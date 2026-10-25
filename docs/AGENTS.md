# Using UniView with AI Coding Agents

UniView serves as a private, offline viewer and human-in-the-loop review workspace for AI coding agents (such as Claude Code, Codex, and Cursor).

Agents can:
- Open local files in native viewer tabs (PDFs, spreadsheets, presentations, code, images, diffs).
- Render rich, structured view specifications (`*.uview.json`) for dashboards, tables, metrics, and trees.
- Submit review receipts (`*.receipt.json`) describing completed tasks and changed files with SHA-256 hashes.
- Request human review decisions: the person clicks **Approve** or **Request changes** (with optional feedback comments), and UniView returns a cryptographic decision record back to the agent.

---

## Command Line Interface (CLI)

UniView includes a command-line client that communicates with the running desktop application or automatically cold-starts it.

### Syntax

```bash
UniView open [--wait [--timeout <s>]] [--receipt <file>] [--view <file>] [--] <file>...
```

### Arguments and Options

| Option / Argument | Description |
|---|---|
| `open` | Subcommand keyword (required). |
| `<file>...` | One or more local files to open in UniView tabs. Relative paths are resolved against the CLI process working directory. |
| `--receipt <file>` | Path to a `*.receipt.json` review receipt file. Opens a review tab in UniView. |
| `--view <file>` | Path to a `*.uview.json` view specification file. Opens a view tab in UniView. |
| `--` | Flags terminator. All subsequent arguments are treated as file paths, even if they begin with a dash (`-`). |
| `--wait` | Waits synchronously for the person to make a review decision. **Requires `--receipt`**. |
| `--timeout <s>` | Maximum time in whole seconds to wait for a review decision (1 to 2,147,483 seconds; default `3600`). **Requires `--wait`**. |

### Exit Codes

The CLI returns standard exit codes:

| Code | Status | Meaning |
|---|---|---|
| `0` | **OK** | Files handed off to UniView successfully, or the review was **approved** when waiting with `--wait`. |
| `2` | **Usage / Path Error** | Invalid flags, missing required arguments (`--wait` without `--receipt`, `--timeout` without `--wait`), empty path, path longer than 4096 characters, or the file/view/receipt path was rejected by the path policy. |
| `3` | **Changes Requested** | The person reviewed the receipt and clicked **Request changes**. |
| `4` | **Dismissed** | The review was closed or dismissed without an explicit decision (e.g. user closed the tab, or app shut down). |
| `5` | **Timeout** | No review decision was made within the `--timeout` duration. |
| `6` | **Unreachable** | The UniView application is not running and could not be started within 15 seconds, the bridge connection failed, or an internal error occurred. |

### Output

- **Without `--wait`**: Prints an acknowledgement to `stdout`:
  ```text
  Opened in UniView: C:\project\index.ts, C:\project\report.pdf
  ```
- **With `--wait`**: Prints the progress note to `stderr` and, upon completion, prints the formatted JSON decision record (`decision/1`) to `stdout`:
  ```json
  {"uniview":"decision/1","reviewId":"0123456789abcdef0123456789abcdef","receiptDigest":"...","decision":"approved","comment":"Looks clean","decidedAt":"2026-10-25T14:32:00.000Z","verifiedAt":"2026-10-25T14:32:00.000Z","persisted":true,"files":[{"path":"C:\\project\\index.ts","expectedSha256":"...","observedSha256":"...","state":"unchanged"}]}
  ```

---

## MCP Server

UniView provides a built-in Model Context Protocol (MCP) stdio server.

### Invocation

```bash
UniView.exe --mcp
```
*(In source development: `electron . --mcp`)*

- **Transport**: Standard JSON-RPC 2.0 over `stdin` and `stdout` (newline-delimited UTF-8).
- **Logging**: All diagnostics and operational logs are written to `stderr`. `stdout` carries only protocol messages.
- **Protocol Revisions**: Negotiates protocol revisions: `2025-06-18` (default/latest), `2025-03-26`, and `2024-11-05`.
- **Limits**: Maximum line length of 16 MiB on stdin. Inline document texts (`specText`, `receiptText`) are limited to 2 MiB UTF-8.

