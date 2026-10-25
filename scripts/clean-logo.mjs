// Derives the clean logo master (assets/branding/uniview-logo.png) from the CEO-supplied original
// (assets/branding/uniview-logo-source.png, kept byte-identical as evidence).
//
// The original is a white rounded square with a faint grid and two blue bars, but its transparent background was
// flattened to opaque near-black (14,14,14). This script removes that frame. Pure Node (zlib only), deterministic:
//
//   1. Flood-fill (4-connected) from every pixel on the four image borders through near-black neutral pixels
//      (luminance < 48 and max-min channel spread <= 12) and make them fully transparent.
//   2. Anti-aliased boundary: up to 3 passes over neutral grey pixels (spread <= 12, luminance v < 235) that touch
//      the transparent region or a previously recovered pixel. They are white blended over black, so
//      alpha = clamp((v - 14) / (255 - 14), 0, 1) and the colour becomes white (255,255,255).
//      Everything else (blue bars, bluish grid lines, whites) is left exactly as it was.
//   3. Crop to the tight bounding box of pixels with alpha > 0 and pad to a square, centred, with transparency.
//
//   node scripts/clean-logo.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { encodePng } from "./generate-icons.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_PATH = "assets/branding/uniview-logo-source.png";
export const CLEAN_PATH = "assets/branding/uniview-logo.png";

export const FLOOD_LUMINANCE_MAX = 48;
export const NEUTRAL_SPREAD_MAX = 12;
export const FRAME_VALUE = 14;
export const RING_LUMINANCE_MAX = 235;
export const RING_PASSES = 3;

/** Minimal PNG decoder: 8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA). Returns RGBA. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + i] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * bpp];
    rgba[i * 4 + 1] = px[i * bpp + 1];
    rgba[i * 4 + 2] = px[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? px[i * 4 + 3] : 255;
  }
  return { width, height, rgba };
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const spread = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

export function cleanLogo({ width: w, height: h, rgba }) {
  const out = Buffer.from(rgba);
  const transparent = new Uint8Array(w * h);
  const at = (x, y) => y * w + x;
  const isFrame = (i) => {
    const r = out[i * 4], g = out[i * 4 + 1], b = out[i * 4 + 2];
    return out[i * 4 + 3] === 255 && lum(r, g, b) < FLOOD_LUMINANCE_MAX && spread(r, g, b) <= NEUTRAL_SPREAD_MAX;
  };

  // 1. Flood fill from the borders through the near-black frame.
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = at(x, y);
    if (transparent[i] || !isFrame(i)) return;
    transparent[i] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  const framePixels = transparent.reduce((n, v) => n + v, 0);
  for (let i = 0; i < w * h; i++) if (transparent[i]) out.fill(0, i * 4, i * 4 + 4);

  // 2. Recover alpha on the anti-aliased boundary (white blended over the black frame).
  let ringPixels = 0;
  for (let pass = 0; pass < RING_PASSES; pass++) {
    const hits = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = at(x, y);
        if (transparent[i] || out[i * 4 + 3] !== 255) continue;
        const nb = (x > 0 && transparent[i - 1]) || (x < w - 1 && transparent[i + 1]) || (y > 0 && transparent[i - w]) || (y < h - 1 && transparent[i + w]);
        if (!nb) continue;
        const r = out[i * 4], g = out[i * 4 + 1], b = out[i * 4 + 2];
        if (spread(r, g, b) > NEUTRAL_SPREAD_MAX) continue;
        const v = lum(r, g, b);
        if (v < RING_LUMINANCE_MAX) hits.push([i, v]);
      }
    }
    if (!hits.length) break;
    for (const [i, v] of hits) {
      const a = Math.min(1, Math.max(0, (v - FRAME_VALUE) / (255 - FRAME_VALUE)));
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
      out[i * 4 + 3] = Math.round(a * 255);
      transparent[i] = 2; // processed ring pixel: lets the next pass reach one pixel further in
      ringPixels++;
    }
  }

  // 3. Tight crop to alpha > 0, pad to a centred square.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (out[at(x, y) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const size = Math.max(cw, ch);
  const ox = Math.floor((size - cw) / 2), oy = Math.floor((size - ch) / 2);
  const sq = Buffer.alloc(size * size * 4);
  for (let y = 0; y < ch; y++) out.copy(sq, ((y + oy) * size + ox) * 4, at(x0, y0 + y) * 4, at(x0, y0 + y) * 4 + cw * 4);
  return { width: size, height: size, rgba: sq, stats: { framePixels, ringPixels, crop: { x0, y0, cw, ch } } };
}

export function writeCleanLogo() {
  const src = decodePng(readFileSync(join(ROOT, SOURCE_PATH)));
  const clean = cleanLogo(src);
  const png = encodePng(clean.width, clean.height, clean.rgba, 6);
  writeFileSync(join(ROOT, CLEAN_PATH), png);
  console.log(`Wrote ${CLEAN_PATH}: ${clean.width}x${clean.height}`, JSON.stringify(clean.stats));
  return png;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeCleanLogo();
