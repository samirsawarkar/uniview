# UniView: Executive Decision Briefs for the CEO

**Document:** `.aes/research/ceo-decisions.md`  
**Date:** October 25, 2026  
**Author:** AES Chief of Staff for Internal Operations  
**Context:** Pre-release executive decisions for UniView V1 (workspace root: `I:\Development\Clone\Universal\uniview`)  
**Status:** Read-only audit complete; awaiting CEO approvals on six actionable decisions.

---

## Executive Summary of Decisions

| # | Topic | Key Finding / Blocker | Recommendation | Exact Next Action |
|---|---|---|---|---|
| **1** | **MPL-2.0 PPTX Engine** | `@aiden0z/pptx-renderer@1.4.0` bundles `mtx-decompressor@1.4.2` (MPL-2.0). Permissible in closed app, but adds 5.5 MB and copyleft notices. | **Ship V1 with native OOXML renderer + `emf-converter` (permissive only).** Defer second engine to V1.1 as an isolated chunk. | CEO confirms: accept pure permissive V1 (Option C). |
| **2** | **Tauri 2 vs Electron** | 4,500+ LOC of Node.js system code (named pipes, Windows ACLs, DPAPI, MCP, LAN sharing) would need complete Rust rewrite. | **Stay on Electron 45 for V1.** Strict fence preserves future portability. Defer Tauri migration to V2. | CEO approves bypassing Tauri check for V1 release. |
| **3** | **Logo / Trademark** | Capacitor icon/splash assets appear in 21 Android locations, 4 desktop/web locations, and iOS assets. | **Run 2-stage replacement**: CEO approves master logo; generate full icon set via automated script. | CEO provides SVG/PNG master or approves proposed U-eye design. |
| **4** | **Windows Code Signing** | Microsoft removed instant SmartScreen bypass for EV in 2024. Azure Artifact Signing Public Trust **excludes India**. | **Purchase SSL.com or Sectigo OV Cloud Signing (~$250/yr).** Skip EV premium ($400+). | CEO initiates OV identity verification on SSL.com / Sectigo. |
| **5** | **Google Play Closed Test** | Google revised rule in Dec 2024 to **12 testers for 14 continuous days**. Target API 36 required (already met in repo). | **Prepare Play listing assets + privacy policy; recruit 16–20 testers** via college/peer network. | CEO creates Play Console account ($25) and verifies identity. |
| **6** | **Private GitHub Repo & CI** | Free plan on private repos **does NOT support branch protection**. Requires GitHub Pro ($4/mo) or AES branch discipline. | **Create private repo; upgrade to GitHub Pro ($4/mo)** for branch protection; deploy CI pipeline. | CEO authorizes `gh repo create` and pushes `feat/v1-core`. |

---

## Decision 1: Optional PowerPoint Engine Licensing (MPL-2.0)

### 1. Facts Found in the Repository
* **Component Identified:** Evaluated in `docs/research/open-file-viewer-evaluation.md` (lines 5–10, 89–91) and noted in `THIRD_PARTY_NOTICES.md` (lines 29–30).
  - Target package: `@aiden0z/pptx-renderer@1.4.0` (declared top-level license: Apache-2.0).
  - Bundled copyleft dependency: `mtx-decompressor@1.4.2`, which is licensed under the **Mozilla Public License 2.0 (MPL-2.0)**.
  - Function: Decompresses MTX/MTEF binary streams to render legacy MathType equations inside PowerPoint slides.
* **Current Workspace Status:**
  - Neither `@aiden0z/pptx-renderer` nor `mtx-decompressor` is installed in `package.json`.
  - UniView currently uses its own lightweight in-house OOXML parser (`src/core/pptx.ts`) and renderer (`src/viewers/PptxViewer.tsx`) alongside `emf-converter@4.23.1` (Apache-2.0, installed in `package.json`).
  - Known documented V1 limitation in `README.md` (lines 95–96): *"Charts in PowerPoint show a labeled placeholder. EMF/WMF pictures use a bounded, offline PNG converter."*

