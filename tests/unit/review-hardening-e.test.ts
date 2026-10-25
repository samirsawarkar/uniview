// P14b-1e: regression tests for Codex findings on review verifier/store
// 1. Post-create placement check failure must not unlink another review's sidecar when ancestor is redirected.
// 2. Rejecting or synchronously throwing close must keep the slot held until retry succeeds; bounded retries.
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

function settles(p: Promise<any>, ms = 3000): Promise<any> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("did not settle")), ms)),
  ]);
}

type Entry = {
  content: string;
  ino?: number | string;
  dev?: number;
  mtimeMs?: number;
  birthtimeMs?: number;
  read?: (buf: Buffer, len: number) => Promise<{ bytesRead: number }>;
  close?: () => Promise<void> | void;
};

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
    handle.stat = async () => ({
      size: BigInt(data.length),
      mtimeMs: BigInt(f.mtimeMs ?? 1000),
      birthtimeMs: BigInt(f.birthtimeMs ?? 0),
    });
    const ino = f.ino === undefined ? undefined : typeof f.ino === "number" && Number.isInteger(f.ino) ? BigInt(f.ino) : f.ino;
    return { ok: true, handle, canonical: p, size: data.length, dev: BigInt(f.dev ?? 1), ino };
  };
  return { files, log, openAgentPath };
}

