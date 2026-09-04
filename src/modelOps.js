// The editor's node operations, as functions of a model.
//
// Everything here is a change somebody can make to a page: set some text, put
// a class on an element, move a node, delete one. It lives in its own file for
// one reason — there must be exactly one implementation of each of them.
//
// Before the Agent API, all of this was inline in App.jsx, reachable only from
// the panel that called it. An MCP server that wanted to do the same things
// had two choices: drive React from the outside, or write a second copy. The
// second copy is the one that rots — it forgets that deleting a node also
// deletes the note above it, that moving one out of a loop strips the bindings
// that would now throw, that a `slot` means nothing once the component around
// it is gone. Every one of those was learned the hard way and is written down
// exactly once, here.
//
// So the panels call these, and so does the agent, and neither of them can
// drift from the other. Each function takes a model and mutates it in place —
// App's `mutateModel` hands it a structural clone, pushes the undo snapshot
// and schedules the save, which is why nothing in this file knows about React,
// history, or saving.
//
// `notes` is how an operation says something out loud. Deleting a node that
// leaves a stranded frontmatter const is worth a sentence; the panel shows it
// as a toast, the agent gets it in its tool result. The operation itself does
// not care which.

import { ASTRO_ASSETS, ASTRO_ASSETS_MODULE, PLACEHOLDER_PROPS } from './astroAssets.js';
import { hasClass, namesIn, withClass } from './classAttr.js';
import { getElementSchema, GLOBAL_ATTRS } from './elementSchemas.js';
import { keepsSlot } from './slotAttr.js';
import { noteIndexAbove, noteValue, selectionAfterDelete } from './treeSelection.js';
import { unusedDeclarations, withoutDeclarations } from './frontmatterMove.js';

let idCounter = 1000;
export const newId = () => `c${idCounter++}`;

// HTML elements that can never have children.
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Placeholder copy for newly inserted text elements, so they're visible on the
// canvas straight away instead of collapsing to a zero-height box.
export const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius ' +
  'enim in eros elementum tristique. Duis cursus, mi quis viverra ornare, eros ' +
  'dolor interdum nulla, ut commodo diam libero vitae erat. Aenean faucibus nibh ' +
  'et justo cursus id rutrum lorem imperdiet. Nunc ut sem vitae risus tristique ' +
  'posuere.';
export const DEFAULT_TEXT = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: LOREM,
};

// ---------------------------------------------------------------------------
// Tree helpers (model.nodes is a tree of {id, kind, name?, props?, children?})
// ---------------------------------------------------------------------------

export function findNodeById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (Array.isArray(node.children)) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Returns {list, index} of the array containing the node.
// Whether a subtree reads anything from the file it currently sits in — an
// expression, a conditional, a loop, or a prop written as code. Moved into a
// component, those names aren't in scope any more: `{title}` in a page reads
// the page's `title`, and in Card.astro it reads nothing at all. Not something
// to refuse over (the fix is a prop, and only the author knows its name) but
// very much something to say out loud.
export function usesPageScope(node) {
  if (!node || typeof node !== 'object') return false;
  if (['expr', 'cond', 'map', 'branch'].includes(node.kind)) return true;
  for (const value of Object.values(node.props || {})) {
    if (value && value.type === 'expr') return true;
  }
  return (node.children || []).some(usesPageScope);
}

