import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const EXPECTED_EXTENSIONS = [
  "pdf", "docx", "docm", "dotx", "xlsx", "xlsm", "xlsb", "xls", "ods", "csv", "tsv",
  "pptx", "pptm", "ppsx", "potx", "epub", "md", "markdown", "png", "jpg", "jpeg",
  "gif", "webp", "bmp", "svg", "tif", "tiff", "avif", "ico", "mp4", "m4v", "mov",
  "webm", "mkv", "ogv", "mp3", "m4a", "aac", "wav", "ogg", "opus", "flac", "zip",
  "cbz", "json", "txt", "log", "ttf", "otf", "woff", "woff2",
];

describe("installer: Windows file associations in build/installer.nsh", () => {
  it("registers the exact list of file associations in both customInstall and customUnInstall", async () => {
    const nshPath = path.resolve(process.cwd(), "build", "installer.nsh");
    const content = await fs.readFile(nshPath, "utf-8");

    const installMatch = content.match(/!macro customInstall([\s\S]*?)!macroend/);
    expect(installMatch, "build/installer.nsh must contain customInstall macro").toBeTruthy();
    const installBody = installMatch![1]!;

    const uninstallMatch = content.match(/!macro customUnInstall([\s\S]*?)!macroend/);
    expect(uninstallMatch, "build/installer.nsh must contain customUnInstall macro").toBeTruthy();
    const uninstallBody = uninstallMatch![1]!;

    // Extract all extensions registered in FileAssociations capabilities
    const fileAssocRegex = /"Software\\UniView\\Capabilities\\FileAssociations"\s+"\.([a-zA-Z0-9]+)"/g;
    const installedFileAssocs = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fileAssocRegex.exec(installBody)) !== null) {
      installedFileAssocs.add(m[1]!.toLowerCase());
    }

    // Extract all extensions registered in OpenWithProgids
    const openWithInstallRegex = /"Software\\Classes\\\.([a-zA-Z0-9]+)\\OpenWithProgids"/g;
    const installedOpenWith = new Set<string>();
    while ((m = openWithInstallRegex.exec(installBody)) !== null) {
      installedOpenWith.add(m[1]!.toLowerCase());
    }

    // Extract all ProgID classes registered
    const progIdClassRegex = /"Software\\Classes\\UniView\.([a-zA-Z0-9]+)"/g;
    const installedProgIds = new Set<string>();
    while ((m = progIdClassRegex.exec(installBody)) !== null) {
      installedProgIds.add(m[1]!.toLowerCase());
    }

    // Extract all extensions cleaned up in uninstall OpenWithProgids
    const openWithUninstallRegex = /"Software\\Classes\\\.([a-zA-Z0-9]+)\\OpenWithProgids"/g;
    const uninstalledOpenWith = new Set<string>();
    while ((m = openWithUninstallRegex.exec(uninstallBody)) !== null) {
      uninstalledOpenWith.add(m[1]!.toLowerCase());
    }

    // Extract all ProgID classes deleted in uninstall
    const uninstalledProgIds = new Set<string>();
    while ((m = progIdClassRegex.exec(uninstallBody)) !== null) {
      uninstalledProgIds.add(m[1]!.toLowerCase());
    }

    expect(EXPECTED_EXTENSIONS.length).toBe(51);

    for (const ext of EXPECTED_EXTENSIONS) {
      expect(
        installedFileAssocs.has(ext),
        `Extension .${ext} must be registered in Capabilities\\FileAssociations in customInstall`
      ).toBe(true);

      expect(
        installedOpenWith.has(ext),
        `Extension .${ext} must be registered in OpenWithProgids in customInstall`
      ).toBe(true);

      expect(
        installedProgIds.has(ext),
        `Extension .${ext} must have ProgID class UniView.${ext} in customInstall`
      ).toBe(true);

      expect(
        uninstalledOpenWith.has(ext),
        `Extension .${ext} must be removed from OpenWithProgids in customUnInstall`
      ).toBe(true);

      expect(
        uninstalledProgIds.has(ext),
        `Extension .${ext} ProgID class UniView.${ext} must be deleted in customUnInstall`
      ).toBe(true);
    }
  });
});
