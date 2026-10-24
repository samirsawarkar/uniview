import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { flush, makeHost, newSession } from "./agent-host-helpers";
// @ts-expect-error plain ESM module without types
import { BRIDGE_OPS, HOST_LIMITS } from "../../electron/lib/agent-host.mjs";
// @ts-expect-error plain ESM module without types
import { enrollProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { readClientKey } from "../../electron/lib/agent-enrollment.mjs";

describe("agent host: dispatch and the canonical op set", () => {
  it("the canonical op set is exactly the P17a set", async () => {
    // Mutation: adding, dropping or renaming a bridge op (the two clients must agree on one set)
    expect([...BRIDGE_OPS]).toEqual(["mcp.hello", "open", "view.show", "review.open", "review.wait", "review.cancelWait", "review.get"]);
  });

  it("an unknown method (including the retired CLI ops) is unknown_method", async () => {
    // Mutation: a fall-through handler for unknown ops, or keeping the old CLI wait_review op
    const t = await makeHost();
    const s = newSession();
    for (const m of ["wait_review", "nope", "", "constructor", "__proto__"]) expect(await t.fail(s, m)).toBe("unknown_method");
    expect(await t.fail(s, undefined as unknown as string)).toBe("unknown_method");
  });

  it("params that are not an object are bad_request", async () => {
    // Mutation: trusting header.params
    const t = await makeHost();
    const s = newSession();
    for (const p of [[], "x", 5, null]) expect(await t.fail(s, "review.get", p)).toBe("bad_request");
  });

  it("a connection that never says hello is the command line: no approval dialog", async () => {
    // Mutation: asking the CLI for approval (spec: the CLI is not subject to approval)
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "a");
    const cli = newSession();
    expect(await t.open(cli, ["/w/a.txt"])).toEqual({ opened: 1 });
    expect(t.dialog.calls).toHaveLength(0);
    expect(t.host.listSessions()[0]).toMatchObject({ kind: "cli", approval: "not_required" });
  });
});

describe("agent host: mcp.hello and approval", () => {
  it("hello marks the session MCP and answers {enrolled:false}; a second hello, or one after another request, is bad_request", async () => {
    // Mutation: letting a client re-hello to change its label, or hello after acting as the CLI
    const t = await makeHost();
    const s = newSession();
    expect(await t.call(s, "mcp.hello", { client: { name: "A", version: "1" }, protocolVersion: "2025-06-18" })).toEqual({ enrolled: false });
    expect(await t.fail(s, "mcp.hello", { client: { name: "B" } })).toBe("bad_request");
    const late = newSession();
    t.fakeFs.set("/w/a.txt", "a");
    await t.open(late, ["/w/a.txt"]);
    expect(await t.fail(late, "mcp.hello", { client: { name: "sneaky" } })).toBe("bad_request");
    expect(t.host.listSessions().find((x: any) => x.sessionId === late.sessionId)).toMatchObject({ kind: "cli" });
  });

  it("an unapproved MCP session is asked on its first call (with the cleaned name) and gets nothing if refused", async () => {
    // Mutation: serving the call before consent, not cleaning the name, or opening the file anyway
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "a");
    const s = await t.mcp("Evil‮ Agent");
    const p = t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])));
    await t.dialog.answer("deny");
    expect(await p).toBe("not_allowed");
    expect(t.dialog.calls[0]!.client).toEqual({ name: "Evil Agent", version: "1" });
    expect(t.host.listSessions().find((x: any) => x.sessionId === s.sessionId)!.client.name).toBe("Evil Agent");
    expect(t.ui.calls.openFile).toEqual([]);
    expect(t.fakeFs.state.live).toBe(0);
    // Remembered: no second dialog.
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("not_allowed");
    expect(t.dialog.calls).toHaveLength(1);
  });

  it("even a malformed request from an unapproved session gets the dialog first, not a parameter error", async () => {
    // Mutation: validating (and so probing) before consent
    const t = await makeHost();
    const s = await t.mcp();
    const p = t.fail(s, "open", {}, Buffer.from("not json"));
    await t.dialog.answer("deny");
    expect(await p).toBe("not_allowed");
  });

  it("allow for this session lets later calls through without asking again", async () => {
    // Mutation: asking on every call
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "a");
    const s = await t.approvedMcp();
    expect(await t.open(s, ["/w/a.txt"])).toEqual({ opened: 1 });
    expect(t.dialog.calls).toHaveLength(1);
    expect(t.host.listSessions().find((x: any) => x.sessionId === s.sessionId)).toMatchObject({ kind: "mcp", approval: "session", client: { name: "Claude Code" } });
  });

  it("review.cancelWait never asks for approval", async () => {
    // Mutation: gating cleanup behind a dialog
    const t = await makeHost();
    const s = await t.mcp();
    expect(await t.call(s, "review.cancelWait", { reviewId: "nothing" })).toEqual({});
    expect(t.dialog.calls).toHaveLength(0);
  });

  it("closing the connection while a dialog is open dismisses it", async () => {
    // Mutation: leaving a dialog on screen for a dead connection
    const t = await makeHost();
    const s = await t.mcp();
    const p = t.fail(s, "review.get", { reviewId: "x" });
    await flush();
    t.host.onSessionClosed(s.sessionId);
    expect(await p).toBe("not_allowed");
    expect(t.dialog.calls[0]!.signal.aborted).toBe(true);
  });
});

