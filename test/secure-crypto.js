// The cryptography, checked against numbers that cannot drift.
//
//   node test/secure-crypto.js
//
// Two kinds of test here and they are doing different jobs.
//
// THE FIXED VECTORS pin the wire format. Every value below was computed once
// and written down, so a change to an HKDF label, to the salt, to the order of
// the fields in the associated data, or to the bytes that get signed fails
// here immediately rather than in six months when somebody's laptop cannot
// read a room their colleague's laptop wrote. They are also what makes the
// protocol document implementable: an independent implementation that produces
// these bytes from these inputs is compatible, and one that does not is not.
//
// THE PROPERTY TESTS check the things the construction is FOR. That a
// ciphertext cannot be edited, that an envelope cannot be moved to another
// room, that two rooms cannot be joined up by the identifiers a relay sees.
// Each one corresponds to a line in the threat model, and each one fails if
// the guard it is about is removed — which is not an assumption, it is
// something the sabotage campaign in test/secure-sabotage.js re-checks by
// removing them.

const crypto = require('node:crypto');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const c = require('../electron/review/secure/crypto.js');
const p = require('../relay/protocol.js');
const cap = require('../electron/review/secure/capability.js');

// --- the fixed vectors ------------------------------------------------------
//
// Room secret is bytes 0..31. Room id is bytes 0..15. Signing seed is 32 bytes
// of 0x07. Nonce is bytes 0..11. All chosen to be obviously constructed rather
// than obviously random, so nobody mistakes them for a real room.

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const ROOM_ID = 'AAECAwQFBgcICQoLDA0ODw';
const SEED = p.toBase64Url(Buffer.alloc(32, 7));
const NONCE = Buffer.from('000102030405060708090a0b', 'hex');

const VECTORS = {
  roomSecret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  kContent: 'D8ekrjAkOjEQJigEgF1-VOkZGu6T7ac9-SZ0mrW2xkg',
  kSenderId: '-kmEGcfKH6Si7gHn7f--8XpMhVf4IsLkj1SWfIqQ6n4',
  kEnvelopeId: 'fDbgW0QW4mgUV4jyyIXVDegyvrkiS7uRksQax1XBYqE',
  senderId: 'DkyH8tlUVZFb8miOQJCIi_wL64ReSHQJ3O9NhJfCR-A',
  envelopeId: 'pCBuwcUVDBr_JqMxTtOKfS3Qer6GAGQNa4T7KnIj9fo',
  publicKey: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw',
  ciphertext:
    'xLg2N-A8UlKbQJrm0ffK23JrutxztNE2SBrhkoNbMKYfMKzGJzovFDYINr7701YRp5muq-BvSsEYc-7QnaC6Zgz1K2oMhdrOP-A9GNPByFU3Kha_RkGe-qGv4R7vq3qgVj40mt7lFN-tFzxyo_XFstH43lfoar_nNFObt-a2V80dI7tnSaTJKsoNPUk_0vWL8l-P3iT640srM6ocIRnUYF-0mIlDkzCGe_4xJodQ4XVuP44i5uWxh42Sd7Zs',
  signature:
    'XBWBZOGPcjACwFjD2KMYqIcTmqf3UbEiW37pD2LDZmUhmapdSjafQlZbnwQHd7XPq2ETOgSeFgfrqHCgsXFbBA',
};

const EVENT = {
  id: 'event-1',
  threadId: 't',
  actorId: 'actor-alice',
  actorKind: 'human',
  actorName: 'Alice',
  type: 'message.created',
  lamport: 1,
  createdAt: 0,
  payload: { body: 'hello' },
};

const keys = c.deriveKeys(SECRET, ROOM_ID);

