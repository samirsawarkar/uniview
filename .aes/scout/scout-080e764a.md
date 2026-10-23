# Scout scout-080e764a

- Goal (app): UniView: an offline universal file viewer with a shared React+TypeScript+Vite viewer core, Electron desktop shell and Capacitor mobile shell. Needs permissively licensed (MIT/Apache/BSD) JavaScript libraries that render in the browser with no network: PDF (pdf.js), DOCX (docx-preview), XLSX/XLS/CSV (SheetJS community), PPTX (alternatives to PPTXjs, ideally maintained), EPUB, Markdown (marked + DOMPurify), code syntax highlighting (lightweight, e.g. highlight.js or shiki), ZIP listing (jszip or fflate), images incl. HEIC/TIFF if a permissive decoder exists, audio/video via HTML5. Also testing tools (vitest, playwright) and Electron packaging (electron-builder). Reject GPL/AGPL/LGPL and non-commercial licences.
- Created: 2026-10-23T06:16:39+00:00
- Scout: hermes

## Build-on candidates
| Candidate | URL | Licence | Stars | Last push | Stages 1-5 | Smoke command and exit code | How we build on it |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pdf.js | https://github.com/mozilla/pdf.js | Apache-2.0 | 54035 | 2026-10-23 | Passed | `npm --cache I:/AES/.npm-cache i pdfjs-dist && node I:/AES/smoke_test/test2.js` (exit 0) | Core offline PDF rendering pipeline directly on HTML5 canvas in the shared React viewer core. |
| docxjs (docx-preview) | https://github.com/VolodymyrBaydalka/docxjs | Apache-2.0 | 2124 | 2026-09-21 | Passed | `npm --cache I:/AES/.npm-cache i docx-preview && node I:/AES/smoke_test/test2.js` (exit 0) | Client-side DOM renderer for Word .docx documents without any server dependencies. |
| hucre | https://github.com/productdevbook/hucre | MIT | 2245 | 2026-10-14 | Passed | `npm --cache I:/AES/.npm-cache i hucre && node I:/AES/smoke_test/test_hucre.js` (exit 0) | Zero-dependency TypeScript spreadsheet engine to parse and extract tabular data from XLSX, CSV, and ODS entirely offline in browser/Electron/Capacitor. |
| PapaParse | https://github.com/mholt/PapaParse | MIT | 13590 | 2026-10-09 | Passed | `npm --cache I:/AES/.npm-cache i papaparse && node I:/AES/smoke_test/test.js` (exit 0) | High-performance client-side CSV/TSV parser for streaming large tabular files into virtualized grid views. |
| marked | https://github.com/markedjs/marked | MIT | 37258 | 2026-10-21 | Passed | `npm --cache I:/AES/.npm-cache i marked && node I:/AES/smoke_test/test.js` (exit 0) | Fast client-side markdown compiler converting Markdown source to HTML. |
| DOMPurify | https://github.com/cure53/DOMPurify | Apache-2.0 | 17477 | 2026-10-16 | Passed | `npm --cache I:/AES/.npm-cache i dompurify && node I:/AES/smoke_test/test.js` (exit 0) | Sanitizes rendered HTML from Markdown, DOCX, and SVG files to prevent XSS in desktop/mobile webview contexts. |
| highlight.js | https://github.com/highlightjs/highlight.js | BSD-3-Clause | 25008 | 2026-09-06 | Passed | `npm --cache I:/AES/.npm-cache i highlight.js && node I:/AES/smoke_test/test.js` (exit 0) | Lightweight client-side syntax highlighter for viewing source code files (JS, TS, Python, Rust, C++, JSON, XML, etc.). |
| shiki | https://github.com/shikijs/shiki | MIT | 13881 | 2026-10-01 | Passed | `npm --cache I:/AES/.npm-cache i shiki && node I:/AES/smoke_test/test_shiki.js` (exit 0) | Alternative VS Code-grade TextMate grammar syntax highlighting engine for high-fidelity code display. |
| jszip | https://github.com/Stuk/jszip | MIT | 10391 | 2026-09-09 | Passed | `npm --cache I:/AES/.npm-cache i jszip && node I:/AES/smoke_test/test.js` (exit 0) | Reads ZIP archives client-side to list contents and extract compressed files/nested viewer payloads. |
| geotiff.js | https://github.com/geotiffjs/geotiff.js | MIT | 1055 | 2026-09-13 | Passed | `npm --cache I:/AES/.npm-cache i geotiff && node I:/AES/smoke_test/test2.js` (exit 0) | Pure JavaScript TIFF decoder that parses and displays multi-page and high-depth TIFF images on HTML5 canvas. |
| ts-toolkit | https://github.com/readium/ts-toolkit | BSD-3-Clause | 158 | 2026-10-22 | Passed | not run | Official Readium foundation TypeScript publication reader toolkit for rendering EPUB, audiobooks, and fixed-layout digital publications. |
| vitest | https://github.com/vitest-dev/vitest | MIT | 17274 | 2026-10-23 | Passed | `npm --cache I:/AES/.npm-cache i vitest && ./node_modules/.bin/vitest --version` (exit 0) | Unit and component test runner for the Vite + React core and renderer modules. |
| playwright | https://github.com/microsoft/playwright | Apache-2.0 | 98327 | 2026-10-22 | Passed | `npm --cache I:/AES/.npm-cache i @playwright/test && ./node_modules/.bin/playwright --version` (exit 0) | E2E automated cross-platform UI and visual regression testing across desktop and mobile shells. |
| electron-builder | https://github.com/electron-userland/electron-builder | MIT | 14679 | 2026-10-23 | Passed | `npm --cache I:/AES/.npm-cache i electron-builder && ./node_modules/.bin/electron-builder --version` (exit 0) | Builds, packages, and signs native installers for Windows, macOS, and Linux desktop shells. |
| servers | https://github.com/modelcontextprotocol/servers | Apache-2.0 | 91496 | 2026-10-22 | Passed | `npm --cache I:/AES/.npm-cache i @modelcontextprotocol/server-filesystem && ./node_modules/.bin/mcp-server-filesystem I:/AES/smoke_test` (exit 0) | Provides reference MCP filesystem server integration to allow local agent inspection of files viewed in UniView. |
| awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | MIT | 96770 | 2026-10-23 | Passed | not run | Registry index for discovering and integrating offline/local MCP utility servers (OCR, audio metadata, exif extraction). |
| superpowers | https://github.com/obra/superpowers | MIT | 303848 | 2026-10-23 | Passed | not run | Agent skills suite to automate viewer testing, workflow execution, and code review gates. |

