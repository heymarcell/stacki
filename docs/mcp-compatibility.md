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
| **Codex CLI** | 0.144.1 | **Driven, and it works.** `codex mcp add --url … --bearer-token-env-var`, in a temp `CODEX_HOME`, behind a recording proxy. A read task and an edit-then-undo task, both correct. See §"A tools-only host" below. |
| **Gemini CLI** | 0.38.1 | **MCP layer driven; task not established.** The whole preamble was recorded on the wire. The run then failed on Google revoking its own free-tier client, downstream of a successful handshake. |
| Cursor, VS Code + Copilot, Claude Desktop, Antigravity | installed on the development machine | **Not driven.** GUI launchers with no documented ephemeral-config CLI; automating one by guesswork would prove nothing. Configuration for Cursor is shipped in the app; nothing here proves it. |

## Capabilities

| Capability | Claude Code | Official client | Status | Evidence |
| --- | --- | --- | --- | --- |
| `server/discover` (2026-07-28) | ✅ 11/11 sessions | ✅ | **TESTED** | proxy recording; `test/mcp-modern.js` |
| Protocol refusal `-32022` with `data.supported` | — | ✅ | **TESTED** | `test/mcp-modern.js` |
| Legacy `initialize` | not used | ✅ | **TESTED** | `test/mcp.js`, `test/mcp-dogfood.js` |
| Negotiated legacy version asserted | — | — | **BEST EFFORT** | no test asserts the version returned |
| Server instructions reach the model | ✅ quoted back verbatim | n/a | **TESTED** | a session asked to quote them, with no tool calls, returned all of them. Now 1,826 bytes against a measured host cap of 2,048 characters; `test/host-limits.js` fails if anything crosses it |
| `tools/list` | ✅ 11/11 | ✅ | **TESTED** | 165,135 bytes (17,783 gzipped) — HTTP bytes, not model context; see "What the catalogue actually costs" below |
| `tools/call` | ✅ 83 calls | ✅ | **TESTED** | all 14 tools registered; `test/mcp-wire-coverage.js` covers all <!--count:total-->111<!--/--> operations |
| Arguments that belong to another action are refused | — | ✅ | **TESTED** | every branch is closed (`additionalProperties: false`); a foreign key is `bad_arguments` and nothing is dispatched. `test/schema-dispatch-contract.js` |
| Structured output validated against the delivered schema | — | ✅ | **TESTED** | `test/mcp-modern.js` |
| `resources/list` | ✅ 11/11 | ✅ | **TESTED** | 2,233 bytes each time |
| `resources/read` | ✅ 5 reads | ✅ | **TESTED** | only via the host's built-in resource tools — see below |
| Resource templates | ✗ | ✗ | **UNSUPPORTED** | none registered |
| `prompts/list` | ✅ 11/11 | ✅ | **TESTED** | 1,135 bytes each time |
| `prompts/get` | **never, in any session** | ✅ | **PROTOCOL** | see "Prompts" below |
| `audit` | ✅ | ✅ | **TESTED** | held-out audit-and-fix trial; `test/packaged-audit.js` |
| Permission refusal, with `isError` | ✅ | ✅ | **TESTED** | `test/mcp-refusal-shape.js` |
| `subscriptions/listen` | **never opened, in any session** | ✗ | **UNSUPPORTED** | nothing emits; see `docs/mcp-v1.md` §2 |
| `listChanged` notifications | — | — | **UNSUPPORTED, and now declared so** | was advertised `true` by SDK default and emitted by nothing; the server now declares `false` on all three. `test/mcp-cache-hints.js` |
| Cache hints (`ttlMs`/`cacheScope`) | — | ✅ | **TESTED** | the four catalogue results and the five guides are `public`/300 s; `stacki://project/profile` is `private`/0, asserted by rule. `test/mcp-cache-hints.js` |
| Cancellation of an audit | — | ✅ | **TESTED** | the handler reads `mcpReq.signal`; the run stops at the next viewport, destroys its window and answers `cancelled`. `test/audit-cancel.js` |
| Cancellation of anything else | — | — | **UNSUPPORTED** | no other operation is long enough to be worth it |
| Progress notifications | — | — | **UNSUPPORTED** | none sent |
| Logging, completions, sampling, roots, elicitation | — | — | **UNSUPPORTED** | not declared |
| Packaged app serves all of the above | ✅ | ✅ | **TESTED** | every held-out trial ran against a real `Stacki.app`; `test/packaged-mcp.js`, `test/packaged-audit.js` |
| Transport gates (Host, Origin, bearer, single path, no CORS) | — | raw HTTP | **TESTED** | `test/mcp.js` |

