# Research: MCP Reply Channels and Session Injection in Claude Code and Codex CLI

**Date of Research:** October 30, 2026  
**Author:** AES Internal Operations (Hermes Agent)  
**Target Architecture:** UniView (Local Windows document viewer with stdio MCP server) communicating user change requests back to an active Claude Code or Codex CLI agent session.

---

## Executive Summary

When an agent running under **Claude Code** or **Codex CLI** opens a document in UniView via an MCP tool call, UniView needs a mechanism to deliver subsequent user change requests back to the running session.

- **Claude Code** provides an in-protocol push mechanism called **Channels** (`notifications/claude/channel`), but it is in Research Preview, requires direct Anthropic authentication, and strictly requires the `--channels` or `--dangerously-load-development-channels` flag at startup (without which incoming notifications are silently dropped). It also supports **MCP Elicitation** (`elicitation/create`) in interactive sessions, which blocks the tool call until the user responds in a terminal dialog.
- **Codex CLI** does not implement Claude's channel extension or any in-protocol push notification for user prompt injection. Instead, Codex CLI provides a dedicated CLI command, `codex queue --thread <THREAD_ID> --message <TEXT>`, which dispatches through the local `codex app-server` daemon to wake an active/idle session and enqueue the user's request. Codex also implements **MCP Elicitation** (`elicitation/create`), which blocks the active tool call while prompting the user.
- **Concurrent Resumes Are Unsafe**: In both clients, attempting to inject prompts by concurrently invoking `claude --resume <id> -p "<text>"` or `codex exec resume <id> "<text>"` while an interactive session is open is **unsafe and actively blocked** by process and writer locks (`thread-writer-locks` in Codex, and `already open in another running Claude session` in Claude Code).

---

## 1. Claude Code

### 1.1 Channels / Server-to-Client Push (`notifications/claude/channel`)
- **Protocol & Mechanism**: A Claude Code channel is an MCP server running locally over stdio that declares `capabilities.experimental['claude/channel'] = {}` during initialization. The server emits JSON-RPC notifications using the method `notifications/claude/channel` with parameters `{ content: string, meta?: Record<string, string> }`. The payload arrives in Claude's context wrapped in a `<channel source="<server-name>" ...>` XML tag. For two-way communication, the server advertises a standard MCP tool named `reply` (accepting arguments like `chat_id` and `text`), and Claude calls `reply` to send messages back.
- **Status**: Research preview (available since Claude Code v2.1.80). Supported only with direct Anthropic authentication (claude.ai login or Anthropic Console API key). It is not supported on third-party cloud platforms (Amazon Bedrock, Google Cloud Vertex AI, Microsoft Foundry). For Team and Enterprise organizations, channels must be explicitly enabled by organization policy.
- **Required Flags**: Claude Code **strictly requires** explicit opt-in at startup:
  - Production/plugin syntax: `claude --channels plugin:<plugin-name>` or `claude --channels server:<server-name>`
  - Development syntax: `claude --dangerously-load-development-channels server:<name>`
- **Behavior Without Flags**: **Does not work**. The official documentation explicitly confirms: *"If the session hasn’t loaded your server as a channel, or the organization policy blocks it, Claude Code drops the events silently and returns no error to your server."*
- **URL & Access Date**:
  - `https://code.claude.com/docs/en/channels` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/channels-reference` (Accessed: 2026-10-30)

### 1.2 MCP Tool Timeout (`MCP_TOOL_TIMEOUT`) Default
- **Default Value**: `100000000` ms (100 million milliseconds, approximately **27.78 hours** / ~28 hours).
- **Idle Timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`)**: While `MCP_TOOL_TIMEOUT` is the outer wall-clock ceiling, Claude Code enforces an idle timeout if the server sends neither a response nor an MCP progress notification. The default idle timeout is:
  - **1,800,000 ms (30 minutes)** for stdio servers.
  - **300,000 ms (5 minutes)** for network (HTTP/SSE) servers.
