import { describe, expect, it } from "vitest";
import { discoverHost } from "../../shared/remote-client.mjs";
import * as Proto from "../../shared/remote-protocol.mjs";
import type { RemoteTransport } from "../../src/core/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Proto as any;

describe("discoverHost", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  it("finds 192.168.1.35 when the known host is 192.168.1.40", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const targetHostId = await P.idOf(hostIdentity.publicRaw);

    const transport: RemoteTransport = async (host, _port, path, body) => {
      if (host === "192.168.1.35" && path === "/v1/hello") {
        const parsed = JSON.parse(dec.decode(body));
        const res = await P.helloResponse(hostIdentity, targetHostId, parsed);
        return {
          status: 200,
          body: enc.encode(JSON.stringify(res)),
        };
      }
      throw new Error("unreachable");
    };

    const found = await discoverHost({
      transport,
      hostId: targetHostId,
      hostPub: hostIdentity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
    });
    expect(found).toBe("192.168.1.35");
  });

  it("ignores a 200 answer with another hostId, non-UniView 200, or invalid proof", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const targetHostId = await P.idOf(hostIdentity.publicRaw);

    const transport: RemoteTransport = async (host) => {
      if (host === "192.168.1.10") {
        return {
          status: 200,
          body: enc.encode(JSON.stringify({ app: "uniview", v: 1, hostId: "other-host-id" })),
        };
      }
      if (host === "192.168.1.20") {
        return {
          status: 200,
          body: enc.encode(JSON.stringify({ app: "other-app", v: 1, hostId: targetHostId })),
        };
      }
      if (host === "192.168.1.30") {
        return {
          status: 200,
          body: enc.encode(JSON.stringify({ app: "uniview", v: 1, hostId: targetHostId, proof: "invalid-proof" })),
        };
      }
      throw new Error("unreachable");
    };

    const found = await discoverHost({
      transport,
      hostId: targetHostId,
      hostPub: hostIdentity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      deadlineMs: 3000,
    });
    expect(found).toBeNull();
  });

  it("ignores an impostor with matching hostId but wrong proof and finds real host", async () => {
    const realHost = await P.generateIdentity(true);
    const realHostId = await P.idOf(realHost.publicRaw);
    const impostorHost = await P.generateIdentity(true);

    const transport: RemoteTransport = async (host, _port, path, body) => {
      if (path !== "/v1/hello") throw new Error("unreachable");
      const parsed = JSON.parse(dec.decode(body));
      if (host === "192.168.1.20") {
        const res = await P.helloResponse(impostorHost, realHostId, parsed);
        return {
          status: 200,
          body: enc.encode(JSON.stringify(res)),
        };
      }
      if (host === "192.168.1.35") {
        const res = await P.helloResponse(realHost, realHostId, parsed);
        return {
          status: 200,
          body: enc.encode(JSON.stringify(res)),
        };
      }
      throw new Error("unreachable");
    };

    const found = await discoverHost({
      transport,
      hostId: realHostId,
      hostPub: realHost.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
    });
    expect(found).toBe("192.168.1.35");
  });

  it("exercises replacement while respecting concurrency limit when transports settle after probe timer", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const hostId = await P.idOf(hostIdentity.publicRaw);

    let inFlight = 0;
    let maxInFlight = 0;
    let totalCalls = 0;

    const transport: RemoteTransport = async () => {
      totalCalls++;
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight--;
      throw new Error("connection failed");
    };

    const concurrency = 4;
    const start = Date.now();
    const found = await discoverHost({
      transport,
      hostId,
      hostPub: hostIdentity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      timeoutMs: 50,
      deadlineMs: 400,
      concurrency,
    });
    const elapsed = Date.now() - start;

    expect(found).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(totalCalls).toBeGreaterThan(concurrency);
  });

  it("never exceeds concurrency limit when transports settle after 200 ms with connection error", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const hostId = await P.idOf(hostIdentity.publicRaw);

    let inFlight = 0;
    let maxInFlight = 0;
    let callsAfterResolve = 0;
    let resolved = false;

    const transport: RemoteTransport = async () => {
      if (resolved) {
        callsAfterResolve++;
      }
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight--;
      throw new Error("connection error");
    };

    const concurrency = 2;
    const found = await discoverHost({
      transport,
      hostId,
      hostPub: hostIdentity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      timeoutMs: 50,
      deadlineMs: 550,
      concurrency,
    });
    resolved = true;

    expect(found).toBeNull();
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callsAfterResolve).toBe(0);
  });

  it("does not start new probes while slow transports are still outstanding (probe timer fires first)", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const hostId = await P.idOf(hostIdentity.publicRaw);
    let inFlight = 0;
    let maxInFlight = 0;
    // Each transport outlives the per-probe timer (timeoutMs + 500 = 550 ms).
    const transport: RemoteTransport = async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      inFlight--;
      throw new Error("connection error");
    };
    const found = await discoverHost({
      transport,
      hostId,
      hostPub: hostIdentity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      timeoutMs: 50,
      deadlineMs: 1500,
      concurrency: 2,
    });
    expect(found).toBeNull();
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
