OPTIONS MATRIX: FIVE MERGED DIRECTIONS FOR UNIVIEW
========================================================================================================================

The 11 proposals across Rounds 1 and 2 consolidate into 5 distinct architectural and strategic directions, supported by 2 cross-cutting system enablers.


DIRECTION 1: DECLARATIVE SEMANTIC CANVAS (DATA-OVER-CODE)
Merged from: Round 2 Persp A (AST Scene Graph), Persp B (Option F: Declarative View Specs), Persp D (DSL-First Renderers).

Concept:
Plugins and AI agents never deliver executable JS/Wasm bundles. Instead, they output structured, declarative JSON/YAML schemas (visual AST) describing layouts, data tables, trees, visual diffs, vector graphics, and media overlays. UniView renders everything using hardened, native host components.

Adoption & Developer Flywheel:
- Agents emit valid JSON schemas far more reliably than bug-free, cross-platform JS/DOM code.
- Immediate zero-install authoring: a single prompt generates a working viewer spec in seconds.
- Lower barrier for non-programmers and data scientists.

Security & Attack Surface:
- Near-zero attack surface: pure data ingestion eliminates Remote Code Execution (RCE), sandbox breakouts, DOM injection, and local/LAN credential theft.
- Malicious file payloads cannot trigger code execution.

Mobile & Platform Parity:
- 100% compliant with Apple App Store Guideline 2.5.2 (no dynamic executable code download).
- Native-speed rendering in Electron, iOS WKWebView, and Android Capacitor without webview bridge overhead.

Marketplace Trust & Moderation:
- Near-zero moderation burden. Specs are safe to share permissionlessly across public repos or agent prompts without cryptographic vetting.

Scope & Complexity:
- Low-to-Medium. The engineering team builds and maintains an opinionated component vocabulary rather than a secure multi-runtime sandbox.

Monetization:
- Enterprise schema packs, team template registries, compliance/audit schemas, and visual workflow builders.

Core Trade-off & Limit:
- Expressiveness ceiling. Cannot handle highly bespoke rendering (e.g., custom WebGL shaders, proprietary decompression codecs, or non-standard interactive widgets) without host core updates.


DIRECTION 2: AGENT WORKSPACE & REVIEW RECEIPTS (MCP-NATIVE VERBS)
Merged from: Round 1 Persp A (Visual MCP Runtime), Persp B (File Workspace), Persp C (Default Viewer & Receipts), Persp D (Agent-First Canvas), Round 2 Persp B (Zero-Daemon Handoff).

Concept:
Position UniView as the default human-in-the-loop review interface for AI coding and research agents. Expose an MCP server and zero-daemon CLI handoff (`uniview open <file> --receipt <json>`). Agents open files, display diffs, push annotations, and attach portable review receipts (agent reasoning, source diffs, verification hashes, and citations).

Adoption & Developer Flywheel:
- Direct, immediate utility on Day 1 without waiting for a plugin registry.
- Existing coding and analysis agents (Claude Code, Cursor, OpenCode, bespoke pipelines) drive users to UniView to verify deliverables.

Security & Attack Surface:
- High vulnerability to prompt injection: an untrusted agent could request access to private local or LAN-paired files.
- Requires explicit user approval prompts for file access, session-scoped ephemeral capabilities, strict read-only defaults, and visible audit trails.

Mobile & Platform Parity:
- Mobile cannot easily host persistent background MCP daemons.
- Mobile acts as a viewer receiving receipts via LAN sync or deep-link URI intents (`uniview://open?receipt=...`).

Marketplace Trust & Moderation:
- No marketplace required initially. Value exists directly in the point-to-point connection between the user's agent and the viewer.

Scope & Complexity:
- Medium. Focuses on diffing, annotations, split-screen viewing, and receipt schema parsing rather than generic plugin hosting.

Monetization:
- B2B team review licenses, automated audit-trail retention, compliance archiving, and multi-seat LAN collaboration.

Core Trade-off & Limit:
- Does not directly solve the long-tail file format parsing problem; focuses on the verification workflow of standard formats (PDF, code, markdown, sheets, media).


DIRECTION 3: UNIVERSAL WASM CORE + MCP APPS COMPATIBILITY
Merged from: Round 1 Persp A (Dual-Mode Wasm Core), Persp D (Open Viewer Protocol), Round 2 Persp B (Option E: MCP Apps Standard).

Concept:
Plugins follow emerging cross-ecosystem standards (MCP Apps / tool resources): a deterministic WebAssembly core for headless parsing and conversion, paired with an iframe-isolated web view for rendering. Developers write plugins once and run them in UniView, ChatGPT, Claude, and local IDEs.

Adoption & Developer Flywheel:
- Breaks UniView's cold-start problem: developers build for the global MCP/Wasm ecosystem, not a proprietary UniView API.
- Wasm appeals to serious systems developers (Rust, C++, Go) maintaining industrial parsers.

