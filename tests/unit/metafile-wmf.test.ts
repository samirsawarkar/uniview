/**
 * @jest-environment node
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { metafileToPng } from '../../src/viewers/metafile';

function createPlaceableWmf(right: number, bottom: number, inch: number): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);

  // Aldus Placeable Metafile header (22 bytes)
  view.setUint32(0, 0x9ac6cdd7, true); // key
  view.setUint16(4, 0, true);          // hwmf
  view.setInt16(6, 0, true);           // left
  view.setInt16(8, 0, true);           // top
  view.setInt16(10, right, true);      // right
  view.setInt16(12, bottom, true);     // bottom
  view.setUint16(14, inch, true);      // inch
  view.setUint32(16, 0, true);         // reserved

  let checksum = 0;
  for (let offset = 0; offset <= 18; offset += 2) {
    checksum ^= view.getUint16(offset, true);
  }
  view.setUint16(20, checksum, true);

  // Standard WMF header (18 bytes at offset 22)
  view.setUint16(22, 1, true);         // fileType (MEMORYMETAFILE)
  view.setUint16(24, 9, true);         // headerSize (9 words)
  view.setUint16(26, 0x300, true);     // version 0x300
  view.setUint32(28, 12, true);        // totalSize (12 words)
  view.setUint16(32, 0, true);         // numObjects
  view.setUint32(34, 3, true);         // maxRecord (3 words)
  view.setUint16(38, 0, true);         // numParams

  // EOF record (6 bytes at offset 40)
  view.setUint32(40, 3, true);         // record size (3 words)
  view.setUint16(44, 0, true);         // function (META_EOF)

  return bytes;
}

describe('metafileToPng WMF placeable validation', () => {
  it('converts placeable WMF with 14400 units and inch 1440 to PNG', async () => {
    const wmf = createPlaceableWmf(14400, 14400, 1440);
    const blob = await metafileToPng(wmf, 'wmf');
    expect(blob).not.toBeNull();
    const arrayBuffer = await blob!.arrayBuffer();
    const view = new DataView(arrayBuffer);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(8000);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(8000);
  });

  it('returns null when inch is 0', async () => {
    const wmf = createPlaceableWmf(14400, 14400, 0);
    const result = await metafileToPng(wmf, 'wmf');
    expect(result).toBeNull();
  });

  it('returns null for oversized pixel dimensions (bounds 32000, inch 1)', async () => {
    const wmf = createPlaceableWmf(32000, 32000, 1);
    const result = await metafileToPng(wmf, 'wmf');
    expect(result).toBeNull();
  });
});