describe("agent host: enrolled clients", () => {
  async function enrolledClient(t: Awaited<ReturnType<typeof makeHost>>, name = "Claude Code") {
    const s = await t.mcp(name);
    const p = t.fail(s, "review.get", { reviewId: "x" });
    await t.dialog.answer("allow_always");
    await p;
    const found = await readClientKey({ dir: `${t.root}/agents`, name });
    return { clientId: found.clientId as string, key: found.key as Buffer };
  }
  const hello = (t: Awaited<ReturnType<typeof makeHost>>, s: ReturnType<typeof newSession>, enroll: unknown) =>
    t.call(s, "mcp.hello", { client: { name: "Claude Code", version: "1" }, protocolVersion: "2025-06-18", enroll });
  const proofFor = (key: Buffer, s: ReturnType<typeof newSession>) => enrollProof(key, s.serverNonce, s.clientNonce).toString("base64");

  it("always allow stores a key; a later session proves itself with enrollProof over its own nonces and is not asked", async () => {
    // Mutation: asking again, ignoring the proof (any enroll claim passes), or binding the proof to the wrong nonces
    const t = await makeHost();
    const { clientId, key } = await enrolledClient(t);
    const s2 = newSession();
    expect(await hello(t, s2, { clientId, proof: proofFor(key, s2) })).toEqual({ enrolled: true });
    t.fakeFs.set("/w/a.txt", "a");
    expect(await t.open(s2, ["/w/a.txt"])).toEqual({ opened: 1 });
    expect(t.dialog.calls).toHaveLength(1);
    expect(t.host.listSessions().find((x: any) => x.sessionId === s2.sessionId)).toMatchObject({ approval: "always", clientId });
  });

  it("a wrong proof, another connection's proof, an unknown client or missing nonces is not_allowed", async () => {
    // Mutation: accepting a replayed proof, a guessed client id, or a proof when the nonces are unavailable
    const t = await makeHost();
    const { clientId, key } = await enrolledClient(t);
    const other = newSession();
    const s = newSession();
    expect(await t.fail(s, "mcp.hello", { client: { name: "x" }, enroll: { clientId, proof: proofFor(crypto.randomBytes(32), s) } })).toBe("not_allowed");
    const s2 = newSession();
    expect(await t.fail(s2, "mcp.hello", { client: { name: "x" }, enroll: { clientId, proof: proofFor(key, other) } })).toBe("not_allowed");
    const s3 = newSession();
    expect(await t.fail(s3, "mcp.hello", { client: { name: "x" }, enroll: { clientId: "f".repeat(32), proof: proofFor(key, s3) } })).toBe("not_allowed");
    const s4 = newSession();
    const noNonces = { sessionId: s4.sessionId } as ReturnType<typeof newSession>;
    expect(await t.fail(noNonces, "mcp.hello", { client: { name: "x" }, enroll: { clientId, proof: proofFor(key, s4) } })).toBe("not_allowed");
    const s5 = newSession();
    for (const bad of ["x", 5, null, {}, { clientId }, { proof: "x" }]) {
      const sx = newSession();
      expect(await t.fail(sx, "mcp.hello", { client: { name: "x" }, enroll: bad })).toBe("not_allowed");
    }
    expect(s5).toBeTruthy();
    expect(t.dialog.calls).toHaveLength(1);
  });

  it("removing the enrolment makes the old key fail with not_allowed", async () => {
    // Mutation: a removed enrolment still verifying (spec: removal -> not_allowed)
    const t = await makeHost();
    const { clientId, key } = await enrolledClient(t);
    await t.host.revokeClient(clientId);
    const s = newSession();
    expect(await t.fail(s, "mcp.hello", { client: { name: "x" }, enroll: { clientId, proof: proofFor(key, s) } })).toBe("not_allowed");
  });

  it("revoking cancels the client's pending waits, closes its sessions, and leaves other clients alone", async () => {
    // Mutation: revocation that leaves live sessions or waits running, or that hits every client
    const t = await makeHost();
    const { clientId, key } = await enrolledClient(t);
    const mine = newSession();
    await hello(t, mine, { clientId, proof: proofFor(key, mine) });
    const other = await t.approvedMcp("Other Agent");
    const rec = (s: ReturnType<typeof newSession>) => crypto.createHash("sha256").update(s.sessionId).digest("hex");
    t.fakeFs.set("/w/f.txt", "f");
    const receipt = (await import("./agent-host-helpers")).receiptJson([{ path: "/w/f.txt", sha256: (await import("./agent-host-helpers")).sha256("f") }]);
    const { reviewId } = await t.call(mine, "review.open", { inline: true }, Buffer.from(receipt));
    let waited: any = null;
    const waiting = t.call(mine, "review.wait", { reviewId, timeoutMs: 3_600_000 }).then((r: any) => (waited = r));
    await flush();
    expect(waited).toBeNull();
    const out = await t.host.revokeClient(clientId);
    await waiting;
    // The session that clicked "Always allow" and the one that proved itself are both this client's.
    expect(out).toEqual({ removed: true, sessionsClosed: 2 });
    expect(waited).toEqual({ status: "pending" });
    expect(t.closedSessions).toHaveLength(2);
    expect(t.closedSessions).toContain(mine.sessionId);
    expect(t.closedSessions).not.toContain(other.sessionId);
    expect(t.clock.pending()).toBe(0);
    expect(await t.fail(mine, "review.get", { reviewId })).toBe("not_allowed");
    t.fakeFs.set("/w/a.txt", "a");
    expect(await t.open(other, ["/w/a.txt"])).toEqual({ opened: 1 });
    expect(rec(mine)).toHaveLength(64);
  });
});

