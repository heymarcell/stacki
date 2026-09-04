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
| Server instructions | 1,826 bytes, capped by `test/host-limits.js` against a host limit of 2,048 characters | every connection |
| Tools | **14** | `tools/list` is **165,135 bytes** (17,783 gzipped) |
| Agent operations | **<!--count:total-->111<!--/-->** across <!--count:domains-->8<!--/--> domains — <!--count:full-->110<!--/--> reachable, <!--count:boundary-->1<!--/--> BOUNDARY (`git.publish`) | in the tool schemas above |
| Permission answers | **<!--count:permAnswers-->444<!--/-->** (<!--count:total-->111<!--/--> operations × <!--count:modes-->4<!--/--> levels) | — |
| Resources | **6** — `stacki://guide/{operating-model,editing,review,audit,astro}` and `stacki://project/profile` | `resources/list` is 2,233 bytes; a read costs only when asked |
| Prompts | **3** — change the UI, work the review, audit and fix | `prompts/list` is 1,135 bytes |

### The connection preamble, measured on a real host

Recorded by a proxy between Claude Code 2.1.251 and a real packaged Stacki,
across eleven sessions:

| | bytes |
| --- | --- |
| `server/discover` | 2,188 |
| `tools/list` | 165,135 |
| `resources/list` | 2,233 |
| `prompts/list` | 1,135 |
| **total, before the model has seen the task** | **170,691** |

Those are HTTP bytes, and HTTP bytes are not model context. Claude Code has MCP
tool search on by default: it is handed the catalogue and gives the model tool
NAMES, fetching a schema when one becomes relevant. So the number above is what
the transport carries, not what the model is charged — see
`docs/mcp-compatibility.md` for the measured difference.

The figures moved from the ones this table used to carry (140,885 for
`tools/list`), which were measured before later work and were never pinned by a
test. They are pinned now, in the sense that matters: `test/host-limits.js`
fails if any description or the instructions cross what a real host will
carry.

`tools/list` is 96% of it. Of that, the shared `Envelope` output schema is 4,621
bytes and is serialised once per domain tool — **41,589 bytes, 30% of the whole
catalogue, all identical**. There is no mechanism in the protocol for tools to
share a schema: each tool's `outputSchema` is a standalone document, so `$ref`
cannot cross between them. The only ways to remove that cost are to collapse the
domain tools into fewer tools, which would change the <!--count:total-->111<!--/-->/14 contract, or to
declare less than the tools actually return, which would break the strict clients
this server exists to be correct for. **v1 states the cost rather than hiding
it.**

### What is not declared, deliberately

`resources.subscribe`, `logging`, `completions`, resource templates, sampling,
roots, elicitation, and the tasks/apps extensions. None are declared and none are
served. A host should not probe for them.

### `listChanged` — now declared false, because it is false

The SDK sets `listChanged: true` on tools, resources and prompts the first time
one is registered, unless the server said otherwise at construction. Stacki said
nothing, so for a long time `server/discover` advertised three times over that
this server would tell a client when its lists changed. **Nothing in Stacki has
ever sent a list-changed notification.**

Stacki now declares `listChanged: false` on all three, which is the truth: a
fresh `McpServer` is built per request, every registration happens before it
answers anything, and one POST per request leaves no channel to push a
notification down afterwards. A modern client reads these bits to decide which
notification types to ask for on its listen filter, so a false one buys a
listener that can never fire.

The lists a SERVER INSTANCE serves are fixed for its life. What varies between
instances — a server built without the Agent API serves 5 tools instead of 14 —
is decided before it answers, and a client that reconnects is answered by a new
instance. Re-list after anything that could have changed the surface; nothing
will be pushed to you.

The right way to make these `true` is to emit the notifications. Asserted in
`test/mcp-cache-hints.js`.

### Cache hints — what a client may keep

The 2026-07-28 revision requires `ttlMs` and `cacheScope` on six results
(SEP-2549). The SDK fills them with the conservative `{ttlMs: 0, cacheScope:
'private'}` when nothing says otherwise, and for five of them that was a wrong
description of what Stacki serves.

| result | `ttlMs` | `cacheScope` | why |
| --- | --- | --- | --- |
| `server/discover` | 300,000 | `public` | built from registrations decided before the server answers; identical on every machine running this build |
| `tools/list` | 300,000 | `public` | same |
| `prompts/list` | 300,000 | `public` | same |
| `resources/list` | 300,000 | `public` | same — the catalogue is deliberately constant at every permission level |
| `resources/read` of `stacki://guide/*` | 300,000 | `public` | a frozen table compiled into the app; no project is read to produce one |
| `resources/read` of `stacki://project/profile` | 0 | `private` | this person's project, gated on the level they granted |

