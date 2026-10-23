# Task packet 3: difficult formats (owner: agy, reviewer: Codex)

## Objective

Prove the rendering engine on the hard cases before committing to it, and close the gaps the tests find.

## Work

1. **Harder fixtures** in `scripts/fixture-builders.mjs` and `scripts/make-fixtures.mjs`:
   - `hard.pptx`: a rotated shape (rot 45°), a horizontally flipped arrow (`rightArrow`), a gradient fill, a picture with `srcRect` crop, a text run with a hyperlink and superscript, a table with a merged cell (`gridSpan="2"`), a group nested in a group, a chart graphic frame (renders the "Chart" placeholder), and a hidden slide (`show="0"`).
   - `hard.docx`: a header and a footer, an embedded PNG, a 3×3 table, a numbered list, and a hyperlink.
   - `hard.xlsx`: merged cells (`!merges`), a date cell with a date format, a percentage, a currency format, a formula cell with a cached value, and a 200-column sheet.
2. **Merged cells in the spreadsheet grid.** `VirtualGrid` in `src/viewers/SheetViewer.tsx` (or the worker output from packet 2) renders merged ranges as one cell spanning the merged width and height, showing the top-left value, without breaking virtualization.
3. **Hidden slides.** `PptxViewer` shows hidden slides dimmed with a "Hidden" label in the rail and skips them in presenter mode.
4. Fix any rendering defect the new fixtures expose in `src/core/pptx.ts` (for example nested group transforms or crop math), each with a unit test.

## Tests first

- Unit tests in `tests/unit/pptx.test.ts` for each `hard.pptx` feature (rotation, flip, gradient stops, crop fractions, hyperlink text, superscript baseline, merged table cell `gridSpan`, nested group coordinates, chart placeholder, hidden flag).
- E2E (`tests/e2e/web.spec.ts`): `hard.pptx` renders all slides without an error panel and the presenter skips the hidden slide; `hard.docx` shows its header text, table and image; `hard.xlsx` shows the merged cell once with the right span, the formatted date and percentage, and scrolls horizontally to column 200.

## Non-goals

No new dependencies; no changes to the remote feature or Electron shell.

## Acceptance checks (run and paste output)

- `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`, `npm run fixtures`
- `npx playwright test` with `PLAYWRIGHT_BROWSERS_PATH=I:/AES/Data/ms-playwright`: all projects pass
- `aes eval --workspace . --suite evals/detect.json --execute`: all cases pass; add cases for the three new fixtures
- Commit on `feat/v1-core`: `feat: harder format fixtures, merged cells, hidden slides` with a Co-Authored-By line for your model.
