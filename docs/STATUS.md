# UniView: status report

**Date:** 2026-10-24
**Branch:** `feat/v1-core`, latest commit `17bedc0`
**Push status:** nothing has been pushed; there is no Git remote yet.

**Team:**
- Claude: CTO.
- agy: writes the code.
- Codex: reviews every change.
- OpenHands: phone testing.

---

## 1. The five-point goal

| # | Goal | Status | Evidence |
|---|---|---|---|
| 1 | View files remotely without copying (stream large media) | **Done** | Tested on a real PC and phone: PDF opens in 1.1 s; a 174 MB video seeks in 1.3 s; the phone finds the PC again 3.2 s after its IP address changes. |
| 2 | Pair devices in seconds (QR code, encrypted LAN, folder permissions) | **Done** | You paired by QR code and clicked Allow in 0.4 s. Revoke cuts the phone off in 0.4 s, and re-pairing works. |
| 3 | One reliable rendering engine | **Done** | Open File Viewer was evaluated (`docs/research/open-file-viewer-evaluation.md`). Its EMF/WMF image converter was integrated (`emf-converter`, permissive). CEO decision (2026-10-25): V1 ships purely permissive using the native OOXML renderer; the optional second PowerPoint engine (@aiden0z/pptx-renderer) is deferred to V1.1 as an isolated chunk. |
| 4 | Privacy by architecture | **Done** | No accounts and no telemetry. The app can only connect to itself. The phone-to-PC protocol is read-only. All 50 web and mobile end-to-end tests pass with a guard that fails if any request leaves the device. |
| 5 | Instant opening (thumbnails, previews, recents, large files) | **Done**, accepted by Codex | Recent files show thumbnails. Large files open without freezing the screen (table below). |

Desktop opening times:

| File | Opens in |
|---|---|
| Video, 174 MB | 0.36 s |
| PDF, 35 MB | 0.47 s |
| PPTX, 37 MB | 0.61 s |
| DOCX, 20,000 paragraphs | 0.91 s |
| XLSX, 73 MB | 2.3 s (opens partially, with a notice) |

---

## 2. Phase 1 (AI agents use UniView as their viewer)

### Accepted by Codex

| Packet | What it does | Commits |
|---|---|---|
| P13a–f | Agent views (`*.uview.json`): schema, safe Markdown, viewer, Reload, Open as JSON | `a202a79` … `5c20566` |
| P14a/c | Receipt and decision formats; file fingerprint (SHA-256) helpers | `ee126e6`, `9323cc4` |
| P12c | Phone request timing and queue-limit fixes | `52cd552` |
| G5a–e | Thumbnails for recent files; large spreadsheets; safe desktop thumbnail fallback | `4e91b06` … `ceb1d60` |
| P15a | **Path policy**: agents can only show local, regular files, checked on the file actually opened | `5188011`, `cc64605`, `9d0b0f1` |
| P15b | **Agent connection**: protocol, named pipe, secret key that only your Windows account can read, connection limits | `97987a9`, `be36c36`, `5510b50`, `a228def`, `201bc8b`, `8e0b6bc` |

**Accepted residual risks** (recorded in the spec and in Obsidian `RISKS.md`):
- A malicious network server could fake a local drive's ID number.
- Another Windows user on the same PC can delay new agent connections.

A small native Windows helper would close both. It is scheduled for later.

### In progress

- **P14b-1** (`17bedc0`): checks the files an agent lists in its receipt and saves your decision. **Codex rejected it** with six findings:
  1. A file swapped for a copy between viewing and clicking Approve could still be approved.
  2. The decision file saved next to the receipt could overwrite another review's decision.
  3. Two quick clicks could record two decisions for one review.
  4. A disk read error broke the "two files at a time" limit.
  5. Cancel and the time limit didn't stop a read already in progress.
  6. The saved copies of a decision could disagree on whether saving succeeded.
- **The fix is written as instructions for agy** (P14b-1b). agy could not run it: when it runs without supervision, it may not read or write files in the UniView project.
- **You approved adding that permission, but it is not applied yet.** I stopped on your instruction while checking agy's exact permission names. The names found so far are `read_file`, `write_to_file`, `edit_file`, `create_file`, `list_dir` and `command(<prefix>)`.

---

## 3. Remaining work

### Next steps, in order

1. **agy permissions:** add `I:\Development\Clone\Universal\uniview` to agy's trusted workspaces, and allow file reading and writing there plus `npx vitest`, `npx tsc` and `git`. You approved this; it is not applied yet.
2. **P14b-1b:** agy fixes the six findings, tests the fixes and commits. Then Codex re-reviews.
3. **P14b-2:** the Review tab screen.
   - The receipt is shown inside a clearly marked "content from the agent" area.
   - Approve and Request changes sit in UniView's own bar, outside that area.
   - The buttons only work after a 500 ms delay, and pressing Enter does nothing.
   - Comments are limited to 8 KiB.
4. **P14b-3:** phone and web.
   - Show the receipt and check the files.
   - Find the listed files on a paired computer or among files you pick.
   - The phone says "Decide on your computer".
5. **P16:** a command line, `UniView open [--wait --receipt]`, with exit codes.
6. **P17:** an agent connector (MCP server) built by us, plus an Agents panel and approval dialogs ("this session" or "always").
7. **Wiring and integration test:** connect the agent connection and the path policy to `electron/main.mjs`. Codex requires a test proving every file read goes through the file UniView opened and checked.
8. **P18: release**
   - agent setup docs (`docs/AGENTS.md`);
   - packaging (signed Windows installer and Android release build);
   - full testing on PC and phone;
   - security review;
   - a test with a real agent, such as Claude Code.

### Smaller open items

- Measure large-file opening times on the phone. This needs your phone connected over USB.
- Device names saved before the fix still end in " Build/…". They need a one-time clean-up.
- iOS still copies shared files instead of streaming them. This needs a Mac or a cloud build service.

### Your decisions and actions

- **Licence:** decide whether the optional PowerPoint engine may use its MPL-2.0 component.
- **Desktop framework:** you had asked for a three-day check of Tauri before signing the app; that decision is still open.
- **Logo:** UniView currently uses the Capacitor logo. It must be replaced before any public release, because of the trademark.
- **Code-signing certificate:** buy a Windows code-signing certificate. It takes days to arrive.
- **Google Play:** set up a developer account and find 12 testers for the required 14-day closed test.
- **Code repository:** create a private GitHub repository so automated testing and reviewed merges can run.

---

## 4. Time estimate

AES team estimate (`dec-51c37b98`): about **8 working days** most likely, **14** in a bad case. This excludes waiting for the certificate, Google Play and iOS. Most of the remaining time is P14b, P16, P17 and the release work.

**Tests:** 660 unit tests pass, plus 52 end-to-end tests on web and mobile and 54 Android unit tests. All test runs and reviews are logged in `I:\AES\Data\uniview-lan-test\`.
