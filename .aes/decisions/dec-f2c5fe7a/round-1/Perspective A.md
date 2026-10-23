### 1. Agent-First Visual MCP Runtime
Position UniView as the default local GUI for LLM agents via an embedded Model Context Protocol (MCP) server. Agents dynamically query local files and spin up ephemeral, sandboxed UI renderers to display complex data (e.g., SQLite, logs, custom schemas).
* **Adoption:** Immediate flywheel; agents build single-file renderers on the fly.
* **Trade-offs & Risks:** Massive scope creep. Introduces severe prompt-injection and malicious file-payload risks. Severe mobile friction, as Capacitor cannot seamlessly host persistent local background MCP daemons.

### 2. Dual-Mode Wasm Core (Headless Tool + Visual Canvas)
Require plugins to expose two interfaces: a deterministic headless parser/transformer compiled to WebAssembly, paired with a sandboxed Web Component for rendering. Agents use the headless tools to inspect/convert files; users interact with the UI.
* **Adoption:** Attracts serious developers and agent toolkits seeking cross-platform parity (iOS, Android, desktop).
* **Trade-offs & Risks:** Higher barrier to entry than loose HTML/JS scripts, slowing early registry growth. Wasm compute constraints on lower-end mobile devices.

### 3. Zero-Trust Capability Registry & Pro Format Store
Prioritize offline security and monetization. Plugins operate under cryptographically signed, zero-egress capability tokens (strict host-mediated file handles, zero network access). Monetize via a commercial marketplace for high-value, niche industrial formats (CAD, GIS, medical imaging).
* **Adoption:** Fast enterprise and security-conscious user adoption; high developer payout potential.
* **Trade-offs & Risks:** Gatekeeping and signing requirements kill permissionless agent-generated plugins; high moderation overhead for the registry.
