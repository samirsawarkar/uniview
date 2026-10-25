import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const ICON_CONSTANTS = {
  viewBox: "0 0 512 512",
  viewBoxSize: 512,
  colors: {
    primary: "#2563eb",
    primaryRgb: [37, 99, 235],
    white: "#ffffff",
    monochrome: "#000000",
  },
  geometry: {
    squircleRadius: 112,
    squircleRadiusRatio: 0.22,
    lensArcRadius: 185,
    pupilRadius: 54,
    pupilRadiusRatio: 0.105,
    glintRadius: 16,
    glintRadiusRatio: 0.032,
    glintCx: 276,
    glintCy: 236,
  },
};

// CRC32 implementation
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function calcCrc32(buf, offset = 0, length = buf.length) {
  let crc = 0xffffffff;
  for (let i = offset; i < offset + length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encodes raw RGBA buffer into PNG format
 */
export function encodePng(width, height, data, colorType = 6) {
  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const lineLength = width * bytesPerPixel;
  const scanlines = Buffer.alloc(height * (lineLength + 1));

  for (let y = 0; y < height; y++) {
    const scanlineOffset = y * (lineLength + 1);
    scanlines[scanlineOffset] = 0; // Filter: None

    if (colorType === 2) {
      if (data.length === width * height * 4) {
        // Strip alpha channel from RGBA data
        for (let x = 0; x < width; x++) {
          const srcIdx = (y * width + x) * 4;
          const dstIdx = scanlineOffset + 1 + x * 3;
          scanlines[dstIdx] = data[srcIdx];
          scanlines[dstIdx + 1] = data[srcIdx + 1];
          scanlines[dstIdx + 2] = data[srcIdx + 2];
        }
      } else {
        data.copy(scanlines, scanlineOffset + 1, y * lineLength, (y + 1) * lineLength);
      }
    } else {
      data.copy(scanlines, scanlineOffset + 1, y * lineLength, (y + 1) * lineLength);
    }
  }

  const compressed = deflateSync(scanlines, { level: 6 });

  // PNG Signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR Chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = colorType; // Color type: 2 (RGB) or 6 (RGBA)
  ihdrData[10] = 0; // Compression
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Interlace (no)

  const ihdrChunk = createChunk("IHDR", ihdrData);
  const idatChunk = createChunk("IDAT", compressed);
  const iendChunk = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const chunk = Buffer.alloc(4 + 4 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const crc = calcCrc32(chunk, 4, 4 + data.length);
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

/**
 * Combines multiple PNG images into a multi-resolution Windows .ico container
 * @param {Array<{ width: number, height: number, buffer: Buffer }>} images
 */
export function createIco(images) {
  const count = images.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = Icon
  header.writeUInt16LE(count, 4); // Count

  const entries = [];
  for (const img of images) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // Color count
    entry.writeUInt8(0, 3); // Reserved
    entry.writeUInt16LE(1, 4); // Planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(img.buffer.length, 8); // Size
    entry.writeUInt32LE(offset, 12); // File offset
    entries.push(entry);
    offset += img.buffer.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.buffer)]);
}

/**
 * Pure-JS SDF Rasterizer for UniView icon elements
 */
export function renderSquareIcon(size, options = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const primaryR = 37, primaryG = 99, primaryB = 235; // #2563eb
  const mono = options.monochrome;
  const fullBleed = Boolean(options.fullBleed);
  const colorType = options.colorType ?? 6;

  const fillR = mono ? 0 : primaryR;
  const fillG = mono ? 0 : primaryG;
  const fillB = mono ? 0 : primaryB;

  const center = size / 2;
  const hw = center - 0.5;
  const hh = center - 0.5;
  const cornerRadius = size * 0.22;

  // Lens geometry
  const ew = size * 0.35;
  const eh = size * 0.24;
  const R = (ew * ew + eh * eh) / (2 * eh);
  const Yc = R - eh;

  const rp = size * 0.105;
  const rg = size * 0.032;
  const gx = size * 0.04;
  const gy = -size * 0.04;

  for (let py = 0; py < size; py++) {
    const y = py + 0.5 - center;
    for (let px = 0; px < size; px++) {
      const x = px + 0.5 - center;
      const idx = (py * size + px) * 4;

      let boxAlpha = 1.0;
      if (!fullBleed) {
        // Squircle SDF
        const qx = Math.max(0, Math.abs(x) - (hw - cornerRadius));
        const qy = Math.max(0, Math.abs(y) - (hh - cornerRadius));
        const distSquircle = Math.hypot(qx, qy) - cornerRadius;
        boxAlpha = Math.max(0, Math.min(1, 0.5 - distSquircle));
        if (boxAlpha <= 0) continue;
      }

      // Base background color
      let cr = fillR;
      let cg = fillG;
      let cb = fillB;
      let ca = boxAlpha;

      // 2. Eye lens SDF
      const dTop = Math.hypot(x, y + Yc) - R;
      const dBottom = Math.hypot(x, y - Yc) - R;
      const distLens = Math.max(dTop, dBottom);
      const lensAlpha = Math.max(0, Math.min(1, 0.5 - distLens));

      if (lensAlpha > 0) {
        // Blend white lens over squircle
        cr = cr * (1 - lensAlpha) + 255 * lensAlpha;
        cg = cg * (1 - lensAlpha) + 255 * lensAlpha;
        cb = cb * (1 - lensAlpha) + 255 * lensAlpha;

        // 3. Central pupil SDF
        const distPupil = Math.hypot(x, y) - rp;
        const pupilAlpha = Math.max(0, Math.min(1, 0.5 - distPupil));

        if (pupilAlpha > 0) {
          cr = cr * (1 - pupilAlpha) + fillR * pupilAlpha;
          cg = cg * (1 - pupilAlpha) + fillG * pupilAlpha;
          cb = cb * (1 - pupilAlpha) + fillB * pupilAlpha;

          // 4. Glint SDF
          const distGlint = Math.hypot(x - gx, y - gy) - rg;
          const glintAlpha = Math.max(0, Math.min(1, 0.5 - distGlint));
          if (glintAlpha > 0) {
            cr = cr * (1 - glintAlpha) + 255 * glintAlpha;
            cg = cg * (1 - glintAlpha) + 255 * glintAlpha;
            cb = cb * (1 - glintAlpha) + 255 * glintAlpha;
          }
        }
      }

      rgba[idx] = Math.round(cr);
      rgba[idx + 1] = Math.round(cg);
      rgba[idx + 2] = Math.round(cb);
      rgba[idx + 3] = Math.round(ca * 255);
    }
  }

  return encodePng(size, size, rgba, colorType);
}

export function renderRoundIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const primaryR = 37, primaryG = 99, primaryB = 235;

  const center = size / 2;
  const radius = center - 0.5;

  const ew = size * 0.35;
  const eh = size * 0.24;
  const R = (ew * ew + eh * eh) / (2 * eh);
  const Yc = R - eh;

  const rp = size * 0.105;
  const rg = size * 0.032;
  const gx = size * 0.04;
  const gy = -size * 0.04;

  for (let py = 0; py < size; py++) {
    const y = py + 0.5 - center;
    for (let px = 0; px < size; px++) {
      const x = px + 0.5 - center;
      const idx = (py * size + px) * 4;

      const distCircle = Math.hypot(x, y) - radius;
      const circleAlpha = Math.max(0, Math.min(1, 0.5 - distCircle));
      if (circleAlpha <= 0) continue;

      let cr = primaryR;
      let cg = primaryG;
      let cb = primaryB;
      let ca = circleAlpha;

      const dTop = Math.hypot(x, y + Yc) - R;
      const dBottom = Math.hypot(x, y - Yc) - R;
      const distLens = Math.max(dTop, dBottom);
      const lensAlpha = Math.max(0, Math.min(1, 0.5 - distLens));

      if (lensAlpha > 0) {
        cr = cr * (1 - lensAlpha) + 255 * lensAlpha;
        cg = cg * (1 - lensAlpha) + 255 * lensAlpha;
        cb = cb * (1 - lensAlpha) + 255 * lensAlpha;

        const distPupil = Math.hypot(x, y) - rp;
        const pupilAlpha = Math.max(0, Math.min(1, 0.5 - distPupil));
        if (pupilAlpha > 0) {
          cr = cr * (1 - pupilAlpha) + primaryR * pupilAlpha;
          cg = cg * (1 - pupilAlpha) + primaryG * pupilAlpha;
          cb = cb * (1 - pupilAlpha) + primaryB * pupilAlpha;

          const distGlint = Math.hypot(x - gx, y - gy) - rg;
          const glintAlpha = Math.max(0, Math.min(1, 0.5 - distGlint));
          if (glintAlpha > 0) {
            cr = cr * (1 - glintAlpha) + 255 * glintAlpha;
            cg = cg * (1 - glintAlpha) + 255 * glintAlpha;
            cb = cb * (1 - glintAlpha) + 255 * glintAlpha;
          }
        }
      }

      rgba[idx] = Math.round(cr);
      rgba[idx + 1] = Math.round(cg);
      rgba[idx + 2] = Math.round(cb);
      rgba[idx + 3] = Math.round(ca * 255);
    }
  }

  return encodePng(size, size, rgba);
}

