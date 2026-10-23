// Sandboxed preload: the only bridge between the UI and the main process. Keep in sync with src/shells/electron.ts.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const listeners = new Set();
const queued = [];

ipcRenderer.on("open-files", (_e, files) => {
  if (!Array.isArray(files)) return;
  if (!listeners.size) queued.push(files);
  for (const cb of listeners) cb(files);
});

contextBridge.exposeInMainWorld("uniview", {
  pickFiles: () => ipcRenderer.invoke("uniview:pick"),
  openPath: (path) => ipcRenderer.invoke("uniview:open-path", String(path)),
  readRange: (token, start, end) => ipcRenderer.invoke("uniview:read", String(token), Number(start), Number(end)),
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
});
