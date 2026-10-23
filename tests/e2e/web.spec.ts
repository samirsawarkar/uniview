import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

const FX = join(process.cwd(), "fixtures", "generated");

async function open(page: Page, ...names: string[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await chooser).setFiles(names.map((n) => join(FX, n)));
}

const panel = (page: Page) => page.locator(".tab-panel:not([hidden])");

test.beforeEach(async ({ page }) => {
  // Every network request must stay on the app's own origin.
  page.on("request", (req) => {
    const url = req.url();
    if (!/^(http:\/\/localhost:4173|blob:|data:)/.test(url)) throw new Error(`Unexpected network request: ${url}`);
  });
  await page.goto("/");
});

test("home page offers opening files", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "UniView" })).toBeVisible();
  await expect(page.getByTestId("open-button")).toBeVisible();
});

test("PDF renders its pages and finds text", async ({ page }) => {
  await open(page, "report.pdf");
  await expect(panel(page).getByTestId("pdf-page")).toHaveText("Page 1 of 1");
  await expect(panel(page).locator(".textLayer")).toContainText("Hello from UniView");
  await panel(page).getByLabel("Find in PDF").fill("uniview");
  await panel(page).getByLabel("Find in PDF").press("Enter");
  await expect(panel(page).getByText("Found on page 1")).toBeVisible();
});

test("Word document renders", async ({ page }) => {
  await open(page, "charter.docx");
  await expect(panel(page).getByTestId("docx-body")).toContainText("UniView opens every file offline.");
});

test("spreadsheet shows cells, UTF-8 CSV keeps accents, sheets switch", async ({ page }) => {
  await open(page, "sales.xlsx");
  await expect(panel(page).getByTestId("sheet-grid")).toContainText("Café");
  await panel(page).getByRole("tab", { name: "Plan" }).click();
  await expect(panel(page).getByTestId("sheet-grid")).toContainText("Samir");
  await open(page, "people.csv");
  await expect(panel(page).getByTestId("sheet-grid")).toContainText("Zürich");
  await expect(panel(page).getByTestId("sheet-grid")).toContainText("Ōsaka");
});

test("50,000-row workbook opens and scrolls", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __maxLongTask: number }).__maxLongTask = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const cur = (window as unknown as { __maxLongTask: number }).__maxLongTask;
        if (entry.duration > cur) (window as unknown as { __maxLongTask: number }).__maxLongTask = entry.duration;
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  });
  await open(page, "big.xlsx");
  const grid = panel(page).getByTestId("sheet-grid");
  await expect(grid).toContainText("row 1");
  const maxTask = await page.evaluate(() => (window as unknown as { __maxLongTask: number }).__maxLongTask);
  expect(maxTask).toBeLessThan(200);
  await grid.evaluate((el) => (el.scrollTop = 24 * 40000));
  await expect(grid).toContainText("row 400");
  expect(await grid.locator(".cell").count()).toBeLessThan(600);
});

