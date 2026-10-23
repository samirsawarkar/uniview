I recommend **Option C**.

### Rebutting the Strongest Opposing Point
The strongest opposing argument contends that Option C incurs a wasteful "dual-shell tax" and false compromise: building for Electron and Capacitor forces disparate IPC shims and defers the inevitable transition to a unified Tauri v2 stack.

This critique is flawed for two key reasons:
1. **The abstraction is clean architecture, not throwaway tax:** The `FileSource` and `ShellBridge` seam is essential domain isolation. Decoupling the React+TypeScript viewer core from shell-specific APIs protects decoders, rendering, and UI logic whether the final shell is Tauri, Electron, or native.
2. **Tauri v2 mobile is an unforced delivery risk:** While Tauri promises binary lightness, its mobile ecosystem is young. In contrast, Capacitor directly reuses the Gander-proven Android offline pattern (WebView + same-origin `fetch` + strict CSP). Halting momentum to install Rust and MSVC Build Tools on Windows 11 directly threatens the primary constraint: shipping a complete, working V1 soon.

Option C leverages the already-installed toolchain (Node 24, JDK 17, Android SDK) for immediate velocity, keeping the irreversible decision deferred until empirical cold-start and format-coverage data from the 500-file benchmark is gathered before code signing.

### Final Verdict
**APPROVE** (Option C, with an enforceable, timeboxed Tauri benchmark gate prior to store signing).
