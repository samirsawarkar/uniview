# Third-party notices

UniView bundles the following open-source software. All are under permissive licences; none is GPL, AGPL or LGPL. Full licence texts are in each package under `node_modules/<package>/LICENSE` and are shipped inside the desktop app's `app.asar`.

| Component | Version | Licence | Used for |
|---|---|---|---|
| React, React DOM | 19.3.1 | MIT | User interface |
| pdf.js (`pdfjs-dist`) | 6.4.299 | Apache-2.0 | PDF rendering |
| pdf.js CMaps | via pdf.js | BSD-3-Clause (Adobe) | PDF text in CJK fonts |
| pdf.js standard fonts (Foxit only) | via pdf.js | BSD-3-Clause (Foxit/PDFium) | Fonts for PDFs that do not embed them. The GPL-licensed Liberation fonts are deliberately excluded. |
| OpenJPEG decoder (`openjpeg.wasm`) | via pdf.js | BSD-2-Clause | JPEG 2000 images in PDFs |
| JBIG2 decoder (`jbig2.wasm`) | via pdf.js | Apache-2.0 / BSD-3-Clause | JBIG2 images in PDFs |
| QCMS (`qcms_bg.wasm`) | via pdf.js | MIT | Colour management in PDFs |
| docx-preview | 0.4.1 | Apache-2.0 | Word documents |
| JSZip (dependency of docx-preview) | 3.10.x | MIT **(elected; dual MIT / GPL-3.0-or-later)** | Reading .docx packages |
| SheetJS Community Edition (`xlsx`) | 0.20.3 (cdn.sheetjs.com) | Apache-2.0 | Spreadsheets |
| marked | 18.1.1 | MIT | Markdown |
| DOMPurify | 3.4.17 | Apache-2.0 **(elected; dual MPL-2.0 / Apache-2.0)** | HTML sanitizing |
| highlight.js | 11.12.0 | BSD-3-Clause | Syntax highlighting |
| fflate | 0.8.3 | MIT | ZIP reading |
| UTIF2 | 4.1.0 | MIT | TIFF decoding |
| emf-converter | 4.23.1 | Apache-2.0, with bundled decoder notices | EMF/WMF pictures in presentations |
| Electron | 45.0.0 | MIT (Chromium: BSD-3-Clause and others, see `LICENSES.chromium.html` in the app folder) | Desktop shell |
| Capacitor (core, Android, iOS) | 8.5.3 | MIT | Mobile shells |
| AndroidX, Kotlin standard library (via Capacitor) | — | Apache-2.0 | Android runtime |

UniView elects the permissive option for each dual-licensed component as recorded above.

The distributed `licenses/emf-converter/` directory contains the converter's Apache-2.0 licence and its complete bundled third-party notices, including jpeg-js (BSD), gifuct-js, js-binary-schema-parser, UTIF and pako (MIT), and the Independent JPEG Group notices. The optional second PowerPoint engine (@aiden0z/pptx-renderer, which bundles the MPL-2.0 component mtx-decompressor) is NOT bundled in V1; per CEO decision (2026-10-25), it is deferred to V1.1 as an isolated chunk. No copyleft or MPL-2.0 software is bundled in the shipped V1 build.

Development-only tools (not shipped): Vite, Vitest, Playwright, TypeScript, jsdom, electron-builder, @types packages. With the exception of lightningcss (MPL-2.0, a dev-only Vite build tool that is not distributed in shipped builds), all are MIT or Apache-2.0; see `.aes/scout/scout-080e764a.md` for the verification table.
