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
