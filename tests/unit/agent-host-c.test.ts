import { describe, it, expect } from "vitest";
import path from "node:path";
import crypto from "node:crypto";
import { flush, makeHost, newSession, receiptJson, sha256, makeFakeFs } from "./agent-host-helpers";
// @ts-expect-error plain ESM module without types
import { HOST_LIMITS, BRIDGE_OPS } from "../../electron/lib/agent-host.mjs";

describe("P17b-1c Finding B1: Disconnected session review tabs remain tracked until closed", () => {
  it("four sessions open 8 reviews each, disconnect, close all 32 tabs; fresh session's review succeeds and counters never negative or stuck", async () => {
    // Mutation: deleting review tab tracking on session disconnect so tabClosed returns early and leaks pendingTotal / global 32 quota
    const t = await makeHost();
    const sessions = [];
    const scopeIds: string[] = [];

    // Four sessions open 8 reviews each (32 reviews total)
    let fileIdx = 0;
    for (let sIdx = 0; sIdx < 4; sIdx++) {
      const s = await t.cli();
      sessions.push(s);
      for (let rIdx = 0; rIdx < 8; rIdx++) {
        fileIdx++;
        const p = `/w/f${fileIdx}.txt`;
        t.fakeFs.set(p, `content${fileIdx}`);
        const res = await t.call(
          s,
          "review.open",
          { inline: true },
          Buffer.from(receiptJson([{ path: p, sha256: sha256(`content${fileIdx}`) }])),
        );
        expect(res.reviewId).toBeDefined();
      }
    }

    expect(t.ui.calls.showReview).toHaveLength(32);
    for (const call of t.ui.calls.showReview) {
      scopeIds.push(call.scopeId);
    }

    // Disconnect all 4 sessions
    for (const s of sessions) {
      await t.host.onSessionClosed(s.sessionId);
    }

    // Close all 32 tabs in the UI
    for (const scopeId of scopeIds) {
      await t.host.tabClosed(scopeId);
    }

    // A fresh session opens its first review: must succeed and NOT be busy!
    const freshSession = await t.cli();
    t.fakeFs.set("/w/fresh.txt", "fresh");
    const freshRes = await t.call(
      freshSession,
      "review.open",
      { inline: true },
      Buffer.from(receiptJson([{ path: "/w/fresh.txt", sha256: sha256("fresh") }])),
    );
    expect(freshRes.reviewId).toBeDefined();

    // Closing tabs again or closing already decided reviews never makes counters negative or stuck
    for (const scopeId of scopeIds) {
      await t.host.tabClosed(scopeId);
    }
    const freshScopeId = t.ui.calls.showReview[32].scopeId;
    await t.host.tabClosed(freshScopeId);

    // After closing freshScopeId, opening another review still succeeds
    t.fakeFs.set("/w/fresh2.txt", "fresh2");
    const fresh2 = await t.call(
      freshSession,
      "review.open",
      { inline: true },
      Buffer.from(receiptJson([{ path: "/w/fresh2.txt", sha256: sha256("fresh2") }])),
    );
    expect(fresh2.reviewId).toBeDefined();
  });
});

describe("P17b-1c Finding B2: In-flight open fails if session disconnected while openAgentPath paused", () => {
  it("paused openAgentPath, session closed, openAgentPath resolves -> request fails with not_found, handle closed, no tab to UI", async () => {
    // Mutation: not rechecking session liveness after openAgentPath resolves, allowing in-flight open to hand tabs to UI and leak grants with zero sessions
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((r) => (releaseOpen = r));
    let openStarted = false;
    let releaseStarted!: () => void;
    const startedGate = new Promise<void>((r) => (releaseStarted = r));

    const fakeFs = makeFakeFs();
    const originalOpenAgentPath = fakeFs.openAgentPath;
    fakeFs.openAgentPath = async (p: string) => {
      if (p === "/w/paused.txt") {
        openStarted = true;
        releaseStarted();
        await openGate;
      }
      return originalOpenAgentPath(p);
    };

    const t = await makeHost({ fakeFs });
    fakeFs.set("/w/paused.txt", "paused content");
    const s = await t.cli();

    // Start in-flight open
    const openPromise = t.open(s, ["/w/paused.txt"]);

    await startedGate;
    expect(openStarted).toBe(true);

    // Disconnect session while openAgentPath is in flight
    await t.host.onSessionClosed(s.sessionId);

    // Release openAgentPath
    releaseOpen();

    // Request must fail with not_found / closed error
    await expect(openPromise).rejects.toMatchObject({ code: "not_found" });

    // UI must not have received any tab
    expect(t.ui.calls.openFile).toHaveLength(0);

    // Handle must have been closed (no live handles leaking)
    expect(fakeFs.state.live).toBe(0);
  });
});

