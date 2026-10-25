import { describe, it, expect } from "vitest";
import { Writable, PassThrough } from "node:stream";
import { startServer, createFakeClock, createFakeBridge, flush, toolCall, validReceipt, escapeHeavyReceipt } from "./mcp-helpers";

// @ts-expect-error plain ESM module without types
import { MCP_LIMITS, runMcp } from "../../electron/lib/mcp-server.mjs";

const MiB = 1024 * 1024;

const BUSY = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: "busy: UniView is busy; try again later." }],
    structuredContent: { code: "busy", message: "UniView is busy; try again later." },
    isError: true,
  },
});
const UNAVAILABLE = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: "app_unavailable: UniView is not reachable." }],
    structuredContent: { code: "app_unavailable", message: "UniView is not reachable." },
    isError: true,
  },
});
const wait = (id: number, seconds = 600) => toolCall(id, "request_review", { receiptPath: "C:\\work\\r.receipt.json", waitSeconds: seconds });
const open1 = (id: number) => toolCall(id, "open_files", { paths: ["C:\\work\\a.txt"] });

describe("MCP admission bound", () => {
  it("admits 15 in-flight tool calls and answers the 16th with a busy tool error; ending a call frees its slot", async () => {
    // Mutation: no cap on in-flight tool calls (a flood of waiting requests is retained without bound) or an off-by-one cap.
    expect(MCP_LIMITS.MAX_INFLIGHT_CALLS).toBe(15);
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();
    for (let i = 1; i <= 15; i++) s.send(wait(i));
    await flush();
    expect(s.lines).toEqual([]);
    s.send(open1(16));
    expect(await s.nextJson()).toEqual(BUSY(16));
    expect(s.fake.calls.filter((c) => c.method === "open")).toHaveLength(0);

    // A cancelled wait frees its slot.
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await flush();
    s.send(open1(17));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 1 });

    // Settling (here: the local deadline) frees the rest, so another 15 waits are admitted and the 16th is busy again.
    await clock.advance(600_000 + MCP_LIMITS.WAIT_GRACE_MS);
    for (let i = 2; i <= 15; i++) expect((await s.nextJson()).result.structuredContent.code).toBe("timeout");
    expect(s.lines).toEqual([]);
    for (let i = 18; i <= 32; i++) s.send(wait(i));
    await flush();
    expect(s.lines).toEqual([]);
    s.send(open1(33));
    expect(await s.nextJson()).toEqual(BUSY(33));
    await s.end();
  });

  it("a request that fails validation does not keep a slot", async () => {
    // Mutation: leaking the in-flight entry when a call is rejected with -32602.
    const s = startServer({ clock: createFakeClock() });
    await s.initialize();
    for (let i = 1; i <= 40; i++) {
      s.send(toolCall(i, "open_files", { paths: [] }));
      expect((await s.nextJson()).error.code).toBe(-32602);
    }
    s.send(open1(41));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 1 });
    await s.end();
  });
});

