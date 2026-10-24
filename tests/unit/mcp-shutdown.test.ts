import { describe, it, expect } from "vitest";
import { Writable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { startServer, createFakeClock, createFakeBridge, flush, toolCall, validReceipt } from "./mcp-helpers";

// @ts-expect-error plain ESM module without types
import { MCP_LIMITS, runMcp } from "../../electron/lib/mcp-server.mjs";

const open1 = (id: number) => toolCall(id, "open_files", { paths: ["C:\\work\\a.txt"] });
const wait = (id: number, seconds = 600) => toolCall(id, "request_review", { receiptText: validReceipt(`task ${id}`), waitSeconds: seconds });

/**
 * A bare stdout: it does exactly what the test tells it (and nothing else, unlike a Writable which also emits
 * 'error' and 'close' by itself), so each failure signal can be tested on its own.
 */
class FakeStdout extends EventEmitter {
  written: string[] = [];
  onWrite: null | ((cb?: (e?: Error | null) => void) => boolean | void) = null;
  write(chunk: string, cb?: (e?: Error | null) => void): boolean {
    this.written.push(chunk);
    if (this.onWrite) return this.onWrite(cb) ?? true;
    cb?.();
    return true;
  }
}

/** Runs the server on a stdout that can be made to fail. */
function rig(opts: Record<string, unknown> = {}) {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (c: string) => (errText += c));
  const stdout = new FakeStdout();
  const written = stdout.written;
  // A destroyed stdout also emits "error" for writes after that; the server logs, never throws.
  const fake = createFakeBridge();
  const clock = createFakeClock();
  const done: Promise<void> = runMcp({ stdin, stdout, stderr, connect: fake.connect, clock, ...opts });
  const settled = { value: false };
  done.then(() => (settled.value = true));
  return { stdin, stdout, written, fake, clock, done, settled, errText: () => errText };
}

async function handshake(stdin: PassThrough) {
  stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  await flush();
  stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await flush();
}

const ping = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });

describe("MCP stdout failure shuts the server down", () => {
  async function connected(r: ReturnType<typeof rig>) {
    await handshake(r.stdin);
    r.stdin.write(JSON.stringify(open1(1)) + "\n");
    await flush();
    expect(r.fake.connects).toBe(1);
  }

  const failures: Array<[string, (r: ReturnType<typeof rig>) => void]> = [
    ["a write callback error (EPIPE)", (r) => (r.stdout.onWrite = (cb) => void cb?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })))],
    ["a write that throws", (r) => (r.stdout.onWrite = () => { throw new Error("write after end"); })],
    ["an 'error' event on stdout", (r) => void r.stdout.emit("error", new Error("stdout broke"))],
    ["stdout closing without an error", (r) => void r.stdout.emit("close")],
  ];
  for (const [name, breakStdout] of failures) {
    it(`${name}: runMcp resolves, the bridge is closed, timers are cancelled and later input is dropped`, async () => {
      // Mutation: logging the stdout error but staying alive (the process hangs forever with stdin paused)
      const r = rig();
      await connected(r);
      r.stdin.write(JSON.stringify(wait(2)) + "\n"); // a wait in flight holds a guard timer
      await flush();
      expect(r.clock.pending()).toBeGreaterThan(0);
      breakStdout(r);
      r.stdin.write(ping(3) + "\n");
      await flush();
      await Promise.race([r.done, new Promise((_, rej) => setTimeout(() => rej(new Error("runMcp did not resolve")), 3000))]);
      expect(r.settled.value).toBe(true);
      expect(r.fake.closes).toBe(1);
      expect(r.clock.pending()).toBe(0);
      const callsAfter = r.fake.calls.length;
      r.stdin.write(JSON.stringify(open1(4)) + "\n");
      await flush();
      expect(r.fake.calls.length).toBe(callsAfter);
      expect(r.errText()).toMatch(/uniview-mcp: stdout/);
    });
  }

  it("a failing stdout before any bridge connection also resolves (nothing to close)", async () => {
    // Mutation: assuming a bridge exists when shutting down
    const r = rig();
    await handshake(r.stdin);
    r.stdout.emit("error", new Error("gone"));
    r.stdin.write(ping(1) + "\n");
    await Promise.race([r.done, new Promise((_, rej) => setTimeout(() => rej(new Error("runMcp did not resolve")), 3000))]);
    expect(r.fake.closes).toBe(0);
  });

  it("a healthy stdout is not treated as a failure (no spurious shutdown)", async () => {
    // Mutation: shutting down on every write callback
    const r = rig();
    await connected(r);
    r.stdin.write(ping(5) + "\n");
    await flush();
    expect(r.settled.value).toBe(false);
    expect(r.written.at(-1)).toBe('{"jsonrpc":"2.0","id":5,"result":{}}\n');
    r.stdin.end();
    await r.done;
  });
});

