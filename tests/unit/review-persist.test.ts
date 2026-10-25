import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// @ts-expect-error plain ESM module without types
import { createDecisionStore, writeDecisionNextToReceipt } from "../../electron/lib/review-store.mjs";
// @ts-expect-error plain ESM module without types
import { decide, createVerifier } from "../../electron/lib/review-verify.mjs";

import { tmpBase } from "./helpers/tmp-base";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("review-persist", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `review-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    storeDir = path.join(testDir, "store");
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(storeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDecision(reviewId = "0123456789abcdef0123456789abcdef", decidedAt = new Date().toISOString()) {
    return {
      uniview: "decision/1",
      reviewId,
      receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision: "approved",
      comment: "looks great",
      decidedAt,
      verifiedAt: decidedAt,
      persisted: true,
      files: [{ path: path.join(testDir, "f.txt"), expectedSha256: "abc", observedSha256: "abc", state: "unchanged" }],
    };
  }

  // Mutation caught: writing directly without atomic temp + rename or writing to wrong file path
  it("writes decision next to receipt via temp file and rename", async () => {
    const receiptPath = path.join(testDir, "sample.receipt.json");
    await fs.writeFile(receiptPath, "{}");

    const decision = makeDecision();
    const success = await writeDecisionNextToReceipt(receiptPath, decision, { fs });

    expect(success).toBe(true);
    const targetPath = `${receiptPath}.decision.json`;
    const targetContent = await fs.readFile(targetPath, "utf8");
    expect(JSON.parse(targetContent)).toEqual(decision);
  });

  // Mutation caught: overwriting an existing decision that belongs to a different reviewId
  it("refuses to write next to receipt if existing decision belongs to a different reviewId", async () => {
    const receiptPath = path.join(testDir, "other.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetPath = `${receiptPath}.decision.json`;

    const originalDecision = makeDecision("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await fs.writeFile(targetPath, JSON.stringify(originalDecision, null, 2));

    const newDecision = makeDecision("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const success = await writeDecisionNextToReceipt(receiptPath, newDecision, { fs });

    expect(success).toBe(false);
    const content = await fs.readFile(targetPath, "utf8");
    expect(JSON.parse(content).reviewId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  // Mutation caught: following symlinks instead of inspecting lstat.isSymbolicLink
  it("refuses to write next to receipt when target is a symbolic link", async () => {
    const receiptPath = path.join(testDir, "sym.receipt.json");
    await fs.writeFile(receiptPath, "{}");
    const targetPath = `${receiptPath}.decision.json`;
    const realFile = path.join(testDir, "real-decision.json");
    await fs.writeFile(realFile, JSON.stringify(makeDecision()));

    try {
      await fs.symlink(realFile, targetPath);
    } catch (err: any) {
      if (err.code === "EPERM") {
        return; // Windows unprivileged symlink restriction
      }
      throw err;
    }

    const decision = makeDecision();
    const success = await writeDecisionNextToReceipt(receiptPath, decision, { fs });
    expect(success).toBe(false);
  });

  // Mutation caught: unhandled store failure or reporting persisted true when the exclusive create throws
  it("sets persisted: false when the store record cannot be created", async () => {
    const store = createDecisionStore({ dir: storeDir, fs });
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("Disk link error"), { code: "EIO" }));

    const review = {
      reviewId: "11112222333344445555666677778888",
      receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      receipt: { files: [{ path: "C:\\gone\\a.txt", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] },
      receiptPath: null,
    };

    const result = await decide({
      review,
      shown: { results: [{ path: "C:\\gone\\a.txt", expectedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", observedSha256: null, state: "missing", identity: null }], verifiedAt: new Date().toISOString() },
      decision: "approved",
      store,
      // Approval always re-verifies; an empty file list verifies trivially.
      verifier: createVerifier({ openAgentPath: async () => ({ ok: false, code: "not_found" }) }),
    });

    expect(result.ok).toBe(true);
    expect(result.decision.persisted).toBe(false);
  });

  // Mutation caught: failing to prune oldest beyond max or failing to drop entries older than 30 days
  it("prunes oldest entries beyond max: 3 and drops entries older than 30 days", async () => {
    let fakeNow = 1_700_000_000_000;
    const store = createDecisionStore({
      dir: storeDir,
      fs,
      now: () => fakeNow,
      max: 3,
      ttlDays: 30,
    });

    const d1 = makeDecision("00000000000000000000000000000001", new Date(fakeNow).toISOString());
    await store.save(d1);
    fakeNow += 1000;

    const d2 = makeDecision("00000000000000000000000000000002", new Date(fakeNow).toISOString());
    await store.save(d2);
    fakeNow += 1000;

    const d3 = makeDecision("00000000000000000000000000000003", new Date(fakeNow).toISOString());
    await store.save(d3);
    fakeNow += 1000;

    const d4 = makeDecision("00000000000000000000000000000004", new Date(fakeNow).toISOString());
    await store.save(d4); // Max 3: d1 should be dropped

    expect(await store.load(d1.reviewId)).toBeNull();
    expect(await store.load(d2.reviewId)).not.toBeNull();
    expect(await store.load(d3.reviewId)).not.toBeNull();
    expect(await store.load(d4.reviewId)).not.toBeNull();

    // Advance 31 days past d2, d3, d4
    fakeNow += 31 * 24 * 60 * 60 * 1000;
    const d5 = makeDecision("00000000000000000000000000000005", new Date(fakeNow).toISOString());
    await store.save(d5);

    expect(await store.load(d2.reviewId)).toBeNull();
    expect(await store.load(d3.reviewId)).toBeNull();
    expect(await store.load(d4.reviewId)).toBeNull();
    expect(await store.load(d5.reviewId)).not.toBeNull();
  });

  // Mutation caught: attempting to write next to receipt when receiptPath is null
  it("does not attempt next-to-receipt write for inline receipt (receiptPath: null)", async () => {
    const store = createDecisionStore({ dir: storeDir, fs });
    const review = {
      reviewId: "99998888777766665555444433332222",
      receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      receipt: { files: [{ path: "C:\\gone\\a.txt", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] },
      receiptPath: null,
    };

    const result = await decide({
      review,
      shown: { results: [{ path: "C:\\gone\\a.txt", expectedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", observedSha256: null, state: "missing", identity: null }], verifiedAt: new Date().toISOString() },
      decision: "approved",
      store,
      // Approval always re-verifies; an empty file list verifies trivially.
      verifier: createVerifier({ openAgentPath: async () => ({ ok: false, code: "not_found" }) }),
    });

    expect(result.ok).toBe(true);
    expect(result.decision.persisted).toBe(true);
    const entries = await fs.readdir(testDir);
    expect(entries.some((e: string) => e.includes(".decision.json"))).toBe(false);
  });

  // Mutation caught: writing a decision over a symbolic link / junction (runs on every host via an injected fs).
  it("refuses a target that lstat reports as a symbolic link, without renaming", async () => {
    const receiptPath = path.join(testDir, "linked.receipt.json");
    const rename = vi.fn(async () => {});
    const decision = makeDecision();
    // The link "points at" a decision for the same review, so only the symlink check can refuse it.
    const fakeFs = {
      ...fs,
      lstat: async () => ({ isSymbolicLink: () => true, isFile: () => true }),
      readFile: async () => JSON.stringify(decision),
      rename,
    };
    const ok = await writeDecisionNextToReceipt(receiptPath, decision, { fs: fakeFs });
    expect(ok).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });
});
