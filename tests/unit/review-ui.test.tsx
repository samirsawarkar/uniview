import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import ReviewTab from "../../src/viewers/ReviewTab";
import ReceiptViewer from "../../src/viewers/ReceiptViewer";
import { createElectronBridge } from "../../src/shells/electron";
import type { FileSource } from "../../src/core/types";
import type { Receipt } from "../../shared/receipt.d.mts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "ab12cd34".repeat(4);
const REVIEW_ID = "0123456789abcdef0123456789abcdef";

/**
 * A source made the way the desktop shell makes one: through the bridge, so it carries a grant token.
 * `remote` marks it as opened from a paired computer instead.
 */
async function makeSource(receipt: Receipt, opts: { remote?: boolean; token?: boolean } = {}): Promise<FileSource> {
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  (window as any).uniview = {
    openPath: async (p: string) => ({ token: TOKEN, name: "task.receipt.json", path: p, size: bytes.byteLength }),
    readRange: async (_t: string, s: number, e: number) => bytes.buffer.slice(s, e),
    share: {},
    remotePost: async () => ({ status: 200, body: new Uint8Array() }),
  };
  const granted = await createElectronBridge().openPath!("/test/task.receipt.json");
  if (opts.token === false) {
    // Same file, but a source that never came from a grant.
    const { readAll, readRange, url, release } = granted;
    return { id: "x", name: granted.name, size: granted.size, path: granted.path, readAll, readRange, url, release } as FileSource;
  }
  if (opts.remote) {
    granted.remote = { hostId: "host-1", rootId: "root-1", rootName: "Root", path: "task.receipt.json", mtime: 0 };
  }
  return granted;
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

function reactProps(el: Element): any {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!key) throw new Error("no React props on element");
  return (el as any)[key];
}

/**
 * jsdom never produces a trusted (isTrusted) event from script, so a real person's click is modelled by
 * calling the element's React onClick with the native-event fields a browser sets for a pointer click.
 * The component under test must act on exactly these fields.
 */
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
  checks: [{ name: "unit-tests", status: "pass", evidence: "All 12 tests passed" }],
  sources: [{ title: "Design Spec", ref: "https://specs.internal/p14" }],
};

const FILES = sampleReceipt.files.map((f) => ({
  path: f.path,
  expectedSha256: f.sha256,
  observedSha256: f.sha256,
  state: "unchanged" as const,
}));

function okDecision(decision: string, comment: string) {
  return {
    uniview: "decision/1" as const,
    reviewId: REVIEW_ID,
    receiptDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    decision,
    comment: comment ?? "",
    decidedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    persisted: true,
    files: FILES,
  };
}

function openResult(reviewId = REVIEW_ID) {
  return {
    ok: true,
    reviewId,
    receiptDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    receipt: sampleReceipt,
    files: FILES,
    verifiedAt: new Date().toISOString(),
  };
}