- **Server Startup Timeout (`MCP_TIMEOUT`)**: Default is **30,000 ms (30 seconds)**.
- **Per-Server Override**: A per-server `timeout` field (in milliseconds, minimum 1000) can be configured under the server's entry in `.mcp.json`.
- **URL & Access Date**:
  - `https://code.claude.com/docs/en/env-vars` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/mcp` (Accessed: 2026-10-30)

### 1.3 MCP Server `instructions` Field
- **Protocol Definition**: The standard MCP `initialize` response permits an `instructions?: string` field.
- **Surfacing to the Model**: Claude Code delivers the `instructions` string to Claude as context when the server connects at session start. It is surfaced as an MCP instructions block (usage notes that connected servers supply). In context token reporting (`getContextUsage`), it is tracked under `mcp_instructions`.
- **Role in Channels**: For channel servers, `instructions` is the primary documented mechanism to inform Claude what events to expect, how to interpret attributes on the `<channel>` tag, and which tool to invoke to reply.
- **URL & Access Date**:
  - `https://code.claude.com/docs/en/agent-sdk/typescript` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/channels-reference` (Accessed: 2026-10-30)

### 1.4 Hooks That Could Inject Messages (`Stop`, `UserPromptSubmit`)
- **`UserPromptSubmit` Hook**:
  - *Trigger*: Fires when a prompt is submitted by the user, before Claude processes it.
  - *Context Injection*: Can inject context by returning `hookSpecificOutput.additionalContext` (or outputting plain text to stdout).
  - *Limitation*: Cannot replace the user prompt, and cannot wake or inject into an idle session—it only fires when a human (or automated prompt) submits input.
- **`Stop` Hook**:
  - *Trigger*: Fires at the end of a turn when Claude finishes responding.
  - *Decision Control*: Can prevent Claude from stopping by returning a top-level `decision: "block"` with a `reason` and/or `hookSpecificOutput.additionalContext`, forcing Claude to continue processing.
  - *Limitation*: Only fires synchronously at the boundary where Claude finishes its current turn. Once Claude stops and waits for user input, the hook has exited and cannot be triggered asynchronously by an external application like UniView.
