// Agents IPC handlers and registration for desktop Agents panel (P17b-2).
// Pure functions testable without Electron.
//
// Trust model:
// Agent names, versions, and activity details are untrusted data reported by external agent processes.
// Every string returned across IPC is stripped of bidi/control characters and length-capped.
// Sensitive internals (keys, proofs, nonces, file paths) are strictly excluded from responses.
// Every argument is type- and size-checked; failures return fixed codes and messages.

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g;

export const AGENTS_IPC_LIMITS = Object.freeze({
  maxActivityLimit: 500,
  minActivityLimit: 1,
  defaultActivityLimit: 100,
  maxSessionId: 64,
  maxKind: 32,
  maxClientName: 80,
  maxClientVersion: 40,
  maxApproval: 32,
  maxClientId: 64,
  maxTime: 64,
  maxType: 40,
  maxDetail: 200,
});

const MESSAGES = Object.freeze({
  bad_args: "Invalid request",
  not_found: "Not found",
  failed: "The request could not be completed",
  internal: "Internal error",
});

function fail(code) {
  const known = Object.hasOwn(MESSAGES, code) ? code : "failed";
  return { ok: false, code: known, error: MESSAGES[known] };
}

function isPlainObject(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cleanString(val, max) {
  if (typeof val !== "string") return "";
  return val.replace(UNSAFE_CHARS, "").slice(0, max);
}

function sanitizeSession(s) {
  if (!s || typeof s !== "object") return null;
  const L = AGENTS_IPC_LIMITS;
  return {
    sessionId: cleanString(s.sessionId, L.maxSessionId),
    kind: cleanString(s.kind, L.maxKind),
    client: {
      name: cleanString(s.client?.name, L.maxClientName),
      version: cleanString(s.client?.version, L.maxClientVersion),
    },
    approval: cleanString(s.approval, L.maxApproval),
    clientId: typeof s.clientId === "string" && s.clientId ? cleanString(s.clientId, L.maxClientId) : null,
    openedAt: cleanString(s.openedAt, L.maxTime),
    pendingReviews: typeof s.pendingReviews === "number" ? Math.max(0, Math.floor(s.pendingReviews)) : 0,
    openTabs:
      typeof s.openTabs === "number"
        ? Math.max(0, Math.floor(s.openTabs))
        : typeof s.tabs === "number"
          ? Math.max(0, Math.floor(s.tabs))
          : 0,
  };
}

function sanitizeClient(c) {
  if (!c || typeof c !== "object") return null;
  const L = AGENTS_IPC_LIMITS;
  return {
    clientId: cleanString(c.clientId, L.maxClientId),
    name: cleanString(c.name, L.maxClientName),
    enrolledAt: cleanString(c.enrolledAt, L.maxTime),
  };
}

function sanitizeActivity(a) {
  if (!a || typeof a !== "object") return null;
  const L = AGENTS_IPC_LIMITS;
  const out = {
    at: cleanString(a.at, L.maxTime),
    type: cleanString(a.type, L.maxType),
  };
  if (typeof a.sessionId === "string" && a.sessionId) out.sessionId = cleanString(a.sessionId, L.maxSessionId);
  if (typeof a.client === "string" && a.client) out.client = cleanString(a.client, L.maxClientName);
  if (typeof a.detail === "string" && a.detail) out.detail = cleanString(a.detail, L.maxDetail);
  return out;
}

/**
 * Pure handler for agents:list.
 * Returns connected sessions, enrolled clients, and the last 100 activity entries.
 * All strings are sanitized and length-capped; no keys, proofs, nonces or paths are returned.
 */
export async function handleAgentsList(host, args) {
  if (args !== undefined) {
    if (!isPlainObject(args) || Object.keys(args).length > 0) return fail("bad_args");
  }
  if (!host) return fail("failed");

  try {
    const rawSessions = typeof host.listSessions === "function" ? await host.listSessions() : [];
    const sessions = (Array.isArray(rawSessions) ? rawSessions : []).map(sanitizeSession).filter(Boolean);

    const rawClients = typeof host.listClients === "function" ? await host.listClients() : [];
    const clients = (Array.isArray(rawClients) ? rawClients : []).map(sanitizeClient).filter(Boolean);

    const rawActivity = typeof host.listActivity === "function" ? await host.listActivity() : [];
    const allActivity = (Array.isArray(rawActivity) ? rawActivity : []).map(sanitizeActivity).filter(Boolean);
    const activity = allActivity.slice(-AGENTS_IPC_LIMITS.defaultActivityLimit);

    return {
      ok: true,
      sessions,
      clients,
      enrolledClients: clients,
      activity,
    };
  } catch {
    return fail("failed");
  }
}

/**
 * Pure handler for agents:revoke.
 * Validates args { clientId: string (1..64 alphanumeric/underscore/hyphen) }.
 */
export async function handleAgentsRevoke(host, args) {
  if (!isPlainObject(args)) return fail("bad_args");
  for (const k of Object.keys(args)) {
    if (k !== "clientId") return fail("bad_args");
  }
  const { clientId } = args;
  if (
    typeof clientId !== "string" ||
    clientId.length < 1 ||
    clientId.length > AGENTS_IPC_LIMITS.maxClientId ||
    !/^[0-9a-zA-Z_-]{1,64}$/.test(clientId)
  ) {
    return fail("bad_args");
  }
  if (!host || typeof host.revokeClient !== "function") return fail("failed");

  try {
    const res = await host.revokeClient(clientId);
    return {
      ok: true,
      removed: Boolean(res?.removed),
      sessionsClosed: Number(res?.sessionsClosed ?? 0),
    };
  } catch {
    return fail("failed");
  }
}

/**
 * Pure handler for agents:activity.
 * Validates args { limit: integer (1..500) }.
 */
export async function handleAgentsActivity(host, args) {
  if (!isPlainObject(args)) return fail("bad_args");
  for (const k of Object.keys(args)) {
    if (k !== "limit") return fail("bad_args");
  }
  const { limit } = args;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < AGENTS_IPC_LIMITS.minActivityLimit ||
    limit > AGENTS_IPC_LIMITS.maxActivityLimit
  ) {
    return fail("bad_args");
  }
  if (!host || typeof host.listActivity !== "function") return fail("failed");

  try {
    const rawActivity = await host.listActivity();
    const allActivity = (Array.isArray(rawActivity) ? rawActivity : []).map(sanitizeActivity).filter(Boolean);
    const activity = allActivity.slice(-limit);
    return {
      ok: true,
      activity,
    };
  } catch {
    return fail("failed");
  }
}

