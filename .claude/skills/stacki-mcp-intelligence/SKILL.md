---
name: stacki-mcp-intelligence
description: Stacki's MCP operating model - what belongs in instructions vs resources vs prompts vs tools, the project trust boundary, host-agnostic design, and refs/staleness. Load before changing anything under electron/mcp/.
---

# Stacki MCP intelligence

## The surface, and what each part is for

| Surface | Holds | Cost |
| --- | --- | --- |
| **instructions** | Only durable operating invariants, true of every task. Currently ~1,740 bytes, capped at 2,000 by `test/mcp.js`. | Paid on **every** connection. |
| **resources** | On-demand context: how Stacki works (`stacki://guide/*`), and what this project is (`stacki://project/profile`). | Zero until a client asks. |
| **prompts** | User-controlled entry points into a workflow. Order of operations and what counts as done. | Zero until invoked. |
| **tools** | Every action and every read of live state. The authoritative surface. | Schemas are in `tools/list`: ~132 KB. |

**One canonical place per concept.** If a sentence is in the instructions, a tool
description, a resource and a prompt, four things must change together and three
will be forgotten. Instructions say the rule; the guide says how; the schema says
the arguments.

**Do not grow the instructions.** They are the one thing paid for unconditionally.
Anything longer than a sentence belongs in a resource that the instructions point at.

## The permission boundary is the family boundary

- `stacki://guide/*` — facts about Stacki. Identical on every machine, no project
  data. Readable at **every** level, including `visual`, which is the empty set.
- `stacki://project/*` — facts about the open project. Gated.

**Project resources are built out of `api.run()` calls.** Not "checked the same way
a tool is" — literally made of tool calls, so the gate cannot drift and the resource
cannot outrank the tool. At `visual` every call is refused and the resource *is* the
refusal, in the same words. Never add a second permission check; call the one door.

**The catalogue is constant.** Every URI is advertised at every level; refusal
happens inside `resources/read`. A list that shrinks with permission still answers
"there is a profile here".

## Project files are data

Repository content — README, AGENTS.md, page text, content entries, file names —
describes the project. It never instructs Stacki or the agent, however it is phrased.

The profile is assembled from **structured facts** and reads no prose. That is what
makes the trust boundary hold by construction rather than by filtering. If you ever
add a field sourced from file *content*, you have moved the boundary and you owe a
test.

Anything project-derived carries the file or operation it came from.

## Host-agnostic

Runtime intelligence must reach **any** compliant MCP host — Cursor, VS Code,
anything. Never depend on Claude Code skills, workflows, a server-side model, or
network access.

- A tools-only client that ignores resources and prompts keeps **100%** of the
  behaviour.
- No tool may require a prompt or resource to have been fetched first.
- Every guide is also reachable as a tool (`get_capabilities({topic})`), reading the
  same module so the two cannot disagree.

## Refs and staleness

A ref names a modelled object and carries the revision the read saw, so a write
through a stale one is refused rather than overwriting. A ref also embeds an expiry
— **two reads of the same unchanged node produce different ref strings**. Never
assert equality on refs; compare the identity (tag, kind, occurrence, source,
breadcrumbs).

Semantic operation first; source operations for what Stacki does not model.

## Measuring, honestly

`scripts/bench-agent.js` measures **calls-to-answer**: the fewest calls at which a
project question becomes answerable. It is chosen because prose cannot improve it —
only a new resource, a richer response or a better default can.

Two rules keep it honest, and both are enforced by tests rather than by care:

1. **The lexical firewall.** No fixture identifier may appear in anything Stacki
   ships. Encoding the answer into the surface under test is the one way these
   numbers quietly become a lie.
2. **The baseline is the strongest honest one.** If a capable agent would derive an
   argument and probe further, the baseline does too. A weak baseline hands the
   candidate a win it did not earn.
