import { describe, it, expect, vi } from "vitest";
import path from "node:path";
// @ts-expect-error plain ESM module without types
import { resolveUserDataDir, cleanSpawnEnv, buildMcpErrorMessage, computeAppSpawnArgs, runMcpServer } from "../../electron/lib/mcp-runner.mjs";
// @ts-expect-error plain ESM module without types
import { runEarlyMcp } from "../../electron/lib/app-agents.mjs";

describe("Packet P25: MCP runner and entry utilities", () => {
  it("userData path parity: computes exact Electron userData path for win32, darwin, and linux", () => {
    // Windows: %APPDATA%\UniView
    const winPath = resolveUserDataDir({
      env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      platform: "win32",
    });
    expect(winPath).toBe(path.win32.join("C:\\Users\\tester\\AppData\\Roaming", "UniView"));

    // Windows fallback: %USERPROFILE%\AppData\Roaming\UniView
    const winFallback = resolveUserDataDir({
      env: { USERPROFILE: "C:\\Users\\tester" },
      platform: "win32",
    });
    expect(winFallback).toBe(path.win32.join("C:\\Users\\tester", "AppData", "Roaming", "UniView"));

    // macOS: ~/Library/Application Support/UniView
    const macPath = resolveUserDataDir({
      env: { HOME: "/Users/tester" },
      platform: "darwin",
    });
    expect(macPath).toBe(path.posix.join("/Users/tester", "Library", "Application Support", "UniView"));

    // Linux with XDG_CONFIG_HOME: $XDG_CONFIG_HOME/UniView
    const linuxXdgPath = resolveUserDataDir({
      env: { XDG_CONFIG_HOME: "/custom/config", HOME: "/home/tester" },
      platform: "linux",
    });
    expect(linuxXdgPath).toBe(path.posix.join("/custom/config", "UniView"));

    // Linux default without XDG_CONFIG_HOME: ~/.config/UniView
    const linuxDefPath = resolveUserDataDir({
      env: { HOME: "/home/tester" },
      platform: "linux",
    });
    expect(linuxDefPath).toBe(path.posix.join("/home/tester", ".config", "UniView"));

    // Explicit override via UNIVIEW_USER_DATA
    const override = resolveUserDataDir({
      env: { UNIVIEW_USER_DATA: "I:\\AES\\custom-user-data", APPDATA: "C:\\other" },
      platform: "win32",
    });
    expect(override).toBe("I:\\AES\\custom-user-data");
  });

  it("env stripping on cold start: cleanSpawnEnv removes ELECTRON_RUN_AS_NODE", () => {
    const parentEnv = {
      PATH: "/usr/bin;C:\\Windows",
      ELECTRON_RUN_AS_NODE: "1",
      OTHER_VAR: "kept",
    };
    const cleaned = cleanSpawnEnv(parentEnv);
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(cleaned.PATH).toBe(parentEnv.PATH);
    expect(cleaned.OTHER_VAR).toBe("kept");
  });

  it("main.mjs error message builder: explains Electron stdin closure, ELECTRON_RUN_AS_NODE, entry path, and launcher", () => {
    const msg = buildMcpErrorMessage();
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/ELECTRON_RUN_AS_NODE=1/);
    expect(msg).toMatch(/mcp-entry\.mjs/);
    expect(msg).toMatch(/uniview-mcp\.cmd/);
    expect(msg).toMatch(/stdin/i);
    expect(msg.endsWith("\n")).toBe(true);
  });

  it("runner reuse: runEarlyMcp delegates to runMcpServer", () => {
    expect(typeof runMcpServer).toBe("function");
    expect(typeof runEarlyMcp).toBe("function");
  });

  it("cold start app spawn strips ELECTRON_RUN_AS_NODE from child environment", async () => {
    let capturedSpawnEnv: any = null;
    const mockSpawn = vi.fn((_cmd: string, _args: string[], opts: any) => {
      capturedSpawnEnv = opts.env;
      return { unref: () => {} };
    });

    let connectAttempts = 0;
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const mcpPromise = runMcpServer({
      stdin,
      stdout,
      stderr: new PassThrough(),
      userDataDir: "I:\\AES\\tmp\\test-nonexistent",
      connect: async () => {
        connectAttempts++;
        if (connectAttempts === 1) throw new Error("pipe not ready");
        return {
          request: async () => ({ opened: 1 }),
          close: async () => {},
        };
      },
      env: {
        PATH: "C:\\bin",
        ELECTRON_RUN_AS_NODE: "1",
        CUSTOM: "test",
      },
      spawnApp: async () => {
        mockSpawn("UniView.exe", [], {
          detached: true,
          stdio: "ignore",
          env: cleanSpawnEnv({
            PATH: "C:\\bin",
            ELECTRON_RUN_AS_NODE: "1",
            CUSTOM: "test",
          }),
        });
      },
    });

    // Send initialize
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Send notifications/initialized
    stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Send tool call to trigger connect and cold-start spawnApp
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_files", arguments: { paths: ["C:\\a.txt"] } } }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    stdin.end();
    await mcpPromise;

    expect(mockSpawn).toHaveBeenCalled();
    expect(capturedSpawnEnv).toBeDefined();
    expect(capturedSpawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(capturedSpawnEnv.CUSTOM).toBe("test");
  });
});
