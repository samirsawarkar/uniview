// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("mobile config for remote browsing", () => {
  it("Android manifest configures permissions and network security config", () => {
    const manifest = readFileSync(join(process.cwd(), "android/app/src/main/AndroidManifest.xml"), "utf8");
    expect(manifest).toContain("android.permission.INTERNET");
    expect(manifest).toContain("android.permission.CAMERA");
    expect(manifest).not.toContain('tools:node="remove"');
    expect(manifest).toContain('networkSecurityConfig="@xml/network_security_config"');
  });

  it("Android network security config permits cleartext traffic", () => {
    const networkConfig = readFileSync(
      join(process.cwd(), "android/app/src/main/res/xml/network_security_config.xml"),
      "utf8",
    );
    expect(networkConfig).toContain('cleartextTrafficPermitted="true"');
  });

  it("Capacitor config disables CapacitorHttp plugin", () => {
    const capacitorConfig = readFileSync(join(process.cwd(), "capacitor.config.json"), "utf8");
    expect(JSON.parse(capacitorConfig).plugins.CapacitorHttp.enabled).toBe(false);
  });

  it("iOS Info.plist configures local networking and camera permissions without arbitrary loads", () => {
    const infoPlist = readFileSync(join(process.cwd(), "ios/App/App/Info.plist"), "utf8");
    expect(infoPlist).toContain("NSAllowsLocalNetworking");
    expect(infoPlist).toContain("NSLocalNetworkUsageDescription");
    expect(infoPlist).toContain("NSCameraUsageDescription");
    expect(infoPlist).not.toContain("NSAllowsArbitraryLoads");
  });
});
