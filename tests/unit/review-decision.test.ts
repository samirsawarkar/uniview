import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// @ts-expect-error plain ESM module without types
import { openReview, createVerifier, decide, ReviewError } from "../../electron/lib/review-verify.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore } from "../../electron/lib/review-store.mjs";
import { validateDecision } from "../../shared/receipt.mjs";
import { tmpBase } from "./helpers/tmp-base";

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

describe("review-decision", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `review-decide-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    storeDir = path.join(testDir, "store");
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(storeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  async function setupReview(fileContent: string) {
    const filePath = path.join(testDir, "file.txt");
    await fs.writeFile(filePath, Buffer.from(fileContent));
    const hash = crypto.createHash("sha256").update(Buffer.from(fileContent)).digest("hex");

    const receiptJson = JSON.stringify({
      uniview: "receipt/1",
      createdAt: new Date().toISOString(),
      agent: { name: "decide-agent" },
      task: "task description",
      summary: "summary description",
      files: [{ path: filePath, sha256: hash, role: "created" }],
    });

    const receiptBytes = Buffer.from(receiptJson, "utf8");
    const receiptPath = path.join(testDir, "receipt.json");
    await fs.writeFile(receiptPath, receiptBytes);

    const review = await openReview({ receiptBytes, receiptPath });
    const verifier = createVerifier({ openAgentPath: realOpenAgentPath });
    const store = createDecisionStore({ dir: storeDir, fs });
    return { review, verifier, store, filePath, originalHash: hash };
  }

  // Mutation caught: skipping click-time re-verification or allowing decision when file changed
  it("returns changed and persists nothing when a file was modified after viewing", async () => {
    const { review, verifier, store, filePath } = await setupReview("version 1");
    const shown = await verifier.verify(review.receipt.files);

    await fs.writeFile(filePath, Buffer.from("version 2 (changed)"));

    const result = await decide({
      review,
      shown,
      decision: "approved",
      verifier,
      store,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("changed");
    expect(result.current.results[0].state).toBe("changed");
    expect(await store.hasDecision(review.reviewId)).toBe(false);
  });

  // Mutation caught: ignoring missing state at click-time and deciding anyway
  it("returns changed and blocks decision when a file is deleted after viewing", async () => {
    const { review, verifier, store, filePath } = await setupReview("version 1");
    const shown = await verifier.verify(review.receipt.files);

    await fs.unlink(filePath);

    const result = await decide({
      review,
      shown,
      decision: "approved",
      verifier,
      store,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("changed");
    expect(result.current.results[0].state).toBe("missing");
    expect(await store.hasDecision(review.reviewId)).toBe(false);
  });

  // Mutation caught: failing to persist or validate decision object on identical state
  it("decides successfully with valid decision and persisted true when files are unchanged", async () => {
    const { review, verifier, store } = await setupReview("constant content");
    const shown = await verifier.verify(review.receipt.files);

    const result = await decide({
      review,
      shown,
      decision: "approved",
      comment: "All looks clean",
      verifier,
      store,
    });

    expect(result.ok).toBe(true);
    expect(result.decision.persisted).toBe(true);
    expect(result.decision.decision).toBe("approved");

    const val = await validateDecision(result.decision);
    expect(val.ok).toBe(true);
    expect(await store.hasDecision(review.reviewId)).toBe(true);
  });

  // Mutation caught: allowing multiple decisions on the same reviewId
  it("rejects second decision on the same review with already_decided", async () => {
    const { review, verifier, store } = await setupReview("constant content");
    const shown = await verifier.verify(review.receipt.files);

    const first = await decide({
      review,
      shown,
      decision: "approved",
      verifier,
      store,
    });
    expect(first.ok).toBe(true);

    await expect(
      decide({
        review,
        shown,
        decision: "changes_requested",
        verifier,
        store,
      })
    ).rejects.toMatchObject({ code: "already_decided" });
  });

  // Mutation caught: calling re-verification even when decision is dismissed
  it("decides dismissed without running click-time re-verification", async () => {
    const { review, verifier, store, filePath } = await setupReview("version 1");
    const shown = await verifier.verify(review.receipt.files);

    const verifySpy = vi.spyOn(verifier, "verify");
    await fs.writeFile(filePath, Buffer.from("modified after view"));

    const result = await decide({
      review,
      shown,
      decision: "dismissed",
      comment: "Cancelled by user",
      verifier,
      store,
    });

    expect(verifySpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.decision.decision).toBe("dismissed");
  });

  // Mutation caught: checking comment length in UTF-16 code units instead of UTF-8 byte count
  it("accepts comment of exactly 8 KiB and rejects comment exceeding 8 KiB in UTF-8 bytes", async () => {
    const { review, verifier, store } = await setupReview("content");
    const shown = await verifier.verify(review.receipt.files);

    const comment8KiB = "a".repeat(8192);
    const okResult = await decide({
      review,
      shown,
      decision: "approved",
      comment: comment8KiB,
      verifier,
      store,
    });
    expect(okResult.ok).toBe(true);

    // 8191 ASCII bytes + 3-byte unicode character (€) = 8194 bytes (> 8192 bytes)
    const tooLargeComment = "a".repeat(8191) + "€";
    const freshReview = { ...review, reviewId: "12345678901234567890123456789012" };

    await expect(
      decide({
        review: freshReview,
        shown,
        decision: "approved",
        comment: tooLargeComment,
        verifier,
        store,
      })
    ).rejects.toMatchObject({ code: "bad_comment" });
  });
});
