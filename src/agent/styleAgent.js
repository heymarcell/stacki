// The Style panel, asked questions by something that has no eyes.
//
// "Make the gap larger" is a sentence about a rendered box, and answering it
// from a repository means finding which of eleven stylesheets, which selector
// among the four that match, and whether the value is a literal or a variable
// three files away. The panel already answers all of that, every time somebody
// clicks an element — it scans the sources, parses them once, matches every
// selector against the real DOM, and sorts the result by the cascade.
//
// So this asks the panel's own modules rather than parsing CSS a second time.
// Nothing here knows what a specificity tuple is; css.ts, selectors.ts,
// cascade.ts and resolved.ts do, and they are the same code the person at the
// keyboard is looking at. A second CSS engine for agents would be a second set
// of answers about the same page, and the two would disagree on exactly the
// rules that are hard.
//
// Writes go through writeEmbedDoc, which is what the panel's own fields call:
// a stylesheet edit records an undo command on the app's stack, and a <style>
// block goes through the page model like any other edit. ⌘Z after an agent's
// style change is not special-cased — it is the same step it would be after a
// person's.

import {
  loadEmbedDocs,
  rebuildRules,
  scanPage,
  resolveTarget,
  askCanvasAbout,
  primeDomMatches,
  writeEmbedDoc,
  isReadOnlyRule,
} from '../style-panel/lib/webflow.ts';
import { computeRuleModel } from '../style-panel/lib/cascade.ts';
import {
  addDeclaration,
  createRuleAtRoot,
  removeDeclaration,
  removeRuleIfEmpty,
  setDeclarationValue,
} from '../style-panel/lib/css.ts';
import { queryCanvas, hasCanvas } from '../canvasQuery.js';
import { getHost } from '../style-panel/lib/host.ts';

// Enough to explain a layout without becoming a dump of the whole cascade.
const MAX_RULES = 40;
const MAX_DECLS_PER_RULE = 40;
// Enough for a caller to see WHAT is unaccounted without paying for the whole
// of a utility framework's output; the count beside it is never capped.
const MAX_UNACCOUNTED = 12;
const MAX_VALUE = 300;

const clip = (value, max = MAX_VALUE) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// A style source's name, as something that may travel.
//
// The panel keys a source by its absolute path, which is right inside one
// process and wrong the moment it leaves: an answer that carries somebody's
// home directory has leaked where their project lives for no reason at all. So
// what goes out is project-relative, and what comes back is turned into the
// key the panel uses. Both directions here, so there is one rule.

const projectRoot = () => String(getHost().projectPath || '');

export function publicKey(key) {
  const at = String(key || '').indexOf(':');
  if (at === -1) return key;
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (kind !== 'file' && kind !== 'astro') return key;
  const root = projectRoot();
  const rel = root && rest.startsWith(`${root}/`) ? rest.slice(root.length + 1) : rest;
  return `${kind}:${rel}`;
}

export function internalKey(key) {
  const at = String(key || '').indexOf(':');
  if (at === -1) return key;
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (kind !== 'file' && kind !== 'astro') return key;
  if (rest.startsWith('/')) return key; // already absolute — an older answer
  const root = projectRoot();
  return root ? `${kind}:${root}/${rest}` : key;
}

/** The custom properties a value reads — `var(--gap, 1rem)` → ['--gap']. */
export function variablesIn(value) {
  return [...new Set([...String(value ?? '').matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))];
}

// ─────────────────── @layer, WHICH THE PARSER LEAVES OUT ────────────────────
//
// `@layer` is not a conditional group at-rule — a layer always applies — so
// css.ts walks its block with the PARENT's at-context and the rule arrives at
// computeRuleModel indistinguishable from an unlayered one. Being later in
// document order it then WINS compareCascade's tie-break. CSS Cascade 5 says
// the reverse: layer order is compared BEFORE specificity, and a normal
// declaration outside every layer beats every layered one.
//
// Measured against the shipped Chromium, `.pricing-grid { gap: 1rem }` followed
// by `@layer base { .pricing-grid { gap: 99px } }` computes to 16px. Stacki
// reported the 99px `winning: true` and told the 1rem, by file and by selector,
// that it had lost — to an `overriddenBy` whose source, at-context and selector
// were byte-identical to its own, because the layer that distinguished them had
// been erased upstream.
//
// The parser is not changed for it. css.ts is the Style panel's parser and the
// panel is not what is being fixed; what a layer needs is not a different parse
// but a different ORDER, and the order is decided here — over the same engine,
// run on partitioned inputs, which is the shape the reachability tiers already
// use. The layer is read back off the postcss node's own ancestry, which is
// still in the rule the parser handed over.
const AT_CONTEXT_NAMES = new Set(['media', 'supports', 'container', 'layer']);

// `@layer { }` is a layer with no name, and two of them are two layers, so the
// block itself has to be the identity. Keyed off the node so the same block
// answers the same way in every pass of a read.
const anonymousLayers = new WeakMap();
let anonymousLayerCount = 0;
function layerNameOf(node) {
  const params = String(node.params || '').trim();
  if (params) return params;
  if (!anonymousLayers.has(node)) anonymousLayers.set(node, `anonymous-layer #${++anonymousLayerCount}`);
  return anonymousLayers.get(node);
}

/** The `@layer` blocks a node sits inside, outermost first, as dotted names. */
function layerPathOf(node) {
  const parts = [];
  for (let at = node; at && at.type !== 'root'; at = at.parent) {
    if (at.type !== 'atrule' || String(at.name || '').toLowerCase() !== 'layer') continue;
    parts.unshift(layerNameOf(at));
  }
  return parts;
}

const contexts = new WeakMap();

/**
 * The at-rules a rule is written inside, outermost first, LAYERS INCLUDED —
 * and, separately, the layer it belongs to.
 *
 * Rebuilt from the postcss node's own ancestry rather than read off
 * `rule.atContext`, which css.ts fills with conditional group at-rules only.
 * Where no layer is involved the two have to agree EXACTLY: an identity is
 * matched on this list (findRule), so a context that drifted by one string
 * would refuse every write into a query. So the rebuilt chain is checked
 * against the parser's own answer, and where they disagree the parser's is
 * kept and no layer is claimed — a rule whose ancestry cannot be walked is
 * decided exactly as it was before any of this.
 */
function contextOf(rule) {
  if (!rule) return { atContext: [], layer: null };
  const cached = contexts.get(rule);
  if (cached) return cached;
  const authored = rule.atContext || [];
  const chain = [];
  // Starts at the node, not at its parent: css.ts binds a query's own bare
  // declarations to the at-rule itself, and that rule is inside it.
  for (let node = rule.node; node && node.type !== 'root'; node = node.parent) {
    if (node.type !== 'atrule') continue;
    const name = String(node.name || '').toLowerCase();
    if (AT_CONTEXT_NAMES.has(name)) chain.unshift(`@${node.name} ${node.params}`.trim());
  }
  const conditions = chain.filter((at) => !/^@layer\b/.test(at));
  const layers = layerPathOf(rule.node);
  const answer =
    conditions.join('|') === authored.join('|')
      ? { atContext: chain, layer: layers.length ? layers.join('.') : null }
      : { atContext: authored, layer: null };
  contexts.set(rule, answer);
  return answer;
}

/**
 * Where a declaration lives, as something that can be found again.
 *
 * Deliberately semantic rather than positional: a source, the at-rule context,
 * the selector and the property. An index into a rule list would be right
 * until the first edit above it — which, for a tool whose whole job is editing,
 * is immediately.
 */
export const declarationIdentity = (rule, prop, sourceDigest = null) => ({
  source: publicKey(rule.embedKey),
  sourceLabel: rule.embedLabel,
  // The layer is part of WHERE, not decoration: two rules with one selector in
  // one file, one of them layered, are two different rules to write into, and
  // an identity that cannot tell them apart writes into whichever comes first.
  atContext: contextOf(rule).atContext,
  selector: rule.selectorText,
  property: prop,
  // What the source was when this was read. A rule can still be found in a
  // stylesheet somebody has rewritten — same selector, same property, different
  // file — and finding it is not the same as it being the version that was
  // reasoned about. Carried on the identity so passing the identity back is
  // the whole of the guard.
  ...(sourceDigest ? { sourceDigest } : {}),
});

// A short version marker for a source's text. FNV-1a rather than a real hash:
// this says which version, not who wrote it, and it is computed per rule on
// every read.
export function digestOfSource(text) {
  const body = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `${hash.toString(36)}-${body.length.toString(36)}`;
}

/** The bridge, when there is one. Null in a harness with no window. */
const bridge = () => (typeof window !== 'undefined' ? window.avb : null) || null;

/**
 * The stylesheets to scan, when nothing has scanned any.
 *
 * `host.files` and `host.astroFiles` are filled by StylePanel's own effects,
 * and StylePanel mounts only when somebody opens the Style tab. A session
 * driven entirely through MCP can therefore reach here with both lists empty —
 * and the empty cascade that follows describes the panel's mounting rather than
 * the element, in an answer that looks exactly like "this element has no CSS".
 *
 * So the agent asks the same two handlers the panel asks. Nothing is written
 * back into the host record: that record is the panel's, a write into it would
 * make an agent's read a change to what a person is looking at, and this list
 * only has to live as long as the read that needed it.
 */
