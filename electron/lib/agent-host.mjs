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
//   cli.hello       {version}  must be the first request of a CLI connection; marks the session as CLI
//                   (not subject to approval).
//   mcp.hello       {client:{name,version}, protocolVersion, enroll?:{clientId, proof}}  must be the first request of an MCP
//                   connection; it marks the session as MCP (subject to approval). A connection that never sends hello
//                   is rejected: any first request other than cli.hello or mcp.hello returns not_allowed.
//                   enroll.proof = base64 enrollProof over the connection's nonces. -> {enrolled: boolean}. A bad or
//                   removed enrolment -> not_allowed.
//   open            {}  body = UTF-8 JSON array of 1..20 absolute paths    -> {opened: n}   all or nothing (bad_path / busy)
//   view.show       {path} | {inline: true} + body = spec bytes            -> {scopeId}
//   review.open     {path} | {inline: true} + body = receipt bytes         -> {reviewId}
//   review.wait     {reviewId, timeoutMs}  -> {status:"decided", decision} | {status:"pending"} (timed out or cancelled)
//   review.cancelWait {reviewId}           -> {}   ends this session's waits on the review; the review stays open.
//                   Never busy: the host counts no quota against it and the bridge server exempts it from the
//                   16-requests-in-flight limit (the MCP server also keeps one slot free for it).
//   review.get      {reviewId}             -> {status:"decided", decision} | {status:"pending"}
// Errors are BridgeError codes: bad_request, bad_path, invalid_spec, invalid_receipt, busy, not_allowed, not_found,
// unknown_method, internal. Reviews are visible only to the session that opened them (else not_found).
//
// ---- For the app (renderer / Agents panel) --------------------------------------------------------------------
//   host.tabClosed(scopeId)                         the tab was closed: closes its handles; an undecided review is dismissed
//   host.onSessionClosed(sessionId)                 the agent/CLI went away: opens still in flight are released; tabs already on screen
//                                                   (file/view/review) stay readable until tabClosed, a revoke, or app quit
//   host.viewGrant(scopeId, path)                   grant for an image/fileRef path the view itself names -> {token, name, size, canonical}
//   host.verifyReview(reviewId)                     hashes the receipt files (what is shown) -> verifier result
//   host.decideReview({reviewId, decision, comment}) approved | changes_requested | dismissed; {ok:false, code:"changed", current} blocks
//   host.getReview(reviewId)                        {reviewId, receiptDigest, receipt, decision|null, shown|null, sessionId|null} or null
//   host.listSessions() / listClients() / listActivity()
//   host.revokeClient(clientId)                     removes the enrolment, cancels its waits, closes its sessions
//   host.dispose()                                  shutdown: cancels waits, closes every agent handle
// 
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

