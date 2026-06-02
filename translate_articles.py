"""
Translate semua artikel non-English di BigQuery ke English (Groq Cloud).

Pipeline:
  1. Query `articles_latest` → ambil rows WHERE language != 'en'.
  2. Untuk tiap row, kirim ke Groq → return translated headline/summary/keywords.
  3. Tulis JSON sama format dengan output fetch_news.py → bisa langsung
     di-load lewat bq_load.py (append-only; view dedup ke scraped_at terbaru).

Kenapa append + view, bukan UPDATE:
  Free tier BigQuery disable DML. Insert row baru dengan id sama + scraped_at
  fresh → view `articles_latest` pilih yang terbaru (= versi English).

Field yang ditranslate:
  - headline, summary, keywords

Field yang dipertahankan apa adanya:
  - id, url, date, source, category, subcategory, sentiment, city, province

Field di-set baru:
  - language = 'en'
  - scraped_at = now()  (supaya view ambil row translated sebagai latest)

Usage:
    # Mode A — translate dari BQ (default):
    python translate_articles.py                    # translate semua non-en di BQ
    python translate_articles.py --limit 5          # smoke test

    # Mode B — translate dari JSON file (dipakai di GitHub Actions pipeline):
    python translate_articles.py --input news.json --output news.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from google.cloud import bigquery
from pydantic import BaseModel, ConfigDict, Field, ValidationError


# ============================================================================
# CONFIG
# ============================================================================

DEFAULT_DATASET = "az_daily_news_collection"
DEFAULT_LOCATION = "asia-southeast2"

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_TIMEOUT = 30

# Acronym/proper noun yang HARUS tidak diterjemahkan — biar konteks Indonesia tetap akurat
# untuk pembaca English (BPOM != "Food and Drug Authority" yang generic).
PRESERVE_TERMS = (
    "AstraZeneca, Vaxzevria, Imfinzi, Tagrisso, Forxiga, Soliris, "
    "BPOM, Kemenkes, Kementerian Kesehatan, Menkes, BPJS, JKN, "
    "Formularium Nasional, Fornas, INA-CBGs, TKDN, LKPP, MUI, "
    "Komisi IX, DPR, Permenkes, UU Kesehatan, RUU Kesehatan, "
    "AZ Forest, Young Health Programme"
)

SYSTEM_PROMPT = f"""You are a professional Indonesian → English translator for
AstraZeneca Indonesia media monitoring.

Translate the news headline, summary, and keywords from Indonesian to natural,
professional English suitable for international corporate readers.

PRESERVE EXACTLY (do not translate these proper nouns and Indonesian acronyms):
{PRESERVE_TERMS}

