"""
AstraZeneca Indonesia — Daily News Fetcher (v5 — Groq Cloud)
=============================================================

AI layer powered by Groq Cloud + Llama 3.3 70B Versatile (open source).
Free tier: 14.400 requests/day (kita butuh ~100/hari).

Setup Groq (5 menit, sekali)
-----------------------------
1. Daftar di https://console.groq.com (free, pakai Google account juga bisa)
2. Buka https://console.groq.com/keys
3. Klik "Create API Key" → kasih nama "az-news-monitor" → Copy key
4. Set environment variable:
       export GROQ_API_KEY="gsk_..."

Usage
-----
    python fetch_news.py                                # rule-based fallback
    python fetch_news.py --use-groq                     # pakai Llama 3.3 via Groq
    python fetch_news.py --use-groq --hours 48 --output today.csv

Dependencies
------------
    pip install feedparser requests beautifulsoup4 python-dateutil pydantic googlenewsdecoder

Cron schedule:
    0 6 * * * /path/to/venv/bin/python fetch_news.py --use-groq \\
              --output /data/news-$(date +%%Y-%%m-%%d).csv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import quote_plus

import feedparser
import requests
import trafilatura
from bs4 import BeautifulSoup
from dateutil import parser as date_parser
from googlenewsdecoder import gnewsdecoder
from pydantic import BaseModel, ConfigDict, Field, ValidationError


# ============================================================================
# CONFIG
# ============================================================================

# Keyword tracks — CURATED SUBSET dari Media Monitoring Keyword spec (~44 keywords).
# Tiap keyword di-query terpisah ke Google News RSS; hasil di-dedupe by URL.
#
# Curation strategy:
# - Beberapa keyword spec di-append qualifier untuk narrow ke konteks pharma/health,
#   karena keyword sendirian terlalu broad dan menarik banyak noise:
#     "BPOM"              → "BPOM obat"                       (skip BPOM kosmetik/food/jamu)
#     "BPJS Kesehatan"    → "BPJS Kesehatan formularium"      (skip layanan klaim umum)
#     "Kementerian Kesehatan RI" → "Kementerian Kesehatan RI farmasi"
#     "Komisi IX DPR"     → "Komisi IX DPR kesehatan"         (handle non-health topics)
#     "Penyakit Langka"   → "Penyakit Langka AstraZeneca"     (narrow ke konteks AZ)
# - Beberapa keyword di-skip karena redundant via LM classification atau over-broad:
#   "Kemenperin farmasi", "LPPOM MUI vaksin halal", "pharma regulation Indonesia",
#   "innovative drug policy", "biologic regulation", "vaccine regulation",
#   "local content requirement pharmaceutical", "health technology assessment Indonesia",
#   "BPJS drug formulary", "e-catalogue obat Indonesia", "tender obat Indonesia",
#   "regulasi kesehatan Indonesia", "kebijakan kesehatan Indonesia",
#   "Undang-Undang Kesehatan Indonesia", "kebijakan Kementerian Kesehatan",
#   "kebijakan BPOM", "kebijakan JKN BPJS Kesehatan", "kebijakan distribusi obat"
#
# Quality control downstream:
#   1. Domain harus ada di SOURCE_WHITELIST (filter sebelum Groq → hemat quota)
#   2. Body length harus >= MIN_BODY_CHARS (filter article tanpa body lengkap)
#   3. LM final-klasifikasikan ke Subcategory (skip "Not Relevant")
# Per-category keyword lists — di-gabung jadi DEFAULT_KEYWORDS, tapi disimpan
# terpisah supaya bisa dipakai untuk targeted scrape (mis. cuma kategori baru).
KEYWORDS_AZ = [
    "AstraZeneca",
    "AstraZeneca Indonesia",
    "AZ Forest",
    "Young Health Programme",
    "Penyakit Langka AstraZeneca",
]

KEYWORDS_REGULATORY = [
    "BPOM obat",
    "BPJS Kesehatan formularium",
    "Kementerian Kesehatan RI farmasi",
    "Komisi IX DPR kesehatan",
    "Formularium Nasional Fornas",
    "INA-CBGs",
    "TKDN farmasi",
    "e-katalog LKPP obat",
    "pharmaceutical policy Indonesia",
    "drug reimbursement Indonesia",
    "HTA Indonesia",
    "market access Indonesia pharmaceutical",
    "Peraturan Menteri Kesehatan",
    "regulasi farmasi Indonesia",
    "kebijakan obat Indonesia",
    "kebijakan vaksin Indonesia",
    "RUU kesehatan Indonesia",
    "kebijakan harga obat",
    "regulasi uji klinis Indonesia",
]

KEYWORDS_INDUSTRY_COMPETITOR = [
    "Roche", "Roche Indonesia",
    "Novo Nordisk", "Novo Nordisk Indonesia",
    "Novartis", "Novartis Indonesia",
    "Pfizer", "Pfizer Indonesia",
    "MSD", "MSD Indonesia",
    "Merck Sharp Dohme",
    "Merck Indonesia", "PT Merck Tbk",
    "GlaxoSmithKline", "GSK Indonesia",
    "Bayer", "Bayer Indonesia",
    "Takeda", "Takeda Indonesia",
    "Abbott Indonesia",
    "Zuellig Pharma",
]

# Crisis & Disruption — AND-queries spesifik per Google News.
# Beberapa keyword broad (banjir, gempa) jadi pakai AND dengan konteks farmasi
# untuk narrow ke berita yang punya nuansa industri kita.
KEYWORDS_CRISIS = [
    "banjir AND distribusi obat",
    "banjir AND rantai pasok",
    "banjir AND farmasi",
    "gempa bumi AND rumah sakit",
    "gempa bumi AND kesehatan",
    "tsunami Indonesia",
    "erupsi gunung Indonesia",
    "cuaca ekstrem Indonesia",
    "hujan ekstrem Indonesia",
    "bencana alam AND kesehatan",
    "bencana nasional Indonesia",
    "status siaga bencana",
    "status tanggap darurat",
    "darurat nasional",
    "demonstrasi AND Kementerian Kesehatan",
    "demonstrasi AND istana presiden",
    "demonstrasi AND gedung DPR",
    "aksi buruh AND farmasi",
    "force majeure AND industri farmasi",
    "gangguan logistik AND obat",
    "obat AND evakuasi",
]

# Gabungan semua kategori. Override via --keywords kalau perlu targeted scrape.
DEFAULT_KEYWORDS = [
    *KEYWORDS_AZ,
    *KEYWORDS_REGULATORY,
    *KEYWORDS_INDUSTRY_COMPETITOR,
    *KEYWORDS_CRISIS,
]
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=id&gl=ID&ceid=ID:id"
# Real browser UA — beberapa news Indonesia (Tribunnews, Detik) blokir UA non-browser dengan 403.
# Untuk media monitoring legit (bukan abuse), ini practice umum.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_OUTPUT = "astrazeneca_news.csv"

# Source whitelist — hanya artikel dari publikasi ini yang di-process.
# Match by URL domain (apex + subdomains). Update kalau perlu tambah outlet.
#
# Subscription-only sources yang sengaja SKIP (tidak ada akses kredensial):
#   - "kompas.id"           (Kompas Premium subscription)
#   - The Jakarta Post E-Post (subscription edition)
# Kalau di masa depan ada subscription/API key, tambah domain di sini + handle
# auth header di fetch_article_text (mungkin perlu cookie jar atau bearer token).
SOURCE_WHITELIST = {
    # --- General news / wire services ---
    "kompas.com",          # umum + health (versi free)
    "kompas.tv",
    "detik.com",           # covers detiknews + health.detik.com + news.detik.com
    "tribunnews.com",      # covers regional: jateng/jabar/sumsel/medan/makassar/manado/pontianak/kupang/ambon/papua/bangka.tribunnews.com
    "antaranews.com",
    "liputan6.com",
    "kumparan.com",
    "tempo.co",
    "merdeka.com",
    "republika.co.id",
    "okezone.com",
    "sindonews.com",
    "inews.id",
    "viva.co.id",
    "jpnn.com",
    "suara.com",
    "idntimes.com",
    "idnnews.id",
    "tirto.id",
    "jawapos.com",
    "pikiran-rakyat.com",
    "mediaindonesia.com",
    "metrotvnews.com",
    "beritasatu.com",
    "narasi.tv",
    "rri.co.id",
    "tvonenews.com",
    "thejakartapost.com",

    # --- Business / market / political-economy ---
    "kontan.co.id",
    "bisnis.com",
    "cnbcindonesia.com",
    "cnnindonesia.com",
    "katadata.co.id",
    "investor.id",
    "swa.co.id",
    "wartaekonomi.co.id",

    # --- Health, parenting & lifestyle (relevant untuk health regulation coverage) ---
    "hellosehat.com",
    "haibunda.com",
    "theasianparent.com",  # id.theasianparent.com — subdomain match
    "popmama.com",
    "orami.co.id",
    "femina.co.id",
    "popbela.com",
    "sehatq.com",
    "grid.id",             # covers nakita.grid.id + health.grid.id (GridHealth)
}

# Title patterns yang menandakan entry RSS rusak (image filename, dll.) — skip.
JUNK_TITLE_RE = re.compile(r"\.(jpg|jpeg|png|gif|webp|html|aspx)\b", re.IGNORECASE)

# Groq config
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
# Default: openai/gpt-oss-120b — support Structured Outputs + lebih reliable di JSON grammar.
# Test menunjukkan llama-4-scout kadang generate extra brace `}}` → Groq strict reject.
# gpt-oss-120b lebih lambat (~1.3s vs 0.5s) tapi 100% pass rate di sample test.
# Catatan: llama-3.3-70b-versatile TIDAK support json_schema, jangan dipakai.
# Override via env: GROQ_MODEL=... — daftar model: https://console.groq.com/docs/structured-outputs#supported-models
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_TIMEOUT = 30  # detik per call (Groq biasanya 1-3 detik)

POSITIVE_WORDS = {
    "berhasil", "sukses", "tumbuh", "meningkat", "naik", "untung", "positif",
    "manfaat", "inovasi", "kemitraan", "kerja sama", "kolaborasi", "investasi",
    "ekspansi", "luncurkan", "dukung", "bantu", "selamatkan", "sembuh",
    "tingkatkan", "perluas", "perbaikan", "raih", "penghargaan", "terdepan",
    "unggul", "efektif", "aman", "disetujui", "approve", "approved",
    "breakthrough", "terobosan", "harapan", "solusi"
}
NEGATIVE_WORDS = {
    "gagal", "turun", "rugi", "kritik", "tolak", "larang", "tarik", "recall",
    "bahaya", "efek samping", "kematian", "meninggal", "korban", "krisis",
    "tuntutan", "gugat", "skandal", "hoaks", "kontroversi", "masalah",
    "khawatir", "ragu", "tunda", "tidak aman", "ditarik", "dilarang",
    "dicabut", "merugikan", "berisiko", "ancaman", "buruk", "memburuk",
    "investigasi"
}

REGULATORY_KEYWORDS = [
    "bpom", "kemenkes", "kementerian kesehatan", "menkes", "izin edar",
    "regulasi", "fda", "ema", "approval", "registrasi", "kebijakan",
    "pemerintah", "bpjs", "jkn", "formularium", "regulator", "perpres",
    "peraturan menteri", "permenkes", "pp kesehatan", "uu kesehatan"
]

# Schema enforced via Groq Structured Outputs (JSON Schema mode).
# Struktur dijamin sama dengan Pydantic model di bawah — prompt hanya jelaskan SEMANTIK.
PRESERVE_TERMS = (
    "AstraZeneca, Vaxzevria, Imfinzi, Tagrisso, Forxiga, Soliris, "
    "BPOM, Kemenkes, Kementerian Kesehatan, Menkes, BPJS, JKN, "
    "Formularium Nasional, Fornas, INA-CBGs, TKDN, LKPP, MUI, "
    "Komisi IX, DPR, Permenkes, UU Kesehatan, RUU Kesehatan, "
    "AZ Forest, Young Health Programme"
)

SYSTEM_PROMPT = f"""Anda adalah analis media untuk AstraZeneca Indonesia. Tugas: analisis artikel + hasilkan output BAHASA INDONESIA dan ENGLISH sekaligus.

