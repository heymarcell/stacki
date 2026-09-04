// What a finding is, and what it is allowed to claim.
//
// The categories are not decoration. They are the honest limit of the sentence
// each finding is making, and keeping them apart is the difference between an
// audit somebody trusts and one they learn to ignore:
//
//   mechanical  Measured. "The document scrolls 125px sideways at 375px wide"
//               is a fact about geometry. It is not a rule anybody wrote down,
//               and it might be exactly what the site intends.
//   standard    A named rule from the accessibility engine, with the WCAG
//               success criterion it comes from. This one IS a rule, and it has
//               been broken.
//   advisory    A heuristic. Worth a look. NOT a violation of anything, and it
//               says so in its own `kind` rather than in a footnote.
//   incomplete  The engine could not decide. Not a pass, not a failure. These
//               are kept because dropping them is how "no violations" turns into
//               "accessible", which is the overclaim this whole file exists to
//               prevent.
//
// STABLE IDS. run -> fix -> run again has to be able to say "that one is gone"
// rather than "the array is shorter". So an id is a hash of the things that
// identify the PROBLEM -- rule, viewport, and where it is -- and deliberately
// not of the things that describe its current severity or measurement. A finding
// whose overflow shrinks from 125px to 40px is the same finding, still there. A
// finding whose element moved down the page is the same finding. Only fixing it
// makes it go away.

const crypto = require('node:crypto');

const KINDS = ['mechanical', 'standard', 'advisory', 'incomplete'];
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor', 'info'];

// axe speaks impact; Stacki speaks severity. One place, so the two cannot drift.
const IMPACT_TO_SEVERITY = {
  critical: 'critical',
  serious: 'serious',
  moderate: 'moderate',
  minor: 'minor',
};

/**
 * The identity of a problem.
 *
 * `where` should be the most stable locator available: a Stacki model path if
 * the page carried one, otherwise the CSS selector. Never the array index, and
 * never anything that changes when the problem gets smaller.
 */
function findingId({ ruleId, viewport, where }) {
  const h = crypto.createHash('sha256').update([ruleId, viewport, where].join(' ')).digest('base64url');
  return `f_${h.slice(0, 16)}`;
}

/**
 * WHERE, MEANING WHICH RENDERED NODE -- not which node in the source.
 *
 * A model path is a SOURCE position, and a `.map()` has exactly one of those
 * however many rows it draws: the serializer emits the identical `data-avb-p`
 * on every iteration, by construction. So "the most stable locator available"
 * used to resolve five different `<time>` elements to one string, and a native
 * dogfood measured the result -- `f_4Sjf8vrN_o4ea-Kn` five times over, 22
 * findings sharing 6 ids. An id that cannot tell five rows apart cannot say a
 * row was fixed: it survives until the LAST instance is fixed, and the loop this
 * whole file exists to support silently stops working on the one page shape
 * every real site has.
 *
 * THE DISAMBIGUATOR HAS TO BELONG TO WHATEVER `where` IS. The first attempt at
 * this appended `target.selectorMatch` -- the occurrence among the SELECTOR's
 * matches -- and that is the wrong ordinal for the branch that collapses. When
 * the page gives a mapped row a unique selector (`li:nth-child(3) > time`, or an
 * `id` from the loop key) the selector is "one of one", nothing is appended, and
 * the SHARED model path is used bare: five renders, five different selectors in
 * the payload, one id. The fix did not reach the case it was written for, and
 * the fixture that said otherwise hand-wrote a `match` the page cannot produce
 * for those selectors.
 *
 * So there are two ordinals and each one guards its own locator: `pathMatch`,
 * the occurrence among the elements carrying the identical `data-avb-p`, goes
 * with the model path; `match`, the occurrence among the selector's matches,
 * goes with the selector. Whichever string becomes `where` carries the ordinal
 * that actually disambiguates it -- and `targetOf` publishes exactly the one the
 * hash used, so a reader who trusts the payload and a reader who trusts the id
 * can never disagree.
 *
 * WHAT IT COSTS, said plainly: an id now moves when an element's ORDINAL among
 * its siblings changes -- deleting the second of five rows renumbers the three
 * below it. That is the trade the selector branch already made, and it is
 * strictly better than an id that cannot distinguish "one of five fixed" from
 * "none of five fixed".
 *
 * One spelling changed with the unification, deliberately: the overflow builder
 * used to append `[0]` to its selector fallback unconditionally while the
 * accessibility builder appended nothing. Every id where the disambiguator is
 * absent from the payload is otherwise byte-identical to the one minted before
 * this existed, which test/audit-identity.js pins to literal constants.
 */
