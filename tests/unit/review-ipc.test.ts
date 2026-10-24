import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// @ts-expect-error plain ESM module without types
import { createReviewIpcHandlers } from "../../electron/lib/review-ipc.mjs";
// @ts-expect-error plain ESM module without types
import { createVerifier } from "../../electron/lib/review-verify.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore } from "../../electron/lib/review-store.mjs";

function getTempBaseDir(): string {
  if (process.platform === "win32") {
    return "I:\\AES\\tmp";
  }
  return os.tmpdir();
}

async function mockOpenAgentPath(filePath: string) {
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

describe("review-ipc handlers", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(getTempBaseDir(), `review-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    storeDir = path.join(testDir, "store");
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(storeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  async function createFixture(fileContent = "file content") {
    const targetFile = path.join(testDir, "output.txt");
    await fs.writeFile(targetFile, Buffer.from(fileContent));
    const hash = crypto.createHash("sha256").update(Buffer.from(fileContent)).digest("hex");

    const receipt = {
      uniview: "receipt/1",
      createdAt: new Date().toISOString(),
      agent: { name: "test-agent" },
      task: "test receipt task",
      summary: "test summary",
      files: [{ path: targetFile, sha256: hash, role: "created" }],
    };

    const receiptJson = JSON.stringify(receipt);
    const receiptPath = path.join(testDir, "task.receipt.json");
    await fs.writeFile(receiptPath, receiptJson);

    const store = createDecisionStore({ dir: storeDir, fs });
    const verifier = createVerifier({ openAgentPath: mockOpenAgentPath });
    const handlers = createReviewIpcHandlers({
      store,
      verifier,
      openAgentPath: mockOpenAgentPath,
      fs,
    });

    return { handlers, receiptPath, receiptJson, targetFile, hash, store, verifier };
  }

  // Mutation caught: handleReviewOpen fails to return verification states or reviewId
  it("opens review receipt, verifies files, and returns initial state", async () => {
    const { handlers, receiptPath } = await createFixture();

    const result = await handlers.handleReviewOpen({ receiptPath });

    expect(result.ok).toBe(true);
    expect(result.reviewId).toBeDefined();
    expect(result.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files[0].state).toBe("unchanged");
  });

  // Mutation caught: handleReviewDecide does not validate 8 KiB comment limit
  it("enforces 8 KiB comment limit (8192 bytes OK, 8193 bytes rejected)", async () => {
    const { handlers, receiptPath } = await createFixture();
    const openRes = await handlers.handleReviewOpen({ receiptPath });
    expect(openRes.ok).toBe(true);

    const comment8KiB = "a".repeat(8192);
    const okRes = await handlers.handleReviewDecide({
      reviewId: openRes.reviewId,
      decision: "approved",
      comment: comment8KiB,
    });
    expect(okRes.ok).toBe(true);

    // Second review for limit + 1 test
    const { handlers: handlers2, receiptPath: receiptPath2 } = await createFixture();
    const openRes2 = await handlers2.handleReviewOpen({ receiptPath: receiptPath2 });
    expect(openRes2.ok).toBe(true);

    const commentOverLimit = "a".repeat(8193);
    const failRes = await handlers2.handleReviewDecide({
      reviewId: openRes2.reviewId,
      decision: "approved",
      comment: commentOverLimit,
    });
    expect(failRes.ok).toBe(false);
    expect(failRes.code).toBe("bad_comment");
  });

  // Mutation caught: handleReviewDecide skips click-time re-verification when file modified
  it("blocks decision and returns changed when a file is modified on disk", async () => {
    const { handlers, receiptPath, targetFile } = await createFixture("initial content");
    const openRes = await handlers.handleReviewOpen({ receiptPath });
    expect(openRes.ok).toBe(true);

    // Modify file on disk
    await fs.writeFile(targetFile, Buffer.from("changed content"));

    const decideRes = await handlers.handleReviewDecide({
      reviewId: openRes.reviewId,
      decision: "approved",
      comment: "Looks good",
    });

    expect(decideRes.ok).toBe(false);
    expect(decideRes.code).toBe("changed");
    expect(decideRes.message).toBe("A file changed since you looked — review again");
    expect(decideRes.current[0].state).toBe("changed");
  });

  // Mutation caught: handleReviewDismiss fails to record decision as dismissed
  it("records dismissed when review is dismissed before deciding", async () => {
    const { handlers, receiptPath, store } = await createFixture();
    const openRes = await handlers.handleReviewOpen({ receiptPath });
    expect(openRes.ok).toBe(true);

    const dismissRes = await handlers.handleReviewDismiss(openRes.reviewId);
    expect(dismissRes.ok).toBe(true);
    expect(dismissRes.dismissed).toBe(true);
    expect(dismissRes.decision.decision).toBe("dismissed");

    expect(await store.hasDecision(openRes.reviewId)).toBe(true);
  });

  // Mutation caught: handleReviewRefresh does not re-read files from disk
  it("refreshes verification states on handleReviewRefresh", async () => {
    const { handlers, receiptPath, targetFile } = await createFixture("initial content");
    const openRes = await handlers.handleReviewOpen({ receiptPath });
    expect(openRes.files[0].state).toBe("unchanged");

    await fs.writeFile(targetFile, Buffer.from("updated content"));

    const refreshRes = await handlers.handleReviewRefresh(openRes.reviewId);
    expect(refreshRes.ok).toBe(true);
    expect(refreshRes.files[0].state).toBe("changed");
  });
});
