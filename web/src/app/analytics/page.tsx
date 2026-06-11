import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SentimentTrendChart,
  SubcategoryBreakdownChart,
  TopProvincesChart,
  TopSourcesChart,
} from "@/components/analytics-charts";
import {
  AnalyticsKpiCards,
  AnalyticsKpiCardsSkeleton,
} from "@/components/kpi-cards";
import { articleRepo } from "@/lib/repositories";
import type { AnalyticsRange } from "@/lib/types";

export const metadata: Metadata = {
  title: "Analytics",
  description:
    "Sentiment trend, subcategory, source, and location analytics for AstraZeneca Indonesia news.",
};

export const revalidate = 3600;

const TOP_LIMIT = 10;

const RANGE_TABS: { value: AnalyticsRange; label: string }[] = [
  { value: "last-7-days", label: "Last 7 days" },
  { value: "all-time", label: "All Time" },
];

function rangeLabel(range: AnalyticsRange): string {
  return range === "all-time" ? "all time" : "last 7 days";
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const range: AnalyticsRange = sp.range === "all-time" ? "all-time" : "last-7-days";
  const label = rangeLabel(range);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">
            Trend and distribution visualizations for AstraZeneca Indonesia media
            monitoring.
          </p>
        </div>
        <AnalyticsRangeTabs activeRange={range} />
      </header>

      {/* KPI summary — streaming independen dari chart. */}
      <Suspense key={`kpi-${range}`} fallback={<AnalyticsKpiCardsSkeleton />}>
        <AnalyticsKpiCards range={range} />
      </Suspense>

      {/* Tiap chart streaming independen — query lambat tidak block yang lain.
          `key` di-set per range supaya Suspense re-trigger saat range ganti. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={`Sentiment Trend (${label})`}
          description="Article count per sentiment per day"
        >
          <Suspense key={`trend-${range}`} fallback={<ChartSkeleton />}>
            <SentimentTrendSection range={range} />
          </Suspense>
        </ChartCard>

        <ChartCard
          title={`Subcategories (${label})`}
          description="Article distribution by subcategory"
        >
          <Suspense key={`sub-${range}`} fallback={<ChartSkeleton />}>
            <SubcategoryBreakdownSection range={range} />
          </Suspense>
        </ChartCard>

        <ChartCard
          title={`Top ${TOP_LIMIT} Sources (${label})`}
          description="Publications that produced the most articles"
        >
          <Suspense key={`src-${range}`} fallback={<ChartSkeleton />}>
            <TopSourcesSection range={range} />
          </Suspense>
        </ChartCard>

        <ChartCard
          title={`Top ${TOP_LIMIT} Provinces (${label})`}
          description="Provinces most often referenced as the article location"
        >
          <Suspense key={`prov-${range}`} fallback={<ChartSkeleton />}>
            <TopProvincesSection range={range} />
          </Suspense>
        </ChartCard>
      </div>
    </div>
  );
}

// =============================================================================
// Server data-fetching sections (1 per chart for streaming)
// =============================================================================

async function SentimentTrendSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.sentimentTrend(range);
  return <SentimentTrendChart data={data} />;
}

async function SubcategoryBreakdownSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.subcategoryBreakdown(range);
  return <SubcategoryBreakdownChart data={data} />;
}

async function TopSourcesSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.topSources(range, TOP_LIMIT);
  return <TopSourcesChart data={data} />;
}

async function TopProvincesSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.topProvinces(range, TOP_LIMIT);
  return <TopProvincesChart data={data} />;
}

// =============================================================================
// UI primitives
// =============================================================================

/** Range selector — pure Link, SSR-friendly. Mengatur semua chart sekaligus. */
function AnalyticsRangeTabs({ activeRange }: { activeRange: AnalyticsRange }) {
  return (
    <div className="inline-flex rounded-md border bg-muted p-1">
      {RANGE_TABS.map((tab) => {
        const isActive = activeRange === tab.value;
        return (
          <Link
            key={tab.value}
            href={`?range=${tab.value}`}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ChartSkeleton() {
  return <Skeleton className="h-72 w-full" />;
}
