import type { Article, ArticleCategory } from "@/lib/types";

/**
 * Builder email digest harian. Menghasilkan DUA bentuk:
 *
 * 1. `body`  — plain text. Dipakai untuk `mailto:` (Outlook membuka compose
 *    dengan body ini). mailto TIDAK mendukung HTML.
 * 2. `html`  — rich HTML dengan tabel per artikel (mirip format lampiran).
 *    Dipakai untuk disalin ke clipboard; user paste (Ctrl+V) ke body Outlook
 *    yang rich-text → tabel ter-render.
 */

/** Penerima tetap — kelola di sini kalau perlu ganti. */
export const RECIPIENT_TO = "kania.aidillafirka@astrazeneca.com";
export const RECIPIENT_CC = "muhammad.cavannaufalazizi@astrazeneca.com";

const JKT = "Asia/Jakarta";

const SECTIONS: { category: ArticleCategory; title: string }[] = [
  { category: "About AstraZeneca", title: "ASTRAZENECA INDONESIA" },
  { category: "Regulatory/Policy", title: "REGULATION & POLICY" },
];

export interface SenderInfo {
  name: string;
  jobTitle: string;
  email: string;
}

export interface EmailTemplate {
  to: string;
  cc: string;
  subject: string;
  /** Plain text — untuk mailto + fallback clipboard text/plain. */
  body: string;
  /** Rich HTML bertabel — untuk clipboard text/html (paste ke Outlook). */
  html: string;
  /** mailto: URL siap dipakai. */
  mailtoUrl: string;
}

// =============================================================================
// Helpers
// =============================================================================

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: JKT,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-GB", {
    timeZone: JKT,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Escape untuk konten HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function signatureLines(sender: SenderInfo): string[] {
  const lines = [sender.name, sender.jobTitle, sender.email]
    .map((x) => x.trim())
    .filter(Boolean);
  lines.push("AstraZeneca Indonesia");
  return lines;
}

// =============================================================================
// Plain text (untuk mailto)
// =============================================================================

function plainArticle(a: Article): string {
  return [
    `Headline : ${a.headline}`,
    `Date     : ${fmtDate(a.date)}`,
    `Link     : ${a.url}`,
    "",
    "[SUMMARY]",
    a.summary?.trim() || "(No summary available.)",
  ].join("\n");
}

function buildPlain(articles: Article[], sender: SenderInfo, dateLabel: string): string {
  const lines: string[] = ["AZ DAILY MEDIA MONITORING", dateLabel, ""];

  for (const section of SECTIONS) {
    const inSection = articles.filter((a) => a.category === section.category);
    lines.push(`=== ${section.title} ===`, "");

    if (inSection.length === 0) {
      lines.push("(No news in this category)", "");
    } else {
      inSection.forEach((a, i) => {
        lines.push(plainArticle(a));
        lines.push(i < inSection.length - 1 ? "\n- - -\n" : "");
      });
    }
  }

  lines.push("---", ...signatureLines(sender));
  return lines.join("\n");
}

// =============================================================================
// HTML bertabel (untuk clipboard → paste ke Outlook)
// =============================================================================

const TD_LABEL =
  "padding:6px 10px;background:#f0e6ee;font-weight:bold;width:90px;" +
  "vertical-align:top;font-family:Arial,sans-serif;font-size:13px;";
const TD_VALUE =
  "padding:6px 10px;vertical-align:top;font-family:Arial,sans-serif;font-size:13px;";

function htmlArticle(a: Article): string {
  const summary = a.summary?.trim()
    ? esc(a.summary.trim())
    : "<em>(No summary available.)</em>";

  return `<table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 6px;border-color:#cccccc;">
  <tr><td style="${TD_LABEL}">Headline</td><td style="${TD_VALUE}font-weight:bold;">${esc(a.headline)}</td></tr>
  <tr><td style="${TD_LABEL}">Date</td><td style="${TD_VALUE}">${fmtDate(a.date)}</td></tr>
  <tr><td style="${TD_LABEL}">Link</td><td style="${TD_VALUE}"><a href="${esc(a.url)}" style="color:#003865;">${esc(a.url)}</a></td></tr>
</table>
<p style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;margin:0 0 18px;">
  <strong>[SUMMARY]</strong><br>${summary}
</p>`;
}

function buildHtml(articles: Article[], sender: SenderInfo, dateLabel: string): string {
  const sectionsHtml = SECTIONS.map((section) => {
    const inSection = articles.filter((a) => a.category === section.category);
    const heading = `<h3 style="font-family:Arial,sans-serif;font-size:15px;color:#830051;margin:20px 0 10px;">${esc(section.title)}</h3>`;
    if (inSection.length === 0) {
      return (
        heading +
        `<p style="font-family:Arial,sans-serif;font-size:13px;color:#888888;margin:0 0 12px;">(No news in this category)</p>`
      );
    }
    return heading + inSection.map(htmlArticle).join("");
  }).join("");

  const sig = signatureLines(sender)
    .map((x) => esc(x))
    .join("<br>");

  return `<div style="font-family:Arial,sans-serif;color:#1a1a1a;">
  <p style="font-size:18px;font-weight:bold;color:#830051;margin:0;">AZ Daily Media Monitoring</p>
  <p style="font-size:13px;color:#666666;margin:2px 0 14px;">${esc(dateLabel)}</p>
  ${sectionsHtml}
  <hr style="border:none;border-top:1px solid #cccccc;margin:18px 0 12px;">
  <p style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;margin:0;">${sig}</p>
</div>`;
}

// =============================================================================
// Public
// =============================================================================

export function buildEmailTemplate(
  articles: Article[],
  sender: SenderInfo,
): EmailTemplate {
  const dateLabel = todayLabel();
  const subject = `AZ Daily Media Monitoring - ${dateLabel}`;

  const body = buildPlain(articles, sender, dateLabel);
  const html = buildHtml(articles, sender, dateLabel);

  const mailtoUrl =
    `mailto:${RECIPIENT_TO}` +
    `?cc=${RECIPIENT_CC}` +
    `&subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;

  return { to: RECIPIENT_TO, cc: RECIPIENT_CC, subject, body, html, mailtoUrl };
}
