# Shared Reviews — how it works

Internal notes. The README says what the feature is for; this says why it is
built the way it is, and is the place to read before changing any of it.

## The one-line version

A review is a fold of an append-only set of events, ordered by
`(lamport, id)`. Everything else follows from that sentence.

## Why events, and not a shared reviews.json

The local ledger was a mutable list of threads, and that is correct for one
writer. It cannot be shared. Two people writing to one mutable blob means
whoever writes last wins whole and the other person's reply is gone with no
record it was ever made — and no amount of careful merging fixes that, because
merging two histories automatically is a way to get both of them wrong.

So the shared object is a SET, unioned by id. A union cannot lose anything and
does not care what order the network delivered in. The thread everybody reads
is a pure function of the set.

## The order rule

    sort by (lamport ascending, id ascending)

`lamport` is a Lamport clock: an event gets `max(every lamport this
installation has seen) + 1`. That makes causality a fact rather than a guess —
a reply written after seeing Alice's message sorts after it on every machine,
whatever the wall clocks say. Concurrent events can collide on a number, and
the event's UUID breaks the tie: arbitrary, and arbitrary the *same way* on
both machines, which is the only property required.

`createdAt` is carried and never ordered by. Two laptops disagree about what
time it is.

**Required property:** given the same event set, every installation produces
the same thread. `test/review-events.js` folds every scenario from several
directions and compares the results byte for byte.

### What each conflict resolves to

| Conflict | Rule |
| --- | --- |
| two replies at once | both survive, in `(lamport, id)` order |
| same message edited twice | highest-ordered edit wins; the loser stays in the log |
| edit vs delete | **delete is terminal**, in either order — which is what gives the pair an answer at all |
| resolve vs reopen | highest-ordered status event wins |
| defer vs resolve | same; a deferral with no reason does not erase an earlier reason |
| duplicate event id | ignored; the copy already held wins, so a resend cannot redefine an event |
| unknown event type | kept in the log, ignored by the fold |
| a delete that would empty a thread | the earliest message survives its own tombstone |

### Authorisation is part of the fold

A peer can send any bytes it likes. "Only your own words can be reworded" is
therefore a rule about which events COUNT, not merely which ones this app will
create. `message.edited` is applied only when the event's actor is the
message's author and both are people; `message.deleted` only when a person is
removing their own words or an agent's reply; `thread.deleted` only by the
thread's author (or by any person when an agent created it). A forged event is
dropped by every reader, forever.

The reference service enforces the same thing one layer out: a member may push
a HUMAN event only under their own actor id.

## What is shared and what is local

| Shared (an event) | Local (never leaves) |
| --- | --- |
| the thread, its anchor, its provenance | `anchorState` — whether the anchor resolves *here* |
| every message, edit and tombstone | the re-anchored keys after a node moved *here* |
| status changes and the revision a resolution landed on | the short number `#17` |
| | the sync cursor, the outbox, the workspace link |

`anchorState` is the important one. Bob's tree is not Alice's, so inheriting her
anchor state would be exactly how a review gets a pin on markup he does not
have. A review that arrives is `unknown` until something on this machine looks.

The **number** is a nickname, not identity. The creator's proposed number rides
on `thread.created` and is taken when it is free locally, so in the ordinary
case everybody says "#17" about the same review. Two people creating offline
may end up with different nicknames for one thread; the uuid is what identifies
it, and a number is never reused or renumbered once assigned.

## Provenance

Recorded on every new review, never backfilled:

```
provenance: { head, branch, dirty, files: { "src/pages/index.astro": "sha1:…" } }
```

