// Set a state up, assert it IS that state, and only then photograph it.
//
// A screenshot is evidence only if something checked that the app was in the
// state the caption names. "Orphaned review" over a picture of an attached one
// is not weaker evidence than no picture; it is false evidence that reads as a
// pass to everybody downstream.
//
// The subtle half of that is WHEN the checking happens. The display matrix used
// to read its geometry, then call the capture helper — which waits for the
// layout to settle before it takes the picture. So the numbers in the caption
// and the numbers the assertions were about were from before that wait, and the
// pixels were from after it. Nothing was wrong with the pictures that came out,
// and nothing had to be: a late relayout in that window would have produced a
// caption that was true when it was written and false about the image it sat
// under. That is the exact defect this package exists to remove, so it does not
// get to survive as a race.
//
// Hence `read`. When a state supplies one, it is called ONCE — after the settle
// and immediately before the shutter — and the single object it returns is
// handed to both the claims and the caption. Claims, caption and PNG then refer
// to one moment, by construction rather than by timing.
//
// Everything here is injected so the discipline can be tested without a window:
// `settle` is the wait, `capture` takes the picture, and the two reporters
// decide what a pass and a failure look like to the harness.

/**
 * @param {object} io
 * @param {() => Promise<void>} io.settle      let the UI stop moving
 * @param {(name: string) => Promise<void>} io.capture   take the picture
 * @param {(shot: {name: string, caption: string}) => void} io.onCaptured
 * @param {(name: string, what: string, detail?: string) => void} io.onFailed
 */
function createState({ settle, capture, onCaptured, onFailed }) {
  /**
   * @param {string} name
   * @param {string | ((seen: any) => string)} caption  a function when it needs
   *   the capture-time state, so it can never quote numbers from before it
   * @param {(seen: any) => Promise<Array<[string, boolean, string?]>>} claims
   * @param {null | (() => Promise<any>)} read  the capture-time state, read once
   */
  return async function state(name, caption, claims = async () => [], read = null) {
    await settle();
    let seen = null;
    let held;
    try {
      // One read. Both the claims below and the caption underneath the picture
      // are about this object and nothing else.
      if (read) seen = await read();
      held = (await claims(seen)) || [];
    } catch (err) {
      held = [['the state could be read at all', false, String((err && err.stack) || err)]];
    }
    const broken = held.filter((c) => !c[1]);
    if (broken.length) {
      for (const [what, , detail] of broken) onFailed(name, what, detail);
      return false;
    }
    await capture(name);
    onCaptured({ name, caption: typeof caption === 'function' ? caption(seen) : caption });
    return true;
  };
}

module.exports = { createState };