describe("review hardening e (P14b-1e)", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `review-hard-e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        agent: { name: "hardening-e" },
        task: "task",
        summary: "summary",
        files: files.map((f) => ({ path: f.path, sha256: sha(f.content), role: "created" })),
      }),
      "utf8",
    );
    return openReview({ receiptBytes, receiptPath });
  }

  function makeDecision(reviewId = "11111111111111111111111111111111", extra: Record<string, unknown> = {}) {
    const at = new Date().toISOString();
    return {
      uniview: "decision/1",
      reviewId,
      receiptDigest: "1111111111111111111111111111111111111111111111111111111111111111",
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
  // Finding 1: post-create placement check failure and redirected ancestor cleanup
  // ---------------------------------------------------------------------------------------------
  describe("finding 1: post-create placement check failure does not unlink another review's sidecar", () => {
    /**
     * An fs that operates normally on dirA until the sidecar file is created;
     * thereafter, operations on dirA are redirected to dirB (which contains another review's sidecar).
     */
    function createRedirectingFs(dirA: string, dirB: string) {
      let redirected = false;
      const map = (p: string) => {
        const s = String(p);
        if (redirected && s.startsWith(dirA)) {
          const rel = path.relative(dirA, s);
          return path.join(dirB, rel);
        }
        return s;
      };

      const customFs = {
        ...fs,
        mkdir: async (p: any, opts: any) => fs.mkdir(map(p), opts),
        lstat: async (p: any) => fs.lstat(map(p)),
        stat: async (p: any) => fs.stat(map(p)),
        access: async (p: any) => fs.access(map(p)),
        readFile: async (p: any, enc: any) => fs.readFile(map(p), enc),
        writeFile: async (p: any, data: any, opts: any) => fs.writeFile(map(p), data, opts),
        unlink: async (p: any) => fs.unlink(map(p)),
        open: async (p: any, flags: any) => fs.open(map(p), flags),
        link: async (from: string, to: string) => {
          const res = await fs.link(map(from), map(to));
          if (String(to).endsWith(".decision.json")) {
            // Ancestor redirected to dirB immediately after create
            redirected = true;
          }
          return res;
        },
        copyFile: async (from: string, to: string, mode?: number) => {
          const res = await fs.copyFile(map(from), map(to), mode);
          if (String(to).endsWith(".decision.json")) {
            redirected = true;
          }
          return res;
        },
        realpath: async (p: string) => {
          const mapped = map(p);
          return fs.realpath(mapped);
        },
      };
      return { fs: customFs, isRedirected: () => redirected };
    }

    // Mutation caught: unconditionally unlinking targetPath through redirected ancestor, deleting other's sidecar.
    it("when ancestor redirects to directory B holding another review's sidecar, other sidecar survives", async () => {
      const dirA = path.join(testDir, "dirA");
      const dirB = path.join(testDir, "dirB");
      await fs.mkdir(dirA, { recursive: true });
      await fs.mkdir(dirB, { recursive: true });

      // Directory B holds another review's sidecar
      const receiptFilename = "target.receipt.json";
      const sidecarFilename = "target.receipt.json.decision.json";
      const otherSidecarPath = path.join(dirB, sidecarFilename);
      const otherDecision = makeDecision("22222222222222222222222222222222", {
        receiptDigest: "2222222222222222222222222222222222222222222222222222222222222222",
      });
      await fs.writeFile(otherSidecarPath, JSON.stringify(otherDecision, null, 2), "utf8");

      // dirA initially holds our receipt
      const ourReceiptPath = path.join(dirA, receiptFilename);
      await fs.writeFile(ourReceiptPath, "{}");

      const { fs: redirFs } = createRedirectingFs(dirA, dirB);

      const ourDecision = makeDecision("11111111111111111111111111111111", {
        receiptDigest: "1111111111111111111111111111111111111111111111111111111111111111",
      });

      const outcome = await writeDecisionNextToReceipt(ourReceiptPath, ourDecision, { fs: redirFs });
      expect(outcome).toBe(false);

      // The other review's sidecar in directory B MUST survive untouched!
      const surviving = await fs.readFile(otherSidecarPath, "utf8");
      const parsedOther = JSON.parse(surviving);
      expect(parsedOther.reviewId).toBe("22222222222222222222222222222222");
    });

    // Mutation caught: decide failing to report note when placement verification fails and sidecar is not ours.
    it("decide reports persisted:false with note when sidecar placement verification fails and target is not ours", async () => {
      const dirA = path.join(testDir, "dirA_decide");
      const dirB = path.join(testDir, "dirB_decide");
      await fs.mkdir(dirA, { recursive: true });
      await fs.mkdir(dirB, { recursive: true });

      const otherSidecarPath = path.join(dirB, "r.receipt.json.decision.json");
      const otherDecision = makeDecision("99999999999999999999999999999999", {
        receiptDigest: "9999999999999999999999999999999999999999999999999999999999999999",
      });
      await fs.writeFile(otherSidecarPath, JSON.stringify(otherDecision, null, 2), "utf8");

      const receiptPath = path.join(dirA, "r.receipt.json");
      await fs.writeFile(receiptPath, "{}");

      const { fs: redirFs } = createRedirectingFs(dirA, dirB);

      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "x" }], receiptPath);
      w.files.set(p, { content: "x", ino: 1 });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);

      const store = createDecisionStore({ dir: storeDir, fs: redirFs as typeof fs });
      const result = await decide({ review, shown, decision: "approved", verifier, store });

      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(false);
      expect(result.note).toBe("sidecar_unverified");

      // Other review's sidecar must remain intact
      const surviving = await fs.readFile(otherSidecarPath, "utf8");
      expect(JSON.parse(surviving).reviewId).toBe("99999999999999999999999999999999");
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 2: rejected or synchronously throwing close and slot bounds
  // ---------------------------------------------------------------------------------------------
  describe("finding 2: handle close failure holds slot until retry", () => {
    // Mutation caught: releasing slot on rejected close, leaving descriptor open while liveHandles() === 0.
    it("rejecting close: keeps slot held, reports file unreadable, and liveHandles() remains 1", async () => {
      const w = fakeWorld();
      const a = path.join(testDir, "reject.txt");
      w.files.set(a, {
        content: "data",
        ino: 1,
        close: async () => {
          throw Object.assign(new Error("EIO on close"), { code: "EIO" });
        },
      });

      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        limits: { ...REVIEW_LIMITS, closeRetryAttempts: 3, closeRetryBackoffMs: 5 },
      });

      const res = await settles(verifier.verify([{ path: a, sha256: sha("data") }]));
      expect(res.results[0].state).toBe("unreadable");
      // The slot must stay reserved because the handle never closed cleanly
      expect(verifier.liveHandles()).toBe(1);
    });

    // Mutation caught: releasing slot on synchronously throwing close.
    it("synchronously throwing close: keeps slot held, reports file unreadable, and liveHandles() remains 1", async () => {
      const w = fakeWorld();
      const a = path.join(testDir, "sync-throw.txt");
      w.files.set(a, {
        content: "data",
        ino: 1,
        close: () => {
          throw Object.assign(new Error("synchronous crash on close"), { code: "EIO" });
        },
      });

      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        limits: { ...REVIEW_LIMITS, closeRetryAttempts: 3, closeRetryBackoffMs: 5 },
      });

      const res = await settles(verifier.verify([{ path: a, sha256: sha("data") }]));
      expect(res.results[0].state).toBe("unreadable");
      expect(verifier.liveHandles()).toBe(1);
    });

    // Mutation caught: no retry on close error, leaving slot leaked even if retry would succeed.
    it("close that succeeds on retry: retries with bounded backoff and releases slot when retry succeeds", async () => {
      const w = fakeWorld();
      const a = path.join(testDir, "retry-ok.txt");
      let attempts = 0;
      w.files.set(a, {
        content: "data",
        ino: 1,
        close: async () => {
          attempts++;
          if (attempts < 2) {
            throw Object.assign(new Error("transient close error"), { code: "EIO" });
          }
          // Succeeds on 2nd attempt
        },
      });

      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        limits: { ...REVIEW_LIMITS, closeRetryAttempts: 3, closeRetryBackoffMs: 5 },
      });

      const res = await settles(verifier.verify([{ path: a, sha256: sha("data") }]));
      expect(attempts).toBe(2);
      expect(res.results[0].state).toBe("unchanged");
      expect(verifier.liveHandles()).toBe(0);
    });

    // Mutation caught: slot accounting allowing more than 2 live handles when 4 files have rejecting close.
    it("slot accounting never exceeds 2 live handles when 4 files have rejecting close", async () => {
      const w = fakeWorld();
      const paths = ["f1.txt", "f2.txt", "f3.txt", "f4.txt"].map((n) => path.join(testDir, n));
      for (let i = 0; i < paths.length; i++) {
        w.files.set(paths[i]!, {
          content: `data-${i}`,
          ino: i + 1,
          close: async () => {
            throw Object.assign(new Error("EIO on close"), { code: "EIO" });
          },
        });
      }

      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        limits: { ...REVIEW_LIMITS, concurrentFiles: 2, closeRetryAttempts: 2, closeRetryBackoffMs: 5 },
      });

      const files = paths.map((p, i) => ({ path: p, sha256: sha(`data-${i}`) }));
      const res = await settles(verifier.verify(files));

      // First 2 files took the 2 slots; their close failed, so slots stayed occupied.
      // 3rd and 4th files could not acquire a slot and were reported unreadable without opening.
      expect(res.results.map((r: any) => r.state)).toEqual(["unreadable", "unreadable", "unreadable", "unreadable"]);
      expect(w.log.opened).toBe(2);
      expect(w.log.maxLive).toBeLessThanOrEqual(2);
      expect(verifier.liveHandles()).toBe(2);

      // A second pass in the same verifier also cannot open any file because both slots are held
      const p5 = path.join(testDir, "f5.txt");
      w.files.set(p5, { content: "data-5", ino: 5 });
      const res2 = await settles(verifier.verify([{ path: p5, sha256: sha("data-5") }]));
      expect(res2.results[0].state).toBe("unreadable");
      expect(w.log.opened).toBe(2); // f5 was not even opened
      expect(verifier.liveHandles()).toBe(2);
    });
  });
});