Five minutes is a staleness budget rather than a guess: the catalogue can only
change when a different build answers on this port, which needs Stacki to be
restarted.

The boundary is asserted by RULE rather than by listing today's URIs — every
`stacki://guide/*` resource must be publicly cacheable and every other resource
must not be — so a project resource added later inherits `private`, and a guide
that stopped being static fails the suite rather than reaching a shared cache.
Responses to 2025-era requests carry no cache fields at all.

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
- **`project.probe` reaches the project's own preview and nothing else.** A route
  is resolved against the preview origin; an absolute URL somewhere else is
  refused before the request; a redirect off the project origin is stopped rather
  than followed, so the outside origin receives nothing rather than receiving a
  request Stacki then disapproves of. It asks the same origin question the audit
  asks, out of the same module, with the same tolerance for loopback having more
  than one spelling. (`test/probe-origin-fence.js`.)

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
| `no_preview` | there is no dev server; `project.dev_start`. Also what `page.dynamic_paths` answers rather than reporting zero routes it could not ask about |
| `bad_arguments` | names the key that was wrong AND what that action does accept |
| `bad_action` | no such action on this tool; lists the ones there are |
| `merge_conflict` | the branches disagree; the merge was unwound, the clashing hunks travel, the whole files do not |
| `working_tree_blocked` | uncommitted work is in the way of a switch or a merge; nothing was changed |
| `bad_choices` | a `resolve_merge` choice could not be understood; nothing was written, and the message states the vocabulary |
| `cancelled` | the caller went away mid-audit; says how many viewports had been measured and discarded |
| `undo_failed` / `redo_failed` | the recorded inverse threw. The stack moved, the file did not |

This table is the ones worth knowing rather than all of them; the surface has
more, and `get_capabilities` lists every operation it can refuse.

Four of these are new in this revision, and each replaced something worse: three
git causes that arrived as `failed` (the code this codebase's own comment calls
"the code that means nobody knows"), and one answer that was not a refusal at
all — `page.dynamic_paths` reported a dynamic route as standing for no paths
whenever it had no dev server to ask.

**Every refusal reaches the wire with `isError: true`** as well as `ok: false`, on
every tool. A host that keys off `isError` and a host that reads the envelope both
see the same thing.

### Permission levels

| | |
| --- | --- |
| **Visual only** — the default, on every project, always | see the selection, photograph it, read and reply to comments. **<!--count:visualOps-->0<!--/--> of <!--count:total-->111<!--/--> operations.** |
| **Inspect project** | also read the project: source, content, assets, git history, the project profile, and `audit`. <!--count:inspectOps-->48<!--/--> operations. |
| **Edit project** | also change things, on the undo stack. <!--count:editOps-->94<!--/--> operations. |
| **Full control** | also deletes, dependency installs and git. <!--count:fullOps-->111<!--/--> operations, and it lasts the session only. |

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
- **And the answer is bounded in bytes, which is the cap that binds.** Sixty
  findings off a dense page are about 80 KB, and a host that will not deliver
  that hands the agent an error instead of an audit. Individual fields are capped
  too — a finding that was shortened names the fields in `truncatedFields` — and
  `truncation.omittedByByteBudget` is counted apart from the count layer, so
  "there were more" and "they would not have fitted" stay different facts.
  (`test/audit-byte-budget.js`.)
- **Running an audit changes nothing.** No project file, no click, no focus, no
  scroll, no navigation, no move of the person's viewport. Every window it opens
  is registered and destroyed in a `finally`, and the count is asserted.
- **The fence is on DOCUMENTS, and that is the whole of it.** No argument can
  name a host — `route` is a path joined onto the project's own preview origin —
  and no document from another origin loads in any frame: a redirect or
  navigation off it fails the run as `route_outside_project`, and an off-origin
  subframe is dropped and named in `blockedSubframeOrigins`. So nothing outside
  this project is ever measured or reported. **Subresources are a different
  question and the honest answer is no.** The page is the real one: it fetches
  its own scripts, stylesheets, fonts and images wherever the project points
  them, its JavaScript runs and can request anything, and those requests carry
  the project origin as `Referer`. Blocking them would change what the page IS,
  and an audit of a page that could not load its own fonts would measure a
  layout nobody has. The audit's browser session is wiped at every run boundary,
  so nothing it fetched is kept. Measured with two loopback origins and a live
  sink in `test/contract-wording.js`, which also fails if this document goes back
  to claiming more.

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
| `get_capabilities()` with no topic | ~13-14 KB (<!--count:total-->111<!--/--> action rows) |
| `stacki://project/profile` | 3 KB on a small project; capped at a budget, and it says when it trimmed |
| `audit`, default | 3 viewports × one real page load each, plus axe |

