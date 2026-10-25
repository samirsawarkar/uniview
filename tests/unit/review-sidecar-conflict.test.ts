import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// @ts-expect-error plain ESM module without types
import { createDecisionStore, writeDecisionNextToReceipt } from "../../electron/lib/review-store.mjs";
// @ts-expect-error plain ESM module without types
import { decide, createVerifier } from "../../electron/lib/review-verify.mjs";
import { tmpBase } from "./helpers/tmp-base";

describe("review-sidecar-conflict", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `sidecar-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    storeDir = path.join(testDir, "store");
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(storeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDecision(
    reviewId = "0123456789abcdef0123456789abcdef",
    decisionOutcome = "changes_requested",
    decidedAt = new Date().toISOString()
  ) {
    const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    return {
      uniview: "decision/1",
      reviewId,
      receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision: decisionOutcome,
      comment: "needs fixes",
      decidedAt,
      verifiedAt: decidedAt,
      persisted: true,
      files: [{ path: path.join(testDir, "f.txt"), expectedSha256: SHA, observedSha256: SHA, state: "unchanged" }],
    };
  }

  // Mutation caught: accepting an existing sidecar with conflicting decision outcome ('approved' vs 'changes_requested')
  // just because reviewId matches, reporting persisted: true and overwriting/inconsistently recording.
  it("planted approval repro: real decision changes_requested, sidecar conflict reports persisted: false, sidecar untouched, store consistent", async () => {
    const store = createDecisionStore({ dir: storeDir, fs });
    const receiptPath = path.join(testDir, "task.receipt.json");
    await fs.writeFile(receiptPath, JSON.stringify({ uniview: "receipt/1" }));

    const targetSidecar = `${receiptPath}.decision.json`;
    const reviewId = "11112222333344445555666677778888";
    const receiptDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const plantedApproval = {
      uniview: "decision/1",
      reviewId,
      receiptDigest,
      decision: "approved",
      comment: "planted approval",
      decidedAt: "2026-10-25T10:00:00.000Z",
      verifiedAt: "2026-10-25T10:00:00.000Z",
      persisted: true,
      files: [{ path: "C:\\test\\f.txt", expectedSha256: SHA, observedSha256: null, state: "missing" }],
    };
    await fs.writeFile(targetSidecar, JSON.stringify(plantedApproval, null, 2), "utf8");

    const review = {
      reviewId,
      receiptDigest,
      receipt: {
        uniview: "receipt/1",
        createdAt: "2026-10-25T10:00:00.000Z",
        agent: { name: "Agent" },
        task: "task",
        summary: "summary",
        files: [{ path: "C:\\test\\f.txt", sha256: SHA, role: "modified" }],
      },
      receiptPath,
    };

    const shown = {
      results: [{ path: "C:\\test\\f.txt", expectedSha256: SHA, observedSha256: null, state: "missing", identity: null }],
      verifiedAt: "2026-10-25T12:00:00.000Z",
    };

    const verifier = createVerifier({
      openAgentPath: async () => ({ ok: false, code: "not_found" }),
    });

    // Real human decision is changes_requested
    const result = await decide({
      review,
      shown,
      decision: "changes_requested",
      comment: "real decision is changes requested",
      store,
      verifier,
      writeNextToReceipt: true,
    });

    expect(result.ok).toBe(true);
    // Persisted MUST be false due to sidecar conflict
    expect(result.decision.persisted).toBe(false);
    expect(result.note).toBe("sidecar_conflict");

    // Sidecar on disk must remain UNTOUCHED (never overwritten or unlinked)
    const sidecarOnDisk = JSON.parse(await fs.readFile(targetSidecar, "utf8"));
    expect(sidecarOnDisk.decision).toBe("approved");
    expect(sidecarOnDisk.comment).toBe("planted approval");

    // Store record copy must agree with returned decision: persisted: false
    const storeCopy = await store.load(reviewId);
    expect(storeCopy).not.toBeNull();
    expect(storeCopy.persisted).toBe(false);
    expect(storeCopy.decision).toBe("changes_requested");
  });

  // Mutation caught: accepting sidecar with conflicting receiptDigest or corrupted content
  it("rejects existing sidecar with conflicting receiptDigest or invalid decision/1 schema", async () => {
    const receiptPath = path.join(testDir, "sample.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetPath = `${receiptPath}.decision.json`;

    const realDecision = makeDecision("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "approved");

    // Conflicting digest
    const conflictingDigest = {
      ...realDecision,
      receiptDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
    await fs.writeFile(targetPath, JSON.stringify(conflictingDigest, null, 2));

    const outcome1: { note?: string } = {};
    const ok1 = await writeDecisionNextToReceipt(receiptPath, realDecision, { fs, outcome: outcome1 });
    expect(ok1).toBe(false);
    expect(outcome1.note).toBe("sidecar_conflict");

    // Corrupted non-JSON
    await fs.writeFile(targetPath, "not valid json {{{");
    const outcome2: { note?: string } = {};
    const ok2 = await writeDecisionNextToReceipt(receiptPath, realDecision, { fs, outcome: outcome2 });
    expect(ok2).toBe(false);
    expect(outcome2.note).toBe("sidecar_conflict");
  });

  // Regression test: identical except persisted:false -> conflict (persisted:false result, note sidecar_conflict, file untouched)
  it("identical except persisted:false -> conflict (persisted:false result, note sidecar_conflict, file untouched)", async () => {
    const store = createDecisionStore({ dir: storeDir, fs });
    const receiptPath = path.join(testDir, "task-persisted-mismatch.receipt.json");
    await fs.writeFile(receiptPath, JSON.stringify({ uniview: "receipt/1" }));

    const targetSidecar = `${receiptPath}.decision.json`;
    const reviewId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const receiptDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SHA = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const fixedTime = "2026-10-25T12:00:00.000Z";

    const existingExceptPersistedFalse = {
      uniview: "decision/1",
      reviewId,
      receiptDigest,
      decision: "changes_requested",
      comment: "identical comment",
      decidedAt: fixedTime,
      verifiedAt: fixedTime,
      persisted: false,
      files: [{ path: "C:\\test\\f.txt", expectedSha256: SHA, observedSha256: null, state: "missing" }],
    };
    await fs.writeFile(targetSidecar, JSON.stringify(existingExceptPersistedFalse, null, 2), "utf8");

    const review = {
      reviewId,
      receiptDigest,
      receipt: {
        uniview: "receipt/1",
        createdAt: "2026-10-25T10:00:00.000Z",
        agent: { name: "Agent" },
        task: "task",
        summary: "summary",
        files: [{ path: "C:\\test\\f.txt", sha256: SHA, role: "modified" }],
      },
      receiptPath,
    };

    const shown = {
      results: [{ path: "C:\\test\\f.txt", expectedSha256: SHA, observedSha256: null, state: "missing", identity: null }],
      verifiedAt: fixedTime,
    };

    const fixedTimeMs = new Date(fixedTime).getTime();
    const verifier = createVerifier({
      openAgentPath: async () => ({ ok: false, code: "not_found" }),
      now: () => fixedTimeMs,
    });

    const result = await decide({
      review,
      shown,
      decision: "changes_requested",
      comment: "identical comment",
      store,
      verifier,
      writeNextToReceipt: true,
      now: () => new Date(fixedTime).getTime(),
    });

    expect(result.ok).toBe(true);
    // Persisted MUST be false due to sidecar conflict (persisted:false on disk vs candidate with persisted:true)
    expect(result.decision.persisted).toBe(false);
    expect(result.note).toBe("sidecar_conflict");

    // Sidecar on disk must remain UNTOUCHED (persisted still false)
    const sidecarOnDisk = JSON.parse(await fs.readFile(targetSidecar, "utf8"));
    expect(sidecarOnDisk.persisted).toBe(false);
    expect(sidecarOnDisk.comment).toBe("identical comment");

    // Store record copy must agree with returned decision: persisted: false
    const storeCopy = await store.load(reviewId);
    expect(storeCopy).not.toBeNull();
    expect(storeCopy.persisted).toBe(false);
  });

  // Mutation caught: comparing candidate directly against canonicalJson without JSON serialization roundtrip
  it("candidate with undefined/function/symbol properties matching serialized sidecar does not false-conflict; real difference conflicts", async () => {
    const receiptPath = path.join(testDir, "sidecar-undefined-check.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetPath = `${receiptPath}.decision.json`;

    const realDecision = makeDecision("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "approved");
    await fs.writeFile(targetPath, JSON.stringify(realDecision, null, 2), "utf8");

    // Candidate has unused: undefined and function/symbol properties
    const candidateWithExtras = {
      ...realDecision,
      unused: undefined,
      method: () => {},
      [Symbol("ignore")]: 42,
    };

    // Direction 1: candidate has extra undefined/functions/symbols vs clean on-disk sidecar -> matches
    const outcome1: { note?: string } = {};
    const ok1 = await writeDecisionNextToReceipt(receiptPath, candidateWithExtras, { fs, outcome: outcome1 });
    expect(ok1).toBe(true);
    expect(outcome1.note).toBeUndefined();

    // Direction 2: real difference (e.g. comment or decision) still conflicts
    const conflictingCandidate = {
      ...candidateWithExtras,
      comment: "different comment",
    };
    const outcome2: { note?: string } = {};
    const ok2 = await writeDecisionNextToReceipt(receiptPath, conflictingCandidate, { fs, outcome: outcome2 });
    expect(ok2).toBe(false);
    expect(outcome2.note).toBe("sidecar_conflict");
  });
});
