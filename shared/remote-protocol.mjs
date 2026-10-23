// UniView remote protocol v1 (docs/REMOTE.md). WebCrypto only, so the same code runs in Node (host) and
// in browsers/WebViews (clients). No dependencies.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROTOCOL_VERSION = 1;
export const OFFER_TTL_MS = 5 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_READ = 4 * 1024 * 1024;
export const REPLAY_WINDOW = 4096;

// ------------------------------------------------------------------ encoding

export function b64u(bytes) {
  let s = "";
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) throw new ProtocolError("bad encoding");
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bufs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

function u64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

// ------------------------------------------------------------------ keys

const ECDH = { name: "ECDH", namedCurve: "P-256" };

/** A long-term identity. `extractable` only for the host, which persists its key as a JWK. */
export async function generateIdentity(extractable = false) {
  const pair = await subtle.generateKey(ECDH, extractable, ["deriveBits"]);
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicRaw };
}

export async function exportIdentity(id) {
  return { jwk: await subtle.exportKey("jwk", id.privateKey), pub: b64u(id.publicRaw) };
}

export async function importIdentity(saved) {
  const privateKey = await subtle.importKey("jwk", saved.jwk, ECDH, true, ["deriveBits"]);
  return { privateKey, publicRaw: unb64u(saved.pub) };
}

async function importPublic(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) throw new ProtocolError("bad public key");
  return subtle.importKey("raw", raw, ECDH, false, []);
}

export async function idOf(publicRaw) {
  return b64u(new Uint8Array(await subtle.digest("SHA-256", publicRaw))).slice(0, 22);
}

async function ecdh(privateKey, peerRaw) {
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await importPublic(peerRaw) }, privateKey, 256));
}

async function hkdf(ikm, salt, info, bits = 256) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: typeof salt === "string" ? enc.encode(salt) : salt, info }, key, bits));
}

