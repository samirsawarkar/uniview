import { describe, it, expect } from "vitest";
import path from "node:path";
import { createFakeClock, flush, makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { createApprovalManager, APPROVAL_LIMITS } from "../../electron/lib/agent-approval.mjs";
// @ts-expect-error plain ESM module without types
import { createEnrollmentStore } from "../../electron/lib/agent-enrollment.mjs";

type Answer = "allow_session" | "allow_always" | "deny";
type Call = { sessionId: string; client: { name: string; version: string }; signal: AbortSignal; answer: (a: unknown) => void; fail: (e: unknown) => void };

/** A native dialog the test answers by hand. */
function makeAsk() {
  const calls: Call[] = [];
  const ask = (req: { sessionId: string; client: { name: string; version: string }; signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      calls.push({ ...req, answer: resolve, fail: reject });
    });
  return { ask, calls };
}

function makeEnrollment() {
  const enrolled: string[] = [];
  return {
    enrolled,
    failWith: null as null | Error,
    async enroll({ name }: { name: string }) {
      if (this.failWith) throw this.failWith;
      enrolled.push(name);
      return { clientId: "a".repeat(32), name, enrolledAt: "2026-10-24T12:00:00.000Z" };
    },
  };
}

function setup() {
  const clock = createFakeClock();
  const dialog = makeAsk();
  const enrollment = makeEnrollment();
  const activity: Array<Record<string, unknown>> = [];
  const manager = createApprovalManager({ ask: dialog.ask, enrollment, activity: { add: (e: Record<string, unknown>) => activity.push(e) }, clock });
  return { clock, dialog, enrollment, activity, manager };
}

const client = (name = "Claude Code", version = "1.0") => ({ name, version });
const outcome = (p: Promise<unknown>) => p.then(() => "approved", (e: any) => e?.code ?? "error");

describe("agent approval manager", () => {
  it("states the spec limits: 4 queued, 120 s", () => {
    // Mutation: changing the limit constants
    expect(APPROVAL_LIMITS).toEqual({ queueMax: 4, timeoutMs: 120_000 });
  });

  it("the first call of a session asks once with the cleaned self-reported name; later calls do not ask", async () => {
    // Mutation: asking on every call, not asking at all, or showing the raw agent text
    const s = setup();
    const first = s.manager.require("s1", client("Claude‮ Code\u0000", "1.0"));
    await flush();
    expect(s.dialog.calls).toHaveLength(1);
    expect(s.dialog.calls[0]!.sessionId).toBe("s1");
    expect(s.dialog.calls[0]!.client).toEqual({ name: "Claude Code", version: "1.0" });
    s.dialog.calls[0]!.answer("allow_session");
    expect(await outcome(first)).toBe("approved");
    expect(await outcome(s.manager.require("s1", client()))).toBe("approved");
    expect(s.dialog.calls).toHaveLength(1);
    expect(s.manager.status("s1")).toBe("session");
  });

  it("allow for this session does not enroll; always allow enrolls the client and remembers its id", async () => {
    // Mutation: enrolling on "session", or not enrolling on "always"
    const s = setup();
    const a = s.manager.require("s1", client("A"));
    await flush();
    s.dialog.calls[0]!.answer("allow_session");
    await a;
    expect(s.enrollment.enrolled).toEqual([]);
    const b = s.manager.require("s2", client("B"));
    await flush();
    s.dialog.calls[1]!.answer("allow_always");
    await b;
    expect(s.enrollment.enrolled).toEqual(["B"]);
    expect(s.manager.status("s2")).toBe("always");
    expect(s.manager.clientIdOf("s2")).toBe("a".repeat(32));
    expect(s.manager.clientIdOf("s1")).toBeUndefined();
  });

  it("always allow with a real enrollment store writes the key and the record", async () => {
    // Mutation: wiring the manager to the wrong enrollment method
    const dir = path.join(await makeTempDir(), "agents");
    const store = createEnrollmentStore({ dir });
    await store.load();
    const clock = createFakeClock();
    const dialog = makeAsk();
    const manager = createApprovalManager({ ask: dialog.ask, enrollment: store, activity: { add() {} }, clock });
    const p = manager.require("s1", client("Claude Code"));
    await flush();
    dialog.calls[0]!.answer("allow_always");
    await p;
    expect(store.list().map((c: any) => c.name)).toEqual(["Claude Code"]);
    expect(manager.clientIdOf("s1")).toBe(store.list()[0].clientId);
  });

  it("if enrolling fails the session is still allowed for this session only, and it is logged", async () => {
    // Mutation: turning a storage failure into a denial, or silently claiming "always"
    const s = setup();
    s.enrollment.failWith = Object.assign(new Error("full"), { code: "busy" });
    const p = s.manager.require("s1", client("A"));
    await flush();
    s.dialog.calls[0]!.answer("allow_always");
    expect(await outcome(p)).toBe("approved");
    expect(s.manager.status("s1")).toBe("session");
    expect(s.activity.map((e) => e.type)).toContain("enroll_failed");
  });

  it("don't allow answers not_allowed and sticks for the session (no new dialog on the next call)", async () => {
    // Mutation: asking again on every call after a refusal, or letting the next call through
    const s = setup();
    const p = s.manager.require("s1", client());
    await flush();
    s.dialog.calls[0]!.answer("deny");
    expect(await outcome(p)).toBe("not_allowed");
    expect(await outcome(s.manager.require("s1", client()))).toBe("not_allowed");
    expect(s.dialog.calls).toHaveLength(1);
    expect(s.manager.status("s1")).toBe("denied");
  });

  it("anything but an explicit allow is a denial: unknown answers, a throwing or rejecting dialog", async () => {
    // Mutation: treating a truthy/unknown answer or a dialog error as consent
    for (const answer of ["yes", true, undefined, "ALLOW_SESSION", { x: 1 }]) {
      const s = setup();
      const p = s.manager.require("s1", client());
      await flush();
      s.dialog.calls[0]!.answer(answer);
      expect(await outcome(p)).toBe("not_allowed");
    }
    const rejecting = setup();
    const p2 = rejecting.manager.require("s1", client());
    await flush();
    rejecting.dialog.calls[0]!.fail(new Error("dialog crashed"));
    expect(await outcome(p2)).toBe("not_allowed");
    const clock = createFakeClock();
    const throwing = createApprovalManager({ ask: () => { throw new Error("no window"); }, enrollment: makeEnrollment(), activity: { add() {} }, clock });
    expect(await outcome(throwing.require("s1", client()))).toBe("not_allowed");
    const noAsk = createApprovalManager({ enrollment: makeEnrollment(), activity: { add() {} }, clock });
    expect(await outcome(noAsk.require("s1", client()))).toBe("not_allowed");
  });

  it("only one dialog is shown at a time; the next appears when the first is answered", async () => {
    // Mutation: showing every dialog at once
    const s = setup();
    const a = s.manager.require("s1", client("A"));
    const b = s.manager.require("s2", client("B"));
    await flush();
    expect(s.dialog.calls.map((c) => c.sessionId)).toEqual(["s1"]);
    s.dialog.calls[0]!.answer("allow_session");
    await a;
    await flush();
    expect(s.dialog.calls.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
    s.dialog.calls[1]!.answer("deny");
    expect(await outcome(b)).toBe("not_allowed");
  });

  it("limit: one shown plus 4 queued are accepted; the 6th waiting session is denied at once without being sticky (limit + 1)", async () => {
    // Mutation: queue cap off by one (3/5 queued), unbounded queue, or making the overflow denial permanent
    const s = setup();
    const ps = ["s1", "s2", "s3", "s4", "s5"].map((id) => s.manager.require(id, client(id)));
    await flush();
    expect(s.manager.dialogState()).toEqual({ showing: "s1", queued: 4 });
    const sixth = s.manager.require("s6", client("s6"));
    expect(await outcome(sixth)).toBe("not_allowed");
    expect(s.manager.dialogState()).toEqual({ showing: "s1", queued: 4 });
    expect(s.activity.map((e) => e.type)).toContain("approval_queue_full");
    for (let i = 0; i < 5; i++) {
      await flush();
      s.dialog.calls[i]!.answer("allow_session");
      await ps[i];
    }
    expect(s.dialog.calls).toHaveLength(5);
    // The overflowed session can try again once there is room, and is then asked.
    const again = s.manager.require("s6", client("s6"));
    await flush();
    expect(s.dialog.calls[5]!.sessionId).toBe("s6");
    s.dialog.calls[5]!.answer("allow_session");
    expect(await outcome(again)).toBe("approved");
  });

  it("a dialog unanswered for 120 s is denied: still waiting at 119 999 ms (limit), denied at 120 000 ms, and the dialog is dismissed", async () => {
    // Mutation: a different timeout, no timeout, or leaving the dialog open
    const s = setup();
    const p = s.manager.require("s1", client());
    await flush();
    const signal = s.dialog.calls[0]!.signal;
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await s.clock.advance(119_999);
    expect(settled).toBe(false);
    expect(signal.aborted).toBe(false);
    await s.clock.advance(1);
    expect(await outcome(p)).toBe("not_allowed");
    expect(signal.aborted).toBe(true);
    expect(s.manager.status("s1")).toBe("denied");
    expect(s.activity.map((e) => e.type)).toContain("approval_timeout");
  });

  it("an answer that arrives after the timeout is ignored", async () => {
    // Mutation: letting a late "allow" overturn the timeout denial
    const s = setup();
    const p = s.manager.require("s1", client());
    await flush();
    await s.clock.advance(120_000);
    await outcome(p);
    s.dialog.calls[0]!.answer("allow_always");
    await flush();
    expect(s.manager.status("s1")).toBe("denied");
    expect(s.enrollment.enrolled).toEqual([]);
  });

  it("the 120 s clock starts when a dialog is shown, not when it is queued; and an answer cancels the timer", async () => {
    // Mutation: timing queued requests from enqueue (they would be denied unseen), or leaking the timer after an answer
    const s = setup();
    const a = s.manager.require("s1", client());
    const b = s.manager.require("s2", client());
    await flush();
    await s.clock.advance(100_000);
    s.dialog.calls[0]!.answer("allow_session");
    await a;
    await flush();
    await s.clock.advance(119_999);
    expect(s.manager.status("s2")).toBe("pending");
    expect(s.manager.dialogState().showing).toBe("s2");
    s.dialog.calls[1]!.answer("allow_session");
    await b;
    expect(s.clock.pending()).toBe(0);
  });

  it("concurrent calls of one session share one dialog", async () => {
    // Mutation: one dialog per call (a chatty agent would flood the person)
    const s = setup();
    const ps = [s.manager.require("s1", client()), s.manager.require("s1", client()), s.manager.require("s1", client())];
    await flush();
    expect(s.dialog.calls).toHaveLength(1);
    expect(s.manager.dialogState()).toEqual({ showing: "s1", queued: 0 });
    s.dialog.calls[0]!.answer("allow_session");
    expect(await Promise.all(ps.map(outcome))).toEqual(["approved", "approved", "approved"]);
  });

  it("closing the connection of the session being asked dismisses the dialog and shows the next one", async () => {
    // Mutation: leaving a dialog open for a dead session, or stalling the queue behind it
    const s = setup();
    const a = s.manager.require("s1", client());
    const b = s.manager.require("s2", client());
    await flush();
    s.manager.sessionClosed("s1");
    expect(s.dialog.calls[0]!.signal.aborted).toBe(true);
    expect(await outcome(a)).toBe("not_allowed");
    await flush();
    expect(s.dialog.calls.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
    expect(s.clock.pending()).toBe(1);
    s.dialog.calls[1]!.answer("allow_session");
    await b;
    expect(s.clock.pending()).toBe(0);
    // The dead session's late answer changes nothing.
    s.dialog.calls[0]!.answer("allow_always");
    await flush();
    expect(s.manager.status("s1")).toBe("none");
    expect(s.enrollment.enrolled).toEqual([]);
  });

  it("closing a queued session removes it from the queue", async () => {
    // Mutation: showing a dialog for a session that is already gone
    const s = setup();
    const a = s.manager.require("s1", client());
    const b = s.manager.require("s2", client());
    await flush();
    s.manager.sessionClosed("s2");
    expect(await outcome(b)).toBe("not_allowed");
    expect(s.manager.dialogState()).toEqual({ showing: "s1", queued: 0 });
    s.dialog.calls[0]!.answer("allow_session");
    await a;
    await flush();
    expect(s.dialog.calls).toHaveLength(1);
  });

  it("a session closed while its always-allow is being stored does not come back approved", async () => {
    // Mutation: recording approval after the connection is gone (a leaked entry)
    const clock = createFakeClock();
    const dialog = makeAsk();
    let finishEnroll!: () => void;
    const enrollment = {
      enroll: () => new Promise((resolve) => (finishEnroll = () => resolve({ clientId: "b".repeat(32), name: "A", enrolledAt: "x" }))),
    };
    const manager = createApprovalManager({ ask: dialog.ask, enrollment, activity: { add() {} }, clock });
    const p = manager.require("s1", client("A"));
    await flush();
    dialog.calls[0]!.answer("allow_always");
    await flush();
    manager.sessionClosed("s1");
    finishEnroll();
    await outcome(p);
    expect(manager.status("s1")).toBe("none");
  });

  it("an enrolled session (valid proof) is approved without asking, and revoking its client denies its sessions", async () => {
    // Mutation: asking an enrolled client again, or revocation leaving its session approved
    const s = setup();
    s.manager.recordEnrolled("s1", "c".repeat(32));
    s.manager.recordEnrolled("s2", "c".repeat(32));
    s.manager.recordEnrolled("s3", "d".repeat(32));
    expect(await outcome(s.manager.require("s1", client()))).toBe("approved");
    expect(s.dialog.calls).toHaveLength(0);
    expect(s.manager.status("s1")).toBe("always");
    expect(s.manager.sessionsOfClient("c".repeat(32)).sort()).toEqual(["s1", "s2"]);
    expect(s.manager.revokeClient("c".repeat(32)).sort()).toEqual(["s1", "s2"]);
    expect(await outcome(s.manager.require("s1", client()))).toBe("not_allowed");
    expect(await outcome(s.manager.require("s3", client()))).toBe("approved");
    expect(s.dialog.calls).toHaveLength(0);
  });

  it("outcomes are written to the activity log with the session and the cleaned name", async () => {
    // Mutation: an approval that leaves no trace in the audit trail
    const s = setup();
    const p = s.manager.require("s1", client("Agent‮"));
    await flush();
    s.dialog.calls[0]!.answer("allow_always");
    await p;
    const q = s.manager.require("s2", client("Other"));
    await flush();
    s.dialog.calls[1]!.answer("deny");
    await outcome(q);
    expect(s.activity).toEqual([
      { type: "approved", sessionId: "s1", client: "Agent", detail: "always" },
      { type: "denied", sessionId: "s2", client: "Other", detail: "refused" },
    ]);
  });

  it("closing a session forgets its approval", async () => {
    // Mutation: approvals outliving their connection (unbounded growth)
    const s = setup();
    const p = s.manager.require("s1", client());
    await flush();
    s.dialog.calls[0]!.answer("allow_session");
    await p;
    s.manager.sessionClosed("s1");
    expect(s.manager.status("s1")).toBe("none");
  });
});
