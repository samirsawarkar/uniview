// `UniView open` command-line client (P16). Plain Node ESM without Electron imports:
// main.mjs injects the bridge connection and the app launcher.

import path from "node:path";

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  CHANGES_REQUESTED: 3,
  DISMISSED: 4,
  TIMEOUT: 5,
  UNREACHABLE: 6,
});

export const DEFAULT_TIMEOUT_S = 3600;
/** Largest whole-second delay setTimeout can hold (2^31 - 1 ms); longer ones fire at once. */
export const MAX_TIMEOUT_S = Math.floor(0x7fffffff / 1000);
/** Same limit as the bridge path policy (rule 1), checked on the resolved path. */
export const MAX_CLI_PATH = 4096;
export const COLD_START_MS = 15000;
const BACKOFF_START_MS = 100;
const BACKOFF_MAX_MS = 1000;

export const USAGE = "Usage: UniView open [--wait [--timeout <s>]] [--receipt <file>] [--view <file>] [--] <file>...";

const DECISION_EXIT = {
  approved: EXIT.OK,
  changes_requested: EXIT.CHANGES_REQUESTED,
  dismissed: EXIT.DISMISSED,
};

/** Bridge errors that mean the request itself was wrong, not that the app is unavailable. */
const USAGE_ERROR_CODES = new Set(["bad_path", "invalid_receipt", "invalid_spec", "too_large"]);

/**
 * Resolves one CLI path against the CLI's cwd (path policy rule 1, CLI side).
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function resolvePath(raw, cwd) {
  if (raw.length === 0) return { ok: false, error: "empty path" };
  if (/[\u0000-\u001F\u007F]/.test(raw)) return { ok: false, error: `control character in path ${JSON.stringify(raw)}` };
  const resolved = path.resolve(cwd, raw);
  if (resolved.length > MAX_CLI_PATH) return { ok: false, error: `path longer than ${MAX_CLI_PATH} characters: ${raw.slice(0, 80)}...` };
  return { ok: true, path: resolved };
}

/**
 * Parses `open [--wait [--timeout <s>]] [--receipt <file>] [--view <file>] [--] <file>...`.
 * @param {string[]} argv arguments after the executable (first one is the command)
 * @param {string} cwd absolute directory relative paths resolve against
 * @returns {{ ok: true, files: string[], receipt?: string, view?: string, wait: boolean, timeoutS: number }
 *   | { ok: false, error: string }}
 */
