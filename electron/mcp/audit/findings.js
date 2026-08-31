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
  const base = {
    selector: selector || null,
    tag: tag || null,
    // Present only when the selector is ambiguous, so a reader knows which of
    // several identical boxes this is.
    ...(match && match.of > 1 ? { selectorMatch: { index: match.index, of: match.of } } : {}),
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

/** One mechanical overflow finding. */
function overflowFinding({ viewport, culprit, documentOverflowBy, measured = null }) {
  const target = targetOf({ selector: culprit.selector, refPath: culprit.ref, tag: culprit.tag, match: culprit.match });
  // Four levels of tag.class matches every card in a row, so two real defects on
  // two different cards used to hash to ONE id -- and fixing either made both
  // look fixed. The match index disambiguates without making `selector` invalid.
  const where =
    target.modelPath && target.exact
      ? target.modelPath
      : `${culprit.selector}[${culprit.match?.index ?? 0}]`;
  // At 320 this is a named success criterion; anywhere else it is a measurement.
  const isReflow = viewport.standard != null;
  return {
    id: findingId({ ruleId: 'horizontal-overflow', viewport: viewport.key, where }),
    ruleId: 'horizontal-overflow',
    category: 'responsive',
    kind: isReflow ? 'standard' : 'mechanical',
    severity: 'serious',
    standard: isReflow ? viewport.standard : null,
    viewport: { key: viewport.key, width: viewport.width, height: viewport.height, device: viewport.device },
    message:
      `The page scrolls ${documentOverflowBy}px sideways at ${viewport.width}px wide, and this element extends ` +
      `${culprit.overflowBy}px past the ${culprit.edge} edge. Nothing between it and the page root scrolls or ` +
      `clips, so the overflow reaches the document.`,
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
    kind: isReflow ? 'standard' : 'mechanical',
    severity: 'serious',
    standard: isReflow ? viewport.standard : null,
    viewport: { key: viewport.key, width: viewport.width, height: viewport.height, device: viewport.device },
    message:
      `The page scrolls ${documentOverflowBy}px sideways at ${viewport.width}px wide, and no single element ` +
      'could be held responsible for it: everything that extends past the edge is inside something that ' +
      'contains it, is fixed to the viewport, or has no box of its own. The overflow is real; the cause needs ' +
      'a person.',
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
  const target = targetOf({ selector, refPath, tag: node.tag, crossBoundary: !!node.crossBoundary });
  const where = target.modelPath && target.exact ? target.modelPath : selector;
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
  SEVERITIES,
  findingId,
  targetOf,
  overflowFinding,
  unattributedOverflowFinding,
  axeFinding,
  sortFindings,
  IMPACT_TO_SEVERITY,
};
