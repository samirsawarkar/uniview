import { PassThrough } from "node:stream";

// @ts-expect-error plain ESM module without types
import { BridgeError } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { runMcp } from "../../electron/lib/mcp-server.mjs";

export interface BridgeCall {
  method: string;
  params: any;
  body?: Buffer;
}

export interface FakeBridge {
  calls: BridgeCall[];
  connects: number;
  closes: number;
  connect: () => Promise<any>;
}

export const decisionFor = (reviewId: string) => ({
  uniview: "decision/1",
  reviewId,
  receiptDigest: "a".repeat(64),
  decision: "approved",
  comment: "Looks good",
  decidedAt: "2026-10-24T10:00:00.000Z",
  verifiedAt: "2026-10-24T10:00:00.000Z",
  persisted: true,
  files: [{ path: "C:\\work\\a.txt", expectedSha256: "b".repeat(64), observedSha256: "b".repeat(64), state: "unchanged" }],
});

/**
 * Deterministic stand-in for the app's side of the bridge. Behaviour is chosen by
 * marker words in paths: "not-allowed", "bad", "busy", "timeout", "gone" (the
 * connection drops), "approved" (the review is decided at once).
 */
export function createFakeBridge(): FakeBridge {
  const fake: FakeBridge = {
    calls: [],
    connects: 0,
    closes: 0,
    connect: async () => {
      fake.connects++;
      return client;
    },
  };
  let nextReview = 1;
  let nextScope = 1;
  const reviews = new Map<string, { decided: boolean }>();
  const waits = new Map<string, (v: any) => void>();

  function byMarker(path: string): void {
    if (path.includes("not-allowed")) throw new BridgeError("not_allowed");
    if (path.includes("bad")) throw new BridgeError("bad_path");
    if (path.includes("busy")) throw new BridgeError("busy");
    if (path.includes("timeout")) throw new BridgeError("timeout");
    if (path.includes("gone")) throw new BridgeError("closed");
  }

  const client = {
    sessionId: "f".repeat(32),
    async request(method: string, params: any = {}, body?: Buffer) {
      fake.calls.push({ method, params, body });
      switch (method) {
        case "mcp.hello":
          return { result: {} };
        case "open": {
          const paths: string[] = JSON.parse(body!.toString("utf8"));
          paths.forEach(byMarker);
          return { result: { opened: paths.length } };
        }
        case "view.show":
          if (params.path) byMarker(params.path);
          return { result: { scopeId: `scope-${nextScope++}` } };
        case "review.open": {
          if (params.path) byMarker(params.path);
          const reviewId = String(nextReview++).padStart(32, "0");
          // A path containing "approved", or an inline receipt whose text contains "approved-now", is decided at once.
          reviews.set(reviewId, { decided: Boolean(params.path?.includes("approved") || body?.toString("utf8").includes("approved-now")) });
          return { result: { reviewId } };
        }
        case "review.wait": {
          const r = reviews.get(params.reviewId);
          if (!r) throw new BridgeError("not_found");
          if (r.decided) return { result: { status: "decided", decision: decisionFor(params.reviewId) } };
          return new Promise((resolve) => waits.set(params.reviewId, resolve));
        }
        case "review.cancelWait": {
          waits.get(params.reviewId)?.({ result: { status: "pending" } });
          waits.delete(params.reviewId);
          return { result: {} };
        }
        case "review.get": {
          const r = reviews.get(params.reviewId);
          if (!r) throw new BridgeError("not_found");
          return { result: r.decided ? { status: "decided", decision: decisionFor(params.reviewId) } : { status: "pending" } };
        }
        default:
          throw new BridgeError("bad_frame");
      }
    },
    async close() {
      fake.closes++;
    },
  };
  return fake;
}

