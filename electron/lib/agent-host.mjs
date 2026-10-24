// Agent host (P17b-1): the server side of the local bridge for agents. Plain Node ESM, no Electron imports:
// the path policy, file system, dialogs, clock and UI are all injected. The wiring packet (P17c) builds one host
// in electron/main.mjs and connects it to startBridgeServer, the renderer and the Agents panel.
//
// ---- Wiring ---------------------------------------------------------------------------------------------
//   const host = createAgentHost({
//     openAgentPath,   // (path) => Promise<{ ok, handle, canonical, size, dev, ino } | { ok: false, code, reason }>  path policy
//     store,           // createDecisionStore(...)       review decisions on disk
//     verifier,        // createVerifier({ openAgentPath })
//     enrollment,      // createEnrollmentStore(...), already load()ed
//     activity,        // createActivityLog(...), already load()ed
//     ask,             // native approval dialog, see agent-approval.mjs
//     ui,              // { openFile, showView, showReview, closeTab? }  (below)
//     closeSession,    // (sessionId) => void   destroys that bridge connection (used when a client is revoked)
//     grants,          // optional AgentGrantStore (default: a new one); the protocol/IPC readers use host.grants
//     clock,           // optional { now, setTimeout, clearTimeout }
//   });
//   startBridgeServer({ endpoint, key, onRequest: host.onRequest, onSessionClosed: host.onSessionClosed });
//
//   ui.openFile({ scopeId, token, name, canonical, size, sessionId, agent })        one tab per file; reads use host.grants.get(token, scopeId)
//   ui.showView({ scopeId, specBytes, spec, sessionId, agent })
//   ui.showReview({ scopeId, reviewId, receiptDigest, receipt, receiptBytes, view, sessionId, agent })
//        view: { specBytes, spec } | { error: "bad_path" | "invalid_spec" } | null   (the receipt's own `view`)
//   Each returns a promise; rejecting (code "busy" for the renderer-not-ready queue) rolls the request back.
//
// ---- Bridge ops (the one canonical set; params in the frame header, documents as the raw body) ---------------
//   mcp.hello       {client:{name,version}, protocolVersion, enroll?:{clientId, proof}}  must be the first request of an MCP
//                   connection; it marks the session as MCP (subject to approval). A connection that never sends it is
//                   the command line (not subject to approval). enroll.proof = base64 enrollProof over the connection's
//                   nonces. -> {enrolled: boolean}. A bad or removed enrolment -> not_allowed.
//   open            {}  body = UTF-8 JSON array of 1..20 absolute paths    -> {opened: n}   all or nothing (bad_path / busy)
//   view.show       {path} | {inline: true} + body = spec bytes            -> {scopeId}
//   review.open     {path} | {inline: true} + body = receipt bytes         -> {reviewId}
//   review.wait     {reviewId, timeoutMs}  -> {status:"decided", decision} | {status:"pending"} (timed out or cancelled)
//   review.cancelWait {reviewId}           -> {}   ends this session's waits on the review; the review stays open
//   review.get      {reviewId}             -> {status:"decided", decision} | {status:"pending"}
// Errors are BridgeError codes: bad_request, bad_path, invalid_spec, invalid_receipt, busy, not_allowed, not_found,
// unknown_method, internal. Reviews are visible only to the session that opened them (else not_found).
//
// ---- For the app (renderer / Agents panel) --------------------------------------------------------------------
//   host.tabClosed(scopeId)                         the tab was closed: closes its handles; an undecided review is dismissed
//   host.viewGrant(scopeId, path)                   grant for an image/fileRef path the view itself names -> {token, name, size, canonical}
//   host.verifyReview(reviewId)                     hashes the receipt files (what is shown) -> verifier result
//   host.decideReview({reviewId, decision, comment}) approved | changes_requested | dismissed; {ok:false, code:"changed", current} blocks
//   host.getReview(reviewId)                        {reviewId, receiptDigest, receipt, decision|null, shown|null, sessionId|null} or null
//   host.listSessions() / listClients() / listActivity()
//   host.revokeClient(clientId)                     removes the enrolment, cancels its waits, closes its sessions
//   host.dispose()                                  shutdown: cancels waits, closes every agent handle

import path from "node:path";
import { BridgeError } from "./bridge-proto.mjs";
import { AgentGrantStore, MAX_AGENT_PATH } from "./agent-paths.mjs";
import { createApprovalManager } from "./agent-approval.mjs";
import { cleanLabel } from "./agent-util.mjs";
import { openReview, decide, ReviewError } from "./review-verify.mjs";
import { validateViewSpec } from "../../shared/viewspec.mjs";

