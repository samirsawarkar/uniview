// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { metafileToPng } from '../../src/viewers/metafile';

function createMinimalEmf(): Uint8Array {
  const buf = new ArrayBuffer(108);
  const view = new DataView(buf);

  // EMR_HEADER
  view.setUint32(0, 1, true); // type = EMR_HEADER
  view.setUint32(4, 88, true); // size = 88
  view.setInt32(8, 0, true); // bounds.left
  view.setInt32(12, 0, true); // bounds.top
  view.setInt32(16, 16, true); // bounds.right
  view.setInt32(20, 16, true); // bounds.bottom
  view.setInt32(24, 0, true); // frame.left
  view.setInt32(28, 0, true); // frame.top
  view.setInt32(32, 423, true); // frame.right
  view.setInt32(36, 423, true); // frame.bottom
  view.setUint32(40, 0x464d4520, true); // signature ' EMF'
  view.setUint32(44, 0x00010000, true); // version
  view.setUint32(48, 108, true); // bytes
  view.setUint32(52, 2, true); // records
  view.setUint16(56, 1, true); // handles
  view.setUint16(58, 0, true); // reserved
  view.setInt32(72, 16, true); // device.cx
  view.setInt32(76, 16, true); // device.cy
  view.setInt32(80, 4, true); // millimeters.cx
  view.setInt32(84, 4, true); // millimeters.cy

  // EMR_EOF
  view.setUint32(88, 14, true); // type = EMR_EOF
  view.setUint32(92, 20, true); // size = 20
  view.setUint32(96, 0, true); // nPalEntries
  view.setUint32(100, 0, true); // offPalEntries
  view.setUint32(104, 20, true); // nSizeLast

  return new Uint8Array(buf);
}

async function readBlobAsUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('metafileToPng', () => {
  it('returns null on garbage input', async () => {
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const res = await metafileToPng(garbage, 'emf');
    expect(res).toBeNull();
  });

  it('returns null if size exceeds 32MiB limit', async () => {
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1);
    const res = await metafileToPng(oversized, 'emf');
    expect(res).toBeNull();
  });

  it('returns null for absurd EMF bounds', async () => {
    const emf = createMinimalEmf();
    const view = new DataView(emf.buffer);
    view.setInt32(16, 100000, true); // bounds.right = 100,000 > 8000
    const res = await metafileToPng(emf, 'emf');
    expect(res).toBeNull();
  });

  it('converts minimal valid EMF to a non-empty PNG Blob with PNG signature', async () => {
    const emf = createMinimalEmf();
    const res = await metafileToPng(emf, 'emf');
    expect(res).not.toBeNull();
    expect(res).toBeInstanceOf(Blob);
    expect(res!.type).toBe('image/png');
    const bytes = await readBlobAsUint8Array(res!);
    expect(bytes.length).toBeGreaterThan(16);
    // PNG signature: 137 80 78 71 13 10 26 10
    const expectedSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(Array.from(bytes.slice(0, 8))).toEqual(expectedSig);
  });
});
