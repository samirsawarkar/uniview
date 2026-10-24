import { describe, it, expect, vi } from "vitest";
import path from "node:path";
// @ts-expect-error plain ESM module without types
import { runCli, EXIT, COLD_START_MS } from "../../electron/lib/cli.mjs";

const cwd = path.resolve(process.platform === "win32" ? "I:\\AES\\work" : "/srv/work");
const abs = (p: string) => path.resolve(cwd, p);

type Req = { method: string; params: any };
type Handler = (params: any) => Promise<{ result: any }>;

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Fake bridge client: records requests, answers from per-method handlers. */
function makeBridge(handlers: Record<string, Handler>) {
  const requests: Req[] = [];
  let closed = 0;
  const client = {
    sessionId: "0".repeat(32),
    request(method: string, params: any) {
      requests.push({ method, params });
      const h = handlers[method];
      return h ? h(params) : Promise.reject(codeError("unknown_method"));
    },
    async close() {
      closed++;
    },
  };
  return { client, requests, closedCount: () => closed };
}

/** Fake clock: sleeps advance time at once, except those longer than holdAbove, which wait for fire(). */
function makeClock(holdAbove = Infinity) {
  let t = 0;
  const sleeps: number[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const held: { ms: number; resolve: () => void }[] = [];
  return {
    now: () => t,
    sleep(ms: number, signal?: AbortSignal) {
      sleeps.push(ms);
      signals.push(signal);
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
    signals,
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

const openOk: Handler = async (p) => ({
  result: { opened: [...p.files, ...(p.receipt ? [p.receipt] : []), ...(p.view ? [p.view] : [])], failed: [], ...(p.wait ? { reviewId: "r1" } : {}) },
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
      handlers: { open: openOk, wait_review: () => new Promise<never>(() => {}) },
      holdAbove: 500,
    });
    const done = timeout.run();
    await flush();
    timeout.clock.fire();
    expect(await done).toBe(5);
  });

  it("the last retry sleep is clamped to the remaining budget and still gets a final attempt", async () => {
    // Mutation: giving up while 1 ms of the 15 s budget remains (remaining <= 1 instead of <= 0)
    let t = 0;
    const sleeps: number[] = [];
    let calls = 0;
    const s = setup({ argv: ["open", "a.txt"] });
    s.connect.mockImplementation(async () => {
      if (++calls === 1) t = COLD_START_MS - 1;
      throw codeError("ENOENT");
    });
    const code = await (runCli({
      argv: ["open", "a.txt"], cwd, stdout: makeOut(), stderr: makeOut(), connect: s.connect, startApp: async () => {},
      now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    }) as Promise<number>);
    expect(code).toBe(EXIT.UNREACHABLE);
    expect(sleeps).toEqual([1]);
    expect(calls).toBe(2);
  });

  it("warm start: one open request with absolute paths, one-line acknowledgement, exit 0", async () => {
    // Mutation: starting the app when the bridge answers, sending more than one request, or relative paths
    const s = setup({ argv: ["open", "a.txt", "--view", "v.uview.json"], handlers: { open: openOk } });
    expect(await s.run()).toBe(EXIT.OK);
    expect(s.startApp).not.toHaveBeenCalled();
    expect(s.bridge.requests).toEqual([{ method: "open", params: { files: [abs("a.txt")], view: abs("v.uview.json"), wait: false } }]);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("v.uview.json")}\n`);
    expect(s.stderr.text()).toBe("");
    expect(s.bridge.closedCount()).toBe(1);
  });

  it("usage errors exit 2 without connecting and print the usage line", async () => {
    // Mutation: connecting (or starting the app) before the arguments are validated
    const s = setup({ argv: ["open", "--bogus"], handlers: { open: openOk } });
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
    const s = setup({ argv: ["open", "a.txt"], handlers: { open: openOk } });
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
    const s = setup({ argv: ["open", "a.txt"], handlers: { open: openOk } });
    s.connect.mockImplementation(async () => {
      if (s.clock.now() < 15000) throw codeError("ENOENT");
      return s.bridge.client;
    });
    expect(await s.run()).toBe(EXIT.OK);
    expect(s.clock.now()).toBe(15000);
  });

  it("cold-start budget limit + 1: a bridge that answers only at 15.001 s is not reached (exit 6)", async () => {
    // Mutation: retrying past the 15 s budget
    const s = setup({ argv: ["open", "a.txt"], handlers: { open: openOk } });
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
    expect(s.stderr.text()).toBe("UniView: could not start the app (spawn failed)\n");
  });

  it("partial failure: opened files listed on stdout, each failure on stderr, exit 2", async () => {
    // Mutation: exiting 0 when some files failed, or hiding the failures
    const s = setup({
      argv: ["open", "a.txt", "b.txt", "c.txt"],
      handlers: {
        open: async (p) => ({ result: { opened: [p.files[0], p.files[2]], failed: [{ path: p.files[1], code: "bad_path" }] } }),
      },
    });
    expect(await s.run()).toBe(EXIT.USAGE);
    expect(s.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("c.txt")}\n`);
    expect(s.stderr.text()).toBe(`UniView: cannot open ${abs("b.txt")}: bad_path\n`);
  });

  it("all files failing prints no acknowledgement and exits 2", async () => {
    // Mutation: printing an empty "Opened" line
    const s = setup({
      argv: ["open", "a.txt"],
      handlers: { open: async (p) => ({ result: { opened: [], failed: [{ path: p.files[0], code: "bad_path" }] } }) },
    });
    expect(await s.run()).toBe(EXIT.USAGE);
    expect(s.stdout.text()).toBe("");
    expect(s.stderr.text()).toBe(`UniView: cannot open ${abs("a.txt")}: bad_path\n`);
  });

  it("request-level path/validation errors exit 2; busy, internal and lost connections exit 6", async () => {
    // Mutation: mapping every bridge error to one exit code
    const cases: [string, number][] = [
      ["bad_path", EXIT.USAGE],
      ["invalid_receipt", EXIT.USAGE],
      ["invalid_spec", EXIT.USAGE],
      ["too_large", EXIT.USAGE],
      ["busy", EXIT.UNREACHABLE],
      ["internal", EXIT.UNREACHABLE],
      ["closed", EXIT.UNREACHABLE],
    ];
    for (const [code, exit] of cases) {
      const s = setup({ argv: ["open", "a.txt"], handlers: { open: async () => { throw codeError(code); } } });
      expect(await s.run()).toBe(exit);
      expect(s.stderr.text()).toMatch(new RegExp(`\\b${code}\\b`));
      expect(s.bridge.closedCount()).toBe(1);
    }
  });

  it("a malformed open result exits 6", async () => {
    // Mutation: trusting the response shape (crash or false success)
    for (const result of [undefined, null, {}, { opened: "a", failed: [] }, { opened: [1], failed: [] }, { opened: [], failed: [{ path: 1 }] }]) {
      const s = setup({ argv: ["open", "a.txt"], handlers: { open: async () => ({ result }) } });
      expect(await s.run()).toBe(EXIT.UNREACHABLE);
      expect(s.stderr.text()).toMatch(/unexpected response/);
    }
  });

  describe("--wait", () => {
    const decisions: [string, number][] = [
      ["approved", 0],
      ["changes_requested", 3],
      ["dismissed", 4],
    ];
    for (const [kind, exit] of decisions) {
      it(`${kind} prints the decision JSON on stdout and exits ${exit}`, async () => {
        // Mutation: wrong exit code per decision, or decision JSON mixed with the acknowledgement on stdout
        const d = decision(kind);
        const s = setup({
          argv: ["open", "--wait", "--receipt", "r.receipt.json", "a.txt"],
          handlers: { open: openOk, wait_review: async () => ({ result: { decision: d } }) },
        });
        expect(await s.run()).toBe(exit);
        expect(s.bridge.requests).toEqual([
          { method: "open", params: { files: [abs("a.txt")], receipt: abs("r.receipt.json"), wait: true } },
          { method: "wait_review", params: { reviewId: "r1" } },
        ]);
        expect(s.stdout.text()).toBe(JSON.stringify(d) + "\n");
        expect(s.stderr.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("r.receipt.json")}; waiting for the review decision\n`);
      });
    }

    it("a decision cancels the timeout timer", async () => {
      // Mutation: leaving the timeout timer running after the decision (process would not exit)
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { open: openOk, wait_review: async () => ({ result: { decision: decision("approved") } }) },
        holdAbove: 1000,
      });
      expect(await s.run()).toBe(EXIT.OK);
      const signal = s.clock.signals[s.clock.sleeps.indexOf(3600 * 1000)];
      expect(signal?.aborted).toBe(true);
    });

    it("times out with exit 5 after the default 3600 s and closes the connection", async () => {
      // Mutation: wrong default, ignoring the timeout, or not closing (which is what cancels the server-side wait)
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { open: openOk, wait_review: () => new Promise<never>(() => {}) },
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

    it("--timeout sets the wait in seconds", async () => {
      // Mutation: treating --timeout as milliseconds
      const s = setup({
        argv: ["open", "--wait", "--timeout", "5", "--receipt", "r.json"],
        handlers: { open: openOk, wait_review: () => new Promise<never>(() => {}) },
        holdAbove: 1000,
      });
      const done = s.run();
      await flush();
      expect(s.clock.held.map((h) => h.ms)).toEqual([5000]);
      s.clock.fire();
      expect(await done).toBe(EXIT.TIMEOUT);
    });

    it("the app exiting while waiting exits 6", async () => {
      // Mutation: reporting a lost connection as a timeout or a decision
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { open: openOk, wait_review: async () => { throw codeError("closed"); } },
        holdAbove: 1000,
      });
      expect(await s.run()).toBe(EXIT.UNREACHABLE);
      expect(s.stderr.text()).toMatch(/not reachable \(closed\)/);
      expect(s.stdout.text()).toBe("");
    });

    it("an unknown decision value or missing reviewId exits 6", async () => {
      // Mutation: mapping an unrecognised decision to approved (exit 0)
      const bad = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { open: openOk, wait_review: async () => ({ result: { decision: decision("maybe") } }) },
      });
      expect(await bad.run()).toBe(EXIT.UNREACHABLE);
      const noId = setup({
        argv: ["open", "--wait", "--receipt", "r.json"],
        handlers: { open: async (p) => ({ result: { opened: [p.receipt], failed: [] } }) },
      });
      expect(await noId.run()).toBe(EXIT.UNREACHABLE);
      expect(noId.bridge.requests.map((r) => r.method)).toEqual(["open"]);
    });

    it("a partial failure does not wait and exits 2", async () => {
      // Mutation: waiting for a decision after some files failed to open
      const s = setup({
        argv: ["open", "--wait", "--receipt", "r.json", "a.txt"],
        handlers: {
          open: async (p) => ({ result: { opened: [p.receipt], failed: [{ path: p.files[0], code: "bad_path" }], reviewId: "r1" } }),
          wait_review: async () => ({ result: { decision: decision("approved") } }),
        },
      });
      expect(await s.run()).toBe(EXIT.USAGE);
      expect(s.bridge.requests.map((r) => r.method)).toEqual(["open"]);
    });

    it("two simultaneous --wait clients each get their own decision", async () => {
      // Mutation: sharing state between runs (e.g. a module-level reviewId or connection)
      let next = 0;
      const waiters = new Map<string, (d: any) => void>();
      const makeClient = () => ({
        async request(method: string, params: any) {
          if (method === "open") return { result: { opened: [params.receipt], failed: [], reviewId: `r${++next}` } };
          return new Promise((resolve) => waiters.set(params.reviewId, (d) => resolve({ result: { decision: d } })));
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
