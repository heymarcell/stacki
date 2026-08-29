# MCP performance baseline

The numbers Phase A3 has to beat, or decline to change.

| | |
| --- | --- |
| Machine | Apple Silicon (arm64), macOS |
| Node | v24.12.0 |
| Stacki | `4ead970` (PR #19 merge) |
| Fixture | `test/agent-harness.js` — a real Astro project, real parser, real Agent API |
| Harness | `npm run bench:mcp`, 20 warm iterations per operation |
| Path | official MCP client → HTTP → MCP server → domain tool → Agent API → implementation |

Reproduce with `npm run bench:mcp`. The script is the source of truth; this file is a snapshot.

## What this rig cannot tell you

**There is no browser.** `agent-harness.js` runs the App in jsdom, so anything whose cost is a real
renderer answers instantly and empty here:

- `get_context` reads the same 618 bytes at `none`, `essential` and `full`, because computed styles
  come back empty. **The hypothesis in §34 — that `essential` costs a renderer round trip — cannot be
  tested in this rig.** It needs the packaged app, and until then nothing should be concluded about
  the default.
- `capture` refuses; it has nothing to photograph.

Everything about source, files, refs, parsing, permissions and dispatch is the shipping code.

## Operations

Milliseconds, measured end to end through the client.

| operation | cold | p50 | p90 | p95 | max | bytes |
| --- | --- | --- | --- | --- | --- | --- |
| `server/discover` | 5.7 | 4.1 | 6.5 | 10.5 | 10.5 | 1,752 |
| `tools/list` | 9.1 | 8.1 | 9.9 | 10.3 | 10.3 | 131,349 |
| `get_capabilities` | 69.7 | 3.5 | 5.0 | 7.2 | 7.2 | 30,819 |
| `get_context` (none) | 4.2 | 3.3 | 4.6 | 5.2 | 5.2 | 618 |
| `get_context` (essential) | 3.3 | 4.4 | 6.5 | 6.5 | 6.5 | 618 |
| `get_context` (full) | 4.4 | 3.6 | 5.2 | 5.9 | 5.9 | 618 |
| `get_comments` (summary) | 6.7 | 3.3 | 4.9 | 5.9 | 5.9 | 618 |
| `capture` (selection) | 3.4 | 3.1 | 4.7 | 5.1 | 5.1 | 1,156 |
| `target.read` | 5.4 | 3.6 | 5.0 | 5.1 | 5.1 | 17,174 |
| **`style.read`** | **127.8** | **143.4** | **146.6** | **146.8** | 146.8 | 1,299 |
| `style.list_sources` | 24.2 | 4.5 | 7.4 | 10.4 | 10.4 | 810 |
| `style.variables` | 5.7 | 3.5 | 5.0 | 5.1 | 5.1 | 4,293 |
| `source.read` | 4.7 | 3.2 | 4.8 | 5.9 | 5.9 | 3,455 |
| `page.list` | 5.7 | 3.7 | 5.1 | 5.4 | 5.4 | 1,991 |
| `page.read` | 3.5 | 3.2 | 4.5 | 4.7 | 4.7 | 3,339 |
| `content.cms_list` | 5.0 | 3.6 | 4.8 | 5.5 | 5.5 | 1,141 |
| `content.collections` | 3.4 | 3.2 | 4.5 | 4.5 | 4.5 | 634 |
| `asset.list` | 4.4 | 3.3 | 4.9 | 9.4 | 9.4 | 1,024 |
| `project.info` | 3.9 | 3.2 | 4.5 | 4.8 | 4.8 | 1,392 |
| `project.scan` | 3.9 | 3.6 | 5.0 | 5.5 | 5.5 | 1,991 |
| `git.info` | **500.5** | 14.0 | 14.8 | 15.1 | 15.1 | 262 |
| `git.status` | 14.2 | 13.8 | 14.6 | 14.9 | 14.9 | 510 |

## Catalog

| | raw | gzip |
| --- | --- | --- |
| `tools/list` (13 tools) | 131,349 B | 11,272 B |

| part | bytes | share |
| --- | --- | --- |
| output schemas | 69,363 | 53% |
| input schemas | 52,511 | 40% |
| descriptions | 6,941 | 5% |
| names + titles | 298 | <1% |

Server instructions: 1,519 chars / 1,527 bytes.

The Envelope output schema is declared once per domain tool and therefore serialised **eight times**.
That is where half the catalog is.

## Workflows

Machine time only — no model thinking.

| workflow | calls | ms | bytes |
| --- | --- | --- | --- |
| visual read | 2 | 68.0 | 17,792 |
| style edit | 5 | 281.9 | 21,063 |
| page investigation | 3 | 22.8 | 8,785 |

## What the numbers say

1. **The server is not slow.** Nineteen of twenty-two operations sit at 3–5 ms p50, comfortably
   inside the §42 targets. `server/discover` (4.1) and `tools/list` (8.1) are far under their
   50 ms / 100 ms marks.

2. **`style.read` is the one real outlier** — 143 ms p50, thirty to forty times its neighbours, and
   the reason the style-edit workflow costs 282 ms across five calls. It is the first thing A3
   should profile.

3. **`git.info` costs 500 ms once**, then 14 ms. A first-call cost, not a per-call one.

4. **The catalog is 131 KB raw but 11 KB gzipped**, and over half of it is eight copies of one
   output schema. Whether that matters depends on what a client does with it, which is an A3
   question rather than an assumption.

5. **`get_context` cannot be judged here.** See the caveat above. Any conclusion about its default
   has to come from the packaged app.
