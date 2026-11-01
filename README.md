# UniView

Open any file. Offline, private, instant.

UniView is one simple, Chrome-like app for viewing documents, spreadsheets, presentations, books, images, audio, video, code and archives on Windows, macOS, Android and iOS. Everything runs on the device: there is no account, no telemetry and no network access.

## What it opens

| Kind | Formats | How |
|---|---|---|
| PDF | pdf | pdf.js 6.4: lazy page rendering, selectable text, find, zoom |
| Word | docx, docm, dotx | docx-preview (embedded HTML "altChunks" never rendered) |
| Spreadsheets | xlsx, xlsm, xlsb, xls, ods, csv, tsv | SheetJS CE 0.20.3, virtualized grid (50,000 rows scroll smoothly), sheet tabs, UTF-8 CSV |
| PowerPoint | pptx, ppsx, potx, pptm | UniView's own renderer: theme colors and fonts, layout/master placeholders, shapes, pictures, tables, groups, SmartArt drawings, notes, presenter mode (F5) |
| Books | epub | UniView's own reader: table of contents, chapter navigation, text size, scripts never run |
| Images | png, jpg, gif, webp, avif, bmp, ico, svg, tiff | Zoom, fit, 1:1, rotate; SVG shown as an image so its scripts cannot run |
| Audio and video | mp4, mov, webm, mkv, mp3, m4a, wav, ogg, flac, … | The device's own decoders (nothing bundled, no codec licensing) |
| Text and code | 70+ extensions | highlight.js (40 languages), line numbers, 2 MB pages for huge logs |
| Markdown, JSON | md, json | Rendered and sanitized Markdown; collapsible JSON tree |
| Archives | zip, cbz, jar, apk… | File list with filter; any entry opens in a new tab |
| Fonts | ttf, otf, woff, woff2 | Sample text at six sizes and a glyph grid |
| Legacy Office | doc, ppt | Recovered text with a clear note |
| Anything else | * | Hex view. A file that fails to render always offers "View as text" and "View as hex": never a blank tab |

## Using it

