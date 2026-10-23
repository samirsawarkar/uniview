# UniView V1 specification

UniView opens common files in one simple, Chrome-like app on Windows, macOS, Android and iOS, fully offline.

Decision record: Obsidian `uniview/decisions/20261023T061049567396Z-d3f9d814` (Electron + Capacitor behind a ShellBridge; Tauri gate before signing).

## Goals and measures

| Goal | Measure (V1 target) |
|---|---|
| Format coverage | Every file opens in a readable view. Unknown or broken files fall back to text or hex, never a blank screen or crash. |
| Fast access | Cold app start to interactive under 1.5 s on desktop. Warm open-to-first-view p50 under 300 ms for files under 5 MB (`npm run bench`). |
| Offline | No network request is possible: CSP `connect-src` excludes remote hosts and Electron blocks every non-app request. No telemetry. |
| Simplicity | Open by drag-and-drop, the Open button, double-click (file association) or the share sheet. One tab per file, one omnibox. |

## Architecture

```
src/core      Shell-agnostic logic: types, detection, parsers (PPTX, EPUB, ZIP), utilities. No DOM framework imports.
src/viewers   React viewers, one per format family, lazily loaded.
src/ui        Chrome-like shell: tab strip, omnibox, home page, error boundary.
src/shells    ShellBridge implementations: web (also used by Capacitor), electron (preload API client).
electron/     Electron main and preload (plain ESM/CJS) plus testable lib/ modules.
android/      Capacitor Android project (generated, then patched for VIEW/SEND intents).
```

Fence rule (enforced by `tests/fence.test.ts`): nothing under `src/core`, `src/viewers` or `src/ui` imports `electron`, `@capacitor/*` or `@tauri-apps/*`. Only `src/shells/*` may.

## Interfaces

```ts
interface FileSource {
  id: string;                 // stable per open
  name: string;               // display name with extension
  size: number;               // bytes, -1 if unknown
  mimeHint?: string;          // from the OS, if any
  path?: string;              // desktop absolute path, if any
  readAll(signal?: AbortSignal): Promise<ArrayBuffer>;
  readRange(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer>; // [start, end)
  url(): Promise<string>;     // streamable URL for media (blob: or uniview-file:)
  release(): void;            // free blob URLs and handles
}

interface ShellBridge {
  kind: "web" | "electron" | "capacitor";
  pickFiles(): Promise<FileSource[]>;             // empty array if cancelled
  openPath?(path: string): Promise<FileSource>;   // desktop only, omnibox paste and recent files
  onExternalOpen(cb: (files: FileSource[]) => void): () => void; // file association, argv, share/VIEW intents
  revealInFolder?(source: FileSource): void;
}
```

Errors are typed: `UnsupportedFormatError`, `CorruptFileError(reason)`, `TooLargeError(limit)`, `AccessDeniedError`. Viewers throw; the tab's error boundary shows the reason and offers the text/hex fallback.

## Format detection (`src/core/detect.ts`)

`detect(name, head: Uint8Array /* first 64 KB */, size, mimeHint?) => { kind, subtype, confidence }`.
Order: magic bytes, then container inspection (ZIP: `[Content_Types].xml` parts and `mimetype`), then extension, then a text heuristic (valid UTF-8/UTF-16 with BOM, no NUL in the first 8 KB). Signature beats extension when they disagree.

| kind | Detected by | Viewer |
|---|---|---|
| pdf | `%PDF-` | pdf.js 6.4 (canvas, lazy pages, find, zoom) |
| image | PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, SVG text | `<img>` with zoom, pan, rotate |
| tiff | `II*\0` / `MM\0*` | UTIF2 decode to canvas |
| video / audio | ftyp, EBML, OGG, RIFF WAVE, ID3, fLaC, extension | HTML5 media (OS decoders); clear message if a codec is unsupported |
| docx | ZIP + `word/document.xml` | docx-preview (Apache-2.0) |
| xlsx / xls / ods / csv | ZIP + `xl/workbook.xml`, CFB + Workbook stream, `.csv`/`.tsv` | SheetJS CE 0.20.3, virtualized grid, sheet tabs |
| pptx | ZIP + `ppt/presentation.xml` | UniView's own OOXML renderer (shapes, text, images, tables, groups, placeholders inherited from layout and master), embedded thumbnail first |
| epub | ZIP + `mimetype` = `application/epub+zip` | UniView's own reader: spine, TOC, sanitized chapters in a script-less sandboxed iframe |
| zip | ZIP otherwise | entry list; any entry opens in a new tab |
| markdown | `.md` family | marked + DOMPurify |
| json | `.json` or leading `{`/`[` that parses | pretty-printed, collapsible tree for under 5 MB |
| text / code | text heuristic | highlight.js (common languages), paged 2 MB at a time |
| font | `wOFF`, `wOF2`, `OTTO`, TrueType | FontFace preview with sample text and glyph grid |
| legacy-office | CFB (`D0 CF 11 E0`) not a workbook | message: legacy .doc/.ppt, text extraction preview |
| binary | everything else | hex + ASCII view, paged |

Limits: files over 2 GB stream (media) or page (text/hex). In-memory parsers refuse above 512 MB with `TooLargeError` and offer hex.

## UI

- Tab strip: favicon by kind, title, close (middle-click too), `+` new tab = home. Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1..9.
- Omnibox: shows the path or name of the active tab. Typing filters recent files and open tabs; Enter opens a pasted desktop path.
- Home: drop zone, Open button, recent files (desktop reopens by path; web/mobile list names only).
- Drag-and-drop anywhere opens each file in a new tab. Ctrl+O opens the picker.
- Theme follows the system (light/dark).

## Electron security

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. App served from the `uniview://app/` scheme. Files served from `uniview-file://<token>` with HTTP range support, only for paths the user granted (picker, drop, argv/file association, recent list confirmed by the user). Every other request is cancelled. `will-navigate` and `window.open` are denied. Single instance; second-instance argv opens files in tabs. IPC channels are allow-listed and validate their arguments.

## Tests

- Unit (vitest): detection table, PPTX parser, EPUB parser, ZIP listing, CSV/XLSX adapter, text heuristic, hex formatter, Electron path grants and range parsing, fence.
- E2E (Playwright, web build): open each fixture via the file input and assert visible content; tab keyboard flow; corrupt file falls back to hex.
- Electron smoke (Playwright `_electron`): window loads, opens a fixture from argv, a remote fetch is blocked.
- Fixtures are generated by `scripts/make-fixtures.mjs`, so no third-party binaries are checked in.
- Benchmark: `npm run bench` reports open-to-first-view per fixture (p50/p95).