describe("MCP strict waitSeconds", () => {
  const bad: unknown[] = [null, 1.5, "5", -1, 3601, true, [], {}, 1e21, "3600"];
  it("anything but an integer from 0 to 3600 is -32602 and reaches no bridge call", async () => {
    // Mutation: ?? 0 letting null through, or a loose range/type check
    const s = startServer({ clock: createFakeClock() });
    await s.initialize();
    for (const [i, v] of bad.entries()) {
      s.send(toolCall(i + 1, "request_review", { receiptText: validReceipt(), waitSeconds: v }));
      const r = await s.nextJson();
      expect(r.error?.code, JSON.stringify(v)).toBe(-32602);
      expect(r.error.message).toMatch(/waitSeconds must be an integer from 0 to 3600/);
    }
    expect(s.fake.calls.filter((c) => c.method !== "mcp.hello")).toEqual([]);
    await s.end();
  });

  it("the limits themselves are accepted: 0 and 3600", async () => {
    // Mutation: an off-by-one at either end
    const s = startServer({ clock: createFakeClock() });
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptText: validReceipt(), waitSeconds: 0 }));
    expect((await s.nextJson()).result.structuredContent.status).toBe("pending");
    s.send(toolCall(2, "request_review", { receiptText: validReceipt("approved-now"), waitSeconds: 3600 }));
    expect((await s.nextJson()).result.structuredContent.status).toBe("decided");
    await s.end();
  });

  it("an omitted waitSeconds still means 0", async () => {
    // Mutation: requiring the field
    const s = startServer({ clock: createFakeClock() });
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptText: validReceipt() }));
    expect((await s.nextJson()).result.structuredContent.status).toBe("pending");
    await s.end();
  });
});

describe("MCP hostile tool names", () => {
  it("a tools/call name that is not a string is -32602, never -32603 (no throw while describing it)", async () => {
    // Mutation: String(params.name) on an object whose toString is not callable
    const s = startServer();
    await s.initialize();
    const names = ['{"toString":0}', '{"toString":null,"valueOf":null}', "[]", '[{"toString":0}]', "5", "null", "true", '{"__proto__":1}', '{"name":"open_files"}', '"constructor"', '"__proto__"', '"toString"'];
    for (const [i, raw] of names.entries()) {
      s.send(`{"jsonrpc":"2.0","id":${i + 1},"method":"tools/call","params":{"name":${raw},"arguments":{}}}`);
      const r = await s.nextJson();
      expect(r.error?.code, raw).toBe(-32602);
      expect(r.id).toBe(i + 1);
    }
    s.send(open1(100));
    expect((await s.nextJson()).result.structuredContent).toEqual({ opened: 1 });
    await s.end();
  });

  it("a very long unknown tool name is not echoed in full", async () => {
    // Mutation: reflecting an unbounded agent string in the error message
    const s = startServer();
    await s.initialize();
    s.send(toolCall(1, "x".repeat(100_000), {}));
    const r = await s.nextJson();
    expect(r.error.code).toBe(-32602);
    expect(r.error.message.length).toBeLessThan(200);
    await s.end();
  });
});

