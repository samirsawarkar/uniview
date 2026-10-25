import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cleanLogo, decodePng } from "../../scripts/clean-logo.mjs";
import { encodePng } from "../../scripts/generate-icons.mjs";

// Always-on tests only READ the committed assets. Regeneration lives in branding-generate.test.ts
// (UNIVIEW_GENERATE_ICONS=1) or `node scripts/generate-icons.mjs`.

const ROOT = resolve(".");
const SOURCE_REL = "assets/branding/uniview-logo-source.png";
const MASTER_REL = "assets/branding/uniview-logo.png";
const SOURCE_SHA256 = "10eb69956383c4bc78cf00eb4dda95710a7cf1a7417f201ff4fdca1bb6203e3a";
const MASTER_SHA256 = "99686e77198e499ac09cf92d30b076629038d4fb4778ad20f47cd3e4fcd1165e";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RES = "android/app/src/main/res";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readPngHeader(buf: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  if (buf.length < 33) throw new Error("PNG buffer too short");
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("Not a PNG signature");
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("Expected IHDR chunk");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf.readUInt8(24), colorType: buf.readUInt8(25) };
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  const { width, height } = readPngHeader(buf);
  return { width, height };
}

interface IcoEntry {
  width: number;
  height: number;
  size: number;
  offset: number;
}

function readIco(buf: Buffer): IcoEntry[] {
  if (buf.length < 6) throw new Error("ICO buffer too short");
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("Not a valid ICO format");
  const count = buf.readUInt16LE(4);
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    entries.push({
      width: buf.readUInt8(o) || 256,
      height: buf.readUInt8(o + 1) || 256,
      size: buf.readUInt32LE(o + 8),
      offset: buf.readUInt32LE(o + 12),
    });
  }
  return entries;
}

function loadLedger(rel: string): Set<string> {
  const path = join(ROOT, rel);
  if (!existsSync(path)) throw new Error(`Hash ledger missing at ${path}`);
  const banned = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hash] = trimmed.split(/\s+/);
    if (hash) banned.add(hash);
  }
  return banned;
}

const IMAGE_REGEX = /\.(png|ico|jpg|jpeg|webp|svg)$/i;
const IGNORED_IMAGE_PATHS = [
  /[\\/]android[\\/]app[\\/]build[\\/]/i,
  /[\\/]android[\\/]build[\\/]/i,
  /[\\/]android[\\/]\.gradle[\\/]/i,
  /[\\/]android[\\/]app[\\/]src[\\/]main[\\/]assets[\\/]public[\\/]/i,
  /[\\/]android[\\/]capacitor-cordova-android-plugins[\\/]build[\\/]/i,
  /[\\/]node_modules[\\/]/i,
];

function collectImages(dir: string): string[] {
  const fullDir = join(ROOT, dir);
  if (!existsSync(fullDir)) return [];
  const results: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (IGNORED_IMAGE_PATHS.some((re) => re.test(full + (entry.isDirectory() ? "/" : "")))) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && IMAGE_REGEX.test(entry.name)) results.push(full);
    }
  };
  walk(fullDir);
  return results;
}

