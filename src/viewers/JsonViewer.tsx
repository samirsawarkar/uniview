import { useMemo, useState } from "react";
import { decodeText } from "../core/zip";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import { CodeBlock } from "./TextViewer";
import type { ViewerProps } from "./types";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export default function JsonViewer({ source, onReady }: ViewerProps) {
  const text = useLoad(async (signal) => decodeText(new Uint8Array(await readAllChecked(source, signal, 64 * 1024 * 1024))), [source]);
  const parsed = useMemo(() => {
    if (text === undefined) return undefined;
    try {
      return { ok: true as const, value: JSON.parse(text.replace(/^﻿/, "")) as Json };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }, [text]);
  const [mode, setMode] = useState<"tree" | "text">("tree");
  useReady(text !== undefined, onReady);
  if (text === undefined || !parsed) return <Loading />;
  const showTree = parsed.ok && mode === "tree" && text.length < 5 * 1024 * 1024;
  return (
    <div className="viewer">
      <Toolbar>
        {parsed.ok && <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>Tree</button>}
        <button className={!showTree ? "active" : ""} onClick={() => setMode("text")}>Text</button>
        <Spacer />
        {!parsed.ok && <span className="warn small">Not valid JSON: {parsed.error}</span>}
      </Toolbar>
      <div className="scroll">
        {showTree ? (
          <div className="json-tree" data-testid="json-tree"><Node value={parsed.value} name={null} depth={0} /></div>
        ) : (
          <CodeBlock text={parsed.ok ? JSON.stringify(parsed.value, null, 2) : text} language="json" wrap={false} />
        )}
      </div>
    </div>
  );
}

function Node({ name, value, depth }: { name: string | null; value: Json; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== null ? <span className="json-key">{JSON.stringify(name)}: </span> : null;
  if (value === null || typeof value !== "object") {
    const cls = value === null ? "json-null" : `json-${typeof value}`;
    return <div className="json-row">{label}<span className={cls}>{JSON.stringify(value)}</span></div>;
  }
  const entries: [string, Json][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const [o, c] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const shown = entries.slice(0, 1000);
  return (
    <div className="json-row">
      <button className="json-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "▾" : "▸"}</button>
      {label}
      {o}
      {!open && <span className="muted"> {entries.length} {Array.isArray(value) ? "items" : "keys"} </span>}
      {!open && c}
      {open && (
        <div className="json-children">
          {shown.map(([k, v]) => <Node key={k} name={Array.isArray(value) ? null : k} value={v} depth={depth + 1} />)}
          {entries.length > shown.length && <div className="muted small">… {entries.length - shown.length} more (switch to Text view)</div>}
        </div>
      )}
      {open && <div>{c}</div>}
    </div>
  );
}
