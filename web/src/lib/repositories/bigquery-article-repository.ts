import { unstable_cache } from "next/cache";
import { bq, tbl } from "@/lib/bigquery";
import {
  ArticleSchema,
  parseSemester,
  type AllTimeKpi,
  type AnalyticsRange,
  type Article,
  type ArticleListFilters,
  type DailyKpi,
  type DateBounds,
  type DateRange,
  type SentimentTrendPoint,
  type ShareOfVoiceRow,
  type SubcategoryBreakdown,
  type TopAzTopic,
  type TopProvince,
  type TopSource,
} from "@/lib/types";
import type { ArticleRepository } from "./article-repository";

/**
 * SINGLE-SNAPSHOT PATTERN.
 *
 * Masalah pola lama: tiap kombinasi filter punya cache entry sendiri dengan
 * TTL panjang. Kalau data berubah di antara waktu dua kombinasi pertama
 * di-query, mereka jadi tidak konsisten (mis. "all-time" stale = 11 sementara
 * "last-7-days" fresh = 18 — padahal all-time mustahil < 7-days).
 *
 * Solusi: SATU cache entry berisi seluruh artikel. Semua view (KPI, list,
 * filter, analytics) di-derive in-memory dari snapshot yang sama → semua
 * view dijamin konsisten (last-24h ⊆ last-7-days ⊆ all-time selalu benar).
 * Untuk dataset skala ini (ratusan–ribuan artikel) ini efisien: 1 query BQ.
 */

const CACHE_TTL_SEC = 24 * 60 * 60;
const CACHE_TAG = "articles";
const JKT = "Asia/Jakarta";

// =============================================================================
// Snapshot loader — satu-satunya BQ query untuk data artikel
// =============================================================================

type BQValue = string | { value: string } | null | undefined;

function normalizeRow(row: Record<string, BQValue>): Article {
  const norm = (v: BQValue): string | null => {
    if (v == null) return null;
    if (typeof v === "object" && "value" in v) return v.value;
    return v;
  };
  return ArticleSchema.parse({
    id: row.id,
    headline: row.headline,
    headline_id: row.headline_id ?? null,
    url: row.url,
    date: norm(row.date),
    source: row.source ?? null,
    summary: row.summary ?? null,
    summary_id: row.summary_id ?? null,
    category: row.category ?? null,
    subcategory: row.subcategory ?? null,
    sentiment: row.sentiment ?? null,
    keywords: row.keywords ?? null,
    keywords_id: row.keywords_id ?? null,
    city: row.city ?? null,
    province: row.province ?? null,
    language: row.language ?? null,
    scraped_at: norm(row.scraped_at),
  });
}

/**
 * Fetch SEMUA artikel sekali + anchor `latestArticleDateMs`. Cached —
 * semua method lain derive dari sini. Invalidasi via revalidateTag("articles").
 *
 * `latestArticleDateMs` = MAX(date) → publication date artikel terbaru.
 * Dipakai sebagai anchor untuk window `last-24h` (pengganti `Date.now()`).
 *
 * Kenapa MAX(date) bukan MAX(scraped_at): kolom `scraped_at` ikut berubah
 * setiap kali translate menulis ulang artikel ke BQ (view `articles_latest`
 * dedupe by latest scraped_at → versi English ditandai dengan scraped_at
 * baru). Kalau anchor pakai `scraped_at`, window last-24h ikut bergeser
 * tiap kali ada translate run — bukan cuma saat scrape. MAX(date) immune
 * karena `date` = waktu publikasi artikel, tidak diubah oleh translate.
 */
interface Snapshot {
  articles: Article[];
  latestArticleDateMs: number;
}

const loadSnapshot = unstable_cache(
  async (): Promise<Snapshot> => {
    const sql = `
      SELECT
        id,
        headline, headline_id,
        url, date, source,
        summary, summary_id,
        category, subcategory, sentiment,
        keywords, keywords_id,
        city, province,
        language, scraped_at
      FROM ${tbl("articles_latest")}
      ORDER BY date DESC
    `;
    const [rows] = await bq().query({ query: sql });
    const articles = rows.map(normalizeRow);
    // Snapshot sudah ORDER BY date DESC → articles[0] = artikel terbaru.
    // Fallback ke Date.now() kalau snapshot kosong (mis. dataset belum di-seed)
    // supaya page tidak crash.
    const latestArticleDateMs =
      articles.length > 0 ? new Date(articles[0].date).getTime() : Date.now();
    return { articles, latestArticleDateMs };
  },
  ["articles-snapshot"],
  { revalidate: CACHE_TTL_SEC, tags: [CACHE_TAG] },
);

