import type {
  AllTimeKpi,
  AnalyticsRange,
  Article,
  ArticleListFilters,
  DailyKpi,
  DateBounds,
  SentimentTrendPoint,
  ShareOfVoiceRow,
  SubcategoryBreakdown,
  TopAzTopic,
  TopProvince,
  TopSource,
} from "@/lib/types";

/**
 * Article Repository — DAL abstraction.
 *
 * Implementasi sekarang: BigQuery (BigQueryArticleRepository).
 * Implementasi nanti: Supabase (tinggal buat SupabaseArticleRepository
 * yang implement interface ini, swap di repository factory).
 *
 * Konsumen (pages, API routes) HANYA boleh import interface ini, tidak
 * langsung import dari BigQuery client.
 */
export interface ArticleRepository {
  /** Find one by stable id (12-char hash) */
  findById(id: string): Promise<Article | null>;

  /** Get articles from rolling last-24h window, ordered by date desc */
  findLast24h(limit?: number): Promise<Article[]>;

  /**
   * Get N most recent articles regardless of date — dipakai di landing page
   * supaya home tidak kosong saat hari sudah berganti tapi belum ada artikel
   * baru di tanggal hari ini (boundary timezone edge case).
   */
  findRecent(limit?: number): Promise<Article[]>;

  /** Generic list with filters — dipakai oleh All News page */
  findMany(filters: ArticleListFilters): Promise<{
    items: Article[];
    total: number;
  }>;

  // ===========================================================================
  // KPI / Analytics
  // ===========================================================================

  /** Snapshot KPI untuk landing page (semua scope hari ini, timezone Jakarta) */
  dailyKpi(): Promise<DailyKpi>;

  /** Snapshot KPI all-time untuk All News page — no deltas */
  allTimeKpi(): Promise<AllTimeKpi>;

  /**
   * KPI snapshot untuk subset artikel yang match filters.
   * Dipakai di All News + AZ page supaya KPI dinamis mengikuti filter.
   */
  filteredKpi(filters: ArticleListFilters): Promise<AllTimeKpi>;

  /** Sentiment trend per hari untuk rentang yang dipilih */
  sentimentTrend(range: AnalyticsRange): Promise<SentimentTrendPoint[]>;

  /** Breakdown jumlah artikel per subcategory */
  subcategoryBreakdown(range: AnalyticsRange): Promise<SubcategoryBreakdown[]>;

  /**
   * Top N publikasi by artikel count.
   * `azOnly=true` (default di analytics page) hanya hitung artikel
   * category="About AstraZeneca" — supaya chart benar-benar reflect
   * AZ media presence, bukan total volume regulator/crisis.
   */
  topSources(range: AnalyticsRange, limit: number, opts?: { azOnly?: boolean }): Promise<TopSource[]>;

  /** Top N provinsi by artikel count */
  topProvinces(range: AnalyticsRange, limit: number): Promise<TopProvince[]>;

  /**
   * Share of Voice — count news per company (AZ + 9 competitors).
   * AZ row di-derive dari articles_latest (category=About AstraZeneca).
   * Competitor row di-derive dari competitor_articles_latest.
   * Sorted by count desc, rank-assigned, sharePct = % of total.
   */
  shareOfVoice(range: AnalyticsRange): Promise<ShareOfVoiceRow[]>;

  /**
   * Top N keyword paling sering muncul di AZ-related news (category=About AstraZeneca).
   * Parse keywords dari kolom `keywords` (English, comma-separated).
   * Per article, dedupe duplicates supaya artikel tidak over-count.
   */
  topAzTopics(range: AnalyticsRange, limit: number): Promise<TopAzTopic[]>;

  /**
   * Bounds tanggal artikel — dipakai untuk derive opsi semester di UI dropdown.
   * Kalau snapshot kosong return tahun current.
   */
  dateBounds(): Promise<DateBounds>;
}
