"use client";

import { useState } from "react";
import { Calendar, Clock, Globe, Languages, MapPin } from "lucide-react";
import { format, parseISO } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CategoryBadge,
  SentimentBadge,
  SubcategoryBadge,
} from "@/components/article-badges";
import type { Article } from "@/lib/types";

type Lang = "en" | "id";

/**
 * Client wrapper untuk bagian utama artikel yang BISA di-toggle bahasanya.
 * Server-rendered shell (page.tsx) tetap punya badges/source/dates/link.
 *
 * Dual-language di BQ: `headline/summary/keywords` = English (primary),
 * `headline_id/summary_id/keywords_id` = Indonesian original.
 * Toggle = swap field di state — TIDAK panggil Groq, instant + gratis.
 *
 * Edge case: artikel fallback (Groq gagal di pipeline) punya field EN dan ID
 * isi sama. Toggle tetap jalan tapi tidak ada perubahan visible.
 */
export function ArticleTranslator({ article }: { article: Article }) {
  const [lang, setLang] = useState<Lang>("en");

  // Indonesian fallback ke English kalau _id field NULL (mis. artikel lama
  // sebelum dual-column rollout, atau pipeline corruption).
  const idHeadline = article.headline_id ?? article.headline;
  const idSummary = article.summary_id ?? article.summary ?? "";
  const idKeywords = article.keywords_id ?? article.keywords ?? "";

  const display = lang === "en"
    ? {
        headline: article.headline,
        summary: article.summary ?? "",
        keywords: article.keywords ?? "",
      }
    : {
        headline: idHeadline,
        summary: idSummary,
        keywords: idKeywords,
      };

  const keywords = display.keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const publishedDate = format(
    parseISO(article.date),
    "EEEE, d MMMM yyyy 'at' HH:mm",
  );
  const scrapedDate = format(parseISO(article.scraped_at), "d MMM yyyy HH:mm");

  const toggle = () => setLang((l) => (l === "en" ? "id" : "en"));
  const buttonLabel =
    lang === "en" ? "Translate to Indonesian" : "Show English";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <CategoryBadge value={article.category} />
        <SubcategoryBadge value={article.subcategory} />
        <SentimentBadge value={article.sentiment} />
        <Badge variant="outline" className="font-normal">
          <Globe className="mr-1 h-3 w-3" />
          {lang.toUpperCase()}
        </Badge>
      </div>

      <h1 className="text-2xl font-bold leading-tight sm:text-3xl">
        {display.headline}
      </h1>

      {/* Meta info */}
      <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        {article.source && (
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{article.source}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          {publishedDate}
        </div>
        {(article.city || article.province) && (
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            {[article.city, article.province].filter(Boolean).join(", ")}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Scraped: {scrapedDate}
        </div>
      </div>

      {/* Translate toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={toggle}
          className="gap-2"
        >
          <Languages className="h-3.5 w-3.5" />
          {buttonLabel}
        </Button>
      </div>

      {/* Summary */}
      {display.summary && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h2>
          <p className="text-base leading-relaxed">{display.summary}</p>
        </div>
      )}

      {/* Keywords */}
      {keywords.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Keywords
          </h2>
          <div className="flex flex-wrap gap-2">
            {keywords.map((kw) => (
              <Badge key={kw} variant="secondary" className="font-normal">
                {kw}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
