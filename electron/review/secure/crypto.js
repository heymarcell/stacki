// The room's cryptography, and all of it.
//
// One file, standard primitives, no invention. Everything here is HKDF-SHA-256,
// AES-256-GCM, HMAC-SHA-256 and Ed25519 out of `node:crypto` — which is to say
// out of OpenSSL — arranged so that a relay carrying the output learns the size
// of a comment and nothing else about it.
//
// THE ROOM SECRET IS THE WHOLE OF THE ACCESS CONTROL. Thirty-two random bytes,
// made on somebody's laptop, put into an invitation, and never sent to a relay
// in any form. Everything below is derived from it, which means the relay is
// not trusted for confidentiality by construction rather than by policy: it
// does not hold a key it is choosing not to use, it holds no key at all.
//
// THREE DERIVED KEYS, AND NEVER ONE KEY FOR TWO JOBS:
//
//   K_CONTENT      encrypts the review event
//   K_SENDER_ID    names a member inside this room, and nowhere else
//   K_ENVELOPE_ID  names an event inside this room, and nowhere else
//
// The last two are why a relay operator with two rooms cannot tell they belong
// to the same person or contain the same event. Both are HMACs under keys that
// differ per room, so the same actor id produces unrelated sender ids in
// unrelated rooms — the correlation a stable installation identifier would
// have handed over for free.
//
// EVERY DERIVATION IS BOUND TO THE PROTOCOL VERSION AND THE ROOM ID. A room's
// keys are useless in another room and a version-2 key is useless to a
// version-3 construction, so neither is a thing anybody has to remember not to
// do.

const crypto = require('node:crypto');

const {
  PROTOCOL,
  VERSION,
  ROOM_ID_BYTES,
  ROOM_SECRET_BYTES,
  SENDER_ID_BYTES,
  ENVELOPE_ID_BYTES,
  NONCE_BYTES,
  PUBLIC_KEY_BYTES,
  MAX_CIPHERTEXT_BYTES,
  toBase64Url,
  fromBase64Url,
  aadFor,
  signingBytes,
} = require('../../../relay/protocol.js');

// The three labels, written once. They are part of the wire format: changing a
// string here makes every existing room undecryptable, which is why they are
// constants with a comment rather than template literals at the call site.
const LABEL_CONTENT = 'content';
const LABEL_SENDER_ID = 'sender-id';
const LABEL_ENVELOPE_ID = 'envelope-id';

// HKDF's salt. Not secret and not per-room — the room binding is in `info`,
// where it belongs, and a fixed non-secret salt is exactly what RFC 5869
// describes for this case.
const HKDF_SALT = `${PROTOCOL}/v${VERSION}/hkdf`;

/**
 * The `info` string for one derived key.
 *
 *     stacki-secure-review/v2/<purpose>/<roomId>
 *
 * Domain separation and room binding in one value, and readable in a test
 * vector — which matters, because an independent implementation has to be able
 * to reproduce these bytes from the protocol document alone.
 */
const infoFor = (purpose, roomId) => `${PROTOCOL}/v${VERSION}/${purpose}/${roomId}`;

const hkdf = (secret, purpose, roomId, length = 32) =>
  Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(infoFor(purpose, roomId), 'utf8'), length));

/** Thirty-two bytes that never leave the people in the room. */
const newRoomSecret = () => crypto.randomBytes(ROOM_SECRET_BYTES);

/** A room's public name. Random, not derived, and not a secret — see the protocol doc. */
const newRoomId = () => toBase64Url(crypto.randomBytes(ROOM_ID_BYTES));

/**
 * Every key this room needs, from the one secret it has.
 *
 * `roomSecret` may be the raw bytes or the base64url they travel as, because
 * this is called both just after generating one and just after reading one out
 * of an invitation, and making the caller remember which is a bug waiting to
 * be written.
 */
function deriveKeys(roomSecret, roomId) {
  const secret = typeof roomSecret === 'string' ? fromBase64Url(roomSecret, ROOM_SECRET_BYTES) : roomSecret;
  if (!secret || secret.length !== ROOM_SECRET_BYTES) throw new Error('a secure room needs a 32-byte secret');
  if (typeof roomId !== 'string' || !roomId) throw new Error('a secure room needs an id');
  return {
    roomId,
    content: hkdf(secret, LABEL_CONTENT, roomId),
    senderId: hkdf(secret, LABEL_SENDER_ID, roomId),
    envelopeId: hkdf(secret, LABEL_ENVELOPE_ID, roomId),
  };
}

const hmac = (key, message) => crypto.createHmac('sha256', key).update(Buffer.from(String(message), 'utf8')).digest();

/**
 * What this room calls a Stacki actor.
 *
 * Deterministic inside the room — so a member's own events all carry one
 * sender id and a peer can pin a signing key to it — and unrelated across
 * rooms, so a relay holding two of them cannot say they are the same person.
 * The relay cannot go the other way at all: it would need K_SENDER_ID.
 */
const senderIdFor = (keys, actorId) => toBase64Url(hmac(keys.senderId, actorId));

/**
 * What this room calls a Stacki event.
 *
 * The relay deduplicates on this, so it has to be stable for one event: a push
 * that succeeded and lost its answer is retried and lands on the same id,
 * which is the whole of the retry story. And it is an HMAC rather than the
 * event's own uuid so that the same comment shared into two rooms does not
 * announce itself as the same comment.
 */
const envelopeIdFor = (keys, eventId) => toBase64Url(hmac(keys.envelopeId, eventId));

// --- room-specific signing identity ----------------------------------------

