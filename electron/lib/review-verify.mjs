import crypto from "node:crypto";
// @ts-expect-error plain ESM module without types
import { validateReceipt, validateDecision, sha256Hex, fileState, canDecide } from "../../shared/receipt.mjs";
import { writeDecisionNextToReceipt } from "./review-store.mjs";

export const REVIEW_LIMITS = Object.freeze({
  maxBytesPerPass: 8 * 1024 * 1024 * 1024, // 8 GiB
  passDeadlineMs: 120_000,
  concurrentFiles: 2,
  queuedVerifications: 4,
  chunkBytes: 1024 * 1024, // 1 MiB
});

// How often a pending pass re-checks the deadline against the injected clock.
const DEADLINE_TICK_MS = 250;

export class ReviewError extends Error {
  constructor(code, details = undefined) {
    super(details ? `${code}: ${Array.isArray(details) ? details.join(", ") : JSON.stringify(details)}` : code);
    this.name = "ReviewError";
    this.code = code;
    this.details = details;
  }
}

export async function openReview({ receiptBytes, receiptPath = null, randomBytes = crypto.randomBytes }) {
  if (!receiptBytes) {
    throw new ReviewError("invalid_receipt", ["missing receipt bytes"]);
  }

  const text = new TextDecoder("utf-8").decode(receiptBytes);
  const validation = await validateReceipt(text);
  if (!validation.ok) {
    throw new ReviewError("invalid_receipt", validation.errors);
  }

  const receipt = validation.receipt ?? validation.parsed ?? JSON.parse(text);
  const reviewId = randomBytes(16).toString("hex");
  const bytesForDigest = new Uint8Array(receiptBytes.buffer, receiptBytes.byteOffset, receiptBytes.byteLength);
  const digest = await sha256Hex(bytesForDigest);

  return {
    reviewId,
    receiptDigest: digest,
    receipt,
    receiptPath,
  };
}

