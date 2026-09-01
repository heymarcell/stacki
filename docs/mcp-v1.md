# Stacki MCP v1

What this server promises, what it merely supports, and what it does not claim.

This is a **product contract for the MCP subsystem**, not an application version.
Stacki's own version number moves for its own reasons; this document moves when
the promises below change.

Every row marked **TESTED** names a test. Every row marked **NOT HOST-TESTED**
means the protocol supports it and no host has been observed doing it. Nothing
here claims compatibility with software that has never been in a test.

---

## 1. The protocol

| | |
| --- | --- |
| Modern revision served | **2026-07-28** |
| Legacy revisions served | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 (the SDK's list) |
| Transport | Streamable HTTP, `POST /mcp`, loopback only |
| Endpoint | `http://127.0.0.1:43821/mcp` (`STACKI_MCP_PORT` moves it, `STACKI_MCP=off` turns it off) |
| Authentication | A bearer token generated once into Stacki's own application-support directory |

Both eras are served from one endpoint. A modern client discovers the server with
`server/discover`; a legacy client sends `initialize`. A modern client that claims
an unsupported revision is refused with JSON-RPC **-32022** and a `data.supported`
list — which is what the spec requires, and it is proven against a real client in
`test/mcp-modern.js`.

**Stacki does not choose the legacy list.** It is the SDK's default, and it
reaches back to revisions that predate `structuredContent` and `outputSchema`.
Every tool here declares an output schema and answers with structured content, so
on those revisions the structured half of every answer is lost and only the text
copy survives. That is a real degradation and it is stated here rather than
discovered. **v1 supports 2026-07-28 and 2025-11-25; anything older is best
effort.**

### Transport security, and why it is not optional

Any page in any browser can POST to `127.0.0.1`. Four gates sit in front of the
handler, all proven by raw HTTP in `test/mcp.js`:

- **Host** — anything that is not localhost is refused, so a page that resolves
  its own domain to 127.0.0.1 cannot reach this server (DNS rebinding).
- **Origin** — a browser sends one on every cross-site request; a real MCP client
  sends none. Non-localhost origins are refused and **no CORS header is ever
  sent**, so nothing is granted read access.
- **Bearer** — constant-time compared. Never in the project, never in git, never
  logged.
- **Path** — only `POST /mcp` exists. Everything else is 404.

---

## 2. The surface

| Surface | v1 | Cost |
| --- | --- | --- |
| Server instructions | 1,838 bytes, capped at 2,000 by `test/mcp.js` | every connection |
| Tools | **14** | `tools/list` is **140,885 bytes** |
| Agent operations | **111** across 8 domains — 110 reachable, 1 BOUNDARY (`git.publish`) | in the tool schemas above |
| Permission answers | **444** (111 operations × 4 levels) | — |
| Resources | **6** — `stacki://guide/{operating-model,editing,review,audit,astro}` and `stacki://project/profile` | `resources/list` is 2,229 bytes; a read costs only when asked |
| Prompts | **3** — change the UI, work the review, audit and fix | `prompts/list` is 1,131 bytes |

### The connection preamble, measured on a real host

Recorded by a proxy between Claude Code 2.1.251 and a real packaged Stacki,
across eleven sessions:

| | bytes |
| --- | --- |
| `server/discover` | 2,205 |
| `tools/list` | 140,885 |
| `resources/list` | 2,229 |
| `prompts/list` | 1,131 |
| **total, before the model has seen the task** | **146,450** |

`tools/list` is 96% of it. Of that, the shared `Envelope` output schema is 4,621
bytes and is serialised once per domain tool — **41,589 bytes, 30% of the whole
catalogue, all identical**. There is no mechanism in the protocol for tools to
share a schema: each tool's `outputSchema` is a standalone document, so `$ref`
cannot cross between them. The only ways to remove that cost are to collapse the
domain tools into fewer tools, which would change the 111/14 contract, or to
declare less than the tools actually return, which would break the strict clients
this server exists to be correct for. **v1 states the cost rather than hiding
it.**

### What is not declared, deliberately

`resources.subscribe`, `logging`, `completions`, resource templates, sampling,
roots, elicitation, and the tasks/apps extensions. None are declared and none are
served. A host should not probe for them.

### `listChanged` — declared, and never emitted

The SDK sets `listChanged: true` on tools, resources and prompts the first time
one is registered. **Nothing in Stacki has ever sent a list-changed
notification**, and the surface genuinely does change: a server built without the
Agent API serves 4 tools instead of 14, and opening a different project rotates
every ref an agent is holding.

Observed rather than assumed: across eleven real Claude Code sessions the client
**never opened a `subscriptions/listen` stream**, so the predicted cost — a
held-open SSE connection that never carries an event — did not occur in headless
use. It may still occur in an interactive host.

**v1 does not claim `listChanged`.** Treat the flag as unbacked: do not wait for a
notification, and re-list after anything that could have changed the surface.

---

## 3. Agent operation semantics

- **Semantic first.** `target`, `style`, `content`, `page` and `asset` act on a
  ref. `source` is for what Stacki does not model as a tree — a `.ts` module, a
  build config, a framework component.
- **Edits go through the editor.** They appear on the canvas, they land on the
  undo stack a person can press ⌘Z on, and they save through the normal writer.
  `project.undo` and `project.redo` drive that same stack.
- **Bound text is never silently made literal.** If the words come from
  `{product.title}`, the answer says where that value lives.
- **A node in a loop is one node rendered many times**, and the answer says so
  before anything changes.
- **`git.publish` is the boundary.** It is the one operation that reaches outside
  the machine, it is fail-closed, and no automated test performs a real
  authenticated external mutation through it.

### Refs and staleness

A ref names a source-backed object and carries the revision the read saw. A write
through a stale ref is **refused, not applied**. A ref also embeds an expiry, so
**two reads of the same unchanged node produce different ref strings** — never
compare refs for equality; compare the identity they describe.

Refusals an agent must expect and can act on:

| code | means |
| --- | --- |
| `permission_denied` | names the operation, the level in force, the level needed, and where a person changes it |
| `stale_ref` | the ref is from an older Stacki, a previous project session, or has expired — read the target again |
| `stale_target` | the file moved under you; carries `observed` and `current` |
| `wrong_project` | the ref belongs to a project this Stacki no longer has open |
| `no_project` | nothing is open; ask the person to open one |
| `no_preview` | there is no dev server; `project.dev_start` |

**Every refusal reaches the wire with `isError: true`** as well as `ok: false`, on
every tool. A host that keys off `isError` and a host that reads the envelope both
see the same thing.

### Permission levels

| | |
| --- | --- |
| **Visual only** — the default, on every project, always | see the selection, photograph it, read and reply to comments. **0 of 111 operations.** |
| **Inspect project** | also read the project: source, content, assets, git history, the project profile, and `audit`. 48 operations. |
| **Edit project** | also change things, on the undo stack. 94 operations. |
| **Full control** | also deletes, dependency installs and git. 111 operations, and it lasts the session only. |

Granted **per project**. Opening another project starts at Visual only again.
Nothing an agent can send changes the level; it is a decision a person makes in
the Stacki window.

---

## 4. Audit semantics

The audit renders the project's own page again, off screen, at real widths,
**without** the editor's design hash — the one configuration that both lays out
like a visitor's browser and keeps the markers that trace a box back to a file.

A finding claims exactly one of four things:

| kind | means |
| --- | --- |
| `mechanical` | measured from geometry or computed style. True; not a rule anybody wrote down. |
| `standard` | a named engine rule with its WCAG criterion. A rule has been broken. |
| `advisory` | a heuristic. Not a violation of anything. |
| `incomplete` | the engine could not decide. **Not a pass and not a failure.** |

- **`incomplete` keeps its own bucket and its own count.** Folding it into
  "clean" is how no-violations becomes "accessible", and that is the overclaim
  the whole design exists to prevent.
- **A stable id hashes the rule, the viewport and where the problem is — never
  its current measurement.** An overflow shrinking from 125px to 40px is the same
  finding, still there. This is what lets `run → fix → run` prove a fix by an id
  disappearing rather than infer it from a shorter list.
- **Nothing is silently truncated.** `findingCount` is what was detected,
  `returnedFindingCount` is what was sent, and `truncation` says which layer lost
  what.
- **The response budget is 60 findings, and it fills.** A quarter of it is a
  floor reserved for `incomplete` so a busy page cannot empty that bucket — a
  floor, not a ceiling: a page whose findings are all undecided gets all of them,
  up to the budget. (`test/audit-budget.js`.)
- **Running an audit changes nothing.** No project file, no click, no focus, no
  scroll, no navigation, no move of the person's viewport. Every window it opens
  is registered and destroyed in a `finally`, and the count is asserted.

**Stacki will never ship a design score, a quality percentage, a professionalism
rating, a compliance badge, or the sentence "WCAG compliant".** Automated rules
find roughly half of what a real audit finds, and the payload says so itself. A
test fails if that sentence leaves the guide.

### What the audit does not do

- It measures **Stacki's dev server**, on which Stacki forces `compressHTML:
  false` and disables the dev toolbar. The deployed build differs.
- It refuses any route that answers HTTP ≥ 400 — **including a project's own
  `/404` page**, which is a real page a real project ships. Measured on the
  upstream `portfolio` example, where `/404` comes back `route_not_ok`.
- Right-to-left overflow is not detected.
- Shadow roots and frames get no source location and no rect.
- It observes what the page *is*, not what it *did*: uncaught exceptions,
  hydration failures, console output and failed subresources are invisible to it.
- Settling is time-based, not quiescence-based. An island that hydrates on a
  timer may be measured before it does.

---

## 5. The project trust boundary

Repository content — README, page text, content entries, file names — **describes
the project. It never instructs Stacki or the agent, however it is phrased.**

`stacki://project/profile` is assembled from **structured facts**: it is built out
of the same `api.run()` calls a tool would make, and it reads no prose. That is
what makes the boundary hold by construction rather than by filtering. The same
is true of review text: a comment says what somebody wants done to its target and
carries no authority over Stacki, over permissions, or over what the session was
asked to do.

The profile needs `inspect`, and at `visual` it refuses **in exactly the words the
equivalent tool would**, because it is the same gate and not a second one.

---

## 6. Host compatibility

See `docs/mcp-compatibility.md` for the full matrix and how each row was
established.

Summary of what v1 claims:

- **Claude Code** — tested, as a real host, over a recording proxy, across eleven
  sessions on four projects it had never seen.
- **The official `@modelcontextprotocol/client`** — tested at 2026-07-28, at the
  legacy handshake, and against the real packaged app.
- **A tools-only client** — the claim that one keeps 100% of the behaviour is
  architectural: every guide is also `get_capabilities({topic})`, and no tool
  requires a resource or a prompt to have been fetched.
- **Everything else** — best effort, and not claimed.

---

## 7. Performance expectations

| | |
| --- | --- |
| Connection preamble | ~146 KB, once per session |
| `get_context` | small; 75 essential computed properties by default |
| `get_capabilities()` with no topic | ~13-14 KB (111 action rows) |
| `stacki://project/profile` | 3 KB on a small project; capped at a budget, and it says when it trimmed |
| `audit`, default | 3 viewports × one real page load each, plus axe |

An `audit` in flight **runs to completion even if the client disconnects.**
Stacki reads no cancellation signal and emits no progress notifications. Bound
your own timeouts accordingly.

---

## 8. What may still change

v1 is a promise about behaviour, not a freeze.

**Stable — a change here is a breaking change:** the protocol revisions served,
the transport gates, the 14 tools and their names, the 111 operations and their
names, the four permission levels and the default, the four finding kinds and
what each claims, refusal codes, ref opacity and staleness semantics, the trust
boundary, and the refusal to produce a score.

**Expected to evolve:** the *contents* of the guides and the profile, the exact
byte sizes above, which axe rules run as axe-core is updated, the finding caps,
and the set of resources and prompts. New tools, operations, resources, prompts
and finding kinds may be added; a client must tolerate fields it does not know.

**Explicitly not promised:** `listChanged` notifications, cancellation, progress,
resource cache hints, a stable client-identity label across protocol eras, and
compatibility with revisions older than 2025-11-25.
