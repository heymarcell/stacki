// One suite, every relay.
//
// The Node relay and the Cloudflare Durable Object relay are two programs that
// have to behave identically, and "identically" is not a thing two people can
// hold in their heads while editing them separately. So the protocol's
// behaviour is written down exactly once, here, and both implementations are
// driven through it.
//
// It talks HTTP and nothing else — no store access, no internals, no imports
// from either implementation. Anything that needs to look inside a particular
// relay (its SQLite file, its log stream, its Durable Object storage) belongs
// in that implementation's own test, not in this one.
//
// WEBCRYPTO ONLY. Signing here uses `crypto.subtle` rather than `node:crypto`,
// for two reasons: it is the one API that exists unchanged in Node and in
// workerd, so this file runs in both without a shim; and it demonstrates that
// the protocol document is implementable from WebCrypto alone, which is the
// claim it makes to anybody writing a third relay.
//
// It never encrypts anything. A relay cannot decrypt, so a conformance suite
// has no reason to encrypt — the "ciphertext" below is random bytes, which is
// exactly what a relay is supposed to think every ciphertext is.

const { signingBytes, toBase64Url, fromBase64Url, MAX_CIPHERTEXT_BYTES, MAX_BATCH, MAX_PAGE } = require('../relay/protocol.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// How many checks a complete run makes.
//
// Asserted by both relays' test suites, so that a run which quietly stops
// early — an endpoint that 500s and takes a whole section with it, a helper
// that starts returning undefined — fails instead of reporting the checks it
// did get to as a pass. Raise it when you add a check; that is the point.
const CONFORMANCE_CHECKS = 80;

// `getRandomValues` refuses more than 64 KiB at a time, and the oversized
// ciphertext this suite deliberately builds is larger than that.
const randomBytes = (n) => {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
  return out;
};

/** A room-specific signing identity, the way a real client makes one. */
async function newMember() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: toBase64Url(raw),
    senderId: toBase64Url(randomBytes(32)),
    sign: async (bytes) => toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes))),
  };
}

/** A well formed envelope, signed, with opaque contents. */
async function envelopeFrom(member, roomId, { envelopeId = null, size = 64, senderId = null } = {}) {
  const ciphertext = randomBytes(size);
  const nonce = toBase64Url(randomBytes(12));
  const id = envelopeId || toBase64Url(randomBytes(32));
  const sender = senderId || member.senderId;
  const signature = await member.sign(
    signingBytes({ roomId, envelopeId: id, senderId: sender, nonce, ciphertext })
  );
  return { v: 2, envelopeId: id, senderId: sender, nonce, ciphertext: toBase64Url(ciphertext), signature };
}

/**
 * Run the whole suite against one relay.
 *
 * `call(path, options)` does one request and answers `{ status, body }`. It is
 * injected because a Node relay is reached over a real socket and a Worker
 * under test is reached through its own dispatcher, and neither should have to
 * pretend to be the other.
 */
