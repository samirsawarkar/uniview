# Phase 1: agent review workspace and declarative view specs (plan v5)

CEO decision 2026-10-24 (chat, after AES brainstorm dec-f2c5fe7a): build the panel's Phase 1 — agents connect over MCP or a command line, open files, show views they describe as data, and ask for a review; the person approves or requests changes and the agent gets the answer. No third-party code runs in UniView.

Owner: CTO (Claude). Code: agy. Review: Codex (every packet; security focus on P15–P17). QA: OpenHands. Status: plan v4 after Codex's third review (v1: ten findings; v2 fixed three; v3 fixed three more; v4 closed four; v5 fixes two remaining contradictions: one MCP line limit, per-revision error envelopes). Not started.

## Goals

1. **View specs** (`*.uview.json`): structured views (headings, Markdown, tables, key-value, trees, code, diffs, images, charts, callouts) rendered by UniView's own components on desktop, phone and web.
2. **Review receipts** (`*.receipt.json`): what an agent did, the files with SHA-256, checks, sources. UniView verifies the files, and on desktop offers **Approve** / **Request changes** with a comment.
3. **Command line**: `UniView open … [--receipt r] [--view v] [--wait]`.
4. **MCP**: agents run `UniView --mcp` (stdio) and get show-only tools plus `request_review`.

## Non-goals

No code plugins or marketplace; no agent access to file contents, folder listings or LAN-paired computers; no MCP or review decisions on the phone (the phone shows and verifies specs and receipts); no Windows file association for `.uview.json` / `.receipt.json` (they open through the CLI, MCP, drag and drop, or the Open dialog; generic `.json` stays as it is).

## Trust model (normative)

- **Boundary = the OS user.** Agents run as the same user and can already read the user's files; UniView cannot tell same-user processes apart. Agent approval is consent and an audit trail, not isolation from same-user malware. Every agent-supplied name is an untrusted display label, shown as "says it is ‹name›".
- **What agents can do:** show files they name, show views, ask for reviews, read *their own* review decisions. They cannot read contents, list folders, reach paired computers, or see other agents' reviews.
- **What the decision returns:** the decision, comment, the receipt digest, and per receipt file `unchanged | changed | missing | unreadable`. Hash equality for files the agent named gives a same-user agent nothing it could not compute itself.
- **Agent text is never trusted UI.** Specs, receipts and names render inside a clearly framed "content from the agent" area; UniView's own verification results and the Approve / Request changes controls live in a fixed app bar outside it. No content can trigger a decision; approval needs a real click (no keyboard default, a 500 ms arming delay after the review appears or changes).

## Interfaces

### Local bridge (P15) — one channel for CLI and MCP

- **Endpoint (rendezvous only):** Windows named pipe `\\.\pipe\uniview-bridge-<sha256(user SID + install id)[0..16]>`; macOS/Linux Unix socket `<userData>/bridge/b.sock` (directory created 0700 and checked to be owned by the user and not group/world-writable before use; path length checked; a stale socket is removed only after a failed connect and an ownership check).
- **Authentication (mutual, before any request):** a 256-bit key in `<userData>/bridge/key` (created atomically; on Windows inside the per-user profile, with an explicit owner-only ACL set via `icacls` at creation; on Unix mode 0600, ownership checked on every start). **Only the GUI process that owns the bridge** creates or rotates the key, after acquiring the single-instance lock and before listening; CLI and MCP clients only read it. Handshake: client sends `{hello, clientNonce}`; server answers `{serverNonce, serverProof = HMAC(key, "srv"|clientNonce|serverNonce)}`; the client verifies the server **before** proving itself with `clientProof = HMAC(key, "cli"|serverNonce|clientNonce)`. A squatter running as a different user cannot obtain a proof or impersonate the app to a client; a same-user squatter is inside the stated trust boundary (it could read the key anyway). 5 s handshake deadline; failures close the connection and are logged (rate-limited). The Windows pipe is created with `PIPE_REJECT_REMOTE_CLIENTS` if available through Node; otherwise remote clients still fail authentication.
- **Framing:** each frame = 4-byte big-endian header length + UTF-8 JSON header (≤ 64 KiB) + 4-byte body length + raw body bytes (≤ 2 MiB). Inline specs and receipts travel as the **raw body bytes** (never as an escaped JSON string), so the 2 MiB document limit and the frame limit are the same number; both lengths are checked before reading or parsing. Request ids; at most 16 in-flight requests per connection, at most 8 connections; excess → `busy` error.
- **Session:** each authenticated connection gets an app-owned `sessionId`. MCP sessions carry a `client` (self-reported name/version) and, once approved "always", an enrolled `clientKey` (see P17). Closing the connection cancels that session's pending waits (reviews stay open for the person).

