import { describe, expect, it } from "vitest";
import { errorHeading } from "../../src/ui/remote/RemoteBrowser";

describe("errorHeading", () => {
  it("formats unreachable error heading", () => {
    expect(errorHeading("unreachable", "Desktop")).toBe("Can't reach Desktop");
  });

  it("formats unpaired error heading", () => {
    expect(errorHeading("unpaired", "Desktop")).toBe("Desktop no longer trusts this device");
  });

  it("formats unauthorized error heading", () => {
    expect(errorHeading("unauthorized", "Desktop")).toBe("Desktop no longer trusts this device");
  });

  it("formats other errors or undefined code as folder open failure", () => {
    expect(errorHeading("host", "Desktop")).toBe("Can't open this folder");
    expect(errorHeading(undefined, "Desktop")).toBe("Can't open this folder");
    expect(errorHeading("other", "Desktop")).toBe("Can't open this folder");
  });
});
