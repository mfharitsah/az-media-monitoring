import Link from "next/link";
import { TrendingUp, TrendingDown, Minus, Newspaper, Smile, Target } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { BRAND, TEXT_TONE, netSentimentColor } from "@/lib/brand";
import { articleRepo } from "@/lib/repositories";
import type {
  AllTimeKpi,
  AnalyticsRange,
  ArticleListFilters,
  DailyKpi,
} from "@/lib/types";

// Each KPI card navigates to its own deep-dive page.
const KPI_LINKS = {
  totalNews: "/news",
  netSentiment: "/sentiment",
  aboutAz: "/astrazeneca",
} as const;

// =============================================================================
// PUBLIC: server components
// =============================================================================

/**
 * Landing page — same labels & values as All News (all-time totals),
 * plus a "+N today" delta indicator on each card.
 */
export async function TodayKpiCards() {
  const kpi = await articleRepo.dailyKpi();
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiCard
        href={KPI_LINKS.totalNews}
        icon={<Newspaper className="h-4 w-4" />}
        label="Total News"
        value={kpi.total.toLocaleString("en-US")}
        valueColor={BRAND.darkMulberry}
        footer={
          <div className="space-y-1">
            <DeltaBadge value={kpi.totalLast24h} unit="last 24h" />
          </div>
        }
      />
      <KpiCard
        href={KPI_LINKS.netSentiment}
        icon={<Smile className="h-4 w-4" />}
        label="Net Sentiment"
        value={signed(kpi.netSentiment)}
        valueColor={netSentimentColor(kpi.netSentiment)}
        footer={
          <div className="space-y-1">
            <SentimentBreakdown kpi={kpi} />
            <DeltaBadge value={kpi.netSentimentLast24h} unit="last 24h" />
          </div>
        }
      />
      <KpiCard
        href={KPI_LINKS.aboutAz}
        icon={<Target className="h-4 w-4" />}
        label="About AstraZeneca"
        value={kpi.azRelatedTotal}
        valueColor={BRAND.darkMulberry}
        footer={
          <div className="space-y-1">
            <AzBreakdown kpi={kpi} />
            <DeltaBadge value={kpi.azRelatedLast24h} unit="last 24h" />
          </div>
        }
      />
    </section>
  );
}

/**
 * All News page — KPI yang menyesuaikan filter aktif (range/category/sentiment/q/date).
 * Sama bentuk dengan AllTimeKpiCards tapi datanya adalah subset filtered.
 */
export async function FilteredKpiCards({
  filters,
}: {
  filters: ArticleListFilters;
}) {
  const kpi = await articleRepo.filteredKpi(filters);
  const kpiToday = await articleRepo.dailyKpi();
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiCard
        href={KPI_LINKS.totalNews}
        icon={<Newspaper className="h-4 w-4" />}
        label="Total News"
        value={kpi.total.toLocaleString("en-US")}
        valueColor={BRAND.darkMulberry}
        footer={
          <div className="space-y-1">
            <DeltaBadge value={kpiToday.totalLast24h} unit="last 24h" />
          </div>
        }
      />
      <KpiCard
        href={KPI_LINKS.netSentiment}
        icon={<Smile className="h-4 w-4" />}
        label="Net Sentiment"
        value={signed(kpi.netSentiment)}
        valueColor={netSentimentColor(kpi.netSentiment)}
        footer={<SentimentBreakdown kpi={kpi} />}
      />
      <KpiCard
        href={KPI_LINKS.aboutAz}
        icon={<Target className="h-4 w-4" />}
        label="About AstraZeneca"
        value={kpi.azRelatedTotal}
        valueColor={BRAND.darkMulberry}
        footer={<AzBreakdown kpi={kpi} />}
      />
    </section>
  );
}

/** All News page — cumulative all-time stats, no delta. */
export async function AllTimeKpiCards() {
  const kpi = await articleRepo.allTimeKpi();
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiCard
        href={KPI_LINKS.totalNews}
        icon={<Newspaper className="h-4 w-4" />}
        label="Total News"
        value={kpi.total.toLocaleString("en-US")}
        valueColor={BRAND.darkMulberry}
        footer={<SentimentBreakdown kpi={kpi} />}
      />
      <KpiCard
        href={KPI_LINKS.netSentiment}
        icon={<Smile className="h-4 w-4" />}
        label="Net Sentiment"
        value={signed(kpi.netSentiment)}
        valueColor={netSentimentColor(kpi.netSentiment)}
        footer={<SentimentBreakdown kpi={kpi} />}
      />
      <KpiCard
        href={KPI_LINKS.aboutAz}
        icon={<Target className="h-4 w-4" />}
        label="About AstraZeneca"
        value={kpi.azRelatedTotal}
        valueColor={BRAND.darkMulberry}
        footer={<AzBreakdown kpi={kpi} />}
      />
    </section>
  );
}

