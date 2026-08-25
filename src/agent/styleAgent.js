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
export const declarationIdentity = (rule, prop) => ({
  source: rule.embedKey,
  sourceLabel: rule.embedLabel,
  atContext: rule.atContext || [],
  selector: rule.selectorText,
  property: prop,
});

/** Everything the page's CSS is, parsed once. */
async function readCascade(node) {
  const scan = await scanPage();
  const { docs, errors } = await loadEmbedDocs(scan.pageEmbeds);
  const rules = rebuildRules(docs);
  const asked = await askCanvasAbout(node.id, rules);
  const { target, rootSnapshot } = await resolveTarget(node, scan, asked);
  await primeDomMatches(target, rules, asked);
  const model = await computeRuleModel(rules, target);
  return { docs, rules, model, rootSnapshot, errors };
}

/** What the engine says the element's properties actually resolve to. */
async function computedFor(node, properties, pathOf) {
  const path = pathOf?.(node.id);
  if (!path || !hasCanvas() || !properties.length) return null;
  const reply = await queryCanvas(path, [], [], properties);
  return reply?.computedProps || null;
}

/**
 * Every declaration reaching this element, in cascade order.
 *
 * Each one says where it was authored, whether it wins, what overrides it when
 * it does not, which custom properties it reads, and — for the ones that
 * matter — what the browser resolved it to. That is the whole answer to "why
 * does this look like that", and it is why nothing needs to grep for a class.
 */
export async function readStyles(node, { pathOf, properties = null } = {}) {
  const { docs, model, rootSnapshot, errors } = await readCascade(node);
  const matched = [...model.base, ...model.conditional].slice(0, MAX_RULES);

  const wanted = new Set(properties || []);
  const rules = matched.map((entry) => {
    const rule = entry.rule;
    const declarations = rule.declarations.slice(0, MAX_DECLS_PER_RULE).map((decl) => {
      const status = entry.declStatus?.[decl.declId] || {};
      return {
        property: decl.prop,
        value: clip(decl.value),
        important: !!decl.important,
        winning: status.winning !== false,
        overriddenBy: status.overriddenBy || null,
        variables: variablesIn(decl.value),
        identity: declarationIdentity(rule, decl.prop),
      };
    });
    for (const decl of declarations) wanted.add(decl.property);
    return {
      selector: rule.selectorText,
      matchedSelectors: entry.matchedSelectors.map((s) => s.text),
      label: entry.label,
      kind: entry.kind,
      conditional: !!entry.conditional,
      atContext: rule.atContext || [],
      nested: rule.nestedDisplay || null,
      source: {
        key: rule.embedKey,
        label: rule.embedLabel,
        fromComponent: !!rule.fromComponent,
        componentName: rule.componentName || null,
        // A stylesheet is a file an agent may also read as source; a <style>
        // block is a node in the document being edited.
        kind: rule.embedKey.startsWith('file:') ? 'stylesheet' : rule.embedKey.startsWith('astro:') ? 'component' : 'block',
        file: rule.embedKey.startsWith('file:') || rule.embedKey.startsWith('astro:') ? rule.embedKey.slice(rule.embedKey.indexOf(':') + 1) : null,
      },
      declarations,
      declarationsOmitted: Math.max(0, rule.declarations.length - MAX_DECLS_PER_RULE),
    };
  });

  const computed = await computedFor(node, [...wanted].slice(0, 200), pathOf);
  return {
    element: {
      tag: rootSnapshot?.tag || null,
      id: rootSnapshot?.id || null,
      classes: rootSnapshot?.classes || [],
    },
    rules,
    rulesOmitted: Math.max(0, [...model.base, ...model.conditional].length - MAX_RULES),
    matchedRuleCount: model.matchedRuleCount,
    computed,
    // Where a new declaration would go if the caller names no source. The last
    // project stylesheet, which is where the panel puts one too.
    writableSources: docs
      .map((doc) => ({
        key: doc.source.key,
        label: doc.source.label,
        kind: doc.source.origin.kind,
      }))
      .slice(0, MAX_RULES),
    problems: (errors || []).map((e) => `${e.label}: ${e.error}`),
  };
}

/** The doc a rule was parsed out of. */
const docFor = (docs, key) => docs.find((d) => d.source.key === key) || null;

/** The parsed rule matching a semantic identity, or null. */
function findRule(rules, identity) {
  const wantContext = (identity.atContext || []).join(' › ');
  return (
    rules.find(
      (rule) =>
        rule.embedKey === identity.source &&
        rule.selectorText.trim() === String(identity.selector || '').trim() &&
        (rule.atContext || []).join(' › ') === wantContext
    ) || null
  );
}

const problem = (code, message) => ({ ok: false, code, message });

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
    const rule = findRule(rules, identity);
    if (!rule) {
      return problem(
        'stale_target',
        `That rule is no longer in ${identity.sourceLabel || identity.source} — the stylesheet changed since you read it. Read the styles again.`
      );
    }
    const doc = docFor(docs, rule.embedKey);
    if (!doc) return problem('no_source', 'That stylesheet is no longer loaded.');
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
      source: { key: doc.source.key, label: doc.source.label, kind: doc.source.origin.kind },
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
  const doc = source ? docFor(docs, source) : null;
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
    wrote: { source: doc.source.key, sourceLabel: doc.source.label, atContext: [], selector: target, property: prop, value: next, important },
    source: { key: doc.source.key, label: doc.source.label, kind: doc.source.origin.kind },
    created: true,
  };
}

/** Take one authored declaration out. An emptied rule goes with it. */
export async function removeProperty(node, { identity, live = false }) {
  if (!identity?.selector || !identity?.source || !identity?.property) {
    return problem('bad_request', 'Name the declaration to remove, as style.read reported it.');
  }
  const { docs, rules } = await readCascade(node);
  const rule = findRule(rules, identity);
  if (!rule) {
    return problem('stale_target', 'That rule is not in that stylesheet any more. Read the styles again.');
  }
  const decl = rule.declarations.find((d) => d.prop.toLowerCase() === String(identity.property).toLowerCase());
  if (!decl) return { ok: true, removed: false, note: `${identity.property} was not on ${identity.selector}.` };
  const doc = docFor(docs, rule.embedKey);
  if (!doc) return problem('no_source', 'That stylesheet is no longer loaded.');
  removeDeclaration(decl);
  const emptied = removeRuleIfEmpty(rule);
  const written = await writeEmbedDoc(doc, live);
  if (!written.ok) return problem('write_failed', written.error);
  return {
    ok: true,
    removed: true,
    ruleRemoved: emptied,
    source: { key: doc.source.key, label: doc.source.label, kind: doc.source.origin.kind },
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
  const scan = await scanPage();
  return {
    sources: scan.pageEmbeds.map((s) => ({
      key: s.key,
      label: s.label,
      kind: s.origin.kind,
      fromComponent: !!s.fromComponent,
      componentName: s.componentName || null,
    })),
    openFile: getHost().openFilePath || null,
  };
}

export default readStyles;
