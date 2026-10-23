# Task packet 2: instant opening (owner: agy, reviewer: Codex)

## Objective

Make opening feel instant and prove it with numbers: no UI freeze on large spreadsheets, measured memory and main-thread blocking per format, and recent remote files that reopen in one tap.

## Work

1. **Spreadsheet parsing off the main thread.** Move SheetJS parsing from `src/viewers/SheetViewer.tsx` into a Web Worker (`src/viewers/sheet.worker.ts`, loaded with Vite's `new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module" })`). Keep the existing behavior: UTF-8 decoding for CSV/TSV, `assertZipWithinBudget` before parsing ZIP-based workbooks (run it in the worker), dense mode, formatted cell text (`cell.w`), column widths, sheet names. The worker returns, per sheet, `{ name, rows, cols, colWidths, cells: string[][] }` (rows of formatted strings), transferring nothing it doesn't need. Errors come back as messages and become `CorruptFileError` in the viewer. Terminate the worker when the tab closes (abort signal). If `Worker` is unavailable, fall back to parsing on the main thread through the same function (export the pure parse function from a module the worker imports).
2. **Remote recents.** When a remote file opens (`src/remote/source.ts` / `src/ui/remote/RemoteBrowser.tsx`), remember it in recents (`src/ui/recents.ts`) with `{ name, size, remote: { hostId, rootId, rootName, path, mtime } }`. On the home page, a remote recent shows the computer name and reopens through `connect()` + `host.stat()` + `remoteSource()`, with a clear message if the computer is unreachable or the file changed or was removed. Local recents keep working as today.
3. **Benchmark memory and blocking.** Extend `scripts/bench.mjs`: for each fixture, after it opens (cold run), record the page's JS heap (`page.context().newCDPSession(page)` then `Performance.getMetrics`, metric `JSHeapUsedSize`) and the longest main-thread task during the open (a `PerformanceObserver` for `longtask` registered before opening, read afterwards). Add columns `Heap after open` (MB) and `Longest task` (ms) to `docs/BENCHMARK.md`, plus a line with Electron process-family memory measured by a new `scripts/bench-electron.mjs` (launch the app with a fixture via Playwright `_electron`, then `app.evaluate(({ app }) => app.getAppMetrics())`, summing `memory.workingSetSize` in KB → MB).

## Tests first

- `tests/unit/sheet-parse.test.ts`: the pure parse function returns the expected grid for an XLSX built with SheetJS in the test (two sheets, a date, a number format, UTF-8 CSV with accents), and rejects a ZIP bomb (reuse the forging approach in `tests/unit/zip-bombs.test.ts`).
- `tests/unit/recents.test.ts`: remote recents round-trip, de-duplicate by host+root+path, and do not collide with local ones.
- E2E (`tests/e2e/web.spec.ts`): opening `big.xlsx` keeps the main thread free: register a `longtask` observer, open the file, assert the longest task during the open is under 200 ms and the grid shows `row 1`.

## Non-goals

No changes to viewers other than SheetViewer; no new dependencies; do not change the remote protocol.

## Acceptance checks (run and paste output)

- `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`
- `npx playwright test` (set `PLAYWRIGHT_BROWSERS_PATH=I:/AES/Data/ms-playwright`): all projects pass, including `tests/e2e/remote.spec.ts`
- `npm run preview` in the background, then `node scripts/bench.mjs --runs 3` and `node scripts/bench-electron.mjs`; commit the regenerated `docs/BENCHMARK.md`
- Commit on `feat/v1-core`: `feat: instant opening (sheet worker, remote recents, memory bench)` with a Co-Authored-By line for your model.
