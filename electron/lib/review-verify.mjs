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
// How long a file's handle close may take before the pass stops waiting for it. The handle's slot is
// still only freed when the close really settles (see liveHandles below).
const CLOSE_DEADLINE_MS = 2000;

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

/**
 * Identity quality.
 *
 * The (dev, ino) pair identifies a file only where the filesystem hands out stable, unique inode numbers.
 * Some volumes report ino 0 for every file, or numbers that change between opens. So:
 *  - "inode": ino is present, a positive integer, and the volume is not flagged unreliable. (dev, ino)
 *    decides replacement; a differing pair is always "replaced", an unstable ino on an unflagged volume
 *    is therefore blocked (fail closed: it cannot be told apart from a swap).
 *  - "fingerprint": ino is unusable (0, absent, non-finite) or the volume is flagged by `inoUnreliable`.
 *    Replacement is judged by fstat metadata taken from the same handle (size, mtimeMs, birthtimeMs) against
 *    the first-seen values. An unchanged file keeps its metadata, so it is not blocked; a different file
 *    almost always differs in mtime or birthtime. Identical metadata plus identical bytes is the best-effort
 *    limit of this fallback (a perfect forgery cannot be told apart); approval stays bound to the byte hash.
 *  - "none": neither is available. Nothing can be compared, so the file is never approvable
 *    (canDecide refuses, decide reports "identity_unavailable").
 */
function inoUsable(identity, inoUnreliable) {
  if (!identity) return false;
  const ino = String(identity.ino);
  if (!/^\d+$/.test(ino) || BigInt(ino) === 0n) return false;
  if (identity.dev === undefined || identity.dev === null) return false;
  return !inoUnreliable(identity.dev);
}

function fingerprintUsable(fp) {
  return Boolean(fp) && fp.size !== null && fp.size !== undefined && fp.mtimeMs !== null && fp.mtimeMs !== undefined;
}

/** size, mtime and birth time must all match; a birth time only counts when both sides have one. */
function fingerprintsDiffer(a, b) {
  if (String(a.size) !== String(b.size)) return true;
  if (String(a.mtimeMs) !== String(b.mtimeMs)) return true;
  if (a.birthtimeMs && b.birthtimeMs && String(a.birthtimeMs) !== String(b.birthtimeMs)) return true;
  return false;
}

function normalizeFingerprint(st) {
  if (!st) return null;
  const size = st.size;
  const mtime = st.mtimeMs;
  if (size === undefined || size === null || mtime === undefined || mtime === null) return null;
  const birth = st.birthtimeMs;
  return {
    size: String(size),
    mtimeMs: String(mtime),
    // 0 / absent means the filesystem does not record a creation time.
    birthtimeMs: birth === undefined || birth === null || Number(birth) === 0 ? null : String(birth),
  };
}

