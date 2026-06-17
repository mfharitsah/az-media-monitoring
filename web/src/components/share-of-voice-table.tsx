import { BRAND } from "@/lib/brand";
import type { ShareOfVoiceRow } from "@/lib/types";

/**
 * Share of Voice table — AZ + 9 kompetitor.
 *
 * Server component (no client interactivity). Pure HTML table biar
 * accessible + zero JS payload. AZ row di-highlight dengan brand mulberry
 * background tinted supaya stand out di antara kompetitor.
 *
 * Data sumber:
 *  - AZ row: di-derive dari articles_latest (category = "About AstraZeneca")
 *  - Competitor rows: dari competitor_articles_latest, count per company
 *
 * Range filter (Last 7 days / All time / Semester) di-handle di repo —
 * komponen ini cuma render apa adanya.
 */
export function ShareOfVoiceTable({ data }: { data: ShareOfVoiceRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        No data in this range yet.
      </div>
    );
  }

  const total = data.reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Rank</th>
            <th className="px-3 py-2 text-left font-medium">Company</th>
            <th className="px-3 py-2 text-right font-medium">News Count</th>
            <th className="px-3 py-2 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={row.company}
              className={row.isAz ? "border-t" : "border-t hover:bg-muted/30"}
              style={
                row.isAz
                  ? { backgroundColor: `${BRAND.mulberry}14` }
                  : undefined
              }
            >
              <td className="px-3 py-2 tabular-nums">
                <span
                  className="font-semibold"
                  style={row.isAz ? { color: BRAND.mulberry } : undefined}
                >
                  #{row.rank}
                </span>
              </td>
              <td className="px-3 py-2">
                <span
                  className="font-medium"
                  style={row.isAz ? { color: BRAND.mulberry } : undefined}
                >
                  {row.company}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {row.count.toLocaleString("en-US")}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {row.sharePct.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t bg-muted/30 text-xs text-muted-foreground">
          <tr>
            <td className="px-3 py-2" colSpan={2}>
              Total
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {total.toLocaleString("en-US")}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function ShareOfVoiceTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Rank</th>
            <th className="px-3 py-2 text-left font-medium">Company</th>
            <th className="px-3 py-2 text-right font-medium">News Count</th>
            <th className="px-3 py-2 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 10 }).map((_, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-2">
                <div className="h-4 w-8 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-3 py-2">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-3 py-2 text-right">
                <div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" />
              </td>
              <td className="px-3 py-2 text-right">
                <div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
