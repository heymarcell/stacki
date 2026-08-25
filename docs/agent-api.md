# The Agent API — how it works

Internal notes. The README says what the feature is for; this says why it is
built the way it is, and is the place to read before changing any of it.

The generated companion, [agent-api-coverage.md](agent-api-coverage.md), is the
inventory: every operation, what it costs, what it reuses, and everything
deliberately left off.

## The one-line version

An agent already has a filesystem and is very good with it. What it lacks is
the answer to *which* file — and Stacki has been holding that answer the whole
time.

## Why this exists

Before it, an agent working a Visual Review did this:

```
get_comments → comment(focus) → get_context → capture
  → Glob → Grep → Read → grep the CSS → read the component
  → work out the binding → edit the file → come back and capture again
```

Everything in the middle line is rediscovery. Stacki had already parsed that
page, resolved that selection to a file and a line, matched the selectors
against the real DOM, counted the rendered copies of the node, and knew which
`const` the words came from. The agent threw all of it away and worked it out
again, less reliably, from text.

So the surface grew a second half. The first four tools stayed exactly as they
were.

## The shape

```
MCP client
   ↓  loopback · Host · Origin · bearer token          electron/mcp/server.js
tools.js ─── reviewTools.js ─── agentTools.js          the 13 tools
   ↓
electron/mcp/agent/index.js                            the one dispatcher
   ├── permissions.js   may this level run it           ← checked before dispatch
   ├── refs.js          is this ref real, ours, current
   ├── registry.js      what the operation is and where
   ├── paths.js         is this path inside the project
   ├── digest.js        is the document still the one you read
   └── domains.js       which existing handler it calls
   ↓                                    ↓
renderer command bus (mcp:ask)      main-process handlers
   ↓                                 (the same ones the panels call)
src/agent/commands.js
   ↓
App.jsx: mutateModel · setSelectedId · undo · flushSave
   ↓
src/modelOps.js  ← the panels call these too
```

The thing worth noticing is what the dispatcher does **not** do. There is no
step in it where it decides how to create a page, write a content entry or move
a node. It cannot: it does not know how. Those live in one place each, and this
calls them.

## One implementation, two callers

This is the requirement everything else hangs off, and it took two moves.

**The node operations.** Deleting a node also deletes the note above it, and the
frontmatter `const` nothing else reads. Moving one out of a loop strips the
bindings that would now throw, and drops a `slot` no longer addressed to
anybody. All of that was inside React callbacks in `App.jsx`. It is now
`src/modelOps.js`, as functions of a model, and the panels call it. Three
existing tests that read `App.jsx` to check the reasoning was there now read the
file it is in, and each gained a check that App still routes through it.

**The main-process handlers.** `electron/main.js` registers its IPC handlers
through a recorder (`handle()` instead of `ipcMain.handle()`), which keeps each
one by name. `domains.js` maps a domain action to one of those names. So
`page.create` and the Pages panel end up in the same function, with the same
validation, the same errors and the same file on disk.

That is not a generic IPC proxy. No tool takes a channel, the client never sees
one, and only what `registry.js` names is reachable — a channel missing from it
is unreachable however it is spelled. `test/agent-api.js` asserts every
registered handler is either in the registry or in the exclusions table with a
reason.

## StackiRef

A ref names an editor object. The alternative — a path and a line number — is
wrong in two directions: a line number stops being true the moment anybody types
above it, and a path an agent can write is a path an agent can invent.

```
stacki:<base64url payload>.<hmac>
```

- **Opaque.** The client never parses one. The shape may change between versions
  without breaking a client that only hands them back.
- **Signed.** HMAC with a key made once per run and held in memory. A forged ref
  fails the check before anything reads a field off it.
- **Project-scoped.** The payload carries a fingerprint of the project root, not
  the root. A ref from another project is `wrong_project`.
