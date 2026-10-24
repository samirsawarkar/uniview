// P14b-1b: regression tests for the six Codex findings and three verification gaps on commit 17bedc0.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { getEventListeners } from "node:events";

// @ts-expect-error plain ESM module without types
import { openReview, createVerifier, decide, REVIEW_LIMITS } from "../../electron/lib/review-verify.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore, writeDecisionNextToReceipt } from "../../electron/lib/review-store.mjs";

function getTempBaseDir(): string {
  return process.platform === "win32" ? "I:\\AES\\tmp" : os.tmpdir();
}

const sha = (s: string) => crypto.createHash("sha256").update(Buffer.from(s)).digest("hex");

/** Fail (instead of hanging the suite) when a promise does not settle. */
function settles(p: Promise<any>, ms = 2000): Promise<any> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("pass did not settle")), ms)),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Entry = {
  ino: number;
  content: string;
  /** Replace the default read implementation. */
  read?: (buf: Buffer, len: number) => Promise<{ bytesRead: number }>;
};

/** An in-memory openAgentPath: no filesystem involved, identity comes from the entry. */
function fakeWorld() {
  const files = new Map<string, Entry>();
  const log = { opened: 0, closed: 0, maxActive: 0, closedPaths: [] as string[] };
  const openAgentPath = async (p: string) => {
    const f = files.get(p);
    if (!f) return { ok: false, code: "not_found" };
    log.opened++;
    log.maxActive = Math.max(log.maxActive, log.opened - log.closed);
    const data = Buffer.from(f.content);
    let pos = 0;
    const handle = {
      read: async (buf: Buffer, _off: number, len: number) => {
        if (f.read) return f.read(buf, len);
        const n = Math.min(len, data.length - pos);
        data.copy(buf, 0, pos, pos + n);
        pos += n;
        return { bytesRead: n };
      },
      close: async () => {
        log.closed++;
        log.closedPaths.push(p);
      },
    };
    return { ok: true, handle, canonical: p, size: data.length, dev: 1n, ino: BigInt(f.ino) };
  };
  return { files, log, openAgentPath };
}

