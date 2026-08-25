// What a review is about.
//
// A comment is worth nothing if nobody can find what it was pointing at, so
// the anchor is the whole of this feature's difficulty. Two rules shape it:
//
//   It is built from the SAME payload the MCP snapshot is built from. Not a
//   similar one, not one assembled beside it — `buildMcpPayload` is what the
//   renderer publishes, and both `comment create` from an agent and a click in
//   comment mode hand that object to this file. So the identity a review keeps
//   and the identity `get_context` reports and the identity ⇧⌘C copies are one
//   thing by construction rather than by three files agreeing to be careful.
//
//   It anchors on selection KEYS, never on lines. `src/pages/index.astro#0.3.1`
//   is a place in the editing tree; the line it sits on moves every time
//   somebody types above it. Lines are resolved from the keys when they are
//   wanted, by the same resolver ⇧⌘C uses.
//
// Beside the anchor is a creation snapshot, which is frozen forever. If the
// element is deleted the anchor stops resolving and the review still says what
// the human was looking at when they wrote it — which page, which component
// chain, which breakpoint, what it said. An orphan that can still be read is a
// review; an orphan that cannot is a row of empty fields.

const {
  str,
  int,
  listOf,
  propsOf,
  rectOf,
  relativeTo,
  MAX_TEXT,
  MAX_CHAIN,
  MAX_CLASSES,
} = require('../mcp/contextStore');

// A key is `<project-relative file>#<index path>`. Long enough for a deep tree
// in a deeply nested folder, short enough that nothing pathological is stored.
const MAX_KEY = 512;
const MAX_KEYS = 24;
const MAX_FINGERPRINT_TEXT = 160;

/** Why a selection cannot be commented on, in the words the tools use. */
const REFUSALS = ['no_project', 'no_page', 'no_selection'];

const ratio = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Outside the box is not a point on the box. Clamped rather than refused —
  // a pointer one pixel past the edge of an element means the edge.
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
};

const keysOf = (v) => {
  if (!Array.isArray(v)) return [];
  return v
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter((k) => k && k.length <= MAX_KEY && k.includes('#'))
    .slice(0, MAX_KEYS);
};

const breakpointOf = (view) => ({
  device: str(view?.device, 32),
  viewportWidth: int(view?.viewportWidth),
  viewportHeight: int(view?.viewportHeight),
});

/**
 * The bit of a node that helps recognise it again, and only that bit.
 *
 * Deliberately not a computed-style dump and deliberately not enough to
 * reattach on its own — five buttons that all say "Learn more" are five nodes
 * with the same fingerprint. It is corroboration for a position that already
 * looks right, and a description a human can read when nothing looks right at
 * all. See src/reviewAnchor.js for the rules it is used under.
 */
function fingerprintOf(sel) {
  return {
    nodeKind: str(sel?.nodeKind, 32),
    tag: str(sel?.tag, 64),
    text: str(sel?.text, MAX_FINGERPRINT_TEXT),
    componentChain: listOf(sel?.componentChain, MAX_CHAIN),
    breadcrumbs: listOf(sel?.breadcrumbs, MAX_CHAIN),
  };
}

/**
 * Build a review target from a published renderer payload.
 *
 * `payload` is exactly what `buildMcpPayload` produces — the thing already
 * being pushed to the MCP context store on every selection change. The branch
 * rides along on it for the same reason: one payload, so the review and the
 * snapshot can never describe different moments.
 * `pin` is where in the element's rendered box the marker sits, as ratios;
 * absent, it goes to the top-left-ish spot a pin looks natural at.
 *
 * Answers `{ ok: true, anchor, creationContext }`, or `{ ok: false, reason }`
 * with one of REFUSALS — the caller turns that into a status, not an error.
 */
function anchorFrom(payload, { pin } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const root = str(p.project?.root, 512);
  if (!root) return { ok: false, reason: 'no_project' };

  // Project-relative, like everything else the tools report: a review should
  // survive the project being moved or opened from another machine's disk,
  // and an absolute path in stored data is the one field guaranteed not to.
  const pageFile = p.page?.file ? str(relativeTo(root, p.page.file), 512) : null;
  const pageRoute = str(p.page?.route, 200);
  if (!pageFile && !pageRoute) return { ok: false, reason: 'no_page' };

  const sel = p.selection && typeof p.selection === 'object' ? p.selection : null;
  if (!sel || !sel.present) return { ok: false, reason: 'no_selection' };

  const keys = keysOf(sel.keys);
  // No keys is a selection the app cannot name in source — nothing to anchor
  // to, and a review pinned to nothing is the failure this whole file exists
  // to avoid.
  if (!keys.length) return { ok: false, reason: 'no_selection' };

  const breakpoint = breakpointOf(p.view);
  const occurrence = int(sel.occurrence);
  const occurrenceCount = int(sel.occurrenceCount);

  const anchor = {
    type: 'node',
    page: { route: pageRoute, file: pageFile },
    keys,
    // Which rendered copy of a repeated node was reviewed. Source identity is
    // shared between every copy — `items.map(...)` is one node — so this is
    // rendered-instance context, never identity. Kept because "the second card
    // is misaligned" is a different sentence from "the cards are misaligned".
    occurrence,
    occurrenceCount,
    // And which copy of the component instance the node was inside, when the
    // review was left while drilled into one. Null on a page-level review.
    instanceOccurrence: int(sel.instanceOccurrence),
    breakpoint,
    pin: { xRatio: ratio(pin?.xRatio) ?? 0.5, yRatio: ratio(pin?.yRatio) ?? 0.5 },
    fingerprint: fingerprintOf(sel),
  };

  const creationContext = {
    // Frozen. Everything here answers "what was the human looking at", and the
    // answer must not change when the code does.
    page: { route: pageRoute, file: pageFile },
    keys,
    componentChain: listOf(sel.componentChain, MAX_CHAIN),
    breadcrumbs: listOf(sel.breadcrumbs, MAX_CHAIN),
    nodeKind: str(sel.nodeKind, 32),
    tag: str(sel.tag, 64),
    text: str(sel.text, MAX_TEXT),
    props: propsOf(sel.props),
    classes: listOf(sel.classes, MAX_CLASSES, 80),
    occurrence,
    occurrenceCount,
    breakpoint,
    rect: rectOf(sel.rect),
    // Which branch it was written against. Recorded, never used to hide a
    // review — see the store's note on branch scoping.
    branch: str(p.project?.branch, 200),
    // Resolved once, here, and kept: line numbers move, and the point of this
    // copy is to say where the code WAS when the comment was written.
    sourceTrail: null,
  };

  return { ok: true, anchor, creationContext };
}

/** The last key — the node itself, rather than a component on the way down. */
const leafKey = (keys) => (Array.isArray(keys) && keys.length ? keys[keys.length - 1] : null);

/** The file half of a key, with no line numbers attached. */
function fileOfKey(key) {
  if (typeof key !== 'string') return null;
  const hash = key.indexOf('#');
  return hash === -1 ? null : key.slice(0, hash) || null;
}

/**
 * Whether two anchors name the same source node.
 *
 * The leaf key alone, deliberately: the same node reached by drilling into a
 * component from two different pages is the same node, and a comment on it is
 * about that markup either way. The occurrence is not part of it — two reviews
 * on two cards of the same loop are about the same source.
 */
const sameTarget = (a, b) => {
  const x = leafKey(a?.keys);
  const y = leafKey(b?.keys);
  return !!x && x === y;
};

module.exports = { anchorFrom, fingerprintOf, leafKey, fileOfKey, sameTarget, REFUSALS, MAX_KEYS, MAX_KEY };
