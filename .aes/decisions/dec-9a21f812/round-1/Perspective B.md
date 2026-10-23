APPROVE — Option C, with a timeboxed Tauri prototype and an explicit decision gate before signing or store release.

C best matches the immediate goal: a complete working V1 soon. Electron and Capacitor fit the installed toolchain; Tauri adds Rust and MSVC setup before product progress. The shared React+TypeScript core preserves reuse across all four platforms.

The interface must isolate actual platform differences: file access, URI handling, byte ranges, permissions, lifecycle and resource cleanup. Viewer code should consume FileSource capabilities without importing Electron, Capacitor or Tauri APIs. That makes a later switch credible, though it does not make migration free.

Use the same 500-file corpus to measure cold time-to-first-view, successful rendering by format, peak memory and implementation complexity. Predefine acceptance thresholds, timebox the prototype, and reserve time to act on its findings. Smaller binaries and faster shell startup alone do not establish better end-to-end viewing.

Gander supports the Android WebView, same-origin fetch and strict CSP pattern. It does not establish equivalent behavior on iOS or macOS. Obtain CI smoke-build evidence for both Apple targets early; defer distribution, not platform feasibility.

Strongest dissent: C can become A with extra abstraction and an indefinitely deferred experiment. If the team cannot fund and enforce the prototype gate, choose A honestly. B becomes preferable if measured startup or packaging constraints outweigh its setup and platform-validation costs.