export function createVerifier({ openAgentPath, now = Date.now, limits = REVIEW_LIMITS }) {
  const maxBytesPerPass = limits?.maxBytesPerPass ?? REVIEW_LIMITS.maxBytesPerPass;
  const passDeadlineMs = limits?.passDeadlineMs ?? REVIEW_LIMITS.passDeadlineMs;
  const concurrentFiles = limits?.concurrentFiles ?? REVIEW_LIMITS.concurrentFiles;
  const queuedVerifications = limits?.queuedVerifications ?? REVIEW_LIMITS.queuedVerifications;
  const chunkBytes = limits?.chunkBytes ?? REVIEW_LIMITS.chunkBytes;
  const deadlineTickMs = limits?.deadlineTickMs ?? DEADLINE_TICK_MS;

  let isRunning = false;
  const queue = [];

  function queueSize() {
    return queue.length;
  }

  function processQueue() {
    if (queue.length === 0) {
      isRunning = false;
      return;
    }
    const item = queue.shift();
    runPass(item.files, item.opts)
      .then(item.resolve, item.reject)
      .finally(() => {
        processQueue();
      });
  }

  function verify(files, opts = {}) {
    if (!isRunning) {
      isRunning = true;
      return runPass(files, opts).finally(() => {
        processQueue();
      });
    }

    if (queue.length >= queuedVerifications) {
      return Promise.reject(new ReviewError("busy"));
    }

    return new Promise((resolve, reject) => {
      queue.push({ files, opts, resolve, reject });
    });
  }

  /** Closes a handle without waiting for it (a pending read would block an awaited close). */
  function closeDetached(handle) {
    try {
      const p = handle?.close?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }

  async function runPass(files, { baseline, signal } = {}) {
    const list = Array.isArray(files) ? files : [];
    const baselineResults = Array.isArray(baseline) ? baseline : (baseline?.results ?? []);
    const baselineMap = new Map();
    for (const r of baselineResults) {
      if (r && r.path) baselineMap.set(r.path, r);
    }

    const startTime = now();
    const deadline = startTime + passDeadlineMs;
    let totalBytesHashed = 0;
    let limitReached = false;
    let aborted = signal?.aborted ?? false;

    // One promise that settles when the pass is cancelled or runs out of time; every pending
    // open/read is raced against it so a stalled read cannot outlive the pass.
    let tripInterrupt;
    const interrupted = new Promise((resolve) => {
      tripInterrupt = resolve;
    });
    let interruptReason = null;
    const trip = (reason) => {
      if (interruptReason === null) {
        interruptReason = reason;
        tripInterrupt(reason);
      }
    };

    const onAbort = () => {
      aborted = true;
      trip("abort");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let timer = null;
    const armDeadlineTimer = () => {
      const wait = Math.max(1, Math.min(deadlineTickMs, deadline - now() + 1));
      timer = setTimeout(() => {
        if (now() > deadline) {
          limitReached = true;
          trip("deadline");
        } else {
          armDeadlineTimer();
        }
      }, wait);
      if (typeof timer?.unref === "function") timer.unref();
    };
    armDeadlineTimer();

    /** Turns a rejection into a value, and lets an interrupt win the race. */
    function raceInterrupt(promise) {
      return Promise.race([
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
        interrupted.then((reason) => ({ interrupt: reason })),
      ]);
    }

    const results = new Array(list.length);
    let nextIdx = 0;

    function resultFor(file, state, identity, baselineEntry, observedSha256 = null) {
      return {
        path: file.path,
        expectedSha256: file.sha256,
        observedSha256,
        state,
        identity,
        // The identity first seen when the review opened; "replaced" is judged against it.
        firstIdentity: baselineEntry?.firstIdentity ?? baselineEntry?.identity ?? identity ?? null,
      };
    }

    async function hashFile(file) {
      const baselineEntry = baselineMap.get(file.path);
      const make = (state, identity = null, observed = null) => resultFor(file, state, identity, baselineEntry, observed);
      const interruptedResult = (reason, identity = null) => make(reason === "abort" ? "unreadable" : "too_large", identity);

      if (aborted) return make("unreadable");

      if (limitReached || now() > deadline || totalBytesHashed >= maxBytesPerPass) {
        limitReached = true;
        return make("too_large");
      }

      const openPromise = Promise.resolve().then(() => openAgentPath(file.path));
      const opened = await raceInterrupt(openPromise);
      if (opened.interrupt) {
        // The open may still finish later; do not leak the handle it produces.
        openPromise.then((r) => r?.handle && closeDetached(r.handle), () => {});
        return interruptedResult(opened.interrupt);
      }
      if (opened.error) return make("unreadable");

      const openRes = opened.value;
      if (!openRes || !openRes.ok) {
        const code = openRes?.code;
        let state = "unreadable";
        if (code === "not_found") state = "missing";
        else if (code === "too_large") state = "too_large";
        return make(state);
      }

      const { handle, dev, ino } = openRes;
      const identity = (dev !== undefined && ino !== undefined && dev !== null && ino !== null)
        ? { dev: String(dev), ino: String(ino) }
        : null;

      let readPending = false;
      try {
        if (aborted) return make("unreadable", identity);

        const hash = crypto.createHash("sha256");
        const buffer = Buffer.alloc(chunkBytes);

        while (true) {
          if (aborted) return make("unreadable", identity);
          if (now() > deadline) {
            limitReached = true;
            return make("too_large", identity);
          }

          readPending = true;
          const read = await raceInterrupt(Promise.resolve().then(() => handle.read(buffer, 0, chunkBytes, null)));
          if (read.interrupt) return interruptedResult(read.interrupt, identity);
          readPending = false;
          if (read.error) return make("unreadable", identity);

          const bytesRead = read.value?.bytesRead ?? 0;
          if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > chunkBytes) {
            return make("unreadable", identity);
          }
          if (bytesRead === 0) {
            break;
          }

          if (totalBytesHashed + bytesRead > maxBytesPerPass) {
            limitReached = true;
            return make("too_large", identity);
          }

          totalBytesHashed += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));

          if (now() > deadline) {
            limitReached = true;
            return make("too_large", identity);
          }
        }

        // The deadline also covers the final read that reports end of file.
        if (aborted) return make("unreadable", identity);
        if (now() > deadline) {
          limitReached = true;
          return make("too_large", identity);
        }

        const observedSha256 = hash.digest("hex");

        const first = baselineEntry?.firstIdentity ?? baselineEntry?.identity ?? null;
        const isReplaced = Boolean(first && identity && (first.dev !== identity.dev || first.ino !== identity.ino));
        const state = isReplaced ? "replaced" : fileState(file.sha256, observedSha256);
        return make(state, identity, observedSha256);
      } catch {
        return make("unreadable", identity);
      } finally {
        if (readPending) {
          closeDetached(handle);
        } else {
          try {
            await handle.close();
          } catch {}
        }
      }
    }

    async function worker() {
      while (true) {
        if (aborted || limitReached) break;
        const idx = nextIdx++;
        if (idx >= list.length) break;
        try {
          results[idx] = await hashFile(list[idx]);
        } catch {
          results[idx] = resultFor(list[idx], "unreadable", null, baselineMap.get(list[idx].path));
        }
      }
    }

    try {
      const workerCount = Math.min(concurrentFiles, list.length);
      const workers = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }
      // Workers never reject; the pass (and so the queue) only advances once every one has settled.
      await Promise.allSettled(workers);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    for (let i = 0; i < list.length; i++) {
      if (!results[i]) {
        results[i] = resultFor(list[i], aborted ? "unreadable" : "too_large", null, baselineMap.get(list[i].path));
      }
    }

    return {
      results,
      verifiedAt: new Date(now()).toISOString(),
    };
  }

  return {
    verify,
    queueSize,
    limits: { maxBytesPerPass, passDeadlineMs, concurrentFiles, queuedVerifications, chunkBytes, deadlineTickMs },
  };
}

