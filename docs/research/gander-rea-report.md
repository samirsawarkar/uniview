# Gander (Android): rendering, file loading and licensing (REA analysis)

Date: 2026-10-23
Target: [mokshablr/gander](https://github.com/mokshablr/gander) release **v2.6** (2026-10-22), `Gander-2.6.apk`, 5,099,700 bytes.
SHA-256 `62b3f68f…2ee2d44` matches the digest published on the GitHub release. Package `com.arjun.gander`, MIT.

## What was analyzed

- REA `inspect-artifact`: full APK inventory (1,160 entries).
- REA `inspect_apk_signature`: one v2 signer, certificate SHA-256 `5b5cf64a…a7e24b`. REA reads declared signers only; it does not cryptographically verify them.
- REA `identify_flutter_build`: not Flutter (no `libapp.so`). The APK has **no native libraries at all**.
- REA `analyze_javascript_application` on the 16 Gander-authored viewer scripts and pages in `assets/viewer/`. REA found 5 request sites, all same-origin `fetch` calls.
- String and class tables of `classes.dex` and the binary manifest, read with a short Python script.

Not covered:
- Decompiled Kotlin. REA's Android decompiler needs JADX, which isn't installed. Native-side claims below come from dex strings and class names, not from reading the code.
- `android-resources` decoding (needs apktool).
- Runtime behaviour.
- REA's `extract-artifact` refused the whole APK because `res/2f.xml` and `res/2F.xml` collide on a case-insensitive Windows filesystem. That refusal is correct, so I extracted only `assets/`, `classes.dex` and the manifest.

## Architecture in one line

A native Kotlin shell (R8-obfuscated). Documents render in an Android **WebView** running bundled JavaScript from `assets/viewer/`. Images, video, audio and the PDF fallback use **native Android** components. There is **no INTERNET permission**, so the "zero-permission" claim holds: the manifest declares only `android.permission.DUMP`, which is AndroidX ProfileInstaller's caller check, not a grant.

## Format → renderer map

| Formats | Where it renders | Library (version) | License |
|---|---|---|---|
| **pptx, ppsx, potx** (+ macro variants) | WebView `pptx.html` | **PPTXjs 1.21.1** (2021) + divs2slides 1.3.2, jQuery 1.11.3, JSZip 2.x, D3 3.5.10 + NVD3 1.8.1 (charts), FileReader.js; Gander's `pptx.js` patches two upstream bugs | MIT / BSD-3 / Apache-2.0 |
| **ppt** (legacy binary) | Not rendered | n/a | Shows "re-save as .pptx" |
| **xlsx, xlsm, xlsb, xls, ods, csv** | WebView `xlsx.html` | **SheetJS Community 0.20.3** (`xlsx.full.min.js`); Gander's `xlsx.js` adds UTF-8 CSV detection | Apache-2.0 |
| **docx, docm, dotx** | WebView `docx.html` | **docx-preview 0.4.0** + JSZip 3.10.1; Gander adds page layout, line and night modes, and **sandboxes docx-preview's altChunk iframe** (stops a script-injection path) | Apache-2.0 / MIT |
| **doc** (Word 97–2003 binary) | WebView `prose.html` | **Gander's own parser** (`prose-doc.js`: compound file, FIB, piece table) | MIT (Gander) |
| **odt, fodt** | WebView `prose.html` | Gander's own (`prose-odt.js`) over JSZip | MIT (Gander) |
| **rtf** | WebView `prose.html` | Gander's own (`prose-rtf.js`) | MIT (Gander) |
| pdf (main path) | WebView `pdf.html` | **PDF.js 6.3.289** legacy build with worker, plus OpenJPEG and JBIG2 WASM decoders and Adobe CMaps | Apache-2.0 / BSD-2 / BSD-3 |
| pdf (fallback) | WebView `pdfsimple.html` drawing images from native code | Android **`PdfRenderer`**, served as `/render/document`, `/render/sizes`, `/render/page`; runs in `PdfRenderService`/`PdfRenderService1-3` and `PdfThumbService` | OS |
| epub | WebView `epub.html` | Gander's own reader over JSZip + DOMPurify 3.4.12 | MIT / Apache-2.0 |
| stl (3D) | WebView `model.html` | Gander's own WebGL 1 renderer | MIT (Gander) |
| md | WebView `md.html` | marked 15.0.12 + DOMPurify | MIT |
| text and code (json, sql, srt, ruby…) | WebView `text.html` | Gander's own, paged 5 MB at a time with a streaming decoder | MIT (Gander) |
| jpg, png, webp, heic, tiff… | Native (inferred from classes) | **subsampling-scale-image-view** (Dave Morrissey) + `BitmapRegionDecoder`; an `imgweb.html` WebView page also exists for some image types (which ones is not confirmed) | Apache-2.0 |
| video, audio (mp4, mkv…) | Native | **AndroidX Media3 / ExoPlayer** + MediaSession on `MediaCodec` | Apache-2.0 |
| zip | Native | `ArchiveProvider` (content provider `com.arjun.gander.archive`) lists entries and opens one in the matching viewer | MIT (Gander) |

**PPTX and XLSX: the answer.** Gander doesn't solve PPTX fidelity; it uses PPTXjs, which is unmaintained since 2021–22. Gander ships patches for upstream issues 32 and 42 (decks with no `docProps/app.xml`, such as Google Slides exports). Rendering converts slides to HTML/CSS, with D3 for charts, and has the layout limits the panel predicted. XLSX is SheetJS, which is solid for grids and also reads legacy `.xls`. Gander's distinctive work is its **own parsers for .doc, .odt and .rtf**, which avoid LibreOffice entirely.

## How files are loaded

1. **Opening.** The manifest registers `ACTION_VIEW` and `ACTION_SEND` intent filters for about 35 MIME types (Office OOXML and macro variants, legacy `msword` and `ms-excel`, ODF, EPUB, RTF, STL, zip). Files arrive as `content://` URIs and are read with `ContentResolver.openInputStream` / `openFileDescriptor`. No storage permission is needed.
2. **Choosing a viewer.** `ViewerActivity` / `InternalViewer` pick a page by extension or MIME type (the dex holds the full extension list and the page names `pptx.html`, `xlsx.html`, `docx.html`, `prose.html`, `pdf.html`, `pdfsimple.html`, `epub.html`, `md.html`, `model.html`, `text.html`, `imgweb.html`, `unsupported.html`) and pass options as query parameters (e.g. `?resume=` for the last PDF page).
3. **Serving the page and the bytes.** Pages load from the virtual origin `https://appassets.androidplatform.net/assets/viewer/` through AndroidX **`WebViewAssetLoader`**. The page then calls `fetch("/doc/file.<ext>")` on the same origin (`app.js:252`, `vwDocUrl`). The native side answers that path. Inferred from the dex strings `/doc/`, `shouldInterceptRequest`, `WebResourceResponse` and `openInputStream`: it streams a `WebResourceResponse` from the content URI. The decompiled method was not read. The file never touches `file://` or a shared folder, and no bytes cross a JavaScript bridge.
4. **PDF fallback.** On WebViews too old for PDF.js 6, `pdfsimple.html` asks the same interceptor for `/render/sizes` and `/render/page` images, which `PdfRenderer` produces in separate services. The manifest carries the `isolatedProcess` attribute, most likely on those services; this needs decoding to confirm.
5. **Locked-down pages.** Every viewer page has a strict CSP: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'`. A document can't load remote content, and there is no network permission anyway.
6. **Bridge.** The dex references `addJavascriptInterface`, but I couldn't tell without decompiling whether Gander's own code calls it or only the AndroidX WebKit support library does. The viewer JS REA analyzed loads documents only through `fetch`, never through a bridge.

## Licensing and risk flags

| Severity | Item | Notes |
|---|---|---|
| OK | All bundled JS libraries | Permissive (MIT, Apache-2.0, BSD). `assets/licences.md` reproduces the notices and records the choice of MIT for dual-licensed JSZip (MIT or GPL-3.0) and Apache-2.0 for DOMPurify (Apache-2.0 or MPL-2.0). The header versions I checked (PDF.js 6.3.289, SheetJS 0.20.3, PPTXjs 1.21.1, docx-preview) match the declared table. |
| Low | Native dependencies missing from the notice file | `licences.md` lists only the JavaScript libraries. Kotlin, AndroidX, Media3/ExoPlayer, Material Components and subsampling-scale-image-view are Apache-2.0 and expect their notices to ship too. This is a common Android gap; copy their notices if you reuse them. |
| Low | jQuery 1.11.3 (PPTXjs dependency) | Old (2015) with known XSS issues. The page CSP and lack of network limit the impact; replace it if you fork the PPTX path. |
| Medium (maintenance) | PPTXjs | Unmaintained since 2021–22, and HTML/CSS slide rendering limits fidelity. Treat it as a stopgap, not a foundation. |
| Info | Codec licensing | None bundled. Video and audio decode through the OS (`MediaCodec`), and HEIC/WebP through the platform decoders. |
| Info | Gander itself | MIT. The parsers for .doc, .odt and .rtf, the EPUB reader, the STL viewer and the paged text viewer are free to reuse with attribution. |

## Compared with Vudit Desktop

| | Vudit Desktop | Gander |
|---|---|---|
| PPTX / XLSX / legacy DOC | None / none / none | PPTXjs / SheetJS / own parser |
| How bytes reach the viewer | Raw path in a `file://` URL; each page reads the file itself | Same-origin `fetch` answered by `WebViewAssetLoader` from a content URI |
| Isolation | `contextIsolation: false`, no CSP, remote URLs in privileged views | Strict CSP per page, no network permission, PDF rendering in separate services |
| License blockers | nonfree ffmpeg, proprietary DocxJS, AGPL WebODF | None found |
| Media | ffmpeg.wasm transcoding + Video.js | OS decoders via Media3 |

## What to take from this

- **Reuse:** the content-URI → `WebViewAssetLoader` → same-origin `fetch` pattern, the per-page CSP, OS media decoders, and Gander's MIT parsers for .doc, .odt and .rtf. These ideas map directly onto Tauri and Capacitor, which can also serve custom-scheme or virtual-origin responses.
- **Don't build on:** PPTXjs, for fidelity. Gander confirms PPTX still needs its own renderer.
- **Gaps Gander leaves:** legacy `.ppt`, Keynote and Pages files, and anything needing a native conversion engine.