async function ownStyleFiles() {
  const host = getHost();
  if (host.files.length || host.astroFiles.length) return null;
  const root = host.projectPath;
  const avb = bridge();
  if (!root || !avb?.listStyleFiles || !avb?.listAstroStyleFiles) return null;
  const [css, astro] = await Promise.all([
    Promise.resolve(avb.listStyleFiles(root)).catch(() => null),
    Promise.resolve(avb.listAstroStyleFiles(root)).catch(() => null),
  ]);
  if (!css && !astro) return null;
  return { files: css?.files || [], astroFiles: astro?.files || [] };
}

/**
 * THE VIEWPORT THE ANSWER IS ABOUT.
 *
 * `computed` comes from the canvas, and the canvas is a page at a width. A
 * media query that holds at that width is not a hypothetical — it IS what the
 * element has, and the cascade has to be resolved there or the winner it names
 * is contradicted by the computed value printed beside it.
 *
 * The app measures this already: PreviewPane reports `viewportWidth` /
 * `viewportHeight` — the iframe's own client box — and they travel in the MCP
 * payload as `page.viewportWidth`. Taken from whoever is calling if they have
 * it, and off the style-panel host otherwise.
 *
 * Null when nobody measured one, and null is answered as null: a width guessed
 * from the device name would be wrong for the two devices that FILL the pane
 * ('canvas') or are dragged ('custom'), and a wrong viewport is a confidently
 * wrong winner, which is the defect this exists to fix rather than move.
 */
function measuredViewport(given) {
  // Either shape: the canvas report as PreviewPane publishes it
  // (`viewportWidth`), or a plain `{width, height}`.
  const from = given && typeof given === 'object' ? given : getHost();
  const width = Number(from.viewportWidth ?? from.width);
  if (!Number.isFinite(width) || width <= 0) return null;
  const height = Number(from.viewportHeight ?? from.height);
  return { width, height: Number.isFinite(height) && height > 0 ? height : null };
}

/**
 * Everything the page's CSS is, parsed once — and matched once.
 *
 * `model` here is the LISTING: which of the project's rules target this
 * element at all, in document order, with their labels. It is not the verdict.
 * The verdict is a second question — which of them the page actually loads —
 * and readStyles asks the same engine again over the answer to that (see
 * `cascadeTiers` below). `target` comes back so it can, with its snapshot cache
 * and its primed DOM matches already warm.
 */
async function readCascade(node, given) {
  const scan = await scanPage(await ownStyleFiles());
  const { docs, errors } = await loadEmbedDocs(scan.pageEmbeds);
  const rules = rebuildRules(docs);
  const asked = await askCanvasAbout(node.id, rules);
  const { target, rootSnapshot } = await resolveTarget(node, scan, asked);
  await primeDomMatches(target, rules, asked);
  const viewport = measuredViewport(given);
  const model = await computeRuleModel(rules, target, { viewport });
  return { docs, rules, model, target, rootSnapshot, errors, asked, viewport };
}

/** What the engine says the element's properties actually resolve to, and the
 *  rules the served document says reach it. Both come from the same ask. */
async function askDocument(node, properties, pathOf) {
  const path = pathOf?.(node.id);
  if (!path || !hasCanvas()) {
    return {
      computed: null,
      documentRules: null,
      runtime: {
        available: false,
        reason:
          'No preview is running, so the served document could not be consulted. CSS generated at build time ' +
          '(and anything else not in the project\'s own files) is invisible from here — start the dev server and read again.',
      },
    };
  }
  const reply = await queryCanvas(path, [], [], properties, { rules: true });
  if (!reply) {
    return {
      computed: null,
      documentRules: null,
      runtime: { available: false, reason: 'The preview did not answer in time; nothing here describes the served document.' },
    };
  }
  const found = reply.documentRules || null;
  return {
    computed: properties.length ? reply.computedProps || null : null,
    documentRules: found ? found.rules : null,
    runtime: {
      available: !!found,
      ...(found
        ? {
            matchedRules: found.rules.length,
            unreadableStyleSheets: found.unreadable,
            note:
              'These are the rules the browser says match, as the served document holds them — generated CSS included. ' +
              'They have no authored location and cannot be edited through Stacki; a rule that is also in a project file ' +
              'appears in `rules` as well.',
          }
        : { reason: 'The preview answered but reported no rules it could read.' }),
    },
  };
}

