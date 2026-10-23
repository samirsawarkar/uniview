import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Android hands "Open with" files to the page as a token; the page reads ranges from /_uniview_shared/.
const PDF = readFileSync(join(process.cwd(), "fixtures", "generated", "report.pdf"));
const TOKEN = "0123456789abcdef0123456789abcdef";

async function serveShared(page: Page) {
  const closes: string[] = [];
  await page.route("**/_uniview_shared/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("close") === "1") {
      closes.push(url.pathname);
      return route.fulfill({ status: 204 });
    }
    const start = Number(url.searchParams.get("start"));
    const end = Math.min(Number(url.searchParams.get("end")), PDF.length);
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: PDF.subarray(start, end) });
  });
  return closes;
}

const tabs = (page: Page) => page.getByRole("tab");

test("a file shared before the page loaded opens in exactly one tab", async ({ page }) => {
  await serveShared(page);
  await page.addInitScript(
    ([token, size]) => {
      (window as unknown as { __univiewPendingShared: unknown[] }).__univiewPendingShared = [
        { token, name: "report.pdf", size, mime: "application/pdf" },
      ];
    },
    [TOKEN, PDF.length] as const,
  );
  await page.goto("/");
  await expect(page.locator(".tab-panel:not([hidden])").locator(".textLayer")).toContainText("Hello from UniView");
  await expect(tabs(page)).toHaveCount(1);
});

test("a file shared after the page loaded opens in exactly one tab and closing releases it", async ({ page }) => {
  const closes = await serveShared(page);
  await page.goto("/");
  await page.evaluate(
    ([token, size]) =>
      (window as unknown as { __univiewOpenShared: (t: string, n: string, s: number, m: string) => void }).__univiewOpenShared(
        token,
        "report.pdf",
        size,
        "application/pdf",
      ),
    [TOKEN, PDF.length] as const,
  );
  await expect(page.locator(".tab-panel:not([hidden])").locator(".textLayer")).toContainText("Hello from UniView");
  await expect(tabs(page)).toHaveCount(1);
  await page.getByRole("tab").getByRole("button", { name: /close/i }).click();
  await expect.poll(() => closes).toEqual([`/_uniview_shared/${TOKEN}`]);
});
