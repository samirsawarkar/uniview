# UniView Brand Assets & Icon Pipeline (Packet P20 / P21)

## Overview & Executive Decision
In accordance with **CEO Decision 3 (2026-10-25)** documented in `.aes/research/ceo-decisions.md`, all default Capacitor trademark and logo assets have been replaced with an original, proprietary UniView geometric mark.

This ensures:
1. Zero trademark infringement of Ionic / Capacitor assets in production builds and app store submissions.
2. Complete multi-platform icon and splash coverage across Windows desktop, macOS/Linux, Web/PWA, Android (adaptive icons, legacy icons, round icons, monochrome layer, and splash screens), Google Play Store listing, and iOS.
3. Fully automated, deterministic generation from pure-JS Node.js tooling.

## Design Specification
- **Mark**: A modern geometric squircle containing a stylised eye lens formed by two overlapping circular arcs (`A 185 185 0 0 1`), a central pupil/lens, and a specular glint.
- **Color Palette**:
  - Primary Accent: Royal Blue `#2563EB` (RGB: 37, 99, 235)
  - Secondary: Crisp White `#FFFFFF` (RGB: 255, 255, 255)
  - Monochrome Variant: Jet Black `#000000` (RGB: 0, 0, 0)
- **Scalability**: High readability from 16 px (Windows taskbar / favicon) up to 2732 px (iOS splash screen).

## Master Vector Sources & Generator Architecture
- `assets/branding/uniview-icon.svg`: Master colored vector icon (512x512).
- `assets/branding/uniview-icon-monochrome.svg`: Monochrome / high-contrast vector icon (512x512).
- `assets/branding/play-store-512.png`: Google Play Store listing icon (512x512 full-bleed square).
- `assets/branding/removed-capacitor-assets.txt`: SHA-256 audit ledger of all deleted/replaced Capacitor assets (read-only verification).

### Architectural Note: Geometry & Dual-Maintenance
The icon generator script (`scripts/generate-icons.mjs`) contains the analytic geometry constants (`ICON_CONSTANTS`) and a pure-JS Signed Distance Field (SDF) rasterizer with deflation compression, rather than dynamically parsing `assets/branding/uniview-icon.svg`. 

Therefore, **the vector SVG/XML files and `scripts/generate-icons.mjs` must be edited together** whenever geometry or colours are modified. An automated unit test in `tests/unit/branding.test.ts` asserts that the master SVG's key numbers (viewBox, width/height, colours, and geometry radii) match `ICON_CONSTANTS` in `scripts/generate-icons.mjs` to prevent drift.

## Store Submission & Icon Masking Rules
- **iOS AppIcon (`ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`)**: Must be a 1024x1024 full-bleed OPAQUE square with NO alpha channel (PNG colour type 2, 24-bit Truecolour RGB). iOS App Store rules reject icons with an alpha channel or transparent corners because iOS applies the squircle mask dynamically at runtime.
- **Google Play Store (`assets/branding/play-store-512.png`)**: Must be a 512x512 full-bleed square with NO transparent corners (opaque corners at (0,0)). Google Play applies squircle corner masking and drop shadows dynamically upon store ingestion.

## Replacement Instructions for Future Final Artwork
When the design team delivers final polished artwork to replace this placeholder:

1. **Update Master Vector Files**:
   - Update `assets/branding/uniview-icon.svg` with the new colored SVG artwork.
   - Update `assets/branding/uniview-icon-monochrome.svg` with the monochrome version.
2. **Synchronize Generator Constants**:
   - Update `ICON_CONSTANTS` and SDF math in `scripts/generate-icons.mjs` to match the new vector numbers.
3. **Re-run the Asset Generator**:
   - Execute the icon generation script:
     ```bash
     node scripts/generate-icons.mjs
     ```
   - Alternatively, trigger regeneration via test suite:
     ```bash
     UNIVIEW_GENERATE_ICONS=1 npx vitest run tests/unit/branding-generate.test.ts
     ```
4. **Verify Integrity**:
   - Run the verification test suite:
     ```bash
     npx vitest run tests/unit/branding.test.ts
     ```
   - This asserts that all 36+ generated PNG/ICO files exist, have exact dimensions, correct colour types (PNG colour type 2 for iOS), opaque corners for Play Store/iOS, and differ from all recorded Capacitor hashes.

## Target Output Locations

### Desktop & Web
- `build/icon.ico`: Multi-resolution Windows ICO (16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256).
- `build/icon.png`: 512x512 PNG for macOS and Linux packaging.
- `public/icon.png`: 512x512 PNG for Web manifest / PWA.
- `public/favicon.png`: 64x64 PNG browser tab icon.
- `src/ui/assets/logo.png`: 256x256 PNG for in-app UI (Home drop zone, tab headers).

### Android (`android/app/src/main/res/`)
- **Adaptive Foreground**: `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher_foreground.png` (108, 162, 216, 324, 432 px).
- **Adaptive Foreground Vector**: `drawable-v24/ic_launcher_foreground.xml`.
- **Adaptive Background Vector & Values**: `drawable/ic_launcher_background.xml` & `values/ic_launcher_background.xml`.
- **Adaptive Monochrome Layer**: `drawable/ic_launcher_monochrome.xml`.
- **Legacy Launcher**: `mipmap-{mdpi..xxxhdpi}/ic_launcher.png` (48, 72, 96, 144, 192 px).
- **Round Launcher**: `mipmap-{mdpi..xxxhdpi}/ic_launcher_round.png` (48, 72, 96, 144, 192 px).
- **Splash Screens**:
  - `drawable/splash.png` (480x320)
  - `drawable-port-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/splash.png` (320x480, 480x800, 720x1280, 960x1600, 1280x1920)
  - `drawable-land-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/splash.png` (480x320, 800x480, 1280x720, 1600x960, 1920x1280)

### iOS (`ios/App/App/Assets.xcassets/`)
- **App Icon**: `AppIcon.appiconset/AppIcon-512@2x.png` (1024x1024, colour type 2, opaque square).
- **Splash**: `Splash.imageset/splash-2732x2732{,-1,-2}.png` (2732x2732).
