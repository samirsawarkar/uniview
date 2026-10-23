import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { CorruptFileError, ViewerError } from "../core/errors";
import { loadPdf } from "./loaders";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const asset = (p: string) => new URL(`pdfjs/${p}`, document.baseURI).href;

type Zoom = "fit" | number;

export default function PdfViewer({ source, onReady }: ViewerProps) {
  const doc = useLoad(async (signal) => {
    try {
      return await loadPdf(
        (sig) => readAllChecked(source, sig),
        (data) =>
          pdfjs.getDocument({
            data,
            cMapUrl: asset("cmaps/"),
            cMapPacked: true,
            standardFontDataUrl: asset("standard_fonts/"),
            wasmUrl: asset("wasm/"),
            iccUrl: asset("iccs/"),
            enableXfa: false,
            stopAtErrors: false,
          }),
        signal,
      );
    } catch (err) {
      if (signal.aborted || !(err instanceof Error) || err instanceof ViewerError) throw err;
      if (err.name === "PasswordException") throw new CorruptFileError("This PDF is password-protected. UniView V1 cannot open protected PDFs yet.");
      throw new CorruptFileError(`This PDF could not be read: ${err.message}`);
    }
  }, [source]);

  // Destroying the loading task frees the worker and every page of the document.
  useEffect(() => () => void doc?.task.destroy(), [doc]);

  if (!doc) return <Loading />;
  return <PdfDocument doc={doc.doc} onReady={onReady} />;
}

function PdfDocument({ doc, onReady }: { doc: PDFDocumentProxy; onReady: () => void }) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [query, setQuery] = useState("");
  const [findMsg, setFindMsg] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const textCache = useRef(new Map<number, string>());

  useEffect(() => {
    let live = true;
    void doc.getPage(1).then((p) => {
      const vp = p.getViewport({ scale: 1 });
      if (live) setBaseSize({ w: vp.width, h: vp.height });
    });
    return () => {
      live = false;
    };
  }, [doc]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = !baseSize || !width ? 1 : zoom === "fit" ? Math.max(0.25, Math.min(4, (width - 32) / baseSize.w)) : zoom;

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const pages = el.querySelectorAll<HTMLElement>("[data-page]");
    const mid = el.scrollTop + el.clientHeight / 3;
    for (const p of pages) {
      if (p.offsetTop + p.offsetHeight > mid) {
        setPage(Number(p.dataset.page));
        break;
      }
    }
  }, []);

  const goTo = (n: number) => {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    target?.scrollIntoView({ block: "start" });
  };

  const find = async (from: number) => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    setFindMsg("Searching…");
    for (let i = 0; i < doc.numPages; i++) {
      const n = ((from - 1 + i) % doc.numPages) + 1;
      let text = textCache.current.get(n);
      if (text === undefined) {
        const content = await (await doc.getPage(n)).getTextContent();
        text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ").toLowerCase();
        textCache.current.set(n, text);
      }
      if (text.includes(q)) {
        setFindMsg(`Found on page ${n}`);
        goTo(n);
        return;
      }
    }
    setFindMsg("No matches");
  };

  return (
    <div className="viewer pdf-viewer">
      <Toolbar>
        <button onClick={() => setZoom(Math.max(0.25, scale / 1.25))} aria-label="Zoom out" title="Zoom out (Ctrl -)">−</button>
        <button onClick={() => setZoom("fit")} className={zoom === "fit" ? "active" : ""} title="Fit width">{Math.round(scale * 100)}%</button>
        <button onClick={() => setZoom(Math.min(4, scale * 1.25))} aria-label="Zoom in" title="Zoom in (Ctrl +)">+</button>
        <span className="sep" />
        <span className="muted" data-testid="pdf-page">Page {page} of {doc.numPages}</span>
        <Spacer />
        <form
          className="find"
          onSubmit={(e) => {
            e.preventDefault();
            void find(page + (findMsg.startsWith("Found") ? 1 : 0));
          }}
        >
          <input type="search" placeholder="Find in PDF" value={query} onChange={(e) => { setQuery(e.target.value); setFindMsg(""); }} aria-label="Find in PDF" />
          <span className="muted small">{findMsg}</span>
        </form>
      </Toolbar>
      <div className="scroll pdf-pages" ref={scroller} onScroll={onScroll}>
        {baseSize &&
          Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i} doc={doc} n={i + 1} scale={scale} estimate={baseSize} root={scroller} onFirstPaint={i === 0 ? onReady : undefined} />
          ))}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, scale, estimate, root, onFirstPaint }: {
  doc: PDFDocumentProxy;
  n: number;
  scale: number;
  estimate: { w: number; h: number };
  root: React.RefObject<HTMLDivElement | null>;
  onFirstPaint?: () => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(n <= 2);
  const [size, setSize] = useState<{ w: number; h: number }>(estimate);
  const [painted, setPainted] = useState(false);
  const pageRef = useRef<PDFPageProxy | null>(null);
  useReady(painted && !!onFirstPaint, onFirstPaint ?? (() => {}));

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)), {
      root: root.current,
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | undefined;
    let textLayer: pdfjs.TextLayer | undefined;
    void (async () => {
      const page = pageRef.current ?? (await doc.getPage(n));
      pageRef.current = page;
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      setSize({ w: vp.width / scale, h: vp.height / scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      renderTask = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await renderTask.promise;
      } catch {
        return; // cancelled by a zoom change
      }
      if (cancelled) return;
      setPainted(true);
      const text = textRef.current;
      if (text) {
        text.replaceChildren();
        text.style.setProperty("--total-scale-factor", String(scale));
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp });
        await textLayer.render().catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, n, scale, visible]);

  return (
    <div className="pdf-page" data-page={n} ref={holder} style={{ width: size.w * scale, height: size.h * scale }}>
      <canvas ref={canvasRef} aria-label={`Page ${n}`} />
      <div className="textLayer" ref={textRef} />
    </div>
  );
}