describe("MCP local deadlines", () => {
  it("a connect that never answers ends at 30 s with app_unavailable and releases every slot", async () => {
    // Mutation: no local deadline on connecting (the agent hangs and the entries are retained forever).
    expect(MCP_LIMITS.REQUEST_DEADLINE_MS).toBe(30_000);
    const clock = createFakeClock();
    const s = startServer({ clock, connect: () => new Promise(() => {}) });
    await s.initialize();
    for (let i = 1; i <= 15; i++) s.send(open1(i));
    await flush();
    s.send(open1(16));
    expect(await s.nextJson()).toEqual(BUSY(16));
    await clock.advance(29_999);
    expect(s.lines).toEqual([]);
    await clock.advance(1);
    for (let i = 1; i <= 15; i++) expect(await s.nextJson()).toEqual(UNAVAILABLE(i));
    // The slots are free again: this one is admitted (and ends at its own deadline), not busy.
    s.send(open1(18));
    await flush();
    expect(s.lines).toEqual([]);
    await clock.advance(30_000);
    expect(await s.nextJson()).toEqual(UNAVAILABLE(18));
    expect(clock.pending()).toBe(0);
    await s.end();
  });

  it("a bridge hello that never answers ends at 30 s, closes that connection, and the next call connects again", async () => {
    // Mutation: no deadline on the mcp.hello handshake, or keeping the half-open connection.
    const clock = createFakeClock();
    let connects = 0;
    let closes = 0;
    const s = startServer({
      clock,
      approvalGraceMs: 30_000,
      connect: async () => {
        connects++;
        return { request: () => new Promise(() => {}), close: async () => void closes++ };
      },
    });
    await s.initialize();
    s.send(open1(1));
    await clock.advance(29_999);
    expect(s.lines).toEqual([]);
    await clock.advance(1);
    expect(await s.nextJson()).toEqual(UNAVAILABLE(1));
    expect(connects).toBe(1);
    await flush();
    expect(closes).toBe(1);
    s.send(open1(2));
    await clock.advance(30_000);
    expect(await s.nextJson()).toEqual(UNAVAILABLE(2));
    expect(connects).toBe(2);
    await s.end();
  });

  it("a non-wait bridge request that never answers ends at 30 s, drops the connection, and the next call reconnects", async () => {
    // Mutation: no deadline on open/view.show/review.open/review.get, or reusing a stuck connection.
    const clock = createFakeClock();
    let connects = 0;
    let closes = 0;
    let stuck = true;
    const s = startServer({
      clock,
      approvalGraceMs: 30_000,
      connect: async () => {
        connects++;
        return {
          request: async (m: string) => {
            if (m === "mcp.hello") return { result: {} };
            if (stuck) return new Promise(() => {});
            return { result: { opened: 1 } };
          },
          close: async () => void closes++,
        };
      },
    });
    await s.initialize();
    s.send(open1(1));
    await clock.advance(29_999);
    expect(s.lines).toEqual([]);
    await clock.advance(1);
    expect(await s.nextJson()).toEqual(UNAVAILABLE(1));
    expect(closes).toBe(1);
    stuck = false;
    s.send(open1(2));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 1 });
    expect(connects).toBe(2);
    expect(clock.pending()).toBe(0);
    await s.end();
  });

  it("the review.wait itself is not cut at 30 s; it keeps its own waitSeconds + 10 s guard", async () => {
    // Mutation: applying the 30 s deadline to review.wait (a person has up to an hour to decide).
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();
    s.send(wait(1, 600));
    await clock.advance(299_000);
    expect(s.lines).toEqual([]);
    s.send(toolCall(2, "get_review", { reviewId: "00000000000000000000000000000001" }));
    expect((await s.nextJson()).result.structuredContent).toEqual({ status: "pending" });
    await s.end();
  });
});

describe("MCP stdout backpressure", () => {
  /** A stdout that completes writes only while `state.flowing` is true; `release()` completes the held writes. */
  function slowStdout() {
    const written: string[] = [];
    const held: Array<() => void> = [];
    const state = { flowing: true };
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _enc, cb) {
        written.push(chunk.toString("utf8"));
        if (state.flowing) cb();
        else held.push(cb);
      },
    });
    return {
      stream,
      written,
      state,
      release() {
        state.flowing = true;
        held.splice(0).forEach((cb) => cb());
      },
    };
  }

  async function handshake(stdin: PassThrough) {
    stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    await flush();
    stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await flush();
  }

  it("stops reading stdin and does not queue responses while stdout is not draining, then catches up on drain", async () => {
    // Mutation: ignoring write()'s return value, so 10,000 pings pile up in memory behind a slow reader.
    const stdin = new PassThrough();
    const out = slowStdout();
    const stderr = new PassThrough();
    const done = runMcp({ stdin, stdout: out.stream, stderr, connect: createFakeBridge().connect });
    await handshake(stdin);
    out.written.length = 0;
    out.state.flowing = false;

    const pings = Array.from({ length: 10_000 }, (_, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "ping" })).join("\n") + "\n";
    stdin.write(pings);
    await flush();
    expect(out.written).toHaveLength(1);
    expect(out.stream.writableLength).toBeLessThan(100);
    expect(stdin.isPaused()).toBe(true);

    // More input while blocked is not read either.
    stdin.write('{"jsonrpc":"2.0","id":99999,"method":"ping"}\n');
    await flush();
    expect(out.written).toHaveLength(1);

    out.release();
    const started = Date.now();
    while (out.written.length < 10_001 && Date.now() - started < 20_000) {
      await new Promise((r) => setImmediate(r));
    }
    expect(out.written).toHaveLength(10_001);
    expect(out.written[0]).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(JSON.parse(out.written[9_999]!).id).toBe(10_000);
    expect(out.written[10_000]).toBe('{"jsonrpc":"2.0","id":99999,"result":{}}\n');
    stdin.end();
    await done;
  }, 60000);

  it("closes with a stderr message when more than the output cap is queued behind a stuck reader", async () => {
    // Mutation: no cap on queued output (late tool results pile up forever behind a reader that never drains).
    expect(MCP_LIMITS.MAX_QUEUED_OUTPUT_BYTES).toBe(8 * MiB);
    const stdin = new PassThrough();
    const out = slowStdout();
    const stderr = new PassThrough();
    let errText = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (c: string) => (errText += c));
    const fake = createFakeBridge();
    const done = runMcp({ stdin, stdout: out.stream, stderr, connect: fake.connect, maxQueuedOutputBytes: 300 });
    await handshake(stdin);
    out.written.length = 0;
    out.state.flowing = false;
    // All 16 calls are read in one chunk; their answers arrive later and are never drained.
    stdin.write(Array.from({ length: 16 }, (_, i) => JSON.stringify(open1(i + 1))).join("\n") + "\n");
    await Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error("server did not close")), 5000))]);
    expect(errText).toContain("uniview-mcp: output backlog larger than 300 bytes; closing");
    expect(out.written.length).toBeLessThan(5);
    expect(fake.closes).toBe(1);
  });

  it("the cap is not hit while the reader keeps up", async () => {
    // Mutation: counting bytes that were already flushed against the cap.
    const stdin = new PassThrough();
    const out = slowStdout();
    const stderr = new PassThrough();
    const done = runMcp({ stdin, stdout: out.stream, stderr, connect: createFakeBridge().connect, maxQueuedOutputBytes: 300 });
    await handshake(stdin);
    for (let i = 1; i <= 50; i++) {
      stdin.write(JSON.stringify(open1(i)) + "\n");
      await flush();
    }
    expect(out.written.filter((l) => l.includes('"opened":1'))).toHaveLength(50);
    stdin.end();
    await done;
  });
});