## What the catalogue actually costs

`tools/list` is 165,135 bytes. That number has been quoted as a context cost,
and it is not one — it is what the transport carries.

| | bytes | gzipped |
| --- | --- | --- |
| `server/discover` | 2,188 | 1,152 |
| `tools/list` | 165,135 | 17,783 |
| `resources/list` | 2,233 | 926 |
| `prompts/list` | 1,135 | 573 |

Of `tools/list`: 9,815 bytes of descriptions, 74,610 of input schemas, 77,919
of output schemas. Six distinct output schemas across fourteen tools, because
the shared Agent envelope is serialised once per domain tool — **36,968 bytes,
22% of the catalogue, is one repeated document**.

**It is not deduplicated, deliberately.** Each tool's schema is its own root in
`tools/list`; a `$ref` that crossed from one tool's document into another's is
not resolvable by a client and would trade a real property (a schema a client
can validate against standalone) for a byte count. Within one schema, `$defs`
is already used where it applies.

**And both hosts that have been measured defer it.** Claude Code has MCP tool
search on by default and gives the model tool names, fetching a schema when one
becomes relevant. Codex does the same thing — `tool_search_always_defer_mcp_tools`
is permanently on — and the difference is visible in its own usage numbers: a
run told to call no tools reported 16.6k input tokens against roughly 220k for
runs that used them.

So the honest statement is: 165 KB crosses the socket once per connection,
compresses to 18 KB, and is not what the model is charged. The number worth
optimising is the one a host actually puts in front of a model, and on both
hosts measured that is a list of names.

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

## A tools-only host — established

Codex CLI is a tools-only MCP client, which makes it the honest test of the
claim that a tools-only client loses nothing. **It now passes that test.**

The previous entry here read "attempted and not established … not one byte
reached the recording proxy". That no longer reproduces, on the same version
string. There is no `experimental_use_rmcp_client` flag any more because the
rmcp client is the only client: the binary links
`rmcp/transport/streamable_http_client.rs` directly.

**How it was driven.** `CODEX_HOME` redirected to a temp directory, so nothing
in `~/.codex` was written. A recording proxy between Codex and a real Stacki
endpoint (the real Agent API over a real Astro fixture), so "it connected" is a
claim about recorded bytes rather than about what the model said.

```toml
[mcp_servers.stacki]
url = "http://127.0.0.1:<port>/mcp"
bearer_token_env_var = "STACKI_MCP_TOKEN"
default_tools_approval_mode = "approve"
```

**That last line is the whole integration**, and it is not in `codex mcp add
--help`. Unset, or set to `auto`, every `tools/call` fails client-side with
"user cancelled MCP tool call" and **never reaches the wire** — which is very
probably what the earlier attempt ran into. Anyone documenting Codex support
has to ship that line or the integration silently does nothing.

**What was recorded.** Read task, twelve exchanges: `initialize`,
`notifications/initialized`, `tools/list` (13 tools, 152,600 bytes), two
`resources/read` of `stacki://project/profile`, four `tools/call`. Every status
200 or 202. The model was asked for every route, whether each is dynamic, and
the components on the home page, and told not to read files from disk; it read
the project profile unprompted — the server instructions name that URI — and
answered correctly, with zero shell commands from a read-only sandbox in an
empty directory.

