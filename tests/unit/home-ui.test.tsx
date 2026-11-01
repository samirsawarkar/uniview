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

  it("renders open-button and the AI agents row before the Recent heading, with no sharing and no theme choice on Home", async () => {
    // The Recent section only appears when there are recent files.
    localStorage.setItem("uniview.recents.v1", JSON.stringify([{ name: "notes.pdf", size: 10, openedAt: 1 }]));
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const openBtn = container.querySelector('[data-testid="open-button"]');
    const agentsRow = container.querySelector('[aria-label="AI agents"]');
    expect(openBtn).toBeTruthy();
    expect(agentsRow).toBeTruthy();

    const shareBtn = container.querySelector('[data-testid="open-sharing"]');
    expect(shareBtn).toBeNull();
    // Theme is chosen in the View > Theme menu, so Home must not show it.
    expect(container.querySelector('[data-testid^="theme-"]')).toBeNull();

    const recentHeading = Array.from(container.querySelectorAll("h2")).find(
      (h) => h.textContent?.trim() === "Recent"
    );
    expect(recentHeading).toBeTruthy();

    const all = Array.from(container.querySelectorAll("*"));
    const openIdx = all.indexOf(openBtn!);
    const agentsIdx = all.indexOf(agentsRow!);
    const recentIdx = all.indexOf(recentHeading!);
    expect(openIdx).toBeGreaterThan(-1);
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeLessThan(recentIdx);
    expect(agentsIdx).toBeLessThan(recentIdx);

    await act(async () => {
      root.unmount();
    });
  });

  it("applies the theme delivered by the View > Theme menu", async () => {
    const handlers: ((t: string) => void)[] = [];
    (window as any).uniview = {
      onTheme: (cb: (t: string) => void) => {
        handlers.push(cb);
        return () => {};
      },
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    expect(handlers.length).toBe(1);

    await act(async () => {
      handlers[0]!("dark");
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("uniview.theme.v1")).toBe("dark");

    delete (window as any).uniview;
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
    // Home is reached from the View-agnostic omnibox (Ctrl+L); the old always-visible home button is gone.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, cancelable: true }));
    });
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
