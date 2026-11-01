import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "../../src/ui/App";

let externalOpenCb: ((files: any[]) => void) | null = null;

const mockBridge = {
  kind: "capacitor" as const,
  remoteTransport: vi.fn(async () => ({ status: 200, body: new Uint8Array(0) })),
  canScanQr: false,
  pickFiles: vi.fn(async () => []),
  onExternalOpen: vi.fn((cb: (files: any[]) => void) => {
    externalOpenCb = cb;
    return () => {
      externalOpenCb = null;
    };
  }),
};

vi.mock("../../src/shells", () => ({
  getBridge: () => mockBridge,
}));

vi.mock("../../src/ui/TabView", () => ({
  TabView: () => null,
  default: () => null,
}));

vi.mock("../../src/ui/remote/PairDialog", () => ({
  PairDialog: ({ onClose }: { onClose?: () => void }) => (
    <div role="dialog">
      <button data-testid="mock-pair-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
  default: ({ onClose }: { onClose?: () => void }) => (
    <div role="dialog">
      <button data-testid="mock-pair-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

describe("Android back event handling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("verifies home unhandled, dismisses pairing dialog, and closes opened files with release", async () => {
    // The pairing dialog lost its UI entry points (phone features out of scope), so reach it the way the e2e harness does.
    (window as any).uniview = { e2eHooks: true };
    await act(async () => {
      root.render(<App />);
    });

    // 1. Verify home event unhandled
    const homeBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(homeBack);
    });
    expect(homeBack.defaultPrevented).toBe(false);

    // 2. Open the pairing dialog, then a back event dismisses it and prevents default
    act(() => {
      (window as any).__univiewSetPairing(true);
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    const dialogBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(dialogBack);
    });
    expect(dialogBack.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // 3. External open fake FileSource then back closes tab and calls release
    const fakeFile: any = {
      id: "fake-file-1",
      name: "document.pptx",
      size: 2048,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(async () => "blob:fake"),
      release: vi.fn(),
    };

    expect(externalOpenCb).not.toBeNull();
    act(() => {
      externalOpenCb!([fakeFile]);
    });

    const fileBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(fileBack);
    });
    expect(fileBack.defaultPrevented).toBe(true);
    expect(fakeFile.release).toHaveBeenCalled();

    // 4. Back on lone home tab, event is left unhandled again
    const finalBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(finalBack);
    });
    expect(finalBack.defaultPrevented).toBe(false);
    delete (window as any).uniview;
  });

  it("gives viewer first chance to handle back event before closing file tab", async () => {
    await act(async () => {
      root.render(<App />);
    });

    const fakeFile: any = {
      id: "fake-file-viewer-1",
      name: "presentation.pptx",
      size: 2048,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(async () => "blob:fake"),
      release: vi.fn(),
    };

    expect(externalOpenCb).not.toBeNull();
    act(() => {
      externalOpenCb!([fakeFile]);
    });

    const onViewerBack = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener("uniview:back:viewer", onViewerBack);

    const firstBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(firstBack);
    });
    expect(firstBack.defaultPrevented).toBe(true);
    expect(fakeFile.release).not.toHaveBeenCalled();

    window.removeEventListener("uniview:back:viewer", onViewerBack);

    const secondBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(secondBack);
    });
    expect(secondBack.defaultPrevented).toBe(true);
    expect(fakeFile.release).toHaveBeenCalled();
  });

  it("ensures viewer precedence does not depend on registration order", async () => {
    const onViewerBack = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener("uniview:back:viewer", onViewerBack);

    await act(async () => {
      root.render(<App />);
    });

    const fakeFile: any = {
      id: "fake-file-viewer-2",
      name: "presentation2.pptx",
      size: 2048,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(async () => "blob:fake"),
      release: vi.fn(),
    };

    expect(externalOpenCb).not.toBeNull();
    act(() => {
      externalOpenCb!([fakeFile]);
    });

    const firstBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(firstBack);
    });
    expect(firstBack.defaultPrevented).toBe(true);
    expect(fakeFile.release).not.toHaveBeenCalled();

    window.removeEventListener("uniview:back:viewer", onViewerBack);

    const secondBack = new Event("uniview:back", { cancelable: true });
    act(() => {
      window.dispatchEvent(secondBack);
    });
    expect(secondBack.defaultPrevented).toBe(true);
    expect(fakeFile.release).toHaveBeenCalled();
  });
});