- **Session-scoped.** Opening a project rotates the session, and every ref about
  the last one becomes `stale_ref`. The signing key is *not* rotated with it, on
  purpose: a stale ref must come back as "read the target again", not as "this
  was not issued by this Stacki", which sends an agent looking for a bug.
- **Perishable.** Six hours, in the payload.
- **Honest about writing.** `w:false` marks a ref that may be read and not
  written — see *No false confidence* below.

Nothing is stored. The signature is the record, so there is no table to grow and
nothing to evict.

**A node ref is a review anchor.** Same keys, same fingerprint, same peer runs,
same occurrence. That is not a coincidence saved for later — it is what lets
`target` reuse Visual Review's own resolver (`src/reviewAnchor.js`) and its own
navigation (`focusPlan` / `focusReview`). There is one idea of "where a node is"
in Stacki, and one idea of "go to it".

Refs also come back for a target's children and parent, for the component
instance behind a bound prop, for a stylesheet, and for a CSS variable. Walking
the tree is reading the answer, not another round trip per node.

## Revisions and digests

`get_context`'s `revision` counts what is on *screen*: a selection moving bumps
it, an edit to an unselected node may not. A write has to name the *document*,
so there is a second counter — bumped by every accepted model or source change,
including the ones undo and redo make — and a digest of the tree beside it.

A mutation may pass `expectedRevision` and `expectedDigest` from its read. If
either disagrees, the answer is `stale_target` with the current values, and
nothing is changed. Both are checked because either alone can be fooled: an undo
that walked back to where it started leaves the digest right and the revision
wrong; a page closed and reopened leaves the revision plausible and the digest
different.

For disk-backed things — source files, stylesheets, data files, assets — the
evidence is a content digest of the bytes, never an mtime.

Passing neither is allowed. Plenty of writes are honestly blind (create a file,
set a variable by name), and demanding a digest for those would be ceremony. But
a write that names nothing takes what it finds.

## The mutation path

An agent's edit is not a parallel route into the document. It is the route a
click takes:

```
target edit
  → validate every operation against a copy       (all or nothing)
  → App.jsx mutateModel                            (one snapshot, one ⌘Z)
  → the model changes, the canvas re-renders
  → flushSave → Stacki's serializer → the file
  → the preview reloads
  → the answer carries the patch and both digests
```

So the person watching can press ⌘Z after an agent's edit and get their page
back, which is the entire point.

A batch is one `mutateModel`, so it is one undo step. Every operation is applied
to a structural clone first; if any of them refuses, the clone is thrown away
and the answer says which one. A page never ends up with two of three changes in
it and no way to tell which.

Style edits go through `writeEmbedDoc`, which is what the Style panel's own
fields call: a stylesheet edit records an undo command on the app's stack, and a
`<style>` block goes through the page model like any other edit. Nothing is
special-cased for agents.

Writes that never touch the page model — a CSS variable, a content edit, an
asset rename — get an undo entry of their own, because that is what the panels
do for them: without one, ⌘Z would skip straight past to the last layout change.
The inverse is the panels' inverse. A content change is the bytes put back; a
rename or a move is itself read backwards. There is no third kind, and an
operation that fits neither is not recorded rather than recorded wrongly.

Operations that are *not* undoable in the UI are not undoable here either — a
page delete, a git commit, a dependency install. This does not invent history
the app does not have, and the result says `undoable` so an agent is not left
guessing.

### A raw write to the file the editor has open

`source.write` to the open page leaves the model in memory describing a file
that is gone, and the writer marks its own writes so the watcher does not echo
them — which is right for the app's own save and wrong for this. Left alone, the
next model save would put the old markup back over the new file.

So after any write, if the open document's bytes moved, the renderer is asked to
take it from disk again: the same reload the watcher does for an outside editor,
because that is what this is. The answer says `editorReloaded`, and says that the
page's undo snapshots went with it — they describe a tree that is no longer
there. A semantic edit through `target` would have kept them, and the note says
so.

## Bound text

