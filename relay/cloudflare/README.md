# Stacki Secure Share — Cloudflare relay

One Worker that routes, and **one SQLite-backed Durable Object per room** that
holds that room's members, invitations and encrypted envelopes.

This is *an implementation* of the Secure Share protocol, not the protocol
itself. The specification is [`docs/secure-reviews-protocol.md`](../../docs/secure-reviews-protocol.md),
and [`relay/node/`](../node) implements the same thing on plain Node so that
self-hosting needs no Cloudflare account. Both answer the same conformance
suite ([`test/relay-conformance.js`](../../test/relay-conformance.js)); if they
ever disagree about what the protocol means, one of them fails it.

## What it stores

Ciphertext, a nonce, a signature, and two HMACs under keys it has never been
given. Look at the schema in `src/room.js`: there is no column a comment could
go in. The relay cannot read review content, source paths, provenance, project
names, or anybody's name — see the threat model in the protocol document.

## Why no D1, KV, R2 or Queues

A room needs one place that decides the order of things and holds them. A
Durable Object is that place. Adding a second service to hold state the object
is already holding would be adding a service.

## Develop

```bash
cd relay/cloudflare
npm install
npm test          # vitest inside workerd, against a real Durable Object
npm run dev       # wrangler dev, on http://localhost:8787
```

`npm test` runs the shared conformance suite plus the Durable Object's own
tests — storage inspection, the WebSocket wake signal, the retention alarm, and
invite brute-force limiting. Nothing is mocked; the DO under test is a real one
with real SQLite storage, because atomicity is most of what this relay is for
and a mock would only assert its own idea of it.

To point Stacki at a local `wrangler dev`: **Share… → Advanced → Use custom
secure relay**, and enter `http://localhost:8787`. Plain HTTP is accepted for
loopback only.

## Deploy

Nothing here deploys itself, and there is no hard-wired hostname anywhere in
Stacki or in this Worker.

**A relay that will create a room for anybody, forever, is the thing to avoid**,
so this configuration is committed in the state that refuses. Deploying it
as-is gives you a relay that serves existing rooms and declines to make new
ones — which is a deployment you notice within a minute, rather than one you
notice when somebody has filled it.

So a public deployment gets its limiter from a **named environment**, and the
bare top level stays the one that refuses.

**Public staging**, on workers.dev — production-equivalent in everything that
decides behaviour, with only the hostname and the isolation different:

```bash
npx wrangler login
npx wrangler deploy --env staging
```

That publishes `stacki-secure-relay-staging.<your-subdomain>.workers.dev`. It
has the rate limiter, the SQLite Durable Object, the same body limits and the
same logging policy, and it deliberately does **not** carry the development
opt-out. It is a real public service; treat it as one.

**The hosted relay for this fork**, on a domain this fork controls:

```bash
npx wrangler deploy --env hosted
```

That publishes `stacki-relay.neongod.io` — the address the app defaults to.
Same Worker, same protocol, same limits as staging; its own Durable Object
namespace and its own limiter namespace so the two never share state or
counters.

Upstream Stacki intends `relay.stacki.app`. This repository is a fork and does
not own that domain, so it does not deploy there and does not claim to be it.

**A private or experimental relay, knowingly unlimited.** Say so out loud;
there is no way to get here by forgetting something:

```bash
npx wrangler deploy --var STACKI_ALLOW_UNLIMITED_RELAY:1
```

To take a staging deployment down again (`--dry-run` first if you want to see
what it would do):

```bash
npx wrangler delete --env staging
```

### Two things about environments that cost an afternoon each

**`durable_objects` is not inherited.** Wrangler's inheritable keys include
`migrations` and `observability`; its non-inheritable ones include
`durable_objects` and `vars`. An environment that does not repeat its Durable
Object binding deploys a Worker with no `env.ROOM` at all, and every room
request dies on it. Wrangler warns, and the warning is easy to scroll past —
`npm run dev` shipped in exactly that state until a staging deploy noticed.
Both named environments here declare the binding themselves.

