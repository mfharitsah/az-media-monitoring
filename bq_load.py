"""
BigQuery loader untuk media-monitoring.

Strategi: append-only ke `media_monitoring.articles`.
Dedupe by `id` di-handle oleh view `articles_latest` (lihat infrastructure/bq_schema.sql).

Usage:
    # Lokal (pakai service account JSON)
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
    export GCP_PROJECT_ID=my-project-123
    python bq_load.py astrazeneca_news.json

    # GitHub Actions (auth via google-github-actions/auth — ADC sudah di-set)
    python bq_load.py news.json

Env vars:
    GCP_PROJECT_ID         (required) GCP project ID
    BQ_DATASET             (optional) default: "media_monitoring"
    BQ_TABLE               (optional) default: "articles"
    GOOGLE_APPLICATION_CREDENTIALS  (optional) path ke SA JSON; default pakai ADC
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from google.cloud import bigquery


DEFAULT_DATASET = "az_daily_news_collection"
DEFAULT_TABLE = "articles"
DEFAULT_LOCATION = "asia-southeast2"  # harus match lokasi dataset

# Schema explicit — JANGAN serahkan ke auto-detect.
# Order tidak harus match urutan field di JSON, BigQuery match by name.
BQ_SCHEMA = [
    bigquery.SchemaField("id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("headline", "STRING", mode="REQUIRED"),     # English
    bigquery.SchemaField("headline_id", "STRING"),                    # Indonesian
    bigquery.SchemaField("url", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("date", "TIMESTAMP", mode="REQUIRED"),
    bigquery.SchemaField("source", "STRING"),
    bigquery.SchemaField("summary", "STRING"),                        # English
    bigquery.SchemaField("summary_id", "STRING"),                     # Indonesian
    bigquery.SchemaField("category", "STRING"),
    bigquery.SchemaField("subcategory", "STRING"),
    bigquery.SchemaField("sentiment", "STRING"),
    bigquery.SchemaField("keywords", "STRING"),                       # English
    bigquery.SchemaField("keywords_id", "STRING"),                    # Indonesian
    bigquery.SchemaField("city", "STRING"),
    bigquery.SchemaField("province", "STRING"),
    bigquery.SchemaField("language", "STRING"),
    bigquery.SchemaField("scraped_at", "TIMESTAMP", mode="REQUIRED"),
]


def _load_env_file(path: Path) -> None:
    """Load .env file ke os.environ (skip kalau key sudah set)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def read_articles(json_path: Path) -> list[dict]:
    """Read pipeline output JSON, return list of article rows."""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    rows = data.get("articles", [])
    if not isinstance(rows, list):
        raise ValueError(f"Expected 'articles' array di {json_path}, got {type(rows)}")
    return rows


def to_ndjson(rows: list[dict], out_path: Path) -> None:
    """BigQuery load API butuh NDJSON (newline-delimited JSON), bukan JSON array."""
    with out_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_to_bigquery(
    rows: list[dict],
    project_id: str,
    dataset: str,
    table: str,
    location: str = DEFAULT_LOCATION,
) -> None:
    """Append rows ke table BigQuery. Idempotency di-handle oleh view articles_latest."""
    client = bigquery.Client(project=project_id, location=location)
    table_ref = f"{project_id}.{dataset}.{table}"

    # Tulis NDJSON sementara — load_table_from_file lebih reliable daripada
    # load_table_from_json (yang reformat dan kadang lose precision di timestamps).
    ndjson_path = Path("_bq_load_tmp.ndjson")
    to_ndjson(rows, ndjson_path)

    job_config = bigquery.LoadJobConfig(
        schema=BQ_SCHEMA,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        # Strict: kalau JSON ada field unknown, ignore (jangan break).
        # Kalau ada field di schema tapi tidak di JSON, BigQuery isi NULL.
        ignore_unknown_values=True,
    )

    try:
        with ndjson_path.open("rb") as f:
            job = client.load_table_from_file(f, table_ref, job_config=job_config)
        print(f"[*] Submitted load job {job.job_id} → {table_ref}", file=sys.stderr)
        job.result()  # block sampai selesai (~5-10 detik untuk batch kecil)

        if job.errors:
            print(f"[!] Job errors: {job.errors}", file=sys.stderr)
            raise RuntimeError("BigQuery load job had errors")

        print(f"[+] Loaded {job.output_rows} rows", file=sys.stderr)
    finally:
        ndjson_path.unlink(missing_ok=True)


def main() -> int:
    _load_env_file(Path(__file__).parent / ".env")

    p = argparse.ArgumentParser(description="Load pipeline JSON ke BigQuery")
    p.add_argument("json_path", help="Path ke JSON output dari fetch_news.py")
    p.add_argument("--project", default=os.getenv("GCP_PROJECT_ID"),
                   help="GCP project ID (default: $GCP_PROJECT_ID)")
    p.add_argument("--dataset", default=os.getenv("BQ_DATASET", DEFAULT_DATASET))
    p.add_argument("--table", default=os.getenv("BQ_TABLE", DEFAULT_TABLE))
    args = p.parse_args()

    if not args.project:
        print("[!] GCP_PROJECT_ID belum di-set (env var atau --project flag)", file=sys.stderr)
        return 1

    json_path = Path(args.json_path)
    if not json_path.exists():
        print(f"[!] File tidak ada: {json_path}", file=sys.stderr)
        return 1

    rows = read_articles(json_path)
    if not rows:
        print(f"[!] Tidak ada artikel di {json_path}", file=sys.stderr)
        return 0  # bukan error — pipeline run kosong itu valid

    print(f"[*] Loading {len(rows)} rows → {args.project}.{args.dataset}.{args.table}",
          file=sys.stderr)
    load_to_bigquery(rows, args.project, args.dataset, args.table)
    print(f"[OK] Done. Query lewat view `{args.dataset}.articles_latest`.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
