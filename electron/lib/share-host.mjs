// The host side of remote browsing (docs/REMOTE.md). Plain Node with injected platform hooks, so it is
// unit-testable without Electron. Read-only by construction: no operation writes to shared folders.
import { createServer } from "node:http";
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile, lstat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, join, sep, isAbsolute } from "node:path";
import * as P from "../../shared/remote-protocol.mjs";
import { isLanHost } from "./core.mjs";

export function isLanPeer(address) {
  if (typeof address !== "string" || !address) return false;
  let clean = address;
  if (clean.toLowerCase().startsWith("::ffff:")) {
    clean = clean.slice(7);
  }
  const pct = clean.indexOf("%");
  if (pct !== -1) {
    clean = clean.slice(0, pct);
  }
  return isLanHost(clean);
}

export const DEFAULT_PORT = 47823;
const MAX_BODY = 64 * 1024;
const LOG_SIZE = 200;
const HIDDEN = new Set(["desktop.ini", "thumbs.db", ".ds_store", "$recycle.bin", "system volume information"]);

const VIRTUAL_IFACE_RE = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|VMnet|docker|br-|veth|virbr|vboxnet|utun|tailscale|ZeroTier|Loopback/i;

function privateTier(ip) {
  if (typeof ip !== "string") return -1;
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return -1;
}

/** LAN IPv4 addresses a phone can reach. */
export function lanAddresses(ifaces = networkInterfaces()) {
  const filtered = [[], [], []];
  const fallback = [[], [], []];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    const isVirtual = VIRTUAL_IFACE_RE.test(name);
    for (const a of list ?? []) {
      if (!a || a.family !== "IPv4" || a.internal) continue;
      const tier = privateTier(a.address);
      if (tier === -1) continue;
      fallback[tier].push(a.address);
      if (!isVirtual) filtered[tier].push(a.address);
    }
  }
  const primary = [...filtered[0], ...filtered[1], ...filtered[2]];
  if (primary.length > 0) return primary;
  return [...fallback[0], ...fallback[1], ...fallback[2]];
}

/** Resolve a client path inside a shared folder, following symlinks, refusing anything outside it. */
export async function resolveInRoot(rootPath, rel) {
  if (typeof rel !== "string" || rel.length > 4096 || rel.includes("\0")) return null;
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === "." || p.includes("\\") || isAbsolute(p) || /^[a-zA-Z]:$/.test(p))) return null;
  let rootReal;
  let target;
  try {
    rootReal = await realpath(rootPath);
    target = await realpath(join(rootReal, ...parts));
  } catch {
    return null;
  }
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(target) === norm(rootReal) || norm(target).startsWith(norm(rootReal + sep)) ? target : null;
}