Output schema punya field SEPARATE untuk Indonesian (`summary_id`, `keywords_id`) dan English (`headline_en`, `summary_en`, `keywords_en`). Hasilkan SEMUA — content identik secara fakta, hanya bahasa yang beda.

=== PRESERVE EXACTLY di output English (jangan diterjemahkan) ===
{PRESERVE_TERMS}

Aturan translation:
- `headline_en`: terjemahan headline yang diberikan user. Bahasa Inggris jurnalistik natural, mirip panjang aslinya.
- `summary_en`: terjemahan dari `summary_id`. Fakta identik, bahasa English natural.
- `keywords_en`: terjemahan dari `keywords_id`. Comma-separated, max 5.
- `city` dan `province`: TIDAK diterjemahkan (nama tempat Indonesia).

=== Klasifikasi Subcategory (urutan prioritas dari atas) ===

=== Category: About AstraZeneca ===

1. "AZ Focus" — AstraZeneca atau produknya (Vaxzevria, Imfinzi, Tagrisso, Forxiga, dll) menjadi TOPIK UTAMA artikel.
   Contoh: "AstraZeneca raih izin edar obat X", "AZ Forest dorong reforestasi", "Kemitraan AZ dengan Kemenkes".

2. "AZ Mentioned" — AstraZeneca disebut sebagai data point/contoh untuk topik yang lebih general.
   Contoh: artikel industri farmasi yg menyebut AZ sebagai salah satu dari banyak perusahaan, riset penyakit langka yg sebut AZ sebagai donor.

