### Uncovered Options

1. **Declarative Layout AST (Data-over-Code):** Replace executable HTML/JS bundles with a typed, declarative visual AST (JSON scene-graph). Plugins and agents parse files into structured layout and vector primitives that UniView renders natively.
   * *Trade-offs:* Eliminates arbitrary code execution, sandbox escapes, and iOS App Store (Guideline 2.5.2) bans. However, it constrains bespoke interactive widgets to host-supported primitives.
2. **Asymmetric LAN Architecture (Desktop Engine, Mobile Viewport):** Run heavy Wasm parsers, plugin runtimes, and local MCP daemons strictly on desktop. Mobile apps act purely as encrypted LAN satellite viewports streaming state.
   * *Trade-offs:* Sidesteps mobile thermal limits and Capacitor background-daemon constraints, but sacrifices standalone mobile-offline plugin execution.

---

### My #1 Choice: Declarative Layout AST

I rank **Declarative Layout AST** first.

Treating plugins as executable web bundles is the fundamental flaw in prior proposals: it introduces critical prompt-injection and sandbox breakout surfaces, triggers Apple’s ban on downloaded executable code, and causes mobile fragmentation.

Enforcing a data-only AST gets UniView to 9+/10 because:
* **Bulletproof Zero-Trust:** Inputs remain pure data. Agents and malicious payloads cannot execute arbitrary scripts, bypass permissions, or exfiltrate paired-device LAN credentials.
* **Agent-Native Reliability:** LLMs generate deterministic JSON/AST specifications with far higher fidelity than bug-free, sandboxed HTML/JS apps.
* **Seamless Cross-Platform Parity:** A single declarative spec renders identically and performantly across Electron, iOS WKWebView, and Android without fragile webview permission bridges.