Edit task: `source` read, `source` replace_range, `project` undo, `source`
re-read. A foreign host drove Stacki's ref/digest write-protection and its undo
stack correctly on the first attempt. A recursive SHA-256 over all nineteen
fixture files is **identical at all four checkpoints** — before, after the read
task, after the edit, and after the undo — so the undo's restore was on disk
and not only in the model.

**Thirteen tools, not fourteen**, because the rig has no browser and therefore
no audit engine to register the fourteenth. The packaged app serves all
fourteen; `test/packaged-mcp.js` asserts that.

### The dual era is load-bearing, and that is now measured

Neither foreign host used `server/discover`, and neither sent an `Mcp-Method`
header. Codex negotiated **2025-06-18**. Gemini negotiated **2025-11-25**.

A modern-only server would have been unreachable by both of the independent
hosts tested here. The 2025 handshake is not legacy baggage kept out of
politeness; it is how everything that is not Claude Code currently arrives.

### And the catalogue is deferred there too

Codex defers MCP tool schemas rather than injecting them at connect
(`tool_search_always_defer_mcp_tools` is permanently on). A run told to call no
tools reported 16.6k input tokens; runs that used them reported around 220k. So
on a second, independent host, Stacki's schemas are fetched when relevant
rather than paid for up front — the same shape Claude Code's tool search
produces, reached by a different vendor.

### What the claim now rests on

The tools-only claim is no longer purely architectural. A tools-only host was
given a discovery task and an edit-and-undo task and completed both correctly.
What is still architectural is the *no loss* half — that a host without
resources gets every answer — and that rests on: every guide being reachable as
`get_capabilities({topic})` (asserted in `test/mcp-intelligence.js`), no tool
requiring a resource or prompt to have been fetched first, and the four core
tools plus the Agent API being the whole functional surface.

### Gemini CLI — the MCP half worked

Recorded: `initialize` at 2025-11-25, `notifications/initialized`, a `GET /mcp`
that Stacki answered 405 (it is POST-only) and Gemini tolerated,
`prompts/list`, `tools/list` (13 tools, 152,600 bytes), `resources/list`.
157,923 bytes down.

The task then died on Gemini's own authentication —
`IneligibleTierError: This client is no longer supported for Gemini Code Assist
for individuals` — which is Google revoking a free-tier OAuth client, downstream
of a handshake that had already succeeded. The honest row is: **Gemini CLI 0.38.1
connects to Stacki and enumerates its full surface; no task could be driven
because the host cannot reach its own model.**

## What this document does not claim

Three hosts have now been driven against a real Stacki with a recording proxy
in front of it: Claude Code, Codex CLI and the official client, plus Gemini CLI
as far as its own authentication allowed. That is the whole of the evidence.

**Cursor, VS Code with Copilot, Claude Desktop and Antigravity are installed on
the development machine and none of them has been driven against Stacki.** They
are GUI launchers with no documented ephemeral-config CLI, and automating one by
guesswork would produce a screenshot rather than a result. The app ships a
Cursor configuration snippet; that is a convenience, not evidence.

Three hosts is not "works everywhere". What the evidence supports is narrower
and worth stating exactly: **two independent vendors' hosts, plus the reference
client, connect to this server and complete real tasks through it, and both
foreign hosts did so over the 2025 handshake rather than the modern one.** A
host not named in the table above is expected to work because it implements the
same protocol, and that is all it is — an expectation.

One measured trap, recorded because the next person will otherwise lose an
afternoon to it: Codex needs
`default_tools_approval_mode = "approve"` in its server entry, or every
`tools/call` is cancelled client-side and never reaches the server at all.
Nothing about that is visible from Stacki's side; the endpoint simply sees a
connection that lists tools and calls none.
