// Main-process glue for remote browsing: the sharing host (this computer) and the HTTP transport used when this
// computer is the client. Kept out of main.mjs so main stays a thin composition root.
import { app, dialog, ipcMain, nativeImage, safeStorage } from "electron";
import { request } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { ShareHost } from "./share-host.mjs";
import { isLanHost, canDecodeThumbnailFallback } from "./core.mjs";

const TRANSPORT_PATHS = new Set(["/v1/pair", "/v1/session", "/v1/rpc", "/v1/hello"]);
const MAX_REQUEST = 64 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;

/** POST to a paired host on the LAN with a hard size and time limit. */
export function lanPost(host, port, path, body, contentType, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!isLanHost(host)) return reject(new Error("Only devices on your local network can be contacted."));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error("Invalid port."));
    if (!TRANSPORT_PATHS.has(path)) return reject(new Error("Invalid request."));
    if (!(body instanceof Uint8Array) || body.length > MAX_REQUEST) return reject(new Error("Request too large."));
    const timeout = Number.isInteger(timeoutMs) && timeoutMs >= 200 && timeoutMs <= 60000 ? timeoutMs : 15000;
    const type = contentType === "application/json" ? "application/json" : "application/octet-stream";
    const req = request({ host: host.replace(/^\[|\]$/g, ""), port, path, method: "POST", timeout, headers: { "Content-Type": type, "Content-Length": body.length } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > MAX_RESPONSE) req.destroy(new Error("Response too large."));
        else chunks.push(c);
      });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The computer did not answer in time.")));
    req.on("error", reject);
    req.end(Buffer.from(body));
  });
}

/** OS thumbnail as PNG bytes (Windows/macOS shell thumbnailers; images elsewhere). */
export async function thumbnailPng(path, size) {
  try {
    const img = await nativeImage.createThumbnailFromPath(path, { width: size, height: size });
    if (!img.isEmpty()) return new Uint8Array(img.toPNG());
  } catch {
    /* no thumbnailer for this type, or unsupported platform */
  }
  try {
    const st = await stat(path);
    if (!canDecodeThumbnailFallback(path, st.size)) return null;
  } catch {
    return null;
  }
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(1, size / Math.max(width, height));
  return new Uint8Array(img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }).toPNG());
}

/** Syncthing folders from its local config.xml (no network). */
export async function syncthingFolders() {
  const home = homedir();
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Syncthing", "config.xml"),
    join(home, "AppData", "Local", "Syncthing", "config.xml"),
    join(home, "Library", "Application Support", "Syncthing", "config.xml"),
    join(home, ".local", "state", "syncthing", "config.xml"),
    join(home, ".config", "syncthing", "config.xml"),
  ].filter(Boolean);
  for (const file of candidates) {
    let xml;
    try {
      xml = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const out = [];
    for (const m of xml.matchAll(/<folder\b([^>]*)>/g)) {
      const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'")]));
      if (attrs.path) out.push({ label: attrs.label || attrs.id || attrs.path, path: attrs.path.replace(/^~(?=[\\/]|$)/, home) });
    }
    return { found: true, folders: out };
  }
  return { found: false, folders: [] };
}

/**
 * Register sharing and remote-client IPC. `fromApp(event)` validates the sender, `getWindow()` returns the main window.
 * Test-only hooks (never in packaged builds): UNIVIEW_TEST_AUTO_APPROVE=1 approves devices, UNIVIEW_TEST_PICK_DIR picks a folder.
 */
export async function setupRemote({ fromApp, getWindow }) {
  const testing = !app.isPackaged;
  const send = (state) => getWindow()?.webContents.send("share:changed", state);
  const protect = safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) }
    : null;
  const host = new ShareHost({
    dataDir: join(app.getPath("userData"), "remote"),
    hostName: hostname(),
    protect,
    thumbnail: thumbnailPng,
    onChange: () => send(host.state),
    approve: async (name) => {
      if (testing && process.env.UNIVIEW_TEST_AUTO_APPROVE === "1") return true;
      const win = getWindow();
      win?.show();
      win?.focus();
      const opts = {
        type: "question",
        buttons: ["Allow", "Don't allow"],
        defaultId: 1,
        cancelId: 1,
        title: "Allow a device?",
        message: `Allow “${name}” to browse your shared folders?`,
        detail:
          "It will be able to see file names and open files in the folders you shared, over your local network. It cannot change, delete or add anything. You can remove it at any time in Sharing.",
        noLink: true,
      };
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return response === 0;
    },
  });
  await host.init();

  // Folders the user picked in a native dialog (or chose from Syncthing) and may now confirm sharing.
  const picked = new Set();
  const guard = (fn) => async (e, ...args) => {
    if (!fromApp(e)) throw new Error("Request refused: unknown sender");
    return fn(...args);
  };

  ipcMain.handle("share:state", guard(async () => host.state));
  ipcMain.handle("share:set-enabled", guard(async (on) => host.setEnabled(!!on)));
  ipcMain.handle("share:pick-folder", guard(async () => {
    let path = testing ? process.env.UNIVIEW_TEST_PICK_DIR : undefined;
    if (!path) {
      const res = await dialog.showOpenDialog(getWindow(), { properties: ["openDirectory"], title: "Choose a folder to share" });
      if (res.canceled || !res.filePaths[0]) return null;
      path = res.filePaths[0];
    }
    picked.add(path);
    return path;
  }));
  ipcMain.handle("share:syncthing", guard(async () => {
    const r = await syncthingFolders();
    for (const f of r.folders) picked.add(f.path);
    return r;
  }));
  ipcMain.handle("share:add-root", guard(async (path, name) => {
    // Only a folder the user just chose can be shared; the renderer cannot name arbitrary paths.
    if (typeof path !== "string" || !picked.has(path)) throw new Error("Choose the folder again.");
    picked.delete(path);
    await host.addRoot(path, typeof name === "string" ? name : undefined);
    return host.state;
  }));
  ipcMain.handle("share:remove-root", guard(async (id) => (await host.removeRoot(String(id)), host.state)));
  ipcMain.handle("share:remove-device", guard(async (id) => (await host.removeDevice(String(id)), host.state)));
  ipcMain.handle("share:offer", guard(async () => host.createOffer()));
  ipcMain.handle("share:cancel-offer", guard(async () => (host.cancelOffer(), host.state)));
  ipcMain.handle("remote:post", guard(async (h, port, path, body, type, timeoutMs) => lanPost(String(h), Number(port), String(path), body instanceof Uint8Array ? body : new Uint8Array(body ?? 0), String(type), Number.isInteger(timeoutMs) && timeoutMs >= 200 && timeoutMs <= 60000 ? timeoutMs : 15000)));

  return host;
}