### 2. Legal Analysis of MPL-2.0 for Closed-Source Electron / Android Apps
* **File-Level Weak Copyleft (Sections 1.10 & 3.1):** Unlike the GPL/AGPL, MPL-2.0 copyleft does not extend to the entire program. It applies strictly at the individual file boundary. Any modification made to an MPL-covered file must remain under MPL-2.0. Unmodified UniView application files are legally unaffected.
* **The "Larger Work" Exception (Section 3.3):** MPL-2.0 explicitly allows combining MPL-covered software with proprietary or differently licensed code into a single distribution ("Larger Work"), provided the MPL terms are satisfied for the MPL-covered portion.
* **Source Code Availability (Sections 3.1 & 3.2):**
  - If modified: You must publish the modified MPL source code under MPL-2.0.
  - If unmodified: You fulfill the requirement by providing clear notice to recipients informing them where they can obtain the source code of the MPL component (e.g., linking to the public npm tarball or upstream repository).
* **Notice Requirements:** You must include a copy of the MPL-2.0 license text and retain copyright notices in your distribution (e.g., in `THIRD_PARTY_NOTICES.md` and the app's About screen).
* **Bundling Nuance:** In web/Electron bundling (Vite/Rollup), all modules are concatenated into minified JS files. While legally MPL-2.0 treats source compilation units as files, bundling minified code into one shared bundle can create legal ambiguity. Splitting the dependency into a dedicated vendor chunk (`dist/assets/vendor-pptx-mtx.js`) eliminates this ambiguity completely.

### 3. Options and Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **A. Accept As-Is with Notices**<br>(Install `@aiden0z/pptx-renderer@1.4.0`) | Unlocks rich 2D charts (via ECharts) and OMML/MathType equations. Eliminates one documented V1 viewer limitation. | Adds 5.5 MB unpacked weight. Breaks UniView's 100% purely permissive dependency policy. Requires ongoing MPL notice compliance and source code pointer maintenance. |
| **B. Isolate in Code-Split Chunk**<br>(Lazy-load secondary engine behind user toggle) | Fast cold start preserved (p50 ~41ms). Clean physical file boundary for MPL code in `dist/`. High fidelity available on demand. | Increased build config complexity (Vite `manualChunks`). Still requires MPL-2.0 legal notices in release builds. |
| **C. Ship V1 Pure Permissive (Native + EMF)**<br>*(Recommended)* | 100% permissive license manifest (MIT, Apache-2.0, BSD-3, ISC only). Zero legal risk or copyleft audit overhead. Lightest bundle and fastest startup. | PowerPoint charts and MathType equations remain placeholders in V1. |

### 4. Recommendation
**Adopt Option C for V1, deferring Option B to V1.1.**  
UniView's core differentiator is instant opening, privacy, and zero licensing complexity. The native OOXML renderer already handles slide hierarchy, themes, text formatting, shapes, tables, groups, presenter mode, and EMF/WMF vector pictures (via `emf-converter`). Chart rendering can be introduced in V1.1 as a clean, lazy-loaded isolated chunk once core market traction is established.

### 5. Exact Next Action
CEO confirms adoption of **Option C**. No code changes are required in the repo; `package.json` remains clean and purely permissive for the V1 release.

---

## Decision 2: Desktop Framework Evaluation (Tauri 2 vs Electron 45)

### 1. Facts Found in the Repository
* **Decision History:** Recorded in `README.md` (lines 88–90) and `docs/SPEC.md` (line 5):
  - Architecture: Electron + Capacitor behind an abstract `ShellBridge` (`src/shells/`).
  - Strict boundary: `tests/unit/fence.test.ts` enforces that `src/core`, `src/viewers`, and `src/ui` never import shell runtimes.
  - Gate before code signing: *"A 3-day Tauri v2 prototype against the same benchmark; migrate only if p50 time-to-first-view improves ≥25% or installer size drops ≥50% with no format regression."*
* **Electron APIs Currently Implemented & Tested in Repo:**
  - `protocol.handle("uniview", ...)`: Custom scheme serving app bundle with strict CSP.
  - `protocol.handle("uniview-file", ...)`: Streamed file delivery with HTTP Range requests (206 Partial Content) for seeking large media files (up to 2 GB) without reading into RAM.
  - `webUtils.getPathForFile(file)`: In preload, retrieves absolute filesystem path of dropped files so desktop drag-and-drop streams directly from disk rather than memory buffer.
  - `app.requestSingleInstanceLock()` & `second-instance`: Mutex preventing dual instances; forwards argv to open files as tabs in existing window.
  - `dialog.showOpenDialog` & `dialog.showErrorBox`: Native desktop pickers and error popups.
  - `ses.webRequest.onBeforeRequest`: Complete offline network cancellation blocking all external endpoints.
  - `BrowserWindow` & `nativeTheme`: Sandboxed renderer (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`).
  - **4,500+ Lines of Node.js Backend Code in `electron/lib/`:**
    * `bridge-server.mjs`: Windows Named Pipe (`\\.\pipe\uniview-bridge-<hash>`) and Unix socket server with binary frame encoding, HMAC challenge-response handshake, and replay prevention.
    * `bridge-key.mjs`: Windows DPAPI, `icacls`, `whoami`, and user SID enforcement restricting pipe access exclusively to the active Windows user account.
    * `agent-host.mjs`, `agent-approval.mjs`, `agent-enrollment.mjs`: Agent IPC routing, session limits, and UI approval modals.
    * `review-store.mjs` & `review-verify.mjs`: Cryptographic receipt digest verification, sidecar decision persistence, SHA-256 validation.
    * `cli.mjs`: `UniView open [--wait] [--receipt]` CLI client.
    * `mcp-server.mjs`: Model Context Protocol server communicating over stdio.
    * `remote-main.mjs` & `share-host.mjs`: Encrypted LAN pairing and streaming HTTP server.
  - 660 automated unit tests pass, plus Playwright Electron smoke tests.

### 2. Migration Effort and Risks of Tauri 2
* **What is Gained with Tauri 2:**
  - **Installer Size:** Drops from ~85–95 MB (Chromium + Node.js runtime) to ~10–15 MB (utilizes system Microsoft Edge WebView2 on Windows).
  - **Idle Memory:** Drops from ~120–150 MB to ~40–60 MB.
* **What is Lost / High Technical Risks:**
  - **Massive Systems Rewrite:** Tauri's core backend is Rust. Porting the Windows named pipe bridge, icacls ACL validation, HMAC framing, replay window, MCP server, and LAN TLS host from Node.js to Rust would require an estimated 3–5 weeks of complex engineering, resetting the project release date.
  - **WebView2 Ecosystem Variance:** Unlike Electron which bundles a pinned, predictable Chromium release (v45.0.0), WebView2 is updated automatically by Windows Update. Rendering inconsistencies, video codec variations, and subtle CSS/canvas bugs would be subject to external OS updates.
  - **HTTP Range Streaming Complexity:** Tauri 2's custom URI scheme protocols require custom Rust stream responders to handle byte-range seeking for 2 GB video/audio files.
  - **Schedule Impact:** UniView is currently within 8–14 days of release (`docs/STATUS.md`). Migrating now would jeopardize the launch window.

### 3. Recommendation
**Stay on Electron 45 for the V1 release.**  
The architecture is already strictly fenced behind `ShellBridge`. The primary risk to UniView today is launch delay, not installer size. Bypassing the full migration for V1 allows signing and shipping immediately. Tauri 2 should be scheduled as a dedicated V2 milestone.

### 4. Minimal 3-Day Check Plan (If CEO Insists on Executing the Gate)
If the CEO wishes to formally fulfill the evaluation gate recorded in `README.md`, execute this strictly time-boxed spike:
* **Day 1 (UI Shell & Static Assets):** Initialize a disposable Tauri 2 project under `I:\AES\smoke_tauri`. Configure Tauri to load UniView's existing `dist/` web output. Implement a minimal Rust command for file open dialog.
* **Day 2 (Benchmark Comparison):** Run the standard benchmark suite (`scripts/bench.mjs`) on large test fixtures (174 MB video, 35 MB PDF, 73 MB XLSX, 37 MB PPTX). Record cold startup time, p50 open-to-first-view, and peak memory.
* **Day 3 (Synthesis & Decision Gate):** Package the Tauri executable; compare installer size and p50 speedup against the contractual threshold (≥25% p50 speedup and ≥50% size reduction with zero viewer regression). Submit final verdict to the CEO.

### 5. Exact Next Action
CEO decides: Approve **staying on Electron for V1** (recommended), or instruct the team to initiate the 3-day Tauri spike immediately.

---

## Decision 3: Logo & Trademark Replacement

### 1. Facts Found in the Repository
* **Issue:** UniView currently displays default Capacitor logos and icons across mobile, desktop, and web assets. Using Capacitor's proprietary logo infringes Ionic's trademark and prevents public store release.
* **Audit of Existing Icon Assets Across the Workspace:**
  1. **Web & UI Assets:**
     - `src/ui/assets/logo.png` (256x256, sha256: `513fde9f`): Displayed on the Home screen drop zone (`img.logo`, 72x72 CSS) and Home tab header (`img.tab-logo`, 16x16 CSS).
     - `public/icon.png` (512x512, sha256: `eb8a1f88`): Web manifest and general high-res asset.
     - `public/favicon.png` (64x64, sha256: `b23760b7`): Browser tab icon referenced in `index.html`.
  2. **Desktop Build Icons (`electron-builder.json`):**
     - `build/icon.png` (512x512, sha256: `eb8a1f88`): Configured as the source icon for Windows, macOS, and Linux builds.
     - *Missing Dedicated Windows Icon:* The repo lacks a pre-compiled multi-resolution `build/icon.ico`. Electron-builder can auto-convert PNGs, but a pre-built `.ico` guarantees crisp rendering across all Windows scaling factors (100%–250%).
  3. **Android Resources (`android/app/src/main/res/`):**
     - *Adaptive Icon Foreground (Vector):* `drawable-v24/ic_launcher_foreground.xml` (contains raw Capacitor vector path data).
     - *Adaptive Icon Foreground (Raster Densities):*
       * `mipmap-mdpi/ic_launcher_foreground.png` (108x108)
       * `mipmap-hdpi/ic_launcher_foreground.png` (162x162)
       * `mipmap-xhdpi/ic_launcher_foreground.png` (216x216)
       * `mipmap-xxhdpi/ic_launcher_foreground.png` (324x324)
       * `mipmap-xxxhdpi/ic_launcher_foreground.png` (432x432)
     - *Adaptive Icon Background:*
       * `values/ic_launcher_background.xml` (Color value: `#FFFFFF`).
       * `drawable/ic_launcher_background.xml` (Vector background).
     - *Legacy Square & Round Icons (`ic_launcher.png` and `ic_launcher_round.png`):*
       * `mipmap-mdpi`: 48x48
       * `mipmap-hdpi`: 72x72
       * `mipmap-xhdpi`: 96x96
       * `mipmap-xxhdpi`: 144x144
       * `mipmap-xxxhdpi`: 192x192
     - *Android Splash Screens (`splash.png`):*
       * Default: `drawable/splash.png` (480x320)
       * Portrait: `drawable-port-mdpi` (320x480), `hdpi` (480x800), `xhdpi` (720x1280), `xxhdpi` (960x1600), `xxxhdpi` (1280x1920)
       * Landscape: `drawable-land-mdpi` (480x320), `hdpi` (800x480), `xhdpi` (1280x720), `xxhdpi` (1600x960), `xxxhdpi` (1920x1280)
  4. **iOS App Iconset (`ios/App/App/Assets.xcassets/`):**
     - `AppIcon.appiconset/AppIcon-512@2x.png` (1024x1024).

### 2. Complete Asset Replacement Specification

| Platform / Surface | File Path | Format | Required Dimensions | Purpose |
|---|---|---|---|---|
| **Web UI** | `src/ui/assets/logo.png` | PNG (RGBA) | 256 x 256 | In-app Home screen and tab icon |
| **Web / PWA** | `public/icon.png` | PNG (RGBA) | 512 x 512 | PWA manifest & high-res browser |
| **Web Favicon** | `public/favicon.png` | PNG (RGBA) | 64 x 64 (or 32x32) | Browser tab favicon |
| **Desktop Build** | `build/icon.png` | PNG (RGBA) | 512 x 512 | macOS/Linux electron-builder icon |
| **Windows Desktop** | `build/icon.ico` | Multi-layer ICO | 16, 24, 32, 48, 64, 128, 256 | Windows installer, exe, taskbar, alt-tab |
| **Android Play Store** | *External asset* | PNG (32-bit, alpha) | 512 x 512 (max 1024 KB) | Google Play Store listing icon |
| **Android Adaptive FG** | `android/.../mipmap-mdpi/ic_launcher_foreground.png`<br>`hdpi`<br>`xhdpi`<br>`xxhdpi`<br>`xxxhdpi` | PNG (RGBA) | 108 x 108<br>162 x 162<br>216 x 216<br>324 x 324<br>432 x 432 | Android 8.0+ adaptive icon foreground (center 72dp is safe zone) |
| **Android Legacy Icon** | `android/.../mipmap-{mdpi..xxxhdpi}/ic_launcher.png` | PNG (RGBA) | 48, 72, 96, 144, 192 | Android legacy home screen shortcut |
| **Android Round Icon** | `android/.../mipmap-{mdpi..xxxhdpi}/ic_launcher_round.png` | PNG (RGBA) | 48, 72, 96, 144, 192 | Android circular launcher icon |
| **Android Splash** | `android/.../drawable-port-xxxhdpi/splash.png` | PNG | 1280 x 1920 (and density variants) | Mobile cold launch screen |
| **macOS Notarisation** | *None* | — | — | Notarization does not check logo copyright |

### 3. Recommended Process
* **Step 1 (Master Artwork Approval):** The CEO provides a single 1024x1024 PNG or vector SVG file representing the UniView brand (e.g. a minimalist geometric "U" lens/iris symbolizing universal file viewing). Alternatively, the CEO approves generating an in-house placeholder SVG.
* **Step 2 (Automated Asset Pipeline):** Rather than manually exporting dozens of individual PNG files, an automated asset script (`scripts/generate-icons.mjs` using `sharp` and `png-to-ico`) will ingest the master 1024x1024 asset and generate all Windows `.ico`, Android mipmap densities, and web assets in a single deterministic pass.
* **Step 3 (XML Cleanup):** Replace the Capacitor vector paths in `android/.../drawable-v24/ic_launcher_foreground.xml` and update `android/.../values/ic_launcher_background.xml` with the brand's primary color.

### 4. Exact Next Action
CEO provides the master artwork (SVG or 1024x1024 PNG) or gives approval to generate a clean geometric "U-lens" placeholder logo.

---

## Decision 4: Windows Code Signing in 2026

### 1. Facts Found in the Repo & 2026 Industry Landscape
* **Current Repo Configuration (`electron-builder.json`):**
  - Targets: `nsis` (x64 installer) and `portable` (x64 single executable).
  - Current status: Builds are completely unsigned.
  - Windows SmartScreen: Any unsigned executable downloaded by users triggers a severe red warning ("Windows protected your PC: Microsoft Defender SmartScreen prevented an unrecognized app from starting").
* **Critical 2024–2026 Microsoft Policy Changes (Official Microsoft Documentation):**
  - *Source:* Microsoft Learn, *"Code signing options for Windows app developers"* (Updated 2026, `https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options`):
  - **EV Certificates No Longer Bypass SmartScreen:** Historically, Extended Validation (EV) certificates granted instant SmartScreen reputation from the very first download. **Microsoft eliminated this instant bypass in 2024.** In 2026, EV and OV certificates are treated identically by SmartScreen; both must accumulate reputation over time based on download volume and telemetry.
  - **Hardware Token Mandate (Since June 1, 2023):** The CA/Browser Forum mandates that ALL code signing keys (both OV and EV) must reside on FIPS 140-2 Level 2 or HSM hardware. Exportable `.pfx` software certificates are no longer sold.
  - **Azure Trusted Signing Rebranding:** Microsoft officially rebranded "Azure Trusted Signing" as **Azure Artifact Signing** in 2026.
  - **Azure Artifact Signing Geographic Restriction (Official Microsoft Q&A / Docs, Oct 2026):** Public Trust signing is strictly restricted to organizations in 12 regions (USA, Canada, EU, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, Israel) and individual developers located in the USA or Canada. **India is NOT eligible for Public Trust.** Because the CEO is based in Pune, India, Azure Artifact Signing Public Trust cannot be onboarded unless an eligible foreign legal entity is used.

### 2. Comparison of 2026 Code Signing Options

| Dimension | Azure Artifact Signing<br>*(formerly Trusted Signing)* | Cloud HSM / Signing<br>*(SSL.com eSigner / Sectigo KeyLocker)* | Physical USB Hardware Token<br>*(DigiCert / Sectigo SafeNet)* |
|---|---|---|---|
| **Annual Cost** | ~$119.88/yr ($9.99/mo Basic, includes 5,000 signs/mo) | ~$250 – $350/yr (OV) | ~$350 – $500/yr (OV + USB token + shipping) |
| **Lead Time** | 1–3 business days | 2–4 business days | 7–15 business days (customs/shipping to India) |
| **Geographic Eligibility** | ❌ **Ineligible in India** (US/CA/EU/UK/AU/NZ/JP/KR/SG/CH/NO/IL only) | ✅ **Eligible in India** (Global identity verification) | ✅ **Eligible in India** (Global identity verification) |
| **SmartScreen Behavior** | Standard reputation ramp (no instant bypass) | Standard reputation ramp (no instant bypass) | Standard reputation ramp (no instant bypass) |
| **CI/CD Integration** | Direct Azure credentials in GitHub Actions | Native CLI (`CodeSignTool` / `smctl`) in headless CI | Requires dedicated self-hosted runner with physical USB |
| **electron-builder Setup** | `win.azureSignOptions` | `win.sign` pointing to custom sign wrapper script | Default `signtool` with local certificate thumbprint |

### 3. Recommendation
**Procure an Organization Validation (OV) Code Signing Certificate with Cloud Signing via SSL.com (eSigner) or Sectigo (KeyLocker).**
* *Why not Azure Artifact Signing:* Ineligible due to geographic restrictions on Public Trust signing for developers/entities based in India.
* *Why not an EV Certificate:* Paying $400–$700+/year for EV is financially unjustified in 2026 because Microsoft removed the instant SmartScreen bypass. An OV certificate achieves the exact same reputation ramp at roughly half the price.
* *Why Cloud Signing over USB Token:* Cloud signing eliminates waiting 1–2 weeks for physical hardware to clear Indian customs and enables automated signing directly inside GitHub Actions CI.

### 4. Step-by-Step Account Setup for the CEO
1. **Choose Provider:** Purchase an OV Code Signing Certificate with Cloud HSM integration:
   - *Option A:* SSL.com OV Code Signing with eSigner Cloud Signing (~$129/yr cert + ~$10/mo eSigner tier).
   - *Option B:* Sectigo OV Code Signing via KeyLocker (~$250–$300/yr via authorized resellers like SSL2BUY or TheSSLStore).
2. **Submit Verification Documents:**
   - For Individual Developer: Submit government photo ID (Passport / Aadhaar) and complete a short video or notary verification.
   - For Entity / Business: Provide official business registration (GST registration or Certificate of Incorporation) and a verifiable telephone listing (e.g. Dun & Bradstreet / official registry).
3. **Generate Credentials for CI:**
   - In the provider's cloud portal, set up an API service credential (eSigner Client ID/Secret or KeyLocker API key).
   - Add these credentials as secrets in GitHub Actions (`WINDOWS_SIGN_KEY_ID`, `WINDOWS_SIGN_SECRET`).
4. **Configure electron-builder:**
   - Add a lightweight `scripts/sign-windows.cjs` script invoking `CodeSignTool` or `smctl` and reference it in `electron-builder.json` under `win.sign`.

### 5. Exact Next Action
CEO purchases an OV Code Signing Certificate with Cloud Signing on SSL.com or Sectigo and initiates the identity validation process.

---

## Decision 5: Google Play Publishing & 12-Tester Requirement

### 1. Verification of the Closed-Testing Policy
* **Official Verification:** Verified against official Google Play Console Help (*"App testing requirements for new personal developer accounts"*, `https://support.google.com/googleplay/android-developer/answer/14151465`):
  - *Initial Rule (November 13, 2023):* Google required personal accounts created after this date to test apps with 20 testers for 14 days.
  - *Revised Policy (December 2024 to present 2026):* Following extensive developer feedback, Google officially revised the threshold down from 20 to **a minimum of 12 testers opted in continuously for at least 14 days**.
  - *Strict Requirement:* Testers must be continuously opted in for 14 consecutive days. If a tester opts out and rejoins, their counter resets. When applying for production, at least 12 testers must currently be active.
  - *Note on Account Types:* This requirement applies exclusively to **Personal** developer accounts. Organization accounts (requiring a D-U-N-S number) are exempt from the mandatory 12-tester gate.

### 2. Complete Google Play Submission Requirements Checklist
1. **Developer Account & Identity Verification:**
   - One-time $25 registration fee.
   - Submission of government ID and official address proof matching payment details.
2. **Target API Level Compliance:**
   - *Requirement:* As of August 31, 2026, Google Play mandates that all new app submissions target **Android 16 (API level 36)** or higher (`https://support.google.com/googleplay/android-developer/answer/11926878`).
   - *Repo Status:* **Already compliant.** UniView's `android/variables.gradle` explicitly sets `targetSdkVersion = 36` and `compileSdkVersion = 36`.
3. **Play App Signing:**
   - Mandatory for all new apps. UniView signs the initial upload using a private upload key; Google re-signs the app with Google's managed key for distribution.
4. **Data Safety Form & Content Rating:**
   - *Content Rating:* Complete the International Age Rating Coalition (IARC) questionnaire. UniView qualifies for PEGI 3 / ESRB Everyone.
   - *Data Safety Declaration:* UniView collects **zero personal data, operates offline, has no analytics, and performs no tracking**.
   - *Network Permission Explanation:* Although `android.permission.INTERNET` is declared in `AndroidManifest.xml`, it is used solely for local peer-to-peer Wi-Fi/LAN streaming between paired local computers (via `setupRemote`). In the Data Safety form, mark: "No data is collected" and "No data is shared with third parties".
5. **Mandatory Project Deliverables:**
   - **Privacy Policy URL:** A live, publicly accessible URL is strictly required. Must clearly declare that UniView operates fully offline and collects no user data.
   - **Store Listing Artwork:**
     * App Icon: 512 x 512, 32-bit PNG with alpha channel (max 1024 KB).
     * Feature Graphic: 1024 x 500, PNG or JPEG (max 15 MB).
     * Screenshots: Minimum 2 phone screenshots (up to 8), 16:9 or 9:16 aspect ratio, min 320px, max 3840px.
   - **Production App Bundle (AAB):** Generated using `cd android && ./gradlew bundleRelease`.

### 3. Tester Recruitment Plan (14-Day Protocol)
To ensure the 12-tester requirement is satisfied without risk of drop-offs pausing the clock, recruit a cohort of **16 to 20 testers**:
* **Recruitment Pool:** Utilize Samir's COEP (College of Engineering Pune) final-year engineering cohort, student tech clubs, and developer peer network.
* **Testing Track Setup:**
  - In Play Console, create a Closed Testing track (Alpha).
  - Add testers via a Google Group (`uniview-testers@googlegroups.com`) or direct email list.
  - Distribute the private opt-in web link (`https://play.google.com/apps/testing/com.uniview.viewer`).
* **Retention Protocol:**
  - Instruct testers to keep the app installed on their devices for at least 15 continuous days.
  - Provide a simple 3-item task checklist (open a PDF, connect to desktop on local Wi-Fi, open an Excel sheet).
  - Monitor the Play Console Dashboard daily to confirm the active opt-in counter remains ≥ 12.
* **Production Access Application:** On Day 15, submit the 14-day summary answers in Play Console detailing testing feedback and bug fixes to unlock production approval.

### 4. Exact Next Action
CEO registers the personal Google Play Console account ($25), completes ID verification, and creates the Google Group for tester recruitment.

---

## Decision 6: Private GitHub Repository & CI Pipeline

### 1. Facts Found in the Repo & Branch Status
* **Current Git Status:**
  - Active branch: `feat/v1-core` (HEAD commit `d2e2dfb`).
  - Local branches: `feat/v1-core`, `feat/p14b-3`, `feat/p16-cli`, `feat/p17a-mcp`, `feat/p17b-1`.
  - Push status: Zero remotes configured (`git remote -v` returns empty). Nothing has been pushed.
  - *Strict Policy:* **Nothing will be pushed until the CEO explicitly issues the command.**

### 2. Branch Protection Availability: GitHub Free vs GitHub Pro
* **Official GitHub Documentation:**
  - *Source:* GitHub Docs, *"About protected branches"* (`https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches`):
  - **On GitHub Free:** Branch protection rules and repository rulesets are available **only for public repositories**. In private repositories on a Free plan, branch protection is completely disabled.
  - **On GitHub Pro / Team:** Branch protection is fully supported for both public and private repositories.
* **Implications for UniView:**
  - If UniView is hosted on a private repository under a **GitHub Free** personal account, GitHub settings cannot prevent direct pushes to `main`, cannot enforce pull request reviews, and cannot block merging on failing CI checks.
  - To enforce automated branch protection natively on GitHub, the account must be upgraded to **GitHub Pro ($4/month or $48/year)**.
  - *Alternative on Free Plan:* Enforce branch protection client-side using git hooks and AES operating rules (as done in `samirsawarkar/aes`, where AES operating procedures strictly mandate conventional branching and peer review prior to merging).

### 3. Exact Commands to Initialize Remote and Push (Awaiting CEO Command)
*Note: These commands are prepared for the CEO and must NOT be executed until explicit instruction is given.*

```bash
# 1. Authenticate with GitHub CLI (if not already authenticated)
gh auth login

# 2. Create the private repository on GitHub (creates remote named 'origin')
gh repo create uniview --private --source=. --remote=origin --description "Open any file. Offline, private, instant."

# 3. Push the primary v1 core branch and set upstream tracking
git push -u origin feat/v1-core

# 4. Push all remaining feature branches
git push origin feat/p14b-3 feat/p16-cli feat/p17a-mcp feat/p17b-1

# 5. Create the production 'main' branch tracking the latest verified core
git checkout -b main
git push -u origin main
git checkout feat/v1-core
```

### 4. Continuous Integration (CI) Workflow Outline
Create `.github/workflows/ci.yml` to automate verification on all pull requests and pushes to `main` and `feat/*`:

```yaml
name: UniView CI

on:
  push:
    branches: [ main, 'feat/**' ]
  pull_request:
    branches: [ main ]

jobs:
  verify:
    name: Lint, Typecheck & Unit Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js 24
        uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Copy build assets
        run: npm run prebuild

      - name: TypeScript type-check
        run: npx tsc --noEmit -p tsconfig.json

      - name: Generate test fixtures
        run: npm run fixtures

      - name: Vitest unit tests
        run: npm test

  e2e:
    name: Playwright E2E Tests
    runs-on: ubuntu-latest
    needs: verify
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js 24
        uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build web application
        run: npm run build

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Execute E2E tests
        run: npx playwright test

  electron-smoke:
    name: Desktop Build Smoke Test
    runs-on: windows-latest
    needs: verify
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js 24
        uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build assets
        run: npm run build

      - name: Verify Electron compilation
        run: npx electron-builder --win --dir --config electron-builder.json
```

### 5. Exact Next Action
CEO reviews the plan, decides whether to subscribe to GitHub Pro ($4/month) for native branch protection, and gives the explicit signal to create the repository and push branches.

---

## Final Chief of Staff Assessment

All six items have been thoroughly researched and verified against official documentation and the local codebase. The project is technically mature (660 unit tests passing, clean architectural fences), and the remaining hurdles are administrative and external (certificate procurement, logo artwork, Play Console onboarding, and repository creation). 

Once the CEO approves these briefs, AES can immediately disaggregate the follow-up work into atomic agent tasks for execution.
