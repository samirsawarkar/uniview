// Review IPC handlers and registration for desktop review decisions.
// Pure functions testable without Electron.
//
// Trust model: the renderer is not trusted with paths. It names a receipt by the opaque grant token of a
// file the person opened (GrantStore, core.mjs); main resolves the token to a path itself, reads at most
// 2 MiB through that file, and derives the decision sidecar location only from that granted path. Inline
// receipts (bytes) never write beside anything. Every argument is type- and size-checked, and failures
// come back as fixed codes with fixed messages: no file content, no error text from the OS, no paths.

import crypto from "node:crypto";
import path from "node:path";
import defaultFs from "node:fs/promises";
import { openReview, createVerifier, decide } from "./review-verify.mjs";
import { createDecisionStore } from "./review-store.mjs";
import { openAgentPath as defaultOpenAgentPath } from "./agent-paths.mjs";

export const REVIEW_IPC_LIMITS = Object.freeze({
  /** Receipt file / inline body, same as the receipt format limit. */
  maxReceiptBytes: 2 * 1024 * 1024,
  maxCommentBytes: 8192,
  /** Reviews that are open (opened, not yet decided) at once, including opens still in flight. */
  maxOpenUndecided: 32,
  /** Decided reviews stay answerable ("already decided") for this long, then are forgotten. */
  decidedRetentionMs: 60_000,
  /** Hard bound on remembered decided reviews inside the retention window. */
  maxDecidedKept: 64,
  maxTokenLength: 64,
});

const MESSAGES = Object.freeze({
  bad_args: "Invalid request",
  not_granted: "This file is no longer available. Open it again.",
  unreadable: "The receipt could not be read",
  too_large: "The receipt is larger than 2 MiB",
  invalid_receipt: "This is not a valid review receipt",
  verify_failed: "The files could not be checked",
  too_many_reviews: "Too many reviews are open. Decide or close one first.",
  not_found: "Review not found",
  already_decided: "This review has already been decided",
  busy: "Another action on this review is in progress",
  bad_decision: "Invalid decision",
  bad_comment: "Comment exceeds 8 KiB",
  changed: "A file changed since you looked — review again",
  identity_unavailable: "A file cannot be identified reliably, so it cannot be approved",
  invalid_decision: "The decision could not be recorded",
  failed: "The review could not be completed",
});

/** Short fixed text per validation error code. The validator's own messages can echo receipt content. */
const VALIDATION_TEXT = Object.freeze({
  schema: "does not match the receipt format",
  bad_path: "is not an acceptable path",
  too_large: "is too large",
  too_deep: "is nested too deeply",
  invalid_json: "is not valid JSON",
  unsupported_version: "is not a supported version",
});
const MAX_VALIDATION_ERRORS = 20;
const MAX_ERROR_PATH = 120;

function fail(code, extra = {}) {
  const known = Object.hasOwn(MESSAGES, code) ? code : "failed";
  return { ok: false, code: known, error: MESSAGES[known], ...extra };
}

function safeCode(code) {
  return typeof code === "string" && Object.hasOwn(MESSAGES, code) ? code : "failed";
}

function sanitizeValidationErrors(details) {
  if (!Array.isArray(details)) return [];
  const out = [];
  for (const d of details) {
    if (out.length >= MAX_VALIDATION_ERRORS) break;
    if (typeof d !== "object" || d === null) continue;
    const code = typeof d.code === "string" && Object.hasOwn(VALIDATION_TEXT, d.code) ? d.code : "schema";
    const rawPath = typeof d.path === "string" ? d.path : "";
    // eslint-disable-next-line no-control-regex
    const cleanPath = rawPath.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").slice(0, MAX_ERROR_PATH);
    out.push({ code, path: cleanPath, message: VALIDATION_TEXT[code] });
  }
  return out;
}

