// What an agent holds instead of a file path.
//
// A Stacki ref names an object the editor already knows about: the node under
// somebody's pointer, the declaration that is making it look wrong, the entry
// the words came from. It exists because the alternative — handing an agent a
// path and a line number — is wrong in two directions at once. A line number
// stops being true the moment anybody types above it, and a path an agent can
// write is a path an agent can invent.
//
// So a ref is signed, and it carries identity rather than location:
//
//   opaque      the client never parses one. Everything inside is Stacki's,
//               and the shape may change between versions without breaking a
//               client that only ever hands them back.
//   signed      HMAC over the payload with a secret made fresh each run and
//               kept in memory. A forged ref is not a ref: it fails the check
//               before anything reads a field off it, so a client cannot name
//               a file by writing one.
//   scoped      to the project that was open when it was minted, and to the
//               run of the app that minted it. Close the project and every
//               ref about it stops resolving — it does not quietly start
//               meaning the same path in the next project.
//   perishable  a lifetime, so an agent that kept one from this morning is
//               told to look again rather than acting on a memory.
//   honest      `w:false` marks a ref that may be read and not written. That
//               is how the Visual Review evidence rules reach the write path:
//               a node recovered on position alone across a branch gets a
//               readable ref and no permission to change anything.
//
// Nothing is stored. The signature IS the record, so there is no table to
// grow, nothing to evict, and no way for two windows to disagree about which
// refs exist.

const crypto = require('node:crypto');

const VERSION = 1;
const PREFIX = 'stacki';

// Long enough that an agent working through a review never trips over it,
// short enough that a ref found in an old transcript is not a live handle.
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

// Every kind of thing a ref can name. A client never reads these — they are
// here so a mistyped kind fails at mint rather than at resolve.
const KINDS = [
  'node', // a source-backed node in the editor model
  'prop', // one prop on one node
  'style', // one authored declaration in a stylesheet or <style> block
  'styleRule', // a whole rule
  'cssvar', // a CSS custom property
  'source', // a project file, as text
  'page', // a page or component file, as a project object
  'content', // a CMS file or a content-collection entry
  'field', // one field inside a content object
  'asset', // a file under public/ or src/
];

let secret = crypto.randomBytes(32);
let session = crypto.randomBytes(8).toString('base64url');

/**
 * Start a new signing era.
 *
 * Called when a project opens or closes: refs minted about the last one must
 * not resolve against this one, and a ref that outlives its project is a ref
 * that names a path in somebody else's.
 */
function rotate() {
  secret = crypto.randomBytes(32);
  session = crypto.randomBytes(8).toString('base64url');
  return session;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** A short, stable fingerprint of the project root. Never the root itself. */
function projectFingerprint(root) {
  if (!root) return null;
  return crypto.createHash('sha256').update(String(root)).digest('base64url').slice(0, 12);
}

function sign(body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 27);
}

/**
 * Mint a ref.
 *
 * `data` is whatever re-resolving this kind of object needs, and it is the
 * caller's business — except that it must contain nothing absolute. Paths
 * inside a ref are project-relative, because a ref that carried a real
 * filesystem path would leak one the moment a client logged what it was
 * holding.
 */
function mint(kind, data, { projectRoot, ttlMs = DEFAULT_TTL_MS, writable = true, now = Date.now } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown ref kind: ${kind}`);
  const payload = {
    v: VERSION,
    k: kind,
    p: projectFingerprint(projectRoot),
    s: session,
    t: now(),
    x: now() + ttlMs,
    d: data && typeof data === 'object' ? data : {},
  };
  if (!writable) payload.w = false;
  const body = b64(JSON.stringify(payload));
  return `${PREFIX}:${body}.${sign(body)}`;
}

/**
 * Read a ref back, or say why not.
 *
 * Every refusal is a code rather than a throw, because every one of them is
 * something an agent can do something about: `stale_ref` means read the target
 * again, `wrong_project` means the user moved on, `bad_ref` means it was never
 * ours. Guessing at any of them is how an edit lands in the wrong file.
 */
function parse(ref, { projectRoot, kind = null, now = Date.now } = {}) {
  if (typeof ref !== 'string' || !ref.startsWith(`${PREFIX}:`)) {
    return { ok: false, code: 'bad_ref', message: 'That is not a Stacki ref.' };
  }
  const rest = ref.slice(PREFIX.length + 1);
  const dot = rest.lastIndexOf('.');
  if (dot === -1) return { ok: false, code: 'bad_ref', message: 'That ref is malformed.' };
  const body = rest.slice(0, dot);
  const mac = rest.slice(dot + 1);
  const expected = sign(body);
  // Constant time, and length-checked first because timingSafeEqual insists.
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { ok: false, code: 'bad_ref', message: 'That ref was not issued by this Stacki, or it has been altered.' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'bad_ref', message: 'That ref is malformed.' };
  }
  if (payload?.v !== VERSION) {
    return { ok: false, code: 'stale_ref', message: 'That ref is from an older version of Stacki. Read the target again.' };
  }
  if (payload.s !== session) {
    return {
      ok: false,
      code: 'stale_ref',
      message: 'That ref was issued before the current project was opened. Read the target again.',
    };
  }
  if (typeof payload.x === 'number' && now() > payload.x) {
    return { ok: false, code: 'stale_ref', message: 'That ref has expired. Read the target again.' };
  }
  const fingerprint = projectFingerprint(projectRoot);
  if (!fingerprint || payload.p !== fingerprint) {
    return {
      ok: false,
      code: 'wrong_project',
      message: 'That ref belongs to a different project than the one Stacki has open.',
    };
  }
  if (kind && payload.k !== kind) {
    return {
      ok: false,
      code: 'wrong_kind',
      message: `That ref names a ${payload.k}, and this action works on a ${kind}.`,
    };
  }
  return {
    ok: true,
    kind: payload.k,
    data: payload.d || {},
    mintedAt: payload.t,
    expiresAt: payload.x,
    // Absent means writable — only a deliberately withheld ref carries the flag.
    writable: payload.w !== false,
  };
}

/** The kind a ref names, without validating it. For error messages only. */
function kindOf(ref) {
  try {
    const rest = String(ref).slice(PREFIX.length + 1);
    const payload = JSON.parse(Buffer.from(rest.slice(0, rest.lastIndexOf('.')), 'base64url').toString('utf8'));
    return typeof payload?.k === 'string' ? payload.k : null;
  } catch {
    return null;
  }
}

module.exports = {
  mint,
  parse,
  rotate,
  kindOf,
  projectFingerprint,
  KINDS,
  VERSION,
  DEFAULT_TTL_MS,
  get session() {
    return session;
  },
};