describe("P17b-1c Finding B3: Stalled handle close in first scope does not block invalidation of second scope", () => {
  it("first handle's close pending, second grant invalid immediately after disconnect", async () => {
    // Mutation: serializing scope cleanup behind handle close, so a stalled handle close in scope 1 leaves scope 2's tokens valid after disconnect
    let releaseClose1!: () => void;
    const close1Gate = new Promise<void>((r) => (releaseClose1 = r));

    const fakeFs = makeFakeFs();
    const originalOpenAgentPath = fakeFs.openAgentPath;
    fakeFs.openAgentPath = async (p: string) => {
      const res = await originalOpenAgentPath(p);
      if (res.ok && "handle" in res && res.handle && p === "/w/stalled.txt") {
        const origClose = res.handle.close;
        res.handle.close = async () => {
          await close1Gate;
          await origClose();
        };
      }
      return res;
    };

    const t = await makeHost({ fakeFs });
    fakeFs.set("/w/stalled.txt", "stalled");
    fakeFs.set("/w/normal.txt", "normal");
    const s = await t.cli();

    // Open file 1 (scope 1)
    await t.open(s, ["/w/stalled.txt"]);
    // Open file 2 (scope 2)
    await t.open(s, ["/w/normal.txt"]);

    expect(t.ui.calls.openFile).toHaveLength(2);
    const scopeId1 = t.ui.calls.openFile[0].scopeId;
    const token1 = t.ui.calls.openFile[0].token;
    const scopeId2 = t.ui.calls.openFile[1].scopeId;
    const token2 = t.ui.calls.openFile[1].token;

    // Both grants valid before disconnect
    expect(t.host.grants.get(token1, scopeId1)).toBeDefined();
    expect(t.host.grants.get(token2, scopeId2)).toBeDefined();

    // Disconnect session - returns a promise while handle 1 close is still pending on close1Gate
    const closeSessionPromise = t.host.onSessionClosed(s.sessionId);

    // Immediately after disconnect (synchronously! handle 1 close still pending), scope 2's grant MUST BE INVALID!
    expect(t.host.grants.get(token2, scopeId2)).toBeUndefined();
    expect(t.host.grants.get(token1, scopeId1)).toBeUndefined();

    // Release handle 1 close so cleanup completes cleanly
    releaseClose1();
    await closeSessionPromise;
  });

  it("stalled handle close wait is bounded and detaches late close", async () => {
    // Mutation: unbounded wait on handle close hanging onSessionClosed forever
    const fakeFs = makeFakeFs();
    const originalOpenAgentPath = fakeFs.openAgentPath;
    fakeFs.openAgentPath = async (p: string) => {
      const res = await originalOpenAgentPath(p);
      if (res.ok && "handle" in res && res.handle && p === "/w/forever.txt") {
        res.handle.close = async () => {
          return new Promise<void>(() => {}); // Never resolves
        };
      }
      return res;
    };

    const t = await makeHost({ fakeFs });
    fakeFs.set("/w/forever.txt", "forever");
    const s = await t.cli();

    await t.open(s, ["/w/forever.txt"]);
    const scopeId = t.ui.calls.openFile[0].scopeId;
    const token = t.ui.calls.openFile[0].token;

    let closed = false;
    const p = t.host.onSessionClosed(s.sessionId).then(() => {
      closed = true;
    });

    // Immediately invalidated
    expect(t.host.grants.get(token, scopeId)).toBeUndefined();

    // Advance clock past 2000ms bounded wait
    await t.clock.advance(2500);
    await p;
    expect(closed).toBe(true);
  });
});
