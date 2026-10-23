# Scout scout-fa4e0d6e

- Goal (tool): Add an AI-agent review workspace to UniView (Electron + React/TS desktop file viewer, Capacitor mobile): (1) an MCP server (stdio, launched by agents such as Claude Code, Codex, Cursor) that bridges to the running desktop app over a local authenticated IPC channel (named pipe / Unix socket) with tools like open_file, show_view, request_review; (2) a declarative JSON view-spec format agents write (headings, markdown, tables, key-value, trees, code, text diffs, images, simple charts, callouts) rendered by host components with a JSON Schema validator; (3) review receipts (JSON with file SHA-256 hashes, checks, citations) with approve/request-changes decisions. Find permissively licensed (MIT/Apache/BSD/ISC) libraries: the official MCP TypeScript SDK, JSON Schema validators (small, CSP-safe: no eval/new Function), text diff libraries, markdown renderers already safe for untrusted input, and any existing open specs for agent review receipts or declarative UI schemas (e.g. MCP Apps / MCP-UI) we should align with.
- Created: 2026-10-23T19:30:04+00:00
- Scout: hermes

## Build-on candidates
| Candidate | URL | Licence | Stars | Last push | Stages 1-5 | Smoke command and exit code | How we build on it |
| punkpeye/awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | MIT | 96793 | 2026-10-23 | Pass | not run | Curated registry of MCP servers and developer tools; reference standard for stdio transport patterns and agent capability discovery. |
| MCP-UI-Org/mcp-ui | https://github.com/MCP-UI-Org/mcp-ui | Apache-2.0 | 5231 | 2026-09-16 | Pass | not run | Open protocol specification and UI component architecture extending MCP for client-rendered dynamic agent UI views, aligning UniView's tool call responses with standard MCP-UI event frames. |
| microsoft/AdaptiveCards | https://github.com/microsoft/AdaptiveCards | MIT | 1970 | 2026-10-06 | Pass | not run | Declarative JSON schema specification for platform-agnostic interactive cards and views (headings, tables, facts, inputs, actions); reference standard for UniView's declarative JSON view-spec format. |
| hyperjump-io/json-schema | https://github.com/hyperjump-io/json-schema | MIT | 314 | 2026-10-14 | Pass | node I:/AES/smoke_uniview_review/test_smoke.js (exit 0) | Pure AST-based JSON Schema (draft 2020-12/2019-09/07) validator with zero eval() or new Function() code generation; validates agent view-specs and review receipt JSON safely under Electron's strict CSP. |
| kpdecker/jsdiff | https://github.com/kpdecker/jsdiff | BSD-3-Clause | 9213 | 2026-10-20 | Pass | node I:/AES/smoke_uniview_review/test_smoke.js (exit 0) | Computes unified patches, structured line diffs, and word diffs for code and text comparison blocks rendered in UniView's agent review workspace. |
| remarkjs/react-markdown | https://github.com/remarkjs/react-markdown | MIT | 15928 | 2026-10-03 | Pass | node I:/AES/smoke_uniview_review/test_react_markdown.js (exit 0) | React renderer for markdown blocks in the declarative view-spec; parses to mdast syntax trees without raw HTML evaluation to prevent script injection. |
| cure53/DOMPurify | https://github.com/cure53/DOMPurify | Apache-2.0 | 17478 | 2026-10-23 | Pass | node I:/AES/smoke_uniview_review/test_dompurify.js (exit 0) | Sanitizes untrusted agent-generated HTML/SVG and rich callouts before rendering in Electron host components or Capacitor mobile WebViews. |
| markdown-it/markdown-it | https://github.com/markdown-it/markdown-it | MIT | 21999 | 2026-10-23 | Pass | node I:/AES/smoke_uniview_review/test_smoke.js (exit 0) | High-speed CommonMark parser with AST token stream support for extracting headings, callouts, and code blocks from agent review notes. |
| micromark/micromark | https://github.com/micromark/micromark | MIT | 2236 | 2026-09-26 | Pass | node I:/AES/smoke_uniview_review/test_smoke.js (exit 0) | Minimalist, 100% CommonMark-compliant low-overhead lexer and compiler for parsing lightweight markdown snippets inside review receipt cards. |
| obra/superpowers | https://github.com/obra/superpowers | MIT | 304178 | 2026-10-23 | Pass | not run | Agent skills framework providing battle-tested subagent workflows, structured review checkpoints, and verification quality gates. |
| anthropics/claude-cookbooks | https://github.com/anthropics/claude-cookbooks | MIT | 53705 | 2026-10-17 | Pass | not run | Reference architectures for agent tool use, structured JSON artifact generation, human-in-the-loop review approvals, and citation-based verification receipts. |
| openai/openai-cookbook | https://github.com/openai/openai-cookbook | MIT | 76779 | 2026-10-23 | Pass | not run | Verified recipes for JSON schema enforcement (structured outputs), citation extraction with SHA-256 integrity verification, and agent evaluation loops. |
| garrytan/gstack | https://github.com/garrytan/gstack | MIT | 137379 | 2026-10-23 | Pass | not run | Pre-landing PR review skill patterns producing structured diff analysis, verification checklists, and cryptographic receipt summaries. |
| synthetic-sciences/openscience | https://github.com/synthetic-sciences/openscience | Apache-2.0 | 4242 | 2026-10-23 | Pass | not run | Formalized audit, claim verification, and receipt-generation schemas for structured review outputs and citation graphs. |

