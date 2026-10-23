import React, { useState, useEffect, useRef } from "react";
import type { ViewerProps } from "./types";
import { validateViewSpec } from "../../shared/viewspec.mjs";
import type { ViewSpec, ValidationError } from "../../shared/viewspec.d.mts";
import { sanitizeLabel } from "./agent-markdown";
import { ViewNodeRenderer } from "./viewspec-nodes";

const MAX_BYTES = 2 * 1024 * 1024;

type Loaded = { spec: ViewSpec; errors: null } | { spec: null; errors: ValidationError[] };

function failed(code: string, message: string): Loaded {
  return { spec: null, errors: [{ code, path: "", message } as ValidationError] };
}

/** Reads and validates the spec bytes once; used for the first view and for Reload. */
async function readSpec(source: ViewerProps["source"]): Promise<Loaded> {
  if (source.size > MAX_BYTES) return failed("too_large", `File exceeds 2 MiB limit (${source.size} bytes)`);
  try {
    const bytes = await source.readAll();
    if (bytes.byteLength > MAX_BYTES) return failed("too_large", `File exceeds 2 MiB limit (${bytes.byteLength} bytes)`);
    const result = await validateViewSpec(new TextDecoder("utf-8").decode(bytes));
    return result.ok ? { spec: result.spec, errors: null } : { spec: null, errors: result.errors };
  } catch (err: unknown) {
    return failed("read_error", err instanceof Error ? err.message : String(err));
  }
}

export default function ViewSpecViewer({
  source,
  onReady,
  onFallback,
}: ViewerProps): React.ReactElement {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const loading = loaded === null;
  const spec = loaded?.spec ?? null;
  const errorInfo = loaded?.errors ? { errors: loaded.errors } : null;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setLoaded(null);
    void readSpec(source).then((r) => {
      if (!cancelled) setLoaded(r);
    });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [source]);

  useEffect(() => {
    if (!loading) {
      onReady?.();
    }
  }, [loading, onReady]);

  // The previous content stays on screen until the new bytes are validated.
  const handleReload = async () => {
    if (!source.reopen) return;
    try {
      const fresh = await source.reopen();
      try {
        const r = await readSpec(fresh);
        if (mounted.current) setLoaded(r);
      } finally {
        fresh.release();
      }
    } catch (err: unknown) {
      if (mounted.current) {
        setLoaded(failed("read_error", err instanceof Error ? err.message : String(err)));
      }
    }
  };

  if (loading) {
    return <div className="vs-loading">Loading view…</div>;
  }

  if (errorInfo) {
    return (
      <div className="vs-error-view">
        <h2 className="vs-error-heading">This view could not be shown</h2>
        <ul className="vs-error-list">
          {errorInfo.errors.slice(0, 20).map((err, i) => (
            <li key={i} className="vs-error-item">
              <span className="vs-err-code">{err.code}</span>
              {err.path && <span className="vs-err-path"> ({err.path})</span>}
              <span className="vs-err-message">: {err.message}</span>
            </li>
          ))}
        </ul>
        <div className="vs-error-actions">
          {source.reopen && (
            <button
              type="button"
              className="vs-reload"
              onClick={() => void handleReload()}
            >
              Reload
            </button>
          )}
          {onFallback && (
            <button
              type="button"
              className="vs-open-json"
              onClick={() => onFallback("json")}
            >
              Open as JSON
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!spec) return <></>;

  const agentName = spec.agent?.name
    ? sanitizeLabel(spec.agent.name, 80)
    : null;
  const title = sanitizeLabel(spec.title, 200);

  return (
    <section className="agent-content">
      <header className="vs-header">
        <div className="vs-agent-meta">
          {agentName
            ? `View from an agent · says it is ${agentName}`
            : "View from an agent"}
        </div>
        <h1 className="vs-title">{title}</h1>
        {source.reopen && (
          <button
            type="button"
            className="vs-reload"
            onClick={() => void handleReload()}
          >
            Reload
          </button>
        )}
      </header>
      <div className="vs-body">
        {spec.body.map((node, i) => (
          <ViewNodeRenderer key={i} node={node} />
        ))}
      </div>
    </section>
  );
}