function createMockApi(overrides: Partial<any> = {}) {
  return {
    open: vi.fn(async (_args: any) => openResult()),
    decide: vi.fn(async ({ decision, comment }: any) => ({ ok: true, decision: okDecision(decision, comment) })),
    dismiss: vi.fn(async (_id: string) => ({ ok: true, dismissed: true })),
    refresh: vi.fn(async (_id: string) => ({ ok: true, files: FILES, verifiedAt: new Date().toISOString() })),
    ...overrides,
  };
}

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
    delete (window as any).uniview;
    vi.useRealTimers();
  });

  async function flush() {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function renderReview(api: any = createMockApi(), extra: Record<string, unknown> = {}) {
    const source = await makeSource(sampleReceipt);
    await act(async () => {
      root!.render(<ReviewTab source={source} reviewApi={api} onReady={() => {}} {...extra} />);
    });
    await flush();
    return source;
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const q = <T extends Element = HTMLElement>(sel: string) => container!.querySelector(sel) as T;
  const approve = () => q<HTMLButtonElement>("[data-testid='approve-btn']");
  const requestChanges = () => q<HTMLButtonElement>("[data-testid='request-changes-btn']");
  const commentBox = () => q<HTMLTextAreaElement>("[data-testid='review-comment']");
  const reloadBtn = () => q<HTMLButtonElement>(".receipt-reload-btn");

  // Mutation caught: rendering receipt task/summary/files outside agent-content section
  it("(1) renders receipt strictly inside 'Content from the agent' region", async () => {
    await renderReview();

    const agentRegion = container?.querySelector(".agent-content, [data-agent-content='true']");
    expect(agentRegion).not.toBeNull();
    expect(agentRegion?.textContent).toContain("Content from the agent");
    expect(agentRegion?.textContent).toContain("Implement new feature with security checks");
    expect(agentRegion?.textContent).toContain("src/feature.ts");
    expect(agentRegion?.textContent).toContain("unit-tests");
    expect(agentRegion?.textContent).toContain("Design Spec");

    const outerClone = container!.cloneNode(true) as HTMLElement;
    outerClone.querySelector(".agent-content, [data-agent-content='true']")?.remove();
    expect(outerClone.textContent).not.toContain("Implement new feature with security checks");
    expect(outerClone.textContent).not.toContain("Design Spec");
  });

  // Mutation caught: rendering Approve/Request changes buttons inside agent-content region
  it("(2) renders Approve, Request changes and comment box in UniView's bar OUTSIDE agent-content", async () => {
    await renderReview();

    const bar = q("[data-testid='review-bar']");
    expect(bar).not.toBeNull();
    expect(bar.querySelector("[data-testid='approve-btn']")).not.toBeNull();
    expect(bar.querySelector("[data-testid='request-changes-btn']")).not.toBeNull();
    expect(bar.querySelector("textarea")).not.toBeNull();

    const agentRegion = q(".agent-content");
    expect(agentRegion.querySelector("[data-testid='approve-btn'], .btn-approve")).toBeNull();
    expect(agentRegion.querySelector("[data-testid='request-changes-btn'], .btn-request-changes")).toBeNull();
    expect(agentRegion.querySelector("textarea")).toBeNull();
  });

  describe("F3: the bar is a real, fixed, themed bar outside the agent region", () => {
    // Mutation caught: bar rendered inside the agent region, or without the class the CSS styles
    it("the bar is not inside the agent region, is not a parent of it, and carries the sticky-bar classes", async () => {
      await renderReview();
      const bar = q("[data-testid='review-bar']");
      const region = q("[data-agent-content='true']");
      expect(bar.classList.contains("review-bar")).toBe(true);
      expect(bar.classList.contains("uniview-bar")).toBe(true);
      expect(region.contains(bar)).toBe(false);
      expect(bar.contains(region)).toBe(false);
      expect(bar.closest("[data-agent-content]")).toBeNull();
    });

    const css = fs.readFileSync(path.resolve(__dirname, "../../src/ui/app.css"), "utf8");
    const rule = (selector: RegExp) => {
      const m = new RegExp(`(^|\\n)\\s*${selector.source}\\s*\\{([^}]*)\\}`).exec(css);
      return m ? m[2] : null;
    };

    // Mutation caught: .review-bar loses position sticky/fixed (the bar scrolls away with the agent content)
    it("app.css makes .review-bar sticky at the top, above the content, with theme-variable colours", () => {
      const body = rule(/\.uniview-bar\.review-bar/);
      expect(body).not.toBeNull();
      expect(body).toMatch(/position:\s*(sticky|fixed)/);
      expect(body).toMatch(/top:\s*0/);
      expect(body).toMatch(/z-index:\s*\d+/);
      expect(body).toMatch(/background:\s*var\(--bg-2/);
      expect(body).toMatch(/color:\s*var\(--fg/);
    });

    it("app.css lays out the comment box and buttons, and has dark-mode and narrow-width rules", () => {
      for (const sel of [/\.review-action-row/, /\.review-comment-wrap/, /\.review-comment-box/, /\.review-buttons-wrap/]) {
        expect(rule(sel), String(sel)).not.toBeNull();
      }
      expect(rule(/\.review-action-row/)).toMatch(/display:\s*flex/);
      expect(rule(/\.review-comment-box/)).toMatch(/var\(--bg/);
      // dark and system themes
      for (const theme of ["dark", "system"]) {
        for (const decision of ["approved", "changes_requested"]) {
          expect(css).toContain(`:root[data-theme="${theme}"] .review-outcome-badge.decision-${decision}`);
        }
        expect(css).toContain(`:root[data-theme="${theme}"] .review-comment-limit-err`);
      }
      // narrow widths
      const narrow = /@media \(max-width: 640px\) \{[\s\S]*?\.review-buttons-wrap[\s\S]*?\n\}/.exec(css);
      expect(narrow).not.toBeNull();
    });
  });

  describe("F1: arming starts when the bar is on screen", () => {
    // Mutation caught: the 500 ms delay starts at mount instead of when the bar first renders
    it("a slow open (1.5 s) does not leave Approve enabled when the bar first appears", async () => {
      const api = createMockApi({
        open: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(openResult()), 1500))),
      });
      const source = await makeSource(sampleReceipt);
      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} />);
      });
      await advance(1400);
      expect(container?.querySelector("[data-testid='review-bar']")).toBeNull();

      await advance(100); // open resolves at 1500
      await flush();
      expect(q("[data-testid='review-bar']")).not.toBeNull();
      expect(approve().disabled).toBe(true);
      expect(requestChanges().disabled).toBe(true);

      // A pointer click that lands in the first instants of the bar is ignored, even calling the handler.
      await pointerClick(approve());
      expect(api.decide).not.toHaveBeenCalled();

      await advance(499);
      expect(approve().disabled).toBe(true);
      await advance(1);
      expect(approve().disabled).toBe(false);
      expect(requestChanges().disabled).toBe(false);
    });

    it("(3) keeps buttons disabled for first 500 ms after shown", async () => {
      const api = createMockApi();
      await renderReview(api);

      expect(approve().disabled).toBe(true);
      expect(requestChanges().disabled).toBe(true);

      await advance(300);
      expect(approve().disabled).toBe(true);
      await pointerClick(approve());
      expect(api.decide).not.toHaveBeenCalled();

      await advance(200);
      expect(approve().disabled).toBe(false);
      expect(requestChanges().disabled).toBe(false);
    });

    // Mutation caught: a refresh does not re-arm
    it("re-arms after every refresh, and stays disabled while the refresh is running", async () => {
      let finish!: () => void;
      const api = createMockApi({
        refresh: vi.fn(
          () =>
            new Promise((resolve) => {
              finish = () => resolve({ ok: true, files: FILES, verifiedAt: new Date().toISOString() });
            })
        ),
      });
      await renderReview(api);
      await advance(500);
      expect(approve().disabled).toBe(false);

      await act(async () => {
        reloadBtn().click();
      });
      expect(approve().disabled).toBe(true);
      await advance(2000); // a long refresh must not time the delay out
      expect(approve().disabled).toBe(true);

      await act(async () => {
        finish();
      });
      await flush();
      expect(approve().disabled).toBe(true); // the new state was only just shown
      await advance(499);
      expect(approve().disabled).toBe(true);
      await advance(1);
      expect(approve().disabled).toBe(false);
    });

    // Mutation caught: showing the tab again does not re-arm
    it("re-arms when the tab becomes visible again", async () => {
      const api = createMockApi();
      const source = await renderReview(api);
      await advance(500);
      expect(approve().disabled).toBe(false);

      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} active={false} />);
      });
      expect(approve().disabled).toBe(true);
      await advance(5000);
      expect(approve().disabled).toBe(true); // hidden tabs never arm

      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} active={true} />);
      });
      expect(approve().disabled).toBe(true);
      await advance(499);
      expect(approve().disabled).toBe(true);
      await advance(1);
      expect(approve().disabled).toBe(false);
      expect(api.open).toHaveBeenCalledTimes(1); // the review itself was not reopened
    });

    it("re-arms when the window comes back to the foreground", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);
      expect(approve().disabled).toBe(false);

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(approve().disabled).toBe(true);
      await advance(500);
      expect(approve().disabled).toBe(false);
    });
  });

  describe("F2: only a trusted, pointer-originated click decides", () => {
    // Mutation caught: handler acts on untrusted (script-dispatched) clicks
    it("a synthetic click on the Approve and Request changes buttons does nothing, even armed", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);
      expect(approve().disabled).toBe(false);

      await act(async () => {
        approve().click(); // jsdom: untrusted
        approve().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
        approve().dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, detail: 1, pointerType: "mouse" } as any));
        requestChanges().click();
        requestChanges().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      expect(api.decide).not.toHaveBeenCalled();
      expect(container?.textContent).not.toContain("Decision:");
    });

    // Mutation caught: a click from agent content (or the bar) reaches a decision
    it("synthetic clicks from the content area and the bar decide nothing", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);

      const everything = Array.from(container!.querySelectorAll("*")) as HTMLElement[];
      expect(everything.length).toBeGreaterThan(20);
      await act(async () => {
        for (const el of everything) {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, detail: 1 }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
        }
      });
      expect(api.decide).not.toHaveBeenCalled();
      expect(api.dismiss).not.toHaveBeenCalled();
    });

    // Mutation caught: handler acts on an untrusted event that merely claims to be trusted-looking
    it("an untrusted event with isTrusted false is ignored even with a pointer-like detail and pointerType", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);
      await pointerClick(approve(), { isTrusted: false });
      await pointerClick(approve(), { isTrusted: undefined });
      expect(api.decide).not.toHaveBeenCalled();
    });

    // Mutation caught: keyboard activation (Space/Enter on a focused button) decides
    it("keyboard activation (a trusted click with detail 0 and no pointerType) does nothing", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);
      await pointerClick(approve(), { detail: 0, pointerType: "" });
      await pointerClick(approve(), { detail: 0, pointerType: undefined });
      await pointerClick(requestChanges(), { detail: 0, pointerType: "" });
      expect(api.decide).not.toHaveBeenCalled();
    });

    it("Space and Enter on the buttons are swallowed (no default action)", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);
      for (const key of ["Enter", " "]) {
        for (const btn of [approve(), requestChanges()]) {
          const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
          const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
          await act(async () => {
            btn.dispatchEvent(down);
            btn.dispatchEvent(up);
          });
          expect(down.defaultPrevented).toBe(true);
          expect(up.defaultPrevented).toBe(true);
        }
      }
      expect(api.decide).not.toHaveBeenCalled();
    });

    // Mutation caught: trusted pointer click no longer decides (guard too strict)
    it("a trusted pointer click decides (mouse, touch and pen)", async () => {
      for (const init of [{ pointerType: "mouse" }, { pointerType: "touch" }, { pointerType: "pen", detail: 0 }, { pointerType: undefined, detail: 1 }]) {
        await act(async () => {
          root!.unmount();
        });
        root = createRoot(container!);
        const api = createMockApi();
        await renderReview(api);
        await advance(500);
        await pointerClick(approve(), init);
        expect(api.decide, JSON.stringify(init)).toHaveBeenCalledTimes(1);
      }
    });

    // Mutation caught: Enter blocked everywhere including the textarea, or not blocked on buttons/container
    it("(3) keyboard Enter on the tab does nothing (only a deliberate pointer click decides)", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);

      await act(async () => {
        approve().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      expect(api.decide).not.toHaveBeenCalled();

      await pointerClick(approve());
      expect(api.decide).toHaveBeenCalledTimes(1);
      expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ decision: "approved" }));
    });

    // Mutation caught: Enter blocked in the comment box (no multi-line comments)
    it("F8: Enter is blocked on buttons and the container but types a new line in the comment box", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);

      const inBox = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => {
        commentBox().dispatchEvent(inBox);
      });
      expect(inBox.defaultPrevented).toBe(false);

      for (const el of [approve(), requestChanges(), q("[data-testid='review-bar']"), q(".review-tab-container"), reloadBtn()]) {
        const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        await act(async () => {
          el.dispatchEvent(ev);
        });
        expect(ev.defaultPrevented).toBe(true);
      }

      // A multi-line comment can be typed and is sent as typed.
      await act(async () => {
        setInputValue(commentBox(), "line one\nline two");
      });
      expect(commentBox().value).toBe("line one\nline two");
      await pointerClick(approve());
      expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ comment: "line one\nline two" }));
      expect(api.decide).not.toHaveBeenCalledWith(expect.objectContaining({ reviewId: undefined }));
    });
  });

  // Mutation caught: permitting comment > 8 KiB (8192 bytes)
  it("(4) comment limit 8 KiB UTF-8 accepts comment at limit (8192 bytes)", async () => {
    const api = createMockApi();
    await renderReview(api);
    await advance(500);

    const valid8KiB = "a".repeat(8192);
    await act(async () => {
      setInputValue(commentBox(), valid8KiB);
    });

    expect(approve().disabled).toBe(false);
    await pointerClick(approve());
    expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ comment: valid8KiB }));
  });

  it("(4) comment limit 8 KiB UTF-8 rejects comment over limit (8193 bytes / limit + 1)", async () => {
    const api = createMockApi();
    await renderReview(api);
    await advance(500);

    await act(async () => {
      setInputValue(commentBox(), "a".repeat(8193));
    });

    expect(approve().disabled).toBe(true);
    await pointerClick(approve());
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
    await advance(500);

    await pointerClick(approve());

    expect(container?.textContent).toContain("A file changed since you looked — review again");
    expect(container?.textContent).toContain("changed");
    expect(approve().disabled).toBe(true);

    await advance(499);
    expect(approve().disabled).toBe(true);
    await advance(1);
    expect(approve().disabled).toBe(false);
  });

  // Mutation caught: controls remain enabled after decision, or persisted:false error is missing
  it("(6) one decision per review: disables controls, shows outcome, and displays error if persisted:false", async () => {
    const api = createMockApi({
      decide: vi.fn(async ({ decision, comment }: any) => ({
        ok: true,
        decision: { ...okDecision(decision, comment), persisted: false, files: [] },
      })),
    });

    await renderReview(api);
    await advance(500);

    const a = approve();
    const r = requestChanges();
    const c = commentBox();

    await pointerClick(a);

    expect(a.disabled).toBe(true);
    expect(r.disabled).toBe(true);
    expect(c.disabled).toBe(true);
    expect(container?.textContent?.toLowerCase()).toContain("approved");

    const errorEl = container?.querySelector("[data-testid='persist-error']");
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("persisted: false");

    await pointerClick(a);
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  describe("(7) tab closed means dismissed", () => {
    // Mutation caught: closing tab without deciding fails to record dismissed
    it("closing the tab without deciding records dismissed", async () => {
      const api = createMockApi();
      await renderReview(api);

      await act(async () => {
        root!.unmount();
        root = null;
      });

      expect(api.dismiss).toHaveBeenCalledTimes(1);
      expect(api.dismiss).toHaveBeenCalledWith(REVIEW_ID);
    });

    it("closing the tab AFTER deciding does NOT call dismiss", async () => {
      const api = createMockApi();
      await renderReview(api);
      await advance(500);

      await pointerClick(approve());
      expect(api.decide).toHaveBeenCalledTimes(1);

      await act(async () => {
        root!.unmount();
        root = null;
      });

      expect(api.dismiss).not.toHaveBeenCalled();
    });

    // Mutation caught: dismissal runs in the effect cleanup that depends on source/api
    it("F6: a new api object or re-render with the same source does not dismiss or reopen", async () => {
      const api = createMockApi();
      const source = await renderReview(api);
      const api2 = createMockApi();

      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api2 as any} onReady={() => {}} />);
      });
      await flush();
      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} onReady={() => {}} active={true} />);
      });
      await flush();

      expect(api.dismiss).not.toHaveBeenCalled();
      expect(api2.dismiss).not.toHaveBeenCalled();
      expect(api.open).toHaveBeenCalledTimes(1);
      expect(api2.open).not.toHaveBeenCalled();
      expect(approve()).not.toBeNull();
    });

    // Mutation caught: unmount during an in-flight decide sends dismiss
    it("F6: no dismiss while a decision is in flight; the recorded decision stays the only record", async () => {
      let finish!: (r: unknown) => void;
      const api = createMockApi({
        decide: vi.fn(() => new Promise((resolve) => (finish = resolve))),
      });
      await renderReview(api);
      await advance(500);

      await pointerClick(approve());
      expect(api.decide).toHaveBeenCalledTimes(1);

      await act(async () => {
        root!.unmount();
        root = null;
      });
      expect(api.dismiss).not.toHaveBeenCalled();

      await act(async () => {
        finish({ ok: true, decision: okDecision("approved", "") });
      });
      await flush();
      expect(api.dismiss).not.toHaveBeenCalled();
    });

    it("F6: if the in-flight decision turns out blocked after the tab closed, the review is dismissed then", async () => {
      let finish!: (r: unknown) => void;
      const api = createMockApi({
        decide: vi.fn(() => new Promise((resolve) => (finish = resolve))),
      });
      await renderReview(api);
      await advance(500);
      await pointerClick(approve());
      await act(async () => {
        root!.unmount();
        root = null;
      });
      expect(api.dismiss).not.toHaveBeenCalled();

      await act(async () => {
        finish({ ok: false, code: "changed", current: [] });
      });
      await flush();
      expect(api.dismiss).toHaveBeenCalledTimes(1);
      expect(api.dismiss).toHaveBeenCalledWith(REVIEW_ID);
    });

    // Mutation caught: a review whose open was superseded (strict-mode double mount, tab closed mid-open) hangs
    it("a review that finishes opening after the tab is already gone is dismissed", async () => {
      let finishOpen!: (r: unknown) => void;
      const api = createMockApi({ open: vi.fn(() => new Promise((resolve) => (finishOpen = resolve))) });
      const source = await makeSource(sampleReceipt);
      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} />);
      });
      await act(async () => {
        root!.unmount();
        root = null;
      });
      expect(api.dismiss).not.toHaveBeenCalled();
      await act(async () => {
        finishOpen(openResult());
      });
      await flush();
      expect(api.dismiss).toHaveBeenCalledWith(REVIEW_ID);
    });

    it("under StrictMode (double mount) only the superseded open is dismissed, not the live review", async () => {
      let n = 0;
      const ids = ["1".repeat(32), "2".repeat(32)];
      const api = createMockApi({ open: vi.fn(async () => openResult(ids[n++])) });
      const source = await makeSource(sampleReceipt);
      await act(async () => {
        root!.render(
          <React.StrictMode>
            <ReviewTab source={source} reviewApi={api as any} />
          </React.StrictMode>
        );
      });
      await flush();
      expect(api.open).toHaveBeenCalledTimes(2);
      expect(api.dismiss).toHaveBeenCalledTimes(1);
      expect(api.dismiss).toHaveBeenCalledWith(ids[0]);
      expect(approve()).not.toBeNull();
    });
  });

  describe("F4: the renderer names the receipt by grant token only", () => {
    // Mutation caught: renderer passes a path (or reads and ships the file itself)
    it("opens with exactly { receiptToken } and never reads the file or sends a path", async () => {
      const api = createMockApi();
      const source = await makeSource(sampleReceipt);
      const readAll = vi.spyOn(source, "readAll");
      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} />);
      });
      await flush();
      expect(api.open).toHaveBeenCalledTimes(1);
      expect((api.open.mock.calls[0] as any[])[0]).toEqual({ receiptToken: TOKEN });
      expect(readAll).not.toHaveBeenCalled();
    });

    it("a source without a grant token is not opened for review at all", async () => {
      const api = createMockApi();
      const source = await makeSource(sampleReceipt, { token: false });
      await act(async () => {
        root!.render(<ReviewTab source={source} reviewApi={api as any} />);
      });
      await flush();
      expect(api.open).not.toHaveBeenCalled();
      expect(container?.querySelector("[data-testid='approve-btn']")).toBeNull();
      expect(container?.textContent).toContain("could not be shown");
    });
  });

  describe("F9: load failures show field-level errors", () => {
    // Mutation caught: error rendered as [object Object]
    it("shows sanitised validation errors, never [object Object]", async () => {
      const api = createMockApi({
        open: vi.fn(async () => ({
          ok: false,
          code: "invalid_receipt",
          error: "This is not a valid review receipt",
          errors: [
            { code: "bad_path", path: "/files/0/path", message: "is not an acceptable path" },
            { code: "schema", path: "/summary‮evil\u0007", message: "does not match the receipt format" },
          ],
        })),
      });
      await renderReview(api);

      const text = container?.textContent ?? "";
      expect(text).toContain("could not be shown");
      expect(text).not.toContain("[object Object]");
      expect(text).toContain("bad_path");
      expect(text).toContain("/files/0/path");
      expect(text).toContain("is not an acceptable path");
      expect(text).toContain("/summary");
      expect(text).not.toContain("‮");
      expect(text).not.toContain("\u0007");
      expect(container?.querySelectorAll("li.receipt-error-item").length).toBe(2);
      expect(container?.querySelector("[data-testid='approve-btn']")).toBeNull();
    });

    it("shows a plain message when there are no field errors, and caps the list at 20", async () => {
      const api = createMockApi({ open: vi.fn(async () => ({ ok: false, code: "unreadable", error: "The receipt could not be read" })) });
      await renderReview(api);
      expect(container?.textContent).toContain("The receipt could not be read");

      await act(async () => {
        root!.unmount();
      });
      root = createRoot(container!);
      const many = Array.from({ length: 50 }, (_, i) => ({ code: "schema", path: `/p${i}`, message: "does not match the receipt format" }));
      await renderReview(createMockApi({ open: vi.fn(async () => ({ ok: false, code: "invalid_receipt", errors: many })) }));
      expect(container?.querySelectorAll("li.receipt-error-item").length).toBe(20);
    });
  });
});