### Path policy (P15, `electron/lib/agent-paths.mjs`, main process only)

All agent- and CLI-supplied paths (files, `--receipt`, `--view`, `receipt.files[].path`, spec `image.path`, `fileRef.path`, `receipt.view`) go through one function:
1. string ≤ 4096 chars, no NUL/control chars; CLI relative paths are resolved against the CLI's cwd **in the CLI process**; the bridge accepts only absolute paths;
2. reject before touching the filesystem: UNC (`\\server\…`), `\\?\` and `\\.\` prefixes, device names (`CON`, `NUL`, `COM1`…), alternate data streams (`:` after the drive), and on Unix `/dev`, `/proc`, `/sys`;
3. **Open first, then decide on the opened handle** (amended 2026-10-24 after two Codex security reviews: re-checking a *name* after `open` is a race, so names are only a first line). `open(path)` (POSIX: `O_RDONLY|O_NONBLOCK|O_NOCTTY`, so a FIFO or tty cannot block); `realpath.native(path)` and rule 2 on the canonical path as a first line (Windows also classifies the input and canonical drive letters). The decision uses `fstat(handle)`: a regular file; POSIX — its device is not that of `/proc`, `/sys` or `/dev`, and not a network mount (Linux: devices taken directly from `/proc/self/mountinfo` major:minor, no `stat`; other POSIX: `mount` + `stat` of each network mount point, and if any cannot be identified every file is rejected until the next refresh); Windows — its device (volume serial) must be one of the local fixed/removable volumes (`Win32_LogicalDisk` DriveType 2/3, each volume root `stat`ed), cached 60 s, any failure → reject. Input paths with `.` or `..` segments are rejected before I/O. Every call settles within its deadline; handles are closed on every failure path without awaiting. Any error or timeout → reject.
   **Accepted residual risk (CTO, 2026-10-24, Codex review 14):** on Windows, Node exposes no API that reports whether an *opened handle* is remote, and a remote SMB volume can report the same volume serial as a local one (Samba `volume serial number`). A same-user process holding the symbolic-link privilege (administrator or Developer Mode), racing a link between `open` and `realpath`, with an attacker-controlled SMB server forging a local serial, could make UniView *display* a network file it named. This is accepted because the agent is inside the stated trust boundary (same OS user; it could read that share itself), the consequence is display of a file the user can already read, and no privilege is gained. Closing it fully needs a native call (`GetFileInformationByHandleEx(FileRemoteProtocolInfo)`), tracked for a later native-helper packet.
4. the opened handle must be a regular file; size ≤ 4 GiB for viewing.
5. the grant holds that handle. **Every read route uses it**: the `uniview-file:` protocol stream (`electron/main.mjs` today reopens the path), the `file:read` IPC reader, thumbnails, hashing. Agent grants live in a new scoped store (`AgentGrantStore`: grant → {handle, scopeId, size}); `FileSource.release()` for Electron agent sources (today empty in `src/shells/electron.ts`) closes the scope's reference; closing the tab or the review closes the scope and all its handles.

Grants are scoped to a **view scope** (a tab opened by an agent, a view, or a review) with an id; images and `fileRef`s in a view may only use grants created for that view; closing the tab closes the scope and its handles. The existing user-opened grant store is unchanged.

### View spec v1 (P13)

Normative JSON Schema (draft 2020-12) in `shared/schemas/view-1.json` with positive and negative fixtures in `fixtures/viewspec/`; validated with **@hyperjump/json-schema** (scout OK: MIT, no eval) on all platforms; `validateViewSpec(json) → {ok:true, spec} | {ok:false, errors:[{code, path, message}]}` with stable `code`s (`schema`, `too_large`, `invalid_json`, `too_deep`, `too_many_nodes`, `bad_path`, `unsupported_version`). Error `path`s are RFC 6901 JSON Pointers (`~` → `~0`, `/` → `~1`). Every "KiB" limit counts UTF-8 bytes (checked after schema validation); `relPath` values must be relative and contain no `..` segment at all (stricter than root containment; rejected as `bad_path`). Chart points count every supplied value (sum of `series[].values` lengths).

Top level: `{ "uniview": "view/1", "title": string ≤ 200, "agent"?: { "name" ≤ 80, "model"? ≤ 80 }, "body": Node[] }`. Every object has `additionalProperties: false`.

| type | required | optional | rules |
|---|---|---|---|
| `heading` | `text` ≤ 300 | `level` 1–4 (default 2) | |
| `markdown` | `text` ≤ 256 KiB | | restricted Markdown (below) |
| `callout` | `tone` info/success/warning/danger, `text` | `title` ≤ 200 | |
| `keyValue` | `items` 1–500 of `{key ≤ 200, value ≤ 4 KiB}` | | |
| `table` | `columns` 1–50 of `{key, label}` | `align` left/right/center per column, `rows` 0–10 000 | `key` matches `^[A-Za-z0-9_.-]{1,64}$`, unique; cells string ≤ 4 KiB, number, boolean or null; unknown keys rejected |
| `list` | `items` 1–1000 of string or Node | `ordered` | |
| `tree` | `nodes` | | `{label ≤ 300, detail? ≤ 1 KiB, children?}`; ≤ 20 000 entries total |
| `code` | `text` ≤ 512 KiB | `language` (highlight.js id), `highlightLines` [[from,to]] ranges ≥ 1 | |
| `diff` | exactly one of `unified` (≤ 512 KiB) or `before`+`after` (each ≤ 512 KiB) | `language`, `title` | ≤ 20 000 diff lines computed with **jsdiff** (scout OK), in a worker with a 2 s budget; over budget → shown as two plain panes |
| `image` | `path`, `alt` ≤ 300 | `caption` ≤ 300 | path policy; PNG/JPEG/GIF/WebP only; decoded size ≤ 50 MP |
| `chart` | `kind` bar/line, `x` 1–500 strings, `series` 1–10 of `{name, values}` | | every `values` length equals `x` length; finite numbers |
| `section` | `children` | `title`, `collapsed` | |
| `columns` | `columns` 2–3 arrays of Node | | stacks on screens < 720 px |
| `fileRef` | `path` | `label` ≤ 200 | path policy; opens in a new tab |

Budgets: file ≤ 2 MiB; depth ≤ 32; **node count** = every Node + every table cell + every tree entry + every chart point + every list item, ≤ 50 000. `table.rows` is optional (default `[]`). Spec snapshot: the spec bytes are read once when shown; later edits to the file do not change an open view (the tab offers "Reload"). Invalid specs show an error view (first 20 errors with paths and codes) with "Open as JSON".

**Restricted Markdown** (specs and receipts; `src/viewers/agent-markdown.ts`): **markdown-it** (scout OK) with `html: false`, no images (use `image` nodes), links rendered as inert text with the URL shown and a copy button, no autolinks to `file:`/`javascript:`/`data:`; output passes DOMPurify with an allow-list of the produced tags only. Agent names and titles: strip control and bidirectional-override characters, cap length.

**Detection:** compound suffixes `.uview.json` → `viewspec`, `.receipt.json` → `receipt`; other `.json` unchanged.

### Review receipt v1 and reviews (P14)

Schema `shared/schemas/receipt-1.json` (+ fixtures): `{ "uniview": "receipt/1", "createdAt", "agent": {name, model?, run?}, "task" ≤ 2 KiB, "summary" ≤ 256 KiB (restricted Markdown), "files": 1–200 of { "path" (absolute) , "relPath"? (relative to the receipt's folder, for other devices), "sha256" (64 hex), "role": created|modified|input }, "checks": 0–200 of {name, status pass|fail|skip, evidence? ≤ 16 KiB}, "sources": 0–200 of {title, ref ≤ 2 KiB}, "view"? (path) }`. Receipt file ≤ 2 MiB.

- **Review identity (app-owned):** `reviewId` = random 128-bit, created when the receipt is opened; `receiptDigest` = SHA-256 of the receipt's bytes as received. Agent-supplied ids are not used.
- **Snapshot:** the receipt (and its `view`) is read once when the review opens; `receiptDigest` = SHA-256 of those exact bytes (inline receipts arrive as the frame's raw body bytes, which come from the MCP `receiptText` string encoded as UTF-8; the digest covers exactly those bytes). Edits to the receipt file afterwards do not change the open review. **Verification (what approval binds to):** at open and again when Approve/Request changes is clicked, for every receipt file UniView (1) re-opens the **pathname** through the path policy, (2) compares its device/inode with the handle captured at open, and (3) hashes the pathname's current bytes. States: `unchanged` (hash equals the receipt's), `changed` (different hash; the observed hash is recorded), `replaced` (pathname now refers to a different file), `missing`, `unreadable`, `too_large`. If any state or observed hash differs between what is on screen and the click-time check, the decision is blocked and the view refreshes ("A file changed since you looked — review again"). Desktop hashing: Node `crypto` streaming.
- **Decision (exact):** `{ "uniview": "decision/1", reviewId, receiptDigest, decision: "approved"|"changes_requested"|"dismissed", comment ≤ 8 KiB, decidedAt, verifiedAt, persisted: boolean, files: [{ path, expectedSha256, observedSha256 | null, state }] }`. One decision per review (later clicks disabled); "dismissed" when the person closes the review tab without deciding.
- **Ownership:** a review opened by an MCP session or CLI `--wait` belongs to that session; `get_review` and waits only see their own sessions' reviews (else `not_found`). Reviews opened by the person by hand belong to nobody.
- **Persistence:** decisions kept in `<userData>/reviews/` (≤ 500, 30 days). If the receipt came from a file, also write `<receipt>.decision.json` next to it: create with temp file + rename, refuse if the target exists and is a symlink/junction or belongs to another reviewId; a write failure is shown and reported in the result (`persisted: false`); inline receipts (MCP) are never written next to anything.
- **Phone and web:** show the receipt and verify files (no decisions in Phase 1: "Decide on your computer"). Resolution rules for every reference (`files[].path`, `view`, spec `image.path`, `fileRef.path`): each may carry a `relPath` sibling field (`relPath`, `viewRelPath`, `image.relPath`, `fileRef.relPath`), relative to the receipt's or spec's folder. When the receipt/spec was opened from a LAN-shared folder, `relPath` is resolved on the same host and root; `..` that would leave the root, absolute `relPath`, or a different root → `missing` (not followed). Otherwise the person can pick companion files: matched by file name, and among duplicates by hash; still ambiguous → the person chooses. Unresolved images show a placeholder "image not available on this device"; unresolved `fileRef`s are disabled. Hashing: WebCrypto `digest` on the whole file, ≤ 256 MiB per file, one file at a time, ≤ 512 MiB per receipt; above that → `too_large`.

### Command line (P16)

`UniView open [--wait [--timeout <s>]] [--receipt <file>] [--view <file>] [--] <file>…` — a CLI client in the main process that runs **before** the single-instance lock: it resolves paths against its cwd, connects to the bridge (starting the app and retrying for 15 s on a cold start), sends one `open` request, prints a one-line acknowledgement or error, and exits; with `--wait` it waits for the review's decision and prints the decision JSON. Exit codes: 0 handed off / approved, 2 usage or path error, 3 changes requested, 4 dismissed, 5 timeout (default 3600 s), 6 app not reachable. `--view` and `receipt.view` both shown if both given. Rules for `--`, unknown flags (exit 2), partial failures (opened files listed, failures to stderr, exit 2). The app keeps a single window; requests while the renderer is loading are queued (bounded: 32).

### MCP (P17)

`UniView --mcp` runs a **hand-written minimal MCP stdio server** in a windowless process that connects to the bridge (starting the app if needed). Reason: the official SDK has an unresolved licence signal in the scout (NOASSERTION); the subset we need is small. Wire contract below ("MCP wire contract").

**Agent approval:** first `tools/call` of an unapproved session shows one native dialog at a time (others queue, max 4; unanswered for 120 s → denied): "An agent that says it is ‹name› wants to show files and ask for reviews in UniView" — Allow for this session / Always allow / Don't allow. "Always" enrolls the client: UniView generates a client key, which the MCP process stores in `<userData>/agents/<clientId>.key` (owner-only) and presents on later sessions (bridge-authenticated, then `clientProof`); revocation in the **Agents** panel deletes the enrollment, cancels its pending waits and closes its sessions. Rate limits: ≤ 30 opened tabs per minute per session, ≤ 8 pending reviews per session and 32 overall. The Agents panel lists sessions and enrolled clients (self-reported names), with an activity log (≤ 500 entries, 30 days).

### Bridge authentication details (P15)

- Nonces: 32 random bytes each side, fresh per connection. Transcript encoding for HMAC inputs: each field as a 4-byte big-endian length followed by its bytes, in the order given; labels are ASCII. The server rejects a `clientNonce` seen in the last 10 minutes (replay window of 4096 entries), and a client rejects a server proof for any nonce it did not just send.
- Enrolled clients (MCP "Always allow"): after the bridge handshake, `enrollProof = HMAC(clientKey, "enroll" | serverNonce | clientNonce)` over the same connection's nonces; the server looks the client up by `clientId` and verifies. A removed enrollment fails with `not_allowed`.
- Cold start: the CLI/MCP client starts the app, then polls the endpoint with backoff (100 ms → 1 s, 15 s total); two clients cold-starting at once both connect to the single instance.

### Aggregate limits (all platforms; each has a limit and limit+1 test)

| Resource | Limit | Over the limit |
|---|---|---|
| Bridge frame | header ≤ 64 KiB, body ≤ 2 MiB | connection closed (`too_large`) |
| Connections / in-flight per connection | 8 / 16 | `busy` |
| Handshake | 5 s | closed |
| Agent tabs open at once (all sessions) | 64 | `busy` |
| Agent file handles (all scopes) | 256 | `busy` |
| Opened tabs per session | 30 per minute | `busy` |
| Pending reviews | 8 per session, 32 total | `busy` |
| Receipt files | 200 | `invalid_receipt` |
| Bytes hashed per verification pass (desktop) | 8 GiB in total, 120 s deadline | remaining files `too_large`; pass cancelled on tab close or decision |
| Hashing queue (desktop) | 2 concurrent files, 4 queued verifications | later ones wait; beyond → `busy` |
| Phone/web hashing | 1 file at a time, ≤ 256 MiB each, ≤ 512 MiB per receipt | `too_large` |
| Approval dialogs | one shown, 4 queued, 120 s | denied |
| Spec images | ≤ 50 MP each; decoded only while near the viewport (IntersectionObserver) and released when scrolled away or the tab closes; ≤ 2 concurrent decodes; ≤ 64 MP decoded per view and ≤ 128 MP across all open agent views | placeholder "Image not loaded — click to load" (loading it evicts the least recently shown images first) |
| CLI renderer-not-ready queue | 32 requests | `busy` |
| Activity log / stored decisions | 500 entries / 500 decisions, 30 days | oldest dropped |

### MCP wire contract (P17)

- Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, UTF-8, one message per line, ≤ 16 MiB per line (longer → error -32600 and the line is discarded; see "Size" below). **stdout carries only protocol messages**; all logging goes to stderr.
- Protocol revision: `2025-06-18`; `initialize` accepts a client-requested revision from {`2025-06-18`, `2025-03-26`, `2024-11-05`} and otherwise answers with `2025-06-18`. Capabilities: `tools` only. Lifecycle: `initialize` → `notifications/initialized` → requests; requests before initialization → -32002. `ping` supported. `notifications/cancelled` cancels a waiting `request_review` (the review stays open for the person).
- Errors: JSON-RPC codes -32700 (parse), -32600 (invalid request), -32601 (unknown method), -32602 (invalid params). Tool failures are tool results with `isError: true` in the per-revision error envelope defined under "Result envelopes" (`structuredContent` only on `2025-06-18`), with `code` ∈ `not_allowed`, `bad_path`, `invalid_spec`, `invalid_receipt`, `busy`, `app_unavailable`, `not_found`, `timeout`.
- Tools (input schemas published in `tools/list`; exactly one of each alternative pair, else -32602): `open_files {paths: string[1..20]}` → `{opened}`; `show_view {specText: string | specPath: string}`; `request_review {receiptText: string | receiptPath: string, waitSeconds: 0..3600 (default 0)}` → `{status: "decided", decision}` | `{status: "pending", reviewId}`; `get_review {reviewId}` → decided | pending | `not_found` (also for other sessions' reviews).
- **Result envelopes (exact).** Successful tool results: revision `2025-06-18` → `{ content: [{ type: "text", text: <JSON of the structured value> }], structuredContent: <structured value> }`; revisions `2025-03-26` and `2024-11-05` → `{ content: [{ type: "text", text: <JSON of the structured value> }] }` only. Structured values: `open_files` → `{ opened: number }`; `show_view` → `{ shown: true, scopeId: string }`; `request_review` → `{ status: "decided", reviewId, decision }` or `{ status: "pending", reviewId }`; `get_review` → `{ status: "decided", decision }` or `{ status: "pending" }`. Errors: `isError: true` with `content: [{ type: "text", text: "<code>: <message>" }]`, plus `structuredContent: { code, message }` on `2025-06-18`. Each tool's `outputSchema` (2025-06-18 only) matches these shapes.
- Size: an MCP line may be up to 16 MiB (JSON escaping can expand a 2 MiB document several times); after JSON decoding, `specText` / `receiptText` must be ≤ 2 MiB as UTF-8 (`invalid_params` otherwise).
- Deterministic transcripts in `fixtures/mcp/*.jsonl` (request lines and the exact expected response lines, with ids) are the conformance tests.

### CLI details (P16)

`--wait` requires `--receipt` (else exit 2 with a usage message). `--timeout` only with `--wait`. Paths after `--` are files even if they start with `-`.

### Packaging (P18)

Schemas live in `shared/schemas/` (already packaged by electron-builder's `shared/**`) and are imported by the validators, so there is no runtime file lookup. The CLI and `--mcp` entry are part of `electron/main.mjs`; no extra packaged files. Installed-build tests (`aes eval` suite `evals/agents.json` against the packaged `UniView.exe`): `open` acknowledgement, usage-error exit codes, `--mcp` `initialize` + `tools/list` transcript, a spec/receipt validation error message, and **one successful `tools/call open_files` through the bridge, the approval dialog and the renderer**: the test drives the native "Allow for this session" button with Windows UI Automation (PowerShell `System.Windows.Automation`, no product test hook) and asserts the exact result envelope and that the tab opened. Decision round-trips are tested in the unpackaged Electron e2e (they need a person or a test-only auto-decide hook, which never exists in packaged builds).

### Behaviour-to-test map

Every row is a deterministic automated test (unit, JVM, or Playwright/Electron e2e) recorded red-before/green-after in the packet's commit. Screenshots, docs, a live-agent run, OpenHands reports and reviewer ACCEPT are supplementary evidence, not acceptance tests.

| Behaviour | Test |
|---|---|
| Spec node rules, budgets (limit, +1), unknown fields, error codes | `viewspec-schema.test.ts` (fixtures) |
| Restricted Markdown: no `a[href]`, no `img`, raw HTML escaped, bidi/control stripped, no network request | `agent-markdown.test.tsx` (DOM + fetch/Image spies) |
| Diff worker budget fallback | `viewspec-diff.test.ts` (fake clock) |
| SHA-256 vectors incl. 0, 1, 63, 64, 65 bytes and multi-chunk sizes | `sha256-vectors.test.ts` (desktop and WebCrypto paths) |
| unchanged / changed / replaced / missing / unreadable / too_large | `receipt-verify.test.ts` (temp files, rename-replace, delete) |
| Change between view and click blocks approval; replaced-by-rename detected; file deleted after viewing → `missing`, approval blocked | `review-decision.test.ts` |
| Snapshot stability: editing the receipt file or its view file after opening changes neither the review, its `receiptDigest`, nor the shown view (until "Reload") | `review-snapshot.test.ts` |
| Inline receipt digest = SHA-256 of the exact UTF-8 body bytes (fixtures with escapes, non-ASCII, CRLF) | `receipt-digest.test.ts` |
| Escape-heavy inline payloads (2 MiB of quotes/backslashes/control chars) pass through MCP and the bridge; 2 MiB + 1 is rejected | `inline-payload.test.ts` |
| Spec image budgets: per-image, per-view, global, concurrent decodes, release on scroll/close | `viewspec-images.test.tsx` |
| One decision only; dismissal; `persisted` false on write failure; symlink/other-review target refused | `review-persist.test.ts` |
| Content cannot trigger a decision; 500 ms arming delay; Enter does nothing | `review-ui.test.tsx` (fake timers, synthetic events from the content area) |
| Phone/web resolution: relPath on a LAN root, `..` escape, wrong root, duplicates, picked companions | `receipt-resolve.test.ts` |
| Phone/web hashing limits | `receipt-verify-web.test.ts` |
| Bridge handshake: wrong key, fake server cannot get a client proof, replayed nonce, squatter endpoint, stale socket, oversized frame, too many connections, timeout, concurrent cold start | `bridge.real.test.ts` (real named pipe on Windows, real socket on Unix) |
| Path policy table, open-then-validate mismatch, drive lookup fail-closed, swap after grant reads the original handle | `agent-paths.test.ts` (+ Windows-only cases) |
| Agent reads use the handle: protocol stream, IPC reader, thumbnails, hashing; tab close releases | `agent-grants.e2e.ts` (Electron) |
| Aggregate limits table | `agent-limits.test.ts` |
| CLI arg parsing; cold/warm start; two `--wait` clients; exit codes 0/2/3/4/5/6 | `cli-args.test.ts`, `cli.e2e.ts` |
| MCP transcripts incl. success **and error** envelopes for each supported revision, and a 16 MiB escape-heavy line accepted / 16 MiB + 1 rejected; approval session/always/deny/queue/timeout; removed enrollment; cross-session `get_review` | `mcp-transcripts.test.ts`, `mcp-approval.e2e.ts` |
| Installed build incl. a successful approved `tools/call` | `evals/agents.json` |

## Task packets (order: P13 ∥ P14-schema → P15 → P16 → P17 → P18)

| # | Packet | Acceptance (each item is a deterministic test that fails without the change; red-before/green-after evidence recorded in the commit) |
|---|---|---|
| P13 | View spec v1: schema + fixtures, validator (hyperjump), restricted Markdown, ViewSpec viewer, detection | every node type valid/invalid fixture; each budget at its exact limit and +1; unknown fields; DOM test: no `<a href>`, no `<img>` from Markdown, raw HTML escaped, bidi/control stripped; no network request during render (fetch/Image spy); diff worker budget; e2e web + phone sizes, light/dark screenshots |
| P14 | Receipts + reviews: schema + fixtures, `verifyReceipt` (desktop streaming + phone/web whole-file), Review tab with app bar, decision schema, persistence rules, phone companion resolution | SHA-256 vectors incl. sizes around chunk/block boundaries; unchanged/changed/missing/unreadable; change between view and click blocks approval; one decision only; dismissal; decision-file write: symlink target refused, existing other review refused, failure reported; content cannot trigger approval (keyboard Enter, synthetic click from content area); phone: receipt from a LAN share resolves `relPath`; > 256 MiB message |
| P15 | Local bridge + path policy | real Windows pipe and real Unix socket tests (not in-memory): wrong key, server-proof check (fake server cannot learn client proof), pre-existing endpoint (squatter), stale socket, oversized frame before parse, too many connections/in-flight, handshake timeout; path policy table (UNC, `\\?\`, devices, ADS, junction/symlink to UNC, directory, swap after grant reads the original handle); per-view grant scope (cannot use another view's grant; closing the tab closes handles) |
| P16 | CLI handoff | arg-parser unit tests (`--`, unknown flags, relative paths, combinations); Electron e2e: cold start and warm start; two simultaneous `--wait` clients each get their own decision; approved/changes/dismissed/timeout exit codes; app exits while waiting → exit 6; startup failure |
| P17 | MCP server + approval + Agents panel | JSON-RPC conformance tests (initialize, tools/list schemas, errors, cancellation); approval dialog flows (session, always, deny, queue, 120 s timeout); enrolled key reuse after removal fails; cross-session `get_review` → not_found; rate limits; packaged-app test: `UniView.exe --mcp` from the installed build completes `initialize` |
| P18 | Docs, packaging, QA, security | electron-builder includes the new files; `docs/AGENTS.md` with config snippets for Claude Code, Codex, Cursor; `aes eval` golden cases for the CLI; a real agent (Claude Code) connects through MCP and gets a decision; OpenHands end-to-end report (desktop + phone); Codex red-team review ACCEPT (prompt injection via spec/receipt text and names, squatting, flooding) |

## Dependencies

Scout `scout-fa4e0d6e` (2026-10-23): **OK** — `@hyperjump/json-schema` (MIT), `diff`/jsdiff (BSD-3-Clause), `markdown-it` (MIT), DOMPurify (already bundled). **Not used**: the official MCP TypeScript SDK (licence NOASSERTION; would need a CTO exception — replaced by a minimal in-house server), `ajv` (code generation, CSP-incompatible), `node-ipc` (supply-chain history; Node `net` is used). Already bundled `marked` stays for the existing Markdown viewer only.

## CEO decisions (2026-10-24)

1. Agent approval offers both "Allow for this session" and "Always allow" (enrolled key).
2. Review decisions on the phone are deferred to Phase 2; Phase 1 phones show and verify only.
3. Build order: P13 (split into P13a schema/validator, P13b restricted Markdown, P13c viewer) and P14a (receipt schema) first.