Security & Attack Surface:
- Strong memory safety inside Wasm linear memory.
- Host-mediated file handles and strict zero-egress capability tokens prevent network exfiltration.
- Web UI remains sandboxed in strict null-origin iframes.

Mobile & Platform Parity:
- Heavy Wasm parsers risk memory exhaustion and thermal throttling on mobile devices.
- Apple App Store review risks: downloading external Wasm binaries dynamically can trigger App Store rejection under Guideline 2.5.2 unless distributed as pre-bundled app updates or static assets.

Marketplace Trust & Moderation:
- High overhead. Requires signed manifests, Software Bill of Materials (SBOM), automated sandbox escape fuzzing, and publisher identity verification.

Scope & Complexity:
- High. Maintaining a dual-runtime host (Electron Node/Browser + Capacitor WKWebView/Android WebView) with Wasm memory bridges and iframe IPC is demanding.

Monetization:
- Commercial registry with revenue-sharing for pro developer plugins, enterprise offline licenses.

Core Trade-off & Limit:
- High developer authoring friction slows early registry volume; agents cannot reliably generate multi-file Wasm+JS plugins on the fly.


DIRECTION 4: CURATED PRO FORMAT STORE & DEMAND-FUNDED BOUNTIES
Merged from: Round 1 Persp A (Zero-Trust Pro Store), Persp B (Underserved Formats & Workflows), Persp C (Curated Registry & Bounties), Persp D (Tiered Capability Sandbox).

Concept:
Double down on the original 8/10 vision with rigorous curation. Target high-value, underserved engineering and industrial file formats (CAD, GIS, medical DICOM, scientific NetCDF/HDF5). Implement verified capability sandboxes, desktop CLI isolation adapters, and a bounty exchange where users fund missing format viewers with test fixtures.

Adoption & Developer Flywheel:
- Captures niche professional users desperate for offline, cross-device viewing without purchasing $5,000/seat CAD/industrial licenses.
- Direct financial incentive: developers get paid upfront via bounties and format sales.

Security & Attack Surface:
- Bulletproof: cryptographic signing, declarative capability tokens, reproducible builds, and strict isolation of native CLI converters in desktop sub-processes.

Mobile & Platform Parity:
- Solved via Asymmetric LAN offload: the paired desktop runs the heavy native/CLI converter; mobile receives rendered lightweight previews (vector tiles, SVG, WebGL scenes).

Marketplace Trust & Moderation:
- Highest trust in the industry. Every plugin is manually reviewed, conformance-tested, and tied to verified legal entities.

Scope & Complexity:
- Very High organizational and moderation overhead. Managing fiat/crypto bounties, licensing disputes, and manual code audits distracts from core software development.

Monetization:
- Direct 15-30% cut of commercial plugin sales, enterprise fleet management, bounty matching fees, and organizational workflow packs.

Core Trade-off & Limit:
- Rejects permissionless agent generation. Growth is linear and curated rather than explosive. High friction for casual developers.


DIRECTION 5: ON-DEMAND LOCAL SYNTHESIS (EPHEMERAL AGENT-GENERATED PLUGINS)
Merged from: Round 1 Persp C ("Plugins are generated"), Persp D (Dynamic Synthesis).

Concept:
"Zero-marketplace" architecture. When a user opens an unrecognized file, a local or connected AI agent inspects sample byte headers, writes an ephemeral, single-file HTML/JS/CSS viewer on the fly, and runs it immediately in a sandboxed container on that machine. The plugin is cached locally and never published to a public registry.

Adoption & Developer Flywheel:
- Fulfills the CEO's vision of infinite extensibility with zero developer recruitment.
- Immediate user delight when edge-case, archaic, or bespoke internal files render without manual plugin hunting.

Security & Attack Surface:
- Severe security risk: dynamic code generated from untrusted files creates an open vector for prompt injection and sandbox escape payloads embedded inside file metadata.
- Requires absolute network egress blocking (no fetch, no WebSocket, no image loading) and strictly read-only ephemeral file handles.

Mobile & Platform Parity:
- Mobile cannot run local code-generation models; mobile relies entirely on paired desktop synthesis.
- iOS blocks executing dynamically downloaded or locally generated executable code in WKWebView unless evaluated strictly through non-persistent `eval` constructs (which still risks App Store scrutiny).

Marketplace Trust & Moderation:
- Zero marketplace moderation cost (there is no store).
- User carries 100% of the quality and reliability risk (hallucinated data, broken layouts, inaccurate parsing).

Scope & Complexity:
- High prompt engineering and containment complexity. Requires self-healing execution loops (capturing JS errors and prompting the agent to fix its own viewer).

Monetization:
- Hard to monetize via transactions; must be packaged as a "UniView AI Assistant" premium subscription.

Core Trade-off & Limit:
- Brittle and unreliable for complex binary files. No network effects or cumulative ecosystem value, as viewers remain isolated on individual devices.


