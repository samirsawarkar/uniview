# Question

UniView shell decision (triage dec-67e7d1c9 said TYPE 1). Build a universal offline file viewer for Windows, macOS, Android, iOS with one shared React+TypeScript viewer core. Options: (A) Electron (Win/macOS) + Capacitor (Android/iOS) now; installed toolchain covers it (Node 24, JDK 17, Android SDK); no Rust. (B) Tauri v2 on all four; requires installing Rust + MSVC Build Tools first; smaller binaries and faster cold start. (C) Electron+Capacitor now behind a strict FileSource/ShellBridge interface, with a scheduled Tauri prototype measured against the same 500-file benchmark before any store release or code signing, which is the point where switching becomes expensive. Constraints: development host is Windows 11 (no macOS, so iOS/macOS builds need CI later); goal is a complete working V1 soon; offline only; measurable wins on time-to-first-view, format coverage and simplicity. Evidence: docs/research (brainstorm synthesis, Vudit Desktop and Gander REA reports; Gander proves the WebView + same-origin fetch + strict CSP pattern on Android). Recommend one option with the strongest dissent.

# Anonymous Perspectives from Round 1

## Perspective A
**CONCERNS. I recommend C, with conditions that keep it from turning into A with a promise attached.**

**Why C:**
1. **The toolchain is ready now.** Electron and Capacitor run on the installed Node 24, JDK 17 and Android SDK. B needs Rust and the MSVC Build Tools before anything renders, and V1 is meant to ship soon.
2. **The Android pattern is already proven.** Gander shows WebView, same-origin fetch and a strict CSP working on Android. That is the hardest offline-rendering risk, and Capacitor reuses the pattern directly.
3. **It defers the expensive decision to where it actually becomes expensive.** That point is store release and code signing, not the first commit. A FileSource/ShellBridge seam keeps the React viewer core free of shell code, so a later switch only touches the adapters.
4. **No macOS host.** iOS and macOS builds need CI under every option, so B gains nothing there. Tauri's iOS path is also younger than Capacitor's.

**Conditions, or C fails:**
- **Keep the interface small:** about 6 to 8 methods (open, read range, stat, list, file picker, share-in intent). Fail CI if the viewer core imports `electron` or `@capacitor/*` directly.
- **Lock the prototype into the plan:** give it a fixed timebox (for example 3 days) and fix the pass threshold now. For example: Tauri wins only if p50 time-to-first-view on the 500-file benchmark improves by at least 30% or the installer shrinks by at least 60%, with no loss of format coverage. Otherwise it gets skipped under schedule pressure, and you have chosen A without saying so.
- **Measure Electron's cold start first.** If it already meets the time-to-first-view target, cancel the prototype.

**Strongest dissent (B):** Electron ships its own Chromium, while Tauri uses the system webview, which differs between platforms. Desktop formats that work in Electron could then silently break in a later Tauri port: codecs such as HEVC, PDF.js workers and WebGPU. That would make the benchmark misleading unless it also tests format coverage on the system webview. Installing Rust takes about an hour, so B now avoids running two shell stacks. My reply is to run the format-coverage half of the benchmark on WebView2 and WKWebView in CI from week one.

## Perspective B
APPROVE — Option C, with a timeboxed Tauri prototype and an explicit decision gate before signing or store release.

C best matches the immediate goal: a complete working V1 soon. Electron and Capacitor fit the installed toolchain; Tauri adds Rust and MSVC setup before product progress. The shared React+TypeScript core preserves reuse across all four platforms.

The interface must isolate actual platform differences: file access, URI handling, byte ranges, permissions, lifecycle and resource cleanup. Viewer code should consume FileSource capabilities without importing Electron, Capacitor or Tauri APIs. That makes a later switch credible, though it does not make migration free.

Use the same 500-file corpus to measure cold time-to-first-view, successful rendering by format, peak memory and implementation complexity. Predefine acceptance thresholds, timebox the prototype, and reserve time to act on its findings. Smaller binaries and faster shell startup alone do not establish better end-to-end viewing.

Gander supports the Android WebView, same-origin fetch and strict CSP pattern. It does not establish equivalent behavior on iOS or macOS. Obtain CI smoke-build evidence for both Apple targets early; defer distribution, not platform feasibility.

Strongest dissent: C can become A with extra abstraction and an indefinitely deferred experiment. If the team cannot fund and enforce the prototype gate, choose A honestly. B becomes preferable if measured startup or packaging constraints outweigh its setup and platform-validation costs.

## Perspective C
**APPROVE (Option C)**

### Recommendation & Strongest Reasons
**Option C** is the optimal path to deliver a complete, offline V1 quickly without incurring irreversible architecture debt.

1. **Zero Host Setup Friction:** Windows 11 already has Node 24, JDK 17, and the Android SDK configured. Starting immediately with Electron + Capacitor enables rapid local iteration and Android validation without blocking on Rust/MSVC toolchain installation.
2. **Strict Core Decoupling:** Enforcing a rigorous [`FileSource`](file:///I:/Development/Clone/Universal/uniview/.aes/decisions/dec-9a21f812/private/) and [`ShellBridge`](file:///I:/Development/Clone/Universal/uniview/.aes/decisions/dec-9a21f812/private/) abstraction isolates the shared React+TypeScript engine. This cleanly replicates the Gander-proven offline pattern (WebView + same-origin fetch + strict CSP) without leaking platform-specific shell code into viewer components.
3. **Evidence-Based Gate:** Evaluating a Tauri v2 prototype against the 500-file benchmark *before* code signing and app-store onboarding anchors the platform decision on cold-start speed and memory data right before switching costs become prohibitive.

### Strongest Dissent
Maintaining dual shells (Electron for desktop, Capacitor for mobile) fragments IPC bridges, plugin ecosystems, and CI pipelines, doubling shell surface area compared to a unified Tauri v2 setup. If Tauri is the eventual target for lightweight binaries and unified cross-platform maintenance, writing disposable Electron/Capacitor glue code wastes effort, and organizational inertia risks letting a heavier Electron implementation become permanent.

## Perspective D
**APPROVE Option C.**

### Reasons & Evidence

1. **Immediate Execution Without Toolchain Detours:** The Windows 11 host already has Node 24, JDK 17, and the Android SDK configured. Option C enables instant local iteration on Windows and Android without stalling to install/configure Rust and MSVC Build Tools.
2. **Proven Architectural Precedents:** Gander REA demonstrates that the WebView + same-origin `fetch` + strict CSP pattern reliably delivers offline file viewing on Android under Capacitor. Meanwhile, Electron provides well-understood local file-system access for desktop.
3. **Decoupled Core Protects Velocity:** Establishing a strict `FileSource` / `ShellBridge` interface guarantees the React+TypeScript viewer engine (format decoders, virtualization, UI) remains 100% shell-agnostic. This isolates 90% of development effort from shell churn.
4. **Data-Driven Gate Before True Lock-In:** A TYPE 1 commitment only solidifies at store signing and platform integration. Running an empirical 500-file cold-start/memory benchmark against a Tauri spike before code signing grounds the ultimate shell decision in verified metrics rather than speculation.

### Strongest Dissent

Option C risks dual-shell tax and false compromise: building for Electron and Capacitor concurrently forces dual IPC patterns (Node/Chromium vs. mobile WebViews) while dangling a third (Tauri/Rust) in the background. If Tauri v2 is the ultimate destination for universal code sharing and binary lightness across all four targets, postponing Rust onboarding merely defers inevitable refactoring while burning cycles maintaining two disparate bridge shims.
