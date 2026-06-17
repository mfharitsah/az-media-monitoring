"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART } from "@/lib/brand";
import type {
  SentimentTrendPoint,
  SubcategoryBreakdown,
  TopProvince,
  TopSource,
} from "@/lib/types";

/**
 * Charts are client components (Recharts pakai window).
 * Data di-fetch di server, passed as props.
 * Warna dari single source of truth: lib/brand.ts (CHART).
 */

// Alias supaya minim diff di body chart
const COLORS = {
  positive: CHART.positive,
  neutral: CHART.neutral,
  negative: CHART.negative,
  // Distribution palette = subcategory colors + warna untuk standalone
  // category (Crisis & Disruption) yang muncul sebagai bar di chart
  // walaupun bukan subcategory secara struktural.
  distributionPalette: CHART.byDistribution,
};

export function SentimentTrendChart({ data }: { data: SentimentTrendPoint[] }) {
  if (data.length === 0) {
    return <EmptyState message="No sentiment data in this range yet." />;
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey="positive"
          name="Positive"
          stroke={COLORS.positive}
          strokeWidth={2}
        />
        <Line
          type="monotone"
          dataKey="neutral"
          name="Neutral"
          stroke={COLORS.neutral}
          strokeWidth={2}
        />
        <Line
          type="monotone"
          dataKey="negative"
          name="Negative"
          stroke={COLORS.negative}
          strokeWidth={2}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SubcategoryBreakdownChart({
  data,
}: {
  data: SubcategoryBreakdown[];
}) {
  if (data.length === 0) {
    return <EmptyState message="No subcategory data yet." />;
  }
  // Recharts auto-picks `fill` dari tiap data item — tidak perlu <Cell> (deprecated).
  const colored = data.map((d) => ({
    ...d,
    fill:
      COLORS.distributionPalette[
        d.subcategory as keyof typeof COLORS.distributionPalette
      ] ?? "#94a3b8",
  }));
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={colored} margin={{ top: 5, right: 20, left: -10, bottom: 60 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="subcategory"
          tick={{ fontSize: 11 }}
          interval={0}
          angle={-25}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TopSourcesChart({ data }: { data: TopSource[] }) {
  if (data.length === 0) {
    return <EmptyState message="No source data yet." />;
  }
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 32)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 5, right: 20, left: 60, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
        <YAxis
          dataKey="source"
          type="category"
          tick={{ fontSize: 11 }}
          width={120}
          interval={0}
        />
        <Tooltip />
        <Bar dataKey="count" fill={CHART.bar} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TopProvincesChart({ data }: { data: TopProvince[] }) {
  if (data.length === 0) {
    return <EmptyState message="No location data yet." />;
  }
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 32)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 5, right: 20, left: 60, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
        <YAxis
          dataKey="province"
          type="category"
          tick={{ fontSize: 11 }}
          width={120}
          interval={0}
        />
        <Tooltip />
        <Bar dataKey="count" fill={CHART.byCategory["Regulatory/Policy"]} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-64 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {message}
    </div>
  );
}
