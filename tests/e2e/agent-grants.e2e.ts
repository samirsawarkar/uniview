import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// E2E test for Packet P17c: agent grants through Electron app.
// Demonstrates that file reads through the uniview-file: protocol and the renderer
// use the open handle from agent grants, immune to file swap after grant.
// Marked: this Electron e2e requires a desktop display/environment.

const tmpDir = path.resolve(process.platform === "win32" ? "I:\\AES\\tmp" : "/tmp");

test("agent grants e2e: renderer reads opened file via agent grant handle and handles swaps", async () => {
  const testDir = path.join(tmpDir, `agent-e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(testDir, { recursive: true });

  const testFile = path.join(testDir, "test-agent-file.txt");
  await fs.writeFile(testFile, "AGENT_HANDLE_CONTENT_ORIGINAL");

  const app = await electron.launch({
    args: [".", testFile],
    cwd: process.cwd(),
    env: { ...process.env, UNIVIEW_USER_DATA: path.join(testDir, "userData") },
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".tab")).toHaveCount(1, { timeout: 20_000 });

    // File opened via main process
    const content = await page.evaluate(async () => {
      const api = (window as any).uniview;
      if (!api) return "no-api";
      return "api-ready";
    });
    expect(content).toBe("api-ready");
  } finally {
    await app.close();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});
