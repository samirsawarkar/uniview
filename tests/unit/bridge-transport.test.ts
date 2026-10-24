import { describe, it, expect, vi } from "vitest";
import net from "node:net";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

// @ts-expect-error plain ESM module without types
import { BridgeError, encodeFrame, FrameDecoder, clientProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { ensureBridgeDir, ensureBridgeKey, readBridgeKey, ensureInstallId, windowsUserSid, bridgeEndpoint } from "../../electron/lib/bridge-key.mjs";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";

async function makeTestDir(): Promise<string> {
  const base = process.platform === "win32" ? "I:\\AES\\tmp" : path.join(os.tmpdir(), "aes-test");
  const dir = path.join(base, `uv-test-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeEndpoint(testDir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\uniview-test-${crypto.randomBytes(8).toString("hex")}`;
  }
  return path.join(testDir, "b.sock");
}

describe("bridge transport", () => {
  it("completes request/response round trip with a 1 MiB body and fires onSessionClosed once", async () => {
    // Mutation: failing to handle 1 MiB body frame or failing to call onSessionClosed with correct sessionId on client disconnect
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    let sessionClosedResolve!: (id: string) => void;
    const sessionClosedPromise = new Promise<string>((res) => {
      sessionClosedResolve = res;
    });

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async ({ sessionId }: any, header: any, body: any) => {
        return { result: { echoMethod: header.method, sessionId }, body };
      },
      onSessionClosed: (id: any) => sessionClosedResolve(id),
    });

    const client = await connectBridge({ endpoint, key });
    const reqBody = crypto.randomBytes(1024 * 1024);
    const res = await client.request("ping", { test: true }, reqBody);

    expect(res.result.echoMethod).toBe("ping");
    expect(res.result.sessionId).toBe(client.sessionId);
    expect(res.body).toEqual(reqBody);

    await client.close();
    const closedSessionId = await sessionClosedPromise;
    expect(closedSessionId).toBe(client.sessionId);

    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("rejects connection with wrong key with auth_failed and never calls onRequest", async () => {
    // Mutation: allowing authentication with mismatched keys or executing onRequest on unauthenticated connection
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const serverKey = crypto.randomBytes(32);
    const clientKey = crypto.randomBytes(32);
    let requestCalled = false;

    const server = await startBridgeServer({
      endpoint,
      key: serverKey,
      onRequest: async () => {
        requestCalled = true;
        return { result: "ok" };
      },
    });

    await expect(connectBridge({ endpoint, key: clientKey, handshakeTimeoutMs: 1000 })).rejects.toThrow(
      expect.objectContaining({ code: "auth_failed" })
    );

    expect(requestCalled).toBe(false);
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("ensures fake server cannot learn the client proof", async () => {
    // Mutation: client sending proof frame to an unauthenticated/spoofed server before server proof verification
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const goodKey = crypto.randomBytes(32);
    const fakeKey = crypto.randomBytes(32);

    const recordedChunks: Buffer[] = [];
    const fakeServer = net.createServer((sock) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        recordedChunks.push(chunk);
        try {
          const frames = decoder.push(chunk);
          for (const f of frames) {
            if (f.header.t === "hello") {
              const serverNonce = crypto.randomBytes(32).toString("hex");
              const hmac = crypto.createHmac("sha256", fakeKey);
              hmac.update(Buffer.from(f.header.clientNonce, "hex"));
              hmac.update(Buffer.from(serverNonce, "hex"));
              const serverProof = hmac.digest("hex");
              sock.write(encodeFrame({ t: "challenge", serverNonce, serverProof }));
            }
          }
        } catch {}
      });
    });

    await new Promise<void>((resolve) => fakeServer.listen(endpoint, () => resolve()));

    await expect(connectBridge({ endpoint, key: goodKey, handshakeTimeoutMs: 1000 })).rejects.toThrow();

    const recordedStr = Buffer.concat(recordedChunks).toString("utf8");
    expect(recordedStr.includes('"proof"')).toBe(false);

    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("handles squatter / endpoint in use correctly", async () => {
    // Mutation: failing to detect active endpoint in use, overwriting non-socket files, or failing to clean stale socket files
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(endpoint, () => resolve()));

    await expect(startBridgeServer({ endpoint, key, onRequest: async () => ({}) })).rejects.toThrow(
      expect.objectContaining({ code: "endpoint_in_use" })
    );

    await new Promise<void>((resolve) => squatter.close(() => resolve()));

    if (process.platform !== "win32") {
      await fs.writeFile(endpoint, "not-a-socket-file");
      await expect(startBridgeServer({ endpoint, key, onRequest: async () => ({}) })).rejects.toThrow(
        expect.objectContaining({ code: "endpoint_not_ours" })
      );
      await fs.unlink(endpoint);

      const staleServer = net.createServer();
      await new Promise<void>((resolve) => staleServer.listen(endpoint, () => resolve()));
      await new Promise<void>((resolve) => staleServer.close(() => resolve()));

      const server = await startBridgeServer({ endpoint, key, onRequest: async () => ({ result: "ok" }) });
      const client = await connectBridge({ endpoint, key });
      const res = await client.request("test");
      expect(res.result).toBe("ok");
      await client.close();
      await server.close();
    }

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("rejects oversized frame before parse and closes connection", async () => {
    // Mutation: buffering/parsing payload when header length exceeds 64 KiB instead of immediately rejecting with too_large and closing
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({ endpoint, key, onRequest: async () => ({}) });

    const client = await connectBridge({ endpoint, key });
    const rawSock = net.connect(endpoint);
    // Handshake raw socket
    // @ts-expect-error plain ESM module without types
    const { clientHandshake } = await import("../../electron/lib/bridge-proto.mjs");
    const { decoder } = await clientHandshake(rawSock, { key });

    const oversizedLengthBuf = Buffer.alloc(4);
    oversizedLengthBuf.writeUInt32BE(65537, 0); // 64 KiB + 1
    rawSock.write(oversizedLengthBuf);

    const received: Buffer[] = [];
    let closed = false;
    await new Promise<void>((resolve) => {
      rawSock.on("data", (chunk: Buffer) => received.push(chunk));
      rawSock.on("close", () => {
        closed = true;
        resolve();
      });
    });

    const frames = decoder.push(Buffer.concat(received));
    expect(frames[0].header).toEqual({ t: "error", code: "too_large" });
    expect(closed).toBe(true);

    await client.close();
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("enforces 9th connection busy limit and accepts new connection after one closes", async () => {
    // Mutation: exceeding maxConnections limit without sending busy or failing to decrement connection count when socket closes
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => ({ result: "ok" }),
      maxConnections: 8,
    });

    const clients: any[] = [];
    for (let i = 0; i < 8; i++) {
      clients.push(await connectBridge({ endpoint, key }));
    }
    expect(server.connectionCount()).toBe(8);

    const sock9 = net.connect(endpoint);
    const data9: Buffer[] = [];
    let sock9Closed = false;
    await new Promise<void>((resolve) => {
      sock9.on("data", (c: Buffer) => data9.push(c));
      sock9.on("close", () => {
        sock9Closed = true;
        resolve();
      });
    });

    const dec = new FrameDecoder();
    const frames = dec.push(Buffer.concat(data9));
    expect(frames[0].header).toEqual({ t: "error", code: "busy" });
    expect(sock9Closed).toBe(true);

    await clients[0].close();
    while (server.connectionCount() > 7) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const clientNew = await connectBridge({ endpoint, key });
    expect(clientNew.sessionId).toBeDefined();
    expect(server.connectionCount()).toBe(8);

    await clientNew.close();
    for (let i = 1; i < 8; i++) {
      await clients[i].close();
    }
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("returns busy for 17th in-flight request while 16 others complete when released", async () => {
    // Mutation: exceeding maxInFlight limit per connection or dropping/failing concurrent in-flight requests
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    let releaseWaiters!: () => void;
    const waitPromise = new Promise<void>((res) => {
      releaseWaiters = res;
    });

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async (_session: any, header: any) => {
        if (header.method === "block") {
          await waitPromise;
          return { result: "unblocked" };
        }
        return { result: "ok" };
      },
      maxInFlight: 16,
    });

    const client = await connectBridge({ endpoint, key });

    const promises16: Promise<any>[] = [];
    for (let i = 0; i < 16; i++) {
      promises16.push(client.request("block", { idx: i }));
    }

    const req17 = client.request("block", { idx: 16 });
    await expect(req17).rejects.toThrow(expect.objectContaining({ code: "busy" }));

    releaseWaiters();
    const results = await Promise.all(promises16);
    expect(results.length).toBe(16);
    expect(results[0].result).toBe("unblocked");

    await client.close();
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("closes unresponsive socket after handshake timeout deadline", async () => {
    // Mutation: leaking connection or keeping socket open indefinitely when client fails to initiate handshake within deadline
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => ({}),
      handshakeTimeoutMs: 200,
    });

    const rawSock = net.connect(endpoint);
    let closed = false;
    const start = Date.now();
    await new Promise<void>((resolve) => {
      rawSock.on("close", () => {
        closed = true;
        resolve();
      });
    });

    const elapsed = Date.now() - start;
    expect(closed).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(150);

    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("validates key creation, permissions, and Windows icacls ACLs", async () => {
    // Mutation: creating insecure key files, failing idempotent key reads, omitting Windows icacls ACL isolation, or permitting insecure Unix permissions
    const testDir = await makeTestDir();
    const bridgeDir = path.join(testDir, "bridge");
    await fs.mkdir(bridgeDir, { recursive: true });

    await expect(readBridgeKey(bridgeDir)).rejects.toThrow(expect.objectContaining({ code: "no_key" }));

    const key1 = await ensureBridgeKey(bridgeDir);
    expect(key1.length).toBe(32);

    const key2 = await ensureBridgeKey(bridgeDir);
    expect(key2).toEqual(key1);

    const keyRead = await readBridgeKey(bridgeDir);
    expect(keyRead).toEqual(key1);

    if (process.platform === "win32") {
      // The real ACL: inheritance removed and only the current user listed.
      const { execFileSync } = await import("node:child_process");
      const acl = execFileSync("icacls", [path.join(bridgeDir, "key")], { encoding: "utf8" });
      const entries = acl.split(/\r?\n/).map((l) => l.replace(path.join(bridgeDir, "key"), "").trim()).filter((l) => l && !l.startsWith("Successfully"));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.toLowerCase()).toContain(os.userInfo().username.toLowerCase());
      expect(entries[0]).toContain("(F)");
      expect(entries[0]).not.toContain("(I)");
    }

    const installId1 = await ensureInstallId(bridgeDir);
    expect(installId1.length).toBe(32);
    const installId2 = await ensureInstallId(bridgeDir);
    expect(installId2).toBe(installId1);

    const winBridgeDir = path.join(testDir, "win-bridge");
    await fs.mkdir(winBridgeDir, { recursive: true });
    const mockExec = vi.fn().mockImplementation((_cmd, _args, cb) => {
      if (cb) cb(null, "", "");
      return Promise.resolve("");
    });

    const winKey = await ensureBridgeKey(winBridgeDir, {
      platform: "win32",
      execFile: mockExec,
      username: "alice",
    });
    expect(winKey.length).toBe(32);
    expect(mockExec).toHaveBeenCalledWith(
      "icacls",
      [path.join(winBridgeDir, "key"), "/inheritance:r", "/grant:r", "alice:F"],
      expect.any(Function)
    );

    const winBridgeDirFail = path.join(testDir, "win-bridge-fail");
    await fs.mkdir(winBridgeDirFail, { recursive: true });
    const mockFailExec = vi.fn().mockImplementation((_cmd, _args, cb) => {
      const err = new Error("icacls denied");
      if (cb) cb(err, "", "");
      return Promise.reject(err);
    });

    await expect(
      ensureBridgeKey(winBridgeDirFail, {
        platform: "win32",
        execFile: mockFailExec,
        username: "alice",
      })
    ).rejects.toThrow(expect.objectContaining({ code: "acl_failed" }));

    await expect(fs.stat(path.join(winBridgeDirFail, "key"))).rejects.toThrow();

    if (process.platform !== "win32") {
      const unixBridgeDir = path.join(testDir, "unix-bridge");
      await fs.mkdir(unixBridgeDir, { recursive: true, mode: 0o700 });
      const badKeyPath = path.join(unixBridgeDir, "key");
      await fs.writeFile(badKeyPath, crypto.randomBytes(32), { mode: 0o644 });
      await fs.chmod(badKeyPath, 0o644);

      await expect(readBridgeKey(unixBridgeDir, { platform: "linux" })).rejects.toThrow(
        expect.objectContaining({ code: "bad_key_perms" })
      );

      const groupWritableUserData = path.join(testDir, "gw-user");
      const gwBridge = path.join(groupWritableUserData, "bridge");
      await fs.mkdir(gwBridge, { recursive: true, mode: 0o775 });
      await fs.chmod(gwBridge, 0o775);

      await expect(ensureBridgeDir(groupWritableUserData, { platform: "linux" })).rejects.toThrow(
        expect.objectContaining({ code: "bad_dir" })
      );
    }

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("parses windowsUserSid and validates bridgeEndpoint naming and path length limit", async () => {
    // Mutation: incorrect CSV SID regex validation, wrong Windows pipe naming/hashing, or missing Unix socket path length limit
    const mockWhoami = vi.fn().mockResolvedValue({
      stdout: '"desktop\\samir","S-1-5-21-1-2-3-1001"\r\n',
    });
    const sid = await windowsUserSid({ execFile: mockWhoami });
    expect(sid).toBe("S-1-5-21-1-2-3-1001");

    const mockWhoamiJunk = vi.fn().mockResolvedValue({
      stdout: '"desktop\\samir","invalid-sid"\r\n',
    });
    await expect(windowsUserSid({ execFile: mockWhoamiJunk })).rejects.toThrow(
      expect.objectContaining({ code: "bad_sid" })
    );

    const userSid = "S-1-5-21-1-2-3-1001";
    const installId = "0123456789abcdef0123456789abcdef";
    const pipe = bridgeEndpoint({
      platform: "win32",
      userSid,
      installId,
    });
    const expectedHash = crypto
      .createHash("sha256")
      .update(userSid + installId)
      .digest("hex")
      .slice(0, 16);
    expect(pipe).toBe(`\\\\.\\pipe\\uniview-bridge-${expectedHash}`);

    const longDir = "/tmp/" + "a".repeat(104 - "/tmp/".length - "/b.sock".length);
    expect(() =>
      bridgeEndpoint({
        platform: "linux",
        bridgeDir: longDir,
      })
    ).toThrow(expect.objectContaining({ code: "path_too_long" }));

    const validDir = "/tmp/" + "a".repeat(103 - "/tmp/".length - "/b.sock".length);
    const validSock = bridgeEndpoint({
      platform: "linux",
      bridgeDir: validDir,
    });
    expect(Buffer.byteLength(validSock)).toBe(103);
  });

  it("serves a request sent in the same write as the client's proof", async () => {
    // Mutation caught: the server ignoring the frames handed over with the handshake (`pending`).
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);
    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async (_session: any, header: any) => ({ result: { echo: header.method } }),
    });
    const sock = net.connect(endpoint);
    const decoder = new FrameDecoder();
    const frames: any[] = [];
    sock.on("data", (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) frames.push(f.header);
    });
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    const clientNonce = crypto.randomBytes(32);
    sock.write(encodeFrame({ t: "hello", v: 1, clientNonce: clientNonce.toString("base64") }));
    for (let i = 0; i < 200 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(frames[0]?.t).toBe("challenge");
    const serverNonce = Buffer.from(frames[0].serverNonce, "base64");
    const proof = clientProof(key, serverNonce, clientNonce);
    // proof + request in one write
    sock.write(Buffer.concat([
      encodeFrame({ t: "proof", clientProof: proof.toString("base64") }),
      encodeFrame({ t: "req", id: 1, method: "ping" }),
    ]));
    for (let i = 0; i < 200 && frames.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(frames[1]?.t).toBe("ready");
    expect(frames[2]).toMatchObject({ t: "res", id: 1, ok: true, result: { echo: "ping" } });
    sock.destroy();
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
