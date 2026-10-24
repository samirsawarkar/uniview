import crypto from "node:crypto";
// @ts-expect-error plain ESM module without types
import { validateReceipt, validateDecision, sha256Hex, fileState, canDecide } from "../../shared/receipt.mjs";
import { writeDecisionNextToReceipt } from "./review-store.mjs";

export const REVIEW_LIMITS = {
  maxBytesPerPass: 8 * 1024 * 1024 * 1024, // 8 GiB
  passDeadlineMs: 120_000,
  concurrentFiles: 2,
  queuedVerifications: 4,
  chunkBytes: 1024 * 1024, // 1 MiB
};

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

    if (signal) {
      signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
    }

    const results = new Array(list.length);
    let nextIdx = 0;

    async function hashFile(file) {
      const baselineEntry = baselineMap.get(file.path);

      if (aborted) {
        return {
          path: file.path,
          expectedSha256: file.sha256,
          observedSha256: null,
          state: "unreadable",
          identity: null,
        };
      }

      if (limitReached || now() > deadline || totalBytesHashed >= maxBytesPerPass) {
        limitReached = true;
        return {
          path: file.path,
          expectedSha256: file.sha256,
          observedSha256: null,
          state: "too_large",
          identity: null,
        };
      }

      let openRes;
      try {
        openRes = await openAgentPath(file.path);
      } catch {
        return {
          path: file.path,
          expectedSha256: file.sha256,
          observedSha256: null,
          state: "unreadable",
          identity: null,
        };
      }

      if (!openRes || !openRes.ok) {
        const code = openRes?.code;
        let state = "unreadable";
        if (code === "not_found") state = "missing";
        else if (code === "too_large") state = "too_large";
        return {
          path: file.path,
          expectedSha256: file.sha256,
          observedSha256: null,
          state,
          identity: null,
        };
      }

      const { handle, dev, ino } = openRes;
      const identity = (dev !== undefined && ino !== undefined && dev !== null && ino !== null)
        ? { dev: String(dev), ino: String(ino) }
        : null;

      try {
        if (aborted || signal?.aborted) {
          aborted = true;
          return {
            path: file.path,
            expectedSha256: file.sha256,
            observedSha256: null,
            state: "unreadable",
            identity,
          };
        }

        const hash = crypto.createHash("sha256");
        const buffer = Buffer.alloc(chunkBytes);

        while (true) {
          if (aborted || signal?.aborted) {
            aborted = true;
            return {
              path: file.path,
              expectedSha256: file.sha256,
              observedSha256: null,
              state: "unreadable",
              identity,
            };
          }

          if (now() > deadline) {
            limitReached = true;
            return {
              path: file.path,
              expectedSha256: file.sha256,
              observedSha256: null,
              state: "too_large",
              identity,
            };
          }

          const readResult = await handle.read(buffer, 0, chunkBytes, null);
          const bytesRead = readResult?.bytesRead ?? 0;
          if (bytesRead === 0) {
            break;
          }

          if (totalBytesHashed + bytesRead > maxBytesPerPass) {
            limitReached = true;
            return {
              path: file.path,
              expectedSha256: file.sha256,
              observedSha256: null,
              state: "too_large",
              identity,
            };
          }

          totalBytesHashed += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));

          if (now() > deadline) {
            limitReached = true;
            return {
              path: file.path,
              expectedSha256: file.sha256,
              observedSha256: null,
              state: "too_large",
              identity,
            };
          }
        }

        const observedSha256 = hash.digest("hex");

        let state;
        let isReplaced = false;
        if (baselineEntry?.identity && identity) {
          if (baselineEntry.identity.dev !== identity.dev || baselineEntry.identity.ino !== identity.ino) {
            isReplaced = true;
          }
        }

        if (isReplaced) {
          state = "replaced";
        } else {
          state = fileState(file.sha256, observedSha256);
        }

        return {
          path: file.path,
          expectedSha256: file.sha256,
          observedSha256,
          state,
          identity,
        };
      } finally {
        try {
          await handle.close();
        } catch {}
      }
    }

    async function worker() {
      while (true) {
        if (aborted || limitReached) break;
        const idx = nextIdx++;
        if (idx >= list.length) break;
        results[idx] = await hashFile(list[idx]);
      }
    }

    const workerCount = Math.min(concurrentFiles, list.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    for (let i = 0; i < list.length; i++) {
      if (!results[i]) {
        results[i] = {
          path: list[i].path,
          expectedSha256: list[i].sha256,
          observedSha256: null,
          state: aborted ? "unreadable" : "too_large",
          identity: null,
        };
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
  };
}

export async function decide({
  review,
  shown,
  decision,
  comment = "",
  verifier,
  store,
  writeNextToReceipt = true,
  now = Date.now,
}) {
  if (!["approved", "changes_requested", "dismissed"].includes(decision)) {
    throw new ReviewError("bad_decision", `Invalid decision: ${decision}`);
  }

  const commentStr = comment ?? "";
  const commentBytes = new TextEncoder().encode(commentStr).byteLength;
  if (commentBytes > 8192) {
    throw new ReviewError("bad_comment", "Comment exceeds 8 KiB");
  }

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

  let nextOk = true;
  if (review.receiptPath !== null && review.receiptPath !== undefined && writeNextToReceipt) {
    nextOk = await writeDecisionNextToReceipt(review.receiptPath, decisionObj, { fs: store?.fs });
  }

  let storeOk = false;
  if (store) {
    try {
      decisionObj.persisted = nextOk;
      await store.save(decisionObj);
      storeOk = true;
    } catch {
      storeOk = false;
    }
  }

  const persisted = Boolean(storeOk && nextOk);
  decisionObj.persisted = persisted;

  return {
    ok: true,
    decision: decisionObj,
  };
}