test("PowerPoint deck renders slides with inherited layout", async ({ page }) => {
  await open(page, "deck.pptx");
  await expect(panel(page).getByTestId("slide-count")).toHaveText("2 slides");
  const first = panel(page).locator(".pptx-main [data-testid=slide]").first();
  await expect(first).toContainText("Quarterly Review");
  await expect(first).toContainText("Revenue up 12%");
  await expect(first).toContainText("North");
  await panel(page).getByRole("button", { name: "▶ Present" }).click();
  await expect(page.locator(".presenter")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter")).toContainText("Next Steps");
  await page.keyboard.press("Escape");
  await expect(page.locator(".presenter")).toHaveCount(0);
});

test("EPUB renders chapters without running book scripts", async ({ page }) => {
  await open(page, "book.epub");
  const frame = panel(page).frameLocator("[data-testid=epub-frame]");
  await expect(frame.locator("body")).toContainText("It was a bright cold day.");
  await panel(page).getByRole("button", { name: "Chapter Two" }).click();
  await expect(frame.locator("body")).toContainText("The end.");
  const hacked = await panel(page).locator("[data-testid=epub-frame]").evaluate((f: HTMLIFrameElement) => (f.contentWindow as unknown as { hacked?: boolean }).hacked ?? null);
  expect(hacked).toBeNull();
});

test("ZIP entries open in new tabs", async ({ page }) => {
  await open(page, "bundle.zip");
  await panel(page).getByRole("button", { name: "data/report.md" }).click();
  await expect(page.locator(".tab.active")).toContainText("report.md");
  await expect(panel(page).getByTestId("markdown")).toContainText("Nested report");
});

test("Markdown is sanitized, JSON shows a tree, code is highlighted", async ({ page }) => {
  await open(page, "notes.md");
  await expect(panel(page).getByTestId("markdown")).toContainText("Release notes");
  expect(await panel(page).getByTestId("markdown").innerHTML()).not.toContain("<script");
  await open(page, "data.json");
  await expect(panel(page).getByTestId("json-tree")).toContainText('"formats"');
  await open(page, "app.ts");
  await expect(panel(page).locator(".hljs .hljs-keyword").first()).toBeVisible();
});

test("images, SVG and audio open", async ({ page }) => {
  await open(page, "pixel.png");
  await expect(panel(page).getByText("320 × 200")).toBeVisible();
  await open(page, "shape.svg");
  await expect(panel(page).locator(".image-viewer img")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked ?? null)).toBeNull();
  await open(page, "tone.wav");
  await expect(panel(page).getByTestId("audio")).toBeVisible();
});

test("broken and unknown files never leave a blank tab", async ({ page }) => {
  await open(page, "broken.pdf");
  await expect(panel(page).getByTestId("error-panel")).toContainText("could not be read");
  await panel(page).getByRole("button", { name: "View as hex" }).click();
  await expect(panel(page).getByTestId("hex")).toContainText("25 50 44 46");
  await open(page, "random.bin");
  await expect(panel(page).getByTestId("hex")).toBeVisible();
  await open(page, "minutes.doc");
  await expect(panel(page).getByTestId("legacy-text")).toContainText("Budget approved unanimously");
  await open(page, "empty.txt");
  await expect(panel(page).getByTestId("text-content")).toBeVisible();
});

test("tabs: several files at once, keyboard switching and closing", async ({ page }) => {
  await open(page, "report.pdf", "notes.md", "data.json");
  await expect(page.locator(".tab")).toHaveCount(3);
  await expect(page.locator(".tab.active")).toContainText("data.json");
  await page.keyboard.press("Control+1");
  await expect(page.locator(".tab.active")).toContainText("report.pdf");
  await page.keyboard.press("Control+w");
  await expect(page.locator(".tab")).toHaveCount(2);
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab.active")).toContainText("New tab");
  await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
});

// ---- Regression tests for the Codex review (aes run aes-2c1b389d7adb) ----

test("a truncated ZIP can still be viewed as hex (finding 2)", async ({ page }) => {
  await open(page, "broken.zip");
  await expect(panel(page).getByTestId("error-panel")).toBeVisible();
  await panel(page).getByRole("button", { name: "View as hex" }).click();
  await expect(panel(page).getByTestId("hex")).toContainText("50 4b 03 04");
});

test("short UTF-8 text is not mistaken for Windows-1252 (finding 5)", async ({ page }) => {
  await open(page, "unicode.txt");
  await expect(panel(page).getByTestId("text-content")).toContainText("éà – naïve café 日本語");
});

test("TIFF and font files render", async ({ page }) => {
  await open(page, "photo.tif");
  await expect(panel(page).getByText("64 × 48")).toBeVisible();
  await expect(panel(page).locator(".image-viewer canvas")).toBeVisible();
  await open(page, "sans.ttf");
  await expect(panel(page).getByTestId("font-sheet")).toContainText("The quick brown fox");
  const family = await panel(page).locator(".font-row div").first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain("uv-font-");
});

test("closing a tab mid-load leaves no errors and no stray fonts (finding 7)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "big.xlsx");
  await page.keyboard.press("Control+w");
  await open(page, "sans.ttf");
  await page.keyboard.press("Control+w");
  await open(page, "report.pdf");
  await expect(panel(page).locator(".textLayer")).toContainText("Hello from UniView");
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => [...document.fonts].filter((f) => f.family.startsWith("uv-font-")).length)).toBe(0);
});
