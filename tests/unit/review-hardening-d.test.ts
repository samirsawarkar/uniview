// P14b-1d: regression tests for Codex's final review of 8cc03ec + 5fe0e8f
// (pending-close slot bound, identity quality fallback, link-swap re-verification, rewrite failure).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// @ts-expect-error plain ESM module without types
import { openReview, createVerifier, decide, REVIEW_LIMITS } from "../../electron/lib/review-verify.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore, writeDecisionNextToReceipt } from "../../electron/lib/review-store.mjs";
import { tmpBase } from "./helpers/tmp-base";

const sha = (s: string) => crypto.createHash("sha256").update(Buffer.from(s)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fail (instead of hanging the suite) when a promise does not settle. */
function settles(p: Promise<any>, ms = 2000): Promise<any> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("did not settle")), ms))]);
}

type Entry = {
  content: string;
  ino?: number | string;
  dev?: number;
  mtimeMs?: number;
  birthtimeMs?: number;
  /** Omit the stat method on the handle. */
  noStat?: boolean;
  read?: (buf: Buffer, len: number) => Promise<{ bytesRead: number }>;
  /** Called by handle.close(); the returned promise decides when the close settles. */
  close?: () => Promise<void>;
};

/** In-memory openAgentPath with fstat-style metadata and controllable close(). */
function fakeWorld() {
  const files = new Map<string, Entry>();
  const log = { opened: 0, closeCalls: 0, closedSettled: 0, maxLive: 0 };
  const openAgentPath = async (p: string) => {
    const f = files.get(p);
    if (!f) return { ok: false, code: "not_found" };
    log.opened++;
    log.maxLive = Math.max(log.maxLive, log.opened - log.closedSettled);
    const data = Buffer.from(f.content);
    let pos = 0;
    const handle: Record<string, unknown> = {
      read: async (buf: Buffer, _off: number, len: number) => {
        if (f.read) return f.read(buf, len);
        const n = Math.min(len, data.length - pos);
        data.copy(buf, 0, pos, pos + n);
        pos += n;
        return { bytesRead: n };
      },
      close: async () => {
        log.closeCalls++;
        if (f.close) await f.close();
        log.closedSettled++;
      },
    };
    if (!f.noStat) {
      handle.stat = async () => ({
        size: BigInt(data.length),
        mtimeMs: BigInt(f.mtimeMs ?? 1000),
        birthtimeMs: BigInt(f.birthtimeMs ?? 0),
      });
    }
    const ino = f.ino === undefined ? undefined : typeof f.ino === "number" && Number.isInteger(f.ino) ? BigInt(f.ino) : f.ino;
    return { ok: true, handle, canonical: p, size: data.length, dev: BigInt(f.dev ?? 1), ino };
  };
  return { files, log, openAgentPath };
}

