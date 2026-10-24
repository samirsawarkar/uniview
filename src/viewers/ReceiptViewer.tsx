import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ViewerProps } from "./types";
import { validateReceipt } from "../../shared/receipt.mjs";
import type { Receipt, ReceiptValidationError } from "../../shared/receipt.d.mts";
import { sanitizeLabel, AgentMarkdown } from "./agent-markdown";
import {
  resolveLanPath,
  matchCompanionFile,
  type LanContext,
  type CompanionFile,
} from "../core/receipt-resolve";
import {
  verifyReceiptWeb,
  type WebVerifyFile,
  type WebVerifiedFile,
  type WebVerifySource,
} from "../core/receipt-verify-web";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024; // 2 MiB limit for receipt file itself

export interface ReceiptViewerProps extends ViewerProps {
  unresolvedImages?: string[];
  unresolvedFileRefs?: string[];
}

type LoadedReceipt =
  | { receipt: Receipt; errors: null }
  | { receipt: null; errors: ReceiptValidationError[] };

function failed(code: string, message: string): LoadedReceipt {
  return {
    receipt: null,
    errors: [{ code: code as any, path: "", message }],
  };
}

async function readReceipt(source: ViewerProps["source"]): Promise<LoadedReceipt> {
  if (source.size > MAX_RECEIPT_BYTES) {
    return failed(
      "too_large",
      `File exceeds 2 MiB limit (${source.size} bytes)`
    );
  }
  try {
    const bytes = await source.readAll();
    if (bytes.byteLength > MAX_RECEIPT_BYTES) {
      return failed(
        "too_large",
        `File exceeds 2 MiB limit (${bytes.byteLength} bytes)`
      );
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    const result = await validateReceipt(text);
    return result.ok
      ? { receipt: result.receipt, errors: null }
      : { receipt: null, errors: result.errors };
  } catch (err: unknown) {
    return failed("read_error", err instanceof Error ? err.message : String(err));
  }
}

function toArrayBuffer(data?: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (!data) return new ArrayBuffer(0);
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data.slice(0);
}

export default function ReceiptViewer({
  source,
  onReady,
  onFallback,
  unresolvedImages = [],
  unresolvedFileRefs = [],
}: ReceiptViewerProps): React.ReactElement {
  const [loaded, setLoaded] = useState<LoadedReceipt | null>(null);
  const [verifiedFiles, setVerifiedFiles] = useState<WebVerifiedFile[]>([]);
  const [companions, setCompanions] = useState<CompanionFile[]>([]);
  const [ambiguousChoices, setAmbiguousChoices] = useState<
    Record<string, CompanionFile[]>
  >({});
  const [chosenFiles, setChosenFiles] = useState<Record<string, CompanionFile>>(
    {}
  );
  const mounted = useRef(true);

  const receipt = loaded?.receipt ?? null;
  const errors = loaded?.errors ?? null;
  const loading = loaded === null;

  // Initial read and validation
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setLoaded(null);

    void readReceipt(source).then((r) => {
      if (!cancelled) setLoaded(r);
    });

    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [source]);

  // Signal ready once first render settles
  useEffect(() => {
    if (!loading) {
      onReady?.();
    }
  }, [loading, onReady]);

  // Verification pass for files
  useEffect(() => {
    if (!receipt) return;

    let cancelled = false;

    const lanContext: LanContext | undefined = source.remote
      ? {
          hostId: source.remote.hostId,
          rootId: source.remote.rootId,
          receiptPath: source.remote.path,
        }
      : undefined;

    const filesToVerify: WebVerifyFile[] = receipt.files.map((f) => ({
      path: f.path,
      relPath: f.relPath,
      expectedSha256: f.sha256,
      role: f.role,
    }));

    const resolver = async (
      file: WebVerifyFile
    ): Promise<WebVerifySource | null> => {
      // 1. If chosen by user among ambiguous
      if (chosenFiles[file.path]) {
        const c = chosenFiles[file.path]!;
        return {
          size: c.size,
          readAll: async () => toArrayBuffer(c.data),
        };
      }

      // 2. Try LAN resolution
      if (lanContext && file.relPath) {
        const lan = resolveLanPath(file.relPath, lanContext);
        if (lan.ok) {
          // Resolved on LAN root
          return null; // Remote file read handled by shell bridge or companion
        }
      }

      // 3. Try Companion files matching
      if (companions.length > 0) {
        const namePath = file.relPath || file.path;
        const match = matchCompanionFile(
          namePath,
          file.expectedSha256,
          companions
        );
        if (match.status === "matched") {
          return {
            size: match.file.size,
            readAll: async () => toArrayBuffer(match.file.data),
          };
        }
        if (match.status === "ambiguous") {
          if (mounted.current) {
            setAmbiguousChoices((prev) => ({
              ...prev,
              [file.path]: match.candidates,
            }));
          }
        }
      }

      return null;
    };

    void verifyReceiptWeb(filesToVerify, resolver).then((res) => {
      if (!cancelled && mounted.current) {
        setVerifiedFiles(res.files);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [receipt, source.remote, companions, chosenFiles]);

  const handlePickCompanions = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;

      const picked: CompanionFile[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i]!;
        const data = await file.arrayBuffer();
        picked.push({
          id: `comp-${Date.now()}-${i}`,
          name: file.name,
          size: file.size,
          data,
        });
      }
      setCompanions((prev) => [...prev, ...picked]);
    },
    []
  );

  const handleSelectChoice = (filePath: string, comp: CompanionFile) => {
    setChosenFiles((prev) => ({ ...prev, [filePath]: comp }));
    setAmbiguousChoices((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
  };

  const handleReload = async () => {
    if (!source.reopen) return;
    try {
      const fresh = await source.reopen();
      try {
        const r = await readReceipt(fresh);
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
    return <div className="receipt-loading">Loading review receipt…</div>;
  }

  if (errors) {
    return (
      <div className="receipt-error-view" role="alert">
        <h2 className="receipt-error-heading">This receipt could not be shown</h2>
        <ul className="receipt-error-list">
          {errors.slice(0, 20).map((err, i) => (
            <li key={i} className="receipt-error-item">
              <span className="receipt-err-code">{err.code}</span>
              {err.path && <span className="receipt-err-path"> ({err.path})</span>}
              <span className="receipt-err-message">: {err.message}</span>
            </li>
          ))}
        </ul>
        <div className="receipt-error-actions">
          {source.reopen && (
            <button
              type="button"
              className="receipt-reload-btn"
              onClick={() => void handleReload()}
            >
              Reload
            </button>
          )}
          {onFallback && (
            <button
              type="button"
              className="receipt-open-json-btn"
              onClick={() => onFallback("json")}
            >
              Open as JSON
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!receipt) return <></>;

  const agentName = receipt.agent?.name
    ? sanitizeLabel(receipt.agent.name, 80)
    : null;
  const agentModel = receipt.agent?.model
    ? sanitizeLabel(receipt.agent.model, 80)
    : null;

  return (
    <div className="receipt-viewer-container">
      {/* Fixed UniView bar - explicitly outside the agent content area. NO decision buttons. */}
      <header className="uniview-bar receipt-bar" role="banner">
        <div className="uniview-bar-left">
          <span className="uniview-brand">UniView</span>
          <span className="uniview-receipt-tag">Review Receipt</span>
        </div>
        <div className="uniview-bar-center">
          <span className="uniview-decide-banner">Decide on your computer</span>
        </div>
        <div className="uniview-bar-right">
          {source.reopen && (
            <button
              type="button"
              className="receipt-reload-btn"
              onClick={() => void handleReload()}
            >
              Reload
            </button>
          )}
        </div>
      </header>

      {/* Untrusted agent content clearly framed and labeled */}
      <section
        className="agent-content receipt-agent-content"
        aria-label="Content from the agent"
        data-testid="agent-content"
        data-agent-content="true"
      >
        <div className="agent-content-header">
          <div className="agent-content-label">
            <span className="agent-badge">Content from the agent</span>
            <span className="agent-identity">
              {agentName
                ? `Receipt from an agent · says it is ${agentName}`
                : "Receipt from an agent"}
              {agentModel ? ` (${agentModel})` : ""}
            </span>
          </div>
          <div className="receipt-created-at">
            Created: {receipt.createdAt}
          </div>
        </div>

        {/* Task */}
        <div className="receipt-section receipt-task-section">
          <h2 className="receipt-section-heading">Task</h2>
          <div className="receipt-task-body">{receipt.task}</div>
        </div>

        {/* Summary (Restricted Markdown) */}
        <div className="receipt-section receipt-summary-section">
          <h2 className="receipt-section-heading">Summary</h2>
          <AgentMarkdown text={receipt.summary} className="receipt-summary-md" />
        </div>

        {/* Files */}
        <div className="receipt-section receipt-files-section">
          <div className="receipt-section-title-row">
            <h2 className="receipt-section-heading">
              Files ({receipt.files.length})
            </h2>
            <label className="receipt-pick-btn-label">
              <span>Pick companion files</span>
              <input
                type="file"
                multiple
                onChange={(e) => void handlePickCompanions(e)}
                style={{ display: "none" }}
              />
            </label>
          </div>

          <ul className="receipt-files-list">
            {receipt.files.map((file, i) => {
              const verified = verifiedFiles.find((v) => v.path === file.path);
              const state = verified?.state ?? "missing";
              const choices = ambiguousChoices[file.path];

              return (
                <li key={i} className="receipt-file-item">
                  <div className="receipt-file-header">
                    <span className={`receipt-role-badge role-${file.role}`}>
                      {file.role}
                    </span>
                    <span className="receipt-file-name">
                      {file.relPath || file.path}
                    </span>
                    <span className={`receipt-state-badge state-${state}`}>
                      {state}
                    </span>
                  </div>

                  <div className="receipt-file-details">
                    <div className="receipt-hash-row">
                      <span className="receipt-hash-label">Expected:</span>
                      <code className="receipt-hash-val">{file.sha256}</code>
                    </div>
                    {verified?.observedSha256 && (
                      <div className="receipt-hash-row">
                        <span className="receipt-hash-label">Observed:</span>
                        <code className="receipt-hash-val">
                          {verified.observedSha256}
                        </code>
                      </div>
                    )}
                  </div>

                  {choices && choices.length > 0 && (
                    <div className="receipt-ambiguous-picker">
                      <span className="receipt-ambiguous-prompt">
                        Multiple files named &quot;{file.relPath || file.path}&quot; found. Choose:
                      </span>
                      <div className="receipt-choices-row">
                        {choices.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="receipt-choice-btn"
                            onClick={() => handleSelectChoice(file.path, c)}
                          >
                            Use {c.name} ({c.size} bytes)
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Checks (if present) */}
        {receipt.checks && receipt.checks.length > 0 && (
          <div className="receipt-section receipt-checks-section">
            <h2 className="receipt-section-heading">
              Checks ({receipt.checks.length})
            </h2>
            <ul className="receipt-checks-list">
              {receipt.checks.map((chk, i) => (
                <li key={i} className={`receipt-check-item status-${chk.status}`}>
                  <div className="receipt-check-header">
                    <span className="receipt-check-name">{chk.name}</span>
                    <span
                      className={`receipt-check-status-badge status-${chk.status}`}
                    >
                      {chk.status}
                    </span>
                  </div>
                  {chk.evidence && (
                    <pre className="receipt-check-evidence">{chk.evidence}</pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sources (if present) */}
        {receipt.sources && receipt.sources.length > 0 && (
          <div className="receipt-section receipt-sources-section">
            <h2 className="receipt-section-heading">
              Sources ({receipt.sources.length})
            </h2>
            <ul className="receipt-sources-list">
              {receipt.sources.map((src, i) => (
                <li key={i} className="receipt-source-item">
                  <div className="receipt-source-title">{src.title}</div>
                  <code className="receipt-source-ref">{src.ref}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* View references & placeholders */}
        {unresolvedImages.map((img, i) => (
          <div key={`img-${i}`} className="agent-image-placeholder" data-placeholder="true">
            [image: {img}] - image not available on this device
          </div>
        ))}

        {unresolvedFileRefs.map((ref, i) => (
          <button
            key={`ref-${i}`}
            type="button"
            disabled
            className="agent-fileref disabled"
            aria-disabled="true"
            title="File not available on this device"
          >
            {ref} (unavailable)
          </button>
        ))}
      </section>
    </div>
  );
}