`files` is the durable half — it needs no repository, survives a rebase, and
answers the only question that really matters ("is the file this was written
about the file I have?"). `head` is historical evidence and **not identity**: a
squash, a rebase, a shallow clone or a gc can make it unreachable, so every
reader treats an unreachable commit as `unknown` rather than as `no`.

Git is never required. A project with no repository gets nulls for
head/branch/dirty and perfectly good digests.

## Checkout state

Computed locally, on demand, never stored and never shared
(`electron/review/checkout.js`):

```
{ branch, head, dirty, origin, sameBranch, originIn, source, resolution }
```

- `source` — `same | changed | missing | unknown`, from the recorded digests.
- `resolution` — `present | behind | unknown`, from `merge-base --is-ancestor`.
  `unknown` for a dirty resolution, an unreachable commit, a shallow clone, or
  no repository. **Never** collapsed into `no`.
- `originIn` — whether the commit the review was WRITTEN on is in this history.
  Reported, and deliberately not used to relax the pin rule: being descended
  from a commit says nothing about whether the tree still resembles it.

## The pin rule

`src/reviewCheckout.js`. On top of the resolver's own ladder
(`exact | positional | moved | none` — see `src/reviewAnchor.js`):

- `exact` / `moved` — evidence about the NODE. Travels between trees. Pin it.
- `positional` — a statement about THIS tree ("nothing slid past this index").
  Worth nothing about a different one.
- `unverified` — the file was never read; the page just reported a box.

A review is *divergent* when a file it was written about is missing, or it was
written on another branch — unless the file bytes are byte-identical, which
settles it outright. A divergent review pins only on `exact`/`moved`.

A withheld pin is never a hidden review. The thread stays in the panel, says
where it came from, and says why there is no marker.

## Sync

`electron/review/sync.js`. Push first (so a later failure still leaves local
work somewhere else), then pull pages until the cursor stops moving, then union
and refold. Nothing is replaced and nothing is discarded, so "offline" is not a
mode — an event written with no network is an event in the outbox.

Triggers: opening a shared project, pressing Sync, and window focus (throttled
to once a minute). No polling, no socket. Moving to WebSocket or SSE delivery
later changes this one file and nothing else, because the data model does not
know what a transport is.

**A project that is not shared makes zero requests.** The first line of `sync`
is the guard and `test/shared-reviews.js` counts.

## The service boundary

`SharedReviewTransport` (`electron/review/transport.js`) is five methods:
`workspace`, `pullEvents`, `pushEvents`, `createInvite`, `close`, plus
`createWorkspace` / `joinWorkspace` which happen before there is a credential.
One HTTP implementation ships. Nothing above that file mentions a URL, a token
or a status code.

`service/` is the reference implementation: node + `node:sqlite`, no
dependencies, five routes. It is **not** packaged into the desktop app —
`build.files` does not include it and `test/packaging.js` asserts both
directions of that boundary. It imports `electron/review/events.js` so that
client and server cannot disagree about what an event is; that module is
therefore kept free of Electron and of node_modules.

### Service security

- Every workspace operation needs a member credential; tokens are stored as
  sha-256 hashes.
- A workspace you are not in answers **404**, not 403 — a 403 would confirm it
  exists.
- The server decides who a person is: a human event must carry the member's own
  actor id. Agent events are allowed under any actor (that is what makes
  "Claude" the same author everywhere) and are stamped with the submitting
  member.
- Creating a workspace needs the server's signup token. Invitations are
  single-use, expiring, and claimed with a conditional UPDATE so two people
  racing one cannot both get in.
- Everything is bounded: body size, batch size, page size, name length,
  event size, events per workspace.
- Nothing that could be a comment is logged.

## The version 3 epoch

There is no migration. Ledgers below version 3 are **discarded**, and so is the
review-sharing membership that could pull their events back.

The review model changed shape during alpha: a comment carried a filing colour
the user picked, with `thread.color.changed` behind it and a `color` field on
every projection. Both are gone. Keeping them alive as migration code — a dead
event type and a dead field, folded on every read, forever — to serve reviews
written in a build nobody was yet relying on was the worse trade.

So `loadFile` returns an empty, writable ledger for any version below the
current one, reporting `problem: { kind: 'reset' }` rather than corruption, and
`electron/review/epoch.js` runs once at startup to remove the files themselves
along with every room registration, dormant identity, workspace credential and
project mapping. Membership goes first: a machine that keeps its old comments
and cannot sync them is recoverable, and one with an empty ledger and a live
subscription refilling it is not.

Two things it does **not** touch. The local actor — every comment ever written
from this machine is attributed to that uuid, and a new one would make somebody
a stranger to their own past. And the preferred relay, which is a setting.

A version **above** the current one is still read-only and never rewritten. The
discard fires only for versions this build knows are obsolete; a downgrade must
not eat a newer file. `test/review-epoch.js` measures both halves and the
boundary between them.

## Files

| | |
| --- | --- |
| `electron/review/events.js` | the event model, the order rule, the fold |
| `electron/review/store.js` | the ledger: file, lock, projection, outbox |
| `electron/review/provenance.js` | git as evidence, degrading safely |
| `electron/review/checkout.js` | how a review stands against *this* tree |
| `electron/review/actors.js` | identity, names, ownership rules |
| `electron/review/workspaces.js` | which project is shared, and the credentials |
| `electron/review/epoch.js` | the one-time discard of the alpha's review data |
| `electron/review/transport.js` | the boundary, and one HTTP implementation |
| `electron/review/sync.js` | push, pull, union, refold |
| `electron/review/index.js` | the app around all of it |
| `src/reviewCheckout.js` | the pin rule and the wording of a mismatch |
| `service/` | the reference service (not shipped in the app) |