`<h1>{product.title}</h1>` renders words that are not in the file. Replacing the
expression with a literal makes the pixels right and deletes the reason the page
had a CMS.

So `target.read` reports `text.nature`:

| | |
| --- | --- |
| `direct` | literal text; `set_text` replaces it |
| `bound` | an expression produces it; `set_text` is refused |
| `mixed` | literal text with `{holes}` in it; also refused |
| `none` | nothing here renders words |

A refusal is `bound_value`, it names the expressions, and the read that preceded
it already followed each binding back to where the value lives:

| resolves to | what comes back |
| --- | --- |
| a loop variable | which loop, and the same question asked about the list |
| a collection query | the collection name, for the content domain |
| a frontmatter `const` | the declaration and its range |
| an import | the specifier, which `resolve_path` turns into a file |
| a prop | **a ref to the instance that sets it**, since there is no one value |
| anything else | `unknown`, with why — never a guess |

`replaceBinding: true` does it anyway. Saying so is the whole difference between
an accident and a decision.

## Repeated occurrences

A node inside `items.map(…)` is one source node and several rendered cards. An
edit reaches every one of them.

`target.read` says so before anything is edited: `occurrence.scope` is
`shared_template`, the note says *editing it here changes every copy* in as many
words, and `occurrence.perOccurrence` points at the data item behind the copy in
hand — which is how one card is changed. A `map` node itself reports scope
`loop` instead, because "this changes every copy" is true and useless about the
`.map(` line; what an agent wants there is the list.

## No false confidence

The Visual Review evidence rules now protect writes.

`src/reviewAnchor.js` says how a node was identified: `exact` (position plus
corroborating marks), `moved` (found elsewhere by its recorded marks),
`positional` (the slot held on structure alone), or `none`.
`src/reviewCheckout.js`'s `mayPin` turns that into a yes or no, and it is the
same function for both questions:

- **exact / moved** — proof about a *node*, which travels between trees. Pin it,
  and issue a writable ref.
- **positional** on a tree the ref was not made for — a statement about *this*
  tree and worth nothing about a different one. The pin is withheld, and so is
  the write: the ref comes back with `w:false`, and `target` edit answers
  `not_editable` with what to do instead.

"A tree the ref was not made for" is decided the way `divergent()` decides it —
a node ref carries the branch it was minted on, and the comparison is made by
the same function rather than a second copy of the reasoning.

An agent's mutation never uses weaker evidence than a visual pin.

## Permission modes

The endpoint's guards answer *is this our agent*. They have nothing to say about
*should our agent be able to delete a branch*, and that question is the user's.

| | |
| --- | --- |
| **Inspect only** | Read context, source, project information; capture; read and focus reviews. No project mutation. |
| **Edit project** | Everything the panels do — text, props, classes, structure, styles, variables, pages, components, content, assets, undo, redo. |
| **Full control** | Also destructive and remote: deletes, dependency installs, and git — commit, checkout, restore, merge, push, publish. |

Set in the AI connection (MCP) window. Enforced in the main process, in
`run()`, before anything is dispatched — there is no path to an operation that
skips it. Every operation carries a risk class in the registry, and
`get_capabilities` reports which of them this level may run.

**The default is `inspect`, including for an installation that has been running
this server for months.** An update must never quietly hand out a permission
nobody was asked for.

The MCP annotations say the same things and they are documentation. A client
that ignores every hint gets exactly as far as its level allows.

## The security boundary

Unchanged where it was already right, and extended where the surface grew.

- Loopback only, Host and Origin validated, bearer token from the app's own data
  directory. None of it weakened.
- Every path argument is project-relative and resolved here. Absolute paths are
  refused rather than "normalized"; `..` is not searched for as text but
  resolved and the *result* checked; symlinks are followed and checked again; a
  null byte is refused.
- Nothing leaves carrying an absolute path. Style sources are keyed
  project-relative both directions; `diagnose` reports whether node was found
  rather than where.
