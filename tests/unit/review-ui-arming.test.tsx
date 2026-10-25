import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReviewTab from "../../src/viewers/ReviewTab";
import type { FileSource } from "../../src/core/types";
import type { Receipt } from "../../shared/receipt.d.mts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "ab12cd34".repeat(4);
const REVIEW_ID = "0123456789abcdef0123456789abcdef";

function reactProps(el: Element): any {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!key) throw new Error("no React props on element");
  return (el as any)[key];
}

async function pointerClick(el: Element, nativeEvent: Record<string, unknown> = {}) {
  await act(async () => {
    reactProps(el).onClick({
      nativeEvent: { isTrusted: true, detail: 1, pointerType: "mouse", ...nativeEvent },
      preventDefault() {},
      stopPropagation() {},
    });
  });
}

const sampleReceipt: Receipt = {
  uniview: "receipt/1",
  createdAt: "2026-10-24T12:00:00Z",
  agent: { name: "Agent", model: "model-x" },
  task: "Task",
  summary: "Summary",
  files: [
    {
      path: "/workspace/src/feature.ts",
      relPath: "src/feature.ts",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      role: "modified",
    },
  ],
};

const INITIAL_FILES = sampleReceipt.files.map((f) => ({
  path: f.path,
  expectedSha256: f.sha256,
  observedSha256: f.sha256,
  state: "unchanged" as const,
}));

function makeSource(): FileSource {
  const bytes = new TextEncoder().encode(JSON.stringify(sampleReceipt));
  return {
    id: "src-1",
    name: "task.receipt.json",
    size: bytes.byteLength,
    path: "/test/task.receipt.json",
    readAll: async () => bytes.buffer.slice(0),
    readRange: async (s, e) => bytes.buffer.slice(s, e),
    url: async () => "",
    release: () => {},
  };
}

describe("ReviewTab initial verification arming", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  async function flush() {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const q = <T extends Element = HTMLElement>(sel: string) => container!.querySelector(sel) as T;
  const approve = () => q<HTMLButtonElement>("[data-testid='approve-btn']");
  const requestChanges = () => q<HTMLButtonElement>("[data-testid='request-changes-btn']");

  // Mutation caught: arming controls at 500 ms while initial verification is still in flight,
  // or failing to re-arm (reset armEpoch / arming delay) when initial refresh results are displayed.
  it("keeps controls disabled while initial verification is in flight (> 500 ms) and re-arms when results display", async () => {
    let resolveRefresh: ((res: any) => void) | null = null;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    const mockApi = {
      open: vi.fn(),
      decide: vi.fn(async () => ({ ok: true, decision: { persisted: true } })),
      dismiss: vi.fn(async () => ({ ok: true })),
      refresh: vi.fn(() => refreshPromise),
    };

    const initialReview = {
      reviewId: REVIEW_ID,
      receipt: sampleReceipt,
      files: INITIAL_FILES,
    };

    const source = makeSource();

    await act(async () => {
      root!.render(<ReviewTab source={source} reviewApi={mockApi as any} initialReview={initialReview} />);
    });
    await flush();

    expect(approve()).not.toBeNull();
    expect(approve().disabled).toBe(true);

    // Advance 550 ms (> 500 ms standard arming delay).
    // Initial verification is STILL IN FLIGHT. Controls must stay disabled!
    await advance(550);
    expect(approve().disabled).toBe(true);
    expect(requestChanges().disabled).toBe(true);

    // Click attempted while in flight must be ignored
    await pointerClick(approve());
    expect(mockApi.decide).not.toHaveBeenCalled();

    // Now initial verification settles at t = 600 ms with refreshed file results
    const refreshedFiles = [
      {
        path: sampleReceipt.files[0]!.path,
        expectedSha256: sampleReceipt.files[0]!.sha256,
        observedSha256: sampleReceipt.files[0]!.sha256,
        state: "unchanged" as const,
      },
    ];

    await act(async () => {
      resolveRefresh!({
        ok: true,
        files: refreshedFiles,
        verifiedAt: new Date().toISOString(),
      });
    });
    await flush();

    // Results are now displayed, but arming must have restarted!
    // The button must NOT be armed immediately.
    expect(approve().disabled).toBe(true);
    expect(requestChanges().disabled).toBe(true);

    // Attempting click right as results display is blocked
    await pointerClick(approve());
    expect(mockApi.decide).not.toHaveBeenCalled();

    // Advance 250 ms (half of the 500 ms re-arming delay)
    await advance(250);
    expect(approve().disabled).toBe(true);

    // Advance remaining 250 ms (total 500 ms after results were displayed)
    await advance(250);
    expect(approve().disabled).toBe(false);
    expect(requestChanges().disabled).toBe(false);

    // Now a deliberate click succeeds
    await pointerClick(approve());
    expect(mockApi.decide).toHaveBeenCalledTimes(1);
  });
});
