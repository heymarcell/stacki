# Stacki Secure Share — protocol and threat model

Version 2 of Stacki's shared review transport. This document is the
specification: an independent implementation that follows it, and reproduces
the test vectors at the end, will interoperate with Stacki and with both relays
in this repository.

Secure Share replaces nothing in Stacki's review model. The events, their
ordering, their projection and their authorship rules are exactly what
`electron/review/events.js` already defines and are documented in
[shared-reviews.md](./shared-reviews.md). This document is only about how those
events get from one laptop to another without the machine in the middle being
able to read them.

---

## 1. The one paragraph version

Stacki keeps review comments in a local append-only event ledger. Secure Share
encrypts each event on the client, signs it, and hands the result to a small
relay that stores opaque ciphertext. The relay assigns each envelope a sequence
number and serves them back after a cursor. Clients decrypt, verify, and union
the events into their own ledger, which stays authoritative. A WebSocket tells
clients when there is something new; it is an optimisation and correctness does
not depend on it.

---

## 2. Security goals

Secure Share is designed to hold these properties against a relay operator who
reads their own database, a network attacker, and a room member who is not
supposed to be able to speak as somebody else.

| # | Goal |
|---|---|
| G1 | The relay cannot read review content, source paths, provenance, or actor names. |
| G2 | A database dump yields ciphertext, sizes and timings, and nothing else about a review. |
| G3 | The relay never receives the room master secret in any form. |
| G4 | A modified envelope fails closed on the recipient, not silently. |
| G5 | An envelope cannot be moved between rooms. |
| G6 | A member cannot submit a `human` event attributed to another person. |
| G7 | A relay cannot correlate one person across two rooms through the identifiers it holds. |
| G8 | An invitation works once and expires. |
| G9 | No secret is written into the user's project, repository or working tree. |
| G10 | Secure Share works completely against a self-hosted relay with no Stacki account. |

## 3. Non-goals

Stated plainly, because a security claim that is not bounded is not a claim.

- **An authorised collaborator copying plaintext.** Anybody in the room can
  read the room. That is what being in the room means. Screenshots, exports and
  memory are all outside this design.
- **Relay availability.** The relay can drop, delay or refuse. It cannot read,
  and it cannot forge, but it can be unhelpful. Clients keep working offline.
- **A compromised endpoint.** Malware on a member's laptop has the room secret,
  because that member's Stacki has it.
