# UniView Brand Assets & Icon Pipeline

## The one logo
The ONLY logo for UniView, on desktop, web, Android and iOS, is the CEO-supplied image
`assets/branding/uniview-logo-source.png` (135x133 PNG: a white rounded square with a faint diagonal grid and two
crossing light-blue bars, on a near-black square frame). It is the single master, kept byte-identical to what was supplied.

- Master SHA-256: `10eb69956383c4bc78cf00eb4dda95710a7cf1a7417f201ff4fdca1bb6203e3a`
- Nothing is redrawn or restyled: every other file is a resampled copy of this image on a canvas.
- The earlier blue-eye placeholder (SVGs, vector XML, generated PNGs) was deleted; its SHA-256 hashes are kept in
  `removed-placeholder-assets.txt`, and the default Capacitor assets' hashes in `removed-capacitor-assets.txt`.
  A unit test fails if any file under `android/`, `ios/`, `public/`, `build/`, `src/ui/assets` or `assets/` matches either ledger.
- `assets/branding/` contains only the master, this README, the two ledgers and the generated `play-store-512.png`.

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
The master is only 135 px, so everything above that size is an upscale (smooth, slightly soft; no extra detail is invented).
The logo keeps its aspect ratio (contain-fit, longer side = the stated size).

| Surface | Output | Layout |
| --- | --- | --- |
| Windows | `build/icon.ico` (16, 24, 32, 48, 64, 128, 256 PNG frames) | logo full-size |
| macOS / Linux | `build/icon.png` (512), `build/icon-1024.png` | logo full-size, alpha as supplied |
| Web / PWA / favicon | `public/icon.png` (512), `public/favicon.png` (64) | logo full-size |
| In-app (Home, tab) | `src/ui/assets/logo.png` (256) | logo full-size |
| Electron window | `BrowserWindow` icon = `dist/icon.png` (packaged in the asar) | - |
| Play Store | `assets/branding/play-store-512.png` | OPAQUE (PNG colour type 2), logo on white |
| iOS AppIcon | `ios/.../AppIcon.appiconset/AppIcon-512@2x.png` (1024) | OPAQUE (colour type 2), logo on white |
| iOS splash | `ios/.../Splash.imageset/splash-2732x2732{,-1,-2}.png` | logo ~256 px centred on white |
| Android legacy | `mipmap-*/ic_launcher.png` (48-192) | logo full-size |
| Android round | `mipmap-*/ic_launcher_round.png` | white circle, logo fitted inside it (74%) |
| Android adaptive | `mipmap-*/ic_launcher_foreground.png` (108-432) | logo in the 66% safe zone, transparent; background `#FFFFFF` (`values/ic_launcher_background.xml`) |
| Android splash | `drawable*/splash.png` (11 variants) | logo ~256 px (capped at half the short side) centred on white |

The adaptive icon XML (`mipmap-anydpi-v26/ic_launcher*.xml`) has background + foreground only: there is no
monochrome/themed layer, because that would not be "only this logo".

## Store rules
- iOS AppIcon must be an opaque square with no alpha channel (colour type 2); Play Store icon is opaque too.
