import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { FileSource, FormatKind, Detection } from "../core/types";
import type { Receipt, FileState, Decision } from "../../shared/receipt.d.mts";
import type { ReviewApi, ReviewValidationError } from "../shells/electron";
import { hasElectronApi, grantTokenOf, toSource, type GrantedFile } from "../shells/electron";
import { sanitizeLabel, AgentMarkdown } from "./agent-markdown";
import ViewSpecViewer from "./ViewSpecViewer";
import { ViewReferenceContext, type ViewReferenceResolver } from "./viewspec-nodes";

const MAX_COMMENT_BYTES = 8192; // 8 KiB UTF-8 byte limit
const ARMING_DELAY_MS = 500;
const VIEW_SPEC_DETECTION: Detection = {
  kind: "viewspec",
  label: "View Spec",
  ext: ".viewspec.json",
  by: "container",
};

function createViewSourceFromSnapshot(view: any, scopeId?: string): FileSource | null {
  if (!view) return null;
  let bytes: Uint8Array | null = null;
  if (view instanceof Uint8Array) {
    bytes = view;
  } else if (view.specBytes instanceof Uint8Array) {
    bytes = view.specBytes;
  } else if (view.specBytes?.data) {
    bytes = new Uint8Array(view.specBytes.data);
  } else if (view.bytes instanceof Uint8Array) {
    bytes = view.bytes;
  } else if (view.bytes?.data) {
    bytes = new Uint8Array(view.bytes.data);
  } else if (view.spec && typeof view.spec === "object") {
    bytes = new TextEncoder().encode(JSON.stringify(view.spec));
  } else if (typeof view === "object" && (view.body || view.title || view.version || view.nodes)) {
    bytes = new TextEncoder().encode(JSON.stringify(view));
  } else if (typeof view === "string" && view.trim().startsWith("{")) {
    bytes = new TextEncoder().encode(view);
  }
  if (!bytes) return null;
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const ab: ArrayBuffer = buf.buffer;
  return {
    id: `agent-review-view-${scopeId || "view"}`,
    name: "view.uview.json",
    size: ab.byteLength,
    readAll: async (): Promise<ArrayBuffer> => {
      const copy = new Uint8Array(buf.byteLength);
      copy.set(buf);
      return copy.buffer;
    },
    readRange: async (start, end): Promise<ArrayBuffer> => {
      const sub = buf.subarray(start, end);
      const copy = new Uint8Array(sub.byteLength);
      copy.set(sub);
      return copy.buffer;
    },
    url: async () => "",
    release: () => {},
  };
}

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
  /** A receipt the person opened from a file on this computer (it carries a grant token). */
  source: FileSource;
  reviewApi?: ReviewApi;
  /** This viewer's tab is the visible one; default true. Showing the tab again re-arms the buttons. */
  active?: boolean;
  onReady?: () => void;
  onOpen?: (files: FileSource[]) => void;
  onFallback?: (format: FormatKind) => void;
  initialReview?: {
    scopeId?: string;
    reviewId: string;
    receiptDigest?: string;
    receipt: Receipt;
    receiptBytes?: Uint8Array;
    view?: any;
    sessionId?: string;
    agent?: string;
    files?: Array<{ path: string; expectedSha256: string; observedSha256: string | null; state: FileState }>;
  };
}

interface LoadFailure {
  message: string;
  errors: ReviewValidationError[];
}

type ReviewApiFile = { path: string; expectedSha256: string; observedSha256: string | null; state: FileState };

/**
 * Only a deliberate pointer click decides. Untrusted events (script-dispatched, element.click()) and
 * keyboard activation (Space/Enter on a focused button arrives as a click with detail 0 and no pointerType)
 * are ignored.
 */
export function isDeliberateClick(event: { nativeEvent?: unknown }): boolean {
  const n = event?.nativeEvent as { isTrusted?: boolean; detail?: number; pointerType?: string } | undefined;
  if (!n || n.isTrusted !== true) return false;
  return (typeof n.detail === "number" && n.detail > 0) || (typeof n.pointerType === "string" && n.pointerType !== "");
}

function swallowKeyboardActivation(e: React.KeyboardEvent) {
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    e.stopPropagation();
  }
}

function filesFromResults(receipt: Receipt, results: ReviewApiFile[] | undefined): ReviewTabFile[] {
  return (receipt.files || []).map((rf, idx) => {
    const r = results?.[idx];
    return {
      path: rf.path,
      relPath: rf.relPath,
      expectedSha256: rf.sha256,
      observedSha256: r?.observedSha256 ?? null,
      state: r?.state ?? "not checked",
      role: rf.role,
    };
  });
}