- **Cryptographic forgetting.** A member who has held the room secret cannot be
  made to forget it. See [§13, Revocation](#13-revocation-and-what-leaving-actually-does).
- **Anonymity.** The relay sees IP addresses, request timing and ciphertext
  sizes, like any server. Secure Share is confidential, not anonymous.
- **A malicious relay colluding with a malicious member.** Outside the V1 trust
  model. The honest-relay properties above are what is claimed.
- **A malicious browser extension on the share landing page.** The page is
  minimal and third-party-free, but it runs in the recipient's browser.

The user-facing claim that is true:

> Stacki's relay cannot read your review content.

Claims that are **not** made anywhere in the product: "Stacki knows nothing
about you", "nothing is stored", "your reviews are anonymous".

---

## 4. What the relay sees, and what it does not

### The relay may know

- the room ID (random, 128 bits, client-chosen)
- a room-scoped sender ID per member (an HMAC; see §7)
- a room-specific Ed25519 public key per member
- the number of members, invitations and envelopes
- ciphertext bytes, nonce, signature, and the size of each
- a sequence cursor and a received-at timestamp per envelope
- connection IP and request timing, at the level any HTTP server does

### The relay must never receive

Review text · source paths · selection trails · anchors · anchor confidence ·
provenance · branch names · commit SHAs · git remotes · project names ·
repository names · actor display names · Stacki actor IDs · agent responses ·
review status · review targets · **the room master secret** · **any member's
private signing key**.

Note what is absent from the "may know" list that the legacy plaintext service
does know: the project name, the git remote, and every actor's real ID and
display name. Secure Share removes all three from the wire.

---

## 5. Roles and lifecycle

There is **one** privileged role and it exists because ending a shared review
has to be possible: the **owner** is whoever created the room. Everything else
is a member. There is no roles system, no permissions matrix, and no directory
of people.

```
create room ──> invite ──> join ──> push/pull ──┬──> leave        (that member)
                                                └──> end room     (owner only)
```

- **Room** — created by a client, exists until the owner ends it or it is swept
  for inactivity. Ending deletes all relay state for it.
- **Member** — joins by redeeming an invitation, holds a bearer token, is bound
  to one sender ID and one public key for the life of the room.
- **Invitation** — single use, expires (7 days by default), stored server-side
  only as a hash.

---

## 6. Key derivation

The room master secret is **32 cryptographically random bytes**, generated on
the creating client. It is never sent to a relay.

All keys come from HKDF-SHA-256:

```
salt = UTF8("stacki-secure-review/v2/hkdf")
ikm  = room master secret (32 bytes)
info = UTF8("stacki-secure-review/v2/" + purpose + "/" + roomId)
L    = 32 bytes
```

Three purposes, and no key is ever used for two of them:

| purpose | constant | used for |
|---|---|---|
| `content` | `K_CONTENT` | AES-256-GCM key for review events |
| `sender-id` | `K_SENDER_ID` | HMAC key naming members in this room |
| `envelope-id` | `K_ENVELOPE_ID` | HMAC key naming events in this room |

Every derivation is bound to the protocol version and the room ID, so a key is
useless outside the room and version it was made for.

---

## 7. Room-scoped sender identifier

```
senderId = base64url( HMAC-SHA-256( K_SENDER_ID, UTF8(actorId) ) )
```

`actorId` is the Stacki actor UUID of the **human** member. The relay never
receives it.

Properties: deterministic within a room, so a member's envelopes all carry one
sender ID and peers can pin a signing key to it; unrelated across rooms, so a
relay holding two rooms cannot tell they contain the same person; one-way, so
the relay cannot recover the actor ID.

---

## 8. Opaque envelope identifier

```
envelopeId = base64url( HMAC-SHA-256( K_ENVELOPE_ID, UTF8(event.id) ) )
```

Stable for one event in one room, which gives idempotent retry — a push that
succeeded and lost its answer lands on the same identifier and is deduplicated.
Different across rooms, so the same comment shared twice does not announce
itself as the same comment.

The relay deduplicates on `envelopeId`, uniquely per room.

---

## 9. Encryption

AES-256-GCM under `K_CONTENT`.

- **Plaintext**: `UTF8(JSON.stringify(event))`, the ordinary Stacki review
  event, after it has passed Stacki's own validator.
- **Nonce**: 12 fresh cryptographically random bytes per encryption operation.
  Never derived, never counted, never reused. Test vectors inject a fixed nonce;
  production has no code path that does.
- **Ciphertext on the wire**: GCM output with the 16-byte tag appended, so
  there is one value and no second field anybody can forget to authenticate.
- **Associated data**: binds the routing context, so a relay cannot re-file an
  envelope under a different room, sender or identifier without decryption
  failing.

```
AAD = LP( "stacki-secure-review/aad", "2", roomId, envelopeId, senderId )
```

`LP` is the canonical length-prefixed encoding of §11.

---

## 10. Signatures

Every member holds a **room-specific** Ed25519 keypair, generated locally at
create or join. Not one key per installation — a stable signing identity across
rooms would hand a relay operator exactly the correlation the derived sender ID
exists to prevent.

The private key never leaves the machine. The public key is given to the relay
and served to other members, who pin it (§12).

```
signed bytes = LP( "stacki-secure-review/envelope", "2",
                   roomId, envelopeId, senderId, nonce, ciphertext )
```

`nonce` is its base64url text; `ciphertext` is the raw bytes.

The relay verifies before storing. **The recipient verifies again**, and that
second check is the one that matters — it does not require trusting the relay.

---

## 11. Canonical encoding

One encoding, used for both the AAD and the signed bytes:

```
LP(parts) = for each part: uint32be(byteLength(part)) || part
```

Strings are UTF-8. There is no canonical-JSON subsystem, deliberately: length
prefixing five known fields is unambiguous, and a JSON canonicaliser is a pile
of edge cases none of this needs.

All binary values crossing a JSON boundary are **base64url with no padding**,
and decoding is strict — the text is decoded, re-encoded and compared, so one
value has exactly one encoding.

| field | bytes |
|---|---|
| room ID | 16 |
| sender ID | 32 |
| envelope ID | 32 |
| nonce | 12 |
| signature | 64 |
| public key | 32 |
| room master secret | 32 |
| member token / invitation | 32 |

---

## 12. Verifying a received envelope

In this order, and it fails closed at every step:

1. **Shape** — exactly the six envelope fields, correct version, correct
   lengths, ciphertext within bounds.
2. **Pinned key** — the sender's public key, as first observed for this room.
   A public key that differs from the pin for a known sender ID is **rejected**,
   never silently accepted. This is the whole of the key-substitution defence,
   and it is deliberately not a PKI.
3. **Signature** — verified against the pinned key over the §10 bytes. Checked
   before decryption, so an unsignable envelope cannot cost a decryption pass.
4. **Decryption** — AES-256-GCM with the §9 AAD.
5. **Validation** — the decrypted JSON goes through Stacki's *own* event
   validator (`reviveEvent`), the same function the local ledger folds with.
6. **Envelope binding** — `envelopeId` must equal `HMAC(K_ENVELOPE_ID, event.id)`
   for the event that came out. An envelope claiming to be one event and
   containing another is refused.
7. **Human authorship** — if `event.actorKind === "human"`, then
   `HMAC(K_SENDER_ID, event.actorId)` must equal the envelope's `senderId`.

Only after all seven does the event reach the union/fold. A failure at any step
discards that envelope; it is never partially projected.

### Agent events

Step 7 applies to human events only. A member may submit an event whose inner
`actorKind` is `agent` under any agent actor ID — that is what lets Claude be
Claude on both machines. The outer envelope is still authenticated by the human
member who submitted it, so an agent event is always attributable to a person
in the room. This is exactly the rule the legacy plaintext service enforces.

---

## 13. Revocation, and what leaving actually does

**Leave** revokes that member's relay credential. They can no longer read or
write through the relay.

**Leave does not un-know the room secret.** A member who has held it has it.
This is stated in the UI and it is not worked around, because it cannot be:
there is no group rekey, no MLS, no Double Ratchet, and adding one would be a
large state machine to make a smaller claim than it appears to.

For a genuinely new cryptographic boundary: **End secure share**, then create a
new one. New room, new secret, new invitations, and the old secret opens
nothing that exists any more.

Ending a room deletes the relay's copy of every envelope. It does not delete
what collaborators already decrypted onto their own machines, and the product
does not suggest otherwise.

---

## 14. HTTP API

All bodies are JSON. All member operations authenticate with
`Authorization: Bearer <token>`. Errors are `{ "error": "<code>", "message": "..." }`
with the stable codes in §16. No stack traces, ever.

| method | path | auth | purpose |
|---|---|---|---|
| `GET` | `/health` | — | liveness |
| `POST` | `/v2/rooms` | — | create a room |
| `POST` | `/v2/join` | invitation | redeem an invitation |
| `GET` | `/v2/rooms/:room` | member | room status, members, head |
| `GET` | `/v2/rooms/:room/envelopes?after=&limit=` | member | pull after a cursor |
| `POST` | `/v2/rooms/:room/envelopes` | member | push a batch |
| `POST` | `/v2/rooms/:room/invites` | member | create an invitation |
| `DELETE` | `/v2/rooms/:room/membership/me` | member | leave |
| `DELETE` | `/v2/rooms/:room` | owner | end the room for everyone |
| `GET` | `/v2/rooms/:room/watch` | member | WebSocket upgrade |

### `POST /v2/rooms`

```json
{ "roomId": "<16 bytes b64url>", "senderId": "<32>", "publicKey": "<32>" }
```

→ `{ "room": { "id", "createdAt" }, "credential": { "token" } }`

The creator becomes the owner. A room ID that already exists answers `409
member_exists`. The relay never receives the room secret.

### `POST /v2/join`

```json
{ "roomId": "...", "invite": "...", "senderId": "<32>", "publicKey": "<32>" }
```

→ `{ "room": {...}, "credential": { "token" }, "members": [ { "senderId", "publicKey" } ] }`

Redemption is **atomic**: the invitation is consumed by a conditional update, so
two simultaneous redeems produce exactly one member. Every bad invitation —
wrong, used, expired — answers the same `401 bad_invite`, so guessing cannot
distinguish them.

### `GET /v2/rooms/:room`

→ `{ "room": { "id", "createdAt", "endedAt", "envelopeCount", "storedBytes" },
     "member": { "senderId", "isOwner" },
     "members": [ { "senderId", "publicKey", "joinedAt", "leftAt" } ],
     "head": <cursor> }`

The `members` array is where a joining client gets pinning material.

### `POST /v2/rooms/:room/envelopes`

```json
{ "envelopes": [ { "v":2, "envelopeId", "senderId", "nonce", "ciphertext", "signature" } ] }
```

→ `{ "accepted": ["<envelopeId>"], "rejected": [ { "envelopeId", "code" } ], "cursor": <head> }`

The relay checks shape, that `senderId` is the authenticated member's own, and
the signature against that member's pinned public key. A duplicate `envelopeId`
is **accepted** and stored once — the client's intent is satisfied either way,
and reporting it rejected would make it retry forever.

### `GET /v2/rooms/:room/envelopes?after=&limit=`

→ `{ "envelopes": [ { ..., "seq", "receivedAt" } ], "cursor": <last seq>, "hasMore": bool }`

`seq` is the relay's arrival order and is **not** the events' own order. Stacki
sorts by `(lamport, id)` after decryption regardless of delivery order; the
cursor is only about what has been fetched.

### `GET /v2/rooms/:room/watch`

WebSocket. Because a browser-style `WebSocket` cannot set an `Authorization`
header, the credential travels as the second subprotocol:

```
Sec-WebSocket-Protocol: stacki-secure-review.v2, <token>
```

The server accepts by echoing `stacki-secure-review.v2`. The only message the
server sends is:

```json
{ "type": "head", "cursor": 184 }
```

A client that sees a higher cursor runs an ordinary HTTP sync. **No review data
travels over the WebSocket.** There is one synchronisation protocol; this is a
doorbell. If the socket never connects, everything still works.

---

## 15. Limits

Encrypted does not mean unlimited. A relay that accepted arbitrary ciphertext
would be an encrypted file host.

| limit | value |
|---|---|
| request body | 8 MiB |
| single ciphertext | 66 KiB (Stacki's 64 KiB event + GCM tag + slack) |
| envelopes per push | 100 |
| envelopes per pull page | 200 |
| members per room | 50 |
| open invitations per room | 20 |
| envelopes per room | 200 000 |
| stored ciphertext per room | 512 MiB |
| invitation lifetime | 7 days (minimum 1 s) |

## 16. Error codes

`bad_request` `bad_json` `bad_envelope` `bad_signature` `bad_sender` `bad_room`
`bad_key` `unauthorized` `bad_invite` `not_found` `room_ended` `member_exists`
`too_large` `too_many` `room_full` `rate_limited` `internal_error`

Mapped to `400 401 404 409 413 429 500` as in `relay/protocol.js`.

---

## 17. Retention

Clients are the durable owners of review history. The relay is a mailbox and a
catch-up cache.

- **Ending a room** deletes its relay state immediately.
- **An abandoned room** — no authenticated activity for **365 days** — is swept.

The retention window is one constant, there is no settings UI for it, and
self-hosted relays can change it. 90 days was the candidate and was rejected: a
review left open across a quiet quarter is an ordinary thing, and coming back to
a swept room costs a person an invitation they have to ask a colleague for.
Nothing about the longer window costs anything — the data is ciphertext and the
per-room byte cap is enforced separately.

There is no ACK-based deletion, no per-recipient bookkeeping, and no bootstrap
snapshot ownership. Those are the complications this design exists to avoid.

## 18. Rate limiting

Room creation, join attempts and invitation redemption are rate limited by
source. Rate limiting is **not** authorisation and is never relied on as such —
it is there so a public relay is not a free resource for anybody who finds it.
No accounts, no Turnstile.

## 19. Logging

Logging is part of the security model. Never logged, on any relay: the
`Authorization` header, member tokens, invitations, capabilities, room secrets,
private keys, request bodies, plaintext, ciphertext, nonces, or full URLs.

Coarse operational codes only: `room_created` `member_joined` `invite_redeemed`
`envelope_accepted` `rate_limited` `bad_signature` `internal_error`.

---

## 20. The share capability

```
stacki2.<base64url(JSON)>
```

where the JSON is exactly four fields:

```json
{ "r": "<relay origin>", "id": "<roomId>", "i": "<invitation>", "k": "<room secret>" }
```

Any extra field, any missing field, a non-canonical encoding, a room ID or
secret of the wrong length, or a relay origin that is not HTTPS-or-loopback is
refused outright.

### As a link

```
https://<share origin>/#stacki2....
```

The capability is the **fragment**. A browser does not put a fragment in the
request line, in a `Referer`, or anywhere a server can log it. The landing page
reads `location.hash`, keeps it in memory, and calls `history.replaceState()` to
take it out of the visible URL. `Open Stacki` happens only on an explicit click.

### As a deep link

```
stacki://join#stacki2....
```

`join` is the only action this protocol has. A deep link cannot execute a shell,
open a file, modify a project, invoke MCP, run git, or edit source — there is no
code path from the handler to any of those. Everything else about the URL is
validated before the capability is even parsed.

---

## 21. Local secret storage

Three secrets live on the client and none of them go in the project:

- the room master secret
- the member bearer token
- the room-specific Ed25519 private key

They are stored in Electron's `userData`, in a file that is `0600`, and
encrypted with Electron `safeStorage` when the platform provides an OS-backed
backend (macOS Keychain, Windows DPAPI, and on Linux whichever of
kwallet/gnome-libsecret is present).

**Linux honestly:** where no keyring backend is available, `safeStorage` reports
so and Stacki falls back to the `0600` file without encryption rather than
refusing to run. That is weaker, it is reported in diagnostics, and it is not
described to the user as if it were the same thing.

Tests inject a deterministic in-memory protector and never touch a real
keychain.

---

## 22. Legacy compatibility

The plaintext v1 Shared Reviews service is unchanged and keeps working. The two
transports sit behind the same interface:

- `legacy-http` — the existing `service/`, plaintext, signup tokens, workspaces
- `secure-relay-v2` — this document

New shares default to Secure Share. Existing legacy workspaces keep syncing.
There is **no automatic migration**, no silent conversion, and no surprise
upload; moving a legacy workspace to a secure room is a separate feature that
has not been designed.

---

## 23. Relay implementations

Two, and the protocol is what they have in common — Cloudflare is an
implementation, not the protocol.

### Node (`relay/node/`)

`node:http`, `node:sqlite`, `node:crypto`. No framework, no dependencies. One
SQLite file. This is what a self-hoster runs, and it is a first-class target:
every capability of Secure Share works against it with no Stacki account, no
Cloudflare account, and no proprietary anything.

### Cloudflare (`relay/cloudflare/`)

A Worker that routes, and **one SQLite-backed Durable Object per room** which
owns that room's authorisation state, members, invitations, envelope storage,
sequence assignment and WebSocket wake-ups. No D1, no KV, no R2, no Queues, no
Redis, no external SQL.

Both implementations run the same conformance suite (`test/relay-conformance.js`).
Neither imports `electron/review/events.js`; there is a test that greps for it.

### Durable Object schema

```
room_meta ( created_at, last_activity, owner_sender, ended_at,
            envelope_count, stored_bytes )
members   ( sender_id PK, public_key, token_hash, joined_at, left_at, is_owner )
invites   ( token_hash PK, created_by, created_at, expires_at, used_at )
envelopes ( seq INTEGER PK AUTOINCREMENT, envelope_id UNIQUE, sender_id,
            nonce, ciphertext, signature, received_at )
```

No plaintext review metadata appears in any column.

---

## 24. Test vectors

Room secret is bytes `00..1f`. Room ID is bytes `00..0f`. Signing seed is 32
bytes of `0x07`. Nonce is bytes `00..0b`. All base64url, unpadded.

```
room secret   AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
room ID       AAECAwQFBgcICQoLDA0ODw

K_CONTENT     D8ekrjAkOjEQJigEgF1-VOkZGu6T7ac9-SZ0mrW2xkg
K_SENDER_ID   -kmEGcfKH6Si7gHn7f--8XpMhVf4IsLkj1SWfIqQ6n4
K_ENVELOPE_ID fDbgW0QW4mgUV4jyyIXVDegyvrkiS7uRksQax1XBYqE

senderId("actor-alice")   DkyH8tlUVZFb8miOQJCIi_wL64ReSHQJ3O9NhJfCR-A
envelopeId("event-1")     pCBuwcUVDBr_JqMxTtOKfS3Qer6GAGQNa4T7KnIj9fo

signing seed  BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc
public key    6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw
nonce         AAECAwQFBgcICQoL
```

Event plaintext (exact JSON, key order as written):

```json
{"id":"event-1","threadId":"t","actorId":"actor-alice","actorKind":"human","actorName":"Alice","type":"message.created","lamport":1,"createdAt":0,"payload":{"body":"hello"}}
```

```
ciphertext  xLg2N-A8UlKbQJrm0ffK23JrutxztNE2SBrhkoNbMKYfMKzGJzovFDYINr7701YRp5muq-BvSsEYc-7Q
            naC6Zgz1K2oMhdrOP-A9GNPByFU3Kha_RkGe-qGv4R7vq3qgVj40mt7lFN-tFzxyo_XFstH43lfoar_n
            NFObt-a2V80dI7tnSaTJKsoNPUk_0vWL8l-P3iT640srM6ocIRnUYF-0mIlDkzCGe_4xJodQ4XVuP44i
            5uWxh42Sd7Zs
signature   XBWBZOGPcjACwFjD2KMYqIcTmqf3UbEiW37pD2LDZmUhmapdSjafQlZbnwQHd7XPq2ETOgSeFgfrqHCg
            sXFbBA
```

(The ciphertext and signature are one line each; wrapped here for reading.)

These are asserted in `test/secure-crypto.js`.

---

## 25. Self-hosting

```bash
node relay/node/bin.js
```

Prints the address it is listening on. Then in Stacki: **Share… → Advanced →
Use custom secure relay**, and paste that address. Nothing else is required —
no account, no token to copy, no Cloudflare, no Stacki service. Room creation on
a self-hosted relay is open by default and bounded by the same limits; bind it
to loopback or put it behind whatever your team already runs.

The Node relay also serves the share landing page at `/`, so a self-hoster's
invitation links work without depending on Stacki's hosted service at all.

For Cloudflare deployment instructions see `relay/cloudflare/README.md`.
