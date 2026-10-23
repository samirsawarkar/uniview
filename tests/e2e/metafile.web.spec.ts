import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const FX = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/generated');

function buildBlankEmf(): Uint8Array {
  const buf = new Uint8Array(108);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 88, true);
  dv.setInt32(16, 16, true);
  dv.setInt32(20, 16, true);
  dv.setInt32(32, 423, true);
  dv.setInt32(36, 423, true);
  dv.setUint32(40, 0x464d4520, true);
  dv.setUint32(44, 0x10000, true);
  dv.setUint32(48, 108, true);
  dv.setUint32(52, 2, true);
  dv.setUint16(56, 1, true);
  dv.setInt32(72, 16, true);
  dv.setInt32(76, 16, true);
  dv.setInt32(80, 4, true);
  dv.setInt32(84, 4, true);
  dv.setUint32(88, 14, true);
  dv.setUint32(92, 20, true);
  dv.setUint32(104, 20, true);
  return buf;
}

test('renders pptx with EMF metafile image', async ({ page }) => {
  const deckBuf = readFileSync(join(FX, 'deck.pptx'));
  const entries = unzipSync(new Uint8Array(deckBuf));

  delete entries['ppt/media/image1.png'];
  entries['ppt/media/image1.emf'] = buildBlankEmf();

  for (const path of Object.keys(entries)) {
    if (path.endsWith('.rels')) {
      const text = strFromU8(entries[path]);
      if (text.includes('image1.png')) {
        entries[path] = strToU8(text.replaceAll('image1.png', 'image1.emf'));
      }
    }
  }

  const ctKey = '[Content_Types].xml';
  if (entries[ctKey]) {
    const ctText = strFromU8(entries[ctKey]);
    const insert = '<Default Extension="emf" ContentType="image/x-emf"/>';
    entries[ctKey] = strToU8(ctText.replace('</Types>', `${insert}</Types>`));
  }

  const externalRequests: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol.startsWith('http') && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      externalRequests.push(req.url());
    }
  });

  await page.goto('/');

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('open-button').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'metafile.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from(zipSync(entries)),
  });

  await expect(page.getByTestId('slide-count')).toContainText('2 slides');
  const img = page.locator('.pptx-main img').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toMatch(/^blob:/);
  expect(externalRequests).toEqual([]);
});