=== Category: Regulatory/Policy ===

3. "Stakeholder & Regulator" — fokus ke AKTOR/INSTITUSI: BPOM, Kementerian Kesehatan, Menkes, BPJS Kesehatan, Komisi IX DPR, Kemenperin, LKPP, MUI Halal vaksin.
   Contoh: "BPOM perketat pengawasan obat", "Menkes umumkan program X", "Komisi IX DPR bahas RUU kesehatan".

4. "Pharma Policy" — kebijakan SPESIFIK industri farmasi: HTA, Formularium Nasional, e-katalog/tender obat, izin edar obat, INA-CBGs, TKDN farmasi, drug reimbursement, market access farmasi, biologic/vaccine regulation, uji klinis.
   Contoh: "Pemerintah revisi e-katalog obat", "HTA proses penilaian obat baru".

5. "General Health Regulation" — regulasi/kebijakan kesehatan UMUM (di luar farmasi spesifik): UU Kesehatan, RUU Kesehatan, Permenkes umum, kebijakan vaksin/JKN/distribusi obat, harga obat.
   Contoh: "Pemerintah terbitkan UU Kesehatan baru", "Kebijakan vaksinasi dewasa direvisi".

=== Category: Industry & Competitor (standalone — tidak ada sub-level) ===

6. "Industry & Competitor" — berita tentang kompetitor farmasi AstraZeneca atau dinamika industri farmasi (di luar AZ, di luar regulator/pemerintah).
   Termasuk: Roche, Novo Nordisk, Novartis, Pfizer, MSD (Merck Sharp & Dohme), Merck, PT Merck Tbk, GlaxoSmithKline (GSK), Bayer, Takeda, Abbott, Zuellig Pharma — beserta cabang Indonesia mereka.
   Contoh: "Roche luncurkan obat baru di Asia", "Pfizer raih izin edar vaksin di Indonesia", "Bayer Indonesia investasi pabrik".
   CATATAN: kalau artikel utamanya tentang AstraZeneca (walaupun menyebut kompetitor), pilih "AZ Focus" atau "AZ Mentioned" alih-alih ini.

=== Category: Crisis & Disruption (standalone — tidak ada sub-level) ===

7. "Crisis & Disruption" — bencana alam, civil unrest, atau peristiwa yang berpotensi mengganggu operasi farmasi / rantai pasok obat / akses layanan kesehatan.
   Termasuk: banjir, gempa bumi, tsunami, erupsi gunung, cuaca ekstrem, hujan ekstrem, bencana nasional/alam; demonstrasi (istana presiden, Kementerian Kesehatan, gedung DPR), aksi buruh, status siaga/tanggap darurat, darurat nasional; gangguan logistik obat, force majeure industri farmasi, gangguan rantai pasok, evakuasi obat.
   Contoh: "Banjir di Jakarta ganggu distribusi obat", "Gempa Cianjur rumah sakit rusak", "Demonstrasi di gedung DPR farmasi terhambat".
   CATATAN: kalau peristiwa terjadi tapi TIDAK ada konteks farmasi/kesehatan/distribusi → "Not Relevant".

=== Skip ===

6. "Not Relevant" — TIDAK fit ke 5 di atas. Pilih ini kalau:
   - Artikel kesehatan umum tanpa konteks AZ/farmasi/regulasi
   - Artikel BPJS layanan klaim/keanggotaan umum (bukan obat/farmasi)
   - Artikel pejabat/politik tanpa relevansi farmasi/kesehatan
   - Artikel kompetitor TANPA konteks AZ atau industri farmasi
   PENTING: "Not Relevant" akan di-skip. Jangan paksa fit kalau memang tidak relevan.