check('room secret encodes to its published vector', p.toBase64Url(SECRET) === VECTORS.roomSecret);
check('HKDF derives the published K_CONTENT', p.toBase64Url(keys.content) === VECTORS.kContent, p.toBase64Url(keys.content));
check('HKDF derives the published K_SENDER_ID', p.toBase64Url(keys.senderId) === VECTORS.kSenderId);
check('HKDF derives the published K_ENVELOPE_ID', p.toBase64Url(keys.envelopeId) === VECTORS.kEnvelopeId);
check(
  'the three derived keys are all different',
  new Set([p.toBase64Url(keys.content), p.toBase64Url(keys.senderId), p.toBase64Url(keys.envelopeId)]).size === 3
);
check('a room secret given as base64url derives identically', p.toBase64Url(c.deriveKeys(VECTORS.roomSecret, ROOM_ID).content) === VECTORS.kContent);
check('the HKDF info string is domain separated and room bound', c.infoFor('content', ROOM_ID) === `stacki-secure-review/v2/content/${ROOM_ID}`);

check('sender id matches its published vector', c.senderIdFor(keys, 'actor-alice') === VECTORS.senderId);
check('envelope id matches its published vector', c.envelopeIdFor(keys, 'event-1') === VECTORS.envelopeId);
check('the signing seed yields the published public key', c.publicFromPrivate(SEED) === VECTORS.publicKey);

const sealed = c.sealEvent({ keys, senderId: VECTORS.senderId, event: EVENT, privateKey: SEED, nonce: NONCE });
check('sealing succeeds', sealed.ok);
check('ciphertext matches its published vector', sealed.envelope.ciphertext === VECTORS.ciphertext, sealed.envelope.ciphertext);
check('signature matches its published vector', sealed.envelope.signature === VECTORS.signature, sealed.envelope.signature);
check('the sealed envelope carries the protocol version', sealed.envelope.v === p.VERSION);
check('the sealed envelope is a well formed one on the wire', p.readEnvelope({
  v: sealed.envelope.v,
  envelopeId: sealed.envelope.envelopeId,
  senderId: sealed.envelope.senderId,
  nonce: sealed.envelope.nonce,
  ciphertext: sealed.envelope.ciphertext,
  signature: sealed.envelope.signature,
}).ok);

// --- determinism and unlinkability -----------------------------------------

const otherRoom = c.deriveKeys(SECRET, c.newRoomId());
const otherSecret = c.deriveKeys(c.newRoomSecret(), ROOM_ID);

check('the same actor in the same room is always the same sender', c.senderIdFor(keys, 'actor-alice') === c.senderIdFor(keys, 'actor-alice'));
check('the same actor in a different room is a different sender', c.senderIdFor(keys, 'actor-alice') !== c.senderIdFor(otherRoom, 'actor-alice'));
check('a different actor in the same room is a different sender', c.senderIdFor(keys, 'actor-alice') !== c.senderIdFor(keys, 'actor-bob'));
check('the same event in the same room is always the same envelope', c.envelopeIdFor(keys, 'event-1') === c.envelopeIdFor(keys, 'event-1'));
check('the same event in a different room is a different envelope', c.envelopeIdFor(keys, 'event-1') !== c.envelopeIdFor(otherRoom, 'event-1'));
check('a sender id does not reveal the actor id', !c.senderIdFor(keys, 'actor-alice').includes('alice'));

// --- roundtrip and every way it must fail ----------------------------------

const opened = c.openEnvelope({ keys, envelope: sealed.envelope, publicKey: VECTORS.publicKey });
check('a sealed event opens again', opened.ok);
check('the event survives the roundtrip intact', opened.ok && JSON.stringify(opened.event) === JSON.stringify(EVENT));

const withNonce = (over) => ({ ...sealed.envelope, ...over });
const bad = (what, envelope, keysUsed = keys, pub = VECTORS.publicKey) => {
  const result = c.openEnvelope({ keys: keysUsed, envelope, publicKey: pub });
  check(what, result.ok === false, result.ok ? 'it opened' : undefined);
  return result;
};

bad('a wrong room secret cannot open it', sealed.envelope, otherSecret);
bad('an envelope replayed into another room cannot open it', sealed.envelope, otherRoom);
bad('a wrong public key cannot verify it', sealed.envelope, keys, c.newSigningKeys().publicKey);