## Rejected candidates
| Candidate | URL | Failed stage | Reason |
| modelcontextprotocol/typescript-sdk | https://github.com/modelcontextprotocol/typescript-sdk | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION due to licensing transition header (Apache-2.0 / MIT / CC-BY-4.0); requires CTO exception to use official @modelcontextprotocol/sdk. |
| modelcontextprotocol/servers | https://github.com/modelcontextprotocol/servers | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION due to mixed licensing transition header across server implementations. |
| modelcontextprotocol/registry | https://github.com/modelcontextprotocol/registry | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION on repository license detection. |
| modelcontextprotocol/inspector | https://github.com/modelcontextprotocol/inspector | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION on repository license detection. |
| modelcontextprotocol/ext-apps | https://github.com/modelcontextprotocol/ext-apps | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION on repository license detection. |
| markedjs/marked | https://github.com/markedjs/marked | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION due to combined MIT and legacy John Gruber BSD clauses in LICENSE file. |
| sinclairzx81/typebox | https://github.com/sinclairzx81/typebox | Stage 1 (Licence) | GitHub API reports SPDX NOASSERTION on license detection. |
| sourcemeta/jsonschema | https://github.com/sourcemeta/jsonschema | Stage 1 (Licence) | AGPL-3.0 copyleft licence is non-permissive and prohibited for integration into UniView. |
| google/diff-match-patch | https://github.com/google/diff-match-patch | Stage 2 (Maintenance) | Repository archived on GitHub (read-only); no commit since May 2024. |
| modelcontextprotocol/create-python-server | https://github.com/modelcontextprotocol/create-python-server | Stage 2 (Maintenance) | Repository archived on GitHub; deprecated generator. |
| cfworker/cfworker | https://github.com/cfworker/cfworker | Stage 2 (Maintenance) | Stale repository (last pushed 196 days ago, exceeding 90-day maintenance freshness limit). |
| praneshr/react-diff-viewer | https://github.com/praneshr/react-diff-viewer | Stage 2 (Maintenance) | Stale repository (last pushed March 2024, >2 years ago, unmaintained). |
| geraintluff/tv4 | https://github.com/geraintluff/tv4 | Stage 2 (Maintenance) | Stale repository (last pushed June 2024, >800 days ago) and unresolved license NOASSERTION. |
| ajv-validator/ajv | https://github.com/ajv-validator/ajv | Stage 3 (Bloat) | Heavy JIT code generation engine that relies on eval() / new Function(), causing EvalError security failures under Electron's strict CSP. |
| node-ipc/node-ipc | https://github.com/node-ipc/node-ipc | Stage 4 (Security) | High-severity supply chain vulnerability and protestware payload history (CVE-2022-23812); local IPC must use standard node:net named pipes instead. |

## Launcher verification (GitHub API, 2026-10-23T19:30:04+00:00)

Only rows marked OK may be built on. Anything else needs a CTO exception or is rejected.

| Repo | Stars | Licence | Last push | Archived | Verdict |
|---|---|---|---|---|---|
| punkpeye/awesome-mcp-servers | 96793 | MIT | 2026-10-23 | False | OK |
| MCP-UI-Org/mcp-ui | 5231 | Apache-2.0 | 2026-09-16 | False | OK |
| microsoft/AdaptiveCards | 1970 | MIT | 2026-10-06 | False | OK |
| hyperjump-io/json-schema | 314 | MIT | 2026-10-14 | False | OK |
| kpdecker/jsdiff | 9213 | BSD-3-Clause | 2026-10-20 | False | OK |
| remarkjs/react-markdown | 15928 | MIT | 2026-10-03 | False | OK |
| cure53/DOMPurify | 17478 | Apache-2.0 | 2026-10-23 | False | OK |
| markdown-it/markdown-it | 21999 | MIT | 2026-10-23 | False | OK |
| micromark/micromark | 2236 | MIT | 2026-09-26 | False | OK |
| obra/superpowers | 304178 | MIT | 2026-10-23 | False | OK |
| anthropics/claude-cookbooks | 53705 | MIT | 2026-10-17 | False | OK |
| openai/openai-cookbook | 76779 | MIT | 2026-10-23 | False | OK |
| garrytan/gstack | 137379 | MIT | 2026-10-23 | False | OK |
| synthetic-sciences/openscience | 4242 | Apache-2.0 | 2026-10-23 | False | OK |
| modelcontextprotocol/typescript-sdk | 13642 | NOASSERTION | 2026-10-23 | False | NO LICENCE |
| modelcontextprotocol/servers | 91520 | NOASSERTION | 2026-10-22 | False | NO LICENCE |
| modelcontextprotocol/registry | 7401 | NOASSERTION | 2026-10-23 | False | NO LICENCE |
| modelcontextprotocol/inspector | 11133 | NOASSERTION | 2026-10-21 | False | NO LICENCE |
| modelcontextprotocol/ext-apps | 3003 | NOASSERTION | 2026-10-23 | False | NO LICENCE |
| markedjs/marked | 37262 | NOASSERTION | 2026-10-21 | False | NO LICENCE |
| sinclairzx81/typebox | 7012 | NOASSERTION | 2026-10-22 | False | NO LICENCE |
| sourcemeta/jsonschema | 309 | AGPL-3.0 | 2026-10-23 | False | NON-PERMISSIVE (AGPL-3.0) |
| google/diff-match-patch | 8132 | Apache-2.0 | 2024-05-22 | True | ARCHIVED |
| modelcontextprotocol/create-python-server | 477 | MIT | 2025-01-23 | True | ARCHIVED |
| cfworker/cfworker | 704 | MIT | 2026-04-10 | False | STALE |
| praneshr/react-diff-viewer | 1665 | MIT | 2024-03-28 | False | STALE |
| geraintluff/tv4 | 1165 | NOASSERTION | 2024-06-12 | False | NO LICENCE |
| ajv-validator/ajv | 14865 | MIT | 2026-09-06 | False | OK |
| node-ipc/node-ipc | 66 | MIT | 2022-04-25 | False | STALE |
