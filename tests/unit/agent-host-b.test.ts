import { describe, it, expect } from "vitest";
import path from "node:path";
import crypto from "node:crypto";
import { flush, makeHost, newSession, receiptJson, sha256, specJson, makeFakeFs } from "./agent-host-helpers";
// @ts-expect-error plain ESM module without types
import { HOST_LIMITS, BRIDGE_OPS } from "../../electron/lib/agent-host.mjs";
// @ts-expect-error plain ESM module without types
import { enrollProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { readClientKey } from "../../electron/lib/agent-enrollment.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore } from "../../electron/lib/review-store.mjs";

describe("P17b-1b Finding 1: Review finalization is one authoritative idempotent transition", () => {
  it("closing a review tab during decideReview does not corrupt quota counters; limits 8 and 32 hold", async () => {
    // Mutation: duplicate decrement in tabClosed catch path when competing dismissal fails,
    // which caused pendingReviews to drop to -1 and allowed a session to open 9 pending reviews instead of 8.
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => (releaseSave = r));
    let saveEntered = false;
    let releaseEntered!: () => void;
    const enteredGate = new Promise<void>((r) => (releaseEntered = r));

    const t = await makeHost();
    const realStore = createDecisionStore({ dir: path.join(t.root, "reviews") });

    const store = {
      ...realStore,
      async save(decision: any) {
        saveEntered = true;
        releaseEntered();
        await saveGate;
        return realStore.save(decision);
      },
      async get(id: string) {
        return realStore.get(id);
      },
    };

    const hostWithStore = await makeHost({ store });
    const s = await hostWithStore.cli();
    hostWithStore.fakeFs.set("/w/f0.txt", "v0");
    const { reviewId } = await hostWithStore.call(
      s,
      "review.open",
      { inline: true },
      Buffer.from(receiptJson([{ path: "/w/f0.txt", sha256: sha256("v0") }])),
    );
    const scopeId = hostWithStore.ui.calls.showReview[0].scopeId;

    const sessionBefore = hostWithStore.host.listSessions().find((x: any) => x.sessionId === s.sessionId);
    expect(sessionBefore.pendingReviews).toBe(1);

    // Verify first so shown is populated for approved decision
    await hostWithStore.host.verifyReview(reviewId);

    // Start decideReview: enters save and waits on saveGate
    const decidePromise = hostWithStore.host.decideReview({ reviewId, decision: "approved" });
    await enteredGate;
    expect(saveEntered).toBe(true);

    // tabClosed runs while decide is pending; competing dismissal fails
    await hostWithStore.host.tabClosed(scopeId);

    // Release the save so decide completes
    releaseSave();
    const result = await decidePromise;
    expect(result.ok).toBe(true);

    // Counters must be 0, never negative (-1)
    const sessionAfter = hostWithStore.host.listSessions().find((x: any) => x.sessionId === s.sessionId);
    expect(sessionAfter.pendingReviews).toBe(0);
    expect(sessionAfter.pendingReviews).toBeGreaterThanOrEqual(0);

    // Test per-session limit: 8 pending reviews hold (limit and limit+1)
    for (let i = 1; i <= 8; i++) {
      hostWithStore.fakeFs.set(`/w/f${i}.txt`, `v${i}`);
      const r = await hostWithStore.call(
        s,
        "review.open",
        { inline: true },
        Buffer.from(receiptJson([{ path: `/w/f${i}.txt`, sha256: sha256(`v${i}`) }])),
      );
      expect(r.reviewId).toBeDefined();
    }
    const sessionAt8 = hostWithStore.host.listSessions().find((x: any) => x.sessionId === s.sessionId);
    expect(sessionAt8.pendingReviews).toBe(8);

    // 9th review (limit + 1) must be refused with busy
    hostWithStore.fakeFs.set("/w/f9.txt", "v9");
    expect(
      await hostWithStore.fail(
        s,
        "review.open",
        { inline: true },
        Buffer.from(receiptJson([{ path: "/w/f9.txt", sha256: sha256("v9") }])),
      ),
    ).toBe("busy");

    // Test aggregate limit: 32 total reviews hold (limit and limit+1)
    // s currently holds 8 reviews. We open 8 in s2, 8 in s3, and 8 in s4 (total = 32).
    const s2 = await hostWithStore.cli();
    const s3 = await hostWithStore.cli();
    const s4 = await hostWithStore.cli();
    let idx = 10;
    for (const sess of [s2, s3, s4]) {
      for (let j = 0; j < 8; j++) {
        idx++;
        hostWithStore.fakeFs.set(`/w/f${idx}.txt`, `v${idx}`);
        await hostWithStore.call(
          sess,
          "review.open",
          { inline: true },
          Buffer.from(receiptJson([{ path: `/w/f${idx}.txt`, sha256: sha256(`v${idx}`) }])),
        );
      }
    }

    // 33rd review total across all sessions (limit + 1) must be refused with busy
    const s5 = await hostWithStore.cli();
    hostWithStore.fakeFs.set("/w/f_overflow.txt", "v_overflow");
    expect(
      await hostWithStore.fail(
        s5,
        "review.open",
        { inline: true },
        Buffer.from(receiptJson([{ path: "/w/f_overflow.txt", sha256: sha256("v_overflow") }])),
      ),
    ).toBe("busy");
  }, 30000);
});

