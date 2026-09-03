// Everything Stacki knows about one editor object, in one answer.
//
// The measure of this file is a negative one: after reading it, an agent
// should have no reason to open the file. Not because opening files is
// forbidden — it is not — but because everything it would go looking for is
// already here, and looking for it again means reading a tree Stacki has
// already parsed, matching a selector Stacki has already resolved, and
// guessing at an occurrence Stacki has already counted.
//
// So this is deliberately generous where the answer is cheap and deliberately
// bounded where it is not. Props, classes, the children's shapes, the parent,
// the occurrence, what the words are bound to and what may be done to it: all
// of it, capped. The source snippet and the file:line trail are added by the
// main process, which is where the parser and the files are.
//
// Two things it says that nothing else does:
//
//   what CAN be done. `capabilities` is not documentation — it is the same
//   test the operation itself will make. An agent that reads `setText: false`
//   and tries anyway gets the identical refusal, so the two can never disagree
//   about what the editor is willing to do.
//
//   how many of these there are. A node inside `items.map(…)` is ONE node and
//   several rendered cards. Everything about that lives in `occurrence`, and
//   an answer that left it out would let "fix the third card" mean "rewrite
//   all six" without anybody noticing.

import { textOf, tagOf } from '../mcpContext.js';
import { namesIn } from '../classAttr.js';
import { isDataBound } from '../bindings.js';
import { ancestorChain, findParentNode, pathOfNode, textNature, VOID_ELEMENTS } from '../modelOps.js';
import { resolveBinding } from './bindingSource.js';

// Caps. One enormous class attribute, a page of copy or a section with two
// hundred children must not be able to fill a response on its own.
const MAX_TEXT = 600;
// The words shown in a child or parent summary. A preview, not an identity:
// see `summarize`.
const PREVIEW_TEXT = 120;
const MAX_PROPS = 40;
const MAX_PROP_VALUE = 300;
const MAX_CLASSES = 60;
const MAX_CHILDREN = 40;
const MAX_BINDINGS = 12;
const MAX_LABEL = 80;

const clip = (value, max) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** A prop as the model holds it: a literal string, or code. */
function propOf(value) {
  if (value == null) return null;
  if (value === true) return { type: 'boolean', value: 'true' };
  if (typeof value !== 'object') return { type: 'string', value: clip(String(value), MAX_PROP_VALUE) };
  const type = value.type === 'expr' ? 'expr' : value.type === 'spread' ? 'spread' : 'string';
  return { type, value: clip(String(value.value ?? ''), MAX_PROP_VALUE) ?? '' };
}

function propsOf(node) {
  const out = {};
  for (const name of Object.keys(node?.props || {}).slice(0, MAX_PROPS)) {
    const prop = propOf(node.props[name]);
    if (prop) out[name] = prop;
  }
  return out;
}

/** The text this node itself holds — what set_text replaces, and nothing else. */
function ownTextOf(node) {
  if (!node) return null;
  if (node.kind === 'text' || node.kind === 'comment') return String(node.value ?? '');
  if (node.kind === 'expr') return String(node.value ?? '');
  if (node.kind === 'map') return String(node.head ?? '');
  if (node.kind === 'cond') return String(node.test ?? '');
  if (node.kind === 'raw') return String(node.inner ?? '');
  const own = (node.children || []).find((c) => c.kind === 'text');
  return own ? String(own.value ?? '') : null;
}

/** A one-line description of a node, for a child or parent summary. */
function labelOf(node, crumbLabel) {
  if (!node) return null;
  if (typeof crumbLabel === 'function') {
    const label = crumbLabel(node);
    if (label) return clip(String(label), MAX_LABEL);
  }
  return clip(node.name || node.kind, MAX_LABEL);
}

function summarize(node, crumbLabel, keysFor, crumbsFor = null, peersFor = null) {
  if (!node) return null;
  const words = textOf(node).join(' ').trim();
  return {
    kind: node.kind || null,
    tag: tagOf(node),
    label: labelOf(node, crumbLabel),
    text: clip(words, PREVIEW_TEXT),
    // WHETHER THOSE WORDS ARE THE WHOLE OF THEM.
    //
    // The caller mints a ref from this summary, and src/reviewAnchor.js matches
    // a fingerprint's text against the node's FULL words — so a preview with an
    // ellipsis on the end can never equal anything, and the ref was dead on
    // arrival for any child with more than a hundred and twenty characters and
    // a same-tag sibling. Measured: the ref failed on the very next call, with
    // no edit and no revision movement, and answered `ambiguous`.
    //
    // A truncated preview is presentation, not identity. Saying so here lets
    // the ref carry the sibling run instead, which is evidence rather than a
    // string that cannot match.
    textClipped: words.length > PREVIEW_TEXT,
    childCount: Array.isArray(node.children) ? node.children.length : null,
    // Enough for the caller to mint a ref for this one, so walking the tree is
    // reading the answer rather than making another round trip per node.
    keys: typeof keysFor === 'function' ? keysFor(node.id) : null,
    // And enough for that ref to survive the tree moving underneath it. An
    // index path plus a tag is Stacki's "same node after a reload" rule, and
    // it is only about the slot: insert a sibling above and the slot holds
    // something else. The trail of labels is what lets the resolver find the
    // node itself, one rung further down — the same evidence a review anchor
    // carries, spelled the same way, so it reads them the same.
    breadcrumbs: typeof crumbsFor === 'function' ? crumbsFor(node.id) : null,
    // The sibling run at every level down to this node — what tells "nothing
    // moved" apart from "something was inserted above me". The node's own ref
    // has carried this from the start (it is why it survives the same
    // truncation); a child's ref had only the slot.
    peers: typeof peersFor === 'function' ? peersFor(node.id) : null,
    kindOfThing: node.kind === 'component' && !node.dynamicTag ? 'component_instance' : null,
  };
}

