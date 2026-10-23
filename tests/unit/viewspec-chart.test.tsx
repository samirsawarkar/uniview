import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartRenderer } from "../../src/viewers/viewspec-nodes";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChartRenderer negative values and zero-line alignment", () => {
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

  it("renders positive and negative bars spanning to the zero line with equal heights", async () => {
    // Catches mutation where negative bar height is clamped to 1 instead of spanning from zero line to value
    await act(async () => {
      root!.render(
        <ChartRenderer
          node={
            {
              kind: "bar",
              x: ["a", "b"],
              series: [{ name: "s", values: [10, -10] }],
            } as any
          }
        />
      );
    });

    const bars = container?.querySelectorAll<SVGRectElement>("rect.vs-chart-bar");
    expect(bars).toBeDefined();
    expect(bars?.length).toBe(2);

    const bar0 = bars?.[0];
    const bar1 = bars?.[1];
    if (!bar0 || !bar1) throw new Error("Bars not found");

    const h0 = parseFloat(bar0.getAttribute("height") ?? "0");
    const h1 = parseFloat(bar1.getAttribute("height") ?? "0");
    const y0 = parseFloat(bar0.getAttribute("y") ?? "0");
    const y1 = parseFloat(bar1.getAttribute("y") ?? "0");

    // Both heights are equal and > 1
    expect(h0).toBeGreaterThan(1);
    expect(h1).toBeGreaterThan(1);
    expect(h0).toBe(h1);

    // The positive bar's y + height equals the negative bar's y (both touch the zero line)
    // Catches mutation where bar y position does not align with the zero line
    expect(y0 + h0).toBe(y1);
  });

  it("renders a line chart with a negative value below the zero line", async () => {
    // Catches mutation where line chart point for negative value is plotted above or clamped to zero line
    await act(async () => {
      root!.render(
        <ChartRenderer
          node={
            {
              kind: "line",
              x: ["a", "b"],
              series: [{ name: "s", values: [10, -10] }],
            } as any
          }
        />
      );
    });

    const dots = container?.querySelectorAll<SVGCircleElement>("circle.vs-chart-dot");
    expect(dots).toBeDefined();
    expect(dots?.length).toBe(2);

    const dot0 = dots?.[0];
    const dot1 = dots?.[1];
    if (!dot0 || !dot1) throw new Error("Dots not found");

    const cy0 = parseFloat(dot0.getAttribute("cy") ?? "0");
    const cy1 = parseFloat(dot1.getAttribute("cy") ?? "0");

    // In SVG, y increases downwards. In 300px height with padTop=20, padBottom=40,
    // for range [-10, 10], zero line is at getY(0) = 140.
    const zeroY = 140;
    expect(cy0).toBeLessThan(zeroY);
    expect(cy1).toBeGreaterThan(zeroY);
  });
});
