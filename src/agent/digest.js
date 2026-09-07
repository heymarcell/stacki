// A short, stable fingerprint of what the editor is holding.
//
// The document revision counts changes; this says which change. They answer
// different halves of the same question, and a write names both — a revision
// that agrees can still be a different document (an undo walking back to where
// it started, a page closed and reopened), and a digest that agrees is the
// same document whatever the counter says.
//
// FNV-1a rather than a real hash: this runs in the renderer, on every read, on
// a tree that can be large. Nothing about it is security — a client cannot
// forge a document into being current, because the digest it sends is only
// ever compared against one Stacki computed itself a moment ago.

/** The 32-bit FNV-1a of a string, base-36 spelled. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, as shifts, because Math.imul(hash, 16777619) is the same
    // thing and this stays exact in 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The parse counter's node ids, left out.
 *
 * THEY USED TO BE LEFT IN, DELIBERATELY, and the reasoning was wrong. It said:
 * ids change when a document is reparsed, which is exactly when a ref minted
 * against the old parse should stop being trusted. But a reparse of the SAME
 * BYTES produces a tree of the same shape with different numbers on it — the
 * ids come from a module-global counter in electron/astroParser.js that is
 * never reset — so the digest said "different document" about a document that
 * had not changed by one byte.
 *
 * What that cost: `target.enter` followed by `target.exit` reparses the page.
 * Measured, with reads only at the `inspect` permission level and the file's
 * own content digest unmoved throughout, `document.digest` went 17411fj-13o ->
 * 44l7fg-13v — and a write through a ref minted before that navigation was then
 * REFUSED AS STALE. Two pure reads, and a handle stopped working. The new value
 * was not even reproducible between runs, because it is a counter.
 *
 * A ref's own validity does not depend on this. It carries the index path to
 * its node and a fingerprint of what was there; after a reparse of identical
 * bytes the tree has the same shape, so the path still leads to the same node.
 * The digest's job is to answer "is this the same document", and it now answers
 * that question instead of "is this the same parse".
 */
const withoutNodeIds = (key, value) => (key === 'id' ? undefined : value);

/**
 * The digest of a model (or of raw source, for a file Stacki cannot model).
 *
 * STABLE WHILE THE BYTES ARE. Two parses of the same file agree; any edit that
 * changes what the document says changes it, because everything except the
 * parse counter is still in there.
 */
export function digestOfModel(model) {
  if (model == null) return null;
  const text = typeof model === 'string' ? model : JSON.stringify(model, withoutNodeIds);
  // The length goes in too: a collision has to agree on both.
  return `${fnv1a(text)}-${text.length.toString(36)}`;
}

export default digestOfModel;
