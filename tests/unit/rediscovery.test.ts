// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
// @ts-expect-error plain ESM modules without types
import { ShareHost } from "../../electron/lib/share-host.mjs";
import { RemoteHost, pairWithOffer, type HostRecord } from "../../shared/remote-client.mjs";
import * as Proto from "../../shared/remote-protocol.mjs";
import type { RemoteTransport } from "../../src/core/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Proto as any;

function nodeHttpPost(host: string, port: number, path: string, body: Uint8Array, type: string) {
  return new Promise<{ status: number; body: Uint8Array }>((resolve, reject) => {
    const req = request({ host, port, path, method: "POST", headers: { "Content-Type": type, "Content-Length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) }));
    });
    req.on("error", reject);
    req.end(Buffer.from(body));
  });
}

const testDir = join(process.cwd(), "node_modules", ".cache", "uniview-tests", `rediscovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const sharedDir = join(testDir, "shared");
const data1 = join(testDir, "data1");
const data2 = join(testDir, "data2");

let host1: InstanceType<typeof ShareHost>;
let host2: InstanceType<typeof ShareHost>;
let host1Port: number;
let host2Port: number;

beforeAll(async () => {
  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(data1, { recursive: true });
  mkdirSync(data2, { recursive: true });
  writeFileSync(join(sharedDir, "hello.txt"), "rediscovery content");

  host1 = new ShareHost({ dataDir: data1, hostName: "Primary Host", approve: async () => true });
  await host1.init();
  await host1.setEnabled(true);
  await host1.addRoot(sharedDir, "Shared");
  host1Port = host1.state.port;

  host2 = new ShareHost({ dataDir: data2, hostName: "Secondary Host", approve: async () => true });
  await host2.init();
  await host2.setEnabled(true);
  await host2.addRoot(sharedDir, "Shared");
  host2Port = host2.state.port;
});

afterAll(async () => {
  await host1.stop();
  await host2.stop();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup failure */
  }
});

describe("rediscovery", () => {
  it("discovers host1 while ignoring host2 impostor and never sends session request to host2", async () => {
    const offer1 = await host1.createOffer();
    const offerText = offer1.text.replace(/h=[^&]+/, "h=192.168.1.40").replace(/p=\d+/, `p=${host1Port}`);
    const device = await P.generateIdentity(false);

    const requestCounts: Record<string, number> = {};
    let pairingDone = false;

    const transport: RemoteTransport = async (host, port, path, body, contentType) => {
      const key = `${host}:${path}`;
      requestCounts[key] = (requestCounts[key] ?? 0) + 1;

      if (!pairingDone) {
        if (host === "192.168.1.40") {
          return nodeHttpPost("127.0.0.1", host1Port, path, body, contentType);
        }
        throw new Error(`unreachable: ${host}`);
      }

      if (host === "192.168.1.40") {
        throw new Error("connection error: 192.168.1.40 down");
      }
      if (host === "192.168.1.20") {
        return nodeHttpPost("127.0.0.1", host2Port, path, body, contentType);
      }
      if (host === "192.168.1.35") {
        return nodeHttpPost("127.0.0.1", host1Port, path, body, contentType);
      }
      throw new Error(`connection error: ${host}`);
    };

    let changedRecord = null as HostRecord | null;
    const record: HostRecord = await pairWithOffer(offerText, { transport, device, deviceName: "Test Device" });
    pairingDone = true;

    const remoteHost = new RemoteHost(record, {
      transport,
      device,
      onHostsChanged: (rec: HostRecord) => {
        changedRecord = rec;
      },
    });

    const info = await remoteHost.info();
    expect(info).toBeDefined();
    expect(changedRecord).not.toBeNull();
    expect(changedRecord!.preferred).toBe("192.168.1.35");

    expect(requestCounts["192.168.1.20:/v1/session"] ?? 0).toBe(0);
    expect(requestCounts["192.168.1.20:/v1/hello"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(requestCounts["192.168.1.35:/v1/session"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("rejects replayed hello proof from host1 and reports host not reachable", async () => {
    const offer1 = await host1.createOffer();
    const offerText = offer1.text.replace(/h=[^&]+/, "h=192.168.1.40").replace(/p=\d+/, `p=${host1Port}`);
    const device = await P.generateIdentity(false);

    const probe = await P.helloRequest();
    const probeRes = await nodeHttpPost(
      "127.0.0.1",
      host1Port,
      "/v1/hello",
      new TextEncoder().encode(JSON.stringify(probe.body)),
      "application/json",
    );
    const replayedProofJson = JSON.parse(new TextDecoder().decode(probeRes.body));

    let pairingDone = false;

    const transport: RemoteTransport = async (host, port, path, body, contentType) => {
      if (!pairingDone) {
        if (host === "192.168.1.40") {
          return nodeHttpPost("127.0.0.1", host1Port, path, body, contentType);
        }
        throw new Error(`unreachable: ${host}`);
      }

      if (host === "192.168.1.40") {
        throw new Error("connection error: 192.168.1.40 down");
      }
      if (host === "192.168.1.50" && path === "/v1/hello") {
        return {
          status: 200,
          body: new TextEncoder().encode(JSON.stringify(replayedProofJson)),
        };
      }
      throw new Error(`connection error: ${host}`);
    };

    let onHostsChangedCalled = false;
    const record: HostRecord = await pairWithOffer(offerText, { transport, device, deviceName: "Test Device" });
    pairingDone = true;

    const remoteHost = new RemoteHost(record, {
      transport,
      device,
      onHostsChanged: () => {
        onHostsChangedCalled = true;
      },
    });

    await expect(remoteHost.info()).rejects.toThrow(/not reachable/);
    expect(onHostsChangedCalled).toBe(false);
  });
});