// Used by decide() when no store is supplied; with a store the claims live on the store.
const fallbackClaims = new Set();

export async function decide(args) {
  const { review, decision, comment = "", store } = args;
  if (!["approved", "changes_requested", "dismissed"].includes(decision)) {
    throw new ReviewError("bad_decision", `Invalid decision: ${decision}`);
  }

  const commentBytes = new TextEncoder().encode(comment ?? "").byteLength;
  if (commentBytes > 8192) {
    throw new ReviewError("bad_comment", "Comment exceeds 8 KiB");
  }

  // Synchronous claim: nothing awaits between the check and the add, so two concurrent calls for the
  // same review cannot both pass. It is released on any failure so the review can be retried.
  const claims = store?.claims ?? fallbackClaims;
  if (claims.has(review.reviewId)) {
    throw new ReviewError("already_decided", `Review ${review.reviewId} is already decided`);
  }
  claims.add(review.reviewId);

  // The claim is kept only while a record of the decision exists (store record or sidecar). A failed
  // verification, or a store write that failed so nothing was recorded, releases it for a retry.
  const outcome = { recorded: false };
  let keepClaim = false;
  try {
    const result = await decideClaimed({ ...args, outcome });
    keepClaim = result.ok === true && outcome.recorded;
    return result;
  } finally {
    if (!keepClaim) claims.delete(review.reviewId);
  }
}

async function decideClaimed({
  review,
  shown,
  decision,
  comment = "",
  verifier,
  store,
  writeNextToReceipt = true,
  now = Date.now,
  outcome = { recorded: false },
}) {
  const commentStr = comment ?? "";

  if (store && (await store.hasDecision(review.reviewId))) {
    throw new ReviewError("already_decided", `Review ${review.reviewId} is already decided`);
  }

  let current = null;
  let verifiedAt = shown?.verifiedAt ?? new Date(now()).toISOString();
  let filesSource = Array.isArray(shown) ? shown : (shown?.results ?? []);

  if (decision === "approved" || decision === "changes_requested") {
    current = await verifier.verify(review.receipt.files, { baseline: shown });
    const shownResults = Array.isArray(shown) ? shown : (shown?.results ?? []);
    const currentResults = current?.results ?? [];

    if (!canDecide(shownResults, currentResults)) {
      return {
        ok: false,
        code: "changed",
        current,
      };
    }
    verifiedAt = current.verifiedAt;
    filesSource = current.results;
  }

  const decidedAt = new Date(now()).toISOString();
  const files = filesSource.map((f) => ({
    path: f.path,
    expectedSha256: f.expectedSha256 ?? f.sha256,
    observedSha256: f.observedSha256 ?? null,
    state: f.state,
  }));

  const decisionObj = {
    uniview: "decision/1",
    reviewId: review.reviewId,
    receiptDigest: review.receiptDigest,
    decision,
    comment: commentStr,
    decidedAt,
    verifiedAt,
    persisted: false,
    files,
  };

  const validation = await validateDecision(decisionObj);
  if (!validation.ok) {
    throw new ReviewError("invalid_decision", validation.errors);
  }

  // 1. The store record (created exclusively) with persisted true.
  let storeOk = false;
  if (store) {
    decisionObj.persisted = true;
    try {
      await store.save(decisionObj);
      storeOk = true;
    } catch (err) {
      if (err?.code === "EEXIST") {
        throw new ReviewError("already_decided", `Review ${review.reviewId} is already decided`);
      }
      decisionObj.persisted = false;
    }
  }

  // 2. The sidecar, only after a successful store write. Its content is the returned decision.
  let nextOk = true;
  const wantsSidecar = review.receiptPath !== null && review.receiptPath !== undefined && writeNextToReceipt;
  if (wantsSidecar && (storeOk || !store)) {
    nextOk = await writeDecisionNextToReceipt(review.receiptPath, decisionObj, { fs: store?.fs });
  }
  // A record exists when the store holds it, or (without a store) the sidecar was written.
  outcome.recorded = storeOk || (!store && wantsSidecar && nextOk);

  // 3. Make the store copy agree with what is returned when the sidecar failed.
  if (storeOk && !nextOk) {
    decisionObj.persisted = false;
    try {
      await store.rewrite(decisionObj);
    } catch {}
  }

  decisionObj.persisted = Boolean(storeOk && nextOk);

  return {
    ok: true,
    decision: decisionObj,
  };
}