async function hmacKey(bytes) {
  return subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmac(keyBytes, ...parts) {
  return new Uint8Array(await subtle.sign("HMAC", await hmacKey(keyBytes), concat(...parts)));
}

/** Constant-time MAC check (WebCrypto verify). */
export async function hmacOk(keyBytes, mac, ...parts) {
  if (!(mac instanceof Uint8Array) || mac.length !== 32) return false;
  return subtle.verify("HMAC", await hmacKey(keyBytes), mac, concat(...parts));
}

/** The static HMAC key shared by a host and a paired device. */
export async function staticKey(ownPrivate, peerPublicRaw, hostPublicRaw, devicePublicRaw) {
  return hkdf(await ecdh(ownPrivate, peerPublicRaw), "uniview-v1-static", concat(hostPublicRaw, devicePublicRaw));
}

export async function helloRequest() {
  const ephemeral = await generateIdentity(false);
  const nonce = randomBytes(16);
  const ePub = b64u(ephemeral.publicRaw);
  return {
    body: {
      v: PROTOCOL_VERSION,
      ePub,
      nonce: b64u(nonce),
    },
    async verify(hostPubRaw, hostId, json) {
      try {
        if (!json || typeof json !== "object") return false;
        if (json.app !== "uniview" || json.hostId !== hostId) return false;
        if (typeof json.proof !== "string") return false;
        const hostPubBytes = hostPubRaw instanceof Uint8Array ? hostPubRaw : unb64u(hostPubRaw);
        const proof = unb64u(json.proof);
        if (proof.length !== 32) return false;
        const shared = await ecdh(ephemeral.privateKey, hostPubBytes);
        const K = await hkdf(shared, "uniview-v1-hello", concat(hostPubBytes, ephemeral.publicRaw));
        return await hmacOk(K, proof, "uniview-hello", hostPubBytes, ephemeral.publicRaw, nonce);
      } catch {
        return false;
      }
    },
  };
}

export async function helloResponse(hostIdentity, hostId, body) {
  try {
    if (!body || typeof body !== "object") return null;
    if (typeof body.ePub !== "string" || typeof body.nonce !== "string") return null;
    const ePubRaw = unb64u(body.ePub);
    const nonce = unb64u(body.nonce);
    if (ePubRaw.length !== 65 || ePubRaw[0] !== 4) return null;
    if (nonce.length !== 16) return null;
    const shared = await ecdh(hostIdentity.privateKey, ePubRaw);
    const K = await hkdf(shared, "uniview-v1-hello", concat(hostIdentity.publicRaw, ePubRaw));
    const proof = await hmac(K, "uniview-hello", hostIdentity.publicRaw, ePubRaw, nonce);
    return {
      app: "uniview",
      v: PROTOCOL_VERSION,
      hostId,
      proof: b64u(proof),
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ pairing offer

export function makeOffer({ hosts, port, hostPub, secret, name }) {
  const q = new URLSearchParams({ v: String(PROTOCOL_VERSION), h: hosts.join(","), p: String(port), k: b64u(hostPub), s: b64u(secret), n: name });
  return `uniview:pair?${q.toString()}`;
}

export function parseOffer(text) {
  const t = String(text ?? "").trim();
  const m = /^uniview:pair\?(.+)$/.exec(t);
  if (!m) throw new ProtocolError("This is not a UniView pairing code.");
  const q = new URLSearchParams(m[1]);
  if (q.get("v") !== String(PROTOCOL_VERSION)) throw new ProtocolError("This pairing code is from an incompatible UniView version.");
  const hosts = (q.get("h") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const port = Number(q.get("p"));
  const hostPub = unb64u(q.get("k") ?? "");
  const secret = unb64u(q.get("s") ?? "");
  if (!hosts.length || !Number.isInteger(port) || port < 1 || port > 65535 || hostPub.length !== 65 || secret.length !== 32) {
    throw new ProtocolError("This pairing code is incomplete. Show a new code on the computer and try again.");
  }
  return { hosts, port, hostPub, secret, name: (q.get("n") ?? "Computer").slice(0, 64) };
}

// ------------------------------------------------------------------ pairing (client side)

export async function pairRequest(offer, device, deviceName) {
  const nonce = randomBytes(16);
  const name = String(deviceName).slice(0, 64);
  const mac = await hmac(offer.secret, "uniview-pair-req", offer.hostPub, device.publicRaw, nonce, name);
  const body = { v: PROTOCOL_VERSION, devicePub: b64u(device.publicRaw), deviceName: name, nonce: b64u(nonce), mac: b64u(mac) };
  return {
    body,
    /** Check the host's answer; returns {deviceId, hostName} or throws. */
    async verify(resp) {
      const deviceId = String(resp?.deviceId ?? "");
      const ok = await hmacOk(offer.secret, unb64u(String(resp?.mac ?? "")), "uniview-pair-ok", offer.hostPub, device.publicRaw, nonce, deviceId);
      if (!ok || deviceId !== (await idOf(device.publicRaw))) throw new ProtocolError("The computer's answer could not be verified. Pairing was cancelled.");
      return { deviceId, hostName: String(resp.hostName ?? offer.name).slice(0, 64) };
    },
  };
}

// ------------------------------------------------------------------ pairing (host side)

/** Verify a pairing request against the active offer secret. Returns the parsed request or null. */
export async function verifyPairRequest(secret, hostPub, body) {
  try {
    if (body?.v !== PROTOCOL_VERSION) return null;
    const devicePub = unb64u(String(body.devicePub));
    const nonce = unb64u(String(body.nonce));
    const name = String(body.deviceName ?? "").slice(0, 64);
    if (devicePub.length !== 65 || nonce.length !== 16) return null;
    await importPublic(devicePub);
    const ok = await hmacOk(secret, unb64u(String(body.mac)), "uniview-pair-req", hostPub, devicePub, nonce, name);
    return ok ? { devicePub, nonce, deviceName: name || "Device", deviceId: await idOf(devicePub) } : null;
  } catch {
    return null;
  }
}

export async function pairResponse(secret, hostPub, req, hostName) {
  const mac = await hmac(secret, "uniview-pair-ok", hostPub, req.devicePub, req.nonce, req.deviceId);
  return { deviceId: req.deviceId, hostName, mac: b64u(mac) };
}

// ------------------------------------------------------------------ sessions

async function sessionKeys(ePriv, peerEPub, kst, sessionId) {
  const shared = await ecdh(ePriv, peerEPub);
  const raw = async (label) => subtle.importKey("raw", await hkdf(shared, kst, concat(label, sessionId)), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { c2s: await raw("uniview-c2s"), s2c: await raw("uniview-s2c") };
}

/** Client: start a session. `finish(resp)` verifies the host and returns a ClientSession. */
export async function sessionRequest(kst, deviceId, now = Date.now()) {
  const eph = await generateIdentity(false);
  const nonce = randomBytes(16);
  const ts = Math.floor(now);
  const mac = await hmac(kst, "uniview-session", deviceId, eph.publicRaw, u64(ts), nonce);
  return {
    body: { v: PROTOCOL_VERSION, deviceId, ePub: b64u(eph.publicRaw), ts, nonce: b64u(nonce), mac: b64u(mac) },
    async finish(resp) {
      const sessionId = unb64u(String(resp?.sessionId ?? ""));
      const hostEPub = unb64u(String(resp?.ePub ?? ""));
      if (sessionId.length !== 16) throw new ProtocolError("bad session");
      const ok = await hmacOk(kst, unb64u(String(resp?.mac ?? "")), "uniview-session-ok", sessionId, hostEPub, eph.publicRaw);
      if (!ok) throw new ProtocolError("The computer could not prove its identity. It may not be the computer you paired with.");
      const keys = await sessionKeys(eph.privateKey, hostEPub, kst, sessionId);
      return new ClientSession(sessionId, keys);
    },
  };
}

/** Sliding-window replay protection: accepts each sequence number once, in any order within the window. */
export class ReplayWindow {
  #top = 0n;
  #seen = new Set();
  accept(seq) {
    const s = BigInt(seq);
    if (s <= 0n) return false;
    if (this.#top >= BigInt(REPLAY_WINDOW) && s <= this.#top - BigInt(REPLAY_WINDOW)) return false;
    if (this.#seen.has(s)) return false;
    this.#seen.add(s);
    if (s > this.#top) {
      this.#top = s;
      const floor = s - BigInt(REPLAY_WINDOW);
      if (this.#seen.size > REPLAY_WINDOW * 2) for (const x of this.#seen) if (x <= floor) this.#seen.delete(x);
    }
    return true;
  }
}

/** Host: verify a session request and create the session. Returns {response, session} or null. */
export async function acceptSession(kst, body, seenNonces, now = Date.now()) {
  try {
    if (body?.v !== PROTOCOL_VERSION) return null;
    const ts = Number(body.ts);
    if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > CLOCK_SKEW_MS) return null;
    const clientEPub = unb64u(String(body.ePub));
    const nonce = unb64u(String(body.nonce));
    if (nonce.length !== 16) return null;
    const ok = await hmacOk(kst, unb64u(String(body.mac)), "uniview-session", String(body.deviceId), clientEPub, u64(ts), nonce);
    if (!ok) return null;
    const nonceKey = b64u(nonce);
    if (seenNonces.has(nonceKey)) return null;
    seenNonces.set(nonceKey, now);
    const eph = await generateIdentity(false);
    const sessionId = randomBytes(16);
    const keys = await sessionKeys(eph.privateKey, clientEPub, kst, sessionId);
    const mac = await hmac(kst, "uniview-session-ok", sessionId, eph.publicRaw, clientEPub);
    return {
      response: { sessionId: b64u(sessionId), ePub: b64u(eph.publicRaw), mac: b64u(mac) },
      session: new HostSession(sessionId, keys, String(body.deviceId), now),
    };
  } catch {
    return null;
  }
}

function iv(direction, seq) {
  return concat(new Uint8Array([0, 0, 0, direction]), u64(seq));
}

function frameJson(json, payload) {
  const j = enc.encode(JSON.stringify(json));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, j.length);
  return concat(head, j, payload ?? new Uint8Array(0));
}

function unframeJson(bytes) {
  if (bytes.length < 4) throw new ProtocolError("short frame");
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + n > bytes.length) throw new ProtocolError("bad frame");
  return { json: JSON.parse(dec.decode(bytes.subarray(4, 4 + n))), payload: bytes.subarray(4 + n) };
}

export class ClientSession {
  #seq = 0n;
  constructor(id, keys) {
    this.id = id;
    this.idText = b64u(id);
    this.keys = keys;
  }

  /** Encrypt a request. Returns {seq, bytes}. */
  async seal(request) {
    const seq = ++this.#seq;
    const aad = concat("uniview-rpc", this.id, u64(seq));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv(1, seq), additionalData: aad }, this.keys.c2s, enc.encode(JSON.stringify(request))));
    return { seq, bytes: concat(this.id, u64(seq), ct) };
  }

  /** Decrypt the response to request `seq`. */
  async open(seq, bytes) {
    const aad = concat("uniview-rpc-resp", this.id, u64(seq));
    let plain;
    try {
      plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: iv(2, seq), additionalData: aad }, this.keys.s2c, bytes));
    } catch {
      throw new ProtocolError("A reply from the computer failed its integrity check.");
    }
    return unframeJson(plain);
  }
}

