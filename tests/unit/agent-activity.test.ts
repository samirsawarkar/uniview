import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { createActivityLog, createFileActivityStore, ACTIVITY_LIMITS } from "../../electron/lib/agent-activity.mjs";

const DAY = 24 * 60 * 60 * 1000;

function memoryStore(initial: unknown[] = []) {
  const saves: unknown[][] = [];
  return {
    saves,
    async load() {
      return initial;
    },
    async save(entries: unknown[]) {
      saves.push(entries);
    },
  };
}

function clock(start = Date.parse("2026-10-24T12:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

describe("agent activity log", () => {
  it("states the spec limits: 500 entries, 30 days", () => {
    // Mutation: changing either limit constant
    expect(ACTIVITY_LIMITS).toEqual({ max: 500, ttlDays: 30 });
  });

  it("records type, session, client and detail with the clock's time", async () => {
    // Mutation: dropping a field or stamping with the wall clock instead of the injected one
    const c = clock();
    const log = createActivityLog({ store: memoryStore(), now: c.now });
    log.add({ type: "open", sessionId: "s1", client: "Claude Code", detail: "2 files" });
    expect(log.list()).toEqual([
      { at: "2026-10-24T12:00:00.000Z", type: "open", sessionId: "s1", client: "Claude Code", detail: "2 files" },
    ]);
  });

  it("keeps exactly 500 entries (limit) and drops only the oldest at 501 (limit + 1)", async () => {
    // Mutation: off-by-one in the cap (keeping 499 or 501), or dropping the newest instead of the oldest
    const c = clock();
    const log = createActivityLog({ store: memoryStore(), now: c.now });
    for (let i = 0; i < 500; i++) {
      log.add({ type: "t", detail: `n${i}` });
      c.advance(1);
    }
    expect(log.list()).toHaveLength(500);
    expect(log.list()[0].detail).toBe("n0");
    log.add({ type: "t", detail: "n500" });
    const list = log.list();
    expect(list).toHaveLength(500);
    expect(list[0].detail).toBe("n1");
    expect(list[499].detail).toBe("n500");
  });

  it("an entry exactly 30 days old is kept (limit); 1 ms older is dropped (limit + 1)", async () => {
    // Mutation: comparing with >= instead of > (or using 29/31 days)
    const c = clock();
    const log = createActivityLog({ store: memoryStore(), now: c.now });
    log.add({ type: "old" });
    c.advance(30 * DAY);
    expect(log.list().map((e: any) => e.type)).toEqual(["old"]);
    c.advance(1);
    expect(log.list()).toEqual([]);
  });

  it("expired entries are also pruned when a new entry is added", async () => {
    // Mutation: pruning only in list()
    const c = clock();
    const store = memoryStore();
    const log = createActivityLog({ store, now: c.now });
    log.add({ type: "old" });
    c.advance(30 * DAY + 1);
    log.add({ type: "new" });
    await log.flush();
    expect((store.saves.at(-1) as any[]).map((e) => e.type)).toEqual(["new"]);
  });

  it("load keeps the newest 500 of a larger stored list and drops expired and malformed entries", async () => {
    // Mutation: trusting the stored file (no cap / no ttl / no shape check)
    const c = clock();
    const stored: unknown[] = [
      { at: new Date(c.now() - 31 * DAY).toISOString(), type: "expired" },
      null,
      "x",
      { type: "no-time" },
      { at: "garbage", type: "bad-time" },
      { at: new Date(c.now()).toISOString() },
    ];
    for (let i = 0; i < 501; i++) stored.push({ at: new Date(c.now() - 1000 + i).toISOString(), type: "t", detail: `n${i}` });
    const log = createActivityLog({ store: memoryStore(stored), now: c.now });
    await log.load();
    const list = log.list();
    expect(list).toHaveLength(500);
    expect(list[0].detail).toBe("n1");
    expect(list.some((e: any) => ["expired", "no-time", "bad-time"].includes(e.type))).toBe(false);
  });

  it("strips control and bidi characters from labels and caps their length", async () => {
    // Mutation: storing agent text verbatim (it is shown in the Agents panel)
    const log = createActivityLog({ store: memoryStore(), now: clock().now });
    log.add({ type: "open", client: "ev‮il\u0000name", detail: "x".repeat(500) });
    const [e] = log.list();
    expect(e.client).toBe("evilname");
    expect(e.detail).toHaveLength(200);
  });

  it("persists after each add, and saves are serialized and coalesced (never concurrent)", async () => {
    // Mutation: starting a second save while one is in flight (interleaved writes could leave an older snapshot on disk)
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    const saved: number[] = [];
    const store = {
      async load() {
        return [];
      },
      async save(entries: unknown[]) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => gates.push(r));
        saved.push(entries.length);
        inFlight--;
      },
    };
    const log = createActivityLog({ store, now: clock().now });
    log.add({ type: "a" });
    log.add({ type: "b" });
    log.add({ type: "c" });
    expect(gates).toHaveLength(1);
    gates.shift()!();
    for (let i = 0; i < 10 && gates.length === 0; i++) await Promise.resolve();
    expect(gates).toHaveLength(1);
    gates.shift()!();
    await log.flush();
    expect(maxInFlight).toBe(1);
    expect(saved).toEqual([1, 3]);
  });

  it("a failing store never throws from add and the next add saves again", async () => {
    // Mutation: letting a persistence error escape into the request that logged
    let fail = true;
    const saved: number[] = [];
    const store = {
      async load() {
        return [];
      },
      async save(entries: unknown[]) {
        if (fail) throw new Error("disk full");
        saved.push(entries.length);
      },
    };
    const log = createActivityLog({ store, now: clock().now });
    expect(() => log.add({ type: "a" })).not.toThrow();
    await log.flush();
    fail = false;
    log.add({ type: "b" });
    await log.flush();
    expect(saved).toEqual([2]);
  });
});

