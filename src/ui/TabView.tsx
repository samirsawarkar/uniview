import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import { DETECT_HEAD_BYTES, classifyZipEntries, detect, extOf } from "../core/detect";
import { describeError, isAbort, ViewerError } from "../core/errors";
import type { Detection, FileSource, FormatKind } from "../core/types";
import { listZip } from "../core/zip";
import { HexViewer, TextViewer, VIEWERS } from "../viewers/registry";
import { Loading } from "../viewers/common";

export interface TabViewProps {
  source: FileSource;
  onDetected: (d: Detection) => void;
  onReady: (ms: number) => void;
  onOpen: (files: FileSource[]) => void;
  active?: boolean;
}

/** Reads the head of a file, picks a viewer, and guarantees something readable is shown. */
export function TabView({ source, onDetected, onReady, onOpen, active = true }: TabViewProps) {
  const [detection, setDetection] = useState<Detection | null>(null);
  const [override, setOverride] = useState<FormatKind | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [started] = useState(() => performance.now());

  useEffect(() => {
    const ctrl = new AbortController();
    setDetection(null);
    setOverride(null);
    setError(null);
    void (async () => {
      try {
        const head = new Uint8Array(await source.readRange(0, source.size >= 0 ? Math.min(source.size, DETECT_HEAD_BYTES) : DETECT_HEAD_BYTES, ctrl.signal));
        let d = detect(source.name, head, source.mimeHint);
        // ZIPs written with data descriptors hide their part names from the head; check the central directory.
        if (d.kind === "zip" && source.size > 0 && source.size < 512 * 1024 * 1024) {
          const bytes = await source.readAll(ctrl.signal);
          let kind: FormatKind | null = null;
          try {
            kind = classifyZipEntries(listZip(bytes).map((e) => e.name));
          } catch {
            /* damaged archive: the ZIP viewer reports it and offers text/hex */
          }
          if (kind) d = { ...d, kind, label: kind === "docx" ? "Word document" : kind === "pptx" ? "PowerPoint presentation" : kind === "sheet" ? "Spreadsheet" : "EPUB book", by: "container" };
        }
        if (ctrl.signal.aborted) return;
        setDetection(d);
        onDetected(d);
      } catch (err) {
        if (!ctrl.signal.aborted && !isAbort(err)) setError(err);
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // A fallback the user chose must work even when detection itself failed (e.g. a truncated ZIP).
  if (error && !override) return <ErrorPanel source={source} error={error} onFallback={setOverride} />;
  const base: Detection | null = detection ?? (override ? { kind: override, label: "Unrecognized file", ext: extOf(source.name), by: "content" } : null);
  if (!base) return <Loading />;
  const kind = override ?? base.kind;
  const Viewer = override === "text" ? TextViewer : override === "binary" ? HexViewer : VIEWERS[kind];
  return (
    <ViewerBoundary key={`${source.id}:${kind}`} source={source} onFallback={setOverride} fallbackUsed={override}>
      <Suspense fallback={<Loading />}>
        <Viewer source={source} detection={override ? { ...base, kind } : base} onOpen={onOpen} onReady={() => onReady(performance.now() - started)} active={active} onFallback={setOverride} />
      </Suspense>
    </ViewerBoundary>
  );
}

interface BoundaryProps {
  source: FileSource;
  onFallback: (k: FormatKind) => void;
  fallbackUsed: FormatKind | null;
  children: ReactNode;
}

class ViewerBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown) {
    console.warn("UniView viewer failed:", error);
  }
  override render() {
    if (this.state.error) return <ErrorPanel source={this.props.source} error={this.state.error} onFallback={this.props.onFallback} hideFallback={this.props.fallbackUsed} />;
    return this.props.children;
  }
}

function ErrorPanel({ source, error, onFallback, hideFallback }: { source: FileSource; error: unknown; onFallback: (k: FormatKind) => void; hideFallback?: FormatKind | null }) {
  const title = error instanceof ViewerError && error.code === "too-large" ? "This file is too large for this view" : error instanceof ViewerError && error.code === "unsupported" ? "This format is not supported yet" : "This file could not be displayed";
  return (
    <div className="center-msg error-panel" role="alert" data-testid="error-panel">
      <div className="error-icon" aria-hidden>!</div>
      <strong>{title}</strong>
      <span className="error-detail">{describeError(error)}</span>
      <span className="muted small">{source.name}</span>
      <div className="row">
        {hideFallback !== "text" && <button onClick={() => onFallback("text")}>View as text</button>}
        {hideFallback !== "binary" && <button onClick={() => onFallback("binary")}>View as hex</button>}
      </div>
    </div>
  );
}