export function findParentList(model, id) {
  const search = (list) => {
    const index = list.findIndex((n) => n.id === id);
    if (index !== -1) return { list, index };
    for (const node of list) {
      if (Array.isArray(node.children)) {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return search(model.nodes);
}

export function isDescendantOf(candidateParent, id) {
  if (!Array.isArray(candidateParent.children)) return false;
  return !!findNodeById(candidateParent.children, id) || candidateParent.id === id;
}

// Position (index trail) of a node in the tree, for re-selecting the
// equivalent node after an external reload regenerates ids.
export function pathOfNode(nodes, id, trail = []) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return [...trail, i];
    if (Array.isArray(n.children)) {
      const p = pathOfNode(n.children, id, [...trail, i]);
      if (p) return p;
    }
  }
  return null;
}

// Ancestor chain (root → … → node) for breadcrumbs.
export function ancestorChain(nodes, id, trail = []) {
  for (const node of nodes) {
    if (node.id === id) return [...trail, node];
    if (Array.isArray(node.children)) {
      const r = ancestorChain(node.children, id, [...trail, node]);
      if (r) return r;
    }
  }
  return null;
}

export function nodeAtPath(nodes, trail) {
  let list = nodes;
  let node = null;
  for (const i of trail) {
    node = list?.[i];
    if (!node) return null;
    list = Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

// The node whose children list holds `id` — null when it sits at the page root.
export function findParentNode(nodes, id) {
  for (const n of nodes) {
    if (!Array.isArray(n.children)) continue;
    if (n.children.some((c) => c.id === id)) return n;
    const found = findParentNode(n.children, id);
    if (found) return found;
  }
  return null;
}

// Loops and conditionals render their children straight through, so a `slot`
// under one is still read by whatever component sits above it.
export const SLOT_TRANSPARENT = new Set(['map', 'cond', 'branch', 'chunk-group']);

// The component (or layout) whose slots a node's `slot` attribute names,
// looking past those pass-through wrappers. Null when the node lands in a
// plain element or at the page root — nothing there reads a slot name.
export function slotHostOf(model, id) {
  let node = findParentNode(model.nodes, id);
  while (node && SLOT_TRANSPARENT.has(node.kind)) {
    node = findParentNode(model.nodes, node.id);
  }
  return node && node.kind === 'component' ? node : null;
}

// What we know about a placed component, which may be imported under a local
// name of its own (`import Layout from '../layouts/BaseLayout.astro'`) — so
// fall back to the file the import points at. Null means "no definition
// scanned", which is never the same answer as "has no slots".
export function definitionOf(model, node, insertables) {
  const byName = insertables.find((c) => c.name === node.name);
  if (byName) return byName;
  const imp = (model.imports || []).find((i) => i.name === node.name);
  const base = imp?.path.split('/').pop()?.replace(/\.astro$/i, '');
  return (base && insertables.find((c) => c.name === base)) || null;
}

// ---------------------------------------------------------------------------
// Renaming a loop variable
//
// `services.map((service) => …)` — renaming `service` has to follow every
// reference below it, or the loop's own children stop compiling. Text-level
// rewriting, since the children hold code as strings.
// ---------------------------------------------------------------------------

export const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/;

export function splitMapHead(head) {
  const m = String(head).trim().match(MAP_HEAD_RE);
  return m ? { data: m[1].trim(), item: m[2], index: m[3] || '' } : null;
}

// Whole identifier only: `service` but never the `service` in `x.service`
// (a property of something else) or in `services`.
export const renameIdent = (code, from, to) =>
  String(code ?? '').replace(new RegExp(`(?<![.\\w$])${from}(?![\\w$])`, 'g'), to);

// Text nodes are prose with {expressions} in it — rewrite only the braces,
// so a loop variable named `title` doesn't rewrite the word in a sentence.
export const renameInBraces = (text, from, to) =>
  String(text ?? '').replace(/\{([^{}]*)\}/g, (_, inner) => `{${renameIdent(inner, from, to)}}`);

export function renameLoopVar(nodes, from, to) {
  for (const n of nodes) {
    if (n.kind === 'map') {
      const p = splitMapHead(n.head);
      if (p) {
        // Only the data expression is a reference; the parameters are this
        // loop's own declarations.
        const data = renameIdent(p.data, from, to);
        if (data !== p.data) {
          n.head = `${data}.map((${p.item}${p.index ? `, ${p.index}` : ''}) => (`;
        }
        // Declarations in a statement-body loop read the outer item as
        // freely as the markup does.
        if (Array.isArray(n.body)) n.body = n.body.map((line) => renameIdent(line, from, to));
        // A nested loop that re-declares the name shadows the outer one, so
        // everything below it means something else by it.
        if (p.item === from || p.index === from) continue;
      } else {
        n.head = renameIdent(n.head, from, to); // custom head — best effort
      }
    } else if (n.kind === 'expr') {
      n.value = renameIdent(n.value, from, to);
    } else if (n.kind === 'cond') {
      n.test = renameIdent(n.test, from, to);
    } else if (n.kind === 'text') {
      n.value = renameInBraces(n.value, from, to);
    }
    for (const [key, v] of Object.entries(n.props || {})) {
      if (v?.type === 'expr') n.props[key] = { ...v, value: renameIdent(v.value, from, to) };
    }
    if (Array.isArray(n.children)) renameLoopVar(n.children, from, to);
  }
}

// First element with this tag, depth-first. Used to land the selection on a
// layout's <body> when it is opened: the html/head wrapper above it is not
// what anyone came to edit, and <body> is the page's real root.
export function findElementByTag(nodes, tag) {
  for (const n of nodes || []) {
    if (n.kind === 'element' && String(n.name).toLowerCase() === tag) return n;
    if (Array.isArray(n.children)) {
      const found = findElementByTag(n.children, tag);
      if (found) return found;
    }
  }
  return null;
}

// What a freshly opened component starts on: its <body> when it owns the
// document (a layout), otherwise the first thing its markup renders. Leading
// comments and text aren't what the file is about, so they're skipped; if
// there's nothing else, the first node of any kind is better than nothing.
export function openingSelection(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  return findElementByTag(list, 'body') || outermostNode(list);
}

// The outermost thing a page renders: its layout wrapper when it has one,
// otherwise the first real node. A doctype line, a leading comment or stray
// whitespace isn't what the page is about, so those are skipped — but any
// node beats selecting nothing.
export function outermostNode(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.find((n) => n.kind === 'element' || n.kind === 'component') || list[0] || null;
}

export function collectUsedNames(model) {
  const used = new Set();
  const walk = (list) => {
    for (const node of list) {
      if (node.name) used.add(node.name);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(model.nodes);
  return used;
}

// Comments in the frontmatter are prose about the page, and prose names the
// things the page is built from — `// Hero copy` is talk about <Hero>, not a
// use of it. Only whole-line `//` comments go: a trailing one can't be told
// from the `//` inside a URL without really parsing, and cutting a string in
// half there would hide a reference that is real.
export function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Everything in the file that is code rather than markup: the frontmatter, a
// loop's head, a condition's test, an expression node, and any prop whose
// value is an expression. An imported name can be used in any of them without
// ever appearing as a tag.
//
// <style> and <script> bodies are pointedly not code for this purpose. Both
// are their own scope in Astro — CSS never sees a frontmatter binding, and a
// <script> is a separate module — so a name inside one is a coincidence, not
// a use. Reading them meant a `.Hero` class or a `/* Hero */` note pinned
// <Hero>'s import in place for good. What those blocks genuinely share comes
// in through `define:vars`, which is a prop expression and is still read.
export function codeText(model) {
  const parts = [stripComments(model.extraFrontmatter || '')];
  const walk = (list) => {
    for (const node of list) {
      if (node.kind === 'expr' || node.kind === 'raw-line') parts.push(node.value || '');
      if (node.kind === 'map') parts.push(node.head || '');
      if (node.kind === 'cond') parts.push(node.test || '');
      for (const v of Object.values(node.props || {})) {
        if (v && (v.type === 'expr' || v.type === 'spread')) parts.push(String(v.value ?? ''));
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(model.nodes);
  return parts.join('\n');
}
// Imports the app is willing to remove once nothing refers to them: a
// component file of any flavour Astro renders, an image, and Astro's own
// <Image>/<Picture>. All three are reachable only as a tag or from an
// expression, both of which the check below reads in full. A stylesheet, a
// data module or a utility is left alone — those get imported for effects
// this file can't see, and dropping one that is still doing its job breaks
// the page.
export const COMPONENT_IMPORT_RE = /\.(astro|jsx|tsx|vue|svelte)$/i;
export const ASSET_IMPORT_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

export function prunableImport(i) {
  return (
    COMPONENT_IMPORT_RE.test(i.path) ||
    ASSET_IMPORT_RE.test(i.path) ||
    i.path === ASTRO_ASSETS_MODULE
  );
}

export function pruneImports(model) {
  const used = collectUsedNames(model);
  // A name can be referenced as code rather than as a tag — inside a
  // `<Fragment set:html>` chunk, a frontmatter const, a prop expression. The
  // test is deliberately loose (a bare word anywhere in the code counts),
  // because the cost of a false positive is a stray import and the cost of a
  // false negative is deleting something the page still needs.
  const code = codeText(model);
  const mentioned = (name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
  model.imports = model.imports.filter(
    (i) => !prunableImport(i) || used.has(i.name) || mentioned(i.name)
  );
}

// Chooses an import path matching the page's existing style: if it already
// imports via a src alias (e.g. "@/components/X.astro"), reuse that alias
// root for the new import; otherwise fall back to a relative path.
export function chooseImportPath(model, { relative, srcRelative }) {
  if (srcRelative) {
    for (const imp of model.imports) {
      if (imp.path.startsWith('.')) continue;
      for (const marker of ['/components/', '/layouts/']) {
        const idx = imp.path.indexOf(marker);
        if (idx > 0) return imp.path.slice(0, idx + 1) + srcRelative;
      }
    }
  }
  return relative;
}

// `data.map((item[, index]) => (` → its pieces, or null when the head is
// hand-written code the loop editor can't model.
export function parseLoopHead(head) {
  const m = String(head || '').match(
    /^([\s\S]*?)\.map\(\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*=>\s*\($/
  );
  return m ? { data: m[1].trim(), item: m[2], index: m[3] || '' } : null;
}

// Whether `expr` reads from the variable `v` (`service`, `service.tags`) —
// not merely contains its letters (`services`, `x.service`).
export const readsVar = (expr, v) =>
  new RegExp(`(^|[^\\w$.])${v}\\b`).test(String(expr || ''));

// Switching a loop's data source orphans any loop beneath it that reads from
// the item — `service.tags.map(...)` under `services.map((service) => …)`
// would call .map on undefined once the parent points somewhere else. Those
// loops are repointed at an empty array: still valid code, renders nothing,
// and the child markup is preserved for re-pointing by hand.
export function disconnectDependentLoops(list, vars) {
  for (const n of list || []) {
    if (!Array.isArray(n.children)) continue;
    if (n.kind === 'map') {
      const h = parseLoopHead(n.head);
      if (h && vars.some((v) => readsVar(h.data, v))) {
        n.head = `[].map((${h.item}${h.index ? `, ${h.index}` : ''}) => (`;
      }
      // The declarations are left alone: an empty list never calls the
      // callback, so nothing in there can run, and the code is still what the
      // user wrote for when they point it at data again.
      // A nested loop that reuses the name shadows it, so anything deeper
      // refers to the inner one and is still valid.
      const shadowed = new Set([h?.item, h?.index].filter(Boolean));
      const rest = vars.filter((v) => !shadowed.has(v));
      if (rest.length) disconnectDependentLoops(n.children, rest);
    } else if (n.kind === 'cond') {
      // Same for a condition reading the item: false renders the else branch
      // instead of throwing.
      if (vars.some((v) => readsVar(n.test, v))) n.test = 'false';
      disconnectDependentLoops(n.children, vars);
    } else {
      disconnectDependentLoops(n.children, vars);
    }
  }
}

// The loop variables in scope at a node: every enclosing map's item/index.
export function loopVarsAt(nodes, id) {
  const vars = [];
  const walk = (list, scope) => {
    for (const n of list) {
      if (n.id === id) {
        vars.push(...scope);
        return true;
      }
      if (Array.isArray(n.children)) {
        const next =
          n.kind === 'map'
            ? [...scope, ...[parseLoopHead(n.head)?.item, parseLoopHead(n.head)?.index].filter(Boolean)]
            : scope;
        if (walk(n.children, next)) return true;
      }
    }
    return false;
  };
  walk(nodes, []);
  return [...new Set(vars)];
}

// What a dropped binding is replaced with, so the element keeps rendering
// something you can select and retype.
export const UNBOUND_TEXT = 'content';

// Moving or pasting a node out of its loop leaves its bindings pointing at a
// variable that no longer exists — `{service.text}` becomes a hard
// ReferenceError that blanks the whole page. Replace exactly those bindings:
// `{…}` children and interpolations become placeholder text, expression props
// are dropped (a stale `href="content"` would just be a broken link), and
// nested loops that read from the departed item are pointed at an empty
// array.
export function stripLostBindings(node, vars) {
  if (!vars.length) return 0;
  let removed = 0;
  const walk = (n) => {
    for (const [k, v] of Object.entries(n.props || {})) {
      if (v?.type === 'expr' && vars.some((x) => readsVar(v.value, x))) {
        delete n.props[k];
        removed++;
      }
    }
    // A dropped binding leaves placeholder text rather than a hole, so the
    // element stays visible and editable on the canvas.
    if (n.kind === 'expr' && vars.some((x) => readsVar(n.value, x))) {
      removed++;
      n.kind = 'text';
      n.value = UNBOUND_TEXT;
      delete n.head;
      delete n.children;
      return;
    }
    if (n.kind === 'text' && n.value.includes('{')) {
      const next = n.value.replace(/\{([^{}]*)\}/g, (whole, inner) =>
        vars.some((x) => readsVar(inner, x)) ? UNBOUND_TEXT : whole
      );
      if (next !== n.value) {
        removed++;
        n.value = next;
      }
    }
    if (n.kind === 'map') {
      const h = parseLoopHead(n.head);
      if (h && vars.some((x) => readsVar(h.data, x))) {
        n.head = `[].map((${h.item}${h.index ? `, ${h.index}` : ''}) => (`;
        removed++;
      }
      if (Array.isArray(n.body)) {
        // This loop can still run (its own data may be fine), so a
        // declaration reading a lost variable would throw. Dropping the line
        // would orphan whatever reads the name it declares — so keep the
        // binding and swap what it's assigned, the same placeholder a lost
        // text binding gets.
        n.body = n.body.map((line) => {
          if (!vars.some((x) => readsVar(line, x))) return line;
          const decl = line.match(/^((?:const|let)\s+[^=]+=\s*)/);
          if (!decl) return line;
          removed++;
          return `${decl[1]}'${UNBOUND_TEXT}';`;
        });
      }
    }
    // A condition on a variable that's gone would throw; false keeps the
    // markup and renders the else branch.
    if (n.kind === 'cond' && vars.some((x) => readsVar(n.test, x))) {
      n.test = 'false';
      removed++;
    }
    if (Array.isArray(n.children)) {
      n.children.forEach(walk);
      n.children = n.children.filter((c) => !c.__drop);
    }
  };
  walk(node);
  return removed;
}

export function insertIntoModel(model, node, target) {
  if (!target || target.parentId == null) {
    const index = target ? Math.min(target.index, model.nodes.length) : model.nodes.length;
    model.nodes.splice(index, 0, node);
    return;
  }
  const parent = findNodeById(model.nodes, target.parentId);
  if (!parent) {
    model.nodes.push(node);
    return;
  }
  if (!Array.isArray(parent.children)) parent.children = [];
  const index = Math.min(target.index, parent.children.length);
  parent.children.splice(index, 0, node);
}
// ---------------------------------------------------------------------------
// The operations
//
// One function per thing somebody can do, each a pure function of the model it
// is handed. Every one of them returns the same shape:
//
//   { ok, code?, message?, notes: [], selectId? }
//
// `ok: false` means nothing was changed — checked before anything is written,
// so a batch that fails on its third operation leaves the first two undone
// rather than half-applied. `notes` is what the operation wants said out loud.
// `selectId` is where the selection should end up, when the operation has an
// opinion (a duplicate selects the copy; a delete selects the neighbour).
// ---------------------------------------------------------------------------

const fail = (code, message) => ({ ok: false, code, message, notes: [] });
const done = (extra = {}) => ({ ok: true, notes: [], ...extra });

/** Every id in a subtree, so a batch can tell whether its target survived. */
export function idsIn(node, out = new Set()) {
  if (!node) return out;
  out.add(node.id);
  for (const child of node.children || []) idsIn(child, out);
  return out;
}

/** A copy of a subtree with fresh ids, so it can sit beside the original. */
export function cloneWithNewIds(node) {
  const clone = structuredClone(node);
  const walk = (n) => {
    n.id = newId();
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(clone);
  return clone;
}

// --- text ------------------------------------------------------------------

/**
 * Where a node's rendered words come from, and whether they can be typed over.
 *
 * This is the distinction the whole "do not silently replace a binding" rule
 * rests on. `<h1>Hello</h1>` is words in the file. `<h1>{product.title}</h1>`
 * is a program that fetches words, and typing "Hello" over it does not change
 * a title — it deletes a feature and makes the page lie about where its
 * content lives.
 *
 *   direct   the words are literal text and may be replaced.
 *   bound    an expression produces them. `expressions` names what to follow.
 *   mixed    literal text with interpolations in it — the text is editable,
 *            the holes are not, so replacing the lot would drop them.
 *   none     nothing here renders words (a void element, a <style> block).
 */
export function textNature(node) {
  if (!node) return { kind: 'none', expressions: [] };
  if (node.kind === 'expr') {
    return { kind: 'bound', expressions: [innerExpression(node.value)].filter(Boolean) };
  }
  if (node.kind === 'text' || node.kind === 'comment') {
    const holes = [...String(node.value ?? '').matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].trim());
    return holes.length ? { kind: 'mixed', expressions: holes } : { kind: 'direct', expressions: [] };
  }
  // A loop head, a condition's test and a raw block's body are code somebody
  // types; they are edited directly and nothing about them is "bound".
  if (node.kind === 'map' || node.kind === 'cond' || node.kind === 'raw') {
    return { kind: 'direct', expressions: [] };
  }
  if (node.kind !== 'element' && node.kind !== 'component') return { kind: 'none', expressions: [] };
  if (node.children === null) return { kind: 'none', expressions: [] };
  const kids = node.children || [];
  const expressions = [];
  let literal = false;
  for (const child of kids) {
    if (child.kind === 'expr') expressions.push(innerExpression(child.value));
    else if (child.kind === 'text') {
      const holes = [...String(child.value ?? '').matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].trim());
      if (holes.length) expressions.push(...holes);
      if (String(child.value ?? '').replace(/\{[^{}]*\}/g, '').trim()) literal = true;
    }
  }
  if (expressions.length) return { kind: literal ? 'mixed' : 'bound', expressions: expressions.filter(Boolean) };
  return { kind: 'direct', expressions: [] };
}

/**
 * What an expression node actually says.
 *
 * The parser keeps an expression child as it was written — braces and all —
 * because that is what serializing it back has to produce. Everything that
 * REASONS about one wants what is inside them: `{post.title}` is a reference to
 * `post.title`, and a resolver handed the braces concludes it is looking at
 * code it cannot follow.
 */
export function innerExpression(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return text;
  return text.slice(1, -1).trim();
}

/**
 * Set a node's own words.
 *
 * An element or component gets its single text child replaced (or one added);
 * a text, expression or comment node gets its value; a loop gets its head, a
 * condition its test, a raw block its body. `renames` carries the loop
 * variables this edit renames, so references below the node follow — the loop
 * editor's own behaviour, unchanged.
 *
 * Refuses when the words come from a binding, unless the caller has explicitly
 * said it means to replace one.
 */
export function setText(model, { nodeId, value, renames = null, replaceBinding = false, slotHint = null }) {
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');

  const nature = textNature(node);
  if (nature.kind === 'none') {
    return fail('not_text', `A <${node.name || node.kind}> has no text of its own to set.`);
  }
  if ((nature.kind === 'bound' || nature.kind === 'mixed') && !replaceBinding) {
    return {
      ok: false,
      code: 'bound_value',
      notes: [],
      expressions: nature.expressions,
      message:
        `Those words come from ${nature.expressions.map((e) => `{${e}}`).join(', ')}, not from the file. ` +
        'Change the value they read instead — Stacki resolves the binding for you in the target read. ' +
        'Nothing was changed.',
    };
  }

  const notes = [];
  if (node.kind === 'map') {
    const prev = parseLoopHead(node.head);
    node.head = value;
    for (const { from, to } of renames || []) {
      if (from && to && from !== to) renameLoopVar(node.children || [], from, to);
    }
    const next = parseLoopHead(value);
    if (prev && next && prev.data !== next.data) {
      const vars = [next.item, next.index].filter(Boolean);
      if (vars.length) disconnectDependentLoops(node.children || [], vars);
    }
    return done({ notes });
  }
  if (node.kind === 'cond') {
    node.test = value;
    return done({ notes });
  }
  if (node.kind === 'raw') {
    node.inner = value;
    return done({ notes });
  }
  if (node.kind === 'text' || node.kind === 'expr' || node.kind === 'comment') {
    node.value = value;
    return done({ notes });
  }

  // An element or component: its loose text, in the place it already sat.
  if (!Array.isArray(node.children)) node.children = [];
  const at = node.children.findIndex((c) => c.kind === 'text');
  if (at !== -1 && !value) {
    node.children.splice(at, 1);
    return done({ notes, textSlot: at });
  }
  if (at !== -1) {
    node.children[at].value = value;
    return done({ notes });
  }
  if (!value) return done({ notes });
  const back = slotHint;
  const idx = Number.isInteger(back) && back <= node.children.length ? back : node.children.length;
  node.children.splice(idx, 0, { id: newId(), kind: 'text', value });
  return done({ notes });
}

// --- props -----------------------------------------------------------------

/** Set or delete one prop. `value === undefined` removes it. */
export function setProp(model, { nodeId, name, value }) {
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');
  if (!name) return fail('bad_request', 'A prop name is required.');
  if (!node.props) node.props = {};
  if (value === undefined) delete node.props[name];
  else node.props[name] = value;
  return done();
}

/** Several props in one step, so a pick that sets three is a single change. */
export function setProps(model, { nodeId, patch }) {
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');
  if (!node.props) node.props = {};
  for (const [name, value] of Object.entries(patch || {})) {
    if (value === undefined) delete node.props[name];
    else node.props[name] = value;
  }
  return done();
}

/** Rename an attribute in place, keeping its value and its position. */
export function renameProp(model, { nodeId, from, to }) {
  const node = findNodeById(model.nodes, nodeId);
  if (!node?.props || !(from in node.props)) return fail('no_prop', `There is no ${from} on that node.`);
  if (!to || to === from) return done();
  const next = {};
  for (const [k, v] of Object.entries(node.props)) {
    if (k === from) next[to] = v;
    else if (k !== to) next[k] = v;
  }
  node.props = next;
  return done();
}

// --- classes ---------------------------------------------------------------

/** Add one class, wherever this element's classes are written. */
export function addClass(model, { nodeId, className }) {
  const clean = String(className || '').trim();
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');
  if (!clean) return fail('bad_request', 'A class name is required.');
  if (hasClass(node.props, clean)) return done({ notes: [`It already has ${clean}.`] });
  const edit = withClass(node.props, clean);
  if (!edit) {
    return fail(
      'unrepresentable',
      `Add ${clean} to this element yourself — its class comes from code Stacki cannot edit safely.`
    );
  }
  if (!node.props) node.props = {};
  node.props[edit.key] = edit.value;
  return done();
}

/**
 * Remove one class.
 *
 * Only from a plain `class="…"`. A class:list or a template literal is code
 * whose shape somebody chose, and taking a word out of it by string surgery is
 * how `class:list={[a, , b]}` happens.
 */
export function removeClass(model, { nodeId, className }) {
  const clean = String(className || '').trim();
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');
  const cls = node.props?.class;
  if (!cls || cls.type !== 'string') {
    if (hasClass(node.props, clean)) {
      return fail(
        'unrepresentable',
        `${clean} comes from an expression on this element, so Stacki will not edit it out by hand. Change the code that produces it.`
      );
    }
    return done({ notes: [`It does not have ${clean}.`] });
  }
  const words = namesIn(cls).filter((w) => w !== clean);
  if (words.length === namesIn(cls).length) return done({ notes: [`It does not have ${clean}.`] });
  if (words.length) node.props.class = { type: 'string', value: words.join(' ') };
  else delete node.props.class;
  return done();
}

/** Replace the whole class attribute with a list of names. */
export function setClasses(model, { nodeId, classes }) {
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');
  const list = (Array.isArray(classes) ? classes : []).map((c) => String(c).trim()).filter(Boolean);
  if (node.props?.['class:list']) {
    return fail(
      'unrepresentable',
      'This element builds its classes with class:list, so replacing them wholesale would throw that code away. Add and remove single classes instead, or edit the expression.'
    );
  }
  const existing = node.props?.class;
  if (existing && existing.type !== 'string') {
    return fail(
      'unrepresentable',
      'This element’s class attribute is an expression. Replacing it with a plain list would delete code Stacki cannot read.'
    );
  }
  if (!node.props) node.props = {};
  if (list.length) node.props.class = { type: 'string', value: list.join(' ') };
  else delete node.props.class;
  return done();
}

// --- structure -------------------------------------------------------------

/** Where a new node goes relative to an existing one. */
function placeFor(model, nodeId, position) {
  if (position === 'append' || position === 'prepend') {
    const parent = findNodeById(model.nodes, nodeId);
    if (!parent) return { error: fail('no_node', 'That node is not in the open file any more.') };
    if (parent.children === null) {
      return { error: fail('no_children', `A <${parent.name}> cannot hold children.`) };
    }
    if (!Array.isArray(parent.children)) parent.children = [];
    return { target: { parentId: parent.id, index: position === 'prepend' ? 0 : parent.children.length } };
  }
  const found = findParentList(model, nodeId);
  if (!found) return { error: fail('no_node', 'That node is not in the open file any more.') };
  const parent = findParentNode(model.nodes, nodeId);
  return {
    target: { parentId: parent ? parent.id : null, index: found.index + (position === 'after' ? 1 : 0) },
  };
}

/**
 * Insert a node built from a description.
 *
 * The description is the same vocabulary the insert palette uses — an element
 * with a tag, a component by name, a loop, a condition, some text — so what an
 * agent can add is exactly what a person can add, and nothing else.
 */
export function insertNode(model, { nodeId, position = 'after', node: spec }, ctx = {}) {
  const built = buildNode(spec, model, ctx);
  if (!built.ok) return built;
  const { target, error } = placeFor(model, nodeId, position);
  if (error) return error;
  insertIntoModel(model, built.node, target);
  // NOT pruneImports. An insert only ever ADDS a reference, so nothing it does
  // can make an import unused -- which means every import this could remove was
  // already unused before the call, and belongs to whoever wrote the file. An
  // append that silently deleted somebody's import was found doing exactly that,
  // and it also turned a one-line splice into a whole-frontmatter rewrite,
  // because one import gone and one added in the same write is not a splice.
  // remove and set_tag DO make a reference disappear, and prune there.
  return done({ selectId: built.node.id, notes: built.notes || [] });
}

/**
 * A node from a spec, or the reason there isn't one.
 *
 * `importPaths` is how a placed component gets the import it cannot build
 * without. Working out how one file should import another is a round trip to
 * the main process (`page:importPathFor`) and this runs inside a synchronous
 * mutation, so the caller that writes resolves it first and hands the answer
 * in — the same answer, from the same handler, the Insert panel awaits before
 * it mutates. It is AUTHORITATIVE when present: a component missing from it
 * cannot be imported, and markup for a component the page does not import is a
 * page that does not build, so the insert refuses instead. A caller that
 * passes none is rehearsing (src/agent/commands.js dry-runs a batch to report
 * what would fail, and has no way to await) — it neither imports nor refuses,
 * and the write that follows decides.
 */
export function buildNode(spec, model, { insertables = [], importPaths = null } = {}) {
  const kind = spec?.kind;
  const id = newId();
  if (kind === 'element') {
    const tag = String(spec.tag || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) return fail('bad_request', `"${spec.tag}" is not an element name.`);
    const text = spec.text != null ? String(spec.text) : DEFAULT_TEXT[tag];
    return done({
      ok: true,
      node: {
        id,
        kind: 'element',
        name: tag,
        props: propsFromSpec(spec.props),
        children: VOID_ELEMENTS.has(tag)
          ? null
          : text
            ? [{ id: newId(), kind: 'text', value: text }]
            : [],
      },
    });
  }
  if (kind === 'component') {
    const name = String(spec.name || '').trim();
    if (!/^[A-Z][\w$]*$/.test(name)) {
      return fail('bad_request', `"${spec.name}" is not a component name — those start with a capital.`);
    }
    const known =
      (model.imports || []).some((i) => i.name === name) ||
      insertables.some((c) => c.name === name) ||
      ASTRO_ASSETS.some((a) => a.name === name);
    if (!known) {
      return fail(
        'unknown_component',
        `Nothing in this project provides <${name}>. Create the component first, or import it in the frontmatter.`
      );
    }
    const asset = ASTRO_ASSETS.some((a) => a.name === name);
    if (asset && !(model.imports || []).some((i) => i.name === name)) {
      model.imports.push({ name, imported: name, path: ASTRO_ASSETS_MODULE, named: true });
    }
    if (!asset && !(model.imports || []).some((i) => i.name === name)) {
      const paths = importPaths ? importPaths[name] : null;
      if (paths) model.imports.push({ name, path: chooseImportPath(model, paths) });
      else if (importPaths) {
        return fail(
          'unresolved_import',
          `Stacki could not work out how this page should import <${name}>, and will not place markup the page has no import for. Nothing was changed.`
        );
      }
    }
    return done({
      ok: true,
      node: {
        id,
        kind: 'component',
        name,
        props: asset ? { ...PLACEHOLDER_PROPS, ...propsFromSpec(spec.props) } : propsFromSpec(spec.props),
        children: spec.text ? [{ id: newId(), kind: 'text', value: String(spec.text) }] : [],
        ...(asset ? { astroAsset: true } : {}),
      },
      notes: asset ? ['Inserted with placeholder src/alt — Astro throws on an <Image> without them.'] : [],
    });
  }
  if (kind === 'text') return done({ ok: true, node: { id, kind: 'text', value: String(spec.text ?? 'Text') } });
  if (kind === 'expr') return done({ ok: true, node: { id, kind: 'expr', value: String(spec.text ?? '{/* code */}') } });
  if (kind === 'comment') return done({ ok: true, node: { id, kind: 'comment', value: noteValue(null, String(spec.text ?? 'Comment')) } });
  if (kind === 'map') {
    return done({ ok: true, node: { id, kind: 'map', head: String(spec.head || '[].map((item) => ('), children: [] } });
  }
  if (kind === 'cond') {
    return done({
      ok: true,
      node: {
        id,
        kind: 'cond',
        op: '&&',
        test: String(spec.test || 'true'),
        children: [{ id: newId(), kind: 'branch', name: 'then', children: [] }],
      },
    });
  }
  return fail('bad_request', 'node.kind must be one of element, component, text, expr, comment, map, cond.');
}

/** Prop values as the model writes them: a string, or code in braces. */
function propsFromSpec(props) {
  const out = {};
  for (const [name, value] of Object.entries(props || {})) {
    if (value == null) continue;
    if (typeof value === 'object' && (value.type === 'string' || value.type === 'expr')) {
      out[name] = { type: value.type, value: String(value.value ?? '') };
    } else {
      out[name] = { type: 'string', value: String(value) };
    }
  }
  return out;
}

/**
 * Delete a node — and the note above it, and the frontmatter nothing else
 * reads any more.
 */
export function removeNode(model, { nodeId }) {
  const target = findNodeById(model.nodes, nodeId);
  if (!target) return fail('no_node', 'That node is not in the open file any more.');
  if (target.kind === 'chunk-group') {
    return fail('unrepresentable', 'This section comes from the page frontmatter — remove it from the code instead.');
  }
  const nextId = selectionAfterDelete(model, nodeId);
  const found = findParentList(model, nodeId);
  if (found) {
    const noteAt = noteIndexAbove(found.list, found.index);
    if (noteAt === -1) found.list.splice(found.index, 1);
    else found.list.splice(noteAt, 2);
  }
  pruneImports(model);
  const notes = [];
  const dead = unusedDeclarations(model);
  if (dead.length) {
    const names = dead.map((d) => d.name);
    model.extraFrontmatter = withoutDeclarations(model.extraFrontmatter, names);
    notes.push(
      `Also removed ${names.map((n) => `\`${n}\``).join(', ')} from the frontmatter — nothing was reading ${
        names.length === 1 ? 'it' : 'them'
      } any more.`
    );
  }
  return done({ notes, selectId: nextId });
}

/** Copy a node in beside itself. */
export function duplicateNode(model, { nodeId }) {
  const src = findNodeById(model.nodes, nodeId);
  if (!src) return fail('no_node', 'That node is not in the open file any more.');
  if (src.kind === 'chunk-group' || src.chunkFile) {
    return fail('unrepresentable', 'Chunk sections are defined in the page frontmatter and cannot be duplicated here.');
  }
  const found = findParentList(model, nodeId);
  if (!found) return fail('no_node', 'That node is not in the open file any more.');
  const clone = cloneWithNewIds(src);
  found.list.splice(found.index + 1, 0, clone);
  return done({ selectId: clone.id });
}

/**
 * Move a node somewhere else in the tree.
 *
 * Everything that made this hard is still here: the note travels with it, a
 * drop between a note and its element collapses onto the pair, a `slot` that
 * no longer addresses anybody is dropped, and bindings that read a loop
 * variable the node has just left are stripped rather than left to throw.
 */
export function moveNode(model, { nodeId, target }, { insertables = [] } = {}) {
  const found = findParentList(model, nodeId);
  if (!found) return fail('no_node', 'That node is not in the open file any more.');
  const node = found.list[found.index];

  if (target?.parentId) {
    if (target.parentId === nodeId) return fail('bad_request', 'A node cannot be moved into itself.');
    if (isDescendantOf(node, target.parentId)) {
      return fail('bad_request', 'A node cannot be moved inside its own subtree.');
    }
    const parent = findNodeById(model.nodes, target.parentId);
    if (!parent) return fail('no_node', 'That destination is not in the open file any more.');
    if (parent.children === null) return fail('no_children', `A <${parent.name}> cannot hold children.`);
  }

  const sameList =
    (target?.parentId == null && found.list === model.nodes) ||
    (target?.parentId != null && findNodeById(model.nodes, target.parentId)?.children === found.list);

  const before = loopVarsAt(model.nodes, nodeId);
  const noteAt = noteIndexAbove(found.list, found.index);
  const note = noteAt === -1 ? null : found.list[noteAt];
  const removeAt = note ? noteAt : found.index;
  const removedCount = note ? 2 : 1;

  found.list.splice(removeAt, removedCount);
  let index = target?.index ?? Number.MAX_SAFE_INTEGER;
  if (sameList && index > removeAt) index = Math.max(removeAt, index - removedCount);
  insertIntoModel(model, node, target ? { ...target, index } : null);
  if (note) {
    const landed = findParentList(model, nodeId);
    if (landed) landed.list.splice(landed.index, 0, note);
  }

  const slot = node.props?.slot;
  const slotName = slot?.type === 'string' ? slot.value : null;
  if (slotName) {
    const host = slotHostOf(model, nodeId);
    const definition = host ? definitionOf(model, host, insertables) : null;
    if (!keepsSlot({ slotName, host, definition })) delete node.props.slot;
  }

  const notes = [];
  const after = loopVarsAt(model.nodes, nodeId);
  const lost = before.filter((v) => !after.includes(v));
  const removed = stripLostBindings(node, lost);
  if (removed) {
    notes.push(`Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`);
  }
  return done({ notes });
}

/**
 * Change a plain element's tag.
 *
 * Attributes that belonged only to the old tag's schema go; global, data-* and
 * aria-* attributes stay. A component becoming a tag keeps nothing but those —
 * its props were the component's API and would serialize as junk on a <div>.
 */
export function setTag(model, { nodeId, tag }) {
  const name = String(tag || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return fail('bad_request', `"${tag}" is not an element name.`);
  const node = findNodeById(model.nodes, nodeId);
  if (!node) return fail('no_node', 'That node is not in the open file any more.');
  if (node.kind !== 'element' && node.kind !== 'component') {
    return fail('not_element', 'Only an element or a component has a tag to change.');
  }
  if (node.name === name) return done();
  const wasComponent = node.kind !== 'element';
  const oldNames = wasComponent
    ? new Set(Object.keys(node.props || {}))
    : new Set(getElementSchema(node.name).map((f) => f.name));
  if (wasComponent) {
    node.kind = 'element';
    delete node.astroAsset;
    delete node.dynamicTag;
  }
  const newNames = new Set(getElementSchema(name).map((f) => f.name));
  for (const attr of Object.keys(node.props || {})) {
    if (oldNames.has(attr) && !newNames.has(attr) && !GLOBAL_ATTRS.has(attr) && !/^(data-|aria-)/.test(attr)) {
      delete node.props[attr];
    }
  }
  node.name = name;
  if (VOID_ELEMENTS.has(name)) node.children = null;
  else if (node.children === null) node.children = [];
  pruneImports(model);
  return done();
}

// --- one door --------------------------------------------------------------

const OPS = {
  set_text: (model, op, ctx) => setText(model, op, ctx),
  set_prop: (model, op) => setProp(model, op),
  remove_prop: (model, op) => setProp(model, { ...op, value: undefined }),
  set_props: (model, op) => setProps(model, op),
  rename_prop: (model, op) => renameProp(model, op),
  add_class: (model, op) => addClass(model, op),
  remove_class: (model, op) => removeClass(model, op),
  set_classes: (model, op) => setClasses(model, op),
  insert_before: (model, op, ctx) => insertNode(model, { ...op, position: 'before' }, ctx),
  insert_after: (model, op, ctx) => insertNode(model, { ...op, position: 'after' }, ctx),
  append_child: (model, op, ctx) => insertNode(model, { ...op, position: 'append' }, ctx),
  prepend_child: (model, op, ctx) => insertNode(model, { ...op, position: 'prepend' }, ctx),
  remove: (model, op) => removeNode(model, op),
  duplicate: (model, op) => duplicateNode(model, op),
  move: (model, op, ctx) => moveNode(model, op, ctx),
  set_tag: (model, op) => setTag(model, op),
};

export const OP_TYPES = Object.keys(OPS);

/**
 * Run a list of operations over a model, all or nothing.
 *
 * Applied to a copy first. If any of them refuses, the copy is thrown away and
 * the caller is told which one and why — so a batch never leaves a page with
 * two of its three changes in it and no way to know which.
 */
export function applyOperations(model, operations, ctx = {}) {
  const draft = structuredClone(model);
  const notes = [];
  let selectId = null;
  for (const [index, op] of (operations || []).entries()) {
    const run = OPS[op?.type];
    if (!run) {
      return { ok: false, code: 'bad_operation', index, message: `"${op?.type}" is not an operation.`, notes: [] };
    }
    const result = run(draft, op, ctx);
    if (!result.ok) return { ...result, index, notes };
    notes.push(...(result.notes || []));
    if (result.selectId !== undefined && result.selectId !== null) selectId = result.selectId;
  }
  return { ok: true, model: draft, notes, selectId };
}