describe("agent host: open", () => {
  it("opens each file in its own tab and scope, with a grant that reads through the held handle", async () => {
    // Mutation: one shared scope for all files, no grant, or reopening by name instead of using the handle
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "hello");
    t.fakeFs.set("/w/b.txt", "world!");
    const s = newSession();
    expect(await t.open(s, ["/w/a.txt", "/w/b.txt"])).toEqual({ opened: 2 });
    const [a, b] = t.ui.calls.openFile;
    expect(a).toMatchObject({ name: "a.txt", canonical: "/w/a.txt", size: 5, sessionId: s.sessionId });
    expect(b).toMatchObject({ name: "b.txt", size: 6 });
    expect(a.scopeId).not.toBe(b.scopeId);
    const grant = t.host.grants.get(a.token, a.scopeId);
    expect(grant.size).toBe(5);
    const buf = Buffer.alloc(5);
    await grant.handle.read(buf, 0, 5, 0);
    expect(buf.toString()).toBe("hello");
    // A grant cannot be used from another tab's scope.
    expect(t.host.grants.get(a.token, b.scopeId)).toBeUndefined();
    expect(t.fakeFs.state.live).toBe(2);
  });

  it("limit: 20 paths are accepted; 21, 0, or a non-array are bad_request", async () => {
    // Mutation: path-count cap off by one, missing lower bound, or accepting a non-array
    const t = await makeHost();
    const s = newSession();
    const paths = Array.from({ length: 21 }, (_, i) => `/w/f${i}.txt`);
    paths.forEach((p) => t.fakeFs.set(p, "x"));
    expect(HOST_LIMITS.maxPaths).toBe(20);
    expect(await t.open(s, paths.slice(0, 20))).toEqual({ opened: 20 });
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(paths)))).toBe("bad_request");
    expect(await t.fail(s, "open", {}, Buffer.from("[]"))).toBe("bad_request");
    expect(await t.fail(s, "open", {}, Buffer.from('{"a":1}'))).toBe("bad_request");
  });

  it("limit: a 4096-character path is read through the path policy, a 4097-character one is bad_request", async () => {
    // Mutation: path length bound off by one, or none
    const t = await makeHost();
    const s = newSession();
    const ok = `/${"a".repeat(4095)}`;
    t.fakeFs.set(ok, "x");
    expect(await t.open(s, [ok])).toEqual({ opened: 1 });
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify([`/${"a".repeat(4096)}`])))).toBe("bad_request");
  });

  it("malformed bodies are bad_request: missing, invalid JSON, invalid UTF-8, non-string and empty entries", async () => {
    // Mutation: crashing (internal) or accepting junk entries
    const t = await makeHost();
    const s = newSession();
    expect(await t.fail(s, "open", {})).toBe("bad_request");
    expect(await t.fail(s, "open", {}, Buffer.alloc(0))).toBe("bad_request");
    expect(await t.fail(s, "open", {}, Buffer.from("{nope"))).toBe("bad_request");
    expect(await t.fail(s, "open", {}, Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]))).toBe("bad_request");
    for (const bad of [[1], [""], [null], [["a"]]]) expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(bad)))).toBe("bad_request");
  });

  it("all or nothing: one refused path is bad_path, nothing is shown, every handle is closed, and no quota is used", async () => {
    // Mutation: opening the good files anyway, leaking their handles, or counting a failed request against the minute
    const t = await makeHost();
    t.fakeFs.set("/w/ok.txt", "x");
    t.fakeFs.refuse("/w/nope.txt");
    const s = newSession();
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/ok.txt", "/w/nope.txt", "/w/missing.txt"])))).toBe("bad_path");
    expect(t.ui.calls.openFile).toEqual([]);
    expect(t.fakeFs.state.live).toBe(0);
    for (let i = 0; i < 30; i++) await t.open(s, ["/w/ok.txt"]);
  });

  it("limit: 64 agent tabs across all sessions; the 65th is busy, and a request that would cross the limit opens none of its files", async () => {
    // Mutation: cap 63/65, per-session instead of global, or opening part of a request before refusing
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const sessions = [newSession(), newSession(), newSession(), newSession()];
    let opened = 0;
    for (const s of sessions) {
      for (let i = 0; i < 16 && opened < 63; i++, opened++) await t.open(s, ["/w/a.txt"]);
    }
    expect(opened).toBe(63);
    const live = t.fakeFs.state.live;
    expect(await t.fail(sessions[3]!, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt", "/w/a.txt"])))).toBe("busy");
    expect(t.fakeFs.state.live).toBe(live);
    expect(t.ui.calls.openFile).toHaveLength(63);
    await t.clock.advance(60_000);
    expect(await t.open(sessions[3]!, ["/w/a.txt"])).toEqual({ opened: 1 });
    expect(await t.fail(sessions[1]!, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("busy");
  });

  it("parallel requests from several sessions cannot overshoot the 64-tab limit", async () => {
    // Mutation: counting only finished tabs (a reservation is needed while the files are still being opened)
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const sessions = [newSession(), newSession(), newSession()];
    const results = await Promise.all(
      Array.from({ length: 70 }, (_, i) => t.fail(sessions[i % 3]!, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))),
    );
    expect(results.filter((r) => r === "busy")).toHaveLength(6);
    expect(t.ui.calls.openFile).toHaveLength(64);
    expect(t.fakeFs.state.live).toBe(64);
  });

  it("a request is counted by its size against the minute: 20 used, 11 more is busy and opens nothing; 10 more is fine", async () => {
    // Mutation: counting a multi-file request as one tab
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const s = newSession();
    await t.open(s, Array.from({ length: 20 }, () => "/w/a.txt"));
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(Array.from({ length: 11 }, () => "/w/a.txt"))))).toBe("busy");
    expect(t.ui.calls.openFile).toHaveLength(20);
    expect(await t.open(s, Array.from({ length: 10 }, () => "/w/a.txt"))).toEqual({ opened: 10 });
  });

  it("closing a tab frees its slot under the 64-tab limit", async () => {
    // Mutation: a closed tab still counting as open
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const sessions = [newSession(), newSession(), newSession(), newSession()];
    for (const s of sessions) await t.open(s, Array.from({ length: 16 }, () => "/w/a.txt"));
    expect(await t.fail(sessions[0]!, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("busy");
    await t.host.tabClosed(t.ui.calls.openFile[0].scopeId);
    expect(await t.open(sessions[1]!, ["/w/a.txt"])).toEqual({ opened: 1 });
  });

  it("closing a tab releases its handle and frees its slot", async () => {
    // Mutation: tabClosed not closing the scope (handle leak) or not freeing the slot
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const s = newSession();
    await t.open(s, ["/w/a.txt"]);
    const { scopeId, token } = t.ui.calls.openFile[0];
    expect(t.fakeFs.state.live).toBe(1);
    await t.host.tabClosed(scopeId);
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.get(token, scopeId)).toBeUndefined();
    await t.host.tabClosed(scopeId);
  });

  it("limit: 30 opened tabs per minute per session; the 31st is busy until the oldest is a minute old", async () => {
    // Mutation: limit 29/31, a window that never slides, > vs >= at exactly 60 s, or a global instead of per-session count
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const s = newSession();
    const s2 = newSession();
    expect(HOST_LIMITS.tabsPerMinute).toBe(30);
    await t.open(s, Array.from({ length: 20 }, () => "/w/a.txt"));
    await t.clock.advance(1);
    await t.open(s, Array.from({ length: 10 }, () => "/w/a.txt"));
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("busy");
    expect(await t.open(s2, ["/w/a.txt"])).toEqual({ opened: 1 });
    await t.clock.advance(59_998); // t = 59 999: the first 20 are 59 999 ms old
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("busy");
    await t.clock.advance(1); // t = 60 000: the first 20 are a minute old and no longer count
    expect(await t.open(s, Array.from({ length: 20 }, () => "/w/a.txt"))).toEqual({ opened: 20 });
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("busy");
  });

  it("parallel requests cannot overshoot the per-minute limit", async () => {
    // Mutation: checking the quota before the awaits but only recording it after (a race)
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    const s = newSession();
    const results = await Promise.all(
      Array.from({ length: 31 }, () => t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))),
    );
    expect(results.filter((r) => r === "busy")).toHaveLength(1);
    expect(t.ui.calls.openFile).toHaveLength(30);
  });

  it("a UI that is busy (renderer not ready, queue full) answers busy and rolls everything back; another UI failure is internal", async () => {
    // Mutation: leaving handles/tabs behind when the renderer refuses, or leaking its error text
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    t.fakeFs.set("/w/b.txt", "y");
    const s = newSession();
    t.ui.failWith = { code: "busy" };
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt", "/w/b.txt"])))).toBe("busy");
    expect(t.fakeFs.state.live).toBe(0);
    t.ui.failWith = { code: "EBOOM" };
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("internal");
    expect(t.fakeFs.state.live).toBe(0);
    t.ui.failWith = null;
    for (let i = 0; i < 30; i++) await t.open(s, ["/w/a.txt"]);
  });

  it("the ui failing after some tabs were shown closes those tabs again", async () => {
    // Mutation: leaving half a request visible to the person
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    t.fakeFs.set("/w/b.txt", "y");
    const s = newSession();
    let n = 0;
    const original = t.ui.openFile.bind(t.ui);
    t.ui.openFile = async (p: any) => {
      if (++n === 2) throw Object.assign(new Error("x"), { code: "busy" });
      return original(p);
    };
    expect(await t.fail(s, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt", "/w/b.txt"])))).toBe("busy");
    expect(t.ui.calls.closeTab).toEqual([t.ui.calls.openFile[0].scopeId]);
    expect(t.fakeFs.state.live).toBe(0);
  });

  it("limit: 256 agent file handles across all scopes; the 257th grant is busy and its handle is closed", async () => {
    // Mutation: no handle cap, an off-by-one cap, or leaking the handle of a refused grant
    const t = await makeHost();
    const images = Array.from({ length: 257 }, (_, i) => `/w/img${i}.png`);
    images.forEach((p) => t.fakeFs.set(p, "png"));
    const s = newSession();
    const spec = JSON.stringify({ uniview: "view/1", title: "T", body: images.map((p) => ({ type: "image", path: p, alt: "a" })) });
    const { scopeId } = await t.call(s, "view.show", { inline: true }, Buffer.from(spec));
    for (let i = 0; i < 256; i++) await t.host.viewGrant(scopeId, images[i]);
    expect(t.fakeFs.state.live).toBe(256);
    await expect(t.host.viewGrant(scopeId, images[256])).rejects.toMatchObject({ code: "busy" });
    expect(t.fakeFs.state.live).toBe(256);
    await t.host.tabClosed(scopeId);
    expect(t.fakeFs.state.live).toBe(0);
  });

  it("dispose closes every agent handle", async () => {
    // Mutation: leaking handles at shutdown
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "x");
    await t.open(newSession(), ["/w/a.txt"]);
    await t.host.dispose();
    expect(t.fakeFs.state.live).toBe(0);
  });
});

describe("agent host: activity and lists", () => {
  it("logs sessions and ops without file paths, and lists sessions, clients and activity", async () => {
    // Mutation: a silent host (no audit trail) or paths copied into the log
    const t = await makeHost();
    t.fakeFs.set("/w/secret-name.txt", "x");
    const s = await t.approvedMcp("Claude Code");
    await t.open(s, ["/w/secret-name.txt"]);
    const log = t.host.listActivity();
    expect(log.map((e: any) => e.type)).toEqual(["session_opened", "approved", "open"]);
    expect(log.every((e: any) => e.sessionId === s.sessionId && e.client === "Claude Code")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("secret-name");
    expect(t.host.listClients()).toEqual([]);
    t.host.onSessionClosed(s.sessionId);
    expect(t.host.listSessions()).toEqual([]);
  });
});
