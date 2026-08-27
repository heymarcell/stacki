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

Room creation should be rate limited in production. The Worker uses a
`ROOM_LIMITER` binding **if one is configured** and is a no-op otherwise, so
that everything in this repository stays runnable and testable by somebody with
no Cloudflare account. Uncomment the `ratelimits` block in `wrangler.jsonc` and
give it a namespace id, or put a WAF rate-limiting rule in front of
`POST /v2/rooms`.

Invitation brute force is bounded inside each room's Durable Object and needs
no configuration. Neither mechanism is authorisation and nothing treats it as
such.

### Observability

`wrangler.jsonc` enables Workers Logs deliberately rather than by default.
Nothing that reaches that sink carries a credential, a capability, a room
secret, a ciphertext or a nonce — the logging policy is in §19 of the protocol
document, and `test/secure-relay.js` proves the equivalent for the Node relay
by running a whole share and grepping the log stream for every secret it made.

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
