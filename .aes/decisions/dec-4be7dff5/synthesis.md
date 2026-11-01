[2m│[0m [1msynthesis.md[0m
[2m│[0m [38;2;139;134;130m@@ -0,0 +1,88 @@[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+MEMORANDUM[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+TO:       Chief Executive Officer[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+FROM:     Architecture Review Team (AES)[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+DATE:     October 30, 2026[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+SUBJECT:  UniView MCP Reply Channel & Agent Session Architecture (TYPE 1 Gate: dec-4be7dff5)[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+CONTEXT[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+UniView is a free, local Windows document viewer with a stdio MCP server (tools: open_files, show_view, request_review, get_review) communicating over a local named pipe. The CTO's product mandate requires that when a user works in Claude Code or Codex CLI, documents open inside UniView instead of native agent side windows, and user change requests typed inside UniView route directly back to that same active agent session for editing and refresh.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Constraints: Zero extra terminal flags, zero paid external services, simple UI.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Key technical facts from .aes/research/mcp-reply-channel.md:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  1. Claude Channels require startup flag --channels; without it, notifications are silently dropped.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  2. Codex CLI has 'codex queue --thread <id> --message <text>' without flags via app-server daemon.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  3. Concurrent session resumption (claude --resume -p / codex exec resume) is actively blocked in both by process and single-writer locks.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  4. MCP Elicitation (elicitation/create) blocks the agent and prompts in the CLI terminal, not in UniView.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  5. Long-polling tools work in both: Claude enforces a 30-minute stdio idle timeout (resets on progress notifications); Codex defaults tool_timeout_sec to 60s (unbounded, settable in config.toml).[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  6. Both clients honor the MCP server instructions field at initialization.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+RECOMMENDED PATH: OPTION A (UNIVERSAL LONG-POLL WITH DURABLE INBOX BUFFER)[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Ship Option A for V1: a unified long-polling tool (open_document / wait_for_user_message) backed by a local durable inbox buffer. Defer client-specific optimizations (such as codex queue) to v1.1.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Key Justifications:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  - Single IPC Model: Enforces one unified, testable integration across Claude Code and Codex CLI rather than multiplying testing surface and protocol edge cases.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  - Zero-Flag Compliance: Operates out of the box in standard interactive CLI sessions without requiring user-supplied flags like --channels.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  - Active Session Steering: Unlike turn hooks (Option B) or detached sidecars (Option D), holding the turn allows immediate agent reaction when the user submits an edit from UniView.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  - Fallback Resiliency: Backing the long-poll with a durable inbox ensures that if the agent exits the poll loop prematurely, user edits are never lost and can be delivered on the next agent turn.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Required Implementation Guardrails:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  1. Keep-Alive Heartbeats: UniView stdio MCP server must emit periodic JSON-RPC progress notifications during wait_for_user_message to prevent Claude's 30-minute idle disconnect.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  2. Installer Configuration: The UniView Windows installer must automatically update ~/.codex/config.toml to raise tool_timeout_sec (e.g., 1800s) and set tool approval to auto for UniView tools to prevent repetitive terminal permission prompts.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  3. Direct Binary Execution: Configure the MCP server command in ~/.claude.json using a direct native executable binary (.exe) to avoid Windows cmd.exe /c argument mangling bugs.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+STANCE MATRIX BY PERSPECTIVE[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Perspective | Round 1 Stance | Round 2 Stance | Recommended V1 | Core Focus & Argument[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+------------+----------------+----------------+----------------+-------------------------------------------------------------[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+A           | CONCERNS (A)   | CONCERNS (C)   | Option C       | Favors hybrid: codex queue for Codex (zero-flag, non-blocking) + Option A for Claude. Considers long-poll on Codex a brittle hack.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+B           | APPROVE (A)    | CONCERNS (A)   | Option A       | Recommends Option A + durable inbox. Rejects C for v1 to avoid duplicate delivery paths and thread-ID tracking. Gate on real tests.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+C           | CONCERNS (C)   | CONCERNS (A)   | Option A       | Switched to Option A in R2. Argues codex queue only enqueues subsequent turns, tripling test overhead without solving Claude fallback.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Consensus: Majority recommendation (2 of 3 evaluators: B, C) for Option A backed by a durable inbox. Overall panel verdict is CONCERNS due to inherent model loop dependencies and terminal lockup.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+STRONGEST DISSENT (STEELMAN OF PERSPECTIVE A / OPTION C)[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+The strongest objection is that Option A forces an artificial, synchronous busy-wait onto an ecosystem that already provides native asynchronous queuing in Codex. [0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Steelman:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Codex CLI already provides a robust, zero-flag asynchronous CLI queue (codex queue --thread <id> --message <text>) backed by its local background daemon. Forcing Codex into Option A's long-poll busy-loop freezes the user's terminal prompt, creates terminal deadlock, and depends on an external installer successfully mutating ~/.codex/config.toml's tool_timeout_sec. If that configuration write fails or is overwritten, Codex sessions will reliably abort every 60 seconds with timeout errors. Forcing both clients into the lowest common denominator when half the market already supports clean asynchronous queuing introduces artificial fragility and ruins terminal responsiveness.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Rebuttal:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+Codex still requires an active loop or follow-up prompt to trigger edits; codex queue only appends to the queue for subsequent turns and cannot steer an in-flight tool turn. Furthermore, because Claude Code strictly requires Option A regardless, building Option C in V1 means building, maintaining, and testing two completely different asynchronous IPC paths (named pipe poll + daemon CLI invocation) along with thread-ID discovery and out-of-order race resolution. Option A delivers a single hardened path for V1; codex queue remains the prioritized upgrade for v1.1 once baseline loop stability is validated.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+STEERING AND HONEST LIMITATIONS[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+1. How the Agent is Made to Prefer UniView:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+   - MCP Server Instructions: Exploit the MCP instructions field delivered during initialize (honored by both Claude Code and Codex) with strict directives: route all document previews, visual diffs, and review requests through UniView (open_files / show_view) rather than CLI text dumps or native visualizers.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+   - Tool Docstrings: Craft explicit when-to-use semantic descriptions on open_files and wait_for_user_message detailing that user review must occur inside the viewer.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+   - Project Directives: Provide optional, user-consented global instructions in ~/.codex/AGENTS.md and ~/.claude.json / CLAUDE.md.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+2. What Cannot Be Forced:[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+   - Deterministic Tool Selection: Prompt steering is advisory. We cannot hard-disable the host client's native sidecar windows, block built-in tools, or prevent the model from using cat, head, or terminal diffs.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+   - Guaranteed Loop Continuation: We cannot force the LLM to call wait_for_user_message on every turn. If the model summarizes and halts, the polling cycle breaks.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+   - Terminal Concurrency: Because neither client allows concurrent resume, the terminal CLI is locked while UniView holds the tool call. Concurrent bidirectional typing in both terminal and UniView is impossible without native channel support.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+BLOCKERS & CRITICAL FLAGS[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+- HARD BLOCK: Claude Code Native Channels (--channels):[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+  Cannot be used in default V1. Claude Code silently drops all channel notifications unless started with the explicit --channels flag.[0m
[2m│[0m [38;2;255;255;255;48;2;19;87;20m+- HARD BLOCK: Concurrent Session Resume:[0m
[2m│[0m [38;2;139;134;130m… omitted 10 diff line(s) across 1 additional file(s)/section(s)[0m
MEMORANDUM

TO:       Chief Executive Officer
FROM:     Architecture Review Team (AES)
DATE:     October 30, 2026
SUBJECT:  UniView MCP Reply Channel & Agent Session Architecture (TYPE 1 Gate: dec-4be7dff5)


CONTEXT

UniView is a free, local Windows document viewer with a stdio MCP server (tools: open_files, show_view, request_review, get_review) communicating over a local named pipe. The CTO's product mandate requires that when a user works in Claude Code or Codex CLI, documents open inside UniView instead of native agent side windows, and user change requests typed inside UniView route directly back to that same active agent session for editing and refresh.

Constraints: Zero extra terminal flags, zero paid external services, simple UI.
Key technical facts from .aes/research/mcp-reply-channel.md:
  1. Claude Channels require the startup flag --channels; without it, notifications are silently dropped.
  2. Codex CLI has 'codex queue --thread <id> --message <text>' without flags via app-server daemon.
  3. Concurrent session resumption (claude --resume -p / codex exec resume) is actively blocked in both by process and single-writer locks.
  4. MCP Elicitation (elicitation/create) blocks the agent and prompts in the CLI terminal, not in UniView.
  5. Long-polling tools work in both: Claude enforces a 30-minute stdio idle timeout (resets on progress notifications); Codex defaults tool_timeout_sec to 60s (unbounded, settable in config.toml).
  6. Both clients honor the MCP server instructions field at initialization.


RECOMMENDED PATH: OPTION A (UNIVERSAL LONG-POLL WITH DURABLE INBOX BUFFER)

Ship Option A for V1: a unified long-polling tool (open_document / wait_for_user_message) backed by a local durable inbox buffer. Defer client-specific optimizations (such as codex queue) to v1.1.

Key Justifications:
  - Single IPC Model: Enforces one unified, testable integration across Claude Code and Codex CLI rather than multiplying testing surface and protocol edge cases.
  - Zero-Flag Compliance: Operates out of the box in standard interactive CLI sessions without requiring user-supplied flags like --channels.
  - Active Session Steering: Unlike turn hooks (Option B) or detached sidecars (Option D), holding the turn allows immediate agent reaction when the user submits an edit from UniView.
  - Fallback Resiliency: Backing the long-poll with a durable inbox ensures that if the agent exits the poll loop prematurely, user edits are never lost and can be delivered on the next agent turn.

Required Implementation Guardrails:
  1. Keep-Alive Heartbeats: UniView stdio MCP server must emit periodic JSON-RPC progress notifications during wait_for_user_message to prevent Claude's 30-minute idle disconnect.
  2. Installer Configuration: The UniView Windows installer must automatically update ~/.codex/config.toml to raise tool_timeout_sec (e.g., 1800s) and set tool approval to auto for UniView tools to prevent repetitive terminal permission prompts.
  3. Direct Binary Execution: Configure the MCP server command in ~/.claude.json using a direct native executable binary (.exe) to avoid Windows cmd.exe /c argument mangling bugs.


STANCE MATRIX BY PERSPECTIVE

Perspective | Round 1 Stance | Round 2 Stance | Recommended V1 | Core Focus & Argument
------------+----------------+----------------+----------------+-------------------------------------------------------------
A           | CONCERNS (A)   | CONCERNS (C)   | Option C       | Favors hybrid: codex queue for Codex (zero-flag, non-blocking) + Option A for Claude. Considers long-poll on Codex a brittle hack.
B           | APPROVE (A)    | CONCERNS (A)   | Option A       | Recommends Option A + durable inbox. Rejects C for v1 to avoid duplicate delivery paths and thread-ID tracking. Gate on real tests.
C           | CONCERNS (C)   | CONCERNS (A)   | Option A       | Switched to Option A in R2. Argues codex queue only enqueues subsequent turns, tripling test overhead without solving Claude fallback.

Consensus: Majority recommendation (2 of 3 evaluators: B, C) for Option A backed by a durable inbox. Overall panel verdict is CONCERNS due to inherent model loop dependencies and terminal lockup.


STRONGEST DISSENT (STEELMAN OF PERSPECTIVE A / OPTION C)

The strongest objection is that Option A forces an artificial, synchronous busy-wait onto an ecosystem that already provides native asynchronous queuing in Codex. 

Steelman:
Codex CLI already provides a robust, zero-flag asynchronous CLI queue (codex queue --thread <id> --message <text>) backed by its local background daemon. Forcing Codex into Option A's long-poll busy-loop freezes the user's terminal prompt, creates terminal deadlock, and depends on an external installer successfully mutating ~/.codex/config.toml's tool_timeout_sec. If that configuration write fails or is overwritten, Codex sessions will reliably abort every 60 seconds with timeout errors. Forcing both clients into the lowest common denominator when half the market already supports clean asynchronous queuing introduces artificial fragility and ruins terminal responsiveness.

Rebuttal:
Codex still requires an active loop or follow-up prompt to trigger edits; codex queue only appends to the queue for subsequent turns and cannot steer an in-flight tool turn. Furthermore, because Claude Code strictly requires Option A regardless, building Option C in V1 means building, maintaining, and testing two completely different asynchronous IPC paths (named pipe poll + daemon CLI invocation) along with thread-ID discovery and out-of-order race resolution. Option A delivers a single hardened path for V1; codex queue remains the prioritized upgrade for v1.1 once baseline loop stability is validated.


STEERING AND HONEST LIMITATIONS

1. How the Agent is Made to Prefer UniView:
   - MCP Server Instructions: Exploit the MCP instructions field delivered during initialize (honored by both Claude Code and Codex) with strict directives: route all document previews, visual diffs, and review requests through UniView (open_files / show_view) rather than CLI text dumps or native visualizers.
   - Tool Docstrings: Craft explicit when-to-use semantic descriptions on open_files and wait_for_user_message detailing that user review must occur inside the viewer.
   - Project Directives: Provide optional, user-consented global instructions in ~/.codex/AGENTS.md and ~/.claude.json / CLAUDE.md.

2. What Cannot Be Forced:
   - Deterministic Tool Selection: Prompt steering is advisory. We cannot hard-disable the host client's native sidecar windows, block built-in tools, or prevent the model from using cat, head, or terminal diffs.
   - Guaranteed Loop Continuation: We cannot force the LLM to call wait_for_user_message on every turn. If the model summarizes and halts, the polling cycle breaks.
   - Terminal Concurrency: Because neither client allows concurrent resume, the terminal CLI is locked while UniView holds the tool call. Concurrent bidirectional typing in both terminal and UniView is impossible without native channel support.


BLOCKERS & CRITICAL FLAGS

- HARD BLOCK: Claude Code Native Channels (--channels):
  Cannot be used in default V1. Claude Code silently drops all channel notifications unless started with the explicit --channels flag.
- HARD BLOCK: Concurrent Session Resume:
  Attempting out-of-band execution via claude --resume -p or codex exec resume while an interactive session is open fails immediately due to OS thread-writer and process locks.
- CRITICAL UI REQUIREMENT: Transparent Session State:
  Because the terminal is frozen during long-polling, UniView's UI must clearly display true status ("Agent listening" vs "Agent idle / Changes queued in inbox") and inform users that pressing Esc or Ctrl+C in the terminal aborts the wait safely.


DECISION NEEDED FROM CEO

1. Approve Option A (Universal Long-Poll with Durable Inbox) as the V1 delivery architecture for Claude Code and Codex CLI, scheduling Option C (codex queue) as a fast-follow in v1.1.
2. Authorize the UniView Windows installer to automatically configure Codex tool_timeout_sec = 1800 and set UniView tools to auto-approve in ~/.codex/config.toml.
3. Authorize the release evaluation gate: V1 cannot ship until multi-turn loop persistence and terminal recovery (Esc/Ctrl+C) are empirically validated across 20+ live sessions in both Claude Code and Codex.
