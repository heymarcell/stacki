// The computed properties worth sending by default.
//
// A rendered element has around 340 computed properties. Nearly all of them
// answer questions nobody asked — `-webkit-text-emphasis-position`,
// `scroll-snap-stop`, every `animation-*` on an element that never animates —
// and sending them all turns "what does this look like" into three pages an
// agent has to read past. So `styleDetail: "essential"` sends the ones a
// visual change is ever actually about: box, layout, type, colour, border,
// effect. `"full"` is there for the times that isn't enough.
//
// The list is FLAT and always complete: every property here is reported, at
// its computed value, whether or not it differs from the initial value.
// Dropping defaults would halve the size and cost the reader the one thing
// this is for — being able to tell "0px because nothing sets it" from "this
// property was not reported".
//
// What is NOT here is anything that answers a question already answered
// elsewhere or a question nobody asked of a picture: `pointer-events` is the
// selection's own `inert` flag, `float` and `clear` are a layout model this
// list is not about, and `cursor`, `order`, `outline-*`, `mix-blend-mode` and
// the `grid-auto-*` pair are detail that belongs to styleDetail: "full".
// A representative selection serializes to about 3KB with this list.

const ESSENTIAL = [
  // Box
  'display',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'aspect-ratio',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',

  // Position
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',

  // Flex / grid
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-content',
  'align-self',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'grid-column',
  'grid-row',

  // Type
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'white-space',
  'text-wrap-mode',
  'color',

  // Paint
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'opacity',
  'box-shadow',
  'filter',

  // Border
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',

  // Behaviour a picture cannot show
  'overflow-x',
  'overflow-y',
  'visibility',
  'transform',
  'transition',
  'object-fit',
];

const ESSENTIAL_SET = new Set(ESSENTIAL);

/** The property names to ask the page for, given the requested detail. */
function propertiesFor(detail, allKnown) {
  if (detail === 'none') return [];
  if (detail === 'full') {
    // Everything the engine knows about, with the essentials guaranteed to be
    // in it even if the caller's list of known properties is short.
    const all = Array.isArray(allKnown) ? allKnown.filter((p) => typeof p === 'string') : [];
    return [...new Set([...all, ...ESSENTIAL])];
  }
  return [...ESSENTIAL];
}

/**
 * The essential subset of an answer, in the order above so two reads of the
 * same element serialize identically.
 *
 * Values the page could not answer for (null, empty) are left out — an absent
 * key means "the page said nothing", which is not the same as a value.
 */
function pickEssential(computed) {
  if (!computed || typeof computed !== 'object') return null;
  const out = {};
  for (const prop of ESSENTIAL) {
    const value = computed[prop];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) out[prop] = text;
  }
  return Object.keys(out).length ? out : null;
}

/** Every property the page answered for, sorted, for `styleDetail: "full"`. */
function allStyles(computed) {
  if (!computed || typeof computed !== 'object') return null;
  const out = {};
  for (const prop of Object.keys(computed).sort()) {
    const value = computed[prop];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) out[prop] = text;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { ESSENTIAL, ESSENTIAL_SET, propertiesFor, pickEssential, allStyles };