export function parseArgs(argv, cwd) {
  if (argv.length === 0) return { ok: false, error: "missing command (expected 'open')" };
  if (argv[0] !== "open") return { ok: false, error: `unknown command '${argv[0]}'` };

  const rawFiles = [];
  /** @type {Record<string, string>} */
  const values = {};
  let wait = false;
  let flagsDone = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsDone || !arg.startsWith("-")) {
      rawFiles.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    if (arg === "--wait") {
      if (wait) return { ok: false, error: "--wait given twice" };
      wait = true;
      continue;
    }
    const m = /^(--receipt|--view|--timeout)(?:=(.*))?$/s.exec(arg);
    if (!m) return { ok: false, error: `unknown option '${arg}'` };
    const name = m[1];
    let value = m[2];
    if (value === undefined) {
      const next = argv[i + 1];
      // A dash-leading value is only taken in the = form, so `--receipt --wait` is not a path.
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === "") return { ok: false, error: `${name} needs a value` };
    if (name in values) return { ok: false, error: `${name} given twice` };
    values[name] = value;
  }

  let timeoutS = DEFAULT_TIMEOUT_S;
  if ("--timeout" in values) {
    if (!wait) return { ok: false, error: "--timeout requires --wait" };
    const t = values["--timeout"];
    const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
    if (!(n >= 1 && n <= MAX_TIMEOUT_S)) {
      return { ok: false, error: `--timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}` };
    }
    timeoutS = n;
  }
  if (wait && !("--receipt" in values)) return { ok: false, error: "--wait requires --receipt" };
  if (rawFiles.length === 0 && !("--receipt" in values) && !("--view" in values)) {
    return { ok: false, error: "nothing to open" };
  }

  const files = [];
  for (const raw of rawFiles) {
    const r = resolvePath(raw, cwd);
    if (!r.ok) return r;
    files.push(r.path);
  }
  /** @type {{ ok: true, files: string[], receipt?: string, view?: string, wait: boolean, timeoutS: number }} */
  const out = { ok: true, files, wait, timeoutS };
  for (const [flag, key] of [["--receipt", "receipt"], ["--view", "view"]]) {
    if (!(flag in values)) continue;
    const r = resolvePath(values[flag], cwd);
    if (!r.ok) return r;
    out[key] = r.path;
  }
  return out;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function errorCode(err) {
  return (err && typeof err.code === "string" && err.code) || "unknown";
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isOpenResult(r) {
  return !!r && typeof r === "object" && isStringArray(r.opened) && Array.isArray(r.failed) &&
    r.failed.every((f) => f && typeof f.path === "string" && typeof f.code === "string");
}

/**
 * Connects to the bridge; on failure starts the app once and polls with backoff
 * (100 ms doubling to 1 s) until COLD_START_MS have passed.
 * @returns {Promise<{ ok: true, client: any } | { ok: false, message: string }>}
 */
async function connectWithColdStart({ connect, startApp, now, sleep }) {
  const deadline = now() + COLD_START_MS;
  let delay = BACKOFF_START_MS;
  let started = false;
  for (;;) {
    let lastErr;
    try {
      return { ok: true, client: await connect() };
    } catch (err) {
      lastErr = err;
    }
    if (!started) {
      started = true;
      try {
        await startApp();
      } catch (err) {
        return { ok: false, message: `could not start the app (${err?.message || errorCode(err)})` };
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, message: `the app is not reachable (${errorCode(lastErr)})` };
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
}

/**
 * Runs `UniView open ...` and resolves with the process exit code.
 * @param {{
 *   argv: string[],
 *   cwd: string,
 *   stdout: { write(s: string): unknown },
 *   stderr: { write(s: string): unknown },
 *   connect: () => Promise<{ request(method: string, params?: any): Promise<{ result: any }>, close(): Promise<void> }>,
 *   startApp: () => Promise<void>,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
 * }} options
 * @returns {Promise<number>}
 */
export async function runCli({ argv, cwd, stdout, stderr, connect, startApp, now = Date.now, sleep = defaultSleep }) {
  const args = parseArgs(argv, cwd);
  if (!args.ok) {
    stderr.write(`UniView: ${args.error}\n${USAGE}\n`);
    return EXIT.USAGE;
  }

  const conn = await connectWithColdStart({ connect, startApp, now, sleep });
  if (!conn.ok) {
    stderr.write(`UniView: ${conn.message}\n`);
    return EXIT.UNREACHABLE;
  }
  const client = conn.client;

  const fail = (err) => {
    const code = errorCode(err);
    if (USAGE_ERROR_CODES.has(code)) {
      stderr.write(`UniView: request rejected: ${code}\n`);
      return EXIT.USAGE;
    }
    stderr.write(`UniView: the app is not reachable (${code})\n`);
    return EXIT.UNREACHABLE;
  };
  const unexpected = () => {
    stderr.write("UniView: unexpected response from the app\n");
    return EXIT.UNREACHABLE;
  };

  try {
    const params = { files: args.files };
    if (args.receipt !== undefined) params.receipt = args.receipt;
    if (args.view !== undefined) params.view = args.view;
    params.wait = args.wait;

    let result;
    try {
      ({ result } = await client.request("open", params));
    } catch (err) {
      return fail(err);
    }
    if (!isOpenResult(result)) return unexpected();

    const ackOut = args.wait ? stderr : stdout;
    const failed = result.failed.length > 0;
    if (result.opened.length > 0) {
      const tail = args.wait && !failed ? "; waiting for the review decision" : "";
      ackOut.write(`Opened in UniView: ${result.opened.join(", ")}${tail}\n`);
    }
    for (const f of result.failed) stderr.write(`UniView: cannot open ${f.path}: ${f.code}\n`);
    if (failed) return EXIT.USAGE;
    if (!args.wait) return EXIT.OK;

    if (typeof result.reviewId !== "string" || result.reviewId === "") return unexpected();

    const timer = new AbortController();
    const TIMED_OUT = Symbol("timeout");
    let outcome;
    try {
      outcome = await Promise.race([
        client.request("wait_review", { reviewId: result.reviewId }),
        sleep(args.timeoutS * 1000, timer.signal).then(() => TIMED_OUT),
      ]);
    } catch (err) {
      return fail(err);
    } finally {
      timer.abort();
    }
    if (outcome === TIMED_OUT) {
      stderr.write(`UniView: no decision within ${args.timeoutS} s\n`);
      return EXIT.TIMEOUT;
    }
    const decision = outcome?.result?.decision;
    const exit = decision && Object.hasOwn(DECISION_EXIT, decision.decision) ? DECISION_EXIT[decision.decision] : undefined;
    if (exit === undefined) return unexpected();
    stdout.write(JSON.stringify(decision) + "\n");
    return exit;
  } finally {
    // Closing the connection also cancels a pending server-side wait (the review stays open).
    try {
      await client.close();
    } catch {}
  }
}