/**
 * Analytics page — Total News + Sentiment for AZ News.
 * Range-aware: ikut RangeTabs di /analytics (Last 7 days / All time).
 *
 * Dua call `filteredKpi` paralel:
 * - filteredKpi({range}) → total + global sentiment
 * - filteredKpi({range, categories: ["About AstraZeneca"]}) → AZ-only sentiment
 * Keduanya hit cached snapshot — cost minimal.
 */
export async function AnalyticsKpiCards({ range }: { range: AnalyticsRange }) {
  const [kpi, azKpi] = await Promise.all([
    articleRepo.filteredKpi({ range }),
    articleRepo.filteredKpi({ range, categories: ["About AstraZeneca"] }),
  ]);
  const netAz = azKpi.positiveCount - azKpi.negativeCount;
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <KpiCard
        href={KPI_LINKS.totalNews}
        icon={<Newspaper className="h-4 w-4" />}
        label="Total News"
        value={kpi.total.toLocaleString("en-US")}
        valueColor={BRAND.darkMulberry}
        footer={<SentimentBreakdown kpi={kpi} />}
      />
      <KpiCard
        href={KPI_LINKS.aboutAz}
        icon={<Smile className="h-4 w-4" />}
        label="Sentiment for AZ News"
        value={signed(netAz)}
        valueColor={netSentimentColor(netAz)}
        footer={
          <div className="space-y-1">
            <SentimentBreakdown kpi={azKpi} />
            <span className="block text-xs text-muted-foreground">
              {azKpi.total} AZ article{azKpi.total === 1 ? "" : "s"}
            </span>
          </div>
        }
      />
    </section>
  );
}

/** Skeleton 2-card untuk AnalyticsKpiCards Suspense fallback. */
export function AnalyticsKpiCardsSkeleton() {
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-5">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-10 w-16 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

export function KpiCardsSkeleton() {
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-5">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-10 w-16 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

// =============================================================================
// PRIVATE: shared primitives
// =============================================================================

function SentimentBreakdown({ kpi }: { kpi: AllTimeKpi }) {
  return (
    <span className="block text-xs text-muted-foreground">
      <span style={{ color: TEXT_TONE.positive }} className="font-medium">
        {kpi.positiveCount} positive
      </span>
      {" · "}
      <span style={{ color: TEXT_TONE.negative }} className="font-medium">
        {kpi.negativeCount} negative
      </span>
      {" · "}
      <span>{kpi.neutralCount} neutral</span>
    </span>
  );
}

function AzBreakdown({ kpi }: { kpi: AllTimeKpi }) {
  return (
    <span className="block text-xs text-muted-foreground">
      {kpi.azFocusCount} Focus &middot; {kpi.azMentionedCount} Mentioned
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  valueColor,
  footer,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  /** Hex untuk warna angka utama. Default: foreground (inherit). */
  valueColor?: string;
  footer: React.ReactNode;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group block focus-visible:outline-none"
      aria-label={`${label}: ${value}`}
    >
      <Card className="h-full transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground group-hover:text-foreground">
            {icon}
            {label}
          </div>
          <div
            className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl"
            style={valueColor ? { color: valueColor } : undefined}
          >
            {value}
          </div>
          <div className="mt-2">{footer}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Inline delta indicator — arrow + signed value + unit.
 * Green if up, red if down, gray with dash if 0.
 */
function DeltaBadge({ value, unit }: { value: number; unit: string }) {
  if (value === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <Minus className="h-4 w-4" />
        No change {unit}
      </span>
    );
  }
  const isUp = value > 0;
  const Icon = isUp ? TrendingUp : TrendingDown;
  const color = isUp ? TEXT_TONE.positive : TEXT_TONE.negative;
  return (
    <span
      className="inline-flex items-center gap-1 text-sm font-medium"
      style={{ color }}
    >
      <Icon className="h-4 w-4" />
      {signed(value)} {unit}
    </span>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export type { DailyKpi, AllTimeKpi };
