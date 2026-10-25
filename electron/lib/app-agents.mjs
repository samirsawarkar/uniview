// Wiring factory for agent host, bridge server, review IPC, agent grants, and early CLI/MCP runners.
// Plain Node ESM module testable with fakes.

import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile as nodeExecFile, spawn } from "node:child_process";
import { Readable } from "node:stream";

import { createAgentHost } from "./agent-host.mjs";
import {
  openAgentPath as defaultOpenAgentPath,
  AgentGrantStore,
  createLocalVolumeClassifier,
  getForbiddenDevs,
} from "./agent-paths.mjs";
import { createEnrollmentStore, readClientKey } from "./agent-enrollment.mjs";
import { createActivityLog, createFileActivityStore } from "./agent-activity.mjs";
import { createDecisionStore } from "./review-store.mjs";
import { createVerifier } from "./review-verify.mjs";
import { createReviewIpcHandlers, registerReviewIpc, installShutdownDismiss } from "./review-ipc.mjs";
import { registerAgentsIpc } from "./agents-ipc.mjs";
import { startBridgeServer } from "./bridge-server.mjs";
import { connectBridge } from "./bridge-client.mjs";
import {
  ensureBridgeDir,
  ensureBridgeKey,
  readBridgeKey,
  ensureInstallId,
  windowsUserSid,
  currentWindowsAccount,
  bridgeEndpoint,
  parseIcaclsEntries,
  systemToolPath,
  resolveTool,
} from "./bridge-key.mjs";
import { enrollProof, BridgeError } from "./bridge-proto.mjs";
import { cleanLabel } from "./agent-util.mjs";
import { runCli } from "./cli.mjs";
import { runMcp, MCP_LIMITS } from "./mcp-server.mjs";
import { parseRange, contentType, checkReadArgs } from "./core.mjs";

const defaultFs = fsPromises;
function defaultExecFile(file, args, cb) {
  const resolved = resolveTool(file);
  return nodeExecFile(resolved, args, { windowsHide: true, timeout: 10_000 }, cb);
}
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

function runExecFile(execFileFn, file, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const res = execFileFn(file, args, (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
      if (res && typeof res.then === "function") {
        res.then(
          (val) => {
            if (settled) return;
            settled = true;
            resolve(val);
          },
          (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          }
        );
      }
    } catch (err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
  });
}

function fullAccountName(name) {
  return typeof name === "string" && name.includes("\\") ? name : undefined;
}

async function verifyAgentsWindowsAcl(targetPath, {
  execFile = defaultExecFile,
  accountName,
  userSid,
} = {}) {
  let stdout;
  try {
    const res = await runExecFile(execFile, "icacls", [targetPath]);
    stdout = typeof res === "string" ? res : (res?.stdout || "");
  } catch {
    throw new BridgeError("bad_dir");
  }

  const entries = parseIcaclsEntries(stdout, targetPath);
  if (entries.length !== 1) {
    throw new BridgeError("bad_dir");
  }

  const [entry] = entries;

  if (entry.inherited) {
    throw new BridgeError("bad_dir");
  }

  const validDirRights =
    entry.rights === "(OI)(CI)(F)" ||
    entry.rights === "(CI)(OI)(F)" ||
    entry.rights === "(OI)(CI)F" ||
    entry.rights === "(F)";
  if (!validDirRights) {
    throw new BridgeError("bad_dir");
  }

  let expectedName = fullAccountName(accountName);
  let expectedSid = userSid;

  if (!expectedSid) {
    try {
      const acct = await currentWindowsAccount({ execFile });
      expectedName = expectedName || acct.name;
      expectedSid = acct.sid;
    } catch {
      throw new BridgeError("bad_dir");
    }
  }

  let matches = false;
  const principal = entry.principal.trim();

  if (expectedName && principal.toLowerCase() === expectedName.toLowerCase()) {
    matches = true;
  }

  if (!matches && expectedSid) {
    const cleanSid = expectedSid.startsWith("*")
      ? expectedSid.slice(1).toLowerCase()
      : expectedSid.toLowerCase();
    const cleanPrincipal = principal.startsWith("*")
      ? principal.slice(1).toLowerCase()
      : principal.toLowerCase();
    if (cleanPrincipal === cleanSid) {
      matches = true;
    }
  }

  if (!matches) {
    throw new BridgeError("bad_dir");
  }
}

