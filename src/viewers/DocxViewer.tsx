import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { CorruptFileError } from "../core/errors";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

export default function DocxViewer({ source, onReady }: ViewerProps) {
  const data = useLoad((signal) => readAllChecked(source, signal), [source]);
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [zoom, setZoom] = useState(1);
  useReady(rendered, onReady);

  useEffect(() => {
    if (!data || !body.current || !styles.current) return;
    let cancelled = false;
    body.current.replaceChildren();
    styles.current.replaceChildren();
    renderAsync(data, body.current, styles.current, {
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      // An altChunk embeds arbitrary HTML in an unsandboxed iframe; never render it.
      renderAltChunks: false,
      breakPages: true,
    })
      .then(() => {
        if (cancelled || !body.current) return;
        // Defence in depth: no frame or link inside a document may navigate the app.
        for (const f of body.current.querySelectorAll("iframe")) f.setAttribute("sandbox", "");
        setRendered(true);
      })
      .catch((err: Error) => !cancelled && setError(new CorruptFileError(`This Word document could not be rendered: ${err.message}`)));
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (error) throw error;
  return (
    <div className="viewer docx-viewer">
      <Toolbar>
        <button onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button onClick={() => setZoom((z) => Math.min(3, z * 1.2))} aria-label="Zoom in">+</button>
        <Spacer />
      </Toolbar>
      {!rendered && <Loading label="Laying out pages…" />}
      <div
        className="scroll docx-scroll"
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (a && !a.getAttribute("href")?.startsWith("#")) e.preventDefault();
        }}
      >
        <div ref={styles} />
        <div ref={body} data-testid="docx-body" style={{ zoom, visibility: rendered ? "visible" : "hidden" }} />
      </div>
    </div>
  );
}
