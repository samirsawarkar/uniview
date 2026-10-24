import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer, createFakeClock, flush, toolCall, escapeHeavySpec, paddedLine, validReceipt } from "./mcp-helpers";

// @ts-expect-error plain ESM module without types
import { MCP_LIMITS, LineSplitter } from "../../electron/lib/mcp-server.mjs";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";

const MiB = 1024 * 1024;

describe("MCP limits", () => {
  it("accepts a 16 MiB escape-heavy line and rejects 16 MiB + 1 with -32600, discarding only that line", async () => {
    // Mutation: an off-by-one line limit, buffering the whole oversized line, or dropping the following line.
    expect(MCP_LIMITS.MAX_LINE_BYTES).toBe(16 * MiB);
    const s = startServer();
    await s.initialize();
    const spec = escapeHeavySpec(2 * MiB);
    const atLimit = paddedLine(toolCall(1, "show_view", { specText: spec }), 16 * MiB);
    expect(Buffer.byteLength(atLimit)).toBe(16 * MiB);
    s.send(atLimit);
    const ok = await s.nextJson(30000);
    expect(ok.id).toBe(1);
    expect(ok.result.isError).toBeUndefined();
    expect(ok.result.structuredContent).toEqual({ shown: true, scopeId: "scope-1" });

    s.send(paddedLine(toolCall(2, "show_view", { specText: spec }), 16 * MiB + 1));
    s.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(await s.nextJson(30000)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: line longer than ${16 * MiB} bytes` } });
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    await s.end();
  }, 120000);

  it("counts a CRLF line without its \\r", () => {
    // Mutation: counting the \r of a CRLF terminator against the limit.
    const sp = new LineSplitter(4);
    expect(sp.push(Buffer.from("abcd\r\nabcde\r\n"))).toEqual([{ line: Buffer.from("abcd") }, { tooLong: true }]);
  });

  it("splits lines across chunks and reports an unterminated last line at end", () => {
    // Mutation: losing bytes at chunk boundaries or the final line without "\n".
    const sp = new LineSplitter(10);
    expect(sp.push(Buffer.from("ab"))).toEqual([]);
    expect(sp.push(Buffer.from("c\nde"))).toEqual([{ line: Buffer.from("abc") }]);
    expect(sp.end()).toEqual([{ line: Buffer.from("de") }]);
  });

  it("passes a 2 MiB escape-heavy specText through as the raw frame body and rejects 2 MiB + 1 with -32602", async () => {
    // Mutation: measuring the escaped JSON instead of the decoded UTF-8 text, or re-encoding the body as a JSON string.
    const s = startServer();
    await s.initialize();
    const spec = escapeHeavySpec(2 * MiB);
    expect(Buffer.byteLength(spec)).toBe(2 * MiB);
    s.send(toolCall(1, "show_view", { specText: spec }));
    const ok = await s.nextJson(30000);
    expect(ok.result.structuredContent).toEqual({ shown: true, scopeId: "scope-1" });
    const shown = s.fake.calls.find((c) => c.method === "view.show")!;
    expect(shown.params).toEqual({ inline: true });
    expect(shown.body!.equals(Buffer.from(spec, "utf8"))).toBe(true);

    const over = escapeHeavySpec(2 * MiB + 1);
    s.send(toolCall(2, "show_view", { specText: over }));
    expect(await s.nextJson(30000)).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: `Invalid params: specText is larger than ${2 * MiB} bytes as UTF-8` } });
    expect(s.fake.calls.filter((c) => c.method === "view.show")).toHaveLength(1);
    await s.end();
  }, 120000);

  it("counts receiptText as UTF-8 bytes: 2 MiB of multi-byte text passes the size check, one more byte does not", async () => {
    // Mutation: counting UTF-16 code units (string length) instead of UTF-8 bytes.
    const s = startServer();
    await s.initialize();
    const atLimit = "é".repeat(MiB); // 2 bytes each in UTF-8
    s.send(toolCall(1, "request_review", { receiptText: atLimit }));
    const r1 = await s.nextJson(30000);
    expect(r1.result.structuredContent.code).toBe("invalid_receipt");
    s.send(toolCall(2, "request_review", { receiptText: `${atLimit}a` }));
    expect((await s.nextJson(30000)).error.code).toBe(-32602);
    await s.end();
  }, 60000);

  it("open_files accepts 20 paths and rejects 21; a path may have 4096 characters but not 4097", async () => {
    // Mutation: off-by-one in the path count or path length check.
    const s = startServer();
    await s.initialize();
    const p = (i: number) => `C:\\work\\f${i}.txt`;
    s.send(toolCall(1, "open_files", { paths: Array.from({ length: 20 }, (_, i) => p(i)) }));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 20 });
    s.send(toolCall(2, "open_files", { paths: Array.from({ length: 21 }, (_, i) => p(i)) }));
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Invalid params: paths must be an array of 1 to 20 strings" } });
    s.send(toolCall(3, "open_files", { paths: [] }));
    expect((await s.nextJson()).error.code).toBe(-32602);
    const long = `C:\\${"x".repeat(4093)}`;
    expect(long).toHaveLength(4096);
    s.send(toolCall(4, "open_files", { paths: [long] }));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 1 });
    s.send(toolCall(5, "open_files", { paths: [`${long}y`] }));
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32602, message: "Invalid params: paths[0] must be a string of 1 to 4096 characters" } });
    // 20 paths of 4096 non-ASCII characters exceed the 64 KiB frame header, so paths travel in the body.
    const wide = Array.from({ length: 20 }, () => "C:\\" + "é".repeat(4093));
    s.send(toolCall(6, "open_files", { paths: wide }));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 20 });
    const opened = s.fake.calls.filter((c) => c.method === "open").at(-1)!;
    expect(opened.params).toEqual({});
    expect(JSON.parse(opened.body!.toString("utf8"))).toEqual(wide);
    await s.end();
  });

  it("waitSeconds accepts 3600 and rejects 3601 and fractions", async () => {
    // Mutation: off-by-one in the wait range or accepting non-integers.
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptPath: "C:\\work\\approved.receipt.json", waitSeconds: 3600 }));
    expect((await s.nextJson()).result.structuredContent.status).toBe("decided");
    expect(s.fake.calls.find((c) => c.method === "review.wait")!.params).toEqual({ reviewId: "00000000000000000000000000000001", timeoutMs: 3_600_000 });
    for (const [id, w] of [[2, 3601], [3, 1.5], [4, -1], [5, "5"]] as const) {
      s.send(toolCall(id, "request_review", { receiptPath: "C:\\work\\r.receipt.json", waitSeconds: w }));
      expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: waitSeconds must be an integer from 0 to 3600" } });
    }
    await s.end();
  });

  it("a reviewId of 128 characters is looked up, 129 is invalid params", async () => {
    // Mutation: off-by-one in the reviewId length check.
    const s = startServer();
    await s.initialize();
    s.send(toolCall(1, "get_review", { reviewId: "a".repeat(128) }));
    expect((await s.nextJson()).result.structuredContent.code).toBe("not_found");
    s.send(toolCall(2, "get_review", { reviewId: "a".repeat(129) }));
    expect((await s.nextJson()).error.code).toBe(-32602);
    await s.end();
  });
});

describe("MCP review waits", () => {
  it("the local guard answers timeout at waitSeconds + 10 s, not a moment earlier, and ends the bridge wait", async () => {
    // Mutation: no local deadline (a stuck app hangs the agent forever) or a deadline shorter than the wait.
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptPath: "C:\\work\\r.receipt.json", waitSeconds: 2 }));
    await flush();
    await clock.advance(2000 + MCP_LIMITS.WAIT_GRACE_MS - 1);
    expect(s.lines).toEqual([]);
    // The fake ends a wait only on cancelWait, so the guard is what answers.
    await clock.advance(1);
    const r = await s.nextJson();
    expect(r.result.structuredContent).toEqual({ code: "timeout", message: "UniView did not answer in time." });
    expect(s.fake.calls.map((c) => c.method)).toContain("review.cancelWait");
    await s.end();
  });

  it("notifications/cancelled ends a waiting request_review without a response; the review stays open", async () => {
    // Mutation: answering a cancelled request, closing the review instead of only the wait, or ignoring the cancel.
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();
    s.send(toolCall(7, "request_review", { receiptPath: "C:\\work\\r.receipt.json", waitSeconds: 600 }));
    await flush();
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    await flush();
    expect(s.fake.calls.find((c) => c.method === "review.cancelWait")!.params).toEqual({ reviewId: "00000000000000000000000000000001" });
    expect(clock.pending()).toBe(0);
    s.send(toolCall(8, "get_review", { reviewId: "00000000000000000000000000000001" }));
    expect((await s.nextJson()).result.structuredContent).toEqual({ status: "pending" });
    // The id is free again once the cancelled request has ended.
    s.send({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    await s.end();
    expect(s.lines).toEqual([]);
  });

  it("cancelling another request id or a non-review tool changes nothing", async () => {
    // Mutation: a cancel for an unknown id or for open_files suppressing an answer.
    const s = startServer();
    await s.initialize();
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
    s.send(toolCall(1, "open_files", { paths: ["C:\\work\\a.txt"] }));
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 1 });
    await s.end();
  });

  it("a request id that is still in flight cannot be reused", async () => {
    // Mutation: two requests sharing an id, which makes cancellation ambiguous.
    const s = startServer({ clock: createFakeClock() });
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptPath: "C:\\work\\r.receipt.json", waitSeconds: 60 }));
    await flush();
    s.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid Request: id is already in use" } });
    await s.end();
  });
});

describe("MCP bridge connection", () => {
  it("connects lazily, once, and introduces the agent with its sanitized self-reported name", async () => {
    // Mutation: connecting before a tool call, reconnecting per call, or forwarding control/bidi characters.
    const s = startServer();
    s.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "evil\u202e\u0007agent", version: "9" } } });
    await s.next();
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await s.next();
    expect(s.fake.connects).toBe(0);
    s.send(toolCall(2, "open_files", { paths: ["C:\\work\\a.txt"] }));
    s.send(toolCall(3, "open_files", { paths: ["C:\\work\\b.txt"] }));
    await s.next();
    await s.next();
    expect(s.fake.connects).toBe(1);
    expect(s.fake.calls[0]).toEqual({ method: "mcp.hello", params: { client: { name: "evilagent", version: "9" }, protocolVersion: "2025-03-26" }, body: undefined });
    await s.end();
    expect(s.fake.closes).toBe(1);
  });

  it("starts the app and retries with backoff; a connection at exactly 15 s succeeds", async () => {
    // Mutation: giving up before the 15 s deadline or never calling startApp.
    const clock = createFakeClock();
    const s = startServer({ clock });
    let started = 0;
    const real = s.fake.connect;
    const opts = { connectAt: 15_000 };
    s.fake.connect = async () => {
      if (started === 0 || clock.now() < opts.connectAt) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return real();
    };
    // startServer captured the original connect; rebuild with the patched one.
    await s.end();
    const t = startServer({ clock, connect: () => s.fake.connect(), startApp: async () => void started++ });
    await t.initialize();
    t.send(toolCall(1, "open_files", { paths: ["C:\\work\\a.txt"] }));
    await clock.advance(15_000);
    const r = await t.nextJson();
    expect(r.result.structuredContent).toEqual({ opened: 1 });
    expect(started).toBe(1);
    expect(t.stderr()).toContain("bridge connect failed: ENOENT");
    await t.end();
  });

  it("answers app_unavailable when the app is still unreachable after 15 s", async () => {
    // Mutation: retrying forever or answering with a JSON-RPC error instead of a tool error.
    const clock = createFakeClock();
    let attempts = 0;
    const s = startServer({
      clock,
      connect: async () => {
        attempts++;
        if (clock.now() < 15_001) throw new Error("no pipe");
        throw new Error("unreachable");
      },
      startApp: async () => {},
    });
    await s.initialize();
    s.send(toolCall(1, "open_files", { paths: ["C:\\work\\a.txt"] }));
    await clock.advance(14_999);
    expect(s.lines).toEqual([]);
    await clock.advance(1);
    expect((await s.nextJson()).result).toEqual({
      content: [{ type: "text", text: "app_unavailable: UniView is not reachable." }],
      structuredContent: { code: "app_unavailable", message: "UniView is not reachable." },
      isError: true,
    });
    // 100, 200, 400, 800, then 1000 ms steps up to 15 s, plus the first attempt.
    expect(attempts).toBe(1 + 4 + 14);
    await s.end();
  });

  it("without startApp an unreachable app is app_unavailable at once", async () => {
    // Mutation: waiting for an app nobody will start.
    const s = startServer({ connect: async () => { throw new Error("no pipe"); } });
    await s.initialize();
    s.send(toolCall(1, "show_view", { specPath: "C:\\work\\v.uview.json" }));
    expect((await s.nextJson()).result.structuredContent.code).toBe("app_unavailable");
    await s.end();
  });

  it("a refused hello (not_allowed) is the tool error and the next call connects again", async () => {
    // Mutation: ignoring the bridge's answer to the hello, or caching a refused connection.
    let refuse = true;
    const s = startServer();
    const base = s.fake;
    await s.end();
    const t = startServer({
      connect: async () => {
        const c = await base.connect();
        return {
          ...c,
          request: async (m: string, p: any, b?: Buffer) => {
            if (m === "mcp.hello" && refuse) {
              const e = Object.assign(new Error("not_allowed"), { code: "not_allowed" });
              throw e;
            }
            return c.request(m, p, b);
          },
        };
      },
    });
    await t.initialize();
    t.send(toolCall(1, "open_files", { paths: ["C:\\work\\a.txt"] }));
    expect((await t.nextJson()).result.structuredContent.code).toBe("not_allowed");
    refuse = false;
    t.send(toolCall(2, "open_files", { paths: ["C:\\work\\a.txt"] }));
    expect((await t.nextJson()).result.structuredContent).toEqual({ opened: 1 });
    expect(base.connects).toBe(2);
    await t.end();
  });

  it("stdout carries only JSON-RPC messages; diagnostics go to stderr", async () => {
    // Mutation: a console.log or log line written to stdout corrupts the protocol stream.
    const s = startServer({ connect: async () => { throw new Error("no pipe"); } });
    await s.initialize();
    s.send(toolCall(1, "open_files", { paths: ["C:\\work\\a.txt"] }));
    s.send("{oops");
    await s.next();
    await s.next();
    await s.end();
    expect(s.stderr()).toContain("uniview-mcp: bridge connect failed: no pipe");
    expect(s.partial()).toBe("");
  });

  it("invalid UTF-8 is a parse error; a client response is ignored", async () => {
    // Mutation: decoding invalid UTF-8 leniently, or answering a response.
    const s = startServer();
    await s.initialize();
    s.stdin.write(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    s.send({ jsonrpc: "2.0", id: 5, result: {} });
    s.send({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(await s.nextJson()).toEqual({ jsonrpc: "2.0", id: 6, result: {} });
    await s.end();
  });

  it("sends spec and receipt text over a real bridge as raw body bytes", async () => {
    // Mutation: sending the document inside the JSON header (escaped) instead of as the frame body.
    const base = process.platform === "win32" ? "I:\\AES\\tmp" : path.join(os.tmpdir(), "aes-test");
    const testDir = path.join(base, `uv-mcp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
    await fs.mkdir(testDir, { recursive: true });
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\uniview-test-${crypto.randomBytes(8).toString("hex")}` : path.join(testDir, "b.sock");
    const key = crypto.randomBytes(32);
    const seen: Array<{ method: string; params: any; body: Buffer }> = [];
    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async (_s: unknown, header: any, body: Buffer) => {
        seen.push({ method: header.method, params: header.params, body });
        if (header.method === "view.show") return { result: { scopeId: "real-scope" } };
        if (header.method === "review.open") return { result: { reviewId: "real-review" } };
        return { result: {} };
      },
    });
    const s = startServer({ connect: () => connectBridge({ endpoint, key }) });
    await s.initialize();
    const spec = escapeHeavySpec(2 * MiB);
    s.send(toolCall(1, "show_view", { specText: spec }));
    expect((await s.nextJson(30000)).result.structuredContent).toEqual({ shown: true, scopeId: "real-scope" });
    const shown = seen.find((r) => r.method === "view.show")!;
    expect(shown.params).toEqual({ inline: true });
    expect(shown.body.equals(Buffer.from(spec, "utf8"))).toBe(true);

    const receipt = validReceipt("Überprüfung \u{1F680} 日本語", 'quote " backslash \\ tab\t crlf\r\n');
    s.send(toolCall(2, "request_review", { receiptText: receipt }));
    expect((await s.nextJson(30000)).result.structuredContent).toEqual({ status: "pending", reviewId: "real-review" });
    const reviewed = seen.find((r) => r.method === "review.open")!;
    expect(reviewed.params).toEqual({ inline: true });
    expect(reviewed.body.equals(Buffer.from(receipt, "utf8"))).toBe(true);
    await s.end();
    await server.close();
    await fs.rm(testDir, { recursive: true, force: true });
  }, 60000);
});
