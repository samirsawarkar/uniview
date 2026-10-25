import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// @ts-expect-error plain ESM module without types
import { writeDecisionNextToReceipt, isDecisionEqual } from "../../electron/lib/review-store.mjs";
import { tmpBase } from "./helpers/tmp-base";

describe("review-store writeDecisionNextToReceipt exported helper without outcome", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `exported-helper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  // Mutation caught: skipping unconditional schema validation while keeping equality checks
  // when outcome is omitted (accepting identical but schema-invalid sidecar files).
  it("rejects identical but schema-invalid existing sidecar when outcome is omitted", async () => {
    const receiptPath = path.join(testDir, "schema-invalid.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetSidecar = `${receiptPath}.decision.json`;

    // Existing sidecar and candidate are IDENTICAL, parseable JSON, but schema-INVALID (wrong decision value)
    const invalidDecision = makeDecision({
      decision: "invalid_decision_enum_value",
    });
    await fs.writeFile(targetSidecar, JSON.stringify(invalidDecision, null, 2), "utf8");

    // Call writeDecisionNextToReceipt WITHOUT outcome
    const result = await writeDecisionNextToReceipt(receiptPath, invalidDecision, { fs });
    expect(result).toBe(false);
  });

  // Mutation caught: comparing raw candidate object with canonicalJson without roundtripping
  // through JSON.parse(JSON.stringify(...)), causing undefined/function/symbol properties to falsely conflict.
  it("accepts candidate with undefined, function, or symbol properties matching serialized sidecar without outcome", async () => {
    const receiptPath = path.join(testDir, "serialized-equality.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetSidecar = `${receiptPath}.decision.json`;

    const baseDecision = makeDecision();
    await fs.writeFile(targetSidecar, JSON.stringify(baseDecision, null, 2), "utf8");

    // Candidate has extra properties that serialize away in JSON (undefined, function, symbol)
    const candidateWithExtras = {
      ...baseDecision,
      unused: undefined,
      extraHelper: () => "ignored",
      [Symbol("meta")]: "hidden",
    };

    // Must return true because serialized representation matches exactly
    const result = await writeDecisionNextToReceipt(receiptPath, candidateWithExtras, { fs });
    expect(result).toBe(true);
  });

  it("isDecisionEqual tests both directions for undefined/function/symbol properties and real field differences", () => {
    const base = makeDecision();
    const withExtras = {
      ...base,
      unused: undefined,
      fn: () => 123,
      [Symbol("test")]: "val",
    };

    // Both directions must consider withExtras and base equal (no false conflict)
    expect(isDecisionEqual(withExtras, base)).toBe(true);
    expect(isDecisionEqual(base, withExtras)).toBe(true);

    // Key order difference in both directions must be equal
    const keysReversed = Object.keys(base).reverse().reduce((acc: any, k) => {
      acc[k] = (base as any)[k];
      return acc;
    }, {});
    expect(isDecisionEqual(keysReversed, base)).toBe(true);
    expect(isDecisionEqual(base, keysReversed)).toBe(true);

    // Real field differences must conflict in both directions
    const withDiff = { ...base, comment: "different comment" };
    expect(isDecisionEqual(withDiff, base)).toBe(false);
    expect(isDecisionEqual(base, withDiff)).toBe(false);
  });
});
