import { validateViewSpec } from "../../shared/viewspec.mjs";
import { validateReceipt } from "../../shared/receipt.mjs";

/**
 * Hand-written minimal MCP stdio server (P17a). Newline-delimited JSON-RPC 2.0
 * on stdin/stdout; every tool call is forwarded to UniView over the local
 * bridge. The app is the authority for paths, approval and reviews: whenever it
 * answers a request with a bridge error code (for example `not_allowed` while
 * the person has not approved this agent) that code becomes the tool error.
 *
 * Bridge methods used (params in the frame header, documents as raw body bytes):
 *   mcp.hello         {client: {name, version}, protocolVersion}  once per connection
 *   open              {}  body = UTF-8 JSON array of paths       -> {opened}
 *   view.show         {path} | {inline: true} + body = spec bytes  -> {scopeId}
 *   review.open       {path} | {inline: true} + body = receipt bytes -> {reviewId}
 *   review.wait       {reviewId, timeoutMs}  -> {status: "decided", decision} | {status: "pending"}
 *   review.cancelWait {reviewId}             ends a wait early; the review stays open
 *   review.get        {reviewId}             -> {status: "decided", decision} | {status: "pending"}
 */

export const MCP_LIMITS = Object.freeze({
  MAX_LINE_BYTES: 16 * 1024 * 1024,
  MAX_TEXT_BYTES: 2 * 1024 * 1024,
  MAX_PATHS: 20,
  MAX_PATH_LENGTH: 4096,
  MAX_WAIT_SECONDS: 3600,
  MAX_REVIEW_ID_LENGTH: 128,
  CONNECT_DEADLINE_MS: 15_000,
  WAIT_GRACE_MS: 10_000,
  MAX_CLIENT_NAME_LENGTH: 80,
  MAX_CLIENT_VERSION_LENGTH: 40,
});

export const LATEST_PROTOCOL = "2025-06-18";
export const SUPPORTED_PROTOCOLS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const NOT_INITIALIZED = -32002;

export const TOOL_ERROR_MESSAGES = Object.freeze({
  not_allowed: "The person has not allowed this agent to use UniView.",
  bad_path: "UniView refused a path; it must be an absolute path to a local regular file.",
  invalid_spec: "The view spec is not valid.",
  invalid_receipt: "The review receipt is not valid.",
  busy: "UniView is busy; try again later.",
  app_unavailable: "UniView is not reachable.",
  not_found: "No review with that id belongs to this session.",
  timeout: "UniView did not answer in time.",
});

class ToolFailure extends Error {
  constructor(code, message = TOOL_ERROR_MESSAGES[code]) {
    super(message);
    this.code = code;
  }
}

class ParamsError extends Error {}

const SUPPRESS = Symbol("suppress");

const DECISION_OUTPUT_SCHEMA = {
  type: "object",
  required: ["uniview", "reviewId", "receiptDigest", "decision", "comment", "decidedAt", "verifiedAt", "persisted", "files"],
  properties: {
    uniview: { const: "decision/1" },
    reviewId: { type: "string" },
    receiptDigest: { type: "string" },
    decision: { enum: ["approved", "changes_requested", "dismissed"] },
    comment: { type: "string" },
    decidedAt: { type: "string" },
    verifiedAt: { type: "string" },
    persisted: { type: "boolean" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "expectedSha256", "observedSha256", "state"],
        properties: {
          path: { type: "string" },
          expectedSha256: { type: "string" },
          observedSha256: { type: ["string", "null"] },
          state: { enum: ["unchanged", "changed", "replaced", "missing", "unreadable", "too_large"] },
        },
      },
    },
  },
};

// Tool errors carry structuredContent too, so each output schema also admits the error shape.
const ERROR_OUTPUT_SCHEMA = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { enum: Object.keys(TOOL_ERROR_MESSAGES) },
    message: { type: "string" },
  },
  additionalProperties: false,
};

