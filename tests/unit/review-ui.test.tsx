import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReviewTab from "../../src/viewers/ReviewTab";
import type { Receipt } from "../../shared/receipt.d.mts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSource(receipt: Receipt) {
  const json = JSON.stringify(receipt);
  const bytes = new TextEncoder().encode(json);
  return {
    id: "test-src-desktop",
    name: "task.receipt.json",
    path: "/test/task.receipt.json",
    size: bytes.byteLength,
    readAll: async () => bytes.buffer.slice(0),
    readRange: async (start: number, end: number) => bytes.buffer.slice(start, end),
    url: async () => "blob:test",
    release: () => {},
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const win = el.ownerDocument.defaultView ?? window;
  const proto = el.tagName.toLowerCase() === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (set) set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const sampleReceipt: Receipt = {
  uniview: "receipt/1",
  createdAt: "2026-10-24T12:00:00Z",
  agent: { name: "Desktop Agent", model: "model-x", run: "run-99" },
  task: "Implement new feature with security checks",
  summary: "Completed work successfully.\n\nReview [docs](https://example.org/spec) here.",
  files: [
    {
      path: "/workspace/src/feature.ts",
      relPath: "src/feature.ts",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      role: "modified",
    },
    {
      path: "/workspace/test/feature.test.ts",
      relPath: "test/feature.test.ts",
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      role: "created",
    },
  ],
  checks: [
    { name: "unit-tests", status: "pass", evidence: "All 12 tests passed" },
  ],
  sources: [
    { title: "Design Spec", ref: "https://specs.internal/p14" },
  ],
};

describe("ReviewTab (desktop)", () => {
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

  function createMockApi(overrides: Partial<any> = {}) {
    const files = sampleReceipt.files.map((f) => ({
      path: f.path,
      expectedSha256: f.sha256,
      observedSha256: f.sha256,
      state: "unchanged" as const,
    }));

    return {
      open: vi.fn(async () => ({
        ok: true,
        reviewId: "rev-12345678901234567890123456789012",
        receiptDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        receipt: sampleReceipt,
        files,
        verifiedAt: new Date().toISOString(),
      })),
      decide: vi.fn(async ({ decision, comment }: any) => ({
        ok: true,
        decision: {
          uniview: "decision/1" as const,
          reviewId: "rev-12345678901234567890123456789012",
          receiptDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          decision,
          comment: comment ?? "",
          decidedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          persisted: true,
          files,
        },
      })),
      dismiss: vi.fn(async () => ({
        ok: true,
        dismissed: true,
      })),
      refresh: vi.fn(async () => ({
        ok: true,
        files,
        verifiedAt: new Date().toISOString(),
      })),
      ...overrides,
    };
  }

  async function renderReview(api = createMockApi(), source = makeSource(sampleReceipt)) {
    await act(async () => {
      root!.render(<ReviewTab source={source} reviewApi={api} onReady={() => {}} />);
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  // Mutation caught: rendering receipt task/summary/files outside agent-content section
  it("(1) renders receipt strictly inside 'Content from the agent' region", async () => {
    const api = createMockApi();
    await renderReview(api);

    const agentRegion = container?.querySelector(".agent-content, [data-agent-content='true']");
    expect(agentRegion).not.toBeNull();
    expect(agentRegion?.textContent).toContain("Content from the agent");
    expect(agentRegion?.textContent).toContain("Implement new feature with security checks");
    expect(agentRegion?.textContent).toContain("src/feature.ts");
    expect(agentRegion?.textContent).toContain("unit-tests");
    expect(agentRegion?.textContent).toContain("Design Spec");

    // Outside agentRegion there must be NO task or file details
    const outerClone = container!.cloneNode(true) as HTMLElement;
    const innerInClone = outerClone.querySelector(".agent-content, [data-agent-content='true']");
    innerInClone?.remove();
    expect(outerClone.textContent).not.toContain("Implement new feature with security checks");
    expect(outerClone.textContent).not.toContain("Design Spec");
  });

  // Mutation caught: rendering Approve/Request changes buttons inside agent-content region
  it("(2) renders Approve, Request changes and comment box in UniView's bar OUTSIDE agent-content", async () => {
    const api = createMockApi();
    await renderReview(api);

    const bar = container?.querySelector(".uniview-bar, .review-bar, header[role='banner']");
    expect(bar).not.toBeNull();

    const approveBtn = bar?.querySelector("[data-testid='approve-btn'], .btn-approve");
    const requestChangesBtn = bar?.querySelector("[data-testid='request-changes-btn'], .btn-request-changes");
    const commentBox = bar?.querySelector("textarea, [data-testid='review-comment']");

    expect(approveBtn).not.toBeNull();
    expect(requestChangesBtn).not.toBeNull();
    expect(commentBox).not.toBeNull();

    // Verify they are NOT inside agent-content
    const agentRegion = container?.querySelector(".agent-content");
    expect(agentRegion?.querySelector("[data-testid='approve-btn'], .btn-approve")).toBeNull();
    expect(agentRegion?.querySelector("[data-testid='request-changes-btn'], .btn-request-changes")).toBeNull();
    expect(agentRegion?.querySelector("textarea, [data-testid='review-comment']")).toBeNull();
  });

  // Mutation caught: enabling decision buttons immediately without 500 ms delay
  it("(3) keeps buttons disabled for first 500 ms after shown", async () => {
    const api = createMockApi();
    await renderReview(api);

    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;
    const requestChangesBtn = container?.querySelector("[data-testid='request-changes-btn'], .btn-request-changes") as HTMLButtonElement;

    // Disabled initially
    expect(approveBtn.disabled).toBe(true);
    expect(requestChangesBtn.disabled).toBe(true);

    // Click at 300 ms does nothing
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(approveBtn.disabled).toBe(true);

    await act(async () => {
      approveBtn.click();
    });
    expect(api.decide).not.toHaveBeenCalled();

    // After 500 ms total, buttons are enabled
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(approveBtn.disabled).toBe(false);
    expect(requestChangesBtn.disabled).toBe(false);
  });

  // Mutation caught: allowing Enter key to trigger review decision
  it("(3) keyboard Enter on the tab does nothing (only deliberate pointer click decides)", async () => {
    const api = createMockApi();
    await renderReview(api);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const commentBox = container?.querySelector("textarea, [data-testid='review-comment']") as HTMLTextAreaElement;
    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;

    // Dispatch Enter keydown on comment box
    await act(async () => {
      commentBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(api.decide).not.toHaveBeenCalled();

    // Dispatch Enter keydown on approve button
    await act(async () => {
      approveBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(api.decide).not.toHaveBeenCalled();

    // Deliberate click decides
    await act(async () => {
      approveBtn.click();
    });
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ decision: "approved" }));
  });

  // Mutation caught: permitting comment > 8 KiB (8192 bytes)
  it("(4) comment limit 8 KiB UTF-8 accepts comment at limit (8192 bytes)", async () => {
    const api = createMockApi();
    await renderReview(api);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const commentBox = container?.querySelector("textarea, [data-testid='review-comment']") as HTMLTextAreaElement;
    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;

    // Exactly 8192 bytes (8 KiB)
    const valid8KiB = "a".repeat(8192);
    await act(async () => {
      setInputValue(commentBox, valid8KiB);
    });

    expect(approveBtn.disabled).toBe(false);
    await act(async () => {
      approveBtn.click();
    });
    expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ comment: valid8KiB }));
  });

  it("(4) comment limit 8 KiB UTF-8 rejects comment over limit (8193 bytes / limit + 1)", async () => {
    const api = createMockApi();
    await renderReview(api);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const commentBox = container?.querySelector("textarea, [data-testid='review-comment']") as HTMLTextAreaElement;
    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;

    const overLimit8193 = "a".repeat(8193);
    await act(async () => {
      setInputValue(commentBox, overLimit8193);
    });

    // Should be disabled or click blocked
    await act(async () => {
      approveBtn.click();
    });
    expect(api.decide).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("8 KiB");
  });

  // Mutation caught: ignoring click-time re-verification "changed" outcome
  it("(5) click-time re-verification 'changed' blocks decision and refreshes view with warning", async () => {
    const api = createMockApi({
      decide: vi.fn(async () => ({
        ok: false,
        code: "changed",
        message: "A file changed since you looked — review again",
        current: [
          {
            path: "/workspace/src/feature.ts",
            expectedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            observedSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            state: "changed",
          },
        ],
      })),
    });

    await renderReview(api);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
    });

    // Warning must be visible
    expect(container?.textContent).toContain("A file changed since you looked — review again");

    // Outcome is NOT decided; buttons are re-armed with 500 ms delay
    expect(approveBtn.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(approveBtn.disabled).toBe(false);
  });

  // Mutation caught: controls remain enabled after decision, or persisted:false error is missing
  it("(6) one decision per review: disables controls, shows outcome, and displays error if persisted:false", async () => {
    const api = createMockApi({
      decide: vi.fn(async ({ decision, comment }: any) => ({
        ok: true,
        decision: {
          uniview: "decision/1" as const,
          reviewId: "rev-12345678901234567890123456789012",
          receiptDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          decision,
          comment: comment ?? "",
          decidedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          persisted: false, // Write failed!
          files: [],
        },
      })),
    });

    await renderReview(api);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;
    const requestChangesBtn = container?.querySelector("[data-testid='request-changes-btn'], .btn-request-changes") as HTMLButtonElement;
    const commentBox = container?.querySelector("textarea, [data-testid='review-comment']") as HTMLTextAreaElement;

    await act(async () => {
      approveBtn.click();
    });

    // All controls disabled
    expect(approveBtn.disabled).toBe(true);
    expect(requestChangesBtn.disabled).toBe(true);
    expect(commentBox.disabled).toBe(true);

    // Outcome shown
    expect(container?.textContent?.toLowerCase()).toContain("approved");

    // persisted:false shown as visible error
    const errorEl = container?.querySelector("[data-testid='persist-error'], .review-persist-error, [role='alert']");
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("persisted: false");
  });

  // Mutation caught: closing tab without deciding fails to record dismissed
  it("(7) closing tab without deciding records dismissed", async () => {
    const api = createMockApi();
    await renderReview(api);

    // Tab is closed (unmounted) before deciding
    await act(async () => {
      root!.unmount();
      root = null;
    });

    expect(api.dismiss).toHaveBeenCalledTimes(1);
    expect(api.dismiss).toHaveBeenCalledWith("rev-12345678901234567890123456789012");
  });

  it("(7) closing tab AFTER deciding does NOT call dismiss", async () => {
    const api = createMockApi();
    await renderReview(api);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const approveBtn = container?.querySelector("[data-testid='approve-btn'], .btn-approve") as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
    });
    expect(api.decide).toHaveBeenCalledTimes(1);

    // Now unmount
    await act(async () => {
      root!.unmount();
      root = null;
    });

    expect(api.dismiss).not.toHaveBeenCalled();
  });
});