========================================================================================================================
COMPARISON MATRIX ACROSS KEY EVALUATION CRITERIA
========================================================================================================================

Criteria                 Dir 1: Declarative AST    Dir 2: Agent Review Workspace  Dir 3: Wasm + MCP Apps    Dir 4: Curated Pro Store   Dir 5: Local Synthesis
-----------------------  ------------------------  -----------------------------  ------------------------  -------------------------  ------------------------
Primary Target User      Casual devs, agents,      AI engineers, coding agent     Wasm devs, cross-tool     Engineers, GIS/CAD pros,   Edge-case file owners,
                         data analysts             users, code reviewers          power users               enterprise teams           experimental power users

Developer / Agent        Highest (instant JSON     High (hooks into existing      Medium (high dev effort,  Low-Medium (strict gating, High for agents,
Authoring Friction       generation, no code)      agent protocols & CLI)         must write Wasm/JS)       high quality bar)          zero for humans

Ecosystem Cold-Start     Low (users generate own   Zero (leverages existing       Low (borrows global       High (requires recruiting  Zero (no external
Risk                     views immediately)        agents on Day 1)               MCP/tool ecosystems)      format maintainers)        creators needed)

Security & Injection     Near Zero (pure data,     Medium (prompt injection       Low-Medium (isolated      Very Low (signed, audited, High (malicious file
Risk                     no code execution)        file-read risks)               Wasm + iframe sandbox)    zero-egress tokens)        prompts, sandbox break)

Mobile Parity &          Flawless (native host     High (as satellite client     Challenging (Wasm memory  High (via Asymmetric LAN   Poor (cannot run local
iOS Store Compliance     components, iOS safe)     or deep-link consumer)         limits, iOS 2.5.2 risk)   desktop offloading)        synthesis on mobile)

Moderation Overhead      None (specs are data,     None (point-to-point           High (SBOM, malware scan, Severe (manual code audits, None (local only,
                         no malware risk)          local connection)              provenance checks)        bounty arbitration)        no central store)

Direct Monetization      Medium (template packs,   High (team review seats,       High (revenue share on    Highest (bounties, paid    Low-Medium (bundled
Potential                enterprise schemas)       compliance logs)               paid pro plugins)         pro packs, enterprise)     into AI subscription)

Engineering Scope        Controlled (build UI      Focused (diffing, review UI,   Broad (multi-engine Wasm  Very Broad (store infra,   Unpredictable (runtime
Complexity               component catalog)        receipt parser, MCP server)    & iframe host bridges)    worker isolation, billing) self-healing engine)


========================================================================================================================
TWO CROSS-CUTTING ARCHITECTURAL ENABLERS
========================================================================================================================

Regardless of the primary direction chosen, two technical architectures surfaced in Round 2 resolve UniView's physical platform constraints:

1. Asymmetric LAN Offload (Desktop Engine, Mobile Satellite Viewport):
   - Problem: Mobile devices (Capacitor on iOS/Android) cannot run persistent background MCP daemons, heavy Wasm converters, or native CLI binaries without thermal throttle, memory limits, and App Store rejections.
   - Solution: Leverage UniView's existing encrypted LAN pairing. The desktop acts as the heavy compute engine (running MCP servers, Wasm converters, and worker processes). Mobile connects as an authenticated LAN client, viewing lightweight rendered output (vector streams, tiled PDFs, JSON ASTs, or WebGL frames).

2. Zero-Daemon CLI Handoff:
   - Problem: Requiring a resident background MCP daemon on every client creates operational friction and fails on environments where persistent local daemons are killed by the OS.
   - Solution: Support a stateless CLI handoff (`uniview open <file> --view <spec> --receipt <json>`) alongside the MCP daemon. Any script, terminal agent, or shell pipeline can trigger UniView instantly without socket negotiation.


========================================================================================================================
RECOMMENDED SYNTHESIS: THE 9+/10 COMPOSABLE ROADMAP
========================================================================================================================

To jump from 8/10 to 9+/10 without drowning in security liabilities, Apple App Store rejections, and developer cold starts, the optimal path merges Direction 1 and Direction 2 as Phase 1, followed by Direction 3/4 as Phase 2:

Phase 1 (The Wedge): Direction 2 + Direction 1
- Turn UniView into the default human-in-the-loop review tool for AI agents via MCP verbs (`open`, `diff`, `annotate`) and portable review receipts.
- Let agents define visual layouts using a Declarative Semantic Schema (Data-over-Code AST).
- Result: Agents get visual superpowers immediately, users get auditability, security is guaranteed, and mobile apps remain 100% App Store compliant.

Phase 2 (The Platform): Direction 3 with Asymmetric LAN Offload
- Introduce code plugins only after the review workflow is established.
- Align code plugins with the open MCP Apps / Wasm standard so developers don't build UniView-only silos.
- Offload heavy desktop converters to mobile via encrypted LAN streaming, preserving mobile battery and offline safety.
