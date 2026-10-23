import { describe, expect, it } from "vitest";
import { parsePptx, type ShapeEl, type TableEl, type ImageEl, type PlaceholderEl } from "../../src/core/pptx";
import { makeHardPptx } from "../../scripts/fixture-builders.mjs";
import { findPresenterEntrySlide, findNextSlide, findPrevSlide } from "../../src/viewers/pptx-navigation";

const textOf = (el: ShapeEl) => el.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n") ?? "";

describe("parsePptx on hard.pptx fixture", () => {
  const pres = parsePptx(makeHardPptx());
  const [s1, s2, s3] = pres.slides;

  it("reads slide count and hidden slide flags", () => {
    expect(pres.slides).toHaveLength(3);
    expect(s1!.hidden).toBe(false);
    expect(s2!.hidden).toBe(true);
    expect(s3!.hidden).toBe(false);
  });

  it("reads rotated shape (rot 45°)", () => {
    const rotated = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Rotated 45");
    expect(rotated).toBeDefined();
    expect(rotated!.rot).toBeCloseTo(45);
    expect(rotated!.geom).toBe("rect");
    expect(rotated!.fill?.color).toBe("#3B82F6");
  });

  it("reads horizontally flipped arrow shape", () => {
    const arrow = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Flipped Arrow");
    expect(arrow).toBeDefined();
    expect(arrow!.geom).toBe("rightArrow");
    expect(arrow!.flipH).toBe(true);
    expect(arrow!.flipV).toBe(false);
    expect(arrow!.fill?.color).toBe("#10B981");
  });

  it("reads gradient stops and angle", () => {
    const grad = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Gradient Shape");
    expect(grad).toBeDefined();
    expect(grad!.fill?.gradient).toBeDefined();
    const g = grad!.fill!.gradient!;
    expect(g.angle).toBeCloseTo(90);
    expect(g.stops).toHaveLength(2);
    expect(g.stops[0]).toEqual({ pos: 0, color: "#EF4444" });
    expect(g.stops[1]).toEqual({ pos: 100, color: "#3B82F6" });
  });

  it("reads picture with srcRect crop fractions", () => {
    const img = s1!.elements.find((e): e is ImageEl => e.type === "image");
    expect(img).toBeDefined();
    expect(img!.part).toBe("ppt/media/image1.png");
    expect(img!.crop).toBeDefined();
    expect(img!.crop!.l).toBeCloseTo(0.1);
    expect(img!.crop!.t).toBeCloseTo(0.2);
    expect(img!.crop!.r).toBeCloseTo(0.1);
    expect(img!.crop!.b).toBeCloseTo(0.2);
  });

  it("reads text run with hyperlink text and superscript baseline", () => {
    const linkShape = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e).startsWith("UniView Docs"));
    expect(linkShape).toBeDefined();
    const runs = linkShape!.text!.paragraphs[0]!.runs;
    expect(runs).toHaveLength(2);

    // Hyperlink text run
    expect(runs[0]!.text).toBe("UniView Docs");
    expect(runs[0]!.link).toBe("https://uniview.app");

    // Superscript run
    expect(runs[1]!.text).toBe("[1]");
    expect(runs[1]!.baseline).toBe(30);
  });

  it("reads table with merged cell gridSpan", () => {
    const table = s1!.elements.find((e): e is TableEl => e.type === "table");
    expect(table).toBeDefined();
    expect(table!.colWidths).toHaveLength(3);
    expect(table!.rows).toHaveLength(2);

    const headerCells = table!.rows[0]!.cells;
    expect(headerCells).toHaveLength(3);
    expect(headerCells[0]!.text.paragraphs[0]!.runs[0]!.text).toBe("Merged Header");
    expect(headerCells[0]!.gridSpan).toBe(2);
    expect(headerCells[0]!.merged).toBe(false);

    expect(headerCells[1]!.merged).toBe(true);

    expect(headerCells[2]!.text.paragraphs[0]!.runs[0]!.text).toBe("Col 3");
    expect(headerCells[2]!.gridSpan).toBe(1);
    expect(headerCells[2]!.merged).toBe(false);
  });

  it("computes nested group child coordinates in slide points", () => {
    const deep = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Deep Child");
    expect(deep).toBeDefined();
    // OuterGroup at (504, 72, 200, 200) with chExt=(400, 400) -> scale 0.5
    // InnerGroup at (100, 100, 200, 200) -> outer at (554, 122, 100, 100) with chExt=(200, 200) -> scale 0.5
    // DeepChild at (50, 50, 100, 100) -> (554 + 25, 122 + 25, 50, 50) = (579, 147, 50, 50)
    expect(deep!.x).toBeCloseTo(579);
    expect(deep!.y).toBeCloseTo(147);
    expect(deep!.w).toBeCloseTo(50);
    expect(deep!.h).toBeCloseTo(50);
    expect(deep!.fill?.color).toBe("#8B5CF6");
  });

  it("reads chart placeholder graphic frame", () => {
    const chart = s1!.elements.find((e): e is PlaceholderEl => e.type === "placeholder" && e.label === "Chart");
    expect(chart).toBeDefined();
    expect(chart!.x).toBeCloseTo(504);
    expect(chart!.y).toBeCloseTo(288);
    expect(chart!.w).toBeCloseTo(200);
    expect(chart!.h).toBeCloseTo(144);
  });
});

describe("presenter navigation helpers (pptx-navigation)", () => {
  const deck = [
    { hidden: false }, // index 0
    { hidden: true },  // index 1
    { hidden: false }, // index 2
  ];

  it("skips hidden slides forward", () => {
    expect(findNextSlide(deck, 0)).toBe(2);
    expect(findNextSlide(deck, 2)).toBe(2);
  });

  it("skips hidden slides backward", () => {
    expect(findPrevSlide(deck, 2)).toBe(0);
    expect(findPrevSlide(deck, 0)).toBe(0);
  });

  it("finds correct entry slide, skipping hidden slides on entry", () => {
    expect(findPresenterEntrySlide(deck, 0)).toBe(0);
    // When current is slide 1 (hidden), entry advances to first visible slide (slide 2)
    expect(findPresenterEntrySlide(deck, 1)).toBe(2);
    expect(findPresenterEntrySlide(deck, 2)).toBe(2);

    // If starting on a trailing hidden slide, searches backward
    const trailingHidden = [{ hidden: false }, { hidden: true }];
    expect(findPresenterEntrySlide(trailingHidden, 1)).toBe(0);
  });

  it("cleanly handles all-hidden decks", () => {
    const allHidden = [{ hidden: true }, { hidden: true }, { hidden: true }];
    expect(findPresenterEntrySlide(allHidden, 0)).toBe(-1);
    expect(findPresenterEntrySlide(allHidden, 1)).toBe(-1);
    expect(findNextSlide(allHidden, 0)).toBe(0);
    expect(findPrevSlide(allHidden, 1)).toBe(1);

    expect(findPresenterEntrySlide([], 0)).toBe(-1);
    expect(findNextSlide([], 0)).toBe(0);
    expect(findPrevSlide([], 0)).toBe(0);
  });
});
