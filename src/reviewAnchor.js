// Finding what a review was about, again.
//
// A review is anchored to a selection key — `src/pages/index.astro#0.3.1` —
// which is the same thing ⇧⌘C copies and the same thing `get_context` reports.
// That key is an index path through the editing tree, and index paths move:
// add a section above and 0.3 becomes 0.4. So there has to be a second
// question after "is it still there", and the whole difficulty of this file is
// that the wrong answer to it is worse than no answer.
//
// The ladder, in order, and nothing below the rung that answers:
//
//   1. The index path still resolves, and the node there is still the same
//      KIND of thing. This is Stacki's own convention for "the same node after
//      a reload" — App re-selects through pathOfNode/nodeAtPath after every
//      external edit — so a review uses it too rather than inventing a second
//      idea of node identity.
//
//   2. It doesn't, so look for the node somewhere else in the tree: same kind,
//      same tag, and the same chain of ancestor labels it was under when the
//      comment was written. Accepted only when exactly ONE node in the file
//      answers to that. One is evidence; two is a coin toss.
//
//   3. Nothing, or several things. Orphaned. The review keeps everything it
//      ever knew — the message, the page, the component chain, what the
//      element said, the breakpoint — and points at nothing rather than at
//      something plausible.
//
// Two rules that are not obvious and both matter:
//
//   Text is never a requirement. "The copy here is wrong" is the single most
//   common review there is, and the agent's whole job is to change that text.
//   An anchor that demanded matching text would come unstuck at the exact
//   moment the work was done.
//
//   Text is never sufficient either. Five buttons that say "Learn more" are
//   five nodes with identical text, and picking one of them is how a review
//   ends up attached to the wrong button forever. It is a tie-breaker between
//   candidates that already agree on kind, tag and ancestry — never a search.

import { tagOf, textOf } from './mcpContext.js';

/** `file#indexPath` split into its halves. Null for anything that isn't a key. */
export function keyParts(key) {
  if (typeof key !== 'string') return null;
  const hash = key.indexOf('#');
  if (hash === -1) return null;
  const file = key.slice(0, hash);
  const indexPath = key.slice(hash + 1);
  if (!file) return null;
  return { file, indexPath };
}

/** An index path as the numbers nodeAtPath walks. Null for frontmatter or a bare file. */
export function trailOfPath(indexPath) {
  if (typeof indexPath !== 'string' || !indexPath) return null;
  if (indexPath === 'frontmatter') return null;
  const parts = indexPath.split('.');
  const trail = parts.map((n) => Number(n));
  return trail.every((n) => Number.isInteger(n) && n >= 0) ? trail : null;
}

