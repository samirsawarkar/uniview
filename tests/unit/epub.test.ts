import { describe, expect, it } from "vitest";
import { parseEpub, chapterHtml } from "../../src/core/epub";
import { CorruptFileError } from "../../src/core/errors";
import { makeEpub, makeZip } from "../../scripts/fixture-builders.mjs";

describe("parseEpub", () => {
  const book = parseEpub(makeEpub());

  it("reads metadata, spine and nav TOC", () => {
    expect(book.title).toBe("The Test Book");
    expect(book.author).toBe("A. Author");
    expect(book.spine.map((s) => s.part)).toEqual(["OEBPS/text/ch1.xhtml", "OEBPS/text/ch2.xhtml"]);
    expect(book.toc.map((t) => [t.title, t.href])).toEqual([
      ["Chapter One", "OEBPS/text/ch1.xhtml"],
      ["Chapter Two", "OEBPS/text/ch2.xhtml"],
    ]);
  });

  it("builds a script-free chapter with inlined CSS and rewritten resources", () => {
    const html = chapterHtml(book, "OEBPS/text/ch1.xhtml", (p) => `blob:test/${p}`);
    expect(html).toContain("It was a bright cold day.");
    expect(html).toContain('src="blob:test/OEBPS/images/dot.png"');
    expect(html).toContain("color: rgb(180, 0, 0)");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("window.hacked");
    expect(html).toContain("default-src 'none'");
  });

  it("rejects archives that are not books", () => {
    expect(() => parseEpub(makeZip())).toThrow(CorruptFileError);
  });
});
