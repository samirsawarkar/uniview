import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM module without types
import { runMcp, parseMaxWait, SERVER_INSTRUCTIONS, MCP_LIMITS } from "../../electron/lib/mcp-server.mjs";
import { startServer, createFakeClock, toolCall, flush } from "./mcp-helpers";
import { makeHost, newSession } from "./agent-host-helpers";

function resolveWait(fake: any, outcome: any = { status: "waiting" }) {
  const r = fake.waitingResolve;
  fake.waitingResolve = null;
  r?.({ result: outcome });
}

describe("Packet 1: MCP and bridge", () => {
  it("Tool schemas: tools/list includes open_files, wait_for_user_message, and post_message with correct schemas; initialize returns instructions", async () => {
    const s = startServer();
    // Initialize check
    s.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-agent", version: "1.0" } },
    });
    const initRes = await s.nextJson();
    expect(initRes.id).toBe(1);
    expect(initRes.result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(initRes.result.instructions.slice(0, 512)).toContain("open_files");
    expect(initRes.result.instructions.slice(0, 512)).toContain("wait_for_user_message");
    expect(initRes.result.instructions.length).toBeLessThanOrEqual(512);

    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list check
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listRes = await s.nextJson();
    const tools = listRes.result.tools;

    const openFiles = tools.find((t: any) => t.name === "open_files");
    expect(openFiles).toBeDefined();
    expect(openFiles.description).toContain("wait_for_user_message");

    const waitTool = tools.find((t: any) => t.name === "wait_for_user_message");
    expect(waitTool).toBeDefined();
    expect(waitTool.inputSchema).toEqual({
      type: "object",
      properties: {
        waitSeconds: { type: "integer" },
      },
      additionalProperties: false,
    });
    expect(waitTool.outputSchema).toBeDefined();

    const postTool = tools.find((t: any) => t.name === "post_message");
    expect(postTool).toBeDefined();
    expect(postTool.inputSchema).toEqual({
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 4000 },
      },
      required: ["text"],
      additionalProperties: false,
    });
    expect(postTool.outputSchema).toBeDefined();

    await s.end();
  });

  it("clamp and default of waitSeconds: defaults to maxWait, clamps low/high values, rejects non-integers", async () => {
    const s = startServer();
    await s.initialize();

    // Default waitSeconds (omitted) -> 50 s = 50,000 ms
    s.send(toolCall(10, "wait_for_user_message", {}));
    await flush();
    const call1 = s.fake.calls.find((c: any) => c.method === "session.waitMessage");
    expect(call1).toBeDefined();
    expect(call1?.params?.timeoutMs).toBe(50_000);
    resolveWait(s.fake);
    const res1 = await s.nextJson();
    expect(res1.id).toBe(10);
    expect(res1.result.structuredContent).toEqual({ status: "waiting" });

    // Clamp <= 0 to 1 -> 1,000 ms
    s.send(toolCall(11, "wait_for_user_message", { waitSeconds: 0 }));
    await flush();
    const call2 = s.fake.calls.filter((c: any) => c.method === "session.waitMessage")[1];
    expect(call2?.params?.timeoutMs).toBe(1_000);
    resolveWait(s.fake);
    await s.nextJson();

    // Clamp negative to 1 -> 1,000 ms
    s.send(toolCall(12, "wait_for_user_message", { waitSeconds: -10 }));
    await flush();
    const call3 = s.fake.calls.filter((c: any) => c.method === "session.waitMessage")[2];
    expect(call3?.params?.timeoutMs).toBe(1_000);
    resolveWait(s.fake);
    await s.nextJson();

    // Clamp > maxWait (50) to 50 -> 50,000 ms
    s.send(toolCall(13, "wait_for_user_message", { waitSeconds: 99999 }));
    await flush();
    const call4 = s.fake.calls.filter((c: any) => c.method === "session.waitMessage")[3];
    expect(call4?.params?.timeoutMs).toBe(50_000);
    resolveWait(s.fake);
    await s.nextJson();

    // Valid intermediate value
    s.send(toolCall(14, "wait_for_user_message", { waitSeconds: 30 }));
    await flush();
    const call5 = s.fake.calls.filter((c: any) => c.method === "session.waitMessage")[4];
    expect(call5?.params?.timeoutMs).toBe(30_000);
    resolveWait(s.fake);
    await s.nextJson();

    // Reject non-integer
    s.send(toolCall(15, "wait_for_user_message", { waitSeconds: 2.5 }));
    const errRes = await s.nextJson();
    expect(errRes.id).toBe(15);
    expect(errRes.error.code).toBe(-32602);

    await s.end();
  });

  it("env parsing with bad values: parses UNIVIEW_MAX_WAIT safely with fallback to 50", async () => {
    expect(parseMaxWait(undefined)).toBe(50);
    expect(parseMaxWait("")).toBe(50);
    expect(parseMaxWait("not-a-number")).toBe(50);
    expect(parseMaxWait("0")).toBe(50);
    expect(parseMaxWait("-1")).toBe(50);
    expect(parseMaxWait("3001")).toBe(50);
    expect(parseMaxWait("25.5")).toBe(50);
    expect(parseMaxWait(null)).toBe(50);
    expect(parseMaxWait("1")).toBe(1);
    expect(parseMaxWait("100")).toBe(100);
    expect(parseMaxWait("3000")).toBe(3000);

    // Test server with custom valid env
    const sCustom = startServer({ env: { UNIVIEW_MAX_WAIT: "120" } });
    await sCustom.initialize();
    sCustom.send(toolCall(1, "wait_for_user_message", {}));
    await flush();
    const callCustom = sCustom.fake.calls.find((c: any) => c.method === "session.waitMessage");
    expect(callCustom?.params?.timeoutMs).toBe(120_000);
    resolveWait(sCustom.fake);
    await sCustom.nextJson();
    await sCustom.end();

    // Test server with invalid env falls back to 50
    const sBad = startServer({ env: { UNIVIEW_MAX_WAIT: "99999" } });
    await sBad.initialize();
    sBad.send(toolCall(1, "wait_for_user_message", {}));
    await flush();
    const callBad = sBad.fake.calls.find((c: any) => c.method === "session.waitMessage");
    expect(callBad?.params?.timeoutMs).toBe(50_000);
    resolveWait(sBad.fake);
    await sBad.nextJson();
    await sBad.end();
  });

  it("delivery order: messages are delivered in strict FIFO order", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // Send three messages
    await t.host.sendMessage({ sessionId: s.sessionId, text: "msg-1", documentPath: "/w/doc.txt" });
    await t.host.sendMessage({ sessionId: s.sessionId, text: "msg-2", documentPath: "/w/doc.txt" });
    await t.host.sendMessage({ sessionId: s.sessionId, text: "msg-3", documentPath: "/w/doc.txt" });

    // Retrieve them one by one
    const r1 = await t.call(s, "session.waitMessage", { timeoutMs: 5000 });
    expect(r1).toEqual({ status: "message", text: "msg-1", documentPath: "/w/doc.txt" });

    const r2 = await t.call(s, "session.waitMessage", { timeoutMs: 5000 });
    expect(r2).toEqual({ status: "message", text: "msg-2", documentPath: "/w/doc.txt" });

    const r3 = await t.call(s, "session.waitMessage", { timeoutMs: 5000 });
    expect(r3).toEqual({ status: "message", text: "msg-3", documentPath: "/w/doc.txt" });
  });

  it("wait then message: agent waits first, then user message immediately delivers and updates state to working", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // Agent calls wait first
    const waitPromise = t.call(s, "session.waitMessage", { timeoutMs: 30000 });
    await flush();

    // Verify session state became "listening"
    expect(t.ui.calls.sessionState).toContainEqual({ sessionId: s.sessionId, state: "listening" });

    // User sends message
    const sendRes = await t.host.sendMessage({ sessionId: s.sessionId, text: "Fix typo", documentPath: "/w/doc.txt" });
    expect(sendRes).toEqual({ ok: true, delivered: true });

    const waitRes = await waitPromise;
    expect(waitRes).toEqual({ status: "message", text: "Fix typo", documentPath: "/w/doc.txt" });
    expect(t.ui.calls.sessionState).toContainEqual({ sessionId: s.sessionId, state: "working" });
  });

  it("message then wait: user sends message before agent waits; stays queued until agent calls wait", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // User sends message while agent is not waiting
    const sendRes = await t.host.sendMessage({ sessionId: s.sessionId, text: "Queued change", documentPath: "/w/doc.txt" });
    expect(sendRes).toEqual({ ok: true, delivered: false, queued: true });
    expect(t.ui.calls.sessionState).toContainEqual({ sessionId: s.sessionId, state: "queued" });

    // Now agent calls wait -> returns immediately
    const waitRes = await t.call(s, "session.waitMessage", { timeoutMs: 30000 });
    expect(waitRes).toEqual({ status: "message", text: "Queued change", documentPath: "/w/doc.txt" });
    expect(t.ui.calls.sessionState).toContainEqual({ sessionId: s.sessionId, state: "working" });
  });

  it("cancel while waiting keeps message: tool cancellation ends wait without losing queued message", async () => {
    const s = startServer();
    await s.initialize();

    // Start wait
    s.send(toolCall(42, "wait_for_user_message", { waitSeconds: 50 }));
    await flush();

    // Cancel the wait
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } });
    await flush();

    // Cancel message sent to bridge
    const cancelCall = s.fake.calls.find((c: any) => c.method === "session.cancelWaitMessage");
    expect(cancelCall).toBeDefined();

    // Subsequent call should succeed and not be blocked by old wait
    s.send(toolCall(43, "wait_for_user_message", { waitSeconds: 10 }));
    await flush();
    resolveWait(s.fake, { status: "message", text: "Preserved message", documentPath: "C:\\a.txt" });
    const res = await s.nextJson();
    expect(res.id).toBe(43);
    expect(res.result.structuredContent).toEqual({ status: "message", text: "Preserved message", documentPath: "C:\\a.txt" });

    await s.end();
  });

  it("disconnect: client disconnect terminates wait, preserves inbox, and notifies disconnected state", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // Queue a message first
    await t.host.sendMessage({ sessionId: s.sessionId, text: "Unsent text", documentPath: "/w/doc.txt" });

    // Agent starts waiting for second message
    const waitPromise = t.call(s, "session.waitMessage", { timeoutMs: 50000 });
    // First message is consumed by waitPromise
    const res = await waitPromise;
    expect(res.text).toBe("Unsent text");

    // Agent waits again
    const activeWaitPromise = t.call(s, "session.waitMessage", { timeoutMs: 50000 });
    await flush();

    // A message lands in the inbox after the wait opened, still undelivered
    const liveInbox = t.host.getSessionInbox(s.sessionId);
    liveInbox.push({ text: "Keep this after disconnect", documentPath: "/w/doc.txt" });

    // Client disconnects
    t.host.onSessionClosed(s.sessionId);

    // Active wait terminated
    const outcome = await activeWaitPromise;
    expect(outcome.status).toBe("waiting");

    // Session state reported disconnected
    expect(t.ui.calls.sessionState).toContainEqual({ sessionId: s.sessionId, state: "disconnected" });

    // Unsent text is kept: the disconnect-terminated wait did not consume it
    expect(liveInbox).toEqual([{ text: "Keep this after disconnect", documentPath: "/w/doc.txt" }]);

    // Further send attempts to disconnected session are refused
    await expect(
      t.host.sendMessage({ sessionId: s.sessionId, text: "Fail", documentPath: "/w/doc.txt" })
    ).rejects.toThrow(/Session not found or disconnected/);
  });

  it("second wait busy: only one wait per session at a time; second wait fails with busy", async () => {
    const s = startServer();
    await s.initialize();

    s.send(toolCall(1, "wait_for_user_message", { waitSeconds: 50 }));
    await flush();

    // Second wait on same session while first is still pending
    s.send(toolCall(2, "wait_for_user_message", { waitSeconds: 50 }));
    const busyRes = await s.nextJson();
    expect(busyRes.id).toBe(2);
    expect(busyRes.result.isError).toBe(true);
    expect(busyRes.result.structuredContent.code).toBe("busy");

    // Finish first wait
    resolveWait(s.fake);
    const firstRes = await s.nextJson();
    expect(firstRes.id).toBe(1);
    expect(firstRes.result.structuredContent).toEqual({ status: "waiting" });

    await s.end();
  });

  it("session isolation: a session only receives messages typed on tabs that session opened", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc1.txt", "doc1");
    t.fakeFs.set("/w/doc2.txt", "doc2");

    const s1 = await t.approvedMcp("agent1");
    await t.open(s1, ["/w/doc1.txt"]);

    const s2 = await t.approvedMcp("agent2");
    await t.open(s2, ["/w/doc2.txt"]);

    // Send message on doc1 for session 1
    await t.host.sendMessage({ sessionId: s1.sessionId, text: "For S1", documentPath: "/w/doc1.txt" });

    // Attempting to send message on doc1 for session 2 must be rejected
    await expect(
      t.host.sendMessage({ sessionId: s2.sessionId, text: "Intrusion", documentPath: "/w/doc1.txt" })
    ).rejects.toThrow(/Session isolation/);

    // Session 2 waiting receives nothing from Session 1
    t.call(s2, "session.waitMessage", { timeoutMs: 50 });
    await t.clock.advance(60);
    const s2Inbox = t.host.getSessionInbox(s2.sessionId);
    expect(s2Inbox).toHaveLength(0);

    // Session 1 waiting receives its message
    const s1Res = await t.call(s1, "session.waitMessage", { timeoutMs: 5000 });
    expect(s1Res).toEqual({ status: "message", text: "For S1", documentPath: "/w/doc1.txt" });
  });

  it("closed status: when user ends session, waiting wait resolves with closed and future waits return closed", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // Agent starts waiting
    const waitPromise = t.call(s, "session.waitMessage", { timeoutMs: 50000 });
    await flush();

    // User clicks End
    const endRes = await t.host.endSession(s.sessionId);
    expect(endRes).toEqual({ ok: true });

    // Active wait immediately returns status closed
    const outcome = await waitPromise;
    expect(outcome).toEqual({ status: "closed" });

    // Future wait on closed session immediately returns status closed
    const futureWait = await t.call(s, "session.waitMessage", { timeoutMs: 50000 });
    expect(futureWait).toEqual({ status: "closed" });
  });

  it("post_message length limits: rejects empty or > 4000 characters; accepts 1 and 4000", async () => {
    const s = startServer();
    await s.initialize();

    // Empty string rejected
    s.send(toolCall(1, "post_message", { text: "" }));
    const res1 = await s.nextJson();
    expect(res1.id).toBe(1);
    expect(res1.error.code).toBe(-32602);

    // 4001 characters rejected
    s.send(toolCall(2, "post_message", { text: "x".repeat(4001) }));
    const res2 = await s.nextJson();
    expect(res2.id).toBe(2);
    expect(res2.error.code).toBe(-32602);

    // 1 character accepted
    s.send(toolCall(3, "post_message", { text: "x" }));
    const res3 = await s.nextJson();
    expect(res3.id).toBe(3);
    expect(res3.result.structuredContent).toEqual({ posted: true });

    // 4000 characters accepted
    s.send(toolCall(4, "post_message", { text: "x".repeat(4000) }));
    const res4 = await s.nextJson();
    expect(res4.id).toBe(4);
    expect(res4.result.structuredContent).toEqual({ posted: true });

    // Non-string rejected
    s.send(toolCall(5, "post_message", { text: 1234 }));
    const res5 = await s.nextJson();
    expect(res5.id).toBe(5);
    expect(res5.error.code).toBe(-32602);

    await s.end();
  });

  it("progress notifications with and without a token: sends progress every 20 s only when progressToken is present", async () => {
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();

    // Wait WITH progressToken
    s.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wait_for_user_message",
        arguments: { waitSeconds: 50 },
        _meta: { progressToken: "token-123" },
      },
    });
    await flush();

    // Advance 20s
    await clock.advance(20_000);
    const p1 = await s.nextJson();
    expect(p1).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "token-123", progress: 1, total: 50 },
    });

    // Advance another 20s
    await clock.advance(20_000);
    const p2 = await s.nextJson();
    expect(p2).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "token-123", progress: 2, total: 50 },
    });

    // Complete the wait
    resolveWait(s.fake);
    await s.nextJson();

    // Wait WITHOUT progressToken
    s.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wait_for_user_message",
        arguments: { waitSeconds: 50 },
      },
    });
    await flush();

    // Advance 20s, 40s - no progress notification emitted
    await clock.advance(40_000);
    expect(s.lines).toHaveLength(0);

    resolveWait(s.fake);
    const finalRes = await s.nextJson();
    expect(finalRes.id).toBe(2);

    await s.end();
  });

  it("full inbox: rejects 101st message with error; does not drop messages silently", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // Fill inbox with 100 messages
    for (let i = 1; i <= 100; i++) {
      const res = await t.host.sendMessage({ sessionId: s.sessionId, text: `message-${i}`, documentPath: "/w/doc.txt" });
      expect(res.ok).toBe(true);
    }
    expect(t.host.getSessionInbox(s.sessionId)).toHaveLength(100);

    // 101st message must be rejected
    await expect(
      t.host.sendMessage({ sessionId: s.sessionId, text: "message-101", documentPath: "/w/doc.txt" })
    ).rejects.toThrow(/Inbox is full/);

    // Ensure all 100 original messages are still present
    const inbox = t.host.getSessionInbox(s.sessionId);
    expect(inbox).toHaveLength(100);
    expect(inbox[0].text).toBe("message-1");
    expect(inbox[99].text).toBe("message-100");
  });

  it("truthful status on timeout or cancel: emits idle, or queued if inbox is non-empty", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    // Test 1: wait times out with empty inbox -> emits "idle"
    const p1 = t.call(s, "session.waitMessage", { timeoutMs: 50 });
    await t.clock.advance(60);
    const r1 = await p1;
    expect(r1).toEqual({ status: "waiting" });
    expect(t.ui.calls.sessionState.at(-1)).toEqual({ sessionId: s.sessionId, state: "idle" });

    // Test 2: wait is cancelled with empty inbox -> emits "idle"
    const p2 = t.call(s, "session.waitMessage", { timeoutMs: 50_000 });
    await flush();
    expect(t.ui.calls.sessionState.at(-1)).toEqual({ sessionId: s.sessionId, state: "listening" });
    await t.call(s, "session.cancelWaitMessage", {});
    const r2 = await p2;
    expect(r2).toEqual({ status: "waiting" });
    expect(t.ui.calls.sessionState.at(-1)).toEqual({ sessionId: s.sessionId, state: "idle" });

    // Test 3: wait is cancelled with non-empty inbox -> emits "queued"
    const p3 = t.call(s, "session.waitMessage", { timeoutMs: 50_000 });
    await flush();
    expect(t.ui.calls.sessionState.at(-1)).toEqual({ sessionId: s.sessionId, state: "listening" });
    t.host.getSessionInbox(s.sessionId).push({ text: "queued-later", documentPath: "/w/doc.txt" });
    await t.call(s, "session.cancelWaitMessage", {});
    const r3 = await p3;
    expect(r3).toEqual({ status: "waiting" });
    expect(t.ui.calls.sessionState.at(-1)).toEqual({ sessionId: s.sessionId, state: "queued" });
  });

  it("message loss race: cancelled wait tool buffers late arriving bridge message for next wait", async () => {
    let bridgeResolve: ((v: any) => void) | undefined;
    const fake = {
      calls: [] as any[],
      connects: 0,
      closes: 0,
      connect: async () => client,
    };
    const client = {
      sessionId: "s".repeat(32),
      async request(method: string, params: any) {
        fake.calls.push({ method, params });
        if (method === "mcp.hello") return { result: {} };
        if (method === "session.waitMessage") {
          return new Promise((r) => { bridgeResolve = r; });
        }
        if (method === "session.cancelWaitMessage") {
          return { result: {} };
        }
        return { result: {} };
      },
      async close() {},
    };

    const s = startServer({ connect: fake.connect });
    await s.initialize();

    // Agent calls wait
    s.send(toolCall(1, "wait_for_user_message", { waitSeconds: 50 }));
    await flush();

    // Tool call is cancelled
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await flush();

    // Bridge wait resolves late with a message
    bridgeResolve!({ result: { status: "message", text: "Late gap message", documentPath: "C:\\a.txt" } });
    await flush();

    // Next wait_for_user_message returns the buffered message immediately without calling bridge waitMessage again
    const bridgeCallsBefore = fake.calls.filter((c) => c.method === "session.waitMessage").length;
    s.send(toolCall(2, "wait_for_user_message", { waitSeconds: 50 }));
    const res = await s.nextJson();
    expect(res.id).toBe(2);
    expect(res.result.structuredContent).toEqual({
      status: "message",
      text: "Late gap message",
      documentPath: "C:\\a.txt",
    });
    const bridgeCallsAfter = fake.calls.filter((c) => c.method === "session.waitMessage").length;
    expect(bridgeCallsAfter).toBe(bridgeCallsBefore);

    await s.end();
  });

  it("wait guard: an unanswered bridge wait ends at timeoutMs + grace, cancels it, and keeps a late message", async () => {
    const clock = createFakeClock();
    let bridgeResolve: ((v: any) => void) | undefined;
    const fake = {
      calls: [] as any[],
      connects: 0,
      closes: 0,
      connect: async () => client,
    };
    const client = {
      sessionId: "s".repeat(32),
      async request(method: string, params: any) {
        fake.calls.push({ method, params });
        if (method === "mcp.hello") return { result: {} };
        if (method === "session.waitMessage") return new Promise((r) => { bridgeResolve = r; });
        return { result: {} };
      },
      async close() {},
    };

    const s = startServer({ clock, connect: fake.connect });
    await s.initialize();

    s.send(toolCall(1, "wait_for_user_message", { waitSeconds: 2 }));
    await flush();

    // Not before the guard fires
    await clock.advance(2_000 + MCP_LIMITS.WAIT_GRACE_MS - 1);
    expect(s.lines).toHaveLength(0);

    await clock.advance(1);
    const res = await s.nextJson();
    expect(res.id).toBe(1);
    expect(res.result.structuredContent).toEqual({ status: "waiting" });
    expect(fake.calls.some((c) => c.method === "session.cancelWaitMessage")).toBe(true);

    // The reply that arrives after the guard is not lost
    bridgeResolve!({ result: { status: "message", text: "Late", documentPath: "/a.txt" } });
    await flush();
    s.send(toolCall(2, "wait_for_user_message", { waitSeconds: 50 }));
    const res2 = await s.nextJson();
    expect(res2.result.structuredContent).toEqual({ status: "message", text: "Late", documentPath: "/a.txt" });

    await s.end();
  });

  it("post_message failure: a renderer that cannot be reached is a tool failure, not posted", async () => {
    const t = await makeHost();
    const s = await t.approvedMcp("agent");
    t.ui.postMessage = async () => {
      throw new Error("no window");
    };
    expect(await t.fail(s, "session.postMessage", { text: "x" })).toBe("app_unavailable");
  });

  it("sendMessage requires documentPath and case-folds only on win32 and darwin", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc.txt", "content");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc.txt"]);

    await expect(t.host.sendMessage({ sessionId: s.sessionId, text: "no path" })).rejects.toThrow(/documentPath/);
    await expect(t.host.sendMessage({ sessionId: s.sessionId, text: "null path", documentPath: null })).rejects.toThrow(
      /documentPath/,
    );
    await expect(
      t.host.sendMessage({ sessionId: s.sessionId, text: "wrong path", documentPath: "/w/other.txt" }),
    ).rejects.toThrow(/isolation/);

    // Case-only variants are the same file on win32/darwin, and a different path on posix.
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await expect(
        t.host.sendMessage({ sessionId: s.sessionId, text: "case", documentPath: "/W/DOC.TXT" }),
      ).rejects.toThrow(/isolation/);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    if (process.platform === "win32" || process.platform === "darwin") {
      await expect(
        t.host.sendMessage({ sessionId: s.sessionId, text: "case", documentPath: "/W/DOC.TXT" }),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("reset chatClosed on open: session ends, chatClosed is reset when session opens a document again", async () => {
    const t = await makeHost();
    t.fakeFs.set("/w/doc1.txt", "doc1");
    t.fakeFs.set("/w/doc2.txt", "doc2");
    const s = await t.approvedMcp("agent");
    await t.open(s, ["/w/doc1.txt"]);

    // End the session
    await t.host.endSession(s.sessionId);

    // Waiting now returns closed
    const closedRes = await t.call(s, "session.waitMessage", { timeoutMs: 1000 });
    expect(closedRes).toEqual({ status: "closed" });

    // Agent opens a new document in the same session
    await t.open(s, ["/w/doc2.txt"]);

    // Future wait is no longer closed
    const activeWaitPromise = t.call(s, "session.waitMessage", { timeoutMs: 1000 });
    await flush();
    await t.host.sendMessage({ sessionId: s.sessionId, text: "Resume chat", documentPath: "/w/doc2.txt" });
    const msgRes = await activeWaitPromise;
    expect(msgRes).toEqual({ status: "message", text: "Resume chat", documentPath: "/w/doc2.txt" });
  });
});
