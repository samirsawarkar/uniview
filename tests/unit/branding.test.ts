import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const ROOT = resolve(".");

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) throw new Error("PNG buffer too short");
  const magic = buf.subarray(0, 8);
  const expectedMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!magic.equals(expectedMagic)) throw new Error("Not a PNG signature");
  const type = buf.toString("ascii", 12, 16);
  if (type !== "IHDR") throw new Error("Expected IHDR chunk");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function readPngDetails(buf: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  pixel0: { r: number; g: number; b: number; a: number };
} {
  if (buf.length < 24) throw new Error("PNG buffer too short");
  const magic = buf.subarray(0, 8);
  const expectedMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!magic.equals(expectedMagic)) throw new Error("Not a PNG signature");
  const type = buf.toString("ascii", 12, 16);
  if (type !== "IHDR") throw new Error("Expected IHDR chunk");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);

  let offset = 8;
  const idatParts: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const chunkType = buf.toString("ascii", offset + 4, offset + 8);
    if (chunkType === "IDAT") {
      idatParts.push(buf.subarray(offset + 8, offset + 8 + len));
    }
    offset += 8 + len + 4;
  }

  const decompressed = inflateSync(Buffer.concat(idatParts));
  // First byte is filter type for line 0
  const r = decompressed[1] ?? 0;
  const g = decompressed[2] ?? 0;
  const b = decompressed[3] ?? 0;
  const a = colorType === 2 ? 255 : (decompressed[4] ?? 0);

  return { width, height, bitDepth, colorType, pixel0: { r, g, b, a } };
}

function readIcoSizes(buf: Buffer): { width: number; height: number }[] {
  if (buf.length < 6) throw new Error("ICO buffer too short");
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) throw new Error("Not a valid ICO format");
  const sizes: { width: number; height: number }[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    let w = buf.readUInt8(offset);
    let h = buf.readUInt8(offset + 1);
    if (w === 0) w = 256;
    if (h === 0) h = 256;
    sizes.push({ width: w, height: h });
  }
  return sizes;
}

const HASH_LOG_PATH = join(ROOT, "assets/branding/removed-capacitor-assets.txt");

function loadCapacitorLedger(): Set<string> {
  if (!existsSync(HASH_LOG_PATH)) {
    throw new Error(`Capacitor hash ledger missing at ${HASH_LOG_PATH}`);
  }
  const lines = readFileSync(HASH_LOG_PATH, "utf8").split("\n");
  const banned = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hash] = trimmed.split(/\s+/);
    if (hash) banned.add(hash);
  }
  return banned;
}

const IMAGE_REGEX = /\.(png|ico|jpg|jpeg|webp)$/i;
const IGNORED_IMAGE_PATHS = [
  /[\\/]android[\\/]app[\\/]build[\\/]/i,
  /[\\/]android[\\/]build[\\/]/i,
  /[\\/]android[\\/]\.gradle[\\/]/i,
  /[\\/]android[\\/]app[\\/]src[\\/]main[\\/]assets[\\/]public[\\/]/i,
  /[\\/]android[\\/]capacitor-cordova-android-plugins[\\/]build[\\/]/i,
  /[\\/]node_modules[\\/]/i,
];

function isTrackedImagePath(filePath: string): boolean {
  return !IGNORED_IMAGE_PATHS.some((re) => re.test(filePath));
}

function collectTrackedImages(dir: string): string[] {
  const fullDir = join(ROOT, dir);
  if (!existsSync(fullDir)) return [];
  const results: string[] = [];

  function walk(current: string) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (isTrackedImagePath(full + "/")) {
          walk(full);
        }
      } else if (entry.isFile() && IMAGE_REGEX.test(entry.name) && isTrackedImagePath(full)) {
        results.push(full);
      }
    }
  }

  walk(fullDir);
  return results;
}

