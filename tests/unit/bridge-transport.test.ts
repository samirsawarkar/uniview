import { describe, it, expect, vi } from "vitest";
import net from "node:net";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

// @ts-expect-error plain ESM module without types
import { BridgeError, encodeFrame, FrameDecoder, clientProof, serverProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { ensureBridgeDir, ensureBridgeKey, readBridgeKey, ensureInstallId, windowsUserSid, bridgeEndpoint, parseIcaclsEntries, currentWindowsAccount, resolveTool } from "../../electron/lib/bridge-key.mjs";
// @ts-expect-error plain ESM module without types
import { startBridgeServer, attachSocketGuards, createAuthFailureLogger, defaultAuthFailureLogger } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";
// @ts-expect-error plain ESM module without types
import { powershellPath } from "../../electron/lib/agent-paths.mjs";

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

  it("fake server cannot authenticate to client without key", async () => {
    // Mutation comment: Fails if the client stops verifying the server proof.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const clientKey = crypto.randomBytes(32);
    const wrongServerKey = crypto.randomBytes(32);

    let proofFrameReceived = false;
    let serverSocket: net.Socket | undefined;

    const server = net.createServer((socket) => {
      serverSocket = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        try {
          const frames = decoder.push(chunk);
          for (const frame of frames) {
            if (frame.header?.t === "hello") {
              const clientNonce = Buffer.from(frame.header.clientNonce, "base64");
              const serverNonce = crypto.randomBytes(32);
              const proof = serverProof(wrongServerKey, clientNonce, serverNonce);
              socket.write(
                encodeFrame({
                  t: "challenge",
                  serverNonce: serverNonce.toString("base64"),
                  serverProof: proof.toString("base64"),
                })
              );
            } else if (frame.header?.t === "proof") {
              proofFrameReceived = true;
            }
          }
        } catch {}
      });
    });

    await new Promise<void>((resolve) => server.listen(endpoint, () => resolve()));

    await expect(
      connectBridge({
        endpoint,
        key: clientKey,
        handshakeTimeoutMs: 1000,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "auth_failed" }));

    expect(proofFrameReceived).toBe(false);

    if (serverSocket) {
      serverSocket?.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
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
    const mockExec = vi.fn().mockImplementation((_cmd: string, args: string[], cb?: any) => {
      // `icacls <path>` (verification) lists one owner-only entry; the grant call prints nothing.
      const out = args.length === 1 ? `${args[0]} *S-1-5-21-1-2-3-1001:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\r\n` : "";
      if (cb) cb(null, out, "");
      return Promise.resolve(out);
    });

    const winKey = await ensureBridgeKey(winBridgeDir, {
      platform: "win32",
      execFile: mockExec,
      username: "alice",
      accountName: "DESKTOP\\alice",
      userSid: "S-1-5-21-1-2-3-1001",
    });
    expect(winKey.length).toBe(32);
    // The ACL is applied to the empty temp file before the secret is written, then verified.
    const grantCalls = mockExec.mock.calls.filter((c: any[]) => c[0] === "icacls" && c[1].includes("/grant:r"));
    expect(grantCalls.length).toBeGreaterThan(0);
    expect(grantCalls.some((c: any[]) => c[1].slice(1).join(" ") === "/inheritance:r /grant:r *S-1-5-21-1-2-3-1001:F")).toBe(true);

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
      accountName: "DESKTOP\\alice",
      userSid: "S-1-5-21-1-2-3-1001",
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

  it("handles stale socket on POSIX", async () => {
    // Mutation comment: Fails if startBridgeServer unlinks an endpoint without verifying dev/ino identity, or fails to clean up a dead socket.
    if (process.platform === "win32") return;

    const testDir = await makeTestDir();
    const sockPath = path.join(testDir, "stale.sock");
    const key = crypto.randomBytes(32);

    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('net').createServer().listen(process.argv[1]); setInterval(()=>{},1000)",
        sockPath,
      ],
      { stdio: "ignore" }
    );

    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const st = await fs.lstat(sockPath);
        if (st.isSocket()) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready).toBe(true);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    const server = await startBridgeServer({
      endpoint: sockPath,
      key,
      onRequest: async () => ({ result: "ok" }),
    });
    expect(server.connectionCount()).toBe(0);
    await server.close();

    await fs.writeFile(sockPath, "regular file content");
    await expect(
      startBridgeServer({
        endpoint: sockPath,
        key,
        onRequest: async () => ({ result: "ok" }),
      })
    ).rejects.toThrow(expect.objectContaining({ code: "endpoint_not_ours" }));

    await fs.unlink(sockPath).catch(() => {});
  });

  it("Windows key with inherited ACL throws bad_key_perms", async () => {
    // Mutation comment: Fails if readBridgeKey does not reject keys with inherited Windows ACL entries.
    if (process.platform !== "win32") return;
    const testDir = await makeTestDir();
    const keyPath = path.join(testDir, "key");
    await fs.writeFile(keyPath, crypto.randomBytes(32));
    await expect(
      readBridgeKey(testDir, { platform: "win32" })
    ).rejects.toThrow(expect.objectContaining({ code: "bad_key_perms" }));
  });

  it("parseIcaclsEntries parses sample icacls output including (I), (OI)(CI), and *S-1- forms", () => {
    // Mutation comment: Fails if parseIcaclsEntries fails to extract principals, rights, and inheritance flags correctly.
    const sample = `
  C:\\bridge\\key NT AUTHORITY\\SYSTEM:(I)(F)
                  BUILTIN\\Administrators:(I)(F)
                  DESKTOP-TEST\\Alice:(F)
                  *S-1-5-21-123456789-1001:(OI)(CI)(F)
  Successfully processed 1 files; Failed processing 0 files
  `;
    const entries = parseIcaclsEntries(sample, "C:\\bridge\\key");
    expect(entries).toEqual([
      { principal: "NT AUTHORITY\\SYSTEM", rights: "(F)", inherited: true },
      { principal: "BUILTIN\\Administrators", rights: "(F)", inherited: true },
      { principal: "DESKTOP-TEST\\Alice", rights: "(F)", inherited: false },
      { principal: "*S-1-5-21-123456789-1001", rights: "(OI)(CI)(F)", inherited: false },
    ]);
  });

  it("ensureBridgeKey writes secret only after ACL check passes", async () => {
    // Mutation comment: Fails if secret bytes are written to disk before ACL permissions are established and verified.
    const testDir = await makeTestDir();
    const operations: any[] = [];

    const mockFs = {
      ...fs,
      stat: async (p: any) => {
        operations.push(`stat:${path.basename(p)}`);
        return fs.stat(p);
      },
      writeFile: async (p: any, data: any, opts: any) => {
        const isBuffer = Buffer.isBuffer(data);
        const len = isBuffer ? data.length : typeof data === "string" ? Buffer.byteLength(data) : 0;
        operations.push(`writeFile:${path.basename(p)}:len=${len}`);
        return fs.writeFile(p, data, opts);
      },
      rename: async (src: any, dst: any) => {
        operations.push(`rename:${path.basename(src)}->${path.basename(dst)}`);
        return fs.rename(src, dst);
      },
    };

    const mockExecFile = (file: any, args: any, cb: any) => {
      operations.push(`execFile:${file}:${args[1] || ""}`);
      if (file === "icacls" && args.length === 1) operations.push(`verify:${path.basename(args[0])}`);
      if (file === "icacls") {
        if (args[1] === "/inheritance:r") {
          cb(null, "processed 1 files", "");
        } else {
          const target = args[0];
          cb(null, `${target} *S-1-5-21-1-2-3-1001:(F)\nSuccessfully processed 1 files;`, "");
        }
        return;
      }
      cb(null, "", "");
    };

    await ensureBridgeKey(testDir, {
      platform: "win32",
      fs: mockFs,
      execFile: mockExecFile,
      username: "USER",
      accountName: "DESKTOP\\USER",
      userSid: "S-1-5-21-1-2-3-1001",
    });

    const emptyWriteIdx = operations.findIndex((op) => op.includes("writeFile") && op.includes("len=0"));
    const icaclsCheckIdx = operations.findLastIndex((op) => op.includes("execFile:icacls"));
    const secretWriteIdx = operations.findIndex((op) => op.includes("writeFile") && op.includes("len=32"));
    const renameIdx = operations.findIndex((op) => op.includes("rename"));
    // Mutation caught: writing the secret before the temp file's ACL was verified.
    const tempVerifyIdx = operations.findIndex((op) => op.startsWith("verify:") && op !== "verify:key");
    expect(tempVerifyIdx).toBeGreaterThanOrEqual(0);
    expect(tempVerifyIdx).toBeLessThan(secretWriteIdx);

    expect(emptyWriteIdx).toBeGreaterThanOrEqual(0);
    expect(icaclsCheckIdx).toBeGreaterThan(emptyWriteIdx);
    expect(secretWriteIdx).toBeGreaterThan(icaclsCheckIdx);
    expect(renameIdx).toBeGreaterThan(secretWriteIdx);
  });

  it("hostile 9th connection that never reads or closes is destroyed within ~1s and does not appear in connectionCount", async () => {
    // Mutation comment: Fails if over-limit rejected connections leak into connectionCount or fail to be destroyed on timeout.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      maxConnections: 8,
      onRequest: async () => ({ result: "ok" }),
    });

    const clients = [];
    for (let i = 0; i < 8; i++) {
      clients.push(await connectBridge({ endpoint, key }));
    }
    expect(server.connectionCount()).toBe(8);

    // Fill the separate handshake slots with silent sockets, then the 9th unauthenticated one is over the limit.
    const silent: net.Socket[] = [];
    for (let i = 0; i < 8; i++) {
      const sk = net.connect(endpoint);
      sk.on("error", () => {});
      silent.push(sk);
    }
    await new Promise((r) => setTimeout(r, 100));
    const hostileSocket = net.connect(endpoint);
    hostileSocket.on("error", () => {});
    expect(server.connectionCount()).toBe(8);

    // The hostile peer reads nothing for 1.2 s (a non-reading client never sees "close" locally); then it resumes
    // and must find the connection already closed by the server.
    await new Promise((r) => setTimeout(r, 1200));
    const closedAfterResume = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      hostileSocket.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      hostileSocket.resume();
    });

    expect(closedAfterResume).toBe(true);
    expect(hostileSocket.destroyed).toBe(true);
    expect(server.connectionCount()).toBe(8);
    for (const sk of silent) sk.destroy();

    for (const c of clients) {
      await c.close();
    }
    await server.close();
  });

  it("handshakes have their own slots: 7 sessions plus 8 silent handshakes are all accepted", async () => {
    // Mutation caught: counting handshakes and sessions in one pool (the 9th connection overall would get busy).
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);
    const server = await startBridgeServer({
      endpoint,
      key,
      maxConnections: 8,
      maxHandshakes: 8,
      handshakeTimeoutMs: 5000,
      onRequest: async () => ({ result: "ok" }),
    });
    const clients: any[] = [];
    for (let i = 0; i < 7; i++) clients.push(await connectBridge({ endpoint, key }));
    const busySeen: boolean[] = [];
    const raws = Array.from({ length: 8 }, (_, i) => {
      const sk = net.connect(endpoint);
      sk.on("error", () => {});
      const dec = new FrameDecoder();
      busySeen[i] = false;
      sk.on("data", (chunk: Buffer) => {
        for (const f of dec.push(chunk)) if (f.header?.code === "busy") busySeen[i] = true;
      });
      return sk;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(busySeen.every((b) => b === false)).toBe(true);
    for (const c of clients) expect((await c.request("ping")).result).toBe("ok");
    for (const sk of raws) sk.destroy();
    for (const c of clients) await c.close();
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("attachSocketGuards prevents unhandled error throw, destroys socket and calls onError once", () => {
    // Mutation comment: Fails if socket error throws an unhandled exception or fails to destroy the socket.
    let errorCount = 0;
    let receivedError = null;

    const fakeSocket = new Duplex({
      read() {},
      write(chunk, enc, cb) { cb(); },
    });

    attachSocketGuards(fakeSocket, (err: any) => {
      errorCount++;
      receivedError = err;
    });

    expect(() => {
      fakeSocket.emit("error", new Error("transport_failure_1"));
      fakeSocket.emit("error", new Error("transport_failure_2"));
    }).not.toThrow();

    expect(fakeSocket.destroyed).toBe(true);
    expect(errorCount).toBe(1);
    expect((receivedError as Error | null)?.message).toBe("transport_failure_1");
  });

  it("abruptly destroying an authenticated client mid-request calls onSessionClosed once and leaves server serving next client", async () => {
    // Mutation comment: Fails if abrupt client socket destruction leaves server broken or calls onSessionClosed multiple times.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    let sessionClosedCount = 0;
    let closedSessionId = null;

    const server = await startBridgeServer({
      endpoint,
      key,
      onSessionClosed: (sid: any) => {
        sessionClosedCount++;
        closedSessionId = sid;
      },
      onRequest: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { result: "ok" };
      },
    });

    const client1Raw = net.connect(endpoint);
    const client1 = await connectBridge({ endpoint, key, connect: () => client1Raw });
    const sid1 = client1.sessionId;

    client1.request("slow").catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    client1Raw.destroy(new Error("abrupt_kill"));

    await new Promise((r) => setTimeout(r, 200));
    expect(sessionClosedCount).toBe(1);
    expect(closedSessionId).toBe(sid1);

    const client2 = await connectBridge({ endpoint, key });
    expect(server.connectionCount()).toBe(1);
    await client2.close();
    await server.close();
  });

  it("client.close with a request pending rejects the request with closed", async () => {
    // Mutation comment: Fails if client.close() leaves in-flight pending requests unrejected or hanging.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { result: "ok" };
      },
    });

    const client = await connectBridge({ endpoint, key });
    const pendingReq = client.request("test");

    await client.close();

    await expect(pendingReq).rejects.toThrow(expect.objectContaining({ code: "closed" }));
    await server.close();
  });

  it("server closing connection with a request pending rejects client request with closed", async () => {
    // Mutation comment: Fails if server disconnection does not reject pending client requests with closed.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { result: "ok" };
      },
    });

    const client = await connectBridge({ endpoint, key });
    const pendingReq = client.request("test");

    await server.close();

    await expect(pendingReq).rejects.toThrow(expect.objectContaining({ code: "closed" }));
    await client.close();
  });

  it("body exactly 2 MiB accepted and 2 MiB + 1 rejects with too_large and closes", async () => {
    // Mutation comment: Fails if request bodies over 2 MiB are accepted instead of rejected with too_large.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async (sess: any, header: any, body: any) => ({ result: body ? body.length : 0 }),
    });

    const client = await connectBridge({ endpoint, key });
    const twoMegs = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const res = await client.request("echo", {}, twoMegs);
    expect(res.result).toBe(2 * 1024 * 1024);

    const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 0x42);
    await expect(client.request("echo", {}, tooBig)).rejects.toThrow(
      expect.objectContaining({ code: "too_large" })
    );

    await client.close();
    await server.close();
  });

  it("malformed request id closes socket with bad_frame", async () => {
    // Mutation comment: Fails if non-integer or string id > 64 chars is accepted instead of bad_frame.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => ({ result: "ok" }),
    });

    const rawSocket = net.connect(endpoint);
    const client = await connectBridge({ endpoint, key, connect: () => rawSocket });

    rawSocket.write(encodeFrame({ t: "req", id: -5, method: "test" }));

    const errFrame = await new Promise((resolve) => {
      const decoder = new FrameDecoder();
      rawSocket.on("data", (chunk) => {
        try {
          const frames = decoder.push(chunk);
          for (const f of frames) {
            if (f.header?.t === "error") resolve(f.header);
          }
        } catch {}
      });
      rawSocket.once("close", () => resolve(null));
    });

    expect((errFrame as any)?.code).toBe("bad_frame");
    await client.close();
    await server.close();
  });

  it("duplicate in-flight id returns duplicate_id without closing connection", async () => {
    // Mutation comment: Fails if duplicate concurrent in-flight id does not respond with duplicate_id error.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    let resolveFirst: any;
    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => {
        await new Promise((r) => { resolveFirst = r; });
        return { result: "ok" };
      },
    });

    const rawSocket = net.connect(endpoint);
    const client = await connectBridge({ endpoint, key, connect: () => rawSocket });

    rawSocket.write(encodeFrame({ t: "req", id: 99, method: "slow" }));
    rawSocket.write(encodeFrame({ t: "req", id: 99, method: "slow" }));

    const responses: any[] = [];
    await new Promise<void>((resolve) => {
      const decoder = new FrameDecoder();
      rawSocket.on("data", (chunk) => {
        try {
          const frames = decoder.push(chunk);
          for (const f of frames) {
            if (f.header?.t === "res") {
              responses.push(f.header);
              if (responses.length === 1 && responses[0].error?.code === "duplicate_id") {
                if (resolveFirst) resolveFirst();
              }
              if (responses.length === 2) {
                resolve();
              }
            }
          }
        } catch {}
      });
    });

    expect(responses).toHaveLength(2);
    const dup = responses.find((r) => r.ok === false);
    expect(dup?.error?.code).toBe("duplicate_id");

    await client.close();
    await server.close();
  });

  it("handler BridgeError maps to code and plain Error maps to internal", async () => {
    // Mutation comment: Fails if handler errors leak unmapped error structures or fail to map plain Error to internal.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async (sess: any, header: any) => {
        if (header.method === "custom") {
          throw new BridgeError("not_found");
        }
        throw new Error("unexpected error");
      },
    });

    const client = await connectBridge({ endpoint, key });

    await expect(client.request("custom")).rejects.toThrow(
      expect.objectContaining({ code: "not_found" })
    );

    await expect(client.request("plain")).rejects.toThrow(
      expect.objectContaining({ code: "internal" })
    );

    await client.close();
    await server.close();
  });

  it("after 16 failing handlers, 16 new requests succeed", async () => {
    // Mutation comment: Fails if failing request handlers fail to decrement in-flight request accounting.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);

    let fail = true;
    const server = await startBridgeServer({
      endpoint,
      key,
      maxInFlight: 16,
      onRequest: async () => {
        if (fail) throw new Error("intentional_failure");
        return { result: "recovered_ok" };
      },
    });

    const client = await connectBridge({ endpoint, key });

    const failingPromises = Array.from({ length: 16 }, () =>
      client.request("test").catch((err: any) => err)
    );
    await Promise.all(failingPromises);

    fail = false;

    const successPromises = Array.from({ length: 16 }, () =>
      client.request("test")
    );
    const results = await Promise.all(successPromises);
    for (const r of results) {
      expect(r.result).toBe("recovered_ok");
    }

    await client.close();
    await server.close();
  });

  it("onAuthFailure receives auth_failed for wrong key, timeout for silent socket, and default logger rate-limits", async () => {
    // Mutation comment: Fails if onAuthFailure is not called with failure codes or logger fails to rate limit.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);

    const authFailures: any[] = [];
    const server = await startBridgeServer({
      endpoint,
      key,
      handshakeTimeoutMs: 150,
      onAuthFailure: (f: any) => authFailures.push(f),
      onRequest: async () => ({ result: "ok" }),
    });

    await expect(
      connectBridge({ endpoint, key: wrongKey, handshakeTimeoutMs: 150 })
    ).rejects.toThrow();

    // A raw client answering the challenge with a bogus proof.
    const raw = net.connect(endpoint);
    raw.on("error", () => {});
    const rawDecoder = new FrameDecoder();
    const rawFrames: any[] = [];
    raw.on("data", (chunk: Buffer) => {
      for (const f of rawDecoder.push(chunk)) rawFrames.push(f.header);
    });
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
    raw.write(encodeFrame({ t: "hello", v: 1, clientNonce: crypto.randomBytes(32).toString("base64") }));
    for (let i = 0; i < 100 && rawFrames.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    raw.write(encodeFrame({ t: "proof", clientProof: crypto.randomBytes(32).toString("base64") }));
    for (let i = 0; i < 100 && rawFrames.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
    raw.destroy();

    const silentSocket = net.connect(endpoint);
    await new Promise((r) => setTimeout(r, 250));
    silentSocket.destroy();

    expect(authFailures).toEqual(
      expect.arrayContaining([
        { code: "auth_failed" },
        { code: "timeout" },
      ])
    );

    await server.close();

    const warnings: any[] = [];
    let currentTime = 1000000;
    const logger = createAuthFailureLogger({
      log: (msg: any) => warnings.push(msg),
      now: () => currentTime,
    });

    for (let i = 0; i < 15; i++) {
      logger({ code: "auth_failed" });
    }

    expect(warnings).toHaveLength(10);

    currentTime += 60000;
    logger({ code: "timeout" });

    expect(warnings).toHaveLength(12);
    expect(warnings[10]).toMatch(/5 more failures suppressed/);
  });

  it("server-side socket errors after authentication do not crash and close the session once", async () => {
    // Mutation caught: the connection handler not attaching its persistent error guard.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);
    const serverSockets: net.Socket[] = [];
    let closed = 0;
    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async () => ({ result: "ok" }),
      onSessionClosed: () => { closed++; },
      createServer: () => {
        const srv = net.createServer();
        srv.on("connection", (sk: net.Socket) => serverSockets.push(sk));
        return srv;
      },
    });
    const client = await connectBridge({ endpoint, key });
    expect((await client.request("ping")).result).toBe("ok");
    const sk = serverSockets[serverSockets.length - 1]!;
    expect(() => sk.emit("error", Object.assign(new Error("boom"), { code: "ECONNRESET" }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(1);
    const client2 = await connectBridge({ endpoint, key });
    expect((await client2.request("ping")).result).toBe("ok");
    await client2.close();
    await client.close().catch(() => {});
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("a rejected socket whose busy write never flushes is destroyed after 1 s", async () => {
    // Mutation caught: no timer fallback for rejected sockets.
    const testDir = await makeTestDir();
    const endpoint = makeEndpoint(testDir);
    const key = crypto.randomBytes(32);
    const serverSockets: net.Socket[] = [];
    const server = await startBridgeServer({
      endpoint,
      key,
      maxConnections: 1,
      maxHandshakes: 1,
      onRequest: async () => ({ result: "ok" }),
      createServer: () => {
        const srv = net.createServer();
        srv.on("connection", (sk: net.Socket) => {
          serverSockets.push(sk);
          // Writes on the 2nd connection never complete, as with a peer that stops reading.
          if (serverSockets.length === 2) (sk as any).write = () => true;
        });
        return srv;
      },
    });
    const first = await connectBridge({ endpoint, key });
    const second = net.connect(endpoint);
    second.on("error", () => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(serverSockets[1]?.destroyed).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(serverSockets[1]?.destroyed).toBe(true);
    second.destroy();
    await first.close();
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("Windows host: ensureBridgeDir creates bridge dir with real icacls listing exactly one owner entry (OI)(CI)(F) and no (I)", async () => {
    // Mutation: if ensureBridgeDir granted bare username or inherited ACLs on Windows, real icacls output would have (I) or multiple entries.
    if (process.platform !== "win32") {
      return;
    }

    const { execFile: cpExecFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(cpExecFile);

    const tmpUserData = await makeTestDir();
    const bridgeDir = await ensureBridgeDir(tmpUserData, { platform: "win32" });

    expect(bridgeDir).toBe(path.join(tmpUserData, "bridge"));

    const { stdout } = await execFileAsync("icacls", [bridgeDir]);
    const entries = parseIcaclsEntries(stdout, bridgeDir);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.inherited).toBe(false);
    expect(entry.rights).toBe("(OI)(CI)(F)");

    const acct = await currentWindowsAccount();
    const expectedSid = acct.sid.toLowerCase();
    const expectedName = acct.name.toLowerCase();
    const principal = entry.principal.toLowerCase();

    const cleanSid = expectedSid.startsWith("*") ? expectedSid.slice(1) : expectedSid;
    const cleanPrincipal = principal.startsWith("*") ? principal.slice(1) : principal;

    const matches =
      principal === expectedName ||
      cleanPrincipal === cleanSid;
    expect(matches).toBe(true);
  });

  it("ensureBridgeDir rejects with bad_dir when icacls listing has an extra inherited entry", async () => {
    // Mutation: if verifyWindowsAcl did not check entries.length === 1 or entry.inherited, an extra inherited entry would not throw bad_dir.
    const tmpUserData = await makeTestDir();
    const bridgeDir = path.join(tmpUserData, "bridge");
    await fs.mkdir(bridgeDir, { recursive: true });

    const mockExecFile = vi.fn((file, args, cb) => {
      const stdout = [
        `${bridgeDir} DESKTOP\\alice:(OI)(CI)(F)`,
        `${bridgeDir} NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)`,
      ].join("\r\n");
      cb(null, stdout, "");
    });

    await expect(
      ensureBridgeDir(tmpUserData, {
        platform: "win32",
        execFile: mockExecFile,
        accountName: "DESKTOP\\alice",
        userSid: "S-1-5-21-1-2-3-1001",
      })
    ).rejects.toMatchObject({ code: "bad_dir" });
  });

  it("ensureBridgeDir rejects with bad_dir when icacls listing has OTHERDOMAIN\\<same short name>:(OI)(CI)(F)", async () => {
    // Mutation: if verifyWindowsAcl compared only short username suffix, OTHERDOMAIN\\alice would be accepted instead of throwing bad_dir.
    const tmpUserData = await makeTestDir();
    const bridgeDir = path.join(tmpUserData, "bridge");
    await fs.mkdir(bridgeDir, { recursive: true });

    const mockExecFile = vi.fn((file: any, args: any, cb: any) => {
      if (file === "whoami") return cb(null, '"desktop\\alice","S-1-5-21-1-2-3-1001"\r\n', "");
      const stdout = `${bridgeDir} OTHERDOMAIN\\alice:(OI)(CI)(F)\r\n`;
      cb(null, stdout, "");
    });

    await expect(
      ensureBridgeDir(tmpUserData, {
        platform: "win32",
        execFile: mockExecFile,
        username: "alice",
        accountName: "alice",
      })
    ).rejects.toMatchObject({ code: "bad_dir" });
  });

  it("readBridgeKey rejects OTHERDOMAIN\\alice:(F) with bad_key_perms and accepts *<SID>:(F)", async () => {
    // Mutation: if verifyWindowsAcl accepted different domain with same short name, OTHERDOMAIN\\alice would succeed instead of bad_key_perms.
    const tmpDir = await makeTestDir();
    const keyPath = path.join(tmpDir, "key");
    const secret = crypto.randomBytes(32);
    await fs.writeFile(keyPath, secret);

    const mockExecOtherDomain = vi.fn((file: any, args: any, cb: any) => {
      if (file === "whoami") return cb(null, '"desktop\\alice","S-1-5-21-1-2-3-1001"\r\n', "");
      cb(null, `${keyPath} OTHERDOMAIN\\alice:(F)\r\n`, "");
    });

    await expect(
      readBridgeKey(tmpDir, {
        platform: "win32",
        execFile: mockExecOtherDomain,
        username: "alice",
        accountName: "alice",
      })
    ).rejects.toMatchObject({ code: "bad_key_perms" });

    const mockExecSid = vi.fn((file, args, cb) => {
      cb(null, `${keyPath} *S-1-5-21-1-2-3-1001:(F)\r\n`, "");
    });

    const key = await readBridgeKey(tmpDir, {
      platform: "win32",
      execFile: mockExecSid,
      accountName: "DESKTOP\\alice",
      userSid: "S-1-5-21-1-2-3-1001",
    });

    expect(key).toEqual(secret);
  });

  it("startBridgeServer rejects endpoint_not_ours when socket inode changes before unlink", async () => {
    // Mutation: if the second lstat check was omitted or didn't check st2.ino !== st.ino, unlink would be called and no endpoint_not_ours would be thrown.
    const { EventEmitter } = await import("node:events");
    const testDir = await makeTestDir();
    const endpoint = path.join(testDir, "test.sock");

    const currentUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const getuidSpy =
      typeof process.getuid === "function"
        ? vi.spyOn(process, "getuid").mockReturnValue(currentUid)
        : null;

    let lstatCount = 0;
    const mockLstat = vi.fn(async () => {
      lstatCount++;
      return {
        isSocket: () => true,
        uid: currentUid,
        dev: 1n,
        ino: lstatCount === 1 ? 1n : 2n,
        mode: 0o140755,
      };
    });

    const mockUnlink = vi.fn(async () => {});

    const mockConnect = vi.fn(() => {
      const s: any = new EventEmitter();
      s.destroy = vi.fn();
      queueMicrotask(() => {
        const err: any = new Error("connect ECONNREFUSED");
        err.code = "ECONNREFUSED";
        s.emit("error", err);
      });
      return s;
    });

    try {
      await expect(
        startBridgeServer({
          endpoint,
          platform: "linux",
          fs: {
            lstat: mockLstat,
            unlink: mockUnlink,
          },
          connect: mockConnect,
          bridgeKey: crypto.randomBytes(32),
        })
      ).rejects.toMatchObject({ code: "endpoint_not_ours" });

      expect(mockLstat).toHaveBeenCalledTimes(2);
      expect(mockUnlink).not.toHaveBeenCalled();
    } finally {
      getuidSpy?.mockRestore();
    }
  });

  it("a bare short name never identifies the account, even when passed as an option", async () => {
    // Mutation caught: promoting `username` / a short `accountName` to the expected identity.
    const tmpDir = await makeTestDir();
    const keyPath = path.join(tmpDir, "key");
    await fs.writeFile(keyPath, crypto.randomBytes(32));
    const exec = vi.fn((file: any, args: any, cb: any) => {
      if (file === "whoami") return cb(null, '"desktop\\alice","S-1-5-21-1-2-3-1001"\r\n', "");
      cb(null, `${keyPath} alice:(F)\r\n`, "");
    });
    await expect(readBridgeKey(tmpDir, { platform: "win32", execFile: exec, username: "alice" })).rejects.toMatchObject({ code: "bad_key_perms" });
    await expect(readBridgeKey(tmpDir, { platform: "win32", execFile: exec, accountName: "alice" })).rejects.toMatchObject({ code: "bad_key_perms" });
  });

  it("Windows security tools run from System32, not from PATH", () => {
    // Mutation caught: resolving icacls / whoami / powershell through PATH.
    const env = { SystemRoot: "C:\\Windows", PATH: "C:\\evil" };
    expect(resolveTool("icacls", "win32", env)).toBe(path.join("C:\\Windows", "System32", "icacls.exe"));
    expect(resolveTool("whoami", "win32", env)).toBe(path.join("C:\\Windows", "System32", "whoami.exe"));
    expect(resolveTool("whoami", "linux", env)).toBe("whoami");
    expect(powershellPath(env)).toBe(path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  });
});