function whereOf({ modelPath, exact, pathMatch, selector, match }) {
  if (modelPath && exact) {
    // pathMatch first, because it is the ordinal for the string being used. The
    // selector ordinal is kept as a fallback for a producer that computes no
    // pathMatch at all -- an ordinal that disambiguates by luck still beats a
    // model path used bare -- but never when pathMatch exists and says the path
    // is unique, since appending an ordinal to an already-unique locator only
    // buys churn when an unrelated sibling is deleted.
    if (pathMatch) return `${modelPath}${pathMatch.of > 1 ? `[${pathMatch.index}]` : ''}`;
    return `${modelPath}${match && match.of > 1 ? `[${match.index}]` : ''}`;
  }
  return `${selector || 'document'}${match && match.of > 1 ? `[${match.index}]` : ''}`;
}

/**
 * A source location, only when Stacki can actually prove one.
 *
 * THE RULE THIS ENFORCES: a StackiRef is never minted from a CSS selector. If
 * the audited element carried a `data-avb-p` model path, that path is real and
 * is returned. If the nearest one belonged to an ANCESTOR rather than to the
 * element itself, that is said out loud with `exact: false`, because "somewhere
 * inside this component" is a different claim from "this node". If there is no
 * marker at all -- a runtime-generated node, a third-party embed -- the answer
 * is null and the finding stands on its selector and its geometry instead.
 *
 * A finding with a selector, a rectangle and a screenshot and no source location
 * is more useful than one with a confident lie in it.
 */
function targetOf({ selector, refPath, tag, crossBoundary = false, match = null }) {
  // Present only when the locator it belongs to is ambiguous, so a reader knows
  // which of several identical boxes this is -- and so that whatever the id
  // hashed is visible on the finding. `modelPathMatch` is the one that matters
  // for a mapped component: the selector can be perfectly unique while the model
  // path is shared by every row.
  const pathMatch = refPath && refPath.exact ? refPath.match : null;
  const base = {
    selector: selector || null,
    tag: tag || null,
    ...(match && match.of > 1 ? { selectorMatch: { index: match.index, of: match.of } } : {}),
    ...(pathMatch && pathMatch.of > 1 ? { modelPathMatch: { index: pathMatch.index, of: pathMatch.of } } : {}),
  };
  if (crossBoundary) {
    return {
      ...base,
      modelPath: null,
      exact: false,
      note:
        'This element is inside a shadow root or a frame. Stacki cannot address it from the top document, so no ' +
        'source location is claimed for it.',
    };
  }
  if (!refPath || !refPath.path) {
    return {
      ...base,
      modelPath: null,
      exact: false,
      note: 'No Stacki marker on or above this element; it has no source location Stacki can prove.',
    };
  }
  return {
    ...base,
    modelPath: refPath.path,
    exact: !!refPath.exact,
    note: refPath.exact
      ? null
      : 'The nearest Stacki marker is on an ancestor, not on this element - the location is the containing node, not the node itself.',
  };
}

// WHY 320px OVERFLOW IS NOT AUTOMATICALLY A WCAG FAILURE.
//
// `standard` means, in this file's own words, "a named rule that HAS BEEN
// BROKEN". Horizontal overflow at the 320px reflow width was being promoted
// straight to that, purely because the requested width happened to be 320 --
// which asserts a conclusion the detector cannot reach.
//
// WCAG 2.2 SC 1.4.10 exempts content that requires a two-dimensional layout for
// usage or meaning: data tables, maps, diagrams, video, games, presentations,
// some complex interfaces. A geometry probe measures boxes. It does not know
// whether the thing sticking out is a pricing table that should have wrapped or
// a train timetable that legitimately cannot.
//
// So the measurement stays `mechanical`, the criterion is named as RELATED
// rather than as broken, and the exception is stated in the finding itself. If a
// vetted standards engine ever returns a real 1.4.10 violation, that is a
// different evidence source and may carry `kind: 'standard'` on its own account.
const REFLOW_CRITERION = 'WCAG 2.2 SC 1.4.10 Reflow';
const REFLOW_NOTE =
  'This is a measurement, not a verdict. Content that requires a two-dimensional layout for its usage or ' +
  'meaning — a data table, a map, a diagram, a video, a game — is exempt from SC 1.4.10, and this check cannot ' +
  'tell those apart from a layout that simply failed to reflow. Decide which this is before treating it as a ' +
  'failure.';

