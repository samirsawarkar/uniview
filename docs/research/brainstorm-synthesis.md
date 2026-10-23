OPTIONS MATRIX: CROSS-PLATFORM UNIVERSAL FILE VIEWER
(Merged across all perspectives; duplicates consolidated)


1. ARCHITECTURE AND STACK OPTIONS

Option 1.1: Web-Unified (Electron Desktop + Capacitor Mobile + React/TS)
  Description:
    Single React/TypeScript codebase for UI (tabs, omnibox, drag-and-drop) running in Electron on Windows/macOS and Capacitor on Android/iOS. Reuses web-based format engines.
  Pros:
    - Maximum code sharing (85-95% UI and viewer logic reuse).
    - Fastest development velocity and rapid MVP delivery.
    - Native-like tabs and drag-and-drop are trivial in web tech.
  Cons / Trade-offs:
    - Worst cold-start Time-to-First-View (TTFV >1.2s to 2.5s) due to Chromium/Node startup.
    - High memory footprint (150-250 MB idle baseline).
    - Engine fragmentation on iOS (Apple forces WebKit, creating dual-engine rendering edge cases vs Chromium).
    - High mobile memory pressure; large PDFs or spreadsheets can crash mobile webviews.

Option 1.2: Modern Native Webview Shell (Pure Tauri v2 Desktop & Mobile + Rust Core)
  Description:
    Tauri v2 running across Windows (WebView2), macOS (WKWebView), Android, and iOS (WKWebView). Single React/TS UI backed by a shared Rust engine for archive indexing, file I/O, parsing, and caching.
  Pros:
    - Drastically smaller app binary (<30 MB vs 150 MB+ for Electron).
    - Substantially faster cold-start TTFV (<250ms desktop, <400ms mobile).
    - Single UI codebase for Chrome-like UX (tabs, omnibox, drag-and-drop).
    - WebKit parity: macOS and iOS both run WebKit, reducing engine divergence.
    - Rust backend provides zero-cost FFI, memory safety, and thread-pooled archive handling.
  Cons / Trade-offs:
    - OS Webview dependencies: Windows requires WebView2 runtime; older Android versions have varying system webviews.
    - Mobile Tauri v2 plugin ecosystem is younger than Capacitor/React Native.

Option 1.3: React Native Multiplatform (RN Windows/macOS + iOS/Android + Rust via C++ JSI)
  Description:
    Single TypeScript UI rendering native OS controls (WinUI 3, AppKit, UIKit, Android Views). High-performance parsers (PDFium, Rust crates) wired via direct JSI without bridge serialization overhead.
  Pros:
    - Excellent cold-start TTFV (<150ms).
    - Genuine OS-level tabs, smooth scrolling, and accessible native controls.
    - Bypasses webview sandbox constraints and memory caps on mobile.
  Cons / Trade-offs:
    - Desktop targets (RN Windows, RN macOS) have smaller communities and require custom native modules.
    - Implementing custom cross-platform rendering surfaces (e.g., custom canvas/drawing for complex office layouts) is more labor-intensive than HTML/Canvas.

Option 1.4: Dual Native Shells over Shared Rust/C++ Engine (Tauri/C++ Desktop + SwiftUI/Compose Mobile)
  Description:
    Native desktop UI (Tauri or WinUI/AppKit) and native mobile UI (SwiftUI on iOS, Jetpack Compose on Android) communicating with a unified Rust core (file parsing, indexing, caching, rendering orchestration).
  Pros:
    - Optimal platform performance, lowest latency, and zero platform friction.
    - Full hardware acceleration and native OS gesture support.
  Cons / Trade-offs:
    - Requires maintaining 3 separate UI codebases (Desktop, iOS, Android).
    - High ongoing engineering cost to maintain feature parity (Chrome-like tabs and omnibox must be implemented 3 times).

Option 1.5: OS Previewer Delegation (Thin Shell + Platform Bridges)
  Description:
    Thin app shell that handles navigation/tabs, but delegates actual document and media rendering to OS facilities: QuickLook on macOS/iOS, Windows Preview Handlers/Edge controls, Android FileProvider/Intents. Shared web renderers only for missing formats (code, archives, epub).
  Pros:
    - Fastest initial launch with minimal bundled rendering code (<20 MB).
    - Zero media codec licensing headaches; native hardware decoders handle all supported video/audio.
  Cons / Trade-offs:
    - Non-uniform user experience across platforms (QuickLook looks completely different from Windows handlers).
    - Windows preview handlers are unreliable or missing if Microsoft Office is not installed.
    - Zero competitive differentiation: identical rendering and limitations as default OS viewers.


2. OSS STRATEGY: FORK VS. REUSE AS LIBRARIES

