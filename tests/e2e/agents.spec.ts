import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";
// @ts-expect-error plain ESM module without types
import { readBridgeKey, bridgeEndpoint, windowsUserSid, ensureInstallId } from "../../electron/lib/bridge-key.mjs";

const tmpBase = process.platform === "win32" ? "I:\\AES\\tmp" : "/tmp";

test.describe("Packet P17c: agent behaviour through Electron app", () => {
  test("CLI session opens file via bridge, renders tab, preserves original content after reload despite file swap; MCP session requests approval then opens tab", async () => {
    // Mutation: opening files via path instead of grant handle on reload, or failing to request/flow approval for MCP
    const testDir = path.join(tmpBase, `agent-e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    const userDataDir = path.join(testDir, "userData");
    await fs.mkdir(userDataDir, { recursive: true });

    const app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: { ...process.env, UNIVIEW_USER_DATA: userDataDir },
    });

    try {
      const page = await app.firstWindow();
      await expect(page.locator(".chrome")).toBeVisible({ timeout: 20_000 });

      // 1. Wait for bridge key to be created in userData/bridge
      const bridgeDir = path.join(userDataDir, "bridge");
      let key: Buffer | null = null;
      for (let i = 0; i < 60; i++) {
        try {
          key = await readBridgeKey(bridgeDir);
          if (key) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(key).toBeTruthy();

      const installId = await ensureInstallId(bridgeDir, { fs });
      const endpoint =
        process.platform === "win32"
          ? bridgeEndpoint({
              platform: "win32",
              bridgeDir,
              userSid: await windowsUserSid(),
              installId,
            })
          : bridgeEndpoint({ platform: process.platform, bridgeDir });

      // 2. CLI session: cli.hello then open of a temp file
      const cliClient = await connectBridge({ endpoint, key: key! });
      const helloRes = await cliClient.request("cli.hello", { version: "1.0" });
      expect(helloRes.result).toEqual({ version: "1.0" });

      const cliFile = path.join(testDir, "agent-cli-file.txt");
      await fs.writeFile(cliFile, "ORIGINAL_AGENT_CLI_CONTENT");

      const openRes = await cliClient.request("open", {}, Buffer.from(JSON.stringify([cliFile]), "utf8"));
      expect(openRes.result).toEqual({ opened: 1 });

      // Check tab appears and its content renders
      await expect(page.locator(".tab", { hasText: "agent-cli-file.txt" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("tabpanel").getByTestId("text-content")).toContainText("ORIGINAL_AGENT_CLI_CONTENT");

      // 4. MCP session path: intercept native approval dialog in main process
      await app.evaluate(async ({ dialog }) => {
        (globalThis as any).__dialogCalls = [];
        dialog.showMessageBox = async (...args: any[]) => {
          (globalThis as any).__dialogCalls.push(args);
          // Button 0 is "Allow for this session"
          return { response: 0, checkboxChecked: false };
        };
      });

      const mcpClient = await connectBridge({ endpoint, key: key! });
      await mcpClient.request("mcp.hello", {
        client: { name: "test-mcp-agent", version: "1.0" },
        protocolVersion: "2024-11-05",
      });

      const mcpFile = path.join(testDir, "agent-mcp-file.txt");
      await fs.writeFile(mcpFile, "MCP_APPROVED_CONTENT");

      // Request open -> triggers native approval dialog
      const mcpOpenRes = await mcpClient.request("open", {}, Buffer.from(JSON.stringify([mcpFile]), "utf8"));
      expect(mcpOpenRes.result).toEqual({ opened: 1 });

      // Assert approval was requested via dialog
      const dialogCalls = await app.evaluate(() => (globalThis as any).__dialogCalls || []);
      expect(dialogCalls.length).toBeGreaterThanOrEqual(1);
      const dialogOpts = dialogCalls[0][1] || dialogCalls[0][0];
      expect(dialogOpts.message).toContain("test-mcp-agent");

      // And 'Allow for this session' flows through to a tab
      await expect(page.locator(".tab", { hasText: "agent-mcp-file.txt" })).toBeVisible({ timeout: 15_000 });
      await page.locator(".tab", { hasText: "agent-mcp-file.txt" }).click();
      await expect(page.locator(".tab.active", { hasText: "agent-mcp-file.txt" })).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole("tabpanel")).toBeVisible();
      await expect(page.getByRole("tabpanel").getByTestId("text-content")).toContainText("MCP_APPROVED_CONTENT");

      await cliClient.close();
      await mcpClient.close();
    } finally {
      await app.close();
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
