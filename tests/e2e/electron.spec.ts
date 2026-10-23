import { _electron as electron, expect, test } from "@playwright/test";
import { join } from "node:path";

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

    // An unknown token is refused.
    const forged = await page.evaluate(async () => (await fetch(`uniview-file://${"a".repeat(32)}/x`).catch(() => null))?.status ?? "error");
    expect(forged === 403 || forged === "error").toBe(true);

    // The renderer has no Node.js access.
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe("undefined");
  } finally {
    await app.close();
  }
});
