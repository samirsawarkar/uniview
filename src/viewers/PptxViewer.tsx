import { safePptxLink } from './pptx-links';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { parsePptx, type Fill, type Paragraph, type Presentation, type Slide, type SlideElement, type TextBody } from "../core/pptx";
import { readZipEntries } from "../core/zip";
import { extOf } from "../core/detect";
import { Loading, Spacer, Toolbar, readAllChecked, useReady, useViewerBack } from "./common";
import { findPresenterEntrySlide, findNextSlide, findPrevSlide, findVisibleSlide } from "./pptx-navigation";
import type { ViewerProps } from "./types";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
  svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff",
};

import { metafileToPng } from './metafile';

type Urls = (part: string) => string | undefined;

export function useImageUrls(pres: Presentation | null): Urls {
  const cache = useRef(new Map<string, string | null>());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const c = cache.current;
    let active = true;

    if (pres) {
      (async () => {
        for (const entry of pres.pkg.entries) {
          const ext = extOf(entry.name).toLowerCase();
          if ((ext === 'emf' || ext === 'wmf') && entry.size <= 32 * 1024 * 1024) {
            try {
              const raw = pres.pkg.bytesOf(entry.name);
              const png = raw ? await metafileToPng(raw, ext) : null;
              if (!active) return;
              if (png) {
                const url = URL.createObjectURL(png);
                c.set(entry.name, url);
                setRevision((r) => r + 1);
              } else {
                c.set(entry.name, null);
              }
            } catch {
              if (active) c.set(entry.name, null);
            }
          }
        }
      })();
    }

    return () => {
      active = false;
      for (const u of c.values()) if (u) URL.revokeObjectURL(u);
      c.clear();
    };
  }, [pres]);

  return useCallback(
    (part: string) => {
      if (!pres) return undefined;
      const hit = cache.current.get(part);
      if (hit !== undefined) return hit ?? undefined;
      const ext = extOf(part).toLowerCase();
      if (ext === 'emf' || ext === 'wmf') return undefined;
      const mime = IMAGE_MIME[extOf(part)];
      const bytes = mime ? pres.pkg.bytesOf(part) : undefined;
      const url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) : null;
      cache.current.set(part, url);
      return url ?? undefined;
    },
    [pres, revision],
  );
}

