import type { Metadata } from "next";
import { Suspense } from "react";

import { ArticleCardLandscape } from "@/components/article-card-landscape";
import { ArticleCardGallery } from "@/components/article-card-gallery";
import { EmailDigestLauncher } from "@/components/email-digest-launcher";
import { FilteredKpiCards, KpiCardsSkeleton } from "@/components/kpi-cards";
import { NewsFilters, RangeTabs } from "@/components/news-filters";
import { Pagination } from "@/components/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { articleRepo } from "@/lib/repositories";
import {
  ArticleCategorySchema,
  ArticleSentimentSchema,
  ArticleSubcategorySchema,
  type ArticleListFilters,
  type DateRange,
} from "@/lib/types";

export const metadata: Metadata = {
  title: "All News",
};

export const revalidate = 3600;

/** Page size per range — landscape cards lebih besar, gallery lebih kompak. */
const PAGE_SIZE_BY_RANGE: Record<DateRange, number> = {
  "last-24h": 10,
  "last-7-days": 20,
  "all-time": 20,
  custom: 20,
};

/**
 * Search params (URL state):
 * - range:     "last-24h" | "last-7-days" | "all-time" | (custom kalau ada `date`)
 * - date:      YYYY-MM-DD; kalau diisi, override range → custom
 * - q:         free text search
 * - category:  enum
 * - sentiment: enum
 * - page:      1-indexed pagination
 */
export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { filters, page, pageSize } = parseParams(sp);
  // Landscape layout dipakai untuk window kecil (last-24h); gallery untuk yg lebih besar.
  const isCompactWindow = filters.range === "last-24h";
  const activeRangeTab = sp.date ? "custom" : filters.range;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="space-y-2">
        <h1 className="text-3xl text-[#4D0030] font-bold tracking-tight">All News</h1>
        <p className="text-muted-foreground">
          Filter by date, category, or sentiment — or search keywords across articles.
        </p>
      </header>

      <Suspense
        key={`kpi-${JSON.stringify(filters)}`}
        fallback={<KpiCardsSkeleton />}
      >
        <FilteredKpiCards filters={filters} />
      </Suspense>

      <div className="space-y-4">
        <RangeTabs activeRange={activeRangeTab} />
        <NewsFilters />
      </div>

      {filters.range === "last-24h" && !sp.date && (
        <Suspense fallback={null}>
          <EmailDigestLauncher />
        </Suspense>
      )}

      <Suspense
        key={`list-${JSON.stringify(filters)}-p${page}`}
        fallback={isCompactWindow ? <LandscapeSkeleton /> : <GallerySkeleton />}
      >
        <ResultList
          filters={filters}
          layout={isCompactWindow ? "landscape" : "gallery"}
          page={page}
          pageSize={pageSize}
          searchParams={sp}
        />
      </Suspense>
    </div>
  );
}

function parseParams(sp: Record<string, string | undefined>): {
  filters: ArticleListFilters;
  page: number;
  pageSize: number;
} {
  // Date input override range → custom. Default: rolling last-24h.
  let range: DateRange = "last-24h";
  let customDate: string | undefined;
  if (sp.date) {
    range = "custom";
    customDate = sp.date;
  } else if (sp.range === "last-7-days") {
    range = "last-7-days";
  } else if (sp.range === "all-time") {
    range = "all-time";
  }

  const parsedCategory = sp.category
    ? ArticleCategorySchema.safeParse(sp.category).data
    : undefined;
  const parsedSubcategory = sp.subcategory
    ? ArticleSubcategorySchema.safeParse(sp.subcategory).data
    : undefined;
  const sentiment = sp.sentiment
    ? ArticleSentimentSchema.safeParse(sp.sentiment).data
    : undefined;

  const page = sp.page ? Math.max(1, parseInt(sp.page, 10) || 1) : 1;
  const pageSize = PAGE_SIZE_BY_RANGE[range];

  return {
    filters: {
      range,
      customDate,
      q: sp.q || undefined,
      categories: parsedCategory ? [parsedCategory] : undefined,
      subcategories: parsedSubcategory ? [parsedSubcategory] : undefined,
      sentiment,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
    page,
    pageSize,
  };
}

async function ResultList({
  filters,
  layout,
  page,
  pageSize,
  searchParams,
}: {
  filters: ArticleListFilters;
  layout: "landscape" | "gallery";
  page: number;
  pageSize: number;
  searchParams: Record<string, string | undefined>;
}) {
  const { items, total } = await articleRepo.findMany(filters);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-muted-foreground">
          No articles match these filters. Try a different date or keyword.
        </p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      {layout === "landscape" ? (
        <div className="space-y-4">
          {items.map((a) => (
            <ArticleCardLandscape key={a.id} article={a} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((a) => (
            <ArticleCardGallery key={a.id} article={a} />
          ))}
        </div>
      )}
      <Pagination
        currentPage={page}
        totalPages={totalPages}
        pageSize={pageSize}
        totalItems={total}
        searchParams={searchParams}
      />
    </div>
  );
}

function LandscapeSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-40 w-full" />
      ))}
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 9 }).map((_, i) => (
        <Skeleton key={i} className="h-48 w-full" />
      ))}
    </div>
  );
}
