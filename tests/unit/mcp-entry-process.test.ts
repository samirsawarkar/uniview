import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
// @ts-expect-error plain ESM module without types
import { ensureBridgeDir, ensureBridgeKey, ensureInstallId, windowsUserSid, bridgeEndpoint } from "../../electron/lib/bridge-key.mjs";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { BridgeError } from "../../electron/lib/bridge-proto.mjs";
import { tmpBase } from "./helpers/tmp-base";

const entryRunner = path.resolve(__dirname, "../../electron/mcp-entry.mjs");
const KILL_AFTER_MS = 25000;

async function makeDir(): Promise<string> {
  const base = tmpBase();
  const dir = path.join(base, `uv-mcp-proc-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {}
  }
});

async function startBridgeStub() {
  const work = await makeDir();
  const userData = path.join(work, "userData");
  await fs.mkdir(userData);
  const bridgeDir = await ensureBridgeDir(userData);
  const key = await ensureBridgeKey(bridgeDir);
  const installId = await ensureInstallId(bridgeDir);
  const endpoint =
    process.platform === "win32"
      ? bridgeEndpoint({ bridgeDir, userSid: await windowsUserSid(), installId })
      : bridgeEndpoint({ bridgeDir });

  const requests: Array<{ method: string; params: any }> = [];

  const server = await startBridgeServer({
    endpoint,
    key,
    onRequest: async (_session: unknown, header: any) => {
      requests.push({ method: header.method, params: header.params });
      if (header.method === "mcp.hello") {
        return { result: { version: "2025-06-18" } };
      }
      if (header.method === "open") {
        return { result: { opened: 1 } };
      }
      throw new BridgeError("unknown_method");
    },
  });

  cleanups.push(async () => {
    await server.close();
    await fs.rm(work, { recursive: true, force: true });
  });

  return { work, userData, requests, server };
}

function spawnMcpProcess(opts: { cwd: string; userData: string }) {
  const child = spawn(process.execPath, [entryRunner], {
    cwd: opts.cwd,
    env: { ...process.env, UNIVIEW_USER_DATA: opts.userData },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let buffer = "";
  const listeners: ((line: string) => void)[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        const nextListener = listeners.shift();
        if (nextListener) nextListener(line);
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const killer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);

  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stderr });
    });
  });

  const nextJson = (timeoutMs = 15000): Promise<any> => {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for line from child (stderr: ${stderr})`)), timeoutMs);
      listeners.push((line: string) => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      });
    });
  };

  const send = (obj: any) => {
    child.stdin.write(JSON.stringify(obj) + "\n");
  };

  return { child, nextJson, send, exited };
}

describe("mcp-entry process (real Node process against stub bridge and unreachable bridge)", () => {
  it("initialize + tools/list and tool call over real stdin/stdout with real bridge stub", async () => {
    const stub = await startBridgeStub();
    const proc = spawnMcpProcess({ cwd: stub.work, userData: stub.userData });

    // 1. Send initialize
    proc.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    });

    const initResp = await proc.nextJson(10000);
    expect(initResp.id).toBe(1);
    expect(initResp.result?.protocolVersion).toBe("2025-06-18");
    expect(initResp.result?.serverInfo?.name).toBe("UniView");

    // 2. Send notifications/initialized
    proc.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // 3. Send tools/list
    proc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const listResp = await proc.nextJson(10000);
    expect(listResp.id).toBe(2);
    expect(Array.isArray(listResp.result?.tools)).toBe(true);
    const toolNames = listResp.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("open_files");
    expect(toolNames).toContain("show_view");
    expect(toolNames).toContain("request_review");
    expect(toolNames).toContain("get_review");

    // 4. Send open_files tool call
    proc.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "open_files",
        arguments: { paths: [path.join(stub.work, "test.txt")] },
      },
    });

    const callResp = await proc.nextJson(10000);
    expect(callResp.id).toBe(3);
    expect(callResp.result?.isError).toBeUndefined();
    expect(callResp.result?.structuredContent).toEqual({ opened: 1 });

    // Verify bridge stub received requests
    expect(stub.requests.map((r) => r.method)).toContain("mcp.hello");
    expect(stub.requests.map((r) => r.method)).toContain("open");

    // End stdin and assert clean exit
    proc.child.stdin.end();
    const exitRes = await proc.exited;
    expect(exitRes.code).toBe(0);
  }, 30000);

  it("unreachable bridge (no app, no launcher in tests) answers tool call with app_unavailable within budget", async () => {
    const work = await makeDir();
    const userData = path.join(work, "userData-empty");
    await fs.mkdir(userData);
    cleanups.push(async () => {
      await fs.rm(work, { recursive: true, force: true });
    });

    const t0 = Date.now();
    const proc = spawnMcpProcess({ cwd: work, userData });

    // 1. Initialize succeeds without bridge connection
    proc.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    });

    const initResp = await proc.nextJson(5000);
    expect(initResp.id).toBe(1);

    proc.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // 2. Call tool requiring bridge connection
    proc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "open_files",
        arguments: { paths: ["C:\\test\\doc.txt"] },
      },
    });

    // Expect app_unavailable within the 15s connect deadline budget
    const callResp = await proc.nextJson(20000);
    const elapsed = Date.now() - t0;

    expect(callResp.id).toBe(2);
    expect(callResp.result?.isError).toBe(true);
    expect(callResp.result?.structuredContent?.code).toBe("app_unavailable");
    expect(elapsed).toBeLessThan(KILL_AFTER_MS);

    // End stdin and exit cleanly
    proc.child.stdin.end();
    const exitRes = await proc.exited;
    expect(exitRes.code).toBe(0);
  }, 30000);
});
