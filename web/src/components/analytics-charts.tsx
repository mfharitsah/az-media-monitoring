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
import type {
  CategoryBreakdown,
  SentimentTrendPoint,
  TopProvince,
  TopSource,
} from "@/lib/types";

/**
 * Charts are client components (Recharts pakai window).
 * Data di-fetch di server, passed as props.
 */

// Color tokens — match badge colors
const COLORS = {
  positive: "#10b981", // emerald-500
  neutral: "#64748b", // slate-500
  negative: "#f43f5e", // rose-500
  categoryPalette: {
    "AZ Focus": "#8b5cf6", // violet-500
    "AZ Mentioned": "#0ea5e9", // sky-500
    Regulatory: "#f59e0b", // amber-500
    Competitor: "#f43f5e", // rose-500
  },
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

export function CategoryBreakdownChart({ data }: { data: CategoryBreakdown[] }) {
  if (data.length === 0) {
    return <EmptyState message="No category data yet." />;
  }
  // Recharts auto-picks `fill` from each data item — no need for deprecated <Cell>.
  const colored = data.map((d) => ({
    ...d,
    fill:
    COLORS.categoryPalette[
      d.category as keyof typeof COLORS.categoryPalette
    ] ?? "#94a3b8", // default to slate-400 if category not in palette
  }));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={colored} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="category" tick={{ fontSize: 12 }} />
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
        <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} />
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
        <Bar dataKey="count" fill="#14b8a6" radius={[0, 4, 4, 0]} />
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
