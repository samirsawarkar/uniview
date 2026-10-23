import { describe, expect, it, beforeAll } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { VirtualGrid, type Grid } from "../../src/viewers/SheetViewer";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // @ts-expect-error React act environment flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function renderGrid(grid: Grid) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<VirtualGrid grid={grid} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("VirtualGrid merged cells rendering", () => {
  it("renders one merged cell spanning summed column widths and row heights", () => {
    const grid: Grid = {
      name: "TestSheet",
      rows: 4,
      cols: 4,
      merges: [
        {
          s: { r: 1, c: 1 },
          e: { r: 2, c: 2 },
        },
      ],
      colWidth: (c) => (c === 0 ? 100 : c === 1 ? 120 : c === 2 ? 80 : 90),
      cell: (r, c) => (r === 1 && c === 1 ? "Merged Header" : `cell-${r}-${c}`),
    };

    const { container, cleanup } = renderGrid(grid);
    try {
      const mergedEl = Array.from(container.querySelectorAll(".cell")).find(
        (el) => el.textContent === "Merged Header",
      ) as HTMLElement | undefined;

      expect(mergedEl).toBeDefined();
      // row 1 * 24px = 24px
      expect(mergedEl!.style.top).toBe("24px");
      // col 0 width = 100px
      expect(mergedEl!.style.left).toBe("100px");
      // col 1 width (120px) + col 2 width (80px) = 200px
      expect(mergedEl!.style.width).toBe("200px");
      // 2 rows * 24px = 48px
      expect(mergedEl!.style.height).toBe("48px");
    } finally {
      cleanup();
    }
  });

  it("suppresses covered cells belonging to a merge", () => {
    const grid: Grid = {
      name: "TestSheet",
      rows: 4,
      cols: 4,
      merges: [
        {
          s: { r: 1, c: 1 },
          e: { r: 2, c: 2 },
        },
      ],
      colWidth: () => 100,
      cell: (r, c) => {
        if (r === 1 && c === 1) return "Anchor";
        if (r === 1 && c === 2) return "Covered 1:2";
        if (r === 2 && c === 1) return "Covered 2:1";
        if (r === 2 && c === 2) return "Covered 2:2";
        return `val-${r}-${c}`;
      },
    };

    const { container, cleanup } = renderGrid(grid);
    try {
      const texts = Array.from(container.querySelectorAll(".cell")).map((el) => el.textContent);
      // Anchor cell is rendered
      expect(texts).toContain("Anchor");
      // Unmerged cells are rendered
      expect(texts).toContain("val-0-0");
      expect(texts).toContain("val-3-0");
      // Covered cells are suppressed
      expect(texts).not.toContain("Covered 1:2");
      expect(texts).not.toContain("Covered 2:1");
      expect(texts).not.toContain("Covered 2:2");
    } finally {
      cleanup();
    }
  });

  it("retains intersecting merge when anchor lies above viewport", () => {
    const grid: Grid = {
      name: "TallSheet",
      rows: 30,
      cols: 5,
      merges: [
        {
          s: { r: 0, c: 0 },
          e: { r: 15, c: 1 },
        },
      ],
      colWidth: () => 100,
      cell: (r, c) => (r === 0 && c === 0 ? "Tall Anchor Above" : `r${r}c${c}`),
    };

    const { container, cleanup } = renderGrid(grid);
    try {
      const scrollEl = container.querySelector(".grid-scroll") as HTMLDivElement;
      expect(scrollEl).toBeDefined();

      // Scroll down: 300px down means r0 = Math.floor(300/24) - 5 = 7 (anchor row 0 is strictly above viewport)
      act(() => {
        Object.defineProperty(scrollEl, "scrollTop", { value: 300, configurable: true });
        scrollEl.dispatchEvent(new Event("scroll"));
      });

      const mergedEl = Array.from(container.querySelectorAll(".cell")).find(
        (el) => el.textContent === "Tall Anchor Above",
      ) as HTMLElement | undefined;

      // The intersecting merge must be retained
      expect(mergedEl).toBeDefined();
      expect(mergedEl!.style.top).toBe("0px");
      expect(mergedEl!.style.height).toBe(`${16 * 24}px`); // 16 rows * 24 = 384px

      // Covered cells in rows 7..15 must still be suppressed
      const texts = Array.from(container.querySelectorAll(".cell")).map((el) => el.textContent);
      expect(texts).not.toContain("r7c0");
      expect(texts).not.toContain("r8c1");
    } finally {
      cleanup();
    }
  });

  it("retains intersecting merge when anchor lies left of viewport", () => {
    const grid: Grid = {
      name: "WideSheet",
      rows: 5,
      cols: 30,
      merges: [
        {
          s: { r: 0, c: 0 },
          e: { r: 1, c: 10 },
        },
      ],
      colWidth: () => 100,
      cell: (r, c) => (r === 0 && c === 0 ? "Wide Anchor Left" : `r${r}c${c}`),
    };

    const { container, cleanup } = renderGrid(grid);
    try {
      const scrollEl = container.querySelector(".grid-scroll") as HTMLDivElement;
      expect(scrollEl).toBeDefined();

      // Scroll right: 500px right means c0 = 3 (anchor col 0 is strictly left of viewport)
      act(() => {
        Object.defineProperty(scrollEl, "scrollLeft", { value: 500, configurable: true });
        scrollEl.dispatchEvent(new Event("scroll"));
      });

      const mergedEl = Array.from(container.querySelectorAll(".cell")).find(
        (el) => el.textContent === "Wide Anchor Left",
      ) as HTMLElement | undefined;

      // The intersecting merge must be retained
      expect(mergedEl).toBeDefined();
      expect(mergedEl!.style.left).toBe("0px");
      expect(mergedEl!.style.width).toBe(`${11 * 100}px`); // 11 cols * 100 = 1100px

      // Covered cells in cols 3..10 must still be suppressed
      const texts = Array.from(container.querySelectorAll(".cell")).map((el) => el.textContent);
      expect(texts).not.toContain("r0c4");
      expect(texts).not.toContain("r1c5");
    } finally {
      cleanup();
    }
  });

  it("does not render non-intersecting merges outside viewport", () => {
    const grid: Grid = {
      name: "LongSheet",
      rows: 60,
      cols: 5,
      merges: [
        {
          s: { r: 45, c: 0 },
          e: { r: 50, c: 1 },
        },
      ],
      colWidth: () => 100,
      cell: (r, c) => (r === 45 && c === 0 ? "Far Away" : `r${r}c${c}`),
    };

    const { container, cleanup } = renderGrid(grid);
    try {
      // Scrolled at top (scrollTop = 0, view height = 600, r1 ~ 30)
      const texts = Array.from(container.querySelectorAll(".cell")).map((el) => el.textContent);
      expect(texts).not.toContain("Far Away");
    } finally {
      cleanup();
    }
  });
});