describe("P17b-1b Finding 2: Disconnect during enrollment persistence rejects op", () => {
  it("Always allow answered, enrollment persistence paused, close session, finish persistence -> no tab opened, request fails", async () => {
    // Mutation: finish() resolving approval despite entry.gone, so disconnected request returns {opened:1}
    let releaseEnroll!: () => void;
    const enrollGate = new Promise<void>((r) => (releaseEnroll = r));
    let enrollStarted = false;
    let releaseStarted!: () => void;
    const startedGate = new Promise<void>((r) => (releaseStarted = r));

    const mockEnrollment = {
      async enroll({ name }: { name: string }) {
        enrollStarted = true;
        releaseStarted();
        await enrollGate;
        return { clientId: "a".repeat(32) };
      },
      async verify() {
        return true;
      },
      async remove() {
        return true;
      },
      list() {
        return [];
      },
    };

    const t = await makeHost({ enrollment: mockEnrollment });
    t.fakeFs.set("/w/a.txt", "a");
    const s = await t.mcp("PauseAgent");

    const reqPromise = t.open(s, ["/w/a.txt"]);
    await flush();

    expect(t.dialog.calls).toHaveLength(1);
    t.dialog.calls[0]!.answer("allow_always");

    await startedGate;
    expect(enrollStarted).toBe(true);

    // Close session while enrollment persistence is held
    await t.host.onSessionClosed(s.sessionId);

    // Finish persistence
    releaseEnroll();

    // Request must fail with not_allowed and NO tab opened
    await expect(reqPromise).rejects.toMatchObject({ code: "not_allowed" });
    expect(t.ui.calls.openFile).toHaveLength(0);
  });
});

