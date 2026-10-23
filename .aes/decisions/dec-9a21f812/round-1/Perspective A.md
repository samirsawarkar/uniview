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