export const HOST_LIMITS = Object.freeze({
  maxPaths: 20,
  maxPathLength: MAX_AGENT_PATH,
  maxAgentTabs: 64,
  tabsPerMinute: 30,
  rateWindowMs: 60_000,
  pendingReviewsPerSession: 8,
  pendingReviewsTotal: 32,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxWaitMs: 2 ** 31 - 1,
  decidedKeptPerSession: 100,
});

export const BRIDGE_OPS = Object.freeze(["mcp.hello", "open", "view.show", "review.open", "review.wait", "review.cancelWait", "review.get"]);

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const err = (code) => new BridgeError(code, code);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function closeQuietly(handle) {
  try {
    const p = handle?.close?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

/** Paths a spec names for images and file references; only these may get grants in its scope. */
function declaredPaths(spec) {
  const found = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
    } else if (isObject(node)) {
      if ((node.type === "image" || node.type === "fileRef") && typeof node.path === "string") found.add(node.path);
      for (const v of Object.values(node)) visit(v);
    }
  };
  visit(spec);
  return found;
}

/** @param {Record<string, any>} deps see the header comment */
export function createAgentHost(deps) {
  const {
    openAgentPath,
    store,
    verifier,
    enrollment,
    activity,
    ask,
    ui,
    closeSession,
    clock = realClock,
  } = deps;
  const grants = deps.grants ?? new AgentGrantStore();
  const L = HOST_LIMITS;
  const approval = createApprovalManager({ ask, enrollment, activity, clock });

  /** sessionId -> per-connection state, created by the connection's first request. */
  const sessions = new Map();
  /** scopeId -> { kind: "file"|"view"|"review", sessionId, reviewId?, declared?: Set, granted?: Map } */
  const tabs = new Map();
  /** reviewId -> review record */
  const reviews = new Map();
  /** sessionId -> decided review ids, oldest first (bounded) */
  const decidedBySession = new Map();
  let reservedTabs = 0;
  let pendingTotal = 0;
  let reservedReviews = 0;

  function log(type, state, detail) {
    try {
      activity?.add({ type, sessionId: state?.sessionId, client: state?.client?.name, ...(detail === undefined ? {} : { detail }) });
    } catch {}
  }

  function stateFor(session) {
    let state = sessions.get(session.sessionId);
    if (!state) {
      state = {
        sessionId: session.sessionId,
        kind: "cli",
        client: { name: "", version: "" },
        sawRequest: false,
        helloDone: false,
        openedAt: new Date(clock.now()).toISOString(),
        tabTimes: [],
        pendingReviews: 0,
        reservedReviews: 0,
      };
      sessions.set(session.sessionId, state);
    }
    return state;
  }

  const agentLabel = (state) => (state.kind === "cli" ? "command line" : state.client.name);

  // ---- limits ---------------------------------------------------------------------------------------------

  /** Reserves `n` tab slots (64 at once, 30 per minute per session) or throws busy; returns commit/rollback. */
  function reserveTabs(state, n) {
    const t = clock.now();
    state.tabTimes = state.tabTimes.filter((e) => t - e.at < L.rateWindowMs);
    if (state.tabTimes.length + n > L.tabsPerMinute) throw err("busy");
    if (tabs.size + reservedTabs + n > L.maxAgentTabs) throw err("busy");
    const mine = Array.from({ length: n }, () => ({ at: t }));
    state.tabTimes.push(...mine);
    reservedTabs += n;
    let done = false;
    return {
      commit() {
        if (done) return;
        done = true;
        reservedTabs -= n;
      },
      rollback() {
        if (done) return;
        done = true;
        reservedTabs -= n;
        state.tabTimes = state.tabTimes.filter((e) => !mine.includes(e));
      },
    };
  }

  function reserveReview(state) {
    if (state.pendingReviews + state.reservedReviews >= L.pendingReviewsPerSession) throw err("busy");
    if (pendingTotal + reservedReviews >= L.pendingReviewsTotal) throw err("busy");
    state.reservedReviews++;
    reservedReviews++;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      state.reservedReviews--;
      reservedReviews--;
    };
    return {
      commit() {
        release();
        state.pendingReviews++;
        pendingTotal++;
      },
      rollback: release,
    };
  }

  // ---- documents ------------------------------------------------------------------------------------------

  function checkPathParam(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > L.maxPathLength) throw err("bad_request");
    return value;
  }

  /** Exactly one of {path} or {inline: true} + body. @returns {{ path: string } | { bytes: Buffer }} */
  function documentSource(params, body) {
    const hasPath = params.path !== undefined;
    const inline = params.inline === true;
    if (hasPath === inline) throw err("bad_request");
    if (hasPath) return { path: checkPathParam(params.path) };
    if (!body || body.length === 0 || body.length > L.maxDocumentBytes) throw err("bad_request");
    return { bytes: body };
  }

  /** Reads a file through the path policy (<= 2 MiB). Throws bad_path, or `tooLarge` (an Error with .tooLarge). */
  async function readDocument(filePath) {
    let opened;
    try {
      opened = await openAgentPath(filePath);
    } catch {
      throw err("bad_path");
    }
    if (!opened || !opened.ok) throw err("bad_path");
    const handle = opened.handle;
    try {
      if (opened.size > L.maxDocumentBytes) throw Object.assign(new Error("too large"), { tooLarge: true });
      const buffer = Buffer.alloc(L.maxDocumentBytes + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
        if (length > L.maxDocumentBytes) throw Object.assign(new Error("too large"), { tooLarge: true });
      }
      return { bytes: buffer.subarray(0, length), canonical: opened.canonical };
    } catch (e) {
      if (e?.tooLarge || e instanceof BridgeError) throw e;
      throw err("bad_path");
    } finally {
      closeQuietly(handle);
    }
  }

  /** The document's bytes (inline or from a file) and the file's canonical path when it came from one. */
  async function loadDocument(source, invalidCode) {
    if (source.bytes) return { bytes: source.bytes, canonical: null };
    try {
      return await readDocument(source.path);
    } catch (e) {
      if (e?.tooLarge) throw err(invalidCode);
      throw e;
    }
  }

  async function parseSpec(bytes) {
    let text;
    try {
      text = utf8.decode(bytes);
    } catch {
      throw err("invalid_spec");
    }
    const checked = await validateViewSpec(text);
    if (!checked.ok) throw err("invalid_spec");
    return checked.spec;
  }

  // ---- UI hand-off ----------------------------------------------------------------------------------------

  async function callUi(method, payload) {
    try {
      await ui[method](payload);
    } catch (e) {
      throw err(e?.code === "busy" ? "busy" : "internal");
    }
  }

  async function dropTab(scopeId) {
    tabs.delete(scopeId);
    await grants.closeScope(scopeId);
  }

  // ---- ops ------------------------------------------------------------------------------------------------

  async function opHello(session, state, params) {
    if (state.sawRequest || state.helloDone) throw err("bad_request");
    const client = params.client === undefined ? {} : params.client;
    if (!isObject(client)) throw err("bad_request");
    state.helloDone = true;
    state.kind = "mcp";
    state.client = { name: cleanLabel(client.name, 80), version: cleanLabel(client.version, 40) };
    let enrolled = false;
    if (params.enroll !== undefined) {
      const claim = params.enroll;
      const ok =
        isObject(claim) &&
        typeof claim.clientId === "string" &&
        typeof claim.proof === "string" &&
        (await enrollment.verify({
          clientId: claim.clientId,
          proof: claim.proof,
          serverNonce: session.serverNonce,
          clientNonce: session.clientNonce,
        }));
      if (!ok) {
        log("enroll_rejected", state);
        throw err("not_allowed");
      }
      approval.recordEnrolled(state.sessionId, claim.clientId);
      enrolled = true;
    }
    log("session_opened", state, enrolled ? "enrolled" : "new");
    return { result: { enrolled } };
  }

  async function opOpen(state, params, body) {
    if (!body || body.length === 0) throw err("bad_request");
    let list;
    try {
      list = JSON.parse(utf8.decode(body));
    } catch {
      throw err("bad_request");
    }
    if (!Array.isArray(list) || list.length < 1 || list.length > L.maxPaths) throw err("bad_request");
    for (const p of list) checkPathParam(p);

    const n = list.length;
    const slots = reserveTabs(state, n);
    const scopes = [];
    const shown = [];
    try {
      const results = await Promise.all(
        list.map(async (p) => {
          try {
            return await openAgentPath(p);
          } catch {
            return { ok: false };
          }
        }),
      );
      if (results.some((r) => !r || !r.ok)) {
        for (const r of results) if (r?.ok) closeQuietly(r.handle);
        throw err("bad_path");
      }
      const items = [];
      try {
        for (const opened of results) {
          const scopeId = grants.openScope();
          const item = { scopeId, opened, granted: false, token: null };
          scopes.push(item);
          try {
            item.token = grants.grant(scopeId, opened);
            item.granted = true;
          } catch (e) {
            throw err(e?.code === "busy" ? "busy" : "internal");
          }
          items.push(item);
        }
      } catch (e) {
        for (const r of results) {
          if (!scopes.some((s) => s.opened === r && s.granted)) closeQuietly(r.handle);
        }
        throw e;
      }
      for (const item of items) tabs.set(item.scopeId, { kind: "file", sessionId: state.sessionId });
      for (const item of items) {
        await callUi("openFile", {
          scopeId: item.scopeId,
          token: item.token,
          name: path.basename(item.opened.canonical),
          canonical: item.opened.canonical,
          size: item.opened.size,
          sessionId: state.sessionId,
          agent: agentLabel(state),
        });
        shown.push(item.scopeId);
      }
    } catch (e) {
      slots.rollback();
      for (const item of scopes) {
        await dropTab(item.scopeId);
        if (shown.includes(item.scopeId)) {
          try {
            await ui.closeTab?.(item.scopeId);
          } catch {}
        }
      }
      throw e;
    }
    slots.commit();
    log("open", state, `${n} file(s)`);
    return { result: { opened: n } };
  }

  async function opViewShow(state, params, body) {
    const source = documentSource(params, body);
    const { bytes } = await loadDocument(source, "invalid_spec");
    const spec = await parseSpec(bytes);
    const slots = reserveTabs(state, 1);
    const scopeId = grants.openScope();
    tabs.set(scopeId, { kind: "view", sessionId: state.sessionId, declared: declaredPaths(spec), granted: new Map() });
    try {
      await callUi("showView", { scopeId, specBytes: bytes, spec, sessionId: state.sessionId, agent: agentLabel(state) });
    } catch (e) {
      slots.rollback();
      await dropTab(scopeId);
      throw e;
    }
    slots.commit();
    log("view.show", state);
    return { result: { scopeId } };
  }

  /** The receipt's own `view`: best effort, a problem is shown in the review rather than failing it. */
  async function loadReceiptView(viewPath) {
    try {
      const { bytes } = await readDocument(viewPath);
      return { bytes, spec: await parseSpec(bytes) };
    } catch (e) {
      return { error: e?.tooLarge ? "invalid_spec" : e?.code === "invalid_spec" ? "invalid_spec" : "bad_path" };
    }
  }

  async function opReviewOpen(state, params, body) {
    const source = documentSource(params, body);
    const { bytes, canonical } = await loadDocument(source, "invalid_receipt");
    let review;
    try {
      review = await openReview({ receiptBytes: bytes, receiptPath: canonical });
    } catch (e) {
      if (e instanceof ReviewError) throw err("invalid_receipt");
      throw e;
    }
    let slot;
    let slots;
    slots = reserveTabs(state, 1);
    try {
      slot = reserveReview(state);
    } catch (e) {
      slots.rollback();
      throw e;
    }
    const scopeId = grants.openScope();
    let view = null;
    const tab = { kind: "review", sessionId: state.sessionId, reviewId: review.reviewId, declared: new Set(), granted: new Map() };
    tabs.set(scopeId, tab);
    try {
      if (typeof review.receipt.view === "string") {
        view = await loadReceiptView(review.receipt.view);
        if (view.spec) tab.declared = declaredPaths(view.spec);
      }
      const record = {
        reviewId: review.reviewId,
        ownerSessionId: state.sessionId,
        scopeId,
        review,
        shown: null,
        decision: null,
        waiters: new Set(),
      };
      reviews.set(review.reviewId, record);
      await callUi("showReview", {
        scopeId,
        reviewId: review.reviewId,
        receiptDigest: review.receiptDigest,
        receipt: review.receipt,
        receiptBytes: bytes,
        view: view && view.spec ? { specBytes: view.bytes, spec: view.spec } : view,
        sessionId: state.sessionId,
        agent: agentLabel(state),
      });
    } catch (e) {
      reviews.delete(review.reviewId);
      slot.rollback();
      slots.rollback();
      await dropTab(scopeId);
      throw e;
    }
    slot.commit();
    slots.commit();
    log("review.open", state);
    return { result: { reviewId: review.reviewId } };
  }

  function ownedReview(state, params) {
    const id = params.reviewId;
    if (typeof id !== "string" || id.length < 1 || id.length > 128) throw err("bad_request");
    const record = reviews.get(id);
    if (!record || record.ownerSessionId !== state.sessionId) throw err("not_found");
    return record;
  }

  const outcomeOf = (record) =>
    record.decision ? { status: "decided", decision: record.decision } : { status: "pending" };

  async function opReviewWait(state, params) {
    const record = ownedReview(state, params);
    const timeoutMs = params.timeoutMs === undefined ? 0 : params.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > L.maxWaitMs) throw err("bad_request");
    if (record.decision || timeoutMs === 0) return { result: outcomeOf(record) };
    return new Promise((resolve) => {
      const waiter = { sessionId: state.sessionId };
      waiter.finish = () => {
        clock.clearTimeout(waiter.timer);
        record.waiters.delete(waiter);
        resolve({ result: outcomeOf(record) });
      };
      waiter.timer = clock.setTimeout(waiter.finish, timeoutMs);
      record.waiters.add(waiter);
    });
  }

  function cancelWaits(sessionId, record) {
    for (const waiter of [...record.waiters]) if (waiter.sessionId === sessionId) waiter.finish();
  }

  async function opReviewCancelWait(state, params) {
    const id = params.reviewId;
    if (typeof id !== "string" || id.length < 1 || id.length > 128) throw err("bad_request");
    const record = reviews.get(id);
    if (record && record.ownerSessionId === state.sessionId) cancelWaits(state.sessionId, record);
    return { result: {} };
  }

  async function opReviewGet(state, params) {
    return { result: outcomeOf(ownedReview(state, params)) };
  }

  const OPS = {
    "open": opOpen,
    "view.show": opViewShow,
    "review.open": opReviewOpen,
    "review.wait": opReviewWait,
    "review.cancelWait": opReviewCancelWait,
    "review.get": opReviewGet,
  };

  // ---- bridge entry points --------------------------------------------------------------------------------

  async function onRequest(session, header, body) {
    const method = header?.method;
    if (typeof method !== "string" || !BRIDGE_OPS.includes(method)) throw err("unknown_method");
    const params = header.params === undefined ? {} : header.params;
    if (!isObject(params)) throw err("bad_request");
    const state = stateFor(session);
    try {
      if (method === "mcp.hello") return await opHello(session, state, params);
      state.sawRequest = true;
      // Consent comes first: an MCP session that is not approved gets nothing, not even parameter errors.
      // Cancelling a wait is cleanup of something the session already holds, so it never asks.
      if (state.kind === "mcp" && method !== "review.cancelWait") await approval.require(state.sessionId, state.client);
      return await OPS[method](state, params, body);
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw err("internal");
    }
  }

  function onSessionClosed(sessionId) {
    approval.sessionClosed(sessionId);
    const state = sessions.get(sessionId);
    for (const record of reviews.values()) {
      if (record.ownerSessionId !== sessionId) continue;
      cancelWaits(sessionId, record);
      if (record.decision) reviews.delete(record.reviewId);
    }
    decidedBySession.delete(sessionId);
    if (state && state.kind === "mcp") log("session_closed", state);
    sessions.delete(sessionId);
  }

  // ---- reviews, for the app -------------------------------------------------------------------------------

  function finalizeReview(record, decision) {
    record.decision = decision;
    const owner = sessions.get(record.ownerSessionId);
    if (owner) {
      owner.pendingReviews--;
      const kept = decidedBySession.get(owner.sessionId) ?? [];
      kept.push(record.reviewId);
      while (kept.length > L.decidedKeptPerSession) reviews.delete(kept.shift());
      decidedBySession.set(owner.sessionId, kept);
    } else {
      reviews.delete(record.reviewId);
    }
    pendingTotal--;
    for (const waiter of [...record.waiters]) waiter.finish();
    log("review_decided", owner, decision.decision);
  }

  function recordOf(reviewId) {
    const record = typeof reviewId === "string" ? reviews.get(reviewId) : undefined;
    if (!record) throw err("not_found");
    return record;
  }

  async function verifyReview(reviewId) {
    const record = recordOf(reviewId);
    const result = await verifier.verify(record.review.receipt.files, { baseline: record.shown ?? undefined });
    record.shown = result;
    return result;
  }

  /**
   * What a dismissal records for the files when nobody has verified them yet (decision/1 needs a files list but has no
   * "not checked" state): every file as unreadable with no observed hash. Approve and changes_requested never use this.
   */
  function unverified(record) {
    return {
      verifiedAt: new Date(clock.now()).toISOString(),
      results: record.review.receipt.files.map((f) => ({
        path: f.path,
        expectedSha256: f.sha256,
        observedSha256: null,
        state: "unreadable",
      })),
    };
  }

  async function decideReview({ reviewId, decision, comment = "" }) {
    const record = recordOf(reviewId);
    if (record.decision) throw new ReviewError("already_decided", `Review ${reviewId} is already decided`);
    const shown = decision === "dismissed" && !record.shown ? unverified(record) : record.shown;
    const result = await decide({ review: record.review, shown, decision, comment, verifier, store });
    if (!result.ok) {
      // The view refreshes to what was just found; the next click needs a new look (and the arming delay).
      if (result.current) record.shown = result.current;
      return result;
    }
    finalizeReview(record, result.decision);
    return result;
  }

  async function tabClosed(scopeId) {
    const tab = tabs.get(scopeId);
    if (!tab) return;
    tabs.delete(scopeId);
    await grants.closeScope(scopeId);
    const record = tab.reviewId ? reviews.get(tab.reviewId) : undefined;
    if (!record || record.decision) return;
    try {
      const result = await decide({ review: record.review, shown: record.shown ?? unverified(record), decision: "dismissed", verifier, store });
      if (result.ok) {
        finalizeReview(record, result.decision);
        return;
      }
    } catch {}
    // The dismissal could not be recorded; the review must not stay pending forever.
    const owner = sessions.get(record.ownerSessionId);
    if (owner) owner.pendingReviews--;
    pendingTotal--;
    reviews.delete(record.reviewId);
    for (const waiter of [...record.waiters]) waiter.finish();
  }

  async function viewGrant(scopeId, requestedPath) {
    const tab = tabs.get(scopeId);
    if (!tab || !tab.declared) throw err("not_found");
    if (typeof requestedPath !== "string" || !tab.declared.has(requestedPath)) throw err("bad_path");
    const existing = tab.granted.get(requestedPath);
    if (existing) return { ...existing };
    let opened;
    try {
      opened = await openAgentPath(requestedPath);
    } catch {
      throw err("bad_path");
    }
    if (!opened || !opened.ok) throw err("bad_path");
    if (!tabs.has(scopeId)) {
      closeQuietly(opened.handle);
      throw err("not_found");
    }
    let token;
    try {
      token = grants.grant(scopeId, opened);
    } catch (e) {
      closeQuietly(opened.handle);
      throw err(e?.code === "busy" ? "busy" : "not_found");
    }
    const grant = { token, name: path.basename(opened.canonical), size: opened.size, canonical: opened.canonical };
    tab.granted.set(requestedPath, grant);
    return { ...grant };
  }

  // ---- Agents panel ---------------------------------------------------------------------------------------

  function listSessions() {
    return [...sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      kind: s.kind,
      client: { ...s.client },
      approval: s.kind === "cli" ? "not_required" : approval.status(s.sessionId),
      clientId: approval.clientIdOf(s.sessionId) ?? null,
      openedAt: s.openedAt,
      pendingReviews: s.pendingReviews,
    }));
  }

  async function revokeClient(clientId) {
    const removed = await enrollment.remove(clientId);
    const ids = approval.revokeClient(clientId);
    for (const id of ids) {
      for (const record of reviews.values()) if (record.ownerSessionId === id) cancelWaits(id, record);
      try {
        closeSession?.(id);
      } catch {}
    }
    log("revoked", undefined, `${removed ? "removed" : "not enrolled"}; ${ids.length} session(s) closed`);
    return { removed, sessionsClosed: ids.length };
  }

  async function dispose() {
    for (const record of reviews.values()) for (const waiter of [...record.waiters]) waiter.finish();
    tabs.clear();
    await grants.closeAll();
  }

  return {
    grants,
    approval,
    limits: L,
    onRequest,
    onSessionClosed,
    tabClosed,
    viewGrant,
    verifyReview,
    decideReview,
    getReview(reviewId) {
      const record = typeof reviewId === "string" ? reviews.get(reviewId) : undefined;
      if (!record) return null;
      return {
        reviewId: record.reviewId,
        receiptDigest: record.review.receiptDigest,
        receipt: record.review.receipt,
        decision: record.decision,
        shown: record.shown,
        sessionId: record.ownerSessionId,
      };
    },
    listSessions,
    listClients: () => enrollment.list(),
    listActivity: () => activity.list(),
    revokeClient,
    dispose,
  };
}
