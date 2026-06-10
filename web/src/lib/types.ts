import { z } from "zod";

/**
 * Domain types untuk artikel — match BigQuery schema `articles_latest` view.
 *
 * Zod schema = single source of truth: validasi runtime saat baca dari BQ + tipe TS.
 * Kalau schema BQ diubah, edit di sini sekali, semua consumer ter-update.
 */

/**
 * Hybrid taxonomy (sinkron dengan ArticleAnalysis di fetch_news.py):
 * - Beberapa kategori punya subkategori (About AstraZeneca, Regulatory/Policy)
 * - Beberapa kategori STANDALONE — tidak punya subkategori
 *   (Industry & Competitor, Crisis & Disruption). Di DB row: subcategory=NULL.
 *
 * "Not Relevant" subcategory di-skip oleh pipeline, tidak masuk DB/frontend.
 */
export const ArticleCategorySchema = z.enum([
  "About AstraZeneca",
  "Regulatory/Policy",
  "Industry & Competitor",
  "Crisis & Disruption",
]);
export const ArticleSubcategorySchema = z.enum([
  // About AstraZeneca
  "AZ Focus",
  "AZ Mentioned",
  // Regulatory/Policy
  "Stakeholder & Regulator",
  "Pharma Policy",
  "General Health Regulation",
]);
export const ArticleSentimentSchema = z.enum(["Positive", "Neutral", "Negative"]);

/** Mapping: dipakai kalau UI butuh derive Category dari Subcategory. */
export const SUBCATEGORY_TO_CATEGORY: Record<
  z.infer<typeof ArticleSubcategorySchema>,
  z.infer<typeof ArticleCategorySchema>
> = {
  "AZ Focus": "About AstraZeneca",
  "AZ Mentioned": "About AstraZeneca",
  "Stakeholder & Regulator": "Regulatory/Policy",
  "Pharma Policy": "Regulatory/Policy",
  "General Health Regulation": "Regulatory/Policy",
};

/**
 * Reverse: subkategori yang valid untuk tiap kategori. Dipakai oleh
 * filter UI (cascading dropdown) — kalau array kosong → kategori standalone
 * (subcategory dropdown di-hide).
 */
export const SUBCATEGORIES_BY_CATEGORY: Record<
  z.infer<typeof ArticleCategorySchema>,
  ArticleSubcategory[]
> = {
  "About AstraZeneca": ["AZ Focus", "AZ Mentioned"],
  "Regulatory/Policy": [
    "Stakeholder & Regulator",
    "Pharma Policy",
    "General Health Regulation",
  ],
  "Industry & Competitor": [],
  "Crisis & Disruption": [],
};

/**
 * Dual-language: `headline`, `summary`, `keywords` = English (primary display).
 * `headline_id`, `summary_id`, `keywords_id` = Indonesian original.
 * Translate toggle di UI swap antara dua versi tanpa Groq call.
 */
export const ArticleSchema = z.object({
  id: z.string(),
  headline: z.string(),                       // English
  headline_id: z.string().nullable(),         // Indonesian (RSS original)
  url: z.url(),
  date: z.string(), // ISO timestamp; BQ TIMESTAMP serialized as string
  source: z.string().nullable(),
  summary: z.string().nullable(),             // English
  summary_id: z.string().nullable(),          // Indonesian
  category: ArticleCategorySchema.nullable(),
  subcategory: ArticleSubcategorySchema.nullable(),
  sentiment: ArticleSentimentSchema.nullable(),
  keywords: z.string().nullable(),            // English
  keywords_id: z.string().nullable(),         // Indonesian
  city: z.string().nullable(),
  province: z.string().nullable(),
  language: z.string().nullable(),
  scraped_at: z.string(),
});

export type Article = z.infer<typeof ArticleSchema>;
export type ArticleCategory = z.infer<typeof ArticleCategorySchema>;
export type ArticleSubcategory = z.infer<typeof ArticleSubcategorySchema>;
export type ArticleSentiment = z.infer<typeof ArticleSentimentSchema>;

// =============================================================================
// Filter / query params untuk list pages
// =============================================================================

export type DateRange = "last-24h" | "last-7-days" | "all-time" | "custom";

export interface ArticleListFilters {
  range: DateRange;
  /** ISO date (YYYY-MM-DD) — only used when range = "custom" */
  customDate?: string;
  /** Free-text search across headline + summary + keywords */
  q?: string;
  /** Match any of these categories (IN clause). Empty/undefined = all. */
  categories?: ArticleCategory[];
  /** Match any of these subcategories (IN clause). Empty/undefined = all. */
  subcategories?: ArticleSubcategory[];
  sentiment?: ArticleSentiment;
  /** Pagination */
  limit?: number;
  offset?: number;
}

// =============================================================================
// Analytics aggregates
// =============================================================================

export interface SentimentTrendPoint {
  date: string; // YYYY-MM-DD
  positive: number;
  neutral: number;
  negative: number;
}

/**
 * Item untuk Article distribution chart. `label` bisa berupa:
 * - ArticleSubcategory: untuk kategori yang punya subkategori
 * - ArticleCategory: untuk standalone (Industry & Competitor, Crisis & Disruption)
 *   → di-bubble dari column `category` saat `subcategory` NULL.
 */
export type DistributionLabel = ArticleSubcategory | ArticleCategory;

export interface SubcategoryBreakdown {
  subcategory: DistributionLabel;
  count: number;
}

/** Rentang waktu untuk halaman Analytics. */
export type AnalyticsRange = "last-7-days" | "all-time";

export interface TopSource {
  source: string;
  count: number;
}

export interface TopProvince {
  province: string;
  count: number;
}

/**
 * KPI snapshot — all-time totals. Used by All News page (no delta).
 */
export interface AllTimeKpi {
  /** Total articles all-time */
  total: number;

  /** Net sentiment all-time (Positive − Negative) */
  netSentiment: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;

  /** Total AZ Focus + AZ Mentioned all-time */
  azRelatedTotal: number;
  azFocusCount: number;
  azMentionedCount: number;
}

/**
 * KPI snapshot — all-time totals PLUS last-24h contribution (delta).
 * Used by landing page so labels match All News but show "+N last 24h" indicator.
 *
 * Rolling 24h window (sinkron dengan scrape pipeline) — bukan calendar "today".
 * Konsekuensinya: artikel publish 23:50 kemarin tetap dihitung sebagai "last 24h"
 * sampai ~23:50 hari ini, jadi UX tidak break di boundary midnight WIB.
 */
export interface DailyKpi extends AllTimeKpi {
  /** Articles published in rolling last 24h */
  totalLast24h: number;
  /** Rolling 24h contribution to net sentiment (pos − neg) */
  netSentimentLast24h: number;
  /** Rolling 24h contribution to AZ Related (Focus + Mentioned) */
  azRelatedLast24h: number;
}