- **URL & Access Date**:
  - `https://code.claude.com/docs/en/hooks` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/hooks-guide` (Accessed: 2026-10-30)

### 1.5 `claude mcp add --scope user` on Windows with `.cmd` Launchers
- **Configuration Destination**: User scope writes to `%USERPROFILE%\.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`).
- **Windows `.cmd` Launcher Issue**:
  1. *Process Spawning*: On native Windows, Node.js `child_process.spawn()` cannot directly execute batch scripts (`.cmd` or `.bat`) without `shell: true` or a `cmd.exe /c` wrapper.
  2. *CLI Path Mangling Bug*: When users configure a server via `claude mcp add --scope user <name> -- cmd /c <command>`, the CLI command parser (and MSYS path conversion) corrupts `/c`, expanding it to `C:/` (Windows drive path) or `/schedule`.
  3. *Result*: The saved configuration contains `args: ["C:/", ...]` or fails to spawn, producing `Status: ✗ Failed to connect` / `Connection closed`.
  4. *Workaround*: Users must either configure a direct native `.exe` binary, or bypass the CLI command and manually correct `~/.claude.json` to have `command: "cmd"` and `args: ["/c", ...]`.
- **URL & Access Date**:
  - `https://github.com/anthropics/claude-code/issues/25111` (Accessed: 2026-10-30)
  - `https://github.com/anthropics/claude-code/issues/36808` (Accessed: 2026-10-30)
  - `https://github.com/anthropics/claude-code/issues/4158` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/mcp` (Accessed: 2026-10-30)

---

## 2. Codex CLI

### 2.1 `config.toml` `mcp_servers` Keys
Codex defines MCP servers in TOML format under `[mcp_servers.<name>]` in `~/.codex/config.toml` (or project `.codex/config.toml`). Supported keys (validated against `codex-rs/config/src/mcp_types.rs`):

- **Stdio Transport Keys**:
  - `command` (`string`): Executable binary or command path.
  - `args` (`list of strings`): Command-line arguments.
  - `env` (`table of string = string`): Environment variables.
  - `env_vars` (`list of objects/strings`): Environment variable definitions with validation.
  - `cwd` (`string`): Working directory for the stdio process.
- **Streamable HTTP Transport Keys**:
  - `url` (`string`): Endpoint URL.
  - `bearer_token_env_var` (`string`): Name of env var holding bearer token.
  - `http_headers` (`table of string = string`): Static HTTP headers.
  - `env_http_headers` (`table of string = string`): HTTP headers read from env vars.
  - `http_headers_helper` (`string`): Local helper command that outputs JSON headers map.
- **Common & Control Keys**:
  - `enabled` (`boolean`, default: `true`): Toggles the server.
  - `required` (`boolean`, default: `false`): Aborts startup if the server fails to connect.
  - `startup_timeout_sec` (`number`, default: `10.0`) / `startup_timeout_ms` (`integer` alias): Time allowed for server handshake.
  - `tool_timeout_sec` (`number`, default: `60.0`): Timeout for individual tool execution.
  - `enabled_tools` (`list of strings`): Allowlist of tools.
  - `disabled_tools` (`list of strings`): Denylist of tools (evaluated after allowlist).
  - `default_tools_approval_mode` (`string`): `"auto"`, `"prompt"`, `"writes"`, `"approve"`.
  - `tools` (`table`): Per-tool configurations (`approval_mode`, `output_token_limit`).
  - `supports_parallel_tool_calls` (`boolean`): Allows concurrent tool invocations.
  - `startup_readiness` (`string`): `"connection"` or `"catalog"`.
  - `tool_input_schema_max_bytes` (`integer`, default: `5000`): Threshold for compacting input schemas.
  - `environment_id` (`string`, default: `"local"`): Execution environment ID.
  - `auth` (`string`): `"oauth"` or `"chatgpt"`.
  - `scopes` (`list of strings`): OAuth scopes.
  - `oauth` (`table`): OAuth configuration (`client_id`, `client_secret`, `callback_url`, `callback_port`).
  - `oauth_resource` (`string`): RFC 8707 OAuth resource parameter.
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/extend/mcp` (Accessed: 2026-10-30)
  - `https://learn.chatgpt.com/docs/config-file/config-reference` (Accessed: 2026-10-30)
  - `https://learn.chatgpt.com/docs/config-file/config-sample` (Accessed: 2026-10-30)
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/mcp_types.rs` (Accessed: 2026-10-30)

### 2.2 `tool_timeout_sec` Default and Max
- **Default**: `60` seconds (60.0s).
- **Maximum Ceiling**: **Unbounded / No maximum limit enforced by Codex CLI**. In Codex CLI source code (`codex-rs/config/src/mcp_types.rs`), `tool_timeout_sec` is parsed into a standard Rust `Option<Duration>` from `f64` without any `schemars` range validation or hard upper cap. Any positive duration is accepted.
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/extend/mcp` (Accessed: 2026-10-30)
  - `https://learn.chatgpt.com/docs/config-file/config-reference` (Accessed: 2026-10-30)
  - `https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs` (Accessed: 2026-10-30)

### 2.3 Whether Codex Honours MCP Server `instructions`
- **Confirmation**: **Yes, fully honoured**.
- **Official Documentation**: *"Server instructions: Codex reads the MCP instructions field returned during initialization and uses it as server-wide guidance alongside the server’s tools. If you build or maintain an MCP server for Codex, use instructions for cross-tool workflows, constraints, and rate limits that apply across the server. Keep the first 512 characters self-contained so the most important guidance is available when Codex is deciding how to use the server."*
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/extend/mcp` (Accessed: 2026-10-30)

### 2.4 Notification / Injection Mechanism in Codex CLI
- **In-Protocol Push**: **None**. Codex adheres strictly to standard MCP and does not implement proprietary server-to-client message notifications like `notifications/claude/channel`. Compliant servers may send `notifications/tools/list_changed` or `notifications/progress` (which Codex handles/logs), but MCP notifications cannot inject prompt turns into the model context.
- **Out-of-Band CLI Message Injection (`codex queue`)**:
  - Codex CLI includes a dedicated command:
    ```bash
    codex queue --thread <THREAD_UUID_OR_NAME> --message "<TEXT>"
    ```
  - This dispatches through the local `codex app-server` daemon (`thread/queue/add` API).
  - It wakes an idle or running session and delivers the message with `role: "user"`.
  - UniView can invoke `codex queue` externally to inject user change requests directly into the running Codex session.
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/cli/reference` (Accessed: 2026-10-30)
  - `https://github.com/openai/codex/issues/54991` (Accessed: 2026-10-30)
  - `https://github.com/openai/codex/commit/83d0153` (Accessed: 2026-10-30)