export default function PptxViewer({ source, onReady, active = true }: ViewerProps) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [pres, setPres] = useState<Presentation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const urls = useImageUrls(pres);
  const main = useRef<HTMLDivElement>(null);
  // A rail click scrolls the deck; that scroll must not steal the selection it came from.
  const pinned = useRef(-1);
  const settle = useRef(0);
  const unpin = useCallback(() => { pinned.current = -1; }, []);
  useReady(!!thumb || !!pres, onReady);

  useEffect(() => {
    const ctrl = new AbortController();
    let thumbUrl: string | null = null;
    setPres(null);
    setThumb(null);
    void (async () => {
      try {
        const buf = new Uint8Array(await readAllChecked(source, ctrl.signal));
        // The embedded thumbnail is a cheap first view while the whole deck parses.
        const t = readZipEntries(buf, (n) => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(n));
        const tb = [...t.values()][0];
        if (tb && !ctrl.signal.aborted) {
          thumbUrl = URL.createObjectURL(new Blob([tb as BlobPart]));
          setThumb(thumbUrl);
        }
        await new Promise((r) => setTimeout(r, 0));
        if (ctrl.signal.aborted) return;
        setPres(parsePptx(buf));
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err);
      }
    })();
    return () => {
      ctrl.abort();
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    };
  }, [source]);

  const slides = useMemo(() => pres?.slides ?? [], [pres]);
  const go = useCallback((n: number) => {
    const i = Math.max(0, Math.min(slides.length - 1, n));
    pinned.current = i;
    // A click that causes no scroll would otherwise pin forever.
    clearTimeout(settle.current);
    settle.current = window.setTimeout(unpin, 150);
    setCurrent(i);
    if (!presenting) main.current?.querySelector(`[data-slide="${i}"]`)?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [slides.length, presenting, unpin]);

  const startPresenting = useCallback(() => {
    const entry = findPresenterEntrySlide(slides, current);
    if (entry >= 0) setCurrent(entry);
    setPresenting(true);
  }, [slides, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      unpin();
      if (presenting && e.key === "Escape") return setPresenting(false);
      if (["ArrowRight", "PageDown", " "].includes(e.key) && presenting) {
        e.preventDefault();
        const next = findNextSlide(slides, current);
        if (next !== current) setCurrent(next);
      }
      if (["ArrowLeft", "PageUp"].includes(e.key) && presenting) {
        e.preventDefault();
        const prev = findPrevSlide(slides, current);
        if (prev !== current) setCurrent(prev);
      }
      if (e.key === "F5") { e.preventDefault(); startPresenting(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, current, slides, startPresenting, unpin]);

  useViewerBack(active && presenting, () => setPresenting(false));

  if (error) throw error;
  if (!pres) {
    return thumb ? (
      <div className="viewer pptx-viewer">
        <div className="scroll pptx-main"><div className="slide-frame"><img src={thumb} alt="Presentation preview" className="pptx-thumb-preview" /></div></div>
        <div className="parse-badge" role="status">Rendering slides…</div>
      </div>
    ) : (
      <Loading label="Rendering slides…" />
    );
  }

  if (presenting) {
    const allHidden = slides.length === 0 || slides.every((s) => s.hidden);
    const entry = findPresenterEntrySlide(slides, current);
    const activeIndex = entry >= 0 ? (slides[current]?.hidden ? entry : current) : -1;
    const s = activeIndex >= 0 ? slides[activeIndex] : undefined;

    if (!s || allHidden) {
      return (
        <div className="presenter" onClick={() => setPresenting(false)}>
          <div className="presenter-empty" style={{ color: "#fff", textAlign: "center", padding: 32 }}>
            <p style={{ fontSize: 20, marginBottom: 12 }}>All slides in this presentation are hidden.</p>
            <button
              onClick={() => setPresenting(false)}
              style={{ color: "#fff", border: "1px solid rgba(255,255,255,0.4)", padding: "6px 16px", borderRadius: 6, background: "rgba(255,255,255,0.1)" }}
            >
              Exit (Esc)
            </button>
          </div>
          <div className="presenter-bar" onClick={(e) => e.stopPropagation()}>
            <span>0 / {slides.length}</span>
            <button onClick={() => setPresenting(false)}>Exit (Esc)</button>
          </div>
        </div>
      );
    }

    const nextSlide = () => {
      const next = findNextSlide(slides, activeIndex);
      if (next !== activeIndex) setCurrent(next);
    };

    const prevSlide = () => {
      const prev = findPrevSlide(slides, activeIndex);
      if (prev !== activeIndex) setCurrent(prev);
    };

    return (
      <div className="presenter" onClick={nextSlide} onContextMenu={(e) => { e.preventDefault(); prevSlide(); }}>
        <FitSlide pres={pres} slide={s} urls={urls} />
        <div className="presenter-bar" onClick={(e) => e.stopPropagation()}>
          <button onClick={prevSlide} aria-label="Previous slide">‹</button>
          <span>{activeIndex + 1} / {slides.length}</span>
          <button onClick={nextSlide} aria-label="Next slide">›</button>
          <button onClick={() => setPresenting(false)}>Exit (Esc)</button>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer pptx-viewer">
      <Toolbar>
        <button onClick={startPresenting} title="Present (F5)">▶ Present</button>
        <button onClick={() => setShowNotes((v) => !v)} className={showNotes ? "active" : ""}>Notes</button>
        <Spacer />
        <span className="muted small" data-testid="slide-count">{slides.length} slides{pres.warnings.length ? ` · ${pres.warnings.length} skipped item(s)` : ""}</span>
      </Toolbar>
      <div className="pptx-body">
        <nav className="slide-rail" aria-label="Slides">
          {slides.map((s, i) => (
            <button
              key={i}
              className={`rail-item ${i === current ? "active" : ""} ${s.hidden ? "hidden-slide" : ""}`}
              style={s.hidden ? { opacity: 0.5 } : undefined}
              onClick={() => go(i)}
              aria-label={`Slide ${i + 1}${s.hidden ? " (hidden)" : ""}`}
            >
              <span className="rail-num">{i + 1}</span>
              <div style={{ position: "relative" }}>
                <LazySlide pres={pres} slide={s} urls={urls} width={150} />
                {s.hidden && (
                  <span
                    className="rail-hidden-label"
                    style={{
                      position: "absolute",
                      bottom: 4,
                      left: 4,
                      background: "rgba(0, 0, 0, 0.75)",
                      color: "#fff",
                      fontSize: "10px",
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: "3px",
                      lineHeight: "14px",
                      letterSpacing: "0.3px",
                    }}
                  >
                    Hidden
                  </span>
                )}
              </div>
            </button>
          ))}
        </nav>
        <div
          className="scroll pptx-main"
          ref={main}
          onWheel={unpin}
          onTouchStart={unpin}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (pinned.current >= 0) {
              // Hold the click's selection until this scroll settles.
              clearTimeout(settle.current);
              settle.current = window.setTimeout(unpin, 150);
              return;
            }
            const boxes = Array.from(el.querySelectorAll<HTMLElement>("[data-slide]"), (it) => ({ top: it.offsetTop, height: it.offsetHeight }));
            const i = findVisibleSlide(boxes, el.scrollTop, el.clientHeight);
            if (i >= 0) setCurrent(i);
          }}
        >
          {slides.map((s, i) => (
            <section key={i} className="slide-frame" data-slide={i} aria-label={`Slide ${i + 1}`}>
              <ResponsiveSlide pres={pres} slide={s} urls={urls} />
              {showNotes && s.notes && <div className="slide-notes">{s.notes}</div>}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResponsiveSlide({ pres, slide, urls }: { pres: Presentation; slide: Slide; urls: Urls }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.min(el.clientWidth, 1400)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className="slide-holder">{w > 0 && <LazySlide pres={pres} slide={slide} urls={urls} width={w} />}</div>;
}

function FitSlide({ pres, slide, urls }: { pres: Presentation; slide: Slide; urls: Urls }) {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const width = Math.min(size.w, (size.h * pres.widthPt) / pres.heightPt);
  return <SlideView pres={pres} slide={slide} urls={urls} width={width} />;
}

/** Renders a slide only once it scrolls near the viewport. */
function LazySlide(props: { pres: Presentation; slide: Slide; urls: Urls; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(props.slide.index < 3);
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  const h = (props.width * props.pres.heightPt) / props.pres.widthPt;
  return <div ref={ref} style={{ width: props.width, height: h }}>{seen && <SlideView {...props} />}</div>;
}

export function SlideView({ pres, slide, urls, width }: { pres: Presentation; slide: Slide; urls: Urls; width: number }) {
  const scale = width / pres.widthPt;
  return (
    <div className="slide" style={{ width, height: pres.heightPt * scale }} data-testid="slide">
      <div className="slide-inner" style={{ width: pres.widthPt, height: pres.heightPt, transform: `scale(${scale})`, ...fillStyle(slide.background, urls) }}>
        {slide.elements.map((el, i) => <Element key={i} el={el} urls={urls} />)}
      </div>
    </div>
  );
}

function fillStyle(fill: Fill | undefined, urls: Urls): CSSProperties {
  if (!fill) return {};
  if (fill.imagePart) {
    const u = urls(fill.imagePart);
    if (u) return { backgroundImage: `url("${u}")`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  if (fill.gradient) {
    const stops = fill.gradient.stops.map((s) => `${s.color} ${s.pos}%`).join(", ");
    return { background: `linear-gradient(${fill.gradient.angle + 90}deg, ${stops})` };
  }
  return fill.color ? { background: fill.color } : {};
}

const CLIP: Record<string, string> = {
  triangle: "polygon(50% 0, 100% 100%, 0 100%)",
  rtTriangle: "polygon(0 0, 100% 100%, 0 100%)",
  diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  parallelogram: "polygon(25% 0, 100% 0, 75% 100%, 0 100%)",
  trapezoid: "polygon(25% 0, 75% 0, 100% 100%, 0 100%)",
  pentagon: "polygon(50% 0, 100% 38%, 82% 100%, 18% 100%, 0 38%)",
  hexagon: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  octagon: "polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)",
  rightArrow: "polygon(0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%)",
  leftArrow: "polygon(100% 25%, 40% 25%, 40% 0, 0 50%, 40% 100%, 40% 75%, 100% 75%)",
  upArrow: "polygon(25% 100%, 25% 40%, 0 40%, 50% 0, 100% 40%, 75% 40%, 75% 100%)",
  downArrow: "polygon(25% 0, 75% 0, 75% 60%, 100% 60%, 50% 100%, 0 60%, 25% 60%)",
  chevron: "polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%, 25% 50%)",
  homePlate: "polygon(0 0, 80% 0, 100% 50%, 80% 100%, 0 100%)",
  star5: "polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
  plus: "polygon(35% 0, 65% 0, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0 65%, 0 35%, 35% 35%)",
};

const LINE_GEOMS = new Set(["line", "straightConnector1", "bentConnector2", "bentConnector3", "curvedConnector3"]);

function boxStyle(el: SlideElement): CSSProperties {
  const t: string[] = [];
  if (el.rot) t.push(`rotate(${el.rot}deg)`);
  if (el.flipH) t.push("scaleX(-1)");
  if (el.flipV) t.push("scaleY(-1)");
  return { position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h, transform: t.join(" ") || undefined };
}

function Element({ el, urls }: { el: SlideElement; urls: Urls }) {
  switch (el.type) {
    case "shape": {
      if (LINE_GEOMS.has(el.geom)) {
        const stroke = el.line?.color ?? "#000";
        const sw = el.line?.widthPt ?? 1;
        return (
          <svg style={{ ...boxStyle(el), overflow: "visible" }} viewBox={`0 0 ${Math.max(el.w, 0.01)} ${Math.max(el.h, 0.01)}`} preserveAspectRatio="none">
            <line x1={0} y1={0} x2={el.w} y2={el.h} stroke={stroke} strokeWidth={sw} strokeDasharray={el.line?.dash && el.line.dash !== "solid" ? `${sw * 3} ${sw * 2}` : undefined} />
          </svg>
        );
      }
      const radius = el.geom === "ellipse" ? "50%" : el.geom === "roundRect" ? Math.min(el.w, el.h) * ((el.adj ?? 16667) / 100000) : undefined;
      const clip = CLIP[el.geom];
      const style: CSSProperties = {
        ...boxStyle(el),
        ...fillStyle(el.fill, urls),
        borderRadius: radius,
        clipPath: clip,
        border: el.line && !clip ? `${el.line.widthPt}pt ${el.line.dash && el.line.dash !== "solid" ? "dashed" : "solid"} ${el.line.color}` : undefined,
        boxSizing: "border-box",
      };
      return <div style={style}>{el.text && <Text body={el.text} />}</div>;
    }
    case "image": {
      const ext = extOf(el.part);
      const url = urls(el.part);
      if (!url) return <div className="slide-ph" style={boxStyle(el)}>{ext === "emf" || ext === "wmf" ? "Vector image (EMF/WMF)" : "Image"}</div>;
      if (el.crop && (el.crop.l || el.crop.t || el.crop.r || el.crop.b)) {
        const fw = 1 - el.crop.l - el.crop.r, fh = 1 - el.crop.t - el.crop.b;
        return (
          <div style={{ ...boxStyle(el), overflow: "hidden" }}>
            <img src={url} alt="" draggable={false} style={{ position: "absolute", width: `${100 / fw}%`, height: `${100 / fh}%`, left: `${(-el.crop.l / fw) * 100}%`, top: `${(-el.crop.t / fh) * 100}%`, maxWidth: "none" }} />
          </div>
        );
      }
      return <img src={url} alt="" draggable={false} style={{ ...boxStyle(el), objectFit: "fill", maxWidth: "none" }} />;
    }
    case "table": {
      return (
        <table className="slide-table" style={{ ...boxStyle(el), height: undefined }}>
          <colgroup>{el.colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <tbody>
            {el.rows.map((row, ri) => (
              <tr key={ri} style={{ height: row.h }}>
                {row.cells.map((cell, ci) =>
                  cell.merged ? null : (
                    <td
                      key={ci}
                      colSpan={cell.gridSpan > 1 ? cell.gridSpan : undefined}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      style={{
                        ...fillStyle(cell.fill, urls),
                        verticalAlign: cell.text.anchor === "middle" ? "middle" : cell.text.anchor === "bottom" ? "bottom" : "top",
                        padding: `${cell.text.insetsPt[1]}px ${cell.text.insetsPt[2]}px ${cell.text.insetsPt[3]}px ${cell.text.insetsPt[0]}px`,
                        borderLeft: borderCss(cell.borders?.l), borderRight: borderCss(cell.borders?.r),
                        borderTop: borderCss(cell.borders?.t), borderBottom: borderCss(cell.borders?.b),
                      }}
                    >
                      {cell.text.paragraphs.map((p, i) => <Para key={i} p={p} />)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "placeholder":
      return <div className="slide-ph" style={boxStyle(el)}>{el.label}</div>;
  }
}

function borderCss(l: { color: string; widthPt: number } | undefined): string {
  return l ? `${l.widthPt}px solid ${l.color}` : "1px solid rgba(0,0,0,0.15)";
}

function Text({ body }: { body: TextBody }) {
  const [l, t, r, b] = body.insetsPt;
  return (
    <div
      className="slide-text"
      style={{
        padding: `${t}px ${r}px ${b}px ${l}px`,
        justifyContent: body.anchor === "middle" ? "center" : body.anchor === "bottom" ? "flex-end" : "flex-start",
        whiteSpace: body.wrap ? "pre-wrap" : "pre",
        writingMode: body.vertical ? "vertical-rl" : undefined,
      }}
    >
      {body.paragraphs.map((p, i) => <Para key={i} p={p} />)}
    </div>
  );
}

const FONT_FALLBACK = ', "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';

function Para({ p }: { p: Paragraph }) {
  const first = p.runs.find((r) => r.text) ?? p.runs[0];
  const size = first?.sizePt ?? p.endSizePt ?? 18;
  return (
    <p
      className="slide-p"
      style={{
        textAlign: p.align,
        marginTop: p.spaceBeforePt,
        marginBottom: p.spaceAfterPt,
        paddingLeft: p.bullet ? Math.max(p.indentPt, size * 0.9) : p.indentPt,
        lineHeight: p.lineSpacing ? p.lineSpacing * 1.2 : 1.2,
        fontSize: size,
        minHeight: p.runs.length ? undefined : size * 1.2,
      }}
    >
      {p.bullet && <span className="slide-bullet" style={{ width: size * 0.9, marginLeft: -size * 0.9, color: first?.color }}>{p.bullet}</span>}
      {p.runs.length === 0 ? "​" : p.runs.map((r, i) =>
        r.isBreak ? <br key={i} /> : (
          safePptxLink(r.link) ? (
            <a
              key={i}
              href={safePptxLink(r.link)}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: r.sizePt,
                fontWeight: r.bold ? 700 : undefined,
                fontStyle: r.italic ? "italic" : undefined,
                color: r.color ?? "var(--accent, #1a73e8)",
                fontFamily: r.font ? `"${r.font}"${FONT_FALLBACK}` : undefined,
                textDecoration: [r.underline !== false ? "underline" : "", r.strike ? "line-through" : ""].join(" ").trim() || "underline",
                verticalAlign: r.baseline ? (r.baseline > 0 ? "super" : "sub") : undefined,
              }}
            >
              {r.text}
            </a>
          ) : (
            <span
              key={i}
              style={{
                fontSize: r.sizePt,
                fontWeight: r.bold ? 700 : undefined,
                fontStyle: r.italic ? "italic" : undefined,
                color: r.color,
                fontFamily: r.font ? `"${r.font}"${FONT_FALLBACK}` : undefined,
                textDecoration: [r.underline ? "underline" : "", r.strike ? "line-through" : ""].join(" ").trim() || undefined,
                verticalAlign: r.baseline ? (r.baseline > 0 ? "super" : "sub") : undefined,
              }}
            >
              {r.text}
            </span>
          )
        ),
      )}
    </p>
  );
}