### Available Tools

#### 1. `open_files`
Opens local files in UniView tabs for the user to inspect.

- **Input Schema**:
  ```json
  {
    "paths": ["C:\\path\\to\\file1.ts", "C:\\path\\to\\file2.pdf"]
  }
  ```
  *Array of 1 to 20 absolute paths to local regular files.*
- **Output**:
  ```json
  {
    "opened": 2
  }
  ```

#### 2. `show_view`
Renders a declarative view specification (`uniview view/1`) in a new tab.

- **Input Schema** *(requires exactly one of `specText` or `specPath`)*:
  ```json
  {
    "specText": "{\"uniview\":\"view/1\",\"title\":\"Status\",\"body\":[...]}"
  }
  ```
  *or*
  ```json
  {
    "specPath": "C:\\path\\to\\dashboard.uview.json"
  }
  ```
- **Output**:
  ```json
  {
    "shown": true,
    "scopeId": "0123456789abcdef0123456789abcdef"
  }
  ```

#### 3. `request_review`
Presents a review receipt (`uniview receipt/1`) for human review.

- **Input Schema** *(requires exactly one of `receiptText` or `receiptPath`)*:
  ```json
  {
    "receiptText": "{\"uniview\":\"receipt/1\",\"task\":\"Refactor auth\",...}",
    "waitSeconds": 300
  }
  ```
  - `waitSeconds`: Optional integer (0 to 3600, default `0`).
    - If `0`: Returns immediately with `status: "pending"` and a `reviewId`. The agent can poll using `get_review`.
    - If `> 0`: Waits up to `waitSeconds` for the person to decide.
- **Output (Immediate / Decided)**:
  ```json
  {
    "status": "decided",
    "reviewId": "0123456789abcdef0123456789abcdef",
    "decision": {
      "uniview": "decision/1",
      "reviewId": "0123456789abcdef0123456789abcdef",
      "receiptDigest": "...",
      "decision": "approved",
      "comment": "Looks good!",
      "decidedAt": "2026-10-25T14:30:00.000Z",
      "verifiedAt": "2026-10-25T14:30:00.000Z",
      "persisted": true,
      "files": [
        {
          "path": "C:\\project\\auth.ts",
          "expectedSha256": "...",
          "observedSha256": "...",
          "state": "unchanged"
        }
      ]
    }
  }
  ```
- **Output (Pending)**:
  ```json
  {
    "status": "pending",
    "reviewId": "0123456789abcdef0123456789abcdef"
  }
  ```

#### 4. `get_review`
Polls the review decision for a previously requested review.

- **Input Schema**:
  ```json
  {
    "reviewId": "0123456789abcdef0123456789abcdef"
  }
  ```
- **Output**:
  Returns `{ "status": "decided", "decision": { ... } }` or `{ "status": "pending" }`.

### MCP Error Codes

Standard JSON-RPC 2.0 error codes:
- `-32700`: Parse error (invalid JSON).
- `-32600`: Invalid Request (malformed structure or already initialized).
- `-32601`: Method not found.
- `-32602`: Invalid params (missing arguments, invalid types, mutually exclusive options violated).
- `-32002`: Server not initialized.

Tool failures are returned with `isError: true` containing standard error codes:
- `not_allowed`: The user declined agent permission or the approval prompt timed out.
- `bad_path`: Refused path; paths must be absolute paths to local regular files.
- `invalid_spec`: The view specification failed schema validation or exceeded size limits.
- `invalid_receipt`: The review receipt failed schema validation.
- `busy`: UniView is handling too many concurrent requests or queue is full.
- `app_unavailable`: UniView desktop app is unreachable.
- `not_found`: Review ID does not exist or belongs to a different session.
- `timeout`: The operation or review wait timed out.

---

## Agent Approval and Management

### Human Approval Prompt

When an agent session issues its first tool call, UniView presents a modal prompt to the user:

> **"An agent that says it is \<name\> wants to show files and ask for reviews in UniView"**

