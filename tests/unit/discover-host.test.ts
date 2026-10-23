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

  it("resolves null after deadlineMs when transport never settles and respects concurrency limit", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const hostId = await P.idOf(hostIdentity.publicRaw);

    let inFlight = 0;
    let maxInFlight = 0;

    const transport: RemoteTransport = async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      return new Promise(() => {
        // never settles
      });
    };

    const concurrency = 8;
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
  });

  it("does not block remaining probes when a probe hangs", async () => {
    const hostIdentity = await P.generateIdentity(true);
    const hostId = await P.idOf(hostIdentity.publicRaw);

    const transport: RemoteTransport = async (host, _port, path, body) => {
      if (host === "192.168.1.1") {
        return new Promise(() => {
          // never settles
        });
      }
      if (host === "192.168.1.2" && path === "/v1/hello") {
        const parsed = JSON.parse(dec.decode(body));
        const res = await P.helloResponse(hostIdentity, hostId, parsed);
        return {
          status: 200,
          body: enc.encode(JSON.stringify(res)),
        };
      }
      throw new Error("unreachable");
    };

    const found = await discoverHost({
      transport,
      hostId,
      hostPub: hostIdentity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      timeoutMs: 50,
      deadlineMs: 5000,
      concurrency: 1,
    });

    expect(found).toBe("192.168.1.2");
  });
});
