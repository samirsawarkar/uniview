import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { createAppAgents, createAskDialog, createUiManager, detectEarlyArgv, createMcpClock, serveAgentFile, readAgentHandle } from "../../electron/lib/app-agents.mjs";
// @ts-expect-error plain ESM module without types
import { AgentGrantStore } from "../../electron/lib/agent-paths.mjs";
// @ts-expect-error plain ESM module without types
import { MCP_LIMITS } from "../../electron/lib/mcp-server.mjs";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {}
  }
});

describe("Packet P17c: app-agents wiring factory", () => {
  it("ask dialog mapping: 3 buttons, defaultId=2 (Don't allow), cancelId=2, name sanitised, abort signal closes dialog", async () => {
    // Mutation: defaultId pointing to Allow, un-sanitised name, or ignoring AbortSignal
    const dialogCalls: any[] = [];
    let resolveMessageBox: (v: any) => void = () => {};

    const fakeDialog = {
      showMessageBox: vi.fn(async (_win: any, opts?: any) => {
        const actualOpts = opts || _win;
        dialogCalls.push(actualOpts);
        return new Promise((resolve) => {
          resolveMessageBox = resolve;
        });
      }),
    };

    const fakeWin = { isDestroyed: () => false };
    const ask = createAskDialog({ dialog: fakeDialog, getWindow: () => fakeWin });

    // Test 1: name sanitisation & dialog options
    const bidiEvilName = "\u202Eevil-agent\u202C\x00\x1F\t" + "a".repeat(100);
    const controller1 = new AbortController();
    const p1 = ask({
      sessionId: "sess-1",
      client: { name: bidiEvilName, version: "1.0" },
      signal: controller1.signal,
    });

    expect(dialogCalls).toHaveLength(1);
    const opts1 = dialogCalls[0];
    expect(opts1.buttons).toEqual(["Allow for this session", "Always allow", "Don't allow"]);
    expect(opts1.defaultId).toBe(2);
    expect(opts1.cancelId).toBe(2);
    // Name must be cleaned of control/bidi characters and capped to 80 chars
    expect(opts1.message).toContain("‹evil-agent");
    expect(opts1.message).not.toContain("\u202E");
    expect(opts1.message).not.toContain("\x00");
    expect(opts1.message).toMatch(/^An agent that says it is ‹.+› wants to show files and ask for reviews in UniView$/);

    // Answer with index 0 -> allow_session
    resolveMessageBox({ response: 0 });
    expect(await p1).toBe("allow_session");

    // Test 2: index 1 -> allow_always
    const controller2 = new AbortController();
    const p2 = ask({
      sessionId: "sess-2",
      client: { name: "good-agent", version: "1.0" },
      signal: controller2.signal,
    });
    resolveMessageBox({ response: 1 });
    expect(await p2).toBe("allow_always");

    // Test 3: index 2 -> deny
    const controller3 = new AbortController();
    const p3 = ask({
      sessionId: "sess-3",
      client: { name: "good-agent", version: "1.0" },
      signal: controller3.signal,
    });
    resolveMessageBox({ response: 2 });
    expect(await p3).toBe("deny");

    // Test 4: abort signal closes/denies dialog
    const controller4 = new AbortController();
    const p4 = ask({
      sessionId: "sess-4",
      client: { name: "slow-agent", version: "1.0" },
      signal: controller4.signal,
    });
    controller4.abort();
    expect(await p4).toBe("deny");
  });

  it("single-instance ordering: no key creation before the lock succeeds", async () => {
    // Mutation: creating bridge key/dir before app.requestSingleInstanceLock()
    const tempDir = await makeTempDir("uv-single-instance");
    let lockHeld = false;
    let checkedLockFirst = false;

    const fakeApp = {
      requestSingleInstanceLock: vi.fn(() => {
        checkedLockFirst = true;
        return lockHeld;
      }),
      on: vi.fn(),
      setPath: vi.fn(),
    };

    const keyPath = path.join(tempDir, "bridge", "key");

    // Case 1: lock fails -> start returns false, NO key created
    lockHeld = false;
    const agentsApp1 = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      fromApp: () => true,
      getWindow: () => null,
      userDataDir: tempDir,
    });

    const res1 = await agentsApp1.start();
    expect(checkedLockFirst).toBe(true);
    expect(res1.ok).toBe(false);
    await expect(fs.stat(keyPath)).rejects.toThrow();

    // Case 2: lock succeeds -> key is created only after lock
    lockHeld = true;
    const agentsApp2 = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      fromApp: () => true,
      getWindow: () => null,
      userDataDir: tempDir,
    });

    cleanups.push(() => agentsApp2.stop());
    const res2 = await agentsApp2.start();
    expect(res2.ok).toBe(true);
    const keyStat = await fs.stat(keyPath);
    expect(keyStat.isFile()).toBe(true);
  });

  it("tab-queue bound 32/33: queues 32 requests while renderer not ready, 33rd is busy", async () => {
    // Mutation: unbounded queue, or queue cap off-by-one (e.g. 31 or 33)
    const openedTabs: any[] = [];
    const uiManager = createUiManager({
      getWindow: () => null,
      openRendererTab: async (item: any) => {
        openedTabs.push(item);
      },
    });

    expect(uiManager.isReady()).toBe(false);

    // Queue 32 requests successfully
    for (let i = 0; i < 32; i++) {
      await expect(
        uiManager.ui.openFile({
          scopeId: `scope-${i}`,
          token: `token-${i}`,
          name: `file-${i}.txt`,
          canonical: `/path/to/file-${i}.txt`,
          size: 100,
        })
      ).resolves.toBeUndefined();
    }
    expect(uiManager.queueLength()).toBe(32);
    expect(openedTabs).toHaveLength(0);

    // 33rd request must reject with busy
    await expect(
      uiManager.ui.openFile({
        scopeId: "scope-32",
        token: "token-32",
        name: "file-32.txt",
        canonical: "/path/to/file-32.txt",
        size: 100,
      })
    ).rejects.toMatchObject({ code: "busy" });

    // When renderer becomes ready, the 32 queued items are dispatched
    await uiManager.setReady();
    expect(uiManager.isReady()).toBe(true);
    expect(openedTabs).toHaveLength(32);
    expect(uiManager.queueLength()).toBe(0);

    // Subsequent requests dispatch immediately without queuing
    await uiManager.ui.openFile({
      scopeId: "scope-after",
      token: "token-after",
      name: "file-after.txt",
      canonical: "/path/to/file-after.txt",
      size: 100,
    });
    expect(openedTabs).toHaveLength(33);
  });

  it("closeSession destroys the bridge socket of a session", async () => {
    // Mutation: closeSession being a no-op or not destroying the underlying socket
    const tempDir = await makeTempDir("uv-closesession");
    const fakeApp = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      setPath: vi.fn(),
    };

    const agents = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      fromApp: () => true,
      getWindow: () => null,
      userDataDir: tempDir,
    });

    const fakeSocket = {
      destroyed: false,
      destroy: vi.fn(function (this: any) {
        this.destroyed = true;
      }),
      once: vi.fn(),
      on: vi.fn(),
    };

    const sessId = "a".repeat(32);
    agents.trackSessionSocket(sessId, fakeSocket);

    agents.closeSession(sessId);
    expect(fakeSocket.destroy).toHaveBeenCalledTimes(1);
    expect(fakeSocket.destroyed).toBe(true);
  });

  it("CLI/MCP early-argv paths never create a window", async () => {
    // Mutation: missing early check in argv parser or proceeding to window creation
    expect(detectEarlyArgv(["UniView.exe", "--mcp"], true)).toEqual({
      isMcp: true,
      isCli: false,
      cliArgv: [],
    });

    expect(detectEarlyArgv(["electron.exe", "main.mjs", "open", "file.txt"], false)).toEqual({
      isMcp: false,
      isCli: true,
      cliArgv: ["open", "file.txt"],
    });

    expect(detectEarlyArgv(["electron.exe", "main.mjs", "normal-arg"], false)).toEqual({
      isMcp: false,
      isCli: false,
      cliArgv: [],
    });
  });

  it("approval grace: raises MCP server 30 s deadline to 125 s on first request", () => {
    // Mutation: leaving 30 s deadline for approval dialog, causing timeout during approval
    const armedTimeouts: number[] = [];
    const fakeClock = {
      now: vi.fn(() => 1000),
      setTimeout: vi.fn((_fn: any, ms: number) => {
        armedTimeouts.push(ms);
        return 42;
      }),
      clearTimeout: vi.fn(),
    };

    const mcpClock = createMcpClock({ approvalGraceMs: 125_000, clock: fakeClock });

    // First request: standard 30s deadline (REQUEST_DEADLINE_MS) is raised to 125s
    mcpClock.setTimeout(() => {}, MCP_LIMITS.REQUEST_DEADLINE_MS);
    expect(armedTimeouts[0]).toBe(125_000);

    // Subsequent requests keep normal 30s deadline
    mcpClock.setTimeout(() => {}, MCP_LIMITS.REQUEST_DEADLINE_MS);
    expect(armedTimeouts[1]).toBe(MCP_LIMITS.REQUEST_DEADLINE_MS);

    // Other timers (e.g. 5000 ms) are unaffected
    mcpClock.setTimeout(() => {}, 5000);
    expect(armedTimeouts[2]).toBe(5000);
  });

  it("every read goes through the handle opened and checked by path policy (swap after grant reads original file)", async () => {
    // Mutation: reopening path by filename instead of reading via grant handle
    const tempDir = await makeTempDir("uv-swap-test");
    const filePath = path.join(tempDir, "original.txt");
    await fs.writeFile(filePath, "ORIGINAL_CONTENT");

    // Open path and create an agent grant holding the open file handle
    const fileHandle = await fs.open(filePath, "r");
    cleanups.push(() => fileHandle.close());

    const grantStore = new AgentGrantStore();
    const scopeId = grantStore.openScope();
    const token = grantStore.grant(scopeId, {
      handle: fileHandle,
      canonical: filePath,
      size: Buffer.byteLength("ORIGINAL_CONTENT"),
    });

    const grantEntry = grantStore.get(token, scopeId);
    expect(grantEntry).toBeDefined();

    // Now simulate a SWAP of the file on disk (rename original, write new file at same path)
    const renamedPath = path.join(tempDir, "renamed_original.txt");
    await fs.rename(filePath, renamedPath);
    await fs.writeFile(filePath, "SWAPPED_MALICIOUS_CONTENT");

    // 1. Test readAgentHandle (used by uniview:read IPC)
    const readBuf = await readAgentHandle(grantEntry, 0, grantEntry.size);
    const readText = Buffer.from(readBuf).toString("utf8");
    expect(readText).toBe("ORIGINAL_CONTENT");
    expect(readText).not.toBe("SWAPPED_MALICIOUS_CONTENT");

    // 2. Test serveAgentFile (used by uniview-file: protocol)
    const fakeRequest = new Request(`uniview-file://${token}/original.txt`);
    const response = await serveAgentFile(grantEntry, fakeRequest);
    expect(response.status).toBe(200);
    const streamText = await response.text();
    expect(streamText).toBe("ORIGINAL_CONTENT");
    expect(streamText).not.toBe("SWAPPED_MALICIOUS_CONTENT");

    // Cleanup scope
    await grantStore.closeScope(scopeId);
  });
});
