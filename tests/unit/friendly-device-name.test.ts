import { describe, expect, it } from "vitest";
import { cleanSavedName, friendlyDeviceName } from "../../shared/device-name.mjs";

describe("friendlyDeviceName", () => {
  it.each([
    ["RMX2002 Build/RP1A.200720.011", "realme RMX2002"],
    ["RMX2002 Build/RP1A.200720.011; wv", "realme RMX2002"],
    ["RMX2002 Build/RP1A.200720.011 wv", "realme RMX2002"],
    ["SM-G991B Build/TP1A.220624.014", "Samsung SM-G991B"],
    ["Pixel 8 Build/AP1A.240305.019", "Pixel 8"],
    ["Pixel 8", "Pixel 8"],
    ["Pixel 8 wv", "Pixel 8"],
    ["Moto G Power 11.0.2", "Moto G Power"],
    ["realme RMX2002", "realme RMX2002"],
    ["K", ""],
    ["Android 11", ""],
    ["", ""],
  ])("%s -> %s", (raw, want) => {
    expect(friendlyDeviceName(raw)).toBe(want);
  });
});

describe("cleanSavedName", () => {
  it("drops the build token from names saved by older builds", () => {
    expect(cleanSavedName("RMX2002 Build/RP1A.200720.011")).toBe("realme RMX2002");
  });
  it("leaves names a person typed alone", () => {
    expect(cleanSavedName("Saurabh's phone 2.5")).toBe("Saurabh's phone 2.5");
    expect(cleanSavedName("Pixel 8 wv")).toBe("Pixel 8 wv");
  });
});
