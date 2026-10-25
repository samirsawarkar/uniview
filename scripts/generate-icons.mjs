// UniView icon pipeline.
//
// The ONLY source artwork is assets/branding/uniview-logo.png: the CEO-supplied logo with its flattened black frame
// removed by scripts/clean-logo.mjs (the untouched original is kept as uniview-logo-source.png). Nothing is redrawn or
// restyled: every output is a resampled copy of that image, placed on a canvas.
//
// Resampling is done by headless Chromium (Playwright, no browser download: the cache is read from
// PLAYWRIGHT_BROWSERS_PATH, default I:\AES\Data\ms-playwright). If Chromium cannot be launched, the same
// canvas code runs inside the project's Electron binary instead. PNG and ICO encoding is done here in Node.
//
//   node scripts/generate-icons.mjs
//   UNIVIEW_ICON_BACKEND=electron node scripts/generate-icons.mjs   (force the Electron fallback)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

export const SOURCE_PATH = "assets/branding/uniview-logo-source.png";
export const MASTER_PATH = "assets/branding/uniview-logo.png";
export const DEFAULT_PLAYWRIGHT_BROWSERS_PATH = "I:\\AES\\Data\\ms-playwright";

const RES = "android/app/src/main/res";

// ---------------------------------------------------------------------------------------------
// PNG / ICO encoding
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function calcCrc32(buf, offset = 0, length = buf.length) {
  let crc = 0xffffffff;
  for (let i = offset; i < offset + length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(calcCrc32(chunk, 4, 4 + data.length), 8 + data.length);
  return chunk;
}

/** Encodes a raw RGBA buffer as PNG. colorType 6 = RGBA, colorType 2 = RGB (alpha dropped, so the data must be opaque). */
export function encodePng(width, height, rgba, colorType = 6) {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  const bpp = colorType === 2 ? 3 : 4;
  const line = width * bpp;
  const raw = Buffer.alloc(height * (line + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (line + 1);
    raw[o] = 0;
    if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        const d = o + 1 + x * 3;
        raw[d] = rgba[s];
        raw[d + 1] = rgba[s + 1];
        raw[d + 2] = rgba[s + 2];
      }
    } else {
      rgba.copy(raw, o + 1, y * line, (y + 1) * line);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createChunk("IHDR", ihdr),
    createChunk("IDAT", deflateSync(raw, { level: 9 })),
    createChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Combines PNG frames into a multi-resolution Windows .ico container. */
export function createIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    e.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.buffer.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buffer)]);
}

// ---------------------------------------------------------------------------------------------
// Output plan
// ---------------------------------------------------------------------------------------------

/**
 * A render "job" = one canvas: w x h pixels, optional white background, the logo (aspect preserved, longer side
 * = `box` px) centred on it. `circle` first fills a white disc of diameter min(w,h) (round launcher icons) and
 * leaves the rest transparent. `opaque` outputs are written as PNG colour type 2 (no alpha channel).
 */
const mipmapDensities = [
  { name: "mdpi", icon: 48, fg: 108 },
  { name: "hdpi", icon: 72, fg: 162 },
  { name: "xhdpi", icon: 96, fg: 216 },
  { name: "xxhdpi", icon: 144, fg: 324 },
  { name: "xxxhdpi", icon: 192, fg: 432 },
];

const androidSplashes = [
  ["drawable", 480, 320],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
];

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const SPLASH_LOGO_PX = 256;
export const ADAPTIVE_SAFE_ZONE = 0.66;
export const ROUND_LOGO_RATIO = 0.74;

