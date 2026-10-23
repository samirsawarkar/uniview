import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
// @ts-expect-error plain ESM module without types
import { isLanPeer, ShareHost } from "../../electron/lib/share-host.mjs";

function requestHttp(method: string, path: string, port: number, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = body ? Buffer.from(body, "utf8") : Buffer.alloc(0);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("isLanPeer", () => {
  it("allows private and local network peer addresses", () => {
    const allowed = [
      "127.0.0.1",
      "::1",
      "::ffff:192.168.1.51",
      "192.168.1.51",
      "10.0.0.7",
      "fe80::1%2",
      "fd00::5",
    ];
    for (const addr of allowed) {
      expect(isLanPeer(addr), `expected ${addr} to be allowed`).toBe(true);
    }
  });

  it("rejects non-LAN, public, CGNAT, link-local IPv4, empty, and undefined addresses", () => {
    const rejected = [
      "8.8.8.8",
      "::ffff:8.8.8.8",
      "203.0.113.9",
      "100.64.0.1",
      "169.254.1.1",
      "",
      undefined,
    ];
    for (const addr of rejected) {
      expect(isLanPeer(addr), `expected ${String(addr)} to be rejected`).toBe(false);
    }
  });

  it("enforces peer check at request boundary", async () => {
    const blockedDir = join(
      process.cwd(),
      "node_modules",
      ".cache",
      "uniview-tests",
      `lan-peer-blocked-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const defaultDir = join(
      process.cwd(),
      "node_modules",
      ".cache",
      "uniview-tests",
      `lan-peer-default-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      const blockedHost = new ShareHost({
        dataDir: blockedDir,
        hostName: "Blocked Host",
        isPeerAllowed: () => false,
        approve: async () => true,
      });
      await blockedHost.init();
      await blockedHost.setEnabled(true);
      const blockedPort = blockedHost.state.port;

      const sessionRes = await requestHttp("POST", "/v1/session", blockedPort, "{}");
      expect(sessionRes.status).toBe(403);

      const helloPostRes = await requestHttp("POST", "/v1/hello", blockedPort, "{}");
      expect(helloPostRes.status).toBe(403);

      await blockedHost.stop();

      const defaultHost = new ShareHost({
        dataDir: defaultDir,
        hostName: "Default Host",
        approve: async () => true,
      });
      await defaultHost.init();
      await defaultHost.setEnabled(true);
      const defaultPort = defaultHost.state.port;

      const helloGetRes = await requestHttp("GET", "/v1/hello", defaultPort);
      expect(helloGetRes.status).toBe(200);

      await defaultHost.stop();
    } finally {
      try {
        rmSync(blockedDir, { recursive: true, force: true });
        rmSync(defaultDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup error */
      }
    }
  });
});