async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res, status, body, type = "application/json") {
  const data = body instanceof Uint8Array ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

export class ShareHost {
  #opts;
  #config = { enabled: false, port: DEFAULT_PORT, roots: [], devices: [] };
  #identity = null;
  #server = null;
  #port = 0;
  #offer = null;
  #sessions = new Map();
  #seenNonces = new Map();
  #attempts = new Map();
  #log = [];
  #thumbs = new Map();
  /** Derived static keys per device, kept in memory only (never written to remote.json). */
  #kst = new Map();

  /**
   * @param {object} opts
   * @param {string} opts.dataDir where remote.json and the identity live
   * @param {string} opts.hostName shown to devices
   * @param {(name: string, id: string) => Promise<boolean>} opts.approve asks the host user to approve a device
   * @param {(path: string, size: number) => Promise<Uint8Array|null>} [opts.thumbnail] OS thumbnailer
   * @param {{encrypt(s: string): Buffer, decrypt(b: Buffer): string} | null} [opts.protect] keychain protection for the identity key
   * @param {() => void} [opts.onChange] state changed (log, devices, sessions)
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.#opts = { now: () => Date.now(), onChange: () => {}, thumbnail: async () => null, protect: null, isPeerAllowed: isLanPeer, ...opts };
  }

  async init() {
    await mkdir(this.#opts.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.#opts.dataDir, "remote.json"), "utf8"));
      this.#config = {
        enabled: !!saved.enabled,
        port: Number.isInteger(saved.port) ? saved.port : DEFAULT_PORT,
        roots: Array.isArray(saved.roots) ? saved.roots.filter((r) => r && typeof r.path === "string") : [],
        devices: Array.isArray(saved.devices) ? saved.devices.filter((d) => d && typeof d.pub === "string") : [],
      };
    } catch {
      /* first run */
    }
    this.#identity = await this.#loadIdentity();
    this.hostId = await P.idOf(this.#identity.publicRaw);
    if (this.#config.enabled) await this.#listen();
  }

  async #loadIdentity() {
    const file = join(this.#opts.dataDir, this.#opts.protect ? "identity.bin" : "identity.json");
    try {
      const raw = await readFile(file);
      const text = this.#opts.protect ? this.#opts.protect.decrypt(raw) : raw.toString("utf8");
      return await P.importIdentity(JSON.parse(text));
    } catch {
      const id = await P.generateIdentity(true);
      const text = JSON.stringify(await P.exportIdentity(id));
      await this.#atomicWrite(file, this.#opts.protect ? this.#opts.protect.encrypt(text) : text);
      return id;
    }
  }

  async #atomicWrite(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  }

  async #save() {
    await this.#atomicWrite(join(this.#opts.dataDir, "remote.json"), JSON.stringify(this.#config, null, 2));
    this.#opts.onChange();
  }

  get state() {
    return {
      enabled: this.#config.enabled,
      listening: !!this.#server,
      port: this.#port,
      addresses: this.#server ? lanAddresses() : [],
      hostName: this.#opts.hostName,
      roots: this.#config.roots.map(({ id, name, path }) => ({ id, name, path })),
      devices: this.#config.devices.map(({ id, name, addedAt, lastSeen }) => ({ id, name, addedAt, lastSeen, connected: [...this.#sessions.values()].some((s) => s.deviceId === id) })),
      offer: this.#offer && this.#offer.expiresAt > this.#opts.now() ? { text: this.#offer.text, expiresAt: this.#offer.expiresAt } : null,
      log: this.#log.slice(-50).reverse(),
    };
  }

  // ---------------------------------------------------------------- settings (host UI)

  async setEnabled(on) {
    this.#config.enabled = !!on;
    if (on) await this.#listen();
    else await this.stop();
    await this.#save();
    return this.state;
  }

  async addRoot(path, name) {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) throw new Error("Only folders can be shared.");
    const existing = this.#config.roots.find((r) => r.path === real);
    if (existing) return existing;
    const root = { id: P.b64u(P.randomBytes(9)), name: String(name || basename(real) || real).slice(0, 80), path: real };
    this.#config.roots.push(root);
    await this.#save();
    return root;
  }

  async removeRoot(id) {
    this.#config.roots = this.#config.roots.filter((r) => r.id !== id);
    await this.#save();
  }

  async removeDevice(id) {
    this.#config.devices = this.#config.devices.filter((d) => d.id !== id);
    this.#kst.delete(id);
    for (const [k, s] of this.#sessions) if (s.deviceId === id) this.#sessions.delete(k);
    await this.#save();
  }

  /** Start a pairing offer (one at a time). Returns the QR/code text. */
  async createOffer() {
    if (!this.#server) throw new Error("Turn on sharing first.");
    const addresses = lanAddresses();
    const hosts = addresses.length ? addresses : ["127.0.0.1"];
    const secret = P.randomBytes(32);
    const text = P.makeOffer({ hosts, port: this.#port, hostPub: this.#identity.publicRaw, secret, name: this.#opts.hostName });
    this.#offer = { secret, text, expiresAt: this.#opts.now() + P.OFFER_TTL_MS, failures: 0 };
    this.#opts.onChange();
    return { text, expiresAt: this.#offer.expiresAt };
  }

  cancelOffer() {
    this.#offer = null;
    this.#opts.onChange();
  }

  // ---------------------------------------------------------------- server

  async #listen() {
    if (this.#server) return;
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        if (!res.headersSent) send(res, err?.status ?? 500, { error: "request failed" });
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    const listenOn = (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve(server.address().port);
        });
      });
    try {
      this.#port = await listenOn(this.#config.port);
    } catch {
      this.#port = await listenOn(0);
    }
    this.#server = server;
    this.#opts.onChange();
  }

  async stop() {
    const s = this.#server;
    this.#server = null;
    this.#offer = null;
    this.#sessions.clear();
    if (s) await new Promise((r) => s.close(() => r()));
    this.#opts.onChange();
  }

  #record(device, action, path) {
    this.#log.push({ at: this.#opts.now(), device, action, path });
    if (this.#log.length > LOG_SIZE) this.#log.splice(0, this.#log.length - LOG_SIZE);
    this.#opts.onChange();
  }

  #rateLimited(ip) {
    const now = this.#opts.now();
    const list = (this.#attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    this.#attempts.set(ip, list);
    return list.length > 30;
  }

  async #handle(req, res) {
    if (!this.#opts.isPeerAllowed(req.socket.remoteAddress)) return send(res, 403, { error: "local network only" });
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/v1/hello") return send(res, 200, { app: "uniview", v: P.PROTOCOL_VERSION, hostId: this.hostId });
    if (req.method !== "POST") return send(res, 405, { error: "method" });
    const ip = req.socket.remoteAddress ?? "?";
    if (url.pathname === "/v1/hello") {
      if (this.#rateLimited(ip)) return send(res, 429, { error: "slow down" });
      return this.#hello(req, res);
    }
    if (url.pathname === "/v1/pair") return this.#pair(req, res);
    if (url.pathname === "/v1/session") {
      if (this.#rateLimited(ip)) return send(res, 429, { error: "slow down" });
      return this.#session(req, res);
    }
    if (url.pathname === "/v1/rpc") return this.#rpc(req, res);
    return send(res, 404, { error: "not found" });
  }

  async #hello(req, res) {
    let body;
    try {
      body = JSON.parse(Buffer.from(await readBody(req, MAX_BODY)).toString("utf8"));
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const response = await P.helloResponse(this.#identity, this.hostId, body);
    if (!response) return send(res, 400, { error: "bad request" });
    return send(res, 200, response);
  }

  async #pair(req, res) {
    const offer = this.#offer;
    let body;
    try {
      body = JSON.parse(Buffer.from(await readBody(req, MAX_BODY)).toString("utf8"));
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    if (!offer || offer.expiresAt < this.#opts.now()) return send(res, 410, { error: "This pairing code has expired. Show a new one on the computer." });
    const verified = await P.verifyPairRequest(offer.secret, this.#identity.publicRaw, body);
    if (!verified) {
      if (++offer.failures >= 5) this.#offer = null;
      return send(res, 401, { error: "unauthorized" });
    }
    this.#offer = null; // one-time use, even if the user declines
    this.#opts.onChange();
    const allowed = await this.#opts.approve(verified.deviceName, verified.deviceId);
    if (!allowed) {
      this.#record(verified.deviceName, "pairing declined", "");
      return send(res, 403, { error: "The computer's owner declined this device." });
    }
    const now = this.#opts.now();
    this.#config.devices = this.#config.devices.filter((d) => d.id !== verified.deviceId);
    this.#config.devices.push({ id: verified.deviceId, name: verified.deviceName, pub: P.b64u(verified.devicePub), addedAt: now, lastSeen: now });
    await this.#save();
    this.#record(verified.deviceName, "paired", "");
    return send(res, 200, await P.pairResponse(offer.secret, this.#identity.publicRaw, verified, this.#opts.hostName));
  }

  async #staticKeyFor(device) {
    let k = this.#kst.get(device.id);
    if (!k) {
      const pub = P.unb64u(device.pub);
      k = await P.staticKey(this.#identity.privateKey, pub, this.#identity.publicRaw, pub);
      this.#kst.set(device.id, k);
    }
    return k;
  }

  async #session(req, res) {
    let body;
    try {
      body = JSON.parse(Buffer.from(await readBody(req, MAX_BODY)).toString("utf8"));
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const device = this.#config.devices.find((d) => d.id === body?.deviceId);
    if (!device) return send(res, 401, { error: "unauthorized" });
    const now = this.#opts.now();
    for (const [k, t] of this.#seenNonces) if (now - t > 2 * P.CLOCK_SKEW_MS) this.#seenNonces.delete(k);
    const accepted = await P.acceptSession(await this.#staticKeyFor(device), body, this.#seenNonces, now);
    if (!accepted) return send(res, 401, { error: "unauthorized" });
    for (const [k, s] of this.#sessions) if (s.expired(now)) this.#sessions.delete(k);
    this.#sessions.set(accepted.session.idText, accepted.session);
    device.lastSeen = now;
    this.#opts.onChange();
    return send(res, 200, accepted.response);
  }

  async #rpc(req, res) {
    const bytes = await readBody(req, MAX_BODY);
    const session = this.#sessions.get(P.sessionIdOf(bytes) ?? "");
    if (!session || session.expired(this.#opts.now())) return send(res, 401, { error: "unauthorized" });
    const device = this.#config.devices.find((d) => d.id === session.deviceId);
    if (!device) {
      this.#sessions.delete(session.idText);
      return send(res, 401, { error: "unauthorized" });
    }
    const opened = await session.open(bytes);
    if (!opened) return send(res, 401, { error: "unauthorized" });
    let json;
    let payload;
    try {
      ({ json, payload } = await this.#op(opened.request, device));
    } catch (err) {
      json = { error: err?.userMessage ?? "That file or folder is not available." };
    }
    return send(res, 200, await session.seal(opened.seq, json, payload), "application/octet-stream");
  }

  #root(id) {
    const r = this.#config.roots.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error("root"), { userMessage: "That shared folder is no longer shared." });
    return r;
  }

  async #resolve(rootId, rel) {
    const root = this.#root(rootId);
    const p = await resolveInRoot(root.path, rel ?? "");
    if (!p) throw Object.assign(new Error("path"), { userMessage: "That file or folder is not available." });
    return p;
  }

  async #op(req, device) {
    switch (req?.op) {
      case "info":
        return { json: { hostName: this.#opts.hostName, roots: this.#config.roots.map(({ id, name }) => ({ id, name })) } };
      case "list": {
        const dir = await this.#resolve(req.root, req.path);
        const root = this.#root(req.root);
        const names = await readdir(dir);
        const entries = [];
        for (const name of names) {
          if (name.startsWith(".") || HIDDEN.has(name.toLowerCase())) continue;
          const full = join(dir, name);
          try {
            const l = await lstat(full);
            let s = l;
            if (l.isSymbolicLink()) {
              // Show a link only if it stays inside the shared folder.
              const rel = [req.path, name].filter(Boolean).join("/");
              if (!(await resolveInRoot(root.path, rel))) continue;
              s = await stat(full);
            }
            if (!s.isDirectory() && !s.isFile()) continue;
            entries.push({ name, dir: s.isDirectory(), size: s.isFile() ? s.size : 0, mtime: Math.round(s.mtimeMs) });
          } catch {
            /* unreadable entry: skip */
          }
        }
        entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
        this.#record(device.name, "browsed", `${root.name}/${req.path ?? ""}`);
        return { json: { entries } };
      }
      case "stat": {
        const s = await stat(await this.#resolve(req.root, req.path));
        if (!s.isFile()) throw Object.assign(new Error("not file"), { userMessage: "That is not a file." });
        return { json: { size: s.size, mtime: Math.round(s.mtimeMs) } };
      }
      case "read": {
        const file = await this.#resolve(req.root, req.path);
        const start = Number(req.start);
        const end = Number(req.end);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > P.MAX_READ) {
          throw Object.assign(new Error("range"), { userMessage: "Invalid read." });
        }
        const fh = await open(file, "r");
        try {
          const s = await fh.stat();
          const len = Math.max(0, Math.min(end, s.size) - start);
          const buf = Buffer.alloc(len);
          let off = 0;
          while (off < len) {
            const { bytesRead } = await fh.read(buf, off, len - off, start + off);
            if (!bytesRead) break;
            off += bytesRead;
          }
          if (start === 0) this.#record(device.name, "opened", `${this.#root(req.root).name}/${req.path}`);
          return { json: { size: s.size, mtime: Math.round(s.mtimeMs) }, payload: new Uint8Array(buf.buffer, buf.byteOffset, off) };
        } finally {
          await fh.close();
        }
      }
      case "thumb": {
        const file = await this.#resolve(req.root, req.path);
        const size = Math.max(32, Math.min(512, Number(req.size) || 256));
        const s = await stat(file);
        const key = `${file}|${s.mtimeMs}|${size}`;
        let png = this.#thumbs.get(key);
        if (png === undefined) {
          png = (await this.#opts.thumbnail(file, size).catch(() => null)) ?? null;
          this.#thumbs.set(key, png);
          if (this.#thumbs.size > 500) this.#thumbs.delete(this.#thumbs.keys().next().value);
        }
        if (!png) throw Object.assign(new Error("thumb"), { userMessage: "No preview." });
        return { json: { type: "image/png" }, payload: png };
      }
      default:
        throw Object.assign(new Error("op"), { userMessage: "Unknown request." });
    }
  }
}