/** @returns {{ jobs: Record<string, object>, files: Array<{ path: string, job: string }>, ico: { path: string, jobs: string[] } }} */
export function buildPlan() {
  const jobs = {};
  const files = [];
  const square = (size, extra = {}) => ({ w: size, h: size, box: size, ...extra });
  const addSquare = (path, size, extra) => {
    const key = `square-${size}${extra ? "-" + Object.keys(extra).join("-") : ""}`;
    jobs[key] ??= square(size, extra);
    files.push({ path, job: key });
  };

  // Desktop / web / in-app: the logo full-size on a transparent canvas (its own rounded corners stay transparent).
  addSquare("build/icon.png", 512);
  addSquare("build/icon-1024.png", 1024);
  addSquare("public/icon.png", 512);
  addSquare("public/favicon.png", 64);
  addSquare("src/ui/assets/logo.png", 256);

  // Store icons: opaque (PNG colour type 2). The (white) logo fills the whole square, composited on white: full-bleed.
  addSquare("assets/branding/play-store-512.png", 512, { opaque: true, white: true });
  addSquare("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024, { opaque: true, white: true });

  // Android launcher icons.
  for (const d of mipmapDensities) {
    addSquare(`${RES}/mipmap-${d.name}/ic_launcher.png`, d.icon);
    const roundKey = `round-${d.icon}`;
    jobs[roundKey] = { w: d.icon, h: d.icon, box: Math.round(d.icon * ROUND_LOGO_RATIO), circle: true };
    files.push({ path: `${RES}/mipmap-${d.name}/ic_launcher_round.png`, job: roundKey });
    const fgKey = `adaptive-${d.fg}`;
    jobs[fgKey] = { w: d.fg, h: d.fg, box: Math.round(d.fg * ADAPTIVE_SAFE_ZONE) };
    files.push({ path: `${RES}/mipmap-${d.name}/ic_launcher_foreground.png`, job: fgKey });
  }

  // Splash screens: the logo centred at ~256 px (never blown up to fill) on plain white. Small canvases cap the
  // logo at half of their short side so it never crowds the screen.
  const splash = (w, h) => {
    const key = `splash-${w}x${h}`;
    jobs[key] ??= { w, h, box: Math.min(SPLASH_LOGO_PX, Math.round(Math.min(w, h) * 0.5)), white: true, opaque: true };
    return key;
  };
  const iosSplash = splash(2732, 2732);
  for (const f of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    files.push({ path: `ios/App/App/Assets.xcassets/Splash.imageset/${f}`, job: iosSplash });
  }
  for (const [dir, w, h] of androidSplashes) files.push({ path: `${RES}/${dir}/splash.png`, job: splash(w, h) });

  const icoJobs = ICO_SIZES.map((s) => {
    const key = `square-${s}`;
    jobs[key] ??= square(s);
    return key;
  });
  return { jobs, files, ico: { path: "build/icon.ico", jobs: icoJobs } };
}

// ---------------------------------------------------------------------------------------------
// Canvas rendering. This function body is executed inside Chromium (Playwright page, or an Electron window), so
// it must stay self-contained: it can only use browser globals.
// ---------------------------------------------------------------------------------------------

/* eslint-disable */
export async function renderInPage(masterB64, job) {
  const img = new Image();
  img.src = "data:image/png;base64," + masterB64;
  await img.decode();

  const make = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    return [c, x];
  };

  // High-quality resample: when downscaling, halve repeatedly (each step is a 2:1 box-like reduction) and finish
  // with one smoothed step; when upscaling, one smoothed step.
  const resample = (src, tw, th) => {
    let cur = src;
    while (cur.width / 2 >= tw && cur.height / 2 >= th) {
      const [c, x] = make(Math.max(1, Math.round(cur.width / 2)), Math.max(1, Math.round(cur.height / 2)));
      x.drawImage(cur, 0, 0, c.width, c.height);
      cur = c;
    }
    const [out, ox] = make(tw, th);
    ox.drawImage(cur, 0, 0, tw, th);
    return out;
  };

  const [canvas, ctx] = make(job.w, job.h);
  if (job.white) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, job.w, job.h);
  }
  if (job.circle) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(job.w / 2, job.h / 2, Math.min(job.w, job.h) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Contain-fit (aspect preserved): the longer side of the logo is `box` px.
  const s = job.box / Math.max(img.naturalWidth, img.naturalHeight);
  const tw = Math.max(1, Math.round(img.naturalWidth * s));
  const th = Math.max(1, Math.round(img.naturalHeight * s));
  const [base, bx] = make(img.naturalWidth, img.naturalHeight);
  bx.drawImage(img, 0, 0);
  const logo = resample(base, tw, th);
  ctx.drawImage(logo, Math.floor((job.w - tw) / 2), Math.floor((job.h - th) / 2));

  const data = ctx.getImageData(0, 0, job.w, job.h).data;
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < data.length; i += CH) bin += String.fromCharCode.apply(null, data.subarray(i, i + CH));
  return btoa(bin);
}
/* eslint-enable */

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

