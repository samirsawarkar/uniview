# Live MCP test with real assistants, 26 October 2026

Both assistants were run for real (not simulated) against the packaged app `release-logo\win-unpacked\UniView.exe`
(unsigned, with the final logo), through the Node-mode entry `resources\app.asar\electron\mcp-entry.mjs` with
`ELECTRON_RUN_AS_NODE=1`, the form documented in `docs/AGENTS.md`. Test harness: `demo/mcp-live-host.mjs`
(PC side: runs the app, answers the native approval prompt with "Allow for this session" and clicks Approve with a
real click like a person would; the product has no test hook).

| Assistant | What it did | Result |
|---|---|---|
| Claude Code 2.1.302 (`claude -p --mcp-config ... --strict-mcp-config`) | `open_files` (2 files), `show_view`, `request_review` (no wait) | `{"opened":2}`, `{"shown":true,...}`, `{"status":"pending","reviewId":...}`; the approval prompt named the agent "claude-code" |
| Claude Code | `request_review` with `waitSeconds 120` while the person clicked Approve | "Decision: approved. Files: sales.xlsx unchanged, notes.md unchanged, app.ts unchanged" |
| Codex 0.162 (`codex exec -c mcp_servers.uniview...`) | `request_review` with `waitSeconds 120` | "decision: approved; sales.xlsx / notes.md / app.ts unchanged"; the approval prompt named the agent "codex-mcp-client" |

## Notes
* Neither assistant's configuration files were changed: Claude Code used `--mcp-config` with `--strict-mcp-config`, Codex used `-c` overrides.
* Codex needs its own tool-approval setting for MCP tools in non-interactive mode: add
  `default_tools_approval_mode = "approve"` under `[mcp_servers.uniview]` (without it Codex refuses the call: "approval policy is never").
  In TOML paths use forward slashes (`I:/...`).
* If UniView is not running, the MCP entry cold-starts the app (observed while a harness had died): the first call then waits for the person to answer the approval prompt.
* The unit-level conformance tests and Codex's security review are unchanged.