export default function ReviewTab({
  source,
  reviewApi: reviewApiProp,
  active = true,
  onReady,
  onFallback,
  initialReview,
  onOpen,
}: ReviewTabProps): React.ReactElement {
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [files, setFiles] = useState<ReviewTabFile[]>([]);
  const [viewSource, setViewSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);

  const [comment, setComment] = useState("");
  const [armEpoch, setArmEpoch] = useState(0);
  const [armedKey, setArmedKey] = useState<number | null>(null);
  const [prevActive, setPrevActive] = useState(active);

  const [decisionOutcome, setDecisionOutcome] = useState<Decision | null>(null);
  const [persistedError, setPersistedError] = useState<boolean>(false);
  const [sidecarConflict, setSidecarConflict] = useState<boolean>(false);
  const [changeWarning, setChangeWarning] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const decidedRef = useRef(false);
  const inFlightRef = useRef(false);
  const reviewIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  // Resolved API (passed prop or window.uniview.review). Kept in a ref so a new object identity for the
  // same API neither reloads the review nor counts as closing the tab.
  const api = useMemo<ReviewApi | null>(() => {
    if (reviewApiProp) return reviewApiProp;
    if (hasElectronApi() && (window as any).uniview?.review) {
      return (window as any).uniview.review;
    }
    return null;
  }, [reviewApiProp]);
  const apiRef = useRef<ReviewApi | null>(api);
  apiRef.current = api;
  const grantToken = grantTokenOf(source);

  /** Closing the review without deciding records "dismissed". Never while a decision is in flight. */
  const dismissIfOpen = useCallback(() => {
    const id = reviewIdRef.current;
    const a = apiRef.current;
    if (!id || !a || decidedRef.current || inFlightRef.current) return;
    reviewIdRef.current = null;
    void Promise.resolve(a.dismiss(id)).catch(() => {});
  }, []);

  // Tab closed means dismissed. This cleanup runs on a real unmount only, not when props change.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dismissIfOpen();
    };
  }, [dismissIfOpen]);

  // Showing the tab again re-arms the buttons (adjusted during render so there is no enabled frame).
  if (prevActive !== active) {
    setPrevActive(active);
    if (active) setArmEpoch((e) => e + 1);
  }

  // The window going to the background and coming back also re-arms.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setArmEpoch((e) => e + 1);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Load the review. Main reads the receipt through the grant token; the renderer never sends a path.
  useEffect(() => {
    let cancelled = false;
    // A review from an earlier source in this same component is replaced, so it is closed.
    dismissIfOpen();
    reviewIdRef.current = null;
    decidedRef.current = false;
    setReviewId(null);
    setReceipt(null);
    setFiles([]);
    setDecisionOutcome(null);
    setPersistedError(false);
    setSidecarConflict(false);
    setChangeWarning(null);
    setLoading(true);
    setLoadError(null);

    if (initialReview) {
      reviewIdRef.current = initialReview.reviewId;
      setReviewId(initialReview.reviewId);
      setReceipt(initialReview.receipt);
      setFiles(filesFromResults(initialReview.receipt, initialReview.files));
      if (initialReview.view) {
        setViewSource(createViewSourceFromSnapshot(initialReview.view, initialReview.scopeId));
      } else {
        setViewSource(null);
      }
      setLoading(false);
      const a = apiRef.current;
      if (a) {
        void a.refresh(initialReview.reviewId).then((refreshed) => {
          if (mountedRef.current && !cancelled && refreshed?.ok && refreshed.files) {
            setFiles(filesFromResults(initialReview.receipt, refreshed.files));
          }
        });
      }
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const a = apiRef.current;
      try {
        if (!a) throw new Error("Desktop review API is not available");
        if (!grantToken) {
          if (!cancelled) {
            setLoadError({
              message: "This receipt was not opened from a file on this computer, so it cannot be decided here.",
              errors: [],
            });
            setLoading(false);
          }
          return;
        }
        const res = await a.open({ receiptToken: grantToken });

        if (cancelled) {
          // Superseded or unmounted while main was opening it: do not leave that review hanging.
          if (res?.ok && res.reviewId) void Promise.resolve(a.dismiss(res.reviewId)).catch(() => {});
          return;
        }
        if (!res.ok || !res.reviewId || !res.receipt) {
          setLoadError({
            message: res.error || "Failed to open review",
            errors: Array.isArray(res.errors) ? res.errors.slice(0, 20) : [],
          });
          setLoading(false);
          return;
        }

        reviewIdRef.current = res.reviewId;
        setReviewId(res.reviewId);
        setReceipt(res.receipt);
        setFiles(filesFromResults(res.receipt, res.files));
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setLoadError({ message: err?.message || "Failed to load review receipt", errors: [] });
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, grantToken, dismissIfOpen]);

  // Signal ready
  useEffect(() => {
    if (!loading) {
      onReady?.();
    }
  }, [loading, onReady]);

  // Arming: the 500 ms delay runs from the moment the bar is on screen showing the current review state,
  // and starts over whenever that state changes (refresh, changed result) or the tab is shown again.
  const barShown = !loading && !loadError && receipt !== null;
  const armKey = barShown && active ? armEpoch : null;
  const armed = armKey !== null && armedKey === armKey;
  useEffect(() => {
    if (armKey === null) return;
    const timer = setTimeout(() => setArmedKey(armKey), ARMING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [armKey]);

  // Comment limits
  const commentBytes = useMemo(() => utf8ByteCount(comment), [comment]);
  const isCommentOverLimit = commentBytes > MAX_COMMENT_BYTES;

  // Decide action (only a deliberate, trusted pointer click decides)
  const handleDecide = useCallback(
    async (event: React.MouseEvent, decisionType: "approved" | "changes_requested") => {
      const a = apiRef.current;
      if (!isDeliberateClick(event)) return;
      if (!armed || isSubmitting || isRefreshing || decidedRef.current || isCommentOverLimit || !reviewId || !a || !receipt) {
        return;
      }

      setIsSubmitting(true);
      inFlightRef.current = true;
      setChangeWarning(null);

      try {
        const res = await a.decide({ reviewId, decision: decisionType, comment });

        if (res.ok) {
          decidedRef.current = true; // recorded, whether or not this tab is still on screen
        }
        if (!mountedRef.current) return;

        if (!res.ok) {
          if (res.code === "changed" || res.code === "identity_unavailable") {
            // Click-time re-verification blocks the decision and refreshes the view.
            setChangeWarning(res.message || "A file changed since you looked — review again");
            if (Array.isArray(res.current)) setFiles(filesFromResults(receipt, res.current));
            setArmEpoch((k) => k + 1); // re-armed: disabled for 500 ms again
          } else {
            setChangeWarning(res.message || res.error || "Decision was not recorded");
          }
          return;
        }

        if (res.decision) {
          setDecisionOutcome(res.decision);
          if (res.decision.persisted === false) {
            setPersistedError(true);
            if (res.sidecarConflict) {
              setSidecarConflict(true);
            }
          }
        }
      } catch (err: any) {
        if (mountedRef.current) {
          setChangeWarning(err?.message || "Failed to submit decision");
        }
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setIsSubmitting(false);
        } else {
          // The tab was closed while the decision was in flight and nothing was recorded: dismiss now.
          dismissIfOpen();
        }
      }
    },
    [armed, isSubmitting, isRefreshing, isCommentOverLimit, reviewId, receipt, comment, dismissIfOpen]
  );

  const handleApprove = (e: React.MouseEvent) => void handleDecide(e, "approved");
  const handleRequestChanges = (e: React.MouseEvent) => void handleDecide(e, "changes_requested");

  // Reload action
  const handleReload = async () => {
    const a = apiRef.current;
    if (!a || !reviewId || !receipt || isRefreshing || isSubmitting) return;
    setChangeWarning(null);
    setIsRefreshing(true);
    try {
      const res = await a.refresh(reviewId);
      if (!mountedRef.current) return;
      if (res.ok && Array.isArray(res.files)) {
        setFiles(filesFromResults(receipt, res.files));
      }
      setArmEpoch((k) => k + 1);
    } catch {
      /* the old state stays on screen */
    } finally {
      if (mountedRef.current) setIsRefreshing(false);
    }
  };

  // Keyboard Enter does nothing, except where it types a new line (the comment box).
  const blockEnter = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if ((e.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
    e.preventDefault();
    e.stopPropagation();
  };

  const referenceResolver = useMemo<ViewReferenceResolver>(() => {
    return {
      async resolve(ref) {
        const scopeId = initialReview?.scopeId;
        const grants = (initialReview as any)?.grants;
        const grant = grants?.[ref.path] || (Array.isArray(grants) ? grants.find((g: any) => g.path === ref.path) : undefined);
        if (grant) {
          return {
            status: "found",
            open: () => onOpen?.([toSource(grant, false)]),
          };
        }
        if (scopeId && typeof (window as any).uniview?.viewGrant === "function") {
          try {
            const g = await (window as any).uniview.viewGrant(scopeId, ref.path);
            if (g?.token) {
              const granted: GrantedFile = {
                token: String(g.token),
                name: String(g.name || ref.path.split(/[/\\]/).pop() || ref.path),
                path: String(g.path || g.canonical || ref.path),
                size: Number(g.size ?? 0),
                scopeId: String(g.scopeId || scopeId),
              };
              return {
                status: "found",
                open: () => onOpen?.([toSource(granted, false)]),
              };
            }
          } catch {}
        }
        return { status: "missing" };
      },
    };
  }, [initialReview, onOpen]);

  if (loading) {
    return <div className="receipt-loading">Loading review receipt…</div>;
  }

  if (loadError) {
    return (
      <div className="receipt-error-view" role="alert">
        <h2 className="receipt-error-heading">This receipt could not be shown</h2>
        {loadError.errors.length === 0 && (
          <div className="receipt-error-item">{sanitizeLabel(loadError.message, 300)}</div>
        )}
        {loadError.errors.length > 0 && (
          <ul className="receipt-error-list">
            {loadError.errors.slice(0, 20).map((err, i) => (
              <li key={i} className="receipt-error-item">
                <span className="receipt-err-code">{sanitizeLabel(String(err.code), 40)}</span>
                {err.path && <span className="receipt-err-path"> ({sanitizeLabel(String(err.path), 120)})</span>}
                <span className="receipt-err-message">: {sanitizeLabel(String(err.message), 120)}</span>
              </li>
            ))}
          </ul>
        )}
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
  const controlsDisabled = !armed || isSubmitting || isRefreshing || isDecided || isCommentOverLimit;

  return (
    <div className="receipt-viewer-container review-tab-container" onKeyDown={blockEnter}>
      {/* UniView's own bar, sticky and OUTSIDE the agent-content region */}
      <header className="uniview-bar review-bar" role="banner" data-testid="review-bar">
        <div className="uniview-bar-left review-bar-left">
          <span className="uniview-brand">UniView</span>
          <span className="uniview-receipt-tag">Review Receipt</span>
        </div>

        <div className="uniview-bar-center review-bar-controls">
          {isDecided && (
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
          )}
          <div className="review-action-row">
            <div className="review-comment-wrap">
              <textarea
                className={`review-comment-box ${isCommentOverLimit ? "over-limit" : ""}`}
                data-testid="review-comment"
                placeholder="Comment (optional, max 8 KiB)..."
                aria-label="Comment (optional)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={isSubmitting || isDecided}
                rows={2}
              />
              {isCommentOverLimit && !isDecided && (
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
                onKeyDown={swallowKeyboardActivation}
                onKeyUp={swallowKeyboardActivation}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn btn-request-changes danger"
                data-testid="request-changes-btn"
                onClick={handleRequestChanges}
                disabled={controlsDisabled}
                onKeyDown={swallowKeyboardActivation}
                onKeyUp={swallowKeyboardActivation}
              >
                Request changes
              </button>
            </div>
          </div>
        </div>

        <div className="uniview-bar-right review-bar-right">
          <button type="button" className="receipt-reload-btn" onClick={() => void handleReload()} disabled={isRefreshing || isSubmitting}>
            Reload
          </button>
        </div>
      </header>

      {/* Warnings & Errors */}
      {changeWarning && (
        <div className="banner warn review-change-warning" role="alert" data-testid="review-change-warning">
          <span>{sanitizeLabel(changeWarning, 300)}</span>
          <button type="button" className="link small" onClick={() => setChangeWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

      {persistedError && (
        <div className="banner danger review-persist-error" role="alert" data-testid="persist-error">
          {sidecarConflict
            ? "A decision file from an earlier review already exists next to this receipt; this decision was kept inside UniView only."
            : "Error: Decision could not be saved to disk (persisted: false)"}
        </div>
      )}

      {/* Receipt renders ONLY inside the clearly marked "Content from the agent" region */}
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
        {(receipt.view || viewSource) && (
          <div className="receipt-section receipt-view-section">
            <h2 className="receipt-section-heading">View</h2>
            {viewSource ? (
              <ViewReferenceContext.Provider value={referenceResolver}>
                <ViewSpecViewer
                  source={viewSource}
                  detection={VIEW_SPEC_DETECTION}
                  onReady={onReady || (() => {})}
                  onOpen={onOpen || (() => {})}
                  onFallback={onFallback}
                />
              </ViewReferenceContext.Provider>
            ) : (
              <div className="receipt-view-note">
                {receipt.viewRelPath || receipt.view}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
