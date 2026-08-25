// Proving that a file is the file you read.
//
// An agent reads a target, thinks for a while, and writes. In between, the
// person at the keyboard may have typed something, another agent may have run,
// or a branch may have been switched. The write must not land on top of that,
// and — this is the part that is easy to get wrong — it must not land on top of
// it merely because the old ref still resembles something in the file.
//
// So a mutation names what it believes it is modifying, and the belief is
// checked against the bytes rather than against a line number or a timestamp.
// A digest is cheap, exact, and survives a file being rewritten with identical
// content, which is the case where refusing would be annoying and wrong.
//
// Everything here is content-addressed. Nothing depends on mtime: an editor
// that writes a file twice in the same millisecond is ordinary, and a
// filesystem whose timestamps have one-second resolution is not extinct.

const crypto = require('node:crypto');
const fs = require('node:fs');

/** The digest of a string. Short enough to travel, long enough to mean it. */
function digestOf(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64url').slice(0, 22);
}

/** The digest of a file, or null when there is no file. */
function digestOfFile(abs) {
  try {
    return digestOf(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a write may proceed.
 *
 * `expected` absent used to mean "the caller did not claim to know", and was
 * allowed. That was the hole: a client which simply never sent the field got a
 * write that took whatever it found, and the protection existed only for
 * clients that remembered to ask for it. `requireForExisting` closes it — a
 * write that REPLACES something has to name what it is replacing, whether by
 * carrying a ref (which has the digest baked into it) or by saying so.
 *
 * A write that creates something is different and stays open: there is no
 * prior object for it to be stale against.
 */
function checkDigest({ expected, actual, what = 'that file', requireForExisting = false }) {
  if (expected == null && requireForExisting && actual != null) {
    return {
      ok: false,
      code: 'guard_required',
      currentDigest: actual,
      message:
        `${what} already exists, so replacing it needs to say which version it is replacing. ` +
        'Read it first and pass the ref it gave you, or pass its expectedDigest. Nothing was written.',
    };
  }
  if (expected == null) return null;
  if (typeof expected !== 'string' || !expected) {
    return { ok: false, code: 'bad_request', message: 'expectedDigest must be a digest Stacki gave you.' };
  }
  if (expected === actual) return null;
  return {
    ok: false,
    code: 'stale_target',
    expectedDigest: expected,
    currentDigest: actual,
    message:
      `${what} has changed since you read it — somebody or something else edited it. ` +
      'Nothing was written. Read it again and re-apply your change to what is there now.',
  };
}

/**
 * The same question about the editor's own document.
 *
 * The renderer counts a revision per accepted model change; a digest of the
 * model catches the case where two different edits arrive at the same number
 * (a page closed and reopened, an undo that walked back to where it started).
 * Either one disagreeing is enough to refuse.
 */
function checkRevision({ expectedRevision, expectedDigest, revision, digest, what = 'that target' }) {
  if (expectedRevision != null && expectedRevision !== revision) {
    return {
      ok: false,
      code: 'stale_target',
      expectedRevision,
      currentRevision: revision,
      currentDigest: digest,
      message:
        `${what} has changed since you read it (revision ${expectedRevision} → ${revision}). ` +
        'Nothing was changed. Read the target again.',
    };
  }
  if (expectedDigest != null && expectedDigest !== digest) {
    return {
      ok: false,
      code: 'stale_target',
      expectedDigest,
      currentDigest: digest,
      currentRevision: revision,
      message:
        `${what} has changed since you read it. Nothing was changed. Read the target again.`,
    };
  }
  return null;
}

module.exports = { digestOf, digestOfFile, checkDigest, checkRevision };