/** The node an index trail leads to. Mirrors App's nodeAtPath exactly. */
export function nodeAt(nodes, trail) {
  let list = nodes;
  let node = null;
  for (const i of trail || []) {
    node = list?.[i];
    if (!node) return null;
    list = Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The visible words of a node, as the fingerprint recorded them. */
const wordsOf = (node) => norm(textOf(node).join(' '));

/**
 * Whether a node is still the same SORT of thing the review was left on.
 *
 * Kind and tag only. An element that became a component, or a `<span>` that
 * became a `<div>`, is a different thing wearing the old position; an element
 * whose words changed is the same element after somebody did the work.
 */
export function sameSort(node, fingerprint) {
  if (!node) return false;
  const fp = fingerprint || {};
  if (fp.nodeKind && node.kind !== fp.nodeKind) return false;
  const tag = tagOf(node);
  if (fp.tag && tag !== fp.tag) return false;
  // A fingerprint from an older review may have neither; then the position is
  // all there is, and that is what rung 1 already checked.
  return true;
}

/**
 * Every node in a model, with its index trail and the labels of its ancestors.
 *
 * `labelOf` is the app's own crumbLabel — passed in rather than reimplemented,
 * because the breadcrumbs stored on a review were made with it and a second
 * labeller would quietly disagree with the first.
 */
function walk(nodes, labelOf, out = [], trail = [], chain = []) {
  (nodes || []).forEach((node, i) => {
    const here = [...trail, i];
    out.push({ node, trail: here, chain });
    if (Array.isArray(node.children)) {
      walk(node.children, labelOf, out, here, [...chain, labelOf ? labelOf(node) : null]);
    }
  });
  return out;
}

/**
 * The ancestor labels a review recorded, without the page name at the front.
 *
 * `crumbs` in App starts with the file the selection is in and ends with the
 * node itself; what identifies a position is the part between.
 */
function ancestorsOf(fingerprint) {
  const crumbs = Array.isArray(fingerprint?.breadcrumbs) ? fingerprint.breadcrumbs : null;
  if (!crumbs || crumbs.length < 2) return null;
  return crumbs.slice(1, -1).map(norm);
}

const chainMatches = (chain, wanted) => {
  if (!wanted) return false;
  const got = chain.map(norm);
  if (got.length !== wanted.length) return false;
  return got.every((label, i) => label === wanted[i]);
};

/**
 * Where a review's node is in this model now.
 *
 * Answers `{ id, trail, confidence, reason }`. `confidence` is one of:
 *
 *   exact  — the index path still leads to the same sort of node
 *   moved  — it doesn't, but exactly one node in the file answers the
 *            fingerprint, so it is that one
 *   none   — nothing, or more than one thing. The caller orphans the review;
 *            it does not pick.
 */
export function resolveNode(nodes, indexPath, fingerprint, { labelOf } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const trail = trailOfPath(indexPath);

  // Rung 1 — the position, which is what Stacki already means by "the same
  // node" after a reload.
  if (trail) {
    const at = nodeAt(list, trail);
    if (at && sameSort(at, fingerprint)) {
      return { id: at.id, trail, confidence: 'exact', reason: null };
    }
  }

  // Rung 2 — the same sort of node, under the same ancestors, and only one of
  // it. Without recorded ancestors there is nothing here worth trusting: kind
  // and tag alone match every <span> in the file.
  const wanted = ancestorsOf(fingerprint);
  if (!wanted) {
    return { id: null, trail: null, confidence: 'none', reason: trail ? 'changed' : 'no_path' };
  }
  const everything = walk(list, labelOf);
  let candidates = everything.filter((e) => sameSort(e.node, fingerprint) && chainMatches(e.chain, wanted));
  if (!candidates.length) {
    return { id: null, trail: null, confidence: 'none', reason: 'gone' };
  }
  if (candidates.length > 1) {
    // Several nodes fit. The words are allowed to break the tie — and ONLY to
    // break a tie between nodes that already agree on everything else.
    const fpText = norm(fingerprint?.text);
    const byText = fpText ? candidates.filter((e) => wordsOf(e.node) === fpText) : [];
    if (byText.length !== 1) {
      return { id: null, trail: null, confidence: 'none', reason: 'ambiguous' };
    }
    candidates = byText;
  }
  const found = candidates[0];
  return { id: found.node.id, trail: found.trail, confidence: 'moved', reason: null };
}

/**
 * What a review's anchor expects to find at each step down to its node.
 *
 * A key chain is the page, then the instance of each component drilled into on
 * the way down, then the node — `[index.astro#0.3, Hero.astro#0.1.2]` means
 * "the <Hero> at 0.3 in the page, then 0.1.2 inside Hero.astro". The component
 * a step is expected to open is named by the NEXT key's file, so a step that
 * lands on something else is caught rather than followed.
 */
export function anchorSteps(anchor) {
  const keys = Array.isArray(anchor?.keys) ? anchor.keys : [];
  const parts = keys.map(keyParts).filter(Boolean);
  return parts.map((part, i) => {
    const next = parts[i + 1];
    return {
      file: part.file,
      indexPath: part.indexPath,
      // The last key is the node the comment is on; every earlier one is a
      // door into a component.
      leaf: !next,
      opens: next ? componentNameOf(next.file) : null,
    };
  });
}

/**
 * The path the CANVAS knows a node by.
 *
 * The page renders every component's markup, and the dev server marks each
 * `.astro` with its own namespace — so a node inside `HeroSection.astro` is
 * addressable as `src/components/HeroSection.astro|0.0.1` whatever the editor
 * is currently showing. The PAGE's own nodes carry no namespace, which is the
 * same rule App's `pathFor` follows.
 *
 * Against the page rather than against the open file, deliberately: the page
 * is what is on the canvas, and it is what the markers belong to. This is what
 * lets a comment left three components deep wear a pin while the page is open
 * — without it a review could only be marked while the very file it lives in
 * was the one being edited, which is neither where the comment was left nor
 * where anybody is looking.
 */
export function markerPathFor(key, pageFile) {
  const parts = keyParts(key);
  if (!parts || !parts.indexPath || parts.indexPath === 'frontmatter') return null;
  return parts.file === pageFile ? parts.indexPath : `${parts.file}|${parts.indexPath}`;
}

/** `src/components/HeroSection.astro` → `HeroSection`. */
export function componentNameOf(file) {
  if (typeof file !== 'string') return null;
  const base = file.split('/').pop() || '';
  return base.replace(/\.(astro|md|mdx)$/i, '') || null;
}

/**
 * Whether this model can still answer for the part of the anchor it holds.
 *
 * Three answers, and `unknown` is the important one. A review on a node inside
 * a component cannot be checked while the page is what is open — the component's
 * tree is not loaded — and reporting "attached" or "orphaned" about a file
 * nobody has read is a guess either way. So the health of a review is only
 * ever updated by something that actually looked: the page it is on being
 * opened, or a focus, which opens every file on the way down.
 */
export function checkAnchor(anchor, { file, nodes, labelOf } = {}) {
  const steps = anchorSteps(anchor);
  const mine = steps.filter((s) => s.file === file);
  if (!mine.length) return { state: 'unknown', reason: 'not_open' };
  // Where each step actually resolved to. A node that moved is still the same
  // node, and saying so lets the anchor be written back at its new position
  // instead of searching for it again on every read.
  const moved = new Map();
  for (const step of mine) {
    // A door into a component is checked against the component it should open,
    // so a review does not survive its <Hero> being swapped for a <Banner>.
    const fingerprint = step.leaf
      ? anchor?.fingerprint
      : { nodeKind: 'component', tag: step.opens };
    const found = resolveNode(nodes, step.indexPath, fingerprint, { labelOf });
    if (found.confidence === 'none') return { state: 'orphaned', reason: found.reason, at: step };
    if (found.confidence === 'moved') moved.set(step.indexPath, found.trail.join('.'));
  }
  // Every step this file owns still resolves. That is the whole anchor only
  // when the leaf is one of them.
  if (!mine.some((s) => s.leaf)) return { state: 'unknown', reason: 'deeper' };
  return {
    state: 'attached',
    reason: null,
    keys: moved.size
      ? steps.map((s) => `${s.file}#${s.file === file ? moved.get(s.indexPath) ?? s.indexPath : s.indexPath}`)
      : null,
  };
}

export default resolveNode;
