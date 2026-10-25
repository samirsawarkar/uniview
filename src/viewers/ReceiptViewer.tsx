import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { ViewerProps } from "./types";
import type { FileSource } from "../core/types";
import { validateReceipt } from "../../shared/receipt.mjs";
import type { Receipt, ReceiptValidationError } from "../../shared/receipt.d.mts";
import { sanitizeLabel, AgentMarkdown } from "./agent-markdown";
import ViewSpecViewer from "./ViewSpecViewer";
import { ViewReferenceContext, type ViewReferenceResolver } from "./viewspec-nodes";
import {
  createReferenceResolver,
  fileChoiceKey,
  nextCompanionId,
  resolveLanPath,
  type LanContext,
  type LanReader,
  type CompanionFile,
  type ResolvedTarget,
} from "../core/receipt-resolve";
import {
  verifyReceiptWeb,
  type WebVerifyFile,
  type WebVerifiedFile,
} from "../core/receipt-verify-web";
import { createLanReader } from "../remote/receipt-lan";
import { getBridge } from "../shells";
import { grantTokenOf, hasElectronApi, type ReviewApi } from "../shells/electron";
import ReviewTab from "./ReviewTab";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024; // 2 MiB limit for receipt file itself
const NOT_AVAILABLE = "not available on this device";

export interface ReceiptViewerProps extends ViewerProps {
  /**
   * Reads files of the LAN-shared root the receipt was opened from. By default it is built from the
   * paired computer; null means this device cannot read the share. Tests inject a fake remote here.
   */
  lanReader?: LanReader | null;
  reviewApi?: ReviewApi;
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

/** Agent text that may span lines (check evidence): same stripping as labels, newlines kept. */
function sanitizeBlock(text: string, max: number): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => sanitizeLabel(line, Number.MAX_SAFE_INTEGER))
    .join("\n")
    .slice(0, max);
}

/** A FileSource that reads the resolved target only when a viewer asks for it. */
function targetSource(target: ResolvedTarget): FileSource {
  let url: string | undefined;
  let counter = 0;
  const readAll = (): Promise<ArrayBuffer> => target.read();
  return {
    id: `receipt-ref-${nextCompanionId()}-${counter++}`,
    name: target.name,
    size: target.size,
    readAll,
    readRange: async (start, end) => (await readAll()).slice(start, end),
    async url() {
      if (url) return url;
      url = URL.createObjectURL(new Blob([await readAll()]));
      return url;
    },
    release() {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    },
  };
}

type ViewState =
  | { status: "none" }
  | { status: "checking" }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "ambiguous"; candidates: CompanionFile[] }
  | { status: "found"; sig: string; source: FileSource; basePath: string | undefined; via: "lan" | "companion" };

const VIEW_KEY = "view";
const noop = () => {};

/**
 * Desktop: a receipt the person opened from a file on this computer (it carries a grant token) gets the
 * Review tab, which can record a decision. Anything else (a receipt from a paired computer, or from no
 * file at all) is shown read-only: its files[].path entries name files on ANOTHER device, so checking them
 * against this computer's disk would prove nothing about what the agent produced.
 *
 * This is a wrapper so that the two bodies are separate components: switching between them never changes
 * the hooks one component runs.
 */
export default function ReceiptViewer(props: ReceiptViewerProps): React.ReactElement {
  const { source, reviewApi: reviewApiProp } = props;
  const desktopReviewApi = useMemo<ReviewApi | null>(() => {
    if (reviewApiProp) return reviewApiProp;
    if (hasElectronApi() && (window as any).uniview?.review) {
      return (window as any).uniview.review as ReviewApi;
    }
    return null;
  }, [reviewApiProp]);

  const fromOtherDevice = Boolean(source.remote);
  if (desktopReviewApi && !fromOtherDevice && grantTokenOf(source)) {
    return (
      <ReviewTab
        source={source}
        reviewApi={desktopReviewApi}
        active={props.active}
        onReady={props.onReady}
        onFallback={props.onFallback}
        onOpen={props.onOpen}
      />
    );
  }
  return <ReadOnlyReceiptViewer {...props} decideNote={desktopReviewApi && fromOtherDevice ? "other-device" : "default"} />;
}

interface ReadOnlyReceiptViewerProps extends ReceiptViewerProps {
  decideNote: "default" | "other-device";
}