function isPlainObject(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const REVIEW_ID = /^[0-9a-f]{32}$/;

function toBytes(v) {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

export function createReviewIpcHandlers({
  store,
  storeDir,
  verifier,
  openAgentPath = defaultOpenAgentPath,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  fs = defaultFs,
  /** token -> { path } | undefined. Without one, every token is refused. */
  resolveGrant = () => undefined,
  limits = REVIEW_IPC_LIMITS,
} = {}) {
  const actualStore = store || (storeDir ? createDecisionStore({ dir: storeDir, fs, now }) : null);
  const actualVerifier = verifier || createVerifier({ openAgentPath, now });
  const openReviews = new Map();
  let pendingOpens = 0;

  function undecidedCount() {
    let n = 0;
    for (const rec of openReviews.values()) if (!rec.decided) n++;
    return n;
  }

  /** Forget decided reviews past their retention, and the oldest ones beyond the hard bound. */
  function sweep() {
    const t = now();
    const decided = [];
    for (const [id, rec] of openReviews) {
      if (!rec.decided) continue;
      if (rec.inFlight) continue;
      if (t - rec.decidedAt > limits.decidedRetentionMs) openReviews.delete(id);
      else decided.push([id, rec]);
    }
    if (decided.length > limits.maxDecidedKept) {
      decided.sort((a, b) => a[1].decidedAt - b[1].decidedAt);
      for (const [id] of decided.slice(0, decided.length - limits.maxDecidedKept)) openReviews.delete(id);
    }
  }

  /** Reads the granted file: at most maxReceiptBytes; a bigger file is refused without reading it. */
  async function readGranted(filePath) {
    let fh;
    try {
      fh = await fs.open(filePath, "r");
      const st = await fh.stat();
      if (!st.isFile()) return { code: "unreadable" };
      if (st.size > limits.maxReceiptBytes) return { code: "too_large" };
      // One byte more than the limit, so a file that grew after the check is still caught.
      const buf = Buffer.allocUnsafe(limits.maxReceiptBytes + 1);
      let total = 0;
      while (total < buf.length) {
        const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > limits.maxReceiptBytes) return { code: "too_large" };
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, total) };
    } catch {
      return { code: "unreadable" };
    } finally {
      try {
        await fh?.close();
      } catch {
        /* nothing useful to do */
      }
    }
  }

  async function handleReviewOpen(args) {
    sweep();
    if (!isPlainObject(args)) return fail("bad_args");
    for (const k of Object.keys(args)) {
      if (k !== "receiptToken" && k !== "receiptBytes" && args[k] !== undefined) return fail("bad_args");
    }
    const hasToken = args.receiptToken !== undefined && args.receiptToken !== null;
    const hasBytes = args.receiptBytes !== undefined && args.receiptBytes !== null;
    if (hasToken === hasBytes) return fail("bad_args");

    if (undecidedCount() + pendingOpens >= limits.maxOpenUndecided) return fail("too_many_reviews");
    pendingOpens++;
    try {
      let bytes;
      let receiptPath = null;
      if (hasToken) {
        const token = args.receiptToken;
        if (typeof token !== "string" || token.length > limits.maxTokenLength) return fail("bad_args");
        const entry = resolveGrant(token);
        if (!entry || typeof entry.path !== "string") return fail("not_granted");
        const base = path.basename(entry.path);
        if (!base.toLowerCase().endsWith(".receipt.json")) return fail("bad_args");
        const read = await readGranted(entry.path);
        if (!read.bytes) return fail(read.code);
        bytes = read.bytes;
        receiptPath = entry.path;
      } else {
        bytes = toBytes(args.receiptBytes);
        if (!bytes) return fail("bad_args");
        if (bytes.byteLength > limits.maxReceiptBytes) return fail("too_large");
        bytes = new Uint8Array(bytes); // own copy: the review's digest is of these exact bytes
      }

      let review;
      try {
        review = await openReview({ receiptBytes: bytes, receiptPath, randomBytes });
      } catch (err) {
        const code = safeCode(err?.code);
        if (code === "invalid_receipt") {
          return fail("invalid_receipt", { errors: sanitizeValidationErrors(err?.details) });
        }
        return fail(code);
      }

      let shown;
      try {
        shown = await actualVerifier.verify(review.receipt.files);
      } catch {
        return fail("verify_failed");
      }

      openReviews.set(review.reviewId, {
        reviewId: review.reviewId,
        review,
        shown,
        decided: false,
        inFlight: false,
        decidedAt: 0,
        pendingDismiss: false,
        inFlightPromise: null,
        dismissResult: null,
        decision: null,
      });

      return {
        ok: true,
        reviewId: review.reviewId,
        receiptDigest: review.receiptDigest,
        receipt: review.receipt,
        files: shown.results,
        verifiedAt: shown.verifiedAt,
      };
    } finally {
      pendingOpens--;
    }
  }

  async function executeDismiss(rec) {
    if (rec.decided) {
      openReviews.delete(rec.reviewId);
      return { ok: true, dismissed: false, alreadyDecided: true, decision: rec.decision };
    }
    try {
      const result = await decide({
        review: rec.review,
        shown: rec.shown,
        decision: "dismissed",
        comment: "",
        verifier: actualVerifier,
        store: actualStore,
        writeNextToReceipt: Boolean(rec.review.receiptPath),
        now,
      });
      rec.decided = true;
      rec.decidedAt = now();
      rec.decision = result?.decision ?? null;
      openReviews.delete(rec.reviewId);
      return { ok: true, dismissed: true, decision: result?.decision };
    } catch (err) {
      openReviews.delete(rec.reviewId);
      return fail(safeCode(err?.code));
    }
  }

  async function handleReviewDecide(args) {
    sweep();
    if (!isPlainObject(args)) return fail("bad_args");
    const { reviewId, decision } = args;
    const comment = args.comment === undefined || args.comment === null ? "" : args.comment;
    if (typeof reviewId !== "string" || !REVIEW_ID.test(reviewId)) return fail("bad_args");
    if (typeof comment !== "string") return fail("bad_args");
    if (typeof decision !== "string" || !["approved", "changes_requested"].includes(decision)) return fail("bad_decision");
    // A string longer than the limit in UTF-16 units is longer in UTF-8 bytes too: no need to encode it.
    if (comment.length > limits.maxCommentBytes || new TextEncoder().encode(comment).byteLength > limits.maxCommentBytes) {
      return fail("bad_comment");
    }

    const rec = openReviews.get(reviewId);
    if (!rec) return fail("not_found");
    if (rec.decided) return fail("already_decided");
    if (rec.inFlight) return fail("busy");

    let resolveInFlight;
    rec.inFlight = true;
    rec.inFlightPromise = new Promise((resolve) => {
      resolveInFlight = resolve;
    });

    try {
      let result;
      try {
        result = await decide({
          review: rec.review,
          shown: rec.shown,
          decision,
          comment,
          verifier: actualVerifier,
          store: actualStore,
          writeNextToReceipt: Boolean(rec.review.receiptPath),
          now,
        });
      } catch (err) {
        return fail(safeCode(err?.code));
      }

      if (result?.ok) {
        rec.decided = true;
        rec.decidedAt = now();
        rec.decision = result.decision;
        let sidecarConflict = false;
        if (result.decision?.persisted === false && rec.review?.receiptPath) {
          try {
            const sidecarPath = `${path.resolve(rec.review.receiptPath)}.decision.json`;
            const content = await fs.readFile(sidecarPath, "utf8");
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === "object" && parsed.reviewId && parsed.reviewId !== rec.review.reviewId) {
              sidecarConflict = true;
            }
          } catch {
            // Not a conflict or file doesn't exist
          }
        }
        return {
          ok: true,
          decision: result.decision,
          ...(sidecarConflict ? { sidecarConflict: true } : {}),
        };
      }

      if (result && (result.code === "changed" || result.code === "identity_unavailable") && result.current) {
        rec.shown = result.current;
        return {
          ok: false,
          code: result.code,
          message: MESSAGES[result.code],
          current: result.current.results,
          verifiedAt: result.current.verifiedAt,
        };
      }

      return fail(safeCode(result?.code));
    } finally {
      rec.inFlight = false;
      if (rec.pendingDismiss && !rec.decided) {
        rec.dismissResult = await executeDismiss(rec);
      }
      resolveInFlight();
      rec.inFlightPromise = null;
    }
  }

  async function handleReviewDismiss(reviewId) {
    sweep();
    if (typeof reviewId !== "string" || !REVIEW_ID.test(reviewId)) return fail("bad_args");
    const rec = openReviews.get(reviewId);
    if (!rec) return fail("not_found");
    if (rec.decided) {
      openReviews.delete(reviewId);
      return { ok: true, dismissed: false, alreadyDecided: true, decision: rec.decision };
    }
    if (rec.inFlight) {
      rec.pendingDismiss = true;
      await rec.inFlightPromise;
      if (rec.dismissResult) {
        return rec.dismissResult;
      }
      if (rec.decided) {
        openReviews.delete(reviewId);
        return { ok: true, dismissed: false, alreadyDecided: true, decision: rec.decision };
      }
      return executeDismiss(rec);
    }

    return executeDismiss(rec);
  }

  async function handleReviewRefresh(reviewId) {
    sweep();
    if (typeof reviewId !== "string" || !REVIEW_ID.test(reviewId)) return fail("bad_args");
    const rec = openReviews.get(reviewId);
    if (!rec) return fail("not_found");
    if (rec.decided) return fail("already_decided");
    if (rec.inFlight) return fail("busy");

    let resolveInFlight;
    rec.inFlight = true;
    rec.inFlightPromise = new Promise((resolve) => {
      resolveInFlight = resolve;
    });

    try {
      const fresh = await actualVerifier.verify(rec.review.receipt.files);
      rec.shown = fresh;
      return { ok: true, files: fresh.results, verifiedAt: fresh.verifiedAt };
    } catch {
      return fail("verify_failed");
    } finally {
      rec.inFlight = false;
      if (rec.pendingDismiss && !rec.decided) {
        rec.dismissResult = await executeDismiss(rec);
      }
      resolveInFlight();
      rec.inFlightPromise = null;
    }
  }

  function hasUndecided() {
    return undecidedCount() > 0;
  }

  /** Window closed or app quitting: every review still open is recorded as dismissed. */
  async function dismissAll() {
    const list = [...openReviews].filter(([_, rec]) => !rec.decided);
    const results = await Promise.all(list.map(([id]) => handleReviewDismiss(id)));
    return results.filter((res) => res && res.ok && res.dismissed).length;
  }

  return {
    handleReviewOpen,
    handleReviewDecide,
    handleReviewDismiss,
    handleReviewRefresh,
    hasUndecided,
    dismissAll,
    openReviews,
  };
}

