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

ESTIMATE: P50=12 P90=24

Unit: working days of 8 hours, counted from 2026-10-24.

1. The existing foundation is sound, and the team sustains its current workflow with 2–3  review rounds per packet. Seven reviewed packets per session does not translate directly to these remaining packets: bridge security, MCP, persistence, and approval flows each require substantial integration work.

2. Signing credentials and Android devices are available when needed. Implementation and acceptance take approximately 7 days, followed by 5 days for packaging, release builds, security checks, and full device QA. P90 allows for authentication/path-policy defects, Windows installer issues, and Android lifecycle or phone-resolution regressions requiring repeated review and testing. External waits and iOS are excluded.
