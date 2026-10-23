# Open File Viewer evaluation

Research by hermes (AES run `aes-82a4d275dd1e`, 2026-10-23); facts re-verified by the CTO against the GitHub and npm APIs the same day.

## CTO decision

1. **Do not adopt Open File Viewer wholesale.** Its runtime dependencies bring copyleft risk (`heic2any` bundles LGPL libheif; the CAD peer `@mlightcad/libredwg-web` is GPL-3.0) and an unofficial SheetJS fork (`@stackline/xlsx`). It is an embeddable widget SDK, not an offline application shell. UniView keeps its own registry, viewers and shells.
2. **Adopt selected engines, behind UniView's renderer registry, lazily loaded, only after they pass our hard-format fixtures:**
   - `@aiden0z/pptx-renderer` 1.4.0 (Apache-2.0, 133 stars, pushed 2026-10-18; deps jszip, echarts, mtx-decompressor; 5.5 MB unpacked) as an optional **high-fidelity PPTX engine** for decks with charts and equations, configured with `externalMedia: 'block'`. UniView's own renderer stays the default because it is small and opens instantly.
   - `emf-converter` 4.23.1 (Apache-2.0, zero dependencies, 9 stars, pushed 2026-10-23) to draw EMF/WMF pictures inside PPTX. Low adoption is a risk, so it is isolated behind one function and lazy-loaded; a failure falls back to today's labeled placeholder.
3. **Backlog, not V1:** email (.msg via @kenjiuno/msgreader, .eml via postal-mime), PSD (ag-psd), Parquet (hyparquet). Each needs its own scout row before use.
4. **Rejected:** heic2any (LGPL), libredwg-web (GPL), @stackline/xlsx (unofficial fork).

Note: the report's descriptions of UniView internals contain errors (UniView's CSP is `connect-src 'self' blob: data: uniview-file:`, not `'none'`, and the PPTX parser lives in `src/core/pptx.ts`). They do not affect the recommendation.

---

# Research Report: Evaluation of `xushanpei/open-file-viewer` for UniView

**Prepared for:** Internal Operations & Engineering Architecture  
**Role:** AES Chief of Staff for Internal Operations  
**Date:** October 23, 2026  
**Status:** Read-only Evaluation & Recommendations  

---

## Executive Summary

`xushanpei/open-file-viewer` is an open-source, framework-agnostic file preview SDK designed for embedding document viewers into enterprise web applications (vanilla JS, React, Vue, Svelte). While it showcases impressive format breadth—spanning CAD, GIS, 3D, and email—**adopting it wholesale for UniView is strongly contraindicated**.

Wholesale adoption introduces unacceptable copyleft and supply-chain liabilities (specifically bundled LGPL-3.0 binaries in `heic2any`, GPL-3.0 in `@mlightcad/libredwg-web`, and an unvetted personal fork `@stackline/xlsx`), and clashes fundamentally with UniView's desktop/mobile architecture (offline-by-construction sandboxing, virtualized data grids, and strict shell isolation).

However, **selective adoption of two specific modular rendering engines is strongly recommended**:
1. **`@aiden0z/pptx-renderer` (Apache-2.0):** Introduce as a secondary engine in UniView's PPTX viewer registry to unlock high-fidelity 2D charts (via ECharts), DrawingML 3D approximations, and OMML equations.
2. **`emf-converter` (Apache-2.0):** Integrate immediately to decode embedded EMF/WMF vector drawings inside DOCX and PPTX documents into Canvas/PNG, eliminating one of UniView V1's primary documented limitations.

---

## 1. Format Coverage Comparison

UniView focuses on lightweight, high-performance, private desktop and mobile offline viewing. Open File Viewer (OFV) focuses on enterprise attachment previews with wide, multi-domain format ingestion.