/**
 * Ensures `<userData>/agents` folder exists with owner-only ACL on Windows
 * and mode 0700 on POSIX (mirroring the security guarantees of the bridge directory).
 */
export async function ensureAgentsDir(
  userDataDir,
  {
    platform = process.platform,
    fs = defaultFs,
    execFile = defaultExecFile,
    userSid,
    accountName,
  } = {}
) {
  const agentsDir = path.join(userDataDir, "agents");
  if (platform === "win32") {
    let existed = false;
    try {
      const st = await fs.stat(agentsDir);
      if (!st.isDirectory()) throw new BridgeError("bad_dir");
      existed = true;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (err && err.code !== "ENOENT") throw err;
    }

    let sid = userSid;
    let name = accountName;
    if (!sid) {
      try {
        const acct = await currentWindowsAccount({ execFile });
        sid = acct.sid;
        if (!name) name = acct.name;
      } catch {
        throw new BridgeError("bad_dir");
      }
    }

    if (!existed) {
      await fs.mkdir(agentsDir, { recursive: true });
      const grantSid = sid.startsWith("*") ? sid : `*${sid}`;
      try {
        await runExecFile(execFile, "icacls", [
          agentsDir,
          "/inheritance:r",
          "/grant:r",
          `${grantSid}:(OI)(CI)F`,
        ]);
      } catch {
        throw new BridgeError("bad_dir");
      }
    }

    await verifyAgentsWindowsAcl(agentsDir, {
      execFile,
      userSid: sid,
      accountName: name,
    });
    return agentsDir;
  }

  await fs.mkdir(agentsDir, { recursive: true, mode: 0o700 });
  const st = await fs.stat(agentsDir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new BridgeError("bad_dir");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new BridgeError("bad_dir");
  }
  return agentsDir;
}

/**
 * Creates the native approval dialog wrapper conforming to the agent-approval spec:
 * - 3 buttons: Allow for this session / Always allow / Don't allow
 * - defaultId = 2 (Don't allow)
 * - cancelId = 2 (Don't allow)
 * - name sanitised (control and bidi characters stripped, length capped to 80)
 * - parented to main window if available
 * - honours AbortSignal: abort resolves "deny"
 */
export function createAskDialog({ dialog, getWindow }) {
  return function ask({ sessionId, client, signal }) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve("deny");
        return;
      }

      const rawName = client?.name ?? "";
      const cleaned = cleanLabel(rawName, 80);
      const message = `An agent that says it is ‹${cleaned}› wants to show files and ask for reviews in UniView`;

      const buttons = ["Allow for this session", "Always allow", "Don't allow"];
      const defaultId = 2; // Don't allow
      const cancelId = 2; // Don't allow

      let settled = false;
      const done = (choice) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(choice);
      };

      const onAbort = () => {
        done("deny");
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const options = {
        type: "question",
        message,
        buttons,
        defaultId,
        cancelId,
        noLink: true,
        signal,
      };

      const parentWin = getWindow ? getWindow() : null;
      const showPromise =
        parentWin && !parentWin.isDestroyed?.()
          ? dialog.showMessageBox(parentWin, options)
          : dialog.showMessageBox(options);

      Promise.resolve(showPromise).then(
        (res) => {
          const idx = typeof res === "object" && res !== null ? res.response : res;
          if (idx === 0) done("allow_session");
          else if (idx === 1) done("allow_always");
          else done("deny");
        },
        () => {
          done("deny");
        }
      );
    });
  };
}

/**
 * Creates the UI manager that forwards openFile, showView, showReview, and closeTab
 * to the renderer window or custom handler. While the renderer is still loading,
 * requests are queued up to a bound of 32; a 33rd request rejects with code "busy".
 */