function outputSchema(...shapes) {
  return { type: "object", anyOf: [...shapes, ERROR_OUTPUT_SCHEMA] };
}

const PATH_SCHEMA = { type: "string", minLength: 1, maxLength: MCP_LIMITS.MAX_PATH_LENGTH };

// No top-level oneOf: several MCP clients reject it in input schemas. "Exactly one of"
// is stated in the descriptions and enforced here with -32602.
const TOOLS = [
  {
    name: "open_files",
    description: "Open local files in UniView tabs for the person to see. Paths must be absolute.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: PATH_SCHEMA, minItems: 1, maxItems: MCP_LIMITS.MAX_PATHS },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      type: "object",
      required: ["opened"],
      properties: { opened: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    }),
  },
  {
    name: "show_view",
    description: "Show a view spec (uniview view/1 JSON) in UniView. Give exactly one of specText (the spec itself, at most 2 MiB as UTF-8) or specPath (an absolute path to a .uview.json file).",
    inputSchema: {
      type: "object",
      properties: {
        specText: { type: "string" },
        specPath: PATH_SCHEMA,
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      type: "object",
      required: ["shown", "scopeId"],
      properties: { shown: { const: true }, scopeId: { type: "string" } },
      additionalProperties: false,
    }),
  },
  {
    name: "request_review",
    description: "Ask the person to review a receipt (uniview receipt/1 JSON) in UniView. Give exactly one of receiptText (at most 2 MiB as UTF-8) or receiptPath (an absolute path). waitSeconds (0 to 3600, default 0) waits for the decision; otherwise poll get_review with the returned reviewId.",
    inputSchema: {
      type: "object",
      properties: {
        receiptText: { type: "string" },
        receiptPath: PATH_SCHEMA,
        waitSeconds: { type: "integer", minimum: 0, maximum: MCP_LIMITS.MAX_WAIT_SECONDS, default: 0 },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema(
      {
        type: "object",
        required: ["status", "reviewId", "decision"],
        properties: { status: { const: "decided" }, reviewId: { type: "string" }, decision: DECISION_OUTPUT_SCHEMA },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["status", "reviewId"],
        properties: { status: { const: "pending" }, reviewId: { type: "string" } },
        additionalProperties: false,
      },
    ),
  },
  {
    name: "get_review",
    description: "Get the person's decision on a review this session requested.",
    inputSchema: {
      type: "object",
      properties: {
        reviewId: { type: "string", minLength: 1, maxLength: MCP_LIMITS.MAX_REVIEW_ID_LENGTH },
      },
      required: ["reviewId"],
      additionalProperties: false,
    },
    outputSchema: outputSchema(
      {
        type: "object",
        required: ["status", "decision"],
        properties: { status: { const: "decided" }, decision: DECISION_OUTPUT_SCHEMA },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["status"],
        properties: { status: { const: "pending" } },
        additionalProperties: false,
      },
    ),
  },
];

/**
 * Splits a byte stream into lines of at most `maxBytes` (excluding "\n" and a
 * trailing "\r"). A longer line is not buffered: it is reported once as
 * `{ tooLong: true }` when its newline (or the end of input) arrives.
 */
export class LineSplitter {
  constructor(maxBytes = MCP_LIMITS.MAX_LINE_BYTES) {
    this.maxBytes = maxBytes;
    this._chunks = [];
    this._size = 0;
    this._discarding = false;
  }

  /** @returns {Array<{ line: Buffer } | { tooLong: true }>} */
  push(chunk) {
    const out = [];
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      this._append(chunk.subarray(start, end));
      if (nl === -1) break;
      out.push(this._finish());
      start = nl + 1;
    }
    return out;
  }

  /** @returns {Array<{ line: Buffer } | { tooLong: true }>} */
  end() {
    if (this._discarding || this._size > 0) return [this._finish()];
    return [];
  }

  _append(part) {
    if (part.length === 0 || this._discarding) return;
    // One byte of slack for a "\r" that turns out to precede the newline.
    if (this._size + part.length > this.maxBytes + 1) {
      this._discarding = true;
      this._chunks = [];
      this._size = 0;
      return;
    }
    this._chunks.push(part);
    this._size += part.length;
  }

  _finish() {
    if (this._discarding) {
      this._discarding = false;
      return { tooLong: true };
    }
    let line = Buffer.concat(this._chunks, this._size);
    this._chunks = [];
    this._size = 0;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length > this.maxBytes) return { tooLong: true };
    return { line };
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isValidId(id) {
  return typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
}

function idKey(id) {
  return `${typeof id}:${id}`;
}

function cleanLabel(value, max) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").slice(0, max);
}

function checkKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ParamsError(`unknown argument "${key}"`);
  }
}

function checkPath(name, value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MCP_LIMITS.MAX_PATH_LENGTH) {
    throw new ParamsError(`${name} must be a string of 1 to ${MCP_LIMITS.MAX_PATH_LENGTH} characters`);
  }
}

function checkText(name, value) {
  if (typeof value !== "string") throw new ParamsError(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > MCP_LIMITS.MAX_TEXT_BYTES) {
    throw new ParamsError(`${name} is larger than ${MCP_LIMITS.MAX_TEXT_BYTES} bytes as UTF-8`);
  }
}

function exactlyOne(args, a, b) {
  if ((args[a] === undefined) === (args[b] === undefined)) {
    throw new ParamsError(`exactly one of ${a} or ${b} is required`);
  }
}

function describeErrors(errors) {
  const shown = errors.slice(0, 3).map((e) => `${e.path || "/"} ${e.code}: ${e.message}`);
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
  return `${shown.join("; ")}${more}`;
}

function toolFailureFrom(err) {
  if (err instanceof ToolFailure) return err;
  const code = err && typeof err.code === "string" && Object.hasOwn(TOOL_ERROR_MESSAGES, err.code) ? err.code : "app_unavailable";
  return new ToolFailure(code);
}

/**
 * Runs the MCP server until stdin ends.
 * @param {{
 *   stdin: import("node:stream").Readable,
 *   stdout: import("node:stream").Writable,
 *   stderr: import("node:stream").Writable,
 *   connect: () => Promise<{ request: (method: string, params?: any, body?: Buffer) => Promise<{ result: any, body?: Buffer }>, close: () => Promise<void> }>,
 *   startApp?: () => Promise<void> | void,
 *   clientInfo?: { name: string, version: string },
 *   clock?: { now: () => number, setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (h: any) => void },
 * }} options  clientInfo names this UniView build; it is reported as serverInfo in `initialize`.
 * @returns {Promise<void>}
 */
