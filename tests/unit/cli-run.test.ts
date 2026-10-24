import { describe, it, expect, vi } from "vitest";
import path from "node:path";
// @ts-expect-error plain ESM module without types
import { runCli, EXIT, COLD_START_MS } from "../../electron/lib/cli.mjs";

const cwd = path.resolve(process.platform === "win32" ? "I:\\AES\\work" : "/srv/work");
const abs = (p: string) => path.resolve(cwd, p);

type Req = { method: string; params: any; paths?: string[] };
type Handler = (params: any, paths?: string[]) => Promise<{ result: any }>;

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Fake bridge client: records requests, answers from per-method handlers. */
function makeBridge(handlers: Record<string, Handler>) {
  const requests: Req[] = [];
  let closed = 0;
  const client = {
    sessionId: "0".repeat(32),
    request(method: string, params: any, body?: Buffer) {
      const paths: string[] | undefined = body ? JSON.parse(body.toString("utf8")) : undefined;
      requests.push({ method, params, ...(paths ? { paths } : {}) });
      const h = handlers[method];
      return h ? h(params, paths) : Promise.reject(codeError("unknown_method"));
    },
    async close() {
      closed++;
    },
  };
  return { client, requests, closedCount: () => closed };
}

/**
 * Fake clock. Sleeps without a signal (retry backoff) advance time at once, except those longer than holdAbove.
 * Sleeps with a signal are cancellable timers (attempt deadlines, the --wait timeout): they are recorded in
 * `timers`, wait in `held` for fire(), and leave `held` when their signal aborts.
 */
function makeClock(holdAbove = Infinity) {
  let t = 0;
  const sleeps: number[] = [];
  const timers: { ms: number; signal: AbortSignal }[] = [];
  const held: { ms: number; resolve: () => void }[] = [];
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    sleep(ms: number, signal?: AbortSignal) {
      if (signal) {
        timers.push({ ms, signal });
        return new Promise<void>((resolve) => {
          const entry = { ms, resolve };
          held.push(entry);
          signal.addEventListener("abort", () => {
            const i = held.indexOf(entry);
            if (i >= 0) held.splice(i, 1);
          }, { once: true });
        });
      }
      sleeps.push(ms);
      if (ms > holdAbove) return new Promise<void>((resolve) => held.push({ ms, resolve }));
      t += ms;
      return Promise.resolve();
    },
    fire() {
      for (const h of held.splice(0)) {
        t += h.ms;
        h.resolve();
      }
    },
    sleeps,
    timers,
    held,
  };
}