export function createUiManager({ getWindow, openRendererTab }) {
  let rendererReady = false;
  const pendingQueue = [];
  const MAX_QUEUE = 32;

  async function dispatchTab(item) {
    if (openRendererTab) {
      await openRendererTab(item);
    }
    const win = getWindow ? getWindow() : null;
    if (win && !win.isDestroyed?.() && win.webContents) {
      if (item.kind === "file") {
        win.webContents.send("agent:tab", item);
        win.webContents.send("open-files", [
          {
            token: item.token,
            name: item.name,
            path: item.canonical,
            size: item.size,
            scopeId: item.scopeId,
          },
        ]);
      } else if (item.kind === "view") {
        win.webContents.send("agent:show-view", item);
      } else if (item.kind === "review") {
        win.webContents.send("agent:show-review", item);
      } else if (item.kind === "closeTab") {
        win.webContents.send("agent:close-tab", item.scopeId);
      }
    }
  }

  async function enqueueOrDispatch(item) {
    if (rendererReady) {
      await dispatchTab(item);
      return;
    }
    if (pendingQueue.length >= MAX_QUEUE) {
      const err = new Error("Renderer queue full");
      err.code = "busy";
      throw err;
    }
    pendingQueue.push(item);
  }

  return {
    isReady: () => rendererReady,
    setReady: async () => {
      rendererReady = true;
      while (pendingQueue.length > 0) {
        const item = pendingQueue.shift();
        try {
          await dispatchTab(item);
        } catch {}
      }
    },
    queueLength: () => pendingQueue.length,
    ui: {
      async openFile(params) {
        await enqueueOrDispatch({ kind: "file", ...params });
      },
      async showView(params) {
        await enqueueOrDispatch({ kind: "view", ...params });
      },
      async showReview(params) {
        await enqueueOrDispatch({ kind: "review", ...params });
      },
      async closeTab(scopeId) {
        await enqueueOrDispatch({ kind: "closeTab", scopeId });
      },
    },
  };
}

/**
 * Creates a readable stream from a handle without reopening the path.
 */
export function createHandleReadStream(handle, start, end) {
  let pos = start;
  return new Readable({
    async read(size) {
      if (pos > end) {
        this.push(null);
        return;
      }
      const toRead = Math.min(size, end - pos + 1);
      const buf = Buffer.alloc(toRead);
      try {
        const { bytesRead } = await handle.read(buf, 0, toRead, pos);
        if (!bytesRead) {
          this.push(null);
          return;
        }
        pos += bytesRead;
        this.push(buf.subarray(0, bytesRead));
      } catch (err) {
        this.destroy(err);
      }
    },
  });
}

/**
 * Reads a range from an agent handle for the IPC reader `uniview:read`.
 */
export async function readAgentHandle(agentEntry, start, end, maxRead = 512 * 1024 * 1024) {
  const sSize = agentEntry.size;
  const problem = checkReadArgs(start, end, sSize, maxRead);
  if (problem) throw new Error(problem);
  const len = Math.min(end, sSize) - start;
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await agentEntry.handle.read(buf, off, len - off, start + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + off);
}

/**
 * Serves an agent granted file over the `uniview-file:` protocol from its handle.
 */
export async function serveAgentFile(agentEntry, request) {
  const size = agentEntry.size;
  const range = parseRange(request.headers?.get?.("range"), size);
  const type = contentType(agentEntry.canonical);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const body = size === 0 ? null : Readable.toWeb(createHandleReadStream(agentEntry.handle, start, end));
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": String(size === 0 ? 0 : end - start + 1),
    "Cache-Control": "no-store",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/**
 * Generates thumbnail PNG bytes from an agent granted handle directly.
 */
export async function thumbnailAgent(agentEntry, size, nativeImage) {
  if (!nativeImage) return null;
  const dot = agentEntry.canonical.lastIndexOf(".");
  const ext = dot === -1 ? "" : agentEntry.canonical.slice(dot + 1).toLowerCase();
  const isImg = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext);
  if (!isImg || agentEntry.size > 100 * 1024 * 1024) return null;
  try {
    const buf = Buffer.alloc(agentEntry.size);
    let off = 0;
    while (off < agentEntry.size) {
      const { bytesRead } = await agentEntry.handle.read(buf, off, agentEntry.size - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    const img = nativeImage.createFromBuffer(buf.subarray(0, off));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const scale = Math.min(1, size / Math.max(width, height));
    return new Uint8Array(
      img
        .resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "good",
        })
        .toPNG()
    );
  } catch {
    return null;
  }
}