describe("ReceiptViewer on desktop (F7, F10)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as any).uniview;
  });

  const detection: any = { kind: "receipt", confidence: 1 };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  const renderViewer = async (source: FileSource, api?: any) => {
    await act(async () => {
      root.render(<ReceiptViewer source={source} detection={detection} onReady={() => {}} onOpen={() => {}} reviewApi={api} lanReader={null} />);
    });
    await settle();
  };

  // Mutation caught: ReviewTab used for every desktop receipt, even from a paired computer
  it("F10: a receipt opened from a local grant gets the Review tab", async () => {
    const api = createMockApi();
    await renderViewer(await makeSource(sampleReceipt), api);
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='review-bar']")).not.toBeNull();
    expect(container.querySelector("[data-testid='approve-btn']")).not.toBeNull();
  });

  it("F10: a receipt from a paired computer is read-only, with a message that it came from another device", async () => {
    const api = createMockApi();
    await renderViewer(await makeSource(sampleReceipt, { remote: true }), api);
    expect(api.open).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='review-bar']")).toBeNull();
    expect(container.querySelector("[data-testid='approve-btn']")).toBeNull();
    expect(container.querySelector("[data-testid='request-changes-btn']")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    const note = container.querySelector("[data-testid='decide-elsewhere']");
    expect(note?.textContent).toContain("another device");
    expect(container.textContent).toContain("Implement new feature with security checks");
  });

  it("F10: a desktop source with no grant is read-only too", async () => {
    const api = createMockApi();
    await renderViewer(await makeSource(sampleReceipt, { token: false }), api);
    expect(api.open).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='approve-btn']")).toBeNull();
    expect(container.textContent).toContain("Decide on your computer");
  });

  // Mutation caught: early return before hooks (hooks-order violation)
  it("F7: toggling the review api prop (and the source kind) back and forth does not throw", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    try {
      const local = await makeSource(sampleReceipt);
      const remote = await makeSource(sampleReceipt, { remote: true });
      const api = createMockApi();
      await renderViewer(local, api);
      expect(container.querySelector("[data-testid='review-bar']")).not.toBeNull();
      await renderViewer(local, undefined); // no api, no window.uniview.review: read-only
      expect(container.querySelector("[data-testid='review-bar']")).toBeNull();
      expect(container.textContent).toContain("Implement new feature with security checks");
      await renderViewer(local, api);
      expect(container.querySelector("[data-testid='review-bar']")).not.toBeNull();
      await renderViewer(remote, api);
      expect(container.querySelector("[data-testid='review-bar']")).toBeNull();
      await renderViewer(local, api);
      expect(container.querySelector("[data-testid='review-bar']")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((e) => /hook|Rendered (fewer|more)/i.test(JSON.stringify(e, (_k, v) => (v instanceof Error ? v.message : v))))).toEqual([]);
  });
});