### 2.5 AGENTS.md Global Location
- **Location**: `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md` if `CODEX_HOME` is defined).
- **Windows Resolution**: `%USERPROFILE%\.codex\AGENTS.md`.
- **Global Override**: `~/.codex/AGENTS.override.md` replaces `AGENTS.md` at the global level if present.
- **Hierarchy**: Codex layers instructions: Global (`~/.codex/AGENTS.md`) → Project root (`<repo>/AGENTS.md`) → Subdirectories down to CWD.
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/agent-configuration/agents-md.md` (Accessed: 2026-10-30)
  - `https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex` (Accessed: 2026-10-30)

### 2.6 `codex mcp add`
- **Syntax**:
  ```bash
  codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
  ```
- **Configuration Destination**: Always writes directly to global user config at `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Unlike Claude Code, it has no `--scope` flag (`local`/`project`/`user`).
- **Flags**: Supports `--env KEY=VALUE` for stdio servers, `--url` for streamable HTTP, and OAuth options (`--oauth-client-id`, `--oauth-client-secret`, `--oauth-client-registration`, `--oauth-resource`).
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/extend/mcp` (Accessed: 2026-10-30)
  - `https://learn.chatgpt.com/docs/cli/reference` (Accessed: 2026-10-30)

---

## 3. Resuming or Sending to a Running Session

### 3.1 Claude Code: `claude --resume` / `-p`
- **Behavior While Interactive Session Is Open**:
  - Attempting to resume a session while it is currently open in an interactive terminal or live background process is **actively refused** by Claude Code.
  - Claude Code reports:
    - `Can't open — this session is running in another terminal`
    - `This conversation is already open in another running Claude session — use that one, or close it and try again`
- **Safety**: **Unsafe and blocked**. Claude Code enforces exclusive single-process access to the session transcript to prevent data corruption, split-brain turns, or orphaned tool states.
- **URL & Access Date**:
  - `https://code.claude.com/docs/en/errors` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/sessions` (Accessed: 2026-10-30)

### 3.2 Codex CLI: `codex exec resume`
- **Behavior While Interactive Session Is Open**:
  - While an interactive Codex session (TUI, Desktop, or IDE extension) is open, the process holds a live OS-level single-writer lock on `%USERPROFILE%\.codex\thread-writer-locks\<thread-id>.lock`.
  - Running `codex exec resume <thread-id> "<prompt>"` from another process fails immediately with:
    `thread/resume failed: thread <id> already has an active writer (code -32600)` or
    `thread-store conflict: thread <id> already has an active writer`
- **Safety**: **Unsafe and blocked**. Concurrent writers to the same thread rollout store are strictly prohibited.
- **Safe Alternative in Codex**: As documented in Section 2.4, the supported method to send messages to an active/idle session without acquiring writer locks is `codex queue --thread <thread-id> --message "<text>"`.
- **URL & Access Date**:
  - `https://github.com/openai/codex/issues/45406` (Accessed: 2026-10-30)
  - `https://github.com/openai/codex/issues/37403` (Accessed: 2026-10-30)
  - `https://learn.chatgpt.com/docs/developer-commands` (Accessed: 2026-10-30)

---

## 4. MCP Elicitation Support (`elicitation/create`)

MCP Elicitation is a standard client capability allowing an MCP server to request user input mid-task or mid-tool-call.

### 4.1 Claude Code Elicitation Support
- **Support**: **Fully supported** in interactive terminal sessions.
- **Capability Declaration**: Claude Code declares `elicitation: {form: {}, url: {}}` on connections using protocol revision 2026-07-28, and `elicitation: {}` (form mode only) on earlier revisions.
- **Interactive Behavior**: When an MCP server sends `elicitation/create`, Claude Code displays an interactive dialog modal directly in the terminal TUI and passes the user's input back to the server.
- **Hooks**: Can be inspected or intercepted programmatically via `Elicitation` and `ElicitationResult` hooks.
- **Non-Interactive Mode (`-p`)**: Automatically canceled by Claude Code.
- **Blocks the Agent**: **YES**. Elicitation occurs during an active tool call or server task; the agent loop is blocked waiting for the user to complete the dialog before the tool returns.
- **URL & Access Date**:
  - `https://code.claude.com/docs/en/mcp` (Accessed: 2026-10-30)
  - `https://code.claude.com/docs/en/hooks` (Accessed: 2026-10-30)

