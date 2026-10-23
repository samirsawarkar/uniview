# Task packet 4: second PPTX engine and EMF/WMF pictures (owner: agy, reviewer: Codex)

Decision: `docs/research/open-file-viewer-evaluation.md` (CTO decision section). Both packages are recorded OK in `.aes/scout/scout-080e764a.md`.

## Objective

Make the rendering layer modular per format, with a second, higher-fidelity PPTX engine for decks with charts and equations, and draw EMF/WMF pictures instead of showing a placeholder. Test the difficult formats before committing to either engine.

## Work

1. Install exact versions: `@aiden0z/pptx-renderer@1.4.0`, `emf-converter@4.23.1`.
2. **Engine registry for PPTX.** In `src/viewers/PptxViewer.tsx`, add an engine switch in the toolbar: "Standard" (UniView's renderer, default) and "High fidelity" (`@aiden0z/pptx-renderer`). Load the second engine with a dynamic `import()` so it is its own chunk and costs nothing until chosen. Configure it with `externalMedia: 'block'` and UniView's own pdf.js. Remember the choice per session. If the high-fidelity engine throws, show the error panel's existing fallbacks plus "Use Standard engine".
3. **Auto-suggest.** When UniView's parser emits a "Chart" placeholder or an EMF/WMF picture, show a one-line banner offering "Open in High fidelity".
4. **EMF/WMF pictures.** Add `src/viewers/metafile.ts` exporting `metafileToPng(bytes: Uint8Array, kind: "emf" | "wmf"): Promise<Blob | null>`, which lazy-imports `emf-converter`, returns null on any failure, and is bounded (refuse inputs over 32 MB and outputs over 64 megapixels). Use it in the PPTX image URL resolver so `.emf`/`.wmf` parts render as images.
5. **Offline check.** The high-fidelity engine must make no network request: assert it in e2e, following the existing request listener in `tests/e2e/web.spec.ts`.

## Tests first

- Unit: `metafileToPng` returns null for garbage and for oversized input; returns a PNG for a minimal valid EMF built in the test (header plus EOF record).
- E2E: `deck.pptx` and `hard.pptx` (from packet 3) render in both engines with no error panel; switching engines keeps the slide count; a PPTX with an embedded EMF shows an `<img>`, not the placeholder; no network requests.
- Bundle check: `npm run build` output shows the pptx-renderer code in its own chunk, not in `index-*.js`.

## Non-goals

No other formats; no change to the remote feature.

## Acceptance checks (the CTO runs them)

`npm test`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`, `npx playwright test` (all projects), `node scripts/bench.mjs --runs 3` (index chunk and warm PPTX open time must not regress by more than 10%).