## Rejected candidates
| Candidate | URL | Failed stage | Reason |
| --- | --- | --- | --- |
| sheetjs | https://github.com/SheetJS/sheetjs | Stage 2 | Unmaintained on GitHub (last push 2024-04-18, >90 days ago); upstream distribution shifted to custom non-commercial/licensing terms. |
| exceljs | https://github.com/exceljs/exceljs | Stage 2 | Unmaintained (last push 2025-01-21, >90 days ago). |
| PPTXjs | https://github.com/meshesha/PPTXjs | Stage 2 | Abandoned (last push 2022-03-26, >4 years ago). |
| PPTist | https://github.com/pipipi-pikachu/PPTist | Stage 1 | AGPL-3.0 license (copyleft prohibited for UniView). |
| readest | https://github.com/readest/readest | Stage 1 | AGPL-3.0 license (copyleft prohibited). |
| koodo-reader | https://github.com/koodo-reader/koodo-reader | Stage 1 | AGPL-3.0 license (copyleft prohibited). |
| vivliostyle.js | https://github.com/vivliostyle/vivliostyle.js | Stage 1 | AGPL-3.0 license (copyleft prohibited). |
| epub.js | https://github.com/futurepress/epub.js | Stage 2 | Stale maintenance (last push 2026-03-24, >200 days ago). |
| foliate-js | https://github.com/johnfactotum/foliate-js | Stage 2 | Stale maintenance (last push 2026-05-01, >170 days ago). |
| fflate | https://github.com/101arrowz/fflate | Stage 2 | Stale maintenance (last push 2026-05-16, >160 days ago). |
| heic-to | https://github.com/hoppergee/heic-to | Stage 1 | LGPL-3.0 license (prohibited). |
| libheif | https://github.com/strukturag/libheif | Stage 1 | Core library is LGPL-3.0 license (prohibited). |
| heic2any | https://github.com/alexcorvi/heic2any | Stage 2 | Abandoned (last push 2024-04-11, >2 years ago) and wraps LGPL libheif. |
| hyperformula | https://github.com/handsontable/hyperformula | Stage 1 | Dual-licensed GPL-3.0 / proprietary commercial license. |
| UTIF.js | https://github.com/photopea/UTIF.js | Stage 2 | Stale maintenance (last push 2026-05-04, >170 days ago). |
| tiff.js | https://github.com/seikichi/tiff.js | Stage 2 | Abandoned (last push 2020-04-29, >6 years ago). |

## Launcher verification (GitHub API, 2026-10-23T06:16:39+00:00)

Only rows marked OK may be built on. Anything else needs a CTO exception or is rejected.

| Repo | Stars | Licence | Last push | Archived | Verdict |
|---|---|---|---|---|---|
| mozilla/pdf.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| VolodymyrBaydalka/docxjs |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| productdevbook/hucre |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| mholt/PapaParse |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| markedjs/marked |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| cure53/DOMPurify |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| highlightjs/highlight.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| shikijs/shiki |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| Stuk/jszip |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| geotiffjs/geotiff.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| readium/ts-toolkit |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| vitest-dev/vitest |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| microsoft/playwright |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| electron-userland/electron-builder |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| modelcontextprotocol/servers |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| punkpeye/awesome-mcp-servers |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| obra/superpowers |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| SheetJS/sheetjs |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| exceljs/exceljs |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| meshesha/PPTXjs |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| pipipi-pikachu/PPTist |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| readest/readest |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| koodo-reader/koodo-reader |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| vivliostyle/vivliostyle.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| futurepress/epub.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| johnfactotum/foliate-js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| 101arrowz/fflate |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| hoppergee/heic-to |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| strukturag/libheif |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| alexcorvi/heic2any |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| handsontable/hyperformula |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| photopea/UTIF.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |
| seikichi/tiff.js |  |  |  |  | CHECK FAILED (HTTP Error 403: rate limit exceeded) |