- **Open:** drag files anywhere, click **Open** (Ctrl+O), double-click a file in Explorer/Finder, or use "Open with" / Share on a phone.
- **Windows:** Ctrl+N opens a new window with its own tabs on desktop.
- **Tabs:** Ctrl+T new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab switch, Ctrl+1…9 jump, middle-click closes.
- **Omnibox (Ctrl+L):** search open tabs and recent files; on desktop, paste a file path and press Enter.
- **AI agents:** in Home, click **Connect** beside Claude Code or Codex; when the agent shows a document it opens in UniView. Type a change request in the bar under the document and the same agent session makes the edit and the tab reloads. Your terminal shows the agent waiting, and Esc there takes back control. Claude Code or Codex must already be installed; UniView only adds its own MCP entry. Click **Disconnect** before uninstalling UniView, otherwise the agent keeps a broken entry. Manual setup (`resources\uniview-mcp.cmd`, or `ELECTRON_RUN_AS_NODE=1` because Electron's main process on Windows closes stdin in GUI mode) is in [docs/AGENTS.md](docs/AGENTS.md).

## Measured

`npm run bench` (see [docs/BENCHMARK.md](docs/BENCHMARK.md)): app start to interactive 108 ms; open-to-first-view p50 41 ms warm, about 355 ms the first time a format is opened (the viewer's code loads once); a 5.8 MB, 50,000-row workbook opens in 291 ms warm.

## Develop

Requires Node 22+ (tested on 24.20).

```bash
npm install
npm run dev          # web UI at http://localhost:5173
npm test             # unit tests (Vitest)
npm run build        # type-check and production build into dist/
npm run fixtures     # generate test documents into fixtures/generated/
npx playwright test  # end-to-end: web, Pixel 7 viewport, Electron
npm run bench        # time-to-first-view benchmark (needs `npm run preview` running)
npm run electron     # desktop app from the current build
```

AES golden eval: `aes eval --workspace . --suite evals/detect.json --execute`; agent workspace eval: `aes eval --workspace . --suite evals/agents.json --execute`.

Set `PLAYWRIGHT_BROWSERS_PATH` if your Playwright browsers live outside the default cache.

### Packages

| Target | Command | Output |
|---|---|---|
| Windows | `npm run dist:win` | `release/UniView-Setup-1.0.0.exe` (installer), `release/UniView-Portable-1.0.0.exe` |
| macOS | `npm run dist:mac` (on a Mac or CI) | `release/UniView-1.0.0-*.dmg` |
| Android | `npm run android:apk` (JDK 21) | `android/app/build/outputs/apk/debug/app-debug.apk` |
| iOS | `npx cap sync ios`, then build `ios/App` in Xcode | |

Builds are unsigned. Code signing, notarization and store submission are a separate, deliberate release step.

## Architecture

```
src/core     format detection, PPTX/EPUB/ZIP parsing, errors: no React, no shell code
src/viewers  one lazily loaded viewer per format family
src/ui       tabs, omnibox, home, per-tab error boundary
src/shells   the only code that talks to Electron or Capacitor (ShellBridge, FileSource)
electron/    desktop main process and sandboxed preload
android/ ios/  Capacitor projects with native "Open with" / Share handling
```

`tests/unit/fence.test.ts` fails the build if `src/core`, `src/viewers` or `src/ui` import a shell runtime, so the shell can be swapped later (see the decision record below).

## Security model

- **Offline by construction.** Desktop: the session cancels every request that is not to the app's own schemes. Web/mobile: the Content Security Policy allows no remote hosts. On Android the INTERNET permission is used only for direct, end-to-end encrypted connections to computers you paired with on your local network; the page itself still cannot reach any remote host.
- **Desktop isolation.** Sandboxed renderer, context isolation, no Node.js in the page, navigation and new windows denied, IPC accepted only from the app's top-level page. Files are served from `uniview-file://<token>/` with HTTP range support, where the 128-bit token exists only for files the user opened (picker, drop, file association, typed path).
- **Untrusted documents.** EPUB chapters run in a sandboxed iframe without scripts, with their own CSP and sanitized HTML; Markdown is sanitized with DOMPurify; SVG is shown through `<img>`; DOCX embedded HTML is never rendered. ZIP-based formats have per-entry (512 MB) and per-package (1 GB) decompression limits.
- **Agent security boundary.** The agent bridge trust boundary is the local OS user account (same-user processes can open local regular files for display or reuse enrolled agent keys; file contents cannot be read back and approvals always require human interaction; enrollments can be revoked in the Agents panel).

## Decisions and reviews

Recorded in Obsidian (`uniview`) and in `.aes/`:

- Shell: Electron + Capacitor behind a ShellBridge, accepted by the CEO (triage `dec-67e7d1c9` TYPE 1, debate `dec-9a21f812` unanimous). **Gate before code signing:** a 3-day Tauri v2 prototype against the same benchmark; migrate only if p50 time-to-first-view improves ≥25% or installer size drops ≥50% with no format regression.
- Reuse-first scout: `.aes/scout/scout-080e764a.md` (with CTO verification and licence exceptions).
- Licensing: CEO decision (2026-10-25) confirms V1 ships purely permissive (native OOXML renderer + `emf-converter`); the optional second PowerPoint engine (@aiden0z/pptx-renderer) is deferred to V1.1 as an isolated chunk.
- Independent reviews: Codex (GPT) and pi (Gemini); the author was Claude.

## Known limits (V1)

- No editing or annotation; view only.
- HEIC images are not supported (every permissive decoder bundles LGPL libheif). Old binary .doc/.ppt show recovered text only.
- Charts and equations in PowerPoint show a labeled placeholder (the optional second PowerPoint engine is deferred to V1.1 as an isolated chunk). EMF/WMF pictures use a bounded, offline PNG converter; unsupported or oversized metafiles keep a placeholder.
- Spreadsheet output is limited to 500,000 grid slots across all sheets and 32 Mi UTF-16 code units of text; larger workbooks offer the fallback view.
- Password-protected PDFs are not supported yet.
- Android and iOS runtime behavior has not been verified on a device or emulator yet (the APK was inspected statically; iOS needs a Mac or CI).

## License

MIT for UniView's own code. Bundled libraries keep their licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Set UniView as a default viewer on Windows

Install `UniView-Setup-1.0.0.exe` (the portable version does not register file types). Open **Settings → Apps → Default apps**, search for **UniView**, and select it for each file type you want it to open. You can also right-click a file in Explorer, choose **Open with → Choose another app**, select UniView, and choose **Always**. Installing UniView does not change your existing defaults. Windows chooses defaults separately for each extension.

UniView can open other files using **Open** or drag and drop, including an inspection fallback for unknown formats; it cannot faithfully render every document format. See the format table and known limits above and below.