describe("MCP shutdown cancels request-guard timers", () => {
  it("ending stdin while a non-wait bridge request is stuck leaves no timer registered", async () => {
    // Mutation: the 30 s request guard staying registered after shutdown (it would keep a real process alive)
    const clock = createFakeClock();
    let closes = 0;
    const s = startServer({
      clock,
      connect: async () => ({
        request: async (m: string) => (m === "mcp.hello" ? { result: {} } : new Promise(() => {})),
        close: async () => void closes++,
      }),
    });
    await s.initialize();
    s.send(open1(1));
    await flush();
    expect(clock.pending()).toBeGreaterThan(0);
    await s.end();
    expect(closes).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("ending stdin while a connect attempt is stuck leaves no timer registered", async () => {
    // Mutation: the connect+hello deadline staying registered after shutdown
    const clock = createFakeClock();
    const s = startServer({ clock, connect: () => new Promise(() => {}) });
    await s.initialize();
    s.send(open1(1));
    await flush();
    expect(clock.pending()).toBeGreaterThan(0);
    await s.end();
    expect(clock.pending()).toBe(0);
  });

  it("ending stdin while the cold-start backoff sleeps leaves no timer registered", async () => {
    // Mutation: the backoff sleep timer staying registered after shutdown
    const clock = createFakeClock();
    const s = startServer({ clock, connect: async () => { throw new Error("ECONNREFUSED"); }, startApp: async () => {} });
    await s.initialize();
    s.send(open1(1));
    await flush();
    expect(clock.pending()).toBeGreaterThan(0);
    await s.end();
    expect(clock.pending()).toBe(0);
  });

  it("ending stdin during a review wait leaves no timer registered", async () => {
    // Mutation: the waitSeconds + grace guard staying registered after shutdown
    const clock = createFakeClock();
    const s = startServer({ clock });
    await s.initialize();
    s.send(wait(1, 600));
    await flush();
    expect(clock.pending()).toBeGreaterThan(0);
    await s.end();
    expect(clock.pending()).toBe(0);
  });
});

describe("MCP held-input bound", () => {
  /** A stdout that stops completing writes (a reader that never drains) once `state.flowing` is false. */
  function stuckStdout() {
    const held: Array<() => void> = [];
    const state = { flowing: true };
    const written: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _enc, cb) {
        written.push(chunk.toString("utf8"));
        if (state.flowing) cb();
        else held.push(cb);
      },
    });
    return { stream, state, written, release: () => { state.flowing = true; held.splice(0).forEach((cb) => cb()); } };
  }

  function setup(opts: Record<string, unknown>) {
    const stdin = new PassThrough();
    const out = stuckStdout();
    const stderr = new PassThrough();
    let errText = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (c: string) => (errText += c));
    const fake = createFakeBridge();
    const done: Promise<void> = runMcp({ stdin, stdout: out.stream, stderr, connect: fake.connect, ...opts });
    return { stdin, out, fake, done, errText: () => errText };
  }

  it("states the default caps", () => {
    // Mutation: changing or dropping the caps
    expect(MCP_LIMITS.MAX_QUEUED_INPUT_LINES).toBe(100_000);
    expect(MCP_LIMITS.MAX_QUEUED_INPUT_BYTES).toBe(32 * 1024 * 1024);
    expect(MCP_LIMITS.MAX_INFLIGHT_CALLS).toBe(15);
  });

  it("limit: exactly the cap of lines may wait behind a stuck reader; one more closes with a stderr message", async () => {
    // Mutation: unbounded held input (a client can fill memory while stdout is not draining) or an off-by-one cap
    const ok = setup({ maxQueuedInputLines: 5 });
    await handshake(ok.stdin);
    ok.out.state.flowing = false;
    // The first line is answered (and blocks stdin); five more are held.
    ok.stdin.write(Array.from({ length: 6 }, (_, i) => ping(i + 1)).join("\n") + "\n");
    await flush();
    expect(ok.errText()).toBe("");
    ok.out.release();
    await flush();
    expect(ok.out.written.filter((l) => l.includes('"result":{}'))).toHaveLength(6);
    ok.stdin.end();
    await ok.done;

    const over = setup({ maxQueuedInputLines: 5 });
    await handshake(over.stdin);
    over.out.state.flowing = false;
    over.stdin.write(Array.from({ length: 7 }, (_, i) => ping(i + 1)).join("\n") + "\n");
    await Promise.race([over.done, new Promise((_, rej) => setTimeout(() => rej(new Error("server did not close")), 3000))]);
    expect(over.errText()).toContain("uniview-mcp: input backlog larger than 5 lines; closing");
  });

  it("limit: the byte cap counts held lines; at the cap they wait, one byte over closes", async () => {
    // Mutation: counting lines only, or an off-by-one on bytes
    const line = (id: number) => ping(id);
    const size = Buffer.byteLength(line(1));
    const ok = setup({ maxQueuedInputBytes: size * 3 });
    await handshake(ok.stdin);
    ok.out.state.flowing = false;
    ok.stdin.write(Array.from({ length: 4 }, (_, i) => line(i + 1)).join("\n") + "\n"); // 1 answered, 3 held = exactly the cap
    await flush();
    expect(ok.errText()).toBe("");
    ok.out.release();
    await flush();
    ok.stdin.end();
    await ok.done;

    const over = setup({ maxQueuedInputBytes: size * 3 - 1 });
    await handshake(over.stdin);
    over.out.state.flowing = false;
    over.stdin.write(Array.from({ length: 4 }, (_, i) => line(i + 1)).join("\n") + "\n");
    await Promise.race([over.done, new Promise((_, rej) => setTimeout(() => rej(new Error("server did not close")), 3000))]);
    expect(over.errText()).toContain(`uniview-mcp: input backlog larger than ${size * 3 - 1} bytes; closing`);
  });

  it("held lines are released from the count as they are processed (a long conversation is not capped)", async () => {
    // Mutation: never decrementing the held counters
    const r = setup({ maxQueuedInputLines: 2 });
    await handshake(r.stdin);
    for (let round = 0; round < 10; round++) {
      r.out.state.flowing = false;
      r.stdin.write([ping(round * 10 + 1), ping(round * 10 + 2), ping(round * 10 + 3)].join("\n") + "\n");
      await flush();
      r.out.release();
      await flush();
    }
    expect(r.errText()).toBe("");
    expect(r.out.written.filter((l) => l.includes('"result":{}'))).toHaveLength(30);
    r.stdin.end();
    await r.done;
  });
});

