-- BigQuery schema untuk media-monitoring AstraZeneca Indonesia.
--
-- Design choice: APPEND-ONLY table + VIEW yang ambil latest per id.
-- Alasan: BigQuery tidak punya native UPSERT yang murah, dan append-only memberi
-- benefit:
--   1. Idempotent load — re-run pipeline tidak masalah, view selalu konsisten
--   2. Audit trail — bisa lihat history scraped_at suatu artikel
--   3. Simpler loader code — tidak perlu MERGE statement
--
-- Cara pakai dari Next.js: SELECT FROM articles_latest (bukan articles).
--
-- Jalankan SEKALI di BigQuery Console (Project: GANTI_PROJECT_ID):
--   bq query --use_legacy_sql=false < bq_schema.sql

-- =============================================================================
-- TABLE: articles (append-only raw inserts)
-- =============================================================================
CREATE TABLE IF NOT EXISTS `az_daily_news_collection.articles` (
  id            STRING    NOT NULL  OPTIONS(description="12-char stable hash dari URL"),
  headline      STRING    NOT NULL  OPTIONS(description="Headline ENGLISH (default UI display)"),
  headline_id   STRING                OPTIONS(description="Headline original Bahasa Indonesia (dari RSS feed)"),
  url           STRING    NOT NULL  OPTIONS(description="URL artikel asli (sudah di-decode dari Google News redirect)"),
  date          TIMESTAMP NOT NULL  OPTIONS(description="published_at dari RSS feed"),
  source        STRING                OPTIONS(description="Nama publikasi, mis. 'Kompas.com'"),
  summary       STRING                OPTIONS(description="Ringkasan English (default UI display)"),
  summary_id    STRING                OPTIONS(description="Ringkasan Bahasa Indonesia"),
  category      STRING                OPTIONS(description="enum: 'About AstraZeneca' | 'Regulatory/Policy'"),
  subcategory   STRING                OPTIONS(description="enum: 'AZ Focus' | 'AZ Mentioned' | 'Stakeholder & Regulator' | 'Pharma Policy' | 'General Health Regulation'"),
  sentiment     STRING                OPTIONS(description="enum: 'Positive' | 'Neutral' | 'Negative'"),
  keywords      STRING                OPTIONS(description="5 keyword English dipisah koma"),
  keywords_id   STRING                OPTIONS(description="5 keyword Bahasa Indonesia dipisah koma"),
  city          STRING                OPTIONS(description="Kota Indonesia atau '' kalau tidak disebut"),
  province      STRING                OPTIONS(description="Provinsi Indonesia (nama resmi) atau ''"),
  language      STRING                OPTIONS(description="ISO 639-1. Selalu 'en' setelah dual-column refactor; field di-keep untuk backward compat"),
  scraped_at    TIMESTAMP NOT NULL  OPTIONS(description="Waktu loader memasukkan row ini")
)
PARTITION BY DATE(date)
CLUSTER BY id, category, subcategory
OPTIONS(
  description="Append-only raw inserts dari pipeline scraper. Query lewat articles_latest view.",
  -- partition_expiration_days dihilangkan = retain forever. Set angka kalau perlu cap storage.
  partition_expiration_days=NULL
);

-- =============================================================================
-- VIEW: articles_latest (deduped — 1 row per id, latest scrape wins)
-- =============================================================================
CREATE OR REPLACE VIEW `az_daily_news_collection.articles_latest` AS
SELECT * EXCEPT(rn)
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY id ORDER BY scraped_at DESC) AS rn
  FROM `az_daily_news_collection.articles`
)
WHERE rn = 1;

-- =============================================================================
-- VIEW: articles_last_24h — rolling 24-jam window untuk landing page.
-- Konsisten dengan scrape window (pipeline jalan --hours 24, rolling juga).
-- Beda dengan calendar "today" view yang sebelumnya: tidak terpengaruh boundary
-- midnight (artikel publish 23:50 kemarin tetap muncul di view ini sampai
-- ~23:50 hari ini, bukan langsung hilang setelah ganti tanggal).
-- =============================================================================
CREATE OR REPLACE VIEW `az_daily_news_collection.articles_last_24h` AS
SELECT *
FROM `az_daily_news_collection.articles_latest`
WHERE date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
ORDER BY date DESC;
