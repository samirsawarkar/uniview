import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

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

const FORMER_CAPACITOR_FILES = [
  "public/icon.png",
  "public/favicon.png",
  "build/icon.png",
  "src/ui/assets/logo.png",
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png",
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png",
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png",
  "android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml",
  "android/app/src/main/res/drawable/ic_launcher_background.xml",
  "android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png",
  "android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png",
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png",
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png",
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png",
  "android/app/src/main/res/mipmap-mdpi/ic_launcher.png",
  "android/app/src/main/res/mipmap-hdpi/ic_launcher.png",
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png",
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
  "android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png",
  "android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png",
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png",
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png",
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png",
  "android/app/src/main/res/drawable/splash.png",
  "android/app/src/main/res/drawable-port-mdpi/splash.png",
  "android/app/src/main/res/drawable-port-hdpi/splash.png",
  "android/app/src/main/res/drawable-port-xhdpi/splash.png",
  "android/app/src/main/res/drawable-port-xxhdpi/splash.png",
  "android/app/src/main/res/drawable-port-xxxhdpi/splash.png",
  "android/app/src/main/res/drawable-land-mdpi/splash.png",
  "android/app/src/main/res/drawable-land-hdpi/splash.png",
  "android/app/src/main/res/drawable-land-xhdpi/splash.png",
  "android/app/src/main/res/drawable-land-xxhdpi/splash.png",
  "android/app/src/main/res/drawable-land-xxxhdpi/splash.png",
];

const HASH_LOG_PATH = join(ROOT, "assets/branding/removed-capacitor-assets.txt");

function recordFormerCapacitorHashesIfMissing(): Map<string, string> {
  const map = new Map<string, string>();
  if (existsSync(HASH_LOG_PATH)) {
    const lines = readFileSync(HASH_LOG_PATH, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [hash, ...rest] = trimmed.split(/\s+/);
      const relPath = rest.join(" ");
      if (hash && relPath) map.set(relPath, hash);
    }
    return map;
  }

  // Snapshot before deletion
  mkdirSync(join(ROOT, "assets/branding"), { recursive: true });
  const records: string[] = ["# Recorded SHA-256 hashes of Capacitor default assets before P20 replacement"];
  for (const rel of FORMER_CAPACITOR_FILES) {
    const full = join(ROOT, rel);
    if (existsSync(full)) {
      const h = sha256(readFileSync(full));
      map.set(rel, h);
      records.push(`${h}  ${rel}`);
    }
  }
  writeFileSync(HASH_LOG_PATH, records.join("\n") + "\n", "utf8");
  return map;
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

describe("UniView Branding Asset Replacement (P20)", () => {
  const formerHashes = recordFormerCapacitorHashesIfMissing();

  beforeAll(async () => {
    const { generateAll } = await import("../../scripts/generate-icons.mjs");
    await generateAll();
  });

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

  it("no current file matches any recorded Capacitor asset hash", () => {
    expect(formerHashes.size).toBeGreaterThan(0);
    for (const [rel, oldHash] of formerHashes.entries()) {
      const full = join(ROOT, rel);
      if (existsSync(full)) {
        const currentHash = sha256(readFileSync(full));
        expect(
          currentHash,
          `File ${rel} must not match old Capacitor hash ${oldHash}`
        ).not.toBe(oldHash);
      }
    }
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