RULES:
- Keep the same meaning, tone, and factual content. Do not add or remove information.
- Use journalistic, neutral English. No headlines in title case unless original was.
- Keywords: translate each keyword separately, keep them comma-separated, max 5 keywords.
- If a field is empty, return empty string "".
- Headline: keep it concise (similar length to original).
- Summary: 2-3 sentences, max 300 characters.
"""


# ============================================================================
# SCHEMA
# ============================================================================

class TranslationOut(BaseModel):
    """Output Groq Structured Outputs untuk satu artikel."""
    model_config = ConfigDict(extra="forbid")

    headline: str = Field(description="English translation of headline")
    summary: str = Field(
        description="English translation of summary, max 300 chars",
        max_length=600,
    )
    keywords: str = Field(description="English keywords, comma-separated, max 5")


def _build_response_format() -> dict:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "TranslationOut",
            "schema": TranslationOut.model_json_schema(),
            "strict": True,
        },
    }


# ============================================================================
# GROQ CLIENT
# ============================================================================

class GroqTranslator:
    def __init__(self, api_key: str, model: str = GROQ_MODEL):
        self.model = model
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def translate(self, headline: str, summary: str, keywords: str) -> TranslationOut | None:
        user_prompt = (
            f"Translate the following AZ media monitoring entry to English.\n\n"
            f"HEADLINE: {headline}\n\n"
            f"SUMMARY: {summary or '(empty)'}\n\n"
            f"KEYWORDS: {keywords or '(empty)'}"
        )
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": _build_response_format(),
            "temperature": 0.2,
            # gpt-oss-120b reasoning kadang panjang sebelum emit JSON final.
            # Truncation di 800 → "max completion tokens reached" → JSON invalid.
            "max_tokens": 1500,
        }
        text = self._post_with_retry(payload)
        if text is None:
            return None
        try:
            return TranslationOut.model_validate_json(text)
        except (ValidationError, json.JSONDecodeError) as e:
            print(f"    ! schema/parse error: {e}", file=sys.stderr)
            return None

    def _post_with_retry(self, payload: dict, max_retries: int = 2) -> str | None:
        attempt = 0
        while True:
            try:
                resp = self._session.post(GROQ_API_URL, json=payload, timeout=GROQ_TIMEOUT)
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"]
            except requests.Timeout:
                print(f"    ! Groq timeout {GROQ_TIMEOUT}s", file=sys.stderr)
                return None
            except requests.HTTPError as e:
                status = e.response.status_code
                if status == 429 and attempt < max_retries:
                    attempt += 1
                    print(f"    ! 429 rate limit, wait 5s ({attempt}/{max_retries})...",
                          file=sys.stderr)
                    time.sleep(5)
                    continue
                body = e.response.text[:500] if e.response is not None else ""
                print(f"    ! Groq HTTP {status}: {body}", file=sys.stderr)
                return None
            except Exception as e:
                print(f"    ! Groq call failed: {e}", file=sys.stderr)
                return None


# ============================================================================
# BQ READ
# ============================================================================

def fetch_articles_to_translate(
    project: str, dataset: str, location: str, limit: int | None
) -> list[dict]:
    """Ambil artikel non-English dari view articles_latest."""
    client = bigquery.Client(project=project, location=location)
    limit_clause = f"LIMIT {limit}" if limit else ""
    sql = f"""
    SELECT
      id, headline, url, date, source, summary,
      category, subcategory, sentiment, keywords,
      city, province, language
    FROM `{project}.{dataset}.articles_latest`
    WHERE COALESCE(language, 'id') != 'en'
    ORDER BY date DESC
    {limit_clause}
    """
    rows = []
    for r in client.query(sql):
        rows.append({
            "id": r["id"],
            "headline": r["headline"],
            "url": r["url"],
            "date": r["date"].isoformat() if r["date"] else None,
            "source": r["source"] or "",
            "summary": r["summary"] or "",
            "category": r["category"] or "",
            "subcategory": r["subcategory"] or "",
            "sentiment": r["sentiment"] or "",
            "keywords": r["keywords"] or "",
            "city": r["city"] or "",
            "province": r["province"] or "",
        })
    return rows


def read_all_articles_from_json(path: Path) -> list[dict]:
    """Baca SEMUA artikel dari JSON apa adanya. Format mengikuti `save_json`
    di fetch_news.py: `{ generated_at, count, articles: [...] }`.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("articles", [])


# ============================================================================
# PIPELINE
# ============================================================================

OUTPUT_COLUMNS = [
    "id", "headline", "url", "date", "source",
    "summary", "category", "subcategory", "sentiment", "keywords",
    "city", "province",
    "language", "scraped_at",
]


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def translate_all(rows: list[dict], translator: GroqTranslator) -> list[dict]:
    now_iso = datetime.now(timezone.utc).isoformat()
    translated: list[dict] = []
    n = len(rows)
    failed: list[str] = []

    for i, row in enumerate(rows, 1):
        print(f"[{i}/{n}] {row['headline'][:80]}", file=sys.stderr)
        start = time.time()
        out = translator.translate(
            headline=row["headline"],
            summary=row["summary"],
            keywords=row["keywords"],
        )
        elapsed = time.time() - start
        if out is None:
            print(f"    ! FAILED ({elapsed:.1f}s) — skip", file=sys.stderr)
            failed.append(row["id"])
            continue
        translated.append({
            "id": row["id"],
            "headline": out.headline,
            "url": row["url"],
            "date": row["date"],
            "source": row["source"],
            "summary": out.summary,
            "category": row["category"],
            "subcategory": row["subcategory"],
            "sentiment": row["sentiment"],
            "keywords": out.keywords,
            "city": row["city"],
            "province": row["province"],
            "language": "en",
            "scraped_at": now_iso,
        })
        print(f"    OK ({elapsed:.1f}s) → {out.headline[:80]}", file=sys.stderr)

    if failed:
        print(f"\n[!] {len(failed)} article(s) failed: {failed}", file=sys.stderr)
    return translated


