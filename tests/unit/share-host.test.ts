// @vitest-environment node
// End-to-end over real HTTP: ShareHost (host) <-> RemoteHost (client), no Electron.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
// @ts-expect-error plain ESM modules without types
import { ShareHost, resolveInRoot } from "../../electron/lib/share-host.mjs";
import { RemoteHost, pairWithOffer, RemoteError } from "../../shared/remote-client.mjs";
import * as Proto from "../../shared/remote-protocol.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Proto as any;

/** Node HTTP transport, like the Electron main-process transport. */
function transport(host: string, port: number, path: string, body: Uint8Array, type: string) {
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

const tmp = mkdtempSync(join(tmpdir(), "uniview-share-"));
const shared = join(tmp, "shared");
const secret = join(tmp, "secret");
const data = join(tmp, "data");
let host: InstanceType<typeof ShareHost>;
let approve = true;

beforeAll(async () => {
  mkdirSync(join(shared, "Docs"), { recursive: true });
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(shared, "Docs", "report.txt"), "hello remote world");
  writeFileSync(join(shared, ".hidden"), "x");
  writeFileSync(join(shared, "big.bin"), Buffer.alloc(9 * 1024 * 1024, 7));
  writeFileSync(join(secret, "passwords.txt"), "do not read");
  try {
    symlinkSync(secret, join(shared, "escape"), "junction");
  } catch {
    /* symlinks may need privileges; the resolveInRoot test covers traversal regardless */
  }
  host = new ShareHost({ dataDir: data, hostName: "Test PC", approve: async () => approve });
  await host.init();
  await host.setEnabled(true);
  await host.addRoot(shared, "Shared");
});

afterAll(async () => {
  await host.stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function pairNewDevice(name = "Pixel 7") {
  const device = await P.generateIdentity(false);
  const offer = await host.createOffer();
  const text = offer.text.replace(/h=[^&]+/, "h=127.0.0.1");
  const record = await pairWithOffer(text, { transport, device, deviceName: name });
  return { device, record, client: new RemoteHost(record, { transport, device }) };
}

describe("ShareHost <-> RemoteHost", () => {
  it("pairs, lists, reads ranges and logs access", async () => {
    const { client, record } = await pairNewDevice();
    expect(record.hostName).toBe("Test PC");
    const info = await client.info();
    expect(info.roots.map((r: { name: string }) => r.name)).toEqual(["Shared"]);
    const root = info.roots[0]!.id;
    const top = await client.list(root, "");
    expect(top.map((e: { name: string }) => e.name)).toContain("Docs");
    expect(top.map((e: { name: string }) => e.name)).not.toContain(".hidden");
    expect(top.map((e: { name: string }) => e.name)).not.toContain("escape"); // symlink leaving the share is hidden
    const text = new TextDecoder().decode(await client.read(root, "Docs/report.txt", 6, 12));
    expect(text).toBe("remote");
    const big = await client.read(root, "big.bin", 0, 9 * 1024 * 1024);
    expect(big.length).toBe(9 * 1024 * 1024); // spans three 4 MiB requests
    expect(host.state.log.some((l: { action: string; path: string }) => l.action === "opened" && l.path === "Shared/big.bin")).toBe(true);
    expect(host.state.devices.find((d: { name: string }) => d.name === "Pixel 7")).toBeTruthy();
  });

  it("shows a friendly name for devices saved with a raw ' Build/...' name", async () => {
    await pairNewDevice("RMX2002 Build/RP1A.200720.011");
    const names = host.state.devices.map((d: { name: string }) => d.name);
    expect(names).toContain("realme RMX2002");
    expect(names.some((n: string) => n.includes("Build/"))).toBe(false);
  });

  it("refuses paths outside the share", async () => {
    const { client } = await pairNewDevice();
    const root = (await client.info()).roots[0]!.id;
    await expect(client.read(root, "../secret/passwords.txt", 0, 10)).rejects.toThrow(/not available/);
    await expect(client.read(root, "escape/passwords.txt", 0, 10)).rejects.toThrow(/not available/);
    await expect(client.list(root, "Docs/../../secret")).rejects.toThrow(/not available/);
    await expect(client.read(root, "Docs/report.txt", 0, 5 * 1024 * 1024)).resolves.toBeTruthy();
  });

  it("offers are one-time and declined devices are not trusted", async () => {
    const device = await P.generateIdentity(false);
    const offer = await host.createOffer();
    const text = offer.text.replace(/h=[^&]+/, "h=127.0.0.1");
    approve = false;
    await expect(pairWithOffer(text, { transport, device, deviceName: "Stranger" })).rejects.toThrow(/declined/);
    approve = true;
    await expect(pairWithOffer(text, { transport, device, deviceName: "Stranger" })).rejects.toThrow(/expired/);
    const fake = new RemoteHost({ hostId: "x", hostName: "Test PC", hostPub: P.b64u(P.unb64u(new URLSearchParams(text.split("?")[1]).get("k")!)), hosts: ["127.0.0.1"], port: host.state.port, deviceId: await P.idOf(device.publicRaw) }, { transport, device });
    await expect(fake.info()).rejects.toThrow(/no longer trusts/);
  });

  it("removing a device ends its access immediately", async () => {
    const { client, record } = await pairNewDevice("Old phone");
    await client.info();
    await host.removeDevice(record.deviceId);
    await expect(client.info()).rejects.toBeInstanceOf(RemoteError);
  });

  it("sharing off means nothing listens", async () => {
    const { client } = await pairNewDevice("Tablet");
    await host.setEnabled(false);
    await expect(client.info()).rejects.toThrow(/not reachable|stopped responding/);
    await host.setEnabled(true);
  });
});

describe("resolveInRoot", () => {
  it("refuses traversal, absolute and drive paths", async () => {
    expect(await resolveInRoot(shared, "Docs/report.txt")).toMatch(/report\.txt$/);
    expect(await resolveInRoot(shared, "../secret")).toBeNull();
    expect(await resolveInRoot(shared, "Docs\\..\\..\\secret")).toBeNull();
    expect(await resolveInRoot(shared, "C:")).toBeNull();
    expect(await resolveInRoot(shared, "nope/missing.txt")).toBeNull();
    expect(await resolveInRoot(shared, "a\0b")).toBeNull();
  });
});