Aturan sentiment dari sudut pandang AstraZeneca:
- "Positive": kemitraan baru, approval AZ, prestasi AZ, growth AZ, kebijakan yg menguntungkan AZ
- "Negative": kegagalan trial AZ, recall produk AZ, kontroversi AZ, kritik terhadap AZ, kebijakan yg menghambat AZ
- "Neutral": factual update tanpa positioning jelas. Default untuk Regulatory dan Not Relevant.

=== Aturan SUMMARY (PENTING — sering dilanggar) ===

Summary HARUS berasal dari BODY artikel, BUKAN dari HEADLINE.

ATURAN MUTLAK:
- JANGAN sekedar paraphrase atau perluas headline. Headline 1 kalimat singkat — summary harus
  membawa info SPESIFIK yang TIDAK ADA di headline (angka konkret, nama orang/instansi, alasan,
  konteks, dampak, kutipan).
- BUKAN bentuk: "Headline X. Hal ini terjadi karena Y." kalau Y tidak detail.
- BUKAN bentuk: "Artikel membahas tentang [headline rephrased]." — INI YANG SERING SALAH.
- BENTUK YANG BENAR: "[Aktor] [aksi spesifik] [angka/lokasi]. [Alasan/konteks]. [Dampak/respons]."

Contoh BAD: headline "BPOM Tarik 11 Kosmetik Berbahaya" → summary "BPOM melakukan penarikan
terhadap 11 produk kosmetik yang dianggap berbahaya."  ❌ ini cuma rewrite headline.

Contoh GOOD: summary "BPOM tarik 11 kosmetik yang mengandung merkuri dan hidrokuinon, ditemukan
di Jakarta dan Surabaya. Produk dikeluarkan tanpa izin edar resmi sejak 2024. Konsumen diminta
laporkan via aplikasi BPOM Mobile."  ✓ tambah merk bahan, lokasi, periode, channel respons.

Kalau body terlalu singkat / cuma paragraf pertama copy headline → return summary kosong (string "")
DI KEDUA FIELD (`summary_id` dan `summary_en`).
JANGAN paksa bikin summary fake — Pydantic schema mengizinkan empty string.

Panjang summary: 2-3 kalimat, maksimal 300 karakter (berlaku untuk Indonesian dan English).
Keywords: 5 kata kunci penting (entitas/topik specific), dipisah koma. Hasilkan di kedua field
(`keywords_id` Indonesian, `keywords_en` English).

