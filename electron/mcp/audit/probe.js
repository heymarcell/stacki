// The measurement, as it runs inside the audited page.
//
// This file exports SOURCE STRINGS, not functions. Everything here is evaluated
// by `webContents.executeJavaScript` in a page Stacki did not write and does not
// trust, so it can reach nothing of Stacki's and returns only JSON.
//
// WHAT IT IS ALLOWED TO DO: read. Geometry, computed style, attributes, the
// marker comments. Nothing here clicks, focuses, submits, navigates or scrolls
// anything that stays scrolled — a page that behaves differently because it was
// audited has not been audited.
//
// WHY OVERFLOW IS HARD, AND WHY THIS IS THE SHAPE IT IS
//
// "Something is wider than the viewport" is not a defect. A carousel is wider
// than the viewport on purpose, and so is a code block, a wide table and a
// horizontally scrolled gallery. Every one of them is inside a box that says
// `overflow-x: auto | scroll | hidden`, and that box is the difference between
// "you can reach this" and "this is off the side of the page and gone".
//
// So the test is not "is this element wide". It is: does the DOCUMENT scroll
// sideways, and if so, which elements stick out with NOTHING between them and
// the root that would have contained them. An element whose own overflow-x
// clips, or any of whose ancestors clips before the root is reached, is
// contained by design and is not reported.
//
// The 2px tolerance is not fudge. scrollWidth and clientWidth are integers, and
// sub-pixel layout routinely leaves a 1px difference on a page that is perfectly
// fine. Reporting that as a defect trains people to ignore the audit.

// Kept small on purpose. A finding is a pointer to a problem, not a copy of the
// page: an audit that returns innerText is a context bomb, and quoting a hostile
// page at length is how page content gets read as instructions.
const MAX_TEXT = 80;
const MAX_ELEMENTS = 40;

const HELPERS = `
  const MAX_TEXT = ${MAX_TEXT};
  const clip = (s) => {
    const t = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
             top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left) };
  };
  // Stacki's own model path, when the page carries one. The canvas strips the
  // <template> markers outside design mode because :nth-child counts them; the
  // data-avb-p attribute and the comment markers survive, and they are the only
  // honest bridge from a rendered box back to a thing in a file.
  const refPathOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const p = n.getAttribute && n.getAttribute('data-avb-p');
      if (p) return { path: p, exact: n === el };
      n = n.parentElement;
    }
    return null;
  };
  // A selector good enough to find the element again, and short enough to read.
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 4; depth++) {
      let part = n.tagName.toLowerCase();
      const cls = (n.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      parts.unshift(part);
      if (n.id) { parts[0] = '#' + CSS.escape(n.id); break; }
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
`;

// Make the page hold still. Animations and transitions mean two measurements of
// the same page disagree, and a screenshot then shows neither. Only ever applied
// to the audit window, never to what the person is looking at.
const FREEZE = `(() => {
  const s = document.createElement('style');
  s.setAttribute('data-stacki-audit', 'freeze');
  s.textContent = '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;' +
                  'transition-duration:0s !important;transition-delay:0s !important;' +
                  'scroll-behavior:auto !important;caret-color:transparent !important}';
  document.head.appendChild(s);
  return true;
})()`;

// Fonts, then two frames, then a quiet moment. A box measured before the webfont
// lands is a box that will move.
const SETTLE = `(async () => {
  try { await document.fonts.ready; } catch {}
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(1))));
  return { title: document.title || '', readyState: document.readyState };
})()`;

const OVERFLOW = `(() => {
  ${HELPERS}
  const de = document.documentElement;
  const clientW = de.clientWidth;
  const docOverflow = de.scrollWidth - clientW;
  // Not a defect until it is more than rounding. See the note at the top.
  const overflows = docOverflow >= 2;

  const culprits = [];
  if (overflows) {
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      // THE RIGHT EDGE ONLY, AND THAT IS NOT A SHORTCUT.
      //
      // The document-level test above is scrollWidth - clientWidth, which in a
      // left-to-right document measures content past the RIGHT edge. Content
      // placed off the LEFT does not contribute to it, so it cannot be the cause
      // of the scroll and must not be blamed for it.
      //
      // This matters more than it sounds. "position:absolute; left:-9999px" is
      // how a skip link and visually-hidden text have been written for twenty
      // years. An earlier version of this reported both -- and sorted them
      // FIRST, at 10000px and 9999px, ahead of the real 145px culprit. The two
      // most prominent findings on a correctly built page were its accessibility
      // features.
      //
      // The honest limit: in a right-to-left document the page scrolls the other
      // way, and this looks in the wrong direction. Said in docs/audit.md rather
      // than papered over with a heuristic.
      const overRight = r.right - clientW;
      if (overRight < 2) continue;

      // A FIXED ELEMENT CANNOT CAUSE DOCUMENT SCROLL.
      //
      // position:fixed takes an element out of the flow entirely and pins it to
      // the viewport; its box contributes nothing to scrollWidth. A wide fixed
      // header therefore gets blamed for an overflow it provably did not cause,
      // and -- being wide -- sorts above the element that did. Same class of
      // mistake as blaming a skip link at left:-9999px.
      if (cs.position === 'fixed') continue;

      // An element that clips or scrolls its OWN overflow contains it.
      const ownX = cs.overflowX;
      if (ownX === 'auto' || ownX === 'scroll' || ownX === 'hidden' || ownX === 'clip') continue;

      // And so does any ancestor between it and the root. If one of those
      // contains it, this is a scroll container's content, not a page defect.
      let contained = false;
      let containedBy = null;
      let p = el.parentElement;
      while (p && p !== de) {
        const px = getComputedStyle(p).overflowX;
        if (px === 'auto' || px === 'scroll' || px === 'hidden' || px === 'clip') {
          contained = true;
          containedBy = selectorOf(p) + ' {overflow-x:' + px + '}';
          break;
        }
        p = p.parentElement;
      }
      if (contained) continue;

      culprits.push({
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        rect: rectOf(el),
        overflowBy: Math.round(overRight),
        edge: 'right',
        computed: {
          'overflow-x': ownX,
          width: cs.width,
          'min-width': cs.minWidth,
          position: cs.position,
        },
        ref: refPathOf(el),
        text: clip(el.textContent),
      });
      if (culprits.length >= ${MAX_ELEMENTS}) break;
    }
    // Widest offender first, then by position, so two runs of the same page
    // produce the same order and therefore the same finding ids.
    culprits.sort((a, b) => b.overflowBy - a.overflowBy || a.rect.top - b.rect.top || a.selector.localeCompare(b.selector));
  }

  return {
    // The MEASURED viewport, not the width that was asked for. A window told to
    // be 375 wide can report a different clientWidth once a scrollbar or a zoom
    // level is involved, and a finding that quotes the request rather than the
    // measurement is describing an intention.
    viewportWidth: clientW,
    documentScrollWidth: de.scrollWidth,
    overflowBy: docOverflow,
    overflows,
    culprits,
    truncated: culprits.length >= ${MAX_ELEMENTS},
  };
})()`;

module.exports = { FREEZE, SETTLE, OVERFLOW, MAX_TEXT, MAX_ELEMENTS };
