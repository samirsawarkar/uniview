// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as Proto from "../../shared/remote-protocol.mjs";

// The tests exercise internals the app-facing declarations do not list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Proto as any;

async function pairedPair() {
  const host = await P.generateIdentity(true);
  const device = await P.generateIdentity(false);
  const secret = P.randomBytes(32);
  const offer = P.parseOffer(P.makeOffer({ hosts: ["192.168.1.5", "10.0.0.2"], port: 47823, hostPub: host.publicRaw, secret, name: "Studio PC" }));
  const req = await P.pairRequest(offer, device, "Pixel 7");
  const verified = await P.verifyPairRequest(secret, host.publicRaw, req.body);
  expect(verified).not.toBeNull();
  const resp = await P.pairResponse(secret, host.publicRaw, verified, "Studio PC");
  const result = await req.verify(resp);
  const kHost = await P.staticKey(host.privateKey, device.publicRaw, host.publicRaw, device.publicRaw);
  const kDevice = await P.staticKey(device.privateKey, host.publicRaw, host.publicRaw, device.publicRaw);
  return { host, device, secret, offer, result, kHost, kDevice };
}

async function openSession(kDevice: Uint8Array, kHost: Uint8Array, deviceId: string) {
  const sreq = await P.sessionRequest(kDevice, deviceId);
  const accepted = await P.acceptSession(kHost, sreq.body, new Map());
  expect(accepted).not.toBeNull();
  const client = await sreq.finish(accepted.response);
  return { client, host: accepted.session, sreq };
}

describe("pairing offer", () => {
  it("round-trips and rejects junk", async () => {
    const host = await P.generateIdentity(true);
    const text = P.makeOffer({ hosts: ["192.168.1.5"], port: 47823, hostPub: host.publicRaw, secret: P.randomBytes(32), name: "PC & Co" });
    expect(text).toMatch(/^uniview:pair\?v=1&/);
    expect(P.parseOffer(text).name).toBe("PC & Co");
    expect(() => P.parseOffer("https://example.com")).toThrow(/not a UniView pairing code/);
    expect(() => P.parseOffer("uniview:pair?v=1&h=1.2.3.4&p=1")).toThrow();
    expect(() => P.parseOffer(text.replace("v=1", "v=9"))).toThrow(/incompatible/);
  });
});

describe("pairing", () => {
  it("binds both sides to the QR secret and host key", async () => {
    const { result, kHost, kDevice, device } = await pairedPair();
    expect(result.deviceId).toBe(await P.idOf(device.publicRaw));
    expect(result.hostName).toBe("Studio PC");
    expect(P.b64u(kHost)).toBe(P.b64u(kDevice));
  });

  it("rejects a request made without the secret", async () => {
    const host = await P.generateIdentity(true);
    const device = await P.generateIdentity(false);
    const offer = { hosts: ["x"], port: 1, hostPub: host.publicRaw, secret: P.randomBytes(32), name: "n" };
    const req = await P.pairRequest(offer, device, "Pixel");
    expect(await P.verifyPairRequest(P.randomBytes(32), host.publicRaw, req.body)).toBeNull();
    expect(await P.verifyPairRequest(offer.secret, host.publicRaw, { ...req.body, deviceName: "Evil" })).toBeNull();
  });

  it("client rejects an answer from a host that does not know the secret", async () => {
    const { host, device, offer } = await pairedPair();
    const req = await P.pairRequest(offer, device, "Pixel 7");
    const forged = await P.pairResponse(P.randomBytes(32), host.publicRaw, await P.verifyPairRequest(offer.secret, host.publicRaw, req.body), "x");
    await expect(req.verify(forged)).rejects.toThrow(/could not be verified/);
  });
});

describe("sessions and rpc", () => {
  it("encrypts both ways and authenticates the host", async () => {
    const { kHost, kDevice, result } = await pairedPair();
    const { client, host } = await openSession(kDevice, kHost, result.deviceId);
    const { seq, bytes } = await client.seal({ op: "list", root: "r1", path: "" });
    expect(P.sessionIdOf(bytes)).toBe(host.idText);
    const opened = await host.open(bytes);
    expect(opened.request).toEqual({ op: "list", root: "r1", path: "" });
    const reply = await host.seal(opened.seq, { ok: true }, new Uint8Array([1, 2, 3]));
    const back = await client.open(seq, reply);
    expect(back.json).toEqual({ ok: true });
    expect(Array.from(back.payload)).toEqual([1, 2, 3]);
  });

  it("rejects replays, tampering and stale or forged session requests", async () => {
    const { kHost, kDevice, result } = await pairedPair();
    const { client, host } = await openSession(kDevice, kHost, result.deviceId);
    const { bytes } = await client.seal({ op: "info" });
    expect(await host.open(bytes)).not.toBeNull();
    expect(await host.open(bytes)).toBeNull(); // replay
    const { bytes: b2 } = await client.seal({ op: "info" });
    const tampered = b2.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await host.open(tampered)).toBeNull();
    expect(await host.open(b2)).not.toBeNull(); // the tampered copy did not burn the sequence number

    const old = await P.sessionRequest(kDevice, result.deviceId, Date.now() - 10 * 60 * 1000);
    expect(await P.acceptSession(kHost, old.body, new Map())).toBeNull();
    const fresh = await P.sessionRequest(kDevice, result.deviceId);
    const seen = new Map();
    expect(await P.acceptSession(kHost, fresh.body, seen)).not.toBeNull();
    expect(await P.acceptSession(kHost, fresh.body, seen)).toBeNull(); // nonce reuse
    const stranger = await P.sessionRequest(P.randomBytes(32), result.deviceId);
    expect(await P.acceptSession(kHost, stranger.body, new Map())).toBeNull();
  });

  it("client detects an impostor host that lacks the static key", async () => {
    const { kHost, kDevice, result } = await pairedPair();
    const sreq = await P.sessionRequest(kDevice, result.deviceId);
    const impostor = await P.acceptSession(P.randomBytes(32), { ...sreq.body }, new Map());
    expect(impostor).toBeNull(); // cannot even verify the client
    const real = await P.acceptSession(kHost, sreq.body, new Map());
    const forged = { ...real.response, mac: P.b64u(P.randomBytes(32)) };
    await expect(sreq.finish(forged)).rejects.toThrow(/could not prove its identity/);
  });

  it("accepts out-of-order sequence numbers once each within the window", () => {
    const w = new P.ReplayWindow();
    expect(w.accept(3n)).toBe(true);
    expect(w.accept(1n)).toBe(true);
    expect(w.accept(2n)).toBe(true);
    expect(w.accept(2n)).toBe(false);
    expect(w.accept(5000n)).toBe(true);
    expect(w.accept(4n)).toBe(false); // fell out of the window
    expect(w.accept(0n)).toBe(false);
  });
});