// =============================================================================
// Competitor snapshot — separate cache entry (different BQ table)
// =============================================================================

interface CompetitorRow {
  url: string;
  company: string;
  source: string | null;
  /** ISO timestamp string (BigQuery TIMESTAMP) */
  published_at: string;
}

interface CompetitorSnapshot {
  rows: CompetitorRow[];
}

const loadCompetitorSnapshot = unstable_cache(
  async (): Promise<CompetitorSnapshot> => {
    const sql = `
      SELECT url, company, source, published_at
      FROM ${tbl("competitor_articles_latest")}
      ORDER BY published_at DESC
    `;
    const [rows] = await bq().query({ query: sql });
    const norm = (v: BQValue): string | null => {
      if (v == null) return null;
      if (typeof v === "object" && "value" in v) return v.value;
      return v;
    };
    const normalized: CompetitorRow[] = rows.map((r: Record<string, BQValue>) => ({
      url: String(r.url),
      company: String(r.company),
      source: r.source != null ? String(r.source) : null,
      published_at: norm(r.published_at) ?? "",
    }));
    return { rows: normalized };
  },
  ["competitor-snapshot"],
  { revalidate: CACHE_TTL_SEC, tags: [CACHE_TAG] },
);

// =============================================================================
// Date helpers (Asia/Jakarta, no DST)
// =============================================================================

/** YYYY-MM-DD dari ISO timestamp, di timezone Jakarta. */
function jakartaDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: JKT });
}

/** Tanggal Jakarta hari ini (YYYY-MM-DD). */
function todayJakarta(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: JKT });
}

