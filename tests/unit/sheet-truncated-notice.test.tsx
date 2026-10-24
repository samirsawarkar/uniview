import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SheetTruncatedNotice } from "../../src/viewers/SheetViewer";
import type { ParsedSheet } from "../../src/viewers/sheet-parse";

describe("sheet-truncated notice", () => {
  it("renders status notice with row counts when totalRows is present", () => {
    // Catches: missing truncation notice or incorrect formatting when totalRows is present
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const sheet: ParsedSheet = {
      name: "Sheet1",
      rows: 50000,
      cols: 10,
      colWidths: Array(10).fill(110),
      cells: [],
      merges: [],
      totalRows: 120000,
    };

    act(() => {
      root.render(<SheetTruncatedNotice sheet={sheet} />);
    });

    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl?.textContent).toBe("Showing the first 50,000 of 120,000 rows.");
    expect(statusEl?.classList.contains("sheet-truncated")).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not render notice when totalRows is not present", () => {
    // Catches: spurious truncation notice rendered when totalRows is absent
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const sheet: ParsedSheet = {
      name: "Sheet1",
      rows: 50000,
      cols: 10,
      colWidths: Array(10).fill(110),
      cells: [],
      merges: [],
    };

    act(() => {
      root.render(<SheetTruncatedNotice sheet={sheet} />);
    });

    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
