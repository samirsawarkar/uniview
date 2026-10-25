# UniView: status report

**Date:** 2026-10-26
**Branch:** `feat/v1-core`, latest commit `73ed049`
**Push status:** nothing has been pushed; there is no Git remote yet.

**Team:**
- Claude: CTO (plans, briefs, decides, verifies, commits). Claude agents built the last fixes while agy was out of quota.
- agy: writes most of the code (out of Gemini quota until about 28 Oct).
- Codex: reviews every change. Independent reviewers (a second AI family) check the rest.
- Hermes: research briefs. OpenHands and Strix were not used in this phase (Strix needs Docker, which is not running).

---

## 1. The five-point goal

| # | Goal | Status |
|---|---|---|
| 1 | View files remotely without copying (stream large media) | **Done** (PC and phone tested earlier) |
| 2 | Pair devices in seconds (QR code, encrypted LAN, folder permissions) | **Done** |
| 3 | One reliable rendering engine | **Done.** V1 ships without the MPL-2.0 PowerPoint engine (CEO decision 2026-10-25); the second engine is deferred to V1.1 as an isolated chunk. |
| 4 | Privacy by architecture | **Done.** All web and phone-size end-to-end tests pass (52), including the guard that fails if any request leaves the device. |
| 5 | Instant opening | **Done** on the PC (video 174 MB 0.36 s, PDF 35 MB 0.47 s, PPTX 37 MB 0.61 s, 20,000-paragraph DOCX 0.91 s). Phone timings need the physical phone. |

## 2. Phase 1: AI assistants use UniView as their viewer: built

- Agent views (`*.uview.json`) and review receipts, with the Review tab (Approve / Request changes, 500 ms arming, real clicks only, files re-verified at click time).
- Phone and web receipt viewer (read-only: "Decide on your computer").
- Command line `UniView open [--wait --receipt --view]` with exit codes 0/2/3/4/5/6.
- MCP connector. In the packaged app it runs in Node mode through `resources\uniview-mcp.cmd`, because stdio does not work in Electron's main process on Windows. Setup guide: `docs/AGENTS.md`.
- Approval dialog (this session / always / don't allow), enrolment, Agents panel with revoke, activity log.
- Path policy: local regular files only; agent tabs read through the already-checked file handle.
- Tabs opened by a command or agent stay readable after it exits (until the tab is closed, the agent is revoked, or the app quits).

**Review record.** Every packet was reviewed by Codex or an independent reviewer. They rejected work more than 20 times, and the fixes were re-reviewed. Final Codex security review of the agent surface at `73ed049`: **SHIP-READY** (no High or Critical findings).

**Accepted residual risks** (documented in `docs/AGENTS.md` and the spec). The trust boundary is the Windows user account: a same-user program can claim to be the command line (no approval) or reuse an enrolled agent's name, and a local receipt is read through its granted path. A hostile same-user program could also fill the 64-tab cap; recover by closing tabs or revoking it. A native Windows helper would close the earlier network-drive residual.

## 3. Verified on real builds

- Unit and integration: **1393 tests pass**, type check clean.
- Real Electron window (Playwright): 4/4 (agent open, swap-after-open, reload, approval, remote pairing).
- Web and phone-size: 52/52.
- Packaged app (`release-final`, unsigned): cold start does not hold the caller's pipe, the MCP launcher answers initialize and tools/list, CLI usage errors exit 2. The Android debug APK launches cleanly in the emulator; a debug APK and an unsigned release bundle are built.
- Board demo kit: `demo/` (runbook `demo/DEMO.md`), rehearsed end to end on the packaged app.

## 4. Remaining

### Needs you (CEO)
- **Windows code-signing certificate:** buy one (recommended: SSL.com or Sectigo OV cloud signing, about $250 a year). The installers are unsigned until then.
- **Google Play:** create the Play Console account ($25), verify identity, find 12 testers for a 14-day closed test. The release bundle is built but unsigned; it needs the Play upload key.
- **Private GitHub repository:** say when. GitHub Pro (about $4 a month) is needed for branch protection on a private repository.
- **Logo:** the current blue-eye icon is a placeholder used everywhere and locked. Send the final logo file and every size will be regenerated from it.
- **Phone:** connect your phone for the real pairing and large-file timing test.

### Technical, not blocked on you
- Re-run Codex on the final code after any further change.
- iOS still copies shared files instead of streaming (needs a Mac or a cloud build service).
- Strix security scan (needs Docker on I:).
- Device names saved before an earlier fix still end in " Build/…" (one-time clean-up).
- Phone and web view specs: image pixels are not drawn yet (placeholders and disabled file references work).

## 5. Decisions made (2026-10-25)
- Ship V1 without the MPL-2.0 PowerPoint engine (V1.1).
- Stay on Electron for V1 (Tauri deferred to V2).
- Placeholder logo now; final logo from the CEO later.

Tests, reviews and logs: `I:\AES\Data\uniview-lan-test\`, `.aes/` in the project, decision briefs in `docs/CEO-DECISIONS.md`.
