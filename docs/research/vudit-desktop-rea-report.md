# Vudit Desktop: rendering, file flow and licensing (REA analysis)

Date: 2026-10-23
Target: [praharshjain/Vudit-Desktop](https://github.com/praharshjain/Vudit-Desktop), commit `daa05bbd` (2025-11-22), Electron 39, app version 1.0.0.

## What was analyzed

Vudit Desktop has no GitHub releases or tags, and the README documents building from source only. There is no released binary to download. I analyzed the `app/` tree that `electron-builder` packages into `app.asar` (`"main": "app/main.js"`, `asar: true`), cloned with `--depth 1`. Nothing was installed or run.

- REA `analyze_javascript_application` on the checkout root (1,085 inventoried files; 8 selected sources parsed: `package.json`, `app/main.js`, `app/functions.js`, `app/config.js`, `app/photon/*`). Evidence ID `ev_9bed36cf…b24` (retained in the REA session).
- REA facts view for IPC channels, handlers and BrowserWindow constructions.
- Source reading at the line ranges REA reported, plus license headers and build strings in the vendored libraries.

Not covered: npm dependencies (`node_modules` was not installed), runtime behaviour, and a packaged `.asar` (none published).

## Format → renderer map

Routing is a lookup table. `app/config.js` assigns each category in `file_types.json` a viewer page, then applies per-extension overrides. `getViewerURLByType()` in `app/main.js:432` falls back on MIME prefixes (`text/*` → code viewer, `video/*`, `audio/*`, `image/*`).

| Formats | Viewer page | Library (version) | License |
|---|---|---|---|
| pdf | `pdfviewer/external/pdfjs-dist/web/viewer.html` | PDF.js **2.1.266** (2018) + turn.js 4.1.0 page-flip | Apache-2.0; turn.js: see flags |
| docx | `docxviewer` | **DocxJS** (docxjs.com, proprietary), jQuery | **Personal/testing only; commercial needs paid license** |
| odt ott odp otp ods ots fodt fods fodp | `docviewer` | WebODF (ViewerJS) | **AGPL-3.0+** |
| rtf, wmf | `rtfviewer` | RTF.js + EMF.js + WMF.js | MIT |
| djv djvu | `djvuviewer` | DjVu.js 0.5.4 | MIT |
| tex latex | `latexviewer` | JaxEdit + MathJax + CodeMirror | **LGPL-3.0** (JaxEdit); Apache-2.0; MIT |
| ipynb | `ipynbviewer` | nbpreview, notebook.js, marked, KaTeX, Prism, DOMPurify, ansi_up | MIT / Apache-2.0 / BSD (permissive) |
| epub mobi azw3 fb2 cbz | `ebookviewer` | foliate-js | MIT |
| png jpg gif webp svg bmp ico apng avif | `imgviewer` | PhotoSwipe (Chromium decodes) | MIT |
| tif tiff | `imgviewer` | tiff.js (libtiff via Emscripten) | zlib + libtiff (permissive) |
| heic heif | `imgviewer` | libheif.js (WASM) | **LGPL-3.0** (libheif/libde265); HEVC patents |
| mp3 m4a wav ogg flac aac opus | `mediaviewer/audio.html` | Video.js 8.0.4 + Chromium decoders | Apache-2.0 |
| mp4 webm mov mkv ogv 3gp m3u8 mpd | `mediaviewer/video.html` | Video.js 8.0.4, mux.js, flv.js, three.js (360°) | Apache-2.0 / MIT |
| flv avi etc. (transcode) | `mediaviewer` convert | ffmpeg.wasm (`ffmpeg-core.wasm`, local) | **GPL + `--enable-nonfree`** (see flags) |
| swf | `swfviewer` | Ruffle | MIT / Apache-2.0 |
| zip (rar is registered too) | `zipviewer` | adm-zip in main process | MIT; adm-zip is zip-only, so rar likely fails |
| json xml yaml csv | `treedocviewer` | treedoc (Vue bundle) | not checked |
| md | `markdownviewer` | EasyMDE 2.18.0 + highlight.js | MIT / BSD-3 |
| sqlite sqlite3 | `sqliteviewer` | sql.js (old asm.js build), Ace, Bootstrap, jQuery 1.11.3 | MIT / BSD |
| ~55 code/text extensions | `ide` | Ace (src-min-noconflict) | BSD-3 |
| diff | `diffviewer` | jsdiff + diff2html | BSD-3 / MIT |
| pgn | `pgnviewer` | PGN viewer bundle | not checked |
| puz jpz | `puzzleviewer` | crossword.js, jsPDF, Dark Reader | MIT (not fully checked) |
| ttf otf woff woff2 | `fontviewer` | custom renderer | MIT (app code) |

**Gap that matters for us:** Vudit registers **no pptx, xlsx, ppt, xls or doc**. Its only Office Open XML support is docx, and that goes through a proprietary library. The formats you named as hardest are not solved here.

## How a file gets from main to the renderer

1. **Choosing a file.** The renderer (`photon/index.html` via preload `app/functions.js`) calls `ipcRenderer.sendSync('openFile', path, type)` (`functions.js:57`). Menu commands call `ipcMain.handle('handleOpenFile')` (`main.js:150`), which runs `dialog.showOpenDialogSync`, or `handleOpenURL` (`main.js:153`), which shows a URL prompt.
2. **Routing in main.** `openFile()` (`main.js:457`) gets the extension and MIME type (`mime-lookup` + `mime-db`) and builds a URL:
   `file://<app>/viewer/<viewer>/index.html?file=<encodeURIComponent(path)>`.
   For an `http(s)` URL with no extension match, it sends a HEAD request and routes by `Content-Type`.
3. **One tab = one BrowserView.** `loadURLInWindow()` (`main.js:495`) creates a `BrowserView` with the same `baseWebPreferences`, loads the viewer URL, and caches the view in `openViews[url]`, so reopening a file restores the view (`restoreView`). It then sends `fileOpened` back to the main window.
4. **The viewer reads the bytes itself.** Main does not pass file contents over IPC. Each viewer page reads `?file=` with `getParameterByName` and loads the path directly: `fetch(filePath)` (imgviewer), `XMLHttpRequest` (WebODF), PDF.js `?file=`, foliate-js and the font renderer through the shared preload helpers.
   - Exception: **zip.** The renderer calls `getZipEntries` with `sendSync`. Main opens the archive with `adm-zip` and returns the entry list (`main.js:552`).
   - Directory browsing: `listFiles` (`main.js:582`) runs `fs.readdirSync`/`statSync` in main and returns metadata.
5. **macOS Quick Look.** `quickLookPreview` calls `BrowserWindow.previewFile()` (`main.js:490`), which hands the file to the OS previewer.

IPC channels REA recovered. All have literal names, all synchronous except the three `handle` calls, with no sender validation observed:
`handleOpenFile`, `handleOpenURL`, `listFiles` (handle); `openFile`, `quickLookPreview`, `restoreView`, `closeView`, `hideOpenFiles`, `getConfig`, `getZipEntries`, `getPreviewURL` (on/sendSync). Main → renderer: `fileOpened`.

Window security settings (`main.js:20`): `contextIsolation: false`, `nodeIntegrationInSubFrames: true`, `webviewTag: true`, `plugins: true`, and preload `functions.js` on every viewer BrowserView. The tray window (`main.js:186`) also sets `nodeIntegration: true`. Remote URLs open in the same privileged viewer pages as local files.

REA limitation found: REA reported `preload_entrypoints: 0` and `explicit_web_preferences: 0` because the preferences object is passed by variable (`baseWebPreferences`), not inline. The source shows a preload on every window. REA's IPC findings matched the source exactly.

## Licensing and risk flags

| Severity | Item | Why it matters for us |
|---|---|---|
| **Blocker** | `mediaviewer/ffmpeg-core.wasm` built with `--enable-gpl --enable-nonfree --enable-libx264 --enable-libx265` | `nonfree` builds are not redistributable under any license. GPL x264/x265 plus H.264/HEVC patents. Do not copy this binary or this approach. |
| **Blocker** | `docxviewer/scripts/docxjs.min.js` (DocxJS) | Header says personal/testing use only; commercial use needs a purchased license. Use docx-preview (Apache-2.0) instead. |
| **High** | `docviewer/webodf.js` | AGPL-3.0+. Bundling it forces AGPL obligations; app stores conflict with that. |
| **High** | PDF.js 2.1.266 | Affected by CVE-2024-4367 (script execution from a crafted PDF, fixed in 4.2.67). With `contextIsolation: false` and a preload exposing `ipcRenderer`, a malicious PDF could reach main-process IPC. |
| **Medium** | libheif.js | LGPL-3.0 plus HEVC patents. Prefer OS decoders (macOS/iOS/Android support HEIC natively; Windows needs the HEVC extension). |
| **Medium** | JaxEdit (LaTeX) | LGPL-3.0. Fine as a separate dynamically loaded file on desktop; avoid on iOS. |
| **Check** | turn.js 4.1.0 (PDF page-flip) | Header points to turnjs.com/license.txt. Version 4 is not under the permissive license earlier versions used; confirm terms before reuse, or drop the feature. |
| **Check** | treedoc, PGN viewer, puzzle viewer bundles | License not identified in the headers; check the upstream repos before reuse. |
| Info | Vudit's own code | MIT (`LICENSE`). Its routing table and viewer-per-format pattern are free to reuse. |
| Info | Offline | No viewer page loads scripts from a CDN; the ffmpeg default `unpkg.com` core path is overridden to a local file. Offline-safe as shipped. |

## What to take from this

- **Reuse:** the routing table pattern (extension, then MIME, then MIME-prefix fallback), one isolated view per open file with restore, and foliate-js, RTF.js, DjVu.js, Ruffle and Video.js as permissive building blocks.
- **Avoid:** WebODF, DocxJS, the nonfree ffmpeg build, old PDF.js, synchronous IPC, `contextIsolation: false`, and passing raw paths in URLs to privileged pages. Open remote content in an unprivileged view.
- **Still unsolved:** PPTX, XLSX and the legacy binary Office formats. Vudit gives nothing for these, which confirms the panel's view that PPTX needs its own spike.
