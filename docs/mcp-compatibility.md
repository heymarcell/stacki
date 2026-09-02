# Host compatibility

What has actually been driven against this server, and what has not.

Every row says how it was established. The distinction that matters is between a
behaviour the protocol supports and a behaviour a **host was observed
performing** — those are different claims, and before this document Stacki made
only the first while sounding like the second.

## Key

| | |
| --- | --- |
| **TESTED** | a host or client did this against a real Stacki, and a test or a recorded session proves it |
| **PROTOCOL** | supported and served; no host has been observed doing it |
| **BEST EFFORT** | it should work; nothing here proves it, and it may degrade |
| **UNSUPPORTED** | not declared, not served. A host should not probe for it |

## Hosts and clients

| | version | how it was driven |
| --- | --- | --- |
| **Claude Code** | 2.1.251 | A real subprocess per trial: `--strict-mcp-config` with a per-trial temporary config, `--setting-sources ''`, no session persistence, and a recording proxy between it and the app. Eleven sessions against a real packaged Stacki over four upstream Astro projects. No user MCP registration was created or read. |
| **`@modelcontextprotocol/client`** | 2.0.0 | The official client, at the modern revision, at `auto`, and at the legacy handshake. This is what every wire test in the suite uses. |
| **Codex CLI** | 0.144.1 | **Attempted and not established.** See §"A tools-only host" below. |
| Cursor, VS Code + Copilot, Gemini CLI, Claude Desktop | installed on the development machine | **Not driven.** Configuration for Cursor is shipped in the app; nothing here proves it. |

## Capabilities

| Capability | Claude Code | Official client | Status | Evidence |
| --- | --- | --- | --- | --- |
| `server/discover` (2026-07-28) | ✅ 11/11 sessions | ✅ | **TESTED** | proxy recording; `test/mcp-modern.js` |
| Protocol refusal `-32022` with `data.supported` | — | ✅ | **TESTED** | `test/mcp-modern.js` |
| Legacy `initialize` | not used | ✅ | **TESTED** | `test/mcp.js`, `test/mcp-dogfood.js` |
| Negotiated legacy version asserted | — | — | **BEST EFFORT** | no test asserts the version returned |
| Server instructions reach the model | ✅ quoted back verbatim | n/a | **TESTED** | a session asked to quote them, with no tool calls, returned all 1,838 bytes |
| `tools/list` | ✅ 11/11 | ✅ | **TESTED** | 140,885 bytes each time |
| `tools/call` | ✅ 83 calls | ✅ | **TESTED** | all 14 tools registered; `test/mcp-wire-coverage.js` covers all 111 operations |
| Structured output validated against the delivered schema | — | ✅ | **TESTED** | `test/mcp-modern.js` |
| `resources/list` | ✅ 11/11 | ✅ | **TESTED** | 2,229 bytes each time |
| `resources/read` | ✅ 5 reads | ✅ | **TESTED** | only via the host's built-in resource tools — see below |
| Resource templates | ✗ | ✗ | **UNSUPPORTED** | none registered |
| `prompts/list` | ✅ 11/11 | ✅ | **TESTED** | 1,131 bytes each time |
| `prompts/get` | **never, in any session** | ✅ | **PROTOCOL** | see "Prompts" below |
| `audit` | ✅ | ✅ | **TESTED** | held-out audit-and-fix trial; `test/packaged-audit.js` |
| Permission refusal, with `isError` | ✅ | ✅ | **TESTED** | `test/mcp-refusal-shape.js` |
| `subscriptions/listen` | **never opened, in any session** | ✗ | **UNSUPPORTED** | nothing emits; see `docs/mcp-v1.md` §2 |
| `listChanged` notifications | — | — | **UNSUPPORTED** | declared by the SDK, emitted by nothing |
| Cancellation on a closed stream | — | — | **UNSUPPORTED** | an audit in flight runs to completion |
| Progress notifications | — | — | **UNSUPPORTED** | none sent |
| Logging, completions, sampling, roots, elicitation | — | — | **UNSUPPORTED** | not declared |
| Packaged app serves all of the above | ✅ | ✅ | **TESTED** | every held-out trial ran against a real `Stacki.app`; `test/packaged-mcp.js`, `test/packaged-audit.js` |
| Transport gates (Host, Origin, bearer, single path, no CORS) | — | raw HTTP | **TESTED** | `test/mcp.js` |

## Resources are reachable only through the host's own tools

Claude Code does not hand MCP resources to the model. It reaches them through two
**built-in** tools, `ListMcpResourcesTool` and `ReadMcpResourceTool`.

Measured, not assumed. A trial run with `--tools ""` — no built-in tools at all —
had a perfectly healthy `resources/list` in its preamble and read the project
profile **zero times**, because with those tools switched off the profile is
unreachable. It used `page`, `content`, `asset` and `source` instead and arrived
at the right answer the long way. Re-run with exactly those two tools allowed, the
same task took **1 tool call and one profile read**.

The consequence for anyone deploying Stacki:

- A host that exposes MCP resources gets the fast road.
- A host that does not — or a run whose toolset is restricted — still gets
  **every** answer, because every guide is also `get_capabilities({topic})` and
  every project fact in the profile came from a tool call that is still there. It
  pays 2,229 bytes a session for a catalogue it cannot open.

## Prompts

Across eleven real sessions, Claude Code called `prompts/list` **every time** and
`prompts/get` **never**.

That is not a defect in either. Prompts are *user-controlled*: a host offers them
to a person, typically as slash commands, and a person invokes one. A headless
`claude -p` run has no person and no way to reach them, so the three prompts cost
1,131 bytes a session there and return nothing.

The spec is explicit that nothing may depend on a prompt having been invoked, and
nothing here does: every prompt is a shortcut into a workflow that is fully
achievable without it. **v1 keeps the prompts and states plainly that a headless
host cannot reach them.**

## A tools-only host — attempted, and not established

Codex CLI is a tools-only MCP client, which makes it the honest test of the claim
that a tools-only client loses nothing. That claim is still argued from the
architecture rather than observed.

It was driven with an inline configuration (`-c mcp_servers.stacki.url=…`,
`bearer_token_env_var`) so that nothing in `~/.codex` was created, read for
credentials, or modified. `codex mcp list` with the same flags shows the server
registered, enabled, and with bearer auth recognised. But across three attempts —
including with `experimental_use_rmcp_client` — **not one byte reached the
recording proxy**, and the session reported that Stacki's tools were not
available to it.

Claude Code connects to the same endpoint, through the same proxy, with the same
token, every time. So this is a Codex-side limitation in `exec` mode rather than
anything Stacki does, and the honest row is that the host was **attempted and not
established**. It is written down rather than dropped, because the next person to
try will otherwise start from zero.

**The claim that a tools-only client keeps 100% of the behaviour therefore
remains architectural.** It rests on: every guide is also
`get_capabilities({topic})`, serving the same bytes (asserted in
`test/mcp-intelligence.js`); no tool requires a resource or a prompt to have been
fetched first; and the four core tools plus the Agent API are the whole
functional surface. What is *measured* is the adjacent fact — a Claude Code run
whose resource tools were switched off completed the discovery task correctly
using tools alone, and paid more calls to do it.

## What this document does not claim

Cursor, VS Code with Copilot, Gemini CLI and Claude Desktop are installed on the
development machine and **none of them has been driven against Stacki**. Codex
CLI was driven and did not connect (above). The app
ships a Cursor configuration snippet; that is a convenience, not evidence. Until
one of them appears in the table above with a session behind it, the honest
statement is that they are expected to work because they implement the same
protocol — and that is all.