async function runConformance({ call, label = 'relay' }) {
  const failures = [];
  let checked = 0;
  const check = (what, condition, detail) => {
    checked++;
    if (!condition) failures.push(`  [${label}] ${what}${detail ? `\n    ${detail}` : ''}`);
    return !!condition;
  };

  const json = (path, options = {}) => call(path, options);
  const asMember = (token, options = {}) => ({ ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });

  // --- creating a room ------------------------------------------------------

  const alice = await newMember();
  const roomId = toBase64Url(randomBytes(16));

  const created = await json('/v2/rooms', { method: 'POST', body: { roomId, senderId: alice.senderId, publicKey: alice.publicKey } });
  check('a room can be created', created.status === 200, JSON.stringify(created.body));
  const aliceToken = created.body?.credential?.token;
  check('creating a room issues a credential', typeof aliceToken === 'string' && aliceToken.length >= 22);
  check('the created room answers with its id', created.body?.room?.id === roomId);

  check(
    'the same room id cannot be created twice',
    (await json('/v2/rooms', { method: 'POST', body: { roomId, senderId: alice.senderId, publicKey: alice.publicKey } })).status === 409
  );

  for (const [what, body] of [
    ['a short room id', { roomId: toBase64Url(randomBytes(8)), senderId: alice.senderId, publicKey: alice.publicKey }],
    ['a short sender id', { roomId: toBase64Url(randomBytes(16)), senderId: toBase64Url(randomBytes(8)), publicKey: alice.publicKey }],
    ['a short public key', { roomId: toBase64Url(randomBytes(16)), senderId: alice.senderId, publicKey: toBase64Url(randomBytes(8)) }],
    ['a missing room id', { senderId: alice.senderId, publicKey: alice.publicKey }],
    ['a non base64url room id', { roomId: 'not+base64url/at-all', senderId: alice.senderId, publicKey: alice.publicKey }],
  ]) {
    check(`creating a room with ${what} is refused`, (await json('/v2/rooms', { method: 'POST', body })).status === 400);
  }

  // --- authentication -------------------------------------------------------

  check('a room cannot be read without a credential', (await json(`/v2/rooms/${roomId}`)).status === 401);
  check('a room cannot be read with a wrong credential', (await json(`/v2/rooms/${roomId}`, asMember('not-a-real-token'))).status === 401);
  check('a room can be read by its member', (await json(`/v2/rooms/${roomId}`, asMember(aliceToken))).status === 200);

  const unknownRoom = toBase64Url(randomBytes(16));
  // Every way of not being in a room answers the same. Anything that told a
  // wrong credential apart from a valid one for a different room would let
  // somebody holding one token find out which other rooms exist.
  check(
    'a room this credential is not in refuses without confirming it exists',
    (await json(`/v2/rooms/${unknownRoom}`, asMember(aliceToken))).status === 401
  );

  const status = await json(`/v2/rooms/${roomId}`, asMember(aliceToken));
  check('the room status names this member', status.body?.member?.senderId === alice.senderId);
  check('the creator is the owner', status.body?.member?.isOwner === true);
  check('the room status lists members with their keys', status.body?.members?.[0]?.publicKey === alice.publicKey);
  check('a fresh room has a zero head', status.body?.head === 0);
  check('the room status carries no plaintext review metadata', !JSON.stringify(status.body).includes('thread'));

  // --- invitations ----------------------------------------------------------

  const invited = await json(`/v2/rooms/${roomId}/invites`, asMember(aliceToken, { method: 'POST', body: {} }));
  check('a member can create an invitation', invited.status === 200 && typeof invited.body?.invite === 'string');
  check('an invitation expires', Number.isInteger(invited.body?.expiresAt));

  const bob = await newMember();
  const joined = await json('/v2/join', {
    method: 'POST',
    body: { roomId, invite: invited.body.invite, senderId: bob.senderId, publicKey: bob.publicKey },
  });
  check('an invitation can be redeemed', joined.status === 200);
  const bobToken = joined.body?.credential?.token;
  check('joining issues a credential', typeof bobToken === 'string' && bobToken.length >= 22);
  check('joining returns the members already there', (joined.body?.members || []).some((m) => m.senderId === alice.senderId));
  check('joining returns their pinning keys', (joined.body?.members || []).some((m) => m.publicKey === alice.publicKey));
  check('the joiner is not the owner', (await json(`/v2/rooms/${roomId}`, asMember(bobToken))).body?.member?.isOwner === false);

  const carol = await newMember();
  check(
    'an invitation cannot be redeemed twice',
    (await json('/v2/join', { method: 'POST', body: { roomId, invite: invited.body.invite, senderId: carol.senderId, publicKey: carol.publicKey } })).status === 401
  );
  check(
    'an invitation that never existed is refused the same way',
    (await json('/v2/join', { method: 'POST', body: { roomId, invite: toBase64Url(randomBytes(32)), senderId: carol.senderId, publicKey: carol.publicKey } })).status === 401
  );
  check(
    'an invitation for another room is refused',
    (await json('/v2/join', { method: 'POST', body: { roomId: unknownRoom, invite: invited.body.invite, senderId: carol.senderId, publicKey: carol.publicKey } })).status === 401
  );

  // Expiry, observed rather than asserted from the code.
  const shortLived = await json(`/v2/rooms/${roomId}/invites`, asMember(aliceToken, { method: 'POST', body: { ttlMs: 1000 } }));
  await wait(1300);
  check(
    'an expired invitation cannot be redeemed',
    (await json('/v2/join', { method: 'POST', body: { roomId, invite: shortLived.body.invite, senderId: carol.senderId, publicKey: carol.publicKey } })).status === 401
  );

  // The race. Two redemptions of one invitation, started together: exactly one
  // may win, and it must be atomic rather than "usually".
  const raced = await json(`/v2/rooms/${roomId}/invites`, asMember(aliceToken, { method: 'POST', body: {} }));
  const racers = await Promise.all([newMember(), newMember()]);
  const outcomes = await Promise.all(
    racers.map((m) => json('/v2/join', { method: 'POST', body: { roomId, invite: raced.body.invite, senderId: m.senderId, publicKey: m.publicKey } }))
  );
  check(
    'exactly one of two simultaneous redemptions succeeds',
    outcomes.filter((o) => o.status === 200).length === 1,
    outcomes.map((o) => o.status).join(',')
  );

  // --- pushing --------------------------------------------------------------

  const first = await envelopeFrom(alice, roomId);
  const pushed = await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: [first] } }));
  check('an envelope can be pushed', pushed.status === 200 && pushed.body?.accepted?.[0] === first.envelopeId);
  check('pushing moves the cursor', pushed.body?.cursor >= 1);

  const again = await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: [first] } }));
  check('a duplicate envelope is accepted rather than refused', again.status === 200 && again.body?.accepted?.[0] === first.envelopeId);
  check('a duplicate envelope is not stored twice', again.body?.cursor === pushed.body?.cursor, `${again.body?.cursor} vs ${pushed.body?.cursor}`);

  // A member may only speak as themselves.
  const asAlice = await envelopeFrom(bob, roomId, { senderId: alice.senderId });
  const impersonated = await json(`/v2/rooms/${roomId}/envelopes`, asMember(bobToken, { method: 'POST', body: { envelopes: [asAlice] } }));
  check('an envelope claiming another member is refused', impersonated.body?.rejected?.[0]?.code === 'bad_sender', JSON.stringify(impersonated.body));
  check('an envelope claiming another member is not stored', (impersonated.body?.accepted || []).length === 0);

  // A signature that does not verify.
  const tampered = await envelopeFrom(bob, roomId);
  const flipped = fromBase64Url(tampered.ciphertext);
  flipped[0] ^= 0xff;
  const broken = { ...tampered, ciphertext: toBase64Url(flipped) };
  const badSig = await json(`/v2/rooms/${roomId}/envelopes`, asMember(bobToken, { method: 'POST', body: { envelopes: [broken] } }));
  check('an envelope whose signature does not verify is refused', badSig.body?.rejected?.[0]?.code === 'bad_signature', JSON.stringify(badSig.body));

  // An envelope signed for another room, replayed into this one.
  const elsewhere = await envelopeFrom(bob, toBase64Url(randomBytes(16)));
  const replayed = await json(`/v2/rooms/${roomId}/envelopes`, asMember(bobToken, { method: 'POST', body: { envelopes: [elsewhere] } }));
  check('an envelope signed for another room is refused', replayed.body?.rejected?.[0]?.code === 'bad_signature');

  for (const [what, envelope] of [
    ['a missing field', (() => { const e = { ...first }; delete e.signature; return e; })()],
    ['an extra field', { ...first, seq: 1 }],
    ['the wrong version', { ...first, v: 3 }],
    ['a short nonce', { ...first, nonce: toBase64Url(randomBytes(8)) }],
    ['a short signature', { ...first, signature: toBase64Url(randomBytes(32)) }],
    ['a short envelope id', { ...first, envelopeId: toBase64Url(randomBytes(8)) }],
    ['a padded base64 value', { ...first, nonce: `${first.nonce}=` }],
    ['a ciphertext below the tag size', { ...first, ciphertext: toBase64Url(randomBytes(8)) }],
    ['a non object', 'not an envelope'],
  ]) {
    const answer = await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: [envelope] } }));
    check(`an envelope with ${what} is refused`, (answer.body?.accepted || []).length === 0 && (answer.body?.rejected || []).length === 1, JSON.stringify(answer.body));
  }

  check(
    'envelopes must be a list',
    (await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: 'nope' } }))).status === 400
  );
  const overBatch = await Promise.all(Array.from({ length: MAX_BATCH + 1 }, () => envelopeFrom(alice, roomId)));
  check(
    'a batch over the limit is refused',
    (await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: overBatch } }))).status === 413
  );

  const oversized = await envelopeFrom(alice, roomId, { size: MAX_CIPHERTEXT_BYTES + 32 });
  const tooBig = await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: [oversized] } }));
  check('an oversized ciphertext is refused', tooBig.body?.rejected?.[0]?.code === 'too_large' || tooBig.status === 413, JSON.stringify(tooBig.body).slice(0, 120));

  // --- pulling --------------------------------------------------------------

  const batch = await Promise.all(Array.from({ length: 12 }, () => envelopeFrom(bob, roomId)));
  const sent = await json(`/v2/rooms/${roomId}/envelopes`, asMember(bobToken, { method: 'POST', body: { envelopes: batch } }));
  check('a batch is accepted whole', sent.body?.accepted?.length === 12, JSON.stringify(sent.body).slice(0, 200));

  const all = await json(`/v2/rooms/${roomId}/envelopes?after=0&limit=200`, asMember(aliceToken));
  check('everything can be pulled', all.status === 200 && all.body.envelopes.length === 13, `${all.body?.envelopes?.length}`);
  check('a pulled envelope carries its sequence', Number.isInteger(all.body.envelopes[0].seq));
  check('a pulled envelope carries its arrival time', Number.isInteger(all.body.envelopes[0].receivedAt));
  check('sequences are strictly increasing', all.body.envelopes.every((e, i, list) => i === 0 || e.seq > list[i - 1].seq));
  check('the cursor is the last sequence', all.body.cursor === all.body.envelopes[all.body.envelopes.length - 1].seq);
  check('a full read has no more', all.body.hasMore === false);
  check('a pulled envelope round trips its ciphertext', all.body.envelopes.some((e) => e.ciphertext === first.ciphertext));

  const page = await json(`/v2/rooms/${roomId}/envelopes?after=0&limit=5`, asMember(aliceToken));
  check('a page is the size asked for', page.body.envelopes.length === 5);
  check('a short page says there is more', page.body.hasMore === true);
  const next = await json(`/v2/rooms/${roomId}/envelopes?after=${page.body.cursor}&limit=5`, asMember(aliceToken));
  check('paging continues after the cursor', next.body.envelopes[0].seq > page.body.cursor);
  check('paging does not repeat', !next.body.envelopes.some((e) => page.body.envelopes.some((p) => p.seq === e.seq)));

  const beyond = await json(`/v2/rooms/${roomId}/envelopes?after=${all.body.cursor}`, asMember(aliceToken));
  check('pulling past the head is empty rather than an error', beyond.status === 200 && beyond.body.envelopes.length === 0);
  check('an empty page keeps the cursor', beyond.body.cursor === all.body.cursor);
  check(
    'a pull page is capped',
    (await json(`/v2/rooms/${roomId}/envelopes?after=0&limit=99999`, asMember(aliceToken))).body.envelopes.length <= MAX_PAGE
  );

  // --- leaving --------------------------------------------------------------

  const leaver = await newMember();
  const leaveInvite = await json(`/v2/rooms/${roomId}/invites`, asMember(aliceToken, { method: 'POST', body: {} }));
  const leaveJoin = await json('/v2/join', {
    method: 'POST',
    body: { roomId, invite: leaveInvite.body.invite, senderId: leaver.senderId, publicKey: leaver.publicKey },
  });
  const leaverToken = leaveJoin.body.credential.token;
  check('a member can read before leaving', (await json(`/v2/rooms/${roomId}`, asMember(leaverToken))).status === 200);
  check('a member can leave', (await json(`/v2/rooms/${roomId}/membership/me`, asMember(leaverToken, { method: 'DELETE' }))).status === 200);
  check('a member who left cannot read', (await json(`/v2/rooms/${roomId}`, asMember(leaverToken))).status === 401);
  const afterLeaving = await envelopeFrom(leaver, roomId);
  check(
    'a member who left cannot push',
    (await json(`/v2/rooms/${roomId}/envelopes`, asMember(leaverToken, { method: 'POST', body: { envelopes: [afterLeaving] } }))).status === 401
  );
  check(
    'what a departed member already said is still there',
    (await json(`/v2/rooms/${roomId}`, asMember(aliceToken))).body.members.some((m) => m.senderId === leaver.senderId && m.publicKey === leaver.publicKey)
  );

  // --- ending ---------------------------------------------------------------

  check(
    'a member who is not the owner cannot end the room',
    (await json(`/v2/rooms/${roomId}`, asMember(bobToken, { method: 'DELETE' }))).status === 401
  );
  check('the room is still there after a refused end', (await json(`/v2/rooms/${roomId}`, asMember(aliceToken))).status === 200);
  check('the owner can end the room', (await json(`/v2/rooms/${roomId}`, asMember(aliceToken, { method: 'DELETE' }))).status === 200);

  const gone = await json(`/v2/rooms/${roomId}`, asMember(aliceToken));
  check('an ended room refuses its owner', gone.status === 401, `${gone.status}`);
  check('an ended room refuses its members', (await json(`/v2/rooms/${roomId}`, asMember(bobToken))).status === 401);
  const orphan = await envelopeFrom(alice, roomId);
  check(
    'an ended room takes no more envelopes',
    (await json(`/v2/rooms/${roomId}/envelopes`, asMember(aliceToken, { method: 'POST', body: { envelopes: [orphan] } }))).status === 401
  );
  check(
    'an invitation to an ended room cannot be redeemed',
    (await json('/v2/join', { method: 'POST', body: { roomId, invite: leaveInvite.body.invite, senderId: carol.senderId, publicKey: carol.publicKey } })).status === 401
  );

  // --- the shape of failure -------------------------------------------------

  const notThere = await json('/v2/nothing-here');
  check('an unknown endpoint is a not found', notThere.status === 404);
  check('an error names a stable code', typeof notThere.body?.error === 'string');
  check('an error carries no stack trace', !JSON.stringify(notThere.body).includes('at '));

  return { checked, failures };
}

module.exports = { runConformance, newMember, envelopeFrom, randomBytes, CONFORMANCE_CHECKS };
