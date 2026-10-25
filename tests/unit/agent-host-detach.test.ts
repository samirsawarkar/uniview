import { describe, it, expect } from "vitest";
import { flush, makeHost, newSession, specJson, makeFakeFs } from "./agent-host-helpers";
// @ts-expect-error plain ESM module without types
import { enrollProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { readClientKey } from "../../electron/lib/agent-enrollment.mjs";

/** P28: tabs the person is looking at keep working after the CLI / agent process has gone. */

const readAll = async (grant: any): Promise<string> => {
  const buf = Buffer.alloc(1024);
  const { bytesRead } = await grant.handle.read(buf, 0, buf.length, 0);
  return buf.subarray(0, bytesRead).toString();
};

async function enrolledClient(t: any, name = "DetachAgent") {
  const first = await t.mcp(name);
  const p = t.fail(first, "review.get", { reviewId: "x" });
  await t.dialog.answer("allow_always");
  await p;
  const found = await readClientKey({ dir: `${t.root}/agents`, name });
  const connect = async () => {
    const s = newSession({ autoCli: false });
    await t.call(s, "mcp.hello", {
      client: { name, version: "1" },
      protocolVersion: "2025-06-18",
      enroll: { clientId: found.clientId, proof: enrollProof(found.key, s.serverNonce, s.clientNonce).toString("base64") },
    });
    return s;
  };
  return { connect, clientId: found.clientId as string };
}

async function openThree(t: any, s: any) {
  t.fakeFs.set("/w/a.txt", "alpha bytes");
  t.fakeFs.set("/w/b.txt", "bravo bytes");
  t.fakeFs.set("/w/c.txt", "charlie bytes");
  await t.open(s, ["/w/a.txt", "/w/b.txt", "/w/c.txt"]);
  expect(t.ui.calls.openFile).toHaveLength(3);
  return t.ui.calls.openFile.map((c: any) => ({ scopeId: c.scopeId, token: c.token }));
}

describe("P28: committed tabs outlive the session that opened them", () => {
  it("(1) a CLI session opens 3 files and disconnects: each grant still reads the original bytes", async () => {
    // Mutation: onSessionClosed closing every scope of the session (closeSessionScopes without the committed check)
    // makes grants.get(...) undefined here (the packaged-app 'This file is no longer available').
    const t = await makeHost();
    const s = await t.cli();
    const tabs = await openThree(t, s);
    await t.host.onSessionClosed(s.sessionId);
    const expected = ["alpha bytes", "bravo bytes", "charlie bytes"];
    for (let i = 0; i < 3; i++) {
      const grant = t.host.grants.get(tabs[i].token, tabs[i].scopeId);
      expect(grant).toBeDefined();
      expect(await readAll(grant)).toBe(expected[i]);
    }
    expect(t.fakeFs.state.live).toBe(3);
  });

  it("(2) after tabClosed the scope is closed and its handle released; the other tabs stay open", async () => {
    // Mutation: tabClosed not releasing a detached tab's scope (leaks the handle for the rest of the app's life).
    const t = await makeHost();
    const s = await t.cli();
    const tabs = await openThree(t, s);
    await t.host.onSessionClosed(s.sessionId);
    await t.host.tabClosed(tabs[1].scopeId);
    expect(t.host.grants.get(tabs[1].token, tabs[1].scopeId)).toBeUndefined();
    expect(t.host.grants.get(tabs[0].token, tabs[0].scopeId)).toBeDefined();
    expect(t.host.grants.get(tabs[2].token, tabs[2].scopeId)).toBeDefined();
    expect(t.fakeFs.state.live).toBe(2);
    await t.host.tabClosed(tabs[0].scopeId);
    await t.host.tabClosed(tabs[2].scopeId);
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.scopeCount).toBe(0);
  });

  it("(3) revokeClient closes the scopes of a client whose session already disconnected, and of one still connected", async () => {
    // Mutation: revokeClient closing only the scopes of sessions still connected (or none), leaving the revoked client's tabs readable.
    const t = await makeHost();
    const { connect, clientId } = await enrolledClient(t);
    const s = await connect();
    t.fakeFs.set("/w/gone.txt", "gone");
    t.fakeFs.set("/w/live.txt", "live");
    await t.open(s, ["/w/gone.txt"]);
    const gone = t.ui.calls.openFile[0];
    await t.host.onSessionClosed(s.sessionId);
    expect(t.host.grants.get(gone.token, gone.scopeId)).toBeDefined(); // detached, still readable

    const s2 = await connect();
    await t.open(s2, ["/w/live.txt"]);
    const live = t.ui.calls.openFile[1];
    expect(t.host.grants.get(live.token, live.scopeId)).toBeDefined();

    await t.host.revokeClient(clientId);

    expect(t.host.grants.get(gone.token, gone.scopeId)).toBeUndefined();
    expect(t.host.grants.get(live.token, live.scopeId)).toBeUndefined();
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.scopeCount).toBe(0);
  });

  it("(4) an open still in flight when the session disconnects is closed, fails, and leaves no handle", async () => {
    // Mutation: treating in-flight (uncommitted) scopes as committed on disconnect leaves their handles/scopes alive after the failed open.
    const t = await makeHost();
    const s = await t.cli();
    t.fakeFs.set("/w/p.txt", "p");
    t.fakeFs.set("/w/q.txt", "q");
    let releaseUi!: () => void;
    t.ui.gate = new Promise<void>((r) => (releaseUi = r));
    const seen: any[] = [];
    const origOpenFile = t.ui.openFile;
    t.ui.openFile = async (p: any) => {
      seen.push(p);
      return origOpenFile(p);
    };
    const opening = t.open(s, ["/w/p.txt", "/w/q.txt"]).catch((e: any) => e.code);
    for (let i = 0; i < 50 && seen.length === 0; i++) await flush();
    expect(t.host.grants.scopeCount).toBe(2);

    await t.host.onSessionClosed(s.sessionId);
    expect(t.host.grants.scopeCount).toBe(0);
    expect(t.host.grants.get(seen[0].token, seen[0].scopeId)).toBeUndefined();
    releaseUi();
    expect(await opening).toBe("not_found");
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.scopeCount).toBe(0);
  });

  it("a view tab stays valid after disconnect and is released by tabClosed", async () => {
    // Mutation: closing view scopes on disconnect, or not marking view tabs committed.
    const t = await makeHost();
    const s = await t.cli();
    const { scopeId } = await t.call(s, "view.show", { inline: true }, Buffer.from(specJson()));
    await t.host.onSessionClosed(s.sessionId);
    expect(t.host.grants.scopeCount).toBe(1);
    await t.host.tabClosed(scopeId);
    expect(t.host.grants.scopeCount).toBe(0);
  });

  it("the 64-tab cap still counts detached tabs, so leaving tabs open cannot grow without bound", async () => {
    // Mutation: dropping detached tabs from the registry on disconnect (the cap would no longer bound them).
    const fs = makeFakeFs();
    const t = await makeHost({ fakeFs: fs });
    for (let i = 0; i < 64; i++) fs.set(`/w/f${i}.txt`, `f${i}`);
    for (let c = 0; c < 4; c++) {
      const cs = await t.cli();
      await t.open(cs, Array.from({ length: 16 }, (_, k) => `/w/f${c * 16 + k}.txt`));
      await t.host.onSessionClosed(cs.sessionId);
      t.clock.advance(61_000);
    }
    expect(t.host.grants.scopeCount).toBe(64);
    fs.set("/w/extra.txt", "x");
    const next = await t.cli();
    expect(await t.fail(next, "open", {}, Buffer.from(JSON.stringify(["/w/extra.txt"])))).toBe("busy");
    await t.host.tabClosed(t.ui.calls.openFile[0].scopeId);
    await t.open(next, ["/w/extra.txt"]);
  });
});