export function runMcp({
  stdin,
  stdout,
  stderr,
  connect,
  startApp,
  clientInfo = { name: "UniView", version: "0.0.0" },
  clock = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
}) {
  const splitter = new LineSplitter();
  /** "new" -> "initializing" (initialize answered) -> "ready" (notifications/initialized) */
  let phase = "new";
  let revision = LATEST_PROTOCOL;
  let agent = { name: "", version: "" };
  let closed = false;
  let bridge = null;
  let connecting = null;
  const inflight = new Map();

  const sleep = (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms));

  function log(message) {
    try {
      stderr.write(`uniview-mcp: ${message}\n`);
    } catch {}
  }

  function send(message) {
    if (closed) return;
    try {
      stdout.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      log(`stdout write failed: ${err?.message}`);
    }
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function toolResult(value) {
    const content = [{ type: "text", text: JSON.stringify(value) }];
    return revision === LATEST_PROTOCOL ? { content, structuredContent: value } : { content };
  }

  function toolError(code, message) {
    const content = [{ type: "text", text: `${code}: ${message}` }];
    return revision === LATEST_PROTOCOL
      ? { content, structuredContent: { code, message }, isError: true }
      : { content, isError: true };
  }

  async function connectOnce() {
    try {
      return await connect();
    } catch (err) {
      log(`bridge connect failed: ${err?.code || err?.message || err}`);
      return null;
    }
  }

  async function connectWithStart() {
    const first = await connectOnce();
    if (first) return first;
    if (!startApp) throw new ToolFailure("app_unavailable");
    try {
      await startApp();
    } catch (err) {
      log(`starting UniView failed: ${err?.message || err}`);
      throw new ToolFailure("app_unavailable");
    }
    const start = clock.now();
    let delay = 100;
    for (;;) {
      const left = MCP_LIMITS.CONNECT_DEADLINE_MS - (clock.now() - start);
      if (left <= 0) throw new ToolFailure("app_unavailable");
      await sleep(Math.min(delay, left));
      const b = await connectOnce();
      if (b) return b;
      delay = Math.min(delay * 2, 1000);
    }
  }

  async function openBridge() {
    const b = await connectWithStart();
    try {
      await b.request("mcp.hello", { client: agent, protocolVersion: revision });
    } catch (err) {
      b.close().catch(() => {});
      throw toolFailureFrom(err);
    }
    if (closed) {
      b.close().catch(() => {});
      throw new ToolFailure("app_unavailable");
    }
    return b;
  }

  function getBridge() {
    if (bridge) return Promise.resolve(bridge);
    if (!connecting) {
      connecting = openBridge().then(
        (b) => {
          connecting = null;
          bridge = b;
          return b;
        },
        (err) => {
          connecting = null;
          throw err;
        },
      );
    }
    return connecting;
  }

  async function call(method, params, body) {
    const b = await getBridge();
    try {
      const res = await b.request(method, params, body);
      return isPlainObject(res?.result) ? res.result : {};
    } catch (err) {
      if (err?.code === "closed" && bridge === b) {
        // The session is gone (app closed or restarted); the next call opens a new one.
        bridge = null;
        b.close().catch(() => {});
      }
      throw toolFailureFrom(err);
    }
  }

  function expectString(v) {
    if (typeof v !== "string" || v.length === 0) throw new ToolFailure("app_unavailable", "UniView sent an unexpected answer.");
    return v;
  }

  function reviewOutcome(result) {
    if (result.status === "decided" && isPlainObject(result.decision)) return { status: "decided", decision: result.decision };
    if (result.status === "pending") return { status: "pending" };
    throw new ToolFailure("app_unavailable", "UniView sent an unexpected answer.");
  }

  const handlers = {
    async open_files(args) {
      checkKeys(args, ["paths"]);
      const { paths } = args;
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > MCP_LIMITS.MAX_PATHS) {
        throw new ParamsError(`paths must be an array of 1 to ${MCP_LIMITS.MAX_PATHS} strings`);
      }
      paths.forEach((p, i) => checkPath(`paths[${i}]`, p));
      return async () => {
        const result = await call("open", {}, Buffer.from(JSON.stringify(paths), "utf8"));
        if (!Number.isInteger(result.opened) || result.opened < 0) throw new ToolFailure("app_unavailable", "UniView sent an unexpected answer.");
        return { opened: result.opened };
      };
    },

    async show_view(args) {
      checkKeys(args, ["specText", "specPath"]);
      exactlyOne(args, "specText", "specPath");
      if (args.specPath !== undefined) checkPath("specPath", args.specPath);
      else checkText("specText", args.specText);
      return async () => {
        let result;
        if (args.specPath !== undefined) {
          result = await call("view.show", { path: args.specPath });
        } else {
          const checked = await validateViewSpec(args.specText);
          if (!checked.ok) throw new ToolFailure("invalid_spec", `${TOOL_ERROR_MESSAGES.invalid_spec} ${describeErrors(checked.errors)}`);
          result = await call("view.show", { inline: true }, Buffer.from(args.specText, "utf8"));
        }
        return { shown: true, scopeId: expectString(result.scopeId) };
      };
    },

    async request_review(args, entry) {
      checkKeys(args, ["receiptText", "receiptPath", "waitSeconds"]);
      exactlyOne(args, "receiptText", "receiptPath");
      if (args.receiptPath !== undefined) checkPath("receiptPath", args.receiptPath);
      else checkText("receiptText", args.receiptText);
      const waitSeconds = args.waitSeconds ?? 0;
      if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MCP_LIMITS.MAX_WAIT_SECONDS) {
        throw new ParamsError(`waitSeconds must be an integer from 0 to ${MCP_LIMITS.MAX_WAIT_SECONDS}`);
      }
      return async () => {
        let opened;
        if (args.receiptPath !== undefined) {
          opened = await call("review.open", { path: args.receiptPath });
        } else {
          const checked = await validateReceipt(args.receiptText);
          if (!checked.ok) throw new ToolFailure("invalid_receipt", `${TOOL_ERROR_MESSAGES.invalid_receipt} ${describeErrors(checked.errors)}`);
          opened = await call("review.open", { inline: true }, Buffer.from(args.receiptText, "utf8"));
        }
        const reviewId = expectString(opened.reviewId);
        if (entry.cancelled) return SUPPRESS;
        if (waitSeconds === 0) return { status: "pending", reviewId };

        const timeoutMs = waitSeconds * 1000;
        let timer;
        const stop = new Promise((resolve) => {
          entry.cancel = () => resolve("cancelled");
          timer = clock.setTimeout(() => resolve("timeout"), timeoutMs + MCP_LIMITS.WAIT_GRACE_MS);
        });
        const waited = call("review.wait", { reviewId, timeoutMs });
        waited.catch(() => {});
        const outcome = await Promise.race([waited, stop]).finally(() => {
          clock.clearTimeout(timer);
          entry.cancel = null;
        });
        if (outcome === "cancelled" || outcome === "timeout") {
          // Only the wait ends; the review stays open for the person.
          const b = bridge;
          if (b) b.request("review.cancelWait", { reviewId }).catch(() => {});
          if (outcome === "cancelled") return SUPPRESS;
          throw new ToolFailure("timeout");
        }
        const done = reviewOutcome(outcome);
        return done.status === "decided" ? { status: "decided", reviewId, decision: done.decision } : { status: "pending", reviewId };
      };
    },

    async get_review(args) {
      checkKeys(args, ["reviewId"]);
      const { reviewId } = args;
      if (typeof reviewId !== "string" || reviewId.length < 1 || reviewId.length > MCP_LIMITS.MAX_REVIEW_ID_LENGTH) {
        throw new ParamsError(`reviewId must be a string of 1 to ${MCP_LIMITS.MAX_REVIEW_ID_LENGTH} characters`);
      }
      return async () => reviewOutcome(await call("review.get", { reviewId }));
    },
  };

  async function toolsCall(id, params) {
    const key = idKey(id);
    const entry = { cancelled: false, cancel: null, tool: params.name };
    inflight.set(key, entry);
    try {
      let run;
      try {
        if (typeof params.name !== "string" || !Object.hasOwn(handlers, params.name)) {
          throw new ParamsError(`unknown tool ${JSON.stringify(String(params.name))}`);
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isPlainObject(args)) throw new ParamsError("arguments must be an object");
        run = await handlers[params.name](args, entry);
      } catch (err) {
        if (err instanceof ParamsError) {
          fail(id, INVALID_PARAMS, `Invalid params: ${err.message}`);
          return;
        }
        throw err;
      }
      let result;
      try {
        const value = await run();
        if (value === SUPPRESS) return;
        result = toolResult(value);
      } catch (err) {
        const failure = toolFailureFrom(err);
        if (!(err instanceof ToolFailure) && !err?.code) log(`tool ${params.name} failed: ${err?.message || err}`);
        result = toolError(failure.code, failure.message);
      }
      if (!entry.cancelled) reply(id, result);
    } finally {
      inflight.delete(key);
    }
  }

  function handleCancelled(params) {
    if (!isPlainObject(params) || !isValidId(params.requestId)) return;
    const entry = inflight.get(idKey(params.requestId));
    if (!entry || entry.tool !== "request_review") return;
    entry.cancelled = true;
    if (entry.cancel) entry.cancel();
  }

  function handleMessage(msg) {
    if (!isPlainObject(msg)) {
      fail(null, INVALID_REQUEST, "Invalid Request");
      return;
    }
    const hasId = Object.hasOwn(msg, "id");
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || (hasId && !isValidId(msg.id))) {
      // A response from the client (we never send requests) is ignored.
      if (msg.jsonrpc === "2.0" && msg.method === undefined && hasId && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) return;
      fail(hasId && isValidId(msg.id) ? msg.id : null, INVALID_REQUEST, "Invalid Request");
      return;
    }
    if (msg.params !== undefined && !isPlainObject(msg.params)) {
      if (hasId) fail(msg.id, INVALID_PARAMS, "Invalid params: params must be an object");
      return;
    }
    const params = msg.params ?? {};

    if (!hasId) {
      if (msg.method === "notifications/initialized") {
        if (phase === "initializing") phase = "ready";
      } else if (msg.method === "notifications/cancelled") {
        handleCancelled(params);
      }
      return;
    }

    const { id, method } = msg;
    if (inflight.has(idKey(id))) {
      fail(id, INVALID_REQUEST, "Invalid Request: id is already in use");
      return;
    }
    if (method === "ping") {
      reply(id, {});
      return;
    }
    if (method === "initialize") {
      if (phase !== "new") {
        fail(id, INVALID_REQUEST, "Invalid Request: already initialized");
        return;
      }
      if (typeof params.protocolVersion !== "string") {
        fail(id, INVALID_PARAMS, "Invalid params: protocolVersion must be a string");
        return;
      }
      revision = SUPPORTED_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL;
      const info = isPlainObject(params.clientInfo) ? params.clientInfo : {};
      agent = {
        name: cleanLabel(info.name, MCP_LIMITS.MAX_CLIENT_NAME_LENGTH),
        version: cleanLabel(info.version, MCP_LIMITS.MAX_CLIENT_VERSION_LENGTH),
      };
      phase = "initializing";
      reply(id, {
        protocolVersion: revision,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: clientInfo.name, version: clientInfo.version },
      });
      return;
    }
    if (phase !== "ready") {
      fail(id, NOT_INITIALIZED, "Server not initialized");
      return;
    }
    if (method === "tools/list") {
      const tools = TOOLS.map(({ outputSchema: out, ...tool }) => (revision === LATEST_PROTOCOL ? { ...tool, outputSchema: out } : tool));
      reply(id, { tools });
      return;
    }
    if (method === "tools/call") {
      toolsCall(id, params).catch((err) => {
        log(`tools/call crashed: ${err?.message || err}`);
        fail(id, -32603, "Internal error");
      });
      return;
    }
    fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  function handleLine(item) {
    if ("tooLong" in item) {
      fail(null, INVALID_REQUEST, `Invalid Request: line longer than ${MCP_LIMITS.MAX_LINE_BYTES} bytes`);
      return;
    }
    if (item.line.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(utf8.decode(item.line));
    } catch {
      fail(null, PARSE_ERROR, "Parse error");
      return;
    }
    handleMessage(msg);
  }

  return new Promise((resolve) => {
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      for (const item of splitter.end()) handleLine(item);
      closed = true;
      for (const entry of inflight.values()) {
        entry.cancelled = true;
        if (entry.cancel) entry.cancel();
      }
      const b = bridge;
      bridge = null;
      Promise.resolve(b?.close()).catch(() => {}).then(() => resolve());
    }
    stdin.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const item of splitter.push(buf)) handleLine(item);
    });
    stdin.once("end", finish);
    stdin.once("close", finish);
    stdin.once("error", (err) => {
      log(`stdin error: ${err?.message || err}`);
      finish();
    });
  });
}