The user has three choices:
1. **Allow for this session**: Grants permission for the current connection lifetime.
2. **Always allow**: Enrolls the agent client permanently. UniView generates a 256-bit client authentication key saved in `<userData>/agents/<clientId>.key` (owner-only ACL). Future sessions from this client authenticate cryptographically and bypass repeated dialogs.
3. **Don't allow**: Denies access immediately (returns `not_allowed`).

**Dialog Rules**:
- Up to 4 approval requests queue if multiple calls occur.
- A 120-second timeout applies; unanswered prompts fail closed (`not_allowed`).

### Agents Panel

Open the **Agents** panel in UniView to:
- Inspect active agent sessions.
- View enrolled agents and their permissions.
- Audit the activity log (records agent opens and reviews; retains up to 500 entries or 30 days).
- **Revoke**: Clicking "Revoke" on an enrolled agent permanently removes its stored key, cancels any pending review waits, and immediately terminates its active sessions.

---

## View Spec Format (`*.uview.json`)

Declarative view specifications allow agents to display structured content without executing arbitrary script code.

### Minimal Valid Example

```json
{
  "uniview": "view/1",
  "title": "Agent Execution Summary",
  "agent": {
    "name": "claude-code",
    "model": "claude-3-7-sonnet"
  },
  "body": [
    {
      "type": "heading",
      "text": "Overview",
      "level": 1
    },
    {
      "type": "callout",
      "tone": "info",
      "title": "Execution Completed",
      "text": "Task finished in 3 iterations."
    },
    {
      "type": "keyValue",
      "items": [
        { "key": "Target Directory", "value": "src/core" },
        { "key": "Files Modified", "value": "3" }
      ]
    }
  ]
}
```

### Supported Node Types

- `heading`: Text up to 300 characters, level 1–4.
- `markdown`: Restricted Markdown (up to 256 KiB; raw HTML stripped, external images blocked, links inert).
- `callout`: `tone` (`info`, `success`, `warning`, `danger`), `text`, optional `title`.
- `keyValue`: List of up to 500 `{ key, value }` pairs.
- `table`: Column definitions with alignment and rows of cell data.
- `list`: Ordered or unordered list of items or nested nodes.
- `tree`: Hierarchical nodes with labels and details (up to 20,000 entries).
- `code`: Syntax-highlighted code block with line numbering and highlighted line ranges.
- `diff`: Unified or side-by-side file differences computed in a sandboxed worker.
- `image`: Local images (PNG, JPEG, WebP, GIF; decoded under strict memory limits).
- `chart`: Categorical bar or line charts.
- `section`: Collapsible container for grouping nodes.
- `columns`: 2 or 3 responsive columns.
- `fileRef`: Link to open a local file in a separate UniView tab.

### Budgets

- Maximum file size: **2 MiB**.
- Maximum hierarchy depth: **32**.
- Maximum total node count: **50,000** (counting cells, list items, tree entries, chart points).

---

## Review Receipt Format (`*.receipt.json`)

Review receipts record agent work, list affected files, provide cryptographic verification hashes, and specify associated test checks.

### Minimal Valid Example

```json
{
  "uniview": "receipt/1",
  "createdAt": "2026-10-25T14:30:00.000Z",
  "agent": {
    "name": "claude-code",
    "model": "claude-3-7-sonnet",
    "run": "run-4029"
  },
  "task": "Add authentication guard to API routes",
  "summary": "Implemented bearer token validation middleware and updated route handlers.",
  "files": [
    {
      "path": "C:\\repo\\src\\auth.ts",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "role": "modified"
    }
  ],
  "checks": [
    {
      "name": "test-auth-unit",
      "status": "pass"
    }
  ]
}
```

### File Verification and Decision

When a receipt is opened, and again when the user clicks **Approve** or **Request changes**:
1. UniView reopens each file path through the security path policy.
2. Compares device and inode handles to detect replacement.
3. Computes the current streaming SHA-256 hash.
4. Determines state: `unchanged`, `changed`, `replaced`, `missing`, `unreadable`, or `too_large`.
5. If any file changed between display and click, approval is blocked and the user is prompted to review the refreshed contents.

