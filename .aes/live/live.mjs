// Live proof on the PACKAGED app with a real agent CLI. See .aes/tasks/mcp-first-spec.md.
// Usage: node .aes/live/live.mjs claude|codex|connect
import { _electron as electron } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = path.join(ROOT, "release", "win-unpacked", "UniView.exe");
const ENTRY = path.join(ROOT, "release", "win-unpacked", "resources", "app.asar", "electron", "mcp-entry.mjs");
const LIVE = path.join(ROOT, ".aes", "live");
const TMPBASE = "I:\\AES\\Temp\\uniview-live";
const PROMPTS = [
  "Show me note.md in this folder.",
  "Open note.md",
  "Create a short report.md about colours, then let me see it.",
];
const OPEN_PROMPT = "Open note.md in UniView, then wait for my instructions there.";
const SEND = "Change RED to BLUE in the file.";
const MODEL = process.env.LIVE_CLAUDE_MODEL || "claude-haiku-5-5";
const CODEX_CANDIDATES = ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-terra"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = async (p) => { try { return crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex"); } catch { return null; } };
const toml = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

async function poll(fn, timeoutSec, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return { ok: true, sec: +((Date.now() - start) / 1000).toFixed(1) };
    if (Date.now() - start > timeoutSec * 1000) return { ok: false, sec: +((Date.now() - start) / 1000).toFixed(1), label };
    await sleep(250);
  }
}

function realConfigHashes() {
  const home = os.homedir();
  return { claudeJson: path.join(home, ".claude.json"), codexToml: path.join(home, ".codex", "config.toml") };
}

async function launchApp(env, args = []) {
  const clean = { ...process.env, ...env };
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.UNIVIEW_USER_DATA;
  const app = await electron.launch({ executablePath: EXE, args, env: clean });
  const page = await app.firstWindow();
  await page.locator(".chrome").waitFor({ state: "visible", timeout: 60_000 });
  return { app, page };
}

