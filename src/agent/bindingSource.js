// Following a binding back to the value behind it.
//
// `<h1>{product.title}</h1>` renders words that are not in the file. An agent
// asked to change those words has two choices, and one of them is a disaster:
// replace the expression with a literal, which makes the pixels right and
// silently deletes the reason the page had a CMS. This file exists so it can
// take the other one.
//
// The question is only ever "where does the first name in this path come
// from", because everything after it is a property lookup on whatever that is.
// There are five answers and Stacki already knows all of them:
//
//   a loop variable   `services.map((service) => …)` — the value is one item
//                     of whatever `services` is, so ask the same question
//                     about `services` and say which item.
//   a query           `const posts = await getCollection('blog')` — a content
//                     collection, which the content domain can read and write.
//   a declaration     `const hero = { title: 'x' }` in the frontmatter — the
//                     value is right there in the file being edited.
//   an import         `import data from '../data/site.json'` — a file, which
//                     may be a CMS data file or ordinary source.
//   a prop            `const { title } = Astro.props` — the value is set at
//                     every call site, so there is no single place to change
//                     and saying so is the answer.
//
// Nothing here guesses. An expression that is a program rather than a path
// (`items.filter(Boolean).length`) has no single source, and the honest answer
// to "where does this come from" is that Stacki cannot say.

import { findDeclaration, findImportOf, collectionCallIn, referenceCallIn, parseDestructures } from '../dataSuggest.js';
import { parseLoopHead } from '../modelOps.js';

// A declaration can be a page of data. What identifies it is its name and where
// it sits; the whole value belongs in a source read, not in every target that
// happens to mention it.
const MAX_STATEMENT = 600;
const clip = (text) => {
  const s = String(text ?? '');
  return s.length > MAX_STATEMENT ? `${s.slice(0, MAX_STATEMENT)}…` : s;
};

/** The first name in a dotted path — `post.data.title` → `post`. */
export function rootOf(expression) {
  const m = String(expression || '').trim().match(/^([A-Za-z_$][\w$]*)/);
  return m ? m[1] : null;
}

/** Whether an expression is a plain path this can reason about at all. */
const PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[\d+\])*$/;

/**
 * The loops around a node, outermost first, as `{ item, index, data, nodeId }`.
 *
 * `ancestors` is the chain from the root down to (and including) the node —
 * App's own ancestorChain, so this and the editor agree about what encloses
 * what.
 */
export function loopsAround(ancestors) {
  const out = [];
  for (const node of ancestors || []) {
    if (node?.kind !== 'map') continue;
    const head = parseLoopHead(node.head);
    if (head) out.push({ item: head.item, index: head.index || null, data: head.data, nodeId: node.id });
    else out.push({ item: null, index: null, data: null, nodeId: node.id });
  }
  return out;
}

/**
 * Where the value an expression reads actually lives.
 *
 * `{ kind, ... }` where kind is one of:
 *
 *   loop_item     one item of `data`, which carries its own resolution
 *   collection    a content collection, by name
 *   declaration   a frontmatter const, with its statement and range
 *   import        a file, by import specifier
 *   prop          set by whoever renders this component
 *   unknown       Stacki cannot say — and says so rather than pretending
 */