/** A clock whose timers only fire when the test advances it. */
export function createFakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Advances time, firing due timers in order and letting promise callbacks run between them. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await flush();
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
      await flush();
    },
  };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export function startServer(options: Record<string, unknown> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  let partial = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (s: string) => {
    partial += s;
    let nl;
    while ((nl = partial.indexOf("\n")) !== -1) {
      lines.push(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  let errText = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (s: string) => (errText += s));

  const fake = createFakeBridge();
  const done: Promise<void> = runMcp({
    stdin,
    stdout,
    stderr,
    connect: fake.connect,
    clientInfo: { name: "UniView", version: "1.0.0" },
    ...options,
  });

  return {
    fake,
    stdin,
    lines,
    stderr: () => errText,
    partial: () => partial,
    done,
    send(msg: unknown) {
      stdin.write(typeof msg === "string" ? `${msg}\n` : `${JSON.stringify(msg)}\n`);
    },
    /** Resolves with the next output line, or rejects after `ms` of real time. */
    async next(ms = 5000): Promise<string> {
      const started = Date.now();
      while (lines.length === 0) {
        if (Date.now() - started > ms) throw new Error("no output line");
        await Promise.race([new Promise<void>((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 20))]);
      }
      return lines.shift()!;
    },
    async nextJson(ms?: number): Promise<any> {
      return JSON.parse(await this.next(ms));
    },
    async initialize(protocolVersion = "2025-06-18") {
      this.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "test-agent", version: "1" } } });
      await this.next();
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async end() {
      stdin.end();
      await done;
    },
  };
}

export function toolCall(id: number | string, name: string, args: unknown) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/**
 * A valid view spec of exactly `bytes` UTF-8 bytes whose code text is made of quotes,
 * backslashes and control characters, so JSON-escaping it for the MCP line expands it.
 */
export function escapeHeavySpec(bytes: number): string {
  const head = '{"uniview":"view/1","title":"escapes","body":[';
  const tail = "]}";
  const nodes: string[] = [];
  // Each code node text: 64 KiB of characters that all need escaping in JSON.
  const text = '"\\\u0001'.repeat(16 * 1024);
  const node = JSON.stringify({ type: "code", text });
  let size = Buffer.byteLength(head + tail);
  while (size + node.length + 1 < bytes - 64) {
    nodes.push(node);
    size += node.length + 1;
  }
  const spec = head + nodes.join(",") + tail;
  const pad = bytes - Buffer.byteLength(spec);
  // JSON whitespace before the closing brace brings the document to the exact size.
  return spec.slice(0, -1) + " ".repeat(pad) + "}";
}

/** A tools/call line of exactly `bytes` bytes (before "\n"), padded with JSON whitespace. */
export function paddedLine(msg: unknown, bytes: number): string {
  const json = JSON.stringify(msg);
  const pad = bytes - Buffer.byteLength(json);
  if (pad < 0) throw new Error("message larger than requested line");
  return json.slice(0, -1) + " ".repeat(pad) + "}";
}

/** A valid receipt/1 document (compact JSON) with the given task and summary. */
export function validReceipt(task = "Add a feature", summary = "Implemented it.", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    uniview: "receipt/1",
    createdAt: "2026-10-24T00:00:00.000Z",
    agent: { name: "transcript-agent" },
    task,
    summary,
    files: [{ path: "C:\\work\\a.txt", sha256: "0".repeat(63) + "1", role: "created" }],
    ...extra,
  });
}

/**
 * A VALID receipt of exactly `bytes` UTF-8 bytes whose summary and check evidence are made of
 * quotes, backslashes, newlines and control characters (each JSON-escaped to 2 to 6 bytes),
 * padded with JSON whitespace to the exact size.
 */
export function escapeHeavyReceipt(bytes: number): string {
  const unit = '"\\\u0001\n';
  const checks: unknown[] = [];
  const build = () => validReceipt("escape heavy", unit.repeat(60000), { checks });
  let text = build();
  for (;;) {
    checks.push({ name: `check ${checks.length}`, status: "pass", evidence: unit.repeat(4096) });
    const next = build();
    if (Buffer.byteLength(next) > bytes - 64 || checks.length >= 200) {
      checks.pop();
      break;
    }
    text = next;
  }
  const pad = bytes - Buffer.byteLength(text);
  if (pad < 0) throw new Error("receipt larger than requested size");
  return text.slice(0, -1) + " ".repeat(pad) + "}";
}