/** One mechanical overflow finding. */
function overflowFinding({ viewport, culprit, documentOverflowBy, measured = null }) {
  const target = targetOf({ selector: culprit.selector, refPath: culprit.ref, tag: culprit.tag, match: culprit.match });
  // Four levels of tag.class matches every card in a row, so two real defects on
  // two different cards used to hash to ONE id -- and fixing either made both
  // look fixed. The match index disambiguates without making `selector` invalid.
  // It used to be applied only on the fallback branch, which left the GOOD case
  // -- an element with a real model path -- colliding. See whereOf().
  const where = whereOf({
    modelPath: target.modelPath,
    exact: target.exact,
    pathMatch: culprit.ref && culprit.ref.exact ? culprit.ref.match : null,
    selector: culprit.selector,
    match: culprit.match,
  });
  // AT 320 THIS IS STILL A MEASUREMENT. See reflowNote() below.
  const isReflow = viewport.standard != null;
  return {
    id: findingId({ ruleId: 'horizontal-overflow', viewport: viewport.key, where }),
    ruleId: 'horizontal-overflow',
    category: 'responsive',
    kind: 'mechanical',
    severity: 'serious',
    // Named as RELATED, never as broken. `standard` stays null because nothing
    // here establishes a violation.
    standard: null,
    relatedStandard: isReflow ? REFLOW_CRITERION : null,
    viewport: { key: viewport.key, width: viewport.width, height: viewport.height, device: viewport.device },
    message:
      `The page scrolls ${documentOverflowBy}px sideways at ${viewport.width}px wide, and this element extends ` +
      `${culprit.overflowBy}px past the ${culprit.edge} edge. Nothing between it and the page root scrolls or ` +
      `clips, so the overflow reaches the document.` +
      (isReflow ? ` ${REFLOW_NOTE}` : ''),
    target,
    evidence: {
      // MEASURED, not requested. The window was ASKED for viewport.width; what
      // the document actually reported is clientWidth, and the two differ once a
      // scrollbar or a zoom level is involved. documentScrollWidth used to be
      // reconstructed as width + overflow, which is arithmetic on a number that
      // was already arithmetic. Both come straight off the page now, with the
      // requested width kept beside them so a mismatch is visible rather than
      // hidden.
      viewportWidth: measured?.viewportWidth ?? viewport.width,
      requestedViewportWidth: viewport.width,
      documentScrollWidth: measured?.documentScrollWidth ?? viewport.width + documentOverflowBy,
      documentOverflowBy,
      elementOverflowBy: culprit.overflowBy,
      edge: culprit.edge,
      rect: culprit.rect,
      computed: culprit.computed,
      text: culprit.text || null,
    },
    help:
      'Constrain the element to its container: a max-width, a min-width that is not fixed, or wrapping. If the ' +
      'sideways scroll is deliberate, put it in a box with overflow-x: auto and it will stop being reported.',
  };
}

/**
 * The document scrolls sideways and no element could honestly be blamed.
 *
 * Every rule that excludes a culprit -- it clips its own overflow, an ancestor
 * clips it, it is fixed, it is off the left -- is a reason not to point at that
 * element. They can all be true at once: overflow from a text node with no box,
 * from a margin, from something the walk cannot reach. Reporting nothing then
 * would be the worst answer available, because the page demonstrably scrolls and
 * the audit would be saying it is fine.
 *
 * So the measurement is the finding. It has no target, and it says so.
 */
