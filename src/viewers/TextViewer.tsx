import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../core/errors";
import { Loading, Spacer, Toolbar, useReady } from "./common";
import { highlight } from "./highlight";
import type { ViewerProps } from "./types";

/** Bytes read per page, so a multi-gigabyte log opens instantly. */
export const TEXT_PAGE = 2 * 1024 * 1024;

function encodingOf(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  return "utf-8";
}

export default function TextViewer({ source, detection, onReady }: ViewerProps) {
  const [text, setText] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const decoder = useRef<TextDecoder | null>(null);
  const busy = useRef(false);
  const total = source.size;

  const loadMore = async (from: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const end = total < 0 ? from + TEXT_PAGE : Math.min(total, from + TEXT_PAGE);
      const bytes = new Uint8Array(await source.readRange(from, end));
      if (!decoder.current) {
        let enc = encodingOf(bytes);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.max(0, bytes.length - 4)));
        } catch {
          if (enc === "utf-8") enc = "windows-1252";
        }
        decoder.current = new TextDecoder(enc);
      }
      const done = end >= total || bytes.length < end - from;
      const chunk = decoder.current.decode(bytes, { stream: !done });
      setText((t) => (t ?? "") + chunk);
      setLoaded(from + bytes.length);
    } catch (err) {
      setError(err);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    decoder.current = null;
    setText(null);
    setLoaded(0);
    void loadMore(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useReady(text !== null, onReady);
  if (error) throw error;
  if (text === null) return <Loading />;
  const more = total >= 0 && loaded < total;
  return (
    <div className="viewer text-viewer">
      <Toolbar>
        <span className="muted small">{detection.language ? detection.language : "Plain text"}</span>
        <button onClick={() => setWrap((w) => !w)} className={wrap ? "active" : ""} title="Wrap long lines">Wrap</button>
        <button onClick={() => void navigator.clipboard?.writeText(text)} title="Copy all loaded text">Copy</button>
        <Spacer />
        <span className="muted small">{formatBytes(loaded)}{more ? ` of ${formatBytes(total)}` : ""}</span>
      </Toolbar>
      <div className="scroll">
        <CodeBlock text={text} language={detection.language} wrap={wrap} />
        {more && (
          <div className="load-more">
            <button onClick={() => void loadMore(loaded)}>Load the next {formatBytes(Math.min(TEXT_PAGE, total - loaded))}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function CodeBlock({ text, language, wrap }: { text: string; language?: string; wrap: boolean }) {
  const html = useMemo(() => highlight(text, language), [text, language]);
  const lines = useMemo(() => {
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }, [text]);
  const gutter = useMemo(() => Array.from({ length: Math.min(lines, 200_000) }, (_, i) => i + 1).join("\n"), [lines]);
  return (
    <div className={`code ${wrap ? "wrap" : ""}`}>
      {!wrap && <pre className="gutter" aria-hidden>{gutter}</pre>}
      {html !== null ? (
        <pre className="hljs" data-testid="text-content"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
      ) : (
        <pre data-testid="text-content"><code>{text}</code></pre>
      )}
    </div>
  );
}
