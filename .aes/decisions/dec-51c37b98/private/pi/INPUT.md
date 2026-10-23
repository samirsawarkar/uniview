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

At an observed velocity of ~7 reviewed packets per session, the ~6 remaining packets (P13f through P18) represent roughly 1 to 1.5 working days of core development. However, P15 (HMAC/path policy), P17 (stdio MCP), and P18 (Windows installer signing and Android hardware device QA) carry significant platform-specific integration friction and strict mutation test gates.

ESTIMATE: P50=3 P90=5

Key assumptions:
1. Windows stdio IPC and Android mutual HMAC bridge pass  review within the usual 2–3 rounds without hitting blocking OS-level socket/sandbox restrictions.
2. Android release packaging and physical device QA uncover only minor layout or state regressions that resolve in a single polish pass rather than architectural rework.
