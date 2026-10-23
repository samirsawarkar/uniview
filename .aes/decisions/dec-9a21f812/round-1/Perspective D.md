**APPROVE Option C.**

### Reasons & Evidence

1. **Immediate Execution Without Toolchain Detours:** The Windows 11 host already has Node 24, JDK 17, and the Android SDK configured. Option C enables instant local iteration on Windows and Android without stalling to install/configure Rust and MSVC Build Tools.
2. **Proven Architectural Precedents:** Gander REA demonstrates that the WebView + same-origin `fetch` + strict CSP pattern reliably delivers offline file viewing on Android under Capacitor. Meanwhile, Electron provides well-understood local file-system access for desktop.
3. **Decoupled Core Protects Velocity:** Establishing a strict `FileSource` / `ShellBridge` interface guarantees the React+TypeScript viewer engine (format decoders, virtualization, UI) remains 100% shell-agnostic. This isolates 90% of development effort from shell churn.
4. **Data-Driven Gate Before True Lock-In:** A TYPE 1 commitment only solidifies at store signing and platform integration. Running an empirical 500-file cold-start/memory benchmark against a Tauri spike before code signing grounds the ultimate shell decision in verified metrics rather than speculation.

### Strongest Dissent

Option C risks dual-shell tax and false compromise: building for Electron and Capacitor concurrently forces dual IPC patterns (Node/Chromium vs. mobile WebViews) while dangling a third (Tauri/Rust) in the background. If Tauri v2 is the ultimate destination for universal code sharing and binary lightness across all four targets, postponing Rust onboarding merely defers inevitable refactoring while burning cycles maintaining two disparate bridge shims.
