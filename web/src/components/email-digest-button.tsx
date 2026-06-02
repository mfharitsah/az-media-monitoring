"use client";

import { useEffect, useState } from "react";
import { Mail, X, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildEmailTemplate,
  RECIPIENT_TO,
  RECIPIENT_CC,
  type SenderInfo,
} from "@/lib/email-template";
import type { Article } from "@/lib/types";

const STORAGE_KEY = "az-digest-sender";
const EMPTY_SENDER: SenderInfo = { name: "", jobTitle: "", email: "" };

/**
 * Tombol untuk menyusun email digest harian.
 *
 * Alur:
 * 1. Klik tombol → modal konfirmasi (template + input nama/jabatan/email).
 * 2. "Paste to Outlook" → satu klik: copy formatted ke clipboard +
 *    buka Outlook via mailto. Body mailto cuma instruksi singkat.
 * 3. Di body Outlook: Ctrl+A lalu Ctrl+V → tabel HTML menggantikan instruksi.
 *
 * mailto hanya mendukung teks polos → tabel HTML harus lewat clipboard.
 */
export function EmailDigestButton({ articles }: { articles: Article[] }) {
  const [open, setOpen] = useState(false);
  const [sender, setSender] = useState<SenderInfo>(EMPTY_SENDER);

  // Restore info pengirim yang tersimpan.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setSender({ ...EMPTY_SENDER, ...JSON.parse(saved) });
    } catch {
      /* abaikan localStorage rusak */
    }
  }, []);

  // ESC untuk tutup modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const updateSender = (patch: Partial<SenderInfo>) => {
    const next = { ...sender, ...patch };
    setSender(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* abaikan kuota localStorage */
    }
  };

  const template = buildEmailTemplate(articles, sender);

  /**
   * Satu klik: copy formatted HTML+text ke clipboard, lalu buka Outlook.
   * Clipboard gagal? Tetap buka Outlook — user bisa retry; tidak menutup
   * kemungkinan paste.
   */
  const pasteToOutlook = async () => {
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([template.html], { type: "text/html" }),
            "text/plain": new Blob([template.body], { type: "text/plain" }),
          }),
        ]);
      } else {
        // Browser lama — fallback teks polos.
        await navigator.clipboard.writeText(template.body);
      }
    } catch {
      /* clipboard ditolak — biarkan; mailto tetap dibuka */
    }
    window.location.href = template.mailtoUrl;
    setOpen(false);
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} className="gap-2">
        <Mail className="h-4 w-4" />
        Compose Digest Email
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Compose digest email"
        >
          <div
            className="my-auto w-full max-w-2xl rounded-lg border bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between rounded-t-lg px-5 py-3"
              style={{ backgroundColor: "var(--brand-mulberry)" }}
            >
              <h2 className="flex items-center gap-2 font-semibold text-white">
                <Mail className="h-4 w-4" />
                Compose Daily Digest Email
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              {/* Langkah */}
              <ol className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                <li>
                  <strong className="text-foreground">1.</strong> Klik{" "}
                  <strong className="text-foreground">Paste to Outlook</strong> —
                  clipboard terisi versi tabel + Outlook terbuka otomatis.
                </li>
                <li>
                  <strong className="text-foreground">2.</strong> Di body email Outlook:
                  tekan <strong className="text-foreground">Ctrl+A</strong> lalu{" "}
                  <strong className="text-foreground">Ctrl+V</strong> — tabel
                  menggantikan teks instruksi.
                </li>
              </ol>

              {/* Recipients (read-only) */}
              <div className="grid gap-2 rounded-md border p-3 text-sm">
                <div className="flex gap-2">
                  <span className="w-12 shrink-0 font-medium text-muted-foreground">To</span>
                  <span className="break-all">{RECIPIENT_TO}</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-12 shrink-0 font-medium text-muted-foreground">Cc</span>
                  <span className="break-all">{RECIPIENT_CC}</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-12 shrink-0 font-medium text-muted-foreground">Subject</span>
                  <span className="break-all font-medium">{template.subject}</span>
                </div>
              </div>

              {/* Sender inputs */}
              <div className="grid gap-3 sm:grid-cols-3">
                <SenderField
                  label="Your Name"
                  value={sender.name}
                  placeholder="Mutiara Tsabitah"
                  onChange={(v) => updateSender({ name: v })}
                />
                <SenderField
                  label="Job Title"
                  value={sender.jobTitle}
                  placeholder="Communication Associate"
                  onChange={(v) => updateSender({ jobTitle: v })}
                />
                <SenderField
                  label="Your Email"
                  value={sender.email}
                  placeholder="you@astrazeneca.com"
                  onChange={(v) => updateSender({ email: v })}
                />
              </div>

              {/* Preview tabel (HTML ter-render) */}
              <div>
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Preview ({articles.length} article{articles.length === 1 ? "" : "s"},
                  last 24h)
                </span>
                <div
                  className="max-h-72 overflow-auto rounded-md border bg-white p-3"
                  dangerouslySetInnerHTML={{ __html: template.html }}
                />
              </div>

              {/* Actions */}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={pasteToOutlook} className="gap-2">
                  <Send className="h-4 w-4" />
                  Paste to Outlook
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SenderField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
      <span className="block">{label}</span>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