describe("review hardening d (P14b-1d)", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `review-hard-d-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    storeDir = path.join(testDir, "store");
    await fs.mkdir(storeDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  async function makeReview(files: Array<{ path: string; content: string }>, receiptPath: string | null = null) {
    const receiptBytes = Buffer.from(
      JSON.stringify({
        uniview: "receipt/1",
        createdAt: new Date().toISOString(),
        agent: { name: "hardening-d" },
        task: "task",
        summary: "summary",
        files: files.map((f) => ({ path: f.path, sha256: sha(f.content), role: "created" })),
      }),
      "utf8",
    );
    return openReview({ receiptBytes, receiptPath });
  }

  function makeDecision(reviewId = "0123456789abcdef0123456789abcdef", extra: Record<string, unknown> = {}) {
    const at = new Date().toISOString();
    return {
      uniview: "decision/1",
      reviewId,
      receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision: "approved",
      comment: "",
      decidedAt: at,
      verifiedAt: at,
      persisted: true,
      files: [],
      ...extra,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Finding 1: pending close handles and the two-file bound
  // ---------------------------------------------------------------------------------------------
  describe("finding 1: pending close", () => {
    const hang = () => new Promise<never>(() => {});

    // Mutation caught: the pass (and so the queue) advancing before the aborted files' handles are closed,
    // which lets the next pass open two more files while two closes are still pending (four live handles).
    it("an aborted pass waits for pending closes, so the next pass never raises live handles above two", async () => {
      const w = fakeWorld();
      const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => path.join(testDir, `${n}.txt`)) as [string, string, string, string];
      let releaseCloses!: () => void;
      const closeGate = new Promise<void>((r) => (releaseCloses = r));
      w.files.set(a, { content: "a", ino: 1, read: hang, close: () => closeGate });
      w.files.set(b, { content: "b", ino: 2, read: hang, close: () => closeGate });
      w.files.set(c, { content: "c", ino: 3 });
      w.files.set(d, { content: "d", ino: 4 });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath, limits: { ...REVIEW_LIMITS, closeDeadlineMs: 1500 } });

      const ac = new AbortController();
      let firstSettled = false;
      const pass1 = verifier.verify([{ path: a, sha256: sha("a") }, { path: b, sha256: sha("b") }], { signal: ac.signal }).then((r: any) => {
        firstSettled = true;
        return r;
      });
      const pass2 = verifier.verify([{ path: c, sha256: sha("c") }, { path: d, sha256: sha("d") }]);
      await sleep(40);
      expect(w.log.opened).toBe(2);
      ac.abort();
      await sleep(80);
      expect(firstSettled).toBe(false); // still waiting for the two pending closes
      expect(w.log.opened).toBe(2); // and the queued pass has not opened anything

      releaseCloses();
      const [r1, r2] = await settles(Promise.all([pass1, pass2]));
      expect(r1.results.map((r: any) => r.state)).toEqual(["unreadable", "unreadable"]);
      expect(r2.results.map((r: any) => r.state)).toEqual(["unchanged", "unchanged"]);
      expect(w.log.maxLive).toBeLessThanOrEqual(2);
    });

    // Mutation caught: giving the slot back when the close deadline passes (or not guarding opens by live handles),
    // so closes that never settle let later passes pile more handles on top.
    it("closes that never settle: the pass still ends after the close deadline, later passes open nothing beyond the bound", async () => {
      const w = fakeWorld();
      const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => path.join(testDir, `${n}.txt`)) as [string, string, string, string];
      const settleLate: Array<() => void> = [];
      const lateClose = () => new Promise<void>((r) => settleLate.push(r));
      w.files.set(a, { content: "a", ino: 1, read: hang, close: lateClose });
      w.files.set(b, { content: "b", ino: 2, read: hang, close: lateClose });
      w.files.set(c, { content: "c", ino: 3 });
      w.files.set(d, { content: "d", ino: 4 });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath, limits: { ...REVIEW_LIMITS, closeDeadlineMs: 40 } });

      const ac = new AbortController();
      const pass1 = verifier.verify([{ path: a, sha256: sha("a") }, { path: b, sha256: sha("b") }], { signal: ac.signal });
      await sleep(30);
      ac.abort();
      const r1 = await settles(pass1);
      expect(r1.results.map((r: any) => r.state)).toEqual(["unreadable", "unreadable"]);
      expect(verifier.liveHandles()).toBe(2); // both closes are still pending: the slots stay taken

      const r2 = await settles(verifier.verify([{ path: c, sha256: sha("c") }, { path: d, sha256: sha("d") }]));
      expect(r2.results.map((r: any) => r.state)).toEqual(["unreadable", "unreadable"]);
      expect(w.log.opened).toBe(2); // nothing new was opened
      expect(w.log.maxLive).toBeLessThanOrEqual(2);

      // the late closes finally settle: the slots come back and verification works again
      settleLate.forEach((s) => s());
      await sleep(20);
      expect(verifier.liveHandles()).toBe(0);
      const r3 = await settles(verifier.verify([{ path: c, sha256: sha("c") }]));
      expect(r3.results[0].state).toBe("unchanged");
    });

    // Mutation caught: close awaited outside any bound at EOF (the pass ignores the deadline while close blocks),
    // or the deadline not re-checked after the close.
    it("a read that reaches EOF followed by a blocked close past the deadline still settles as too_large", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      let t = 1_000_000;
      w.files.set(p, {
        content: "x",
        ino: 1,
        close: () => {
          t += 5000; // the close is what runs out the clock
          return hang();
        },
      });
      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        now: () => t,
        limits: { ...REVIEW_LIMITS, passDeadlineMs: 1000, closeDeadlineMs: 40 },
      });
      const res = await settles(verifier.verify([{ path: p, sha256: sha("x") }]));
      expect(res.results[0].state).toBe("too_large");
      expect(verifier.liveHandles()).toBe(1); // still pending, tracked, slot not given back
    });

    // Mutation caught: no abort re-check after the close (a pass cancelled while closing reports a clean result).
    it("a pass aborted while its last file is closing does not report that file as unchanged", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const ac = new AbortController();
      w.files.set(p, {
        content: "x",
        ino: 1,
        close: () => {
          ac.abort();
          return hang();
        },
      });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath, limits: { ...REVIEW_LIMITS, closeDeadlineMs: 40 } });
      const res = await settles(verifier.verify([{ path: p, sha256: sha("x") }], { signal: ac.signal }));
      expect(res.results[0].state).toBe("unreadable");
    });

    // Mutation caught: a handle slot that is not given back when an open fails (throws or reports not ok); after two
    // such files every later file would be refused as unreadable.
    it("failed opens do not leak slots", async () => {
      const w = fakeWorld();
      const [m1, m2, boom, ok] = ["m1", "m2", "boom", "ok"].map((n) => path.join(testDir, `${n}.txt`)) as [string, string, string, string];
      w.files.set(ok, { content: "x", ino: 1 });
      const openAgentPath = async (p: string) => {
        if (p === boom) throw new Error("open exploded");
        return w.openAgentPath(p);
      };
      const verifier = createVerifier({ openAgentPath });
      const files = [m1, m2, boom, ok].map((p) => ({ path: p, sha256: sha("x") }));
      const res = await settles(verifier.verify(files));
      expect(res.results.map((r: any) => r.state)).toEqual(["missing", "missing", "unreadable", "unchanged"]);
      expect(verifier.liveHandles()).toBe(0);
    });

    // Mutation caught: the default close deadline changing.
    it("pins the default close deadline at 2 seconds", () => {
      const v = createVerifier({ openAgentPath: async () => ({ ok: false, code: "not_found" }) });
      expect(v.limits.closeDeadlineMs).toBe(2000);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 2: identity quality
  // ---------------------------------------------------------------------------------------------
  describe("finding 2: identity quality fallback", () => {
    async function viewAndDecide(opts: {
      first: Partial<Entry>;
      then: Partial<Entry>[]; // successive states of the file, last one is present at click time
      inoUnreliable?: (dev: string) => boolean;
      decideState?: number; // index in `then` at which the review is shown (default: 0, first entry after opening)
    }) {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "same bytes" }]);
      const base: Entry = { content: "same bytes", ino: 0, mtimeMs: 1000, birthtimeMs: 500 };
      w.files.set(p, { ...base, ...opts.first });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath, inoUnreliable: opts.inoUnreliable });
      const opened = await verifier.verify(review.receipt.files);
      let shown = opened;
      const passes = [];
      for (let i = 0; i < opts.then.length - 1; i++) {
        w.files.set(p, { ...base, ...opts.first, ...opts.then[i] });
        shown = await verifier.verify(review.receipt.files, { baseline: shown });
        passes.push(shown);
      }
      w.files.set(p, { ...base, ...opts.first, ...opts.then[opts.then.length - 1] });
      const store = createDecisionStore({ dir: storeDir, fs });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      return { opened, shown, result, passes };
    }

    // Mutation caught: ino 0 treated as a valid identity (every file looks identical), so a different file with
    // another mtime is approved.
    it("blocks approval when a file is replaced and the inode number is 0 on both sides (different mtime)", async () => {
      const { opened, result } = await viewAndDecide({ first: { ino: 0 }, then: [{ ino: 0, mtimeMs: 2000 }] });
      expect(opened.results[0].identityQuality).toBe("fingerprint");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("changed");
      expect(result.current.results[0].state).toBe("replaced");
    });

    // Mutation caught: judging a view against a later fingerprint instead of the one first seen / ignoring the
    // fingerprint in canDecide: viewed as replaced, replaced again with identical bytes, still must not approve.
    it("blocks approval when the file is replaced a second time after a replaced view (ino 0)", async () => {
      const { shown, result } = await viewAndDecide({
        first: { ino: 0 },
        then: [{ ino: 0, mtimeMs: 2000 }, { ino: 0, mtimeMs: 3000 }],
      });
      expect(shown.results[0].state).toBe("replaced");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("changed");
    });

    // Mutation caught: blocking an unchanged file just because its inode number is unusable.
    it("approves an unchanged file whose inode number is 0 (metadata and bytes match)", async () => {
      const { result } = await viewAndDecide({ first: { ino: 0 }, then: [{ ino: 0 }] });
      expect(result.ok).toBe(true);
    });

    // Documented best effort: nothing but the bytes can separate a file with identical metadata and identical
    // content. Approval stays bound to the byte hash, so different bytes are still caught.
    it("with identical metadata, identical bytes are accepted but different bytes are still refused", async () => {
      const same = await viewAndDecide({ first: { ino: 0 }, then: [{ ino: 0 }] });
      expect(same.result.ok).toBe(true);
      const tampered = await viewAndDecide({ first: { ino: 0 }, then: [{ ino: 0, content: "other bytes" }] });
      expect(tampered.result.ok).toBe(false);
      expect(tampered.result.current.results[0].state).toBe("changed");
    });

    // Mutation caught: unusable inode forms (0, absent, NaN, negative) accepted as an identity.
    it("treats ino 0, absent, NaN and negative as unusable and a positive ino as usable", async () => {
      const qualities: Record<string, string | null> = {};
      for (const [name, ino] of [["zero", 0], ["absent", undefined], ["nan", NaN], ["negative", -3], ["ok", 5]] as const) {
        const w = fakeWorld();
        const p = path.join(testDir, `${name}.txt`);
        w.files.set(p, { content: "x", ino: ino as any });
        const v = createVerifier({ openAgentPath: w.openAgentPath });
        qualities[name] = (await v.verify([{ path: p, sha256: sha("x") }])).results[0].identityQuality;
      }
      expect(qualities).toEqual({ zero: "fingerprint", absent: "fingerprint", nan: "fingerprint", negative: "fingerprint", ok: "inode" });
    });

    // Mutation caught: approving a file whose identity cannot be compared at all (no usable ino, no fstat).
    it("never approves when neither an inode number nor metadata is available", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "x" }]);
      w.files.set(p, { content: "x", ino: 0, noStat: true });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);
      expect(shown.results[0].identityQuality).toBe("none");
      const result = await decide({ review, shown, decision: "approved", verifier, store: createDecisionStore({ dir: storeDir, fs }) });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("identity_unavailable");
    });

    // Mutation caught: an unstable inode number on an unflagged volume excused (it cannot be told from a swap).
    it("unstable inode numbers on an unflagged volume count as a replacement", async () => {
      const { result } = await viewAndDecide({ first: { ino: 5 }, then: [{ ino: 7 }] });
      expect(result.ok).toBe(false);
      expect(result.current.results[0].state).toBe("replaced");
    });

    // Rule: on a volume flagged as having unreliable inode numbers, an unchanged file (same size, mtime, birth time
    // and bytes) is not blocked by a drifting ino; a different mtime still is.
    // Mutation caught: the unreliable-volume hook being ignored.
    it("on a flagged volume a drifting inode number does not block an unchanged file", async () => {
      const flagged = (dev: string) => dev === "1";
      const ok = await viewAndDecide({ first: { ino: 5 }, then: [{ ino: 7 }], inoUnreliable: flagged });
      expect(ok.result.ok).toBe(true);
      expect(ok.opened.results[0].identityQuality).toBe("fingerprint");
      const moved = await viewAndDecide({ first: { ino: 5 }, then: [{ ino: 7, mtimeMs: 9999 }], inoUnreliable: flagged });
      expect(moved.result.ok).toBe(false);
    });

    // Mutation caught: birth time left out of the fingerprint (a copy that keeps size and mtime but is a new file).
    it("with an unusable inode, a different creation time alone makes the file replaced", async () => {
      const { result } = await viewAndDecide({ first: { ino: 0, birthtimeMs: 500 }, then: [{ ino: 0, birthtimeMs: 900 }] });
      expect(result.ok).toBe(false);
      expect(result.current.results[0].state).toBe("replaced");
    });

    // Mutation caught: inode reuse by a new file (same dev/ino, different creation time) accepted.
    it("treats a reused inode number with a different creation time as a replacement", async () => {
      const { result } = await viewAndDecide({ first: { ino: 5, birthtimeMs: 500 }, then: [{ ino: 5, birthtimeMs: 900 }] });
      expect(result.ok).toBe(false);
      expect(result.current.results[0].state).toBe("replaced");
    });

    // Mutation caught: a changed file with an unusable inode reported as replaced instead of changed (bytes decide).
    it("a changed file with an unusable inode reads as changed, not replaced", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      w.files.set(p, { content: "v1", ino: 0, mtimeMs: 1 });
      const v = createVerifier({ openAgentPath: w.openAgentPath });
      const first = await v.verify([{ path: p, sha256: sha("v1") }]);
      w.files.set(p, { content: "v2", ino: 0, mtimeMs: 2 });
      const second = await v.verify([{ path: p, sha256: sha("v1") }], { baseline: first });
      expect(second.results[0].state).toBe("changed");
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 3: ancestor swap between the check and the write
  // ---------------------------------------------------------------------------------------------
  describe("finding 3: link swap re-verification", () => {
    async function receiptIn(dir: string) {
      await fs.mkdir(dir, { recursive: true });
      const receiptPath = path.join(dir, "r.receipt.json");
      await fs.writeFile(receiptPath, "{}");
      return receiptPath;
    }

    /** realpath behaves normally until the first link/copy happens; afterwards `swap` rewrites the answers. */
    function swappingFs(swap: (p: string, real: string) => string) {
      let swapped = false;
      return {
        ...fs,
        link: async (a: string, b: string) => {
          await fs.link(a, b);
          if (String(b).endsWith(".decision.json")) swapped = true; // the ancestor became a junction while the write was in flight
        },
        copyFile: async (a: string, b: string, m?: number) => {
          await fs.copyFile(a, b, m);
          if (String(b).endsWith(".decision.json")) swapped = true;
        },
        realpath: async (p: string) => {
          const real = await fs.realpath(p);
          return swapped ? swap(String(p), real) : real;
        },
      };
    }
    const leftovers = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));

    // Under CTO decision (P17b-1c): failed placement check never unlinks target by pathname;
    // whatever was created is left in place (harmless decision text); only temp files are removed.
    it("an ancestor swapped after the first realpath: only temp files removed, target left in place, false returned", async () => {
      const dir = path.join(testDir, "proj");
      const receiptPath = await receiptIn(dir);
      const swapFs = swappingFs((p, real) => (p === dir ? path.join(testDir, "elsewhere") : real));
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: swapFs })).toBe(false);
      await expect(fs.access(`${receiptPath}.decision.json`)).resolves.toBeUndefined();
      expect(await leftovers(dir)).toEqual([]);
    });

    it("the created target resolving elsewhere is refused and left in place without unlinking target", async () => {
      const dir = path.join(testDir, "proj2");
      const receiptPath = await receiptIn(dir);
      const target = `${receiptPath}.decision.json`;
      const swapFs = swappingFs((p, real) => (p === target ? path.join(testDir, "elsewhere", "x.json") : real));
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: swapFs })).toBe(false);
      await expect(fs.access(target)).resolves.toBeUndefined();
    });

    it("works through the copyFile fallback as well", async () => {
      const dir = path.join(testDir, "proj3");
      const receiptPath = await receiptIn(dir);
      const swapFs = { ...swappingFs((p, real) => (p === dir ? path.join(testDir, "elsewhere") : real)), link: async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); } };
      // link is unsupported, copyFile (which flips the swap) is used
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: swapFs })).toBe(false);
      await expect(fs.access(`${receiptPath}.decision.json`)).resolves.toBeUndefined();
    });

    // Mutation caught: the same-review "already there" branch trusting a path that no longer resolves in place.
    it("an existing own decision is not trusted when the placement no longer verifies", async () => {
      const dir = path.join(testDir, "proj4");
      const receiptPath = await receiptIn(dir);
      const target = `${receiptPath}.decision.json`;
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs })).toBe(true);
      const badFs = { ...fs, realpath: async (p: string) => (String(p) === target ? path.join(testDir, "elsewhere", "x.json") : fs.realpath(p)) };
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: badFs })).toBe(false);
    });

    // Mutation caught: a failed re-verification still reported as persisted by decide, or leaving the store copy at true.
    it("decide ends persisted false with sidecar_unverified note and a matching store copy when the swap is detected", async () => {
      const dir = path.join(testDir, "proj5");
      const receiptPath = await receiptIn(dir);
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "x" }], receiptPath);
      w.files.set(p, { content: "x", ino: 1 });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);
      const store = createDecisionStore({ dir: storeDir, fs: swappingFs((q, real) => (q === dir ? path.join(testDir, "elsewhere") : real)) as typeof fs });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(false);
      expect(result.note).toBe("sidecar_unverified");
      expect((await store.load(review.reviewId)).persisted).toBe(false);
      await expect(fs.access(`${receiptPath}.decision.json`)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 4: the store copy cannot be corrected
  // ---------------------------------------------------------------------------------------------
  describe("finding 4: rewrite failure", () => {
    async function setup(opts: { rewriteFailures: number; removeFails?: boolean }) {
      const receiptPath = path.join(testDir, "r.receipt.json");
      await fs.writeFile(receiptPath, "{}");
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "x" }], receiptPath);
      w.files.set(p, { content: "x", ino: 1 });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);
      let renames = 0;
      let storeId = "";
      const storeFs = {
        ...fs,
        // the sidecar cannot be created ...
        link: async (a: string, b: string) => {
          if (String(b).endsWith(".decision.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return fs.link(a, b);
        },
        copyFile: async (a: string, b: string, m?: number) => {
          if (String(b).endsWith(".decision.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return fs.copyFile(a, b, m);
        },
        // ... and the store rewrite (which renames its temp file over the record) fails
        rename: async (a: string, b: string) => {
          renames++;
          if (renames <= opts.rewriteFailures) throw Object.assign(new Error("disk error"), { code: "EIO" });
          return fs.rename(a, b);
        },
        unlink: async (q: string) => {
          if (opts.removeFails && String(q).endsWith(`${storeId}.json`)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          return fs.unlink(q);
        },
      };
      const store = createDecisionStore({ dir: storeDir, fs: storeFs as typeof fs });
      storeId = review.reviewId;
      return { review, shown, verifier, store, receiptPath, renames: () => renames };
    }

    // Mutation caught: the swallowed rewrite error (store keeps persisted true while false is returned).
    it("removes the store record, keeps the claim and reports store_inconsistent when the copy cannot be corrected", async () => {
      const { review, shown, verifier, store, receiptPath, renames } = await setup({ rewriteFailures: 99 });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(false);
      expect(result.note).toBe("store_inconsistent");
      expect(result.storeRecordRemoved).toBe(true);
      expect(renames()).toBe(2); // one retry
      await expect(fs.access(path.join(storeDir, `${review.reviewId}.json`))).rejects.toBeTruthy();
      await expect(fs.access(`${receiptPath}.decision.json`)).rejects.toBeTruthy();
      expect(store.claims.has(review.reviewId)).toBe(true);
      await expect(decide({ review, shown, decision: "dismissed", verifier, store })).rejects.toMatchObject({ code: "already_decided" });
    });

    // Mutation caught: no retry before giving up (a transient rewrite error is enough to lose the record).
    it("retries the rewrite once and succeeds without a note", async () => {
      const { review, shown, verifier, store } = await setup({ rewriteFailures: 1 });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.decision.persisted).toBe(false);
      expect(result.note).toBeUndefined();
      expect((await store.load(review.reviewId)).persisted).toBe(false);
    });

    // Mutation caught: pretending the record was removed when removal failed (the inconsistency must be visible).
    it("says so when the stale record cannot be removed either", async () => {
      const { review, shown, verifier, store } = await setup({ rewriteFailures: 99, removeFails: true });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(false);
      expect(result.note).toBe("store_inconsistent");
      expect(result.storeRecordRemoved).toBe(false);
      expect(store.claims.has(review.reviewId)).toBe(true);
    });

    // Mutation caught: store.remove leaving the id known, so hasDecision keeps reporting a record that is gone.
    it("store.remove deletes the record and forgets the id", async () => {
      const store = createDecisionStore({ dir: storeDir, fs });
      await store.save(makeDecision("ee".repeat(16)));
      expect(await store.hasDecision("ee".repeat(16))).toBe(true);
      await store.remove("ee".repeat(16));
      expect(await store.hasDecision("ee".repeat(16))).toBe(false);
    });
  });
});
