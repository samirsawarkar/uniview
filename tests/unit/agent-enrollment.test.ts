import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { createEnrollmentStore, createFileKeyStore, clientIdForName, readClientKey, ENROLLMENT_LIMITS } from "../../electron/lib/agent-enrollment.mjs";
// @ts-expect-error plain ESM module without types
import { enrollProof } from "../../electron/lib/bridge-proto.mjs";

const NONCE_A = Buffer.alloc(32, 1);
const NONCE_B = Buffer.alloc(32, 2);

function proofFor(key: Buffer, serverNonce = NONCE_A, clientNonce = NONCE_B): string {
  return enrollProof(key, serverNonce, clientNonce).toString("base64");
}

async function setup(opts: Record<string, unknown> = {}) {
  const dir = path.join(await makeTempDir(), "agents");
  const clock = { t: Date.parse("2026-10-24T12:00:00.000Z") };
  const store = createEnrollmentStore({ dir, now: () => clock.t, ...opts });
  await store.load();
  return { dir, store, clock };
}

/** The key the app generated for a client, read back from its key file. */
async function keyOf(dir: string, clientId: string): Promise<Buffer> {
  return Buffer.from((await fs.readFile(path.join(dir, `${clientId}.key`), "utf8")).trim(), "hex");
}

describe("agent enrollment store", () => {
  it("limit is 64 enrolled clients", () => {
    // Mutation: changing the cap constant
    expect(ENROLLMENT_LIMITS.maxClients).toBe(64);
  });

  it("clientIdForName is a stable 32-hex id that ignores control and bidi characters", () => {
    // Mutation: a random or unstable id (the agent could never find its key file again), or hashing the raw uncleaned name
    const id = clientIdForName("Claude Code");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(clientIdForName("Claude Code")).toBe(id);
    expect(clientIdForName("Claude Cod‮e")).toBe(id);
    expect(clientIdForName("Claude Code 2")).not.toBe(id);
  });

  it("enroll generates a 256-bit key in <dir>/<clientId>.key (owner-only) and a registry record without the key", async () => {
    // Mutation: a short key, a world-readable key file (mode), the key leaking into the registry or list(), or no key file
    const calls: Array<{ file: string; mode: unknown }> = [];
    const spyFs = {
      ...fs,
      async writeFile(file: string, data: unknown, opts: any) {
        calls.push({ file, mode: opts?.mode });
        return fs.writeFile(file, data as string, opts);
      },
    };
    const { dir, store } = await setup({ fs: spyFs });
    const rec = await store.enroll({ name: "Claude Code" });
    expect(rec).toEqual({ clientId: clientIdForName("Claude Code"), name: "Claude Code", enrolledAt: "2026-10-24T12:00:00.000Z" });
    const key = await keyOf(dir, rec.clientId);
    expect(key).toHaveLength(32);
    expect(calls.every((c) => c.mode === 0o600)).toBe(true);
    expect(calls.some((c) => path.basename(c.file).includes(".key"))).toBe(true);
    const registry = await fs.readFile(path.join(dir, "clients.json"), "utf8");
    expect(registry).not.toContain(key.toString("hex"));
    expect(registry).not.toContain(key.toString("base64"));
    expect(JSON.stringify(store.list())).not.toContain(key.toString("hex"));
    expect(store.list()).toEqual([rec]);
    expect(store.get(rec.clientId)).toEqual(rec);
    expect((await fs.readdir(dir)).sort()).toEqual(["clients.json", `${rec.clientId}.key`].sort());
  });

  it("the key is random per enrollment", async () => {
    // Mutation: deriving the key from the name (anyone could compute it)
    const a = await setup();
    const b = await setup();
    const ra = await a.store.enroll({ name: "same" });
    const rb = await b.store.enroll({ name: "same" });
    expect((await keyOf(a.dir, ra.clientId)).equals(await keyOf(b.dir, rb.clientId))).toBe(false);
  });

  it("verify accepts the HMAC over this connection's nonces and nothing else", async () => {
    // Mutation: accepting any proof, ignoring a nonce, swapping nonce order, or comparing with a short-circuit equals
    const { dir, store } = await setup();
    const { clientId } = await store.enroll({ name: "agent" });
    const key = await keyOf(dir, clientId);
    const ok = (proof: string, sn = NONCE_A, cn = NONCE_B, id = clientId) => store.verify({ clientId: id, proof, serverNonce: sn, clientNonce: cn });
    expect(await ok(proofFor(key))).toBe(true);
    expect(await ok(proofFor(key, NONCE_B, NONCE_A))).toBe(false); // nonces swapped
    expect(await ok(proofFor(key), Buffer.alloc(32, 9))).toBe(false); // other connection
    expect(await ok(proofFor(key), NONCE_A, Buffer.alloc(32, 9))).toBe(false);
    expect(await ok(proofFor(crypto.randomBytes(32)))).toBe(false); // wrong key
    expect(await ok("")).toBe(false);
    expect(await ok("not base64 !!")).toBe(false);
    expect(await ok(proofFor(key).slice(0, 20))).toBe(false); // truncated
    expect(await ok(proofFor(key), NONCE_A, NONCE_B, "f".repeat(32))).toBe(false); // unknown client
    expect(await store.verify({ clientId, proof: 42, serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
    expect(await store.verify({ clientId, proof: proofFor(key), serverNonce: null, clientNonce: NONCE_B })).toBe(false);
  });

  it("remove deletes the record and the key file; the old proof no longer verifies; a second remove is false", async () => {
    // Mutation: leaving the key file or record behind (a removed enrollment must fail)
    const { dir, store } = await setup();
    const { clientId } = await store.enroll({ name: "agent" });
    const key = await keyOf(dir, clientId);
    expect(await store.remove(clientId)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(await store.verify({ clientId, proof: proofFor(key), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
    expect(await fs.readdir(dir)).toEqual(["clients.json"]);
    expect(JSON.parse(await fs.readFile(path.join(dir, "clients.json"), "utf8")).clients).toEqual([]);
    expect(await store.remove(clientId)).toBe(false);
  });

  it("a key file that is still on disk does not revive a removed record", async () => {
    // Mutation: verifying from the key file alone (the registry must be the authority)
    const { dir, store } = await setup();
    const { clientId } = await store.enroll({ name: "agent" });
    const key = await keyOf(dir, clientId);
    await store.remove(clientId);
    await fs.writeFile(path.join(dir, `${clientId}.key`), key.toString("hex") + "\n");
    expect(await store.verify({ clientId, proof: proofFor(key), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
  });

  it("a record whose key file is gone never verifies", async () => {
    // Mutation: treating a missing key as an empty key (HMAC with a known value)
    const { dir, store } = await setup();
    const { clientId } = await store.enroll({ name: "agent" });
    await fs.unlink(path.join(dir, `${clientId}.key`));
    expect(await store.verify({ clientId, proof: proofFor(Buffer.alloc(0)), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
    expect(await store.verify({ clientId, proof: proofFor(Buffer.alloc(32)), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
  });

  it("a client removed while its key is being read does not verify", async () => {
    // Mutation: checking the registry only before the (asynchronous) key read, so a revocation that lands in between is ignored
    const dir = path.join(await makeTempDir(), "agents");
    const key = crypto.randomBytes(32);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading!: () => void;
    const started = new Promise<void>((r) => (reading = r));
    const keyStore = {
      async write() {},
      async read() {
        reading();
        await gate;
        return key;
      },
      async remove() {},
    };
    const store = createEnrollmentStore({ dir, keyStore });
    await store.load();
    const { clientId } = await store.enroll({ name: "agent" });
    const pending = store.verify({ clientId, proof: proofFor(key), serverNonce: NONCE_A, clientNonce: NONCE_B });
    await started;
    await store.remove(clientId);
    release();
    expect(await pending).toBe(false);
  });

  it("a key of the wrong length never verifies, whatever the key store returns", async () => {
    // Mutation: dropping the key length check (a short or empty key is guessable)
    const dir = path.join(await makeTempDir(), "agents");
    const short = Buffer.alloc(5, 7);
    const store = createEnrollmentStore({ dir, keyStore: { async write() {}, async read() { return short; }, async remove() {} } });
    await store.load();
    const { clientId } = await store.enroll({ name: "agent" });
    expect(await store.verify({ clientId, proof: proofFor(short), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
  });

  it("enrollments survive a restart (a new store on the same folder)", async () => {
    // Mutation: keeping the registry only in memory
    const { dir, store } = await setup();
    const { clientId } = await store.enroll({ name: "agent" });
    const key = await keyOf(dir, clientId);
    const again = createEnrollmentStore({ dir });
    await again.load();
    expect(again.list().map((c: any) => c.name)).toEqual(["agent"]);
    expect(await again.verify({ clientId, proof: proofFor(key), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(true);
  });

  it("enrolling the same name again replaces the key (the old proof stops working)", async () => {
    // Mutation: keeping the old key valid after re-enrolment, or duplicating the record
    const { dir, store } = await setup();
    const first = await store.enroll({ name: "agent" });
    const oldKey = await keyOf(dir, first.clientId);
    const second = await store.enroll({ name: "agent" });
    expect(second.clientId).toBe(first.clientId);
    expect(store.list()).toHaveLength(1);
    const newKey = await keyOf(dir, second.clientId);
    expect(newKey.equals(oldKey)).toBe(false);
    expect(await store.verify({ clientId: first.clientId, proof: proofFor(oldKey), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(false);
    expect(await store.verify({ clientId: first.clientId, proof: proofFor(newKey), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(true);
  });

  it("limit: 64 clients enroll; the 65th new name is refused with busy and leaves no key file; re-enrolling a name at the limit works", async () => {
    // Mutation: no cap, an off-by-one cap, or counting a replacement as a new client
    const { dir, store } = await setup();
    for (let i = 0; i < 64; i++) await store.enroll({ name: `agent-${i}` });
    expect(store.list()).toHaveLength(64);
    await expect(store.enroll({ name: "agent-64" })).rejects.toMatchObject({ code: "busy" });
    expect(store.list()).toHaveLength(64);
    expect(await fs.readdir(dir)).toHaveLength(64 * 1 + 1);
    await expect(store.enroll({ name: "agent-0" })).resolves.toMatchObject({ name: "agent-0" });
    expect(store.list()).toHaveLength(64);
  });

  it("a failed registry write leaves no record and no key file", async () => {
    // Mutation: a half-enrolled client (a key file that no record vouches for, or a record that cannot be saved)
    const dir = path.join(await makeTempDir(), "agents");
    const failingFs = {
      ...fs,
      async rename(from: string, to: string) {
        if (path.basename(to) === "clients.json") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return fs.rename(from, to);
      },
    };
    const store = createEnrollmentStore({ dir, fs: failingFs });
    await store.load();
    await expect(store.enroll({ name: "agent" })).rejects.toThrow("disk full");
    expect(store.list()).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("concurrent enrolments are all recorded", async () => {
    // Mutation: unserialized read-modify-write of the registry (a lost update)
    const { dir, store } = await setup();
    await Promise.all(["a", "b", "c", "d"].map((name) => store.enroll({ name })));
    expect(store.list().map((c: any) => c.name).sort()).toEqual(["a", "b", "c", "d"]);
    const again = createEnrollmentStore({ dir });
    await again.load();
    expect(again.list()).toHaveLength(4);
  });

  it("a corrupt registry loads as empty and malformed records are dropped", async () => {
    // Mutation: crashing on, or trusting, a damaged registry file
    const { dir, store } = await setup();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "clients.json"), "{nope");
    await store.load();
    expect(store.list()).toEqual([]);
    const good = { clientId: "a".repeat(32), name: "ok", enrolledAt: "2026-10-24T12:00:00.000Z" };
    await fs.writeFile(
      path.join(dir, "clients.json"),
      JSON.stringify({ v: 1, clients: [good, null, { clientId: "short", name: "x", enrolledAt: "2026-10-24T12:00:00.000Z" }, { clientId: "c".repeat(32), name: "x", enrolledAt: "not a time" }, { clientId: "b".repeat(32), name: 5 }, good] }),
    );
    await store.load();
    expect(store.list()).toEqual([good]);
  });

  it("load caps a registry larger than the limit", async () => {
    // Mutation: trusting an oversized registry
    const { dir, store } = await setup();
    await fs.mkdir(dir, { recursive: true });
    const clients = Array.from({ length: 70 }, (_, i) => ({ clientId: i.toString(16).padStart(32, "0"), name: `n${i}`, enrolledAt: "2026-10-24T12:00:00.000Z" }));
    await fs.writeFile(path.join(dir, "clients.json"), JSON.stringify({ v: 1, clients }));
    await store.load();
    expect(store.list()).toHaveLength(64);
  });

  it("names are cleaned of control and bidi characters and capped at 80 characters", async () => {
    // Mutation: storing the agent's raw name (it is shown in the Agents panel)
    const { store } = await setup();
    const rec = await store.enroll({ name: `ev‮il${"x".repeat(200)}` });
    expect(rec.name).toBe(`evil${"x".repeat(76)}`);
  });
});

describe("agent key files (the MCP process side)", () => {
  it("readClientKey finds the key by the agent's name and returns the same key the server verifies with", async () => {
    // Mutation: a different file name or encoding on the reading side than the writing side
    const { dir, store } = await setup();
    const { clientId } = await store.enroll({ name: "Claude Code" });
    const found = await readClientKey({ dir, name: "Claude Code" });
    expect(found.clientId).toBe(clientId);
    expect(found.key.equals(await keyOf(dir, clientId))).toBe(true);
    expect(await store.verify({ clientId, proof: proofFor(found.key), serverNonce: NONCE_A, clientNonce: NONCE_B })).toBe(true);
  });

  it("readClientKey is null for an unknown name, a missing folder and a damaged key file", async () => {
    // Mutation: throwing instead of "not enrolled", or accepting a wrong-length key
    const { dir, store } = await setup();
    expect(await readClientKey({ dir, name: "nobody" })).toBeNull();
    expect(await readClientKey({ dir: path.join(dir, "missing"), name: "nobody" })).toBeNull();
    const { clientId } = await store.enroll({ name: "agent" });
    await fs.writeFile(path.join(dir, `${clientId}.key`), "abcd\n");
    expect(await readClientKey({ dir, name: "agent" })).toBeNull();
    await fs.writeFile(path.join(dir, `${clientId}.key`), "z".repeat(64));
    expect(await readClientKey({ dir, name: "agent" })).toBeNull();
  });

  it("the file key store writes hex, reads it back and removes it", async () => {
    // Mutation: write/read/remove disagreeing (e.g. remove leaving the secret on disk)
    const dir = await makeTempDir();
    const keys = createFileKeyStore({ dir });
    const key = crypto.randomBytes(32);
    await keys.write("c".repeat(32), key);
    expect((await keys.read("c".repeat(32))).equals(key)).toBe(true);
    await keys.remove("c".repeat(32));
    expect(await keys.read("c".repeat(32))).toBeNull();
    await expect(keys.remove("c".repeat(32))).resolves.toBeUndefined();
  });

  it("the key store refuses a client id that is not 32 hex characters (no path traversal)", async () => {
    // Mutation: building a file name from an unchecked id
    const dir = await makeTempDir();
    const keys = createFileKeyStore({ dir });
    await expect(keys.write("../evil", Buffer.alloc(32))).rejects.toThrow();
    await expect(keys.read("..\\evil")).resolves.toBeNull();
    await expect(keys.remove("../evil")).resolves.toBeUndefined();
  });
});
