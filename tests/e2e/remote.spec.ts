import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FX = join(process.cwd(), "fixtures", "generated");

async function launch(profile: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env, UNIVIEW_USER_DATA: profile, UNIVIEW_E2E: "1", ...env } as Record<string, string> });
  const page = await app.firstWindow();
  await page.getByTestId("open-button").waitFor();
  return { app, page };
}

test("a paired client browses, opens and streams a host's shared folder", async () => {
  test.setTimeout(120_000);
  const tmp = mkdtempSync(join(tmpdir(), "uniview-remote-e2e-"));
  const host = await launch(join(tmp, "host"), { UNIVIEW_TEST_AUTO_APPROVE: "1", UNIVIEW_TEST_PICK_DIR: FX });
  const client = await launch(join(tmp, "client"));
  try {
    // Host: open Sharing, turn it on, share a folder through the permission screen, start pairing.
    const h = host.page;
    await h.evaluate(() => (window as any).__univiewOpenPage({ kind: "sharing" }, true));
    await expect(h.getByTestId("sharing-panel")).toBeVisible();
    await h.getByTestId("sharing-toggle").check();
    await expect(h.getByText(/reachable at/)).toBeVisible();
    await h.getByTestId("add-folder").click();
    await expect(h.getByTestId("permission-screen")).toContainText("read only");
    await h.getByTestId("confirm-share").click();
    await expect(h.getByTestId("sharing-panel")).toContainText("generated");
    await h.getByTestId("pair-device").click();
    const code = await h.getByTestId("pair-code").inputValue();
    expect(code).toMatch(/^uniview:pair\?v=1&/);

    // Client: pair with the code (both instances run on this machine, so use loopback).
    const c = client.page;
    await c.evaluate(() => (window as any).__univiewSetPairing(true));
    await c.getByTestId("pair-code-input").fill(code.replace(/h=[^&]+/, "h=127.0.0.1"));
    await c.getByTestId("pair-connect").click();
    const browser = c.getByTestId("remote-browser");
    await expect(browser).toBeVisible({ timeout: 20_000 });
    await browser.getByRole("button", { name: "generated" }).click();
    const entries = browser.getByTestId("remote-entries");
    await expect(entries).toContainText("deck.pptx");

    // Open a presentation on demand: it renders in a normal viewer tab.
    await entries.getByRole("button", { name: /deck\.pptx/ }).click();
    await expect(c.locator(".tab.active")).toContainText("deck.pptx");
    await expect(c.locator(".tab-panel:not([hidden]) .pptx-main [data-testid=slide]").first()).toContainText("Quarterly Review", { timeout: 20_000 });

    // Reopen remote recent from home tab after closing the presentation tab.
    await c.locator(".tab", { hasText: "deck.pptx" }).locator(".tab-close").click();
    await expect(c.locator(".tab", { hasText: "deck.pptx" })).toHaveCount(0);
    await c.locator(".tab-new").click();
    await expect(c.locator(".home")).toBeVisible();
    await c.locator(".home .recent", { hasText: "deck.pptx" }).click();
    await expect(c.locator(".tab.active")).toContainText("deck.pptx");
    await expect(c.locator(".tab-panel:not([hidden]) .pptx-main [data-testid=slide]").first()).toContainText("Quarterly Review", { timeout: 20_000 });

    // Stream audio: it plays through the service worker without downloading the file first.
    await c.locator(".tab", { hasText: "generated" }).click();
    await entries.getByRole("button", { name: /tone\.wav/ }).click();
    const audio = c.locator(".tab-panel:not([hidden]) [data-testid=audio]");
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration), { timeout: 20_000 }).toBeGreaterThan(0.9);
    expect(await audio.evaluate((a: HTMLAudioElement) => a.currentSrc)).toContain("/__uniview_stream/");

    // The host sees the device and an access log of what it opened.
    await expect(h.getByTestId("access-log")).toContainText("opened");
    await expect(h.getByTestId("access-log")).toContainText("deck.pptx");
    await expect(h.getByTestId("sharing-panel")).toContainText("connected");

    // Revoking the device cuts it off: browsing again fails cleanly.
    await h.getByRole("button", { name: "Remove" }).first().click();
    await c.locator(".tab", { hasText: "generated" }).click();
    await c.getByTitle("Refresh").click();
    await expect(c.getByTestId("remote-browser")).toContainText(/no longer trusts|refused/);
  } finally {
    await client.app.close();
    await host.app.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