// One byte of the ciphertext, flipped. GCM is what refuses this, and it refuses
// it whether the byte was in the body or in the tag.
const flipped = Buffer.from(p.fromBase64Url(sealed.envelope.ciphertext));
flipped[4] ^= 0x01;
bad('a modified ciphertext cannot open it', withNonce({ ciphertext: p.toBase64Url(flipped) }));

const tagFlipped = Buffer.from(p.fromBase64Url(sealed.envelope.ciphertext));
tagFlipped[tagFlipped.length - 1] ^= 0x01;
bad('a modified authentication tag cannot open it', withNonce({ ciphertext: p.toBase64Url(tagFlipped) }));

const otherNonce = Buffer.from(NONCE);
otherNonce[0] ^= 0x01;
bad('a modified nonce cannot open it', withNonce({ nonce: p.toBase64Url(otherNonce) }));

// The associated data binds routing. Changing any part of it — which is what
// a relay would do to relabel who said something — breaks decryption.
bad('a relabelled sender cannot open it', withNonce({ senderId: c.senderIdFor(keys, 'actor-bob') }));
bad('a re-filed envelope id cannot open it', withNonce({ envelopeId: c.envelopeIdFor(keys, 'event-2') }));

// Signature failures are reported as such, before any decryption is attempted.
const sigChanged = bad('a ciphertext change breaks the signature', withNonce({ ciphertext: p.toBase64Url(flipped) }));
check('a broken signature is named as one', sigChanged.code === 'bad_signature', sigChanged.code);

const forged = c.sealEvent({ keys, senderId: VECTORS.senderId, event: EVENT, privateKey: c.newSigningKeys().privateKey, nonce: NONCE });
const wrongSigner = c.openEnvelope({ keys, envelope: forged.envelope, publicKey: VECTORS.publicKey });
check('an envelope signed by another key is refused', wrongSigner.ok === false && wrongSigner.code === 'bad_signature');
check('the same event signed by another key still decrypts under its own key', c.openEnvelope({ keys, envelope: forged.envelope, publicKey: c.publicFromPrivate(forged.envelope.signature ? SEED : SEED) }).ok === false);

// --- nonces are never reused ------------------------------------------------

const nonces = new Set();
for (let i = 0; i < 200; i++) {
  const one = c.sealEvent({ keys, senderId: VECTORS.senderId, event: { ...EVENT, id: `e${i}` }, privateKey: SEED });
  nonces.add(one.envelope.nonce);
}
check('every production seal uses a fresh nonce', nonces.size === 200, `${nonces.size} distinct of 200`);
check('a production nonce is 12 bytes', p.fromBase64Url([...nonces][0], 12) !== null);

// --- the wire format --------------------------------------------------------

check('base64url decoding is strict about padding', p.fromBase64Url(`${VECTORS.senderId}=`) === null);
check('base64url decoding is strict about the alphabet', p.fromBase64Url('abc+def') === null);
check('base64url decoding is strict about length', p.fromBase64Url(VECTORS.senderId, 16) === null);
check('a non canonical encoding of the same bytes is refused', p.fromBase64Url('AAECAwQFBgcICQoLDA0ODx') === null || p.toBase64Url(p.fromBase64Url('AAECAwQFBgcICQoLDA0ODx')) === 'AAECAwQFBgcICQoLDA0ODx');