Aturan city + province:
- Ekstrak kota & provinsi Indonesia yang menjadi FOKUS berita (lokasi event, kantor, pasien, pejabat berbicara, dll.).
- Gunakan nama resmi provinsi: "DKI Jakarta", "Jawa Barat", "Jawa Timur", "Banten", "Bali", "Sumatera Utara", dll.
- Untuk Jakarta, kota = "Jakarta" (tanpa keterangan utara/selatan kecuali eksplisit), province = "DKI Jakarta".
- Kalau berita nasional tanpa kota spesifik, atau berita global/luar negeri, isi kedua field dengan string kosong "".
- JANGAN tebak; lebih baik kosong daripada salah."""


# ============================================================================
# RESPONSE SCHEMA (single source of truth)
# ============================================================================

# 2-level taxonomy: Category > Subcategory.
# LM hanya return Subcategory; Category di-derive via SUBCATEGORY_TO_CATEGORY.
#
# Category "About AstraZeneca":
#   - "AZ Focus"             : AZ atau produknya (Vaxzevria, Imfinzi, Tagrisso, dll) sbg topik utama
#   - "AZ Mentioned"         : AZ disebut sebagai data point dalam topik yg lebih general
#
# Category "Regulatory/Policy":
#   - "Stakeholder & Regulator"   : aktor pemerintah (BPOM, Kemenkes, BPJS, DPR Komisi IX, LKPP, MUI Halal)
#   - "Pharma Policy"             : kebijakan industri farmasi (HTA, formularium, izin edar obat, e-catalogue, market access)
#   - "General Health Regulation" : regulasi kesehatan umum (UU Kesehatan, RUU, Permenkes, kebijakan vaksin/obat)
#
# Skip:
#   - "Not Relevant"  : di-FILTER OUT di process_article, tidak masuk database
Subcategory = Literal[
    # About AstraZeneca
    "AZ Focus", "AZ Mentioned",
    # Regulatory/Policy
    "Stakeholder & Regulator", "Pharma Policy", "General Health Regulation",
    # Standalone categories (no real subcategory — di-flatten ke level kategori
    # di process_article: row.category = label ini, row.subcategory = NULL)
    "Industry & Competitor",
    "Crisis & Disruption",
    # Skip
    "Not Relevant",
]
Sentiment = Literal["Positive", "Neutral", "Negative"]

SUBCATEGORY_TO_CATEGORY: dict[str, str] = {
    "AZ Focus": "About AstraZeneca",
    "AZ Mentioned": "About AstraZeneca",
    "Stakeholder & Regulator": "Regulatory/Policy",
    "Pharma Policy": "Regulatory/Policy",
    "General Health Regulation": "Regulatory/Policy",
    # Self-mapping — "subcategory" ini di-promote ke level kategori
    "Industry & Competitor": "Industry & Competitor",
    "Crisis & Disruption": "Crisis & Disruption",
}

# Subcategory yang sebenarnya kategori standalone (tidak punya sub).
# Di process_article, untuk subcategory ini: row.category = label, row.subcategory = NULL.
STANDALONE_CATEGORIES: set[str] = {"Industry & Competitor", "Crisis & Disruption"}


class ArticleAnalysis(BaseModel):
    """Schema response dari LM. Dipakai untuk:
    1. Generate JSON Schema → dikirim ke Groq (`response_format: json_schema`)
    2. Validate + parse response → typed Python object

    Kalau struktur berubah, cukup edit class ini — prompt & validasi sinkron otomatis.

    DUAL-LANGUAGE: LM produce SEPARATE Indonesian + English fields untuk headline,
    summary, dan keywords. Disimpan ke kolom BQ terpisah (mis. `headline` = en,
    `headline_id` = id) supaya UI bisa toggle bahasa tanpa Groq call on-demand.
    """
    # `extra='forbid'` menambahkan `additionalProperties: false` ke JSON Schema —
    # Groq strict mode butuh ini di setiap object.
    model_config = ConfigDict(extra="forbid")

    # --- Headline (translate dari RSS Indonesian) ---
    headline_en: str = Field(
        description="English headline translation. Preserve proper nouns and "
                    "Indonesian acronyms (BPOM, Kemenkes, AstraZeneca, BPJS, JKN, "
                    "Permenkes, Komisi IX, DPR, dll). Length similar to original.",
        max_length=400,
    )
    # --- Summary (LM generate dari body) ---
    summary_id: str = Field(
        description="Ringkasan 2-3 kalimat Bahasa Indonesia, max 300 karakter",
        max_length=600,
    )
    summary_en: str = Field(
        description="English summary, 2-3 sentences, max 300 chars. "
                    "Translate `summary_id` keeping facts identical. "
                    "Preserve proper nouns and Indonesian acronyms.",
        max_length=600,
    )
    # --- Classification ---
    subcategory: Subcategory = Field(description="Klasifikasi spesifik artikel (lihat aturan di prompt)")
    sentiment: Sentiment = Field(description="Sentimen dari sudut pandang AstraZeneca")
    # --- Keywords (Indonesian + English) ---
    keywords_id: str = Field(description="5 keyword Bahasa Indonesia dipisah koma")
    keywords_en: str = Field(
        description="5 English keywords, comma-separated. Translate keywords_id; "
                    "preserve proper nouns and acronyms.",
    )
    # --- Location (proper nouns Indonesian — no translation) ---
    city: str = Field(
        description="Kota di Indonesia yang menjadi fokus berita (mis. 'Jakarta', 'Surabaya'). "
                    "String kosong '' kalau tidak ada kota spesifik disebut.",
        max_length=80,
    )
    province: str = Field(
        description="Provinsi Indonesia yang menjadi fokus berita, nama resmi "
                    "(mis. 'DKI Jakarta', 'Jawa Barat', 'Jawa Timur'). "
                    "String kosong '' kalau tidak disebut atau berita nasional/global.",
        max_length=80,
    )


def _build_response_format() -> dict:
    """Bangun payload `response_format` Groq Structured Outputs dari Pydantic model."""
    schema = ArticleAnalysis.model_json_schema()
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "ArticleAnalysis",
            "schema": schema,
            "strict": True,
        },
    }


# ============================================================================
# RULE-BASED HELPERS (fallback)
# ============================================================================

def make_article_id(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]


def is_whitelisted_source(url: str) -> bool:
    """True kalau domain URL ada di SOURCE_WHITELIST (incl. subdomain match)."""
    from urllib.parse import urlparse
    netloc = urlparse(url).netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    return any(netloc == d or netloc.endswith("." + d) for d in SOURCE_WHITELIST)


def resolve_google_news_url(url: str) -> str:
    """Decode URL Google News RSS (`news.google.com/rss/articles/...`) ke URL artikel asli.

    Google News URL bukan HTTP-redirect; URL asli base64-encoded di path dan harus
    di-decode dengan algoritma khusus. Untuk URL non-Google News, return apa adanya.
    """
    if "news.google.com" not in url:
        return url
    try:
        result = gnewsdecoder(url, interval=1)
        if result.get("status") and result.get("decoded_url"):
            return result["decoded_url"]
        print(f"    ! decode gagal: {result.get('message', '')[:80]}", file=sys.stderr)
        return url
    except Exception as e:
        print(f"    ! decode error: {e}", file=sys.stderr)
        return url


def parse_source_from_title(title: str) -> tuple[str, str]:
    if " - " in title:
        parts = title.rsplit(" - ", 1)
        return parts[0].strip(), parts[1].strip()
    return title.strip(), ""


def fetch_article_text(url: str, timeout: int = 10) -> str:
    """Extract main article body. trafilatura → fallback ke selectors generic.

    trafilatura adalah library purpose-built untuk news extraction — handle 99%
    situs Indonesia (Kompas, Detik, Tempo, Tribun, ANTARA) tanpa site-specific
    selectors. Return empty string kalau gagal — caller harus check len()
    sebelum kirim ke LM (otherwise summary jadi rubbish karena LM cuma punya
    headline).
    """
    try:
        resp = requests.get(
            url, headers={"User-Agent": USER_AGENT}, timeout=timeout, allow_redirects=True
        )
        if resp.status_code != 200:
            return ""

        # Primary: trafilatura — pakai favor_recall biar agresif extract main content
        extracted = trafilatura.extract(
            resp.text,
            favor_recall=True,
            include_comments=False,
            include_tables=False,
            no_fallback=False,
        )
        if extracted and len(extracted) > 200:
            return extracted[:5000]

        # Fallback: selector-based (kalau trafilatura gagal — rare untuk modern news sites)
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
            tag.decompose()
        selectors = [
            "article", "[itemprop='articleBody']", ".detail__body-text",
            ".read__content", ".article-content", ".post-content",
            ".detail-text", ".content-detail", "main", "#content"
        ]
        for sel in selectors:
            elem = soup.select_one(sel)
            if elem:
                text = elem.get_text(separator=" ", strip=True)
                if len(text) > 200:
                    return text[:5000]
        paragraphs = [p.get_text(strip=True) for p in soup.find_all("p")]
        return " ".join(paragraphs)[:5000]
    except Exception as e:
        print(f"    ! fetch failed: {e}", file=sys.stderr)
        return ""


# Body length threshold sebelum kirim ke LM. Di bawah ini, body terlalu tipis
# untuk menghasilkan summary yang substantive (LM akan paksa paraphrase headline).
MIN_BODY_CHARS = 500


def _has_keyword(text_lower: str, keyword: str) -> bool:
    return bool(re.search(rf"\b{re.escape(keyword)}\b", text_lower))


def simple_sentiment(text: str) -> str:
    text_lower = text.lower()
    pos_count = sum(1 for w in POSITIVE_WORDS if _has_keyword(text_lower, w))
    neg_count = sum(1 for w in NEGATIVE_WORDS if _has_keyword(text_lower, w))
    total = pos_count + neg_count
    if total == 0:
        return "Neutral"
    score = (pos_count - neg_count) / total
    if score >= 0.25:
        return "Positive"
    elif score <= -0.25:
        return "Negative"
    return "Neutral"


STAKEHOLDER_KEYWORDS = [
    "bpom", "kemenkes", "kementerian kesehatan", "menkes", "bpjs kesehatan",
    "komisi ix dpr", "kemenperin", "lkpp", "mui halal",
]
PHARMA_POLICY_KEYWORDS = [
    "hta", "formularium nasional", "fornas", "e-katalog", "izin edar obat",
    "ina-cbgs", "tkdn farmasi", "uji klinis", "drug reimbursement",
    "market access", "biologic regulation", "vaccine regulation",
]


def detect_subcategory(text: str) -> str:
    """Fallback rule-based — dipakai kalau Groq gagal. Best-effort match by keyword."""
    text_lower = text.lower()
    has_az = "astrazeneca" in text_lower or "vaxzevria" in text_lower or "imfinzi" in text_lower

    if has_az:
        # Heuristic: if AZ in headline/early body, it's likely the focus.
        return "AZ Focus" if text_lower.find("astrazeneca") < 200 else "AZ Mentioned"

    if any(_has_keyword(text_lower, kw) for kw in STAKEHOLDER_KEYWORDS):
        return "Stakeholder & Regulator"
    if any(_has_keyword(text_lower, kw) for kw in PHARMA_POLICY_KEYWORDS):
        return "Pharma Policy"
    return "General Health Regulation"


def make_summary(text: str, max_chars: int = 300) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    summary = ""
    for s in sentences[:3]:
        if len(summary) + len(s) > max_chars:
            break
        summary += s + " "
    return summary.strip()


def extract_keywords(text: str, n: int = 5) -> str:
    stopwords = {
        "yang", "dan", "untuk", "dari", "dengan", "pada", "di", "ke", "ini",
        "itu", "adalah", "akan", "atau", "tidak", "juga", "dalam", "telah",
        "oleh", "para", "kita", "kami", "mereka", "saya", "anda", "the",
        "and", "for", "with", "from", "to", "in", "of", "is", "are", "a", "an"
    }
    words = re.findall(r"\b[a-zA-Z]{4,}\b", text.lower())
    freq: dict[str, int] = {}
    for w in words:
        if w not in stopwords:
            freq[w] = freq.get(w, 0) + 1
    top = sorted(freq.items(), key=lambda x: -x[1])[:n]
    return ", ".join(w for w, _ in top)


def detect_language(text: str) -> str:
    id_markers = {"yang", "dan", "untuk", "dari", "dengan", "adalah", "akan", "tidak"}
    text_lower = text.lower()
    id_count = sum(1 for w in id_markers if _has_keyword(text_lower, w))
    return "id" if id_count >= 2 else "en"


# ============================================================================
# GROQ INTEGRATION (Llama 3.3 70B via Groq Cloud)
# ============================================================================

class GroqClient:
    """
    Client untuk Groq Cloud API. Pakai response_format=json_object untuk
    enforce structured output. Default model: Llama 3.3 70B Versatile.

    Reference: https://console.groq.com/docs/api-reference
    
    Pattern API ini OpenAI-compatible — kalau nanti mau pindah ke provider
    lain (OpenAI, Together AI, Anyscale), tinggal ganti URL dan API key.
    """

    def __init__(self, api_key: str, model: str = GROQ_MODEL):
        self.api_key = api_key
        self.model = model
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def health_check(self) -> bool:
        """Test koneksi dengan call ringan."""
        try:
            resp = self._session.post(
                GROQ_API_URL,
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": "say 'ok'"}],
                    "max_tokens": 5,
                },
                timeout=10,
            )
            resp.raise_for_status()
            return True
        except requests.HTTPError as e:
            if e.response.status_code == 401:
                print(f"[!] API key invalid atau expired", file=sys.stderr)
            elif e.response.status_code == 429:
                print(f"[!] Rate limit terlampaui", file=sys.stderr)
            else:
                print(f"[!] Groq health check failed: {e}", file=sys.stderr)
            return False
        except Exception as e:
            print(f"[!] Groq tidak reachable: {e}", file=sys.stderr)
            return False

    def analyze_article(self, headline: str, body: str) -> ArticleAnalysis | None:
        """Kirim artikel ke Groq, return ArticleAnalysis ter-validasi atau None kalau gagal."""
        user_prompt = (
            f"Analisis artikel berikut.\n\n"
            f"HEADLINE: {headline}\n\n"
            f"BODY:\n{body[:3500]}"
        )

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": _build_response_format(),  # Structured Outputs (strict JSON Schema)
            "temperature": 0.3,  # rendah untuk konsistensi
            # Dual-language output (ID + EN headline/summary/keywords) butuh budget
            # lebih besar dari single-language schema. 1500 cukup untuk 2× summary
            # 300 char + 2× keywords + headline_en + classifier fields.
            "max_tokens": 1500,
        }

        response_text = self._post_with_retry(payload)
        if response_text is None:
            return None

        try:
            return ArticleAnalysis.model_validate_json(response_text)
        except ValidationError as e:
            print(f"    ! Schema validation failed: {e.error_count()} error(s)", file=sys.stderr)
            print(f"    Raw: {response_text[:200]}...", file=sys.stderr)
            return None
        except json.JSONDecodeError as e:
            print(f"    ! JSON parse failed: {e}", file=sys.stderr)
            return None

    def _post_with_retry(self, payload: dict, max_retries: int = 5) -> str | None:
        """POST ke Groq dengan retry untuk 429 (rate limit). Return raw content string.

        Smart retry: parse pesan error Groq yang ngasih tahu waktu retry tepat
        ("Please try again in 2.9175s"). Lebih reliable daripada fixed sleep.
        Fallback ke exponential backoff kalau parsing gagal.
        """
        attempt = 0
        while True:
            try:
                resp = self._session.post(GROQ_API_URL, json=payload, timeout=GROQ_TIMEOUT)
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"]
            except requests.Timeout:
                print(f"    ! Groq timeout setelah {GROQ_TIMEOUT}s", file=sys.stderr)
                return None
            except requests.HTTPError as e:
                status = e.response.status_code
                err_body = e.response.text if e.response is not None else ""
                if status == 429 and attempt < max_retries:
                    attempt += 1
                    wait = _parse_retry_after(err_body, fallback=min(60, 5 * 2 ** attempt))
                    print(f"    ! 429 TPM hit, wait {wait:.1f}s & retry ({attempt}/{max_retries})...",
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                print(f"    ! Groq HTTP {status}: {err_body[:500]}", file=sys.stderr)
                return None
            except Exception as e:
                print(f"    ! Groq call failed: {e}", file=sys.stderr)
                return None


_RETRY_AFTER_RE = re.compile(r"try again in ([0-9]+(?:\.[0-9]+)?)(ms|s)")


def _parse_retry_after(err_body: str, fallback: float) -> float:
    """Parse 'Please try again in 2.9175s' atau '352.5ms' dari pesan error Groq.
    Return waktu tunggu dalam detik, plus 0.5s buffer untuk safety."""
    m = _RETRY_AFTER_RE.search(err_body)
    if not m:
        return fallback
    val = float(m.group(1))
    if m.group(2) == "ms":
        val = val / 1000
    return val + 0.5


# ============================================================================
# MAIN PIPELINE
# ============================================================================

def process_article(entry, fetch_body: bool, groq: GroqClient | None) -> dict | None:
    """Bentuk satu row final.

    Field naming dialigment ke kebutuhan website (lihat save_json/save_csv):
    headline, url, date, source, summary, category, sentiment, keywords, city, province.
    """
    headline, source = parse_source_from_title(entry.title)

    # Filter entry rusak (mis. title = "AA22yZxx.jpg" dari RSS yang aneh)
    if JUNK_TITLE_RE.search(headline) or len(headline) < 15:
        print(f"    ! skip junk title: {headline[:60]!r}", file=sys.stderr)
        return None

    # Decode URL Google News → real article URL (penting agar body bisa di-scrape)
    raw_url = entry.link
    url = resolve_google_news_url(raw_url)

    # Filter source whitelist — drop sebelum body fetch + Groq call (hemat quota)
    if not is_whitelisted_source(url):
        print(f"    skip non-whitelisted source: {url[:80]}", file=sys.stderr)
        return None

    try:
        pub_dt = date_parser.parse(entry.published).astimezone(timezone.utc)
    except Exception:
        pub_dt = datetime.now(timezone.utc)

    description = entry.get("summary", "") or entry.get("description", "")
    description_clean = BeautifulSoup(description, "html.parser").get_text(strip=True)

    body = ""
    if fetch_body:
        print(f"    fetching: {url[:80]}...", file=sys.stderr)
        body = fetch_article_text(url)

    # Body length guard: kalau body terlalu tipis, LM cuma akan paraphrase headline
    # (tidak menambah info). Skip artikel — bukan saved with bad summary.
    if fetch_body and len(body) < MIN_BODY_CHARS:
        print(f"    skip thin body ({len(body)} chars < {MIN_BODY_CHARS})", file=sys.stderr)
        return None

    analysis_text = (headline + " " + description_clean + " " + body).strip()
    now_iso = datetime.now(timezone.utc).isoformat()
    # Konvensi dual-language: kolom utama (headline, summary, keywords) = English,
    # kolom *_id = Indonesian original. `language` selalu "en" pasca refactor
    # (kolom di-keep untuk backward compat tapi semantik berubah).
    base = {
        "id": make_article_id(url),
        "url": url,
        "date": pub_dt.isoformat(),
        "source": source,
        "language": "en",
        "scraped_at": now_iso,
    }

    # AI processing dengan Groq, fallback ke rule-based
    if groq and body:
        print(f"    → Groq {groq.model}...", file=sys.stderr)
        start = time.time()
        ai = groq.analyze_article(headline, body)
        elapsed = time.time() - start
        if ai:
            # Skip artikel yang LM nilai tidak relevan untuk AZ monitoring
            if ai.subcategory == "Not Relevant":
                print(f"    SKIP ({elapsed:.1f}s) — Not Relevant", file=sys.stderr)
                return None
            category = SUBCATEGORY_TO_CATEGORY[ai.subcategory]
            # Standalone categories (Industry & Competitor / Crisis & Disruption):
            # tidak ada konsep subcategory di bawahnya → label dipromosikan jadi
            # kategori dan field subcategory di-NULL-kan. Chart subcategory di
            # frontend akan fallback ke category untuk row seperti ini.
            is_standalone = ai.subcategory in STANDALONE_CATEGORIES
            row_subcategory = None if is_standalone else ai.subcategory
            print(f"    OK ({elapsed:.1f}s) — {category}"
                  f"{'/' + ai.subcategory if not is_standalone else ''}"
                  f"/{ai.sentiment}{' @ ' + ai.city if ai.city else ''}",
                  file=sys.stderr)
            return {
                **base,
                "headline":     ai.headline_en,   # English (primary display)
                "headline_id":  headline,         # Indonesian original from RSS
                "summary":      ai.summary_en,    # English
                "summary_id":   ai.summary_id,    # Indonesian
                "category":     category,
                "subcategory":  row_subcategory,
                "sentiment":    ai.sentiment,
                "keywords":     ai.keywords_en,   # English
                "keywords_id":  ai.keywords_id,   # Indonesian
                "city":         ai.city,
                "province":     ai.province,
            }
        print(f"    ! fallback to rule-based (Indonesian-only)", file=sys.stderr)

    # Rule-based fallback — best-effort, hanya kalau Groq gagal.
    # Tidak ada terjemahan English di fallback path → English fields kosong.
    # Acceptable: fallback jarang trigger; data tetap usable lewat *_id fields.
    fallback_subcategory = detect_subcategory(analysis_text)
    fallback_summary = make_summary(body or description_clean or headline)
    fallback_keywords = extract_keywords(analysis_text)
    return {
        **base,
        "language":     "id",  # tidak ada translasi di fallback path
        "headline":     headline,        # Indonesian (no EN available)
        "headline_id":  headline,
        "summary":      fallback_summary,
        "summary_id":   fallback_summary,
        "category":     SUBCATEGORY_TO_CATEGORY[fallback_subcategory],
        "subcategory":  fallback_subcategory,
        "sentiment":    simple_sentiment(analysis_text),
        "keywords":     fallback_keywords,
        "keywords_id":  fallback_keywords,
        "city":         "",
        "province":     "",
    }


def fetch_news(keywords: list[str], hours: int, fetch_body: bool,
               groq: GroqClient | None) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    all_articles: list[dict] = []
    seen_urls: set[str] = set()

    for kw in keywords:
        query = quote_plus(f"{kw} when:{hours}h")
        rss_url = GOOGLE_NEWS_RSS.format(query=query)
        print(f"[*] Fetching RSS for keyword: {kw}", file=sys.stderr)
        feed = feedparser.parse(rss_url)

        for entry in feed.entries:
            if entry.link in seen_urls:
                continue
            seen_urls.add(entry.link)
            try:
                pub_dt = date_parser.parse(entry.published).astimezone(timezone.utc)
                if pub_dt < cutoff:
                    continue
            except Exception:
                pass

            article = process_article(entry, fetch_body, groq)
            if article:
                all_articles.append(article)

    return all_articles


# Urutan kolom = urutan kontrak data untuk web/database. JANGAN ubah tanpa migrasi.
# Catatan dual-language: kolom utama (headline/summary/keywords) = English;
# kolom *_id = Indonesian original.
OUTPUT_COLUMNS = [
    "id",
    "headline", "headline_id",
    "url", "date", "source",
    "summary", "summary_id",
    "category", "subcategory", "sentiment",
    "keywords", "keywords_id",
    "city", "province",
    "language", "scraped_at",
]


def save_csv(articles: list[dict], path: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for art in articles:
            writer.writerow({k: art.get(k, "") for k in OUTPUT_COLUMNS})
    print(f"[+] Saved CSV: {len(articles)} rows → {path}", file=sys.stderr)


def save_json(articles: list[dict], path: str) -> None:
    """Output untuk konsumsi web (Next.js dst). Pretty-printed, UTF-8 mentah."""
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(articles),
        "articles": [{k: art.get(k, "") for k in OUTPUT_COLUMNS} for art in articles],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[+] Saved JSON: {len(articles)} rows → {path}", file=sys.stderr)


def _load_env_file(path: str) -> None:
    """Load KEY=VALUE pairs dari .env file ke os.environ (skip kalau sudah set)."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> None:
    _load_env_file(os.path.join(os.path.dirname(__file__) or ".", ".env"))

    p = argparse.ArgumentParser(description="AstraZeneca Indonesia daily news fetcher")
    p.add_argument("--keywords", default=",".join(DEFAULT_KEYWORDS))
    p.add_argument("--hours", type=int, default=24)
    p.add_argument("--output", default=DEFAULT_OUTPUT,
                   help="CSV output path. JSON disimpan ke path yang sama dengan ekstensi .json")
    p.add_argument("--json-only", action="store_true",
                   help="Skip CSV; output hanya JSON (untuk feed langsung ke web)")
    p.add_argument("--no-fetch-body", action="store_true")
    p.add_argument("--use-groq", action="store_true",
                   help="Use Groq Cloud LM (requires GROQ_API_KEY env var)")
    args = p.parse_args()

    groq = None
    if args.use_groq:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            print("[!] GROQ_API_KEY tidak ada di env. Falling back to rule-based.",
                  file=sys.stderr)
            print("    Daftar di https://console.groq.com untuk dapat API key (gratis)",
                  file=sys.stderr)
        else:
            groq = GroqClient(api_key)
            if not groq.health_check():
                print("[!] Groq health check gagal, fallback ke rule-based",
                      file=sys.stderr)
                groq = None
            else:
                print(f"[*] Groq enabled: {groq.model}", file=sys.stderr)

    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    articles = fetch_news(
        keywords=keywords,
        hours=args.hours,
        fetch_body=not args.no_fetch_body,
        groq=groq,
    )

    articles.sort(key=lambda a: (
        0 if a["category"] == "Regulatory" else 1,
        -date_parser.parse(a["date"]).timestamp()
    ))

    json_path = os.path.splitext(args.output)[0] + ".json"
    save_json(articles, json_path)
    if not args.json_only:
        save_csv(articles, args.output)
    print(f"[+] Done. {len(articles)} articles processed.", file=sys.stderr)


if __name__ == "__main__":
    main()