export async function registerAgentsIpc({
  ipcMain: injectedIpcMain,
  fromApp,
  host,
} = {}) {
  // Fail closed: without a sender check these handlers would answer any frame.
  if (typeof fromApp !== "function") {
    throw new TypeError("registerAgentsIpc requires a fromApp(event) sender check");
  }

  let electronIpc = injectedIpcMain;
  if (!electronIpc) {
    try {
      const electron = await import("electron");
      electronIpc = electron.ipcMain;
    } catch {
      // Not in Electron
    }
  }

  const handlers = {
    handleAgentsList: (args) => handleAgentsList(host, args),
    handleAgentsRevoke: (args) => handleAgentsRevoke(host, args),
    handleAgentsActivity: (args) => handleAgentsActivity(host, args),
  };

  if (electronIpc) {
    const guard = (fn) => async (e, ...args) => {
      if (!fromApp(e)) throw new Error("Request refused: unknown sender");
      try {
        return await fn(args[0]);
      } catch {
        return fail("failed");
      }
    };

    electronIpc.handle("agents:list", guard((a) => handlers.handleAgentsList(a)));
    electronIpc.handle("agents:revoke", guard((a) => handlers.handleAgentsRevoke(a)));
    electronIpc.handle("agents:activity", guard((a) => handlers.handleAgentsActivity(a)));
  }

  return handlers;
}
