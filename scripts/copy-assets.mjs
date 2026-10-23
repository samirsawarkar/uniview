// Copy pdf.js runtime data into public/ so PDFs render offline (CMaps, standard fonts, wasm decoders, ICC).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
// Liberation fonts are GPL-2.0 with a font exception, which conflicts with app-store distribution; without them
// pdf.js substitutes system fonts for the few non-embedded Arial/Times-style fonts. Foxit fonts (BSD) stay.
const excluded = (p) => /^(Liberation.*\.ttf|LICENSE_LIBERATION)$/i.test(basename(p));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true, filter: (p) => !excluded(p) });
}
console.log("pdf.js assets copied to public/pdfjs");

mkdirSync(join(root, 'public', 'licenses', 'emf-converter'), { recursive: true });
cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(root, 'public', 'licenses', 'THIRD_PARTY_NOTICES.md'));
cpSync(join(root, 'node_modules', 'emf-converter', 'LICENSE'), join(root, 'public', 'licenses', 'emf-converter', 'LICENSE.txt'));
cpSync(join(root, 'node_modules', 'emf-converter', 'THIRD_PARTY_NOTICES'), join(root, 'public', 'licenses', 'emf-converter', 'THIRD_PARTY_NOTICES.txt'));
