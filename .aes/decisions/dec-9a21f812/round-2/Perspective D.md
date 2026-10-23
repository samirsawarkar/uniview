**I recommend Option C.**

### Rebuttal to the Strongest Opposing Point (Advocating Option B)
The strongest objection to C is the "dual-shell tax": maintaining disparate Electron and Capacitor bridges burns cycles on disposable glue code, while Tauri v2 promises a single unified shell across all four platforms.

This argument fails under practical operational constraints:
1. **System WebView fragmentation:** Tauri does not provide a single rendering engine; it delegates to WebView2, WKWebView, and Android System WebView. Codec availability (e.g., HEVC), PDF worker behavior, and WebGPU support diverge significantly across system WebViews compared to Electron’s deterministic Chromium baseline. Tauri v2 unifies shell packaging, not cross-platform format rendering.
2. **Disproportionate bridge cost:** A clean `FileSource`/`ShellBridge` boundary needs only 6–8 fundamental methods (stat, read range, list, picker, intent). Implementing two lightweight adapters is trivial compared to the shared React+TypeScript format viewer engine. Cleanly isolating file access from the UI is necessary architectural discipline regardless of shell choice.

### Verdict
Option C capitalizes on the already configured Node/JDK/Android toolchain on Windows 11 and directly applies the Gander-proven offline WebView pattern. To ensure C does not degrade into an unexamined Option A, lock the gate: timebox the Tauri spike to 3 days before code signing, adopting Tauri only if it yields a ≥30% improvement in p50 time-to-first-view on the 500-file benchmark with zero format regression.

**Final: APPROVE.**