/**
 * Reconciles local-file reviews and agent-originated reviews:
 * Both share the same DecisionStore at `<userData>/reviews`.
 * If reviewId belongs to an agent review (present in host), calls host.verifyReview/decideReview
 * to keep agent waiters and session state in sync. Otherwise delegates to local review manager.
 */
export function createReconciledReviewManager({ host, localManager }) {
  return {
    openReviews: localManager.openReviews,
    localManager,
    async handleReviewOpen(args) {
      return localManager.handleReviewOpen(args);
    },

    async handleReviewDecide(args) {
      const reviewId = args?.reviewId;
      if (typeof reviewId === "string" && host.getReview(reviewId)) {
        try {
          const result = await host.decideReview({
            reviewId,
            decision: args.decision,
            comment: args.comment ?? "",
          });
          if (result.ok) {
            return { ok: true, decision: result.decision };
          }
          if (result.code === "changed" || result.code === "identity_unavailable") {
            return {
              ok: false,
              code: result.code,
              message:
                result.code === "changed"
                  ? "A file changed since you looked — review again"
                  : "A file cannot be identified reliably, so it cannot be approved",
              current: result.current?.results ?? result.current,
              verifiedAt: result.current?.verifiedAt,
            };
          }
          return { ok: false, code: result.code || "failed", error: "The review could not be completed" };
        } catch (err) {
          const code = err?.code || "failed";
          return { ok: false, code, error: err?.message || "The review could not be completed" };
        }
      }
      return localManager.handleReviewDecide(args);
    },

    async handleReviewDismiss(reviewId) {
      if (typeof reviewId === "string" && host.getReview(reviewId)) {
        try {
          const result = await host.decideReview({
            reviewId,
            decision: "dismissed",
            comment: "",
          });
          if (result.ok) {
            return { ok: true, dismissed: true, decision: result.decision };
          }
          return { ok: false, code: result.code || "failed" };
        } catch (err) {
          if (err?.code === "already_decided") {
            const r = host.getReview(reviewId);
            return { ok: true, dismissed: false, alreadyDecided: true, decision: r?.decision };
          }
          return { ok: false, code: err?.code || "failed" };
        }
      }
      return localManager.handleReviewDismiss(reviewId);
    },

    async handleReviewRefresh(reviewId) {
      if (typeof reviewId === "string" && host.getReview(reviewId)) {
        try {
          const fresh = await host.verifyReview(reviewId);
          return { ok: true, files: fresh.results, verifiedAt: fresh.verifiedAt };
        } catch {
          return { ok: false, code: "verify_failed", error: "The files could not be checked" };
        }
      }
      return localManager.handleReviewRefresh(reviewId);
    },

    hasUndecided() {
      const hostReviews = host?.hasUndecided
        ? host.hasUndecided()
        : host?.listSessions
        ? host.listSessions().reduce((acc, s) => acc + (s.pendingReviews || 0), 0) > 0
        : false;
      return localManager.hasUndecided() || hostReviews;
    },

    async dismissAll() {
      const [localRes] = await Promise.all([
        localManager.dismissAll(),
        host?.dismissUndecided ? host.dismissUndecided() : Promise.resolve(),
      ]);
      return localRes;
    },
  };
}

/**
 * Detects whether the process was launched with CLI (`UniView open ...`) or MCP (`UniView --mcp`).
 */
export function detectEarlyArgv(argv, isPackaged = false) {
  const args = argv.slice(isPackaged ? 1 : 2);
  const isMcp = args.includes("--mcp") || argv.includes("--mcp");
  const openIdx = args.indexOf("open");
  const isCli = !isMcp && openIdx !== -1;
  const cliArgv = isCli ? args.slice(openIdx) : [];
  return { isMcp, isCli, cliArgv };
}

/**
 * Creates a wrapped clock for runMcp that extends the 30 s request deadline to 125 s
 * for the first tools/call request to cover the 120 s approval dialog.
 */
