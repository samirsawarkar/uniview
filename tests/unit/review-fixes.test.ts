// Regression tests for the Codex review (aes run aes-2c1b389d7adb).
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { isUtf8, looksLikeText } from "../../src/core/detect";
import { ZipPackage } from "../../src/core/zip";
import { CorruptFileError } from "../../src/core/errors";
import { chapterHtml, parseEpub } from "../../src/core/epub";

describe("isUtf8 (finding 5)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it("accepts short complete Unicode text", () => {
    expect(isUtf8(enc("éabc"), true)).toBe(true);
    expect(isUtf8(enc("日本"), true)).toBe(true);
  });
  it("forgives only a sequence cut at the end of a prefix", () => {
    const e = enc("ab日");
    expect(isUtf8(e.subarray(0, e.length - 1), false)).toBe(true);
    expect(isUtf8(e.subarray(0, e.length - 1), true)).toBe(false);
  });
  it("rejects Latin-1 bytes", () => {
    expect(isUtf8(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20]), true)).toBe(false);
    expect(looksLikeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20]))).toBe(true);
  });
});

describe("ZipPackage total budget (finding 3)", () => {
  it("refuses to inflate past the package budget before allocating", () => {
    const big = new Uint8Array(400_000); // compresses to almost nothing
    const data = zipSync({ "a.bin": big, "b.bin": big, "c.bin": big }, { level: 9 });
    const pkg = new ZipPackage(data, 1_000_000);
    expect(pkg.bytesOf("a.bin")!.length).toBe(400_000);
    expect(pkg.bytesOf("b.bin")!.length).toBe(400_000);
    expect(() => pkg.bytesOf("c.bin")).toThrow(CorruptFileError);
    // cached parts are free to read again
    expect(pkg.bytesOf("a.bin")!.length).toBe(400_000);
  });
});

describe("EPUB stylesheet cannot inject markup (finding 6)", () => {
  it("keeps hostile CSS inside the style element", () => {
    const chapter = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style><![CDATA[p{color:red}</style><h1 id="injected">pwned</h1><style>]]></style></head><body><p>ok</p></body></html>`;
    const book = parseEpub(
      zipSync({
        mimetype: strToU8("application/epub+zip"),
        "META-INF/container.xml": strToU8(`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`),
        "c.opf": strToU8(`<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`),
        "a.xhtml": strToU8(chapter),
      }),
    );
    const html = chapterHtml(book, "a.xhtml", () => undefined);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.getElementById("injected")).toBeNull();
    expect(doc.body.textContent).toContain("ok");
    expect(doc.body.textContent).not.toContain("pwned");
  });
});