- A forged ref cannot name a file: it fails the signature before a field is read.
- No shell. An agent connected to Stacki has its own; a second one behind this
  endpoint would widen what a stolen token is worth and buy nothing visual.
- No arbitrary IPC, no arbitrary filesystem, no arbitrary `git <command>`.
- Review administration is unreachable: creating a workspace, joining one,
  minting an invitation, changing an identity, deleting a comment. A person
  types the server address and the invitation.
- Remote review text is text. Nothing about a comment is an input to the gate,
  and there is no action anywhere in the registry that sets a permission level.

## Human-only, and why

The full list is in [agent-api-coverage.md](agent-api-coverage.md). The
categories:

- **Native chrome** — folder pickers, file pickers, the OS edit menu, opening a
  browser. An agent cannot see a dialog, and which project is open is the
  person's decision.
- **Project creation** — deciding where a project lives on disk and running the
  installer. This API acts on the project that is already open.
- **A second shell** — see above.
- **Review administration** — see above.
- **Old-commit preview** — points the canvas at a throwaway checkout and makes
  the editor read-only. An agent driving it would be editing files that are
  about to be deleted.
- **Recents and thumbnails** — the welcome screen's own list.
- **Redundant** — the clipboard copy of the selection trail (`get_context`
  returns it as data), the watcher, the reload handshake.

## Source is the fallback, not the default

`.astro` markup is better edited through `target`: the change lands on the undo
stack, the canvas updates, and the preview follows. `source` is for the rest — a
framework component, a config, plain JavaScript — and for the case `target`
reports as `unrepresentable`, which it says rather than pretending.

`page.read` refuses anything that is not `.astro`, `.md` or `.mdx` for the same
reason: the parser is forgiving enough to make a tree out of a JavaScript file,
and the tree would be nonsense.

## What the tests cover

**`test/agent-api.js`** — the contract. Refs (forged, expired, wrong project,
wrong kind, after a reopen), permission at all three levels across every domain,
path traversal in its several spellings including symlinks and null bytes,
digests and revisions, bounded patches, the exact tool list, the schemas, the
annotations, and `structuredContent` validated against what each tool declared.
Also the coverage assertion: every registered IPC handler is exposed or excluded
with a reason.

**`test/agent-acceptance.js`** — the promise, end to end. It loads the real main
process with a stubbed `electron`, renders the real `App.jsx` in jsdom with its
bridge wired to those handlers, and points the real Agent API at both. Nothing
below the API is a stub. The flows: direct text three levels down with no file
search, props, styles, the CSS variable behind one, bound content followed to
its data file, a repeated item changed one at a time, structural edits, batch
atomicity, stale targets, unrepresentable source, pages and components, CMS,
assets, permission levels, git on a repository of its own, and the original four
tools unchanged.

It found three real bugs on the way in: a commit that read its own result before
React had run the updater, a prop set inside a batch that serialised as
`undefined`, and `WIDTH` — used twice in `jsCollections.js` and declared nowhere
since v0.1.6, so writing any collection holding a record threw before it reached
the file.

## Known limits

- **Content collections need the project's dependencies installed.** Reading a
  content config means evaluating it, which means the project's own Astro. With
  no `node_modules` the answer is a sentence saying so, and the config file is
  still named. The CMS half (JSON data under `src/`) works regardless.
- **No canvas, no computed styles.** `style.read` returns authored declarations
  from real stylesheets either way; `computed` needs a rendering preview and is
  null without one. The same is true of rendered classes and of `capture`.
- **`target` operates on the document Stacki has open.** Reaching a node
  elsewhere navigates there — which is what a person does — and the answer says
  `navigated: true`. A read is therefore not entirely without side effects.
- **A move stays within one file.** Moving a node between documents is a
  different operation with different consequences for imports and scope; it is
  not exposed rather than half-exposed.
- **`git push` and `publish` need a real remote.** Nothing in the tests goes
  near one.
