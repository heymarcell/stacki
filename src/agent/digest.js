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
 * The digest of a model (or of raw source, for a file Stacki cannot model).
 *
 * Node ids are left in deliberately. They are stable for as long as a document
 * is open, and they change when it is reparsed — which is exactly when a ref
 * minted against the old parse should stop being trusted.
 */
export function digestOfModel(model) {
  if (model == null) return null;
  const text = typeof model === 'string' ? model : JSON.stringify(model);
  // The length goes in too: a collision has to agree on both.
  return `${fnv1a(text)}-${text.length.toString(36)}`;
}

export default digestOfModel;