describe("agent activity file store", () => {
  it("round-trips entries through <dir>/activity.json and a missing or corrupt file loads as empty", async () => {
    // Mutation: failing on first start (no file), or throwing on a corrupt file
    const dir = await makeTempDir();
    const store = createFileActivityStore({ dir });
    expect(await store.load()).toEqual([]);
    await store.save([{ at: "2026-10-24T12:00:00.000Z", type: "open" }]);
    expect(await store.load()).toEqual([{ at: "2026-10-24T12:00:00.000Z", type: "open" }]);
    await fs.writeFile(path.join(dir, "activity.json"), "{not json");
    expect(await store.load()).toEqual([]);
  });

  it("a write that fails halfway leaves the previous log intact and no temp file", async () => {
    // Mutation: writing the log in place (a crash or full disk mid-write would truncate the only copy)
    const dir = await makeTempDir();
    const good = createFileActivityStore({ dir });
    await good.save([{ at: "2026-10-24T12:00:00.000Z", type: "kept" }]);
    const failingFs = {
      ...fs,
      async writeFile(file: string, data: string, opts: object) {
        await fs.writeFile(file, String(data).slice(0, 5), opts);
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const bad = createFileActivityStore({ dir, fs: failingFs });
    await expect(bad.save([{ at: "2026-10-24T12:00:00.000Z", type: "lost" }])).rejects.toThrow("disk full");
    expect(await good.load()).toEqual([{ at: "2026-10-24T12:00:00.000Z", type: "kept" }]);
    expect(await fs.readdir(dir)).toEqual(["activity.json"]);
  });

  it("creates the folder and leaves no temp file behind", async () => {
    // Mutation: writing in place (a crash mid-write truncates the log) or leaving .tmp files
    const dir = path.join(await makeTempDir(), "agents");
    const store = createFileActivityStore({ dir });
    await store.save([{ at: "2026-10-24T12:00:00.000Z", type: "open" }]);
    expect(await fs.readdir(dir)).toEqual(["activity.json"]);
  });
});
