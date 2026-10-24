import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { FileSource, FormatKind } from "../core/types";
import type { Receipt, FileState, Decision } from "../../shared/receipt.d.mts";
import type { ReviewApi } from "../shells/electron";
import { hasElectronApi } from "../shells/electron";
import { sanitizeLabel, AgentMarkdown } from "./agent-markdown";
import ViewSpecViewer from "./ViewSpecViewer";

const MAX_COMMENT_BYTES = 8192; // 8 KiB UTF-8 byte limit
const ARMING_DELAY_MS = 500;

function utf8ByteCount(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}

/** Agent text that may span lines (check evidence): same stripping as labels, newlines kept. */
function sanitizeBlock(text: string, max: number): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => sanitizeLabel(line, Number.MAX_SAFE_INTEGER))
    .join("\n")
    .slice(0, max);
}

export interface ReviewTabFile {
  path: string;
  relPath?: string;
  expectedSha256: string;
  observedSha256?: string | null;
  state: FileState | "not checked";
  role?: "created" | "modified" | "input";
}

export interface ReviewTabProps {
  source: FileSource;
  reviewApi?: ReviewApi;
  onReady?: () => void;
  onOpen?: (files: FileSource[]) => void;
  onFallback?: (format: FormatKind) => void;
}

export default function ReviewTab({
  source,
  reviewApi: reviewApiProp,
  onReady,
  onOpen,
  onFallback,
}: ReviewTabProps): React.ReactElement {
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [files, setFiles] = useState<ReviewTabFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [comment, setComment] = useState("");
  const [armed, setArmed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [decisionOutcome, setDecisionOutcome] = useState<Decision | null>(null);
  const [persistedError, setPersistedError] = useState<boolean>(false);
  const [changeWarning, setChangeWarning] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const decidedRef = useRef(false);
  const reviewIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  // Resolved API (passed prop or window.uniview.review)
  const api = useMemo<ReviewApi | null>(() => {
    if (reviewApiProp) return reviewApiProp;
    if (hasElectronApi() && (window as any).uniview?.review) {
      return (window as any).uniview.review;
    }
    return null;
  }, [reviewApiProp]);

  // Keep refs in sync for unmount dismissal
  useEffect(() => {
    reviewIdRef.current = reviewId;
  }, [reviewId]);

  useEffect(() => {
    decidedRef.current = decisionOutcome !== null;
  }, [decisionOutcome]);

  // Arming delay: 500 ms after shown or refreshed
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => {
      if (mountedRef.current) {
        setArmed(true);
      }
    }, ARMING_DELAY_MS);

    return () => clearTimeout(timer);
  }, [refreshKey]);

  // Load review on mount
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        if (!api) {
          throw new Error("Desktop review API is not available");
        }
        const bytes = await source.readAll();
        const res = await api.open({
          receiptBytes: new Uint8Array(bytes),
          receiptPath: source.path ?? null,
        });

        if (cancelled) return;
        if (!res.ok || !res.reviewId || !res.receipt) {
          setLoadError(res.error || "Failed to open review");
          setLoading(false);
          return;
        }

        setReviewId(res.reviewId);
        setReceipt(res.receipt);

        const initialFiles: ReviewTabFile[] = (res.receipt.files || []).map((rf, idx) => {
          const verified = res.files?.[idx];
          return {
            path: rf.path,
            relPath: rf.relPath,
            expectedSha256: rf.sha256,
            observedSha256: verified?.observedSha256 ?? null,
            state: verified?.state ?? "not checked",
            role: rf.role,
          };
        });
        setFiles(initialFiles);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setLoadError(err?.message || "Failed to load review receipt");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      // Requirement (7): closing the tab without deciding records "dismissed"
      if (!decidedRef.current && reviewIdRef.current && api) {
        void api.dismiss(reviewIdRef.current);
      }
    };
  }, [source, api]);

  // Signal ready
  useEffect(() => {
    if (!loading) {
      onReady?.();
    }
  }, [loading, onReady]);

  // Comment limits
  const commentBytes = useMemo(() => utf8ByteCount(comment), [comment]);
  const isCommentOverLimit = commentBytes > MAX_COMMENT_BYTES;

  // Decide action (only deliberate pointer click activation decides)
  const handleDecide = useCallback(
    async (decisionType: "approved" | "changes_requested") => {
      if (!armed || isSubmitting || decisionOutcome !== null || isCommentOverLimit || !reviewId || !api) {
        return;
      }

      setIsSubmitting(true);
      setChangeWarning(null);

      try {
        const res = await api.decide({
          reviewId,
          decision: decisionType,
          comment,
        });

        if (!mountedRef.current) return;

        if (!res.ok) {
          if (res.code === "changed") {
            // Requirement (5): click-time re-verification result "changed/replaced" blocks decision
            // and refreshes view with "A file changed since you looked — review again"
            setChangeWarning("A file changed since you looked — review again");
            if (Array.isArray(res.current) && receipt) {
              const updatedFiles: ReviewTabFile[] = receipt.files.map((rf, idx) => {
                const cur = res.current?.[idx];
                return {
                  path: rf.path,
                  relPath: rf.relPath,
                  expectedSha256: rf.sha256,
                  observedSha256: cur?.observedSha256 ?? null,
                  state: cur?.state ?? "not checked",
                  role: rf.role,
                };
              });
              setFiles(updatedFiles);
            }
            // Re-arm timer (disabled for 500 ms after refresh)
            setRefreshKey((k) => k + 1);
          } else {
            setChangeWarning(res.message || res.error || "Decision was not recorded");
          }
          setIsSubmitting(false);
          return;
        }

        if (res.decision) {
          setDecisionOutcome(res.decision);
          decidedRef.current = true;
          if (res.decision.persisted === false) {
            setPersistedError(true);
          }
        }
      } catch (err: any) {
        if (mountedRef.current) {
          setChangeWarning(err?.message || "Failed to submit decision");
        }
      } finally {
        if (mountedRef.current) {
          setIsSubmitting(false);
        }
      }
    },
    [armed, isSubmitting, decisionOutcome, isCommentOverLimit, reviewId, api, comment, receipt]
  );

  const handleApprove = () => handleDecide("approved");
  const handleRequestChanges = () => handleDecide("changes_requested");

  // Reload action
  const handleReload = async () => {
    if (!api || !reviewId) return;
    setChangeWarning(null);
    try {
      const res = await api.refresh(reviewId);
      if (!mountedRef.current) return;
      if (res.ok && Array.isArray(res.files) && receipt) {
        const updatedFiles: ReviewTabFile[] = receipt.files.map((rf, idx) => {
          const fresh = res.files?.[idx];
          return {
            path: rf.path,
            relPath: rf.relPath,
            expectedSha256: rf.sha256,
            observedSha256: fresh?.observedSha256 ?? null,
            state: fresh?.state ?? "not checked",
            role: rf.role,
          };
        });
        setFiles(updatedFiles);
      }
      setRefreshKey((k) => k + 1);
    } catch {}
  };

  // Requirement (3): keyboard Enter on the tab does nothing (only deliberate click/pointer activation decides)
  const blockEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (loading) {
    return <div className="receipt-loading">Loading review receipt…</div>;
  }

  if (loadError) {
    return (
      <div className="receipt-error-view" role="alert">
        <h2 className="receipt-error-heading">This receipt could not be shown</h2>
        <div className="receipt-error-item">{loadError}</div>
        <div className="receipt-error-actions">
          {onFallback && (
            <button type="button" className="receipt-open-json-btn" onClick={() => onFallback("json")}>
              Open as JSON
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!receipt) return <></>;

  const agentName = receipt.agent?.name ? sanitizeLabel(receipt.agent.name, 80) : null;
  const agentModel = receipt.agent?.model ? sanitizeLabel(receipt.agent.model, 80) : null;
  const isDecided = decisionOutcome !== null;
  const controlsDisabled = !armed || isSubmitting || isDecided || isCommentOverLimit;

  return (
    <div className="receipt-viewer-container review-tab-container" onKeyDown={blockEnter}>
      {/* (2) UniView's own bar OUTSIDE agent-content region */}
      <header className="uniview-bar review-bar" role="banner" data-testid="review-bar">
        <div className="uniview-bar-left">
          <span className="uniview-brand">UniView</span>
          <span className="uniview-receipt-tag">Review Receipt</span>
        </div>

        <div className="uniview-bar-center review-bar-controls">
          {isDecided ? (
            <div className="review-outcome" data-testid="review-outcome">
              <span className="review-outcome-label">Decision: </span>
              <strong className={`review-outcome-badge decision-${decisionOutcome.decision}`}>
                {decisionOutcome.decision === "approved"
                  ? "Approved"
                  : decisionOutcome.decision === "changes_requested"
                    ? "Changes requested"
                    : "Dismissed"}
              </strong>
            </div>
          ) : (
            <div className="review-action-row">
              <div className="review-comment-wrap">
                <textarea
                  className={`review-comment-box ${isCommentOverLimit ? "over-limit" : ""}`}
                  data-testid="review-comment"
                  placeholder="Comment (optional, max 8 KiB)..."
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  disabled={isDecided || isSubmitting}
                  onKeyDown={blockEnter}
                  rows={1}
                />
                {isCommentOverLimit && (
                  <span className="review-comment-limit-err" role="alert">
                    Comment exceeds 8 KiB limit ({commentBytes} / {MAX_COMMENT_BYTES} bytes)
                  </span>
                )}
              </div>

              <div className="review-buttons-wrap">
                <button
                  type="button"
                  className="btn btn-approve primary"
                  data-testid="approve-btn"
                  onClick={handleApprove}
                  disabled={controlsDisabled}
                  onKeyDown={blockEnter}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn-request-changes danger"
                  data-testid="request-changes-btn"
                  onClick={handleRequestChanges}
                  disabled={controlsDisabled}
                  onKeyDown={blockEnter}
                >
                  Request changes
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="uniview-bar-right">
          <button type="button" className="receipt-reload-btn" onClick={() => void handleReload()}>
            Reload
          </button>
        </div>
      </header>

      {/* Warnings & Errors */}
      {changeWarning && (
        <div className="banner warn review-change-warning" role="alert" data-testid="review-change-warning">
          <span>{changeWarning}</span>
          <button type="button" className="link small" onClick={() => setChangeWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

      {persistedError && (
        <div className="banner danger review-persist-error" role="alert" data-testid="persist-error">
          Error: Decision could not be saved to disk (persisted: false)
        </div>
      )}

      {/* (1) Receipt renders ONLY inside clearly marked "Content from the agent" region */}
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
            Created: {sanitizeLabel(receipt.createdAt, 64)}
          </div>
        </div>

        {/* Task */}
        <div className="receipt-section receipt-task-section">
          <h2 className="receipt-section-heading">Task</h2>
          <div className="receipt-task-body">{sanitizeLabel(receipt.task, 2048)}</div>
        </div>

        {/* Summary (Restricted Markdown) */}
        <div className="receipt-section receipt-summary-section">
          <h2 className="receipt-section-heading">Summary</h2>
          <AgentMarkdown text={receipt.summary} className="receipt-summary-md" />
        </div>

        {/* Files with verification state */}
        <div className="receipt-section receipt-files-section">
          <h2 className="receipt-section-heading">Files ({files.length})</h2>
          <ul className="receipt-files-list">
            {files.map((file, i) => {
              const state = file.state ?? "not checked";
              const name = sanitizeLabel(file.relPath || file.path, 4096);
              return (
                <li key={i} className="receipt-file-item">
                  <div className="receipt-file-header">
                    {file.role && (
                      <span className={`receipt-role-badge role-${file.role}`}>
                        {file.role}
                      </span>
                    )}
                    <span className="receipt-file-name">{name}</span>
                    <span className={`receipt-state-badge state-${state.replace(/ /g, "_")}`}>
                      {state}
                    </span>
                  </div>
                  <div className="receipt-file-details">
                    <div className="receipt-hash-row">
                      <span className="receipt-hash-label">Expected:</span>
                      <code className="receipt-hash-val">{file.expectedSha256}</code>
                    </div>
                    {file.observedSha256 && (
                      <div className="receipt-hash-row">
                        <span className="receipt-hash-label">Observed:</span>
                        <code className="receipt-hash-val">{file.observedSha256}</code>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Checks (if present) */}
        {receipt.checks && receipt.checks.length > 0 && (
          <div className="receipt-section receipt-checks-section">
            <h2 className="receipt-section-heading">Checks ({receipt.checks.length})</h2>
            <ul className="receipt-checks-list">
              {receipt.checks.map((chk, i) => (
                <li key={i} className={`receipt-check-item status-${chk.status}`}>
                  <div className="receipt-check-header">
                    <span className="receipt-check-name">{sanitizeLabel(chk.name, 200)}</span>
                    <span className={`receipt-check-status-badge status-${chk.status}`}>
                      {chk.status}
                    </span>
                  </div>
                  {chk.evidence && (
                    <pre className="receipt-check-evidence">{sanitizeBlock(chk.evidence, 16 * 1024)}</pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sources (if present) */}
        {receipt.sources && receipt.sources.length > 0 && (
          <div className="receipt-section receipt-sources-section">
            <h2 className="receipt-section-heading">Sources ({receipt.sources.length})</h2>
            <ul className="receipt-sources-list">
              {receipt.sources.map((src, i) => (
                <li key={i} className="receipt-source-item">
                  <div className="receipt-source-title">{sanitizeLabel(src.title, 300)}</div>
                  <code className="receipt-source-ref">{sanitizeLabel(src.ref, 2048)}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The receipt's view (if present) */}
        {receipt.view && (
          <div className="receipt-section receipt-view-section">
            <h2 className="receipt-section-heading">View</h2>
            <div className="receipt-view-note">
              {receipt.viewRelPath || receipt.view}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