function makeOut() {
  let text = "";
  return { write: (s: string) => { text += s; return true; }, text: () => text };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(opts: { argv: string[]; handlers?: Record<string, Handler>; connect?: () => Promise<any>; startApp?: () => Promise<void>; holdAbove?: number }) {
  const bridge = makeBridge(opts.handlers ?? {});
  const clock = makeClock(opts.holdAbove);
  const stdout = makeOut();
  const stderr = makeOut();
  const connect = vi.fn(opts.connect ?? (async () => bridge.client));
  const startApp = vi.fn(opts.startApp ?? (async () => {}));
  const run = () =>
    runCli({ argv: opts.argv, cwd, stdout, stderr, connect, startApp, now: clock.now, sleep: clock.sleep }) as Promise<number>;
  return { bridge, clock, stdout, stderr, connect, startApp, run };
}

/** An app that accepts everything. */
const ok = (): Record<string, Handler> => ({
  open: async () => ({ result: { opened: 1 } }),
  "view.show": async () => ({ result: { scopeId: "s1" } }),
  "review.open": async () => ({ result: { reviewId: "r1" } }),
});

function decision(kind: string) {
  return { uniview: "decision/1", reviewId: "r1", receiptDigest: "a".repeat(64), decision: kind, comment: "", decidedAt: "t", verifiedAt: "t", persisted: true, files: [] };
}

describe("cli runCli", () => {
  it("exit codes are the spec's numbers", () => {
    // Mutation: renumbering any exit code
    expect(EXIT).toEqual({ OK: 0, USAGE: 2, CHANGES_REQUESTED: 3, DISMISSED: 4, TIMEOUT: 5, UNREACHABLE: 6 });
  });

  it("the process really returns the literal numbers 2, 5 and 6 (not only EXIT.* names)", async () => {
    // Mutation: renumbering EXIT.USAGE / EXIT.TIMEOUT / EXIT.UNREACHABLE consistently, which behaviour tests written with EXIT.* cannot see
    const usage = setup({ argv: ["open", "--bogus"] });
    expect(await usage.run()).toBe(2);
    const unreachable = setup({ argv: ["open", "a.txt"], connect: async () => { throw codeError("ENOENT"); } });
    expect(await unreachable.run()).toBe(6);
    const timeout = setup({
      argv: ["open", "--wait", "--timeout", "1", "--receipt", "r.json"],
      handlers: { ...ok(), "review.wait": () => new Promise<never>(() => {}) },
      holdAbove: 500,
    });
    const done = timeout.run();
    await flush();
    timeout.clock.fire();
    expect(await done).toBe(5);
  });

  it("the last retry sleep is clamped to the remaining budget and still gets a final attempt", async () => {
    // Mutation: giving up while 1 ms of the 15 s budget remains (remaining <= 1 instead of <= 0)
    let calls = 0;
    const s = setup({ argv: ["open", "a.txt"] });
    s.connect.mockImplementation(async () => {
      if (++calls === 1) s.clock.advance(COLD_START_MS - 1);
      throw codeError("ENOENT");
    });
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.clock.sleeps).toEqual([1]);
    expect(calls).toBe(2);
  });

  it("warm start: absolute paths, one-line acknowledgement, exit 0", async () => {
    // Mutation: starting the app when the bridge answers, or relative paths
    const s = setup({ argv: ["open", "a.txt", "--view", "v.uview.json"], handlers: ok() });
    expect(await s.run()).toBe(EXIT.OK);
    expect(s.startApp).not.toHaveBeenCalled();
    expect(s.bridge.requests).toEqual([
      { method: "open", params: {}, paths: [abs("a.txt")] },
      { method: "view.show", params: { path: abs("v.uview.json") } },
    ]);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("v.uview.json")}\n`);
    expect(s.stderr.text()).toBe("");
    expect(s.bridge.closedCount()).toBe(1);
  });

  it("usage errors exit 2 without connecting and print the usage line", async () => {
    // Mutation: connecting (or starting the app) before the arguments are validated
    const s = setup({ argv: ["open", "--bogus"], handlers: ok() });
    expect(await s.run()).toBe(EXIT.USAGE);
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.startApp).not.toHaveBeenCalled();
    expect(s.stderr.text()).toMatch(/unknown option '--bogus'/);
    expect(s.stderr.text()).toMatch(/Usage: UniView open \[--wait \[--timeout <s>\]\] \[--receipt <file>\] \[--view <file>\] \[--\] <file>\.\.\./);
    expect(s.stdout.text()).toBe("");
  });

  it("cold start: starts the app once, retries with backoff, then hands off", async () => {
    // Mutation: starting the app on every retry, or not retrying after starting it
    let calls = 0;
    const s = setup({ argv: ["open", "a.txt"], handlers: ok() });
    s.connect.mockImplementation(async () => {
      if (++calls <= 3) throw codeError("ENOENT");
      return s.bridge.client;
    });
    expect(await s.run()).toBe(EXIT.OK);
    expect(s.startApp).toHaveBeenCalledTimes(1);
    expect(s.connect).toHaveBeenCalledTimes(4);
    expect(s.clock.sleeps).toEqual([100, 200, 400]);
  });

  it("backoff doubles from 100 ms, caps at 1 s, and gives up after exactly 15 s with exit 6", async () => {
    // Mutation: no cap, no doubling, a different budget, or sleeping past the deadline
    const s = setup({ argv: ["open", "a.txt"], connect: async () => { throw codeError("ENOENT"); } });
    expect(COLD_START_MS).toBe(15000);
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.clock.sleeps.slice(0, 6)).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(Math.max(...s.clock.sleeps)).toBe(1000);
    expect(s.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(15000);
    expect(s.stderr.text()).toBe("UniView: the app is not reachable (ENOENT)\n");
    expect(s.stdout.text()).toBe("");
  });

  it("cold-start budget limit: a bridge that answers at exactly 15 s is used", async () => {
    // Mutation: giving up before the final attempt at the deadline (< instead of <=)
    const s = setup({ argv: ["open", "a.txt"], handlers: ok() });
    s.connect.mockImplementation(async () => {
      if (s.clock.now() < 15000) throw codeError("ENOENT");
      return s.bridge.client;
    });
    expect(await s.run()).toBe(EXIT.OK);
    expect(s.clock.now()).toBe(15000);
  });

  it("cold-start budget limit + 1: a bridge that answers only at 15.001 s is not reached (exit 6)", async () => {
    // Mutation: retrying past the 15 s budget
    const s = setup({ argv: ["open", "a.txt"], handlers: ok() });
    s.connect.mockImplementation(async () => {
      if (s.clock.now() < 15001) throw codeError("ECONNREFUSED");
      return s.bridge.client;
    });
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.clock.now()).toBe(15000);
    expect(s.stderr.text()).toMatch(/not reachable \(ECONNREFUSED\)/);
  });

  it("startup failure: startApp rejecting exits 6 at once without retrying", async () => {
    // Mutation: ignoring a failed app launch and polling for 15 s
    const s = setup({
      argv: ["open", "a.txt"],
      connect: async () => { throw codeError("ENOENT"); },
      startApp: async () => { throw new Error("spawn failed"); },
    });
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.clock.sleeps).toEqual([]);
    expect(s.stderr.text()).toBe("UniView: could not start the app (Error)\n");
  });

  it("a connector that succeeds only after advancing the clock past 15 s is not used (exit 6) and its connection is closed", async () => {
    // Mutation: awaiting connect() with no deadline (a 16 s success became exit 0)
    const s = setup({ argv: ["open", "a.txt"], handlers: ok() });
    s.connect.mockImplementation(async () => {
      s.clock.advance(16000);
      return s.bridge.client;
    });
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.bridge.requests).toEqual([]);
    expect(s.bridge.closedCount()).toBe(1);
    expect(s.stderr.text()).toBe("UniView: the app is not reachable (timeout)\n");
    expect(s.stdout.text()).toBe("");
  });

  it("a connector that answers at exactly the 15 s deadline is still used (limit), 1 ms later is not (limit + 1)", async () => {
    // Mutation: a post-connect deadline check using >= instead of >
    const at = async (ms: number) => {
      const s = setup({ argv: ["open", "a.txt"], handlers: ok() });
      s.connect.mockImplementation(async () => {
        s.clock.advance(ms);
        return s.bridge.client;
      });
      return s.run();
    };
    expect(await at(15000)).toBe(EXIT.OK);
    expect(await at(15001)).toBe(EXIT.UNREACHABLE);
  });

  it("a never-settling connect is abandoned at the 15 s deadline with exit 6; a late connection is closed", async () => {
    // Mutation: no per-attempt deadline (the process would hang), or leaking a connection that arrives after giving up
    let late!: (c: unknown) => void;
    const s = setup({ argv: ["open", "a.txt"], handlers: ok() });
    s.connect.mockImplementation(() => new Promise((resolve) => { late = resolve; }));
    const done = s.run();
    await flush();
    expect(s.clock.held.map((h) => h.ms)).toEqual([COLD_START_MS]);
    s.clock.fire();
    expect(await done).toBe(EXIT.UNREACHABLE);
    expect(s.clock.now()).toBe(COLD_START_MS);
    expect(s.startApp).toHaveBeenCalledTimes(0);
    expect(s.stderr.text()).toBe("UniView: the app is not reachable (timeout)\n");
    expect(s.clock.held).toEqual([]);
    late(s.bridge.client);
    await flush();
    expect(s.bridge.closedCount()).toBe(1);
    expect(s.bridge.requests).toEqual([]);
  });

  it("a never-settling startApp is abandoned at the remaining budget with exit 6, without further attempts", async () => {
    // Mutation: awaiting startApp() with no deadline
    const s = setup({
      argv: ["open", "a.txt"],
      connect: async () => { throw codeError("ENOENT"); },
      startApp: () => new Promise<void>(() => {}),
    });
    const done = s.run();
    await flush();
    expect(s.startApp).toHaveBeenCalledTimes(1);
    expect(s.clock.held.map((h) => h.ms)).toEqual([COLD_START_MS]);
    s.clock.fire();
    expect(await done).toBe(EXIT.UNREACHABLE);
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.stderr.text()).toBe("UniView: the app is not reachable (timeout)\n");
  });

  it("the attempt deadline is the remaining budget, not a fresh 15 s", async () => {
    // Mutation: arming each attempt with the full budget instead of what is left
    let calls = 0;
    const s = setup({ argv: ["open", "a.txt"] });
    s.connect.mockImplementation(() => {
      if (++calls === 1) { s.clock.advance(10000); return Promise.reject(codeError("ENOENT")); }
      return new Promise(() => {});
    });
    const done = s.run();
    await flush();
    expect(s.clock.timers.map((x) => x.ms)).toEqual([COLD_START_MS, 5000, 4900]);
    s.clock.fire();
    expect(await done).toBe(EXIT.UNREACHABLE);
  });

  it("startApp's error message never reaches stdout or stderr (only its code or class)", async () => {
    // Mutation: printing err.message (a launcher error can carry secrets such as key=...)
    const s = setup({
      argv: ["open", "a.txt"],
      connect: async () => { throw codeError("ENOENT"); },
      startApp: async () => { throw new Error("spawn failed: key=TEST_SECRET"); },
    });
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.stderr.text() + s.stdout.text()).not.toContain("TEST_SECRET");
    expect(s.stderr.text()).toBe("UniView: could not start the app (Error)\n");
    const coded = setup({
      argv: ["open", "a.txt"],
      connect: async () => { throw codeError("ENOENT"); },
      startApp: async () => { throw Object.assign(new Error("key=TEST_SECRET"), { code: "EACCES" }); },
    });
    expect(await coded.run()).toBe(EXIT.UNREACHABLE);
    expect(coded.stderr.text()).toBe("UniView: could not start the app (EACCES)\n");
  });

  it("an error code that is not a plain identifier is never echoed (connect and request errors)", async () => {
    // Mutation: echoing err.code verbatim
    const weird = codeError("key=TEST_SECRET");
    const a = setup({ argv: ["open", "a.txt"], connect: async () => { throw weird; } });
    expect(await a.run()).toBe(EXIT.UNREACHABLE);
    expect(a.stderr.text() + a.stdout.text()).not.toContain("TEST_SECRET");
    const b = setup({ argv: ["open", "a.txt"], handlers: { open: async () => { throw weird; } } });
    expect(await b.run()).toBe(EXIT.UNREACHABLE);
    expect(b.stderr.text() + b.stdout.text()).not.toContain("TEST_SECRET");
    expect(b.stderr.text()).toMatch(/[(]unknown[)]/);
  });


  it("one open request per file (a body holding that single absolute path), then --view, then --receipt", async () => {
    // Mutation: batching files into one request (a refused file could not be named), or a different order
    const s = setup({
      argv: ["open", "--view", "v.uview.json", "--receipt", "r.receipt.json", "a.txt", "b.txt"],
      handlers: ok(),
    });
    expect(await s.run()).toBe(EXIT.OK);
    expect(s.bridge.requests).toEqual([
      { method: "open", params: {}, paths: [abs("a.txt")] },
      { method: "open", params: {}, paths: [abs("b.txt")] },
      { method: "view.show", params: { path: abs("v.uview.json") } },
      { method: "review.open", params: { path: abs("r.receipt.json") } },
    ]);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("b.txt")}, ${abs("v.uview.json")}, ${abs("r.receipt.json")}\n`);
  });

  it("the CLI never says mcp.hello and sends only canonical ops", async () => {
    // Mutation: a retired op name (open with files/receipt/view params, wait_review) or a hello (which would subject the CLI to approval)
    const s = setup({
      argv: ["open", "--wait", "--receipt", "r.json", "--view", "v.json", "a.txt"],
      handlers: { ...ok(), "review.wait": async () => ({ result: { status: "decided", decision: decision("approved") } }) },
    });
    await s.run();
    const canonical = new Set(["open", "view.show", "review.open", "review.wait"]);
    expect(s.bridge.requests.every((r) => canonical.has(r.method))).toBe(true);
  });

  it("partial failure: opened files listed on stdout, each failure on stderr, exit 2", async () => {
    // Mutation: exiting 0 when some files failed, hiding the failures, or stopping at the first refused file
    const s = setup({
      argv: ["open", "a.txt", "b.txt", "c.txt"],
      handlers: {
        ...ok(),
        open: async (_p, paths) => {
          if (paths?.[0] === abs("b.txt")) throw codeError("bad_path");
          return { result: { opened: 1 } };
        },
      },
    });
    expect(await s.run()).toBe(EXIT.USAGE);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("c.txt")}\n`);
    expect(s.stderr.text()).toBe(`UniView: cannot open ${abs("b.txt")}: bad_path\n`);
  });

  it("all files failing prints no acknowledgement and exits 2", async () => {
    // Mutation: printing an empty "Opened" line
    const s = setup({ argv: ["open", "a.txt"], handlers: { ...ok(), open: async () => { throw codeError("bad_path"); } } });
    expect(await s.run()).toBe(EXIT.USAGE);
    expect(s.stdout.text()).toBe("");
    expect(s.stderr.text()).toBe(`UniView: cannot open ${abs("a.txt")}: bad_path\n`);
  });

  it("a refused view or receipt is named with its code and exits 2, the other items still open", async () => {
    // Mutation: dropping per-item attribution for --view/--receipt, or abandoning the remaining items
    const s = setup({
      argv: ["open", "--view", "v.json", "--receipt", "r.json", "a.txt"],
      handlers: { ...ok(), "view.show": async () => { throw codeError("invalid_spec"); }, "review.open": async () => { throw codeError("invalid_receipt"); } },
    });
    expect(await s.run()).toBe(EXIT.USAGE);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}\n`);
    expect(s.stderr.text()).toBe(`UniView: cannot open ${abs("v.json")}: invalid_spec\nUniView: cannot open ${abs("r.json")}: invalid_receipt\n`);
  });

  it("request errors about the request exit 2 (item named); busy, internal, not_allowed and lost connections stop at once with exit 6", async () => {
    // Mutation: mapping every bridge error to one exit code
    const cases: [string, number][] = [
      ["bad_path", EXIT.USAGE],
      ["invalid_receipt", EXIT.USAGE],
      ["invalid_spec", EXIT.USAGE],
      ["too_large", EXIT.USAGE],
      ["bad_request", EXIT.USAGE],
      ["busy", EXIT.UNREACHABLE],
      ["internal", EXIT.UNREACHABLE],
      ["not_allowed", EXIT.UNREACHABLE],
      ["closed", EXIT.UNREACHABLE],
    ];
    for (const [code, exit] of cases) {
      const s = setup({ argv: ["open", "a.txt"], handlers: { ...ok(), open: async () => { throw codeError(code); } } });
      expect(await s.run()).toBe(exit);
      expect(s.stderr.text()).toMatch(new RegExp(`\\b${code}\\b`));
      expect(s.bridge.closedCount()).toBe(1);
    }
  });

  it("a fatal error mid-way lists what was already opened and does not try the remaining items", async () => {
    // Mutation: continuing after busy (flooding a busy app) or losing the acknowledgement of earlier items
    const s = setup({
      argv: ["open", "a.txt", "b.txt", "c.txt"],
      handlers: {
        ...ok(),
        open: async (_p, paths) => {
          if (paths?.[0] === abs("b.txt")) throw codeError("busy");
          return { result: { opened: 1 } };
        },
      },
    });
    expect(await s.run()).toBe(EXIT.UNREACHABLE);
    expect(s.bridge.requests.map((r) => r.paths?.[0])).toEqual([abs("a.txt"), abs("b.txt")]);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}\n`);
    expect(s.stderr.text()).toMatch(/not reachable \(busy\)/);
  });

  it("a malformed result exits 6 for every op", async () => {
    // Mutation: trusting the response shape (crash or false success)
    const bad: Array<[string, unknown[]]> = [
      ["open", [undefined, null, {}, { opened: 0 }, { opened: "1" }, { opened: 2 }, { opened: ["a"] }]],
      ["view.show", [undefined, {}, { scopeId: "" }, { scopeId: 5 }]],
      ["review.open", [undefined, {}, { reviewId: "" }, { reviewId: 5 }]],
    ];
    for (const [method, results] of bad) {
      for (const result of results) {
        const argv = method === "open" ? ["open", "a.txt"] : method === "view.show" ? ["open", "--view", "v.json"] : ["open", "--receipt", "r.json"];
        const s = setup({ argv, handlers: { ...ok(), [method]: async () => ({ result }) } });
        expect(await s.run()).toBe(EXIT.UNREACHABLE);
        expect(s.stderr.text()).toMatch(/unexpected response/);
      }
    }
  });

  describe("--wait", () => {
    const decisions: [string, number][] = [
      ["approved", 0],
      ["changes_requested", 3],
      ["dismissed", 4],
    ];
    const waits = (result: unknown) => ({ ...ok(), "review.wait": async () => ({ result }) });

    for (const [kind, exit] of decisions) {
      it(`${kind} prints the decision JSON on stdout and exits ${exit}`, async () => {
        // Mutation: wrong exit code per decision, or decision JSON mixed with the acknowledgement on stdout
        const d = decision(kind);
        const s = setup({
          argv: ["open", "--wait", "--receipt", "r.receipt.json", "a.txt"],
          handlers: waits({ status: "decided", decision: d }),
        });
        expect(await s.run()).toBe(exit);
        expect(s.bridge.requests).toEqual([
          { method: "open", params: {}, paths: [abs("a.txt")] },
          { method: "review.open", params: { path: abs("r.receipt.json") } },
          { method: "review.wait", params: { reviewId: "r1", timeoutMs: 3600 * 1000 } },
        ]);
        expect(s.stdout.text()).toBe(JSON.stringify(d) + "\n");
        expect(s.stderr.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("r.receipt.json")}; waiting for the review decision\n`);
      });
    }

    it("a decision cancels the timeout timer", async () => {
      // Mutation: leaving the timeout timer running after the decision (process would not exit)
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: waits({ status: "decided", decision: decision("approved") }),
        holdAbove: 1000,
      });
      expect(await s.run()).toBe(EXIT.OK);
      const waitTimer = s.clock.timers.find((x) => x.ms === 3600 * 1000);
      expect(waitTimer?.signal.aborted).toBe(true);
      expect(s.clock.held).toEqual([]);
    });

    it("times out with exit 5 after the default 3600 s and closes the connection", async () => {
      // Mutation: wrong default, ignoring the timeout, or not closing (which is what cancels the server-side wait)
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { ...ok(), "review.wait": () => new Promise<never>(() => {}) },
        holdAbove: 1000,
      });
      const done = s.run();
      await flush();
      expect(s.clock.held.map((h) => h.ms)).toEqual([3600 * 1000]);
      s.clock.fire();
      expect(await done).toBe(EXIT.TIMEOUT);
      expect(s.stdout.text()).toBe("");
      expect(s.stderr.text()).toMatch(/no decision within 3600 s\n$/);
      expect(s.bridge.closedCount()).toBe(1);
    });

    it("--timeout sets the wait in seconds, locally and as timeoutMs for the app", async () => {
      // Mutation: treating --timeout as milliseconds, or not telling the app how long to wait
      const s = setup({
        argv: ["open", "--wait", "--timeout", "5", "--receipt", "r.json"],
        handlers: { ...ok(), "review.wait": () => new Promise<never>(() => {}) },
        holdAbove: 1000,
      });
      const done = s.run();
      await flush();
      expect(s.clock.held.map((h) => h.ms)).toEqual([5000]);
      expect(s.bridge.requests.at(-1)).toEqual({ method: "review.wait", params: { reviewId: "r1", timeoutMs: 5000 } });
      s.clock.fire();
      expect(await done).toBe(EXIT.TIMEOUT);
    });

    it("the app answering pending (its wait ran out first) is a timeout: exit 5, no decision on stdout, timer cancelled", async () => {
      // Mutation: treating pending as a decision or as an app failure
      const s = setup({ argv: ["open", "--wait", "--timeout", "7", "--receipt", "r.json"], handlers: waits({ status: "pending" }), holdAbove: 1000 });
      expect(await s.run()).toBe(EXIT.TIMEOUT);
      expect(s.stdout.text()).toBe("");
      expect(s.stderr.text()).toMatch(/no decision within 7 s\n$/);
      expect(s.clock.held).toEqual([]);
    });

    it("the app exiting while waiting exits 6", async () => {
      // Mutation: reporting a lost connection as a timeout or a decision
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { ...ok(), "review.wait": async () => { throw codeError("closed"); } },
        holdAbove: 1000,
      });
      expect(await s.run()).toBe(EXIT.UNREACHABLE);
      expect(s.stderr.text()).toMatch(/not reachable \(closed\)/);
      expect(s.stdout.text()).toBe("");
    });

    it("an unknown decision value, a wrong status or a missing reviewId exits 6", async () => {
      // Mutation: mapping an unrecognised decision to approved (exit 0)
      for (const result of [
        { status: "decided", decision: decision("maybe") },
        { status: "decided" },
        { status: "something" },
        { decision: decision("approved") },
        undefined,
      ]) {
        const bad = setup({ argv: ["open", "--wait", "--receipt", "r.json"], handlers: waits(result) });
        expect(await bad.run()).toBe(EXIT.UNREACHABLE);
        expect(bad.stdout.text()).toBe("");
      }
      const noId = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { ...ok(), "review.open": async () => ({ result: {} }) },
      });
      expect(await noId.run()).toBe(EXIT.UNREACHABLE);
      expect(noId.bridge.requests.map((r) => r.method)).toEqual(["review.open"]);
    });

    it("a partial failure does not wait and exits 2", async () => {
      // Mutation: waiting for a decision after some files failed to open
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json", "a.txt"],
        handlers: {
          ...ok(),
          open: async () => { throw codeError("bad_path"); },
          "review.wait": async () => ({ result: { status: "decided", decision: decision("approved") } }),
        },
      });
      expect(await s.run()).toBe(EXIT.USAGE);
      expect(s.bridge.requests.map((r) => r.method)).toEqual(["open", "review.open"]);
      // It must not claim to be waiting.
      expect(s.stderr.text()).toBe(`Opened in UniView: ${abs("r.json")}\nUniView: cannot open ${abs("a.txt")}: bad_path\n`);
    });

    it("a refused receipt with --wait does not wait and exits 2", async () => {
      // Mutation: waiting on a review that never opened
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { ...ok(), "review.open": async () => { throw codeError("invalid_receipt"); } },
      });
      expect(await s.run()).toBe(EXIT.USAGE);
      expect(s.bridge.requests.map((r) => r.method)).toEqual(["review.open"]);
      expect(s.stderr.text()).toBe(`UniView: cannot open ${abs("r.json")}: invalid_receipt\n`);
    });

    it("two simultaneous --wait clients each get their own decision", async () => {
      // Mutation: sharing state between runs (e.g. a module-level reviewId or connection)
      let next = 0;
      const waiters = new Map<string, (d: any) => void>();
      const makeClient = () => ({
        async request(method: string, params: any) {
          if (method === "review.open") return { result: { reviewId: `r${++next}` } };
          return new Promise((resolve) => waiters.set(params.reviewId, (d) => resolve({ result: { status: "decided", decision: d } })));
        },
        async close() {},
      });
      const clock = makeClock(1000);
      const outs = [makeOut(), makeOut()];
      const runs = outs.map((o, i) =>
        runCli({ argv: ["open", "--wait", "--receipt", `r${i}.json`], cwd, stdout: o, stderr: makeOut(), connect: async () => makeClient(), startApp: async () => {}, now: clock.now, sleep: clock.sleep }),
      );
      await flush();
      expect([...waiters.keys()].sort()).toEqual(["r1", "r2"]);
      waiters.get("r2")!({ ...decision("changes_requested"), reviewId: "r2" });
      waiters.get("r1")!({ ...decision("approved"), reviewId: "r1" });
      const codes: number[] = await Promise.all(runs);
      const ids = outs.map((o) => JSON.parse(o.text()).reviewId);
      expect(new Set(ids)).toEqual(new Set(["r1", "r2"]));
      codes.forEach((c: number, i: number) => expect(c).toBe(ids[i] === "r1" ? EXIT.OK : EXIT.CHANGES_REQUESTED));
    });
  });
});
