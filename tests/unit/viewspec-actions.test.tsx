import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ViewSpecViewer from "../../src/viewers/ViewSpecViewer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ViewSpecViewer actions: Reload and Open as JSON", () => {
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
        root!.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  async function renderViewer(source: any, onFallback?: (kind: any) => void) {
    await act(async () => {
      root!.render(
        <ViewSpecViewer
          source={source}
          detection={{
            kind: "viewspec" as any,
            ext: "uview.json",
            by: "extension",
            label: "UniView view",
          }}
          onOpen={() => {}}
          onReady={() => {}}
          onFallback={onFallback}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  it("reads spec once on mount and updates only on clicking Reload", async () => {
    // Catches mutation where file edits auto-update without Reload or reload button is absent
    let title = "One";
    let readCount = 0;
    const source = {
      name: "test.uview.json",
      readAll: vi.fn(async () => {
        readCount++;
        return new TextEncoder().encode(
          JSON.stringify({ uniview: "view/1", title, body: [{ type: "heading", text: title }] })
        );
      }),
    };

    await renderViewer(source);

    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");
    expect(source.readAll).toHaveBeenCalledTimes(1);

    // Later change does not affect the view
    title = "Two";
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");
    expect(source.readAll).toHaveBeenCalledTimes(1);

    // Clicking Reload re-reads and shows "Two", readAll called exactly twice
    const reloadBtn = container?.querySelector<HTMLButtonElement>("button.vs-reload");
    expect(reloadBtn).toBeDefined();
    if (!reloadBtn) throw new Error("Reload button not found");

    await act(async () => {
      reloadBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container?.querySelector(".vs-title")?.textContent).toBe("Two");
    expect(source.readAll).toHaveBeenCalledTimes(2);
  });

  it("shows error view when Reload encounters invalid content", async () => {
    // Catches mutation where reload does not handle valid-to-invalid transitions
    let content: string = JSON.stringify({ uniview: "view/1", title: "One", body: [{ type: "heading", text: "One" }] });
    const source = {
      name: "test.uview.json",
      readAll: vi.fn(async () => new TextEncoder().encode(content)),
    };

    await renderViewer(source);
    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");

    content = "{ invalid json syntax";

    const reloadBtn = container?.querySelector<HTMLButtonElement>("button.vs-reload");
    expect(reloadBtn).toBeDefined();
    if (!reloadBtn) throw new Error("Reload button not found");

    await act(async () => {
      reloadBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container?.querySelector(".vs-title")).toBeNull();
    expect(container?.querySelector(".vs-error-view")).not.toBeNull();
    expect(container?.querySelector(".vs-error-list")).not.toBeNull();
  });

  it("calls onFallback once with 'json' when clicking Open as JSON in error view", async () => {
    // Catches mutation where Open as JSON button does not call onFallback with 'json'
    const source = {
      name: "invalid.uview.json",
      readAll: vi.fn(async () => new TextEncoder().encode("{ invalid: true ")),
    };
    const onFallback = vi.fn();

    await renderViewer(source, onFallback);

    expect(container?.querySelector(".vs-error-view")).not.toBeNull();

    const openJsonBtn =
      container?.querySelector<HTMLButtonElement>("button.vs-open-json") ??
      Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (b) => b.textContent?.includes("Open as JSON")
      );

    expect(openJsonBtn).toBeDefined();
    if (!openJsonBtn) throw new Error("Open as JSON button not found");

    await act(async () => {
      openJsonBtn.click();
    });

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("json");
  });

  it("does not render Open as JSON button when onFallback is absent", async () => {
    // Catches mutation where Open as JSON button is rendered even when onFallback is undefined
    const source = {
      name: "invalid.uview.json",
      readAll: vi.fn(async () => new TextEncoder().encode("{ invalid: true ")),
    };

    await renderViewer(source);

    expect(container?.querySelector(".vs-error-view")).not.toBeNull();

    const openJsonBtn =
      container?.querySelector<HTMLButtonElement>("button.vs-open-json") ??
      Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (b) => b.textContent?.includes("Open as JSON")
      );

    expect(openJsonBtn).toBeUndefined();
  });

  it("shows read error in error view when reload read fails", async () => {
    // Catches mutation where read error during reload crashes or does not show error view
    let shouldFail = false;
    const source = {
      name: "test.uview.json",
      readAll: vi.fn(async () => {
        if (shouldFail) {
          throw new Error("Disk read failure");
        }
        return new TextEncoder().encode(
          JSON.stringify({ uniview: "view/1", title: "One", body: [{ type: "heading", text: "One" }] })
        );
      }),
    };

    await renderViewer(source);
    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");

    shouldFail = true;
    const reloadBtn = container?.querySelector<HTMLButtonElement>("button.vs-reload");
    if (!reloadBtn) throw new Error("Reload button not found");

    await act(async () => {
      reloadBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container?.querySelector(".vs-error-view")).not.toBeNull();
    const errorList = container?.querySelector(".vs-error-list");
    expect(errorList?.textContent).toContain("Disk read failure");
  });
});
