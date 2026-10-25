import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReceiptViewer from "../../src/viewers/ReceiptViewer";
import ReviewTab from "../../src/viewers/ReviewTab";
import { FileRefRenderer } from "../../src/viewers/viewspec-nodes";
import { attachGrantToken } from "../../src/shells/electron";
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

  it("the Content-from-the-agent label is separated from the identity line (P28)", async () => {
    // Mutation: label and identity rendered as adjacent inline text with no separation ("agentReceipt from an agent")
    await renderAndWait(makeSource(sampleReceipt));
    const label = container!.querySelector(".agent-content-label")!;
    expect(label.querySelector(".agent-badge")!.textContent).toBe("Content from the agent");
    expect(label.querySelector(".agent-identity")!.textContent).toMatch(/^Receipt from an agent/);
    expect(label.textContent).not.toContain("agentReceipt");
    expect(label.textContent).toContain("Content from the agent Receipt from an agent");
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

  it("FileRefRenderer sanitizes node.label and node.path stripping bidi and control characters", async () => {
    // Mutation caught: FileRefRenderer renders unsanitized node.label or node.path containing bidi or control characters
    await act(async () => {
      root!.render(<FileRefRenderer node={{ type: "fileRef", path: "file.txt", label: "\u202Eevil\u202C.txt\u0000" }} />);
    });
    const textSpan = container?.querySelector(".vs-fileref-text");
    expect(textSpan?.textContent).toBe("evil.txt");
  });

  it("ReceiptViewer sanitizes agent strings in validation errors list", async () => {
    // Mutation caught: ReceiptViewer error list renders raw unsanitized error strings containing bidi/control characters
    const sourceWithBidiErr = {
      id: "err-src",
      name: "task.receipt.json",
      size: 10,
      readAll: async () => {
        throw new Error("\u202Ehostile-msg\u202C\u0007");
      },
      readRange: async () => new ArrayBuffer(0),
      url: async () => "blob:test",
      release: () => {},
    };
    await renderAndWait(sourceWithBidiErr);
    const errItem = container?.querySelector(".receipt-error-item");
    expect(errItem).not.toBeNull();
    expect(errItem?.textContent).not.toContain("\u202E");
    expect(errItem?.textContent).not.toContain("\u0007");
    expect(errItem?.textContent).toContain("hostile-msg");
  });

  it("shows earlier review sidecar banner when persisted: false and sidecarConflict: true", async () => {
    // Mutation caught: ReviewTab shows generic could not be saved banner instead of earlier-review conflict message
    const mockReviewApi: any = {
      open: vi.fn(async () => ({
        ok: true,
        reviewId: "0".repeat(32),
        receiptDigest: "1".repeat(64),
        receipt: sampleReceipt,
        files: sampleReceipt.files.map((f) => ({ path: f.path, expectedSha256: f.sha256, observedSha256: f.sha256, state: "unchanged" })),
      })),
      decide: vi.fn(async () => ({
        ok: true,
        decision: {
          uniview: "decision/1",
          reviewId: "0".repeat(32),
          receiptDigest: "1".repeat(64),
          decision: "approved",
          comment: "",
          decidedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          persisted: false,
          files: [],
        },
        sidecarConflict: true,
      })),
      dismiss: vi.fn(async () => ({ ok: true })),
      refresh: vi.fn(async () => ({ ok: true })),
    };

    const source = {
      ...makeSource(sampleReceipt),
      path: "C:\\work\\task.receipt.json",
    };
    attachGrantToken(source, "test-token");

    await act(async () => {
      root!.render(
        <ReviewTab
          source={source}
          reviewApi={mockReviewApi}
          active={true}
        />
      );
    });
    // Wait for open and arming
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    const approveBtn = container?.querySelector("[data-testid='approve-btn']") as HTMLButtonElement;
    expect(approveBtn).not.toBeNull();
    await act(async () => {
      const key = Object.keys(approveBtn).find((k) => k.startsWith("__reactProps$"));
      const props = (approveBtn as any)[key!];
      props.onClick({
        type: "click",
        defaultPrevented: false,
        nativeEvent: {
          isTrusted: true,
          detail: 1,
          pointerType: "mouse",
        },
        preventDefault() {},
        stopPropagation() {},
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const persistBanner = container?.querySelector("[data-testid='persist-error']");
    expect(persistBanner).not.toBeNull();
    expect(persistBanner?.textContent).toContain(
      "A decision file from an earlier review already exists next to this receipt; this decision was kept inside UniView only."
    );
  });

  it("ambiguous file awaiting choice displays 'choose a file' badge instead of 'missing'", async () => {
    // Mutation caught: ambiguous file shows 'missing' badge while awaiting choice
    const receiptWithAmbiguous: Receipt = {
      ...sampleReceipt,
      files: [
        {
          path: "/workspace/doc.txt",
          relPath: "doc.txt",
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          role: "created",
        },
      ],
    };
    const source = makeSource(receiptWithAmbiguous);
    await renderAndWait(source);

    // Pick 2 companion files with same name 'doc.txt' but different hashes (neither matching expected)
    const fileInput = container?.querySelector("input[type='file']") as HTMLInputElement;
    const file1 = new File(["content1"], "doc.txt", { type: "text/plain" });
    const file2 = new File(["content2"], "doc.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [file1, file2], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const stateBadge = container?.querySelector(".receipt-state-badge");
    expect(stateBadge?.textContent).toBe("choose a file");
    expect(stateBadge?.className).toContain("state-choose_a_file");
  });

  it("stored choices are keyed by path+sha256 so reloaded reordered receipt applies choice to the correct file", async () => {
    // Mutation caught: stored choices keyed by array index instead of path+sha256, applying choice to wrong file on reload
    const fileA = {
      path: "/workspace/a.txt",
      relPath: "a.txt",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      role: "created" as const,
    };
    const fileB = {
      path: "/workspace/b.txt",
      relPath: "b.txt",
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      role: "created" as const,
    };

    let currentReceipt: Receipt = {
      ...sampleReceipt,
      files: [fileA, fileB],
    };

    const source = {
      ...makeSource(currentReceipt),
      reopen: async () => makeSource(currentReceipt),
    };

    await renderAndWait(source);

    // Pick 2 companion candidates for a.txt to make it ambiguous
    const fileInput = container?.querySelector("input[type='file']") as HTMLInputElement;
    const compA1 = new File(["file a candidate 1"], "a.txt", { type: "text/plain" });
    const compA2 = new File(["file a candidate 2"], "a.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [compA1, compA2], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // File A at index 0 should have choice buttons
    const choiceBtn = container?.querySelector(".receipt-choice-btn") as HTMLButtonElement;
    expect(choiceBtn).not.toBeNull();

    // Click choice for file A
    await act(async () => {
      choiceBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // Now reload with reordered files: [fileB, fileA]
    currentReceipt = {
      ...sampleReceipt,
      files: [fileB, fileA],
    };

    const reloadBtn = container?.querySelector(".receipt-reload-btn") as HTMLButtonElement;
    await act(async () => {
      reloadBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // File B is now index 0. It should NOT have File A's choice applied to it!
    const fileItems = container?.querySelectorAll(".receipt-file-item");
    expect(fileItems?.length).toBe(2);
    // Index 0 is fileB
    expect(fileItems?.[0]?.textContent).toContain("b.txt");
    expect(fileItems?.[0]?.textContent).not.toContain("candidate");
    // Index 1 is fileA
    expect(fileItems?.[1]?.textContent).toContain("a.txt");
  });

  it("resolves view image/fileRef against picked companion files when view is a picked companion on a LAN receipt", async () => {
    // Mutation caught: resolving view references against LAN share instead of picked companions when view is phone-local
    const receiptWithView: Receipt = {
      ...sampleReceipt,
      view: "/remote/share/spec.uview.json",
    };

    const lanOpened = vi.fn();
    const mockLanReader = {
      open: async (path: string) => {
        lanOpened(path);
        throw new Error("File not found on share");
      },
    };

    const remoteSource = makeSource(receiptWithView, undefined, {
      hostId: "host-1",
      rootId: "root-1",
      path: "dir/task.receipt.json",
    });

    // spec.uview.json viewspec containing an image referencing relPath "chart.png"
    const viewspecContent = JSON.stringify({
      uniview: "view/1",
      title: "View with Image",
      body: [
        { type: "image", path: "/workspace/chart.png", relPath: "chart.png", alt: "Test chart" },
      ],
    });

    await renderAndWait(remoteSource, { lanReader: mockLanReader });

    // Pick spec.uview.json and chart.png as companion files
    const fileInput = container?.querySelector("input[type='file']") as HTMLInputElement;
    const compView = new File([viewspecContent], "spec.uview.json", { type: "application/json" });
    const compImg = new File(["fake image bytes"], "chart.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [compView, compImg], configurable: true });

    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // The view should be found from companions and rendered
    // When the image inside the view resolves: it must resolve against picked companion files (finding chart.png),
    // and NOT call lanReader for chart.png!
    expect(lanOpened).not.toHaveBeenCalledWith(expect.stringContaining("chart.png"));
    const imagePlaceholder = container?.querySelector(".vs-image-placeholder");
    expect(imagePlaceholder).not.toBeNull();
    expect(imagePlaceholder?.textContent).toContain("This image is on this device");
  });
});
