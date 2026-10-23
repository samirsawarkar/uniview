MEMORANDUM

TO:       Chief Executive Officer
FROM:     Architecture Review Team
DATE:     October 23, 2026
SUBJECT:  UniView Shell Architecture Decision (TYPE 1 Gate: dec-67e7d1c9)


CONTEXT

UniView requires a universal, offline-first file viewer across Windows, macOS, Android, and iOS, built around a single shared React+TypeScript engine. The project operates under strict operational constraints:
  1. Development host is Windows 11 with Node 24, JDK 17, and Android SDK already configured; no local macOS host exists (Apple builds require CI).
  2. Immediate imperative is shipping a fully functional V1 soon, validated against a 500-file benchmark on time-to-first-view, format coverage, and memory.
  3. Gander research confirms the offline WebView + same-origin fetch + strict CSP pattern is proven and stable on Android.

The core dilemma is whether to commit to Electron + Capacitor (Option A), standardise universally on Tauri v2 (Option B), or implement Electron + Capacitor immediately behind a strict abstraction seam while timeboxing a Tauri prototype before code signing (Option C).


RECOMMENDED PATH: OPTION C (PHASED SEAM WITH BENCHMARKED TAURI GATE)

Proceed immediately with Electron (desktop) and Capacitor (mobile) behind a minimal, rigid FileSource / ShellBridge abstraction interface (6 to 8 core methods: open, read-range, stat, list, picker, intent handling). 

Key justifications:
  - Zero-Friction Velocity: Capitalises on the pre-installed Node/JDK/Android toolchain on Windows 11 immediately, avoiding onboarding delays for Rust and MSVC Build Tools.
  - Proven Offline Pattern: Directly inherits Gander's verified WebView architecture for Android without platform experimentation.
  - Architecture Hygiene: Keeps the core React+TypeScript viewing logic 100% agnostic of shell runtimes via CI import fences.
  - Defers Irreversible Costs: Delays the true TYPE 1 lock-in point (store packaging and code signing) until concrete empirical benchmark metrics are gathered.

Enforced Guardrails:
  - CI Lint Fence: Fail CI immediately if viewer core imports electron, @capacitor/*, or @tauri-apps/*.
  - Timeboxed Prototype: Run a strict 3-day Tauri desktop spike evaluated against the exact 500-file benchmark.
  - Explicit Migration Criteria: Migrate to Tauri only if it yields at least a 25-30% improvement in p50 time-to-first-view or a 50% reduction in installer size with zero format coverage regression. Otherwise, formally lock Option A.


STANCE MATRIX BY PERSPECTIVE

Perspective | Round 1 Stance | Round 2 Stance | Core Emphasis
------------+----------------+----------------+---------------------------------------------------
A           | CONCERNS (C)   | APPROVE (C)    | Toolchain readiness; small 6-8 method seam; fixed gate thresholds.
B           | APPROVE (C)    | APPROVE (C)    | Empirical 500-file corpus gate; early Apple CI feasibility smoke tests.
C           | APPROVE (C)    | APPROVE (C)    | Zero setup friction; clean domain isolation; Gander offline parity.
D           | APPROVE (C)    | APPROVE (C)    | System WebView divergence risks in Tauri; dual-shell tax is overstated.

Consensus: Unanimous APPROVE for Option C across all four evaluators, conditional on an enforceable evaluation gate.


STRONGEST DISSENT (STEELMAN OF OPTION B)

The strongest objection is the "Dual-Shell Tax and Inevitability Trap." 

By selecting Option C, the team builds, tests, and maintains two separate IPC bridge implementations (Node/Chromium for desktop, native Android/iOS WebViews via Capacitor) while carrying a third prospective runtime (Tauri/Rust) in the background. If Tauri v2 is the superior long-term destination for unified 4-platform codebase lightness and single-framework packaging, writing throwaway Electron/Capacitor shims burns engineering cycles. Furthermore, organizational inertia under schedule pressure routinely results in "temporary" prototypes being cancelled, cementing Electron's high memory footprint and bloated binary distribution as the permanent reality by default.

Rebuttal: Tauri does not eliminate native mobile divergence (storage scopes, content URIs, and intents still demand platform-specific Swift/Kotlin plugins). Moreover, Tauri desktop relies on WebView2/WKWebView, which lacks the deterministic codec/worker stability of Electron's bundled Chromium. The FileSource interface isolates the viewer core regardless, making the shim cost negligible compared to format decoder work.


DECISION NEEDED FROM CEO

1. Approve Option C as the execution strategy for UniView V1.
2. Formally authorise the decision gate rule:
   - Commit to a 3-day Tauri prototype before code signing.
   - Authorise migration to Tauri only if p50 time-to-first-view improves by >= 25% or binary size shrinks by >= 50% with 0% format regression; otherwise confirm Option A.


BLOCKERS & CRITICAL FLAGS

- NO LOCAL HARDWARE BLOCKER: Development is hosted exclusively on Windows 11. No local macOS hardware exists. macOS and iOS builds CANNOT be verified locally.
  ACTION: Cloud CI/CD infrastructure (e.g., GitHub Actions macOS runners) must be provisioned within the first sprint to enable early smoke builds and headless WKWebView testing.
- CURRENT STATE: ZERO BLOCKERS for immediate Windows and Android local development under Node 24 and Android SDK. Development can begin today.