describe("review hardening (P14b-1b)", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(getTempBaseDir(), `review-hard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        agent: { name: "hardening" },
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
  // Finding 1: replacement between view and click
  // ---------------------------------------------------------------------------------------------
  describe("finding 1: replacement identity", () => {
    // Mutation caught: click-time comparison without identity, or `replaced` judged against the latest shown identity.
    it("refuses to approve when the file is replaced again (same bytes) after a replaced view", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "same bytes" }]);
      w.files.set(p, { ino: 1, content: "same bytes" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });

      const opened = await verifier.verify(review.receipt.files);
      w.files.set(p, { ino: 2, content: "same bytes" });
      const shown = await verifier.verify(review.receipt.files, { baseline: opened });
      expect(shown.results[0].state).toBe("replaced");

      w.files.set(p, { ino: 3, content: "same bytes" });
      const store = createDecisionStore({ dir: storeDir, fs });
      const result = await decide({ review, shown, decision: "approved", verifier, store });

      expect(result.ok).toBe(false);
      expect(result.code).toBe("changed");
      expect(await store.hasDecision(review.reviewId)).toBe(false);
    });

    // Mutation caught: baseline identity replaced by the latest pass instead of the first identity seen.
    it("keeps judging replaced against the identity first seen when the review opened", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      w.files.set(p, { ino: 1, content: "x" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const files = [{ path: p, sha256: sha("x") }];

      const first = await verifier.verify(files);
      w.files.set(p, { ino: 2, content: "x" });
      const second = await verifier.verify(files, { baseline: first });
      const third = await verifier.verify(files, { baseline: second });

      expect(second.results[0].state).toBe("replaced");
      expect(third.results[0].state).toBe("replaced");
      // Putting the original object back makes the first identity match again.
      w.files.set(p, { ino: 1, content: "x" });
      const fourth = await verifier.verify(files, { baseline: third });
      expect(fourth.results[0].state).toBe("unchanged");
    });

    // Mutation caught: the success path being broken by the identity check (an untouched, replaced-then-stable file is decidable).
    it("still approves when nothing moved between view and click", async () => {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "x" }]);
      w.files.set(p, { ino: 1, content: "x" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);
      const store = createDecisionStore({ dir: storeDir, fs });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 2: sidecar creation is atomic, create-if-absent, and refuses linked parents
  // ---------------------------------------------------------------------------------------------
  describe("finding 2: sidecar", () => {
    async function receiptIn(dir: string) {
      await fs.mkdir(dir, { recursive: true });
      const receiptPath = path.join(dir, "r.receipt.json");
      await fs.writeFile(receiptPath, "{}");
      return receiptPath;
    }

    /** An fs whose create step (link / copyFile / rename) first lets another review win the race. */
    function racingFs(targetPath: string, other: unknown) {
      const winRace = async () => {
        await fs.writeFile(targetPath, JSON.stringify(other));
      };
      return {
        ...fs,
        link: async (a: string, b: string) => {
          await winRace();
          return fs.link(a, b);
        },
        copyFile: async (a: string, b: string, m?: number) => {
          await winRace();
          return fs.copyFile(a, b, m);
        },
        rename: async (a: string, b: string) => {
          await winRace();
          return fs.rename(a, b);
        },
      };
    }

    // Mutation caught: inspect-then-unconditional-rename (the check is raced; the other review's decision is overwritten).
    it("does not overwrite another review's decision created after the inspection", async () => {
      const receiptPath = await receiptIn(testDir);
      const target = `${receiptPath}.decision.json`;
      const other = makeDecision("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const ok = await writeDecisionNextToReceipt(receiptPath, makeDecision("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), {
        fs: racingFs(target, other),
      });
      expect(ok).toBe(false);
      expect(JSON.parse(await fs.readFile(target, "utf8")).reviewId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect((await fs.readdir(testDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });

    // Mutation caught: treating "same reviewId already present" as a failure (or rewriting it).
    it("reports done when the same review's decision already won the race", async () => {
      const receiptPath = await receiptIn(testDir);
      const target = `${receiptPath}.decision.json`;
      const same = makeDecision("cccccccccccccccccccccccccccccccc", { comment: "first writer" });
      const ok = await writeDecisionNextToReceipt(receiptPath, makeDecision("cccccccccccccccccccccccccccccccc", { comment: "second" }), {
        fs: racingFs(target, same),
      });
      expect(ok).toBe(true);
      expect(JSON.parse(await fs.readFile(target, "utf8")).comment).toBe("first writer");
    });

    // Mutation caught: writing the target directly or renaming over it instead of an exclusive create.
    it("creates the sidecar through fs.link from a temp file, never rename", async () => {
      const receiptPath = await receiptIn(testDir);
      const link = vi.spyOn(fs, "link");
      const rename = vi.spyOn(fs, "rename");
      const ok = await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs });
      expect(ok).toBe(true);
      expect(link).toHaveBeenCalledTimes(1);
      const [from, to] = link.mock.calls[0] as [string, string];
      expect(to).toBe(`${receiptPath}.decision.json`);
      expect(from).not.toBe(to);
      expect(path.dirname(from)).toBe(path.dirname(to));
      expect(rename).not.toHaveBeenCalled();
      expect((await fs.readdir(testDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });

    // Mutation caught: fallback that overwrites (plain copyFile) when hard links are unsupported.
    it("falls back to copyFile with COPYFILE_EXCL when hard links are unsupported", async () => {
      const receiptPath = await receiptIn(testDir);
      const copy = vi.fn((a: string, b: string, m?: number) => fs.copyFile(a, b, m));
      const noLinkFs = {
        ...fs,
        link: async () => {
          throw Object.assign(new Error("no links"), { code: "EPERM" });
        },
        copyFile: copy,
      };
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: noLinkFs })).toBe(true);
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0]![2]).toBe(1); // fs.constants.COPYFILE_EXCL

      // ...and a decision that appears before the copy is not overwritten.
      const receipt2 = await receiptIn(path.join(testDir, "two"));
      const target2 = `${receipt2}.decision.json`;
      await fs.writeFile(target2, JSON.stringify(makeDecision("dddddddddddddddddddddddddddddddd")));
      const ok2 = await writeDecisionNextToReceipt(receipt2, makeDecision("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), {
        fs: { ...noLinkFs, lstat: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } },
      });
      expect(ok2).toBe(false);
      expect(JSON.parse(await fs.readFile(target2, "utf8")).reviewId).toBe("dddddddddddddddddddddddddddddddd");
    });

    // Mutation caught: no parent-directory link check (pathname writes traverse a junction/symlink).
    it("refuses a receipt whose parent directory is a junction or symlink (real filesystem)", async () => {
      const realDir = path.join(testDir, "real");
      await fs.mkdir(realDir, { recursive: true });
      const linkDir = path.join(testDir, "linked");
      try {
        await fs.symlink(realDir, linkDir, "junction");
      } catch (err: any) {
        if (err.code === "EPERM") return;
        throw err;
      }
      const receiptPath = path.join(linkDir, "r.receipt.json");
      await fs.writeFile(path.join(realDir, "r.receipt.json"), "{}");
      const ok = await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs });
      expect(ok).toBe(false);
      expect(await fs.readdir(realDir)).toEqual(["r.receipt.json"]);
    });

    // Mutation caught: parent check skipped (runs on every host through an injected realpath).
    it("refuses when realpath of the parent differs from the resolved directory", async () => {
      const receiptPath = await receiptIn(testDir);
      const link = vi.fn(async () => {});
      const fakeFs = { ...fs, realpath: async () => path.join(testDir, "elsewhere"), link };
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: fakeFs })).toBe(false);
      expect(link).not.toHaveBeenCalled();
    });

    // Mutation caught: case-sensitive comparison on Windows (a plain drive-letter/case difference is not a link).
    it.runIf(process.platform === "win32")("compares the parent case-insensitively on Windows", async () => {
      const receiptPath = await receiptIn(testDir);
      const fakeFs = { ...fs, realpath: async (p: string) => String(p).toUpperCase() };
      expect(await writeDecisionNextToReceipt(receiptPath, makeDecision(), { fs: fakeFs })).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 3: one decision per review
  // ---------------------------------------------------------------------------------------------
  describe("finding 3: one decision per review", () => {
    async function setup(withVerifierWorld = true) {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const review = await makeReview([{ path: p, content: "x" }]);
      if (withVerifierWorld) w.files.set(p, { ino: 1, content: "x" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);
      return { w, p, review, verifier, shown };
    }

    // Mutation caught: the already-decided guard only before the async work (no synchronous claim).
    it("lets exactly one of two concurrent decisions through", async () => {
      const { review, verifier, shown } = await setup();
      const store = createDecisionStore({ dir: storeDir, fs });
      const settled = await Promise.allSettled([
        decide({ review, shown, decision: "approved", verifier, store }),
        decide({ review, shown, decision: "changes_requested", verifier, store }),
      ]);
      const ok = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "already_decided" });
      const stored = await store.load(review.reviewId);
      expect(stored.decision).toBe((ok[0] as PromiseFulfilledResult<any>).value.decision.decision);
    });

    // Mutation caught: no synchronous in-memory claim. The store here is not exclusive (hasDecision always false), so only the claim stops
    // a second concurrent decision from reaching the save.
    it("takes a synchronous claim so two concurrent decisions reach save once", async () => {
      const { review, verifier, shown } = await setup();
      let saves = 0;
      const store = {
        fs,
        claims: new Set<string>(),
        hasDecision: async () => false,
        save: async () => {
          saves++;
          await sleep(20);
        },
        rewrite: async () => {},
      };
      const settled = await Promise.allSettled([
        decide({ review, shown, decision: "approved", verifier, store }),
        decide({ review, shown, decision: "changes_requested", verifier, store }),
      ]);
      expect(saves).toBe(1);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      expect(rejected[0]!.reason).toMatchObject({ code: "already_decided" });
    });

    // Mutation caught: claim never released after a failed attempt (review stuck undecidable).
    it("releases the claim when verification throws or the files changed", async () => {
      const { w, p, review, verifier, shown } = await setup();
      const store = createDecisionStore({ dir: storeDir, fs });

      const boom = { verify: async () => { throw new Error("verifier exploded"); } };
      await expect(decide({ review, shown, decision: "approved", verifier: boom, store })).rejects.toThrow("exploded");

      w.files.set(p, { ino: 1, content: "different" });
      const changed = await decide({ review, shown, decision: "approved", verifier, store });
      expect(changed.ok).toBe(false);

      w.files.set(p, { ino: 1, content: "x" });
      const retry = await decide({ review, shown, decision: "approved", verifier, store });
      expect(retry.ok).toBe(true);
    });

    // Mutation caught: hasDecision using fs.existsSync (absent on node:fs/promises), so a fresh store misses the disk.
    it("a fresh store sees a decision that is already on disk", async () => {
      const first = createDecisionStore({ dir: storeDir, fs });
      await first.save(makeDecision("12121212121212121212121212121212"));
      const fresh = createDecisionStore({ dir: storeDir, fs });
      expect(await fresh.hasDecision("12121212121212121212121212121212")).toBe(true);
      expect(await fresh.hasDecision("34343434343434343434343434343434")).toBe(false);
    });

    // Mutation caught: hasDecision treating an unreadable store (not "no such file") as "no decision", letting a second decision through.
    it("fails closed when the store cannot tell whether a decision exists", async () => {
      const denied = createDecisionStore({
        dir: storeDir,
        fs: { ...fs, access: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } as typeof fs,
      });
      await expect(denied.hasDecision("9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a")).rejects.toMatchObject({ code: "EACCES" });
    });

    // Mutation caught: store records written with an unconditional rename/writeFile (a second decision overwrites the first).
    it("creates store records exclusively and never overwrites an existing record", async () => {
      const store = createDecisionStore({ dir: storeDir, fs });
      await store.save(makeDecision("56565656565656565656565656565656", { decision: "approved" }));
      await expect(store.save(makeDecision("56565656565656565656565656565656", { decision: "dismissed" }))).rejects.toMatchObject({ code: "EEXIST" });
      expect((await store.load("56565656565656565656565656565656")).decision).toBe("approved");
      expect((await fs.readdir(storeDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });

    // Mutation caught: store.save using rename instead of the exclusive link create.
    it("store records are created with fs.link, not rename", async () => {
      const store = createDecisionStore({ dir: storeDir, fs });
      const link = vi.spyOn(fs, "link");
      const rename = vi.spyOn(fs, "rename");
      await store.save(makeDecision("78787878787878787878787878787878"));
      expect(link).toHaveBeenCalledTimes(1);
      expect(rename).not.toHaveBeenCalled();
    });

    // Mutation caught: another process decided first (EEXIST at save) must not become a second persisted decision or a sidecar.
    it("reports already_decided and writes no sidecar when the store record already exists", async () => {
      const { review, verifier, shown } = await setup();
      const receiptPath = path.join(testDir, "r.receipt.json");
      await fs.writeFile(receiptPath, "{}");
      const store = createDecisionStore({ dir: storeDir, fs });
      store.hasDecision = async () => false; // the other process wins between the check and the create
      await fs.writeFile(path.join(storeDir, `${review.reviewId}.json`), JSON.stringify(makeDecision(review.reviewId)));

      await expect(
        decide({ review: { ...review, receiptPath }, shown, decision: "approved", verifier, store }),
      ).rejects.toMatchObject({ code: "already_decided" });
      await expect(fs.access(`${receiptPath}.decision.json`)).rejects.toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 4: read errors and the concurrency bound
  // ---------------------------------------------------------------------------------------------
  describe("finding 4: read errors", () => {
    // Mutation caught: handle.read rejection escaping the per-file operation and rejecting the whole pass.
    it("records a file whose read fails as unreadable and still hashes the others", async () => {
      const w = fakeWorld();
      const a = path.join(testDir, "a.txt");
      const b = path.join(testDir, "b.txt");
      w.files.set(a, {
        ino: 1,
        content: "a",
        read: async () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      });
      w.files.set(b, { ino: 2, content: "b" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const res = await settles(verifier.verify([{ path: a, sha256: sha("a") }, { path: b, sha256: sha("b") }]));
      expect(res.results[0].state).toBe("unreadable");
      expect(res.results[0].observedSha256).toBeNull();
      expect(res.results[1].state).toBe("unchanged");
      expect(w.log.opened).toBe(w.log.closed);
    });

    // Mutation caught: Promise.all rejecting early so the queue advances while a sibling handle is still open.
    it("never holds more than two handles after an EIO beside a blocked sibling, and the pass settles last", async () => {
      const w = fakeWorld();
      const paths = [0, 1, 2, 3].map((i) => path.join(testDir, `f${i}.txt`));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      paths.forEach((p, i) => {
        const entry: Entry = { ino: i + 1, content: `c${i}` };
        if (i === 0) entry.read = async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
        if (i === 1) entry.read = async () => { await gate; return { bytesRead: 0 }; };
        w.files.set(p, entry);
      });
      const files = paths.map((p, i) => ({ path: p, sha256: sha(`c${i}`) }));
      const verifier = createVerifier({ openAgentPath: w.openAgentPath, limits: { ...REVIEW_LIMITS, concurrentFiles: 2 } });

      let firstSettled = false;
      const pass1 = verifier.verify(files).then(
        (v: any) => { firstSettled = true; return v; },
        (e: unknown) => { firstSettled = true; return { rejected: e }; },
      );
      const pass2 = verifier.verify(files).catch((e: unknown) => ({ rejected: e }));
      await sleep(60);
      expect(firstSettled).toBe(false);
      expect(w.log.opened - w.log.closed).toBeLessThanOrEqual(2);

      release();
      const [r1, r2] = await settles(Promise.all([pass1, pass2]));
      expect(r1.rejected).toBeUndefined();
      expect(r2.rejected).toBeUndefined();
      expect(r1.results[0].state).toBe("unreadable");
      expect(w.log.maxActive).toBeLessThanOrEqual(2);
      expect(w.log.opened).toBe(w.log.closed);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 5: deadline and abort end pending reads
  // ---------------------------------------------------------------------------------------------
  describe("finding 5: deadline, abort and listeners", () => {
    function hangingWorld(p: string) {
      const w = fakeWorld();
      let started!: () => void;
      const readStarted = new Promise<void>((r) => (started = r));
      w.files.set(p, {
        ino: 1,
        content: "x",
        read: () => {
          started();
          return new Promise(() => {}); // never completes
        },
      });
      return { w, readStarted };
    }

    // Mutation caught: no race between a pending read and the abort signal (pass hangs, handle stays open).
    it("abort ends a pending read, marks the file unreadable and closes the handle", async () => {
      const p = path.join(testDir, "a.txt");
      const { w, readStarted } = hangingWorld(p);
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const ac = new AbortController();
      const pass = verifier.verify([{ path: p, sha256: sha("x") }], { signal: ac.signal });
      await readStarted;
      ac.abort();
      const res = await settles(pass);
      expect(res.results[0].state).toBe("unreadable");
      expect(w.log.closed).toBe(1);
    });

    // Mutation caught: deadline only checked between reads (a stalled read outlives the deadline).
    it("the deadline ends a pending read as too_large and closes the handle", async () => {
      const p = path.join(testDir, "a.txt");
      const { w, readStarted } = hangingWorld(p);
      let t = 1_000_000;
      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        now: () => t,
        limits: { ...REVIEW_LIMITS, passDeadlineMs: 1000, deadlineTickMs: 5 },
      });
      const pass = verifier.verify([{ path: p, sha256: sha("x") }]);
      await readStarted;
      t += 5000;
      const res = await settles(pass);
      expect(res.results[0].state).toBe("too_large");
      expect(res.results[0].observedSha256).toBeNull();
      expect(w.log.closed).toBe(1);
    });

    // Mutation caught: no deadline check after EOF (a file finished after the deadline reports unchanged).
    it("a read that reaches EOF after the deadline is too_large, not unchanged", async () => {
      const p = path.join(testDir, "a.txt");
      const w = fakeWorld();
      let t = 1_000_000;
      w.files.set(p, {
        ino: 1,
        content: "",
        read: async () => {
          t += 5000;
          return { bytesRead: 0 };
        },
      });
      const verifier = createVerifier({
        openAgentPath: w.openAgentPath,
        now: () => t,
        limits: { ...REVIEW_LIMITS, passDeadlineMs: 1000 },
      });
      const res = await verifier.verify([{ path: p, sha256: sha("") }]);
      expect(res.results[0].state).toBe("too_large");
    });

    // Mutation caught: abort listeners left attached after a pass ends.
    it("removes its abort listener when a pass ends", async () => {
      const p = path.join(testDir, "a.txt");
      const w = fakeWorld();
      w.files.set(p, { ino: 1, content: "x" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const ac = new AbortController();
      for (let i = 0; i < 3; i++) {
        await verifier.verify([{ path: p, sha256: sha("x") }], { signal: ac.signal });
      }
      expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Finding 6: returned decision, store copy and sidecar agree
  // ---------------------------------------------------------------------------------------------
  describe("finding 6: persisted flag agreement", () => {
    async function setup(extraFs?: Record<string, unknown>) {
      const w = fakeWorld();
      const p = path.join(testDir, "a.txt");
      const receiptPath = path.join(testDir, "r.receipt.json");
      await fs.writeFile(receiptPath, "{}");
      const review = await makeReview([{ path: p, content: "x" }], receiptPath);
      w.files.set(p, { ino: 1, content: "x" });
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const shown = await verifier.verify(review.receipt.files);
      const store = createDecisionStore({ dir: storeDir, fs: { ...fs, ...extraFs } as typeof fs });
      return { review, verifier, shown, store, receiptPath };
    }

    // Mutation caught: sidecar serialized before `persisted` is set to true.
    it("returned decision, store copy and sidecar are identical when everything persisted", async () => {
      const { review, verifier, shown, store, receiptPath } = await setup();
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(true);
      const sidecar = JSON.parse(await fs.readFile(`${receiptPath}.decision.json`, "utf8"));
      const stored = await store.load(review.reviewId);
      expect(sidecar).toEqual(result.decision);
      expect(stored).toEqual(result.decision);
    });

    // Mutation caught: leaving the store copy at persisted true after the sidecar failed.
    it("when the sidecar fails, the store copy is rewritten with persisted false and false is returned", async () => {
      const failSidecar = async (a: string, b: string, ...rest: unknown[]) => {
        if (String(b).endsWith(".decision.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return (fs.link as any)(a, b, ...rest);
      };
      const { review, verifier, shown, store, receiptPath } = await setup({
        link: failSidecar,
        copyFile: async (a: string, b: string, m?: number) => {
          if (String(b).endsWith(".decision.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return fs.copyFile(a, b, m);
        },
      });
      const result = await decide({ review, shown, decision: "approved", verifier, store });
      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(false);
      expect((await store.load(review.reviewId)).persisted).toBe(false);
      await expect(fs.access(`${receiptPath}.decision.json`)).rejects.toBeTruthy();
    });

    // Mutation caught: sidecar written before (or despite) a failed store save.
    it("when the store save fails, no sidecar is written and false is returned", async () => {
      const { review, verifier, shown, receiptPath } = await setup();
      const failingStore = {
        fs,
        claims: new Set<string>(),
        hasDecision: async () => false,
        save: async () => {
          throw new Error("disk full");
        },
        rewrite: async () => {},
      };
      const result = await decide({ review, shown, decision: "approved", verifier, store: failingStore });
      expect(result.ok).toBe(true);
      expect(result.decision.persisted).toBe(false);
      await expect(fs.access(`${receiptPath}.decision.json`)).rejects.toBeTruthy();
    });

    // Mutation caught: writing the sidecar before the store.
    it("saves the store record first, then the sidecar", async () => {
      const { review, verifier, shown, receiptPath } = await setup();
      const order: string[] = [];
      const real = createDecisionStore({ dir: storeDir, fs });
      const store = {
        ...real,
        save: async (d: unknown) => {
          order.push("store");
          return real.save(d);
        },
        fs: {
          ...fs,
          link: async (a: string, b: string) => {
            if (String(b).endsWith(".decision.json")) order.push("sidecar");
            return fs.link(a, b);
          },
        },
      };
      await decide({ review, shown, decision: "approved", verifier, store });
      expect(order).toEqual(["store", "sidecar"]);
      await fs.access(`${receiptPath}.decision.json`);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Gaps: production defaults and no reopening of the path
  // ---------------------------------------------------------------------------------------------
  describe("verification gaps", () => {
    // Mutation caught: changing any production limit default.
    it("pins the production verification limits", () => {
      expect(REVIEW_LIMITS).toEqual({
        maxBytesPerPass: 8 * 1024 * 1024 * 1024,
        passDeadlineMs: 120_000,
        concurrentFiles: 2,
        queuedVerifications: 4,
        chunkBytes: 1024 * 1024,
      });
      const verifier = createVerifier({ openAgentPath: async () => ({ ok: false, code: "not_found" }) });
      expect(verifier.limits).toMatchObject({
        maxBytesPerPass: 8_589_934_592,
        passDeadlineMs: 120_000,
        concurrentFiles: 2,
        queuedVerifications: 4,
        chunkBytes: 1_048_576,
      });
    });

    // Mutation caught: a per-key fallback in createVerifier that differs from REVIEW_LIMITS (a caller giving partial or empty limits).
    it("fills missing limit keys from the production defaults", () => {
      const open = async () => ({ ok: false, code: "not_found" });
      const expected = {
        maxBytesPerPass: 8_589_934_592,
        passDeadlineMs: 120_000,
        concurrentFiles: 2,
        queuedVerifications: 4,
        chunkBytes: 1_048_576,
      };
      expect(createVerifier({ openAgentPath: open, limits: {} }).limits).toMatchObject(expected);
      expect(createVerifier({ openAgentPath: open, limits: null }).limits).toMatchObject(expected);
      expect(createVerifier({ openAgentPath: open, limits: { concurrentFiles: 1 } }).limits).toMatchObject({ ...expected, concurrentFiles: 1 });
    });

    // Mutation caught: createVerifier defaults diverging from REVIEW_LIMITS (concurrency, queue, deadline, chunk).
    it("applies the production defaults when no limits are given", async () => {
      // chunk size and concurrency
      const w = fakeWorld();
      const paths = [0, 1, 2, 3, 4, 5].map((i) => path.join(testDir, `d${i}.txt`));
      const lens: number[] = [];
      let active = 0;
      let maxActive = 0;
      paths.forEach((p, i) =>
        w.files.set(p, {
          ino: i + 1,
          content: "",
          read: async (_b, len) => {
            lens.push(len);
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(15);
            active--;
            return { bytesRead: 0 };
          },
        }),
      );
      const v = createVerifier({ openAgentPath: w.openAgentPath });
      await v.verify(paths.map((p) => ({ path: p, sha256: sha("") })));
      expect(new Set(lens)).toEqual(new Set([1024 * 1024]));
      expect(maxActive).toBe(2);

      // queue depth 4: the 6th concurrent request is the first one refused
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const q = createVerifier({ openAgentPath: async () => { await gate; return { ok: false, code: "not_found" }; } });
      const calls = [1, 2, 3, 4, 5].map(() => q.verify([{ path: paths[0], sha256: sha("") }]));
      await expect(q.verify([{ path: paths[0], sha256: sha("") }])).rejects.toMatchObject({ code: "busy" });
      release();
      await Promise.all(calls);

      // deadline 120 s: 119 s is fine, 121 s is not
      for (const [elapsed, state] of [[119_000, "unchanged"], [121_000, "too_large"]] as const) {
        let t = 5_000_000;
        const dw = fakeWorld();
        dw.files.set(paths[0]!, {
          ino: 1,
          content: "",
          read: async () => {
            t += elapsed;
            return { bytesRead: 0 };
          },
        });
        const dv = createVerifier({ openAgentPath: dw.openAgentPath, now: () => t });
        const r = await dv.verify([{ path: paths[0]!, sha256: sha("") }]);
        expect(r.results[0].state).toBe(state);
      }
    });

    // Mutation caught: changing the store retention defaults (500 entries / 30 days).
    it("pins the store retention defaults: 500 entries and 30 days", async () => {
      const fakeNow = 1_800_000_000_000;
      const day = 24 * 60 * 60 * 1000;
      const put = (dir: string, id: string, ageMs: number) =>
        fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(makeDecision(id, { decidedAt: new Date(fakeNow - ageMs).toISOString() })));
      const store = createDecisionStore({ dir: storeDir, fs, now: () => fakeNow });
      expect(store.limits).toEqual({ max: 500, ttlDays: 30 });

      // 30-day ttl: 31 days old goes, 29 days old stays.
      await put(storeDir, "b".repeat(32), 31 * day);
      await put(storeDir, "c".repeat(32), 29 * day);
      await store.save(makeDecision("d".repeat(32), { decidedAt: new Date(fakeNow).toISOString() }));
      let left = (await fs.readdir(storeDir)).filter((n) => n.endsWith(".json"));
      expect(left.sort()).toEqual([`${"c".repeat(32)}.json`, `${"d".repeat(32)}.json`]);

      // 500 cap: 500 recent records + 1 new one leaves exactly 500 and drops the oldest.
      const bigDir = path.join(testDir, "big");
      await fs.mkdir(bigDir, { recursive: true });
      const bigStore = createDecisionStore({ dir: bigDir, fs, now: () => fakeNow });
      const ids = Array.from({ length: 500 }, (_, i) => `a${String(i).padStart(31, "0")}`);
      await Promise.all(ids.map((id, i) => put(bigDir, id, 1000 + (500 - i) * 1000))); // ids[0] is the oldest
      await bigStore.save(makeDecision("e".repeat(32), { decidedAt: new Date(fakeNow).toISOString() }));
      left = (await fs.readdir(bigDir)).filter((n) => n.endsWith(".json"));
      expect(left).toHaveLength(500);
      expect(left).not.toContain(`${ids[0]}.json`);
      expect(left).toContain(`${ids[1]}.json`);
      expect(left).toContain(`${"e".repeat(32)}.json`);
    }, 60_000);

    // Mutation caught: hashing reopening the path (a second fs.open) instead of reading through the policy handle.
    it("never reopens the path while hashing", async () => {
      const p = path.join(testDir, "never-on-disk.txt");
      const w = fakeWorld();
      w.files.set(p, { ino: 1, content: "in memory only" });
      const open = vi.spyOn(fs, "open");
      const verifier = createVerifier({ openAgentPath: w.openAgentPath });
      const res = await verifier.verify([{ path: p, sha256: sha("in memory only") }]);
      expect(res.results[0].state).toBe("unchanged");
      expect(open.mock.calls.filter((c) => String(c[0]) === p)).toEqual([]);
    });
  });
});