/**
 * What the editor is willing to do to this node.
 *
 * Every entry is the same question the operation asks, so an agent reading
 * this and an agent trying it get the same answer.
 */
function capabilitiesOf(node, { editable, parent }) {
  const nature = textNature(node);
  const isElement = node.kind === 'element' || node.kind === 'component';
  const holdsChildren = Array.isArray(node.children);
  const chunk = node.kind === 'chunk-group' || !!node.chunkFile;
  return {
    // Text that is literal may simply be replaced. Text that is bound may not,
    // and the refusal names the binding rather than shrugging.
    setText: editable && nature.kind === 'direct',
    setTextNeedsBindingReplacement: editable && (nature.kind === 'bound' || nature.kind === 'mixed'),
    setProp: editable && isElement,
    setClasses: editable && isElement && !node.props?.['class:list'] && (node.props?.class ?? { type: 'string' }).type === 'string',
    addClass: editable && isElement,
    appendChild: editable && holdsChildren,
    insertSibling: editable,
    remove: editable && !chunk,
    duplicate: editable && !chunk,
    move: editable && !chunk,
    setTag: editable && isElement,
    // Why a void element cannot hold children, said once rather than left to
    // be discovered by a refusal.
    note: node.kind === 'element' && VOID_ELEMENTS.has(String(node.name).toLowerCase())
      ? `<${node.name}> is a void element and cannot hold children.`
      : chunk
        ? 'This section is generated from the page frontmatter — change it in the code.'
        : null,
  };
}

/**
 * The bindings this node reads, each followed back to where its value lives.
 *
 * Bounded: a node with thirty expressions on it is a node whose story is told
 * by the first dozen.
 */
/**
 * A prop's value is set by whoever renders this component — and Stacki knows
 * exactly which instance that is, because the key chain that reached this node
 * came down through it. So "there is no single value" comes with the place the
 * value for THIS one is written.
 */
function withInstance(source, keys) {
  if (source?.kind !== 'prop') return source;
  const chain = Array.isArray(keys) ? keys : [];
  if (chain.length < 2) return source;
  return { ...source, instanceKeys: chain.slice(0, -1) };
}

