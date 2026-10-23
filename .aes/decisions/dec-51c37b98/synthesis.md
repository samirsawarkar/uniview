Round-2 Delphi Estimates
Unit: working days (8 hours, counted from 2026-10-24)
Panel size: 4

Round-2 Median P50:
  7.75 working days

Round-2 Median P90:
  14.0 working days

Spread:
  Interquartile range (P25 - P75): 4.50 to 11.25 working days (IQR: 6.75 days)
  P50 full range: 4.5 to 12.0 working days (span: 7.5 days)
  P90 full range: 8.0 to 24.0 working days (span: 16.0 days)

Outlier Justifications:

Upper Outliers / High Cluster (P50 = 11.0 to 12.0 days; Perspective C exceeds P75 = 11.25):

- Perspective C (P50 = 12, P90 = 24):
  Retained 12 days on the basis that remaining scope carries significant cross-platform integration risk not reflected in raw packet counts. P14b persistence/phone resolution, P15 authentication/path policy, and P17 MCP/approvals must be validated concurrently across Windows and Android, constrained by 2-3 review rounds per packet. Allocates ~7 working days for implementation, integration, and review acceptance, plus 5 days for documentation, packaging, signing, and device QA. P90 allows for repeated security, installer, and Android lifecycle regressions.

- Perspective D (P50 = 11, P90 = 20):
  Trimmed only 1 day from 12, arguing that the 6 packets will split into 25 to 30 reviewed sub-packets requiring 5 to 6 working days of coding alone, with security packets (P15, P17) requiring 3 or more review rounds. Contends that lower estimates omit 4 to 6 days of release work: wiring signing into the Windows installer, Android release hardening (R8 shrinking, permissions, physical LAN bridge), and full device QA with fix passes. P90 covers an extra review cycle on P15/P17 and two QA regression loops.

Lower Cluster / Upward Adjustments (P50 = 4.5, P90 = 8.0; sitting at P25 = 4.5):

- Perspective A (revised up from 2.5 to P50 = 4.5, P90 = 8.0):
  Updated upward after acknowledging that its round-1 estimate understated review friction on security-critical packets (P15 HMAC/path policy, P17 hand-written MCP stdio server) and turnaround for hardware QA on physical targets. Allocates 2.5 to 3 working days for coding under 2-3 review iterations and mutation tests, plus 1.5 to 2 days for packaging, installer signing verification, and physical QA defect remediation.

- Perspective B (revised up from 3.0 to P50 = 4.5, P90 = 8.0):
  Updated upward to account for end-to-end device verification overhead and multi-round review on security-sensitive components (P15 and P17). Maintained that functional coding takes under 2 days, but physical Android QA, signed Windows installers, and platform-specific lifecycle/sandbox/IPC edge cases demand dedicated additional sessions.