const REQUIRED_PNG_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "build/icon.png": { width: 512, height: 512 },
  "public/icon.png": { width: 512, height: 512 },
  "public/favicon.png": { width: 64, height: 64 },
  "src/ui/assets/logo.png": { width: 256, height: 256 },
  "assets/branding/play-store-512.png": { width: 512, height: 512 },
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png": { width: 1024, height: 1024 },
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png": { width: 2732, height: 2732 },
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png": { width: 2732, height: 2732 },
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png": { width: 2732, height: 2732 },
  "android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png": { width: 108, height: 108 },
  "android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png": { width: 162, height: 162 },
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png": { width: 216, height: 216 },
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png": { width: 324, height: 324 },
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png": { width: 432, height: 432 },
  "android/app/src/main/res/mipmap-mdpi/ic_launcher.png": { width: 48, height: 48 },
  "android/app/src/main/res/mipmap-hdpi/ic_launcher.png": { width: 72, height: 72 },
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png": { width: 96, height: 96 },
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png": { width: 144, height: 144 },
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png": { width: 192, height: 192 },
  "android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png": { width: 48, height: 48 },
  "android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png": { width: 72, height: 72 },
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png": { width: 96, height: 96 },
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png": { width: 144, height: 144 },
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png": { width: 192, height: 192 },
  "android/app/src/main/res/drawable/splash.png": { width: 480, height: 320 },
  "android/app/src/main/res/drawable-port-mdpi/splash.png": { width: 320, height: 480 },
  "android/app/src/main/res/drawable-port-hdpi/splash.png": { width: 480, height: 800 },
  "android/app/src/main/res/drawable-port-xhdpi/splash.png": { width: 720, height: 1280 },
  "android/app/src/main/res/drawable-port-xxhdpi/splash.png": { width: 960, height: 1600 },
  "android/app/src/main/res/drawable-port-xxxhdpi/splash.png": { width: 1280, height: 1920 },
  "android/app/src/main/res/drawable-land-mdpi/splash.png": { width: 480, height: 320 },
  "android/app/src/main/res/drawable-land-hdpi/splash.png": { width: 800, height: 480 },
  "android/app/src/main/res/drawable-land-xhdpi/splash.png": { width: 1280, height: 720 },
  "android/app/src/main/res/drawable-land-xxhdpi/splash.png": { width: 1600, height: 960 },
  "android/app/src/main/res/drawable-land-xxxhdpi/splash.png": { width: 1920, height: 1280 },
};