function unattributedOverflowFinding({ viewport, documentOverflowBy }) {
  const isReflow = viewport.standard != null;
  return {
    id: findingId({ ruleId: 'horizontal-overflow', viewport: viewport.key, where: 'document' }),
    ruleId: 'horizontal-overflow',
    category: 'responsive',
    kind: 'mechanical',
    severity: 'serious',
    standard: null,
    relatedStandard: isReflow ? REFLOW_CRITERION : null,
    viewport: { key: viewport.key, width: viewport.width, height: viewport.height, device: viewport.device },
    message:
      `The page scrolls ${documentOverflowBy}px sideways at ${viewport.width}px wide, and no single element ` +
      'could be held responsible for it: everything that extends past the edge is inside something that ' +
      'contains it, is fixed to the viewport, or has no box of its own. The overflow is real; the cause needs ' +
      'a person.' + (isReflow ? ` ${REFLOW_NOTE}` : ''),
    target: {
      selector: null,
      tag: null,
      modelPath: null,
      exact: false,
      note: 'No element was attributable, so none is named. This is the document, not a node.',
    },
    evidence: {
      viewportWidth: viewport.width,
      documentOverflowBy,
      attributableElements: 0,
    },
    help:
      'Look for a text node or a margin that cannot be selected, or content the element walk cannot reach ' +
      '(a shadow root, a cross-origin frame). Narrowing the viewport in a browser and using its layout tools ' +
      'is the fastest way in.',
  };
}

/** One accessibility finding, from the engine's own result. */
function axeFinding({ viewport, rule, node, bucket }) {
  const refPath = node.refPath || null;
  // ' >>> ' between hops, not a space: a shadow or frame path joined by spaces
  // reads as a descendant selector and is not one.
  const selector = Array.isArray(node.target)
    ? node.target.join(node.target.length > 1 ? ' >>> ' : ' ')
    : String(node.target || '');
  // `match` comes from the page, where axeScript's locate() resolves the
  // selector and asks which of its matches this node is. Passing it does two
  // things at once: it puts `selectorMatch` on an accessibility finding for the
  // first time -- until now nothing in the payload could tell five identical
  // boxes apart even by hand -- and it makes the id the identity of a RENDERED
  // node rather than of a source position.
  const target = targetOf({ selector, refPath, tag: node.tag, crossBoundary: !!node.crossBoundary, match: node.match });
  const where = whereOf({
    modelPath: target.modelPath,
    exact: target.exact,
    pathMatch: refPath && refPath.exact ? refPath.match : null,
    selector,
    match: node.match,
  });
  const wcag = (rule.tags || []).filter((t) => /^wcag\d/.test(t));
  return {
    id: findingId({ ruleId: rule.id, viewport: viewport.key, where }),
    ruleId: rule.id,
    category: 'accessibility',
    // An engine result that could not be decided is `incomplete` and stays that
    // way. Promoting one to a violation to make a number look better is the
    // single most dishonest thing this file could do.
    kind: bucket === 'incomplete' ? 'incomplete' : 'standard',
    severity: bucket === 'incomplete' ? 'info' : IMPACT_TO_SEVERITY[rule.impact] || 'moderate',
    standard: wcag.length ? wcag.join(', ') : null,
    viewport: { key: viewport.key, width: viewport.width, height: viewport.height, device: viewport.device },
    message:
      bucket === 'incomplete'
        ? `${rule.help}. The engine could not decide this one; a person has to look.`
        : rule.help,
    target,
    evidence: {
      impact: rule.impact || null,
      failureSummary: node.failureSummary || null,
      html: node.html || null,
      rect: node.rect || null,
    },
    help: rule.helpUrl || null,
  };
}

/**
 * Sort so that two runs of the same page produce the same order.
 *
 * Severity first because that is the order somebody wants to read them in, then
 * the rule and the id, which are stable -- never insertion order, which is not.
 */
function sortFindings(list) {
  const rank = (f) => SEVERITIES.indexOf(f.severity);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
}

module.exports = {
  KINDS,
  REFLOW_CRITERION,
  REFLOW_NOTE,
  SEVERITIES,
  findingId,
  targetOf,
  whereOf,
  overflowFinding,
  unattributedOverflowFinding,
  axeFinding,
  sortFindings,
  IMPACT_TO_SEVERITY,
};
