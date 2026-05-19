import { revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Cache invalidation endpoint. Dipanggil dari GitHub Actions setelah
 * bq_load.py sukses — bikin Next.js drop semua cached data tagged 'articles'
 * sehingga visitor berikutnya akan trigger fresh BQ query.
 *
 * Auth: Bearer token di Authorization header. Secret di-set sama persis di:
 *   - .env.local (dev)
 *   - Vercel env vars (prod)
 *   - GitHub Secrets (CI/CD)
 *
 * Usage:
 *   curl -X POST https://your-app.vercel.app/api/revalidate \
 *     -H "Authorization: Bearer <REVALIDATE_SECRET>"
 */
export async function POST(req: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    // Misconfig — refuse to operate so prod doesn't accidentally accept any caller.
    return NextResponse.json(
      { error: "REVALIDATE_SECRET not configured" },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  
  revalidateTag("articles", "max");

  return NextResponse.json({
    revalidated: true,
    tag: "articles",
    at: new Date().toISOString(),
  });
}
