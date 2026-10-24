import { describe, it, expect } from "vitest";
import path from "node:path";
// @ts-expect-error plain ESM module without types
import { parseArgs, MAX_TIMEOUT_S, DEFAULT_TIMEOUT_S, MAX_CLI_PATH } from "../../electron/lib/cli.mjs";

type Parsed =
  | { ok: true; files: string[]; receipt?: string; view?: string; wait: boolean; timeoutS: number }
  | { ok: false; error: string };

const cwd = path.resolve(process.platform === "win32" ? "I:\\AES\\work" : "/srv/work");
const abs = (p: string) => path.resolve(cwd, p);

function ok(argv: string[]): Extract<Parsed, { ok: true }> {
  const r = parseArgs(argv, cwd) as Parsed;
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

function fail(argv: string[]): string {
  const r = parseArgs(argv, cwd) as Parsed;
  if (r.ok) throw new Error(`expected a usage error for ${JSON.stringify(argv)}`);
  return r.error;
}

describe("cli parseArgs", () => {
  it("resolves relative files against the given cwd and keeps absolute ones", () => {
    // Mutation: passing paths through unresolved, or resolving against process.cwd()
    const other = path.resolve(cwd, "..", "elsewhere", "b.md");
    const r = ok(["open", "a.txt", "sub/../c.txt", other]);
    expect(r.files).toEqual([abs("a.txt"), abs("c.txt"), other]);
    expect(r.wait).toBe(false);
    expect(r.receipt).toBeUndefined();
    expect(r.view).toBeUndefined();
  });

  it("resolves --receipt and --view against cwd, in both separate and = forms", () => {
    // Mutation: leaving flag values relative, or not supporting --flag=value
    const r = ok(["open", "--receipt", "r.receipt.json", "--view=v.uview.json", "x"]);
    expect(r.receipt).toBe(abs("r.receipt.json"));
    expect(r.view).toBe(abs("v.uview.json"));
    expect(r.files).toEqual([abs("x")]);
  });

  it("requires the open command", () => {
    // Mutation: accepting a missing or different subcommand
    expect(fail([])).toMatch(/open/);
    expect(fail(["show", "a.txt"])).toMatch(/unknown command/);
  });

  it("rejects unknown flags, including single-dash and bare '-'", () => {
    // Mutation: treating unknown flags as file names
    expect(fail(["open", "--force", "a.txt"])).toMatch(/unknown option '--force'/);
    expect(fail(["open", "-w", "a.txt"])).toMatch(/unknown option '-w'/);
    expect(fail(["open", "-"])).toMatch(/unknown option '-'/);
  });

  it("treats everything after -- as files, even when it starts with -", () => {
    // Mutation: continuing flag parsing after --
    const r = ok(["open", "--", "--wait", "-x.txt", "--"]);
    expect(r.files).toEqual([abs("--wait"), abs("-x.txt"), abs("--")]);
    expect(r.wait).toBe(false);
  });

  it("accepts flags after files when there is no --", () => {
    // Mutation: stopping flag parsing at the first file
    const r = ok(["open", "a.txt", "--view", "v.uview.json"]);
    expect(r.files).toEqual([abs("a.txt")]);
    expect(r.view).toBe(abs("v.uview.json"));
  });

  it("--wait requires --receipt", () => {
    // Mutation: allowing --wait without a receipt
    expect(fail(["open", "--wait", "a.txt"])).toMatch(/--wait requires --receipt/);
    const r = ok(["open", "--wait", "--receipt", "r.json"]);
    expect(r.wait).toBe(true);
    expect(r.files).toEqual([]);
  });

  it("--timeout is only allowed with --wait, in either order", () => {
    // Mutation: accepting --timeout without --wait, or requiring --wait to come first
    expect(fail(["open", "--timeout", "5", "--receipt", "r.json"])).toMatch(/--timeout requires --wait/);
    expect(ok(["open", "--timeout", "5", "--wait", "--receipt", "r.json"]).timeoutS).toBe(5);
    expect(ok(["open", "--wait", "--timeout=7", "--receipt", "r.json"]).timeoutS).toBe(7);
  });

  it("defaults the timeout to 3600 s", () => {
    // Mutation: a different or missing default timeout
    expect(DEFAULT_TIMEOUT_S).toBe(3600);
    expect(ok(["open", "--wait", "--receipt", "r.json"]).timeoutS).toBe(3600);
  });

  it("timeout lower limit: 1 accepted, 0 rejected", () => {
    // Mutation: allowing a zero timeout (would return immediately)
    expect(ok(["open", "--wait", "--timeout", "1", "--receipt", "r.json"]).timeoutS).toBe(1);
    expect(fail(["open", "--wait", "--timeout", "0", "--receipt", "r.json"])).toMatch(/--timeout/);
  });

  it("timeout upper limit: MAX_TIMEOUT_S accepted, MAX_TIMEOUT_S + 1 rejected", () => {
    // Mutation: dropping the upper bound (setTimeout overflows above 2^31-1 ms and fires at once)
    expect(MAX_TIMEOUT_S).toBe(2147483);
    expect(ok(["open", "--wait", "--timeout", String(MAX_TIMEOUT_S), "--receipt", "r.json"]).timeoutS).toBe(MAX_TIMEOUT_S);
    expect(fail(["open", "--wait", "--timeout", String(MAX_TIMEOUT_S + 1), "--receipt", "r.json"])).toMatch(/--timeout/);
  });

  it("rejects non-integer timeouts", () => {
    // Mutation: parsing with parseFloat/Number and accepting fractions, signs, or junk
    for (const v of ["1.5", "-3", "+3", "5s", "", "1e3", " 5"]) {
      expect(fail(["open", "--wait", `--timeout=${v}`, "--receipt", "r.json"])).toMatch(/--timeout/);
    }
  });

  it("rejects a missing flag value, or one that looks like a flag", () => {
    // Mutation: swallowing the next flag as the value (e.g. --receipt --wait)
    expect(fail(["open", "--receipt"])).toMatch(/--receipt needs a value/);
    expect(fail(["open", "--view", "--wait", "x"])).toMatch(/--view needs a value/);
    expect(fail(["open", "--wait", "--timeout"])).toMatch(/--timeout needs a value/);
    expect(fail(["open", "--receipt=", "x"])).toMatch(/--receipt needs a value/);
  });

  it("allows a dash-leading value only in the = form", () => {
    // Mutation: rejecting unambiguous --receipt=-r.json
    expect(ok(["open", "--receipt=-r.json"]).receipt).toBe(abs("-r.json"));
  });

  it("rejects repeated flags", () => {
    // Mutation: silently letting the last --receipt/--view/--wait/--timeout win
    expect(fail(["open", "--receipt", "a", "--receipt", "b"])).toMatch(/--receipt given twice/);
    expect(fail(["open", "--view", "a", "--view", "b"])).toMatch(/--view given twice/);
    expect(fail(["open", "--wait", "--wait", "--receipt", "a"])).toMatch(/--wait given twice/);
    expect(fail(["open", "--wait", "--timeout", "1", "--timeout", "2", "--receipt", "a"])).toMatch(/--timeout given twice/);
  });

  it("--wait takes no value", () => {
    // Mutation: accepting --wait=... as a boolean
    expect(fail(["open", "--wait=yes", "--receipt", "a"])).toMatch(/unknown option '--wait=yes'/);
  });

  it("requires at least one file, receipt or view", () => {
    // Mutation: sending an empty open request
    expect(fail(["open"])).toMatch(/nothing to open/);
    expect(fail(["open", "--"])).toMatch(/nothing to open/);
    expect(ok(["open", "--view", "v.uview.json"]).files).toEqual([]);
  });

  it("rejects empty paths and control characters before resolving", () => {
    // Mutation: resolving "" to cwd (opening the folder) or passing control characters on
    expect(fail(["open", ""])).toMatch(/empty path/);
    expect(fail(["open", "a\u0001b.txt"])).toMatch(/control character/);
    expect(fail(["open", "a\u007fb.txt"])).toMatch(/control character/);
    expect(fail(["open", "--receipt", "r\nx"])).toMatch(/control character/);
  });

  it("resolved path length: MAX_CLI_PATH accepted, MAX_CLI_PATH + 1 rejected", () => {
    // Mutation: dropping or misplacing (< vs <=) the 4096-character limit on the resolved path
    expect(MAX_CLI_PATH).toBe(4096);
    const prefix = abs("x");
    const sep = path.sep;
    const atLimit = prefix + sep + "a".repeat(MAX_CLI_PATH - prefix.length - 1);
    expect(atLimit.length).toBe(MAX_CLI_PATH);
    expect(ok(["open", atLimit]).files).toEqual([atLimit]);
    const over = atLimit + "b";
    expect(fail(["open", over])).toMatch(/longer than 4096/);
  });
});
