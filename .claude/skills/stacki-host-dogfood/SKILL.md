---
name: stacki-host-dogfood
description: Driving a real MCP host against a real Stacki without touching the user's machine - isolated configs, the two purity modes, and the wire recorder that sees what the agent cannot. Load before measuring Stacki with an external agent host.
---

# Dogfooding Stacki from a real MCP host

## The thing that was wrong before, so it is not done again

`scripts/eval` handed the agent a one-shot CLI that reconnected per command. That
measures *"how does a model behave when MCP is an unfamiliar program it must
explore"*. A real host mounts the server: it injects the instructions and every
tool schema at connect, unconditionally, and the agent pays nothing to ask.

The old harness therefore **charged the agent for what a real host gives away**,
and the connection preamble the product actually costs was invisible to it.

Drive a real host. `scripts/eval/heldout/` is the one that does.

## Never touch the user's machine

- **Never** `claude mcp add`, never write `~/.claude`, `~/.claude.json`,
  `~/.cursor`, `~/.codex` or `~/.gemini`.
- One MCP config **per trial**, written into that trial's own workspace.
- `--strict-mcp-config` so nothing else is loaded, `--setting-sources ''` so no
  user, project or local settings file joins in, `--no-session-persistence` so
  nothing is left behind.
- A second host is only usable if it can be pointed at a server *inline*. Codex
  takes `-c mcp_servers.…`; that is fine. A host that requires editing a file in
  the home directory is a host you do not test.

## The two modes, and never one number over both

| | flags | what it measures |
| --- | --- | --- |
| `mcp-only` | `--tools ListMcpResourcesTool,ReadMcpResourceTool` | every action is an MCP call to Stacki. This is the mode that measures Stacki. |
| `integrated` | `--tools default --add-dir <project>` | what a real user has. Its MCP call count means nothing alone. |

**Check the isolation, do not assume it.** The transcript names every tool the
model used; anything that is not an MCP call, not a resource door and not the
structured-answer tool is the model reaching outside Stacki, and a trial where
that count is non-zero has MCP numbers that are only part of the story.

### The trap that looks like a Stacki result and is not

`--tools ""` gives the model **no** built-in tools — and Claude Code reaches MCP
resources only through `ListMcpResourcesTool` and `ReadMcpResourceTool`, which
are built-in. A run configured that way has a perfectly healthy `resources/list`
in its preamble and **cannot read a single resource**. Measured: the discovery
task read the project profile zero times and took the long way round with
`page`, `content`, `asset` and `source`. Allow exactly those two tools. They are
MCP access, not filesystem access.

## Record at the wire, not in the agent

Put `scripts/eval/heldout/recorder.js` between the host and an **unmodified**
Stacki. The server under test must not know it is being measured, or the number
is about the instrument.

It is the only way to see:

- the preamble — `server/discover`, `tools/list`, `resources/list`,
  `prompts/list` — which the model never asks for and always pays for;
- an application failure, which is a successful round trip and a failed call. A
  harness that counts only transport errors reports "0 invalid calls" and means
  nothing by it;
- what the host does on its own, like opening a stream and holding it.

**Stream the proxy.** A response that is only forwarded at `end` looks fine until
the first long-lived SSE stream, and then the host hangs.

## What one trial owns

A disposable **copy** of the project — never the reference corpus, because the
app's teardown removes what it opened and the next trial must not start from the
last one's edits. Its own userData, its own port, its own workspace. Ports are
probed and re-probed: asking whether a port is free and binding it are two
different moments.

Cleanup failure is trial failure, and it is recorded per trial rather than
summed.

## The server to point at

The **packaged app**, not the in-process wire rig. The rig serves 13 tools and no
audit — a Stacki nobody ships — because the audit needs a real rendering engine.
`startPackagedApp({ project, app })` opens a held-out project in a real
`Stacki.app`, and `app` selects which bundle, which is what makes an A/B possible
at all.

The jsdom harness **cannot** run under Electron: `html-encoding-sniffer` requires
an ES module and Electron 33's Node cannot `require()` one. Do not spend an hour
rediscovering this.

## Comparing two arms

Build both bundles. Baseline from a worktree at the pinned commit, candidate from
the branch — and then **verify the two `app.asar`s actually differ** by
extracting the file you changed. Two arms that launched the same app is the
easiest way to measure nothing and call it parity.

Everything else identical: same project bytes, byte-identical brief, same host
flags, same model, same timeouts. A timeout that differs between arms is a result
about the harness.