describe("MCP keeps one bridge slot free for review.cancelWait", () => {
  /** A bridge that, like the real one, answers `busy` once 16 requests are in flight (cancelWait included). */
  function strictBridge() {
    let inflight = 0;
    const waits = new Map<string, (v: unknown) => void>();
    const log: string[] = [];
    let n = 0;
    const client = {
      async request(method: string, params: any = {}) {
        if (method === "mcp.hello") return { result: {} };
        if (inflight >= 16) {
          log.push(`busy:${method}`);
          throw Object.assign(new Error("busy"), { code: "busy" });
        }
        inflight++;
        try {
          if (method === "review.open") return { result: { reviewId: String(++n).padStart(32, "0") } };
          if (method === "review.wait") return await new Promise((resolve) => waits.set(params.reviewId, resolve));
          if (method === "review.cancelWait") {
            log.push("cancelWait");
            waits.get(params.reviewId)?.({ result: { status: "pending" } });
            waits.delete(params.reviewId);
            return { result: {} };
          }
          return { result: {} };
        } finally {
          inflight--;
        }
      },
      async close() {},
    };
    return { client, log };
  }

  it("a 16th tool call is answered busy by the server itself, and cancelling a wait still reaches the app", async () => {
    // Mutation: admitting 16 tool calls, which leaves no room for the cancel on the 16-request bridge
    const bridge = strictBridge();
    const clock = createFakeClock();
    const s = startServer({ clock, connect: async () => bridge.client });
    await s.initialize();
    for (let i = 1; i <= 16; i++) s.send(wait(i));
    const sixteenth = await s.nextJson();
    expect(sixteenth.id).toBe(16);
    expect(sixteenth.result.structuredContent.code).toBe("busy");
    await flush();
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await flush();
    await flush();
    expect(bridge.log).toEqual(["cancelWait"]);
    await s.end();
  });
});