/**
 * "Closing the review means dismissed" also when the window closes or the app quits: before-quit waits
 * (bounded) for the open reviews to be recorded as dismissed, then quits for real.
 */
export function installShutdownDismiss({ app, manager, timeoutMs = 3000 } = {}) {
  let started = false;
  app.on("before-quit", (event) => {
    if (started || !manager.hasUndecided()) return;
    started = true;
    event.preventDefault();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    let dismissing;
    try {
      dismissing = Promise.resolve(manager.dismissAll());
    } catch (err) {
      dismissing = Promise.reject(err);
    }
    Promise.race([dismissing, timeout])
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        app.quit();
      });
  });
}

export async function registerReviewIpc({
  ipcMain: injectedIpcMain,
  fromApp,
  grants,
  resolveGrant,
  manager,
  userDataPath,
  openAgentPath = defaultOpenAgentPath,
  fs = defaultFs,
} = {}) {
  // Fail closed: without a sender check these handlers would answer any frame.
  if (typeof fromApp !== "function") {
    throw new TypeError("registerReviewIpc requires a fromApp(event) sender check");
  }

  let electronIpc = injectedIpcMain;
  let dataPath = userDataPath;

  if (!electronIpc || !dataPath) {
    try {
      const electron = await import("electron");
      electronIpc = electronIpc || electron.ipcMain;
      dataPath = dataPath || (electron.app?.getPath ? electron.app.getPath("userData") : null);
    } catch {
      // Not in Electron
    }
  }

  const grantResolver = resolveGrant || (grants && typeof grants.get === "function" ? (t) => grants.get(t) : undefined);
  const reviewManager = manager || createReviewIpcHandlers({
    storeDir: dataPath ? path.join(dataPath, "reviews") : undefined,
    openAgentPath,
    fs,
    ...(grantResolver ? { resolveGrant: grantResolver } : {}),
  });

  if (electronIpc) {
    const guard = (fn) => async (e, ...args) => {
      if (!fromApp(e)) throw new Error("Request refused: unknown sender");
      try {
        return await fn(args[0]);
      } catch {
        return fail("failed");
      }
    };

    electronIpc.handle("review:open", guard((a) => reviewManager.handleReviewOpen(a)));
    electronIpc.handle("review:decide", guard((a) => reviewManager.handleReviewDecide(a)));
    electronIpc.handle("review:dismiss", guard((id) => reviewManager.handleReviewDismiss(id)));
    electronIpc.handle("review:refresh", guard((id) => reviewManager.handleReviewRefresh(id)));
  }

  return reviewManager;
}
