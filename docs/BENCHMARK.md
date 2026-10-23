# UniView benchmark

Generated 2026-10-23T09:12:08.280Z by `npm run bench` (3 runs each, Chromium headless, production build, win32).
Time-to-first-view: from the file entering the app to the first meaningful content painted (two animation frames after the viewer reports content).
Cold = first open of that format in a fresh page (includes loading the viewer's code). Warm = reopening in the same page.

App start to interactive (page load to Open button): p50 84 ms, p95 93 ms.

All formats: cold p50 356 ms, p95 439 ms · warm p50 42 ms, p95 108 ms.

| File | Size | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Heap after open | Longest task |
|---|---:|---:|---:|---:|---:|---:|---:|
| app.ts | 0.1 KB | 355 ms | 356 ms | 42 ms | 42 ms | 5.4 MB | 0 ms |
| big.xlsx | 5969.1 KB | 653 ms | 655 ms | 325 ms | 326 ms | 9.7 MB | 0 ms |
| book.epub | 2.0 KB | 355 ms | 372 ms | 41 ms | 42 ms | 5.3 MB | 0 ms |
| bundle.zip | 0.4 KB | 354 ms | 355 ms | 42 ms | 42 ms | 4.1 MB | 0 ms |
| charter.docx | 1.1 KB | 355 ms | 356 ms | 42 ms | 43 ms | 4.9 MB | 0 ms |
| data.json | 0.1 KB | 355 ms | 356 ms | 42 ms | 42 ms | 5.2 MB | 0 ms |
| deck.pptx | 7.1 KB | 357 ms | 358 ms | 42 ms | 42 ms | 5.0 MB | 0 ms |
| hard.docx | 3.0 KB | 356 ms | 357 ms | 42 ms | 43 ms | 5.3 MB | 0 ms |
| hard.pptx | 7.3 KB | 357 ms | 357 ms | 42 ms | 43 ms | 5.1 MB | 0 ms |
| hard.xlsx | 29.7 KB | 389 ms | 390 ms | 59 ms | 60 ms | 4.9 MB | 0 ms |
| minutes.doc | 1.1 KB | 356 ms | 356 ms | 42 ms | 43 ms | 4.1 MB | 0 ms |
| notes.md | 0.1 KB | 356 ms | 356 ms | 42 ms | 43 ms | 5.6 MB | 0 ms |
| people.csv | 0.0 KB | 373 ms | 374 ms | 59 ms | 59 ms | 4.8 MB | 0 ms |
| photo.tif | 13.0 KB | 356 ms | 357 ms | 43 ms | 43 ms | 4.5 MB | 0 ms |
| pixel.png | 0.6 KB | 356 ms | 357 ms | 42 ms | 43 ms | 4.1 MB | 0 ms |
| report.pdf | 0.6 KB | 438 ms | 439 ms | 108 ms | 108 ms | 5.2 MB | 0 ms |
| sales.xlsx | 16.8 KB | 389 ms | 389 ms | 59 ms | 59 ms | 4.8 MB | 0 ms |
| sans.ttf | 136.2 KB | 356 ms | 356 ms | 42 ms | 42 ms | 4.1 MB | 0 ms |
| shape.svg | 0.2 KB | 354 ms | 356 ms | 42 ms | 43 ms | 4.1 MB | 0 ms |
| tone.wav | 15.7 KB | 359 ms | 359 ms | 43 ms | 44 ms | 4.1 MB | 0 ms |
| unicode.txt | 0.0 KB | 340 ms | 356 ms | 43 ms | 43 ms | 5.2 MB | 0 ms |

Electron process-family memory after open (big.xlsx): 470.8 MB.

Targets from docs/SPEC.md: warm p50 under 300 ms for files under 5 MB; app start under 1.5 s.