/** The packaged app derives userData from %APPDATA%, so an isolated APPDATA isolates it (and its single-instance lock). */
async function runDirFor(agent) {
  const run = path.join(TMPBASE, `${agent}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const appdata = path.join(run, "appdata");
  await fs.mkdir(appdata, { recursive: true });
  return { run, appdata, userData: path.join(appdata, "UniView") };
}

function spawnAgent(file, args, env, cwd) {
  const started = Date.now();
  // stdin must be a closed handle: both CLIs otherwise block waiting for piped input.
  const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { out.stdout = (out.stdout + d).slice(-20000); });
  child.stderr.on("data", (d) => { out.stderr = (out.stderr + d).slice(-20000); });
  const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal, sec: +((Date.now() - started) / 1000).toFixed(1) })));
  return { child, out, exited };
}

/** Codex: the `model` key from the person's config, then the candidate list, until one answers. */
async function resolveCodexModel() {
  const cfg = path.join(os.homedir(), ".codex", "config.toml");
  const text = await fs.readFile(cfg, "utf8").catch(() => "");
  const m = /^\s*model\s*=\s*"([^"]*)"/m.exec(text);
  const fromConfig = m ? m[1] : null;
  process.stdout.write(`[codex] config model: ${fromConfig ?? "(none)"}\n`);
  const probeDir = path.join(TMPBASE, "codex-probe");
  await fs.mkdir(probeDir, { recursive: true });
  const tried = [];
  for (const name of CODEX_CANDIDATES) {
    const s = spawnAgent("codex", ["exec", "--skip-git-repo-check", "-m", name, "Reply with exactly OK."], process.env, probeDir);
    const r = await Promise.race([s.exited, sleep(60_000).then(() => null)]);
    if (!r) s.child.kill();
    const ok = !!r && r.code === 0 && !/model_not_found/.test(s.out.stderr + s.out.stdout);
    tried.push({ model: name, ok, code: r ? r.code : null });
    process.stdout.write(`[codex] probe ${name}: ${ok ? "ok" : "no"}\n`);
    if (ok) return { model: name, tried };
  }
  return { model: null, tried };
}

async function scenario(agent, prompt, n, codex) {
  const { run, appdata, userData } = await runDirFor(agent);
  const note = path.join(run, "note.md");
  await fs.writeFile(note, "The colour is RED.\n");
  const mcpEnv = { ELECTRON_RUN_AS_NODE: "1", UNIVIEW_MAX_WAIT: process.env.LIVE_MAX_WAIT || "50", APPDATA: appdata, UNIVIEW_USER_DATA: userData };
  const ev = { agent, model: agent === "claude" ? MODEL : codex?.model || "none-accepted", prompt, runDir: run, steps: [], pass: false, failedStep: null };
  let childRef = null;
  let page = null;
  let appRef = null;
  const step = async (name, fn) => { const r = await fn(); ev.steps.push({ step: name, ...r }); if (!r.ok) { ev.failedStep = name; ev.pass = false; throw new Error(`step failed: ${name}`); } return r; };

  const hashes = realConfigHashes();
  const before = { claude: await sha(hashes.claudeJson), codex: await sha(hashes.codexToml) };

  try {
    await step("a.write-note", async () => ({ ok: true, sec: 0 }));
    const t0 = Date.now();
    const launched = await launchApp({ APPDATA: appdata }, ["--user-data-dir=" + userData]);
    appRef = launched.app;
    page = launched.page;
    ev.steps.push({ step: "b.launch", ok: true, sec: +((Date.now() - t0) / 1000).toFixed(1) });
    await launched.app.evaluate(async ({ dialog }) => {
      globalThis.__dialogCalls = 0;
      dialog.showMessageBox = async () => { globalThis.__dialogCalls++; return { response: 0, checkboxChecked: false }; };
    });

    const env = { ...process.env, APPDATA: appdata, UNIVIEW_USER_DATA: userData };
    let spawnSpec;
    if (agent === "claude") {
      const cfg = path.join(run, "mcp-claude.json");
      await fs.writeFile(cfg, JSON.stringify({ mcpServers: { uniview: { command: EXE, args: [ENTRY], env: mcpEnv } } }, null, 2));
      spawnSpec = ["claude", ["-p", prompt, "--model", MODEL, "--strict-mcp-config", "--mcp-config", cfg,
        "--allowedTools", "mcp__uniview__open_files,mcp__uniview__wait_for_user_message,mcp__uniview__post_message,Read,Edit,Write"]];
    } else {
      const c = (...kv) => ["-c", kv.join("=")];
      spawnSpec = ["codex", ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", ...(codex?.model ? ["-m", codex.model] : []),
        ...c("mcp_servers.uniview.command", toml(EXE)),
        ...c("mcp_servers.uniview.args", "[" + toml(ENTRY) + "]"),
        ...c("mcp_servers.uniview.env", "{" + Object.entries(mcpEnv).map(([k, v]) => `${k}=${toml(v)}`).join(",") + "}"),
        ...c("mcp_servers.uniview.tool_timeout_sec", "120"),
        ...c("mcp_servers.uniview.default_tools_approval_mode", toml("auto")),
        prompt]];
    }
    const spawned = spawnAgent(spawnSpec[0], spawnSpec[1], env, run);
    childRef = spawned;
    ev.steps.push({ step: "c.spawn-agent", ok: true, sec: 0 });

    const tabsBefore = await page.locator(".tab").count();
    const titlesBefore = await page.locator(".tab").allInnerTexts().catch(() => []);
    const startedAt = Date.now();
    ev.tabCountBefore = tabsBefore;
    const opened = await step("d.tab-and-listening", async () => {
      ev.barSamples = [];
      const r = await poll(async () => {
        const titles = await page.locator(".tab").allInnerTexts().catch(() => []);
        const tabs = titles.some((t) => !titlesBefore.includes(t));
        const bars = await page.locator(".agent-bar-status").allInnerTexts().catch(() => []);
        const sample = `${titles.length} tabs | ${bars.join(" /")}`;
        if (ev.barSamples[ev.barSamples.length - 1]?.sample !== sample) ev.barSamples.push({ sec: Math.round((Date.now() - startedAt) / 1000), sample });
        if (ev.barSamples.length > 12) ev.barSamples.shift();
        return tabs && bars.some((b) => b.includes("Agent is listening"));
      }, 180, "tab+listening");
      ev.tabTitles = await page.locator(".tab").allInnerTexts().catch(() => []);
      ev.agentOpenedFile = ev.tabTitles.some((t) => !titlesBefore.includes(t));
      const st = await page.locator(".agent-bar-status").allInnerTexts().catch(() => []);
      ev.agentEnteredLoop = r.ok;
      ev.barStatusAtOpen = st.join(" | ");
      await page.screenshot({ path: path.join(LIVE, `shot-${agent}-1-listening.png`) });
      return r;
    });

    await step("e.send", async () => {
      const box = page.locator(".agent-bar-input");
      await box.click({ timeout: 20_000 });
      await sleep(Number(process.env.LIVE_SEND_DELAY || 0) * 1000);
      await box.fill(SEND);
      const start = Date.now();
      await box.press("Enter");
      ev.sentAt = new Date().toISOString();
      return { ok: true, sec: +((Date.now() - start) / 1000).toFixed(1) };
    });

    const snapshot = new Map();
    for (const name of await fs.readdir(run).catch(() => [])) snapshot.set(name, await fs.readFile(path.join(run, name), "utf8").catch(() => ""));
    const editedOnDisk = async () => {
      for (const name of await fs.readdir(run).catch(() => [])) {
        const content = await fs.readFile(path.join(run, name), "utf8").catch(() => "");
        if (content !== snapshot.get(name) && /blue/i.test(content)) return name;
      }
      return null;
    };
    const delivered = await step("f.file-and-reload", async () => {
      let disk = false, shown = false, bar = false, tabsSame = false;
      const start = Date.now();
      while (Date.now() - start < 300_000) {
        disk = (await editedOnDisk()) !== null;
        shown = /blue/i.test(await page.locator(".tab-panel:not([hidden])").innerText().catch(() => ""));
        bar = (await page.locator(".agent-bar-messages").innerText().catch(() => "")).includes("Agent:");
        tabsSame = (await page.locator(".tab").count()) === tabsBefore;
        if (disk && shown && bar && tabsSame) break;
        await sleep(500);
      }
      ev.fileBefore = "The colour is RED.\n";
      ev.editedFile = await editedOnDisk();
      ev.fileAfter = await fs.readFile(note, "utf8").catch(() => "");
      ev.tabCountAfter = await page.locator(".tab").count();
      ev.barLines = await page.locator(".agent-bar-message").allInnerTexts().catch(() => []);
      ev.dialogCalls = await appRef.evaluate(() => globalThis.__dialogCalls || 0).catch(() => null);
      await page.screenshot({ path: path.join(LIVE, `shot-${agent}-2-edited.png`) });
      const sec = +((Date.now() - start) / 1000).toFixed(1);
      return { ok: disk && shown && bar && tabsSame, sec, disk, shown, bar, tabsSame };
    });
    ev.agentEnteredLoop = ev.agentEnteredLoop && delivered.ok;

    await step("g.end-exit", async () => {
      await page.locator(".agent-bar-end").click({ timeout: 20_000 });
      const exitStarted = Date.now();
      const r = await Promise.race([
        spawned.exited,
        sleep(120_000).then(() => null),
      ]);
      const sec = +((Date.now() - exitStarted) / 1000).toFixed(1);
      ev.exit = r || { code: null, timedOut: true };
      ev.exitSec = sec;
      ev.agentStdoutTail = spawned.out.stdout.slice(-3000);
      ev.agentStderrTail = spawned.out.stderr.slice(-3000);
      return { ok: !!r, sec, code: r?.code, signal: r?.signal };
    });

    ev.pass = true;
  } catch (err) {
    ev.failedStep = ev.failedStep || "unknown";
    ev.error = String(err && err.message ? err.message : err);
    if (childRef && !ev.exit) { childRef.child.kill(); ev.exit = { code: null, killed: true }; ev.agentStdoutTail = childRef.out.stdout.slice(-3000); ev.agentStderrTail = childRef.out.stderr.slice(-3000); }
    if (appRef) ev.dialogCalls = await appRef.evaluate(() => globalThis.__dialogCalls || 0).catch(() => null);
    if (page) await page.screenshot({ path: path.join(LIVE, `shot-${agent}-fail.png`) }).catch(() => {});
  } finally {
    ev.realConfigUnchanged = { claude: (await sha(hashes.claudeJson)) === before.claude, codex: (await sha(hashes.codexToml)) === before.codex };
    if (codex) ev.modelProbe = codex;
    await fs.writeFile(path.join(LIVE, `evidence-${agent}-${n}.json`), JSON.stringify(ev, null, 2));
    process.stdout.write(`\n[${agent}-${n}] pass=${ev.pass} failedStep=${ev.failedStep || "-"}\n`);
    if (appRef) await appRef.close().catch(() => {});
  }
}

async function connectCheck() {
  const { run, appdata, userData } = await runDirFor("connect");
  const claudeDir = path.join(run, "claude-config");
  const codexHome = path.join(run, "codex-home");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  const hashes = realConfigHashes();
  const before = { claude: await sha(hashes.claudeJson), codex: await sha(hashes.codexToml) };
  const ev = { agent: "connect", steps: [], pass: false, failures: [], runDir: run, userData };
  const step = async (name, fn) => {
    try {
      const r = await fn();
      ev.steps.push({ step: name, ...r });
      if (!r.ok) ev.failures.push(name);
      return r;
    } catch (err) {
      ev.steps.push({ step: name, ok: false, sec: 0, error: String(err && err.message ? err.message : err) });
      ev.failures.push(name);
      return { ok: false };
    }
  };
  const cfgToml = path.join(codexHome, "config.toml");
  const claudeList = () => {
    try {
      return execFileSync("claude", ["mcp", "list"], { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }, encoding: "utf8", timeout: 90_000, shell: false }).slice(0, 2000);
    } catch (e) { return `ERROR: ${e.message}`; }
  };
  let app = null;
  try {
    const launched = await launchApp({ APPDATA: appdata, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome }, ["--user-data-dir=" + userData]);
    app = launched.app;
    const page = launched.page;
    ev.steps.push({ step: "launch", ok: true, sec: 0 });

    // Each client runs on its own; one client's failure must not hide the other's result.
    for (const [key, name] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
      const row = () => page.locator(".home-agent-item", { hasText: name });
      await step(`${key}.connect`, async () => {
        const start = Date.now();
        await row().getByRole("button", { name: /Connect/ }).click({ timeout: 20_000 });
        await page.locator(`.home-agent-confirm[aria-label="Connect ${name}"]`).getByRole("button", { name: "Connect" }).click();
        const r = await poll(async () => (await row().innerText()).includes("Connected"), 120, `connected-${key}`);
        return { ...r, sec: +((Date.now() - start) / 1000).toFixed(1), uiRow: await row().innerText().catch(() => "") };
      });
    }

    await step("config-written", async () => {
      const tomlText = await fs.readFile(cfgToml, "utf8").catch(() => "");
      ev.codexConfigBlock = tomlText.includes("[mcp_servers.uniview]");
      ev.claudeConfigDirFiles = await fs.readdir(claudeDir).catch(() => []);
      ev.claudeMcpList = claudeList();
      ev.claudeListsUniview = /uniview/i.test(ev.claudeMcpList);
      await page.screenshot({ path: path.join(LIVE, "shot-connect-home.png") });
      return { ok: ev.codexConfigBlock && ev.claudeListsUniview, sec: 0, codexBlock: ev.codexConfigBlock, claudeList: ev.claudeListsUniview };
    });

    for (const [key, name] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
      const row = () => page.locator(".home-agent-item", { hasText: name });
      await step(`${key}.disconnect`, async () => {
        const btn = row().getByRole("button", { name: "Disconnect" });
        if ((await btn.count()) === 0) return { ok: false, sec: 0, note: "no Disconnect control: the UI never showed Connected for this client" };
        await btn.click({ timeout: 20_000 });
        const r = await poll(async () => (await row().innerText()).includes("Connect"), 120, `disconnected-${key}`);
        return r;
      });
    }

    await step("gone-after-disconnect", async () => {
      const tomlText = await fs.readFile(cfgToml, "utf8").catch(() => "");
      ev.codexBlockAfterDisconnect = tomlText.includes("[mcp_servers.uniview]");
      // `claude mcp remove` can flush its config a moment after it exits, so wait for the entry to be gone.
      ev.claudeUniviewGone = (await poll(async () => {
        ev.claudeMcpListAfterDisconnect = claudeList();
        return !/uniview/i.test(ev.claudeMcpListAfterDisconnect);
      }, 60, "claude-config-gone")).ok;
      ev.claudeConfigDirFilesAfter = await fs.readdir(claudeDir).catch(() => []);
      return { ok: !ev.codexBlockAfterDisconnect && ev.claudeUniviewGone, sec: 0 };
    });
    ev.pass = ev.failures.length === 0;
  } catch (err) {
    ev.error = String(err && err.message ? err.message : err);
  } finally {
    ev.realConfigUnchanged = { claude: (await sha(hashes.claudeJson)) === before.claude, codex: (await sha(hashes.codexToml)) === before.codex };
    await fs.writeFile(path.join(LIVE, "evidence-connect.json"), JSON.stringify(ev, null, 2));
    process.stdout.write(`\n[connect] pass=${ev.pass} failures=${ev.failures.join(",") || "-"}\n`);
    if (app) await app.close().catch(() => {});
    process.exit(0);
  }
}

const arg = process.argv[2];
const nums = process.argv.slice(3).map(Number).filter((v) => Number.isInteger(v) && v >= 0);
if (arg === "connect") await connectCheck();
else if (arg === "claude" || arg === "codex") {
  const codex = arg === "codex" ? await resolveCodexModel() : null;
  for (const n of nums.length ? nums : [1]) {
    const prompt = n === 0 ? OPEN_PROMPT : PROMPTS[n - 1] ?? OPEN_PROMPT;
    await scenario(arg, prompt, n, codex);
  }
} else { process.stderr.write("usage: node .aes/live/live.mjs claude|codex|connect [n...]\n"); process.exit(2); }
