// Where the Review Inspector goes, given the window it has to fit in.
//
// The old rule was the length of the conversation: a short comment opened on
// the canvas, a long one opened in the panel. That is unlearnable — the same
// click did two different things and the reason was invisible — so it is gone.
// Presentation now comes from one thing only: how much room there is.
//
// The order of what gets protected, when there is not enough:
//
//   1. the Inspector stays readable. A review nobody can read is not a review.
//   2. the canvas stays useful. The site is what the review is ABOUT.
//   3. the Style/Settings panel stays, if it fits. It is what somebody uses to
//      FIX the feedback, and taking it away turns reading and fixing into two
//      separate trips.
//   4. below that, Style/Settings collapses first — it can be brought back,
//      and a 200px canvas cannot be worked in.
//   5. below THAT, the Inspector stops taking space from the canvas and
//      becomes an overlay over it instead.
//
// The numbers are the ones the design prototype was validated at across ten
// MacBook Pro logical resolutions plus a 1920 external display; this function
// reproduces all eleven of its recorded geometries exactly.

/** The rail down the left. Fixed by .rail in styles.css. */
export const RAIL_W = 44;
/** The Style/Settings panel. Fixed by .panel.right in styles.css. */
export const PROPS_W = 322;
/** Below this the canvas stops being somewhere you can work. */
export const MIN_CANVAS = 650;

/** What the Inspector may be resized to. */
export const INSPECTOR_MIN = 360;
export const INSPECTOR_DEFAULT = 440;
export const INSPECTOR_MAX = 560;

/** A width somebody asked for, brought inside what is allowed. */
export const clampInspector = (w) =>
  Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, Math.round(Number(w) || INSPECTOR_DEFAULT)));

/**
 * Decide the presentation.
 *
 * @param {object} input
 * @param {number} input.viewportWidth  window.innerWidth
 * @param {number} input.preferredWidth the width the person has chosen
 * @param {boolean} input.open          whether the Inspector is showing at all
 * @returns {{mode: 'closed'|'docked'|'overlay', width: number, propsVisible: boolean, canvas: number}}
 *   `mode` is where it is drawn, `width` is what it actually gets (which may
 *   be less than asked for), `propsVisible` is whether Style/Settings survived,
 *   and `canvas` is what the site is left with — reported so a caller can say
 *   so rather than having to work it out again.
 */
export function reviewLayout({ viewportWidth, preferredWidth = INSPECTOR_DEFAULT, open = false } = {}) {
  const vw = Number(viewportWidth) || 0;
  const preferred = clampInspector(preferredWidth);
  if (!open) {
    return { mode: 'closed', width: preferred, propsVisible: true, canvas: Math.max(0, vw - RAIL_W - PROPS_W) };
  }

  // Everything fits: the Inspector at the width somebody chose, a canvas worth
  // having, and the panel they need to act on what they just read.
  const withProps = vw - RAIL_W - preferred - PROPS_W;
  if (vw > 900 && withProps >= MIN_CANVAS) {
    return { mode: 'docked', width: preferred, propsVisible: true, canvas: withProps };
  }

  // Style/Settings goes first. It is one click to bring back; a crushed canvas
  // is not recoverable by anything the person can do.
  const maxDock = vw - RAIL_W - MIN_CANVAS;
  if (maxDock >= INSPECTOR_MIN) {
    const width = Math.min(preferred, maxDock);
    return { mode: 'docked', width, propsVisible: false, canvas: vw - RAIL_W - width };
  }

  // Not even a minimum Inspector and a usable canvas side by side. Rather than
  // give both something neither can be used at, the Inspector stops taking
  // space and floats over the canvas — non-modal, no scrim, the site still
  // there behind it and still scrollable.
  return {
    mode: 'overlay',
    width: Math.min(preferred, Math.max(320, vw - RAIL_W - 20)),
    propsVisible: false,
    canvas: Math.max(0, vw - RAIL_W),
  };
}

export default reviewLayout;
