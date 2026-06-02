import { EmailDigestButton } from "@/components/email-digest-button";
import { articleRepo } from "@/lib/repositories";

/**
 * Server component yang mengambil artikel 24 jam terakhir lalu render
 * tombol compose. Reusable di home page dan all-news page (saat tab
 * Last 24 hours aktif).
 */
export async function EmailDigestLauncher() {
  const articles = await articleRepo.findLast24h(100);
  return <EmailDigestButton articles={articles} />;
}