async function renderWithPlaywright(master, jobs) {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH || !existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) process.env.PLAYWRIGHT_BROWSERS_PATH = DEFAULT_PLAYWRIGHT_BROWSERS_PATH;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    const out = {};
    for (const [key, job] of Object.entries(jobs)) {
      const b64 = await page.evaluate(`(${renderInPage.toString()})(${JSON.stringify(master.toString("base64"))}, ${JSON.stringify(job)})`);
      out[key] = Buffer.from(b64, "base64");
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function renderWithElectron(master, jobs) {
  const electronPath = (await import("electron")).default;
  const work = mkdtempSync(join(tmpdir(), "uniview-icons-"));
  try {
    const req = join(work, "request.json");
    writeFileSync(req, JSON.stringify({ master: master.toString("base64"), jobs, outDir: work }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electronPath, [__filename, "--electron-worker", req], { stdio: "inherit", env });
    if (r.status !== 0) throw new Error(`Electron icon worker failed (exit ${r.status})`);
    const out = {};
    for (const key of Object.keys(jobs)) out[key] = readFileSync(join(work, `${key}.rgba`));
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Runs inside the Electron main process (see renderWithElectron). */
async function electronWorker(requestPath) {
  const { app, BrowserWindow } = await import("electron");
  const { master, jobs, outDir } = JSON.parse(readFileSync(requestPath, "utf8"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html,<!doctype html><html><body></body></html>");
  for (const [key, job] of Object.entries(jobs)) {
    const b64 = await win.webContents.executeJavaScript(`(${renderInPage.toString()})(${JSON.stringify(master)}, ${JSON.stringify(job)})`);
    writeFileSync(join(outDir, `${key}.rgba`), Buffer.from(b64, "base64"));
  }
  app.exit(0);
}

async function renderJobs(master, jobs) {
  const forced = process.env.UNIVIEW_ICON_BACKEND;
  if (forced !== "electron") {
    try {
      const out = await renderWithPlaywright(master, jobs);
      console.log("Backend: headless Chromium (Playwright)");
      return out;
    } catch (err) {
      if (forced === "playwright") throw err;
      console.warn(`Playwright Chromium unavailable (${String(err.message).split("\n")[0]}); falling back to Electron.`);
    }
  }
  const out = await renderWithElectron(master, jobs);
  console.log("Backend: Electron (Chromium canvas)");
  return out;
}

// ---------------------------------------------------------------------------------------------

function writeAsset(relPath, buffer) {
  const full = join(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buffer);
  console.log(`Generated: ${relPath}`);
}

export async function generateAll() {
  const masterFile = join(ROOT, MASTER_PATH);
  if (!existsSync(masterFile)) throw new Error(`Clean master logo missing: ${MASTER_PATH} (run node scripts/clean-logo.mjs)`);
  const master = readFileSync(masterFile);
  console.log(`Generating UniView brand assets from ${MASTER_PATH} ...`);

  const plan = buildPlan();
  const rgba = await renderJobs(master, plan.jobs);

  const pngCache = new Map();
  const png = (key) => {
    const job = plan.jobs[key];
    const cacheKey = `${key}`;
    if (!pngCache.has(cacheKey)) pngCache.set(cacheKey, encodePng(job.w, job.h, rgba[key], job.opaque ? 2 : 6));
    return pngCache.get(cacheKey);
  };

  for (const f of plan.files) writeAsset(f.path, png(f.job));
  writeAsset(plan.ico.path, createIco(plan.ico.jobs.map((k) => ({ width: plan.jobs[k].w, height: plan.jobs[k].h, buffer: png(k) }))));
  console.log("All branding assets generated successfully!");
}

if (process.versions.electron && process.argv.includes("--electron-worker")) {
  electronWorker(process.argv[process.argv.indexOf("--electron-worker") + 1]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  generateAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
