import { unstable_cache } from "next/cache";
import { bq, tbl } from "@/lib/bigquery";
import {
  ArticleSchema,
  type AllTimeKpi,
  type Article,
  type ArticleListFilters,
  type CategoryBreakdown,
  type DailyKpi,
  type SentimentTrendPoint,
  type TopProvince,
  type TopSource,
} from "@/lib/types";
import type { ArticleRepository } from "./article-repository";

// Cache TTL — 24 jam karena scrape harian + ada manual invalidation via
// /api/revalidate endpoint yang dipanggil oleh GitHub Actions setelah bq_load.
// TTL panjang = BQ load lebih rendah; invalidation handles freshness.
const CACHE_TTL_SEC = 24 * 60 * 60;
const CACHE_TAG = "articles";

/**
 * Normalisasi 1 row dari BigQuery → Article ter-validasi.
 *
 * BigQuery client mengembalikan TIMESTAMP sebagai `{ value: "..." }` (BigQueryTimestamp).
 * Kita normalize ke ISO string sebelum Zod parse.
 */
// Type guard untuk BigQuery wrapper objects (timestamp, date, etc.)
type BQValue = string | { value: string } | null | undefined;

function normalizeRow(row: Record<string, BQValue>): Article {
  const normalize = (v: BQValue): string | null => {
    if (v == null) return null;
    if (typeof v === "object" && "value" in v) return v.value;
    return v;
  };

  return ArticleSchema.parse({
    id: row.id,
    headline: row.headline,
    url: row.url,
    date: normalize(row.date),
    source: row.source ?? null,
    summary: row.summary ?? null,
    category: row.category ?? null,
    subcategory: row.subcategory ?? null,
    sentiment: row.sentiment ?? null,
    keywords: row.keywords ?? null,
    city: row.city ?? null,
    province: row.province ?? null,
    language: row.language ?? null,
    scraped_at: normalize(row.scraped_at),
  });
}

/** Common SELECT columns — sumber tunggal supaya konsisten antar query. */
const SELECT_COLS = `
  id, headline, url, date, source, summary,
  category, subcategory, sentiment, keywords, city, province, language, scraped_at
`;

// =============================================================================
// Query helpers (un-cached, dipakai di dalam unstable_cache wrappers)
// =============================================================================

async function queryFindById(id: string): Promise<Article | null> {
  const sql = `
    SELECT ${SELECT_COLS}
    FROM ${tbl("articles_latest")}
    WHERE id = @id
    LIMIT 1
  `;
  const [rows] = await bq().query({
    query: sql,
    params: { id },
  });
  return rows[0] ? normalizeRow(rows[0]) : null;
}

async function queryFindToday(limit: number): Promise<Article[]> {
  const sql = `
    SELECT ${SELECT_COLS}
    FROM ${tbl("articles_today")}
    LIMIT @limit
  `;
  const [rows] = await bq().query({
    query: sql,
    params: { limit },
  });
  return rows.map(normalizeRow);
}

async function queryFindRecent(limit: number): Promise<Article[]> {
  // N most recent by published date — dipakai sebagai fallback di landing
  // kalau articles_today empty (mis. dini hari sebelum cron pagi WIB jalan).
  const sql = `
    SELECT ${SELECT_COLS}
    FROM ${tbl("articles_latest")}
    ORDER BY date DESC
    LIMIT @limit
  `;
  const [rows] = await bq().query({
    query: sql,
    params: { limit },
  });
  return rows.map(normalizeRow);
}

/**
 * Build WHERE clause + params dari ArticleListFilters. Shared antara
 * queryFindMany (untuk list cards) dan queryFilteredKpi (untuk KPI dinamis)
 * supaya filter logic konsisten — kalau diubah, kedua jalur ikut.
 */
