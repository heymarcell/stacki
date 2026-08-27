// The wire, and nothing above it.
//
// One definition of what an envelope is, shared by the Stacki client, the Node
// relay and the Cloudflare relay — because three implementations of "is this
// envelope well formed" is three different answers, and the two that are wrong
// are a client whose comments a relay silently drops and a relay that stores
// whatever it is handed.
//
// WHAT IS DELIBERATELY NOT IN THIS FILE, and the absence is the design:
//
//   No Stacki review event. Not the vocabulary, not the validator, not the
//   projection. A relay cannot import `electron/review/events.js` — there is a
//   test that greps for it — because a relay that can parse a review event is
//   a relay that could be asked to, and the whole claim of this feature is
//   that it cannot read what it carries.
//
//   No secrets and no key material. Deriving keys needs the room secret, which
//   only ever exists on somebody's laptop. What is here is the SHAPE of the
//   bytes and the RULES about their size — the parts a relay is allowed to
//   know, and exactly those.
//
//   No `require` of anything. It runs unchanged in Node and in a Cloudflare
//   Worker, which is what makes "the same protocol on both" a fact about one
//   file rather than a promise about two.
//
// EVERY BINARY VALUE ON THE WIRE IS base64url WITH NO PADDING, and decoding is
// strict: the text is decoded, re-encoded, and compared. `atob` is famously
// relaxed about trailing bits and would let two different strings mean the
// same bytes — which, for a value a relay deduplicates on, is a way to store
// the same envelope twice under two names.

const PROTOCOL = 'stacki-secure-review';
const VERSION = 2;

// --- sizes -----------------------------------------------------------------
//
// Every one of these is a byte count of the DECODED value, checked after
// decoding rather than on the text, so a longer encoding of a short value is
// still refused.

const ROOM_ID_BYTES = 16; // 128 bits of room name. Not a secret; not a key.
const SENDER_ID_BYTES = 32; // HMAC-SHA-256 output
const ENVELOPE_ID_BYTES = 32; // HMAC-SHA-256 output
const NONCE_BYTES = 12; // AES-GCM, 96 bits, per §15
const SIGNATURE_BYTES = 64; // Ed25519
const PUBLIC_KEY_BYTES = 32; // Ed25519, raw
const ROOM_SECRET_BYTES = 32; // never on the wire; here so both ends agree
const TOKEN_BYTES = 32; // member bearer credential, 256 bits
const INVITE_BYTES = 32; // invitation, 256 bits

// The largest single encrypted event. Stacki's own MAX_EVENT_BYTES is 64 KiB
// serialized; AES-GCM adds a 16-byte tag and JSON of an event is not
// compressed, so this is that plus room to spare and not a byte more. A relay
// that accepted arbitrary ciphertext would be an encrypted file host.
const MAX_CIPHERTEXT_BYTES = 66 * 1024;

const MAX_BATCH = 100; // envelopes per push
const MAX_PAGE = 200; // envelopes per pull
const MAX_BODY_BYTES = 8 * 1024 * 1024; // one request, all of it
const MAX_MEMBERS = 50; // people in one room
const MAX_OPEN_INVITES = 20; // unredeemed, unexpired, at once
const MAX_ROOM_ENVELOPES = 200_000; // one room's history
const MAX_ROOM_BYTES = 512 * 1024 * 1024; // one room's stored ciphertext

// A room nobody has authenticated against in this long is abandoned, and the
// hosted relay drops it.
//
// 90 days was the candidate. It is wrong for this product by one ordinary
// case: a design review left open over a quiet quarter — a side project, a
// client who goes silent, parental leave — comes back to a room that has been
// swept, and the person who returns has to be asked for a new invitation by
// somebody who may also have stopped using it. Nothing about a longer window
// costs anything: the data is ciphertext, the cap on a room's bytes is
// enforced separately, and ending a share still deletes immediately. So it is
// a year, which is longer than the gap anybody would describe as "we picked it
// back up" and short enough to still be a retention rule.
const IDLE_ROOM_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // §29, and the UI says it out loud
const MIN_INVITE_TTL_MS = 60 * 1000;

// --- the error vocabulary --------------------------------------------------
//
// Stable strings, because a client switches on them and a person reads what
// the client says about them. No stack traces, no internal detail, and nothing
// that distinguishes "wrong invitation" from "used invitation" at the door —
// see `bad_invite`.