Format Libraries (Always Reuse as Libraries via Clean APIs):
  - PDF: PDFium (compiled to native/WASM, Apache-2.0) or PDF.js (web-first, Apache-2.0). Avoid MuPDF due to AGPL-3.0 restrictions.
  - Word (.docx): docx-preview (MIT / JS) for web, or direct XML parsing for text/structure extraction.
  - Excel (.xlsx): SheetJS (Apache-2.0 community edition) or Rust calamine crate for table grid display.
  - Code / Text: Monaco Editor (MIT) or Prism.js / Shiki for lightweight, fast-loading syntax highlighting.
  - Archives (.zip, .tar, .7z, .rar): Rust zip/tar crates or libarchive (BSD) compiled to native/WASM. Avoid GPL-licensed unrar.
  - Ebooks (.epub): epub.js (FreeBSD) or foliate-js (MIT).
  - Images / Vector: Native webview <img>/SVG tags + Rust image crate for metadata/exif and unsupported raw formats.

Existing Viewer Projects (Inspect / Port Patterns, Do Not Fork Whole Apps):
  - Vudit Desktop (Electron, MIT): Inspect via REA to extract IPC patterns, drag-and-drop shell architecture, and format-loading lifecycle. Do not fork the full repo due to architectural bloat and heavy Electron baggage.
  - Gander (Android, MIT): Reuse its intent handling, document caching logic, and scoped storage / FileProvider integration patterns.
  - Paperwren (Windows/Android, MIT): Study its Office document layout mapping techniques.
  - FileVista (LGPL-3.0-or-later): Do not bundle statically; either isolate strictly behind a dynamic boundary or omit entirely to avoid LGPL distribution risks on closed app stores.
  - Vudit Android (License Unchecked): Do not copy or import any code. Use strictly clean-room design based on public format specs.


3. HARDEST FORMATS AND OFFLINE RENDERING

PPTX (Presentations):
  - Problem: PPTX contains complex coordinate-based shapes, master layouts, smart art, custom fonts, and text warps. HTML translation frequently breaks layouts.
  - Solution:
    1. Primary offline renderer: Headless OOXML parser compiling slides into HTML Canvas or SVG representations (e.g., pptxjs or custom Rust parser).
    2. Progressive enhancement: Extract and render the embedded high-resolution slide thumbnails instantly from the PPTX zip archive while the full slide canvas parses in the background.

Legacy Binary Office (.ppt, .doc, .xls):
  - Problem: Proprietary, complex binary structures pre-dating OpenXML.
  - Solution:
    1. Desktop: Sandboxed headless converter (e.g., LibreOffice in headless print-to-PDF mode) or a dedicated Rust binary extractor.
    2. Mobile: Do not bundle heavy conversion suites (LibreOffice WASM/ZetaOffice is 80-200MB+). Use progressive degradation: extract text and embedded images/previews for a readable outline view, or offer an optional downloadable "Legacy Compatibility Pack".
    3. Paired-Device fallback: If a paired desktop is online, the mobile device delegates heavy conversion to the desktop and streams back a lightweight vector PDF.

Video and Audio Codecs:
  - Problem: Proprietary patents and licensing traps (H.264/H.265/HEVC, AAC, Dolby). Bundling FFmpeg invites GPL compliance issues and patent pool royalties.
  - Solution:
    - Never bundle a generic GPL FFmpeg build.
    - Delegate playback directly to platform native multimedia frameworks:
      * macOS / iOS: AVFoundation (native hardware decoding for H.264, HEVC, ProRes, MP3, AAC).
      * Android: Media3 / ExoPlayer backed by Android MediaCodec.
      * Windows: Windows Media Foundation (WMF).
    - In web shells, use standard HTML5 <video> and <audio> elements tied to the OS webview's underlying platform decoders. Display clear codec fallback messages for unsupported legacy container formats (.avi, .wmv).


4. BENCHMARKING: MAKING "MEASURABLY BETTER" CONCRETE

Standard Test Corpus:
  - Assemble an open, reproducible corpus of 500 files spanning all target extensions:
    * 100 images (tiny web assets to 50MB RAW photos and giant SVGs).
    * 100 documents (PDF, DOCX, XLSX, PPTX, varying from 1 page to 10,000-row sheets).
    * 50 legacy office files (.doc, .ppt, .xls).
    * 100 code/data files (JSON, CSV, Rust, TypeScript, large minified files).
    * 50 audio/video files across common and edge-case containers.
    * 50 archives (.zip, .tar.gz, .7z) with nested directory structures.
    * 50 edge cases (corrupted headers, huge 500MB log files, zero-byte files).

Core Metrics & Targets:
  - Time-to-First-View (TTFV):
    * Cold-start p50 and p95: Time from clicking a file in OS Explorer/Finder to first meaningful pixel rendered. Target: p50 < 200ms, p95 < 500ms (vs Electron competitors at 1.5s - 3.5s).
    * Warm TTFV: Time to switch or open a file when app is already running. Target: < 50ms.
  - Visual Fidelity Score:
    * Structural Similarity Index (SSIM) and pixel-diff against reference renders (Microsoft 365 and Adobe Acrobat Pro). Target: > 92% visual parity on common office files.
  - Useful Format Coverage:
    * Fraction of files in the 500-corpus that render in a readable, non-empty, usable state (graceful degradation to formatted text/hex view counts as useful; crashing or blank screen is a failure). Target: > 95%.
  - Offline Reliability:
    * 100% of tested files must render identically in Airplane Mode with zero telemetry or remote CDN asset dependencies.
  - Simplicity / Usability:
    * Click-to-content distance: 1 drag-and-drop action or 1 omnibox path paste opens any file into a new tab.


