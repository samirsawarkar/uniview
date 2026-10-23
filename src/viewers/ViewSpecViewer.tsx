import React, { useState, useEffect } from "react";
import type { ViewerProps } from "./types";
import { validateViewSpec } from "../../shared/viewspec.mjs";
import type { ViewSpec, ValidationError } from "../../shared/viewspec.d.mts";
import { sanitizeLabel } from "./agent-markdown";
import { ViewNodeRenderer } from "./viewspec-nodes";

export default function ViewSpecViewer({
  source,
  onReady,
}: ViewerProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [spec, setSpec] = useState<ViewSpec | null>(null);
  const [errorInfo, setErrorInfo] = useState<{
    errors: ValidationError[];
    rawText: string;
  } | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const MAX_BYTES = 2 * 1024 * 1024;
      if (typeof source.size === "number" && source.size > MAX_BYTES) {
        if (!cancelled) {
          setErrorInfo({
            errors: [
              {
                code: "too_large",
                path: "",
                message: `File exceeds 2 MiB limit (${source.size} bytes)`,
              },
            ],
            rawText: "",
          });
          setLoading(false);
        }
        return;
      }

      try {
        const bytes = await source.readAll();
        if (cancelled) return;

        if (bytes.byteLength > MAX_BYTES) {
          setErrorInfo({
            errors: [
              {
                code: "too_large",
                path: "",
                message: `File exceeds 2 MiB limit (${bytes.byteLength} bytes)`,
              },
            ],
            rawText: "",
          });
          setLoading(false);
          return;
        }

        const text = new TextDecoder("utf-8").decode(bytes);
        const result = await validateViewSpec(text);
        if (cancelled) return;

        if (!result.ok) {
          setErrorInfo({ errors: result.errors, rawText: text });
        } else {
          setSpec(result.spec);
        }
      } catch (err: any) {
        if (!cancelled) {
          setErrorInfo({
            errors: [
              {
                code: "read_error",
                path: "",
                message: err?.message || String(err),
              },
            ],
            rawText: "",
          });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!loading) {
      onReady?.();
    }
  }, [loading, onReady]);

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
        <div className="vs-raw-toggle">
          <button
            type="button"
            className="vs-toggle-btn"
            onClick={() => setShowJson((v) => !v)}
          >
            Show as JSON
          </button>
          {showJson && (
            <pre className="vs-raw-json">
              {errorInfo.rawText.slice(0, 256 * 1024)}
            </pre>
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
      </header>
      <div className="vs-body">
        {spec.body.map((node, i) => (
          <ViewNodeRenderer key={i} node={node} />
        ))}
      </div>
    </section>
  );
}