describe("UniView Branding Asset Replacement (P20 / P21)", () => {
  beforeAll(async () => {
    // Note: branding.test.ts strictly reads committed assets.
    // If a regeneration marker exists from an ongoing test run, wait briefly for it to complete.
    const marker = join(ROOT, "assets/branding/.regenerate");
    if (existsSync(marker)) {
      for (let i = 0; i < 200; i++) {
        if (!existsSync(marker)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 30_000);

  it("master SVG source and README exist in assets/branding", () => {
    expect(existsSync(join(ROOT, "assets/branding/uniview-icon.svg"))).toBe(true);
    expect(existsSync(join(ROOT, "assets/branding/uniview-icon-monochrome.svg"))).toBe(true);
    expect(existsSync(join(ROOT, "assets/branding/README.md"))).toBe(true);

    const svg = readFileSync(join(ROOT, "assets/branding/uniview-icon.svg"), "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("#2563eb");

    const readme = readFileSync(join(ROOT, "assets/branding/README.md"), "utf8");
    expect(readme.toLowerCase()).toContain("placeholder");
    expect(readme.toLowerCase()).toContain("replace");
  });

  it("master SVG key numbers (colours, viewBox, geometry) match generator ICON_CONSTANTS", async () => {
    const { ICON_CONSTANTS } = await import("../../scripts/generate-icons.mjs");
    const svgPath = join(ROOT, "assets/branding/uniview-icon.svg");
    expect(existsSync(svgPath)).toBe(true);
    const svg = readFileSync(svgPath, "utf8");

    expect(svg).toContain(`viewBox="${ICON_CONSTANTS.viewBox}"`);
    expect(svg).toContain(`width="${ICON_CONSTANTS.viewBoxSize}"`);
    expect(svg).toContain(`height="${ICON_CONSTANTS.viewBoxSize}"`);
    expect(svg).toContain(ICON_CONSTANTS.colors.primary);
    expect(svg).toContain(ICON_CONSTANTS.colors.white);
    expect(svg).toContain(`rx="${ICON_CONSTANTS.geometry.squircleRadius}"`);
    expect(svg).toContain(`A ${ICON_CONSTANTS.geometry.lensArcRadius} ${ICON_CONSTANTS.geometry.lensArcRadius}`);
    expect(svg).toContain(`r="${ICON_CONSTANTS.geometry.pupilRadius}"`);
    expect(svg).toContain(`r="${ICON_CONSTANTS.geometry.glintRadius}"`);
    expect(svg).toContain(`cx="${ICON_CONSTANTS.geometry.glintCx}" cy="${ICON_CONSTANTS.geometry.glintCy}"`);
  });

  it("electron-builder.json icon paths exist and resolve to valid files", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "electron-builder.json"), "utf8"));
    const winIcon = config.win?.icon;
    const macIcon = config.mac?.icon;
    const linuxIcon = config.linux?.icon;

    expect(winIcon).toBe("build/icon.ico");
    expect(existsSync(join(ROOT, winIcon))).toBe(true);
    expect(existsSync(join(ROOT, macIcon))).toBe(true);
    expect(existsSync(join(ROOT, linuxIcon))).toBe(true);
  });

  it("build/icon.ico exists and contains all 7 required dimensions (16,24,32,48,64,128,256)", () => {
    const icoPath = join(ROOT, "build/icon.ico");
    expect(existsSync(icoPath)).toBe(true);
    const buf = readFileSync(icoPath);
    const sizes = readIcoSizes(buf);
    const required = [16, 24, 32, 48, 64, 128, 256];
    for (const r of required) {
      expect(sizes).toContainEqual({ width: r, height: r });
    }
  });

  it("every required PNG asset exists and matches required width/height", () => {
    for (const [rel, expectedDim] of Object.entries(REQUIRED_PNG_DIMENSIONS)) {
      const full = join(ROOT, rel);
      expect(existsSync(full), `File must exist: ${rel}`).toBe(true);
      const buf = readFileSync(full);
      const dim = readPngDimensions(buf);
      expect(dim, `Dimensions for ${rel}`).toEqual(expectedDim);
    }
  });

  it("iOS 1024 app icon is full-bleed opaque square with PNG colour type 2 (no alpha channel)", () => {
    const full = join(ROOT, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    expect(existsSync(full)).toBe(true);
    const buf = readFileSync(full);
    const details = readPngDetails(buf);

    expect(details.width).toBe(1024);
    expect(details.height).toBe(1024);
    expect(details.colorType, "iOS app icon must have colour type 2 (Truecolour RGB, no alpha channel)").toBe(2);
    expect(details.pixel0.a, "iOS app icon pixel (0,0) must be opaque").toBe(255);
    expect(details.pixel0.r).toBe(37);
    expect(details.pixel0.g).toBe(99);
    expect(details.pixel0.b).toBe(235);
  });

  it("Play Store 512 icon is full-bleed square with opaque corners", () => {
    const full = join(ROOT, "assets/branding/play-store-512.png");
    expect(existsSync(full)).toBe(true);
    const buf = readFileSync(full);
    const details = readPngDetails(buf);

    expect(details.width).toBe(512);
    expect(details.height).toBe(512);
    expect(details.pixel0.a, "Play Store icon pixel (0,0) must be opaque (no transparent corners)").toBe(255);
    expect(details.pixel0.r).toBe(37);
    expect(details.pixel0.g).toBe(99);
    expect(details.pixel0.b).toBe(235);
  });

  it("every tracked image under android/, ios/, public/, build/, src/ui/assets, assets/ differs from all recorded Capacitor hashes", () => {
    const bannedHashes = loadCapacitorLedger();
    expect(bannedHashes.size).toBeGreaterThan(0);

    const scanDirs = ["android", "ios", "public", "build", "src/ui/assets", "assets"];
    const allImages = scanDirs.flatMap((d) => collectTrackedImages(d));

    expect(allImages.length).toBeGreaterThanOrEqual(30);

    const violations: { file: string; hash: string }[] = [];
    for (const imgPath of allImages) {
      const buf = readFileSync(imgPath);
      const h = sha256(buf);
      if (bannedHashes.has(h)) {
        violations.push({ file: imgPath, hash: h });
      }
    }

    expect(
      violations,
      `Tracked images must not match any hash in the Capacitor ledger`
    ).toEqual([]);
  });

  it("Android adaptive icon XMLs have been updated with UniView branding and monochrome layer", () => {
    const fgXmlPath = join(ROOT, "android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml");
    expect(existsSync(fgXmlPath)).toBe(true);
    const fgXml = readFileSync(fgXmlPath, "utf8");
    expect(fgXml).not.toContain("M32,64C32,64"); // Old Capacitor path

    const bgXmlPath = join(ROOT, "android/app/src/main/res/drawable/ic_launcher_background.xml");
    expect(existsSync(bgXmlPath)).toBe(true);

    const monoXmlPath = join(ROOT, "android/app/src/main/res/drawable/ic_launcher_monochrome.xml");
    expect(existsSync(monoXmlPath)).toBe(true);

    const anydpiLauncher = join(ROOT, "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
    const anydpiRound = join(ROOT, "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml");
    expect(existsSync(anydpiLauncher)).toBe(true);
    expect(existsSync(anydpiRound)).toBe(true);
    expect(readFileSync(anydpiLauncher, "utf8")).toContain("monochrome");
    expect(readFileSync(anydpiRound, "utf8")).toContain("monochrome");
  });
});
