import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

// @ts-expect-error plain ESM module without types
import { buildColdStartCommand, cleanSpawnEnv } from "../../electron/lib/cold-start.mjs";
// @ts-expect-error plain ESM module without types
import { runMcpServer } from "../../electron/lib/mcp-runner.mjs";
// @ts-expect-error plain ESM module without types
import { runEarlyCli } from "../../electron/lib/app-agents.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Packet P27: cold start command builder and handle leak prevention", () => {
  it("Windows packaged: execPath with spaces and empty args produces cmd.exe start with quoted exe", () => {
    // Mutation: missing cmd.exe wrapper, omitting start "" title, or unquoted paths with spaces
    const res = buildColdStartCommand({
      platform: "win32",
      execPath: "C:\\Program Files\\UniView\\UniView.exe",
      args: [],
      env: { ELECTRON_RUN_AS_NODE: "1", PATH: "C:\\bin" },
    });

    expect(res.file).toBe("cmd.exe");
    expect(res.args).toEqual([
      "/d",
      "/s",
      "/c",
      "start",
      '""',
      '"C:\\Program Files\\UniView\\UniView.exe"',
    ]);
    expect(res.options.detached).toBe(true);
    expect(res.options.stdio).toBe("ignore");
    expect(res.options.windowsHide).toBe(true);
    expect(res.options.windowsVerbatimArguments).toBe(true);
    expect(res.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(res.options.env.PATH).toBe("C:\\bin");
  });

  it("Windows unpackaged: extra app path arg is quoted and passed to start", () => {
    // Mutation: omitting appPath argument or failing to quote arguments
    const res = buildColdStartCommand({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      args: ["I:\\Development\\Clone\\Universal\\uniview"],
      env: { PATH: "C:\\bin" },
    });

    expect(res.file).toBe("cmd.exe");
    expect(res.args).toEqual([
      "/d",
      "/s",
      "/c",
      "start",
      '""',
      '"C:\\Program Files\\nodejs\\node.exe"',
      '"I:\\Development\\Clone\\Universal\\uniview"',
    ]);
    expect(res.options.windowsHide).toBe(true);
    expect(res.options.windowsVerbatimArguments).toBe(true);
  });

  it("non-Windows unchanged: direct execPath spawn on darwin and linux without cmd.exe or windows options", () => {
    // Mutation: running cmd.exe on POSIX or adding windows-specific options on non-Windows
    const darwinRes = buildColdStartCommand({
      platform: "darwin",
      execPath: "/Applications/UniView.app/Contents/MacOS/UniView",
      args: ["/opt/app"],
      env: { ELECTRON_RUN_AS_NODE: "1", HOME: "/Users/dev" },
    });

    expect(darwinRes.file).toBe("/Applications/UniView.app/Contents/MacOS/UniView");
    expect(darwinRes.args).toEqual(["/opt/app"]);
    expect(darwinRes.options.detached).toBe(true);
    expect(darwinRes.options.stdio).toBe("ignore");
    expect(darwinRes.options.windowsHide).toBeUndefined();
    expect(darwinRes.options.windowsVerbatimArguments).toBeUndefined();
    expect(darwinRes.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(darwinRes.options.env.HOME).toBe("/Users/dev");

    const linuxRes = buildColdStartCommand({
      platform: "linux",
      execPath: "/usr/bin/uniview",
      args: [],
      env: { USER: "dev" },
    });

    expect(linuxRes.file).toBe("/usr/bin/uniview");
    expect(linuxRes.args).toEqual([]);
    expect(linuxRes.options.windowsHide).toBeUndefined();
    expect(linuxRes.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("env stripping: cleanSpawnEnv removes ELECTRON_RUN_AS_NODE while preserving other vars", () => {
    // Mutation: leaking ELECTRON_RUN_AS_NODE into child environment
    const rawEnv = {
      ELECTRON_RUN_AS_NODE: "1",
      SYSTEMROOT: "C:\\Windows",
      CUSTOM_SETTING: "value",
    };
    const cleaned = cleanSpawnEnv(rawEnv);
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(cleaned.SYSTEMROOT).toBe("C:\\Windows");
    expect(cleaned.CUSTOM_SETTING).toBe("value");

    const cmd = buildColdStartCommand({
      platform: "win32",
      execPath: "C:\\UniView.exe",
      args: [],
      env: rawEnv,
    });
    expect(cmd.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(cmd.options.env.SYSTEMROOT).toBe("C:\\Windows");
  });

  it("hostile characters rejected on Windows: double quotes, %, !, ^, & in execPath and args throw", () => {
    // Mutation: allowing hostile characters leading to cmd.exe command injection or variable expansion
    // Embedded double quotes in execPath must throw on all platforms
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: 'C:\\App"Test\\UniView.exe' })
    ).toThrow(/double quote/i);
    expect(() =>
      buildColdStartCommand({ platform: "darwin", execPath: '/bin/app"evil' })
    ).toThrow(/double quote/i);

    // Hostile cmd characters in execPath on Windows
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\App%TEST%\\UniView.exe" })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\App!TEST!\\UniView.exe" })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\App^Test\\UniView.exe" })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\App&Calc\\UniView.exe" })
    ).toThrow(/hostile/i);

    // Hostile cmd characters in args on Windows
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\UniView.exe", args: ['arg"withquote'] })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\UniView.exe", args: ["%PATH%"] })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\UniView.exe", args: ["!VAR!"] })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\UniView.exe", args: ["arg^caret"] })
    ).toThrow(/hostile/i);
    expect(() =>
      buildColdStartCommand({ platform: "win32", execPath: "C:\\UniView.exe", args: ["arg&calc"] })
    ).toThrow(/hostile/i);
  });

  it("both call sites use the builder: static source inspection", async () => {
    // Mutation: regression in either mcp-runner.mjs or app-agents.mjs using raw spawn instead of buildColdStartCommand
    const mcpRunnerPath = path.resolve(__dirname, "../../electron/lib/mcp-runner.mjs");
    const appAgentsPath = path.resolve(__dirname, "../../electron/lib/app-agents.mjs");

    const mcpContent = await fs.readFile(mcpRunnerPath, "utf8");
    const appAgentsContent = await fs.readFile(appAgentsPath, "utf8");

    // mcp-runner.mjs must use buildColdStartCommand
    expect(mcpContent).toMatch(/buildColdStartCommand\s*\(/);
    expect(mcpContent).not.toMatch(/spawn\s*\(\s*execPath\s*,\s*computeAppSpawnArgs/);

    // app-agents.mjs must use buildColdStartCommand
    expect(appAgentsContent).toMatch(/buildColdStartCommand\s*\(/);
    expect(appAgentsContent).not.toMatch(/spawn\s*\(\s*process\.execPath\s*,\s*computeAppSpawnArgs/);
  });

  it("both call sites use the builder: execution via runEarlyCli and runMcpServer on Windows", async () => {
    // Mutation: default spawnApp ignoring buildColdStartCommand and directly spawning execPath
    const spawnCalls: any[] = [];
    const spawnSpy = {
      mockRestore() {},
    };
    const fakeSpawn = (cmd: any, args: any, opts: any) => {
      spawnCalls.push({ cmd, args, opts });
      return { unref: vi.fn() } as any;
    };

    try {
      // 1. runEarlyCli cold start launcher
      let cliConnectCount = 0;
      await runEarlyCli({
        argv: ["open", "README.md"],
        userDataDir: "I:\\AES\\tmp\\test-cli-launch",
        platform: "win32",
        spawnProcess: fakeSpawn,
        connect: async () => {
          cliConnectCount++;
          if (cliConnectCount === 1) throw new Error("pipe unavailable");
          return {
            request: async () => ({ opened: 1 }),
            close: async () => {},
          };
        },
      }).catch(() => {});

      expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
      const cliSpawn = spawnCalls[0];
      expect(cliSpawn.cmd).toBe("cmd.exe");
      expect(cliSpawn.args).toEqual(
        expect.arrayContaining(["/d", "/s", "/c", "start", '""'])
      );
      expect(cliSpawn.opts.windowsVerbatimArguments).toBe(true);
      expect(cliSpawn.opts.windowsHide).toBe(true);

      // 2. runMcpServer cold start launcher
      spawnCalls.length = 0;
      let mcpConnectCount = 0;
      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const mcpPromise = runMcpServer({
        stdin,
        stdout,
        stderr: new PassThrough(),
        platform: "win32",
        spawnProcess: fakeSpawn,
        userDataDir: "I:\\AES\\tmp\\test-mcp-launch",
        connect: async () => {
          mcpConnectCount++;
          if (mcpConnectCount === 1) throw new Error("pipe unavailable");
          return {
            request: async () => ({ opened: 1 }),
            close: async () => {},
          };
        },
      });

      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } } }) + "\n");
      await new Promise((r) => setTimeout(r, 20));
      stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await new Promise((r) => setTimeout(r, 20));
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_files", arguments: { paths: ["C:\\a.txt"] } } }) + "\n");
      await new Promise((r) => setTimeout(r, 50));
      stdin.end();
      await mcpPromise;

      expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
      const mcpSpawn = spawnCalls[0];
      expect(mcpSpawn.cmd).toBe("cmd.exe");
      expect(mcpSpawn.args).toEqual(
        expect.arrayContaining(["/d", "/s", "/c", "start", '""'])
      );
      expect(mcpSpawn.opts.windowsVerbatimArguments).toBe(true);
      expect(mcpSpawn.opts.windowsHide).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
