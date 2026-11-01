import { describe, it, expect } from "vitest";
import {
  isNewWindowShortcut,
  hasOtherLiveWindows,
  shouldStopAppAgentsOnRenderProcessGone,
} from "../../electron/lib/window-lifecycle.mjs";

describe("window-lifecycle: isNewWindowShortcut", () => {
  it("matches Ctrl+N keydown on Windows and Linux", () => {
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: true, meta: false, shift: false, alt: false, isAutoRepeat: false },
        "win32"
      )
    ).toBe(true);

    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: true, meta: false, shift: false, alt: false, isAutoRepeat: false },
        "linux"
      )
    ).toBe(true);
  });

  it("matches uppercase key 'N' and code 'KeyN'", () => {
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "N", control: true, meta: false, shift: false, alt: false },
        "win32"
      )
    ).toBe(true);

    expect(
      isNewWindowShortcut(
        { type: "keyDown", code: "KeyN", control: true, meta: false },
        "win32"
      )
    ).toBe(true);
  });

  it("rejects keyUp and autoRepeat events", () => {
    expect(
      isNewWindowShortcut(
        { type: "keyUp", key: "n", control: true, meta: false },
        "win32"
      )
    ).toBe(false);

    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: true, meta: false, isAutoRepeat: true },
        "win32"
      )
    ).toBe(false);
  });

  it("rejects when shift or alt are pressed", () => {
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: true, meta: false, shift: true },
        "win32"
      )
    ).toBe(false);

    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: true, meta: false, alt: true },
        "win32"
      )
    ).toBe(false);
  });

  it("rejects non-control modifiers and other keys on Windows/Linux", () => {
    // Control missing
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: false, meta: false },
        "win32"
      )
    ).toBe(false);

    // Win key instead of control
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", control: false, meta: true },
        "win32"
      )
    ).toBe(false);

    // Other keys
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "t", control: true, meta: false },
        "win32"
      )
    ).toBe(false);

    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "o", control: true, meta: false },
        "win32"
      )
    ).toBe(false);
  });

  it("matches Cmd+N and rejects Ctrl+N on macOS (darwin)", () => {
    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", meta: true, control: false, shift: false, alt: false },
        "darwin"
      )
    ).toBe(true);

    expect(
      isNewWindowShortcut(
        { type: "keyDown", key: "n", meta: false, control: true, shift: false, alt: false },
        "darwin"
      )
    ).toBe(false);
  });

  it("safely handles null, undefined, or malformed input", () => {
    expect(isNewWindowShortcut(null)).toBe(false);
    expect(isNewWindowShortcut(undefined)).toBe(false);
    expect(isNewWindowShortcut({})).toBe(false);
    expect(isNewWindowShortcut("not-an-object")).toBe(false);
  });
});

describe("window-lifecycle: hasOtherLiveWindows & shouldStopAppAgentsOnRenderProcessGone", () => {
  it("returns false / should stop when allWindows is empty or invalid", () => {
    expect(hasOtherLiveWindows([])).toBe(false);
    expect(hasOtherLiveWindows(null as any)).toBe(false);
    expect(shouldStopAppAgentsOnRenderProcessGone([], null)).toBe(true);
  });

  it("returns false / should stop when only currentWindow is present", () => {
    const win1 = { isDestroyed: () => false };
    expect(hasOtherLiveWindows([win1], win1)).toBe(false);
    expect(shouldStopAppAgentsOnRenderProcessGone([win1], win1)).toBe(true);
  });

  it("returns false / should stop when other windows are destroyed", () => {
    const win1 = { isDestroyed: () => false };
    const win2 = { isDestroyed: () => true };
    const win3 = { isDestroyed: () => true };
    expect(hasOtherLiveWindows([win1, win2, win3], win1)).toBe(false);
    expect(shouldStopAppAgentsOnRenderProcessGone([win1, win2, win3], win1)).toBe(true);
  });

  it("returns true / should not stop when another live window remains", () => {
    const win1 = { isDestroyed: () => false };
    const win2 = { isDestroyed: () => false };
    expect(hasOtherLiveWindows([win1, win2], win1)).toBe(true);
    expect(shouldStopAppAgentsOnRenderProcessGone([win1, win2], win1)).toBe(false);
  });

  it("safely handles null/undefined entries in the windows list", () => {
    const win1 = { isDestroyed: () => false };
    expect(hasOtherLiveWindows([win1, null, undefined], win1)).toBe(false);
    expect(shouldStopAppAgentsOnRenderProcessGone([win1, null, undefined], win1)).toBe(true);
  });
});
