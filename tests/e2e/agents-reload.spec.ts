import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";
// @ts-expect-error plain ESM module without types
import { readBridgeKey, bridgeEndpoint, windowsUserSid, ensureInstallId } from "../../electron/lib/bridge-key.mjs";

const tmpBase = process.platform === "win32" ? "I:\\AES\\tmp" : "/tmp";

test.describe("Packet P17c-3: Agent view reload verification", () => {
  test("Agent-opened view reload re-reads from open handle via uniview-file: and preserves original content after file swap", async () => {
    const testDir = path.join(tmpBase, `agent-reload-e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
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

      // 1. Wait for bridge key in userData/bridge
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

      // 2. Track uniview-file: custom protocol requests
      let fileRequestCount = 0;
      page.on("request", (req) => {
        if (req.url().startsWith("uniview-file:")) {
          fileRequestCount++;
        }
      });

      // 3. Connect via bridge and write original .uview.json
      const client = await connectBridge({ endpoint, key: key! });
      await client.request("cli.hello", { version: "1.0" });

      const uviewFile = path.join(testDir, "agent-spec.uview.json");
      const originalSpec = {
        uniview: "view/1",
        title: "ORIGINAL_AGENT_VIEW_TITLE",
        body: [
          { type: "heading", level: 2, text: "ORIGINAL_AGENT_VIEW_HEADING" },
          { type: "markdown", text: "Original spec content that must survive reload." },
        ],
      };
      await fs.writeFile(uviewFile, JSON.stringify(originalSpec));

      // 4. Open via agent bridge
      const openRes = await client.request("open", {}, Buffer.from(JSON.stringify([uviewFile]), "utf8"));
      expect(openRes.result).toEqual({ opened: 1 });

      // Tab should appear named after the filename
      await expect(page.locator(".tab", { hasText: "agent-spec.uview.json" })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".vs-title")).toContainText("ORIGINAL_AGENT_VIEW_TITLE");
      await expect(page.locator(".vs-heading")).toContainText("ORIGINAL_AGENT_VIEW_HEADING");

      // Verify at least one uniview-file: request occurred for reading the file
      await expect.poll(() => fileRequestCount, { timeout: 10_000 }).toBeGreaterThan(0);
      const countBefore = fileRequestCount;

      // 5. Swap the file on disk for a completely different content
      const backupPath = path.join(testDir, "agent-spec-backup.uview.json");
      await fs.rename(uviewFile, backupPath);
      await fs.writeFile(
        uviewFile,
        JSON.stringify({
          uniview: "view/1",
          title: "SWAPPED_DISASTER_TITLE",
          body: [{ type: "heading", level: 2, text: "SWAPPED_DISASTER_HEADING" }],
        })
      );

      // 6. Press the viewer's Reload control (.vs-reload button)
      const reloadBtn = page.locator(".vs-reload");
      await expect(reloadBtn).toBeVisible();
      await reloadBtn.click();

      // 7. Verify uniview-file: request count increased (proving a real re-read occurred)
      await expect.poll(() => fileRequestCount, { timeout: 10_000 }).toBeGreaterThan(countBefore);

      // 8. Verify the open tab still renders the ORIGINAL content (handle-only reads), not the swapped content
      await expect(page.locator(".vs-title")).toContainText("ORIGINAL_AGENT_VIEW_TITLE");
      await expect(page.locator(".vs-heading")).toContainText("ORIGINAL_AGENT_VIEW_HEADING");
      await expect(page.locator(".vs-title")).not.toContainText("SWAPPED_DISASTER_TITLE");
      await expect(page.locator(".vs-heading")).not.toContainText("SWAPPED_DISASTER_HEADING");

      await client.close();
    } finally {
      await app.close();
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
