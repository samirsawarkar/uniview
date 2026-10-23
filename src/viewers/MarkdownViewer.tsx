import { useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { decodeText } from "../core/zip";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import { CodeBlock } from "./TextViewer";
import type { ViewerProps } from "./types";

export default function MarkdownViewer({ source, onReady }: ViewerProps) {
  const text = useLoad(async (signal) => decodeText(new Uint8Array(await readAllChecked(source, signal, 32 * 1024 * 1024))), [source]);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const html = useMemo(() => {
    if (text === undefined) return "";
    const raw = marked.parse(text, { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ["style", "form", "iframe", "object", "embed"],
      // Offline viewer: keep data: images and in-page anchors; remote URLs would never load anyway.
      ALLOWED_URI_REGEXP: /^(?:#|data:image\/|https?:|mailto:)/i,
    });
  }, [text]);
  useReady(text !== undefined, onReady);
  if (text === undefined) return <Loading />;
  return (
    <div className="viewer">
      <Toolbar>
        <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button>
        <button className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>Source</button>
        <Spacer />
      </Toolbar>
      <div className="scroll">
        {mode === "preview" ? (
          <article
            className="prose"
            data-testid="markdown"
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest("a");
              if (a && !a.getAttribute("href")?.startsWith("#")) e.preventDefault();
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <CodeBlock text={text} language="markdown" wrap />
        )}
      </div>
    </div>
  );
}
