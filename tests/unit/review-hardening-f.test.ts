// P17b-1c: regression tests for Codex findings round 3 on review store and placement check.
// Finding A: NEVER unlink the sidecar target by pathname after a failed placement/ancestor check.
// If the post-create verification fails, leave whatever we created where it is, return persisted:false
// with a sidecar_unverified note, and remove only the temp file we created in the temp name.
// An injected fs that redirects ancestors both BEFORE and AFTER the ownership read must never see an unlink
// of the target pathname (assert zero unlink calls on any non-temp path).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// @ts-expect-error plain ESM module without types
import { openReview, createVerifier, decide } from "../../electron/lib/review-verify.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore, writeDecisionNextToReceipt } from "../../electron/lib/review-store.mjs";
import { tmpBase } from "./helpers/tmp-base";

const sha = (s: string) => crypto.createHash("sha256").update(Buffer.from(s)).digest("hex");

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

describe("review hardening f (P17b-1c Finding A)", () => {
  let testDir: string;
  let storeDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpBase(), `review-hard-f-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        agent: { name: "hardening-f" },
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

  it("ancestor redirect BEFORE ownership read never unlinks target pathname (zero non-temp unlinks)", async () => {
    // Mutation caught: unlinking targetPath after failed placement check when ancestor redirected before read
    const dirA = path.join(testDir, "dirA");
    const dirB = path.join(testDir, "dirB");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const unlinkedPaths: string[] = [];
    let created = false;

    const trackingFs = {
      ...fs,
      unlink: async (p: any) => {
        unlinkedPaths.push(String(p));
        return fs.unlink(p);
      },
      link: async (from: string, to: string) => {
        const res = await fs.link(from, to);
        if (String(to).endsWith(".decision.json")) created = true;
        return res;
      },
      copyFile: async (from: string, to: string, mode?: number) => {
        const res = await fs.copyFile(from, to, mode);
        if (String(to).endsWith(".decision.json")) created = true;
        return res;
      },
      realpath: async (p: string) => {
        const real = await fs.realpath(p);
        // Ancestor redirected immediately upon creation (before ownership read)
        if (created && (String(p).endsWith(".decision.json") || p === dirA)) {
          return path.join(dirB, path.basename(p));
        }
        return real;
      },
    };

    const receiptPath = path.join(dirA, "target.receipt.json");
    await fs.writeFile(receiptPath, "{}");

    const decision = makeDecision("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const outcomeOut: { note?: string } = {};

    const outcome = await writeDecisionNextToReceipt(receiptPath, decision, {
      fs: trackingFs as any,
      outcome: outcomeOut,
    });

    expect(outcome).toBe(false);
    expect(outcomeOut.note).toBe("sidecar_unverified");

    // The target sidecar pathname must NEVER be unlinked!
    const nonTempUnlinks = unlinkedPaths.filter((p) => {
      const base = path.basename(p);
      return !(base.startsWith(".tmp-") && base.endsWith(".tmp"));
    });
    expect(nonTempUnlinks).toHaveLength(0);

    // The sidecar file created in dirA must survive untouched
    const createdSidecar = `${receiptPath}.decision.json`;
    const surviving = await fs.readFile(createdSidecar, "utf8");
    expect(JSON.parse(surviving).reviewId).toBe(decision.reviewId);
  });

  it("ancestor redirect AFTER ownership read never unlinks target pathname (zero non-temp unlinks)", async () => {
    // Mutation caught: unlinking targetPath after ownership read verification, which can be redirected between read and unlink
    const dirA = path.join(testDir, "dirA_after");
    const dirB = path.join(testDir, "dirB_after");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const unlinkedPaths: string[] = [];
    let created = false;
    let readDone = false;

    const trackingFs = {
      ...fs,
      readFile: async (p: any, enc: any) => {
        const res = await fs.readFile(p, enc);
        if (String(p).endsWith(".decision.json")) {
          readDone = true;
        }
        return res;
      },
      unlink: async (p: any) => {
        unlinkedPaths.push(String(p));
        return fs.unlink(p);
      },
      link: async (from: string, to: string) => {
        const res = await fs.link(from, to);
        if (String(to).endsWith(".decision.json")) created = true;
        return res;
      },
      copyFile: async (from: string, to: string, mode?: number) => {
        const res = await fs.copyFile(from, to, mode);
        if (String(to).endsWith(".decision.json")) created = true;
        return res;
      },
      realpath: async (p: string) => {
        const real = await fs.realpath(p);
        if (created && (String(p).endsWith(".decision.json") || p === dirA)) {
          return path.join(dirB, path.basename(p));
        }
        return real;
      },
    };

    const receiptPath = path.join(dirA, "target2.receipt.json");
    await fs.writeFile(receiptPath, "{}");

    const decision = makeDecision("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const outcomeOut: { note?: string } = {};

    const outcome = await writeDecisionNextToReceipt(receiptPath, decision, {
      fs: trackingFs as any,
      outcome: outcomeOut,
    });

    expect(outcome).toBe(false);
    expect(outcomeOut.note).toBe("sidecar_unverified");

    // Zero unlink calls on any non-temp path
    const nonTempUnlinks = unlinkedPaths.filter((p) => {
      const base = path.basename(p);
      return !(base.startsWith(".tmp-") && base.endsWith(".tmp"));
    });
    expect(nonTempUnlinks).toHaveLength(0);

    const createdSidecar = `${receiptPath}.decision.json`;
    const surviving = await fs.readFile(createdSidecar, "utf8");
    expect(JSON.parse(surviving).reviewId).toBe(decision.reviewId);
  });

  it("decide reports persisted:false with note sidecar_unverified and leaves decision on disk without unlinking target", async () => {
    // Mutation caught: decide failing to return sidecar_unverified note or trying to unlink target when placement fails
    const dirA = path.join(testDir, "dirA_decide");
    const dirB = path.join(testDir, "dirB_decide");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const unlinkedPaths: string[] = [];
    let created = false;

    const trackingFs = {
      ...fs,
      link: async (from: string, to: string) => {
        const res = await fs.link(from, to);
        if (String(to).endsWith(".decision.json")) created = true;
        return res;
      },
      copyFile: async (from: string, to: string, mode?: number) => {
        const res = await fs.copyFile(from, to, mode);
        if (String(to).endsWith(".decision.json")) created = true;
        return res;
      },
      unlink: async (p: any) => {
        unlinkedPaths.push(String(p));
        return fs.unlink(p);
      },
      realpath: async (p: string) => {
        const real = await fs.realpath(p);
        if (created && (String(p).endsWith(".decision.json") || p === dirA)) {
          return path.join(dirB, path.basename(p));
        }
        return real;
      },
    };

    const w = fakeWorld();
    const filePath = path.join(testDir, "file.txt");
    const receiptPath = path.join(dirA, "sample.receipt.json");
    await fs.writeFile(receiptPath, "{}");

    const review = await makeReview([{ path: filePath, content: "ok" }], receiptPath);
    w.files.set(filePath, { content: "ok", ino: 1 });
    const verifier = createVerifier({ openAgentPath: w.openAgentPath });
    const shown = await verifier.verify(review.receipt.files);

    const store = createDecisionStore({ dir: storeDir, fs: trackingFs as any });
    const result = await decide({ review, shown, decision: "approved", verifier, store });

    expect(result.ok).toBe(true);
    expect(result.decision.persisted).toBe(false);
    expect(result.note).toBe("sidecar_unverified");

    // Zero unlinks of any non-temp path
    const nonTempUnlinks = unlinkedPaths.filter((p) => {
      const base = path.basename(p);
      return !(base.startsWith(".tmp-") && base.endsWith(".tmp"));
    });
    expect(nonTempUnlinks).toHaveLength(0);

    // The sidecar file created in dirA is left as is
    const createdSidecar = `${receiptPath}.decision.json`;
    const surviving = await fs.readFile(createdSidecar, "utf8");
    expect(JSON.parse(surviving).reviewId).toBe(review.reviewId);
  });
});