// THE SHORTHANDS, AND WHY THEY ARE HERE.
//
// The reconciliation below compares property NAMES, and `padding: 1rem` sets
// `padding-top`. Without this table an element whose padding is authored in one
// line is told, in the same response that returns that line, that nothing
// Stacki can see sets its padding-top. A false accusation costs more than the
// silence it replaced: an agent goes and authors a duplicate declaration for a
// property that was never unset.
//
// Only the families a stylesheet actually writes, and only where the longhand
// is not simply the shorthand plus a dash — those are handled by prefix below,
// which is why `border-radius` and `gap` need an entry and `margin` does not.
const SHORTHAND_LONGHANDS = {
  inset: ['top', 'right', 'bottom', 'left'],
  gap: ['row-gap', 'column-gap'],
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
  font: ['line-height'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'grid-area': ['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
};
// Shorthands whose longhands all begin with the shorthand's own name and a dash.
// Kept as a list rather than as a bare prefix test, because `color` is not a
// shorthand for `color-scheme` and the bare test cannot tell.
const SHORTHAND_PREFIXES = [
  'margin',
  'padding',
  'border',
  'background',
  'font',
  'flex',
  'grid',
  'outline',
  'overflow',
  'transition',
  'animation',
  'text-decoration',
  'text-emphasis',
  'list-style',
  'columns',
  'mask',
  'scroll-margin',
  'scroll-padding',
];

/** Whether an authored declaration of `declared` says anything about `property`. */
function covers(declared, property) {
  if (declared === property) return true;
  if ((SHORTHAND_LONGHANDS[declared] || []).includes(property)) return true;
  return SHORTHAND_PREFIXES.includes(declared) && property.startsWith(`${declared}-`);
}

// A generated rule and the authored rule it came from are the same rule with
// two spellings. Astro hashes a scoped selector on its way into the served
// document, and a `:global(...)` wrapper exists only in the source — so both
// come off before two selectors are compared, or every Astro page with one
// scoped block reports rules nothing accounts for.
const normalizeSelector = (sel) =>
  String(sel || '')
    .replace(/:global\(\s*([^)]*?)\s*\)/g, '$1')
    .replace(/\[data-astro-cid-[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();

/** The property names a document rule's declaration block sets. */
const propertiesIn = (cssText) =>
  String(cssText || '')
    .split(';')
    .map((part) => part.slice(0, part.indexOf(':')).trim().toLowerCase())
    .filter(Boolean);

/**
 * Which computed properties no returned declaration can account for, and which
 * rules the browser says reach this element that the authored scan did not.
 *
 * Deliberately not a value comparison: `var(--gap)` and `16px` are the same
 * declaration and normalising every property to find that out is a second CSS
 * engine. The decidable question is the one that matters here — is there any
 * authored declaration for this property at all — and it is exactly the question
 * a Tailwind element answers "no" to for everything it is styled with.
 *
 * TWO WAYS TO GET THAT QUESTION WRONG, and both were being got wrong.
 *
 * A declaration inside `@media` or `:hover` carries `winning: null`, because
 * nothing here knows the viewport or where the pointer is. Reading that as "does
 * not exist" made the answer say `color` was unexplained three lines below
 * returning the `@media` rule that sets it. Unresolved is not absent: it counts
 * as an explanation the response is offering, and the caller can see the
 * condition on the declaration itself.
 *
 * The other is `padding` and `padding-top`, handled by covers() above.
 *
 * AND THE THIRD THING, which is not about `computed` at all. `unexplained` can
 * only ever name properties somebody asked the engine about, and those are the
 * properties the AUTHORED rules named — so it cannot notice a rule it never
 * returned. `documentRules` can: it is the browser's own list of what reaches
 * this element, and a rule in it that no authored rule accounts for is the
 * response's own evidence that its scan is incomplete.
 */
export function reconcileComputed(rules, computed, documentRules = null) {
  // A SOURCE THIS PAGE DOES NOT LOAD EXPLAINS NOTHING ABOUT WHAT IT RENDERED.
  //
  // Both halves below are statements about the rendered element, and a rule in
  // a component the page never imports is not on the rendered element. Left in,
  // it silenced a genuinely unexplained property and — worse — signed for a
  // rule the browser reported, on the strength of the two sharing a selector
  // string. `:global(.pricing-grid)` in an orphaned component and
  // `.pricing-grid` in the served stylesheet are not the same rule; they are
  // the same eleven characters.
  const onThisPage = (rules || []).filter((rule) => rule.source?.reachedByOpenPage !== false);
  const declared = onThisPage.flatMap((rule) =>
    (rule.declarations || []).filter((d) => d.winning !== false).map((d) => d.property)
  );
  const unexplained = Object.entries(computed || {})
    .filter(([property, value]) => value !== null && value !== '' && !declared.some((d) => covers(d, property)))
    .map(([property, value]) => ({
      property,
      computed: value,
      reason: 'no authored declaration Stacki can see sets this property on this element',
    }));

  const authored = new Set(onThisPage.map((rule) => normalizeSelector(rule.selector)));
  for (const rule of onThisPage) for (const sel of rule.matchedSelectors || []) authored.add(normalizeSelector(sel));
  const unaccountedRules = (documentRules || [])
    .filter((rule) => !authored.has(normalizeSelector(rule.selector)))
    .map((rule) => ({ selector: rule.selector, stylesheet: rule.stylesheet || null, properties: propertiesIn(rule.cssText) }));

  return { explainsComputed: computed ? unexplained.length === 0 : null, unexplained, unaccountedRules };
}

// What an authored-source scan cannot contain, said in the answer rather than
// left for the caller to know.
const EXCLUDED_FROM_AUTHORED = [
  'CSS generated at build time (Tailwind, UnoCSS, a PostCSS plugin) — it is not in any project file; `documentRules` and `computed` are the only truth about it',
  "scoped <style> blocks of components that did not render this element — Astro hashes those rules so they cannot reach it — except their :global(...) rules, which are included",
  'style="" attributes on the element, and the browser\'s own default stylesheet',
];

const CASCADE_SCOPE =
  'every .css/.scss/.sass/.less file in the project, whether or not this page imports it, plus the <style> blocks of ' +
  'the open file and the page-wide blocks of its components. All of them are LISTED; the winner is decided only over ' +
  'the ones this page was proved to load — `source.reachedByOpenPage` and `source.reachEvidence` say which those are, ' +
  'and a declaration from anywhere else carries `notInCascade` or `unprovenSource` in place of a verdict.';

/** The stylesheets the open page imports, as far as they can be followed. */
async function reachingFiles() {
  const host = getHost();
  const avb = bridge();
  if (!host.projectPath || !host.openFilePath || !avb?.stylesReaching) return null;
  const answer = await Promise.resolve(
    avb.stylesReaching({ projectPath: host.projectPath, file: host.openFilePath })
  ).catch(() => null);
  return Array.isArray(answer?.files) ? new Set(answer.files) : null;
}

// THE COMPONENTS THIS PAGE ACTUALLY RENDERS.
//
// A component's scoped `<style>` can still reach the page through `:global()`,
// and the escaped-rule scan (webflow.ts) reads those out of EVERY .astro file in
// the project — because `host.astroFiles` is a whole-project list, not a list of
// what this page draws. So a `:global(.card)` sitting in a component nothing
// imports was being offered as a rule reaching this element, hedged with the
// same `reachedByOpenPage: 'unknown'` a genuinely-reaching component gets. That
// is the false positive the Astro hash exists to prevent, one class of markup
// over: an agent reads an `outline` it cannot see on screen and either deletes a
// rule from an unrelated component or decides the preview is stale.
//
// Astro bundles a page's CSS from its MODULE GRAPH, so "does this page import
// the component, directly or through another component" is exactly the right
// question — and unlike "does the open file instantiate it", it does not report
// a Nav rendered by a Layout as absent. The same walk main.js does for
// stylesheets (listReachingStyles), done here for the .astro files it passes
// through and does not report.
// Built fresh per file rather than shared: a `g` regex carries `lastIndex`
// between calls, and this walk is async — two reads in flight over one of these
// would each resume the other's scan halfway through a file.
const importSpecifiers = () => /\bimport\s+(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const REACH_DEPTH = 4;

/** `base`'s directory joined with a relative specifier, as a posix project path. */
function resolveRel(base, spec) {
  const parts = base.split('/').slice(0, -1);
  for (const piece of spec.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (!parts.length) return null; // out of the project; nothing here can say anything about it
      parts.pop();
      continue;
    }
    parts.push(piece);
  }
  return parts.join('/');
}

// WHAT A SPECIFIER THAT IS NOT RELATIVE CAN STILL BE.
//
// `import Aliased from '@components/Aliased.astro'` is a tsconfig `paths` alias,
// which Astro's own docs prescribe, and it renders that component: Astro emits
// its CSS for this page and its `:global()` rule really does paint the element.
// Skipping the specifier and then publishing the NEGATIVE half of the walk said
// the opposite of all three, and deleted the declaration from the cascade
// BEFORE the winner was computed — so the rule the browser was not using came
// back `winning: true`. A false denial is the same defect as a false winner,
// one direction over.
//
// So the aliases the project declares are read and followed, and where the walk
// still cannot see — an alias only astro.config knows, a `import()` a regex
// cannot follow, the depth cut-off — it stops publishing negatives at all,
// which is the choice main.js already made for the same walk: "Nothing here can
// prove a file is unreachable … so this answers only the positive half".
// A bare package name is NOT one of those cases: node_modules holds no project
// .astro file, so nothing in `rules` can come from one.
const DYNAMIC_IMPORTS = /\bimport\s*\(|\bAstro\.glob\s*\(|\bimport\.meta\.glob\s*\(/;
const ALIAS_SHAPES = /^[~#/]/;
// Extensions that import nothing this walk is looking for. A stylesheet, an
// image or a JSON blob cannot re-export a component, so passing one by is not
// a hole; a specifier with no extension at all is.
const TERMINAL_IMPORT = /\.(css|scss|sass|less|styl|json|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|txt|wasm)(\?[^/]*)?$/i;

/** tsconfig/jsconfig `paths` as [prefix, targets], the trailing `*` stripped. */
async function projectAliases(root, read) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const text = await read(`${root}/${name}`);
    if (typeof text !== 'string') continue;
    try {
      // Config files allow comments and trailing commas; strip both rather than
      // pull in a JSON5 parser for one field. Same treatment main.js gives them.
      const paths = JSON.parse(
        text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/,(\s*[}\]])/g, '$1')
      )?.compilerOptions?.paths;
      if (!paths) continue;
      return Object.entries(paths).map(([prefix, targets]) => [
        prefix.replace(/\*$/, ''),
        (Array.isArray(targets) ? targets : [targets]).map((t) => String(t).replace(/^\.\//, '').replace(/\*$/, '')),
      ]);
    } catch {
      // A malformed config means no aliases, not a walk that may be trusted —
      // the caller treats an unresolved specifier as a hole either way.
    }
  }
  return [];
}

/** Whether astro.config declares aliases of its own, which nothing here reads. */
async function hasConfigAliases(root, read) {
  for (const name of ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts', 'vite.config.ts', 'vite.config.js']) {
    const text = await read(`${root}/${name}`);
    if (typeof text === 'string' && /\balias\s*:/.test(text)) return true;
  }
  return false;
}

/**
 * Every .astro file the open page pulls in, transitively, and whether the walk
 * that found them was COMPLETE.
 *
 * Null — never an empty set — when the walk could not be done at all: no open
 * file, no bridge, nothing read. "Not proved to reach" and "proved not to
 * reach" are different claims and only the second may be published as `false`;
 * `complete: false` says this walk earned neither.
 */
async function reachingComponents() {
  const host = getHost();
  const avb = bridge();
  if (!host.projectPath || !host.openFilePath || !avb?.readStyleFile) return null;
  // The host record carries the open file as an ABSOLUTE path and reports rules
  // against project-relative ones. Walk in relative paths, because that is what
  // a comparison with `source.file` needs; read through absolute ones, because
  // main.js resolves a relative argument against ITS OWN cwd and then refuses it
  // for being outside the project.
  const root = String(host.projectPath).replace(/\\/g, '/').replace(/\/$/, '');
  const relative = (p) => {
    const posix = String(p).replace(/\\/g, '/');
    return posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
  };
  const readFile = async (abs) => {
    const answer = await Promise.resolve(avb.readStyleFile(abs)).catch(() => null);
    return typeof answer?.css === 'string' ? answer.css : null;
  };
  const start = relative(host.openFilePath);
  const aliases = await projectAliases(root, readFile);
  const configAliases = await hasConfigAliases(root, readFile);
  const seen = new Set();
  const components = new Set();
  let read = 0;
  // Every place this walk could have missed a component, in one flag: past it,
  // the set is still the components that DO reach the page, and no longer
  // evidence about any file outside it.
  let complete = true;
  // A Markdown or MDX page names its layout in frontmatter rather than with an
  // import, and everything that layout renders is reached through it.
  if (!/\.astro$/i.test(start)) complete = false;
  const visit = async (rel, depth) => {
    if (!rel || seen.has(rel)) return;
    if (depth > REACH_DEPTH) {
      complete = false; // a component deeper than this is reached and unseen
      return;
    }
    seen.add(rel);
    const text = await readFile(`${root}/${rel}`);
    if (typeof text !== 'string') {
      // main.js's walk shrugs this off because it publishes nothing negative.
      // Here it is exactly the hole that makes a denial unsound.
      complete = false;
      return;
    }
    read += 1;
    // `import('./Card.astro')`, `Astro.glob('../components/*.astro')`: real
    // imports of real components that no specifier regex will ever see.
    if (DYNAMIC_IMPORTS.test(text)) complete = false;
    const pattern = importSpecifiers();
    const next = [];
    let match;
    while ((match = pattern.exec(text))) {
      const spec = match[1];
      const target = spec.startsWith('.') ? resolveRel(rel, spec) : resolveAlias(aliases, spec);
      if (typeof target !== 'string' || !target) {
        // A bare package name resolves through node_modules, which holds no
        // file `rules` can name, so skipping it costs nothing. Anything else
        // that did not resolve — an alias prefix whose target could not be
        // followed (`false` above), an alias shape, an aliased `.astro`, or any
        // bare specifier at all in a project that aliases in a config nothing
        // here reads — could have been a component, and is a hole.
        if (target === false || ALIAS_SHAPES.test(spec) || /\.astro$/i.test(spec) || (configAliases && !spec.startsWith('.')))
          complete = false;
        continue;
      }
      if (/\.astro$/i.test(target)) {
        components.add(target);
        next.push(target);
      } else if (/\.(jsx?|tsx?|svelte|vue)$/i.test(target)) {
        next.push(target);
      } else if (!TERMINAL_IMPORT.test(target)) {
        // No extension, or one this does not know: a barrel file re-exporting a
        // component resolves through it and is never seen.
        complete = false;
      }
    }
    for (const child of next) await visit(child, depth + 1);
  };
  await visit(start, 0);
  // The open file itself could not be read, so nothing was walked and nothing
  // can be denied.
  return read ? { components, complete } : null;
}

/**
 * A non-relative specifier through the project's own aliases.
 *
 * A path when it resolved; `false` when an alias prefix DID match and the
 * target could not be followed — a hole, not a package; null when no alias
 * applies, which is what a package name looks like.
 */
function resolveAlias(aliases, spec) {
  let matched = false;
  for (const [prefix, targets] of aliases) {
    if (!prefix || !spec.startsWith(prefix)) continue;
    matched = true;
    for (const target of targets) {
      const joined = `${target}${spec.slice(prefix.length)}`.replace(/^\/+/, '');
      // Only an explicit extension is followed. Guessing one ('' → .astro →
      // /index.astro, the way a bundler resolves) would take a miss for a
      // finding, and this walk's negatives are what a miss becomes.
      if (/\.(astro|jsx?|tsx?|svelte|vue)$/i.test(joined)) return joined;
    }
  }
  return matched ? false : null;
}

// ─────────────── WHICH RULES THE CASCADE IS ALLOWED TO BE DECIDED OVER ───────
//
// `winning: true` is a claim about a box on a screen. A stylesheet the page
// never loads is not on that screen, so a declaration in one cannot be the
// winner, cannot be the thing that overrides a declaration that IS on the
// screen, and cannot be named as the reason one lost. All three were being
// said: `.pricing-grid { gap: 99px }` in a file no import chain reaches was
// reported `winning: true` while `gap: var(--gap)` in the imported stylesheet
// beside it was told, by name and by file, that it had lost to it.
//
// The reason was ordering, not arithmetic. Reachability was annotated onto the
// response AFTER computeRuleModel had already picked a winner over every rule
// in the project — a label pinned to a decision it had no part in, which is how
// `reachedByOpenPage: false` came to be printed beside `winning: true` in one
// object. So it is decided FIRST, and the engine is asked over the rules that
// survive it. The engine itself is untouched: it is the same computeRuleModel
// the Style panel a person is looking at runs, and a second one would be a
// second set of answers about the same page.
//
// FOUR TIERS, because "we did not prove it reaches" and "we proved it does not"
// and "we could not look" are three different facts and only one of them is
// `false`:
//
//   loaded     an import chain from the open page was followed to this source,
//              or it is a <style> block of the open file itself.
//   not-loaded the walk ran, FOLLOWED EVERY SPECIFIER IT FOUND, and this
//              component is not in the page's module graph. Astro emits a
//              component's CSS for the pages that import it, so its `:global()`
//              rules paint nothing here. A walk with a hole in it — an alias it
//              could not resolve, a dynamic import, the depth cut-off — says
//              `unproven` about everything it did not reach instead, because
//              what it did not reach is then not the same set as what is absent.
//   unproven   the walk ran and did not arrive here. Not `false` — an @import
//              inside a package, a Vite plugin or astro.config can load a
//              stylesheet nothing here can follow — but it is evidence, and a
//              source with less evidence than its rival may not beat it.
//   unchecked  no walk could be run at all (no open file, no bridge). Nothing
//              is known about ANY source, so nothing is held back from anything:
//              a uniform absence of evidence is not a reason to hedge every
//              declaration in the project.
const TIER = { loaded: 'loaded', absent: 'not-loaded', unproven: 'unproven', unchecked: 'unchecked' };

/** The project-relative file a rule was authored in, or null for a page block. */
function fileOfRule(rule) {
  const key = String(rule.embedKey || '');
  if (!key.startsWith('file:') && !key.startsWith('astro:')) return null;
  const shown = publicKey(key);
  return shown.slice(shown.indexOf(':') + 1);
}

/**
 * Whether the walk starts where Astro decides a page's CSS from.
 *
 * Astro bundles a page's stylesheets from the PAGE's module graph, so a walk
 * rooted at `src/pages/x.astro` can say what does and does not reach the
 * rendered document. Rooted anywhere else — a component opened for editing,
 * which is what `openFilePath` becomes the moment somebody drills into one —
 * it is a walk through PART of the page, and what it does not reach it may not
 * deny: the page above imports the rest. `.link { font-weight: 700 }` in the
 * project's own stylesheet is on the screen whether or not the Nav component
 * being edited happens to import it.
 *
 * So from inside a component nothing NEGATIVE is published: every source but
 * the open file's own blocks is unchecked, which is what it was before any of
 * this and is the honest answer from there.
 */
function rootedAtPage() {
  const host = getHost();
  if (!host.openFilePath) return false;
  const root = String(host.projectPath || '').replace(/\\/g, '/').replace(/\/$/, '');
  const posix = String(host.openFilePath).replace(/\\/g, '/');
  const rel = root && posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
  return /^src\/pages\//.test(rel);
}

/**
 * What can be shown about every source in `rules`, keyed by embedKey.
 *
 * Per SOURCE and not per rule: whether the page loads a file is a fact about
 * the file, and the `:global()` rules escaped from a component's scoped block
 * carry that component's own key.
 */
async function reachabilityByKey(rules) {
  const page = rootedAtPage();
  const [reaching, walk] = page
    ? await Promise.all([reachingFiles(), reachingComponents()])
    : [null, null];
  const renderedComponents = walk ? walk.components : null;
  // A walk that could have missed a component still proves the ones it found
  // ARE here; it no longer says anything about the ones it did not.
  const denies = !!walk?.complete;
  const tiers = new Map();
  for (const rule of rules) {
    const key = rule.embedKey;
    if (tiers.has(key)) continue;
    const file = fileOfRule(rule);
    // A <style> block of the file being edited is on the file being edited.
    if (String(key).startsWith('node:')) tiers.set(key, TIER.loaded);
    else if (reaching && file && reaching.has(file)) tiers.set(key, TIER.loaded);
    else if (String(key).startsWith('astro:') && file && renderedComponents) {
      tiers.set(
        key,
        renderedComponents.has(file) ? TIER.loaded : denies ? TIER.absent : TIER.unproven
      );
    } else if (reaching || renderedComponents) tiers.set(key, TIER.unproven);
    else tiers.set(key, TIER.unchecked);
  }
  return tiers;
}

// What `source.reachedByOpenPage` has always published, from the tier that now
// decides the cascade as well. Only `not-loaded` may be published as false.
const REACHED_BY_OPEN_PAGE = {
  [TIER.loaded]: true,
  [TIER.absent]: false,
  [TIER.unproven]: 'unknown',
  [TIER.unchecked]: 'unknown',
};

/**
 * What the served document proves that an import walk could not.
 *
 * The browser's list is the rules that actually reach this element. When it can
 * be trusted whole — every sheet readable, and short enough that nothing was
 * dropped by the preload's cap — a selector that is not in it does not reach
 * this element, and a source whose every matching rule is missing from it is
 * not on this page. That narrows `unproven` to `not-loaded`, and a declaration
 * that was hedging against it can go back to being an answer.
 *
 * ONE DIRECTION ONLY. The reverse — "the browser reports `.pricing-grid`, so
 * this file's `.pricing-grid` is the rule it is reporting" — is the conflation
 * this whole area exists to stop: three files in this project declare that
 * selector and the browser's rule is at most one of them. Selector text is
 * evidence of ABSENCE, never of identity.
 *
 * Values are not compared, deliberately: the CSSOM hands back `#3355ff` as
 * `rgb(51, 85, 255)`, so a value that does not match is as likely to be the
 * same declaration renormalised as a different one.
 *
 * AND "NOT IN THE LIST" IS NOT THE SAME FACT AS "NOT ON THE PAGE". The list is
 * what `el.matches(selector)` said about the document AT REST, so a rule that
 * matches nothing at rest is missing from it while being very much on the page:
 * `.pricing-grid:hover`, `.card::before`, a print sheet. A source whose only
 * rules for this element are those was being told, in the payload, that no
 * import chain reaches it. So a selector that could never have appeared is not
 * read as absent, and a source with no testable selector at all is not judged.
 *
 * The other half is that the list itself has to be shown to be complete before
 * absence from it means anything, and `unreadable === 0` does not show that —
 * the collector walks past a rule's own declarations when it has nested ones,
 * and past an `@import`ed sheet entirely, without counting either. So the list
 * is CALIBRATED first, against the sources this page is already known to load:
 * every testable rule of a plain stylesheet the walk reached must be in it. One
 * that is missing means the browser's list is incomplete for reasons this
 * cannot see, and nothing is narrowed by it.
 */
function narrowByDocument(tiers, listed, documentRules, unreadable, docs) {
  if (!Array.isArray(documentRules) || !documentRules.length) return tiers;
  // A truncated list is not a complete list, and absence in it proves nothing.
  if (unreadable !== 0 || documentRules.length >= MAX_DOCUMENT_RULES) return tiers;
  // `@import` pulls a whole stylesheet in through a rule that carries no
  // selector and no `cssRules`, so the collector walks past it without counting
  // it unreadable. One anywhere in this page's own CSS and the list is missing
  // an unknown number of rules — which is exactly the case `unproven` is for.
  if ((docs || []).some((doc) => /@import\b/.test(String(doc.code || '')))) return tiers;

  const served = new Set(documentRules.map((r) => normalizeSelector(r.selector)));
  const inList = (entry) =>
    served.has(normalizeSelector(entry.rule.selectorText)) ||
    entry.matchedSelectors.some((sel) => served.has(normalizeSelector(sel.text)));
  // A rule the browser could have reported: something about it matches this
  // element with the document as it stands, no pointer and no pseudo-element.
  const testable = (entry) =>
    !UNTESTABLE_AT_REST.test(entry.rule.selectorText) ||
    entry.matchedSelectors.some((sel) => !UNTESTABLE_AT_REST.test(sel.text));

  // CALIBRATION. Astro rewrites a component's scoped selectors on the way into
  // the document and a <style> block is scoped the same way, so neither is a
  // fair control; a plain stylesheet is served with its selectors intact.
  for (const entry of listed) {
    if (tiers.get(entry.rule.embedKey) !== TIER.loaded) continue;
    if (!String(entry.rule.embedKey).startsWith('file:')) continue;
    if (testable(entry) && !inList(entry)) return tiers;
  }

  // Every selector this source aims at this element, so one rule that IS served
  // keeps the whole source — and a source with nothing testable is not judged.
  const seen = new Map();
  for (const entry of listed) {
    const key = entry.rule.embedKey;
    if (tiers.get(key) !== TIER.unproven) continue;
    if (!testable(entry)) continue;
    seen.set(key, (seen.get(key) ?? false) || inList(entry));
  }
  const narrowed = new Map(tiers);
  for (const [key, hit] of seen) if (!hit) narrowed.set(key, TIER.absent);
  return narrowed;
}

// Selectors whose match depends on something other than the document at rest —
// where the pointer is, what has focus, what the user typed — plus every
// pseudo-element, which matches no element at all. `el.matches` answers these
// against the moment it is asked, so their absence from the browser's list is a
// fact about that moment and not about which stylesheets the page loaded.
// Structural pseudo-classes (`:first-child`, `:not()`, `:nth-child()`) are
// deliberately NOT here: they are decided by the document as it stands, so the
// browser's answer for them is as good as for a class.
const UNTESTABLE_AT_REST =
  /::|:(?:hover|focus|focus-visible|focus-within|active|target|target-within|visited|link|any-link|checked|indeterminate|placeholder-shown|autofill|user-invalid|user-valid|open|popover-open|modal|fullscreen|picture-in-picture|playing|paused|seeking|buffering|stalled|muted|volume-locked|current|past|future)\b/i;

// The preload's own cap on how many matching rules the served document reports
// (electron/preload.js, MAX_DOCUMENT_RULES). Mirrored rather than imported —
// the preload runs in an isolated world — and mirrored because a list that hit
// the cap may be missing the very rule this would take as proof of absence.
const MAX_DOCUMENT_RULES = 60;

/**
 * The same engine, twice, over two answers to "does this reach the page".
 *
 * `confident` is the cascade among the sources the page is known to load (plus,
 * where nothing could be checked at all, everything — see TIER.unchecked).
 * `open` is that plus the sources nothing could prove either way. The
 * DIFFERENCE between them is the whole of what is not known: a declaration that
 * wins in `confident` and loses in `open` lost to a file that may not be on the
 * page, and the honest answer for it is not `true` and not `false` but "this
 * wins among what is proved to be here, and here is what contests it".
 *
 * Sources proved absent are in neither, so nothing they declare can win, be
 * overridden, or override.
 */
async function cascadeTiers(rules, target, viewport, tiers, listing) {
  const tierOf = (rule) => tiers.get(rule.embedKey) || TIER.unchecked;
  const anyAbsent = rules.some((rule) => tierOf(rule) === TIER.absent);
  const anyUnproven = rules.some((rule) => tierOf(rule) === TIER.unproven);
  const present = (rule) => tierOf(rule) !== TIER.absent;
  const proved = (rule) => present(rule) && tierOf(rule) !== TIER.unproven;

  // A project with no `@layer` anywhere is decided exactly as it was, over one
  // engine pass per answer — which is every project the panel has ever seen.
  if (!rules.some((rule) => contextOf(rule).layer !== null)) {
    // Nothing was held back, so the listing pass already IS both answers. The
    // ordinary project — every stylesheet imported, no orphaned component —
    // takes this path and pays for one pass, as it always did.
    const open = anyAbsent ? await computeRuleModel(rules.filter(present), target, { viewport }) : listing;
    const confident = anyUnproven ? await computeRuleModel(rules.filter(proved), target, { viewport }) : open;
    return { open: statusIndex(open), confident: statusIndex(confident) };
  }

  // Layer order is a fact about the stylesheets, not about the subset of them a
  // given answer is decided over, so it is taken once over all of them and both
  // passes sort against the same table.
  const ranks = layerRanks(rules);
  const open = await layeredStatus(rules.filter(present), target, viewport, ranks);
  const confident = anyUnproven ? await layeredStatus(rules.filter(proved), target, viewport, ranks) : open;
  return { open, confident };
}

/**
 * The order the layers were declared in, earliest first.
 *
 * A layer's position is where its NAME first appears, and that can be a block
 * or a bare `@layer a, b;` statement — the form Tailwind and most design
 * systems open with, and the one css.ts drops entirely because it declares no
 * rules. `rule.order` is the panel's own document sequence, the same number
 * compareCascade already breaks its ties on, so nothing new is assumed here
 * about which stylesheet comes first.
 */
function layerRanks(rules) {
  const ranks = new Map();
  const roots = new Set();
  const note = (name) => {
    if (name && !ranks.has(name)) ranks.set(name, ranks.size);
  };
  for (const rule of [...rules].sort((a, b) => a.order - b.order)) {
    const root = typeof rule.node?.root === 'function' ? rule.node.root() : null;
    if (root && !roots.has(root)) {
      roots.add(root);
      root.walkAtRules('layer', (at) => {
        if (at.nodes) return; // a block; its own rules place it below
        const enclosing = layerPathOf(at.parent);
        for (const part of String(at.params || '').split(',')) {
          const name = part.trim();
          if (name) note([...enclosing, name].join('.'));
        }
      });
    }
    note(contextOf(rule).layer);
  }
  return ranks;
}

/**
 * The cascade over one set of rules, decided across its layers.
 *
 * The engine is run once per layer — over that layer's rules and nothing else,
 * so within a partition it is deciding exactly what it was built to decide, by
 * importance then specificity then document order. What it cannot see is the
 * comparison that comes BEFORE specificity, and that is the only thing added
 * here: among the winners its passes produced, which layer's wins.
 */
async function layeredStatus(rules, target, viewport, ranks) {
  const partitions = new Map();
  for (const rule of rules) {
    const layer = contextOf(rule).layer;
    if (!partitions.has(layer)) partitions.set(layer, []);
    partitions.get(layer).push(rule);
  }
  const models = [];
  for (const [layer, list] of partitions) {
    models.push({
      layer,
      rank: layer === null ? null : (ranks.get(layer) ?? ranks.size),
      model: await computeRuleModel(list, target, { viewport }),
    });
  }
  return composeLayers(models);
}

/**
 * Which of two would-be winners CSS Cascade 5 puts first. Negative: `a` wins.
 *
 * Importance outranks everything. Then the layer, in the two directions the
 * spec gives it: a NORMAL declaration outside every layer beats every layered
 * one and a later layer beats an earlier one, while `!important` reverses both
 * — an important declaration in the FIRST layer beats every other author rule
 * on the page. Specificity and document order never appear here; the engine
 * settled those inside each partition before this is asked.
 */
function strongerCandidate(a, b) {
  if (a.important !== b.important) return a.important ? -1 : 1;
  const aFree = a.layer === null;
  const bFree = b.layer === null;
  if (aFree !== bFree) return (a.important ? bFree : aFree) ? -1 : 1;
  if (a.rank === b.rank) return 0;
  return a.important ? a.rank - b.rank : b.rank - a.rank;
}

/** The `overriddenBy` shape for a rule, before publicKey — the engine's own. */
const originFrom = (rule) => ({
  selector: rule.selectorText,
  atContext: contextOf(rule).atContext,
  source: rule.embedKey,
  sourceLabel: rule.embedLabel,
});

const rawOriginKey = (o) => `${o.source}|${(o.atContext || []).join('|')}|${o.selector}`;

/**
 * One status index over several layer partitions.
 *
 * Each partition's own statuses are kept — resolved/applies/appliesWhen are
 * facts about a rule and its query, and no layer changes them — and only the
 * cascade verdict is decided again across them. A declaration that won its own
 * partition but not the page is told so by name: `overriddenBy` is the rule
 * that actually paints the property, which is the sentence that was untrue.
 */
function composeLayers(models) {
  const held = new Map(); // declId → { status, prop, part }
  const champions = new Map(); // prop → candidate
  const contests = new Map(); // prop → Map(originKey → origin)
  const undecidable = [];
  const contest = (prop, origin) => {
    if (!contests.has(prop)) contests.set(prop, new Map());
    contests.get(prop).set(rawOriginKey(origin), origin);
  };

  for (const part of models) {
    for (const entry of [...part.model.base, ...part.model.conditional]) {
      for (const decl of entry.rule.declarations) {
        const status = entry.declStatus?.[decl.declId];
        if (!status) continue;
        held.set(decl.declId, { status, prop: decl.prop, part });
        for (const by of status.contestedBy || []) contest(decl.prop, by);
        const candidate = {
          declId: decl.declId,
          important: !!decl.important,
          layer: part.layer,
          rank: part.rank,
          rule: entry.rule,
        };
        if (status.resolved && status.winning) {
          const standing = champions.get(decl.prop);
          if (!standing || strongerCandidate(candidate, standing) < 0) champions.set(decl.prop, candidate);
        } else if (
          !status.resolved &&
          status.applies === null &&
          entry.kind === 'at-rule' &&
          entry.matchedSelectors.some((sel) => !UNTESTABLE_AT_REST.test(sel.text))
        ) {
          undecidable.push({ ...candidate, prop: decl.prop, entry });
        }
      }
    }
  }

  // A query nobody could decide contests the winner, and the engine already
  // says so WITHIN a partition. Across one it cannot: an undecidable `@media`
  // in a layer that would outrank the winner is the same uncertainty, and the
  // pass that found it had no winner of its own to hang it on.
  for (const rule of undecidable) {
    const champion = champions.get(rule.prop);
    if (!champion || champion.layer === rule.layer) continue;
    if (strongerCandidate(rule, champion) > 0) continue; // it could not win even if it applied
    contest(rule.prop, originFrom(rule.rule));
  }

  const index = new Map();
  for (const [declId, { status, prop }] of held) {
    const champion = champions.get(prop);
    if (!status.resolved || !champion) {
      index.set(declId, status);
      continue;
    }
    if (champion.declId === declId) {
      const rivals = [...(contests.get(prop) || new Map()).values()].filter(
        (origin) => rawOriginKey(origin) !== rawOriginKey(originFrom(champion.rule))
      );
      index.set(declId, { ...status, winning: true, overriddenBy: null, overriddenByOrigin: null, contestedBy: rivals.length ? rivals : null });
      continue;
    }
    index.set(declId, {
      ...status,
      winning: false,
      overriddenBy: champion.rule.selectorText,
      overriddenByOrigin: originFrom(champion.rule),
      contestedBy: null,
    });
  }
  return index;
}

/** Declaration id → its status in one model. declIds are seeded per source, so
 *  one flat map cannot collide across stylesheets. */
function statusIndex(model) {
  const index = new Map();
  for (const entry of [...model.base, ...model.conditional]) {
    for (const [declId, status] of Object.entries(entry.declStatus || {})) index.set(declId, status);
  }
  return index;
}

/**
 * Where a rule that beat this one, or might, was authored — the shape both
 * `overriddenBy` and each `contestedBy` entry take.
 *
 * The selector alone cannot name it: three stylesheets in this project can
 * declare `.pricing-grid`, and one of them may be a file this page never loads.
 * The query travels with it for the same reason — without it a base declaration
 * beaten by `@media (min-width: 50em) { .section-header h3 }` was told it lost
 * to `.section-header h3`, itself as far as a reader could tell.
 */
const originOf = (origin) =>
  origin
    ? {
        selector: origin.selector,
        atContext: origin.atContext || [],
        source: publicKey(origin.source),
        sourceLabel: origin.sourceLabel,
      }
    : null;

/** Two rivals are the same rival when they are the same rule in the same file
 *  under the same query — one property beaten twice is one entry. */
const originKey = (c) => `${c.source}|${(c.atContext || []).join('|')}|${c.selector}`;

/**
 * What one declaration is entitled to claim, given who is proved to be here.
 *
 * Three answers, and the tier decides which question is even being asked:
 *
 *   not-loaded  it was never in the cascade. Not `false` — nothing beat it, and
 *               saying it lost would name a winner it never ran against.
 *   unproven    it may be on this page and it may not, so it may not be the
 *               answer. It can still be told it LOST, but only to a source that
 *               is at least as well evidenced as it is.
 *   loaded /    the cascade among what is proved to be here decides it — and
 *   unchecked   where letting the unproven sources in would change that answer,
 *               the difference is published as a contest rather than swallowed.
 */
function declarationVerdict(entry, decl, tier, confident, open) {
  const rule = entry.rule;
  if (tier === TIER.absent) {
    return {
      winning: null,
      appliesWhen: null,
      overriddenBy: null,
      notInCascade:
        `${rule.embedLabel} is not loaded by this page — no import chain from the page reaches it — so this ` +
        'declaration was left out before the winner was computed. It is not painting this element, and nothing ' +
        'here lost to it.',
    };
  }

  const wide = open.get(decl.declId) || {};
  // An unproven source is not in the confident model at all, so the wider one
  // is the only place it has a status.
  const status = tier === TIER.unproven ? wide : confident.get(decl.declId) || wide;
  const resolved = status.resolved !== false;
  const appliesWhen = resolved
    ? null
    : (rule.atContext || []).length
      ? rule.atContext
      : entry.matchedSelectors.map((sel) => sel.text);

  if (tier === TIER.unproven) {
    // Losing to something that IS here is a fact whichever way this file's own
    // reachability goes; winning would be a claim it has not earned.
    const lost = resolved && status.winning === false && status.overriddenByOrigin;
    return {
      winning: lost ? false : null,
      appliesWhen,
      overriddenBy: lost ? originOf(status.overriddenByOrigin) : null,
      ...(lost
        ? {}
        : {
            unprovenSource:
              `Nothing followed an import chain from this page to ${rule.embedLabel}, so this may or may not be ` +
              'reaching the element. It is reported because it is in the project, not because it was proved to ' +
              'apply; `computed` is what the element actually has.',
          }),
    };
  }

  // Everything that sets this property and might still turn out to be the value
  // the element has: a query nobody could decide, and a file nobody could prove
  // is on the page.
  const contested = new Map();
  for (const list of [status.contestedBy, wide.contestedBy])
    for (const by of list || []) {
      const c = originOf(by);
      contested.set(originKey(c), c);
    }
  // It wins among what is proved to be here, and loses once the unproven files
  // are let in. That difference IS the uncertainty, and it is the whole reason
  // the engine is run twice.
  if (resolved && status.winning !== false && wide.winning === false && wide.overriddenByOrigin) {
    const c = originOf(wide.overriddenByOrigin);
    contested.set(originKey(c), c);
  }
  const contestedBy = resolved && status.winning !== false && contested.size ? [...contested.values()] : null;

  return {
    winning: resolved ? (contestedBy ? null : status.winning !== false) : null,
    appliesWhen,
    overriddenBy: originOf(status.overriddenByOrigin),
    // Only ever present when it is the reason `winning` is null.
    ...(contestedBy
      ? {
          contestedBy,
          // Kept to one line: it repeats per contested declaration, and the
          // evidence is `contestedBy` rather than the sentence.
          undecided:
            'This wins among the rules that could be resolved and proved to reach this page; `contestedBy` sets the ' +
            'same property under something nothing here could decide — a query at an unknown viewport, or a file no ' +
            'import chain leads to. `computed` is what the element actually has.',
        }
      : {}),
  };
}

/** The dependency whose output is missing from an authored-source scan. */
async function generatorNote() {
  const host = getHost();
  const avb = bridge();
  if (!host.projectPath || !avb?.styleGenerators) return null;
  const answer = await Promise.resolve(avb.styleGenerators(host.projectPath)).catch(() => null);
  const packages = answer?.packages;
  if (!Array.isArray(packages) || !packages.length) return null;
  return (
    `This project depends on ${packages.map((p) => `${p.name}@${p.version}`).join(', ')} (package.json). ` +
    'The CSS those generate is not an authored file and is not in `rules`.'
  );
}

/**
 * Every declaration reaching this element, in cascade order — and an account
 * of what "every" means here.
 *
 * Each one says where it was authored, whether it wins, what overrides it when
 * it does not, which custom properties it reads, and — for the ones that
 * matter — what the browser resolved it to. That is the whole answer to "why
 * does this look like that", and it is why nothing needs to grep for a class.
 *
 * The second half is the part that had to be added. This list is built from
 * files the project authors, and three things are not in them: CSS a build step
 * generates, the hashed rules of components that did not render this element,
 * and whatever the panel has not scanned yet. An answer that reports zero rules
 * without saying which of those applied is indistinguishable from an element
 * with no CSS, and an agent will act on it. So `coverage` states the basis, and
 * `explainsComputed` reconciles what came back against what the engine actually
 * resolved: a property nothing here can account for is named, not omitted.
 */
export async function readStyles(node, { pathOf, properties = null, viewport: measuredAt = null } = {}) {
  const { docs, rules: parsed, model, target, rootSnapshot, errors, asked, viewport } = await readCascade(node, measuredAt);
  const all = [...model.base, ...model.conditional];
  const matched = all.slice(0, MAX_RULES);

  // THE PROPERTIES THE ANSWER IS ABOUT, decided before any verdict is.
  //
  // What the caller named, plus every property the rules this answer will
  // return declare — which is a fact about the LISTING and needs no cascade.
  // It has to be settled here because the served document is asked next, and
  // what it says is evidence about which sources are on this page: the winner
  // cannot be computed until after that question has been put.
  const wanted = new Set(properties || []);
  for (const entry of matched)
    for (const decl of entry.rule.declarations.slice(0, MAX_DECLS_PER_RULE)) wanted.add(decl.prop);

  const { computed, documentRules, runtime } = await askDocument(node, [...wanted].slice(0, 200), pathOf);

  // WHO IS ON THIS PAGE — settled before the cascade, not annotated after it.
  const tiers = narrowByDocument(
    await reachabilityByKey(parsed),
    all,
    documentRules,
    runtime.available === true ? runtime.unreadableStyleSheets : null,
    docs
  );
  const { open, confident } = await cascadeTiers(parsed, target, viewport, tiers, model);

  const rules = matched.map((entry) => {
    const rule = entry.rule;
    const tier = tiers.get(rule.embedKey) || TIER.unchecked;
    const declarations = rule.declarations.slice(0, MAX_DECLS_PER_RULE).map((decl) => {
      // A conditional declaration nothing resolved (:hover, or an @media at an
      // unknown viewport) was never measured against anything: nothing here
      // knows where the pointer is. It used to be reported `winning: true`
      // beside the base declaration that also said it won — one property, two
      // winners, in one response.
      //
      // AND THE OTHER HALF OF THE SAME SENTENCE. A base declaration a media
      // query overrides at the viewport being measured is not the winner
      // either, and saying so contradicts the `computed` value in this same
      // payload — measured, twice, on a page whose h3 was 56px while this said
      // `font-size: var(--text-2xl)` (34px) won. When the query could be
      // decided the cascade above has already settled it; when it could not,
      // `winning` is null and the rules that make it undecidable are named.
      //
      // AND THE THIRD, which is the same shape one axis over: a file this page
      // was never proved to load is undecidable in exactly the way an
      // unresolved query is, so it contests rather than wins — and a file
      // proved NOT to be here is not undecidable at all, it is simply not in
      // the cascade.
      const verdict = declarationVerdict(entry, decl, tier, confident, open);
      return {
        property: decl.prop,
        value: clip(decl.value),
        important: !!decl.important,
        ...verdict,
        variables: variablesIn(decl.value),
        identity: declarationIdentity(rule, decl.prop, digestOfDoc(docs, rule.embedKey)),
      };
    });
    const doc = docFor(docs, rule.embedKey);
    const file =
      rule.embedKey.startsWith('file:') || rule.embedKey.startsWith('astro:')
        ? publicKey(rule.embedKey).slice(publicKey(rule.embedKey).indexOf(':') + 1)
        : null;
    return {
      selector: rule.selectorText,
      matchedSelectors: entry.matchedSelectors.map((s) => s.text),
      label: entry.label,
      kind: entry.kind,
      conditional: !!entry.conditional,
      // Layers included — see contextOf. `conditional` above stays the engine's
      // answer, which is the right one: a layer is not a condition, it always
      // applies, and only the ORDER it applies in is different.
      atContext: contextOf(rule).atContext,
      nested: rule.nestedDisplay || null,
      // A `:global()` rule read out of a scoped block is offered for reading
      // and cannot be written back through the component (see webflow.ts), so
      // it must not be handed over as though set_property could change it.
      editable: !isReadOnlyRule(rule),
      source: {
        key: publicKey(rule.embedKey),
        label: rule.embedLabel,
        fromComponent: !!rule.fromComponent,
        componentName: rule.componentName || null,
        // A stylesheet is a file an agent may also read as source; a <style>
        // block is a node in the document being edited.
        kind: rule.embedKey.startsWith('file:') ? 'stylesheet' : rule.embedKey.startsWith('astro:') ? 'component' : 'block',
        file,
        // Whether these rules reach the page at all, or only the elements the
        // open component renders.
        scope: doc?.source.scope || 'global',
        // True only where an import chain from the open page was actually
        // followed to this file. For a STYLESHEET, never false: an @import
        // inside a package, a framework injection or astro.config can all load
        // one nothing here can see, so "not proved" is as far as that goes.
        //
        // A COMPONENT is different, and this is the one place `false` is
        // honest. Astro emits a component's CSS for the pages whose module
        // graph contains it, so a component the open page does not import —
        // directly or through another component — cannot be painting this
        // element, and the `:global()` rules read out of its scoped block must
        // not be offered as though they were. Still 'unknown' when the walk
        // could not be done at all.
        reachedByOpenPage: REACHED_BY_OPEN_PAGE[tier],
        // WHY it says that, because 'unknown' has two causes and they are not
        // the same fact. `unproven` is a walk that ran from this page and did
        // not arrive here — enough for this source to lose an argument with one
        // that did, which is what `winning` above now reflects; `unchecked` is
        // no walk at all, and holds nothing against anybody.
        reachEvidence: tier,
      },
      declarations,
      declarationsOmitted: Math.max(0, rule.declarations.length - MAX_DECLS_PER_RULE),
    };
  });

  const { explainsComputed, unexplained, unaccountedRules } = reconcileComputed(rules, computed, documentRules);
  const kinds = { stylesheet: 0, component: 0, block: 0 };
  for (const doc of docs) {
    const key = doc.source.origin.kind;
    kinds[key === 'file' ? 'stylesheet' : key === 'astro' ? 'component' : 'block'] += 1;
  }
  const note = await generatorNote();
  const problems = (errors || []).map((e) => `${e.label}: ${e.error}`);
  if (!docs.length) {
    problems.push(
      'No stylesheet was scanned for this element — this answer describes no CSS at all, not an element with no CSS.'
    );
  }

  return {
    element: {
      tag: rootSnapshot?.tag || null,
      id: rootSnapshot?.id || null,
      classes: rootSnapshot?.classes || [],
      // A component instance has no tag of its own in the source, so `null`
      // there is either "the page said so" or "nothing on the page answered",
      // and those are not the same fact. The canvas is asked first; the
      // classes the preview reported for the selection are folded in by
      // buildSnapshot; the model is what is left.
      identitySource: asked?.answer?.identity
        ? 'canvas'
        : (getHost().renderedClasses || []).length && node.id === getHost().selectedId
          ? 'rendered'
          : 'model',
    },
    rules,
    // Kept, and now only ever meaning what it always meant: how many MATCHED
    // rules the display cap dropped. What was never scanned is coverage's.
    rulesOmitted: Math.max(0, all.length - MAX_RULES),
    listCap: {
      max: MAX_RULES,
      matched: model.matchedRuleCount,
      returned: rules.length,
      omittedByCap: Math.max(0, all.length - MAX_RULES),
    },
    matchedRuleCount: model.matchedRuleCount,
    // WHICH PAGE THIS IS ABOUT. `winning` is a statement about a rendered box,
    // and a box has a width: `@media (min-width: 50em)` is the winner at 1200
    // and not at 375. So the answer says where it was resolved — and null,
    // meaning nothing measured one, is why a declaration a media query might
    // override carries `winning: null` rather than a guess.
    viewport: viewport ? { width: viewport.width, height: viewport.height ?? null } : null,
    computed,
    // The rules the served document says match, generated CSS included. Null —
    // never [] — when there was no preview to ask: nobody looked is not the
    // same answer as nothing matched.
    documentRules,
    coverage: {
      basis: 'authored',
      sourcesScanned: docs.length,
      kinds,
      cascadeScope: CASCADE_SCOPE,
      // COMPLETE MEANS NOTHING ELSE REACHES THIS ELEMENT, and the response has
      // to be able to lose that argument against its own contents.
      //
      // It used to be `runtime.available && explainsComputed`, which is
      // circular: `wanted` is built from the properties the AUTHORED rules
      // declare, `computed` is only ever asked for those, and reconciling them
      // therefore asks whether the authored rules explain the authored rules. A
      // rule the scan never saw sets a property nobody asked about, so it could
      // not make the answer incomplete — and `complete: true` came back beside a
      // `documentRules` list carrying two Tailwind utilities the same response
      // could not account for.
      //
      // `unaccountedRules` closes it with evidence the answer is already
      // carrying: the browser's own list of what matches, minus everything the
      // authored scan returned. One entry in it and this is false.
      complete: runtime.available === true && explainsComputed === true && unaccountedRules.length === 0,
      excludes: EXCLUDED_FROM_AUTHORED,
      runtime: {
        ...runtime,
        // Named, not counted: "which rule" is what tells a caller whether the
        // gap is a utility framework or a stylesheet nothing in the project
        // authors. Capped, because a Tailwind element can match dozens.
        ...(runtime.available
          ? {
              unaccountedRules: unaccountedRules.slice(0, MAX_UNACCOUNTED),
              unaccountedRuleCount: unaccountedRules.length,
              ...(unaccountedRules.length
                ? {
                    unaccountedNote:
                      'The served document says these rules match this element and no authored source Stacki scanned ' +
                      'contains them — generated CSS, or a stylesheet outside the project. They are why ' +
                      '`coverage.complete` is false; `documentRules` carries their declarations.',
                  }
                : {}),
            }
          : {}),
      },
      ...(note ? { note } : {}),
    },
    explainsComputed,
    unexplained,
    // Where a new declaration would go if the caller names no source. The last
    // project stylesheet, which is where the panel puts one too.
    //
    // Not everything in this list can be written into. A component whose only
    // page-wide CSS is a `:global()` rule inside a scoped block is a source of
    // rules and not a destination for them — Stacki reads that block and leaves
    // it exactly as the author wrote it — so it says so here rather than
    // refusing after the caller has committed to it.
    writableSources: docs
      .map((doc) => ({
        key: publicKey(doc.source.key),
        label: doc.source.label,
        kind: doc.source.origin.kind,
        writable: doc.regions.some((region) => !!region.root),
      }))
      .slice(0, MAX_RULES),
    problems,
  };
}

/** The doc a rule was parsed out of. */
const docFor = (docs, key) => docs.find((d) => d.source.key === key) || null;

/** The version marker for the source a rule came out of. */
const digestOfDoc = (docs, key) => {
  const doc = docFor(docs, key);
  return doc ? digestOfSource(doc.code) : null;
};

/**
 * Whether the stylesheet a declaration was read from is still that stylesheet.
 *
 * Null when it is, or when the caller passed an identity from before this
 * carried a digest. Otherwise the refusal — the rule may well still be there,
 * and that is not the question being asked.
 */
function checkSource(docs, embedKey, identity) {
  if (!identity?.sourceDigest) return null;
  const now = digestOfDoc(docs, embedKey);
  if (now === identity.sourceDigest) return null;
  return problem(
    'stale_target',
    `${identity.sourceLabel || identity.source} has changed since you read it — the rule is still there, but not ` +
      'the version you reasoned about. Nothing was written. Read the styles again.'
  );
}

/** The parsed rule matching a semantic identity, or null. */
function findRule(rules, identity) {
  const wantContext = (identity.atContext || []).join(' › ');
  const want = internalKey(identity.source);
  return (
    rules.find(
      (rule) =>
        rule.embedKey === want &&
        rule.selectorText.trim() === String(identity.selector || '').trim() &&
        // The same list declarationIdentity published, layer included — the two
        // must be read through one function or a write lands in the wrong rule.
        contextOf(rule).atContext.join(' › ') === wantContext
    ) || null
  );
}

const problem = (code, message) => ({ ok: false, code, message });

/**
 * Why a declaration the caller named cannot be written, or null.
 *
 * Order is the whole of it. `findRule` returns null for three different
 * situations — the source was never loaded, the source is loaded and has no
 * such rule, the source was rewritten since it was read — and answering all
 * three with "the stylesheet changed since you read it, read the styles again"
 * sends an agent round a loop that cannot terminate: reading again produces the
 * same nothing, and the file it is being told to re-read may not exist.
 */
async function locateIdentity(docs, rules, identity) {
  const key = internalKey(identity.source);
  const doc = docFor(docs, key);
  if (!doc) {
    return problem(
      'no_source',
      `There is no style source called ${identity.source} on this page. Nothing was written. ` +
        'style.read lists what Stacki can write into as writableSources; CSS generated at build time is not among them.'
    );
  }
  const moved = checkSource(docs, key, identity);
  if (moved) return moved;
  const rule = findRule(rules, identity);
  if (!rule) {
    const where = (identity.atContext || []).length ? ` inside ${identity.atContext.join(' › ')}` : '';
    return problem(
      'no_rule',
      `${doc.source.label} has not changed since you read it, and it has no rule ${identity.selector}${where}. ` +
        'Nothing was written. To create it, pass selector and source instead of identity.'
    );
  }
  if (isReadOnlyRule(rule)) {
    return problem(
      'read_only',
      `${identity.selector} reaches this page through a :global() rule in ${doc.source.label}'s scoped <style> block. ` +
        'Stacki reads those but does not write them. Nothing was written — edit the component, or author the rule in a stylesheet.'
    );
  }
  return null;
}

/**
 * Set one property.
 *
 * Three cases, in order of how much the caller has told us:
 *
 *   it names a declaration that exists   → change that one, where it is.
 *   it names a selector and a source     → add it there, merging into an
 *                                          existing rule for that selector.
 *   it names neither                     → refuse. Guessing which of eleven
 *                                          stylesheets somebody meant is how a
 *                                          design system gets a stray rule in
 *                                          a vendor file.
 */
export async function setProperty(node, { identity, source, selector, property, value, important = false, live = false }) {
  const prop = String(property || '').trim();
  const next = String(value ?? '').trim();
  if (!prop) return problem('bad_request', 'A CSS property is required.');
  if (!next) return problem('bad_request', 'A value is required — use remove_property to take a declaration out.');

  const { docs, rules } = await readCascade(node);

  if (identity) {
    // Three situations used to come back as one sentence — "the stylesheet
    // changed since you read it. Read the styles again." — and for two of them
    // that advice is guaranteed to produce the identical failure for ever.
    // Asked in this order, each answers only for itself.
    const refusal = await locateIdentity(docs, rules, identity);
    if (refusal) return refusal;
    const rule = findRule(rules, identity);
    const doc = docFor(docs, rule.embedKey);
    const existing = rule.declarations.find((d) => d.prop.toLowerCase() === prop.toLowerCase());
    if (existing) setDeclarationValue(existing, next, important);
    else if (!addDeclaration(rule, prop, next, important)) {
      return problem('bad_request', `${prop}: ${next} is not a declaration Stacki can write.`);
    }
    const written = await writeEmbedDoc(doc, live);
    if (!written.ok) return problem('write_failed', written.error);
    return {
      ok: true,
      wrote: { ...declarationIdentity(rule, prop), value: next, important },
      source: { key: publicKey(doc.source.key), label: doc.source.label, kind: doc.source.origin.kind },
    };
  }

  const target = String(selector || '').trim();
  if (!target) {
    return problem(
      'bad_request',
      'Name either the declaration you read (identity) or a selector and the source to write it into. ' +
        'Stacki will not guess which stylesheet a new rule belongs in.'
    );
  }
  const doc = source ? docFor(docs, internalKey(source)) : null;
  if (!doc) {
    return problem(
      'no_source',
      source
        ? `There is no style source called ${source} on this page.`
        : 'Name the source to write into — style.read lists them as writableSources.'
    );
  }
  // WHICH BLOCK A NEW RULE GOES IN, AND THE THREE REASONS THERE MIGHT NOT BE ONE.
  //
  // This used to take the LAST region unconditionally and refuse a rootless one
  // as "Stacki could not parse X" — one false sentence for three situations.
  // Stacki parses a component's scoped <style> perfectly well; `root: null` is
  // the deliberate decision not to edit it (see docForSource), not a failure. So
  // the refusal sent a person hunting a syntax error that is not there — the
  // same defect class locateIdentity was written to eliminate — and a component
  // whose LAST block happened to be scoped was refused even with a writable
  // is:global block above it.
  const writableRegions = doc.regions.filter((r) => !!r.root);
  const region = writableRegions[writableRegions.length - 1];
  if (!region) {
    const failed = doc.regions.find((r) => r.parseError);
    if (failed) return problem('unrepresentable', `Stacki could not parse ${doc.source.label}: ${failed.parseError}`);
    return problem(
      'read_only',
      `${doc.source.label} has no style block Stacki will write into. A component's scoped <style> is read verbatim ` +
        'and never edited — only an is:global block or a stylesheet is a destination. Nothing was written; ' +
        'style.read marks which sources are writable.'
    );
  }
  if (!createRuleAtRoot(region, target, prop, next, important)) {
    return problem('bad_request', `Stacki could not write ${prop}: ${next} for ${target}.`);
  }
  const written = await writeEmbedDoc(doc, live);
  if (!written.ok) return problem('write_failed', written.error);
  return {
    ok: true,
    wrote: { source: publicKey(doc.source.key), sourceLabel: doc.source.label, atContext: [], selector: target, property: prop, value: next, important },
    source: { key: publicKey(doc.source.key), label: doc.source.label, kind: doc.source.origin.kind },
    created: true,
  };
}

/** Take one authored declaration out. An emptied rule goes with it. */
export async function removeProperty(node, { identity, live = false }) {
  if (!identity?.selector || !identity?.source || !identity?.property) {
    return problem('bad_request', 'Name the declaration to remove, as style.read reported it.');
  }
  const { docs, rules } = await readCascade(node);
  const refusal = await locateIdentity(docs, rules, identity);
  if (refusal) return refusal;
  const rule = findRule(rules, identity);
  const decl = rule.declarations.find((d) => d.prop.toLowerCase() === String(identity.property).toLowerCase());
  if (!decl) return { ok: true, removed: false, note: `${identity.property} was not on ${identity.selector}.` };
  const doc = docFor(docs, rule.embedKey);
  removeDeclaration(decl);
  const emptied = removeRuleIfEmpty(rule);
  const written = await writeEmbedDoc(doc, live);
  if (!written.ok) return problem('write_failed', written.error);
  return {
    ok: true,
    removed: true,
    ruleRemoved: emptied,
    source: { key: publicKey(doc.source.key), label: doc.source.label, kind: doc.source.origin.kind },
  };
}

/** Several properties on one rule, in one write and one undo step. */
export async function setDeclarations(node, { identity, source, selector, declarations, live = false }) {
  const list = Array.isArray(declarations) ? declarations : [];
  if (!list.length) return problem('bad_request', 'declarations must name at least one property.');
  let result = null;
  // After the first write the rule certainly exists, so the rest address it by
  // where the first one landed — which is what keeps them in the same rule
  // rather than scattering across a stylesheet.
  let where = identity || null;
  for (const [index, entry] of list.entries()) {
    result = await setProperty(node, {
      identity: where ? { ...where, property: entry.property } : null,
      source,
      selector,
      property: entry.property,
      value: entry.value,
      important: !!entry.important,
      // Every write but the last is a live one, so the burst coalesces into a
      // single undo step the way a slider drag does.
      live: index < list.length - 1,
    });
    if (!result.ok) return { ...result, applied: index };
    if (!where && result.wrote) {
      where = { source: result.wrote.source, atContext: result.wrote.atContext || [], selector: result.wrote.selector };
    }
  }
  return { ok: true, applied: list.length, source: result?.source || null };
}

/** The style sources this page has, without parsing any of them. */
export async function listSources() {
  const scan = await scanPage(await ownStyleFiles());
  return {
    sources: scan.pageEmbeds.map((s) => {
      const pub = publicKey(s.key);
      return {
        key: pub,
        label: s.label,
        // A component source's label is a bare filename ("Nav.astro"), which
        // nothing can open. The project-relative path is in the key; anything
        // that wants to read the source needs it spelled out.
        path: s.origin.kind === 'node' ? null : pub.slice(pub.indexOf(':') + 1),
        kind: s.origin.kind,
        scope: s.scope,
        fromComponent: !!s.fromComponent,
        componentName: s.componentName || null,
      };
    }),
    openFile: publicKey(`file:${getHost().openFilePath || ''}`).slice('file:'.length) || null,
  };
}

export default readStyles;