const ERRORS = {
  bad_request: 400,
  bad_json: 400,
  bad_envelope: 400,
  bad_signature: 400,
  bad_sender: 400,
  bad_room: 400,
  bad_key: 400,
  unauthorized: 401,
  bad_invite: 401,
  not_found: 404,
  room_ended: 409,
  member_exists: 409,
  too_large: 413,
  too_many: 413,
  room_full: 413,
  rate_limited: 429,
  internal_error: 500,
};

// --- base64url -------------------------------------------------------------

const TEXT = new TextEncoder();

/** Bytes to text. No padding, URL alphabet. */
function toBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  // In chunks: String.fromCharCode.apply with a 64 KiB array overflows the
  // argument list on some runtimes, and a ciphertext is allowed to be that big.
  const STEP = 0x8000;
  for (let i = 0; i < view.length; i += STEP) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + STEP));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Text to bytes, strictly, or null.
 *
 * `expectBytes` is not optional politeness: every field on this wire has one
 * legal length, and checking it here means a caller cannot forget to. The
 * round-trip compare at the end is what makes the decoding canonical — `atob`
 * accepts several strings that decode to the same bytes, and a relay that
 * deduplicates on an envelope id must not be able to hold two names for one.
 */
function fromBase64Url(text, expectBytes = null) {
  if (typeof text !== 'string' || !text) return null;
  if (text.length > 200_000) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let binary;
  try {
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (expectBytes != null && out.length !== expectBytes) return null;
  if (toBase64Url(out) !== text) return null; // one encoding per value
  return out;
}

/** Whether a string is exactly `bytes` bytes of base64url. */
const isBase64Url = (text, bytes) => fromBase64Url(text, bytes) !== null;

// --- canonical bytes -------------------------------------------------------

/**
 * An unambiguous encoding of a list of values.
 *
 * Every part is prefixed with its length as a four-byte big-endian integer, so
 * there is exactly one byte string for any list and no concatenation of two
 * fields can be read as a different pair — the failure that makes "just join
 * them with a colon" a signature forgery waiting for a colon in a field.
 *
 * This is used for the AEAD associated data and for the bytes that get signed,
 * and it is used INSTEAD of canonical JSON on purpose: a JSON canonicaliser is
 * a subsystem with its own edge cases (number formatting, unicode escapes, key
 * ordering) and none of them need to exist to concatenate five known fields.
 */
function lengthPrefixed(parts) {
  const chunks = parts.map((p) => (p instanceof Uint8Array ? p : TEXT.encode(String(p))));
  let total = 0;
  for (const c of chunks) total += 4 + c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out[at++] = (c.length >>> 24) & 0xff;
    out[at++] = (c.length >>> 16) & 0xff;
    out[at++] = (c.length >>> 8) & 0xff;
    out[at++] = c.length & 0xff;
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The associated data every envelope's encryption is bound to.
 *
 * Not encrypted, and authenticated — which is the point. Moving an envelope to
 * another room, relabelling who sent it, or re-filing it under a different
 * envelope id all change these bytes, and AES-GCM then refuses to decrypt.
 * That is what makes cross-room replay fail closed rather than silently
 * producing somebody's comment in the wrong project.
 */
const aadFor = ({ roomId, envelopeId, senderId }) =>
  lengthPrefixed([`${PROTOCOL}/aad`, String(VERSION), roomId, envelopeId, senderId]);

/**
 * The bytes an envelope's sender signs.
 *
 * Everything the relay routes on, plus the ciphertext itself. A relay that
 * swapped two members' sender ids, or handed back a ciphertext from another
 * room, produces a signature that does not verify on the recipient's machine —
 * so the recipient's check is not a formality duplicating the relay's, it is
 * the one that does not require trusting the relay.
 */
const signingBytes = ({ roomId, envelopeId, senderId, nonce, ciphertext }) =>
  lengthPrefixed([
    `${PROTOCOL}/envelope`,
    String(VERSION),
    roomId,
    envelopeId,
    senderId,
    nonce,
    ciphertext instanceof Uint8Array ? ciphertext : TEXT.encode(String(ciphertext)),
  ]);

// --- the envelope ----------------------------------------------------------

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Exactly these, and nothing else. An envelope carrying an extra field is
// refused rather than trimmed: an unrecognised field is either a client this
// relay does not understand or somebody probing, and storing it would mean
// serving it back to peers who also do not understand it.
const ENVELOPE_FIELDS = ['v', 'envelopeId', 'senderId', 'nonce', 'ciphertext', 'signature'];

/**
 * Check one envelope off the wire.
 *
 * `{ ok: true, envelope }` or `{ ok: false, code }`, never a throw. Shape,
 * types, field count, encoding, exact lengths, and the ciphertext cap — all of
 * it before a byte is stored and before a signature is checked, because a
 * signature check on unbounded input is a way to spend a relay's CPU.
 */
function readEnvelope(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'bad_envelope' };
  const keys = Object.keys(raw);
  if (keys.length !== ENVELOPE_FIELDS.length) return { ok: false, code: 'bad_envelope' };
  for (const key of keys) if (!ENVELOPE_FIELDS.includes(key)) return { ok: false, code: 'bad_envelope' };
  if (raw.v !== VERSION) return { ok: false, code: 'bad_envelope' };

  const envelopeId = fromBase64Url(raw.envelopeId, ENVELOPE_ID_BYTES);
  const senderId = fromBase64Url(raw.senderId, SENDER_ID_BYTES);
  const nonce = fromBase64Url(raw.nonce, NONCE_BYTES);
  const signature = fromBase64Url(raw.signature, SIGNATURE_BYTES);
  if (!envelopeId || !senderId || !nonce || !signature) return { ok: false, code: 'bad_envelope' };

  if (typeof raw.ciphertext !== 'string' || !raw.ciphertext) return { ok: false, code: 'bad_envelope' };
  const ciphertext = fromBase64Url(raw.ciphertext);
  if (!ciphertext) return { ok: false, code: 'bad_envelope' };
  // 16 is the GCM tag: a "ciphertext" shorter than the tag is not one.
  if (ciphertext.length < 16) return { ok: false, code: 'bad_envelope' };
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) return { ok: false, code: 'too_large' };

  return {
    ok: true,
    envelope: {
      v: VERSION,
      envelopeId: raw.envelopeId,
      senderId: raw.senderId,
      nonce: raw.nonce,
      ciphertext: raw.ciphertext,
      signature: raw.signature,
      bytes: { envelopeId, senderId, nonce, ciphertext, signature },
    },
  };
}

