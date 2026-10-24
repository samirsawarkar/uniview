// Agent approval manager (P17b): consent for MCP sessions. Plain Node ESM, no Electron imports.
//
// The first bridge request of an MCP session that is not yet approved asks the person (a native dialog the
// wiring packet provides as `ask`): "An agent that says it is <name> wants to show files and ask for reviews in
// UniView" with three answers:
//   "allow_session"  this connection only
//   "allow_always"   also enrol the client (agent-enrollment.mjs): later sessions prove themselves with a key
//   "deny"           (anything else, a failing dialog, or no answer for 120 s is a denial too)
//
// Rules (spec "Agent approval", "Aggregate limits"):
// - one dialog is shown at a time; further sessions queue, at most 4. A session that would be the 6th waiting is
//   refused at once (not_allowed) and may ask again later; that refusal is not remembered.
// - a dialog unanswered for 120 s (counted from when it is shown) is dismissed and the session is denied.
// - a denial (answer or timeout) is remembered for the life of the session: its next calls fail without a dialog.
// - concurrent calls of one session share one dialog.
// - closing the connection dismisses its dialog or removes it from the queue.
// The CLI is not subject to approval (same OS user, local only); the host only calls `require` for MCP sessions.
//
//   const approval = createApprovalManager({ ask, enrollment, activity, clock });
//   await approval.require(sessionId, { name, version });   // resolves, or rejects with BridgeError("not_allowed")
//   ask({ sessionId, client: { name, version }, signal }) -> Promise<"allow_session" | "allow_always" | "deny">
//     `signal` aborts when the dialog must be dismissed (timeout, connection closed).

import { BridgeError } from "./bridge-proto.mjs";
import { cleanLabel } from "./agent-util.mjs";

export const APPROVAL_LIMITS = Object.freeze({ queueMax: 4, timeoutMs: 120_000 });

const MAX_NAME = 80;
const MAX_VERSION = 40;

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

const notAllowed = () => new BridgeError("not_allowed", "not_allowed");

/**
 * @param {{
 *   ask?: (req: { sessionId: string, client: { name: string, version: string }, signal: AbortSignal }) => Promise<string>,
 *   enrollment: { enroll(args: { name: string }): Promise<{ clientId: string }> },
 *   activity?: { add(entry: object): void },
 *   clock?: { setTimeout(fn: () => void, ms: number): any, clearTimeout(h: any): void },
 *   limits?: { queueMax: number, timeoutMs: number }
 * }} options
 */
export function createApprovalManager({ ask, enrollment, activity, clock = realClock, limits = APPROVAL_LIMITS }) {
  /** Decided sessions: status "session" | "always" | "denied", plus the enrolled clientId. */
  const states = new Map();
  /** Sessions waiting for an answer (shown or queued): sessionId -> entry. */
  const pending = new Map();
  const queue = [];
  let current = null;

  function log(type, entry, detail) {
    try {
      activity?.add({ type, sessionId: entry.sessionId, client: entry.client.name, ...(detail === undefined ? {} : { detail }) });
    } catch {}
  }

  function present(entry) {
    current = entry;
    entry.controller = new AbortController();
    entry.timer = clock.setTimeout(() => void finish(entry, "timeout"), limits.timeoutMs);
    let answer;
    try {
      answer = Promise.resolve(ask({ sessionId: entry.sessionId, client: { ...entry.client }, signal: entry.controller.signal }));
    } catch (err) {
      answer = Promise.reject(err);
    }
    answer.then(
      (value) => void finish(entry, value),
      () => void finish(entry, "deny"),
    );
  }

  function presentNext() {
    if (current) return;
    const next = queue.shift();
    if (next) present(next);
  }

  async function finish(entry, answer) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    entry.controller?.abort();
    if (current === entry) current = null;
    let status = "denied";
    let clientId;
    let detail = answer === "timeout" ? "no answer" : "refused";
    if (answer === "allow_session") {
      status = "session";
      detail = "session";
    } else if (answer === "allow_always") {
      try {
        ({ clientId } = await enrollment.enroll({ name: entry.client.name }));
        status = "always";
        detail = "always";
      } catch {
        status = "session";
        detail = "session";
        log("enroll_failed", entry, "allowed for this session only");
      }
    }
    try {
      if (!entry.gone) {
        states.set(entry.sessionId, clientId === undefined ? { status } : { status, clientId });
        log(answer === "timeout" ? "approval_timeout" : status === "denied" ? "denied" : "approved", entry, detail);
      }
    } finally {
      pending.delete(entry.sessionId);
      if (entry.gone || status === "denied") entry.reject(notAllowed());
      else entry.resolve();
      presentNext();
    }
  }

  return {
    limits,

    /** Resolves when the session may use UniView; rejects with BridgeError("not_allowed") otherwise. */
    require(sessionId, client = {}) {
      const state = states.get(sessionId);
      if (state) return state.status === "denied" ? Promise.reject(notAllowed()) : Promise.resolve();
      const waiting = pending.get(sessionId);
      if (waiting) return waiting.promise;

      const entry = {
        sessionId,
        client: { name: cleanLabel(client.name, MAX_NAME), version: cleanLabel(client.version, MAX_VERSION) },
        settled: false,
        gone: false,
      };
      if (current && queue.length >= limits.queueMax) {
        log("approval_queue_full", entry);
        return Promise.reject(notAllowed());
      }
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      // Callers await the promise; this keeps a rejection nobody is waiting for any more from being "unhandled".
      entry.promise.catch(() => {});
      pending.set(sessionId, entry);
      if (current) queue.push(entry);
      else present(entry);
      return entry.promise;
    },

    /** A session whose hello carried a valid enroll proof: approved for good, without asking. */
    recordEnrolled(sessionId, clientId) {
      states.set(sessionId, { status: "always", clientId });
    },

    /** "none" | "session" | "always" | "denied", or "pending" while a dialog is open or queued. */
    status(sessionId) {
      const state = states.get(sessionId);
      if (state) return state.status;
      return pending.has(sessionId) ? "pending" : "none";
    },

    clientIdOf(sessionId) {
      return states.get(sessionId)?.clientId;
    },

    sessionsOfClient(clientId) {
      return [...states].filter(([, s]) => s.clientId === clientId).map(([id]) => id);
    },

    /** Denies every session approved through this client; returns their ids so the host can close them. */
    revokeClient(clientId) {
      const ids = this.sessionsOfClient(clientId);
      for (const id of ids) states.set(id, { status: "denied" });
      return ids;
    },

    dialogState() {
      return { showing: current ? current.sessionId : null, queued: queue.length };
    },

    /** The connection is gone: forget its approval, dismiss its dialog or drop it from the queue. */
    sessionClosed(sessionId) {
      states.delete(sessionId);
      const entry = pending.get(sessionId);
      if (!entry) return;
      entry.gone = true;
      if (entry.settled) return; // already being finished; finish() will not record anything for a gone session
      entry.settled = true;
      if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
      entry.controller?.abort();
      pending.delete(sessionId);
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      if (current === entry) current = null;
      entry.reject(notAllowed());
      presentNext();
    },
  };
}
