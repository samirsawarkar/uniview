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

ESTIMATE: P50=12 P90=22

I estimated this from the context in your message alone, without opening the repo or the plan.

**How I got there:** The six remaining packets will probably split into about 25 to 30 reviewed sub-packets, judging by how P13 and P14 split. P15 (the bridge with mutual HMAC auth and path policy) and P17 (the MCP stdio server, Agents panel and approval dialogs) carry the most security work and will need the most review rounds. At about 7 reviewed packets per session, that is 5 to 7 working days of coding. Release work adds 4 to 6 days: wiring signing into the Windows installer, hardening the Android release build (R8/ProGuard (the release-build code shrinker), permissions, the LAN bridge on a real device), full device QA, and the fixes QA finds.

**Key assumptions:**
1. One working session is roughly one 8-hour day, and the current pace holds.  review rounds stay at 2 to 3 per packet and don't grow on the security-heavy packets.
2. Device QA on Windows and Android finds only moderate rework, not architecture problems. The P90 allows for about 1.5 extra review cycles on P15 and P17 and one QA regression loop.
