// Which pixels of the window are the answer to "what does it look like".
//
// The selected element's box is measured inside the preview iframe, where the
// origin is the top-left of the PAGE'S viewport. capturePage wants a rect in
// the window's own coordinates. Between the two sit: where the frame is on
// screen (the canvas is centred, with a toolbar above it), whatever scale the
// frame is drawn at, the window's zoom factor, and the fact that the page can
// be scrolled so that part of the element is not on screen at all.
//
// Getting any of those wrong photographs the wrong thing quietly — a crop
// that lands on the panel beside the canvas still returns a perfectly valid
// screenshot. So the arithmetic lives here on its own, where it can be checked
// against numbers instead of against a picture.
//
// Everything is CSS pixels of the app window until the last step, which
// multiplies by the zoom factor to get the device-independent pixels
// capturePage measures in.

/** Rects intersect; empty when they don't overlap. */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

const round = (r) => {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return {
    x,
    y,
    width: Math.max(0, Math.ceil(r.x + r.width) - x),
    height: Math.max(0, Math.ceil(r.y + r.height) - y),
  };
};

// Below this a crop is not a picture of anything — a zero-height inline
// element, a node scrolled to a one-pixel sliver at the edge of the frame.
const MIN_EDGE = 8;

/**
 * The window rect to capture.
 *
 * `geometry` is what the renderer measured:
 *   frame      the preview iframe's box in window CSS px
 *   scale      what the frame is drawn at (1 unless something transforms it)
 *   selection  the selected occurrence's box in the page's viewport CSS px
 *   page       the window's own inner size, as the outer clamp
 *   zoom       webContents zoom factor
 *
 * Answers `{ rect, target, fellBack }` — `fellBack` is true when a selection
 * capture could not be made and the frame was captured instead, which is the
 * honest thing to return for an element scrolled out of the canvas.
 */
function captureRect(geometry, { target = 'selection', paddingPx = 48 } = {}) {
  const g = geometry || {};
  const page = {
    x: 0,
    y: 0,
    width: Math.max(0, Number(g.page?.width) || 0),
    height: Math.max(0, Number(g.page?.height) || 0),
  };
  const frameBox = {
    x: Number(g.frame?.x) || 0,
    y: Number(g.frame?.y) || 0,
    width: Math.max(0, Number(g.frame?.width) || 0),
    height: Math.max(0, Number(g.frame?.height) || 0),
  };
  // The frame can hang off the edge of a small window; only the part on screen
  // has ever been drawn, so only that part can be photographed.
  const frame = page.width && page.height ? intersect(frameBox, page) : frameBox;
  const zoom = Number(g.zoom) > 0 ? Number(g.zoom) : 1;
  const scale = Number(g.scale) > 0 ? Number(g.scale) : 1;

  const finish = (rect, used, fellBack) => {
    const clipped = round(rect);
    return {
      rect: {
        x: Math.round(clipped.x * zoom),
        y: Math.round(clipped.y * zoom),
        width: Math.round(clipped.width * zoom),
        height: Math.round(clipped.height * zoom),
      },
      windowRect: clipped,
      target: used,
      fellBack: !!fellBack,
    };
  };

  if (frame.width < MIN_EDGE || frame.height < MIN_EDGE) {
    return { rect: null, windowRect: null, target, fellBack: false };
  }
  if (target === 'viewport' || !g.selection) {
    return finish(frame, 'viewport', target === 'selection');
  }

  const s = g.selection;
  const pad = Math.max(0, Number(paddingPx) || 0);
  const wanted = {
    x: frame.x + (Number(s.x) || 0) * scale - pad,
    y: frame.y + (Number(s.y) || 0) * scale - pad,
    width: Math.max(0, Number(s.w ?? s.width) || 0) * scale + pad * 2,
    height: Math.max(0, Number(s.h ?? s.height) || 0) * scale + pad * 2,
  };
  const visible = intersect(wanted, frame);
  // Scrolled off, or a node with no box at all: the frame is still a true
  // answer to "what is Stacki showing", and it is better than nothing.
  if (visible.width < MIN_EDGE || visible.height < MIN_EDGE) {
    return finish(frame, 'viewport', true);
  }
  return finish(visible, 'selection', false);
}

/**
 * How wide to hand the image over.
 *
 * The capture comes back at device resolution — on a retina display a 900px
 * crop is an 1800px image, and a full-window shot is several megabytes of
 * base64 in a tool response. Shrink to fit `maxEdge` on the longer side, and
 * never upscale.
 */
function fitWidth(width, height, maxEdge) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const max = Math.max(1, Math.round(Number(maxEdge) || 0));
  const longest = Math.max(w, h);
  if (longest <= max) return w;
  return Math.max(1, Math.round((w * max) / longest));
}

module.exports = { captureRect, fitWidth, intersect, MIN_EDGE };
