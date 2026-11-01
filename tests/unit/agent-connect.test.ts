import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// @ts-expect-error plain ESM module without types
import { createAgentConnect, codexBlock, quote } from "../../electron/lib/agent-connect.mjs";

const EXE = "C:\\Program Files\\UniView\\UniView.exe";
const ENTRY = "C:\\Program Files\\UniView\\resources\\app\\electron\\mcp-entry.mjs";
const BIN = "C:\\bin";

let home: string;
let config: string;
let calls: string[][];
let envs: (Record<string, string> | undefined)[];

/** Fake execFile: records argv and simulates the Claude CLI writing .claude.json. */
function fakeExec(order = { failRemove: false }) {
  return async (file: string, args: string[], opts?: { env?: Record<string, string> }) => {
    calls.push([file, ...args]);
    envs.push(opts?.env);
    const i = args.indexOf("mcp");
    if (args[i + 1] === "add-json") {
      const spec = JSON.parse(args[args.length - 1]!);
      await writeFile(
        join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { uniview: spec }, other: 1 }),
        "utf8",
      );
      return { stdout: "", stderr: "" };
    }
    if (args[i + 1] === "remove") {
      if (order.failRemove) throw Object.assign(new Error("boom"), { stderr: "No MCP server found\n" });
      const file2 = join(home, ".claude.json");
      const doc = JSON.parse(await readFile(file2, "utf8"));
      delete doc.mcpServers?.uniview;
      await writeFile(file2, JSON.stringify(doc), "utf8");
      return { stdout: "", stderr: "" };
    }
    throw new Error("unexpected " + args.join(" "));
  };
}

