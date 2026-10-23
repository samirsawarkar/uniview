**My estimate: 11 working days (P50), with a 90% chance of finishing within 20 (P90).**

My previous P50 of 12 sat exactly on the panel's P75. I've moved it down to 11 but no further.

**Why not lower:** The coding alone is about 5 to 6 working days. That is roughly 25 to 30 reviewed sub-packets at about 7 per session. P15 (the bridge with mutual HMAC auth and path policy) and P17 (the MCP stdio server and approval dialogs) carry the most security work, so they will likely need 3 or more  review rounds. The low end of the panel (P25 ≈ 2.9 days) seems to count only the coding. The rest of the estimate is release work:
- wiring signing into the Windows installer;
- the Android release build (R8 shrinking, permissions, the LAN bridge on a real device);
- full device QA on both platforms, plus at least one round of QA fixes.

That adds 4 to 6 days.

**Why I came down slightly:** The pace has been steady, and P14b and P16 are fairly contained, so I trimmed one day.

**P90:** 20 days, which allows for an extra review cycle on P15 and P17 and two QA regression loops.

ESTIMATE: P50=11 P90=20
