import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App } from "../../src/ui/App";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockBridge = {
  kind: "capacitor" as const,
  remoteTransport: {} as any,
  onExternalOpen: vi.fn(() => () => {}),
};

vi.mock("../../src/shells", () => ({
  getBridge: () => mockBridge,
}));

vi.mock("../../src/ui/TabView", () => ({
  TabView: () => <div data-testid="tab-view" />,
}));

describe("Home UI", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders logo img, open-button and connect-computer before Recent heading in DOM order, and no share without share", async () => {
    // The Recent section only appears when there are recent files.
    localStorage.setItem("uniview.recents.v1", JSON.stringify([{ name: "notes.pdf", size: 10, openedAt: 1 }]));
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const logo = container.querySelector("img.logo");
    expect(logo).toBeTruthy();

    const openBtn = container.querySelector('[data-testid="open-button"]');
    const connectBtn = container.querySelector('[data-testid="connect-computer"]');
    expect(openBtn).toBeTruthy();
    expect(connectBtn).toBeTruthy();

    const shareBtn = container.querySelector('[data-testid="open-sharing"]');
    expect(shareBtn).toBeNull();

    const recentHeading = Array.from(container.querySelectorAll("h2")).find(
      (h) => h.textContent?.trim() === "Recent"
    );
    expect(recentHeading).toBeTruthy();

    const all = Array.from(container.querySelectorAll("*"));
    const openIdx = all.indexOf(openBtn!);
    const connectIdx = all.indexOf(connectBtn!);
    const recentIdx = all.indexOf(recentHeading!);
    expect(openIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeLessThan(recentIdx);
    expect(connectIdx).toBeLessThan(recentIdx);

    await act(async () => {
      root.unmount();
    });
  });

  it("clicking theme Dark radio sets data-theme='dark'", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const darkRadio = container.querySelector<HTMLButtonElement>('[data-testid="theme-dark"]');
    expect(darkRadio).toBeTruthy();

    await act(async () => {
      darkRadio!.click();
    });

    expect(document.documentElement.dataset.theme).toBe("dark");

    await act(async () => {
      root.unmount();
    });
  });

  it("with a second tab active, clicking home-button activates a home tab instead of opening another one", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const newTabBtn = container.querySelector<HTMLButtonElement>(".tab-new");
    expect(newTabBtn).toBeTruthy();

    await act(async () => {
      newTabBtn!.click();
    });

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);

    await act(async () => {
      (tabs[0] as HTMLElement).click();
    });

    const countBefore = container.querySelectorAll('[role="tab"]').length;
    const homeBtn = container.querySelector<HTMLButtonElement>('[data-testid="home-button"]');
    expect(homeBtn).toBeTruthy();

    await act(async () => {
      homeBtn!.click();
    });

    const countAfter = container.querySelectorAll('[role="tab"]').length;
    expect(countAfter).toBe(countBefore);

    await act(async () => {
      root.unmount();
    });
  });
});
