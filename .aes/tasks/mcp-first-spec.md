# UniView MCP-first v1 spec

Decision: dec-4be7dff5, option A (long-poll tool plus in-app inbox). Facts: .aes/research/mcp-reply-channel.md.

## The one user story

1. The person clicks **Connect** for Claude Code or Codex in UniView. One click, no terminal.
2. In a normal Claude Code or Codex session, the agent opens a document with `open_files`. It appears in UniView.
3. The person types a change request in a bar under the document, in UniView, and presses Send.
4. The same agent session receives that text, edits the file, and calls `open_files` again.
5. UniView reloads the same tab in place. The agent's short reply shows in the bar. Back to step 3.

Non-goals: Claude channels, `codex queue`, spawning agents from UniView, writing to CLAUDE.md or AGENTS.md, signing, phone features, new dependencies.

## Packet 1: MCP and bridge (electron/lib)

### Server instructions
`initialize` returns an `instructions` string. Its first 512 characters must stand alone. Meaning: when you want to show the person any document, report, image, spreadsheet, PDF or generated file, use UniView `open_files` rather than your own preview window or artifact pane or pasting the content. Then call `wait_for_user_message` and act on what comes back, as a request from the person. After editing, call `open_files` with the same path, then `post_message` with one short sentence, then wait again. Stop only when status is `closed`.

Also rewrite the `open_files` description to say the same briefly.

### New tool: wait_for_user_message
- Input: `{ waitSeconds?: integer }`, optional, clamped to 1..maxWait.
- `maxWait` comes from env `UNIVIEW_MAX_WAIT` (integer 1..3000), default **50** so an unconfigured client with a 60 s tool timeout never times out. Default waitSeconds = maxWait.
- Output, one of:
  - `{ status: "message", text, documentPath }` with the oldest queued message for this session;
  - `{ status: "waiting" }` when the wait elapsed; the agent should call again;
  - `{ status: "closed" }` when the person clicked End on the session's document bar.
- While waiting, if the request has `_meta.progressToken`, send `notifications/progress` every 20 s. Tool cancellation (`notifications/cancelled`) and client disconnect end the wait at once and must not lose a queued message.
- Only one wait per session at a time. A second one fails with `busy`.

### New tool: post_message
- Input: `{ text: string }`, 1..4000 characters.
- Output: `{ posted: true }`. Shows as an agent line in the bar of that session's document. Plain text only, never parsed as HTML or Markdown.

### Inbox
- In main-process memory, one FIFO per agent session, 100 messages max, each at most 8000 characters. A full inbox refuses the send and the UI says so; never drop silently.
- A message is removed only once delivered. If the agent is not waiting it stays queued and the UI says so.
- A session's inbox ends when its connection ends. The UI then shows the agent as disconnected and keeps the unsent text in the box.
- Only the renderer can add messages, through a `fromApp`-guarded IPC handler. No MCP or CLI call can add to any inbox. Follow the existing `guard` and `fromApp` pattern in electron/main.mjs.
- Session isolation: a session only ever receives messages typed on tabs that session opened.

### Tab ownership and reload
- A file opened through `open_files` carries its agent session id to the renderer.
- `open_files` on a path already open in a tab focuses and reloads that tab instead of opening a new one, and the tab takes that session as owner. Reloaded content must come from the file's current bytes, through a fresh grant.
- Existing path policy applies unchanged.

### Tests (vitest)
Tool schemas, clamp and default of waitSeconds, env parsing with bad values, delivery order, wait then message, message then wait, cancel while waiting keeps message, disconnect, second wait busy, session isolation, closed status, post_message length limits, progress notifications with and without a token, full inbox.

## Packet 2: Connect (electron/lib/agent-connect.mjs)

Injected `homedir`, `execFile`, `fs` for tests. Never run from the installer. Runs only when the person clicks Connect or Disconnect.

Server entry for both: command = `process.execPath` (UniView.exe, not the .cmd), args = [packaged path of `electron/mcp-entry.mjs`], env = `ELECTRON_RUN_AS_NODE=1`, `UNIVIEW_MAX_WAIT=1500`.

- **Claude Code:** run `claude mcp add-json --scope user uniview <json>`, with `execFile` and no shell. Remove any old entry first with `claude mcp remove --scope user uniview`, ignoring "not found". Do not edit ~/.claude.json directly.
- **Codex:** text-edit `~/.codex/config.toml` (respect `CODEX_HOME`). Replace the `[mcp_servers.uniview]` block and any `[mcp_servers.uniview.*]` sub-tables, or append. Touch nothing else, preserve line endings and every other byte, keep `config.toml.uniview-backup` from before the first edit, write atomically via temp file and rename. Set `tool_timeout_sec = 1800`, `startup_timeout_sec = 30`, `default_tools_approval_mode = "auto"`.
- **Status:** `status()` returns for each client `{ installed: boolean, connected: boolean }`, plus `stale: true` when the configured exe path differs from the current one. "Installed" is found by looking the binary up on PATH without a shell.
- **Errors:** a missing client returns a plain message, never a throw to the renderer.
- Paths must be escaped correctly in TOML (backslashes) and JSON. Tests cover a path with spaces.
- Disconnect removes only UniView's entries.

Tests: fresh file, existing file with other servers and comments, CRLF file, re-connect replaces rather than duplicates, disconnect restores other content byte for byte, malformed TOML is left unchanged with an error, claude missing, stale path.

## Packet 3: UI, as simple as possible (src/ui)

Top bar: tabs, `+`, Open. Nothing else permanently visible.

Home tab, in this order and nothing else:
1. Drop zone with an **Open file** button.
2. A compact **AI agents** row: `Claude Code [Connect]`, `Codex [Connect]`, with state Connected / Not installed / Reconnect (stale), and a Disconnect link when connected. Clicking Connect shows one sentence saying what will change in which file, with Connect and Cancel.
3. Plain recent files list, no thumbnails.

Remove from the visible UI, without deleting the underlying code or its tests: Sharing and phone pairing cards and tabs, remote browser entry points, action-card grid, hero text, agents toolbar button. The Agents panel (sessions, enrolled agents, audit log, revoke) stays reachable through the **View > Agents** menu item only, since revoke is a safety control. Keep Ctrl+T, Ctrl+N and the existing shortcuts.

Agent bar: shown under a document only when its tab has an owning agent session.
- One line per message, person and agent, most recent at the bottom, scrolling, in a short area of at most about 120 px.
- A text box with Send (Enter sends, Shift+Enter newline) and End.
- A status label, always truthful: `Agent is listening` when a wait is open, `Working…` after delivery, `Message queued. The agent will get it when it next checks` when queued with no wait open, `Agent disconnected` when gone. Send is disabled when disconnected, and the draft stays.
- A one-line hint only while the agent is listening: `Your terminal shows the agent waiting. Press Esc there to take back control.`
- Agent text is plain text, in the same bordered isolation as other agent content.

No new colours or fonts: use existing CSS tokens. Delete CSS that becomes unused.

Tests: vitest for bar state logic, and update Electron e2e specs that relied on removed UI to reach the same function by its new route. Do not delete a test because its button moved. Tests for the phone feature's code remain.

## Acceptance for the whole feature

CTO runs after agy: `npx tsc --noEmit -p .`, `npx vitest run`, the Electron e2e suite, then a live run on the packaged app with real Claude Code through a temporary config, and one with real Codex CLI if its quota allows. Evidence required: a file changed by the agent from text typed in UniView, with the tab reloaded in place.
