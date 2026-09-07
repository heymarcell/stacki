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

**The Origin gate is port-agnostic, deliberately, and that was threat-modelled
rather than assumed.** The SDK's `localhostOriginValidation` accepts any origin
whose HOSTNAME is `localhost`/`127.0.0.1`/`[::1]` at ANY port — so the project's
own Astro dev server, or anything else a person is running on loopback, clears
it. It gets no further, for four reasons each checked against a running
endpoint rather than read off the code:

1. the bearer is checked BEFORE the path and before the size gate, so the first
   thing a browser-originated request meets is a 401;
2. a cross-origin `fetch` cannot attach `Authorization` without a successful
   CORS preflight, and the preflight is an `OPTIONS` carrying no credentials —
   measured: it comes back 401 with `www-authenticate: Bearer` and **no
   `Access-Control-Allow-*` header at all**, so the browser fails it and the
   real request is never sent;
3. the only CORS-emitting code in the SDK is the OAuth protected-resource
   metadata document, which Stacki does not mount;
4. even a no-preflight simple POST gets 401, and with no `Access-Control-Allow-Origin`
   its response is unreadable by the page.

Origin acceptance widens who can reach the 401, not who can pass it. For a
non-browser process on the same machine, Host and Origin are attacker-controlled
anyway and the bearer is the whole control — so port-agnosticism changes nothing
there either. Tightening it would buy no authorization property Stacki does not
already have.

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
| `working_tree_blocked` | uncommitted work is in the way of a switch, a merge, or a `resolve_merge`; nothing was changed |
| `bad_choices` | a `resolve_merge` choice does not describe the conflict: an unreadable value, a path git never reported as conflicting, a list of answers that is not one per disagreement, or `"merged"` where no combined version exists. Nothing was written, and the entry names the path and the reason |
| `stale_merge` | the conflict the choices were made against is not the conflict that is there now — either branch has moved, or git reconciles the same two commits differently. Nothing was merged; the message names both branches and both short commits then and now, and the recovery is `git.merge` again |
| `guard_required` | a `resolve_merge` with no `mergeRef`, or one carrying no observation. The handle `git.merge` hands back is what binds an answer to the conflict it answers |
| `merge_blocked` | git would not start the re-merge a `resolve_merge` runs — most often another git process holding the repository for a moment. Nothing was merged and nothing was written, the conflict those answers are about is still the current one, and the recovery is to send **exactly the same call again with the same `mergeRef`**. Carries git's own sentence under `gitSaid` |
| `merge_stuck` | the re-merge ran, the answers were refused, and the unwind that puts the tree back did not fully take. This is the one refusal here that does not mean "nothing changed", and it has two shapes, told apart by `mergeInProgress`. **True**: the project is still mid-merge and `files` names the paths still holding conflict markers, relative to the repository root — `git merge --abort` in the project clears it. **False**: no merge is in progress, but the working tree is not as it was, and `files` names what differs — `git merge --abort` answers "there is no merge to abort" and will NOT clear this; `git checkout HEAD -- <path>` will. Nothing was committed and the branch did not move in either shape |
| `bad_branch_name` | a name git would not have read as a name — most often one beginning with `-`, which git reads as an option. It was never given to git, so nothing was changed |
| `cancelled` | the caller went away mid-audit; says how many viewports had been measured and discarded |
| `undo_failed` / `redo_failed` | the recorded inverse threw. Neither the project nor the history moved, so the same entry is still the one to retry |
| `command_failed` | the editor's own window threw where no named cause fits — most often the filesystem refusing a write to the open document. The honest answer to an exception nobody planned, and the one code here that carries no advice beyond the sentence git or node gave |

This table is the ones worth knowing rather than all of them; the surface has
more, and `get_capabilities` lists every operation it can refuse.

Four of these are new in this revision, and each replaced something worse: three
git causes that arrived as `failed` (the code this codebase's own comment calls
"the code that means nobody knows"), and one answer that was not a refusal at
all — `page.dynamic_paths` reported a dynamic route as standing for no paths
whenever it had no dev server to ask.

Three more — `merge_blocked`, `merge_stuck` and `bad_branch_name` — were already
being sent to clients before they were written down here. They are minted in the
branch handler rather than in the MCP layer and pass through its mappers
untouched, which is exactly the gap that let them ship undeclared; the contract
test now reads that handler's codes too, so the next one cannot arrive the same
way.

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

