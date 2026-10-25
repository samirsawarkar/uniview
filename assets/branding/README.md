# UniView Brand Assets & Icon Pipeline

## The one logo
The ONLY logo for UniView, on desktop, web, Android and iOS, is the CEO-supplied image: a white rounded square with a
faint diagonal grid and two crossing light-blue bars, on a transparent background. No other logo exists in the repo.

- `assets/branding/uniview-logo-source.png`: the ORIGINAL supplied file (135x133), kept byte-identical as evidence.
  Its transparent background was flattened to opaque near-black (14,14,14) when it was pasted, so it must not be used directly.
  - Source SHA-256: `10eb69956383c4bc78cf00eb4dda95710a7cf1a7417f201ff4fdca1bb6203e3a`
- `assets/branding/uniview-logo.png`: the CLEAN MASTER (128x128 RGBA, transparent background, no dark frame). Every output is derived from it.
  - Master SHA-256: `99686e77198e499ac09cf92d30b076629038d4fb4778ad20f47cd3e4fcd1165e`

### How the clean master is derived (`node scripts/clean-logo.mjs`, deterministic, Node + zlib only)
1. Flood-fill (4-connected) from every pixel on the four image borders through near-black neutral pixels
   (luminance < 48 and max-min channel spread <= 12): they become fully transparent.
2. Anti-aliased boundary: up to 3 passes over neutral grey pixels (spread <= 12, luminance v < 235) touching the transparent
   region or an already recovered pixel. They are white blended over black, so `alpha = clamp((v - 14) / (255 - 14), 0, 1)`
   and the colour is set to white (255,255,255). No dark fringe remains. Every other pixel (blue bars, bluish grid lines,
   whites) is left exactly as is.
3. Crop to the tight bounding box of pixels with alpha > 0 and pad to a centred transparent square (here 128x128).

The nothing-is-redrawn rule still holds: the clean master only removes the frame; all other pixels are the supplied ones.
- The earlier blue-eye placeholder (SVGs, vector XML, generated PNGs) was deleted; its SHA-256 hashes are kept in
  `removed-placeholder-assets.txt`, and the default Capacitor assets' hashes in `removed-capacitor-assets.txt`.
  A unit test fails if any file under `android/`, `ios/`, `public/`, `build/`, `src/ui/assets` or `assets/` matches either ledger.
- `assets/branding/` contains only the two masters, this README, the two ledgers and the generated `play-store-512.png`.

## Generating the outputs
```bash
node scripts/generate-icons.mjs
# or: UNIVIEW_GENERATE_ICONS=1 npx vitest run tests/unit/branding-generate.test.ts
```
No new dependencies. The script drives headless Chromium through Playwright (already a devDependency) to resample with
`imageSmoothingQuality = "high"` (multi-step halving when downscaling), reading the browser from
`PLAYWRIGHT_BROWSERS_PATH` (default `I:\AES\Data\ms-playwright`, so nothing is downloaded). If Chromium cannot launch it
falls back to the project's Electron binary (same canvas code; force with `UNIVIEW_ICON_BACKEND=electron`). PNG and the
multi-size ICO are encoded in Node. The always-on tests only READ the committed assets.

## Layouts
The master is only 128 px, so everything above that size is an upscale (smooth, slightly soft; no extra detail is invented).
The master is square, so "full-size" means the logo fills the whole canvas (no margin).

| Surface | Output | Layout |
| --- | --- | --- |
| Windows | `build/icon.ico` (16, 24, 32, 48, 64, 128, 256 PNG frames) | logo full-size |
| macOS / Linux | `build/icon.png` (512), `build/icon-1024.png` | logo full-size, transparent corners |
| Web / PWA / favicon | `public/icon.png` (512), `public/favicon.png` (64) | logo full-size |
| In-app (Home, tab) | `src/ui/assets/logo.png` (256) | logo full-size |
| Electron window | `BrowserWindow` icon = `dist/icon.png` (packaged in the asar) | - |
| Play Store | `assets/branding/play-store-512.png` | OPAQUE (PNG colour type 2), full-bleed: the white logo fills the square on white |
| iOS AppIcon | `ios/.../AppIcon.appiconset/AppIcon-512@2x.png` (1024) | OPAQUE (colour type 2), full-bleed on white |
| iOS splash | `ios/.../Splash.imageset/splash-2732x2732{,-1,-2}.png` | logo ~256 px centred on white |
| Android legacy | `mipmap-*/ic_launcher.png` (48-192) | logo full-size |
| Android round | `mipmap-*/ic_launcher_round.png` | white circle, logo fitted inside it (74%) |
| Android adaptive | `mipmap-*/ic_launcher_foreground.png` (108-432) | logo in the 66% safe zone, transparent; background `#FFFFFF` (`values/ic_launcher_background.xml`) |
| Android splash | `drawable*/splash.png` (11 variants) | logo ~256 px (capped at half the short side) centred on white |

The adaptive icon XML (`mipmap-anydpi-v26/ic_launcher*.xml`) has background + foreground only: there is no
monochrome/themed layer, because that would not be "only this logo".

## Store rules
- iOS AppIcon must be an opaque square with no alpha channel (colour type 2); Play Store icon is opaque too.