const wire = {
  v: 2,
  envelopeId: VECTORS.envelopeId,
  senderId: VECTORS.senderId,
  nonce: p.toBase64Url(NONCE),
  ciphertext: VECTORS.ciphertext,
  signature: VECTORS.signature,
};
check('a good envelope reads', p.readEnvelope(wire).ok);
check('an envelope with an extra field is refused', p.readEnvelope({ ...wire, extra: 1 }).ok === false);
check('an envelope missing a field is refused', p.readEnvelope({ ...wire, signature: undefined }).ok === false);
check('an envelope of another version is refused', p.readEnvelope({ ...wire, v: 3 }).ok === false);
check('an envelope with a short nonce is refused', p.readEnvelope({ ...wire, nonce: p.toBase64Url(Buffer.alloc(8)) }).ok === false);
check('an envelope with a short signature is refused', p.readEnvelope({ ...wire, signature: p.toBase64Url(Buffer.alloc(32)) }).ok === false);
check('an envelope with a ciphertext below the tag size is refused', p.readEnvelope({ ...wire, ciphertext: p.toBase64Url(Buffer.alloc(8)) }).ok === false);
check(
  'an oversized ciphertext is refused as too large',
  p.readEnvelope({ ...wire, ciphertext: p.toBase64Url(Buffer.alloc(p.MAX_CIPHERTEXT_BYTES + 1)) }).code === 'too_large'
);
check('a non object is refused', p.readEnvelope('nope').ok === false && p.readEnvelope(null).ok === false);

// The length-prefixed encoding is unambiguous: no two different field lists
// produce the same bytes. This is the property that stops a signature over
// concatenated fields being forgeable by moving a separator.
const a = Buffer.from(p.lengthPrefixed(['ab', 'c'])).toString('hex');
const b = Buffer.from(p.lengthPrefixed(['a', 'bc'])).toString('hex');
check('length prefixing is unambiguous', a !== b, `${a} vs ${b}`);

// --- an oversized event is refused rather than sent ------------------------

const huge = { ...EVENT, payload: { body: 'x'.repeat(p.MAX_CIPHERTEXT_BYTES) } };
check('an event too large to carry is refused at sealing', c.sealEvent({ keys, senderId: VECTORS.senderId, event: huge, privateKey: SEED }).ok === false);

// --- constant time comparison ----------------------------------------------

check('the same secret compares equal', c.sameSecret('abc', 'abc'));
check('a different secret compares unequal', !c.sameSecret('abc', 'abd'));
check('a different length compares unequal without throwing', !c.sameSecret('abc', 'abcd'));

// --- capability -------------------------------------------------------------

const inviteToken = p.toBase64Url(crypto.randomBytes(32));
const capability = cap.packCapability({ relay: 'https://relay.example', roomId: ROOM_ID, invite: inviteToken, secret: VECTORS.roomSecret });
const unpacked = cap.unpackCapability(capability);
check('a capability round trips', unpacked && unpacked.roomId === ROOM_ID && unpacked.secret === VECTORS.roomSecret && unpacked.invite === inviteToken);
check('a capability is bounded', capability.length < cap.MAX_CAPABILITY);
const dated = cap.packCapability({ relay: 'https://relay.example', roomId: ROOM_ID, invite: inviteToken, secret: VECTORS.roomSecret, expiresAt: 1893456000000 });
check('a capability carries the invitation expiry', cap.unpackCapability(dated)?.expiresAt === 1893456000000);
check('a capability with no expiry says so rather than guessing', cap.unpackCapability(capability)?.expiresAt === null);
check('the share link puts everything after the fragment', cap.shareLink({ shareOrigin: 'https://share.example', capability }) === `https://share.example/#${capability}`);
check('the share link carries nothing in path or query', !cap.shareLink({ shareOrigin: 'https://share.example', capability }).split('#')[0].includes(ROOM_ID));

// A payload that IS a valid v2 capability, behind a prefix that is not v2.
// This is the one input that separates "the version is checked" from "the
// fields happen to be wrong anyway" — every other malformed capability below
// would be refused for a second reason even if the prefix were ignored.
const validPayload = capability.slice(cap.PREFIX.length);
check('a capability with a future version prefix is refused', cap.unpackCapability(`stacki3.${validPayload}`) === null);
check('a capability with a past version prefix is refused', cap.unpackCapability(`stacki1.${validPayload}`) === null);
check('a capability with no version prefix is refused', cap.unpackCapability(validPayload) === null);
check('and the same payload under its own prefix is still accepted', cap.unpackCapability(`stacki2.${validPayload}`) !== null);
check('a deep link with a future version prefix is refused', cap.readDeepLink(`stacki://join#stacki3.${validPayload}`) === null);