### 4.2 Codex CLI Elicitation Support
- **Support**: **Fully supported** in the client engine (`codex-rs/rmcp-client/src/elicitation_client_service.rs` and `codex-rs/codex-mcp`).
- **Modes Supported**: Supports standard MCP `elicitation/create` (both form and URL modes) and OpenAI extension `openai/elicitation/create` (user verification).
- **Approval Policy Gating**: Configured via `approval_policy.granular.mcp_elicitations` in `config.toml`. Under the default policy (`on-request`), elicitations surface to the user. If set to `never` or `mcp_elicitations = false`, elicitations are auto-canceled/rejected.
- **Blocks the Agent**: **YES**. The client enters `ElicitationPauseState`, pausing the execution turn until the user accepts, declines, or cancels the request.
- **URL & Access Date**:
  - `https://learn.chatgpt.com/docs/config-file/config-reference` (Accessed: 2026-10-30)
  - `https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/elicitation_client_service.rs` (Accessed: 2026-10-30)
  - `https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/connection_manager_tests.rs` (Accessed: 2026-10-30)

---

## 5. Architectural Evaluation & Mechanism Comparison Table

For UniView on Windows, there are four potential architectural avenues to deliver user change requests:
1. **Claude Channels** (`notifications/claude/channel`): Best fit for Claude Code, but client-specific and requires user startup flags (`--channels`).
2. **Codex Queue** (`codex queue --thread <id> --message <text>`): Best fit for Codex CLI, cleanly dispatches to running session via app-server daemon.
3. **MCP Elicitation** (`elicitation/create`): Universal protocol mechanism supported by both clients; ideal if UniView change requests occur while the agent actively requests feedback, but blocks the agent while the document is being reviewed.
4. **Synchronous Long-Polling Tool Call**: The agent calls `open_and_wait_for_user_feedback()`. Supported by both, but ties up the agent tool execution until the user finishes typing (or hits tool timeouts).

### Summary Table

| Mechanism | Claude Code | Codex | Needs flag | Blocks the agent |
| :--- | :--- | :--- | :--- | :--- |
| **Server-to-client push (`notifications/claude/channel`)** | Supported (Research Preview) | Not supported | **Yes** (`--channels` or `--dangerously-load-development-channels`) | **No** (asynchronous push into conversation context) |
| **CLI message queue (`codex queue`)** | Not supported | Supported | **No** (built-in CLI command) | **No** (queues asynchronously into session via daemon) |
| **MCP Elicitation (`elicitation/create`)** | Supported (interactive TUI) | Supported (interactive TUI/app-server) | **No** (enabled by default in interactive sessions) | **Yes** (agent pauses and waits for user form submission) |
| **Synchronous long-polling tool call** | Supported (within `MCP_TOOL_TIMEOUT` & 30m idle limit) | Supported (within `tool_timeout_sec`, default 60s) | **No** (may require raising timeout in config if long wait) | **Yes** (agent tool call remains open and execution blocked) |
| **Concurrent resume (`claude --resume -p` / `codex exec resume`)** | **Blocked** (multi-instance check fails) | **Blocked** (single-writer lock conflict fails) | N/A (cannot be used concurrently while session is open) | N/A (fails with exit error; does not deliver text) |
| **Turn Hooks (`Stop`, `UserPromptSubmit`)** | Supported (context injection) | Supported (context injection) | **No** (requires hook registration in config) | **Yes / Turn-bound** (cannot trigger while session is idle) |

---
*Report verified against official Claude Code docs (`code.claude.com`), Anthropic GitHub releases/issues (`anthropics/claude-code`), OpenAI ChatGPT/Codex documentation (`learn.chatgpt.com`), and OpenAI Codex open-source codebase (`openai/codex`). All claims accurate as of October 30, 2026.*
