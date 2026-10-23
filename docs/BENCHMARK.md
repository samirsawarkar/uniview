# UniView benchmark

Generated 2026-10-23T06:46:17.121Z by `npm run bench` (5 runs each, Chromium headless, production build, win32).
Time-to-first-view: from the file entering the app to the first meaningful content painted (two animation frames after the viewer reports content).
Cold = first open of that format in a fresh page (includes loading the viewer's code). Warm = reopening in the same page.

App start to interactive (page load to Open button): p50 108 ms, p95 115 ms.

All formats: cold p50 355 ms, p95 620 ms · warm p50 41 ms, p95 290 ms.

| File | Size | Cold p50 | Cold p95 | Warm p50 | Warm p95 |
|---|---:|---:|---:|---:|---:|
| app.ts | 0.1 KB | 354 ms | 354 ms | 40 ms | 41 ms |
| big.xlsx | 5969.0 KB | 621 ms | 670 ms | 291 ms | 306 ms |
| book.epub | 2.0 KB | 402 ms | 407 ms | 40 ms | 42 ms |
| bundle.zip | 0.4 KB | 337 ms | 339 ms | 40 ms | 41 ms |
| charter.docx | 1.1 KB | 352 ms | 363 ms | 40 ms | 42 ms |
| data.json | 0.1 KB | 354 ms | 355 ms | 41 ms | 43 ms |
| deck.pptx | 7.1 KB | 356 ms | 359 ms | 42 ms | 44 ms |
| minutes.doc | 1.1 KB | 354 ms | 355 ms | 40 ms | 42 ms |
| notes.md | 0.1 KB | 355 ms | 356 ms | 42 ms | 42 ms |
| people.csv | 0.0 KB | 355 ms | 356 ms | 41 ms | 42 ms |
| pixel.png | 0.6 KB | 339 ms | 354 ms | 41 ms | 42 ms |
| report.pdf | 0.6 KB | 439 ms | 455 ms | 109 ms | 109 ms |
| sales.xlsx | 16.8 KB | 356 ms | 372 ms | 41 ms | 41 ms |
| shape.svg | 0.2 KB | 354 ms | 356 ms | 39 ms | 41 ms |
| tone.wav | 15.7 KB | 356 ms | 357 ms | 41 ms | 42 ms |

Targets from docs/SPEC.md: warm p50 under 300 ms for files under 5 MB; app start under 1.5 s.