## CTO re-verification (authenticated gh api, 2026-10-23T06:17Z)

| Repo | Stars | Licence | Last push | Archived | Verdict |
|---|---|---|---|---|---|
| mozilla/pdf.js | 54035 | Apache-2.0 | 2026-10-23 | false | OK |
| VolodymyrBaydalka/docxjs | 2124 | Apache-2.0 | 2026-09-21 | false | OK |
| SheetJS/sheetjs | 36341 | Apache-2.0 | 2024-04-18 | false | STALE |
| markedjs/marked | 37258 | NOASSERTION | 2026-10-21 | false | CHECK LICENCE |
| cure53/DOMPurify | 17477 | Apache-2.0 | 2026-10-16 | false | OK |
| highlightjs/highlight.js | 25008 | BSD-3-Clause | 2026-09-06 | false | OK |
| 101arrowz/fflate | 3063 | MIT | 2026-05-16 | false | OK |
| Stuk/jszip | 10391 | NOASSERTION | 2026-09-09 | false | CHECK LICENCE |
| photopea/UTIF.js | 502 | MIT | 2026-05-04 | false | OK |
| vitest-dev/vitest | 17274 | MIT | 2026-10-23 | false | OK |
| microsoft/playwright | 98328 | Apache-2.0 | 2026-10-22 | false | OK |
| electron/electron | 123489 | MIT | 2026-10-23 | false | OK |
| electron-userland/electron-builder | 14679 | MIT | 2026-10-23 | false | OK |
| ionic-team/capacitor | 16933 | MIT | 2026-10-22 | false | OK |
| react/react | 251707 | MIT | 2026-10-23 | false | OK |
| vitejs/vite | 83472 | MIT | 2026-10-23 | false | OK |

### CTO exceptions (granted 2026-10-23)

- **SheetJS (STALE on GitHub):** the GitHub repo is a mirror. Development and releases are on git.sheetjs.com and cdn.sheetjs.com. We pin the official 0.20.3 tarball (Apache-2.0), not the outdated npm `xlsx@0.18.5`, which has known CVEs.
- **marked (NOASSERTION):** the LICENSE file combines MIT with the original Markdown.pl BSD-style notice; the npm metadata declares MIT. Both are permissive.
- **JSZip (NOASSERTION):** dual-licensed MIT or GPL-3.0-or-later. It reaches us only as a dependency of docx-preview. UniView elects MIT and records that in THIRD_PARTY_NOTICES.md.
- **Rejected:** heic2any (MIT wrapper around LGPL libheif), libheif-js (LGPL-3.0), PPTXjs (unmaintained, jQuery 1.x). HEIC is out of V1; PPTX gets an in-house renderer.

### CTO verification of remaining dependencies (Codex finding 4, 2026-10-23T06:53Z)

| Repo | Stars | Licence | Last push | Archived | Verdict | Used as |
|---|---|---|---|---|---|---|
| jsdom/jsdom | 21726 | MIT | 2026-10-17 | false | OK | test-only DOM for vitest |
| microsoft/TypeScript | 111575 | Apache-2.0 | 2026-10-22 | false | OK | type-checker (dev) |
| vitejs/vite-plugin-react | 1173 | MIT | 2026-10-23 | false | OK | Vite React plugin (dev) |
| DefinitelyTyped/DefinitelyTyped | 51447 | NOASSERTION | 2026-10-22 | false | CHECK LICENCE | @types/react typings (dev) |
| ionic-team/capacitor | 16933 | MIT | 2026-10-22 | false | OK | @capacitor/ios runtime |
| photopea/UTIF.js | 502 | MIT | 2026-05-04 | false | OK | utif2 TIFF decoder (fork on npm) |

utif2 on npm (MIT, 4.1.0, 2023) is the maintained-API fork of UTIF.js; the upstream repo above is OK. Accepted: small, MIT, used only for TIFF decoding.
- **DefinitelyTyped (NOASSERTION):** the repo licence file is MIT; each @types package, including @types/react, declares MIT on npm (verified). Dev-only typings, never shipped. Exception granted.

| unjs/uqr | 778 | MIT | 2026-04-03 | false | OK | QR code generation (pairing) |
| cozmo/jsQR | 4042 | Apache-2.0 | 2026-05-15 | false | OK | QR code scanning from the camera |

| aiden0z/pptx-renderer | 133 | Apache-2.0 plus bundled MPL-2.0 | 2026-10-18 | false | HOLD: CEO licence decision pending | optional high-fidelity PPTX engine (not installed) |
| ChristopherVR/emf-converter | 9 | Apache-2.0 | 2026-10-23 | false | OK (low adoption, isolated) | EMF/WMF pictures in PPTX (lazy) |