describe("P17b-1b Finding 3: Revocation and session close release grant scopes", () => {
  async function setupEnrolledClient(t: any, name = "RevokeAgent") {
    const s = await t.mcp(name);
    const p = t.fail(s, "review.get", { reviewId: "x" });
    await t.dialog.answer("allow_always");
    await p;
    const found = await readClientKey({ dir: `${t.root}/agents`, name });
    return { clientId: found.clientId as string, key: found.key as Buffer };
  }

  it("revocation releases every grant scope of that session, closes handles, and invalidates grants", async () => {
    // Mutation: revokeClient failing to close session scopes, leaving handles open and grants valid
    const t = await makeHost();
    const { clientId, key } = await setupEnrolledClient(t);
    const s = newSession({ autoCli: false });
    await t.call(s, "mcp.hello", { client: { name: "RevokeAgent", version: "1" }, protocolVersion: "2025-06-18", enroll: { clientId, proof: enrollProof(key, s.serverNonce, s.clientNonce).toString("base64") } });
    t.fakeFs.set("/w/secret.txt", "top secret");
    await t.open(s, ["/w/secret.txt"]);

    const { scopeId, token } = t.ui.calls.openFile[0];
    expect(t.fakeFs.state.live).toBe(1);
    expect(t.host.grants.get(token, scopeId)).toBeDefined();

    await t.host.revokeClient(clientId);

    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.get(token, scopeId)).toBeUndefined();
  });

  it("connection-close (onSessionClosed) releases every grant scope of that session, closes handles, and invalidates grants", async () => {
    // Mutation: onSessionClosed failing to close session scopes
    const t = await makeHost();
    const s = await t.cli();
    t.fakeFs.set("/w/conn.txt", "conn data");
    await t.open(s, ["/w/conn.txt"]);

    const { scopeId, token } = t.ui.calls.openFile[0];
    expect(t.fakeFs.state.live).toBe(1);
    expect(t.host.grants.get(token, scopeId)).toBeDefined();

    await t.host.onSessionClosed(s.sessionId);

    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.get(token, scopeId)).toBeUndefined();
  });
});

describe("P17b-1b Finding 4: verifyReview AbortSignal cancellation on tabClosed, decision, and close", () => {
  function makeDelayedFs() {
    const fs = makeFakeFs();
    const origOpen = fs.openAgentPath.bind(fs);
    let delayed = false;
    let releaseRead: () => void = () => {};
    let readEntered = false;
    let releaseEntered: () => void = () => {};

    const openAgentPath = async (p: string) => {
      const res = await origOpen(p);
      if (p === "/w/delayed.txt" && res.ok && res.handle) {
        const handle = res.handle;
        const origRead = handle.read.bind(handle);
        handle.read = async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          if (delayed) {
            readEntered = true;
            releaseEntered();
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
              setTimeout(resolve, 10000); // safety fallback
            });
          }
          return origRead(buffer, offset, length, position);
        };
      }
      return res;
    };

    return {
      ...fs,
      openAgentPath,
      setDelayed(d: boolean) {
        delayed = d;
      },
      waitForRead: () =>
        new Promise<void>((r) => {
          if (readEntered) r();
          else releaseEntered = r;
        }),
      releaseRead: () => releaseRead(),
    };
  }

  it("verifyReview is cancelled on tabClosed with a delayed read", async () => {
    // Mutation: verifyReview passing no signal to verifier; tab close does not cancel the pass
    const delayedFs = makeDelayedFs();
    delayedFs.set("/w/delayed.txt", "slow data");
    const t = await makeHost({ openAgentPath: delayedFs.openAgentPath, fakeFs: delayedFs });
    const s = await t.cli();
    const text = receiptJson([{ path: "/w/delayed.txt", sha256: sha256("slow data") }]);
    const { reviewId } = await t.call(s, "review.open", { inline: true }, Buffer.from(text));
    const scopeId = t.ui.calls.showReview[0].scopeId;

    delayedFs.setDelayed(true);
    const verifyPromise = t.host.verifyReview(reviewId);
    await delayedFs.waitForRead();

    // Closing the tab must abort the verifier pass immediately
    await t.host.tabClosed(scopeId);
    const result = await verifyPromise;
    expect(result.results[0].state).toBe("unreadable");
  });

  it("verifyReview is cancelled on decision completion", async () => {
    // Mutation: decision completion does not cancel the verifier pass
    const delayedFs = makeDelayedFs();
    delayedFs.set("/w/delayed.txt", "slow data");
    const t = await makeHost({ openAgentPath: delayedFs.openAgentPath, fakeFs: delayedFs });
    const s = await t.cli();
    const text = receiptJson([{ path: "/w/delayed.txt", sha256: sha256("slow data") }]);
    const { reviewId } = await t.call(s, "review.open", { inline: true }, Buffer.from(text));

    delayedFs.setDelayed(true);
    const verifyPromise = t.host.verifyReview(reviewId);
    await delayedFs.waitForRead();

    // Dismissing the review must abort the verifier pass
    await t.host.decideReview({ reviewId, decision: "dismissed" });
    const result = await verifyPromise;
    expect(result.results[0].state).toBe("unreadable");
  });

  it("verifyReview is cancelled on session close / revocation", async () => {
    // Mutation: session close does not cancel in-flight verifications
    const delayedFs = makeDelayedFs();
    delayedFs.set("/w/delayed.txt", "slow data");
    const t = await makeHost({ openAgentPath: delayedFs.openAgentPath, fakeFs: delayedFs });
    const s = await t.cli();
    const text = receiptJson([{ path: "/w/delayed.txt", sha256: sha256("slow data") }]);
    const { reviewId } = await t.call(s, "review.open", { inline: true }, Buffer.from(text));

    delayedFs.setDelayed(true);
    const verifyPromise = t.host.verifyReview(reviewId);
    await delayedFs.waitForRead();

    await t.host.onSessionClosed(s.sessionId);
    const result = await verifyPromise;
    expect(result.results[0].state).toBe("unreadable");
  });
});

