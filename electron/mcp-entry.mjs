#!/usr/bin/env node
// Standalone plain Node ESM entry for UniView MCP server (Packet P25).
// Runs without Electron imports, using ELECTRON_RUN_AS_NODE=1 in the packaged build
// or plain node in test/dev environments.

import { runMcpServer } from "./lib/mcp-runner.mjs";

const code = await runMcpServer();
if (typeof code === "number") {
  process.exitCode = code;
}
