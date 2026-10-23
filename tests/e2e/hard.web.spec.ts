import { test, expect } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = join(__dirname, '../../fixtures/generated');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('hard.docx displays confidential header/footer, table cells, and valid image', async ({ page }) => {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('open-button').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(join(FX, 'hard.docx'));

  const activePanel = page.locator('.tab-panel:not([hidden])');
  await expect(activePanel.getByText('Confidential Header')).toBeVisible();
  await expect(activePanel.getByText('Confidential Footer')).toBeVisible();
  await expect(activePanel.getByText('R3C3')).toBeVisible();
  await expect(activePanel.locator('table td, table th')).toHaveCount(9);

  const img = activePanel.locator('img').first();
  await expect(img).toBeVisible();
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

test('hard.pptx presentation mode and hidden slide navigation', async ({ page }) => {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('open-button').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(join(FX, 'hard.pptx'));

  const activePanel = page.locator('.tab-panel:not([hidden])');
  const slideCount = activePanel.getByTestId('slide-count').or(activePanel.getByText(/3 slides/i)).first();
  await expect(slideCount).toBeVisible();
  await expect(slideCount).toContainText('3');

  const hiddenSlideBtn = activePanel.getByRole('button', { name: 'Slide 2 (hidden)', exact: true, includeHidden: true });
  await expect(hiddenSlideBtn).toHaveCount(1);
  await expect(hiddenSlideBtn).toHaveCSS('opacity', '0.5');
  const viewport = page.viewportSize();
  if (viewport && viewport.width > 760) {
    await expect(hiddenSlideBtn).toBeVisible();
    await expect(hiddenSlideBtn.getByText(/hidden/i).or(hiddenSlideBtn.locator('[aria-label*="hidden" i]')).first()).toBeVisible();
  }

  await page.getByRole('button', { name: /Present/ }).click();
  await expect(page.getByText('Hard Deck')).toBeVisible();

  await page.getByRole('button', { name: 'Next slide' }).click();
  await expect(page.getByText('Conclusion')).toBeVisible();
  await expect(page.getByText('Hidden Slide Content')).not.toBeVisible();

  await page.getByRole('button', { name: /Previous/i }).click();
  await expect(page.getByText('Hard Deck')).toBeVisible();

  await page.keyboard.press('Escape');

  const vp = page.viewportSize();
  if (vp && vp.width > 760) {
    await hiddenSlideBtn.click();
  } else {
    await activePanel.locator('.pptx-main [data-slide="1"]').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  }
  await expect(hiddenSlideBtn).toHaveClass(/active/);
  await page.getByRole('button', { name: /Present/ }).click();
  await expect(page.getByText('Conclusion')).toBeVisible();
});

test('hard.pptx all hidden slides shows message and exits to toolbar', async ({ page }) => {
  const pptxBytes = readFileSync(join(FX, 'hard.pptx'));
  const entries = unzipSync(pptxBytes);

  for (const [filename, content] of Object.entries(entries)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(filename)) {
      let xml = strFromU8(content);
      xml = xml.replace(/<p:sld(\s[^>]*)>/, (match, attrs) => {
        if (/\bshow=(["']).*?\1/.test(attrs)) {
          return `<p:sld${attrs.replace(/\bshow=(["']).*?\1/, 'show="0"')}>`;
        }
        return `<p:sld show="0"${attrs}>`;
      });
      entries[filename] = strToU8(xml);
    }
  }

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('open-button').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'all-hidden.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from(zipSync(entries)),
  });

  await page.getByRole('button', { name: /Present/ }).click();
  await expect(page.getByText(/all slides.*hidden/i)).toBeVisible();

  await page.getByRole('button', { name: 'Exit (Esc)', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /Present/ })).toBeVisible();
});

test('hard.xlsx renders merged summary cell, formatted numbers, and scrolls wide columns', async ({ page }) => {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('open-button').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(join(FX, 'hard.xlsx'));

  const activePanel = page.locator('.tab-panel:not([hidden])');
  const summaryCell = activePanel.locator('.cell', { hasText: 'Quarterly Revenue Summary' });
  await expect(summaryCell).toHaveCount(1);

  const width = await summaryCell.evaluate((el: HTMLElement) => el.offsetWidth || el.getBoundingClientRect().width);
  const sum = await activePanel.locator('.col-head').evaluateAll((heads) =>
    heads.slice(0, 3).reduce((acc, el) => acc + ((el as HTMLElement).offsetWidth || el.getBoundingClientRect().width), 0),
  );
  expect(width).toBeCloseTo(sum, 0);

  await expect(activePanel.getByText('2026-10-23')).toBeVisible();
  await expect(activePanel.getByText('17.5%')).toBeVisible();

  await page.getByRole('tab', { name: 'Wide' }).click();

  const grid = activePanel.locator('.sheet-grid, [data-testid="sheet-grid"], .grid').first();
  await grid.evaluate((el: HTMLElement) => {
    el.scrollLeft = el.scrollWidth;
    el.dispatchEvent(new Event('scroll'));
  });

  await expect(activePanel.getByText('Col 200')).toBeVisible();
});
