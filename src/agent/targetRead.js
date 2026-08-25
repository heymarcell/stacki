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

/** A one-line description of a node, for a child or parent summary. */
function labelOf(node, crumbLabel) {
  if (!node) return null;
  if (typeof crumbLabel === 'function') {
    const label = crumbLabel(node);
    if (label) return clip(String(label), MAX_LABEL);
  }
  return clip(node.name || node.kind, MAX_LABEL);
}

function summarize(node, crumbLabel) {
  if (!node) return null;
  return {
    kind: node.kind || null,
    tag: tagOf(node),
    label: labelOf(node, crumbLabel),
    text: clip(textOf(node).join(' '), 120),
    childCount: Array.isArray(node.children) ? node.children.length : null,
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
function bindingsOf(node, { model, ancestors }) {
  const seen = new Set();
  const out = [];
  const add = (expression, where) => {
    const text = String(expression || '').trim();
    if (!text || seen.has(`${where}:${text}`) || out.length >= MAX_BINDINGS) return;
    seen.add(`${where}:${text}`);
    out.push({
      expression: text,
      where,
      source: resolveBinding(text, {
        frontmatter: model?.extraFrontmatter || '',
        imports: model?.imports || [],
        ancestors,
      }),
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
  const parent = findParentNode(model?.nodes || [], node.id);
  const nature = textNature(node);
  const bindings = bindingsOf(node, { model, ancestors });
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
      value: clip(textOf(node).join(' '), MAX_TEXT),
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
    bound: isDataBound(node),
    bindings,
    occurrence: occurrenceOf(node, { canvas, bindings, ancestors }),
    parent: summarize(parent, crumbLabel),
    children: Array.isArray(node.children)
      ? node.children.slice(0, MAX_CHILDREN).map((child, index) => ({ index, ...summarize(child, crumbLabel) }))
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