function bindingsOf(node, { model, ancestors, keys }) {
  const seen = new Set();
  const out = [];
  const add = (expression, where) => {
    const text = String(expression || '').trim();
    if (!text || seen.has(`${where}:${text}`) || out.length >= MAX_BINDINGS) return;
    seen.add(`${where}:${text}`);
    out.push({
      expression: text,
      where,
      source: withInstance(
        resolveBinding(text, {
          frontmatter: model?.extraFrontmatter || '',
          imports: model?.imports || [],
          ancestors,
        }),
        keys
      ),
    });
  };

  for (const [name, value] of Object.entries(node.props || {})) {
    if (value?.type === 'expr' || value?.type === 'spread') add(value.value, `prop:${name}`);
  }
  const nature = textNature(node);
  for (const expression of nature.expressions) add(expression, 'text');
  if (node.kind === 'map') add(String(node.head || '').replace(/\.map\([\s\S]*$/, ''), 'loop');
  if (node.kind === 'cond') add(node.test, 'condition');
  return out;
}

/**
 * How many of this node the page is rendering, and which one is in hand.
 *
 * A node inside a loop is one node in source. Which is exactly why this has to
 * be said out loud: an edit reaches every copy, and the only honest way to
 * offer "change the third card" is to point at the data behind the third card
 * instead.
 */
function occurrenceOf(node, { canvas, bindings, ancestors }) {
  const count = Number.isInteger(canvas?.occurrenceCount) ? canvas.occurrenceCount : null;
  const index = Number.isInteger(canvas?.occurrence) ? canvas.occurrence : null;
  // The loop itself is not one of its own copies. Saying "editing this changes
  // every copy" about the `.map(` is true and useless — what an agent wants to
  // know there is what the list is.
  if (node.kind === 'map') {
    const list = bindings.find((b) => b.where === 'loop')?.source || null;
    return {
      index: null,
      count,
      repeated: true,
      scope: 'loop',
      note: 'This is the loop, not one of the things it renders. Its children are the template every item uses.',
      perOccurrence: null,
      list,
    };
  }
  const inLoop = (ancestors || []).some((a) => a?.kind === 'map');
  const repeated = inLoop || (count != null && count > 1);
  // The list behind the repetition, when a binding names one. That ref is the
  // difference between changing one card and changing the template.
  const item = bindings.find((b) => b.source?.kind === 'loop_item')?.source || null;
  return {
    index,
    count,
    repeated,
    // The plain-language version of the thing that must never be silent.
    scope: repeated
      ? 'shared_template'
      : 'single',
    note: repeated
      ? `This is one source node rendered ${count == null ? 'more than once' : `${count} times`}. ` +
        'Editing it here changes every copy. To change one copy, change the data item behind it — ' +
        (item ? `follow perOccurrence.` : 'Stacki could not resolve which list it comes from, so say so rather than editing one and hoping.')
      : null,
    perOccurrence: item,
  };
}

/**
 * Build the answer.
 *
 * Everything comes from state the app already holds: the model it is editing,
 * what the canvas last measured, the classes the page reported. Nothing here
 * reads a file or asks the preview a question — the two answers that need
 * those are added by the caller.
 */
export function readTarget({
  node,
  model,
  page,
  keys,
  editable = true,
  crumbLabel = null,
  keysFor = null,
  crumbsFor = null,
  peersFor = null,
  canvas = null,
  renderedClasses = null,
  componentChain = null,
  breadcrumbs = null,
  hidden = false,
  inert = false,
  confidence = 'exact',
  writable = true,
}) {
  if (!node) return null;
  const ancestors = ancestorChain(model?.nodes || [], node.id) || [];
  const keysOf = typeof keysFor === 'function' ? keysFor : null;
  const peersOf = typeof peersFor === 'function' ? peersFor : null;
  const parent = findParentNode(model?.nodes || [], node.id);
  const nature = textNature(node);
  const ownWords = textOf(node).join(' ').trim();
  const bindings = bindingsOf(node, { model, ancestors, keys });
  const authored = [
    ...new Set([
      ...namesIn(node.props?.class),
      ...namesIn(node.props?.['class:list']),
    ]),
  ].slice(0, MAX_CLASSES);

  return {
    kind: node.kind || null,
    tag: tagOf(node),
    label: labelOf(node, crumbLabel),
    page: { file: page?.file || null, route: page?.route || null },
    // The path an editor walks to reach this. The main process turns it into
    // file:line; it is here too because it is what a later call names.
    keys: Array.isArray(keys) ? keys : [],
    indexPath: (pathOfNode(model?.nodes || [], node.id) || []).join('.') || null,
    componentChain: componentChain || null,
    breadcrumbs: breadcrumbs || null,
    text: {
      nature: nature.kind,
      // What the node reads as, however deep the words are — the same reading
      // get_context reports and a review fingerprints against.
      value: clip(ownWords, MAX_TEXT),
      // And whether that reading is the whole of it. Same reason as
      // `summarize`'s `textClipped`: a clipped value is a preview, and a
      // fingerprint built from one names words no node will ever have.
      truncated: ownWords.length > MAX_TEXT,
      // And what set_text would actually replace, which is only ever this
      // node's own text. The two differ for anything with children, and an
      // agent that took the first for the second would type a section's whole
      // contents into its first paragraph.
      own: clip(ownTextOf(node), MAX_TEXT),
      expressions: nature.expressions.slice(0, MAX_BINDINGS),
    },
    props: propsOf(node),
    classes: {
      authored,
      // What the element actually carries on the page. A class written as an
      // expression has no text in the source, so this is the only place the
      // applied classes are knowable.
      rendered: Array.isArray(renderedClasses) ? renderedClasses.slice(0, MAX_CLASSES) : null,
    },
    // A component instance renders another file. Its children here are what
    // the page puts INTO it; what it is made of is inside its own definition,
    // which target "enter" opens the way a double-click does.
    component:
      node.kind === 'component' && !node.dynamicTag
        ? { name: node.name || null, enterable: true }
        : null,
    bound: isDataBound(node),
    bindings,
    occurrence: occurrenceOf(node, { canvas, bindings, ancestors }),
    parent: summarize(parent, crumbLabel, keysOf, crumbsFor, peersOf),
    children: Array.isArray(node.children)
      ? node.children
          .slice(0, MAX_CHILDREN)
          .map((child, index) => ({ index, ...summarize(child, crumbLabel, keysOf, crumbsFor, peersOf) }))
      : null,
    childrenOmitted: Array.isArray(node.children) ? Math.max(0, node.children.length - MAX_CHILDREN) : 0,
    hidden: !!hidden,
    inert: !!inert,
    rect: canvas?.rect || null,
    capabilities: capabilitiesOf(node, { editable, parent }),
    // How sure Stacki is that this is the node the ref was minted about, and
    // whether that is sure enough to write through. See src/reviewCheckout.js:
    // a position that merely held is not evidence about another tree.
    confidence,
    editable: !!editable && !!writable,
  };
}

export default readTarget;
