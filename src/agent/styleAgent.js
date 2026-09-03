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
  atContext: rule.atContext || [],
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

/** Everything the page's CSS is, parsed once. */
async function readCascade(node) {
  const scan = await scanPage(await ownStyleFiles());
  const { docs, errors } = await loadEmbedDocs(scan.pageEmbeds);
  const rules = rebuildRules(docs);
  const asked = await askCanvasAbout(node.id, rules);
  const { target, rootSnapshot } = await resolveTarget(node, scan, asked);
  await primeDomMatches(target, rules, asked);
  const model = await computeRuleModel(rules, target);
  return { docs, rules, model, rootSnapshot, errors, asked };
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

/**
 * Which computed properties no returned declaration can account for.
 *
 * Deliberately not a value comparison: `var(--gap)` and `16px` are the same
 * declaration and normalising every property to find that out is a second CSS
 * engine. The decidable question is the one that matters here — is there any
 * winning authored declaration for this property at all — and it is exactly the
 * question a Tailwind element answers "no" to for everything it is styled with.
 */
export function reconcileComputed(rules, computed) {
  const explained = new Set(
    (rules || []).flatMap((rule) => (rule.declarations || []).filter((d) => d.winning === true).map((d) => d.property))
  );
  const unexplained = Object.entries(computed || {})
    .filter(([property, value]) => !explained.has(property) && value !== null && value !== '')
    .map(([property, value]) => ({
      property,
      computed: value,
      reason: 'no authored declaration Stacki can see sets this property on this element',
    }));
  return { explainsComputed: computed ? unexplained.length === 0 : null, unexplained };
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
  'the open file and the page-wide blocks of its components. `source.reachedByOpenPage` says which of them this page ' +
  'was proved to load.';

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
export async function readStyles(node, { pathOf, properties = null } = {}) {
  const { docs, model, rootSnapshot, errors, asked } = await readCascade(node);
  const all = [...model.base, ...model.conditional];
  const matched = all.slice(0, MAX_RULES);
  const reaching = await reachingFiles();

  const wanted = new Set(properties || []);
  const rules = matched.map((entry) => {
    const rule = entry.rule;
    const declarations = rule.declarations.slice(0, MAX_DECLS_PER_RULE).map((decl) => {
      const status = entry.declStatus?.[decl.declId] || {};
      // A conditional declaration (@media, :hover) was never resolved against
      // anything: nothing here knows the viewport or where the pointer is. It
      // used to be reported `winning: true` beside the base declaration that
      // also said it won — one property, two winners, in one response.
      const resolved = status.resolved !== false;
      return {
        property: decl.prop,
        value: clip(decl.value),
        important: !!decl.important,
        winning: resolved ? status.winning !== false : null,
        appliesWhen: resolved
          ? null
          : (rule.atContext || []).length
            ? rule.atContext
            : entry.matchedSelectors.map((sel) => sel.text),
        // The selector alone cannot name the winner: three stylesheets in this
        // project can declare `.pricing-grid`, and one of them may be a file
        // this page never loads.
        overriddenBy: status.overriddenByOrigin
          ? {
              selector: status.overriddenByOrigin.selector,
              source: publicKey(status.overriddenByOrigin.source),
              sourceLabel: status.overriddenByOrigin.sourceLabel,
            }
          : null,
        variables: variablesIn(decl.value),
        identity: declarationIdentity(rule, decl.prop, digestOfDoc(docs, rule.embedKey)),
      };
    });
    for (const decl of declarations) wanted.add(decl.property);
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
      atContext: rule.atContext || [],
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
        // followed to this file. Never false: an @import inside a package, a
        // framework injection or astro.config can all load a stylesheet
        // nothing here can see, so "not proved" is as far as this goes.
        reachedByOpenPage:
          rule.embedKey.startsWith('node:') || (reaching && file && reaching.has(file)) ? true : 'unknown',
      },
      declarations,
      declarationsOmitted: Math.max(0, rule.declarations.length - MAX_DECLS_PER_RULE),
    };
  });

  const { computed, documentRules, runtime } = await askDocument(node, [...wanted].slice(0, 200), pathOf);
  const { explainsComputed, unexplained } = reconcileComputed(rules, computed);
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
      // Only ever true when the engine's own answer was obtained AND every
      // property in it is accounted for by a rule above.
      complete: runtime.available === true && explainsComputed === true,
      excludes: EXCLUDED_FROM_AUTHORED,
      runtime,
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
        (rule.atContext || []).join(' › ') === wantContext
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
  const region = doc.regions[doc.regions.length - 1];
  if (!region?.root) return problem('unrepresentable', `Stacki could not parse ${doc.source.label}.`);
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
