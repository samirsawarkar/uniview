# Question

UniView (offline cross-platform file viewer: Electron + React/TS desktop, Capacitor Android/iOS, encrypted LAN browsing of a paired computer, renderers for PDF/Office/media/archives) wants to become a plugin platform: developers publish plugins for file formats and tools (view, annotate, convert), users install what they need from an open registry, and the host provides UI, file handles, permissions, cross-device access and distribution. Proposed: versioned manifest (file types, actions, platforms, permissions) + HTML/JS bundle in a sandboxed web context with a small controlled host API (not Chrome extensions); host-managed file handles with explicit read/write grants. New ambition from the CEO: like AI-agent tool ecosystems, let anyone (including AI agents) build any plugin they want, and let every AI agent connect to UniView (e.g. via MCP) and use it as the default viewer for files they produce or inspect. Question: what are the strongest distinct directions to get from 8/10 to 9+/10 - i.e. to make developers and AI agents actually build for it and users adopt it - and what are the trade-offs and risks (security of third-party code and agents, mobile limits, marketplace trust, scope, monetization) of each?

# Anonymous Perspectives from Round 1

## Perspective A
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

## Perspective B
The sandbox proposal is a credible foundation. Getting to 9+/10 requires choosing a compelling entry point: “anyone can build anything” describes extensibility, not demand.

1. **Become the file workspace for AI agents.** Ship MCP tools to open, inspect, render, annotate and export files, with visible results in UniView. Give plugin actions machine-readable schemas so agents can discover and invoke them. Win adoption through reliable integrations and reproducible outputs; monetize team workflows and managed deployments.
   
   **Trade-offs:** Agents expand the attack surface. Treat file contents and plugin output as untrusted data; require scoped, expiring capabilities and explicit approval for destructive writes or external transfers. A connected agent must never inherit every paired computer’s access. Mobile execution limits constrain parity.

2. **Become the easiest platform for underserved file formats.** Prioritize an excellent SDK: templates, fixtures, hot reload, conformance tests and an agent-friendly build/test loop. Recruit format maintainers with real user demand. Make plugin actions reusable across desktop, mobile and agents.
   
   **Trade-offs:** Developer tooling needs sustained investment before network effects appear. HTML/JS cannot support every native codec or heavy conversion; declare platform capabilities honestly. An open registry needs provenance, signing, revocation and clear trust tiers. Monetize optional distribution services without taxing participation prematurely.

3. **Own trusted, complete workflows first.** Curate excellent plugin chains for one audience—such as engineering teams reviewing mixed technical files—with offline viewing, annotation and conversion. Fund maintainers; sell workflow packs and organizational controls.
   
   **Trade-offs:** Narrower reach, curation costs and paid-pack tensions.

**My choice:** Start with option 3; use agent connectivity to accelerate it, then generalize the SDK.

## Perspective C
I'd take Option 1 first. It is the only one that gives AI agents a reason to use UniView right away, and the review gate in Option 2 is how you make it safe.

**1. Agent-first: UniView as the default viewer agents open files in (MCP server + "open/annotate/diff" verbs)**
Ship an MCP server early that exposes a small set of verbs: `open(file, at)`, `highlight`, `compare`, `capture-view`, `get-annotations`, plus the paired-device LAN link. Agents use what already exists; plugins come later.
- Pros: adoption comes from agents that already exist; very little ecosystem building; clear value ("see what your agent did"); works without any marketplace.
- Cons and risks: a prompt-injected agent becomes a remote reader of local and paired-device files. You need per-session scoped grants, read-only by default, and an audit log the user can see. Phones can't run a resident MCP server, so mobile access goes through the paired desktop.

**2. Curated, capability-gated plugin registry (the 8/10 proposal, hardened)**
Signed manifests, declarative permissions, required provenance (SBOM, reproducible bundles), automated static checks plus a "verified" tier, and installs that can be revoked.
- Pros: users can trust it; you can charge for a verified tier or developer accounts; the host stays in control.
- Cons: friction slows growth. Each bundle also has to work in Electron, Android WebView and iOS WKWebView, and iOS rules on downloaded executable code (guideline 2.5.2) may force iOS to curated or bundled plugins only.

**3. "Plugins are generated": AI writes local, single-user plugins on demand**
Users or agents describe a format or tool, and an LLM generates a sandboxed bundle that runs only on that machine and is never published.
- Pros: this is the CEO's "anyone builds anything" with no marketplace trust problem.
- Cons: quality varies; you carry support burden for code no one reviewed; it needs a very strict sandbox (no network, only the granted handles); it doesn't create network effects or revenue.

Shared risk: scope sprawl. Pick one wedge (my pick is 1) and fix the host API surface before opening the registry.

## Perspective D
**1. Agent-First Canvas (MCP Host + Dynamic Synthesis)**
Expose an MCP server turning UniView into the default visual canvas for external AI agents. Agents inspect local files, spawn views, and generate single-file custom viewer plugins on demand.
*Trade-offs:* Immediate differentiation and explosive agent ecosystem adoption.  
*Risks:* High security attack surface (prompt injection or malicious agent-authored code compromising file handles); mobile resource exhaustion under dynamic runtimes; severe scope creep away from core viewer stability.

**2. Tiered Capability Sandbox (Curated Marketplace)**
Implement strict capability-based Iframe/WASM sandboxing with automated security validation for agent-submitted plugins. Permissions remain granular (read-only default, scoped exports, explicit write prompts).
*Trade-offs:* Maximum trust, bulletproof security, seamless mobile parity (respecting Capacitor memory/thread constraints), and clear monetization via a verified enterprise store.  
*Risks:* High developer friction dampens registry growth; sandbox constraints hinder heavy format conversions (e.g., CAD, large video codecs).

**3. Open Viewer Protocol (Decentralized Ecosystem)**
Standardize an open "Viewer & Tool Protocol" separating host UI from renderers. Developers and agents publish to federated registries; UniView acts as an unopinionated client.
*Trade-offs:* Frictionless developer adoption, zero platform liability, and rapid open-source coverage of niche file formats.  
*Risks:* Fragmented UX, supply-chain risks from unvetted third-party repos, and weak direct monetization (forced into hosted relay subscriptions).

**Verdict:** Choose **Option 2**. For offline, cross-platform software with local file and LAN access, security and mobile predictability are existential; agent execution must be constrained by strict host-managed capabilities.
