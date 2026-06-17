import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SentimentTrendChart,
  SubcategoryBreakdownChart,
  TopAzTopicsChart,
  TopProvincesChart,
  TopSourcesChart,
} from "@/components/analytics-charts";
import {
  AnalyticsKpiCards,
  AnalyticsKpiCardsSkeleton,
} from "@/components/kpi-cards";
import {
  ShareOfVoiceTable,
  ShareOfVoiceTableSkeleton,
} from "@/components/share-of-voice-table";
import { articleRepo } from "@/lib/repositories";
import { isAnalyticsRange, type AnalyticsRange } from "@/lib/types";

export const metadata: Metadata = {
  title: "Analytics",
  description:
    "Sentiment trend, subcategory, source, location & Share of Voice analytics for AstraZeneca Indonesia news.",
};

export const revalidate = 3600;

const TOP_LIMIT = 10;
const TOP_AZ_TOPIC_LIMIT = 5;

function rangeLabel(range: AnalyticsRange): string {
  if (range === "all-time") return "all time";
  if (range === "last-7-days") return "last 7 days";
  // Semester
  const [half, year] = range.split("-");
  return `${half.toUpperCase()} ${year}`;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const rawRange = sp.range ?? "last-7-days";
  // Default + validate — invalid string fallback ke "last-7-days".
  const range: AnalyticsRange = isAnalyticsRange(rawRange)
    ? rawRange
    : "last-7-days";
  const label = rangeLabel(range);

  // Bounds tahun untuk generate opsi semester. Cheap — di-derive dari snapshot.
  const bounds = await articleRepo.dateBounds();

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
        <AnalyticsRangeSelector activeRange={range} bounds={bounds} />
      </header>

      {/* KPI summary — streaming independen dari chart. */}
      <Suspense key={`kpi-${range}`} fallback={<AnalyticsKpiCardsSkeleton />}>
        <AnalyticsKpiCards range={range} />
      </Suspense>

      {/* Share of Voice + Top AZ Topics — side by side di lebar md+ */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Share of Voice by Company"
          description={`AstraZeneca vs 9 competitors — news count (${label})`}
        >
          <Suspense key={`sov-${range}`} fallback={<ShareOfVoiceTableSkeleton />}>
            <ShareOfVoiceSection range={range} />
          </Suspense>
        </ChartCard>

        <ChartCard
          title={`Top ${TOP_AZ_TOPIC_LIMIT} Topics for AZ News`}
          description={`Most frequent keywords in AZ-related articles (${label})`}
        >
          <Suspense key={`azk-${range}`} fallback={<ChartSkeleton />}>
            <TopAzTopicsSection range={range} />
          </Suspense>
        </ChartCard>
      </div>

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
          title={`Top ${TOP_LIMIT} Media Publishing AZ-related News (${label})`}
          description="Publications that produced the most AZ-related articles"
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
  // Scope ke AZ-related news — match dengan chart title baru.
  const data = await articleRepo.topSources(range, TOP_LIMIT, { azOnly: true });
  return <TopSourcesChart data={data} />;
}

async function TopProvincesSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.topProvinces(range, TOP_LIMIT);
  return <TopProvincesChart data={data} />;
}

async function ShareOfVoiceSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.shareOfVoice(range);
  return <ShareOfVoiceTable data={data} />;
}

async function TopAzTopicsSection({ range }: { range: AnalyticsRange }) {
  const data = await articleRepo.topAzTopics(range, TOP_AZ_TOPIC_LIMIT);
  return <TopAzTopicsChart data={data} />;
}

// =============================================================================
// UI primitives
// =============================================================================

/**
 * Range selector — 2 primary tabs (Last 7 days / All time) + semester chips
 * yang di-generate dynamic dari dateBounds.
 *
 * Pure server component — semua navigasi lewat Link (SSR-friendly, no JS).
 */
function AnalyticsRangeSelector({
  activeRange,
  bounds,
}: {
  activeRange: AnalyticsRange;
  bounds: { minYear: number; maxYear: number };
}) {
  // Generate semua semester (h1, h2) antara minYear dan maxYear.
  // Sorted desc (terbaru di depan) supaya user lihat data terbaru duluan.
  const semesters: AnalyticsRange[] = [];
  for (let y = bounds.maxYear; y >= bounds.minYear; y--) {
    semesters.push(`h2-${y}`);
    semesters.push(`h1-${y}`);
  }

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border bg-muted p-1">
        <RangeTab href="?range=last-7-days" active={activeRange === "last-7-days"}>
          Last 7 days
        </RangeTab>
        <RangeTab href="?range=all-time" active={activeRange === "all-time"}>
          All Time
        </RangeTab>
      </div>
      {semesters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            By semester:
          </span>
          {semesters.map((sem) => (
            <RangeChip key={sem} href={`?range=${sem}`} active={activeRange === sem}>
              {rangeLabel(sem)}
            </RangeChip>
          ))}
        </div>
      )}
    </div>
  );
}

function RangeTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

function RangeChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
      }`}
    >
      {children}
    </Link>
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
