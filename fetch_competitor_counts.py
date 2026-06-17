"""
Competitor news count scraper untuk AstraZeneca Indonesia.

Beda dari fetch_news.py:
- Hanya hitung jumlah news per kompetitor (bukan ekstraksi konten)
- NO Groq calls — quota-friendly (cuma RSS + URL filter)
- Output: list URL + metadata minimal per company → di-load ke
  BigQuery table `competitor_articles` (separate dari `articles`)

Dipakai untuk feed Analytics page "Share of Voice by Company":
- AZ count: derive dari `articles_latest` (category = 'About AstraZeneca')
- 9 kompetitor: dari `competitor_articles_latest`

Roche Indonesia special: scraper TIDAK apply SOURCE_WHITELIST untuk Roche
(asumsi coverage tipis di whitelist outlet besar). Untuk 8 kompetitor lain,
filter by SOURCE_WHITELIST = sama scope dengan main scrape.

Usage:
    # Lokal
    python fetch_competitor_counts.py --hours 24 --output competitor_news.json

    # GitHub Actions
    python fetch_competitor_counts.py --hours 24 --output competitor_news.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus, urlparse

import feedparser
from dateutil import parser as date_parser

# Reuse helpers + constants dari main scraper. Tidak duplicate biar konsisten
# saat SOURCE_WHITELIST atau URL decoder berubah.
from fetch_news import (
    GOOGLE_NEWS_RSS,
    JUNK_TITLE_RE,
    SOURCE_WHITELIST,
    USER_AGENT,
    is_whitelisted_source,
    resolve_google_news_url,
)


# Kompetitor canonical list — exact string yang disimpan di kolom `company`.
# Urutan: alphabetical untuk dokumentasi yang konsisten. Tidak ada implikasi
# priority karena tiap competitor di-query independent (tidak shared budget).
COMPETITORS = [
    "Bayer Indonesia",
    "GSK Indonesia",
    "MSD Indonesia",          # Merck Sharp & Dohme — query "MSD Indonesia"
    "Novartis Indonesia",
    "Novo Nordisk Indonesia",
    "Pfizer Indonesia",
    "PT Merck Tbk",
    "Roche Indonesia",        # SPECIAL: bypass SOURCE_WHITELIST
    "Takeda Indonesia",
]

# Kompetitor yang TIDAK apply SOURCE_WHITELIST filter — terima semua domain.
WHITELIST_BYPASS_COMPANIES: set[str] = {"Roche Indonesia"}


def apex_domain(url: str) -> str:
    """Extract apex domain dari URL untuk kolom `source`.

    Contoh:
        https://www.detik.com/news/foo → detik.com
        https://health.grid.id/bar     → grid.id
        https://id.theasianparent.com  → theasianparent.com
    """
    netloc = urlparse(url).netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    # Subdomain match against whitelist: kalau domain berakhir dengan ".X"
    # untuk X di whitelist, return X (apex).
    for d in SOURCE_WHITELIST:
        if netloc.endswith("." + d) or netloc == d:
            return d
    # Non-whitelist (mis. Roche bypass): return netloc apa adanya.
    return netloc


def fetch_one_company(company: str, hours: int) -> list[dict]:
    """Query Google News RSS untuk satu kompetitor, return list row siap-load.

    Strategy:
    1. Query `"{company}" when:{hours}h` di Google News (hl=id&gl=ID).
    2. Iterate entries, dedupe by URL (sometimes entry repeated di feed).
    3. Skip junk titles (image filenames di feed).
    4. Filter by cutoff time (rolling N hours).
    5. Filter by SOURCE_WHITELIST kecuali company di WHITELIST_BYPASS_COMPANIES.
    6. Resolve Google News redirect → URL asli.
    """
    query = quote_plus(f'"{company}" when:{hours}h')
    rss_url = GOOGLE_NEWS_RSS.format(query=query)
    print(f"[*] Querying RSS for: {company}", file=sys.stderr)
    feed = feedparser.parse(rss_url, request_headers={"User-Agent": USER_AGENT})

    cutoff = datetime.now(timezone.utc).timestamp() - hours * 3600
    bypass_whitelist = company in WHITELIST_BYPASS_COMPANIES
    rows: list[dict] = []
    seen_urls: set[str] = set()

    for entry in feed.entries:
        title = getattr(entry, "title", "") or ""
        if JUNK_TITLE_RE.search(title):
            continue

        # Time filter
        try:
            pub_dt = date_parser.parse(entry.published).astimezone(timezone.utc)
            if pub_dt.timestamp() < cutoff:
                continue
            published_at_iso = pub_dt.isoformat()
        except Exception:
            continue  # tanpa tanggal valid, skip — tidak bisa partition

        # Decode Google News redirect → URL asli. Mahal (~1s per call) tapi
        # essential supaya whitelist filter & source attribution akurat.
        try:
            real_url = resolve_google_news_url(entry.link)
        except Exception:
            real_url = entry.link  # fallback ke link asli kalau decoder fail

        if real_url in seen_urls:
            continue
        seen_urls.add(real_url)

        # Whitelist filter — kecuali Roche
        if not bypass_whitelist and not is_whitelisted_source(real_url):
            continue

        rows.append({
            "url": real_url,
            "company": company,
            "source": apex_domain(real_url),
            "published_at": published_at_iso,
        })

    print(f"    [+] {company}: {len(rows)} articles "
          f"({'no whitelist' if bypass_whitelist else 'whitelist filter applied'})",
          file=sys.stderr)
    return rows


def main() -> int:
    p = argparse.ArgumentParser(description="Competitor news count scraper")
    p.add_argument("--hours", type=int, default=24,
                   help="Rolling window jam ke belakang (default 24)")
    p.add_argument("--output", default="competitor_news.json",
                   help="Path output JSON (default competitor_news.json)")
    p.add_argument("--companies", default=None,
                   help="Comma-separated subset (default: semua 9 kompetitor)")
    args = p.parse_args()

    if args.companies:
        companies = [c.strip() for c in args.companies.split(",") if c.strip()]
        # Validate against canonical list
        invalid = [c for c in companies if c not in COMPETITORS]
        if invalid:
            print(f"[!] Unknown companies: {invalid}", file=sys.stderr)
            print(f"    Valid: {COMPETITORS}", file=sys.stderr)
            return 1
    else:
        companies = COMPETITORS

    print(f"[*] Scraping {len(companies)} competitors, "
          f"rolling {args.hours}h window", file=sys.stderr)

    scraped_at = datetime.now(timezone.utc).isoformat()
    all_rows: list[dict] = []
    for company in companies:
        try:
            rows = fetch_one_company(company, args.hours)
        except Exception as e:
            # Per-company failure tidak block lainnya. Empty count = no news.
            print(f"[!] {company} failed: {e}", file=sys.stderr)
            rows = []
        for r in rows:
            r["scraped_at"] = scraped_at
        all_rows.extend(rows)

    out_path = Path(args.output)
    out_path.write_text(
        json.dumps({"rows": all_rows, "scraped_at": scraped_at},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[OK] {len(all_rows)} total rows → {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