describe("P17b-1b Finding 5: Session unidentified until hello", () => {
  it("first request without hello -> not_allowed", async () => {
    // Mutation: allowing requests without hello (treating un-helloed sessions as CLI)
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "a");
    const raw = newSession({ autoCli: false });
    expect(await t.fail(raw, "open", {}, Buffer.from(JSON.stringify(["/w/a.txt"])))).toBe("not_allowed");
    expect(await t.fail(raw, "view.show", { inline: true }, Buffer.from(specJson()))).toBe("not_allowed");
    expect(await t.fail(raw, "review.open", { inline: true }, Buffer.from(receiptJson([])))).toBe("not_allowed");
    expect(await t.fail(raw, "review.wait", { reviewId: "dummy" })).toBe("not_allowed");
    expect(await t.fail(raw, "review.get", { reviewId: "dummy" })).toBe("not_allowed");
  });

  it("cli.hello then ops work with no dialog", async () => {
    // Mutation: requiring approval for CLI, or not registering cli.hello
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "a");
    const s = newSession({ autoCli: false });
    expect(await t.call(s, "cli.hello", { version: "1" })).toEqual({ version: "1" });
    expect(await t.open(s, ["/w/a.txt"])).toEqual({ opened: 1 });
    expect(t.dialog.calls).toHaveLength(0);
    expect(t.host.listSessions().find((x: any) => x.sessionId === s.sessionId)).toMatchObject({
      kind: "cli",
      approval: "not_required",
    });
  });

  it("mcp.hello path unchanged: approval applies", async () => {
    // Mutation: breaking mcp.hello approval path
    const t = await makeHost();
    t.fakeFs.set("/w/a.txt", "a");
    const s = newSession({ autoCli: false });
    expect(await t.call(s, "mcp.hello", { client: { name: "Agent", version: "1" } })).toEqual({ enrolled: false });
    const p = t.open(s, ["/w/a.txt"]);
    await flush();
    expect(t.dialog.calls).toHaveLength(1);
    await t.dialog.answer("allow_session");
    expect(await p).toEqual({ opened: 1 });
  });

  it("second hello on a session is bad_request", async () => {
    // Mutation: allowing re-hello or switching session kind
    const t = await makeHost();
    const s1 = newSession({ autoCli: false });
    await t.call(s1, "cli.hello", { version: "1" });
    expect(await t.fail(s1, "cli.hello", { version: "1" })).toBe("bad_request");
    expect(await t.fail(s1, "mcp.hello", { client: { name: "x" } })).toBe("bad_request");

    const s2 = newSession({ autoCli: false });
    await t.call(s2, "mcp.hello", { client: { name: "x" } });
    expect(await t.fail(s2, "cli.hello", { version: "1" })).toBe("bad_request");
    expect(await t.fail(s2, "mcp.hello", { client: { name: "y" } })).toBe("bad_request");
  });
});
