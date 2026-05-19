import Link from "next/link";
import { Suspense } from "react";
import { CalendarDays, BarChart3, ArrowRight } from "lucide-react";

import { ArticleCardLandscape } from "@/components/article-card-landscape";
import { TodayKpiCards, KpiCardsSkeleton } from "@/components/kpi-cards";
import { Skeleton } from "@/components/ui/skeleton";
import { articleRepo } from "@/lib/repositories";

// Today changes each day → hourly revalidation at page level.
// DAL has its own cache layer (CACHE_TTL_SEC) for finer-grained control.
export const revalidate = 3600;

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 py-10 sm:px-6 lg:px-8">
      <HeroSection />
      <Suspense fallback={<KpiCardsSkeleton />}>
        <TodayKpiCards />
      </Suspense>
      <Suspense fallback={<TodayListSkeleton />}>
        <TodayList />
      </Suspense>
    </div>
  );
}

function HeroSection() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  });

  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <CalendarDays className="h-4 w-4" />
        {today}
      </div>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
        Today&rsquo;s News
      </h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Monitor news about AstraZeneca Indonesia and pharma regulatory updates
        from various sources, with sentiment and location analysis.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href="/news"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          All news
          <ArrowRight className="h-4 w-4" />
        </Link>
        <span className="text-muted-foreground">·</span>
        <Link
          href="/analytics"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          <BarChart3 className="h-4 w-4" />
          View analytics
        </Link>
      </div>
    </section>
  );
}

async function TodayList() {
  // Prefer "today" articles (timezone Asia/Jakarta). Edge case: early morning
  // sebelum cron pagi WIB jalan, today bisa kosong walaupun BQ ada artikel
  // dari kemarin sore. Fallback ke 10 artikel terbaru supaya home tidak kosong.
  const todayArticles = await articleRepo.findToday(50);
  const usingFallback = todayArticles.length === 0;
  const articles = usingFallback
    ? await articleRepo.findRecent(10)
    : todayArticles;

  if (articles.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-muted-foreground">
          No articles available yet. Pipeline may not have run — check{" "}
          <Link href="/news" className="font-medium text-primary hover:underline">
            all news
          </Link>{" "}
          for any historical data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {usingFallback ? (
        <p className="text-sm text-muted-foreground">
          No news yet for today. Showing the{" "}
          <span className="font-medium text-foreground">{articles.length} most recent</span>{" "}
          article{articles.length === 1 ? "" : "s"} instead.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {articles.length} latest article{articles.length === 1 ? "" : "s"} today
        </p>
      )}
      {articles.map((article) => (
        <ArticleCardLandscape key={article.id} article={article} />
      ))}
    </div>
  );
}

function TodayListSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-44 w-full" />
      ))}
    </div>
  );
}
