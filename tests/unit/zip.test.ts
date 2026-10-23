import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { listZip, readZipEntries, ZipPackage, decodeText, resolvePath } from "../../src/core/zip";
import { CorruptFileError } from "../../src/core/errors";
import { hexRows } from "../../src/core/hex";

describe("zip", () => {
  const data = zipSync({ "a.txt": strToU8("alpha"), "dir/": new Uint8Array(0), "dir/b.txt": strToU8("beta beta") });

  it("lists entries without inflating", () => {
    const entries = listZip(data);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/", "dir/b.txt"]);
    expect(entries[1]!.isDirectory).toBe(true);
    expect(entries[2]!.size).toBe(9);
  });

  it("reads only wanted entries", () => {
    const out = readZipEntries(data, (n) => n === "dir/b.txt");
    expect([...out.keys()]).toEqual(["dir/b.txt"]);
    expect(decodeText(out.get("dir/b.txt")!)).toBe("beta beta");
  });

  it("resolves part names case-insensitively and caches", () => {
    const pkg = new ZipPackage(data);
    expect(pkg.text("A.TXT")).toBe("alpha");
    expect(pkg.has("missing")).toBe(false);
    expect(pkg.bytesOf("missing")).toBeUndefined();
  });

  it("rejects garbage with a CorruptFileError", () => {
    expect(() => listZip(new Uint8Array([1, 2, 3, 4]))).toThrow(CorruptFileError);
  });
});

describe("decodeText", () => {
  it("honours BOMs and falls back to Windows-1252", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi");
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });
});

describe("resolvePath", () => {
  it("joins relative targets, handles .., absolute paths, anchors and escapes", () => {
    expect(resolvePath("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png");
    expect(resolvePath("OEBPS/text/ch1.xhtml", "../images/a%20b.jpg")).toBe("OEBPS/images/a b.jpg");
    expect(resolvePath("word/document.xml", "/word/media/x.png")).toBe("word/media/x.png");
    expect(resolvePath("OEBPS/toc.ncx", "ch2.xhtml#sec1")).toBe("OEBPS/ch2.xhtml");
  });
});

describe("hexRows", () => {
  it("formats offset, hex and ASCII columns", () => {
    const rows = hexRows(new Uint8Array([0x48, 0x69, 0x00, 0xff]), 16);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^00000010  48 69 00 ff/);
    expect(rows[0]).toMatch(/\|Hi\.\.\|$/);
  });
});