export function renderAdaptiveForeground(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const primaryR = 37, primaryG = 99, primaryB = 235;

  const center = size / 2;
  // In 108dp adaptive canvas, safe zone is 66dp (~61% scale)
  const scale = size * 0.60;
  const ew = scale * 0.42;
  const eh = scale * 0.28;
  const R = (ew * ew + eh * eh) / (2 * eh);
  const Yc = R - eh;

  const rp = scale * 0.13;
  const rg = scale * 0.038;
  const gx = scale * 0.05;
  const gy = -scale * 0.05;

  for (let py = 0; py < size; py++) {
    const y = py + 0.5 - center;
    for (let px = 0; px < size; px++) {
      const x = px + 0.5 - center;
      const idx = (py * size + px) * 4;

      const dTop = Math.hypot(x, y + Yc) - R;
      const dBottom = Math.hypot(x, y - Yc) - R;
      const distLens = Math.max(dTop, dBottom);
      const lensAlpha = Math.max(0, Math.min(1, 0.5 - distLens));
      if (lensAlpha <= 0) continue;

      let cr = 255, cg = 255, cb = 255;
      let ca = lensAlpha;

      const distPupil = Math.hypot(x, y) - rp;
      const pupilAlpha = Math.max(0, Math.min(1, 0.5 - distPupil));
      if (pupilAlpha > 0) {
        cr = cr * (1 - pupilAlpha) + primaryR * pupilAlpha;
        cg = cg * (1 - pupilAlpha) + primaryG * pupilAlpha;
        cb = cb * (1 - pupilAlpha) + primaryB * pupilAlpha;

        const distGlint = Math.hypot(x - gx, y - gy) - rg;
        const glintAlpha = Math.max(0, Math.min(1, 0.5 - distGlint));
        if (glintAlpha > 0) {
          cr = cr * (1 - glintAlpha) + 255 * glintAlpha;
          cg = cg * (1 - glintAlpha) + 255 * glintAlpha;
          cb = cb * (1 - glintAlpha) + 255 * glintAlpha;
        }
      }

      rgba[idx] = Math.round(cr);
      rgba[idx + 1] = Math.round(cg);
      rgba[idx + 2] = Math.round(cb);
      rgba[idx + 3] = Math.round(ca * 255);
    }
  }

  return encodePng(size, size, rgba);
}

