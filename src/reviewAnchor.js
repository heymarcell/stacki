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
 * The run of siblings a node belongs to, among those of its own kind and tag.
 *
 * `{ index, count }` — which one it is, and how many there are. This is the
 * only thing that can tell "nothing moved" apart from "something was inserted
 * above me", and without it an index path is not identity at all: insert a
 * card at the top of a list and every index below it addresses a different
 * card that looks exactly the same.
 */
export function peersAt(nodes, trail) {
  if (!Array.isArray(trail) || !trail.length) return null;
  const parent = trail.slice(0, -1);
  const list = parent.length ? nodeAt(nodes, parent)?.children : nodes;
  if (!Array.isArray(list)) return null;
  const self = list[trail[trail.length - 1]];
  if (!self) return null;
  const kind = self.kind;
  const tag = tagOf(self);
  let index = -1;
  let count = 0;
  for (const node of list) {
    if (node.kind !== kind || tagOf(node) !== tag) continue;
    if (node === self) index = count;
    count += 1;
  }
  return index === -1 ? null : { index, count };
}

/**
 * The sibling run at EVERY level on the way down to a node.
 *
 * The leaf alone is not enough, and the reason is the whole point: a heading
 * is usually the only heading inside its own card, so its own run never
 * changes — while the card it lives in slides down the page because somebody
 * added another card above. What moved was an ancestor. So every level is
 * recorded, and a change at any of them means the stored index path may now
 * address a different, identical-looking thing.
 */
export function peerPath(nodes, trail) {
  if (!Array.isArray(trail) || !trail.length) return null;
  const out = [];
  for (let depth = 1; depth <= trail.length; depth++) {
    const run = peersAt(nodes, trail.slice(0, depth));
    if (!run) return null;
    out.push(run);
  }
  return out;
}

/** Whether two recorded sibling runs describe the same place in the tree. */
export function samePeerPath(then, now) {
  if (!Array.isArray(then) || !Array.isArray(now) || then.length !== now.length) return false;
  return then.every((a, i) => a && now[i] && a.index === now[i].index && a.count === now[i].count);
}

/**
 * Where a review's node is in this model now.
 *
 * The ladder runs from proof to evidence to nothing:
 *
 *   1. The stored slot is provably still the same SLOT — either the node has
 *      no same-kind siblings to be confused with, or the sibling run is
 *      exactly the size and shape it was when the review was written. Note
 *      what that proves and what it does not: nothing slid past this position.
 *      Whether the thing standing in it is the same NODE is a separate
 *      question, and when the recorded words are gone it is not one this can
 *      answer — see "What this cannot do" below.
 *
 *   2. The slot moved, so the recorded marks have to identify it: same kind,
 *      same tag, same ancestor labels AND the same words. Exactly one such
 *      node is an answer. Two or more is a coin toss, and a coin toss is an
 *      orphan.
 *
 *   3. Nothing carries the recorded words — they were edited. The slot is
 *      usable only when there is exactly one candidate in the whole file, so
 *      there was nothing for it to slide between.
 *
 * The case this shape exists for: a sibling inserted above the target AND the
 * target's words changed in the same edit. The slot now holds a different card
 * that looks identical, and no node carries the old words. There is no evidence
 * left, so the only honest answer is `orphaned` — a review pointing at the
 * wrong card is far worse than one pointing at nothing.
 *
 * WHAT THIS CANNOT DO, and why it does not pretend otherwise.
 *
 * Two same-kind siblings swap places while the reviewed one's words are also
 * edited, all in one save. Nothing was added or removed, so every sibling run
 * is the shape it always was; and the old words are gone, so nothing points at
 * where the node went. That input is not merely hard to read — it is the SAME
 * input as an ordinary in-place copy edit on two neighbouring nodes. The two
 * edits produce byte-identical source (test/review-anchor.js proves it by
 * building both), so no function of the tree and the fingerprint can answer
 * both correctly. It is not a gap in the rules; it is the absence of a stable
 * node identity in the source, and the only cures are writing ids into
 * somebody's project or keeping an edit log — a second source-mapping system.
 * Neither is worth it for this.
 *
 * So a prior is chosen, deliberately: KEEP THE SLOT. An in-place copy edit is
 * what happens every time a piece of feedback is acted on — it is the dominant
 * outcome of this whole feature — and orphaning it would turn every success
 * into a lost anchor. A reorder-and-rename in one save is rare by comparison,
 * and when the prior is wrong it lands the review on an adjacent node of the
 * same kind under the same ancestors, with the pin visibly moving and the
 * frozen creationContext still describing what was meant. Wrong, but bounded
 * and visible; the alternative is quietly broken all the time.
 *
 * Answers `{ id, trail, confidence, reason }`:
 *
 *   exact       the slot held and the words still agree, or there were none
 *   positional  the slot held on structure alone and the words are gone — the
 *               node is very probably right and is not proven to be
 *   moved       found somewhere else by its recorded marks
 *   none        orphaned; `reason` says which way
 */
