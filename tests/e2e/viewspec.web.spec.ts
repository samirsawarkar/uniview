import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

async function openFile(page: any, filePath: string) {
  const fileChooserPromise = page.waitForEvent("filechooser");
  const openBtn = page.getByRole("button", { name: /^Open/i }).first();
  await openBtn.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(filePath);
}

test.describe("viewspec viewer e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("opening all-nodes-nested.uview.json shows agent frame, table and chart", async ({
    page,
  }) => {
    const fixturePath = path.resolve(
      "fixtures/viewspec/valid/all-nodes-nested.uview.json"
    );
    await openFile(page, fixturePath);

    const agentContent = page.locator("section.agent-content");
    await expect(agentContent).toBeVisible();

    const table = agentContent.locator("table");
    await expect(table).toBeVisible();

    const chart = agentContent.locator('svg[role="img"]');
    await expect(chart).toBeVisible();
  });

  test("opening an invalid fixture shows 'This view could not be shown'", async ({
    page,
  }) => {
    const invalidDir = path.resolve("fixtures/viewspec/invalid");
    let invalidPath = "";
    if (fs.existsSync(invalidDir)) {
      const files = fs
        .readdirSync(invalidDir)
        .filter((f) => f.endsWith(".json"));
      if (files.length > 0) {
        invalidPath = path.join(invalidDir, files[0]!);
      }
    }

    if (!invalidPath) {
      invalidPath = path.resolve("fixtures/viewspec/invalid.uview.json");
      if (!fs.existsSync(invalidPath)) {
        fs.writeFileSync(
          invalidPath,
          JSON.stringify({ uniview: "wrong", title: "Invalid" })
        );
      }
    }

    await openFile(page, invalidPath);

    await expect(page.locator("text=This view could not be shown")).toBeVisible();
  });
});
