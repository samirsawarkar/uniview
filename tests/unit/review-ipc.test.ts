import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

// @ts-expect-error plain ESM module without types
import { createReviewIpcHandlers, registerReviewIpc, installShutdownDismiss, REVIEW_IPC_LIMITS } from "../../electron/lib/review-ipc.mjs";
// @ts-expect-error plain ESM module without types
import { createVerifier } from "../../electron/lib/review-verify.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore } from "../../electron/lib/review-store.mjs";
// @ts-expect-error plain ESM module without types
import { GrantStore } from "../../electron/lib/core.mjs";
import { tmpBase } from "./helpers/tmp-base";

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

const MIB2 = 2 * 1024 * 1024;

describe("review-ipc handlers", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `review-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    storeDir = path.join(testDir, "store");
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(storeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function receiptFor(targetFile: string, hash: string) {
    return {
      uniview: "receipt/1",
      createdAt: new Date().toISOString(),
      agent: { name: "test-agent" },
      task: "test receipt task",
      summary: "test summary",
      files: [{ path: targetFile, sha256: hash, role: "created" }],
    };
  }

  async function createFixture(
    fileContent = "file content",
    opts: { now?: () => number; verifier?: any } = {}
  ) {
    const targetFile = path.join(testDir, "output.txt");
    await fs.writeFile(targetFile, Buffer.from(fileContent));
    const hash = crypto.createHash("sha256").update(Buffer.from(fileContent)).digest("hex");

    const receiptJson = JSON.stringify(receiptFor(targetFile, hash));
    const receiptPath = path.join(testDir, "task.receipt.json");
    await fs.writeFile(receiptPath, receiptJson);

    const grants = new GrantStore();
    const receiptToken = grants.grant(receiptPath, receiptJson.length);

    const store = createDecisionStore({ dir: storeDir, fs });
    const verifier = opts.verifier ?? createVerifier({ openAgentPath: mockOpenAgentPath });
    const handlers = createReviewIpcHandlers({
      store,
      verifier,
      openAgentPath: mockOpenAgentPath,
      fs,
      resolveGrant: (t: string) => grants.get(t),
      ...(opts.now ? { now: opts.now } : {}),
    });

    return { handlers, grants, receiptToken, receiptPath, receiptJson, targetFile, hash, store, verifier };
  }

  // Mutation caught: handleReviewOpen fails to return verification states or reviewId
  it("opens review receipt by grant token, verifies files, and returns initial state", async () => {
    const { handlers, receiptToken } = await createFixture();

    const result = await handlers.handleReviewOpen({ receiptToken });

    expect(result.ok).toBe(true);
    expect(result.reviewId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files[0].state).toBe("unchanged");
    // The renderer already knows its own file; main does not hand paths back.
    expect(result.receiptPath).toBeUndefined();
  });

  // Mutation caught: handleReviewDecide does not validate 8 KiB comment limit
  it("enforces 8 KiB comment limit (8192 bytes OK, 8193 bytes rejected)", async () => {
    const { handlers, receiptToken } = await createFixture();
    const openRes = await handlers.handleReviewOpen({ receiptToken });
    expect(openRes.ok).toBe(true);

    const okRes = await handlers.handleReviewDecide({
      reviewId: openRes.reviewId,
      decision: "approved",
      comment: "a".repeat(8192),
    });
    expect(okRes.ok).toBe(true);

    // Second review for limit + 1 test
    const { handlers: handlers2, receiptToken: token2 } = await createFixture();
    const openRes2 = await handlers2.handleReviewOpen({ receiptToken: token2 });
    expect(openRes2.ok).toBe(true);

    const failRes = await handlers2.handleReviewDecide({
      reviewId: openRes2.reviewId,
      decision: "approved",
      comment: "a".repeat(8193),
    });
    expect(failRes.ok).toBe(false);
    expect(failRes.code).toBe("bad_comment");

    // Multi-byte: 4097 two-byte characters are 8194 bytes although only 4097 characters long.
    const multi = await handlers2.handleReviewDecide({
      reviewId: openRes2.reviewId,
      decision: "approved",
      comment: "é".repeat(4097),
    });
    expect(multi.ok).toBe(false);
    expect(multi.code).toBe("bad_comment");
  });

  // Mutation caught: handleReviewDecide skips click-time re-verification when file modified
  it("blocks decision and returns changed when a file is modified on disk", async () => {
    const { handlers, receiptToken, targetFile } = await createFixture("initial content");
    const openRes = await handlers.handleReviewOpen({ receiptToken });
    expect(openRes.ok).toBe(true);

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
    const { handlers, receiptToken, store } = await createFixture();
    const openRes = await handlers.handleReviewOpen({ receiptToken });
    expect(openRes.ok).toBe(true);

    const dismissRes = await handlers.handleReviewDismiss(openRes.reviewId);
    expect(dismissRes.ok).toBe(true);
    expect(dismissRes.dismissed).toBe(true);
    expect(dismissRes.decision.decision).toBe("dismissed");

    expect(await store.hasDecision(openRes.reviewId)).toBe(true);
  });

  // Mutation caught: handleReviewRefresh does not re-read files from disk
  it("refreshes verification states on handleReviewRefresh", async () => {
    const { handlers, receiptToken, targetFile } = await createFixture("initial content");
    const openRes = await handlers.handleReviewOpen({ receiptToken });
    expect(openRes.files[0].state).toBe("unchanged");

    await fs.writeFile(targetFile, Buffer.from("updated content"));

    const refreshRes = await handlers.handleReviewRefresh(openRes.reviewId);
    expect(refreshRes.ok).toBe(true);
    expect(refreshRes.files[0].state).toBe("changed");
  });

  describe("F4: main trusts only grants, never renderer paths", () => {
    // Mutation caught: handleReviewOpen reads args.receiptPath again
    it("never reads a renderer-supplied receiptPath (read oracle) and does not echo it", async () => {
      const { handlers } = await createFixture();
      const secret = path.join(testDir, "secret.txt");
      await fs.writeFile(secret, "TOP-SECRET-CONTENT");

      for (const args of [
        { receiptPath: secret },
        { receiptPath: path.join(testDir, "does-not-exist.json") },
        { receiptPath: secret, receiptToken: "0".repeat(32) },
      ]) {
        const res = await handlers.handleReviewOpen(args);
        expect(res.ok).toBe(false);
        const text = JSON.stringify(res);
        expect(text).not.toContain("TOP-SECRET");
        expect(text).not.toContain(testDir);
        expect(text).not.toContain("does-not-exist");
      }
    });

    // Mutation caught: inline bytes plus a renderer path write <path>.decision.json at a renderer-chosen place
    it("never writes a sidecar at a renderer-chosen place, even with inline bytes", async () => {
      const { handlers, receiptJson } = await createFixture();
      const victim = path.join(testDir, "victim.txt");
      await fs.writeFile(victim, "x");

      const res = await handlers.handleReviewOpen({
        receiptBytes: new TextEncoder().encode(receiptJson),
        receiptPath: victim,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("bad_args");

      const names = await fs.readdir(testDir);
      expect(names.filter((n) => n.endsWith(".decision.json"))).toEqual([]);
    });

    // Mutation caught: inline receipts write beside something
    it("inline receipts are decided without writing any sidecar", async () => {
      const { handlers, receiptJson, store } = await createFixture();
      const open = await handlers.handleReviewOpen({ receiptBytes: new TextEncoder().encode(receiptJson) });
      expect(open.ok).toBe(true);
      const dec = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      expect(dec.ok).toBe(true);
      expect(await store.hasDecision(open.reviewId)).toBe(true);
      const names = await fs.readdir(testDir);
      expect(names.filter((n) => n.endsWith(".decision.json"))).toEqual([]);
    });

    // Mutation caught: sidecar location not derived from the granted receipt path
    it("a token-opened receipt writes its sidecar beside the granted file only", async () => {
      const { handlers, receiptToken, receiptPath } = await createFixture();
      const open = await handlers.handleReviewOpen({ receiptToken });
      const dec = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "changes_requested", comment: "no" });
      expect(dec.ok).toBe(true);
      expect(dec.decision.persisted).toBe(true);
      const names = (await fs.readdir(testDir)).filter((n) => n.endsWith(".decision.json"));
      expect(names).toEqual([path.basename(receiptPath) + ".decision.json"]);
    });

    // Mutation caught: error text echoes file content or full paths
    it("returns generic errors without file content or paths for a non-receipt, missing or directory grant", async () => {
      const { handlers, grants } = await createFixture();
      // Mixed case and non-.receipt.json extensions
      const badExt = path.join(testDir, "bad.receipt.json.txt");
      await fs.writeFile(badExt, "{}");
      const badExtToken = grants.grant(badExt, 2);

      const notReceipt = path.join(testDir, "notes.receipt.json");
      await fs.writeFile(notReceipt, '{"password":"TOP-SECRET-CONTENT"');
      const gone = path.join(testDir, "gone.receipt.json");
      await fs.writeFile(gone, "{}");
      const goneToken = grants.grant(gone, 2);
      await fs.rm(gone);
      const dir = path.join(testDir, "adir.receipt.json");
      await fs.mkdir(dir);

      const cases = [
        { token: grants.grant(notReceipt, 10), code: "invalid_receipt" },
        { token: badExtToken, code: "bad_args" },
        { token: goneToken, code: "unreadable" },
        { token: grants.grant(dir, 0), code: "unreadable" },
        { token: "f".repeat(32), code: "not_granted" },
      ];
      for (const c of cases) {
        const res = await handlers.handleReviewOpen({ receiptToken: c.token });
        expect(res.ok).toBe(false);
        expect(res.code).toBe(c.code);
        const text = JSON.stringify(res);
        expect(text).not.toContain("TOP-SECRET");
        expect(text).not.toContain("password");
        expect(text).not.toContain(testDir);
        expect(text).not.toMatch(/ENOENT|EISDIR|EACCES/);
      }
    });

    // Mutation caught: ReviewError.message (which embeds validation details) forwarded to renderer
    it("reports field-level validation errors as code/path only, with generic text", async () => {
      const { handlers, grants } = await createFixture();
      const bad = path.join(testDir, "bad.receipt.json");
      await fs.writeFile(
        bad,
        JSON.stringify({ uniview: "receipt/1", createdAt: "x", agent: { name: "a" }, task: "t", summary: "s", files: [{ path: "relative/TOP-SECRET", sha256: "zz", role: "created" }] })
      );
      const res = await handlers.handleReviewOpen({ receiptToken: grants.grant(bad, 10) });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("invalid_receipt");
      expect(Array.isArray(res.errors)).toBe(true);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors.length).toBeLessThanOrEqual(20);
      for (const e of res.errors) {
        expect(typeof e.code).toBe("string");
        expect(typeof e.path).toBe("string");
        expect(typeof e.message).toBe("string");
        expect(e.message.length).toBeLessThan(120);
      }
      expect(JSON.stringify(res)).not.toContain("TOP-SECRET");
      expect(JSON.stringify(res)).not.toContain(testDir);
    });

    // Limit and limit + 1 for the receipt read (2 MiB)
    it("reads a granted receipt of exactly 2 MiB but refuses 2 MiB + 1 without reading it", async () => {
      const { handlers, grants, receiptJson } = await createFixture();
      const atLimit = path.join(testDir, "at.receipt.json");
      await fs.writeFile(atLimit, receiptJson + " ".repeat(MIB2 - Buffer.byteLength(receiptJson)));
      expect((await fs.stat(atLimit)).size).toBe(MIB2);
      const ok = await handlers.handleReviewOpen({ receiptToken: grants.grant(atLimit, MIB2) });
      expect(ok.ok).toBe(true);

      const over = path.join(testDir, "over.receipt.json");
      await fs.writeFile(over, receiptJson + " ".repeat(MIB2 + 1 - Buffer.byteLength(receiptJson)));
      const res = await handlers.handleReviewOpen({ receiptToken: grants.grant(over, MIB2 + 1) });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("too_large");
    });

    it("accepts inline bytes of exactly 2 MiB", async () => {
      const { handlers, receiptJson } = await createFixture();
      const padded = new TextEncoder().encode(receiptJson + " ".repeat(MIB2 - Buffer.byteLength(receiptJson)));
      expect(padded.byteLength).toBe(MIB2);
      const res = await handlers.handleReviewOpen({ receiptBytes: padded });
      expect(res.ok).toBe(true);
    });

    it("refuses inline bytes of 2 MiB + 1", async () => {
      const { handlers } = await createFixture();
      const res = await handlers.handleReviewOpen({ receiptBytes: new Uint8Array(MIB2 + 1) });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("too_large");
    });

    // The file may grow between the size check and the read; the read itself is capped.
    it("caps the read even when the file grew after the size check", async () => {
      const { grants, receiptJson } = await createFixture();
      const grown = path.join(testDir, "grown.receipt.json");
      await fs.writeFile(grown, receiptJson + " ".repeat(MIB2 + 10));
      // Report a small size at the check, then serve the real (oversized) bytes.
      const lyingFs: any = {
        ...fs,
        open: async (p: string, flags: string) => {
          const fh = await fs.open(p, flags);
          return {
            stat: async () => ({ isFile: () => true, size: 10 }),
            read: (...a: any[]) => (fh.read as any)(...a),
            close: () => fh.close(),
          };
        },
      };
      const handlers = createReviewIpcHandlers({
        store: createDecisionStore({ dir: storeDir, fs }),
        verifier: createVerifier({ openAgentPath: mockOpenAgentPath }),
        fs: lyingFs,
        resolveGrant: (t: string) => grants.get(t),
      });
      const res = await handlers.handleReviewOpen({ receiptToken: grants.grant(grown, 10) });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("too_large");
    });

    // Mutation caught: handlers fall back to a default resolver that trusts any string
    it("refuses every token when no grant resolver is configured", async () => {
      const handlers = createReviewIpcHandlers({ store: createDecisionStore({ dir: storeDir, fs }), verifier: createVerifier({ openAgentPath: mockOpenAgentPath }), fs });
      const res = await handlers.handleReviewOpen({ receiptToken: "a".repeat(32) });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("not_granted");
    });

    // Mutation caught: review:open accepts granted file not ending in .receipt.json or case-sensitive check fails
    it("review:open accepts only files ending in .receipt.json (case-insensitive)", async () => {
      const { handlers, grants, targetFile, hash } = await createFixture();

      // Mixed case .RECEIPT.JSON accepted
      const mixed1 = path.join(testDir, "mixed1.RECEIPT.JSON");
      await fs.writeFile(mixed1, JSON.stringify(receiptFor(targetFile, hash)));
      const res1 = await handlers.handleReviewOpen({ receiptToken: grants.grant(mixed1, 100) });
      expect(res1.ok).toBe(true);

      // Mixed case .Receipt.Json accepted
      const mixed2 = path.join(testDir, "mixed2.Receipt.Json");
      await fs.writeFile(mixed2, JSON.stringify(receiptFor(targetFile, hash)));
      const res2 = await handlers.handleReviewOpen({ receiptToken: grants.grant(mixed2, 100) });
      expect(res2.ok).toBe(true);

      // Trailing extension x.receipt.json.txt rejected
      const txt = path.join(testDir, "x.receipt.json.txt");
      await fs.writeFile(txt, JSON.stringify(receiptFor(targetFile, hash)));
      const resTxt = await handlers.handleReviewOpen({ receiptToken: grants.grant(txt, 100) });
      expect(resTxt.ok).toBe(false);
      expect(["bad_args", "not_receipt"]).toContain(resTxt.code);

      // Plain .json rejected
      const plainJson = path.join(testDir, "task.json");
      await fs.writeFile(plainJson, JSON.stringify(receiptFor(targetFile, hash)));
      const resPlain = await handlers.handleReviewOpen({ receiptToken: grants.grant(plainJson, 100) });
      expect(resPlain.ok).toBe(false);
      expect(["bad_args", "not_receipt"]).toContain(resPlain.code);
    });

    // Mutation caught: handleReviewDecide does not report sidecarConflict when sidecar from earlier review exists
    it("reports sidecarConflict when sidecar from earlier review already exists next to receipt", async () => {
      const { handlers, receiptToken, receiptPath } = await createFixture();
      // Pre-create the sidecar belonging to another review
      const sidecarPath = `${receiptPath}.decision.json`;
      await fs.writeFile(
        sidecarPath,
        JSON.stringify({
          uniview: "decision/1",
          reviewId: "0".repeat(32),
          receiptDigest: "a".repeat(64),
          decision: "approved",
          comment: "",
          decidedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          persisted: true,
          files: [],
        })
      );

      const open = await handlers.handleReviewOpen({ receiptToken });
      expect(open.ok).toBe(true);

      const dec = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      expect(dec.ok).toBe(true);
      expect(dec.decision.persisted).toBe(false);
      expect(dec.sidecarConflict).toBe(true);
    });
  });

  describe("F5: argument validation", () => {
    const junk: unknown[] = [undefined, null, 0, 1, "", "x", true, [], ["a"], {}, { reviewId: null }, { reviewId: {} }, { reviewId: 5 }, { reviewId: ["a"] }, { reviewId: "x".repeat(100000) }, () => 1, Symbol.iterator];

    // Mutation caught: a handler dereferences args without checking its type
    it.each(junk.map((j, i) => [i, j] as const))("decide rejects junk #%i without throwing", async (_i, arg) => {
      const { handlers } = await createFixture();
      const res = await handlers.handleReviewDecide(arg);
      expect(res.ok).toBe(false);
      expect(typeof res.code).toBe("string");
    });

    it.each(junk.map((j, i) => [i, j] as const))("dismiss and refresh reject junk #%i without throwing", async (_i, arg) => {
      const { handlers } = await createFixture();
      for (const fn of [handlers.handleReviewDismiss, handlers.handleReviewRefresh]) {
        const res = await fn(arg);
        expect(res.ok).toBe(false);
        expect(typeof res.code).toBe("string");
      }
    });

    it.each(junk.map((j, i) => [i, j] as const))("open rejects junk #%i without throwing", async (_i, arg) => {
      const { handlers } = await createFixture();
      const res = await handlers.handleReviewOpen(arg);
      expect(res.ok).toBe(false);
      expect(typeof res.code).toBe("string");
    });

    it("open rejects wrongly typed token and bytes", async () => {
      const { handlers } = await createFixture();
      for (const args of [
        { receiptToken: 5 },
        { receiptToken: {} },
        { receiptToken: ["a"] },
        { receiptToken: "a".repeat(100000) },
        { receiptBytes: "a string" },
        { receiptBytes: 5 },
        { receiptBytes: {} },
        { receiptBytes: [1, 2, 3] },
        { receiptToken: "a".repeat(32), receiptBytes: new Uint8Array(1) },
        { receiptToken: "a".repeat(32), extra: 1 },
      ]) {
        const res = await handlers.handleReviewOpen(args);
        expect(res.ok).toBe(false);
        expect(["bad_args", "not_granted"]).toContain(res.code);
      }
    });

    it("decide rejects a wrongly typed decision or comment and does not echo the reviewId", async () => {
      const { handlers, receiptToken } = await createFixture();
      const open = await handlers.handleReviewOpen({ receiptToken });
      for (const args of [
        { reviewId: open.reviewId, decision: {} },
        { reviewId: open.reviewId, decision: "dismissed" },
        { reviewId: open.reviewId, decision: ["approved"] },
        { reviewId: open.reviewId, decision: "approved", comment: 5 },
        { reviewId: open.reviewId, decision: "approved", comment: {} },
        { reviewId: open.reviewId, decision: "approved", comment: ["x"] },
      ]) {
        const res = await handlers.handleReviewDecide(args);
        expect(res.ok).toBe(false);
        expect(["bad_args", "bad_decision", "bad_comment"]).toContain(res.code);
      }
      const hostile = "<img src=x onerror=alert(1)>".padEnd(32, "a");
      const res = await handlers.handleReviewDecide({ reviewId: hostile, decision: "approved" });
      expect(JSON.stringify(res)).not.toContain("onerror");
      // Still undecided after all the rejected calls.
      const ok = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      expect(ok.ok).toBe(true);
    });

    it("a huge comment is rejected by length before it is encoded", async () => {
      const { handlers, receiptToken } = await createFixture();
      const open = await handlers.handleReviewOpen({ receiptToken });
      const res = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved", comment: "a".repeat(50 * 1024 * 1024) });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("bad_comment");
    });
  });

  describe("F5: registration is fail-closed", () => {
    function fakeIpc() {
      const handlers = new Map<string, (...a: any[]) => any>();
      return { handlers, ipcMain: { handle: (ch: string, fn: any) => void handlers.set(ch, fn) } };
    }

    // Mutation caught: registration silently skips the sender check when fromApp is missing
    it("throws at registration when fromApp is omitted or not a function, and registers nothing", async () => {
      for (const fromApp of [undefined, null, true, "yes", {}]) {
        const { handlers, ipcMain } = fakeIpc();
        await expect(registerReviewIpc({ ipcMain, fromApp, userDataPath: storeDir })).rejects.toThrow(/fromApp/);
        expect(handlers.size).toBe(0);
      }
      const { handlers, ipcMain } = fakeIpc();
      await expect(registerReviewIpc({ ipcMain, userDataPath: storeDir })).rejects.toThrow(/fromApp/);
      expect(handlers.size).toBe(0);
    });

    // Mutation caught: guard does not call fromApp or ignores its answer
    it("refuses a sender that fromApp rejects and passes one it accepts", async () => {
      const { handlers, ipcMain } = fakeIpc();
      const { receiptToken, grants } = await createFixture();
      let allowed = false;
      await registerReviewIpc({ ipcMain, fromApp: () => allowed, userDataPath: storeDir, grants });
      expect([...handlers.keys()].sort()).toEqual(["review:decide", "review:dismiss", "review:open", "review:refresh"]);

      const open = handlers.get("review:open")!;
      await expect(open({}, { receiptToken })).rejects.toThrow(/refused/);
      allowed = true;
      const res = await open({}, { receiptToken });
      expect(res.ok).toBe(true);
    });

    // Mutation caught: a handler's unexpected exception escapes with internals
    it("turns unexpected handler failures into a generic error", async () => {
      const { handlers, ipcMain } = fakeIpc();
      const manager = {
        handleReviewOpen: async () => {
          throw new TypeError("secret internals C:\\Users\\x");
        },
        handleReviewDecide: async () => ({ ok: true }),
        handleReviewDismiss: async () => ({ ok: true }),
        handleReviewRefresh: async () => ({ ok: true }),
      };
      await registerReviewIpc({ ipcMain, fromApp: () => true, manager });
      const res = await handlers.get("review:open")!({}, {});
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain("secret");
    });
  });

  describe("preload bridge", () => {
    async function loadPreload() {
      const src = await fs.readFile(path.resolve(__dirname, "../../electron/preload.cjs"), "utf8");
      const calls: any[][] = [];
      let exposed: any;
      const fakeElectron = {
        contextBridge: { exposeInMainWorld: (_n: string, api: any) => (exposed = api) },
        ipcRenderer: { on() {}, send() {}, invoke: (...a: any[]) => (calls.push(a), Promise.resolve({})) },
        webUtils: {},
      };
      new Function("require", src)(() => fakeElectron);
      return { review: exposed.review, calls };
    }

    // Mutation caught: preload forwards a renderer-supplied path (or any extra field) to main
    it("forwards only the known review fields; a path never leaves the renderer", async () => {
      const { review, calls } = await loadPreload();
      await review.open({ receiptToken: "t".repeat(32), receiptPath: "/tmp/secret.txt", extra: { a: 1 } });
      expect(calls.at(-1)).toEqual(["review:open", { receiptToken: "t".repeat(32) }]);
      const bytes = new Uint8Array([1, 2]);
      await review.open({ receiptBytes: bytes, receiptPath: "/tmp/x" });
      expect(calls.at(-1)).toEqual(["review:open", { receiptBytes: bytes }]);
      await review.open(null);
      expect(calls.at(-1)).toEqual(["review:open", {}]);
      await review.open({ receiptToken: { toString: () => "evil" } });
      expect(calls.at(-1)).toEqual(["review:open", { receiptToken: "evil" }]);

      await review.decide({ reviewId: "a".repeat(32), decision: "approved", comment: "hi", receiptPath: "/tmp/y" });
      expect(calls.at(-1)).toEqual(["review:decide", { reviewId: "a".repeat(32), decision: "approved", comment: "hi" }]);
      await review.decide(undefined);
      expect(calls.at(-1)![1].reviewId).toBe("undefined");
      await review.dismiss({ reviewId: "x" });
      expect(typeof calls.at(-1)![1]).toBe("string");
      await review.refresh(null);
      expect(typeof calls.at(-1)![1]).toBe("string");
    });
  });

  describe("F5: open-review cap", () => {
    // Mutation caught: no cap, or off by one
    it("allows 32 undecided reviews and refuses the 33rd until one is decided", async () => {
      const { handlers, receiptToken } = await createFixture();
      expect(REVIEW_IPC_LIMITS.maxOpenUndecided).toBe(32);
      const ids: string[] = [];
      for (let i = 0; i < 32; i++) {
        const r = await handlers.handleReviewOpen({ receiptToken });
        expect(r.ok).toBe(true);
        ids.push(r.reviewId);
      }
      const over = await handlers.handleReviewOpen({ receiptToken });
      expect(over.ok).toBe(false);
      expect(over.code).toBe("too_many_reviews");

      const dec = await handlers.handleReviewDismiss(ids[0]);
      expect(dec.ok).toBe(true);
      const again = await handlers.handleReviewOpen({ receiptToken });
      expect(again.ok).toBe(true);
    });

    // Mutation caught: concurrent opens slip past the cap
    it("counts opens that are still in flight toward the cap", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const verifier = {
        verify: async (files: any[]) => {
          await gate;
          return {
            verifiedAt: new Date().toISOString(),
            results: files.map((f) => ({ path: f.path, expectedSha256: f.sha256, observedSha256: f.sha256, state: "unchanged" })),
          };
        },
      };
      const { handlers, receiptToken } = await createFixture("file content", { verifier });
      const all = Promise.all(Array.from({ length: 40 }, () => handlers.handleReviewOpen({ receiptToken })));
      await new Promise((r) => setTimeout(r, 100));
      release();
      const results = await all;
      expect(results.filter((r: any) => r.ok).length).toBe(32);
      expect(results.filter((r: any) => !r.ok).every((r: any) => r.code === "too_many_reviews")).toBe(true);
    });

    // Mutation caught: decided reviews are never evicted
    it("evicts decided reviews after the retention time", async () => {
      let t = 1_000_000;
      const { handlers, receiptToken } = await createFixture("file content", { now: () => t });
      const open = await handlers.handleReviewOpen({ receiptToken });
      const dec = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      expect(dec.ok).toBe(true);

      t += REVIEW_IPC_LIMITS.decidedRetentionMs;
      expect(handlers.openReviews.has(open.reviewId)).toBe(true);
      const again = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      expect(again.code).toBe("already_decided");

      t += 1;
      const gone = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      expect(gone.code).toBe("not_found");
      expect(handlers.openReviews.has(open.reviewId)).toBe(false);
    });
  });

  describe("F6: shutdown and in-flight handling", () => {
    // Mutation caught: decide in flight can be decided twice or refreshed concurrently
    it("answers busy to a second decide or refresh while a decide is in flight, and queues pending dismiss", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      const base = createVerifier({ openAgentPath: mockOpenAgentPath });
      const verifier = {
        ...base,
        verify: async (...a: any[]) => {
          calls++;
          if (calls > 1) await gate; // the click-time check is the second call
          return (base.verify as any)(...a);
        },
      };
      const { handlers, receiptToken } = await createFixture("file content", { verifier });
      const open = await handlers.handleReviewOpen({ receiptToken });
      expect(open.ok).toBe(true);

      const first = handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "approved" });
      await new Promise((r) => setTimeout(r, 20));
      const dismissPromise = handlers.handleReviewDismiss(open.reviewId);
      const second = await handlers.handleReviewDecide({ reviewId: open.reviewId, decision: "changes_requested" });
      expect(second.code).toBe("busy");
      const refresh = await handlers.handleReviewRefresh(open.reviewId);
      expect(refresh.code).toBe("busy");

      release();
      const done = await first;
      expect(done.ok).toBe(true);
      expect(done.decision.decision).toBe("approved");

      const dismissRes = await dismissPromise;
      expect(dismissRes.ok).toBe(true);
      expect(dismissRes.alreadyDecided).toBe(true);
    });

    // Mutation caught: dismissing during refresh fails with busy and leaves review undecided, keeping cap slot
    it("dismiss during refresh ends dismissed and frees the cap slot", async () => {
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
      let calls = 0;
      const base = createVerifier({ openAgentPath: mockOpenAgentPath });
      const verifier = {
        ...base,
        verify: async (...a: any[]) => {
          calls++;
          if (calls > 1) await refreshGate; // first verify is openReview, second is refresh
          return (base.verify as any)(...a);
        },
      };
      const { handlers, receiptToken, store } = await createFixture("file content", { verifier });
      const open = await handlers.handleReviewOpen({ receiptToken });
      expect(open.ok).toBe(true);
      expect(handlers.openReviews.size).toBe(1);

      // Start a refresh that stays in-flight
      const refreshPromise = handlers.handleReviewRefresh(open.reviewId);
      await new Promise((r) => setTimeout(r, 20));

      // Dismiss while refresh is in-flight
      const dismissPromise = handlers.handleReviewDismiss(open.reviewId);

      // Release refresh gate
      releaseRefresh();
      const [refreshRes, dismissRes] = await Promise.all([refreshPromise, dismissPromise]);

      expect(dismissRes.ok).toBe(true);
      expect(dismissRes.dismissed).toBe(true);
      // The review must be decided as dismissed in store
      expect(await store.hasDecision(open.reviewId)).toBe(true);
      // Cap slot must be freed: no longer in openReviews
      expect(handlers.openReviews.has(open.reviewId)).toBe(false);
      expect(handlers.hasUndecided()).toBe(false);
    });

    // Mutation caught: dismissAll skips in-flight reviews leaving them undecided
    it("dismissAll covers in-flight reviews after they settle", async () => {
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
      let calls = 0;
      const base = createVerifier({ openAgentPath: mockOpenAgentPath });
      const verifier = {
        ...base,
        verify: async (...a: any[]) => {
          calls++;
          // First 2 calls are for the 2 opens. The 3rd call is for the refresh on a.
          if (calls > 2) await refreshGate;
          return (base.verify as any)(...a);
        },
      };
      const { handlers, receiptToken, store } = await createFixture("file content", { verifier });
      const a = await handlers.handleReviewOpen({ receiptToken });
      const b = await handlers.handleReviewOpen({ receiptToken });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(handlers.openReviews.size).toBe(2);

      // Start refresh on a
      const refreshPromise = handlers.handleReviewRefresh(a.reviewId);
      await new Promise((r) => setTimeout(r, 20));

      // dismissAll while a is in-flight and b is idle
      const dismissAllPromise = handlers.dismissAll();

      // Release the in-flight refresh
      releaseRefresh();
      const [_, count] = await Promise.all([refreshPromise, dismissAllPromise]);

      expect(count).toBe(2);
      expect(handlers.hasUndecided()).toBe(false);
      expect(await store.hasDecision(a.reviewId)).toBe(true);
      expect(await store.hasDecision(b.reviewId)).toBe(true);
      expect(handlers.openReviews.has(a.reviewId)).toBe(false);
      expect(handlers.openReviews.has(b.reviewId)).toBe(false);
    });

    // Mutation caught: dismissAll skips undecided reviews
    it("dismissAll records dismissed for every undecided review and leaves decided ones", async () => {
      const { handlers, receiptToken, store } = await createFixture();
      const a = await handlers.handleReviewOpen({ receiptToken });
      const b = await handlers.handleReviewOpen({ receiptToken });
      const c = await handlers.handleReviewOpen({ receiptToken });
      await handlers.handleReviewDecide({ reviewId: c.reviewId, decision: "approved" });
      expect(handlers.hasUndecided()).toBe(true);

      const n = await handlers.dismissAll();
      expect(n).toBe(2);
      expect(handlers.hasUndecided()).toBe(false);
      expect(await store.hasDecision(a.reviewId)).toBe(true);
      expect(await store.hasDecision(b.reviewId)).toBe(true);
    });

    function fakeApp() {
      const app: any = new EventEmitter();
      app.quit = vi.fn(() => {
        const e = {
          prevented: false,
          preventDefault() {
            this.prevented = true;
          },
        };
        app.lastQuitEvent = e;
        app.emit("before-quit", e);
      });
      return app;
    }

    // Mutation caught: before-quit does not dismiss open reviews
    it("before-quit dismisses open reviews, then quits", async () => {
      const dismissAll = vi.fn(async () => 2);
      const app = fakeApp();
      installShutdownDismiss({ app, manager: { hasUndecided: () => true, dismissAll } });
      const e = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      app.emit("before-quit", e);
      expect(e.prevented).toBe(true);
      expect(dismissAll).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
      // The second before-quit (from app.quit) passes straight through.
      expect(app.lastQuitEvent.prevented).toBe(false);
      expect(dismissAll).toHaveBeenCalledTimes(1);
    });

    it("before-quit does not delay quitting when nothing is open", () => {
      const dismissAll = vi.fn(async () => 0);
      const app = fakeApp();
      installShutdownDismiss({ app, manager: { hasUndecided: () => false, dismissAll } });
      const e = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      app.emit("before-quit", e);
      expect(e.prevented).toBe(false);
      expect(dismissAll).not.toHaveBeenCalled();
    });

    // Mutation caught: a stuck dismissal blocks quitting forever
    it("quits after the timeout even when dismissal hangs", async () => {
      vi.useFakeTimers();
      try {
        const app = fakeApp();
        installShutdownDismiss({ app, timeoutMs: 3000, manager: { hasUndecided: () => true, dismissAll: () => new Promise(() => {}) } });
        app.emit("before-quit", { preventDefault() {} });
        await vi.advanceTimersByTimeAsync(2999);
        expect(app.quit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(app.quit).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