An `audit` in flight **runs to completion even if the client disconnects.**
An audit reads the request's `AbortSignal` and stops at the next viewport
boundary; nothing else here is cancellable, and no progress notifications are
emitted. Bound
your own timeouts accordingly.

---

## 7b. The extensions, and why none of them is adopted

Extensions became a formal mechanism (SEP-2133, merged January 2026) and there
are three official families. Each was evaluated against what Stacki actually is
and what its measured hosts actually do, rather than against how modern it would
look to support them.

| extension | status today | decision | why |
| --- | --- | --- | --- |
| **Tasks** | Final spec, Stable schema | **not applicable** | Zero tracked host support — the project's own cross-client matrix has no row for it — and no runtime in `@modelcontextprotocol/server` 2.0.0, which is current. SEP-2663 forbids returning a `CreateTaskResult` to a client that did not declare the capability, so an implementation nothing speaks to is dead code by construction. And the problem it solves is not one Stacki has: the audit runs in tens of seconds, inside Claude Code's 60 s request timer, its 2-minute auto-background threshold and its 5-minute idle window. |
| **Apps (UI)** | Final, real multi-vendor adoption | **not applicable** | It renders an iframe inside somebody else's chat transcript. Stacki already *is* the UI — the audit's findings and screenshots render in its own windows — and the app would be sandboxed away from them anyway, round-tripping every action back through `tools/call`. Claude Code, the host this is measured against, renders nothing. This would be a new product surface (a Stacki panel inside a chat client), not an improvement to this one. |
| **Skills over MCP** | draft PR, "not official" banner | **prepare a seam, do not adopt** | Two wire-breaking realignments in three months, one prerelease client, and install-scope only. Stacki is well placed if it lands — `stacki://guide/<topic>` already serves exactly the artefact the SEP standardises, static machine-invariant markdown in the progressive-disclosure shape — so adopting later costs a URI scheme and two methods. Adopting now would mean tracking a moving draft in shipped code. |

The rule this follows: an extension is worth adopting when a host Stacki
actually runs against consumes it and it solves a problem Stacki actually has.
None of the three currently clears both bars, and a count of supported
extensions is not a measure of anything.

**One residual this evaluation surfaced**, recorded rather than dismissed: an
audit that ever exceeded five minutes would be aborted by Claude Code's HTTP
idle timeout, because Stacki sends no progress notifications. The audit's p95
wall time across the widest viewport set has not been measured. The
proportionate answer if it ever matters is a progress notification, which is
core protocol — not the Tasks extension.

## 8. What may still change

v1 is a promise about behaviour, not a freeze.

**Stable — a change here is a breaking change:** the protocol revisions served,
the transport gates, the 14 tools and their names, the <!--count:total-->111<!--/--> operations and their
names, the four permission levels and the default, the four finding kinds and
what each claims, refusal codes, ref opacity and staleness semantics, the trust
boundary, and the refusal to produce a score.

**Expected to evolve:** the *contents* of the guides and the profile, the exact
byte sizes above, which axe rules run as axe-core is updated, the finding caps,
and the set of resources and prompts. New tools, operations, resources, prompts
and finding kinds may be added; a client must tolerate fields it does not know.

**Now promised, and not before:** cache hints on the six cacheable results
(§2), and cancellation of an audit whose caller has gone away — the run stops at
the next viewport boundary, destroys the window it owns, resets its session and
answers `code: 'cancelled'`, and an audit queued behind an abandoned one is
never started.

**Explicitly not promised:** `listChanged` notifications (declared `false`,
because they are not sent), progress notifications, a stable client-identity
label across protocol eras, cancellation of anything other than an audit, and
compatibility with revisions older than 2025-11-25.

**Known residual, stated rather than left to be found:** whitespace a page
renders because of a rule in a STYLESHEET — `.card { white-space: pre }` — is
not detected when a node is moved or duplicated. The guard covers the tags whose
inner whitespace is always content (`pre`, `textarea`, `script`, `style`) and,
since this revision, a `white-space` declaration written ON the element as an
inline style or a whitespace utility class. Detecting it through the cascade
would mean resolving CSS in the parser, which is a second CSS engine and is not
something this surface is willing to become.
