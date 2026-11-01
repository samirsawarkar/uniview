import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { makeTempDir } from "./agent-helpers";
import { receiptJson } from "./agent-host-helpers";
// @ts-expect-error plain ESM module without types
import { createAppAgents, createAskDialog, createUiManager, detectEarlyArgv, createMcpClock, serveAgentFile, readAgentHandle, computeAppSpawnArgs, runEarlyCli, runEarlyMcp, buildEarlyLaunchOptions } from "../../electron/lib/app-agents.mjs";
// @ts-expect-error plain ESM module without types
import { AgentGrantStore } from "../../electron/lib/agent-paths.mjs";
// @ts-expect-error plain ESM module without types
import { GrantStore } from "../../electron/lib/core.mjs";
// @ts-expect-error plain ESM module without types
import { installShutdownDismiss } from "../../electron/lib/review-ipc.mjs";
// @ts-expect-error plain ESM module without types
import { MCP_LIMITS } from "../../electron/lib/mcp-server.mjs";
import { toSource } from "../../src/shells/electron";

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

  it("postMessage and sessionState reach every live window, held until the renderer is ready", async () => {
    const sent: any[] = [];
    const win = (id: string) => ({
      id,
      isDestroyed: () => false,
      webContents: { send: (channel: string, params: any) => sent.push({ id, channel, params }) },
    });
    const a = win("a");
    const b = win("b");
    const uiManager = createUiManager({
      getWindow: () => a,
      getWindows: () => [a, b],
      openRendererTab: async () => {},
    });

    await uiManager.ui.postMessage({ sessionId: "s1", text: "hi" });
    await uiManager.ui.sessionState({ sessionId: "s1", state: "working" });
    expect(sent).toHaveLength(0);
    expect(uiManager.queueLength()).toBe(2);

    await uiManager.setReady();
    expect(sent).toEqual([
      { id: "a", channel: "agent:message", params: { sessionId: "s1", text: "hi" } },
      { id: "b", channel: "agent:message", params: { sessionId: "s1", text: "hi" } },
      { id: "a", channel: "agent:session-state", params: { sessionId: "s1", state: "working" } },
      { id: "b", channel: "agent:session-state", params: { sessionId: "s1", state: "working" } },
    ]);
  });

  it("postMessage falls back to getWindow when getWindows is absent", async () => {
    const sent: any[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (channel: string, params: any) => sent.push({ channel, params }) } };
    const uiManager = createUiManager({ getWindow: () => win, openRendererTab: async () => {} });
    await uiManager.setReady();
    await uiManager.ui.postMessage({ sessionId: "s1", text: "hi" });
    expect(sent).toEqual([{ channel: "agent:message", params: { sessionId: "s1", text: "hi" } }]);
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

  it("production wiring: AgentGrantStore is used for agent scopes, user GrantStore for user files, reader chooses by grant type", async () => {
    // Mutation: injecting ordinary GrantStore into agent host or confusing agent/user grant tokens
    const tempDir = await makeTempDir("uv-wiring-test");
    const fakeApp = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      setPath: vi.fn(),
      getPath: vi.fn(() => tempDir),
    };
    const userGrants = new GrantStore();
    const agents = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      fromApp: () => true,
      getWindow: () => null,
      userDataDir: tempDir,
      userGrants,
    });
    cleanups.push(() => agents.stop());
    const res = await agents.start();
    expect(res.ok).toBe(true);

    // Host grants must be an AgentGrantStore with scope methods
    expect(agents.host.grants).toBeInstanceOf(AgentGrantStore);
    expect(typeof agents.host.grants.openScope).toBe("function");
    expect(typeof agents.host.grants.closeScope).toBe("function");
    expect(typeof agents.host.grants.closeAll).toBe("function");

    // An agent grant carries a handle
    const scopeId = agents.host.grants.openScope();
    const filePath = path.join(tempDir, "agent-test.txt");
    await fs.writeFile(filePath, "AGENT_HANDLE_DATA");
    const handle = await fs.open(filePath, "r");
    cleanups.push(() => handle.close());

    const agentToken = agents.host.grants.grant(scopeId, {
      handle,
      canonical: filePath,
      size: 17,
    });
    const agentEntry = agents.getGrant(agentToken, scopeId);
    expect(agentEntry).toBeDefined();
    expect(agentEntry.handle).toBe(handle);

    // User grant carries path/size, NOT handle
    const userFilePath = path.join(tempDir, "user-test.txt");
    await fs.writeFile(userFilePath, "USER_DATA");
    const userToken = userGrants.grant(userFilePath, 9);
    const userEntry = userGrants.get(userToken);
    expect(userEntry).toBeDefined();
    expect(userEntry.handle).toBeUndefined();

    // User token can never be resolved as an agent grant
    expect(agents.getGrant(userToken, scopeId)).toBeUndefined();
    // Agent token is never present in user grants
    expect(userGrants.get(agentToken)).toBeUndefined();
  });

  it("local review token resolution accepts tokens from user GrantStore unchanged", async () => {
    // Mutation: local review resolver only checking tokenScopeMap, returning not_granted for user-opened receipts
    const tempDir = await makeTempDir("uv-local-review");
    const fakeApp = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      setPath: vi.fn(),
    };
    const userGrants = new GrantStore();
    const ipcHandlers: Record<string, Function> = {};
    const fakeIpcMain = {
      handle: vi.fn((channel, fn) => {
        ipcHandlers[channel] = fn;
      }),
      on: vi.fn(),
    };

    const targetFile = path.join(tempDir, "target.txt");
    await fs.writeFile(targetFile, "TARGET_DATA");
    const targetHash = crypto.createHash("sha256").update("TARGET_DATA").digest("hex");

    const receiptContent = receiptJson([{ path: targetFile, sha256: targetHash }], {
      agent: { name: "test-agent" },
    });
    const receiptPath = path.join(tempDir, "test.receipt.json");
    await fs.writeFile(receiptPath, receiptContent);

    // Open .receipt.json via user grant path
    const userToken = userGrants.grant(receiptPath, Buffer.byteLength(receiptContent));

    const agents = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: fakeIpcMain,
      fromApp: () => true,
      getWindow: () => null,
      userDataDir: tempDir,
      userGrants,
    });
    cleanups.push(() => agents.stop());
    await agents.start();

    // review:open with userToken must resolve the grant from userGrants and open the review
    const openHandler = ipcHandlers["review:open"];
    expect(openHandler).toBeDefined();
    const result = await openHandler!({ senderFrame: {} }, { receiptToken: userToken });
    expect(result.ok).toBe(true);
    expect(result.reviewId).toBeDefined();
  });

  it("toSource().reopen() for agent-scoped source calls reopenAgent and never openPath", async () => {
    // Mutation: toSource().reopen() unconditionally calling openPath(f.path) for agent-scoped sources
    const fakeApi = {
      openPath: vi.fn(async (p: string) => ({ token: "user-token", name: "user.txt", path: p, size: 10 })),
      reopenAgent: vi.fn(async (scopeId: string, token: string) => ({
        token,
        name: "agent.txt",
        path: "/agent.txt",
        size: 20,
        scopeId,
      })),
      readRange: vi.fn(async () => new ArrayBuffer(0)),
    };
    (globalThis as any).window = { uniview: fakeApi };

    // 1. Agent-scoped source
    const agentFile = { token: "tok-1", name: "agent.txt", path: "/agent.txt", size: 20, scopeId: "scope-1" };
    const agentSource = toSource(agentFile);
    expect(agentSource.reopen).toBeDefined();
    const reopenedAgent = await agentSource.reopen!();
    expect(fakeApi.reopenAgent).toHaveBeenCalledWith("scope-1", "tok-1");
    expect(fakeApi.openPath).not.toHaveBeenCalled();
    expect(reopenedAgent.name).toBe("agent.txt");

    // 2. User source without scopeId
    fakeApi.openPath.mockClear();
    fakeApi.reopenAgent.mockClear();
    const userFile = { token: "user-tok", name: "user.txt", path: "/user.txt", size: 10 };
    const userSource = toSource(userFile);
    await userSource.reopen!();
    expect(fakeApi.openPath).toHaveBeenCalledWith("/user.txt");
    expect(fakeApi.reopenAgent).not.toHaveBeenCalled();
  });

  it("shutdown dismissal: quit with undecided local and agent review records dismissed for both and quits after 3s even if dismissal hangs", async () => {
    // Mutation: will-quit only starting async stop() without awaiting dismissal, or hanging forever on stuck dismiss
    const tempDir = await makeTempDir("uv-shutdown-test");
    let beforeQuitHandler: ((event: any) => void) | null = null;
    let quitCount = 0;
    const fakeApp = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event, handler) => {
        if (event === "before-quit") beforeQuitHandler = handler;
      }),
      quit: vi.fn(() => {
        quitCount++;
      }),
      setPath: vi.fn(),
    };

    const userGrants = new GrantStore();
    const ipcHandlers: Record<string, Function> = {};
    const fakeIpcMain = {
      handle: vi.fn((channel, fn) => {
        ipcHandlers[channel] = fn;
      }),
      on: vi.fn(),
    };

    const agents = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: fakeIpcMain,
      fromApp: () => true,
      getWindow: () => null,
      userDataDir: tempDir,
      userGrants,
    });
    cleanups.push(() => agents.stop());
    await agents.start();

    expect(beforeQuitHandler).toBeDefined();

    // 1. Create an undecided local review
    const targetFile = path.join(tempDir, "local-target.txt");
    await fs.writeFile(targetFile, "LOCAL_TARGET");
    const hash = crypto.createHash("sha256").update("LOCAL_TARGET").digest("hex");
    const receiptContent = receiptJson([{ path: targetFile, sha256: hash }], {
      agent: { name: "local-agent" },
    });
    const receiptPath = path.join(tempDir, "local.receipt.json");
    await fs.writeFile(receiptPath, receiptContent);
    const localToken = userGrants.grant(receiptPath, Buffer.byteLength(receiptContent));
    const openRes = await ipcHandlers["review:open"]!({ senderFrame: {} }, { receiptToken: localToken });
    expect(openRes.ok).toBe(true);
    const localReviewId = openRes.reviewId;

    // 2. Create an undecided agent review
    const s = { sessionId: "a".repeat(32), clientNonce: Buffer.alloc(32), serverNonce: Buffer.alloc(32) };
    await agents.host.onRequest(s, { t: "req", id: 0, method: "cli.hello", params: { version: "1" } });
    const agentFile = path.join(tempDir, "agent-target.txt");
    await fs.writeFile(agentFile, "AGENT_TARGET");
    const agentHash = crypto.createHash("sha256").update("AGENT_TARGET").digest("hex");
    const agentReceipt = receiptJson([{ path: agentFile, sha256: agentHash }], {
      agent: { name: "cli-agent" },
    });
    const agentOpenRes = await agents.host.onRequest(s, { t: "req", id: 1, method: "review.open", params: { inline: true } }, Buffer.from(agentReceipt));
    const agentReviewId = agentOpenRes.result.reviewId;
    expect(agentReviewId).toBeDefined();

    // Both reviews are undecided
    expect(agents.reviewManager.hasUndecided()).toBe(true);

    // Trigger before-quit
    let defaultPrevented = false;
    const fakeEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    beforeQuitHandler!(fakeEvent);
    expect(defaultPrevented).toBe(true);

    // Wait for dismissal promises to settle and app.quit() to be called
    for (let i = 0; i < 50 && quitCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(quitCount).toBe(1);

    // Verify both reviews were persisted as dismissed
    const decisionFile = `${receiptPath}.decision.json`;
    const localDecisionRaw = await fs.readFile(decisionFile, "utf8");
    const localDecision = JSON.parse(localDecisionRaw);
    expect(localDecision.decision).toBe("dismissed");

    const agentReviewRecord = agents.host.getReview(agentReviewId);
    expect(agentReviewRecord?.decision?.decision).toBe("dismissed");

    // Test timeout: if dismissal hangs, it still quits after timeout (3s)
    let timeoutQuitCount = 0;
    const fakeAppTimeout = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      quit: vi.fn(() => {
        timeoutQuitCount++;
      }),
      setPath: vi.fn(),
    };
    const hangingManager = {
      hasUndecided: () => true,
      dismissAll: () => new Promise(() => {}), // never resolves
    };
    let timeoutBeforeQuitHandler: Function = () => {};
    fakeAppTimeout.on.mockImplementation((event: string, handler: Function) => {
      if (event === "before-quit") timeoutBeforeQuitHandler = handler;
    });

    installShutdownDismiss({
      app: fakeAppTimeout as any,
      manager: hangingManager as any,
      timeoutMs: 100, // fast timeout for test
    });

    let timeoutDefaultPrevented = false;
    timeoutBeforeQuitHandler({
      preventDefault: () => {
        timeoutDefaultPrevented = true;
      },
    });
    expect(timeoutDefaultPrevented).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(timeoutQuitCount).toBe(1);
  });

  it("computeAppSpawnArgs: packaged mode returns [], unpackaged mode returns [appPath]", () => {
    // Mutation: running process.execPath with [] in unpackaged mode
    expect(computeAppSpawnArgs({ isPackaged: true, appPath: "/path/to/app" })).toEqual([]);
    expect(computeAppSpawnArgs({ isPackaged: false, appPath: "/path/to/app" })).toEqual(["/path/to/app"]);
    expect(computeAppSpawnArgs({ isPackaged: false, appPath: "" })).toEqual([process.cwd()]);
  });

  it("Finding 4: production cold-start callers computed launch command (packaged: exe only without cwd arg; unpackaged: electron + absolute app path)", async () => {
    const packagedArgs = computeAppSpawnArgs({ isPackaged: true, appPath: "/Applications/UniView.app" });
    expect(packagedArgs).toEqual([]);

    const unpackagedArgs = computeAppSpawnArgs({ isPackaged: false, appPath: "/Users/dev/uniview" });
    expect(unpackagedArgs).toEqual(["/Users/dev/uniview"]);

    const fakeSpawnApp = vi.fn(async () => {});
    const tempDir = await makeTempDir("uv-coldstart-test");
    cleanups.push(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    const fakeAppPackaged = {
      isPackaged: true,
      getAppPath: () => "/Applications/UniView.app",
      getPath: () => tempDir,
    };

    let connectCount = 0;
    await runEarlyCli({
      argv: ["open", "file.txt"],
      ...buildEarlyLaunchOptions({ app: fakeAppPackaged as any }),
      connect: async () => {
        connectCount++;
        if (connectCount === 1) throw new Error("first connect failed");
        return {
          request: async () => ({ opened: 1 }),
          close: async () => {},
        };
      },
      spawnApp: fakeSpawnApp,
      sleep: (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          const t = setTimeout(resolve, 5);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        }),
    }).catch(() => {});

    expect(fakeSpawnApp).toHaveBeenCalled();
  });

  it("Finding 6: runEarlyMcp production deadlines are [30000, 125000, 30000] (hello 30000, first tools/call 125000, next 30000)", async () => {
    const tempDir = await makeTempDir("uv-mcp-clock-test");
    cleanups.push(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    const scheduledTimeouts: number[] = [];
    const mockClock = {
      now: () => 1000,
      setTimeout: (fn: Function, ms: number) => {
        scheduledTimeouts.push(ms);
        return setTimeout(fn, ms);
      },
      clearTimeout: (h: any) => clearTimeout(h),
    };

    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const fakeClient = {
      sessionId: "b".repeat(32),
      serverNonce: Buffer.alloc(32),
      clientNonce: Buffer.alloc(32),
      request: vi.fn(async (method: string) => {
        if (method === "mcp.hello") return { result: { version: "2024-11-05" } };
        return { result: { opened: 1 } };
      }),
      close: vi.fn(async () => {}),
    };

    const mcpPromise = runEarlyMcp({
      stdin,
      stdout,
      stderr: new PassThrough(),
      userDataDir: tempDir,
      connect: async () => fakeClient,
      clock: mockClock,
      approvalGraceMs: 125_000,
    });

    // 1. Send initialize
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "agent-1", version: "1.0" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // 2. Send initialized notification
    stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // 3. Send first tools/call (triggers getBridge 30000, then call with approvalGraceMs = 125000)
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_files", arguments: { paths: ["/a.txt"] } } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // 4. Send second tools/call (triggers call which uses REQUEST_DEADLINE_MS = 30000)
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "open_files", arguments: { paths: ["/b.txt"] } } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    stdin.end();
    await mcpPromise;

    expect(scheduledTimeouts).toEqual([30000, 125000, 30000]);
  });

  it("Finding 2: agent:view-grant IPC route validates args, enforces fromApp, resolves declared path via host.viewGrant, and refuses undeclared path or wrong scope", async () => {
    // Mutation: missing agent:view-grant IPC route, missing fromApp check, or allowing undeclared paths / wrong scopeId
    const tempDir = await makeTempDir("uv-view-grant-ipc");
    const fakeApp = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      setPath: vi.fn(),
      getPath: vi.fn(() => tempDir),
    };
    const ipcHandlers: Record<string, Function> = {};
    const fakeIpcMain = {
      handle: vi.fn((channel, fn) => {
        ipcHandlers[channel] = fn;
      }),
      on: vi.fn(),
    };

    let allowFromApp = true;
    const fromApp = vi.fn((_event: any) => allowFromApp);

    const targetFile = path.join(tempDir, "declared-file.txt");
    await fs.writeFile(targetFile, "DECLARED_FILE_CONTENT");

    const undeclaredFile = path.join(tempDir, "undeclared-file.txt");
    await fs.writeFile(undeclaredFile, "UNDECLARED_FILE_CONTENT");

    const fakeOpenAgentPath = vi.fn(async (p: string) => {
      if (p === targetFile) {
        const handle = await fs.open(targetFile, "r");
        cleanups.push(() => handle.close());
        const s = await fs.stat(targetFile);
        return { ok: true, handle, canonical: targetFile, size: s.size };
      }
      return { ok: false, code: "bad_path" };
    });

    const agents = createAppAgents({
      app: fakeApp,
      dialog: { showMessageBox: vi.fn() },
      ipcMain: fakeIpcMain,
      fromApp,
      getWindow: () => null,
      userDataDir: tempDir,
      openAgentPath: fakeOpenAgentPath,
    });
    cleanups.push(() => agents.stop());
    await agents.start();

    // Verify agent:view-grant handler is registered
    const viewGrantHandler = ipcHandlers["agent:view-grant"];
    expect(viewGrantHandler).toBeDefined();

    // Set up a review scope in host with declared file
    const client = { name: "test-agent", version: "1.0" };
    const sessRes = await agents.host.onRequest(
      { sessionId: "s".repeat(32) },
      {
        method: "cli.hello",
        params: { version: "1.0" },
      }
    );
    expect(sessRes.result).toBeDefined();

    // Write a receipt declaring targetFile
    const targetHash = crypto.createHash("sha256").update("DECLARED_FILE_CONTENT").digest("hex");
    const receiptContent = receiptJson([{ path: targetFile, sha256: targetHash }], {
      agent: { name: "test-agent" },
    });
    const receiptPath = path.join(tempDir, "audit.receipt.json");
    await fs.writeFile(receiptPath, receiptContent);

    // Open review via bridge request
    let capturedScopeId: string | undefined;
    const origUiShowReview = agents.uiManager.ui.showReview;
    agents.uiManager.ui.showReview = async (params: any) => {
      capturedScopeId = params.scopeId;
      return origUiShowReview(params);
    };

    const reviewRes = await agents.host.onRequest(
      { sessionId: "s".repeat(32) },
      {
        method: "review.open",
        params: { inline: true },
      },
      Buffer.from(receiptContent, "utf8")
    );
    expect(reviewRes.result?.reviewId).toBeDefined();
    expect(capturedScopeId).toBeDefined();
    const scopeId = capturedScopeId!;

    // 1. Valid declared path -> succeeds with grant token
    const grantResult = await viewGrantHandler!({ senderFrame: {} }, { scopeId, path: targetFile });
    expect(grantResult.token).toBeDefined();
    expect(grantResult.name).toBe("declared-file.txt");
    expect(grantResult.path).toBe(targetFile);
    expect(grantResult.scopeId).toBe(scopeId);

    // Grant must be retrievable via agents.getGrant
    const grantEntry = agents.getGrant(grantResult.token, scopeId);
    expect(grantEntry).toBeDefined();
    expect(grantEntry.canonical).toBe(targetFile);

    // 2. Undeclared path -> refused (rejects)
    await expect(
      viewGrantHandler!({ senderFrame: {} }, { scopeId, path: undeclaredFile })
    ).rejects.toThrow();

    // 3. Wrong / non-existent scopeId -> refused (rejects)
    await expect(
      viewGrantHandler!({ senderFrame: {} }, { scopeId: "wrong-scope-999", path: targetFile })
    ).rejects.toThrow();

    // 4. Invalid arguments -> rejected
    await expect(
      viewGrantHandler!({ senderFrame: {} }, { scopeId: "", path: targetFile })
    ).rejects.toThrow();
    await expect(
      viewGrantHandler!({ senderFrame: {} }, null)
    ).rejects.toThrow();

    // 5. fromApp returning false -> refused
    allowFromApp = false;
    await expect(
      viewGrantHandler!({ senderFrame: {} }, { scopeId, path: targetFile })
    ).rejects.toThrow(/refused|unknown sender/i);
  });

  it("Finding 4: buildEarlyLaunchOptions extracts call-site arguments from app and process", () => {
    // Mutation: missing buildEarlyLaunchOptions or dropping metadata arguments at main.mjs call sites
    const fakeAppPackaged = {
      isPackaged: true,
      getAppPath: () => "/Applications/UniView.app/Contents/Resources/app.asar",
      getPath: (name: string) => (name === "userData" ? "/mock/userData" : ""),
    };
    const optsPackaged = buildEarlyLaunchOptions({ app: fakeAppPackaged as any });
    expect(optsPackaged).toEqual({
      userDataDir: "/mock/userData",
      app: fakeAppPackaged,
      isPackaged: true,
      appPath: "/Applications/UniView.app/Contents/Resources/app.asar",
    });

    const fakeAppUnpackaged = {
      isPackaged: false,
      getAppPath: () => "/Users/dev/uniview",
      getPath: (name: string) => (name === "userData" ? "/mock/userData" : ""),
    };
    const optsUnpackaged = buildEarlyLaunchOptions({ app: fakeAppUnpackaged as any });
    expect(optsUnpackaged).toEqual({
      userDataDir: "/mock/userData",
      app: fakeAppUnpackaged,
      isPackaged: false,
      appPath: "/Users/dev/uniview",
    });

    expect(() => buildEarlyLaunchOptions({ app: null as any })).toThrow();
  });

  it("Finding 4 static test: main.mjs imports buildEarlyLaunchOptions for CLI and handles early MCP exit", async () => {
    // Mutation: main.mjs directly constructing or dropping metadata arguments instead of using buildEarlyLaunchOptions
    const mainMjsPath = path.resolve(__dirname, "../../electron/main.mjs");
    const mainMjsContent = await fs.readFile(mainMjsPath, "utf8");

    // Must import buildEarlyLaunchOptions from ./lib/app-agents.mjs
    expect(mainMjsContent).toMatch(/import\s*\{[^}]*buildEarlyLaunchOptions[^}]*\}\s*from\s*["']\.\/lib\/app-agents\.mjs["']/);

    // Must call buildEarlyLaunchOptions at early.isCli site
    const calls = mainMjsContent.match(/buildEarlyLaunchOptions\s*\(/g);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBeGreaterThanOrEqual(1);

    // Must use buildMcpErrorMessage and app.exit(2) on early.isMcp
    expect(mainMjsContent).toMatch(/buildMcpErrorMessage/);
    expect(mainMjsContent).toMatch(/app\.exit\(2\)/);
  });
});
