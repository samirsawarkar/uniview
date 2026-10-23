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
