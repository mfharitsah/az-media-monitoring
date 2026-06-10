"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArticleCategorySchema,
  SUBCATEGORIES_BY_CATEGORY,
  type ArticleCategory,
} from "@/lib/types";

/**
 * Category options — di-derive dari Zod schema agar selalu sinkron dengan types.ts.
 */
const CATEGORY_OPTIONS = [
  { value: "all", label: "All categories" },
  ...ArticleCategorySchema.options.map((c) => ({ value: c, label: c })),
] as const;

const SENTIMENT_OPTIONS = [
  { value: "all", label: "All sentiments" },
  { value: "Positive", label: "Positive" },
  { value: "Neutral", label: "Neutral" },
  { value: "Negative", label: "Negative" },
] as const;

function isCategory(s: string | null): s is ArticleCategory {
  return s !== null && (ArticleCategorySchema.options as readonly string[]).includes(s);
}

/** Param yang dianggap "filter" (range tab tidak termasuk — itu periode). */
const FILTER_KEYS = ["q", "category", "subcategory", "sentiment", "date"] as const;

/**
 * Filter bar untuk All News page. State sepenuhnya di URL searchParams.
 *
 * Inputs CONTROLLED (value dari searchParams) supaya tombol "Clear filters"
 * benar-benar mereset tampilan input — bukan cuma URL. Search pakai local
 * state agar ketikan responsif, di-sync balik dari URL saat navigasi
 * eksternal (mis. klik Clear).
 */
export function NewsFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [q, setQ] = useState(searchParams.get("q") ?? "");

  // Sync search box saat URL berubah dari luar (Clear filters / back button).
  useEffect(() => {
    setQ(searchParams.get("q") ?? "");
  }, [searchParams]);

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === "" || value === "all") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    params.delete("page"); // reset pagination saat filter berubah
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  };

  const clearFilters = () => {
    // Buang semua filter, pertahankan tab range (periode bukan filter).
    const params = new URLSearchParams();
    const range = searchParams.get("range");
    if (range) params.set("range", range);
    setQ("");
    startTransition(() => {
      router.replace(params.toString() ? `?${params.toString()}` : "?", {
        scroll: false,
      });
    });
  };

  const hasActiveFilters = FILTER_KEYS.some((k) => !!searchParams.get(k));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto]">
        <FilterField label="Search" htmlFor="news-search">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="news-search"
              type="search"
              placeholder="Headline, summary, or keyword..."
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setParam("q", e.target.value);
              }}
              className="pl-9"
            />
          </div>
        </FilterField>

        <FilterField label="Category">
          <Select
            value={searchParams.get("category") ?? "all"}
            onValueChange={(v) => {
              setParam("category", v);
              // Clear subcategory ketika category ganti — subcategory yg
              // sebelumnya valid mungkin tidak applicable di kategori baru.
              setParam("subcategory", "all");
            }}
          >
            <SelectTrigger className="w-full lg:w-[190px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        {/* Subcategory cascading: hanya muncul kalau kategori yg dipilih
            punya subkategori. Industry & Competitor + Crisis & Disruption
            standalone → dropdown ini di-hide. */}
        {(() => {
          const selectedCat = searchParams.get("category");
          if (!isCategory(selectedCat)) return null;
          const subs = SUBCATEGORIES_BY_CATEGORY[selectedCat];
          if (subs.length === 0) return null;
          return (
            <FilterField label="Subcategory">
              <Select
                value={searchParams.get("subcategory") ?? "all"}
                onValueChange={(v) => setParam("subcategory", v)}
              >
                <SelectTrigger className="w-full lg:w-[210px]">
                  <SelectValue placeholder="Subcategory" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{`All ${selectedCat} subcategories`}</SelectItem>
                  {subs.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
          );
        })()}

        <FilterField label="Sentiment">
          <Select
            value={searchParams.get("sentiment") ?? "all"}
            onValueChange={(v) => setParam("sentiment", v)}
          >
            <SelectTrigger className="w-full lg:w-[150px]">
              <SelectValue placeholder="Sentiment" />
            </SelectTrigger>
            <SelectContent>
              {SENTIMENT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label="Date" htmlFor="news-date">
          <Input
            id="news-date"
            type="date"
            value={searchParams.get("date") ?? ""}
            onChange={(e) => setParam("date", e.target.value)}
            className="w-full lg:w-[160px]"
            title="Specific date — overrides range tab when set"
          />
        </FilterField>
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-3.5 w-3.5" />
          Clear filters
        </button>
      )}
    </div>
  );
}

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const RANGE_TABS = [
  { value: "last-24h", label: "Last 24h" },
  { value: "last-7-days", label: "Last 7 days" },
  { value: "all-time", label: "All Time" },
] as const;

export function RangeTabs({ activeRange }: { activeRange: string }) {
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