export function createVerifier({ openAgentPath, now = Date.now, limits = REVIEW_LIMITS, inoUnreliable = () => false }) {
  const maxBytesPerPass = limits?.maxBytesPerPass ?? REVIEW_LIMITS.maxBytesPerPass;
  const passDeadlineMs = limits?.passDeadlineMs ?? REVIEW_LIMITS.passDeadlineMs;
  const concurrentFiles = limits?.concurrentFiles ?? REVIEW_LIMITS.concurrentFiles;
  const queuedVerifications = limits?.queuedVerifications ?? REVIEW_LIMITS.queuedVerifications;
  const chunkBytes = limits?.chunkBytes ?? REVIEW_LIMITS.chunkBytes;
  const deadlineTickMs = limits?.deadlineTickMs ?? DEADLINE_TICK_MS;
  const closeDeadlineMs = limits?.closeDeadlineMs ?? CLOSE_DEADLINE_MS;

  let isRunning = false;
  const queue = [];

  // Open file handles, counted from the moment a slot is reserved until the handle's close has really
  // settled (also when it settles long after the pass stopped waiting). Never more than concurrentFiles,
  // across passes: a handle whose close hangs keeps its slot, so a later pass cannot pile more on top.
  let liveHandles = 0;
  const releaseSlot = () => {
    liveHandles = Math.max(0, liveHandles - 1);
  };

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

  /**
   * Closes a handle and waits for it, but never longer than closeDeadlineMs. The slot is released when the
   * close settles, however late; a close that never settles keeps its slot (and so bounds the live handles).
   */
  function closeBounded(handle) {
    let closePromise;
    try {
      closePromise = Promise.resolve(handle?.close?.());
    } catch (err) {
      closePromise = Promise.reject(err);
    }
    const settled = closePromise.then(
      () => {},
      () => {},
    ).then(() => {
      releaseSlot();
    });
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, closeDeadlineMs);
      if (typeof timer?.unref === "function") timer.unref();
    });
    return Promise.race([settled, bound]).finally(() => clearTimeout(timer));
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

    /** `info` is { identity, fingerprint, quality } for a file that was opened, else null. */
    function resultFor(file, state, info, baselineEntry, observedSha256 = null) {
      const identity = info?.identity ?? null;
      const fingerprint = info?.fingerprint ?? null;
      return {
        path: file.path,
        expectedSha256: file.sha256,
        observedSha256,
        state,
        identity,
        fingerprint,
        identityQuality: info?.quality ?? null,
        // The identity and metadata first seen when the review opened; "replaced" is judged against them.
        firstIdentity: baselineEntry?.firstIdentity ?? baselineEntry?.identity ?? identity ?? null,
        firstFingerprint: baselineEntry?.firstFingerprint ?? baselineEntry?.fingerprint ?? fingerprint ?? null,
      };
    }

    async function hashFile(file) {
      const baselineEntry = baselineMap.get(file.path);
      const make = (state, info = null, observed = null) => resultFor(file, state, info, baselineEntry, observed);
      const interruptedResult = (reason, info = null) => make(reason === "abort" ? "unreadable" : "too_large", info);

      if (aborted) return make("unreadable");

      if (limitReached || now() > deadline || totalBytesHashed >= maxBytesPerPass) {
        limitReached = true;
        return make("too_large");
      }

      // Reserve a handle slot before opening. If earlier handles are still not closed (their close is
      // hanging), no further file is opened: it is reported unreadable instead of exceeding the bound.
      if (liveHandles >= concurrentFiles) return make("unreadable");
      liveHandles++;

      const openPromise = Promise.resolve().then(() => openAgentPath(file.path));
      const opened = await raceInterrupt(openPromise);
      if (opened.interrupt) {
        // The open may still finish later; its handle is closed then and only then gives its slot back.
        openPromise.then(
          (r) => {
            if (r?.handle) void closeBounded(r.handle);
            else releaseSlot();
          },
          () => releaseSlot(),
        );
        return interruptedResult(opened.interrupt);
      }
      if (opened.error) {
        releaseSlot();
        return make("unreadable");
      }

      const openRes = opened.value;
      if (!openRes || !openRes.ok) {
        releaseSlot();
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
      let info = { identity, fingerprint: null, quality: "none" };

      /** Reads and hashes the opened handle. The handle is closed by the caller. */
      const readAndHash = async () => {
        if (aborted) return make("unreadable", info);

        // Metadata from the same handle (never from the path), used when the inode number is not usable.
        let fingerprint = null;
        if (typeof handle.stat === "function") {
          const st = await raceInterrupt(Promise.resolve().then(() => handle.stat({ bigint: true })));
          if (st.interrupt) return interruptedResult(st.interrupt, info);
          if (!st.error) fingerprint = normalizeFingerprint(st.value);
        }
        const inoOk = inoUsable(identity, inoUnreliable);
        const quality = inoOk ? "inode" : fingerprintUsable(fingerprint) ? "fingerprint" : "none";
        info = { identity, fingerprint, quality };

        const hash = crypto.createHash("sha256");
        const buffer = Buffer.alloc(chunkBytes);

        while (true) {
          if (aborted) return make("unreadable", info);
          if (now() > deadline) {
            limitReached = true;
            return make("too_large", info);
          }

          const read = await raceInterrupt(Promise.resolve().then(() => handle.read(buffer, 0, chunkBytes, null)));
          if (read.interrupt) return interruptedResult(read.interrupt, info);
          if (read.error) return make("unreadable", info);

          const bytesRead = read.value?.bytesRead ?? 0;
          if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > chunkBytes) {
            return make("unreadable", info);
          }
          if (bytesRead === 0) {
            break;
          }

          if (totalBytesHashed + bytesRead > maxBytesPerPass) {
            limitReached = true;
            return make("too_large", info);
          }

          totalBytesHashed += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));

          if (now() > deadline) {
            limitReached = true;
            return make("too_large", info);
          }
        }

        // The deadline also covers the final read that reports end of file.
        if (aborted) return make("unreadable", info);
        if (now() > deadline) {
          limitReached = true;
          return make("too_large", info);
        }

        const observedSha256 = hash.digest("hex");

        const first = baselineEntry?.firstIdentity ?? baselineEntry?.identity ?? null;
        const firstFp = baselineEntry?.firstFingerprint ?? baselineEntry?.fingerprint ?? null;
        let replaced = false;
        let metadataDiffers = false;
        if (inoOk && inoUsable(first, inoUnreliable)) {
          // Inode numbers are usable on both sides: a differing pair is a different file. The inode
          // number alone can be reused by a new file, so a differing creation time also counts.
          replaced = first.dev !== identity.dev || first.ino !== identity.ino;
          if (!replaced && fingerprintUsable(fingerprint) && fingerprintUsable(firstFp) && fingerprint.birthtimeMs && firstFp.birthtimeMs) {
            replaced = fingerprint.birthtimeMs !== firstFp.birthtimeMs;
          }
        } else if (fingerprintUsable(fingerprint) && fingerprintUsable(firstFp)) {
          metadataDiffers = fingerprintsDiffer(fingerprint, firstFp);
        }

        let state;
        if (replaced) {
          state = "replaced";
        } else {
          state = fileState(file.sha256, observedSha256);
          // Without a usable inode, different metadata with the expected bytes is a replacement; with other
          // bytes the file simply reads as changed.
          if (metadataDiffers && state === "unchanged") state = "replaced";
        }
        return make(state, info, observedSha256);
      };

      let result;
      try {
        result = await readAndHash();
      } catch {
        result = make("unreadable", info);
      } finally {
        // Closed right away (also while a read is still pending) and waited for, but only up to the close
        // deadline, so a hanging close cannot hold the pass or the queue.
        await closeBounded(handle);
      }

      // A pass cancelled, or out of time, while the file was closing does not report a clean result.
      if (result.observedSha256 !== null) {
        if (aborted) return make("unreadable", info);
        if (now() > deadline) {
          limitReached = true;
          return make("too_large", info);
        }
      }
      return result;
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
    liveHandles: () => liveHandles,
    limits: { maxBytesPerPass, passDeadlineMs, concurrentFiles, queuedVerifications, chunkBytes, deadlineTickMs, closeDeadlineMs },
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
      // A file whose identity cannot be established at all is a different problem from a changed file.
      const unavailable = currentResults.some((r) => r?.identityQuality === "none");
      return {
        ok: false,
        code: unavailable ? "identity_unavailable" : "changed",
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

  // 3. Make the store copy agree with what is returned when the sidecar failed. The three copies (returned
  //    decision, store record, sidecar) must never disagree on `persisted`.
  let note = null;
  let storeRecordRemoved = null;
  if (storeOk && !nextOk) {
    decisionObj.persisted = false;
    let corrected = false;
    for (let attempt = 0; attempt < 2 && !corrected; attempt++) {
      try {
        await store.rewrite(decisionObj);
        corrected = true;
      } catch {}
    }
    if (!corrected) {
      // The stored copy still claims persisted true and cannot be corrected: remove it (best effort) so it
      // cannot contradict what is returned. The claim stays (outcome.recorded) so this review is not decided
      // a second time in this process, and the result says the store was left inconsistent.
      note = "store_inconsistent";
      storeRecordRemoved = false;
      try {
        if (typeof store.remove === "function") {
          await store.remove(decisionObj.reviewId);
          storeRecordRemoved = true;
        }
      } catch {}
    }
  }

  decisionObj.persisted = Boolean(storeOk && nextOk);

  const result = {
    ok: true,
    decision: decisionObj,
  };
  if (note) {
    result.note = note;
    result.storeRecordRemoved = storeRecordRemoved;
  }
  return result;
}
