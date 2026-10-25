import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// @ts-expect-error plain ESM module without types
import { writeDecisionNextToReceipt } from "../../electron/lib/review-store.mjs";

function getTempBaseDir(): string {
  if (process.platform === "win32") {
    return "I:\\AES\\tmp";
  }
  return os.tmpdir();
}

describe("review-store writeDecisionNextToReceipt exported helper without outcome", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(getTempBaseDir(), `exported-helper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDecision(overrides: Record<string, any> = {}) {
    const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    return {
      uniview: "decision/1",
      reviewId: "1234567890abcdef1234567890abcdef",
      receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision: "approved",
      comment: "good",
      decidedAt: "2026-10-25T10:00:00.000Z",
      verifiedAt: "2026-10-25T10:00:00.000Z",
      persisted: true,
      files: [{ path: path.join(testDir, "a.txt"), expectedSha256: SHA, observedSha256: SHA, state: "unchanged" }],
      ...overrides,
    };
  }

  // Mutation caught: skipping validation and equality checks when outcome is omitted,
  // accepting conflicting decisions just because reviewId matches.
  it("rejects conflicting existing sidecar with same reviewId when outcome is omitted", async () => {
    const receiptPath = path.join(testDir, "test.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetSidecar = `${receiptPath}.decision.json`;

    // Existing sidecar on disk has same reviewId, but conflicting decision ("changes_requested")
    const existingOnDisk = makeDecision({
      decision: "changes_requested",
      comment: "needs changes",
    });
    await fs.writeFile(targetSidecar, JSON.stringify(existingOnDisk, null, 2), "utf8");

    const candidate = makeDecision({
      decision: "approved",
      comment: "good",
    });

    // Call writeDecisionNextToReceipt WITHOUT outcome (default path)
    const result = await writeDecisionNextToReceipt(receiptPath, candidate, { fs });
    expect(result).toBe(false);

    // Existing file on disk remains untouched
    const onDiskRaw = await fs.readFile(targetSidecar, "utf8");
    const onDisk = JSON.parse(onDiskRaw);
    expect(onDisk.decision).toBe("changes_requested");
    expect(onDisk.comment).toBe("needs changes");
  });

  it("accepts identical existing sidecar when outcome is omitted", async () => {
    const receiptPath = path.join(testDir, "identical.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetSidecar = `${receiptPath}.decision.json`;

    const candidate = makeDecision();
    await fs.writeFile(targetSidecar, JSON.stringify(candidate, null, 2), "utf8");

    // Call writeDecisionNextToReceipt WITHOUT outcome
    const result = await writeDecisionNextToReceipt(receiptPath, candidate, { fs });
    expect(result).toBe(true);
  });
});