export function createMcpClock({ approvalGraceMs = 125_000, clock = realClock } = {}) {
  let firstCall = true;
  return {
    now: () => clock.now(),
    setTimeout: (fn, ms) => {
      let timeoutMs = ms;
      if (firstCall && ms === MCP_LIMITS.REQUEST_DEADLINE_MS) {
        firstCall = false;
        timeoutMs = approvalGraceMs;
      }
      return clock.setTimeout(fn, timeoutMs);
    },
    clearTimeout: (h) => clock.clearTimeout(h),
  };
}

/**
 * Computes spawn args for launching UniView in packaged vs unpackaged mode.
 * In unpackaged mode (dev), starts process.execPath with [appPath] so Electron loads this app.
 * In packaged mode, starts process.execPath with [].
 */
export function computeAppSpawnArgs({ isPackaged = false, appPath = "" } = {}) {
  return isPackaged ? [] : [appPath || process.cwd()];
}

/**
 * Runs the CLI client early before the single-instance lock.
 */
export async function runEarlyCli({
  argv,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  userDataDir,
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  spawnApp,
  connect,
  sleep,
  app,
  isPackaged = false,
  appPath,
}) {
  const bridgeDir = path.join(userDataDir, "bridge");
  const doConnect =
    connect ||
    (async () => {
      const key = await readBridgeKey(bridgeDir, { platform, fs, execFile });
      const endpoint =
        platform === "win32"
          ? bridgeEndpoint({
              platform,
              bridgeDir,
              userSid: await windowsUserSid({ execFile }),
              installId: await ensureInstallId(bridgeDir, { fs }),
            })
          : bridgeEndpoint({ platform, bridgeDir });
      return connectBridge({ endpoint, key });
    });

  const doStartApp =
    spawnApp ||
    (async () => {
      const resolvedAppPath = appPath ?? (app?.getAppPath ? app.getAppPath() : process.cwd());
      const resolvedIsPackaged = app?.isPackaged ?? isPackaged;
      const child = spawn(
        process.execPath,
        computeAppSpawnArgs({ isPackaged: resolvedIsPackaged, appPath: resolvedAppPath }),
        {
          detached: true,
          stdio: "ignore",
        }
      );
      child.unref();
    });

  return runCli({
    argv,
    cwd,
    stdout,
    stderr,
    connect: doConnect,
    startApp: doStartApp,
    ...(sleep ? { sleep } : {}),
  });
}

/**
 * Runs the MCP stdio server early before the single-instance lock.
 */
export async function runEarlyMcp({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  userDataDir,
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  spawnApp,
  connect,
  clock = realClock,
  approvalGraceMs = 125_000,
  app,
  isPackaged = false,
  appPath,
}) {
  const bridgeDir = path.join(userDataDir, "bridge");
  const agentsDir = path.join(userDataDir, "agents");

  const baseConnect =
    connect ||
    (async () => {
      const key = await readBridgeKey(bridgeDir, { platform, fs, execFile });
      const endpoint =
        platform === "win32"
          ? bridgeEndpoint({
              platform,
              bridgeDir,
              userSid: await windowsUserSid({ execFile }),
              installId: await ensureInstallId(bridgeDir, { fs }),
            })
          : bridgeEndpoint({ platform, bridgeDir });
      return connectBridge({ endpoint, key });
    });

  const wrappedConnect = async () => {
    const client = await baseConnect();
    return {
      ...client,
      request: async (method, params, body) => {
        if (method !== "mcp.hello") return client.request(method, params, body);
        let enroll;
        try {
          const found = await readClientKey({ dir: agentsDir, name: params?.client?.name, fs });
          if (found) {
            enroll = {
              clientId: found.clientId,
              proof: enrollProof(found.key, client.serverNonce, client.clientNonce).toString("base64"),
            };
          }
        } catch {}
        return client.request(method, { ...params, ...(enroll ? { enroll } : {}) }, body);
      },
    };
  };

  const doStartApp =
    spawnApp ||
    (async () => {
      const resolvedAppPath = appPath ?? (app?.getAppPath ? app.getAppPath() : process.cwd());
      const resolvedIsPackaged = app?.isPackaged ?? isPackaged;
      const child = spawn(
        process.execPath,
        computeAppSpawnArgs({ isPackaged: resolvedIsPackaged, appPath: resolvedAppPath }),
        {
          detached: true,
          stdio: "ignore",
        }
      );
      child.unref();
    });

  return runMcp({
    stdin,
    stdout,
    stderr,
    connect: wrappedConnect,
    startApp: doStartApp,
    clock,
    approvalGraceMs,
  });
}

