import { describe, expect, it } from "vitest";
import { parsePptx, applyColorMods, type ShapeEl, type TableEl, type ImageEl } from "../../src/core/pptx";
import { CorruptFileError } from "../../src/core/errors";
import { makePptx, makeDocx } from "../../scripts/fixture-builders.mjs";

const textOf = (el: ShapeEl) => el.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n") ?? "";

describe("parsePptx", () => {
  const pres = parsePptx(makePptx());
  const [s1, s2] = pres.slides;

  it("reads slide size, count, notes and thumbnail", () => {
    expect(pres.widthPt).toBe(720);
    expect(pres.heightPt).toBe(540);
    expect(pres.slides).toHaveLength(2);
    expect(s1!.notes).toBe("Mention the new hires.");
    expect(pres.thumbnailPart).toBe("docProps/thumbnail.png");
    expect(pres.warnings).toEqual([]);
  });

  it("places a title placeholder from the layout and styles it from the master", () => {
    const title = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Quarterly Review");
    expect(title).toBeDefined();
    // Layout xfrm: off (457200, 300000) EMU => (36pt, 23.62pt)
    expect(title!.x).toBeCloseTo(36);
    expect(title!.y).toBeCloseTo(23.62, 1);
    const run = title!.text!.paragraphs[0]!.runs[0]!;
    expect(run.sizePt).toBe(40);
    expect(run.bold).toBe(true);
    expect(run.font).toBe("Georgia");
    expect(run.color).toBe("#1F2937");
    expect(title!.text!.paragraphs[0]!.align).toBe("center");
  });

  it("resolves scheme colors with luminance modifiers", () => {
    const box = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Revenue up 12%");
    expect(box!.geom).toBe("roundRect");
    expect(box!.fill!.color).toBe(applyColorMods("DC2626", [lumMod(75000)]));
    expect(box!.text!.anchor).toBe("middle");
    expect(box!.text!.paragraphs[0]!.runs[0]!.color).toBe("#FFFFFF");
  });

  it("maps group children into slide coordinates and applies style references", () => {
    const child = s1!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e) === "Grouped");
    expect(child!.geom).toBe("ellipse");
    expect(child!.x).toBeCloseTo(504);
    expect(child!.w).toBeCloseTo(144);
    expect(child!.h).toBeCloseTo(72);
    expect(child!.fill!.color).toBe("#16A34A");
    expect(child!.line!.color).toBe("#2563EB");
    expect(child!.text!.paragraphs[0]!.runs[0]!.color).toBe("#FFFFFF");
  });

  it("reads pictures and tables", () => {
    const img = s1!.elements.find((e): e is ImageEl => e.type === "image");
    expect(img!.part).toBe("ppt/media/image1.png");
    const table = s1!.elements.find((e): e is TableEl => e.type === "table");
    expect(table!.colWidths).toEqual([216, 216]);
    expect(table!.rows).toHaveLength(2);
    expect(table!.rows[0]!.cells[0]!.text.paragraphs[0]!.runs[0]!.text).toBe("Region");
    expect(table!.rows[0]!.cells[0]!.fill!.color).toBe("#2563EB");
    expect(table!.rows[0]!.cells[0]!.text.paragraphs[0]!.runs[0]!.bold).toBe(true);
  });

  it("draws master decorations behind slide content", () => {
    const bar = s1!.elements[0] as ShapeEl;
    expect(bar.type).toBe("shape");
    expect(bar.y).toBeCloseTo(504);
    expect(bar.fill!.color).toBe("#1F2937");
  });

  it("inherits body placeholders, bullets, levels and autofit scale", () => {
    expect(s2!.background!.color).toBe("#FEF3C7");
    const body = s2!.elements.find((e): e is ShapeEl => e.type === "shape" && textOf(e).startsWith("Hire"));
    expect(body).toBeDefined();
    expect(body!.y).toBeCloseTo(126);
    const [p1, p2] = body!.text!.paragraphs;
    expect(p1!.bullet).toBe("•");
    expect(p1!.runs[0]!.sizePt).toBeCloseTo(25.2);
    expect(p2!.level).toBe(1);
    expect(p2!.bullet).toBe("–");
    expect(p2!.runs[0]!.sizePt).toBeCloseTo(21.6);
  });

  it("skips empty placeholders, which are edit-mode prompts", () => {
    const shapes = s2!.elements.filter((e) => e.type === "shape");
    expect(shapes.every((s) => (s as ShapeEl).text || (s as ShapeEl).fill)).toBe(true);
  });

  it("rejects non-presentations", () => {
    expect(() => parsePptx(makeDocx())).toThrow(CorruptFileError);
  });
});

function lumMod(val: number): Element {
  const el = document.createElementNS("http://schemas.openxmlformats.org/drawingml/2006/main", "lumMod");
  el.setAttribute("val", String(val));
  return el;
}