function ReadOnlyReceiptViewer({
  source,
  onReady,
  onFallback,
  onOpen,
  lanReader: lanReaderProp,
  decideNote,
}: ReadOnlyReceiptViewerProps): React.ReactElement {
  const [loaded, setLoaded] = useState<LoadedReceipt | null>(null);
  const [verifiedFiles, setVerifiedFiles] = useState<Record<number, WebVerifiedFile>>({});
  const [companions, setCompanions] = useState<CompanionFile[]>([]);
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, CompanionFile[]>>({});
  const [chosenFiles, setChosenFiles] = useState<Record<string, CompanionFile>>({});
  const [view, setView] = useState<ViewState>({ status: "none" });
  const mounted = useRef(true);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  /** Verification passes run strictly one after another; a pass that is superseded stops early. */
  const passChain = useRef<Promise<void>>(Promise.resolve());
  /** Hashes of picked files (they never change), reused between passes. */
  const hashCache = useRef(new Map<string, string | null>());

  const receipt = loaded?.receipt ?? null;
  const errors = loaded?.errors ?? null;
  const loading = loaded === null;

  const lanContext = useMemo<LanContext | undefined>(
    () =>
      source.remote
        ? {
            hostId: source.remote.hostId,
            rootId: source.remote.rootId,
            receiptPath: source.remote.path,
          }
        : undefined,
    [source.remote]
  );

  const lanReader = useMemo<LanReader | null>(() => {
    if (lanReaderProp !== undefined) return lanReaderProp;
    if (!source.remote) return null;
    try {
      return createLanReader(source.remote, { transport: getBridge().remoteTransport });
    } catch {
      return null;
    }
  }, [lanReaderProp, source.remote]);

  // Initial read and validation
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setLoaded(null);
    setCompanions([]);
    setChosenFiles({});
    setAmbiguousChoices({});
    setVerifiedFiles({});
    hashCache.current = new Map();

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

  // Verification pass for files: one file at a time, one pass at a time.
  useEffect(() => {
    if (!receipt) return;

    const ac = new AbortController();
    setVerifiedFiles({});
    setAmbiguousChoices({});

    const filesToVerify: WebVerifyFile[] = receipt.files.map((f) => ({
      path: f.path,
      relPath: f.relPath,
      expectedSha256: f.sha256,
      role: f.role,
    }));

    const run = async () => {
      if (ac.signal.aborted) return;
      const budget = { used: 0 };
      const resolve = createReferenceResolver({
        lan: lanContext,
        lanReader,
        companions,
        chosen: chosenFiles,
        hashCache: hashCache.current,
        budget,
        signal: ac.signal,
      });
      try {
        await verifyReceiptWeb(
          filesToVerify,
          async (file, index) => {
            const key = fileChoiceKey(file.path, file.expectedSha256);
            const out = await resolve({
              key,
              path: file.path,
              relPath: file.relPath,
              sha256: file.expectedSha256,
            });
            if (out.status === "found") {
              return {
                size: out.size,
                readAll: out.read,
                digestHex: out.digestHex,
                prehashed: out.prehashed,
              };
            }
            if (out.status === "ambiguous" && !ac.signal.aborted) {
              setAmbiguousChoices((prev) => ({ ...prev, [key]: out.candidates }));
            }
            return null;
          },
          {
            signal: ac.signal,
            budget,
            onFile: (f, index) => {
              if (!ac.signal.aborted) setVerifiedFiles((prev) => ({ ...prev, [index]: f }));
            },
          }
        );
      } catch {
        /* a failed pass leaves the remaining files "not checked" */
      }
    };
    passChain.current = passChain.current.then(run, run);

    return () => {
      ac.abort();
    };
  }, [receipt, lanContext, lanReader, companions, chosenFiles]);

  // The receipt's view: resolved like any other reference, then shown by the view viewer.
  useEffect(() => {
    if (!receipt || !receipt.view) {
      setView({ status: "none" });
      return;
    }
    let cancelled = false;
    setView((prev) => (prev.status === "found" ? prev : { status: "checking" }));
    const resolve = createReferenceResolver({
      lan: lanContext,
      lanReader,
      companions,
      chosen: chosenFiles,
      hashCache: hashCache.current,
      budget: { used: 0 },
    });
    void (async () => {
      let next: ViewState;
      try {
        const out = await resolve({ key: VIEW_KEY, path: receipt.view!, relPath: receipt.viewRelPath });
        if (out.status === "found") {
          const lan = lanContext && receipt.viewRelPath ? resolveLanPath(receipt.viewRelPath, lanContext) : null;
          next = {
            status: "found",
            sig: `${out.via}:${out.id}`,
            source: targetSource(out),
            basePath: lan && lan.ok ? lan.resolvedPath : undefined,
            via: out.via,
          };
        } else if (out.status === "ambiguous") {
          next = { status: "ambiguous", candidates: out.candidates };
        } else {
          next = { status: "missing" };
        }
      } catch {
        next = { status: "unreadable" };
      }
      if (cancelled) return;
      setView((prev) => (prev.status === "found" && next.status === "found" && prev.sig === next.sig ? prev : next));
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt, lanContext, lanReader, companions, chosenFiles]);

  // Images and fileRefs inside the view resolve against the view's own folder (or the picked files).
  const viewBase = view.status === "found" ? view.basePath : undefined;
  const viewVia = view.status === "found" ? view.via : undefined;
  const referenceResolver = useMemo<ViewReferenceResolver | null>(() => {
    if (view.status !== "found") return null;
    return {
      async resolve(ref) {
        const resolve = createReferenceResolver({
          lan: viewVia === "companion" ? undefined : lanContext,
          lanReader: viewVia === "companion" ? null : lanReader,
          companions,
          chosen: {},
          hashCache: hashCache.current,
          budget: { used: 0 },
        });
        try {
          const out = await resolve({ key: `${ref.kind}:${ref.path}`, path: ref.path, relPath: ref.relPath }, viewBase);
          if (out.status !== "found") return { status: "missing" };
          return {
            status: "found",
            open: () => onOpenRef.current([targetSource(out)]),
          };
        } catch {
          return { status: "unreadable" };
        }
      },
    };
  }, [view.status, viewVia, lanContext, lanReader, companions, viewBase]);

  const handlePickCompanions = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Keep the File handles only; their bytes are read lazily, one file at a time, when hashing.
    const picked: CompanionFile[] = Array.from(e.target.files ?? []).map((file) => ({
      id: nextCompanionId(),
      name: file.name,
      size: file.size,
      handle: file,
    }));
    try {
      e.target.value = "";
    } catch {
      /* some browsers refuse to clear a file input */
    }
    if (picked.length === 0) return;
    setCompanions((prev) => [...prev, ...picked]);
  }, []);

  const handleSelectChoice = (key: string, comp: CompanionFile) => {
    setChosenFiles((prev) => ({ ...prev, [key]: comp }));
    setAmbiguousChoices((prev) => {
      const next = { ...prev };
      delete next[key];
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
              <span className="receipt-err-code">{sanitizeLabel(String(err.code), 120)}</span>
              {err.path && <span className="receipt-err-path"> ({sanitizeLabel(err.path, 4096)})</span>}
              <span className="receipt-err-message">: {sanitizeLabel(err.message, 4096)}</span>
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
          {decideNote === "other-device" ? (
            <span className="uniview-decide-banner" data-testid="decide-elsewhere">
              This receipt came from another device. Decide on the computer it came from.
            </span>
          ) : (
            <span className="uniview-decide-banner">Decide on your computer</span>
          )}
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
            {" "}
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
                onChange={handlePickCompanions}
                style={{ display: "none" }}
              />
            </label>
          </div>

          <ul className="receipt-files-list">
            {receipt.files.map((file, i) => {
              const verified = verifiedFiles[i];
              const fKey = fileChoiceKey(file.path, file.sha256);
              const choices = ambiguousChoices[fKey];
              const isAmbiguous = choices && choices.length > 0;
              const state = isAmbiguous ? "choose a file" : (verified?.state ?? "not checked");
              const name = sanitizeLabel(file.relPath || file.path, 4096);

              return (
                <li key={i} className="receipt-file-item">
                  <div className="receipt-file-header">
                    <span className={`receipt-role-badge role-${file.role}`}>
                      {file.role}
                    </span>
                    <span className="receipt-file-name">{name}</span>
                    <span className={`receipt-state-badge state-${state.replace(/ /g, "_")}`}>
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

                  {isAmbiguous && (
                    <Chooser name={name} choices={choices} onChoose={(c) => handleSelectChoice(fKey, c)} />
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
                    <span className="receipt-check-name">{sanitizeLabel(chk.name, 200)}</span>
                    <span
                      className={`receipt-check-status-badge status-${chk.status}`}
                    >
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
            <h2 className="receipt-section-heading">
              Sources ({receipt.sources.length})
            </h2>
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

        {/* The receipt's view */}
        {receipt.view && (
          <div className="receipt-section receipt-view-section">
            <h2 className="receipt-section-heading">View</h2>
            {view.status === "found" ? (
              <ViewReferenceContext.Provider value={referenceResolver}>
                <ViewSpecViewer
                  key={view.sig}
                  source={view.source}
                  detection={{ kind: "viewspec" as any, ext: "uview.json", by: "extension", label: "UniView view" }}
                  onOpen={onOpen}
                  onReady={noop}
                />
              </ViewReferenceContext.Provider>
            ) : view.status === "ambiguous" ? (
              <Chooser
                name={sanitizeLabel(receipt.viewRelPath || receipt.view, 4096)}
                choices={view.candidates}
                onChoose={(c) => handleSelectChoice(VIEW_KEY, c)}
              />
            ) : view.status === "checking" || view.status === "none" ? (
              <div className="receipt-view-note">Looking for the view…</div>
            ) : (
              <div className="receipt-view-note">
                {view.status === "unreadable"
                  ? "The view could not be read from the shared folder."
                  : `The view is ${NOT_AVAILABLE}. Pick it as a companion file or open the receipt from a shared folder.`}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Chooser({
  name,
  choices,
  onChoose,
}: {
  name: string;
  choices: CompanionFile[];
  onChoose: (c: CompanionFile) => void;
}): React.ReactElement {
  return (
    <div className="receipt-ambiguous-picker">
      <span className="receipt-ambiguous-prompt">
        Multiple files named &quot;{name}&quot; found. Choose:
      </span>
      <div className="receipt-choices-row">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            className="receipt-choice-btn"
            onClick={() => onChoose(c)}
          >
            Use {sanitizeLabel(c.name, 200)} ({c.size} bytes)
          </button>
        ))}
      </div>
    </div>
  );
}
