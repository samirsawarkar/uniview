import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ViewSpecViewer from "../../src/viewers/ViewSpecViewer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshotSource(
  initialContent: string,
  getCurrentContent?: () => string,
  options?: {
    noReopen?: boolean;
    reopenReject?: Error;
    freshRelease?: () => void;
  }
) {
  const initialBytes = new TextEncoder().encode(initialContent);
  const source: any = {
    id: "source-1",
    name: "test.uview.json",
    size: initialBytes.byteLength,
    readAll: vi.fn(async () => {
      const copy = new Uint8Array(initialBytes);
      return copy.buffer;
    }),
    release: vi.fn(),
  };

  if (!options?.noReopen) {
    source.reopen = vi.fn(async () => {
      if (options?.reopenReject) {
        throw options.reopenReject;
      }
      const current = getCurrentContent ? getCurrentContent() : initialContent;
      const currentBytes = new TextEncoder().encode(current);
      const freshSource: any = {
        id: "source-fresh",
        name: "test.uview.json",
        size: currentBytes.byteLength,
        readAll: vi.fn(async () => {
          const copy = new Uint8Array(currentBytes);
          return copy.buffer;
        }),
        release: options?.freshRelease ? vi.fn(options.freshRelease) : vi.fn(),
      };
      return freshSource;
    });
  }

  return source;
}

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

  it("shows new title on Reload when file grew and releases fresh source", async () => {
    // Catches mutation: Reload re-reading original source snapshot instead of reopening, or failing to release fresh source
    let title = "One";
    const freshRelease = vi.fn();
    const source = makeSnapshotSource(
      JSON.stringify({ uniview: "view/1", title: "One", body: [{ type: "heading", text: "One" }] }),
      () => JSON.stringify({ uniview: "view/1", title, body: [{ type: "heading", text: title }] }),
      { freshRelease }
    );

    await renderViewer(source);

    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");
    expect(source.readAll).toHaveBeenCalledTimes(1);

    // Later change does not affect the view
    title = "A Much Longer Updated Title That Has Many More Bytes Than Before";
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");
    expect(source.readAll).toHaveBeenCalledTimes(1);

    // Clicking Reload re-opens and shows the longer title
    const reloadBtn = container?.querySelector<HTMLButtonElement>("button.vs-reload");
    expect(reloadBtn).toBeDefined();
    if (!reloadBtn) throw new Error("Reload button not found");

    await act(async () => {
      reloadBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container?.querySelector(".vs-title")?.textContent).toBe(
      "A Much Longer Updated Title That Has Many More Bytes Than Before"
    );
    expect(source.reopen).toHaveBeenCalledTimes(1);
    expect(freshRelease).toHaveBeenCalledTimes(1);
  });

  it("shows error view when Reload encounters invalid content", async () => {
    // Catches mutation where reload does not handle valid-to-invalid transitions
    let content: string = JSON.stringify({ uniview: "view/1", title: "One", body: [{ type: "heading", text: "One" }] });
    const source = makeSnapshotSource(content, () => content);

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

  it("does not render Reload button when source.reopen is absent", async () => {
    // Catches mutation: Reload button rendered when source.reopen is absent
    const source = makeSnapshotSource(
      JSON.stringify({ uniview: "view/1", title: "One", body: [{ type: "heading", text: "One" }] }),
      undefined,
      { noReopen: true }
    );

    await renderViewer(source);

    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");
    expect(container?.querySelector("button.vs-reload")).toBeNull();
  });

  it("does not render Reload button in error view when source.reopen is absent", async () => {
    // Catches mutation: Reload button rendered in error view when source.reopen is absent
    const source = makeSnapshotSource(
      "{ invalid: true ",
      undefined,
      { noReopen: true }
    );

    await renderViewer(source);

    expect(container?.querySelector(".vs-error-view")).not.toBeNull();
    expect(container?.querySelector("button.vs-reload")).toBeNull();
  });

  it("shows read_error in error view when reopen rejects", async () => {
    // Catches mutation: reopen rejection not showing error view with read_error
    const source = makeSnapshotSource(
      JSON.stringify({ uniview: "view/1", title: "One", body: [{ type: "heading", text: "One" }] }),
      undefined,
      { reopenReject: new Error("Disk read failure") }
    );

    await renderViewer(source);
    expect(container?.querySelector(".vs-title")?.textContent).toBe("One");

    const reloadBtn = container?.querySelector<HTMLButtonElement>("button.vs-reload");
    if (!reloadBtn) throw new Error("Reload button not found");

    await act(async () => {
      reloadBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container?.querySelector(".vs-title")).toBeNull();
    expect(container?.querySelector(".vs-error-view")).not.toBeNull();
    expect(container?.querySelector(".vs-err-code")?.textContent).toBe("read_error");
    const errorList = container?.querySelector(".vs-error-list");
    expect(errorList?.textContent).toContain("Disk read failure");
  });

  it("calls onFallback once with 'json' when clicking Open as JSON in error view", async () => {
    // Catches mutation where Open as JSON button does not call onFallback with 'json'
    const source = makeSnapshotSource("{ invalid: true ");
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
    const source = makeSnapshotSource("{ invalid: true ");

    await renderViewer(source);

    expect(container?.querySelector(".vs-error-view")).not.toBeNull();

    const openJsonBtn =
      container?.querySelector<HTMLButtonElement>("button.vs-open-json") ??
      Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (b) => b.textContent?.includes("Open as JSON")
      );

    expect(openJsonBtn).toBeUndefined();
  });
});