**Whitespace a page renders, and what still gets past the guard.** A `move` or
a `duplicate` across a nesting level reindents the block that travels, and where
those leading spaces are rendered content that would be a silent edit to what
the page shows. Four things are checked before a block is reindented: the tags
whose inner whitespace is always content (`pre`, `textarea`, `script`, `style`);
a `white-space` declaration written ON the element, as an inline style or a
whitespace utility class; the same declaration on any ANCESTOR, because
`white-space` inherits, and on the DESTINATION the block is moving into; and a
rule anywhere in the project's stylesheets or its `<style>` blocks whose
selector could reach the element. That last one is a one-sided static scan, not
a cascade: a selector shape it does not fully understand, a stylesheet it cannot
read, a directory it cannot list, one postcss cannot parse, one too big to be
worth reading, and a tree deeper than the walk goes all resolve to "could match
anything". `pre-line`, `normal` and `nowrap` are deliberately not in the
refusing set — measured in a real browser, a reindent under those three renders
identically. The scan covers the whole project rather than a fixed list of
stylesheet directories, so a stylesheet a page imports out of `assets/`, or from
anywhere else inside the project, is read like any other; `node_modules`, `dist`
and the build caches are the only things skipped.

**What "could match anything" costs, precisely.** It costs the elements it
covers their REINDENTATION, and nothing else. It is an admission that the scan
came back incomplete, not a measurement that every element renders its
whitespace, and the writer keeps the two apart: an unproven element keeps the
authored bytes of whatever moves into or out of it, while the markup around that
move keeps the indentation the file already had. Only an element the guard
positively identified — a `pre` or `textarea`, a declaration on the element or
on an ancestor, a rule whose selector was actually reduced — has the
indentation between its children treated as content and therefore left out.

**Known residuals, stated rather than left to be found:** the scan reads CSS
that is in the project as text. It therefore does not see a rule that arrives
from outside it — a stylesheet fetched from a URL or served out of
`node_modules` — one injected at runtime by script, or a class name that only
exists after a build step and is not written in the markup. It reads `.css`, `.pcss`,
`.postcss`, `.scss` and `.less`, and the `<style>` blocks of pages, layouts and
components. The indented syntaxes — `.sass`, `.styl`, `.stylus` — are not CSS
and are not parsed at all: a project containing one resolves to "could match
anything", so no reindent of rendered whitespace happens anywhere in it. That is
blunt, and blunt in the safe direction; the alternative measured worse, because
postcss accepts some `.sass` files (one whose first statement is `@use
'sass:math'`, say) without finding any rule in them, which would read as the
positive "nothing here preserves whitespace". It does not run a build: a custom utility declared in a JavaScript config rather
than in CSS is invisible, so `@apply my-utility` reads as preserving nothing —
whereas an `@utility` or `@mixin` block in the project's CSS that declares
`white-space` does resolve to "could match anything", because which elements end
up with it is not answerable from the text. A value it cannot evaluate statically — `var(--ws)`, a Sass
`$ws`, a Less `@ws`, `map-get(...)`, an interpolation — is read as preserving
rather than as absent, so such a rule refuses a reindent instead of permitting
one. It also cannot resolve a `class`
whose value is an expression rather than a literal, and it never consults the
live preview: doing so would make the bytes written to disk depend on whether a
window is open and which route it shows, and could not answer about a
destination that does not exist until after the write.

### Git: what is not read, and what is not repaired

**A custom merge driver's output is opaque, deliberately.** A path merged by a
program of the project's own — `merge=<name>` in `.gitattributes`, or any path
at all when `merge.default` names a driver — is handed the three versions and
writes whatever it likes into the result. Nothing in git's contract makes it
emit conflict markers, and nothing makes the text above `=======` this branch
and the text below it the incoming one; that ordering belongs to the built-in
text driver, not to conflict markup. So Stacki reads no hunk sides out of such a
path and offers none: `hunks` comes back empty, the envelope names the driver in
`customDriver`, and a per-hunk array for that path is refused as
`not_splittable`. The whole-file words are still exact, because "ours" and
"theirs" are answered from git's index — stages 2 and 3 — without reading a byte
of the driver's text. Marker-provenance checking does not run on such a path
either, for the same reason: nothing is being parsed, so there is nothing for an
authored marker-shaped line to be confused with. Every path git marked up itself
is unaffected.

**A driver's NAME is data, and is matched byte for byte.** `merge.default` is
read with `git config -z --get` and used exactly as configured: a key that is
absent, a key set to the empty string, and a key set to `" text "` with the
spaces are three different things, and git resolves each to a different
subsection. Stacki does not trim, case-fold, Unicode-normalise, or collapse an
empty value to "unset", because git does none of those and the answer must be
the one git will act on.

**A git configuration that breaks stock git is not something Stacki repairs.**
Where a user's configuration would change the meaning of an answer, Stacki pins
it for its own invocation and says so — `diff.relative` is pinned to `false` for
the single call that would otherwise be misread — but it takes no view on the
user's configuration otherwise and does not correct it. A repository whose
configuration makes git itself fail is reported as the failure it is; making it
work again is the user's to do, not Stacki's, and a product that silently
rewrote a person's git config to get a cleaner answer would be a worse one.