/**
 * Wiring factory for Packet P17c:
 * Builds one agent host instance, connects to bridge server, reconciles review IPC,
 * manages agent file grants, and coordinates startup/shutdown.
 */
export function createAppAgents({
  app,
  dialog,
  ipcMain,
  fromApp,
  getWindow,
  userDataDir,
  platform = process.platform,
  openRendererTab,
  grants: injectedGrants,
  userGrants,
  clock = realClock,
  fs = defaultFs,
  execFile = defaultExecFile,
  createServer = net.createServer,
  openAgentPath: customOpenAgentPath,
}) {
  const grants = injectedGrants ?? new AgentGrantStore();
  const tokenScopeMap = new Map();
  const sessionSockets = new Map();

  function trackSessionSocket(sessionId, socket) {
    sessionSockets.set(sessionId, socket);
    socket.once?.("close", () => {
      if (sessionSockets.get(sessionId) === socket) {
        sessionSockets.delete(sessionId);
      }
    });
  }

  function closeSession(sessionId) {
    const sock = sessionSockets.get(sessionId);
    if (sock) {
      sessionSockets.delete(sessionId);
      try {
        sock.destroy();
      } catch {}
    }
  }

  const boundOpenAgentPath =
    customOpenAgentPath ||
    ((p) => {
      const classifier = platform === "win32" ? createLocalVolumeClassifier() : undefined;
      const forbidden = platform !== "win32" ? getForbiddenDevs(fs) : undefined;
      return defaultOpenAgentPath(p, {
        platform,
        fs,
        isLocalDev: classifier,
        forbiddenDevs: forbidden,
      });
    });

  const uiManager = createUiManager({
    getWindow,
    openRendererTab: async (item) => {
      if (item.token && item.scopeId) {
        tokenScopeMap.set(item.token, item.scopeId);
      }
      if (openRendererTab) await openRendererTab(item);
    },
  });

  const ask = createAskDialog({ dialog, getWindow });

  let host = null;
  let verifier = null;
  let bridgeServer = null;
  let activity = null;
  let enrollment = null;
  let store = null;
  let reconciledReviewManager = null;
  let stopped = false;

  async function start() {
    // 5. key/dir creation ONLY after app.requestSingleInstanceLock() succeeded
    const hasLock = app.requestSingleInstanceLock();
    if (!hasLock) {
      return { ok: false, locked: false };
    }

    // 1 & 9. Ensure agents directory with safe owner-only ACL
    await ensureAgentsDir(userDataDir, { platform, fs, execFile });
    enrollment = createEnrollmentStore({ dir: path.join(userDataDir, "agents"), fs, now: clock.now });
    await enrollment.load();

    activity = createActivityLog({
      store: createFileActivityStore({ dir: path.join(userDataDir, "agents"), fs }),
      now: clock.now,
    });
    await activity.load();

    store = createDecisionStore({ dir: path.join(userDataDir, "reviews"), fs, now: clock.now });
    verifier = createVerifier({ openAgentPath: boundOpenAgentPath, now: clock.now });

    host = createAgentHost({
      openAgentPath: boundOpenAgentPath,
      store,
      verifier,
      enrollment,
      activity,
      ask,
      ui: {
        async openFile(p) {
          if (p?.token && p?.scopeId) tokenScopeMap.set(p.token, p.scopeId);
          return uiManager.ui.openFile(p);
        },
        async showView(p) {
          return uiManager.ui.showView(p);
        },
        async showReview(p) {
          return uiManager.ui.showReview(p);
        },
        async closeTab(id) {
          return uiManager.ui.closeTab(id);
        },
      },
      closeSession,
      grants,
      clock,
    });

    // 5. Ensure bridge directory, key, and endpoint
    const bridgeDir = await ensureBridgeDir(userDataDir, { platform, fs, execFile });
    const key = await ensureBridgeKey(bridgeDir, { platform, fs, execFile });
    const installId = await ensureInstallId(bridgeDir, { fs });
    const endpoint =
      platform === "win32"
        ? bridgeEndpoint({ platform, bridgeDir, userSid: await windowsUserSid({ execFile }), installId })
        : bridgeEndpoint({ platform, bridgeDir });

    // Tracking createServer to capture sockets per sessionId
    const trackingCreateServer = () => {
      const srv = createServer();
      srv.on?.("connection", (socket) => {
        const origWrite = socket.write?.bind(socket);
        if (origWrite) {
          socket.write = function (data, ...args) {
            try {
              const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
              const match =
                /"t"\s*:\s*"ready"\s*,\s*"sessionId"\s*:\s*"([0-9a-f]{32})"/.exec(text) ||
                /"sessionId"\s*:\s*"([0-9a-f]{32})"\s*,\s*"t"\s*:\s*"ready"/.exec(text);
              if (match) {
                trackSessionSocket(match[1], socket);
              }
            } catch {}
            return origWrite(data, ...args);
          };
        }
      });
      return srv;
    };

    bridgeServer = await startBridgeServer({
      endpoint,
      key,
      onRequest: host.onRequest,
      onSessionClosed: (sessionId) => {
        sessionSockets.delete(sessionId);
        host.onSessionClosed(sessionId);
      },
      createServer: trackingCreateServer,
      platform,
      fs,
    });

    // 6. Register Agents IPC and Reconciled Review IPC
    await registerAgentsIpc({ ipcMain, fromApp, host });

    const localReviewManager = createReviewIpcHandlers({
      store,
      verifier,
      openAgentPath: boundOpenAgentPath,
      fs,
      now: clock.now,
      resolveGrant: (t) => {
        const userEntry = userGrants?.get?.(t);
        if (userEntry) return userEntry;
        const scope = tokenScopeMap.get(t);
        return scope ? grants.get(t, scope) : undefined;
      },
    });

    reconciledReviewManager = createReconciledReviewManager({ host, localManager: localReviewManager });
    await registerReviewIpc({
      ipcMain,
      fromApp,
      grants,
      manager: reconciledReviewManager,
    });

    // Route renderer 'tab closed' and 'ready'
    if (ipcMain?.on) {
      ipcMain.on("uniview:tab-closed", (_e, scopeId) => {
        if (typeof fromApp === "function" && !fromApp(_e)) return;
        if (typeof scopeId === "string") {
          void host.tabClosed(scopeId);
          for (const [t, s] of tokenScopeMap) {
            if (s === scopeId) tokenScopeMap.delete(t);
          }
        }
      });

      ipcMain.on("uniview:ready", (_e) => {
        if (typeof fromApp === "function" && !fromApp(_e)) return;
        void uiManager.setReady();
      });
    }

    if (app?.on) {
      installShutdownDismiss({
        app,
        manager: reconciledReviewManager,
        timeoutMs: 3000,
      });
      app.on("will-quit", () => {
        void stop();
      });
    }

    return { ok: true, locked: true };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      if (bridgeServer) await bridgeServer.close();
    } catch {}
    try {
      if (host) await host.dispose();
    } catch {}
    try {
      if (activity) await activity.flush();
    } catch {}
  }

  function getGrant(token, scopeId) {
    const scope = scopeId || tokenScopeMap.get(token);
    return scope ? grants.get(token, scope) : undefined;
  }

  return {
    start,
    stop,
    get host() {
      return host;
    },
    get verifier() {
      return verifier;
    },
    get grants() {
      return grants;
    },
    get userGrants() {
      return userGrants;
    },
    get reviewManager() {
      return reconciledReviewManager;
    },
    get uiManager() {
      return uiManager;
    },
    getGrant,
    closeSession,
    trackSessionSocket,
    serveAgentFile: (entry, req) => serveAgentFile(entry, req),
    readAgentHandle: (entry, start, end, max) => readAgentHandle(entry, start, end, max),
    thumbnail: (entry, size, nativeImage) => thumbnailAgent(entry, size, nativeImage),
  };
}