function buildWhereFromFilters(filters: ArticleListFilters): {
  whereClause: string;
  params: Record<string, unknown>;
} {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  // Date range — "all-time" sengaja tidak menambah kondisi.
  if (filters.range === "today") {
    conditions.push(`DATE(date, "Asia/Jakarta") = CURRENT_DATE("Asia/Jakarta")`);
  } else if (filters.range === "last-7-days") {
    conditions.push(
      `DATE(date, "Asia/Jakarta") >= DATE_SUB(CURRENT_DATE("Asia/Jakarta"), INTERVAL 6 DAY)`,
    );
  } else if (filters.range === "custom" && filters.customDate) {
    conditions.push(`DATE(date, "Asia/Jakarta") = @customDate`);
    params.customDate = filters.customDate;
  }

  // Full-text-ish search (case-insensitive LIKE — cukup untuk MVP, swap ke
  // BigQuery search index kalau perlu nanti)
  if (filters.q) {
    conditions.push(`(
      LOWER(headline) LIKE @q
      OR LOWER(COALESCE(summary, '')) LIKE @q
      OR LOWER(COALESCE(keywords, '')) LIKE @q
    )`);
    params.q = `%${filters.q.toLowerCase()}%`;
  }

  if (filters.categories && filters.categories.length > 0) {
    conditions.push(`category IN UNNEST(@categories)`);
    params.categories = filters.categories;
  }

  if (filters.subcategories && filters.subcategories.length > 0) {
    conditions.push(`subcategory IN UNNEST(@subcategories)`);
    params.subcategories = filters.subcategories;
  }

  if (filters.sentiment) {
    conditions.push(`sentiment = @sentiment`);
    params.sentiment = filters.sentiment;
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}


async function queryFindMany(filters: ArticleListFilters): Promise<{
  items: Article[];
  total: number;
}> {
  const { whereClause, params } = buildWhereFromFilters(filters);

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const sql = `
    WITH filtered AS (
      SELECT ${SELECT_COLS}
      FROM ${tbl("articles_latest")}
      ${whereClause}
    )
    SELECT
      (SELECT COUNT(*) FROM filtered) AS total,
      f.*
    FROM filtered f
    ORDER BY date DESC
    LIMIT @limit OFFSET @offset
  `;

  const [rows] = await bq().query({
    query: sql,
    params: { ...params, limit, offset },
  });

  const total = rows[0]?.total ?? 0;
  const items = rows.map((r: Record<string, BQValue> & { total?: number }) => {
    const { total: _t, ...rest } = r;
    return normalizeRow(rest);
  });

  return { items, total: Number(total) };
}

async function querySentimentTrend(days: number): Promise<SentimentTrendPoint[]> {
  const sql = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', DATE(date, "Asia/Jakarta")) AS date,
      COUNTIF(sentiment = 'Positive') AS positive,
      COUNTIF(sentiment = 'Neutral')  AS neutral,
      COUNTIF(sentiment = 'Negative') AS negative
    FROM ${tbl("articles_latest")}
    WHERE DATE(date, "Asia/Jakarta") >= DATE_SUB(CURRENT_DATE("Asia/Jakarta"), INTERVAL @days DAY)
    GROUP BY date
    ORDER BY date ASC
  `;
  const [rows] = await bq().query({ query: sql, params: { days } });
  return rows.map((r: { date: string; positive: number; neutral: number; negative: number }) => ({
    date: r.date,
    positive: Number(r.positive),
    neutral: Number(r.neutral),
    negative: Number(r.negative),
  }));
}

async function queryCategoryBreakdown(days: number): Promise<CategoryBreakdown[]> {
  const sql = `
    SELECT category, COUNT(*) AS count
    FROM ${tbl("articles_latest")}
    WHERE DATE(date, "Asia/Jakarta") >= DATE_SUB(CURRENT_DATE("Asia/Jakarta"), INTERVAL @days DAY)
      AND category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `;
  const [rows] = await bq().query({ query: sql, params: { days } });
  return rows.map((r: { category: CategoryBreakdown["category"]; count: number }) => ({
    category: r.category,
    count: Number(r.count),
  }));
}

// Macros yang reused di queryDailyKpi, queryFilteredKpi, queryAllTimeKpi.
// Single source of truth — kalau definisi "AZ Related" berubah, edit di sini.
const KPI_BASE_SELECTS = `
  COUNT(*)                                                  AS total,
  COUNTIF(sentiment = 'Positive')                           AS positive_count,
  COUNTIF(sentiment = 'Negative')                           AS negative_count,
  COUNTIF(sentiment = 'Neutral')                            AS neutral_count,
  COUNTIF(category = 'About AstraZeneca')                   AS az_related_total,
  COUNTIF(subcategory = 'AZ Focus')                         AS az_focus_count,
  COUNTIF(subcategory = 'AZ Mentioned')                     AS az_mentioned_count
`;

function readKpi(r: Record<string, unknown>): AllTimeKpi {
  const n = (key: string) => Number(r[key] ?? 0);
  const positiveCount = n("positive_count");
  const negativeCount = n("negative_count");
  return {
    total: n("total"),
    netSentiment: positiveCount - negativeCount,
    positiveCount,
    negativeCount,
    neutralCount: n("neutral_count"),
    azRelatedTotal: n("az_related_total"),
    azFocusCount: n("az_focus_count"),
    azMentionedCount: n("az_mentioned_count"),
  };
}

async function queryDailyKpi(): Promise<DailyKpi> {
  // Single round-trip: all-time aggregates + today's contributions for delta highlights.
  const sql = `
    WITH today AS (
      SELECT *
      FROM ${tbl("articles_latest")}
      WHERE DATE(date, "Asia/Jakarta") = CURRENT_DATE("Asia/Jakarta")
    )
    SELECT
      ${KPI_BASE_SELECTS},
      (SELECT COUNT(*) FROM today)                                                          AS total_today,
      (SELECT COUNTIF(sentiment = 'Positive') - COUNTIF(sentiment = 'Negative') FROM today) AS net_sentiment_today,
      (SELECT COUNTIF(category = 'About AstraZeneca') FROM today)                           AS az_related_today
    FROM ${tbl("articles_latest")}
  `;
  const [rows] = await bq().query({ query: sql });
  const r = rows[0] ?? {};
  const n = (key: string) => Number(r[key] ?? 0);
  return {
    ...readKpi(r),
    totalToday: n("total_today"),
    netSentimentToday: n("net_sentiment_today"),
    azRelatedToday: n("az_related_today"),
  };
}

async function queryFilteredKpi(filters: ArticleListFilters): Promise<AllTimeKpi> {
  const { whereClause, params } = buildWhereFromFilters(filters);
  const sql = `
    SELECT ${KPI_BASE_SELECTS}
    FROM ${tbl("articles_latest")}
    ${whereClause}
  `;
  const [rows] = await bq().query({ query: sql, params });
  return readKpi(rows[0] ?? {});
}


async function queryAllTimeKpi(): Promise<AllTimeKpi> {
  const sql = `SELECT ${KPI_BASE_SELECTS} FROM ${tbl("articles_latest")}`;
  const [rows] = await bq().query({ query: sql });
  return readKpi(rows[0] ?? {});
}

async function queryTopSources(days: number, limit: number): Promise<TopSource[]> {
  const sql = `
    SELECT source, COUNT(*) AS count
    FROM ${tbl("articles_latest")}
    WHERE DATE(date, "Asia/Jakarta") >= DATE_SUB(CURRENT_DATE("Asia/Jakarta"), INTERVAL @days DAY)
      AND source IS NOT NULL AND source != ''
    GROUP BY source
    ORDER BY count DESC
    LIMIT @limit
  `;
  const [rows] = await bq().query({ query: sql, params: { days, limit } });
  return rows.map((r: { source: string; count: number }) => ({
    source: r.source,
    count: Number(r.count),
  }));
}

async function queryTopProvinces(days: number, limit: number): Promise<TopProvince[]> {
  const sql = `
    SELECT province, COUNT(*) AS count
    FROM ${tbl("articles_latest")}
    WHERE DATE(date, "Asia/Jakarta") >= DATE_SUB(CURRENT_DATE("Asia/Jakarta"), INTERVAL @days DAY)
      AND province IS NOT NULL AND province != ''
    GROUP BY province
    ORDER BY count DESC
    LIMIT @limit
  `;
  const [rows] = await bq().query({ query: sql, params: { days, limit } });
  return rows.map((r: { province: string; count: number }) => ({
    province: r.province,
    count: Number(r.count),
  }));
}

// =============================================================================
// Cached wrappers (Next.js unstable_cache)
// =============================================================================

export const bigQueryArticleRepository: ArticleRepository = {
  findById: unstable_cache(queryFindById, ["findById"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),

  findToday: unstable_cache(
    (limit?: number) => queryFindToday(limit ?? 50),
    ["findToday"],
    { revalidate: CACHE_TTL_SEC, tags: [CACHE_TAG] },
  ),

  findRecent: unstable_cache(
    (limit?: number) => queryFindRecent(limit ?? 10),
    ["findRecent"],
    { revalidate: CACHE_TTL_SEC, tags: [CACHE_TAG] },
  ),

  // Filter object di-stringify untuk kunci cache yang unik per kombinasi.
  findMany: async (filters) => {
    const cached = unstable_cache(
      () => queryFindMany(filters),
      ["findMany", JSON.stringify(filters)],
      { revalidate: CACHE_TTL_SEC, tags: [CACHE_TAG] },
    );
    return cached();
  },

  dailyKpi: unstable_cache(queryDailyKpi, ["dailyKpi"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),

  allTimeKpi: unstable_cache(queryAllTimeKpi, ["allTimeKpi"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),

  // Filter ikut jadi cache key — combo unik dapat hit cache sendiri.
  filteredKpi: async (filters) => {
    const cached = unstable_cache(
      () => queryFilteredKpi(filters),
      ["filteredKpi", JSON.stringify(filters)],
      { revalidate: CACHE_TTL_SEC, tags: [CACHE_TAG] },
    );
    return cached();
  },

  sentimentTrend: unstable_cache(querySentimentTrend, ["sentimentTrend"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),

  categoryBreakdown: unstable_cache(queryCategoryBreakdown, ["categoryBreakdown"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),

  topSources: unstable_cache(queryTopSources, ["topSources"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),

  topProvinces: unstable_cache(queryTopProvinces, ["topProvinces"], {
    revalidate: CACHE_TTL_SEC,
    tags: [CACHE_TAG],
  }),
};
