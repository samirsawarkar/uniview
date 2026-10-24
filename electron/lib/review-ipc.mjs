// Review IPC handlers and registration for desktop review decisions.
// Pure functions testable without Electron.

import crypto from "node:crypto";
import path from "node:path";
import defaultFs from "node:fs/promises";
import { openReview, createVerifier, decide, ReviewError } from "./review-verify.mjs";
import { createDecisionStore } from "./review-store.mjs";
import { openAgentPath as defaultOpenAgentPath } from "./agent-paths.mjs";

export function createReviewIpcHandlers({
  store,
  storeDir,
  verifier,
  openAgentPath = defaultOpenAgentPath,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  fs = defaultFs,
} = {}) {
  const actualStore = store || (storeDir ? createDecisionStore({ dir: storeDir, fs, now }) : null);
  const actualVerifier = verifier || createVerifier({ openAgentPath, now });
  const openReviews = new Map();

  async function handleReviewOpen(args = {}) {
    let bytes = args.receiptBytes;
    if (!bytes && args.receiptPath) {
      try {
        bytes = await fs.readFile(args.receiptPath);
      } catch (err) {
        return { ok: false, error: err?.message || "Failed to read receipt file" };
      }
    }
    if (!bytes) {
      return { ok: false, error: "Missing receipt bytes" };
    }
    if (typeof bytes === "string") {
      bytes = new TextEncoder().encode(bytes);
    } else if (bytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytes);
    } else if (ArrayBuffer.isView(bytes) && !(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    let review;
    try {
      review = await openReview({
        receiptBytes: bytes,
        receiptPath: args.receiptPath ?? null,
        randomBytes,
      });
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
        code: err?.code,
        details: err?.details,
      };
    }

    let shown;
    try {
      shown = await actualVerifier.verify(review.receipt.files);
    } catch (err) {
      return { ok: false, error: err?.message || "Verification failed" };
    }

    const reviewRecord = {
      reviewId: review.reviewId,
      review,
      shown,
      decided: false,
    };
    openReviews.set(review.reviewId, reviewRecord);

    return {
      ok: true,
      reviewId: review.reviewId,
      receiptDigest: review.receiptDigest,
      receipt: review.receipt,
      receiptPath: review.receiptPath,
      files: shown.results,
      verifiedAt: shown.verifiedAt,
    };
  }

  async function handleReviewDecide(args = {}) {
    const { reviewId, decision, comment = "" } = args;
    const rec = openReviews.get(reviewId);
    if (!rec) {
      return { ok: false, error: `Review ${reviewId} not found`, code: "not_found" };
    }
    if (rec.decided) {
      return { ok: false, error: `Review ${reviewId} is already decided`, code: "already_decided" };
    }
    if (!["approved", "changes_requested"].includes(decision)) {
      return { ok: false, error: `Invalid decision: ${decision}`, code: "bad_decision" };
    }

    const commentBytes = new TextEncoder().encode(comment ?? "").byteLength;
    if (commentBytes > 8192) {
      return { ok: false, error: "Comment exceeds 8 KiB", code: "bad_comment" };
    }

    const writeNextToReceipt = Boolean(rec.review.receiptPath);
    let result;
    try {
      result = await decide({
        review: rec.review,
        shown: rec.shown,
        decision,
        comment: comment ?? "",
        verifier: actualVerifier,
        store: actualStore,
        writeNextToReceipt,
        now,
      });
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
        code: err?.code,
        details: err?.details,
      };
    }

    if (!result.ok && result.code === "changed") {
      rec.shown = result.current;
      return {
        ok: false,
        code: "changed",
        message: "A file changed since you looked — review again",
        current: result.current.results,
        verifiedAt: result.current.verifiedAt,
      };
    }

    if (result.ok) {
      rec.decided = true;
      return {
        ok: true,
        decision: result.decision,
      };
    }

    return result;
  }

  async function handleReviewDismiss(reviewId) {
    const id = typeof reviewId === "object" && reviewId !== null ? reviewId.reviewId : reviewId;
    const rec = openReviews.get(id);
    if (!rec) {
      return { ok: false, error: `Review ${id} not found`, code: "not_found" };
    }
    if (rec.decided) {
      openReviews.delete(id);
      return { ok: true, dismissed: false, alreadyDecided: true };
    }

    const writeNextToReceipt = Boolean(rec.review.receiptPath);
    try {
      const result = await decide({
        review: rec.review,
        shown: rec.shown,
        decision: "dismissed",
        comment: "",
        verifier: actualVerifier,
        store: actualStore,
        writeNextToReceipt,
        now,
      });
      rec.decided = true;
      openReviews.delete(id);
      return {
        ok: true,
        dismissed: true,
        decision: result.decision,
      };
    } catch (err) {
      openReviews.delete(id);
      return { ok: false, error: err?.message || String(err), code: err?.code };
    }
  }

  async function handleReviewRefresh(reviewId) {
    const id = typeof reviewId === "object" && reviewId !== null ? reviewId.reviewId : reviewId;
    const rec = openReviews.get(id);
    if (!rec) {
      return { ok: false, error: `Review ${id} not found`, code: "not_found" };
    }
    try {
      const fresh = await actualVerifier.verify(rec.review.receipt.files);
      rec.shown = fresh;
      return {
        ok: true,
        files: fresh.results,
        verifiedAt: fresh.verifiedAt,
      };
    } catch (err) {
      return { ok: false, error: err?.message || "Refresh failed" };
    }
  }

  return {
    handleReviewOpen,
    handleReviewDecide,
    handleReviewDismiss,
    handleReviewRefresh,
    openReviews,
  };
}

export async function registerReviewIpc({
  ipcMain: injectedIpcMain,
  fromApp,
  manager,
  userDataPath,
  openAgentPath = defaultOpenAgentPath,
  fs = defaultFs,
} = {}) {
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

  const reviewManager = manager || createReviewIpcHandlers({
    storeDir: dataPath ? path.join(dataPath, "reviews") : undefined,
    openAgentPath,
    fs,
  });

  if (electronIpc) {
    const guard = (fn) => async (e, ...args) => {
      if (fromApp && !fromApp(e)) throw new Error("Request refused: unknown sender");
      return fn(...args);
    };

    electronIpc.handle("review:open", guard(async (_e, args) => reviewManager.handleReviewOpen(args)));
    electronIpc.handle("review:decide", guard(async (_e, args) => reviewManager.handleReviewDecide(args)));
    electronIpc.handle("review:dismiss", guard(async (_e, reviewId) => reviewManager.handleReviewDismiss(reviewId)));
    electronIpc.handle("review:refresh", guard(async (_e, reviewId) => reviewManager.handleReviewRefresh(reviewId)));
  }

  return reviewManager;
}
