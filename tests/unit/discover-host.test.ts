import { describe, expect, it } from "vitest";
import { discoverHost } from "../../shared/remote-client.mjs";
import type { RemoteTransport } from "../../src/core/types";

describe("discoverHost", () => {
  const targetHostId = "target-host-123";
  const enc = new TextEncoder();

  it("finds 192.168.1.35 when the known host is 192.168.1.40", async () => {
    const transport: RemoteTransport = async (host, _port, path) => {
      if (host === "192.168.1.35" && path === "/v1/hello") {
        return {
          status: 200,
          body: enc.encode(JSON.stringify({ app: "uniview", v: 1, hostId: targetHostId })),
        };
      }
      throw new Error("unreachable");
    };

    const found = await discoverHost({
      transport,
      hostId: targetHostId,
      knownHosts: ["192.168.1.40"],
      port: 8765,
    });
    expect(found).toBe("192.168.1.35");
  });

  it("ignores a 200 answer with another hostId and a non-UniView 200 answer", async () => {
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
          body: enc.encode("<html>not-json</html>"),
        };
      }
      if (host === "192.168.1.35") {
        return {
          status: 200,
          body: enc.encode(JSON.stringify({ app: "uniview", v: 1, hostId: targetHostId })),
        };
      }
      throw new Error("unreachable");
    };

    const found = await discoverHost({
      transport,
      hostId: targetHostId,
      knownHosts: ["192.168.1.40"],
      port: 8765,
    });
    expect(found).toBe("192.168.1.35");
  });

  it("never probes outside 192.168.1.0/24, never probes the known address, never probes public or IPv6", async () => {
    const probed: string[] = [];
    const transport: RemoteTransport = async (host) => {
      probed.push(host);
      throw new Error("unreachable");
    };

    const res = await discoverHost({
      transport,
      hostId: targetHostId,
      knownHosts: ["192.168.1.40"],
      port: 8765,
    });
    expect(res).toBeNull();
    expect(probed.length).toBe(253);
    expect(probed.includes("192.168.1.40")).toBe(false);
    for (const ip of probed) {
      expect(ip.startsWith("192.168.1.")).toBe(true);
      const parts = ip.split(".");
      const octet = parts[3];
      expect(octet).toBeDefined();
      if (octet !== undefined) {
        const n = Number(octet);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(254);
      }
    }

    const publicProbed: string[] = [];
    const publicTransport: RemoteTransport = async (host) => {
      publicProbed.push(host);
      throw new Error("unreachable");
    };
    const publicRes = await discoverHost({
      transport: publicTransport,
      hostId: targetHostId,
      knownHosts: ["8.8.8.8", "2001:db8::1", "::1", "fe80::1", "host.domain"],
      port: 8765,
    });
    expect(publicRes).toBeNull();
    expect(publicProbed.length).toBe(0);
  });

  it("limits concurrency to at most concurrency probes in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const concurrencyLimit = 16;
    const transport: RemoteTransport = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      throw new Error("unreachable");
    };

    await discoverHost({
      transport,
      hostId: targetHostId,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      concurrency: concurrencyLimit,
    });

    expect(maxInFlight).toBeLessThanOrEqual(concurrencyLimit);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("passes { timeoutMs } to the transport", async () => {
    let receivedTimeout: number | undefined;
    const transport: RemoteTransport = async (_host, _port, _path, _body, _type, opts) => {
      receivedTimeout = opts?.timeoutMs;
      throw new Error("unreachable");
    };

    await discoverHost({
      transport,
      hostId: targetHostId,
      knownHosts: ["192.168.1.40"],
      port: 8765,
      timeoutMs: 850,
    });

    expect(receivedTimeout).toBe(850);
  });

  it("returns null when nothing matches", async () => {
    const transport: RemoteTransport = async () => {
      throw new Error("connection failed");
    };

    const res = await discoverHost({
      transport,
      hostId: targetHostId,
      knownHosts: ["192.168.1.40"],
      port: 8765,
    });
    expect(res).toBeNull();
  });
});
