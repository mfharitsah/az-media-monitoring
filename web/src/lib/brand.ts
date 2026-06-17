import type {
  ArticleCategory,
  ArticleSentiment,
  ArticleSubcategory,
} from "@/lib/types";

/**
 * Brand color palette — single source of truth.
 * Semua warna semantik (badge, stripe, chart) di-derive dari sini.
 * Jangan hardcode hex di komponen lain — import dari file ini.
 */
export const BRAND = {
  magenta: "#D0006F",
  limeGreen: "#C4D600",
  lightBlue: "#68D2DF",
  gold: "#F0AB00",
  darkMulberry: "#4D0030",
  mulberry: "#830051",
  navy: "#003865",
} as const;

/** Neutral untuk sentimen "Neutral" — structural gray, bukan warna brand. */
const NEUTRAL_GRAY = "#64748b";

/**
 * Versi GELAP dari lime green untuk dipakai sebagai warna TEKS.
 * Lime green asli (#C4D600) kontrasnya ~1.4:1 di background putih → tidak
 * terbaca sebagai teks. Shade ini tetap di keluarga lime, hanya digelapkan
 * agar lolos kontras WCAG (~5:1). Lime asli tetap dipakai untuk solid fill.
 */
const LIME_INK = "#6c7600";

/**
 * Warna untuk indikator berbentuk TEKS (angka Net Sentiment, delta, breakdown).
 * Beda dari swatch (solid fill) — di sini warna harus kontras di bg terang.
 */
export const TEXT_TONE = {
  positive: LIME_INK,
  negative: BRAND.magenta, // sudah cukup gelap untuk teks
  neutral: NEUTRAL_GRAY,
} as const;

/** Pasangan bg + fg untuk solid badge (fg dipilih agar kontras cukup). */
export interface Swatch {
  bg: string;
  fg: string;
}

const WHITE = "#ffffff";
const INK = "#1a1a1a";

// =============================================================================
// Semantic → swatch maps
// =============================================================================

export const SENTIMENT_SWATCH: Record<ArticleSentiment, Swatch> = {
  Positive: { bg: BRAND.limeGreen, fg: INK }, // lime terlalu terang untuk white text
  Neutral: { bg: NEUTRAL_GRAY, fg: WHITE },
  Negative: { bg: BRAND.magenta, fg: WHITE },
};

// Extended palette untuk kategori baru (di luar brand AZ core).
// Dipilih distinct dari mulberry/navy/lime/magenta supaya badge & chart legible.
const CRISIS_RED = "#DC2626"; // Crisis & Disruption — alert/urgency

export const CATEGORY_SWATCH: Record<ArticleCategory, Swatch> = {
  "About AstraZeneca": { bg: BRAND.mulberry, fg: WHITE },
  "Regulatory/Policy": { bg: BRAND.navy, fg: WHITE },
  "Crisis & Disruption": { bg: CRISIS_RED, fg: WHITE },
};

export const SUBCATEGORY_SWATCH: Record<ArticleSubcategory, Swatch> = {
  "AZ Focus": { bg: BRAND.mulberry, fg: WHITE },
  "AZ Mentioned": { bg: BRAND.darkMulberry, fg: WHITE },
  "Stakeholder & Regulator": { bg: BRAND.navy, fg: WHITE },
  "Pharma Policy": { bg: BRAND.lightBlue, fg: INK }, // light blue → dark text
  "General Health Regulation": { bg: BRAND.gold, fg: INK }, // gold → dark text
};

/** Warna solid untuk stripe kartu (pakai subcategory, fallback category). */
export const SUBCATEGORY_STRIPE: Record<ArticleSubcategory, string> = {
  "AZ Focus": BRAND.mulberry,
  "AZ Mentioned": BRAND.darkMulberry,
  "Stakeholder & Regulator": BRAND.navy,
  "Pharma Policy": BRAND.lightBlue,
  "General Health Regulation": BRAND.gold,
};

export const CATEGORY_STRIPE: Record<ArticleCategory, string> = {
  "About AstraZeneca": BRAND.mulberry,
  "Regulatory/Policy": BRAND.navy,
  "Crisis & Disruption": CRISIS_RED,
};

/** Tone teks untuk angka Net Sentiment (positif/negatif/0). */
export function netSentimentColor(net: number): string {
  if (net > 0) return TEXT_TONE.positive;
  if (net < 0) return TEXT_TONE.negative;
  return TEXT_TONE.neutral;
}

// =============================================================================
// Chart palette (Recharts) — solid hex
// =============================================================================

/**
 * Palette untuk Article Distribution chart. Merge SUBCATEGORY_STRIPE +
 * standalone category color — chart bar label bisa berupa subcategory
 * (yang punya parent) atau category name (untuk Crisis & Disruption).
 */
const DISTRIBUTION_PALETTE = {
  ...SUBCATEGORY_STRIPE,
  "Crisis & Disruption": CRISIS_RED,
} as const;

export const CHART = {
  positive: BRAND.limeGreen,
  neutral: NEUTRAL_GRAY,
  negative: BRAND.magenta,
  /** Bar tunggal untuk Top Sources / Top Provinces */
  bar: BRAND.mulberry,
  /** Per-label untuk Article Distribution chart (subcategory + standalone cat) */
  byDistribution: DISTRIBUTION_PALETTE,
  /** Legacy alias — beberapa tempat masih pakai. Bisa di-deprecate nanti. */
  bySubcategory: SUBCATEGORY_STRIPE,
  byCategory: CATEGORY_STRIPE,
} as const;
