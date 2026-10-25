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
  readRange: (token, start, end, scopeId) =>
    ipcRenderer.invoke(
      "uniview:read",
      String(token),
      Number(start),
      Number(end),
      scopeId ? String(scopeId) : undefined
    ),
  thumbnail: (token, size) => ipcRenderer.invoke("uniview:thumb", String(token), Number(size)),
  reveal: (token) => ipcRenderer.send("uniview:reveal", String(token)),
  tabClosed: (scopeId) => ipcRenderer.send("uniview:tab-closed", String(scopeId)),
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

  // Review tab desktop IPC. Receipts are named by the grant token of a file the person opened, never by a
  // path; main resolves the token itself. Only the known fields are forwarded, with their types checked.
  review: {
    open: (args) => {
      const a = args && typeof args === "object" ? args : {};
      const out = {};
      if (a.receiptToken != null) out.receiptToken = String(a.receiptToken);
      if (a.receiptBytes != null) out.receiptBytes = a.receiptBytes;
      return ipcRenderer.invoke("review:open", out);
    },
    decide: (args) => {
      const a = args && typeof args === "object" ? args : {};
      return ipcRenderer.invoke("review:decide", {
        reviewId: String(a.reviewId),
        decision: String(a.decision),
        comment: a.comment == null ? undefined : String(a.comment),
      });
    },
    dismiss: (reviewId) => ipcRenderer.invoke("review:dismiss", String(reviewId)),
    refresh: (reviewId) => ipcRenderer.invoke("review:refresh", String(reviewId)),
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

  // Agents panel desktop IPC (P17b-2). Exposes only list, revoke, and activity.
  agents: {
    list: () => ipcRenderer.invoke("agents:list"),
    revoke: (args) => {
      const clientId = typeof args === "object" && args !== null ? args.clientId : args;
      return ipcRenderer.invoke("agents:revoke", { clientId: String(clientId) });
    },
    activity: (args) => {
      const limit = typeof args === "object" && args !== null ? args.limit : args;
      return ipcRenderer.invoke("agents:activity", { limit: limit === undefined ? 100 : Number(limit) });
    },
  },
});
