// Copy pdf.js runtime data into public/ so PDFs render offline (CMaps, standard fonts, wasm decoders, ICC).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(src, dir), join(dest, dir), { recursive: true });
console.log("pdf.js assets copied to public/pdfjs");