export class HostSession {
  constructor(id, keys, deviceId, now) {
    this.id = id;
    this.idText = b64u(id);
    this.keys = keys;
    this.deviceId = deviceId;
    this.createdAt = now;
    this.window = new ReplayWindow();
  }

  expired(now = Date.now()) {
    return now - this.createdAt > SESSION_TTL_MS;
  }

  /** Decrypt a request body (sessionId already matched). Returns {seq, request} or null (tampered or replayed). */
  async open(bytes) {
    if (bytes.length < 16 + 8 + 16) return null;
    const seqBytes = bytes.subarray(16, 24);
    const seq = new DataView(seqBytes.buffer, seqBytes.byteOffset, 8).getBigUint64(0);
    const aad = concat("uniview-rpc", this.id, seqBytes);
    let plain;
    try {
      plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: iv(1, seq), additionalData: aad }, this.keys.c2s, bytes.subarray(24)));
    } catch {
      return null;
    }
    // Only authenticated messages consume a sequence number, so forged traffic cannot burn the window.
    if (!this.window.accept(seq)) return null;
    try {
      return { seq, request: JSON.parse(dec.decode(plain)) };
    } catch {
      return null;
    }
  }

  async seal(seq, json, payload) {
    const aad = concat("uniview-rpc-resp", this.id, u64(seq));
    return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv(2, seq), additionalData: aad }, this.keys.s2c, frameJson(json, payload)));
  }
}

/** The session ID at the start of an rpc body, for lookup before decryption. */
export function sessionIdOf(bytes) {
  return bytes.length >= 16 ? b64u(bytes.subarray(0, 16)) : null;
}