5. CROSS-DEVICE CONNECTION LAYER

Architecture:
  - Zero-cloud, local network direct streaming.
  - Local HTTP server running on the host (desktop), advertising over local network via mDNS (Bonjour / Avahi).
  - Security & Pairing:
    * Desktop generates a single-use or short-lived QR code containing LAN IP, port, ephemeral TLS certificate fingerprint, and a cryptographic bearer token.
    * Mobile scans the QR code; establishes mutual TLS (mTLS) or pinned HTTPS session.
    * Scope-limited file server: Mobile only has read access to specifically opened files or user-selected folders, not full filesystem traversal.
  - Streaming vs. Sync:
    * Stream on-demand: Stream document bytes and media chunks via HTTP range requests rather than copying full files upfront.
    * Paired conversion: Host desktop can pre-render difficult files (e.g. PPTX or legacy formats) into PDF pages and stream lightweight raster/vector tiles to mobile.
    * Defer background filesystem synchronization (Syncthing) entirely in early versions.


6. LICENSING RISKS AND COMPLIANCE

LGPL-3.0 (e.g., FileVista, Libarchive C builds):
  - Risk: On iOS App Store, Apple's DRM packaging and static linking model have historically conflicted with LGPL requirements allowing end users to relink modified library versions.
  - Mitigation: Exclude FileVista. Prefer permissive MIT/Apache-2.0 libraries (PDFium, docx-preview, SheetJS Community). If an LGPL library is required, compile it strictly as a dynamically loaded framework on macOS/Windows and avoid it on iOS.

GPL and Video Codecs (FFmpeg, x264, unrar):
  - Risk: Shipping GPL binaries on the App Store violates terms; patent royalties on MPEG LA / HEVC codecs create legal exposure.
  - Mitigation: Do not package FFmpeg. Use OS-provided platform decoders (AVFoundation, MediaCodec, WMF). For archive extraction, use pure MIT/Apache uncompressed/deflate parsers; support unrar only via permissive BSD-compatible decompressors.

Apple App Store Rules:
  - iOS WebKit mandate: Web-based rendering on iOS must execute inside WKWebView. All scripts and WASM must adhere to iOS W^X (write-xor-execute) memory restrictions.
  - Dynamic code loading: Ensure all format plugins and WASM modules are bundled within the app container; no remote downloading of executable logic.


7. V1 MVP SCOPE: WHAT TO SHIP VS. WHAT TO CUT

Ship in V1 (Core Focus):
  - Shell: Chrome-like multi-tab interface, single omnibox (file path, search, local network address), full OS drag-and-drop.
  - Core Formats:
    * PDF (high performance, text search, thumbnail rail).
    * Modern Office: .docx (formatting, tables, images), .xlsx (multi-sheet grid, cell formulas), .pptx (slide deck viewer with thumbnail rail).
    * Web & Ebooks: HTML, Markdown, Plain Text, EPUB.
    * Media: Common images (PNG, JPEG, WebP, SVG, GIF) and audio/video supported by OS hardware decoders (MP4/H.264, WebM, MP3, AAC).
    * Code: Syntax-highlighted code viewer with line numbers and copy controls for 30+ languages.
    * Archives: .zip and .tar file inspector (browse tree, preview files without full extraction).
  - Cross-Device: Ephemeral QR-code LAN pairing for viewing desktop files on mobile.
  - Offline: 100% self-contained local operation.

Cut for V1 (Defer to V2+):
  - File editing, annotation, or document generation (view-only keeps code footprint small and stable).
  - Background bidirectional file sync (Syncthing integration).
  - Heavy legacy binary Office converters (.doc, .ppt, .xls) on mobile (support desktop fallback or text extraction only).
  - Software video transcoding and exotic container formats (.mkv with proprietary audio tracks, .avi, .flv).
  - Cloud storage providers (Google Drive, Dropbox, OneDrive integration).


SYNTHESIS RECOMMENDATION

The highest-performing, lowest-risk foundation is the Modern Native Webview Shell (Tauri v2 + Rust Core with React/TypeScript UI):
- UX Parity: A single React/TS UI delivers the requested Chrome-like tabs, omnibox, and drag-and-drop across Windows, macOS, Android, and iOS.
- Benchmark Dominance: Replaces Electron to achieve sub-300ms cold-start TTFV and <30 MB installer sizes.
- Clean IP & Codecs: Uses platform hardware media decoders and Apache/MIT parsers (PDFium, docx-preview, SheetJS), avoiding LGPL/GPL licensing traps on mobile app stores.
- Resilient Offline: Pairable via local QR/mTLS without cloud dependencies, backed by an automated 500-file benchmark harness to empirically prove time-to-first-view and fidelity gains over competitors.