export function renderSplash(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  // Default fill: solid white
  rgba.fill(255);

  const primaryR = 37, primaryG = 99, primaryB = 235;

  const cx = width / 2;
  const cy = height / 2;
  // Scaled logo in center of splash screen
  const logoSize = Math.max(96, Math.min(384, Math.round(Math.min(width, height) * 0.28)));
  const halfLogo = logoSize / 2;
  const cornerRadius = logoSize * 0.22;

  const ew = logoSize * 0.35;
  const eh = logoSize * 0.24;
  const R = (ew * ew + eh * eh) / (2 * eh);
  const Yc = R - eh;

  const rp = logoSize * 0.105;
  const rg = logoSize * 0.032;
  const gx = logoSize * 0.04;
  const gy = -logoSize * 0.04;

  const minX = Math.max(0, Math.floor(cx - halfLogo - 2));
  const maxX = Math.min(width, Math.ceil(cx + halfLogo + 2));
  const minY = Math.max(0, Math.floor(cy - halfLogo - 2));
  const maxY = Math.min(height, Math.ceil(cy + halfLogo + 2));

  for (let py = minY; py < maxY; py++) {
    const y = py + 0.5 - cy;
    for (let px = minX; px < maxX; px++) {
      const x = px + 0.5 - cx;
      const idx = (py * width + px) * 4;

      const qx = Math.max(0, Math.abs(x) - (halfLogo - cornerRadius));
      const qy = Math.max(0, Math.abs(y) - (halfLogo - cornerRadius));
      const distSquircle = Math.hypot(qx, qy) - cornerRadius;
      const boxAlpha = Math.max(0, Math.min(1, 0.5 - distSquircle));
      if (boxAlpha <= 0) continue;

      let cr = primaryR;
      let cg = primaryG;
      let cb = primaryB;

      const dTop = Math.hypot(x, y + Yc) - R;
      const dBottom = Math.hypot(x, y - Yc) - R;
      const distLens = Math.max(dTop, dBottom);
      const lensAlpha = Math.max(0, Math.min(1, 0.5 - distLens));

      if (lensAlpha > 0) {
        cr = cr * (1 - lensAlpha) + 255 * lensAlpha;
        cg = cg * (1 - lensAlpha) + 255 * lensAlpha;
        cb = cb * (1 - lensAlpha) + 255 * lensAlpha;

        const distPupil = Math.hypot(x, y) - rp;
        const pupilAlpha = Math.max(0, Math.min(1, 0.5 - distPupil));
        if (pupilAlpha > 0) {
          cr = cr * (1 - pupilAlpha) + primaryR * pupilAlpha;
          cg = cg * (1 - pupilAlpha) + primaryG * pupilAlpha;
          cb = cb * (1 - pupilAlpha) + primaryB * pupilAlpha;

          const distGlint = Math.hypot(x - gx, y - gy) - rg;
          const glintAlpha = Math.max(0, Math.min(1, 0.5 - distGlint));
          if (glintAlpha > 0) {
            cr = cr * (1 - glintAlpha) + 255 * glintAlpha;
            cg = cg * (1 - glintAlpha) + 255 * glintAlpha;
            cb = cb * (1 - glintAlpha) + 255 * glintAlpha;
          }
        }
      }

      // Blend over white background
      rgba[idx] = Math.round(255 * (1 - boxAlpha) + cr * boxAlpha);
      rgba[idx + 1] = Math.round(255 * (1 - boxAlpha) + cg * boxAlpha);
      rgba[idx + 2] = Math.round(255 * (1 - boxAlpha) + cb * boxAlpha);
      rgba[idx + 3] = 255;
    }
  }

  return encodePng(width, height, rgba);
}