function make(over: Record<string, unknown> = {}) {
  return createAgentConnect({
    homedir: home,
    env: { PATH: BIN, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    execFile: fakeExec(),
    fs: fsPromises,
    exePath: EXE,
    entryPath: ENTRY,
    platform: "win32",
    ...over,
  });
}

async function plantBin(name: string, ext = ".exe") {
  await mkdir(BIN, { recursive: true });
  await writeFile(join(BIN, name + ext), "x");
}

beforeEach(async () => {
  home = await mkdtemp(join(os.tmpdir(), "agent-connect-"));
  config = join(home, ".codex", "config.toml");
  calls = [];
  envs = [];
  await mkdir(join(home, ".codex"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(BIN, { recursive: true, force: true });
});

describe("codex connect", () => {
  it("creates the file, the block and a backup on a fresh profile", async () => {
    const c = make();
    expect(await c.connect("codex")).toEqual({ ok: true });
    const text = await readFile(config, "utf8");
    expect(text).toContain("[mcp_servers.uniview]");
    expect(text).toContain("tool_timeout_sec = 1800");
    expect(text).toContain("startup_timeout_sec = 30");
    expect(text).toContain('default_tools_approval_mode = "auto"');
    expect(text).toContain("UNIVIEW_MAX_WAIT = \"1500\"");
    expect(text).toContain('ELECTRON_RUN_AS_NODE = "1"');
    expect(await readFile(config + ".uniview-backup", "utf8")).toBe("");
  });

  it("keeps every other byte: other servers and comments survive", async () => {
    const original = [
      "# my codex config",
      "[mcp_servers.github]",
      'command = "node"',
      "",
      "[profiles.fast]",
      'model = "x"',
      "",
    ].join("\n");
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("# my codex config");
    expect(text).toContain("[profiles.fast]");
  });

  it("preserves CRLF line endings", async () => {
    const original = "[mcp_servers.github]\r\ncommand = \"node\"\r\n";
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it("re-connecting replaces the block instead of duplicating it", async () => {
    const c = make();
    await c.connect("codex");
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text.match(/\[mcp_servers\.uniview\]/g)).toHaveLength(1);
    expect(text.match(/\[mcp_servers\.uniview\.env\]/g)).toHaveLength(1);
  });

  it("replaces an old block in the middle of the file and keeps the rest in order", async () => {
    const original = [
      "[a]",
      'k = "1"',
      "[mcp_servers.uniview]",
      'command = "C:\\\\Old\\\\UniView.exe"',
      'args = ["C:\\\\Old\\\\entry.mjs"]',
      "[mcp_servers.uniview.env]",
      'X = "1"',
      "[b]",
      'k = "2"',
      "",
    ].join("\n");
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text).not.toContain("Old");
    expect(text).toContain(quote(EXE));
    expect(text.indexOf("[a]")).toBeLessThan(text.indexOf("[b]"));
    expect(text.match(/\[mcp_servers\.uniview\]/g)).toHaveLength(1);
    expect(text).toContain('[b]\nk = "2"\n');
  });

  it("leaves an unterminated multi-line string untouched and reports an error", async () => {
    const original = 'note = """\nstill going\n[mcp_servers.uniview]\n';
    await writeFile(config, original, "utf8");
    const c = make();
    const res = await c.connect("codex");
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("ignores fake headers in a comment and inside a multi-line string", async () => {
    const original = [
      '# [mcp_servers.uniview]',
      'note = """',
      '[mcp_servers.uniview]',
      '"""',
      "[b]",
      'k = "2"',
      "",
    ].join("\n");
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text.match(/\[mcp_servers\.uniview\]\ncommand/g)).toHaveLength(1);
  });

  it("never touches [mcp_servers.uniview2]", async () => {
    const original = '[mcp_servers.uniview2]\ncommand = "keep-me"\n\ntool_timeout_sec = 5\n';
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    let text = await readFile(config, "utf8");
    expect(text).toContain(original);
    await c.disconnect("codex");
    text = await readFile(config, "utf8");
    expect(text).toBe(original);
  });

  it("never deletes an array-of-tables header that follows our block", async () => {
    const original = [
      "[mcp_servers.uniview]",
      'command = "C:\\\\Old\\\\UniView.exe"',
      "",
      "[[projects]]",
      'name = "docs"',
      "",
    ].join("\n");
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text).toContain('[[projects]]\nname = "docs"\n');
    expect(text).not.toContain("Old");
  });

  it("keeps the comment lines that sit directly above the next header", async () => {
    const original = [
      "[mcp_servers.uniview]",
      'command = "old"',
      "",
      "# about b",
      "[b]",
      'k = 1',
      "",
    ].join("\n");
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    expect(await readFile(config, "utf8")).toContain('# about b\n[b]\nk = 1\n');
    await c.disconnect("codex");
    expect(await readFile(config, "utf8")).toBe('# about b\n[b]\nk = 1\n');
  });

  it("escapes a Windows path with spaces and backslashes", async () => {
    const c = make();
    await c.connect("codex");
    const text = await readFile(config, "utf8");
    expect(text).toContain(`command = "C:\\\\Program Files\\\\UniView\\\\UniView.exe"`);
    expect(text).toContain("args = [\"C:\\\\Program Files\\\\UniView\\\\resources");
    expect(JSON.parse('"C:\\\\Program Files"')).toBe("C:\\Program Files");
  });
});

describe("codex disconnect", () => {
  it("restores the other content byte for byte", async () => {
    const original = "# top\n[mcp_servers.github]\ncommand = \"node\"\n";
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    expect(await c.disconnect("codex")).toEqual({ ok: true });
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("round-trips a fresh file: connect then disconnect gives the original bytes", async () => {
    const c = make();
    await c.connect("codex");
    await c.disconnect("codex");
    expect(await readFile(config, "utf8")).toBe("");
  });

  it("round-trips a CRLF file with other servers", async () => {
    const original = "[mcp_servers.github]\r\ncommand = \"node\"\r\n";
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    await c.disconnect("codex");
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("documents that a file with no final newline gains one", async () => {
    const original = "[a]\nk = 1";
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    await c.disconnect("codex");
    expect(await readFile(config, "utf8")).toBe(original + "\n");
  });

  it("leaves the backup file alone", async () => {
    const original = "[a]\nk = 1\n";
    await writeFile(config, original, "utf8");
    const c = make();
    await c.connect("codex");
    const backup = config + ".uniview-backup";
    await utimes(backup, 1000, 1000);
    await c.disconnect("codex");
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await stat(backup)).mtimeMs).toBeLessThan(1_000_000_000);
  });

  it("writes the backup only once, before the first edit", async () => {
    await writeFile(config, "[a]\nk = 1\n", "utf8");
    const c = make();
    await c.connect("codex");
    await c.connect("codex");
    expect(await readFile(config + ".uniview-backup", "utf8")).toBe("[a]\nk = 1\n");
  });

  it("uses a temp file in the same folder and leaves no temp behind", async () => {
    const c = make();
    await c.connect("codex");
    const names = await import("node:fs").then((m) => m.readdirSync(join(home, ".codex")));
    expect(names.sort()).toEqual(["config.toml", "config.toml.uniview-backup"]);
  });
});

describe("claude", () => {
  it("removes any old entry then adds the JSON spec, with argv and no shell", async () => {
    await plantBin("claude");
    const c = make();
    expect(await c.connect("claude")).toEqual({ ok: true });
    expect(calls[0]!.slice(1)).toEqual(["mcp", "remove", "--scope", "user", "uniview"]);
    expect(calls[1]!.slice(1, 5)).toEqual(["mcp", "add-json", "--scope", "user"]);
    const spec = JSON.parse(calls[1]![6]!);
    expect(spec.command).toBe(EXE);
    expect(spec.args).toEqual([ENTRY]);
    expect(spec.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", UNIVIEW_MAX_WAIT: "1500" });
    expect(calls[0]![0]).toMatch(/claude\.exe$/i);
  });

  it("succeeds even when the old entry was not found", async () => {
    await plantBin("claude");
    const c = make({ execFile: fakeExec({ failRemove: true }) });
    expect(await c.connect("claude")).toEqual({ ok: true });
  });

  it("reports a missing claude on PATH as a plain error", async () => {
    const c = make();
    const res = await c.connect("claude");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("claude");
    expect((await c.status()).claude.installed).toBe(false);
  });

  it("refuses a .cmd launcher instead of enabling a shell", async () => {
    await plantBin("claude", ".cmd");
    const c = make();
    const res = await c.connect("claude");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/\.cmd/i);
    expect(res.error).toContain("shell");
    expect(calls).toEqual([]);
  });

  it("runs the nested claude.exe of an npm install instead of refusing", async () => {
    await plantBin("claude", ".cmd");
    const bin = join(BIN, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude.exe"), "x");
    const c = make();
    expect(await c.connect("claude")).toEqual({ ok: true });
    expect(calls[0]![0]).toBe(join(bin, "claude.exe"));
    expect(envs[0]).toBeUndefined();
  });

  it("runs cli.js with UniView's Electron as Node and the injected env", async () => {
    await plantBin("claude", ".cmd");
    const pkg = join(BIN, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "cli.js"), "x");
    const c = make();
    expect(await c.connect("claude")).toEqual({ ok: true });
    expect(calls[1]![0]).toBe(EXE);
    expect(calls[1]!.slice(1, 4)).toEqual([join(pkg, "cli.js"), "mcp", "add-json"]);
    expect(envs[1]).toEqual({
      PATH: BIN,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("never throws when .claude.json is junk", async () => {
    await plantBin("claude");
    await writeFile(join(home, ".claude.json"), "{not json", "utf8");
    const c = make();
    expect((await c.status()).claude.connected).toBe(false);
    expect((await c.connect("claude")).ok).toBe(true);
  });
});

describe("status", () => {
  it("finds binaries by walking PATH and PATHEXT", async () => {
    await plantBin("codex", ".bat");
    const c = make();
    const s = await c.status();
    expect(s.claude.installed).toBe(false);
    expect(s.codex.installed).toBe(true);
    expect(s.codex.connected).toBe(false);
  });

  it("reports connected and stale when the configured exe differs", async () => {
    await plantBin("claude");
    await plantBin("codex");
    const c = make();
    await c.connect("codex");
    await c.connect("claude");
    let s = await c.status();
    expect(s.claude).toMatchObject({ installed: true, connected: true, stale: false });
    expect(s.codex).toMatchObject({ installed: true, connected: true, stale: false });

    const other = make({ exePath: "D:\\UniView\\UniView.exe" });
    s = await other.status();
    expect(s.claude.stale).toBe(true);
    expect(s.codex.stale).toBe(true);
  });

  it("does not throw for an unknown client", async () => {
    const c = make();
    expect((await c.connect("nope")).ok).toBe(false);
    expect((await c.disconnect("nope")).ok).toBe(false);
  });

  it("respects CODEX_HOME", async () => {
    const alt = join(home, "alt-codex");
    const c = make({ env: { PATH: BIN, PATHEXT: ".EXE", CODEX_HOME: alt } });
    await c.connect("codex");
    expect(await readFile(join(alt, "config.toml"), "utf8")).toContain("[mcp_servers.uniview]");
  });
});

describe("block text", () => {
  it("uses the given line ending", () => {
    expect(codexBlock(EXE, ENTRY, "\r\n")).toContain("\r\n[mcp_servers.uniview.env]\r\n");
    expect(codexBlock(EXE, ENTRY)).not.toContain("\r");
  });
});
