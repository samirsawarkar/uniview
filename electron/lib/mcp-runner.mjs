// Reusable, electron-free MCP server runner and launcher utilities (Packet P25).
// Plain Node ESM module testable with fakes; NO electron imports.

import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile, spawn } from "node:child_process";
import { buildColdStartCommand, cleanSpawnEnv } from "./cold-start.mjs";
import { fileURLToPath } from "node:url";

import { connectBridge } from "./bridge-client.mjs";
import {
  readBridgeKey,
  ensureInstallId,
  windowsUserSid,
  bridgeEndpoint,
  resolveTool,
} from "./bridge-key.mjs";
import { enrollProof } from "./bridge-proto.mjs";
import { readClientKey } from "./agent-enrollment.mjs";
import { runMcp } from "./mcp-server.mjs";

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

/**
 * Resolves the UniView userData directory without requiring Electron.
 * Reproduces Electron's app.getPath('userData') for the app name 'UniView':
 * - Windows: %APPDATA%\UniView (or %USERPROFILE%\AppData\Roaming\UniView)
 * - macOS: ~/Library/Application Support/UniView
 * - Linux: $XDG_CONFIG_HOME/UniView or ~/.config/UniView
 * If UNIVIEW_USER_DATA is set in env, it takes precedence.
 */
export function resolveUserDataDir({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir?.() || "",
} = {}) {
  if (env.UNIVIEW_USER_DATA) {
    return env.UNIVIEW_USER_DATA;
  }
  const appName = "UniView";
  if (platform === "win32") {
    const appData = env.APPDATA || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Roaming") : "");
    return path.win32.join(appData, appName);
  }
  if (platform === "darwin") {
    const home = env.HOME || homedir;
    return path.posix.join(home, "Library", "Application Support", appName);
  }
  // Linux / POSIX default
  const configHome = env.XDG_CONFIG_HOME || (env.HOME || homedir ? path.posix.join(env.HOME || homedir, ".config") : "");
  return path.posix.join(configHome, appName);
}

/**
 * Strips ELECTRON_RUN_AS_NODE from child process environment on cold start
 * so the spawned child runs as the full Electron desktop app rather than Node.
 */
export { cleanSpawnEnv };

/**
 * Computes spawn args for launching UniView in packaged vs unpackaged mode.
 * In unpackaged mode (dev), starts process.execPath with [appPath] so Electron loads this app.
 * In packaged mode, starts process.execPath with [].
 */
export function computeAppSpawnArgs({ isPackaged = false, appPath = "" } = {}) {
  return isPackaged ? [] : [appPath || process.cwd()];
}

/**
 * Error message emitted to stderr when `UniView.exe --mcp` is invoked directly
 * from the Electron GUI executable on Windows.
 */
export function buildMcpErrorMessage() {
  return (
    "UniView: the MCP server cannot run directly from the GUI executable because Electron on Windows closes stdin in the main process.\n" +
    "To run the MCP server, set the environment variable ELECTRON_RUN_AS_NODE=1 and pass the entry path (e.g. UniView.exe resources\\app.asar\\electron\\mcp-entry.mjs), or use the uniview-mcp.cmd launcher (e.g. resources\\uniview-mcp.cmd).\n"
  );
}

/**
 * Core reusable MCP server runner (Packet P25).
 * Plain Node ESM, NO electron imports.
 */
export async function runMcpServer({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  userDataDir,
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  spawnApp,
  spawnProcess = spawn,
  connect,
  clock = realClock,
  approvalGraceMs = 125_000,
  app,
  isPackaged,
  appPath,
  env = process.env,
  execPath = process.execPath,
  clientInfo = { name: "UniView", version: "1.0.0" },
} = {}) {
  const resolvedUserData = userDataDir || resolveUserDataDir({ env, platform });
  const bridgeDir = path.join(resolvedUserData, "bridge");
  const agentsDir = path.join(resolvedUserData, "agents");

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
      const defaultAppPath = path.resolve(fileURLToPath(import.meta.url), "../../..");
      const resolvedAppPath = appPath ?? (app?.getAppPath ? app.getAppPath() : defaultAppPath);
      const isExeUniView = path.basename(execPath).toLowerCase().includes("uniview");
      const isInsideAsar = import.meta.url.includes("app.asar");
      const resolvedIsPackaged = app?.isPackaged ?? isPackaged ?? (isExeUniView && isInsideAsar);
      const cmd = buildColdStartCommand({
        platform,
        execPath,
        args: computeAppSpawnArgs({ isPackaged: resolvedIsPackaged, appPath: resolvedAppPath }),
        env,
      });
      const child = spawnProcess(cmd.file, cmd.args, cmd.options);
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
    clientInfo,
  });
}
