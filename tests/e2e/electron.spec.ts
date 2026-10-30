import { _electron as electron, expect, test } from "@playwright/test";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const FX = join(process.cwd(), "fixtures", "generated");

test("desktop shell opens argv files, streams media and blocks the network", async () => {
  const app = await electron.launch({ args: [".", join(FX, "deck.pptx"), join(FX, "tone.wav")], cwd: process.cwd() });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".tab")).toHaveCount(2, { timeout: 20_000 });
    await page.locator(".tab", { hasText: "deck.pptx" }).click();
    await expect(page.locator(".tab-panel:not([hidden]) .pptx-main [data-testid=slide]").first()).toContainText("Quarterly Review");

    // Media plays from uniview-file:// with HTTP range support instead of loading the whole file.
    await page.locator(".tab", { hasText: "tone.wav" }).click();
    const audio = page.locator(".tab-panel:not([hidden]) [data-testid=audio]");
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration), { timeout: 10_000 }).toBeGreaterThan(0.9);
    expect(await audio.evaluate((a: HTMLAudioElement) => a.currentSrc)).toMatch(/^uniview-file:\/\/[0-9a-f]{32}\//);

    // Offline guarantee: a remote request from the page must fail.
    const remote = await page.evaluate(async () => {
      try {
        await fetch("https://example.com/");
        return "reached";
      } catch {
        return "blocked";
      }
    });
    expect(remote).toBe("blocked");

    // Images stream from uniview-file:// too; the CSP must allow them (Codex finding 1).
    const img = await page.evaluate(async (path) => {
      const api = (window as unknown as { uniview: { openPath(p: string): Promise<{ token: string; name: string }> } }).uniview;
      const f = await api.openPath(path);
      const el = new Image();
      el.src = `uniview-file://${f.token}/${encodeURIComponent(f.name)}`;
      await el.decode();
      return el.naturalWidth;
    }, join(FX, "pixel.png"));
    expect(img).toBe(320);

    // The session itself refuses other hosts, independent of the page CSP. Use a server this test proves is
    // reachable, so "blocked" can only mean the policy refused it (not that the network was down).
    const server = createServer((_req, res) => res.end("reachable"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("reachable");
      const viaSession = await app.evaluate(async ({ session }, url) => {
        try {
          await session.defaultSession.fetch(url);
          return "reached";
        } catch (err) {
          return String((err as Error).message);
        }
      }, `http://127.0.0.1:${port}/`);
      expect(viaSession).toMatch(/ERR_BLOCKED_BY_CLIENT/);
    } finally {
      server.close();
    }

    // An unknown token is refused.
    const forged = await page.evaluate(async () => (await fetch(`uniview-file://${"a".repeat(32)}/x`).catch(() => null))?.status ?? "error");
    expect(forged === 403 || forged === "error").toBe(true);

    // The renderer has no Node.js access.
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe("undefined");
  } finally {
    await app.close();
  }
});

test("Ctrl+N opens an independent window and closing it keeps the first window usable", async () => {
  const app = await electron.launch({ args: [".", join(FX, "deck.pptx")], cwd: process.cwd() });
  try {
    const first = await app.firstWindow();
    await expect(first.locator(".tab", { hasText: "deck.pptx" })).toBeVisible();
    const nextWindow = app.waitForEvent("window");
    await first.keyboard.press("Control+N");
    const second = await nextWindow;
    await expect(second.locator(".tab", { hasText: "deck.pptx" })).toHaveCount(0);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, join(FX, "tone.wav"));
    await second.keyboard.press("Control+O");
    await expect(second.locator(".tab", { hasText: "tone.wav" })).toBeVisible();
    await expect(first.locator(".tab", { hasText: "tone.wav" })).toHaveCount(0);
    await second.close();
    await expect(first.locator(".tab", { hasText: "deck.pptx" })).toBeVisible();
    await first.keyboard.press("Control+T");
    await expect(first.locator(".tab")).toHaveCount(2);
  } finally {
    await app.close();
  }
});
