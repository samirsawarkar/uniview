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
  const offer1 = await host1.createOffer();
  host1Port = host1.state.port;

  host2 = new ShareHost({ dataDir: data2, hostName: "Secondary Host", approve: async () => true });
  await host2.init();
  await host2.setEnabled(true);
  await host2.addRoot(sharedDir, "Shared");
  const offer2 = await host2.createOffer();
  host2Port = host2.state.port;
});

afterAll(async () => {
  await host1.stop();
  await host2.stop();
  rmSync(testDir, { recursive: true, force: true });
});

describe("ShareHost hello endpoints", () => {
  it("POST /v1/hello returns {app: 'uniview', hostId} matching host.hostId", async () => {
    const res = await nodeHttpPost("127.0.0.1", host1Port, "/v1/hello", new TextEncoder().encode("{}"), "application/json");
    expect(res.status).toBe(200);
    const json = JSON.parse(new TextDecoder().decode(res.body));
    expect(json.app).toBe("uniview");
    expect(json.hostId).toBe(host1.hostId);
  });
});

describe("Host rediscovery", () => {
  it("finds the computer when IP changes, updates preferred address and hosts, and invokes onHostsChanged", async () => {
    let ipMap: Record<string, string | null> = {
      "192.168.1.40": "127.0.0.1",
    };

    const transport: RemoteTransport = async (host, port, path, body, type) => {
      const target = ipMap[host];
      if (!target) throw new Error(`ECONNREFUSED ${host}:${port}`);
      return nodeHttpPost(target, host1Port, path, body, type);
    };

    const device = await P.generateIdentity(false);
    const offer = await host1.createOffer();
    const offerText = offer.text.replace(/h=[^&]+/, "h=192.168.1.40");
    const record = await pairWithOffer(offerText, { transport, device, deviceName: "Mobile" });

    // Simulate DHCP address reassignment: 192.168.1.40 goes down, host appears at 192.168.1.35
    ipMap = {
      "192.168.1.35": "127.0.0.1",
    };

    let updatedRecord = null as HostRecord | null;
    const client = new RemoteHost(record, {
      transport,
      device,
      onHostsChanged: (r) => {
        updatedRecord = { ...r, hosts: [...r.hosts] };
      },
    });

    const info = await client.info();
    expect(info.hostName).toBe("Primary Host");
    expect(updatedRecord).not.toBeNull();
    expect(updatedRecord?.preferred).toBe("192.168.1.35");
    expect(updatedRecord?.hosts[0]).toBe("192.168.1.35");
  });

  it("fails session MAC and rejects as not reachable if a different host responds at the new address", async () => {
    const device = await P.generateIdentity(false);
    const offer1 = await host1.createOffer();
    const offerText1 = offer1.text.replace(/h=[^&]+/, "h=127.0.0.1");
    const record = await pairWithOffer(offerText1, {
      transport: (h, p, path, body, type) => nodeHttpPost("127.0.0.1", host1Port, path, body, type),
      device,
      deviceName: "Mobile",
    });

    // Also pair device with host2 so host2 recognizes deviceId but has a different key pair
    const offer2 = await host2.createOffer();
    const offerText2 = offer2.text.replace(/h=[^&]+/, "h=127.0.0.1");
    await pairWithOffer(offerText2, {
      transport: (h, p, path, body, type) => nodeHttpPost("127.0.0.1", host2Port, path, body, type),
      device,
      deviceName: "Mobile",
    });

    // An imposter at 192.168.1.35 returns host1's hostId on hello, but session handshake is processed by host2
    let changedCalled = false;
    const imposterTransport: RemoteTransport = async (host, port, path, body, type) => {
      if (host === "192.168.1.35") {
        if (path === "/v1/hello") {
          return {
            status: 200,
            body: new TextEncoder().encode(JSON.stringify({ app: "uniview", v: 1, hostId: host1.hostId })),
          };
        }
        return nodeHttpPost("127.0.0.1", host2Port, path, body, type);
      }
      throw new Error(`ECONNREFUSED ${host}:${port}`);
    };

    const client = new RemoteHost(record, {
      transport: imposterTransport,
      device,
      onHostsChanged: () => {
        changedCalled = true;
      },
    });

    await expect(client.info()).rejects.toThrow(/not reachable/);
    expect(changedCalled).toBe(false);
  });
});