export const BRIDGE_OPS = Object.freeze(["cli.hello", "mcp.hello", "open", "view.show", "review.open", "review.wait", "review.cancelWait", "review.get", "session.waitMessage", "session.cancelWaitMessage", "session.postMessage"]);

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
        epoch: 1,
        closed: false,
        disconnected: false,
        kind: "unidentified",
        client: { name: "", version: "" },
        sawRequest: false,
        helloDone: false,
        openedAt: new Date(clock.now()).toISOString(),
        tabTimes: [],
        pendingReviews: 0,
        reservedReviews: 0,
        inbox: [],
        activeWait: null,
        openedPaths: new Set(),
        chatClosed: false,
      };
      sessions.set(session.sessionId, state);
    }
    return state;
  }

  function isSessionLive(state, epoch) {
    return !state.closed && state.epoch === epoch && sessions.get(state.sessionId) === state;
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
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reservedTabs -= n;
    };
    return {
      /** The tabs are in the registry now, so they count there; the reservation must not count them twice. */
      placed: release,
      commit: release,
      rollback() {
        release();
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

  /**
   * A tab record. `sessionId` is the live owner (null once detached); `originSessionId` and `clientId` never change, so an
   * explicit revoke can still find the tabs of a client whose sessions have already disconnected.
   */
  function newTab(state, fields) {
    return { ...fields, sessionId: state.sessionId, originSessionId: state.sessionId, clientId: approval.clientIdOf(state.sessionId) ?? null, committed: false };
  }

  /** The tab is on screen: it now outlives the session that opened it (until tabClosed, a revoke, or app quit). */
  function commitTab(scopeId) {
    const tab = tabs.get(scopeId);
    if (tab) tab.committed = true;
  }

  async function dropTab(scopeId) {
    tabs.delete(scopeId);
    await grants.closeScope(scopeId);
  }

  // ---- ops ------------------------------------------------------------------------------------------------

  async function opCliHello(session, state, params) {
    if (state.sawRequest || state.helloDone) throw err("bad_request");
    if (!isObject(params)) throw err("bad_request");
    const rawVersion = params.version !== undefined ? String(params.version) : "1";
    state.helloDone = true;
    state.kind = "cli";
    state.client = { name: "command line", version: cleanLabel(rawVersion, 40) };
    log("session_opened", state, "cli");
    return { result: { version: state.client.version } };
  }

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
    const epoch = state.epoch;
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
      if (!isSessionLive(state, epoch)) {
        for (const r of results) if (r?.ok) closeQuietly(r.handle);
        throw err("not_found");
      }
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
      for (const item of items) {
        state.openedPaths.add(item.opened.canonical);
        tabs.set(item.scopeId, newTab(state, { kind: "file" }));
      }
      slots.placed();
      for (const item of items) {
        if (!isSessionLive(state, epoch)) throw err("not_found");
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
        if (!isSessionLive(state, epoch)) throw err("not_found");
      }
      // Every tab is on screen and the session was alive to the end: from here the tabs belong to the person.
      for (const item of items) commitTab(item.scopeId);
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
    state.chatClosed = false;
    log("open", state, `${n} file(s)`);
    return { result: { opened: n } };
  }

  async function opViewShow(state, params, body) {
    const epoch = state.epoch;
    const source = documentSource(params, body);
    const { bytes } = await loadDocument(source, "invalid_spec");
    if (!isSessionLive(state, epoch)) throw err("not_found");
    const spec = await parseSpec(bytes);
    if (!isSessionLive(state, epoch)) throw err("not_found");
    const slots = reserveTabs(state, 1);
    const scopeId = grants.openScope();
    tabs.set(scopeId, newTab(state, { kind: "view", declared: declaredPaths(spec), granted: new Map() }));
    slots.placed();
    try {
      if (!isSessionLive(state, epoch)) throw err("not_found");
      await callUi("showView", { scopeId, specBytes: bytes, spec, sessionId: state.sessionId, agent: agentLabel(state) });
      if (!isSessionLive(state, epoch)) throw err("not_found");
      commitTab(scopeId);
    } catch (e) {
      slots.rollback();
      await dropTab(scopeId);
      try {
        await ui.closeTab?.(scopeId);
      } catch {}
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
    const epoch = state.epoch;
    const source = documentSource(params, body);
    const { bytes, canonical } = await loadDocument(source, "invalid_receipt");
    if (!isSessionLive(state, epoch)) throw err("not_found");
    let review;
    try {
      review = await openReview({ receiptBytes: bytes, receiptPath: canonical });
    } catch (e) {
      if (e instanceof ReviewError) throw err("invalid_receipt");
      throw e;
    }
    if (!isSessionLive(state, epoch)) throw err("not_found");
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
    let record = null;
    const tab = newTab(state, { kind: "review", reviewId: review.reviewId, declared: new Set(), granted: new Map() });
    tabs.set(scopeId, tab);
    slots.placed();
    try {
      const declared = new Set();
      if (Array.isArray(review.receipt?.files)) {
        for (const f of review.receipt.files) {
          if (typeof f?.path === "string") declared.add(f.path);
        }
      }
      if (typeof review.receipt?.view === "string") {
        view = await loadReceiptView(review.receipt.view);
        if (!isSessionLive(state, epoch)) throw err("not_found");
        if (view?.spec) {
          for (const p of declaredPaths(view.spec)) declared.add(p);
        }
      } else if (review.receipt?.view?.spec) {
        for (const p of declaredPaths(review.receipt.view.spec)) declared.add(p);
      }
      tab.declared = declared;
      if (!isSessionLive(state, epoch)) throw err("not_found");
      record = {
        reviewId: review.reviewId,
        ownerSessionId: state.sessionId,
        scopeId,
        review,
        shown: null,
        decision: null,
        finalized: false,
        committed: false,
        reservation: slot,
        verifyControllers: new Set(),
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
      if (!isSessionLive(state, epoch) || record.finalized) throw err("not_found");
    } catch (e) {
      reviews.delete(review.reviewId);
      if (record?.reservation) {
        record.reservation.rollback();
        record.reservation = null;
      } else if (!record) {
        slot.rollback();
      }
      slots.rollback();
      await dropTab(scopeId);
      try {
        await ui.closeTab?.(scopeId);
      } catch {}
      throw e;
    }
    record.committed = true;
    record.reservation = null;
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

  async function opWaitMessage(state, params) {
    if (state.activeWait) throw err("busy");
    if (state.chatClosed) return { result: { status: "closed" } };
    if (state.inbox.length > 0) {
      const msg = state.inbox.shift();
      try {
        await ui.sessionState?.({ sessionId: state.sessionId, state: "working" });
      } catch {}
      return { result: { status: "message", text: msg.text, documentPath: msg.documentPath ?? null } };
    }
    const timeoutMs = params.timeoutMs === undefined ? 50_000 : params.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > L.maxWaitMs) throw err("bad_request");
    if (timeoutMs === 0) return { result: { status: "waiting" } };

    try {
      await ui.sessionState?.({ sessionId: state.sessionId, state: "listening" });
    } catch {}

    return new Promise((resolve) => {
      const waiter = {};
      waiter.finish = (outcome) => {
        clock.clearTimeout(waiter.timer);
        if (state.activeWait === waiter) state.activeWait = null;
        if (outcome?.status === "waiting" && !state.disconnected && !state.closed) {
          try {
            ui.sessionState?.({ sessionId: state.sessionId, state: state.inbox.length > 0 ? "queued" : "idle" });
          } catch {}
        }
        resolve({ result: outcome });
      };
      waiter.timer = clock.setTimeout(() => {
        waiter.finish({ status: "waiting" });
      }, timeoutMs);
      state.activeWait = waiter;
    });
  }

  async function opCancelWaitMessage(state) {
    if (state.activeWait) {
      const waiter = state.activeWait;
      state.activeWait = null;
      waiter.finish({ status: "waiting" });
    }
    return { result: {} };
  }

  async function opPostMessage(state, params, body) {
    const rawText = params?.text ?? (body ? utf8.decode(body) : "");
    if (typeof rawText !== "string" || rawText.length < 1 || rawText.length > 4000) {
      throw err("bad_request");
    }
    try {
      await ui.postMessage?.({ sessionId: state.sessionId, text: rawText });
    } catch {
      // The renderer was not told, so the tool must not claim it was.
      throw err("app_unavailable");
    }
    log("post_message", state);
    return { result: { posted: true } };
  }

  const OPS = {
    "open": opOpen,
    "view.show": opViewShow,
    "review.open": opReviewOpen,
    "review.wait": opReviewWait,
    "review.cancelWait": opReviewCancelWait,
    "review.get": opReviewGet,
    "session.waitMessage": opWaitMessage,
    "session.cancelWaitMessage": opCancelWaitMessage,
    "session.postMessage": opPostMessage,
  };

  // ---- bridge entry points --------------------------------------------------------------------------------

  /** Removes the tabs from the registry and invalidates ALL their scopes first, then closes handles with a bounded wait each. */
  async function releaseScopes(scopeIds) {
    const closePromises = scopeIds.map((id) => {
      const p = grants.closeScope(id);
      p.catch(() => {});
      return new Promise((resolve) => {
        let timer;
        timer = clock.setTimeout(() => {
          resolve();
        }, 2000);
        p.then(
          () => {
            clock.clearTimeout(timer);
            resolve();
          },
          () => {
            clock.clearTimeout(timer);
            resolve();
          },
        );
      });
    });
    await Promise.all(closePromises);
  }

  /**
   * The session is gone. Review tabs detach (the person still decides). Committed file/view tabs detach too: they are on
   * screen and stay readable until tabClosed, a revoke, or app quit. Everything else (opens still in flight) is released.
   */
  async function closeSessionScopes(sessionId) {
    const sessionScopeIds = [];
    for (const [scopeId, tab] of tabs.entries()) {
      if (tab.sessionId !== sessionId) continue;
      if (tab.kind === "review") {
        tab.sessionId = null;
      } else if (tab.committed) {
        tab.sessionId = null;
      } else {
        tabs.delete(scopeId);
        sessionScopeIds.push(scopeId);
      }
    }
    await releaseScopes(sessionScopeIds);
  }

  /** Explicit revoke: every file/view scope the client's sessions ever opened, including those of sessions already gone. */
  async function closeClientScopes(clientId, sessionIds) {
    const scopeIds = [];
    for (const [scopeId, tab] of tabs.entries()) {
      if (tab.kind === "review") continue;
      if (tab.clientId === clientId || sessionIds.includes(tab.originSessionId)) {
        tabs.delete(scopeId);
        scopeIds.push(scopeId);
      }
    }
    await releaseScopes(scopeIds);
  }

  function cancelVerifications(record) {
    if (!record?.verifyControllers) return;
    for (const c of record.verifyControllers) {
      try {
        c.abort();
      } catch {}
    }
    record.verifyControllers.clear();
  }

  async function onRequest(session, header, body) {
    const method = header?.method;
    if (typeof method !== "string" || !BRIDGE_OPS.includes(method)) throw err("unknown_method");
    const params = header.params === undefined ? {} : header.params;
    if (!isObject(params)) throw err("bad_request");
    const state = stateFor(session);
    try {
      if (!state.helloDone) {
        if (method === "mcp.hello") return await opHello(session, state, params);
        if (method === "cli.hello") return await opCliHello(session, state, params);
        throw err("not_allowed");
      }
      if (method === "mcp.hello" || method === "cli.hello") throw err("bad_request");
      state.sawRequest = true;
      // Consent comes first: an MCP session that is not approved gets nothing, not even parameter errors.
      // Cancelling a wait is cleanup of something the session already holds, so it never asks.
      if (state.kind === "mcp" && method !== "review.cancelWait") {
        await approval.require(state.sessionId, state.client);
        if (!sessions.has(state.sessionId)) throw err("not_allowed");
      }
      return await OPS[method](state, params, body);
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw err("internal");
    }
  }

  function onSessionClosed(sessionId) {
    approval.sessionClosed(sessionId);
    const state = sessions.get(sessionId);
    if (state) {
      state.closed = true;
      state.disconnected = true;
      state.epoch = (state.epoch || 1) + 1;
      if (state.activeWait) {
        const waiter = state.activeWait;
        state.activeWait = null;
        waiter.finish({ status: "waiting" });
      }
      try {
        ui.sessionState?.({ sessionId, state: "disconnected" });
      } catch {}
    }
    for (const record of reviews.values()) {
      if (record.ownerSessionId !== sessionId) continue;
      cancelVerifications(record);
      cancelWaits(sessionId, record);
      if (record.decision) {
        reviews.delete(record.reviewId);
      } else {
        record.ownerSessionId = null;
      }
    }
    for (const tab of tabs.values()) {
      if (tab.sessionId === sessionId && tab.kind === "review") {
        tab.sessionId = null;
      }
    }
    decidedBySession.delete(sessionId);
    if (state && state.kind === "mcp") log("session_closed", state);
    sessions.delete(sessionId);
    return closeSessionScopes(sessionId);
  }

  // ---- reviews, for the app -------------------------------------------------------------------------------

  function finalizeReview(record, decision) {
    if (record.finalized) {
      if (decision && !record.decision) {
        record.decision = decision;
        const owner = sessions.get(record.ownerSessionId);
        if (owner) {
          reviews.set(record.reviewId, record);
          const kept = decidedBySession.get(owner.sessionId) ?? [];
          if (!kept.includes(record.reviewId)) {
            kept.push(record.reviewId);
            while (kept.length > L.decidedKeptPerSession) reviews.delete(kept.shift());
            decidedBySession.set(owner.sessionId, kept);
          }
        }
      }
      return;
    }
    record.finalized = true;
    cancelVerifications(record);
    if (decision) record.decision = decision;
    const owner = sessions.get(record.ownerSessionId);
    if (record.committed) {
      if (owner) {
        if (owner.pendingReviews > 0) owner.pendingReviews--;
        if (record.decision) {
          const kept = decidedBySession.get(owner.sessionId) ?? [];
          kept.push(record.reviewId);
          while (kept.length > L.decidedKeptPerSession) reviews.delete(kept.shift());
          decidedBySession.set(owner.sessionId, kept);
        } else {
          reviews.delete(record.reviewId);
        }
      } else {
        reviews.delete(record.reviewId);
      }
      if (pendingTotal > 0) pendingTotal--;
    } else {
      if (record.reservation) {
        record.reservation.rollback();
        record.reservation = null;
      }
      reviews.delete(record.reviewId);
    }
    for (const waiter of [...record.waiters]) waiter.finish();
    if (decision) log("review_decided", owner, decision.decision);
  }

  function hasUndecided() {
    for (const record of reviews.values()) {
      if (!record.finalized && !record.decision) return true;
    }
    return false;
  }

  async function dismissUndecided() {
    const undecided = [];
    for (const record of reviews.values()) {
      if (!record.finalized && !record.decision) {
        undecided.push(record.reviewId);
      }
    }
    await Promise.all(
      undecided.map((id) =>
        decideReview({ reviewId: id, decision: "dismissed" }).catch(() => null)
      )
    );
  }

  function recordOf(reviewId) {
    const record = typeof reviewId === "string" ? reviews.get(reviewId) : undefined;
    if (!record) throw err("not_found");
    return record;
  }

  async function verifyReview(reviewId) {
    const record = recordOf(reviewId);
    const controller = new AbortController();
    record.verifyControllers.add(controller);
    try {
      const result = await verifier.verify(record.review.receipt.files, {
        baseline: record.shown ?? undefined,
        signal: controller.signal,
      });
      record.shown = result;
      return result;
    } finally {
      record.verifyControllers.delete(controller);
    }
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
    if (record.decision || record.finalized) throw new ReviewError("already_decided", `Review ${reviewId} is already decided`);
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
    if (!record || record.finalized || record.decision) return;
    cancelVerifications(record);
    try {
      const result = await decide({ review: record.review, shown: record.shown ?? unverified(record), decision: "dismissed", verifier, store });
      if (result.ok) {
        finalizeReview(record, result.decision);
        return;
      }
    } catch {}
    // The dismissal could not be recorded; the review must not stay pending forever.
    finalizeReview(record, null);
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
    return [...sessions.values()].map((s) => {
      let openTabs = 0;
      for (const tab of tabs.values()) {
        if (tab.sessionId === s.sessionId) openTabs++;
      }
      return {
        sessionId: s.sessionId,
        kind: s.kind,
        client: { ...s.client },
        approval: s.kind === "cli" ? "not_required" : approval.status(s.sessionId),
        clientId: approval.clientIdOf(s.sessionId) ?? null,
        openedAt: s.openedAt,
        openTabs,
        pendingReviews: s.pendingReviews,
      };
    });
  }

  async function revokeClient(clientId) {
    const removed = await enrollment.remove(clientId);
    const ids = approval.revokeClient(clientId);
    for (const id of ids) {
      for (const record of reviews.values()) {
        if (record.ownerSessionId === id) {
          cancelVerifications(record);
          cancelWaits(id, record);
          if (record.decision) {
            reviews.delete(record.reviewId);
          } else {
            record.ownerSessionId = null;
          }
        }
      }
      try {
        closeSession?.(id);
      } catch {}
      await closeSessionScopes(id);
    }
    await closeClientScopes(clientId, ids);
    log("revoked", undefined, `${removed ? "removed" : "not enrolled"}; ${ids.length} session(s) closed`);
    return { removed, sessionsClosed: ids.length };
  }

  function sessionOpenedPath(sessionId, documentPath) {
    const state = sessions.get(sessionId);
    if (!state || typeof documentPath !== "string") return false;
    // Case-insensitive filesystems only: a case-only difference is a different file elsewhere.
    const fold = process.platform === "win32" || process.platform === "darwin";
    const norm = fold ? path.normalize(documentPath).toLowerCase() : path.normalize(documentPath);
    for (const p of state.openedPaths) {
      if ((fold ? path.normalize(p).toLowerCase() : path.normalize(p)) === norm) return true;
    }
    return false;
  }

  async function sendMessage({ sessionId, text, documentPath }) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
    const state = sessions.get(sessionId);
    if (!state || state.disconnected || state.closed) {
      throw new Error("Session not found or disconnected");
    }
    if (typeof text !== "string" || text.length < 1 || text.length > 8000) {
      throw new Error("Message text must be 1 to 8000 characters");
    }
    if (typeof documentPath !== "string" || !documentPath) throw new Error("Invalid documentPath");
    if (!sessionOpenedPath(sessionId, documentPath)) {
      throw new Error("Session isolation: this session did not open this document");
    }
    if (state.inbox.length >= 100) {
      throw new Error("Inbox is full (maximum 100 messages)");
    }
    state.inbox.push({ text, documentPath });
    if (state.activeWait) {
      const msg = state.inbox.shift();
      const waiter = state.activeWait;
      state.activeWait = null;
      waiter.finish({ status: "message", text: msg.text, documentPath: msg.documentPath });
      try {
        await ui.sessionState?.({ sessionId, state: "working" });
      } catch {}
      return { ok: true, delivered: true };
    } else {
      try {
        await ui.sessionState?.({ sessionId, state: "queued" });
      } catch {}
      return { ok: true, delivered: false, queued: true };
    }
  }

  async function endSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
    const state = sessions.get(sessionId);
    if (!state) throw new Error("Session not found");
    state.chatClosed = true;
    if (state.activeWait) {
      const waiter = state.activeWait;
      state.activeWait = null;
      waiter.finish({ status: "closed" });
    }
    try {
      await ui.sessionState?.({ sessionId, state: "closed" });
    } catch {}
    return { ok: true };
  }

  // Test-only accessor: returns the live queue so a case can seed "wait open + queued message".
  function getSessionInbox(sessionId) {
    const state = sessions.get(sessionId);
    return state ? state.inbox : [];
  }

  function getSessionState(sessionId) {
    const state = sessions.get(sessionId);
    if (!state || state.disconnected || state.closed) return "disconnected";
    if (state.chatClosed) return "closed";
    if (state.activeWait) return "listening";
    if (state.inbox.length > 0) return "queued";
    return "idle";
  }

  async function dispose() {
    for (const record of reviews.values()) {
      cancelVerifications(record);
      for (const waiter of [...record.waiters]) waiter.finish();
    }
    for (const state of sessions.values()) {
      if (state.activeWait) {
        state.activeWait.finish({ status: "waiting" });
        state.activeWait = null;
      }
    }
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
    sendMessage,
    endSession,
    sessionOpenedPath,
    getSessionInbox,
    getSessionState,
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
    hasUndecided,
    dismissUndecided,
    listSessions,
    listClients: () => enrollment.list(),
    listActivity: () => activity.list(),
    revokeClient,
    dispose,
  };
}
