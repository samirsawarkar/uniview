import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// @ts-expect-error plain ESM module without types
import { openReview, createVerifier, REVIEW_LIMITS, ReviewError } from "../../electron/lib/review-verify.mjs";
import { sha256Hex } from "../../shared/receipt.mjs";

function getTempBaseDir(): string {
  if (process.platform === "win32") {
    return "I:\\AES\\tmp";
  }
  return os.tmpdir();
}

async function realOpenAgentPath(filePath: string) {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      return { ok: false, code: "unreadable" };
    }
    const handle = await fs.open(filePath, "r");
    return {
      ok: true,
      handle,
      canonical: filePath,
      size: stats.size,
      dev: stats.dev,
      ino: stats.ino,
    };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { ok: false, code: "not_found" };
    }
    return { ok: false, code: "unreadable" };
  }
}

describe("review-verify", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(getTempBaseDir(), `review-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // Mutation caught: returning incorrect state for matching hash
  it("verifies unchanged file when SHA-256 matches receipt", async () => {
    const filePath = path.join(testDir, "file1.txt");
    const content = Buffer.from("unchanged content");
    await fs.writeFile(filePath, content);
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    const verifier = createVerifier({ openAgentPath: realOpenAgentPath });
    const result = await verifier.verify([{ path: filePath, sha256: hash }]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].state).toBe("unchanged");
    expect(result.results[0].observedSha256).toBe(hash);
  });

  // Mutation caught: failing to observe new hash or returning unchanged when content was modified
  it("detects changed file when content is edited after receipt", async () => {
    const filePath = path.join(testDir, "file2.txt");
    await fs.writeFile(filePath, Buffer.from("original content"));
    const originalHash = crypto.createHash("sha256").update(Buffer.from("original content")).digest("hex");

    await fs.writeFile(filePath, Buffer.from("modified content"));
    const modifiedHash = crypto.createHash("sha256").update(Buffer.from("modified content")).digest("hex");

    const verifier = createVerifier({ openAgentPath: realOpenAgentPath });
    const result = await verifier.verify([{ path: filePath, sha256: originalHash }]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].state).toBe("changed");
    expect(result.results[0].observedSha256).toBe(modifiedHash);
  });

  // Mutation caught: mapping not_found to error instead of missing state
  it("marks missing file when target does not exist", async () => {
    const filePath = path.join(testDir, "missing.txt");
    const verifier = createVerifier({ openAgentPath: realOpenAgentPath });
    const result = await verifier.verify([{ path: filePath, sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].state).toBe("missing");
    expect(result.results[0].observedSha256).toBeNull();
  });

  // Mutation caught: handling directories as valid files or mapping unexpected errors incorrectly
  it("marks unreadable when path is a directory", async () => {
    const dirPath = path.join(testDir, "a-directory");
    await fs.mkdir(dirPath);

    const verifier = createVerifier({ openAgentPath: realOpenAgentPath });
    const result = await verifier.verify([{ path: dirPath, sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].state).toBe("unreadable");
    expect(result.results[0].observedSha256).toBeNull();
  });

  // Mutation caught: failing to enforce maxBytesPerPass limit and hash check
  it("marks too_large when file size exceeds maxBytesPerPass", async () => {
    const filePath = path.join(testDir, "large.txt");
    await fs.writeFile(filePath, Buffer.alloc(200, "x"));
    const expectedHash = crypto.createHash("sha256").update(Buffer.alloc(200, "x")).digest("hex");

    const verifier = createVerifier({
      openAgentPath: realOpenAgentPath,
      limits: { ...REVIEW_LIMITS, maxBytesPerPass: 50, chunkBytes: 20 },
    });
    const result = await verifier.verify([{ path: filePath, sha256: expectedHash }]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].state).toBe("too_large");
    expect(result.results[0].observedSha256).toBeNull();
  });

  // Mutation caught: ignoring baseline identity mismatch or not recording observed hash for replaced file
  it("marks replaced when file is replaced with a new file having different identity", async () => {
    const filePath = path.join(testDir, "replaced.txt");
    await fs.writeFile(filePath, Buffer.from("first version"));
    const hash1 = crypto.createHash("sha256").update(Buffer.from("first version")).digest("hex");

    const verifier = createVerifier({ openAgentPath: realOpenAgentPath });
    const baseline = await verifier.verify([{ path: filePath, sha256: hash1 }]);

    await fs.rename(filePath, `${filePath}.old`);
    await fs.writeFile(filePath, Buffer.from("second version"));
    const hash2 = crypto.createHash("sha256").update(Buffer.from("second version")).digest("hex");

    const secondPass = await verifier.verify([{ path: filePath, sha256: hash1 }], { baseline });

    expect(secondPass.results).toHaveLength(1);
    expect(secondPass.results[0].state).toBe("replaced");
    expect(secondPass.results[0].observedSha256).toBe(hash2);
    expect(secondPass.results[0].identity).not.toEqual(baseline.results[0].identity);
  });

  // Mutation caught: bypassing handle.read and opening the file directly with fs.open
  it("computes hash strictly through the handle returned by openAgentPath", async () => {
    const filePath = path.join(testDir, "handle-read.txt");
    const content = Buffer.from("strict handle read test");
    await fs.writeFile(filePath, content);
    const expectedHash = crypto.createHash("sha256").update(content).digest("hex");

    let readCalled = false;
    const customOpenAgentPath = async (p: string) => {
      const res = await realOpenAgentPath(p);
      if (!res.ok) return res;
      const originalRead = res.handle!.read.bind(res.handle!);
      res.handle!.read = async (...args: any[]) => {
        readCalled = true;
        return originalRead(...args);
      };
      return res;
    };

    const verifier = createVerifier({ openAgentPath: customOpenAgentPath });
    const result = await verifier.verify([{ path: filePath, sha256: expectedHash }]);

    expect(readCalled).toBe(true);
    expect(result.results[0].state).toBe("unchanged");
  });

  // Mutation caught: exceeding concurrency limit of 2 files hashed at once
  it("never exceeds concurrentFiles limit of 2", async () => {
    const files: Array<{ path: string; sha256: string }> = [];
    for (let i = 0; i < 6; i++) {
      const p = path.join(testDir, `conc-${i}.txt`);
      const c = Buffer.from(`content-${i}`);
      await fs.writeFile(p, c);
      files.push({ path: p, sha256: crypto.createHash("sha256").update(c).digest("hex") });
    }

    let activeReads = 0;
    let maxActiveReads = 0;

    const customOpenAgentPath = async (p: string) => {
      const res = await realOpenAgentPath(p);
      if (!res.ok) return res;
      const originalRead = res.handle!.read.bind(res.handle!);
      res.handle!.read = async (...args: any[]) => {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((r) => setTimeout(r, 10));
        activeReads--;
        return originalRead(...args);
      };
      return res;
    };

    const verifier = createVerifier({
      openAgentPath: customOpenAgentPath,
      limits: { ...REVIEW_LIMITS, concurrentFiles: 2 },
    });

    await verifier.verify(files);
    expect(maxActiveReads).toBeLessThanOrEqual(2);
  });

  // Mutation caught: ignoring deadline check mid-pass and continuing to hash remaining files
  it("marks remaining files too_large when fake now exceeds deadline", async () => {
    const files: Array<{ path: string; sha256: string }> = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(testDir, `deadline-${i}.txt`);
      await fs.writeFile(p, Buffer.from(`file-${i}`));
      files.push({ path: p, sha256: crypto.createHash("sha256").update(Buffer.from(`file-${i}`)).digest("hex") });
    }

    let simulatedTime = 10_000;
    const fakeNow = () => simulatedTime;

    const customOpenAgentPath = async (p: string) => {
      if (p.includes("deadline-1")) {
        simulatedTime += 130_000; // Jump past 120s deadline
      }
      return realOpenAgentPath(p);
    };

    const verifier = createVerifier({
      openAgentPath: customOpenAgentPath,
      now: fakeNow,
      limits: { ...REVIEW_LIMITS, passDeadlineMs: 120_000, concurrentFiles: 1 },
    });

    const result = await verifier.verify(files);
    expect(result.results[0].state).toBe("unchanged");
    expect(result.results[1].state).toBe("too_large");
    expect(result.results[2].state).toBe("too_large");
  });

  // Mutation caught: leaking handles or ignoring abort signal on cancel
  it("aborts via AbortController and marks remaining files unreadable while closing handles", async () => {
    const files: Array<{ path: string; sha256: string }> = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(testDir, `abort-${i}.txt`);
      await fs.writeFile(p, Buffer.from(`abort-content-${i}`));
      files.push({ path: p, sha256: crypto.createHash("sha256").update(Buffer.from(`abort-content-${i}`)).digest("hex") });
    }

    const abortController = new AbortController();
    let closedCount = 0;

    const customOpenAgentPath = async (p: string) => {
      const res = await realOpenAgentPath(p);
      if (!res.ok) return res;
      const originalClose = res.handle!.close.bind(res.handle!);
      res.handle!.close = async () => {
        closedCount++;
        return originalClose();
      };
      if (p.includes("abort-1")) {
        abortController.abort();
      }
      return res;
    };

    const verifier = createVerifier({
      openAgentPath: customOpenAgentPath,
      limits: { ...REVIEW_LIMITS, concurrentFiles: 1 },
    });

    const result = await verifier.verify(files, { signal: abortController.signal });
    expect(result.results.some((r: any) => r.state === "unreadable")).toBe(true);
    expect(closedCount).toBeGreaterThanOrEqual(1);
  });

  // Mutation caught: allowing queue to exceed queuedVerifications limit without rejecting busy
  it("rejects 5th queued verification with busy ReviewError", async () => {
    const p = path.join(testDir, "queue.txt");
    await fs.writeFile(p, Buffer.from("queue content"));
    const files = [{ path: p, sha256: crypto.createHash("sha256").update(Buffer.from("queue content")).digest("hex") }];

    // Only the first pass blocks; once released, the queued passes run straight through.
    let releasePass: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      releasePass = r;
    });
    const blockingOpenAgentPath = async (filePath: string) => {
      await gate;
      return realOpenAgentPath(filePath);
    };

    const verifier = createVerifier({
      openAgentPath: blockingOpenAgentPath,
      limits: { ...REVIEW_LIMITS, queuedVerifications: 4 },
    });

    // 1 active pass
    const p1 = verifier.verify(files);
    // 4 queued passes
    const p2 = verifier.verify(files);
    const p3 = verifier.verify(files);
    const p4 = verifier.verify(files);
    const p5 = verifier.verify(files);

    expect(verifier.queueSize()).toBe(4);

    // 5th queued call exceeds queue capacity
    await expect(verifier.verify(files)).rejects.toThrowError(ReviewError);
    await expect(verifier.verify(files)).rejects.toMatchObject({ code: "busy" });

    if (releasePass) (releasePass as () => void)();
    await Promise.all([p1, p2, p3, p4, p5]);
  });

  // Mutation caught: decoding receipt bytes before digest or normalizing CRLF
  it("computes exact receipt digest covering CRLF and non-ASCII bytes", async () => {
    const receiptText = JSON.stringify({
      uniview: "receipt/1",
      createdAt: "2026-10-24T12:00:00Z",
      agent: { name: "test-agent" },
      task: "CRLF and non-ASCII: café résumé \r\n",
      summary: "summary with \r\n and symbols: 🚀",
      files: [{ path: path.join(testDir, "any.txt"), sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", role: "created" }],
    });
    const receiptBytes = Buffer.from(receiptText, "utf8");

    const review = await openReview({ receiptBytes, receiptPath: path.join(testDir, "test.receipt.json") });
    const expectedDigest = await sha256Hex(receiptBytes);

    expect(review.receiptDigest).toBe(expectedDigest);
    expect(review.reviewId).toMatch(/^[0-9a-f]{32}$/);

    const review2 = await openReview({ receiptBytes });
    expect(review2.reviewId).not.toBe(review.reviewId);
  });

  // Mutation caught: accepting malformed receipt without invalid_receipt error
  it("rejects invalid receipt with invalid_receipt ReviewError", async () => {
    const invalidBytes = Buffer.from("{ invalid-json }", "utf8");
    await expect(openReview({ receiptBytes: invalidBytes })).rejects.toMatchObject({
      code: "invalid_receipt",
    });
  });
});
