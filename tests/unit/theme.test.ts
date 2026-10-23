import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTheme, setTheme, applyTheme } from "../../src/ui/theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to light", () => {
    expect(getTheme()).toBe("light");
  });

  it("returns stored dark when dark is saved", () => {
    localStorage.setItem("uniview.theme.v1", "dark");
    expect(getTheme()).toBe("dark");
  });

  it("returns light on garbage value", () => {
    localStorage.setItem("uniview.theme.v1", "garbage-theme");
    expect(getTheme()).toBe("light");
  });

  it("setTheme persists and sets document.documentElement.dataset.theme", () => {
    setTheme("dark");
    expect(localStorage.getItem("uniview.theme.v1")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    setTheme("system");
    expect(localStorage.getItem("uniview.theme.v1")).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("returns light without throwing when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage access denied");
    });
    expect(() => getTheme()).not.toThrow();
    expect(getTheme()).toBe("light");
  });
});