describe("MCP receipt forwarding", () => {
  it("forwards a valid multibyte receiptText as the exact UTF-8 body of review.open and returns the pending review", async () => {
    // Mutation: re-encoding the receipt (escaping it into the header, normalising CRLF, or not sending it).
    const s = startServer();
    await s.initialize();
    const text = validReceipt("Überprüfung \u{1F680} 日本語", 'line one\r\nline two é \u{1F680}\t"quoted" \\ back');
    s.send(toolCall(1, "request_review", { receiptText: text }));
    const r = await s.nextJson();
    expect(r.result.structuredContent).toEqual({ status: "pending", reviewId: "00000000000000000000000000000001" });
    const opened = s.fake.calls.find((c) => c.method === "review.open")!;
    expect(opened.params).toEqual({ inline: true });
    expect(opened.body!.equals(Buffer.from(text, "utf8"))).toBe(true);
    expect(opened.body!.length).toBeGreaterThan(text.length);
    await s.end();
  });

  it("returns the decision when the receipt is decided while waiting", async () => {
    // Mutation: dropping the decision from a decided request_review result.
    const s = startServer({ clock: createFakeClock() });
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptText: validReceipt("approved-now"), waitSeconds: 30 }));
    const r = await s.nextJson();
    expect(r.result.structuredContent.status).toBe("decided");
    expect(r.result.structuredContent.reviewId).toBe("00000000000000000000000000000001");
    expect(r.result.structuredContent.decision.reviewId).toBe("00000000000000000000000000000001");
    expect(s.fake.calls.find((c) => c.method === "review.wait")!.params).toEqual({ reviewId: "00000000000000000000000000000001", timeoutMs: 30_000 });
    await s.end();
  });

  it("accepts an escape-heavy valid receipt of exactly 2 MiB as the raw body and rejects 2 MiB + 1 with -32602", async () => {
    // Mutation: measuring the escaped line instead of the decoded text, or an off-by-one on receiptText.
    const s = startServer();
    await s.initialize();
    const text = escapeHeavyReceipt(2 * MiB);
    expect(Buffer.byteLength(text)).toBe(2 * MiB);
    s.send(toolCall(1, "request_review", { receiptText: text }));
    const ok = await s.nextJson(30000);
    expect(ok.result.structuredContent).toEqual({ status: "pending", reviewId: "00000000000000000000000000000001" });
    const opened = s.fake.calls.find((c) => c.method === "review.open")!;
    expect(opened.params).toEqual({ inline: true });
    expect(opened.body!.equals(Buffer.from(text, "utf8"))).toBe(true);

    const over = escapeHeavyReceipt(2 * MiB + 1);
    expect(Buffer.byteLength(over)).toBe(2 * MiB + 1);
    s.send(toolCall(2, "request_review", { receiptText: over }));
    expect(await s.nextJson(30000)).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: `Invalid params: receiptText is larger than ${2 * MiB} bytes as UTF-8` } });
    expect(s.fake.calls.filter((c) => c.method === "review.open")).toHaveLength(1);
    await s.end();
  }, 120000);
});