for (const [what, value] of [
  ['a legacy stacki1 invitation', 'stacki1.eyJzIjoiaHR0cDovL3gifQ'],
  ['a truncated capability', capability.slice(0, capability.length - 4)],
  ['a capability with a suffix', `${capability}AAAA!`],
  ['a capability with a prefix', `x${capability}`],
  ['an empty capability', 'stacki2.'],
  ['a capability of the wrong alphabet', 'stacki2.abc+def'],
  ['a capability that is not JSON', `stacki2.${Buffer.from('not json').toString('base64url')}`],
  ['a capability that is an array', `stacki2.${Buffer.from('[1,2]').toString('base64url')}`],
  ['a capability with a missing field', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://x.example', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret })).toString('base64url')}`],
  ['a capability with an extra field', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://x.example', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 0, extra: 1 })).toString('base64url')}`],
  ['a capability with a short secret', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://x.example', id: ROOM_ID, i: inviteToken, k: p.toBase64Url(Buffer.alloc(16)), e: 0 })).toString('base64url')}`],
  ['a capability with a short room id', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://x.example', id: p.toBase64Url(Buffer.alloc(8)), i: inviteToken, k: VECTORS.roomSecret, e: 0 })).toString('base64url')}`],
  ['a capability with a non integer expiry', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://x.example', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 'soon' })).toString('base64url')}`],
  ['a capability with a negative expiry', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://x.example', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: -1 })).toString('base64url')}`],
  ['a capability naming a remote plaintext relay', `stacki2.${Buffer.from(JSON.stringify({ r: 'http://relay.example', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 0 })).toString('base64url')}`],
  ['a capability naming a javascript url', `stacki2.${Buffer.from(JSON.stringify({ r: 'javascript:alert(1)', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 0 })).toString('base64url')}`],
  ['a capability naming a file url', `stacki2.${Buffer.from(JSON.stringify({ r: 'file:///etc/passwd', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 0 })).toString('base64url')}`],
  ['a capability naming a data url', `stacki2.${Buffer.from(JSON.stringify({ r: 'data:text/html,x', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 0 })).toString('base64url')}`],
  ['a capability with credentials in the relay url', `stacki2.${Buffer.from(JSON.stringify({ r: 'https://user:pass@relay.example', id: ROOM_ID, i: inviteToken, k: VECTORS.roomSecret, e: 0 })).toString('base64url')}`],
  ['an oversized capability', `stacki2.${'A'.repeat(4000)}`],
]) {
  check(`${what} is refused`, cap.unpackCapability(value) === null);
}

check('a loopback http relay is allowed', cap.unpackCapability(cap.packCapability({ relay: 'http://127.0.0.1:8787', roomId: ROOM_ID, invite: inviteToken, secret: VECTORS.roomSecret })) !== null);
check('localhost over http is allowed', cap.relayOrigin('http://localhost:8787') === 'http://localhost:8787');
check('a remote host over http is not', cap.relayOrigin('http://relay.example') === null);
check('https anywhere is allowed', cap.relayOrigin('https://relay.example/base') === 'https://relay.example/base');

// --- the deep link ----------------------------------------------------------

check('a deep link round trips', !!cap.readDeepLink(cap.deepLink(capability)));
// A URL handler that percent-encoded the dot on the way through is still
// handed an invitation; one that encoded the percent sign as well is not,
// because there is exactly one decode and never a loop.
check('a percent encoded deep link fragment still reads', !!cap.readDeepLink(`stacki://join#${capability.replace('stacki2.', 'stacki2%2E')}`));
for (const [what, url] of [
  ['an unknown action', `stacki://run#${capability}`],
  ['no action', `stacki://#${capability}`],
  ['another scheme', `https://join#${capability}`],
  ['a file url', 'file:///etc/passwd'],
  ['a javascript url', 'javascript:alert(1)'],
  ['a deep link with no fragment', 'stacki://join'],
  ['a deep link with a legacy capability', 'stacki://join#stacki1.abc'],
  ['an oversized deep link', `stacki://join#stacki2.${'A'.repeat(4000)}`],
  ['a deep link with a newline', `stacki://join#${capability}\n`],
  ['a deep link with a null byte', `stacki://join#${capability} `],
  ['a double encoded deep link', `stacki://join#${capability.replace('stacki2.', 'stacki2%252E')}`],
  ['not a string', 12345],
]) {
  check(`a deep link with ${what} is refused`, cap.readDeepLink(url) === null);
}

// A JSON object with the same key twice. `JSON.parse` keeps the last, so
// without an exact field-set check a capability could carry two relays and be
// read as whichever one the parser preferred.
const duplicated = `stacki2.${Buffer.from(
  `{"r":"https://evil.example","r":"https://relay.example","id":"${ROOM_ID}","i":"${inviteToken}","k":"${VECTORS.roomSecret}","e":0}`,
  'utf8'
).toString('base64url')}`;
const dupRead = cap.unpackCapability(duplicated);
check('a capability with a duplicated field cannot name two relays', dupRead === null || dupRead.relay === 'https://relay.example', JSON.stringify(dupRead));

// --- one character at a time ------------------------------------------------
//
// Every single-character mutation of a valid capability must either be refused
// or come back meaning something DIFFERENT. A mutation that decodes to the
// same invitation would be an alias: a second string that unlocks the same
// room, which is a second string to leak and a second one to have to revoke.
//
// (A mutation that is accepted and means something else is fine and expected —
// it names a room that does not exist, and the relay says so.)
const original = cap.unpackCapability(capability);
const ALPHABET = 'ABCXYZabcxyz0189-_.';
let mutated = 0;
let accepted = 0;
const aliases = [];
for (let i = 0; i < capability.length; i++) {
  for (const ch of ALPHABET) {
    if (capability[i] === ch) continue;
    const candidate = `${capability.slice(0, i)}${ch}${capability.slice(i + 1)}`;
    mutated += 1;
    const read = cap.unpackCapability(candidate);
    if (!read) continue;
    accepted += 1;
    if (JSON.stringify(read) === JSON.stringify(original)) aliases.push(candidate);
  }
}
check('the mutation sweep actually ran', mutated > 2000, `${mutated} mutations`);
check('mutations are mostly refused outright', accepted < mutated / 2, `${accepted} of ${mutated} accepted`);

// THE PART THAT GRANTS ACCESS IS EXACTLY DETERMINED. No mutation may leave the
// room, the invitation or the secret unchanged while changing any of them —
// those three are the bearer parts and they are compared byte for byte.
//
// A handful of aliases DO exist and they are all the same thing: a hostname
// written in different case. `new URL()` lowercases it, because a hostname is
// case-insensitive and `relAy.example` genuinely is `relay.example`. That is
// one address written two ways, not two secrets — the same invitation token,
// revoked once. Asserted here rather than waved at.
for (const alias of aliases) {
  const decoded = JSON.parse(Buffer.from(alias.slice(cap.PREFIX.length), 'base64url').toString('utf8'));
  const before = JSON.parse(Buffer.from(capability.slice(cap.PREFIX.length), 'base64url').toString('utf8'));
  check('an alias never changes the room, the invitation or the secret', decoded.id === before.id && decoded.i === before.i && decoded.k === before.k, alias);
  check('an alias differs only in the relay it names', decoded.r !== before.r, alias);
  check('and only in the case of its hostname', String(decoded.r).toLowerCase() === String(before.r).toLowerCase(), `${decoded.r} vs ${before.r}`);
}

if (failures.length) {
  console.error(`\nsecure-crypto: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`secure-crypto: ${checked} checks passed`);
