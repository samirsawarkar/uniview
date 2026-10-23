# Question

How many working days (unit: working days of 8 hours, counted from 2026-10-24) until UniView is production ready on Windows and Android? Production ready = Phase 1 agent review workspace complete and Codex-accepted (remaining packets: P13f in flight, P14b Review tab with file verification/persistence/phone resolution, P15 local bridge with mutual HMAC auth and path policy, P16 CLI, P17 hand-written MCP stdio server + Agents panel + approval dialogs, P18 docs/packaging/QA/security), signed Windows installer and Android release build passing full device QA. Exclude external waits (code-signing certificate issuance, Google Play review/closed testing) and iOS. Context: plan docs/tasks/phase-1-agent-workspace.md; pace so far ~7 reviewed packets per working session, most packets need 2-3 Codex review rounds; agy writes code, Claude integrates test-first with mutation checks, Codex reviews.

# Statistics

{
  "n": 4,
  "median_p50": 7.5,
  "p25": 2.875,
  "p75": 12.0,
  "median_p90": 13.5
}

# Your Previous Estimate

ESTIMATE: P50=2.5 P90=4.5

**Key Assumptions:**

1. **Pipeline Throughput & Review Convergence:** The // triage sustains its ~7 reviewed packets per session velocity, completing the remaining 6 packets (P13f through P18) within ~1.5 working days despite 2–3 review rounds each, without fundamental redesigns on P15 HMAC security or P17 MCP stdio interfaces.
2. **Platform Packaging & Device QA Overhead:** Windows installer creation and Android release builds pass hardware QA with only minor platform-specific or bridge regressions, requiring 1 day (P50) to 3 days (P90) of verification and defect remediation, excluding external store and certificate delays.