const corners = (w: number, h: number): Array<[number, number]> => [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
const byteAt = (b: Buffer, i: number): number => b[i] ?? 0;

const sq = (n: number) => ({ width: n, height: n });

const REQUIRED_PNG_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "build/icon.png": sq(512),
  "build/icon-1024.png": sq(1024),
  "public/icon.png": sq(512),
  "public/favicon.png": sq(64),
  "src/ui/assets/logo.png": sq(256),
  "assets/branding/play-store-512.png": sq(512),
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png": sq(1024),
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png": sq(2732),
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png": sq(2732),
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png": sq(2732),
  [`${RES}/mipmap-mdpi/ic_launcher_foreground.png`]: sq(108),
  [`${RES}/mipmap-hdpi/ic_launcher_foreground.png`]: sq(162),
  [`${RES}/mipmap-xhdpi/ic_launcher_foreground.png`]: sq(216),
  [`${RES}/mipmap-xxhdpi/ic_launcher_foreground.png`]: sq(324),
  [`${RES}/mipmap-xxxhdpi/ic_launcher_foreground.png`]: sq(432),
  [`${RES}/mipmap-mdpi/ic_launcher.png`]: sq(48),
  [`${RES}/mipmap-hdpi/ic_launcher.png`]: sq(72),
  [`${RES}/mipmap-xhdpi/ic_launcher.png`]: sq(96),
  [`${RES}/mipmap-xxhdpi/ic_launcher.png`]: sq(144),
  [`${RES}/mipmap-xxxhdpi/ic_launcher.png`]: sq(192),
  [`${RES}/mipmap-mdpi/ic_launcher_round.png`]: sq(48),
  [`${RES}/mipmap-hdpi/ic_launcher_round.png`]: sq(72),
  [`${RES}/mipmap-xhdpi/ic_launcher_round.png`]: sq(96),
  [`${RES}/mipmap-xxhdpi/ic_launcher_round.png`]: sq(144),
  [`${RES}/mipmap-xxxhdpi/ic_launcher_round.png`]: sq(192),
  [`${RES}/drawable/splash.png`]: { width: 480, height: 320 },
  [`${RES}/drawable-port-mdpi/splash.png`]: { width: 320, height: 480 },
  [`${RES}/drawable-port-hdpi/splash.png`]: { width: 480, height: 800 },
  [`${RES}/drawable-port-xhdpi/splash.png`]: { width: 720, height: 1280 },
  [`${RES}/drawable-port-xxhdpi/splash.png`]: { width: 960, height: 1600 },
  [`${RES}/drawable-port-xxxhdpi/splash.png`]: { width: 1280, height: 1920 },
  [`${RES}/drawable-land-mdpi/splash.png`]: { width: 480, height: 320 },
  [`${RES}/drawable-land-hdpi/splash.png`]: { width: 800, height: 480 },
  [`${RES}/drawable-land-xhdpi/splash.png`]: { width: 1280, height: 720 },
  [`${RES}/drawable-land-xxhdpi/splash.png`]: { width: 1600, height: 960 },
  [`${RES}/drawable-land-xxxhdpi/splash.png`]: { width: 1920, height: 1280 },
};

const OPAQUE_PNGS = ["assets/branding/play-store-512.png", "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"];

