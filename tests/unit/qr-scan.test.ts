import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { decodeQr, isBlackFrame } from "../../src/ui/remote/qr";

/** Render a QR code into RGBA pixels (black modules on white, scaled, with a quiet zone), like a camera frame. */
function qrPixels(text: string, scale = 6, quiet = 4) {
  const grid = encode(text, { ecc: "M", border: 0 }).data;
  const n = grid.length + quiet * 2;
  const size = n * scale;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / scale) - quiet;
      const gy = Math.floor(y / scale) - quiet;
      if (gx >= 0 && gy >= 0 && gx < grid.length && gy < grid.length && grid[gy]?.[gx]) {
        const i = (y * size + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }
  }
  return { rgba, size };
}

describe("QR scanner path", () => {
  it("decodes a pairing code from a generated QR image", () => {
    const offer = "uniview:pair?h=192.168.1.20&p=47890&k=BNnfake&s=c2VjcmV0&n=Saurabh";
    const { rgba, size } = qrPixels(offer);
    expect(decodeQr(rgba, size, size)).toBe(offer);
  });

  it("returns null when there is no code", () => {
    expect(decodeQr(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64)).toBeNull();
  });

  it("detects a black camera frame but not a lit one", () => {
    const dark = new Uint8ClampedArray(64 * 64 * 4);
    expect(isBlackFrame(dark)).toBe(true);
    for (let i = 0; i < 20; i++) dark[i * 4 * 37] = 40; // a few hot sensor pixels are still a black picture
    expect(isBlackFrame(dark)).toBe(true);
    expect(isBlackFrame(qrPixels("hello").rgba)).toBe(false);
  });
});
