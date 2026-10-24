import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReceiptViewer from "../../src/viewers/ReceiptViewer";
import type { Receipt } from "../../shared/receipt.d.mts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSource(data: string | object, size?: number, remote?: any) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const bytes = new TextEncoder().encode(text);
  return {
    id: "test-src",
    name: "task.receipt.json",
    size: size ?? bytes.byteLength,
    readAll: async () => bytes.buffer.slice(0),
    readRange: async (start: number, end: number) => bytes.buffer.slice(start, end),
    url: async () => "blob:test",
    release: () => {},
    remote,
  };
}

const sampleReceipt: Receipt = {
  uniview: "receipt/1",
  createdAt: "2026-10-24T12:00:00Z",
  agent: { name: "Codex Agent", model: "model-1", run: "run-42" },
  task: "Optimize image compression pipeline",
  summary: "Refactored the compressor.\n\nSee [details](https://example.org/plan) for notes.",
  files: [
    {
      path: "/workspace/src/compress.ts",
      relPath: "src/compress.ts",
      sha256: "1111111111111111111111111111111111111111111111111111111111111111",
      role: "modified",
    },
    {
      path: "/workspace/assets/icon.png",
      relPath: "assets/icon.png",
      sha256: "2222222222222222222222222222222222222222222222222222222222222222",
      role: "created",
    },
  ],
  checks: [
    { name: "test-suite", status: "pass", evidence: "All 10 tests passed" },
    { name: "lint", status: "fail", evidence: "Found 1 warning" },
  ],
  sources: [
    { title: "RFC 1951", ref: "https://www.ietf.org/rfc/rfc1951.txt" },
  ],
};

describe("ReceiptViewer for phone and web", () => {
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

  async function renderAndWait(source: any, props: Partial<React.ComponentProps<typeof ReceiptViewer>> = {}) {
    let ready = false;
    await act(async () => {
      root!.render(
        <ReceiptViewer
          source={source}
          detection={{ kind: "receipt" as any, ext: "receipt.json", by: "extension", label: "Review receipt" }}
          onOpen={() => {}}
          onReady={() => {
            ready = true;
          }}
          {...props}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    return ready;
  }

  it("renders a fixed UniView bar saying 'Decide on your computer'", async () => {
    // Mutation: missing or misworded fixed UniView bar on phone/web
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const bar = container?.querySelector(".uniview-bar, .receipt-bar, header[role='banner']");
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("Decide on your computer");
  });

  it("has NO decision buttons (no Approve or Request Changes)", async () => {
    // Mutation: rendering desktop Approve / Request changes buttons on phone/web
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    const buttonTexts = buttons.map((b) => b.textContent?.trim().toLowerCase());
    expect(buttonTexts).not.toContain("approve");
    expect(buttonTexts).not.toContain("request changes");
    expect(buttonTexts).not.toContain("dismiss");
  });

  it("renders receipt task and summary inside clearly marked 'Content from the agent' region", async () => {
    // Mutation: rendering agent content without the distinct 'Content from the agent' marker
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const agentContent = container?.querySelector(".agent-content, [data-agent-content='true'], section[aria-label*='agent']");
    expect(agentContent).not.toBeNull();
    expect(agentContent?.textContent).toContain("Content from the agent");
    expect(agentContent?.textContent).toContain("Optimize image compression pipeline");
  });

  it("renders summary using restricted Markdown (no <a> tags, URLs as text)", async () => {
    // Mutation: using unrestricted markdown renderer that emits raw <a> tags
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const agentContent = container?.querySelector(".agent-content");
    expect(agentContent).not.toBeNull();
    const links = agentContent?.querySelectorAll("a");
    expect(links?.length ?? 0).toBe(0);

    const urls = agentContent?.querySelectorAll(".agent-url");
    expect(urls?.length).toBeGreaterThan(0);
    expect(urls?.[0]?.textContent).toBe("https://example.org/plan");
  });

  it("shows receipt files with roles and verification states", async () => {
    // Mutation: omitting receipt files list or role badges
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const text = container?.textContent ?? "";
    expect(text).toContain("src/compress.ts");
    expect(text).toContain("assets/icon.png");
    expect(text).toContain("modified");
    expect(text).toContain("created");
  });

  it("shows receipt checks with their status and evidence", async () => {
    // Mutation: omitting receipt checks list or evidence details
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const text = container?.textContent ?? "";
    expect(text).toContain("test-suite");
    expect(text).toContain("pass");
    expect(text).toContain("All 10 tests passed");
    expect(text).toContain("lint");
    expect(text).toContain("fail");
  });

  it("shows receipt sources with title and ref", async () => {
    // Mutation: omitting sources section
    const source = makeSource(sampleReceipt);
    await renderAndWait(source);

    const text = container?.textContent ?? "";
    expect(text).toContain("RFC 1951");
    expect(text).toContain("https://www.ietf.org/rfc/rfc1951.txt");
  });

  it("rejects receipt file > 2 MiB with error view", async () => {
    // Mutation: allowing oversized receipt files > 2 MiB to be processed
    const hugeSize = 2 * 1024 * 1024 + 1; // 2 MiB + 1
    const source = makeSource(sampleReceipt, hugeSize);
    await renderAndWait(source);

    const errorView = container?.querySelector(".vs-error-view, .receipt-error-view, [role='alert']");
    expect(errorView).not.toBeNull();
    expect(container?.textContent).toContain("2 MiB limit");
  });
});