describe("UniView logo: the CEO-supplied image is the only logo", () => {
  it("the original supplied logo is kept byte-identical and its hash equals the one recorded in the README", () => {
    const buf = readFileSync(join(ROOT, SOURCE_REL));
    expect(readPngDimensions(buf)).toEqual({ width: 135, height: 133 });
    const recorded = readFileSync(join(ROOT, "assets/branding/README.md"), "utf8").match(/Source SHA-256:\s*`([0-9a-f]{64})`/);
    expect(recorded, "README must record the source SHA-256").not.toBeNull();
    expect(sha256(buf)).toBe(recorded![1]);
    expect(sha256(buf)).toBe(SOURCE_SHA256);
  });

  it("the clean master is a square RGBA PNG whose hash equals the README, with a transparent background", () => {
    const buf = readFileSync(join(ROOT, MASTER_REL));
    const header = readPngHeader(buf);
    expect(header.width).toBe(header.height);
    expect(header.colorType).toBe(6);
    const recorded = readFileSync(join(ROOT, "assets/branding/README.md"), "utf8").match(/Master SHA-256:\s*`([0-9a-f]{64})`/);
    expect(recorded, "README must record the master SHA-256").not.toBeNull();
    expect(sha256(buf)).toBe(recorded![1]);
    expect(sha256(buf)).toBe(MASTER_SHA256);
    const img = decodePng(buf);
    for (const [x, y] of corners(img.width, img.height)) {
      expect(byteAt(img.rgba, (y * img.width + x) * 4 + 3), `corner ${x},${y} alpha`).toBe(0);
    }
  });

  it("the clean master is exactly what scripts/clean-logo.mjs derives from the original (reproducible)", () => {
    const clean = cleanLogo(decodePng(readFileSync(join(ROOT, SOURCE_REL))));
    expect(sha256(encodePng(clean.width, clean.height, clean.rgba, 6))).toBe(MASTER_SHA256);
  });

  it("assets/branding contains only the two masters, README, ledgers and the generated Play Store icon", () => {
    expect(readdirSync(join(ROOT, "assets/branding")).sort()).toEqual(
      [
        "README.md",
        "play-store-512.png",
        "removed-capacitor-assets.txt",
        "removed-placeholder-assets.txt",
        "uniview-logo-source.png",
        "uniview-logo.png",
      ].sort()
    );
  });

  it("the blue-eye placeholder masters are gone (no SVG, monochrome layer or vector foreground)", () => {
    for (const rel of [
      "assets/branding/uniview-icon.svg",
      "assets/branding/uniview-icon-monochrome.svg",
      `${RES}/drawable/ic_launcher_monochrome.xml`,
      `${RES}/drawable-v24/ic_launcher_foreground.xml`,
    ]) {
      expect(existsSync(join(ROOT, rel)), `${rel} must not exist`).toBe(false);
    }
  });

  it("electron-builder.json icon paths exist and resolve to valid files", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "electron-builder.json"), "utf8"));
    expect(config.win?.icon).toBe("build/icon.ico");
    for (const icon of [config.win?.icon, config.mac?.icon, config.linux?.icon]) {
      expect(existsSync(join(ROOT, icon)), `${icon} must exist`).toBe(true);
    }
  });

  it("the Electron window icon is dist/icon.png, which is public/icon.png as built", () => {
    const main = readFileSync(join(ROOT, "electron/main.mjs"), "utf8");
    expect(main).toContain('icon: join(here, "..", "dist", "icon.png")');
    expect(existsSync(join(ROOT, "public/icon.png"))).toBe(true);
  });

  it("build/icon.ico holds PNG frames at 16, 24, 32, 48, 64, 128 and 256", () => {
    const buf = readFileSync(join(ROOT, "build/icon.ico"));
    const entries = readIco(buf);
    expect(entries.map((e) => e.width).sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    for (const e of entries) {
      expect(e.width).toBe(e.height);
      const frame = buf.subarray(e.offset, e.offset + e.size);
      expect(readPngDimensions(frame), `ICO frame ${e.width}`).toEqual({ width: e.width, height: e.height });
    }
  });

  it("every required PNG asset exists with the right dimensions", () => {
    for (const [rel, expected] of Object.entries(REQUIRED_PNG_DIMENSIONS)) {
      const full = join(ROOT, rel);
      expect(existsSync(full), `File must exist: ${rel}`).toBe(true);
      expect(readPngDimensions(readFileSync(full)), `Dimensions for ${rel}`).toEqual(expected);
    }
  });

  it("iOS 1024 and Play Store 512 icons are OPAQUE: PNG colour type 2, 8-bit, no alpha channel", () => {
    for (const rel of OPAQUE_PNGS) {
      const header = readPngHeader(readFileSync(join(ROOT, rel)));
      expect(header.colorType, `${rel} colour type`).toBe(2);
      expect(header.bitDepth).toBe(8);
    }
  });

  it("iOS and Android splash images are plain opaque images (colour type 2)", () => {
    const splashes = Object.keys(REQUIRED_PNG_DIMENSIONS).filter((p) => /splash/.test(p));
    expect(splashes.length).toBe(14);
    for (const rel of splashes) {
      expect(readPngHeader(readFileSync(join(ROOT, rel))).colorType, rel).toBe(2);
    }
  });

  it("the adaptive icon is background + foreground only (no monochrome layer) on a white background", () => {
    for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
      const xml = readFileSync(join(ROOT, `${RES}/mipmap-anydpi-v26/${name}`), "utf8");
      expect(xml).toContain('@mipmap/ic_launcher_foreground"');
      expect(xml).toContain('@color/ic_launcher_background"');
      expect(xml.toLowerCase()).not.toContain("monochrome");
    }
    expect(readFileSync(join(ROOT, `${RES}/values/ic_launcher_background.xml`), "utf8")).toContain("#FFFFFF");
    expect(readFileSync(join(ROOT, `${RES}/drawable/ic_launcher_background.xml`), "utf8")).toContain("#FFFFFF");
  });

  it("no file under android/, ios/, public/, build/, src/ui/assets, assets/ has the hash of a blue-eye placeholder or a Capacitor default", () => {
    const placeholder = loadLedger("assets/branding/removed-placeholder-assets.txt");
    const capacitor = loadLedger("assets/branding/removed-capacitor-assets.txt");
    expect(placeholder.size).toBeGreaterThan(20);
    expect(capacitor.size).toBeGreaterThan(20);

    const scanDirs = ["android", "ios", "public", "build", "src/ui/assets", "assets"];
    const allImages = scanDirs.flatMap((d) => collectImages(d));
    expect(allImages.length).toBeGreaterThanOrEqual(35);

    const violations: { file: string; ledger: string }[] = [];
    for (const imgPath of allImages) {
      const h = sha256(readFileSync(imgPath));
      if (placeholder.has(h)) violations.push({ file: imgPath, ledger: "placeholder" });
      if (capacitor.has(h)) violations.push({ file: imgPath, ledger: "capacitor" });
    }
    expect(violations).toEqual([]);
  });

  it("transparent-capable outputs have transparent corners and no dark opaque pixel within 3 px of any edge (no flattened black frame)", () => {
    const transparentOutputs = [
      "build/icon.png",
      "build/icon-1024.png",
      "public/icon.png",
      "public/favicon.png",
      "src/ui/assets/logo.png",
      ...Object.keys(REQUIRED_PNG_DIMENSIONS).filter((p) => /ic_launcher/.test(p)),
    ];
    expect(transparentOutputs.length).toBe(20);
    for (const rel of transparentOutputs) {
      const img = decodePng(readFileSync(join(ROOT, rel)));
      const { width: w, height: h, rgba } = img;
      const a = (x: number, y: number) => byteAt(rgba, (y * w + x) * 4 + 3);
      for (const [x, y] of corners(w, h)) {
        // alpha 0 up to resampling noise (an anti-aliased corner of a small icon can land on alpha 1..8: invisible)
        expect(a(x, y), `${rel} corner ${x},${y} must be transparent`).toBeLessThanOrEqual(8);
      }
      const dark: string[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (x >= 3 && y >= 3 && x < w - 3 && y < h - 3) continue;
          const i = (y * w + x) * 4;
          const lum = 0.299 * byteAt(rgba, i) + 0.587 * byteAt(rgba, i + 1) + 0.114 * byteAt(rgba, i + 2);
          if (lum < 60 && byteAt(rgba, i + 3) > 200) dark.push(`${x},${y}`);
        }
      }
      expect(dark.slice(0, 5), `${rel} has dark opaque pixels near its edges`).toEqual([]);
    }
  });

  it("opaque store icons (iOS 1024, Play 512) are full-bleed white at all four corners, not black", () => {
    for (const rel of OPAQUE_PNGS) {
      const { width: w, height: h, rgba } = decodePng(readFileSync(join(ROOT, rel)));
      for (const [x, y] of corners(w, h)) {
        const i = (y * w + x) * 4;
        expect([byteAt(rgba, i), byteAt(rgba, i + 1), byteAt(rgba, i + 2)], `${rel} corner ${x},${y}`).toEqual([255, 255, 255]);
      }
    }
  });

  it("splash images are plain white at the corners and the logo (blue bars) sits in the centre", () => {
    for (const rel of Object.keys(REQUIRED_PNG_DIMENSIONS).filter((p) => /splash/.test(p))) {
      const { width: w, height: h, rgba } = decodePng(readFileSync(join(ROOT, rel)));
      const px = (x: number, y: number): number[] => [byteAt(rgba, (y * w + x) * 4), byteAt(rgba, (y * w + x) * 4 + 1), byteAt(rgba, (y * w + x) * 4 + 2)];
      expect(px(0, 0), rel).toEqual([255, 255, 255]);
      expect(px(w - 1, h - 1), rel).toEqual([255, 255, 255]);
      let blue = 0;
      for (let y = Math.floor(h / 2) - 40; y < Math.floor(h / 2) + 40; y++) {
        for (let x = Math.floor(w / 2) - 40; x < Math.floor(w / 2) + 40; x++) {
          const [r = 0, , b = 0] = px(x, y);
          if (b > 200 && r < 160) blue++;
        }
      }
      expect(blue, `${rel} should show the blue bars at its centre`).toBeGreaterThan(50);
    }
  });

  it("the in-app logo is a 256 px resampled copy of the master, not the old placeholder", () => {
    const logo = readFileSync(join(ROOT, "src/ui/assets/logo.png"));
    expect(readPngDimensions(logo)).toEqual({ width: 256, height: 256 });
    expect(sha256(logo)).not.toBe(MASTER_SHA256);
  });
});
