import { describe, it, expect } from "vitest";
import {
  createReferenceResolver,
  nextCompanionId,
  LanNotFoundError,
  type LanContext,
  type CompanionFile,
  type LanReader,
} from "../../src/core/receipt-resolve";
import { WEB_HASH_LIMITS } from "../../src/core/receipt-verify-web";
import { sha256Hex } from "../../shared/receipt.mjs";

describe("receipt-resolve reference resolver", () => {
  const lan: LanContext = { hostId: "h1", rootId: "r1", receiptPath: "dir/task.receipt.json" };
  const bytes = (t: string) => new TextEncoder().encode(t).buffer.slice(0) as ArrayBuffer;
  const comp = (name: string, text: string): CompanionFile => ({
    id: nextCompanionId(),
    name,
    size: text.length,
    handle: { size: text.length, arrayBuffer: async () => bytes(text) },
  });

  it("gives every companion id a distinct value", () => {
    // Mutation: ids derived from Date.now() and the batch index collide across two picks in one millisecond
    const ids = new Set(Array.from({ length: 1000 }, () => nextCompanionId()));
    expect(ids.size).toBe(1000);
  });

  it("resolves a LAN reference through the reader and not through companions", async () => {
    // Mutation: ignoring the LAN reader and returning null for resolved LAN paths
    const opened: string[] = [];
    const lanReader: LanReader = {
      open: async (p) => {
        opened.push(p);
        return { size: 3, readAll: async () => bytes("abc") };
      },
    };
    const resolve = createReferenceResolver({ lan, lanReader, companions: [comp("x.txt", "zzz")], budget: { used: 0 } });
    const out = await resolve({ key: "k", path: "/abs/x.txt", relPath: "files/x.txt" });
    expect(opened).toEqual(["dir/files/x.txt"]);
    expect(out.status).toBe("found");
    if (out.status === "found") {
      expect(out.via).toBe("lan");
      expect(out.size).toBe(3);
      expect(new TextDecoder().decode(await out.read())).toBe("abc");
    }
  });

  it("uses the base path (the spec's folder) for LAN references inside a view", async () => {
    // Mutation: resolving a view's images against the receipt folder instead of the view's folder
    const opened: string[] = [];
    const lanReader: LanReader = {
      open: async (p) => {
        opened.push(p);
        return { size: 0, readAll: async () => new ArrayBuffer(0) };
      },
    };
    const resolve = createReferenceResolver({ lan, lanReader, companions: [], budget: { used: 0 } });
    await resolve({ key: "img", path: "/a/pic.png", relPath: "pic.png" }, "dir/views/v.uview.json");
    expect(opened).toEqual(["dir/views/pic.png"]);
  });

  it("reports missing when the share does not have the file and does not touch companions", async () => {
    // Mutation: treating LanNotFoundError as unreadable (or falling through to a same-named companion)
    const lanReader: LanReader = {
      open: async () => {
        throw new LanNotFoundError();
      },
    };
    const resolve = createReferenceResolver({ lan, lanReader, companions: [comp("x.txt", "zzz")], budget: { used: 0 } });
    const out = await resolve({ key: "k", path: "/abs/x.txt", relPath: "x.txt" });
    expect(out.status).toBe("missing");
  });

  it("rejects when the LAN read fails for another reason (caller reports unreadable)", async () => {
    // Mutation: swallowing LAN transport errors as missing
    const lanReader: LanReader = {
      open: async () => {
        throw new Error("host stopped responding");
      },
    };
    const resolve = createReferenceResolver({ lan, lanReader, companions: [], budget: { used: 0 } });
    await expect(resolve({ key: "k", path: "/abs/x.txt", relPath: "x.txt" })).rejects.toThrow("stopped responding");
  });

  it("never falls through to companions or the reader for an escaping, absolute or unsafe LAN relPath", async () => {
    // Mutation: falling back to name-matched companions when resolveLanPath says missing
    let reads = 0;
    const lanReader: LanReader = {
      open: async () => {
        reads++;
        return { size: 0, readAll: async () => new ArrayBuffer(0) };
      },
    };
    const resolve = createReferenceResolver({ lan, lanReader, companions: [comp("x.txt", "zzz")], budget: { used: 0 } });
    for (const rel of ["../../x.txt", "/x.txt", "C:\\x.txt", "\\\\srv\\sh\\x.txt", ".. /x.txt", "a\u0000/x.txt"]) {
      const out = await resolve({ key: "k", path: "/abs/x.txt", relPath: rel });
      expect(out.status, rel).toBe("missing");
    }
    expect(reads).toBe(0);
  });

  it("throws (unreadable) when the receipt came from a LAN folder but no reader is available", async () => {
    // Mutation: treating a missing reader as 'missing' and hiding that the LAN read could not happen
    const resolve = createReferenceResolver({ lan, lanReader: null, companions: [], budget: { used: 0 } });
    await expect(resolve({ key: "k", path: "/p/x.txt", relPath: "x.txt" })).rejects.toThrow();
  });

  it("matches a lone companion by name without reading it", async () => {
    // Mutation: reading or hashing a companion that has a unique name
    let reads = 0;
    const c: CompanionFile = {
      id: nextCompanionId(),
      name: "a.txt",
      size: 5,
      handle: {
        size: 5,
        arrayBuffer: async () => {
          reads++;
          return bytes("hello");
        },
      },
    };
    const resolve = createReferenceResolver({ companions: [c], budget: { used: 0 } });
    const out = await resolve({ key: "k", path: "/w/a.txt", sha256: "0".repeat(64) });
    expect(out.status).toBe("found");
    expect(reads).toBe(0);
  });

  it("tells same-named companions apart by hash and charges them to the budget once", async () => {
    // Mutation: matching duplicates without hashing them (the hash tie-break never applies)
    const good = await sha256Hex(new TextEncoder().encode("hello"));
    const a = comp("a.txt", "tampered");
    const b = comp("a.txt", "hello");
    const budget = { used: 0 };
    const resolve = createReferenceResolver({ companions: [a, b], budget });
    const out = await resolve({ key: "k", path: "/w/a.txt", sha256: good });
    expect(out.status).toBe("found");
    if (out.status === "found") {
      expect(out.size).toBe(5);
      expect(out.prehashed).toBe(true);
      expect(await out.digestHex!()).toBe(good);
    }
    expect(budget.used).toBe(8 + 5);
    // Same pass, same file again: no second charge.
    await resolve({ key: "k2", path: "/w/a.txt", sha256: good });
    expect(budget.used).toBe(8 + 5);
  });

  it("is ambiguous when duplicates share the hash or none match", async () => {
    // Mutation: picking the first duplicate when the hash does not single one out
    const good = await sha256Hex(new TextEncoder().encode("hello"));
    const two = createReferenceResolver({
      companions: [comp("a.txt", "hello"), comp("a.txt", "hello")],
      budget: { used: 0 },
    });
    const o1 = await two({ key: "k", path: "/w/a.txt", sha256: good });
    expect(o1.status).toBe("ambiguous");
    const none = createReferenceResolver({
      companions: [comp("a.txt", "x1"), comp("a.txt", "x2")],
      budget: { used: 0 },
    });
    const o2 = await none({ key: "k", path: "/w/a.txt", sha256: good });
    expect(o2.status).toBe("ambiguous");
  });

  it("returns the file the person chose for an ambiguous reference", async () => {
    // Mutation: ignoring the person's choice
    const a = comp("a.txt", "one");
    const b = comp("a.txt", "two");
    const resolve = createReferenceResolver({ companions: [a, b], chosen: { k: b }, budget: { used: 0 } });
    const out = await resolve({ key: "k", path: "/w/a.txt", sha256: "f".repeat(64) });
    expect(out.status).toBe("found");
    if (out.status === "found") expect(new TextDecoder().decode(await out.read())).toBe("two");
  });

  it("does not hash a duplicate larger than 256 MiB, at limit and limit+1", async () => {
    // Mutation: off-by-one (or no check) on the per-file hashing limit when telling duplicates apart
    const big = async (size: number) => {
      let reads = 0;
      const mk = (s: number): CompanionFile => ({
        id: nextCompanionId(),
        name: "big.bin",
        size: s,
        handle: {
          size: s,
          arrayBuffer: async () => {
            reads++;
            return new ArrayBuffer(0);
          },
        },
      });
      // A second, tiny duplicate makes the name ambiguous so both are considered; each case has its own budget.
      const resolve = createReferenceResolver({ companions: [mk(size), comp("big.bin", "x")], budget: { used: 0 } });
      await resolve({ key: "k", path: "/w/big.bin", sha256: "a".repeat(64) });
      return reads;
    };
    expect(await big(WEB_HASH_LIMITS.MAX_FILE_BYTES)).toBe(1);
    expect(await big(WEB_HASH_LIMITS.MAX_FILE_BYTES + 1)).toBe(0);
  });

  it("stops hashing duplicates once the 512 MiB receipt budget would be exceeded, at limit and limit+1", async () => {
    // Mutation: hashing duplicates without charging or checking the per-receipt budget
    const half = WEB_HASH_LIMITS.MAX_RECEIPT_BYTES / 2;
    const reads: string[] = [];
    const mk = (id: string, size: number): CompanionFile => ({
      id: nextCompanionId(),
      name: "d.bin",
      size,
      handle: {
        size,
        arrayBuffer: async () => {
          reads.push(id);
          return new ArrayBuffer(0);
        },
      },
    });
    const resolve = createReferenceResolver({
      companions: [mk("first", half), mk("second", half), mk("third", 1)],
      budget: { used: 0 },
    });
    await resolve({ key: "k", path: "/w/d.bin", sha256: "a".repeat(64) });
    // Exactly 512 MiB hashed; the 1-byte file would be the +1.
    expect(reads).toEqual(["first", "second"]);
  });

  it("serialises duplicate hashing (one file at a time)", async () => {
    // Mutation: hashing the duplicates with Promise.all
    let inFlight = 0;
    let max = 0;
    const mk = (): CompanionFile => ({
      id: nextCompanionId(),
      name: "s.txt",
      size: 2,
      handle: {
        size: 2,
        arrayBuffer: async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return bytes("ab");
        },
      },
    });
    const resolve = createReferenceResolver({ companions: [mk(), mk(), mk()], budget: { used: 0 } });
    await resolve({ key: "k", path: "/w/s.txt", sha256: "a".repeat(64) });
    expect(max).toBe(1);
  });

  it("stops hashing when the pass is aborted", async () => {
    // Mutation: continuing to hash duplicates after the pass was cancelled
    const ac = new AbortController();
    let reads = 0;
    const mk = (): CompanionFile => ({
      id: nextCompanionId(),
      name: "s.txt",
      size: 2,
      handle: {
        size: 2,
        arrayBuffer: async () => {
          reads++;
          ac.abort();
          return bytes("ab");
        },
      },
    });
    const resolve = createReferenceResolver({
      companions: [mk(), mk(), mk()],
      budget: { used: 0 },
      signal: ac.signal,
    });
    await expect(resolve({ key: "k", path: "/w/s.txt", sha256: "a".repeat(64) })).rejects.toThrow();
    expect(reads).toBe(1);
  });
});