export function resolveNode(nodes, indexPath, fingerprint, { labelOf } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const trail = trailOfPath(indexPath);
  const fp = fingerprint || {};
  const at = trail ? nodeAt(list, trail) : null;
  const atMatches = !!at && sameSort(at, fp);
  const fpText = norm(fp.text);

  const wanted = ancestorsOf(fp);
  // Everything this could be: same kind, same tag, same ancestry. Without
  // recorded ancestors there is nothing worth searching on — kind and tag
  // alone match every <span> in the file.
  const peers = wanted
    ? walk(list, labelOf).filter((e) => sameSort(e.node, fp) && chainMatches(e.chain, wanted))
    : [];

  // Where the recorded words are NOW. Needed before rung 1, not after: a
  // structural proof about a slot is only a proof about the slot, and the
  // words can say the target left it.
  const marked = fpText ? peers.filter((e) => wordsOf(e.node) === fpText) : peers;
  const atSays = !fpText || wordsOf(at) === fpText;
  const claimedElsewhere = !!fpText && marked.some((e) => e.node !== at);

  // 1 — is the slot provably the same slot?
  const now = trail ? peerPath(list, trail) : null;
  const then = Array.isArray(fp.peers) && fp.peers.length ? fp.peers : null;
  const slotHeld =
    atMatches &&
    // Two cards swapped places. Every sibling run is the size and shape it
    // always was — reordering does not change how many there are — so the
    // structural proof below still says "same slot", and it is wrong: the
    // words the review recorded are sitting on a DIFFERENT node now. Either
    // this slot still says what the review said, or nothing else does; a slot
    // whose words moved next door is not this review's slot any more.
    (atSays || !claimedElsewhere) &&
    // Nothing anywhere on the way down has a same-kind sibling, so there is
    // nothing for the path to have slid between.
    ((now && now.every((run) => run.count === 1)) ||
      // The run is exactly the size and shape it was: same slot, provably.
      samePeerPath(then, now) ||
      // No run was recorded. That is a review written before runs existed, or
      // a synthesised fingerprint (the component a drill step should open,
      // which has neither ancestors nor words). Those keep the older rule —
      // position plus kind and tag — which is what they have always used. It
      // is weaker, and it is why `peers` exists for everything written from
      // now on; orphaning every such review on sight would be worse.
      (!then && (!wanted || atSays)));
  // Held, but say how. `exact` is the slot plus corroborating words; when the
  // recorded words are gone this is a position that nothing slid past, which is
  // a weaker thing and is named as one rather than dressed up as proof.
  if (slotHeld) return { id: at.id, trail, confidence: atSays ? 'exact' : 'positional', reason: null };

  // 2 — exactly one node still carries every recorded mark.
  if (marked.length === 1) {
    const found = marked[0];
    return { id: found.node.id, trail: found.trail, confidence: 'moved', reason: null };
  }
  if (marked.length > 1) return { id: null, trail: null, confidence: 'none', reason: 'ambiguous' };

  // 3 — nothing carries the recorded words, so they were edited. That is the
  //     ordinary end of a piece of feedback being acted on, and it must not
  //     orphan the review that asked for it. It is safe exactly when there is
  //     ONE node in the whole file of this kind, tag and ancestry: whatever it
  //     now says, there is nothing else it could be.
  if (peers.length === 1) {
    const only = peers[0];
    return { id: only.node.id, trail: only.trail, confidence: 'moved', reason: null };
  }
  if (!wanted) return { id: null, trail: null, confidence: 'none', reason: trail ? 'changed' : 'no_path' };
  return { id: null, trail: null, confidence: 'none', reason: peers.length ? 'ambiguous' : 'gone' };
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
 * Whether a loaded page state really is the tree of `file`.
 *
 * `openFile` sets the current file BEFORE it reads it and the model AFTER, so
 * for one render the app names a new file while still holding the previous
 * one's tree. Judging an anchor in that window means looking for a component's
 * node in the page's document and concluding it is gone — which orphaned
 * perfectly good comments every time somebody navigated past them, and did it
 * silently, because "not found" and "not loaded yet" look identical to a
 * resolver.
 *
 * The stamp is what tells the pair apart. An unstamped state is trusted:
 * in-place edits spread the previous state forward and keep the stamp, so the
 * only way to be unstamped is to predate stamping entirely.
 */
export function modelMatchesFile(pageState, file) {
  if (!pageState?.model) return false;
  return !pageState.file || pageState.file === file;
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
