// UniView desktop shell. Serves the shared web UI from uniview://app/ and granted files from uniview-file://.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, nativeImage } from "electron";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setupRemote, thumbnailPng } from "./lib/remote-main.mjs";
import { installShutdownDismiss } from "./lib/review-ipc.mjs";
import { createAppAgents, detectEarlyArgv, runEarlyCli, runEarlyMcp, buildEarlyLaunchOptions } from "./lib/app-agents.mjs";
import { buildMcpErrorMessage } from "./lib/mcp-runner.mjs";
import { GrantStore, checkReadArgs, contentType, filesFromArgv, isAllowedUrl, isAppFrame, parseRange, safeJoin } from "./lib/core.mjs";
import { isNewWindowShortcut, shouldStopAppAgentsOnRenderProcessGone } from "./lib/window-lifecycle.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const MAX_READ = 512 * 1024 * 1024;
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: uniview-file:; " +
  "font-src 'self' data: blob:; media-src 'self' blob: uniview-file:; connect-src 'self' blob: data: uniview-file:; worker-src 'self' blob:; " +
  "frame-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

const grants = new GrantStore();
const pending = [];
let win = null;
const readyWindows = new Set();
let appAgents = null;

protocol.registerSchemesAsPrivileged([
  { scheme: "uniview", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, allowServiceWorkers: true } },
  { scheme: "uniview-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Separate profiles (and so separate single-instance locks) for tests that run a host and a client side by side.
if (!app.isPackaged && process.env.UNIVIEW_USER_DATA) app.setPath("userData", process.env.UNIVIEW_USER_DATA);

// 8. Early CLI and MCP detection: runs before single-instance lock without creating a window.
const early = detectEarlyArgv(process.argv, app.isPackaged);
if (early.isMcp) {
  process.stderr.write(buildMcpErrorMessage());
  app.exit(2);
} else if (early.isCli) {
  const code = await runEarlyCli({
    argv: early.cliArgv,
    ...buildEarlyLaunchOptions({ app, process }),
  });
  app.exit(typeof code === "number" ? code : 0);
} else {
  appAgents = createAppAgents({
    app,
    dialog,
    ipcMain,
    fromApp,
    getWindow: () => win,
    userDataDir: app.getPath("userData"),
    userGrants: grants,
  });

  const startRes = await appAgents.start();
  if (!startRes.ok) {
    app.quit();
  } else {
    app.on("second-instance", (_e, argv) => {
      void openPaths(filesFromArgv(argv, app.isPackaged));
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    // macOS delivers Finder opens as events, possibly before the app is ready.
    app.on("open-file", (e, path) => {
      e.preventDefault();
      void openPaths([path]);
    });
    app.whenReady().then(start, (err) => {
      dialog.showErrorBox("UniView could not start", String(err?.stack ?? err));
      app.quit();
    });
  }
}

async function grantFile(path) {
  const s = await stat(path);
  if (!s.isFile()) throw new Error(`${path} is not a file`);
  return { token: grants.grant(path, s.size), name: basename(path), path, size: s.size };
}

async function openPaths(paths) {
  const files = [];
  for (const p of paths) {
    try {
      files.push(await grantFile(p));
    } catch (err) {
      console.warn("Cannot open", p, err?.message);
    }
  }
  if (!files.length) return;
  if (win && readyWindows.has(win)) win.webContents.send("open-files", files);
  else pending.push(...files);
}

async function serveApp(request) {
  const url = new URL(request.url);
  const file = url.pathname === "/" ? join(DIST, "index.html") : safeJoin(DIST, url.pathname);
  if (!file) return new Response("Not found", { status: 404 });
  try {
    const s = await stat(file);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(file)), {
      status: 200,
      headers: {
        "Content-Type": contentType(file),
        "Content-Length": String(s.size),
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function serveFile(request) {
  const url = new URL(request.url);
  const token = url.hostname;
  const scope = url.searchParams.get("scope");
  if (scope) {
    const agentEntry = appAgents?.getGrant(token, scope);
    if (agentEntry && agentEntry.handle) {
      return appAgents.serveAgentFile(agentEntry, request);
    }
    return new Response("Forbidden", { status: 403 });
  }
  const entry = grants.get(token);
  if (!entry || entry.handle) return new Response("Forbidden", { status: 403 });
  let size;
  try {
    size = (await stat(entry.path)).size;
  } catch {
    return new Response("Gone", { status: 410 });
  }
  const range = parseRange(request.headers.get("range"), size);
  const type = contentType(entry.path);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const body = size === 0 ? null : Readable.toWeb(createReadStream(entry.path, { start, end }));
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(size === 0 ? 0 : end - start + 1), "Cache-Control": "no-store" };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function lockDown(ses) {
  // Offline guarantee: nothing but the app's own schemes can load, so no document can phone home.
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedUrl(details.url) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setSpellCheckerEnabled?.(false);
}

/** IPC is accepted only from the app's own top-level page, never from a subframe or other origin. */
function fromApp(event) {
  return isAppFrame(event.senderFrame);
}

function guard(handler) {
  return (event, ...args) => {
    if (!fromApp(event)) throw new Error("Request refused: unknown sender");
    return handler(event, ...args);
  };
}

function registerIpc() {
  ipcMain.handle("uniview:pick", guard(async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(parent, { properties: ["openFile", "multiSelections"], title: "Open files" });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(grantFile));
  }));
  ipcMain.handle("uniview:open-path", guard(async (_e, path) => {
    if (typeof path !== "string" || !path || path.length > 32767) throw new Error("Invalid path");
    const expanded = path.startsWith("~") ? join(app.getPath("home"), path.slice(1)) : path;
    return grantFile(expanded);
  }));
  ipcMain.handle("uniview:read", guard(async (_e, token, start, end, scopeId) => {
    if (scopeId) {
      const agentEntry = appAgents?.getGrant(token, scopeId);
      if (agentEntry && agentEntry.handle) {
        return appAgents.readAgentHandle(agentEntry, start, end, MAX_READ);
      }
      throw new Error("This file is no longer available. Open it again.");
    }
    const entry = grants.get(token);
    if (!entry || entry.handle) throw new Error("This file is no longer available. Open it again.");
    const s = await stat(entry.path);
    const problem = checkReadArgs(start, end, s.size, MAX_READ);
    if (problem) throw new Error(problem);
    const len = Math.min(end, s.size) - start;
    const buf = Buffer.alloc(len);
    const fh = await open(entry.path, "r");
    try {
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, start + off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + off);
    } finally {
      await fh.close();
    }
  }));
  ipcMain.handle("uniview:reopen-agent", guard(async (_e, scopeId, token) => {
    if (typeof scopeId !== "string" || typeof token !== "string") {
      throw new Error("Invalid arguments");
    }
    const agentEntry = appAgents?.getGrant(token, scopeId);
    if (!agentEntry || !agentEntry.handle) {
      throw new Error("This file is no longer available. Open it again.");
    }
    let size = agentEntry.size;
    try {
      const s = await agentEntry.handle.stat();
      size = Number(s.size);
    } catch {}
    return {
      token,
      name: basename(agentEntry.canonical),
      path: agentEntry.canonical,
      size,
      scopeId,
    };
  }));
  ipcMain.on("uniview:reveal", (e, token) => {
    if (!fromApp(e)) return;
    const entry = grants.get(token);
    if (entry) shell.showItemInFolder(entry.path);
  });
  ipcMain.handle("uniview:thumb", guard(async (_e, token, size, scopeId) => {
    if (scopeId) {
      const agentEntry = appAgents?.getGrant(token, scopeId);
      if (agentEntry && agentEntry.handle) {
        return appAgents.thumbnail(agentEntry, Math.max(32, Math.min(512, Number(size) || 256)), nativeImage);
      }
      return null;
    }
    const entry = grants.get(token);
    if (!entry || entry.handle) return null;
    return thumbnailPng(entry.path, Math.max(32, Math.min(512, Number(size) || 256)));
  }));
  ipcMain.on("uniview:ready", (e) => {
    if (!fromApp(e)) return;
    const window = BrowserWindow.fromWebContents(e.sender);
    if (!window) return;
    readyWindows.add(window);
    void appAgents?.uiManager?.setReady();
    if (pending.length && window === win) window.webContents.send("open-files", pending.splice(0));
  });
  ipcMain.on("uniview:new-window", (e) => {
    if (!fromApp(e)) return;
    void openNewWindow();
  });
  ipcMain.handle("agent:send-message", guard(async (_e, args) => {
    if (!args || typeof args !== "object") throw new Error("Invalid arguments");
    const { sessionId, text, documentPath } = args;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
    if (typeof text !== "string" || !text) throw new Error("Invalid message text");
    if (!appAgents?.host) throw new Error("Agent host not available");
    return appAgents.host.sendMessage({ sessionId, text, documentPath });
  }));
  ipcMain.handle("agent:end-session", guard(async (_e, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
    if (!appAgents?.host) throw new Error("Agent host not available");
    return appAgents.host.endSession(sessionId);
  }));
}

let lastNewWindowTime = 0;
function openNewWindow() {
  const now = Date.now();
  if (now - lastNewWindowTime < 250) return null;
  lastNewWindowTime = now;
  return createWindow();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [{ label: "New Window", accelerator: "CommandOrControl+N", click: () => { void openNewWindow(); } }] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  protocol.handle("uniview", serveApp);
  protocol.handle("uniview-file", serveFile);
  lockDown(session.defaultSession);
  registerIpc();
  await setupRemote({ fromApp, getWindow: () => win });
  buildMenu();

  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (e, url) => {
      if (!url.startsWith("uniview://app/")) e.preventDefault();
    });
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });

  await createWindow();
  void openPaths(filesFromArgv(process.argv, app.isPackaged));
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 480,
    minHeight: 360,
    title: "UniView",
    icon: join(here, "..", "dist", "icon.png"),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202124" : "#ffffff",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  if (!win) win = window;
  window.webContents.on("before-input-event", (event, input) => {
    if (isNewWindowShortcut(input)) {
      event.preventDefault();
      void openNewWindow();
    }
  });
  window.on("focus", () => {
    win = window;
    if (readyWindows.has(window) && pending.length) window.webContents.send("open-files", pending.splice(0));
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.on("render-process-gone", (_e, details) => {
    if (shouldStopAppAgentsOnRenderProcessGone(BrowserWindow.getAllWindows(), window)) {
      void appAgents?.stop();
    }
    if (details.reason !== "clean-exit") {
      readyWindows.delete(window);
      window.reload();
    }
  });
  window.on("closed", () => {
    readyWindows.delete(window);
    if (win === window) {
      win = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && !candidate.isDestroyed()) ?? null;
      if (win && readyWindows.has(win) && pending.length) win.webContents.send("open-files", pending.splice(0));
    }
  });
  await window.loadURL("uniview://app/index.html");
}

app.on("window-all-closed", () => app.quit());
