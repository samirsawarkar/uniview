// Sandboxed preload: the only bridge between the UI and the main process. Keep in sync with src/shells/electron.ts.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const listeners = new Set();
const queued = [];
const shareListeners = new Set();

ipcRenderer.on("open-files", (_e, files) => {
  if (!Array.isArray(files)) return;
  if (!listeners.size) queued.push(files);
  for (const cb of listeners) cb(files);
});

ipcRenderer.on("share:changed", (_e, state) => {
  for (const cb of shareListeners) cb(state);
});

contextBridge.exposeInMainWorld("uniview", {
  pickFiles: () => ipcRenderer.invoke("uniview:pick"),
  openPath: (path) => ipcRenderer.invoke("uniview:open-path", String(path)),
  readRange: (token, start, end) => ipcRenderer.invoke("uniview:read", String(token), Number(start), Number(end)),
  thumbnail: (token, size) => ipcRenderer.invoke("uniview:thumb", String(token), Number(size)),
  reveal: (token) => ipcRenderer.send("uniview:reveal", String(token)),
  /** Absolute path of a dropped File, so desktop drops stream from disk and appear in recents. */
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  onOpenFiles: (cb) => {
    if (typeof cb !== "function") return () => {};
    listeners.add(cb);
    for (const files of queued.splice(0)) cb(files);
    return () => listeners.delete(cb);
  },
  ready: () => ipcRenderer.send("uniview:ready"),

  // Review tab desktop IPC.
  review: {
    open: (args) => ipcRenderer.invoke("review:open", args),
    decide: (args) => ipcRenderer.invoke("review:decide", args),
    dismiss: (reviewId) => ipcRenderer.invoke("review:dismiss", reviewId == null ? undefined : String(reviewId)),
    refresh: (reviewId) => ipcRenderer.invoke("review:refresh", reviewId == null ? undefined : String(reviewId)),
  },

  // Sharing this computer with paired devices (host side).
  share: {
    state: () => ipcRenderer.invoke("share:state"),
    setEnabled: (on) => ipcRenderer.invoke("share:set-enabled", !!on),
    pickFolder: () => ipcRenderer.invoke("share:pick-folder"),
    syncthing: () => ipcRenderer.invoke("share:syncthing"),
    addRoot: (path, name) => ipcRenderer.invoke("share:add-root", String(path), name == null ? undefined : String(name)),
    removeRoot: (id) => ipcRenderer.invoke("share:remove-root", String(id)),
    removeDevice: (id) => ipcRenderer.invoke("share:remove-device", String(id)),
    offer: () => ipcRenderer.invoke("share:offer"),
    cancelOffer: () => ipcRenderer.invoke("share:cancel-offer"),
    onChanged: (cb) => {
      if (typeof cb !== "function") return () => {};
      shareListeners.add(cb);
      return () => shareListeners.delete(cb);
    },
  },

  // Talking to another computer's sharing service (client side), LAN only.
  remotePost: (host, port, path, body, type, timeoutMs) => ipcRenderer.invoke("remote:post", String(host), Number(port), String(path), body, String(type), timeoutMs),
});