def save_json(articles: list[dict], path: Path) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(articles),
        "articles": [{k: a.get(k, "") for k in OUTPUT_COLUMNS} for a in articles],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] Saved {len(articles)} translated rows → {path}", file=sys.stderr)


def main() -> int:
    _load_env_file(Path(__file__).parent / ".env")

    p = argparse.ArgumentParser(description="Translate AZ news articles id → en")
    p.add_argument("--output", default="translated_articles.json")
    p.add_argument("--input", default=None,
                   help="JSON input path (output fetch_news.py). Kalau di-set, "
                        "skip BQ query → translate dari file. Output ikut "
                        "menyertakan artikel English (passthrough).")
    p.add_argument("--project", default=os.getenv("GCP_PROJECT_ID"))
    p.add_argument("--dataset", default=os.getenv("BQ_DATASET", DEFAULT_DATASET))
    p.add_argument("--location", default=os.getenv("BQ_LOCATION", DEFAULT_LOCATION))
    p.add_argument("--limit", type=int, default=None, help="Limit rows (smoke test)")
    args = p.parse_args()

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        print("[!] GROQ_API_KEY belum di-set", file=sys.stderr)
        return 1

    # --- Input source ---
    # `all_originals` cuma diisi di mode --input (untuk fallback kalau translate
    # gagal di sebagian artikel — kita keep originalnya supaya tidak ada data
    # yang hilang antar fetch dan bq_load).
    all_originals: list[dict] = []
    if args.input:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"[!] Input file tidak ada: {input_path}", file=sys.stderr)
            return 1
        print(f"[*] Reading articles from {input_path}", file=sys.stderr)
        all_originals = read_all_articles_from_json(input_path)
        rows = [
            {
                "id": a.get("id", ""),
                "headline": a.get("headline", ""),
                "url": a.get("url", ""),
                "date": a.get("date"),
                "source": a.get("source", "") or "",
                "summary": a.get("summary", "") or "",
                "category": a.get("category", "") or "",
                "subcategory": a.get("subcategory", "") or "",
                "sentiment": a.get("sentiment", "") or "",
                "keywords": a.get("keywords", "") or "",
                "city": a.get("city", "") or "",
                "province": a.get("province", "") or "",
            }
            for a in all_originals
            if (a.get("language") or "id") != "en"
        ]
        if args.limit:
            rows = rows[: args.limit]
        n_en = len(all_originals) - len(rows)
        print(f"[*] {len(rows)} to translate, {n_en} already English",
              file=sys.stderr)
    else:
        if not args.project:
            print("[!] GCP_PROJECT_ID belum di-set", file=sys.stderr)
            return 1
        print(f"[*] Fetching non-en articles from {args.project}.{args.dataset}.articles_latest",
              file=sys.stderr)
        rows = fetch_articles_to_translate(
            args.project, args.dataset, args.location, args.limit,
        )
        print(f"[*] Got {len(rows)} articles to translate", file=sys.stderr)

    # --- Empty cases ---
    if not rows and not all_originals:
        print("[+] Nothing to translate.", file=sys.stderr)
        if args.input:
            save_json([], Path(args.output))  # tulis kosong supaya downstream tidak break
        return 0

    # --- Translate ---
    translated: list[dict] = []
    if rows:
        translator = GroqTranslator(api_key)
        print(f"[*] Using Groq model: {translator.model}", file=sys.stderr)
        translated = translate_all(rows, translator)

    # --- Build output ---
    if args.input:
        # Output: SEMUA artikel original, dengan field bahasa di-swap untuk yang
        # berhasil di-translate. Yang gagal di-translate tetap masuk (Indonesian).
        translated_by_id = {t["id"]: t for t in translated}
        combined = [translated_by_id.get(a.get("id", ""), a) for a in all_originals]
        n_fail = len(rows) - len(translated)
        print(f"[OK] Done. {len(translated)} translated, "
              f"{len(all_originals) - len(rows)} passthrough EN, "
              f"{n_fail} failed (kept original). "
              f"Next: python bq_load.py {args.output}", file=sys.stderr)
    else:
        if not translated:
            print("[!] No successful translations", file=sys.stderr)
            return 1
        combined = translated
        print(f"[OK] Done. {len(translated)} translated. "
              f"Next: python bq_load.py {args.output}", file=sys.stderr)

    save_json(combined, Path(args.output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
