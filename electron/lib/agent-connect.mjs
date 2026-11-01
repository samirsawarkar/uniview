// Agent connect: wires UniView's MCP server into Claude Code and Codex CLI.
// Pure Node ESM, every dependency injected, so tests never touch a real home folder.

import path from "node:path";
import { promisify } from "node:util";
import { execFile as nodeExecFile } from "node:child_process";

export const MAX_WAIT = 1500;
export const CLIENTS = ["claude", "codex"];
const CODEX_SECTION = "mcp_servers.uniview";
const CODEX_KEYS = { tool_timeout_sec: 1800, startup_timeout_sec: 30 };

const fail = (error) => ({ ok: false, error });

/** TOML basic string / JSON string: same escaping for both. */
export function quote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function serverSpec(exePath, entryPath) {
  return {
    type: "stdio",
    command: exePath,
    args: [entryPath],
    env: { ELECTRON_RUN_AS_NODE: "1", UNIVIEW_MAX_WAIT: String(MAX_WAIT) },
  };
}

export function codexBlock(exePath, entryPath, eol = "\n") {
  const lines = [
    `[${CODEX_SECTION}]`,
    `command = ${quote(exePath)}`,
    `args = [${quote(entryPath)}]`,
    `tool_timeout_sec = ${CODEX_KEYS.tool_timeout_sec}`,
    `startup_timeout_sec = ${CODEX_KEYS.startup_timeout_sec}`,
    `default_tools_approval_mode = "auto"`,
    "",
    `[${CODEX_SECTION}.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `UNIVIEW_MAX_WAIT = "${MAX_WAIT}"`,
    "",
  ];
  return lines.join(eol) + eol;
}

// Table headers, ignoring anything inside a string, a multi-line string or a comment.
// ponytail: line-oriented scan, not a TOML parser. Ceiling: a multi-line array whose
// continuation line starts with "[" can be mistaken for a header. Upgrade path: parse
// with a real TOML reader if such files ever show up in practice.
function scanHeaders(lines) {
  const found = [];
  let inML = null;
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(/\r?\n$/, "");
    const startedInML = inML !== null;
    let p = 0;
    while (p < body.length) {
      if (inML) {
        if (body.startsWith(inML, p)) {
          inML = null;
          p += 3;
        } else p++;
      } else if (body[p] === "#") break;
      else if (body.startsWith('"""', p)) {
        inML = '"""';
        p += 3;
      } else if (body.startsWith("'''", p)) {
        inML = "'''";
        p += 3;
      } else if (body[p] === '"' || body[p] === "'") {
        const q = body[p];
        let j = p + 1;
        while (j < body.length) {
          if (q === '"' && body[j] === "\\") j += 2;
          else if (body[j] === q) {
            j++;
            break;
          } else j++;
        }
        p = j;
      } else p++;
    }
    if (startedInML) continue;
    const t = body.trimStart();
    // An array-of-tables header ([[x]]) is never one of ours, so it reports no name.
    const m = /^\[(\[?)([^\[\]\n]*)\]\]?/.exec(t);
    if (m) found.push({ line: i, name: m[1] ? "" : m[2].trim() });
  }
  return { headers: found, unterminated: inML !== null };
}

/** Ranges of UniView's tables: each starts at its header and runs to the next header. */
function univiewRanges(lines) {
  const { headers, unterminated } = scanHeaders(lines);
  if (unterminated) return { error: "Malformed config.toml: an unterminated multi-line string." };
  const isOurs = (n) => n === CODEX_SECTION || n.startsWith(CODEX_SECTION + ".");
  const ranges = [];
  for (let h = 0; h < headers.length; h++) {
    if (!isOurs(headers[h].name)) continue;
    let end = headers[h + 1] ? headers[h + 1].line : lines.length;
    // Comments directly above the next header belong to that table, not to ours.
    if (headers[h + 1]) while (end > headers[h].line + 1 && /^\s*#/.test(lines[end - 1])) end--;
    ranges.push([headers[h].line, end]);
  }
  return { ranges };
}

/** Text with UniView's tables removed. Nothing else changes. */
export function stripCodexBlock(text) {
  const lines = text.split(/(?<=\n)/);
  const { ranges, error } = univiewRanges(lines);
  if (error) return { error };
  const drop = new Set();
  for (const [start, end] of ranges) for (let i = start; i < end; i++) drop.add(i);
  return { text: lines.filter((_, i) => !drop.has(i)).join(""), found: ranges.length > 0 };
}

export function applyCodexBlock(text, exePath, entryPath) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const stripped = stripCodexBlock(text);
  if (stripped.error) return { error: stripped.error };
  let base = stripped.text;
  if (base.length > 0 && !base.endsWith("\n")) base += eol;
  return { text: base + codexBlock(exePath, entryPath, eol) };
}

/** Walk PATH and PATHEXT by hand. No shell, ever. */
export async function resolveBinary(name, { env, fs, platform }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":");
  const raw = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = platform === "win32" ? raw.split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (await isFile(fs, candidate)) return { path: candidate };
    }
  }
  return { error: `${name} was not found on PATH.` };
}

async function isFile(fs, file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export function createAgentConnect({
  homedir,
  env = {},
  execFile,
  fs,
  exePath,
  entryPath,
  platform = process.platform,
}) {
  const run = execFile || promisify(nodeExecFile);
  const p = platform === "win32" ? path.win32 : path.posix;
  const codexDir = env.CODEX_HOME ? env.CODEX_HOME : p.join(homedir, ".codex");
  const codexConfig = p.join(codexDir, "config.toml");
  const claudeConfig = env.CLAUDE_CONFIG_DIR ? p.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : p.join(homedir, ".claude.json");

  async function claudeCli() {
    const found = await resolveBinary("claude", { env, fs, platform });
    if (found.error) return fail(found.error);
    if (!/\.(cmd|bat)$/i.test(found.path)) return { path: found.path, argv: [] };
    // An npm install's .cmd shim: look beside it for a direct route. Still no shell.
    const pkg = p.join(p.dirname(found.path), "node_modules", "@anthropic-ai", "claude-code");
    const exe = p.join(pkg, "bin", "claude.exe");
    if (await isFile(fs, exe)) return { path: exe, argv: [] };
    const script = p.join(pkg, "cli.js");
    if (await isFile(fs, script)) {
      // UniView's Electron standing in as Node.
      return { path: exePath, argv: [script], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
    }
    return launcherError("claude", found.path);
  }

  /** No shell, ever: a .cmd/.bat launcher cannot be run safely, so refuse it. */
  function launcherError(name, file) {
    if (!/\.(cmd|bat)$/i.test(file)) return null;
    return fail(
      `${name} is a ${p.extname(file)} launcher (${file}); UniView will not run it through a shell. Install the native ${name} binary, then try again.`,
    );
  }

  async function call(bin, args, extraEnv) {
    const opts = { windowsHide: true, timeout: 30000 };
    if (extraEnv) opts.env = extraEnv;
    try {
      await run(bin, args, opts);
      return { ok: true };
    } catch (err) {
      const detail = String(err?.stderr || err?.message || err).split("\n")[0].trim();
      return fail(detail || `${bin} exited with an error.`);
    }
  }

  async function readText(file) {
    try {
      return { text: await fs.readFile(file, "utf8") };
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { text: "" };
      return { error: `Could not read ${file}.` };
    }
  }

  /** Write via a sibling temp file, but only if the file still holds what the caller read. */
  async function writeAtomic(file, text, expected) {
    const tmp = file + ".uniview-tmp";
    await fs.writeFile(tmp, text, "utf8");
    try {
      const now = await readText(file);
      if (now.text !== expected) throw new Error(`${file} changed while UniView was editing it; nothing was written. Try again.`);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function backupOnce(file, text) {
    // Nothing to back up (missing or empty file): leave room for a later real backup.
    if (text === "") return;
    try {
      await fs.writeFile(file + ".uniview-backup", text, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if (err && err.code === "EEXIST") return;
      throw err;
    }
  }

  async function claudeEntry() {
    const read = await readText(claudeConfig);
    if (read.error) return null;
    try {
      const entry = JSON.parse(read.text)?.mcpServers?.uniview;
      return entry && typeof entry === "object" ? entry : null;
    } catch {
      return null;
    }
  }

  async function status() {
    const out = { ok: true };
    for (const client of CLIENTS) {
      const found = await resolveBinary(client, { env, fs, platform });
      const entry = client === "claude" ? await claudeEntry() : null;
      let present = Boolean(entry);
      let stale = false;
      if (client === "codex") {
        const read = await readText(codexConfig);
        const text = read.error ? "" : read.text;
        present = stripCodexBlock(text).found === true;
        stale = present && !text.includes(quote(exePath));
      } else if (present) {
        stale = entry.command !== exePath;
      }
      out[client] = { installed: !found.error, connected: present, stale };
    }
    return out;
  }

  async function connect(client) {
    if (!CLIENTS.includes(client)) return fail(`Unknown client: ${String(client)}.`);
    if (client === "claude") {
      // Claude Code owns its own config; never edit ~/.claude.json by hand.
      const cli = await claudeCli();
      if (cli.error) return cli;
      await call(cli.path, [...cli.argv, "mcp", "remove", "--scope", "user", "uniview"], cli.env);
      return call(cli.path, [
        ...cli.argv,
        "mcp",
        "add-json",
        "--scope",
        "user",
        "uniview",
        JSON.stringify(serverSpec(exePath, entryPath)),
      ], cli.env);
    }
    try {
      await fs.mkdir(codexDir, { recursive: true });
      const read = await readText(codexConfig);
      if (read.error) return fail(read.error);
      const next = applyCodexBlock(read.text, exePath, entryPath);
      if (next.error) return fail(next.error);
      await backupOnce(codexConfig, read.text);
      await writeAtomic(codexConfig, next.text, read.text);
      return { ok: true };
    } catch (err) {
      return fail(`Could not update ${codexConfig}: ${err?.code || err?.message || "unknown error"}.`);
    }
  }

  async function disconnect(client) {
    if (!CLIENTS.includes(client)) return fail(`Unknown client: ${String(client)}.`);
    if (client === "claude") {
      const cli = await claudeCli();
      if (cli.error) return cli;
      return call(cli.path, [...cli.argv, "mcp", "remove", "--scope", "user", "uniview"], cli.env);
    }
    try {
      const read = await readText(codexConfig);
      if (read.error) return fail(read.error);
      const next = stripCodexBlock(read.text);
      if (next.error) return fail(next.error);
      if (next.found) await writeAtomic(codexConfig, next.text, read.text);
      return { ok: true };
    } catch (err) {
      return fail(`Could not update ${codexConfig}: ${err?.code || err?.message || "unknown error"}.`);
    }
  }

  return { status, connect, disconnect };
}
