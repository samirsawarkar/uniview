// Client side of remote browsing (docs/REMOTE.md). Transport-agnostic: the shell supplies
// transport(host, port, path, body, contentType) -> {status, body: Uint8Array}.
import * as P from "./remote-protocol.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class RemoteError extends Error {
  constructor(message, code = "remote") {
    super(message);
    this.name = "RemoteError";
    this.code = code;
  }
}

async function postJson(transport, host, port, path, obj) {
  const res = await transport(host, port, path, enc.encode(JSON.stringify(obj)), "application/json");
  let json = null;
  try {
    json = JSON.parse(dec.decode(res.body));
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json };
}

/**
 * Pair with a host from its QR/code text. Tries each advertised address.
 * Returns the record to store: {hostId, hostName, hostPub, hosts, port, deviceId}.
 */
export async function pairWithOffer(offerText, { transport, device, deviceName }) {
  const offer = P.parseOffer(offerText);
  const req = await P.pairRequest(offer, device, deviceName);
  let lastError = null;
  for (const host of offer.hosts) {
    let res;
    try {
      res = await postJson(transport, host, offer.port, "/v1/pair", req.body);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.status === 200) {
      const { deviceId, hostName } = await req.verify(res.json);
      return { hostId: await P.idOf(offer.hostPub), hostName, hostPub: P.b64u(offer.hostPub), hosts: offer.hosts, port: offer.port, deviceId, preferred: host };
    }
    if (res.status === 403) throw new RemoteError(res.json?.error ?? "The computer's owner declined this device.", "declined");
    if (res.status === 410) throw new RemoteError(res.json?.error ?? "This pairing code has expired.", "expired");
    if (res.status === 401) throw new RemoteError("This pairing code was not accepted. Show a new code on the computer.", "unauthorized");
    lastError = new RemoteError(`The computer answered with an error (${res.status}).`);
  }
  throw new RemoteError(
    `Could not reach ${offer.name}. Make sure both devices are on the same Wi-Fi network and sharing is turned on.${lastError?.message ? ` (${lastError.message})` : ""}`,
    "unreachable",
  );
}

/** A connection to one paired host. Sessions are created lazily and renewed when they expire. */
export class RemoteHost {
  #session = null;
  #sessionPromise = null;
  #host = null;

  constructor(record, { transport, device }) {
    this.record = record;
    this.transport = transport;
    this.device = device;
    this.#host = record.preferred ?? record.hosts[0];
  }

  async #kst() {
    const hostPub = P.unb64u(this.record.hostPub);
    return P.staticKey(this.device.privateKey, hostPub, hostPub, this.device.publicRaw);
  }

  async #openSession() {
    const kst = await this.#kst();
    const hosts = [this.#host, ...this.record.hosts.filter((h) => h !== this.#host)];
    let lastError = null;
    for (const host of hosts) {
      const req = await P.sessionRequest(kst, this.record.deviceId);
      let res;
      try {
        res = await postJson(this.transport, host, this.record.port, "/v1/session", req.body);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.status === 200) {
        this.#host = host;
        return req.finish(res.json);
      }
      if (res.status === 401) throw new RemoteError(`${this.record.hostName} no longer trusts this device. Pair again.`, "unpaired");
      lastError = new RemoteError(`${this.record.hostName} answered with an error (${res.status}).`);
    }
    throw new RemoteError(`${this.record.hostName} is not reachable. Check that it is on, sharing is turned on, and you are on the same network.`, "unreachable");
  }

  async #ensureSession() {
    if (this.#session) return this.#session;
    this.#sessionPromise ??= this.#openSession().finally(() => (this.#sessionPromise = null));
    this.#session = await this.#sessionPromise;
    return this.#session;
  }

  /** Call an operation. Returns {json, payload}; throws RemoteError with the host's message on failure. */
  async call(op, args = {}, retry = true) {
    const session = await this.#ensureSession();
    const { seq, bytes } = await session.seal({ op, ...args });
    let res;
    try {
      res = await this.transport(this.#host, this.record.port, "/v1/rpc", bytes, "application/octet-stream");
    } catch (err) {
      this.#session = null;
      if (retry) return this.call(op, args, false);
      throw new RemoteError(`${this.record.hostName} stopped responding. ${err?.message ?? ""}`.trim(), "unreachable");
    }
    if (res.status === 401) {
      // Session expired or the host restarted: open a new one once.
      this.#session = null;
      if (retry) return this.call(op, args, false);
      throw new RemoteError(`${this.record.hostName} refused the connection.`, "unauthorized");
    }
    if (res.status !== 200) throw new RemoteError(`${this.record.hostName} answered with an error (${res.status}).`);
    const out = await session.open(seq, res.body);
    if (out.json?.error) throw new RemoteError(out.json.error, "host");
    return out;
  }

  info() {
    return this.call("info").then((r) => r.json);
  }

  list(root, path) {
    return this.call("list", { root, path }).then((r) => r.json.entries);
  }

  stat(root, path) {
    return this.call("stat", { root, path }).then((r) => r.json);
  }

  async read(root, path, start, end) {
    const out = [];
    let total = 0;
    for (let s = start; s < end; s += P.MAX_READ) {
      const r = await this.call("read", { root, path, start: s, end: Math.min(end, s + P.MAX_READ) });
      out.push(r.payload);
      total += r.payload.length;
      if (r.payload.length < Math.min(end, s + P.MAX_READ) - s) break; // end of file
    }
    if (out.length === 1) return out[0];
    const b = new Uint8Array(total);
    let o = 0;
    for (const c of out) {
      b.set(c, o);
      o += c.length;
    }
    return b;
  }

  thumb(root, path, size) {
    return this.call("thumb", { root, path, size }).then((r) => r.payload);
  }
}
