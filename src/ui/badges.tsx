import type { FormatKind } from "../core/types";

const BADGES: Record<FormatKind, { text: string; color: string; name: string }> = {
  pdf: { text: "PDF", color: "#DC2626", name: "PDF" },
  docx: { text: "DOC", color: "#2563EB", name: "Word" },
  sheet: { text: "XLS", color: "#16A34A", name: "Excel & CSV" },
  pptx: { text: "PPT", color: "#EA580C", name: "PowerPoint" },
  epub: { text: "EPUB", color: "#7C3AED", name: "EPUB" },
  image: { text: "IMG", color: "#0891B2", name: "Images" },
  tiff: { text: "TIF", color: "#0891B2", name: "TIFF" },
  video: { text: "VID", color: "#DB2777", name: "Video" },
  audio: { text: "AUD", color: "#C026D3", name: "Audio" },
  zip: { text: "ZIP", color: "#A16207", name: "ZIP" },
  markdown: { text: "MD", color: "#475569", name: "Markdown" },
  json: { text: "{ }", color: "#475569", name: "JSON" },
  viewspec: { text: "VIEW", color: "#0F766E", name: "UniView view" },
  receipt: { text: "RCPT", color: "#0F766E", name: "Review receipt" },
  text: { text: "TXT", color: "#64748B", name: "Text & code" },
  font: { text: "Aa", color: "#4F46E5", name: "Fonts" },
  "legacy-office": { text: "OLD", color: "#78716C", name: "Legacy Office" },
  binary: { text: "BIN", color: "#57534E", name: "Any file (hex)" },
};

export function badgeFor(kind: FormatKind) {
  return BADGES[kind];
}

export function KindBadge({ kind, small }: { kind?: FormatKind; small?: boolean }) {
  if (!kind) return <span className={`badge ${small ? "small" : ""} pending`} aria-hidden />;
  const b = BADGES[kind];
  return (
    <span className={`badge ${small ? "small" : ""}`} style={{ background: b.color }} aria-label={b.name}>
      {b.text}
    </span>
  );
}