/**
 * A signing keypair for one room and one member.
 *
 * Per room, never per installation. One installation-wide public key would let
 * a relay operator — or two colluding ones — join up every room a person is
 * in, which is exactly the correlation the derived sender id is there to
 * prevent; leaving a stable key beside it would have handed it back.
 *
 * Exported as raw 32-byte values through JWK, because that is the one
 * representation Node, WebCrypto and a Cloudflare Worker all agree on.
 */
function newSigningKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { publicKey: pub.x, privateKey: priv.d };
}

/** The public half of a stored private key, recomputed rather than stored twice. */
function publicFromPrivate(d) {
  // Node needs `x` to build the private KeyObject, and the only way to get it
  // is from a key object — so build it once with a placeholder-free route: a
  // raw Ed25519 private key in DER, which needs no x at all.
  const seed = fromBase64Url(d, 32);
  if (!seed) return null;
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(key).export({ format: 'jwk' }).x;
}

const publicKeyFrom = (x) => {
  if (!fromBase64Url(x, PUBLIC_KEY_BYTES)) return null;
  try {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  } catch {
    return null;
  }
};

const signBytes = (privateKeyD, bytes) => {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), fromBase64Url(privateKeyD, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  return toBase64Url(crypto.sign(null, Buffer.from(bytes), key));
};

/** Whether these bytes were signed by this key. False for anything unreadable. */
function verifyBytes(publicKeyX, bytes, signature) {
  const key = publicKeyFrom(publicKeyX);
  const sig = fromBase64Url(signature, 64);
  if (!key || !sig) return false;
  try {
    return crypto.verify(null, Buffer.from(bytes), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

// --- sealing and opening ---------------------------------------------------

/**
 * One Stacki event, encrypted and signed, ready for a relay.
 *
 * `nonce` is injectable for test vectors ONLY and defaults to twelve fresh
 * random bytes on every single call. A repeated nonce under one AES-GCM key is
 * the catastrophic failure of this construction — it leaks the XOR of two
 * plaintexts and, worse, the authentication subkey — so it is generated here,
 * per operation, and there is no code path that derives it from anything.
 */
function sealEvent({ keys, senderId, event, privateKey, nonce = null }) {
  const plaintext = Buffer.from(JSON.stringify(event), 'utf8');
  const envelopeId = envelopeIdFor(keys, event.id);
  const iv = nonce ? Buffer.from(nonce) : crypto.randomBytes(NONCE_BYTES);
  if (iv.length !== NONCE_BYTES) throw new Error('an AES-GCM nonce is 12 bytes');

  const cipher = crypto.createCipheriv('aes-256-gcm', keys.content, iv);
  cipher.setAAD(Buffer.from(aadFor({ roomId: keys.roomId, envelopeId, senderId })));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // Tag appended, so "ciphertext" is one value on the wire and there is no
  // second field anybody can forget to authenticate.
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) return { ok: false, code: 'too_large' };

  const nonceText = toBase64Url(iv);
  const ciphertextText = toBase64Url(ciphertext);
  const signature = signBytes(
    privateKey,
    signingBytes({ roomId: keys.roomId, envelopeId, senderId, nonce: nonceText, ciphertext })
  );

  return {
    ok: true,
    envelope: { v: VERSION, envelopeId, senderId, nonce: nonceText, ciphertext: ciphertextText, signature },
  };
}

/**
 * The event inside an envelope, or a reason there is not one.
 *
 * Order matters and it is signature first: verifying costs one curve operation
 * on bytes already in hand, decrypting costs a pass over the ciphertext, and a
 * peer that cannot sign should not be able to make this machine do the second.
 *
 * `publicKey` is the pinned key for this sender — passed in rather than looked
 * up here, because the pin lives with the room's metadata and this file has no
 * business reading it. See secrets.js for what "pinned" means.
 */
function openEnvelope({ keys, envelope, publicKey }) {
  const { envelopeId, senderId, nonce, ciphertext, signature } = envelope;
  const rawCiphertext = fromBase64Url(ciphertext);
  const iv = fromBase64Url(nonce, NONCE_BYTES);
  if (!rawCiphertext || !iv || rawCiphertext.length < 16) return { ok: false, code: 'bad_envelope' };

  const signed = signingBytes({ roomId: keys.roomId, envelopeId, senderId, nonce, ciphertext: rawCiphertext });
  if (!verifyBytes(publicKey, signed, signature)) return { ok: false, code: 'bad_signature' };

  const body = Buffer.from(rawCiphertext.subarray(0, rawCiphertext.length - 16));
  const tag = Buffer.from(rawCiphertext.subarray(rawCiphertext.length - 16));
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.content, Buffer.from(iv));
    decipher.setAAD(Buffer.from(aadFor({ roomId: keys.roomId, envelopeId, senderId })));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // A wrong room key, a tampered byte, a moved envelope, a relabelled
    // sender: GCM cannot tell them apart and neither should this. One code.
    return { ok: false, code: 'bad_ciphertext' };
  }

  let parsed;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return { ok: false, code: 'bad_plaintext' };
  }
  return { ok: true, event: parsed };
}

/** Constant-time equality for two base64url values of the same length. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  LABEL_CONTENT,
  LABEL_SENDER_ID,
  LABEL_ENVELOPE_ID,
  HKDF_SALT,
  infoFor,
  hkdf,
  newRoomSecret,
  newRoomId,
  deriveKeys,
  senderIdFor,
  envelopeIdFor,
  newSigningKeys,
  publicFromPrivate,
  signBytes,
  verifyBytes,
  sealEvent,
  openEnvelope,
  sameSecret,
};
