import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SheetViewer, { SheetTruncatedNotice } from "../../src/viewers/SheetViewer";
import { memorySource } from "../../src/shells/sources";
import type { ParsedSheet } from "../../src/viewers/sheet-parse";

describe("SheetTruncatedNotice", () => {
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
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    root = null;
  });

  // Mutation caught: incorrect message format for rows with known total
  it("renders notice text for rows with a known total", () => {
    const sheet: ParsedSheet = {
      name: "Sheet1",
      rows: 50_000,
      cols: 10,
      colWidths: Array(10).fill(110),
      cells: [],
      merges: [],
      totalRows: 120_000,
      truncated: true,
      rowsTruncated: true,
    };
    act(() => {
      root!.render(<SheetTruncatedNotice sheet={sheet} />);
    });
    const el = container!.querySelector(".sheet-truncated");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("Showing the first 50,000 of 120,000 rows.");
  });

  // Mutation caught: incorrect message format for rows with unknown total
  it("renders notice text for rows with unknown total", () => {
    const sheet: ParsedSheet = {
      name: "Sheet1",
      rows: 100_000,
      cols: 2,
      colWidths: Array(2).fill(110),
      cells: [],
      merges: [],
      truncated: true,
      rowsTruncated: true,
    };
    act(() => {
      root!.render(<SheetTruncatedNotice sheet={sheet} />);
    });
    const el = container!.querySelector(".sheet-truncated");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("Showing the first 100,000 rows. The rest of the file is not shown.");
  });

  // Mutation caught: missing appended column truncation notice
  it("appends notice text when columns are dropped", () => {
    const sheet: ParsedSheet = {
      name: "Sheet1",
      rows: 50_000,
      cols: 16_384,
      colWidths: Array(16_384).fill(110),
      cells: [],
      merges: [],
      totalRows: 120_000,
      totalCols: 20_000,
      truncated: true,
      rowsTruncated: true,
    };
    act(() => {
      root!.render(<SheetTruncatedNotice sheet={sheet} />);
    });
    const el = container!.querySelector(".sheet-truncated");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe(
      "Showing the first 50,000 of 120,000 rows. Showing the first 16,384 of 20,000 columns."
    );
  });

  // Mutation caught: showing notice when truncated is not true
  it("renders nothing when truncated is not true", () => {
    const sheet: ParsedSheet = {
      name: "Sheet1",
      rows: 100,
      cols: 5,
      colWidths: Array(5).fill(110),
      cells: [],
      merges: [],
    };
    act(() => {
      root!.render(<SheetTruncatedNotice sheet={sheet} />);
    });
    const el = container!.querySelector(".sheet-truncated");
    expect(el).toBeNull();
  });

  // Mutation caught: removing <SheetTruncatedNotice> from SheetViewer component.
  // A real 100 001-row CSV through the real viewer (jsdom has no Worker, so it parses in-thread).
  it("integration: SheetViewer shows the notice for a CSV over the row cap", async () => {
    const csv = Array.from({ length: 100_001 }, (_, i) => `${i},row ${i}`).join("\n");
    const source = memorySource(new TextEncoder().encode(csv), "big.csv");
    await act(async () => {
      root!.render(
        <SheetViewer
          source={source}
          detection={{ kind: "sheet", ext: "csv", by: "extension", label: "CSV" }}
          onReady={() => {}}
          onOpen={() => {}}
        />
      );
    });
    for (let i = 0; i < 100 && !container!.querySelector(".sheet-truncated"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    const notice = container!.querySelector(".sheet-truncated");
    expect(notice?.textContent).toBe("Showing the first 100,000 rows. The rest of the file is not shown.");
  }, 30_000);

  it("shows rows and columns notice when rows cut with unknown total and columns cut", async () => {
    // Catches mutation: omitting row truncation notice when columns are also cut and totalRows is undefined
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SheetTruncatedNotice
          sheet={{
            name: "Sheet1",
            rows: 30,
            cols: 16384,
            colWidths: [],
            cells: [],
            merges: [],
            truncated: true,
            rowsTruncated: true,
            totalCols: 16385,
          }}
        />,
      );
    });
    expect(container.textContent).toBe(
      "Showing the first 30 rows. The rest of the file is not shown. Showing the first 16,384 of 16,385 columns.",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows only columns notice when only columns are cut", async () => {
    // Catches mutation: displaying row truncation text when rowsTruncated is undefined
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SheetTruncatedNotice
          sheet={{
            name: "Sheet1",
            rows: 30,
            cols: 16384,
            colWidths: [],
            cells: [],
            merges: [],
            truncated: true,
            totalCols: 16385,
          }}
        />,
      );
    });
    expect(container.textContent).toBe("Showing the first 16,384 of 16,385 columns.");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