/** Tanggal Jakarta N hari lalu (YYYY-MM-DD). */
function jakartaDateMinusDays(n: number): string {
  const d = new Date(`${todayJakarta()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// =============================================================================
// In-memory filters & aggregations (pure functions atas snapshot)
// =============================================================================

/**
 * Cek apakah artikel masuk rentang tanggal (list filter).
 *
 * `anchorMs`: titik akhir window untuk `last-24h`. Sengaja DI-INJECT
 * (bukan baca `Date.now()` di sini) supaya semua page yang share snapshot
 * pakai window yang sama = `MAX(date)` dari snapshot. Hasilnya list stabil
 * antar pembukaan page sampai snapshot di-refresh oleh scrape berikutnya.
 */
function inListRange(
  a: Article,
  range: DateRange,
  anchorMs: number,
  customDate?: string,
): boolean {
  // Semester variants — share semantik dengan dateInAnalyticsRange.
  if (range.startsWith("h1-") || range.startsWith("h2-")) {
    return dateInAnalyticsRange(a.date, range as AnalyticsRange);
  }
  if (range === "all-time") return true;
  if (range === "last-24h") {
    return new Date(a.date).getTime() >= anchorMs - 24 * 3600 * 1000;
  }
  if (range === "last-7-days") {
    return jakartaDate(a.date) >= jakartaDateMinusDays(6);
  }
  // custom
  return customDate ? jakartaDate(a.date) === customDate : true;
}

/**
 * Cek apakah ISO date string masuk rentang Analytics.
 * Range bisa berupa "last-7-days", "all-time", atau `h1-YYYY`/`h2-YYYY`.
 * Dipakai untuk article date DAN competitor published_at (semua di Jakarta timezone).
 */
function dateInAnalyticsRange(iso: string, range: AnalyticsRange): boolean {
  if (range === "all-time") return true;
  if (range === "last-7-days") {
    return jakartaDate(iso) >= jakartaDateMinusDays(6);
  }
  // Semester: h1-YYYY → YYYY-01-01..YYYY-06-30, h2-YYYY → YYYY-07-01..YYYY-12-31
  const sem = parseSemester(range);
  if (!sem) return false;
  const d = jakartaDate(iso);
  const startMonth = sem.half === 1 ? "01-01" : "07-01";
  const endMonth = sem.half === 1 ? "06-30" : "12-31";
  return d >= `${sem.year}-${startMonth}` && d <= `${sem.year}-${endMonth}`;
}

/** Wrapper untuk Article (legacy callers). */
function inAnalyticsRange(a: Article, range: AnalyticsRange): boolean {
  return dateInAnalyticsRange(a.date, range);
}

function matchesFilters(
  a: Article,
  f: ArticleListFilters,
  anchorMs: number,
): boolean {
  if (!inListRange(a, f.range, anchorMs, f.customDate)) return false;

  if (f.q) {
    const q = f.q.toLowerCase();
    const haystack = `${a.headline} ${a.summary ?? ""} ${a.keywords ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (f.categories?.length) {
    if (!a.category || !f.categories.includes(a.category)) return false;
  }
  if (f.subcategories?.length) {
    if (!a.subcategory || !f.subcategories.includes(a.subcategory)) return false;
  }
  if (f.sentiment && a.sentiment !== f.sentiment) return false;

  return true;
}

/** Hitung KPI dari sekumpulan artikel. */
function computeKpi(articles: Article[]): AllTimeKpi {
  let positiveCount = 0;
  let negativeCount = 0;
  let neutralCount = 0;
  let azFocusCount = 0;
  let azMentionedCount = 0;
  let azRelatedTotal = 0;

  for (const a of articles) {
    if (a.sentiment === "Positive") positiveCount++;
    else if (a.sentiment === "Negative") negativeCount++;
    else if (a.sentiment === "Neutral") neutralCount++;

    if (a.category === "About AstraZeneca") azRelatedTotal++;
    if (a.subcategory === "AZ Focus") azFocusCount++;
    else if (a.subcategory === "AZ Mentioned") azMentionedCount++;
  }

  return {
    total: articles.length,
    netSentiment: positiveCount - negativeCount,
    positiveCount,
    negativeCount,
    neutralCount,
    azRelatedTotal,
    azFocusCount,
    azMentionedCount,
  };
}

// =============================================================================
// Repository — semua method derive dari loadSnapshot()
// =============================================================================

export const bigQueryArticleRepository: ArticleRepository = {
  async findById(id) {
    const { articles } = await loadSnapshot();
    return articles.find((a) => a.id === id) ?? null;
  },

  async findLast24h(limit = 50) {
    const { articles, latestArticleDateMs } = await loadSnapshot();
    return articles
      .filter((a) => inListRange(a, "last-24h", latestArticleDateMs))
      .slice(0, limit);
  },

  async findRecent(limit = 10) {
    const { articles } = await loadSnapshot();
    return articles.slice(0, limit); // snapshot sudah sorted date desc
  },

  async findMany(filters) {
    const { articles, latestArticleDateMs } = await loadSnapshot();
    const matched = articles.filter((a) => matchesFilters(a, filters, latestArticleDateMs));
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 50;
    return {
      items: matched.slice(offset, offset + limit),
      total: matched.length,
    };
  },

  async dailyKpi(): Promise<DailyKpi> {
    const { articles, latestArticleDateMs } = await loadSnapshot();
    const last24h = articles.filter((a) => inListRange(a, "last-24h", latestArticleDateMs));
    const k24 = computeKpi(last24h);
    return {
      ...computeKpi(articles),
      totalLast24h: k24.total,
      netSentimentLast24h: k24.netSentiment,
      azRelatedLast24h: k24.azRelatedTotal,
    };
  },

  async allTimeKpi() {
    const { articles } = await loadSnapshot();
    return computeKpi(articles);
  },

  async filteredKpi(filters) {
    const { articles, latestArticleDateMs } = await loadSnapshot();
    return computeKpi(articles.filter((a) => matchesFilters(a, filters, latestArticleDateMs)));
  },

  async sentimentTrend(range): Promise<SentimentTrendPoint[]> {
    const { articles } = await loadSnapshot();
    const byDate = new Map<string, SentimentTrendPoint>();
    for (const a of articles) {
      if (!inAnalyticsRange(a, range)) continue;
      const d = jakartaDate(a.date);
      let pt = byDate.get(d);
      if (!pt) {
        pt = { date: d, positive: 0, neutral: 0, negative: 0 };
        byDate.set(d, pt);
      }
      if (a.sentiment === "Positive") pt.positive++;
      else if (a.sentiment === "Negative") pt.negative++;
      else if (a.sentiment === "Neutral") pt.neutral++;
    }
    return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  },

  async subcategoryBreakdown(range): Promise<SubcategoryBreakdown[]> {
    const { articles } = await loadSnapshot();
    const counts = new Map<string, number>();
    for (const a of articles) {
      if (!inAnalyticsRange(a, range)) continue;
      // Standalone kategori (Crisis & Disruption) punya subcategory=NULL →
      // bubble label dari kolom category supaya mereka muncul di Article
      // Distribution chart.
      const label = a.subcategory ?? a.category;
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([subcategory, count]) => ({
        subcategory: subcategory as SubcategoryBreakdown["subcategory"],
        count,
      }))
      .sort((x, y) => y.count - x.count);
  },

  async topSources(range, limit, opts): Promise<TopSource[]> {
    const { articles } = await loadSnapshot();
    const azOnly = opts?.azOnly ?? false;
    const counts = new Map<string, number>();
    for (const a of articles) {
      if (!inAnalyticsRange(a, range)) continue;
      if (azOnly && a.category !== "About AstraZeneca") continue;
      if (!a.source) continue;
      counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, limit);
  },

  async topProvinces(range, limit): Promise<TopProvince[]> {
    const { articles } = await loadSnapshot();
    const counts = new Map<string, number>();
    for (const a of articles) {
      if (!inAnalyticsRange(a, range)) continue;
      if (!a.province) continue;
      counts.set(a.province, (counts.get(a.province) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([province, count]) => ({ province, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, limit);
  },

  async shareOfVoice(range): Promise<ShareOfVoiceRow[]> {
    const [{ articles }, { rows: competitorRows }] = await Promise.all([
      loadSnapshot(),
      loadCompetitorSnapshot(),
    ]);

    // AZ count: artikel category=About AstraZeneca dalam range.
    const azCount = articles.filter(
      (a) => a.category === "About AstraZeneca" && inAnalyticsRange(a, range),
    ).length;

    // Competitor counts: per company, count rows dalam range.
    const competitorCounts = new Map<string, number>();
    for (const r of competitorRows) {
      if (!dateInAnalyticsRange(r.published_at, range)) continue;
      competitorCounts.set(r.company, (competitorCounts.get(r.company) ?? 0) + 1);
    }

    const all = [
      { company: "AstraZeneca Indonesia", count: azCount, isAz: true },
      ...[...competitorCounts.entries()].map(([company, count]) => ({
        company,
        count,
        isAz: false,
      })),
    ];

    const total = all.reduce((sum, r) => sum + r.count, 0);
    return all
      .sort((x, y) => y.count - x.count)
      .map((r, i) => ({
        rank: i + 1,
        company: r.company,
        count: r.count,
        sharePct: total > 0 ? (r.count / total) * 100 : 0,
        isAz: r.isAz,
      }));
  },

  async topAzTopics(range, limit): Promise<TopAzTopic[]> {
    const { articles } = await loadSnapshot();
    const counts = new Map<string, number>();
    for (const a of articles) {
      if (a.category !== "About AstraZeneca") continue;
      if (!inAnalyticsRange(a, range)) continue;
      if (!a.keywords) continue;
      // Per article: dedupe keyword duplicates supaya 1 artikel = 1 vote
      // per kw (kalau LM kasih kw yang sama 2x, jangan double-count).
      const seen = new Set<string>();
      for (const kw of a.keywords.split(",")) {
        const norm = kw.trim().toLowerCase();
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        counts.set(norm, (counts.get(norm) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, limit);
  },

  async dateBounds(): Promise<DateBounds> {
    const { articles } = await loadSnapshot();
    if (articles.length === 0) {
      const y = new Date().getFullYear();
      return { minYear: y, maxYear: y };
    }
    // Snapshot sudah sorted date desc → [0] = max, [last] = min.
    const maxYear = Number(jakartaDate(articles[0].date).slice(0, 4));
    const minYear = Number(jakartaDate(articles[articles.length - 1].date).slice(0, 4));
    return { minYear, maxYear };
  },
};