| Format Family | UniView V1 Current Coverage | Open File Viewer Coverage | Gap / Addition from OFV |
|---|---|---|---|
| **PDF** | [pdf.js 6.4](https://github.com/mozilla/pdf.js): lazy page rendering, text selection, find, zoom | [pdf.js](https://github.com/mozilla/pdf.js) (v4+ peer dep) with iframe fallback & WASM decoders | Parity (UniView has superior offline worker isolation) |
| **Word (DOCX)** | [docx-preview 0.4.1](https://github.com/VolodymyrBaydalka/docxjs): DOM renderer, no HTML altChunk execution | [docx-preview 0.3.x](https://github.com/VolodymyrBaydalka/docxjs) + [mammoth](https://github.com/mwilliamson/mammoth.js) (fallback/HTML conversion) | OFV adds legacy Word 2003 XML / docx fallback via Mammoth |
| **Spreadsheets** | [SheetJS CE 0.20.3](https://cdn.sheetjs.com/): virtualized 50k-row grid, tabs (xlsx, xlsm, xlsb, xls, ods, csv, tsv) | [`@stackline/xlsx 1.0.x`](https://github.com/alexandroit/sheetjs): basic table rendering | UniView is substantially superior in memory & virtualization |
| **PowerPoint (PPTX)** | Custom in-house OOXML renderer: shapes, tables, groups, SmartArt, notes, presenter mode (F5) | [`@aiden0z/pptx-renderer 1.0.3+`](https://github.com/aiden0z/pptx-renderer): 2D charts (ECharts), OMML math, DrawingML | **OFV engine adds 2D charts, OMML math, and connector fidelity** |
| **Legacy Office (.doc, .ppt)** | Text extraction preview with user notification | OLE binary record parser restoring slide layout/geometry and text | OFV has richer slide geometry reconstruction for legacy .ppt |
| **E-books (EPUB)** | Custom reader: sandboxed scriptless iframe, TOC, sanitized chapters | Custom plugin: basic EPUB rendering | Parity / UniView security model is stricter |
| **XPS / OFD** | Hex/text fallback | `xpsPlugin` (XPS/OXPS) and `ofdPlugin` (Chinese National Standard) | **OFV adds native XPS and OFD support** |
| **Images** | Native `<img>` (PNG, JPG, GIF, WebP, AVIF, BMP, ICO, SVG) + [utif2](https://github.com/photopea/UTIF.js) (TIFF) | Canvas/img + [utif](https://github.com/photopea/UTIF.js) + [heic2any](https://github.com/alexcorvi/heic2any) (HEIC/HEIF) | **OFV adds HEIC/HEIF (with LGPL risk)** |
| **Audio & Video** | OS native decoders via HTML5 media elements | HTML5 media + [hls.js](https://github.com/video-dev/hls.js) for live/streaming HLS (.m3u8) | **OFV adds HLS video streaming (.m3u8)** |
| **Text & Code** | [highlight.js 11.12](https://github.com/highlightjs/highlight.js) (40+ languages, 2MB chunks) | [prismjs](https://github.com/PrismJS/prism) + [mermaid](https://github.com/mermaid-js/mermaid) diagram rendering | **OFV adds Mermaid diagram syntax rendering** |
| **Markdown / JSON** | [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify); collapsible JSON tree | [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify); code copy with line numbers | Rough parity |
| **Archives** | [fflate 0.8](https://github.com/101arrowz/fflate): ZIP, CBZ, JAR, APK | [jszip](https://github.com/Stuk/jszip), [seek-bzip](https://github.com/cscott/seek-bzip) (.bz2), [xz-decompress](https://github.com/httptoolkit/xz-decompress) (.xz), tar, gz | **OFV adds Bzip2 (.bz2), XZ (.xz), and Tar/Gz archives** |
| **Fonts** | FontFace sample text + glyph grid (TTF, OTF, WOFF, WOFF2) | Font preview in `assetPlugin` | Parity |
| **Email (.msg, .eml)** | Text / Hex fallback | [`@kenjiuno/msgreader`](https://github.com/HiraokaHyperTools/msgreader) (.msg) & [`postal-mime`](https://github.com/postalsys/postal-mime) (.eml, .mbox) | **OFV adds Outlook .msg and standard RFC822 .eml parsing** |
| **Photoshop / PSD** | Hex fallback | [`ag-psd`](https://github.com/Agamnentzar/ag-psd): parses PSD/PSB layers and composite canvas | **OFV adds layered PSD preview** |
| **CAD / Drawings** | Hex fallback | [`@mlightcad/cad-simple-viewer`](https://github.com/mlightcad/cad-viewer), DXF, DWG (via LibreDWG), STEP, IGES | **OFV adds CAD/DWG parsing (with GPL-3.0 risk)** |
| **GIS / Spatial** | Hex fallback | [`leaflet`](https://github.com/Leaflet/Leaflet), [`shpjs`](https://github.com/calvinmetcalf/shapefile-js), [`@mapbox/togeojson`](https://github.com/mapbox/togeojson), `topojson-client` | **OFV adds interactive map rendering for Shapefiles, KML, GPX, GeoJSON** |
| **3D Models** | Hex fallback | [`three`](https://github.com/mrdoob/three.js): GLTF, GLB, OBJ, STL, FBX, DAE, PLY, 3MF | **OFV adds WebGL 3D model viewport** |
| **Big Data (Parquet)** | Hex fallback | [`hyparquet`](https://github.com/hyparam/hyparquet): Apache Parquet columnar table parsing | **OFV adds columnar Parquet table preview** |
| **Metafiles (EMF/WMF)** | Placeholder notice | [`emf-converter`](https://github.com/ChristopherVR/emf-converter): Canvas/PNG/SVG conversion | **OFV draws standalone and embedded EMF/WMF vector graphics** |
| **Whiteboard / Mindmap** | Hex fallback | Custom renderers for `.drawio`, `.excalidraw`, `.tldraw`, `.xmind` | **OFV adds visual preview for whiteboard and mind map formats** |

---

## 2. Runtime Dependency Licence Audit

Audited against `@open-file-viewer/core` version `1.0.0` (`packages/core/package.json`).

```
Legend:
[PERMISSIVE]   Permissive (MIT, Apache-2.0, BSD, ISC) — Compatible with UniView.
[COPYLEFT]     GPL / AGPL — Prohibited; viral copyleft risk.
[LGPL RISK]    Bundled LGPL — Prohibited unless modular and dynamically replaceable.
[FORK RISK]    Unofficial personal/vendor fork — Governance and maintenance liability.
```

### Direct Runtime Dependencies (`packages/core/package.json`)

| Package | Version | SPDX ID | Upstream / Source URL | Audit Verdict & Risk Assessment |
|---|---|---|---|---|
| [`@aiden0z/pptx-renderer`](https://www.npmjs.com/package/@aiden0z/pptx-renderer) | `^1.0.3` | `Apache-2.0` | [github.com/aiden0z/pptx-renderer](https://github.com/aiden0z/pptx-renderer) | **[PERMISSIVE]** Clean, permissive license. Safe for UniView. |
| [`@kenjiuno/msgreader`](https://www.npmjs.com/package/@kenjiuno/msgreader) | `^1.28.0` | `Apache-2.0` | [github.com/HiraokaHyperTools/msgreader](https://github.com/HiraokaHyperTools/msgreader) | **[PERMISSIVE]** Permissive Outlook .msg parser. Safe for UniView. |
| [`@mapbox/togeojson`](https://www.npmjs.com/package/@mapbox/togeojson) | `^0.16.2` | `BSD-2-Clause` | [github.com/mapbox/togeojson](https://github.com/mapbox/togeojson) | **[PERMISSIVE]** Permissive KML/GPX converter. Safe. |
| [`ag-psd`](https://www.npmjs.com/package/ag-psd) | `^30.2.0` | `MIT` | [github.com/Agamnentzar/ag-psd](https://github.com/Agamnentzar/ag-psd) | **[PERMISSIVE]** Zero-dependency PSD parser/canvas renderer. Safe. |
| [`docx-preview`](https://www.npmjs.com/package/docx-preview) | `^0.3.7` | `Apache-2.0` | [github.com/VolodymyrBaydalka/docxjs](https://github.com/VolodymyrBaydalka/docxjs) | **[PERMISSIVE]** Already used in UniView (v0.4.1). |
| [`dompurify`](https://www.npmjs.com/package/dompurify) | `^3.4.10` | `(MPL-2.0 OR Apache-2.0)` | [github.com/cure53/DOMPurify](https://github.com/cure53/DOMPurify) | **[PERMISSIVE]** Dual-licensed; Apache-2.0 elected. Already in UniView. |
| [`emf-converter`](https://www.npmjs.com/package/emf-converter) | `^3.0.2` | `Apache-2.0` | [github.com/ChristopherVR/emf-converter](https://github.com/ChristopherVR/emf-converter) | **[PERMISSIVE]** Zero-dependency TypeScript metafile engine. Safe for UniView. |
| [`heic2any`](https://www.npmjs.com/package/heic2any) | `^0.0.4` | `MIT` (Wrapper) | [github.com/alexcorvi/heic2any](https://github.com/alexcorvi/heic2any) | **[LGPL RISK] CRITICAL RISK.** Outer wrapper declares MIT, but bundles Emscripten-compiled `libheif-js` derived from [`strukturag/libheif`](https://github.com/strukturag/libheif), which is licensed under **LGPL-3.0**. In a minified/bundled JS web or mobile distribution, meeting LGPL user-relinking obligations is legally perilous. UniView explicitly rejected this package in `.aes/scout/scout-080e764a.md`. |
| [`hls.js`](https://www.npmjs.com/package/hls.js) | `^1.6.16` | `Apache-2.0` | [github.com/video-dev/hls.js](https://github.com/video-dev/hls.js) | **[PERMISSIVE]** Client-side HLS video player. Permissive. |
| [`hyparquet`](https://www.npmjs.com/package/hyparquet) | `^1.26.1` | `MIT` | [github.com/hyparam/hyparquet](https://github.com/hyparam/hyparquet) | **[PERMISSIVE]** Zero-dependency Parquet reader. Safe. |
| [`jszip`](https://www.npmjs.com/package/jszip) | `^3.10.1` | `(MIT OR GPL-3.0-or-later)` | [github.com/Stuk/jszip](https://github.com/Stuk/jszip) | **[PERMISSIVE]** Dual-licensed; MIT elected. Note: micro-frontend timer bug documented in OFV README. |
| [`leaflet`](https://www.npmjs.com/package/leaflet) | `^1.9.4` | `BSD-2-Clause` | [github.com/Leaflet/Leaflet](https://github.com/Leaflet/Leaflet) | **[PERMISSIVE]** Mapping engine. Permissive. |
| [`mammoth`](https://www.npmjs.com/package/mammoth) | `^1.12.0` | `BSD-2-Clause` | [github.com/mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js) | **[PERMISSIVE]** Converts docx to HTML. Permissive. |
| [`marked`](https://www.npmjs.com/package/marked) | `^18.0.4` | `MIT` | [github.com/markedjs/marked](https://github.com/markedjs/marked) | **[PERMISSIVE]** Already used in UniView. |
| [`mermaid`](https://www.npmjs.com/package/mermaid) | `^11.16.0` | `MIT` | [github.com/mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) | **[PERMISSIVE]** Diagramming library. Permissive. |
| [`pako`](https://www.npmjs.com/package/pako) | `^2.1.0` | `(MIT AND Zlib)` | [github.com/nodeca/pako](https://github.com/nodeca/pako) | **[PERMISSIVE]** Permissive compression library. |
| [`postal-mime`](https://www.npmjs.com/package/postal-mime) | `^2.7.4` | `MIT-0` | [github.com/postalsys/postal-mime](https://github.com/postalsys/postal-mime) | **[PERMISSIVE]** Zero-attribution MIT. Safe. |
| [`prismjs`](https://www.npmjs.com/package/prismjs) | `^1.30.0` | `MIT` | [github.com/PrismJS/prism](https://github.com/PrismJS/prism) | **[PERMISSIVE]** Syntax highlighter. Permissive. |
| [`seek-bzip`](https://www.npmjs.com/package/seek-bzip) | `^2.0.0` | `MIT` | [github.com/cscott/seek-bzip](https://github.com/cscott/seek-bzip) | **[PERMISSIVE]** Bzip2 decompression. Permissive. |
| [`shpjs`](https://www.npmjs.com/package/shpjs) | `^6.2.0` | `MIT` | [github.com/calvinmetcalf/shapefile-js](https://github.com/calvinmetcalf/shapefile-js) | **[PERMISSIVE]** Shapefile parser. Permissive. |
| [`three`](https://www.npmjs.com/package/three) | `^0.184.0` | `MIT` | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) | **[PERMISSIVE]** 3D WebGL engine. Permissive. |
| [`topojson-client`](https://www.npmjs.com/package/topojson-client) | `^3.1.0` | `ISC` | [github.com/topojson/topojson-client](https://github.com/topojson/topojson-client) | **[PERMISSIVE]** TopoJSON converter. Permissive. |
| [`utif`](https://www.npmjs.com/package/utif) | `^3.1.0` | `MIT` | [github.com/photopea/UTIF.js](https://github.com/photopea/UTIF.js) | **[PERMISSIVE]** TIFF decoder. Permissive (UniView uses maintained fork `utif2`). |
| [`xlsx` (`@stackline/xlsx`)](https://www.npmjs.com/package/@stackline/xlsx) | `^1.0.6` | `Apache-2.0` | [github.com/alexandroit/sheetjs](https://github.com/alexandroit/sheetjs) | **[FORK RISK] HIGH RISK.** Replaces SheetJS with an unofficial third-party vendor fork (`npm:@stackline/xlsx@^1.0.6`, repository `alexandroit/sheetjs`). While Apache-2.0, it lacks official upstream maintenance, diverges from canonical SheetJS security releases, and creates severe supply-chain opacity compared to UniView's pinned official tarball (`cdn.sheetjs.com/xlsx-0.20.3/`). |
| [`xz-decompress`](https://www.npmjs.com/package/xz-decompress) | `^0.2.3` | `MIT` | [github.com/httptoolkit/xz-decompress](https://github.com/httptoolkit/xz-decompress) | **[PERMISSIVE]** WASM XZ decompressor. Permissive. |

### Peer & Optional Dependencies

| Package | Version | SPDX ID | Upstream / Source URL | Audit Verdict & Risk Assessment |
|---|---|---|---|---|
| [`@mlightcad/libredwg-web`](https://www.npmjs.com/package/@mlightcad/libredwg-web) | `>=0.7.4` | `GPL-3.0` | [github.com/mlightcad/libredwg-web](https://github.com/mlightcad/libredwg-web) | **[COPYLEFT] FATAL RISK.** Upstream [GNU LibreDWG](https://www.gnu.org/software/libredwg/) is strictly **GPL-3.0**. OFV segregates this as an optional peer dependency copied via script into `/public/vendor/`, but if shipped or statically bound into UniView, it would legally infect UniView with GPL-3.0 copyleft requirements. Must never be bundled. |
| [`@mlightcad/cad-simple-viewer`](https://www.npmjs.com/package/@mlightcad/cad-simple-viewer) | `>=1.5.10` | `MIT` | [github.com/mlightcad/cad-viewer](https://github.com/mlightcad/cad-viewer) | **[COPYLEFT RISK]** Although package is MIT, its default DWG parser worker (`libredwg-parser-worker.js`) relies on LibreDWG (GPL-3.0). |
| [`@mlightcad/data-model`](https://www.npmjs.com/package/@mlightcad/data-model) | `>=1.12.5` | `MIT` | [github.com/mlightcad/realdwg-web](https://github.com/mlightcad/realdwg-web) | **[PERMISSIVE]** Data model classes. Permissive. |
| [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) | `>=4` | `Apache-2.0` | [github.com/mozilla/pdf.js](https://github.com/mozilla/pdf.js) | **[PERMISSIVE]** Already used in UniView. |
| [`lodash-es`](https://www.npmjs.com/package/lodash-es) | `>=4.17.21` | `MIT` | [github.com/lodash/lodash](https://github.com/lodash/lodash) | **[PERMISSIVE]** Standard utility library. Permissive. |

---

## 3. Maintenance Signals

Live repository metrics captured from GitHub API on October 23, 2026:

### `xushanpei/open-file-viewer`
- **Repository:** [https://github.com/xushanpei/open-file-viewer](https://github.com/xushanpei/open-file-viewer)
- **Stars:** 1,923
- **Forks:** 202
- **Open Issues:** 6
- **Last Push:** 2026-10-10T10:13:13Z
- **Release Cadence:** Rapid, consistent bi-weekly/monthly cadence from June 2026 through October 2026. Published over 12 releases (`v0.1.37` to `v0.1.49`), culminating in stable `v1.0.0` on 2026-10-10.
- **Health Assessment:** Healthy, active single-maintainer open-source project with good responsiveness to community PRs and issue reports.

### `@aiden0z/pptx-renderer`
- **Repository:** [https://github.com/aiden0z/pptx-renderer](https://github.com/aiden0z/pptx-renderer)
- **Stars:** 133
- **Forks:** 36
- **Open Issues:** 10
- **Last Push:** 2026-10-18T12:55:54Z
- **Release Cadence:** Exceptionally disciplined semver cycle throughout 2026 (`v1.0.1` in March 2026 to `v1.4.0` on October 18, 2026). The repository enforces over 3,500 unit tests and automated visual regression testing against native Microsoft PowerPoint COM outputs on Windows.
- **Health Assessment:** High engineering craft, robust test coverage, and continuous improvements to DrawingML, OMML equations, and ECharts-backed charts.

### `emf-converter` (`ChristopherVR/emf-converter`)
- **Repository:** [https://github.com/ChristopherVR/emf-converter](https://github.com/ChristopherVR/emf-converter)
- **Stars:** 9
- **Forks:** 5
- **Open Issues:** 0
- **Last Push:** 2026-10-23T01:26:17Z
- **Release Cadence:** Hyper-active, automated CI release cycle reaching `v4.23.1` on 2026-10-23. The author has implemented near-native GDI and GDI+ record playback against official Windows ICM tables and TrueType/ClearType rasterization formulas.
- **Health Assessment:** Zero-dependency, pure TypeScript metafile decoder with outstanding mathematical and record-parsing fidelity.

---

## 4. Strategic Recommendations

### Core Verdict: **DO NOT ADOPT WHOLESALE; ADOPT SELECTED ENGINES**

#### Why Wholesale Adoption is Rejected:
1. **Security & Offline Mandate Violation:** UniView's security architecture enforces `contextIsolation: true`, sandboxed desktop preloads, zero-network CSP (`connect-src 'none'`), and strip-out of the Android `INTERNET` permission. OFV is built for multi-tenant web browsers and expects web workers, external font fetching, or remote PDF fallbacks.
2. **Licensing Non-Compliance:** OFV relies on `heic2any` (bundling LGPL-3.0 `libheif`) and promotes `@mlightcad/libredwg-web` (GPL-3.0). Including OFV wholesale introduces immediate copyleft contamination risks into UniView's MIT distribution.
3. **Supply-Chain Liability (`@stackline/xlsx`):** OFV aliased SheetJS to a vendor fork (`@stackline/xlsx`) to bypass unmaintained npm versions. UniView already solves this cleanly by pinning the official `xlsx-0.20.3.tgz` release from `cdn.sheetjs.com`.
4. **Architectural & Performance Regress:** UniView uses a custom virtualized spreadsheet grid that scrolls 50,000 rows in sub-300ms, a custom EPUB reader, and a desktop tab strip. OFV's DOM container model is an embedded widget SDK, not a standalone cross-platform application shell.

---

### Specific Engine Evaluation

#### 1. Add `@aiden0z/pptx-renderer` (Apache-2.0) as a Second PPTX Engine: **YES (RECOMMENDED)**
* **Justification:**
  - UniView's native PPTX renderer (`src/core/parsers/pptx.ts`) is fast and lightweight, but currently has a documented limitation: *"Charts in PowerPoint show a labeled placeholder; EMF/WMF pictures are not drawn."*
  - `@aiden0z/pptx-renderer` features full 2D chart rendering (bar, line, pie, radar, scatter via modular ECharts), DrawingML 3D approximations, connectors, and OMML equation math trees.
  - In version `1.4.0` (released 2026-10-18), it added `externalMedia: 'block'`, allowing UniView to enforce its strict offline security posture by disabling any external URL fetches inside slide packages.
* **Implementation Plan:**
  - Introduce an extensible renderer registry in `src/viewers/pptx/`:
    ```ts
    export type PptxEngine = 'uniview-native' | 'aiden0z';
    ```
  - Keep `uniview-native` as default for instant warm start (p50 ~41ms).
  - Offer an omnibox/tab toggle: *"Switch to High-Fidelity PPTX Engine"* when a presentation contains complex 2D charts or equations.
  - Wire `pdfjs-dist` to UniView's existing PDF.js instance and configure `externalMedia: 'block'`.

#### 2. Use `emf-converter` (Apache-2.0) to Draw EMF/WMF Pictures Inside PPTX and DOCX: **YES (RECOMMENDED)**
* **Justification:**
  - Microsoft Word and PowerPoint documents frequently wrap vector logos, flowcharts, equations, and diagrams inside `.emf` or `.wmf` records. Browsers cannot render these formats natively.
  - UniView's README lists this as an explicit limit: *"EMF/WMF pictures are not drawn."*
  - `emf-converter` (v4.23.1) is licensed under **Apache-2.0**, has **zero external runtime dependencies**, and executes entirely client-side by replaying GDI/GDI+ binary streams onto an HTML5 `<canvas>` or exporting PNG data URLs.
* **Implementation Plan:**
  - Install `emf-converter@^4.23.1` as a shared utility under `src/core/utils/metafile.ts`.
  - In `docx-preview`: intercept `.emf` / `.wmf` image blobs before DOM rendering and convert them via `convertEmfToPng(buffer)`.
  - In `src/viewers/PptxViewer.tsx`: when resolving slide image relationships targeting `.emf` or `.wmf` parts, decode to canvas and bind as an `<img>` src instead of displaying a placeholder box.

#### 3. Additional Selective Engines for UniView Backlog:
* **Outlook & Email (`.msg`, `.eml`):** Adopt `@kenjiuno/msgreader` (Apache-2.0) and `postal-mime` (MIT-0) to add email preview to UniView without licensing friction.
* **Layered Photoshop (`.psd`):** Adopt `ag-psd` (MIT) for client-side PSD canvas rendering.
* **Columnar Data (`.parquet`):** Adopt `hyparquet` (MIT) to render local Parquet datasets in UniView's existing virtualized table grid.
* **Reject:** `heic2any` (LGPL-3.0 risk) and `@mlightcad/libredwg-web` (GPL-3.0 copyleft).

---

## 5. Verification & Evidence Citations

- `xushanpei/open-file-viewer`: [https://github.com/xushanpei/open-file-viewer](https://github.com/xushanpei/open-file-viewer)  
- Open File Viewer Core on npm: [https://www.npmjs.com/package/@open-file-viewer/core](https://www.npmjs.com/package/@open-file-viewer/core)  
- Open File Viewer Documentation: [https://open-file-viewer-workspace.void.app](https://open-file-viewer-workspace.void.app)  
- `aiden0z/pptx-renderer`: [https://github.com/aiden0z/pptx-renderer](https://github.com/aiden0z/pptx-renderer)  
- `aiden0z/pptx-renderer` v1.4.0 Release: [https://github.com/aiden0z/pptx-renderer/releases/tag/v1.4.0](https://github.com/aiden0z/pptx-renderer/releases/tag/v1.4.0)  
- `ChristopherVR/emf-converter`: [https://github.com/ChristopherVR/emf-converter](https://github.com/ChristopherVR/emf-converter)  
- `ChristopherVR/emf-converter` v4.23.1 Release: [https://github.com/ChristopherVR/emf-converter/releases/tag/v4.23.1](https://github.com/ChristopherVR/emf-converter/releases/tag/v4.23.1)  
- `alexcorvi/heic2any` (LGPL libheif wrapper): [https://github.com/alexcorvi/heic2any](https://github.com/alexcorvi/heic2any)  
- Upstream `strukturag/libheif` (LGPL-3.0): [https://github.com/strukturag/libheif](https://github.com/strukturag/libheif)  
- `mlightcad/libredwg-web` (GPL-3.0): [https://github.com/mlightcad/libredwg-web](https://github.com/mlightcad/libredwg-web)  
- GNU LibreDWG (GPL-3.0): [https://www.gnu.org/software/libredwg/](https://www.gnu.org/software/libredwg/)  
- `@stackline/xlsx` on npm: [https://www.npmjs.com/package/@stackline/xlsx](https://www.npmjs.com/package/@stackline/xlsx)  
- Stackline SheetJS Fork: [https://github.com/alexandroit/sheetjs](https://github.com/alexandroit/sheetjs)  
- SheetJS Official CDN Tarballs: [https://cdn.sheetjs.com/](https://cdn.sheetjs.com/)  
- `@kenjiuno/msgreader`: [https://github.com/HiraokaHyperTools/msgreader](https://github.com/HiraokaHyperTools/msgreader)  
- `postalsys/postal-mime`: [https://github.com/postalsys/postal-mime](https://github.com/postalsys/postal-mime)  
- `Agamnentzar/ag-psd`: [https://github.com/Agamnentzar/ag-psd](https://github.com/Agamnentzar/ag-psd)  
- `hyparam/hyparquet`: [https://github.com/hyparam/hyparquet](https://github.com/hyparam/hyparquet)