function writeAsset(relPath, buffer) {
  const fullPath = join(ROOT, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, buffer);
  console.log(`Generated: ${relPath}`);
}

export async function generateAll() {
  console.log("Generating UniView Brand Assets (Packet P20)...");

  // 1. Desktop & Web icons
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) {
    const png = renderSquareIcon(size);
    icoImages.push({ width: size, height: size, buffer: png });
  }
  const icoBuffer = createIco(icoImages);
  writeAsset("build/icon.ico", icoBuffer);

  const icon512 = renderSquareIcon(512);
  writeAsset("build/icon.png", icon512);
  writeAsset("public/icon.png", icon512);

  // Play Store 512: full-bleed square (Play masks it) with no transparent corners
  const playStore512 = renderSquareIcon(512, { fullBleed: true });
  writeAsset("assets/branding/play-store-512.png", playStore512);

  const favicon64 = renderSquareIcon(64);
  writeAsset("public/favicon.png", favicon64);

  const logo256 = renderSquareIcon(256);
  writeAsset("src/ui/assets/logo.png", logo256);

  // 2. iOS AppIcon: full-bleed OPAQUE square with no alpha channel (PNG colour type 2)
  const icon1024 = renderSquareIcon(1024, { fullBleed: true, colorType: 2 });
  writeAsset("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", icon1024);

  // 3. iOS Splash Screens (2732x2732)
  const iosSplash = renderSplash(2732, 2732);
  writeAsset("ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png", iosSplash);
  writeAsset("ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png", iosSplash);
  writeAsset("ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png", iosSplash);

  // 4. Android Mipmap Densities
  const mipmapDensities = [
    { name: "mdpi", size: 48, fg: 108 },
    { name: "hdpi", size: 72, fg: 162 },
    { name: "xhdpi", size: 96, fg: 216 },
    { name: "xxhdpi", size: 144, fg: 324 },
    { name: "xxxhdpi", size: 192, fg: 432 },
  ];

  for (const d of mipmapDensities) {
    writeAsset(
      `android/app/src/main/res/mipmap-${d.name}/ic_launcher.png`,
      renderSquareIcon(d.size)
    );
    writeAsset(
      `android/app/src/main/res/mipmap-${d.name}/ic_launcher_round.png`,
      renderRoundIcon(d.size)
    );
    writeAsset(
      `android/app/src/main/res/mipmap-${d.name}/ic_launcher_foreground.png`,
      renderAdaptiveForeground(d.fg)
    );
  }

  // 5. Android Splash Screens
  const splashVariants = [
    { path: "android/app/src/main/res/drawable/splash.png", w: 480, h: 320 },
    { path: "android/app/src/main/res/drawable-port-mdpi/splash.png", w: 320, h: 480 },
    { path: "android/app/src/main/res/drawable-port-hdpi/splash.png", w: 480, h: 800 },
    { path: "android/app/src/main/res/drawable-port-xhdpi/splash.png", w: 720, h: 1280 },
    { path: "android/app/src/main/res/drawable-port-xxhdpi/splash.png", w: 960, h: 1600 },
    { path: "android/app/src/main/res/drawable-port-xxxhdpi/splash.png", w: 1280, h: 1920 },
    { path: "android/app/src/main/res/drawable-land-mdpi/splash.png", w: 480, h: 320 },
    { path: "android/app/src/main/res/drawable-land-hdpi/splash.png", w: 800, h: 480 },
    { path: "android/app/src/main/res/drawable-land-xhdpi/splash.png", w: 1280, h: 720 },
    { path: "android/app/src/main/res/drawable-land-xxhdpi/splash.png", w: 1600, h: 960 },
    { path: "android/app/src/main/res/drawable-land-xxxhdpi/splash.png", w: 1920, h: 1280 },
  ];

  for (const s of splashVariants) {
    writeAsset(s.path, renderSplash(s.w, s.h));
  }

  console.log("All branding assets generated successfully!");
}

// Auto-run if executed as script directly
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  generateAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
