// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceName } from "../../src/remote/store";

describe("deviceName", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("strips trailing Build/... from Android WebView model", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 11; RMX2002 Build/RP1A.200720.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36",
    );
    expect(deviceName()).toBe("realme RMX2002");
  });

  it("extracts clean model name when no Build/... is present", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    );
    expect(deviceName()).toBe("Pixel 8");
  });

  it("falls back to Android phone for reduced UA model K", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    );
    expect(deviceName()).toBe("Android phone");
  });

  it("cleans a name saved by an older build that still ends in Build/...", () => {
    localStorage.setItem("uniview.remote.deviceName.v1", "RMX2002 Build/RP1A.200720.011");
    expect(deviceName()).toBe("realme RMX2002");
    expect(localStorage.getItem("uniview.remote.deviceName.v1")).toBe("realme RMX2002");
  });

  it("keeps a name the user typed", () => {
    localStorage.setItem("uniview.remote.deviceName.v1", "Saurabh's phone 2.5");
    expect(deviceName()).toBe("Saurabh's phone 2.5");
  });

  it("prefers saved name in localStorage over user agent", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    );
    localStorage.setItem("uniview.remote.deviceName.v1", "Saved Tablet");
    expect(deviceName()).toBe("Saved Tablet");
  });
});
