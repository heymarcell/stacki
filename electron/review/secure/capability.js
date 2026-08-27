// The invitation, as one string.
//
// A secure share is two unrelated things that have to travel together and must
// never travel to the same place:
//
//   an INVITATION, which the relay checks and consumes. The relay is meant to
//   see this one.
//
//   the ROOM SECRET, which decrypts the reviews. The relay must never see this
//   one, in any request, in any log, in any header, ever.
//
// So they are packed into a capability that is handled entirely on the
// recipient's own machine, and the HTTPS form puts the whole of it after a `#`
// — the one part of a URL a browser does not send to the server. The landing
// page reads it out of `location.hash`, and the request that fetched that page
// carried none of it.
//
// IT IS A PASSWORD AND THE UI SAYS SO. Anybody holding this string can join
// the room and read everything in it. There is no second factor, no account,
// and no way to tell an intended recipient from somebody who was forwarded the
// message — which is precisely why the invitation half is single-use and
// expires, and why the copy in the dialog says to treat it like a password.
//
// EVERY FIELD IS CHECKED ON THE WAY IN. This value arrives from a clipboard,
// from an operating system's URL handler, from somebody's chat client. It is
// the least trusted input in the application, and `unpackCapability` is
// written to be read as a list of the ways it could be hostile.

const {
  VERSION,
  ROOM_SECRET_BYTES,
  isRoomId,
  isCredential,
  toBase64Url,
  fromBase64Url,
} = require('../../../relay/protocol.js');

const PREFIX = 'stacki2.';
// A capability is a relay origin, a room id, an invitation and a secret. That
// is about 470 characters of base64url. The cap is generous and finite: an
// unbounded string from a URL handler is a way to spend memory before a single
// field has been looked at.
const MAX_CAPABILITY = 2048;
const MAX_RELAY = 200;

// A control character anywhere in a URL. Checked before parsing, because
// parsers differ about what they strip, and the one that strips is the one
// that turns two different strings into the same origin.
const CONTROL = /[\u0000-\u001f\u007f]/;

// Exactly these four, and no more. An extra field is refused rather than
// ignored — a capability carrying something this version does not understand
// is either a newer Stacki (which should say so plainly) or somebody probing.
const FIELDS = ['r', 'id', 'i', 'k'];

/**
 * Whether Stacki will send a bearer credential to this address.
 *
 * HTTPS, or loopback. That is the whole rule and it is not configurable: a
 * custom relay over ordinary remote HTTP would put a member token and every
 * ciphertext on the wire in clear, and "the user chose it" is not consent to
 * something they were not shown. Loopback is exempt because there is no wire —
 * it is how somebody develops against their own relay.
 */
function relayOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_RELAY) return null;
  if (CONTROL.test(value)) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  // Anything that is not http(s) — javascript:, file:, data: — stops here.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // A credential in the address is a credential in every log that records the
  // address, and it is never how this protocol authenticates.
  if (url.username || url.password) return null;
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null;
  if (url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

const isLoopbackHost = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';

const isLoopbackRelay = (origin) => {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/** The four things a recipient needs, as one thing to paste. */
function packCapability({ relay, roomId, invite, secret }) {
  const origin = relayOrigin(relay);
  if (!origin || !isRoomId(roomId) || !isCredential(invite)) return null;
  const key = typeof secret === 'string' ? secret : toBase64Url(secret);
  if (!fromBase64Url(key, ROOM_SECRET_BYTES)) return null;
  const payload = JSON.stringify({ r: origin, id: roomId, i: invite, k: key });
  return `${PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

/**
 * A capability from anywhere, checked field by field. Null for anything at all
 * that is not exactly one.
 *
 * The refusals, in the order they are tried: not a string; too long; wrong
 * prefix (so a `stacki1.` legacy invitation is not mistaken for one of these);
 * not base64url; not canonical base64url, so a re-encoding cannot smuggle a
 * second reading of the same bytes; not JSON; not an object; the wrong set of
 * fields; a relay that is not an acceptable address; a room id of the wrong
 * length; an invitation that is not a credential; a secret that is not exactly
 * thirty-two bytes.
 */
function unpackCapability(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_CAPABILITY) return null;
  if (!trimmed.startsWith(PREFIX)) return null;
  const body = trimmed.slice(PREFIX.length);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return null;

  let raw;
  try {
    raw = Buffer.from(body, 'base64url');
  } catch {
    return null;
  }
  // One encoding per capability. Without this, `stacki2.<x>` and a padded or
  // bit-shifted variant of <x> are two strings naming one invitation, which is
  // two strings to leak and two to have to revoke.
  if (raw.toString('base64url') !== body) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== FIELDS.length) return null;
  for (const key of keys) if (!FIELDS.includes(key)) return null;

  const relay = relayOrigin(parsed.r);
  if (!relay) return null;
  if (!isRoomId(parsed.id)) return null;
  if (!isCredential(parsed.i)) return null;
  if (!fromBase64Url(parsed.k, ROOM_SECRET_BYTES)) return null;

  return { version: VERSION, relay, roomId: parsed.id, invite: parsed.i, secret: parsed.k };
}

// --- the two forms it travels in -------------------------------------------

/**
 * The link a person sends somebody.
 *
 * The capability is the FRAGMENT. Not the path, not the query — a fragment is
 * the one component a browser does not put in the request line, does not send
 * in a Referer, and does not hand to a server that logs URLs. Everything about
 * this feature's privacy claim at the landing page rests on that single `#`,
 * and there is a test that drives a real browser to prove the canary never
 * appears in a request.
 */
const shareLink = ({ shareOrigin, capability }) => {
  const origin = relayOrigin(shareOrigin);
  return origin && capability ? `${origin}/#${capability}` : null;
};

/** The same capability, addressed to the app rather than to a browser. */
const deepLink = (capability) => (capability ? `stacki://join#${capability}` : null);

/**
 * The capability inside a `stacki://` URL, or null.
 *
 * The one action this protocol has. It is not a command channel: `join` is the
 * only host that means anything, everything else is refused here rather than
 * routed, and the payload is fed straight into `unpackCapability` — so the
 * worst a hostile deep link can do is fail to be an invitation.
 */
function readDeepLink(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_CAPABILITY + 64) return null;
  if (CONTROL.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'stacki:') return null;
  // `stacki://join#...` parses with host `join`; `stacki:join#...` with
  // pathname `join`. Both are things an OS may hand over, and neither is
  // anything but join.
  const action = parsed.host || parsed.pathname.replace(/^\/+/, '');
  if (action !== 'join') return null;
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '';
  // Some URL handlers percent-encode the fragment on the way through. One
  // decode, and only when there is something encoded to decode — never a loop,
  // which is how a double-encoded payload gets a second reading.
  const candidate = fragment.includes('%') ? safeDecode(fragment) : fragment;
  return unpackCapability(candidate);
}

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

module.exports = {
  PREFIX,
  MAX_CAPABILITY,
  FIELDS,
  relayOrigin,
  isLoopbackRelay,
  packCapability,
  unpackCapability,
  shareLink,
  deepLink,
  readDeepLink,
};