**A limiter `namespace_id` is a number, not a resource.** Nothing provisions
it. Any two rate-limit bindings in the same Cloudflare account that pick the
same integer **share their counters**, across unrelated Workers. Cloudflare's
own example uses `"1001"`, which is therefore the most contended integer on any
busy account — on the account this was first deployed to it was already taken
by an unrelated waitlist form *and* an unrelated bug reporter. Sharing a
counter with a stranger's contact form is not rate limiting. Staging uses
`770001` and the hosted relay uses `770002`, so neither can spend the other's
budget.

**Query strings are visible in `wrangler tail`.** Cloudflare has a
`redact_query_string` setting, and wrangler 4.127.0 will not accept it in this
file — both placements are refused with *"Unexpected fields found in
observability field"*. So the protection is that the client never puts anything
sensitive in a query string, which `test/packaging.js` asserts directly: the
only parameters the transport builds are `after=` and `limit=`. Persisted
invocation logs are off regardless.

Then set the relay origin Stacki should offer as its default (see
`electron/review/secure/relays.js`), or leave it and let people paste their own
under Advanced.

### Rate limiting

Room creation is **refused unless something explicitly permits it**. In order:

| state | room creation |
|---|---|
| `ROOM_LIMITER` bound | the limiter decides |
| no limiter, `STACKI_ALLOW_UNLIMITED_RELAY=1` | allowed — somebody said so in writing |
| no limiter, nothing said | **refused** |

| environment | limiter | namespace | unlimited opt-out |
|---|---|---|---|
| top level (`wrangler deploy`) | none | — | no — **refuses to create rooms** |
| `--env staging` | 20 / 60s | `770001` | no |
| `--env hosted` | 20 / 60s | `770002` | no |
| `--env development` | none | — | yes, on purpose, locally |

The last row is the default, and it is the point. An earlier version had this
the other way round — protection was opt-in behind a flag — which meant
forgetting two settings instead of one published an unlimited public
encrypted-storage endpoint and said nothing about it. Defaults have to fail the
safe way round.

`npm run dev` uses `--env development`, which carries the opt-out; so does the
test runtime, in `vitest.config.js`. Neither is what `wrangler deploy`
publishes. A WAF rate-limiting rule in front of `POST /v2/rooms` is a fine
alternative to the binding — pair it with the explicit opt-out so the Worker
knows the protection is elsewhere.

Invitation brute force is bounded inside each room's Durable Object and needs
no configuration. Neither mechanism is authorisation and nothing treats it as
such.

### Observability

`wrangler.jsonc` configures Workers Logs deliberately and **narrower than the
default**: `logs.invocation_logs` is `false`. That setting is what records a
line per request — method, URL, status, timing — which for this relay would be
a per-room, per-member access log nobody asked for. What remains is the
Worker's own output: a handful of coarse codes, never a credential, a
capability, a room secret, a ciphertext, a nonce or a URL. The policy is §19 of
the protocol document, and `test/secure-relay.js` proves the equivalent for the
Node relay by running a whole share and grepping the log stream for every
secret it made.

Cloudflare's infrastructure still sees what any reverse proxy sees — the
connecting address, the timing, the size of a request. That is in the threat
model rather than wished away, and it is why nothing here claims anonymity.

### Retention

A room with no authenticated activity for **365 days** deletes itself. It is
the room's own alarm rather than a cron job: the object that knows when it was
last used is the one that schedules its own removal, and it re-checks when the
alarm fires so that an early wake-up cannot take a room somebody is using.
Ending a share deletes its relay state immediately, always.

## Deployment status in this repository

**Public staging: configured, deploy on demand.** `--env staging` publishes a
production-equivalent relay to workers.dev whenever somebody runs it. Whether
one is running right now is a property of the account, not of this file, so
this file does not claim one is.

**This fork's hosted relay: `stacki-relay.neongod.io`,** deployed from
`--env hosted` and the address `DEFAULT_RELAY` points at.

**`relay.stacki.app`: not ours.** That zone is not in this Cloudflare account,
so nothing here deploys to it or claims to be it. If upstream ever runs it,
this fork's default is a one-line change.
