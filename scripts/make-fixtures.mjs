// Generate one valid file per supported format (plus broken ones) into fixtures/generated/.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import UTIF from "utif2";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { makeDocx, makeEpub, makePdf, makePng, makePptx, makeZip } from "./fixture-builders.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "generated");
mkdirSync(out, { recursive: true });
const write = (name, data) => writeFileSync(join(out, name), data);

function wav(seconds = 1, rate = 8000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

function legacyDoc() {
  // A CFB signature followed by UTF-16LE text, enough for detection and string recovery.
  const head = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const body = Buffer.from("\0\0WordDocument\0\0Minutes of the annual meeting\0\0Budget approved unanimously\0", "utf16le");
  return Buffer.concat([head, Buffer.alloc(504), body, Buffer.alloc(512)]);
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Region", "Q1", "Q2"], ["North", 1204, 1310], ["South", 980, 1022], ["Café", 12.5, 13]]), "Sales");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item", "Owner"], ["Launch", "Samir"]]), "Plan");
const big = [["id", "name", "value"]];
for (let i = 1; i <= 50000; i++) big.push([i, `row ${i}`, i * 3]);
const wbBig = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbBig, XLSX.utils.aoa_to_sheet(big), "Big");

write("report.pdf", makePdf("Hello from UniView"));
write("charter.docx", makeDocx());
write("deck.pptx", makePptx());
write("sales.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
write("big.xlsx", XLSX.write(wbBig, { type: "buffer", bookType: "xlsx" }));
write("people.csv", "name,city,score\nAnna,Zürich,91\nBo,Ōsaka,88\n");
write("book.epub", makeEpub());
write("bundle.zip", makeZip());
write("notes.md", "# Release notes\n\n- **Fast** start\n- Works offline\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>\n");
write("data.json", JSON.stringify({ name: "UniView", formats: ["pdf", "docx", "pptx"], nested: { ok: true, n: 3 } }, null, 2));
write("app.ts", "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n");
write("pixel.png", makePng(320, 200, [37, 99, 235]));
write("shape.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" rx="16" fill="#16a34a"/><text x="100" y="70" font-size="28" text-anchor="middle" fill="#fff">SVG</text><script>window.hacked=1</script></svg>');
write("tone.wav", wav());
write("minutes.doc", legacyDoc());
write("broken.pdf", "%PDF-1.7\nthis is not really a pdf\n%%EOF\n");
write("broken.docx", Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64, 7)]));
write("random.bin", Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
write("empty.txt", "");
write("broken.zip", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 0x41)]));
const rgba = new Uint8Array(64 * 48 * 4);
for (let i = 0; i < 64 * 48; i++) rgba.set([234, 88, 12, 255], i * 4);
write("photo.tif", Buffer.from(UTIF.encodeImage(rgba, 64, 48)));
// Test-only font from pdf.js's bundled standard fonts; the generated folder is never committed or shipped.
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "pdfjs-dist", "standard_fonts", "LiberationSans-Regular.ttf"), join(out, "sans.ttf"));
write("unicode.txt", "éà – naïve café 日本語\n");
console.log(`fixtures written to ${out}`);
