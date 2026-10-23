import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chapterHtml, parseEpub, type Book } from "../core/epub";
import { extOf } from "../core/detect";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  css: "text/css", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", mp3: "audio/mpeg", mp4: "video/mp4",
};

export default function EpubViewer({ source, onReady }: ViewerProps) {
  const book = useLoad(async (signal) => parseEpub(await readAllChecked(source, signal)), [source]);
  if (!book) return <Loading label="Opening book…" />;
  return <Reader book={book} onReady={onReady} />;
}

function Reader({ book, onReady }: { book: Book; onReady: () => void }) {
  const [index, setIndex] = useState(0);
  const [fontScale, setFontScale] = useState(1);
  const [tocOpen, setTocOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingFragment = useRef<string | undefined>(undefined);
  const urls = useRef(new Map<string, string>());
  useReady(loaded, onReady);

  useEffect(() => () => {
    for (const u of urls.current.values()) URL.revokeObjectURL(u);
    urls.current.clear();
  }, [book]);

  const urlFor = useCallback((part: string) => {
    const hit = urls.current.get(part);
    if (hit) return hit;
    const bytes = book.pkg.bytesOf(part);
    if (!bytes) return undefined;
    const type = book.types.get(part) || MIME[extOf(part)] || "application/octet-stream";
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    urls.current.set(part, u);
    return u;
  }, [book]);

  const part = book.spine[index]!.part;
  const html = useMemo(() => chapterHtml(book, part, urlFor), [book, part, urlFor]);

  const openPart = useCallback((target: string, fragment?: string) => {
    const i = book.spine.findIndex((s) => s.part === target);
    if (i < 0) return;
    pendingFragment.current = fragment;
    setIndex(i);
  }, [book]);

  const onLoad = () => {
    setLoaded(true);
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.documentElement.style.fontSize = `${18 * fontScale}px`;
    // In-book links were rewritten to #uniview-part:<path>#frag; route them to chapters.
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element).closest("a");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      e.preventDefault();
      const m = /^#uniview-part:([^#]+)(?:#(.+))?$/.exec(href);
      if (m) openPart(decodeURIComponent(m[1]!), m[2]);
      else if (href.startsWith("#")) doc.getElementById(href.slice(1))?.scrollIntoView();
    });
    const frag = pendingFragment.current;
    pendingFragment.current = undefined;
    if (frag) doc.getElementById(frag)?.scrollIntoView();
    else doc.scrollingElement?.scrollTo(0, 0);
  };

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.documentElement) doc.documentElement.style.fontSize = `${18 * fontScale}px`;
  }, [fontScale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "ArrowRight" && e.altKey) setIndex((i) => Math.min(book.spine.length - 1, i + 1));
      if (e.key === "ArrowLeft" && e.altKey) setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [book]);

  return (
    <div className="viewer epub-viewer">
      <Toolbar>
        <button onClick={() => setTocOpen((v) => !v)} className={tocOpen ? "active" : ""} aria-label="Table of contents">☰</button>
        <button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label="Previous chapter">‹</button>
        <span className="muted small" data-testid="epub-position">{index + 1} / {book.spine.length}</span>
        <button onClick={() => setIndex((i) => Math.min(book.spine.length - 1, i + 1))} disabled={index === book.spine.length - 1} aria-label="Next chapter">›</button>
        <span className="sep" />
        <button onClick={() => setFontScale((s) => Math.max(0.6, s - 0.1))} aria-label="Smaller text">A−</button>
        <button onClick={() => setFontScale((s) => Math.min(2.4, s + 0.1))} aria-label="Larger text">A+</button>
        <Spacer />
        <span className="muted small ellipsis">{book.title}{book.author ? ` · ${book.author}` : ""}</span>
      </Toolbar>
      <div className="epub-body">
        {tocOpen && (
          <nav className="epub-toc" aria-label="Contents">
            {book.toc.map((t, i) => (
              <button key={i} style={{ paddingLeft: 12 + t.depth * 14 }} className={t.href === part ? "active" : ""} onClick={() => openPart(t.href, t.fragment)}>
                {t.title}
              </button>
            ))}
          </nav>
        )}
        {/* allow-same-origin without allow-scripts: chapter scripts never run, but UniView can route link clicks. */}
        <iframe ref={frame} className="epub-frame" title="Chapter" sandbox="allow-same-origin" srcDoc={html} onLoad={onLoad} data-testid="epub-frame" />
      </div>
    </div>
  );
}
