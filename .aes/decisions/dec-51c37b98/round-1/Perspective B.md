ESTIMATE: P50=12 P90=22

I estimated this from the context in your message alone, without opening the repo or the plan.

**How I got there:** The six remaining packets will probably split into about 25 to 30 reviewed sub-packets, judging by how P13 and P14 split. P15 (the bridge with mutual HMAC auth and path policy) and P17 (the MCP stdio server, Agents panel and approval dialogs) carry the most security work and will need the most review rounds. At about 7 reviewed packets per session, that is 5 to 7 working days of coding. Release work adds 4 to 6 days: wiring signing into the Windows installer, hardening the Android release build (R8/ProGuard (the release-build code shrinker), permissions, the LAN bridge on a real device), full device QA, and the fixes QA finds.

**Key assumptions:**
1. One working session is roughly one 8-hour day, and the current pace holds.  review rounds stay at 2 to 3 per packet and don't grow on the security-heavy packets.
2. Device QA on Windows and Android finds only moderate rework, not architecture problems. The P90 allows for about 1.5 extra review cycles on P15 and P17 and one QA regression loop.
