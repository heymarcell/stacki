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

```bash
npx wrangler login
npx wrangler deploy
```

Then set the relay origin Stacki should offer as its default (see
`electron/review/secure/relays.js`), or leave it and let people paste their own
under Advanced.

### Rate limiting

Room creation must be rate limited on a public deployment, and the Worker is
built so that forgetting it fails safe rather than open:

- **Locally, in tests, and for a self-hoster** the `ROOM_LIMITER` binding is
  optional. Its absence is a no-op, so everything here runs without a
  Cloudflare account.
- **An official deployment** sets `STACKI_OFFICIAL_RELAY: "1"`. With that set
  and no limiter bound, the Worker **refuses to create rooms** — a forgotten
  binding makes the relay useless, which somebody notices, rather than making
  it unlimited public encrypted storage, which nobody does.

Uncomment both blocks in `wrangler.jsonc` together, or put a WAF rate-limiting
rule in front of `POST /v2/rooms` and leave the flag unset.

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

**Hosted production deployment: NOT EXECUTED.** There are no Cloudflare
credentials on this machine and none were created. Everything above has been
run locally against workerd.