export function resolveBinding(expression, { frontmatter = '', imports = [], ancestors = [], depth = 0 } = {}) {
  const text = String(expression || '').trim();
  if (!text) return { kind: 'unknown', expression: text, why: 'there is no expression' };
  if (!PATH.test(text)) {
    return {
      kind: 'unknown',
      expression: text,
      why: 'it is code rather than a path, so there is no single value behind it',
    };
  }
  const root = rootOf(text);
  if (!root) return { kind: 'unknown', expression: text, why: 'it does not start with a name' };
  // A path that walked in a circle, or a chain deeper than anything real.
  if (depth > 6) return { kind: 'unknown', expression: text, why: 'the chain of bindings is too deep to follow' };

  // 1 — a loop variable. Innermost wins: a nested loop reusing a name shadows
  //     the outer one, which is what the language does too.
  const loops = loopsAround(ancestors);
  for (let i = loops.length - 1; i >= 0; i--) {
    const loop = loops[i];
    if (!loop.item) continue;
    if (loop.item === root) {
      return {
        kind: 'loop_item',
        expression: text,
        variable: root,
        path: text.slice(root.length).replace(/^[.?]+/, ''),
        loopNodeId: loop.nodeId,
        // Where the list itself comes from — the whole point, since editing
        // "the third card" means editing the third item of THAT.
        list: resolveBinding(loop.data, { frontmatter, imports, ancestors: ancestors.slice(0, -1), depth: depth + 1 }),
      };
    }
    if (loop.index === root) {
      return { kind: 'loop_index', expression: text, variable: root, loopNodeId: loop.nodeId };
    }
  }

  // 2 — a frontmatter declaration. A collection query is one of those, and is
  //     worth naming as itself.
  const declaration = findDeclaration(frontmatter, root);
  if (declaration) {
    const call = collectionCallIn(declaration.value);
    if (call?.fn === 'getCollection') {
      return {
        kind: 'collection',
        expression: text,
        collection: call.name,
        variable: root,
        path: text.slice(root.length).replace(/^[.?]+/, ''),
        declaration: { name: root, start: declaration.start, end: declaration.end, statement: clip(declaration.statement) },
      };
    }
    if (call?.fn === 'getEntry' || referenceCallIn(declaration.value)) {
      return {
        kind: 'entry',
        expression: text,
        collection: call?.name || null,
        variable: root,
        path: text.slice(root.length).replace(/^[.?]+/, ''),
        declaration: { name: root, start: declaration.start, end: declaration.end, statement: clip(declaration.statement) },
      };
    }
    return {
      kind: 'declaration',
      expression: text,
      variable: root,
      path: text.slice(root.length).replace(/^[.?]+/, ''),
      declaration: {
        name: root,
        start: declaration.start,
        end: declaration.end,
        statement: clip(declaration.statement),
        value: clip(declaration.value),
      },
    };
  }

  // 3 — an import, from the model's own list first (which the parser built)
  //     and from the frontmatter text second (a named import the model does
  //     not carry).
  const fromModel = (imports || []).find((i) => i.name === root);
  if (fromModel) {
    return { kind: 'import', expression: text, variable: root, spec: fromModel.path, path: text.slice(root.length).replace(/^[.?]+/, '') };
  }
  const fromText = findImportOf(frontmatter, root);
  if (fromText) {
    return { kind: 'import', expression: text, variable: root, spec: fromText.spec, path: text.slice(root.length).replace(/^[.?]+/, '') };
  }

  // 4 — something the frontmatter took apart. `const { title } = Astro.props`
  //     is a prop, and there is no one value: every place that renders this
  //     component decides it. Anything else destructured is a value in the
  //     file, named by what it was taken from.
  const destructured = parseDestructures(frontmatter || '').find((d) => d.name === root);
  if (destructured) {
    if (/^Astro\.props\b/.test(String(destructured.from || '').trim())) {
      return {
        kind: 'prop',
        expression: text,
        variable: root,
        path: text.slice(root.length).replace(/^[.?]+/, ''),
        why: 'it is a prop of this component, so its value is set wherever the component is used',
      };
    }
    return {
      kind: 'destructured',
      expression: text,
      variable: root,
      from: destructured.from || null,
      path: text.slice(root.length).replace(/^[.?]+/, ''),
      // What it was taken from may itself be a query or an import.
      of: resolveBinding(String(destructured.from || '').trim(), {
        frontmatter,
        imports,
        ancestors,
        depth: depth + 1,
      }),
    };
  }
  if (root === 'Astro') {
    return { kind: 'runtime', expression: text, variable: root, why: 'it comes from Astro at render time' };
  }

  return {
    kind: 'unknown',
    expression: text,
    variable: root,
    why: `nothing in this file declares or imports ${root}`,
  };
}

export default resolveBinding;
