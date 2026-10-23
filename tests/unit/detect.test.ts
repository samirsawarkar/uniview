import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { detect, extOf, looksLikeText, zipLocalNames, classifyZipEntries } from "../../src/core/detect";

const bytes = (...xs: number[]) => new Uint8Array(xs);
const text = (s: string) => new TextEncoder().encode(s);

describe("extOf", () => {
  it("handles ordinary, missing, dotfile and path names", () => {
    expect(extOf("Report.PDF")).toBe("pdf");
    expect(extOf("C:\\a\\b\\photo.jpeg")).toBe("jpeg");
    expect(extOf("README")).toBe("");
    expect(extOf(".gitignore")).toBe("gitignore");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("trailing.")).toBe("");
  });
});

describe("detect by signature", () => {
  it.each([
    ["x.bin", text("%PDF-1.7\n"), "pdf"],
    ["x", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image"],
    ["x", bytes(0xff, 0xd8, 0xff, 0xe0), "image"],
    ["x", text("GIF89a...."), "image"],
    ["x", bytes(0x49, 0x49, 0x2a, 0x00), "tiff"],
    ["x", text("OggS\0\0\0"), "audio"],
    ["x.ogv", text("OggS\0\0\0"), "video"],
    ["x", text("fLaC\0\0"), "audio"],
    ["x", text("ID3\u0004\0"), "audio"],
    ["x", text("wOF2abcd"), "font"],
    ["x", bytes(0x1a, 0x45, 0xdf, 0xa3), "video"],
  ])("%s -> %s", (name, head, kind) => {
    expect(detect(name, head).kind).toBe(kind);
  });

  it("reads MP4, AVIF and HEIC brands", () => {
    const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, ...text("ftyp" + brand)]);
    expect(detect("clip", ftyp("isom")).kind).toBe("video");
    expect(detect("song.m4a", ftyp("M4A ")).kind).toBe("audio");
    expect(detect("pic", ftyp("avif")).kind).toBe("image");
    const heic = detect("pic.heic", ftyp("heic"));
    expect(heic.kind).toBe("binary");
    expect(heic.label).toMatch(/HEIC/);
  });

  it("lets the signature win over a wrong extension", () => {
    const d = detect("photo.pdf", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
    expect(d.kind).toBe("image");
    expect(d.by).toBe("signature");
  });

  it("detects MPEG-TS by sync bytes and keeps .ts as TypeScript", () => {
    const ts = new Uint8Array(400);
    ts[0] = ts[188] = ts[376] = 0x47;
    expect(detect("movie.ts", ts).kind).toBe("video");
    const code = detect("app.ts", text("export const x: number = 1;\n"));
    expect(code.kind).toBe("text");
    expect(code.language).toBe("typescript");
  });
});

describe("detect ZIP containers", () => {
  const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 0 });

  it("classifies OOXML and EPUB by their parts, not their names", () => {
    expect(detect("noext", zip({ "[Content_Types].xml": "<x/>", "word/document.xml": "<w/>" })).kind).toBe("docx");
    expect(detect("noext", zip({ "[Content_Types].xml": "<x/>", "xl/workbook.xml": "<w/>" })).kind).toBe("sheet");
    expect(detect("noext", zip({ "[Content_Types].xml": "<x/>", "ppt/presentation.xml": "<p/>" })).kind).toBe("pptx");
    expect(detect("book.zip", zip({ mimetype: "application/epub+zip", "META-INF/container.xml": "<c/>" })).kind).toBe("epub");
    expect(detect("plain.zip", zip({ "a.txt": "hello" })).kind).toBe("zip");
  });

  it("falls back to an Office extension when local headers do not reveal the type", () => {
    expect(detect("deck.pptx", zip({ "a.bin": "x" })).kind).toBe("pptx");
  });

  it("lists local header names", () => {
    expect(zipLocalNames(zip({ "a.txt": "1", "b/c.txt": "2" }))).toEqual(["a.txt", "b/c.txt"]);
    expect(classifyZipEntries(["META-INF/container.xml", "OEBPS/content.opf"])).toBe("epub");
  });
});

describe("detect legacy Office (CFB)", () => {
  const cfb = (...extra: number[]) => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...extra]);
  it("routes .xls to the sheet viewer and .doc/.ppt to legacy", () => {
    expect(detect("old.xls", cfb()).kind).toBe("sheet");
    expect(detect("old.doc", cfb()).kind).toBe("legacy-office");
    expect(detect("old.ppt", cfb()).label).toMatch(/PowerPoint/);
  });
});

describe("detect by extension and content", () => {
  it("uses extensions for text-like and media types", () => {
    expect(detect("notes.md", text("# hi")).kind).toBe("markdown");
    expect(detect("data.csv", text("a,b\n1,2")).kind).toBe("sheet");
    expect(detect("main.py", text("print(1)")).language).toBe("python");
    expect(detect("song.mp3", new Uint8Array(0)).kind).toBe("audio");
  });

  it("guesses JSON, SVG, text and binary from content", () => {
    expect(detect("noext", text('{"a": [1, 2]}')).kind).toBe("json");
    expect(detect("noext", text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')).kind).toBe("image");
    expect(detect("noext", text("just words\nand more")).kind).toBe("text");
    expect(detect("noext", bytes(0, 1, 2, 3, 0, 255)).kind).toBe("binary");
  });

  it("shows a text file with a media extension as text", () => {
    expect(detect("fake.png", text("this is not a png")).kind).toBe("text");
  });
});

describe("looksLikeText", () => {
  it("accepts UTF-8 cut mid-character and Latin-1, rejects NUL bytes", () => {
    const euro = text("price: 10€");
    expect(looksLikeText(euro.subarray(0, euro.length - 1))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe(true);
  });
});

describe("detect view specs", () => {
  const empty = new Uint8Array(0);

  it("detects .uview.json as viewspec", () => {
    expect(detect("x.uview.json", empty).kind).toBe("viewspec");
  });

  it("detects .UVIEW.JSON case-insensitively as viewspec", () => {
    expect(detect("X.UVIEW.JSON", empty).kind).toBe("viewspec");
  });

  it("detects .json as json", () => {
    expect(detect("x.json", empty).kind).toBe("json");
  });

  it("detects uview.json without dot prefix part as json", () => {
    expect(detect("uview.json", empty).kind).toBe("json");
  });
});