When approved, UniView generates a decision record (`uniview decision/1`) signed by the session and optionally saves `<receipt>.decision.json` adjacent to file receipts.

---

## Privacy and Security Model

- **100% Offline & Local**: UniView runs completely on-device. No telemetry, no cloud connectivity, no accounts.
- **Same-User Trust Boundary**: Agents run under the same OS user. UniView uses a local mutual-authentication bridge:
  - Windows: Named pipe `\\.\pipe\uniview-bridge-<hash>` with owner-only access controls.
  - macOS / Linux: Unix domain socket `<userData>/bridge/b.sock` (mode 0700).
  - Mutual Handshake: 256-bit shared secret in `<userData>/bridge/key` with owner-only ACLs (`icacls` on Windows, `0600` on Unix).
- **Strict Path Policy**:
  - Requires absolute paths to local regular files.
  - Rejects UNC network shares (`\\server\...`), device paths (`\\.\`, `\\?\`), DOS device names (`CON`, `NUL`, `COM1`), and alternate data streams (`:`).
  - Opens file handle first, then checks device identifiers to prevent symlink race conditions (TOCTOU).
  - Grants are scoped to view lifetimes; closing a tab closes file handles.
- **No Agent Read Access**: Agents cannot read file contents or list directories through UniView.
- **UI Content Isolation**: Agent text is rendered inside a clearly bordered container; action buttons (**Approve**, **Request changes**) reside outside in an isolated app bar. Approval requires a deliberate physical mouse click; a 500 ms arming delay prevents accidental double-clicks or UI spoofing.

---

## Client Configuration Snippets

Replace `<username>` with your Windows user profile name.

Packaged executable path placeholder on Windows:
```text
C:\Users\<username>\AppData\Local\Programs\UniView\UniView.exe
```

### 1. Claude Code

Add the MCP server via CLI:
```bash
claude mcp add uniview -- "C:\Users\<username>\AppData\Local\Programs\UniView\UniView.exe" --mcp
```

Or add to `.mcp.json` / Claude Desktop configuration:
```json
{
  "mcpServers": {
    "uniview": {
      "command": "C:\\Users\\<username>\\AppData\\Local\\Programs\\UniView\\UniView.exe",
      "args": [
        "--mcp"
      ]
    }
  }
}
```

### 2. OpenAI Codex

In `config.toml`:
```toml
[mcp_servers.uniview]
command = "C:\\Users\\<username>\\AppData\\Local\\Programs\\UniView\\UniView.exe"
args = ["--mcp"]
```

### 3. Cursor

In `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "uniview": {
      "command": "C:\\Users\\<username>\\AppData\\Local\\Programs\\UniView\\UniView.exe",
      "args": [
        "--mcp"
      ]
    }
  }
}
```

---

## Troubleshooting

### App is not reachable (Exit Code 6 / `app_unavailable`)
- If UniView is closed, the CLI and MCP server attempt to cold-start it within a 15-second budget. Ensure the executable path is correct and that your system permits local child process spawning.
- Ensure the user profile directory has standard read/write permissions for creating the bridge key and socket/named pipe.

### Agent rejected (`not_allowed`)
- The person clicked "Don't allow" in the approval dialog, or the 120-second prompt timed out.
- Open UniView, navigate to the **Agents** panel, and check agent authorization status. Re-run the agent command to prompt again.

### Path rejected (`bad_path`)
- Ensure all paths passed to `open_files`, `specPath`, or `receiptPath` are **absolute paths** to existing, regular files on local fixed drives. Relative paths are only resolved in CLI `open` mode.
- Avoid passing network drive paths, UNC shares, or directory paths.

### Spec or receipt rejected (`invalid_spec` / `invalid_receipt`)
- Validate the JSON payload against `shared/schemas/view-1.json` or `shared/schemas/receipt-1.json`.
- Ensure documents do not exceed 2 MiB in size.
- Verify that every item in `files` includes valid 64-character lowercase hex SHA-256 hashes.
