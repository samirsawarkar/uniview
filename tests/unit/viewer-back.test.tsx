// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerBack } from "../../src/viewers/common";
import PptxViewer from "../../src/viewers/PptxViewer";
import { blobSource } from "../../src/shells/sources";
import { makePptx } from "../../scripts/fixture-builders.mjs";
import type { Detection } from "../../src/core/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

if (typeof Element.prototype.requestFullscreen === "undefined") {
  Element.prototype.requestFullscreen = vi.fn().mockResolvedValue(undefined);
}

if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = vi.fn();
}

if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = vi.fn(() => "blob:mock-thumbnail");
  URL.revokeObjectURL = vi.fn();
}

function TestBackComponent({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  useViewerBack(enabled, onBack);
  return null;
}

describe("useViewerBack hook", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it("when disabled, does not prevent the event and does not call the handler", () => {
    const onBack = vi.fn();
    act(() => {
      root!.render(<TestBackComponent enabled={false} onBack={onBack} />);
    });

    const event = new CustomEvent("uniview:back:viewer", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("when enabled, prevents the event and calls handler once", () => {
    const onBack = vi.fn();
    act(() => {
      root!.render(<TestBackComponent enabled={true} onBack={onBack} />);
    });

    const event = new CustomEvent("uniview:back:viewer", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("with two mounted components where only second is enabled, only second runs", () => {
    const back1 = vi.fn();
    const back2 = vi.fn();
    act(() => {
      root!.render(
        <>
          <TestBackComponent enabled={false} onBack={back1} />
          <TestBackComponent enabled={true} onBack={back2} />
        </>,
      );
    });

    const event = new CustomEvent("uniview:back:viewer", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(back1).not.toHaveBeenCalled();
    expect(back2).toHaveBeenCalledTimes(1);
  });

  it("ignores an already-prevented event", () => {
    const onBack = vi.fn();
    act(() => {
      root!.render(<TestBackComponent enabled={true} onBack={onBack} />);
    });

    const event = new CustomEvent("uniview:back:viewer", { cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("PptxViewer responds to back events when active and presenting", async () => {
    const bytes = makePptx();
    const source = blobSource(new Blob([bytes as BlobPart]), "deck.pptx");
    const detection: Detection = {
      kind: "pptx",
      label: "PowerPoint",
      ext: "pptx",
      by: "content",
    };

    act(() => {
      root!.render(
        <PptxViewer
          source={source}
          detection={detection}
          onReady={() => {}}
          onOpen={() => {}}
          active={true}
        />,
      );
    });

    let presentBtn: HTMLButtonElement | undefined;
    for (let i = 0; i < 50; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const buttons = Array.from(container!.querySelectorAll("button"));
      presentBtn = buttons.find(
        (b) => b.textContent?.includes("Present") || b.getAttribute("title")?.includes("Present"),
      );
      if (presentBtn) break;
    }

    expect(presentBtn).toBeDefined();

    act(() => {
      presentBtn!.click();
    });

    act(() => {
      root!.render(
        <PptxViewer
          source={source}
          detection={detection}
          onReady={() => {}}
          onOpen={() => {}}
          active={false}
        />,
      );
    });

    const backEventInactive = new CustomEvent("uniview:back:viewer", { cancelable: true });
    window.dispatchEvent(backEventInactive);
    expect(backEventInactive.defaultPrevented).toBe(false);

    act(() => {
      root!.render(
        <PptxViewer
          source={source}
          detection={detection}
          onReady={() => {}}
          onOpen={() => {}}
          active={true}
        />,
      );
    });

    const backEventActive = new CustomEvent("uniview:back:viewer", { cancelable: true });
    act(() => {
      window.dispatchEvent(backEventActive);
    });
    expect(backEventActive.defaultPrevented).toBe(true);

    const subsequentBackEvent = new CustomEvent("uniview:back:viewer", { cancelable: true });
    window.dispatchEvent(subsequentBackEvent);
    expect(subsequentBackEvent.defaultPrevented).toBe(false);
  });
});
