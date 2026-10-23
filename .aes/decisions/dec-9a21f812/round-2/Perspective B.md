**Strongest opposing point:** Option C pays a "dual-shell tax." You maintain Electron and Capacitor glue, build a Tauri prototype on the side, and inertia makes Electron permanent. On this view Tauri is the unified end state, so the glue code is wasted.

**Rebuttal:** Tauri on all four platforms is not really one shell.
- **Mobile still needs native code.** Android content URIs, iOS security-scoped bookmarks, the iOS document picker and share-in intents all need Kotlin or Swift plugins under Tauri too. That is the same adapter surface Capacitor already covers with more mature plugins.
- **The FileSource/ShellBridge adapters exist under every option.** So the tax is about two thin adapters, not two architectures.
- **The webview argument favours C.** iOS forces WKWebView and Android uses the system WebView whatever shell you pick, so the viewer core must already work on system webviews. Electron's bundled Chromium is therefore a desktop convenience, not a dependency. That makes a later Tauri desktop swap safe, provided format-coverage tests run on WKWebView and WebView2 from the start.
- **The Rust install is not the real cost.** It takes about an hour. The real cost is validating Tauri mobile file access before V1. C delays that cost until data justifies paying it.

**Conditions for C:**
1. **Viewer core never imports a shell.** CI fails if it imports `electron`, `@capacitor/*` or `@tauri-apps/*`.
2. **Fixed prototype gate.** A Tauri desktop prototype gets a fixed timebox, with thresholds set now. Tauri must cut p50 time-to-first-view on the 500-file benchmark by at least 25%, or shrink the installer by at least 50%, with no loss of format coverage. If it fails, record that A was chosen.
3. **Early Apple smoke builds.** CI builds for iOS and macOS start in the first month.
4. **Measure Electron cold start first.** If it already meets the target, cancel the prototype.

**Strongest dissent:** If nobody funds and enforces the gate, C is just A plus an extra abstraction. In that case, choose A openly.

**Final: APPROVE (Option C), on the four conditions above.**