/** The envelope as it goes back out, plus what the relay knows about it. */
const serveEnvelope = (row) => ({
  v: VERSION,
  envelopeId: row.envelope_id ?? row.envelopeId,
  senderId: row.sender_id ?? row.senderId,
  nonce: row.nonce,
  ciphertext: row.ciphertext,
  signature: row.signature,
  seq: row.seq,
  receivedAt: row.received_at ?? row.receivedAt,
});

const isRoomId = (v) => isBase64Url(v, ROOM_ID_BYTES);
const isSenderId = (v) => isBase64Url(v, SENDER_ID_BYTES);
const isPublicKey = (v) => isBase64Url(v, PUBLIC_KEY_BYTES);
// A credential is compared, never parsed. Length-bounded so a hash of it is
// not a way to spend CPU.
const isCredential = (v) => typeof v === 'string' && v.length >= 22 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v);

module.exports = {
  PROTOCOL,
  VERSION,
  ROOM_ID_BYTES,
  SENDER_ID_BYTES,
  ENVELOPE_ID_BYTES,
  NONCE_BYTES,
  SIGNATURE_BYTES,
  PUBLIC_KEY_BYTES,
  ROOM_SECRET_BYTES,
  TOKEN_BYTES,
  INVITE_BYTES,
  MAX_CIPHERTEXT_BYTES,
  MAX_BATCH,
  MAX_PAGE,
  MAX_BODY_BYTES,
  MAX_MEMBERS,
  MAX_OPEN_INVITES,
  MAX_ROOM_ENVELOPES,
  MAX_ROOM_BYTES,
  IDLE_ROOM_TTL_MS,
  INVITE_TTL_MS,
  MIN_INVITE_TTL_MS,
  ERRORS,
  toBase64Url,
  fromBase64Url,
  isBase64Url,
  lengthPrefixed,
  aadFor,
  signingBytes,
  readEnvelope,
  serveEnvelope,
  isRoomId,
  isSenderId,
  isPublicKey,
  isCredential,
  ENVELOPE_FIELDS,
};
