import { describe, it, expect } from "vitest";
import { structuredPatch } from "diff";
import { computeLineDiff, parseUnified } from "../../src/viewers/viewspec-diff";

describe("viewspec diff unit tests", () => {
  it("small diff produces the expected hunks", () => {
    const before = "line 1\nline 2\nline 3\n";
    const after = "line 1\nline 2 modified\nline 3\n";
    const res = computeLineDiff(before, after, { timeoutMs: 2000 });

    expect(res.kind).toBe("diff");
    if (res.kind === "diff") {
      expect(res.hunks.length).toBeGreaterThan(0);
      const lines = res.hunks[0]!.lines;
      expect(lines.some((l) => l.startsWith("-line 2"))).toBe(true);
      expect(lines.some((l) => l.startsWith("+line 2 modified"))).toBe(true);
    }
  });

  it("maxLines exceeded → too_big", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const res = computeLineDiff(lines, lines, { timeoutMs: 2000, maxLines: 50 });
    expect(res).toEqual({ kind: "too_big" });
  });

  it("pathological input with timeoutMs: 1 → too_big", () => {
    let callCount = 0;
    const fakeNow = () => {
      callCount++;
      return callCount === 1 ? 1000 : 2000;
    };
    const resFake = computeLineDiff("a\nb\nc", "d\ne\nf", {
      timeoutMs: 1,
      now: fakeNow,
    });
    expect(resFake).toEqual({ kind: "too_big" });

    const largeBefore = Array.from({ length: 5000 }, () =>
      Math.random().toString(36).repeat(5)
    ).join("\n");
    const largeAfter = Array.from({ length: 5000 }, () =>
      Math.random().toString(36).repeat(5)
    ).join("\n");
    const resReal = computeLineDiff(largeBefore, largeAfter, { timeoutMs: 1 });
    expect(resReal).toEqual({ kind: "too_big" });
  });

  it("parseUnified round-trips a structuredPatch output", () => {
    const before = "apple\nbanana\ncherry\ndate\n";
    const after = "apple\nblueberry\ncherry\ndate\nelderberry\n";
    const patch = structuredPatch("old.txt", "new.txt", before, after);

    const unifiedText =
      patch.hunks
        .map(
          (h) =>
            `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`
        )
        .join("\n") + "\n";

    const parsedHunks = parseUnified(unifiedText);
    expect(parsedHunks).toEqual(patch.hunks);
  });
});
