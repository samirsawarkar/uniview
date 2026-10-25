import jsQR from "jsqr";

/** Decode a QR code from RGBA pixels (jsQR). Returns the text, or null when none is found. */
export function decodeQr(rgba: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(rgba, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

/**
 * True when a frame is (nearly) all black: a covered lens or a camera that delivers no picture.
 * Uses the mean brightness so a few hot sensor pixels do not count as a picture.
 */
export function isBlackFrame(rgba: Uint8ClampedArray, threshold = 6): boolean {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < rgba.length; i += 16) {
    sum += ((rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0)) / 3;
    n++;
  }
  return n === 0 || sum / n < threshold;
}
