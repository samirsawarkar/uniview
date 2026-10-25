import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TabView } from "../../src/ui/TabView";
import ReviewTab from "../../src/viewers/ReviewTab";
import { App } from "../../src/ui/App";
import { toSource, createElectronBridge } from "../../src/shells/electron";
import type { Detection, FileSource } from "../../src/core/types";
import type { Receipt } from "../../shared/receipt.d.mts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeViewSpecSource(name: string, title: string, headingText: string): FileSource {
  const spec = {
    uniview: "view/1",
    title,
    body: [
      { type: "heading", level: 2, text: headingText },
      { type: "markdown", text: "Some agent generated view body" },
    ],
  };
  const json = JSON.stringify(spec);
  const bytes = new TextEncoder().encode(json);
  return {
    id: `test-view-${Math.random().toString(36).slice(2)}`,
    name,
    size: bytes.byteLength,
    readAll: async () => bytes.buffer.slice(0),
    readRange: async (start, end) => bytes.buffer.slice(start, end),
    url: async () => "",
    release: () => {},
    reopen: async () => makeViewSpecSource(name, title, headingText),
  };
}

describe("Packet P17c-3: App wiring and agent renderer findings", () => {
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

  // 1 HIGH App.tsx:187 / TabView.tsx:32: agent views are named after the spec title; the stored `detection` never reaches TabView
  it("Finding 1: TabView honours passed detection so agent view titled 'Quarterly report' renders as view, not JSON", async () => {
    const source = makeViewSpecSource("Quarterly report", "Quarterly report", "Q3 Financial Performance");
    const detection: Detection = {
      kind: "viewspec",
      label: "View Spec",
      ext: ".viewspec.json",
      by: "container",
    };

    let detected: Detection | null = null;
    await act(async () => {
      root!.render(
        <TabView
          source={source}
          detection={detection}
          onDetected={(d) => {
            detected = d;
          }}
          onReady={() => {}}
          onOpen={() => {}}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // It should render as a view with the heading, NOT JSON viewer
    expect(container?.querySelector(".agent-content")).not.toBeNull();
    expect(container?.querySelector(".vs-title")?.textContent).toBe("Quarterly report");
    expect(container?.textContent).toContain("Q3 Financial Performance");
    expect(container?.querySelector(".json-viewer")).toBeNull();
    expect((detected as Detection | null)?.kind).toBe("viewspec");
  });

  // 2 HIGH electron.ts:163 / ViewSpecViewer.tsx:68: reopened agent source must be lightweight reference that does not own scope
  it("Finding 2: reopened agent source release() is a no-op for the scope; original remains readable across reloads", async () => {
    const closedScopes: string[] = [];
    const readRanges: Array<{ token: string; scopeId?: string }> = [];

    const mockApi = {
      readRange: vi.fn(async (token: string, _start: number, _end: number, scopeId?: string) => {
        readRanges.push({ token, scopeId });
        return new TextEncoder().encode("content").buffer;
      }),
      reopenAgent: vi.fn(async (scopeId: string, token: string) => ({
        token,
        name: "test.uview.json",
        path: "/test.uview.json",
        size: 7,
        scopeId,
      })),
      tabClosed: vi.fn((scopeId: string) => {
        closedScopes.push(scopeId);
      }),
    };

    const prevUniview = (window as any).uniview;
    (window as any).uniview = mockApi;
    try {
      const granted = {
        token: "tok-agent-1",
        name: "test.uview.json",
        path: "/test.uview.json",
        size: 7,
        scopeId: "scope-agent-123",
      };

      // 1. Initial source opened by agent
      const origSource = toSource(granted);
      expect(origSource.reopen).toBeDefined();

      // Original reads fine
      const bytes1 = await origSource.readAll();
      expect(bytes1.byteLength).toBe(7);

      // 2. First reload: calls reopen()
      const reload1 = await origSource.reopen!();
      expect(mockApi.reopenAgent).toHaveBeenCalledWith("scope-agent-123", "tok-agent-1");
      // ViewSpecViewer.tsx releases fresh source after reading
      reload1.release();

      // Crucial check: releasing reload1 MUST NOT have closed the scope!
      expect(mockApi.tabClosed).not.toHaveBeenCalled();
      expect(closedScopes).toHaveLength(0);

      // Original source is STILL readable
      const bytes2 = await origSource.readAll();
      expect(bytes2.byteLength).toBe(7);

      // 3. Second reload: calls reopen() again
      const reload2 = await origSource.reopen!();
      reload2.release();
      expect(mockApi.tabClosed).not.toHaveBeenCalled();

      // Original still readable
      const bytes3 = await origSource.readAll();
      expect(bytes3.byteLength).toBe(7);

      // 4. Closing the tab (releasing original source) DOES close the scope
      origSource.release();
      expect(mockApi.tabClosed).toHaveBeenCalledWith("scope-agent-123");
      expect(closedScopes).toEqual(["scope-agent-123"]);
    } finally {
      if (prevUniview) {
        (window as any).uniview = prevUniview;
      } else {
        delete (window as any).uniview;
      }
    }
  });

  // 3 HIGH ReviewTab.tsx:188/610: for an agent review the supplied receipt `view` (initialReview.view) is rendered with ViewSpec viewer
  it("Finding 3: ReviewTab renders agent review supplied view snapshot with ViewSpec viewer showing distinctive heading", async () => {
    const sampleReceipt: Receipt = {
      uniview: "receipt/1",
      createdAt: "2026-10-25T12:00:00Z",
      agent: { name: "AuditAgent", model: "audit-v1" },
      task: "Audit security boundaries",
      summary: "Security boundary checks completed.",
      files: [
        {
          path: "/workspace/config.json",
          relPath: "config.json",
          sha256: "3333333333333333333333333333333333333333333333333333333333333333",
          role: "modified",
        },
      ],
      view: "/workspace/audit-summary.uview.json",
    };

    const initialReview = {
      scopeId: "review-scope-999",
      reviewId: "rev-123",
      receipt: sampleReceipt,
      files: [
        {
          path: "/workspace/config.json",
          expectedSha256: "3333333333333333333333333333333333333333333333333333333333333333",
          observedSha256: "3333333333333333333333333333333333333333333333333333333333333333",
          state: "unchanged" as const,
        },
      ],
      view: {
        spec: {
          uniview: "view/1",
          title: "Audit Summary View",
          body: [
            { type: "heading", level: 2, text: "DISTINCTIVE_AUDIT_SNAPSHOT_HEADING" },
            { type: "markdown", text: "Security audit findings are documented below." },
          ],
        },
      },
    };

    const receiptJsonBytes = new TextEncoder().encode(JSON.stringify(sampleReceipt));
    const source: FileSource = {
      id: "agent-review-tab",
      name: "AuditAgent.receipt.json",
      size: receiptJsonBytes.byteLength,
      readAll: async () => receiptJsonBytes.buffer.slice(0),
      readRange: async (start, end) => receiptJsonBytes.buffer.slice(start, end),
      url: async () => "",
      release: () => {},
    };

    await act(async () => {
      root!.render(
        <ReviewTab
          source={source}
          active={true}
          initialReview={initialReview}
          onOpen={() => {}}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // The View section in the agent content area should contain the ViewSpec viewer
    // with the distinctive heading rendered!
    const viewSection = container?.querySelector(".receipt-view-section");
    expect(viewSection).not.toBeNull();
    expect(viewSection?.textContent).toContain("DISTINCTIVE_AUDIT_SNAPSHOT_HEADING");
    expect(viewSection?.querySelector(".vs-title")?.textContent).toBe("Audit Summary View");
  });

  // 5 MEDIUM preload.cjs:46 / electron.ts:182 / main.mjs:233: agent thumbnails pass scopeId
  it("Finding 5: electron bridge thumbnail passes scopeId for agent sources", async () => {
    let capturedArgs: any = null;
    const fakeApi = {
      thumbnail: vi.fn(async (token: string, size: number, scopeId?: string) => {
        capturedArgs = { token, size, scopeId };
        return new Uint8Array([1, 2, 3]);
      }),
    };
    const prevUniview = (window as any).uniview;
    (window as any).uniview = fakeApi;
    try {
      const bridge = createElectronBridge();

      // 1. Agent source with scopeId
      const agentFile = {
        token: "agent-token-xyz",
        name: "diagram.png",
        path: "/diagram.png",
        size: 500,
        scopeId: "scope-agent-thumb",
      };
      const agentSource = toSource(agentFile);

      const thumb = await bridge.thumbnail!(agentSource, 256);
      expect(thumb).not.toBeNull();
      expect(fakeApi.thumbnail).toHaveBeenCalledWith("agent-token-xyz", 256, "scope-agent-thumb");
      expect(capturedArgs).toEqual({
        token: "agent-token-xyz",
        size: 256,
        scopeId: "scope-agent-thumb",
      });

      // 2. User source without scopeId
      fakeApi.thumbnail.mockClear();
      const userFile = {
        token: "user-token-abc",
        name: "local.png",
        path: "/local.png",
        size: 500,
      };
      const userSource = toSource(userFile);
      await bridge.thumbnail!(userSource, 256);
      expect(fakeApi.thumbnail).toHaveBeenCalledWith("user-token-abc", 256, undefined);
    } finally {
      if (prevUniview) {
        (window as any).uniview = prevUniview;
      } else {
        delete (window as any).uniview;
      }
    }
  });

  // 7 MEDIUM App.tsx:57/257: openFiles stores scopeId on tabs and onAgentCloseTab matches it
  it("Finding 7: App stores scopeId on tabs and onAgentCloseTab matches scopeId", async () => {
    let agentShowViewCb: ((item: any) => void) | null = null;
    let agentCloseTabCb: ((scopeId: string) => void) | null = null;
    let externalOpenCb: ((files: any[]) => void) | null = null;

    const fakeElectron = {
      onAgentShowView: vi.fn((cb) => {
        agentShowViewCb = cb;
        return () => {};
      }),
      onAgentShowReview: vi.fn(() => () => {}),
      onAgentCloseTab: vi.fn((cb) => {
        agentCloseTabCb = cb;
        return () => {};
      }),
      onOpenFiles: vi.fn((cb) => {
        externalOpenCb = cb;
        return () => {};
      }),
      tabClosed: vi.fn(),
    };
    const prevUniview = (window as any).uniview;
    (window as any).uniview = fakeElectron;
    try {
      await act(async () => {
        root!.render(<App />);
      });

      // Open an agent file via external open (which calls openFiles)
      const agentGranted = {
        token: "tok-tab-test",
        name: "agent-doc.txt",
        path: "/agent-doc.txt",
        size: 50,
        scopeId: "scope-close-target",
      };

      // Call openFiles via external open listener
      await act(async () => {
        // Simulate external open callback in App
        externalOpenCb?.([agentGranted]);
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      // The tab should now be open
      const tabTitleBefore = container?.querySelector(".tab-title")?.textContent;
      expect(tabTitleBefore).toContain("agent-doc.txt");

      // Now trigger agent close tab by scopeId
      await act(async () => {
        agentCloseTabCb?.("scope-close-target");
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      // The tab should now be closed and replaced with home tab ("New tab")
      const tabTitleAfter = container?.querySelector(".tab-title")?.textContent;
      expect(tabTitleAfter).toBe("New tab");
      expect(fakeElectron.tabClosed).toHaveBeenCalledWith("scope-close-target");
    } finally {
      if (prevUniview) {
        (window as any).uniview = prevUniview;
      } else {
        delete (window as any).uniview;
      }
    }
  });
});
