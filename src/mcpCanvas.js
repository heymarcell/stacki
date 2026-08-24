// Getting the canvas ready to be photographed.
//
// A screenshot has to be taken from the main process — capturePage is the only
// thing that can see what Chromium actually painted — but everything it needs
// to know first lives in the pane that draws the canvas: where the frame sits,
// what the selected occurrence measures, and whether the page has to scroll
// before the thing being asked about is on screen at all.
//
// PreviewPane registers itself here the same way it registers its frame with
// canvasQuery, and the MCP bridge asks through this. With no preview up there
// is no probe, and every question answers null — which the tool reports as a
// status rather than an error.

let probe = null;

/** PreviewPane, saying it can answer. Returns the un-register. */
export function registerCanvasProbe(next) {
  probe = next || null;
  return () => {
    if (probe === next) probe = null;
  };
}

export function hasCanvasProbe() {
  return !!probe;
}

/**
 * Put the canvas in front of the camera: the selected occurrence scrolled into
 * view, Stacki's own outlines taken off it, and the geometry measured after
 * the page has settled and painted.
 *
 * Answers `{ frame, scale, selection, page }` in CSS pixels — the app window's
 * for `frame` and `page`, the previewed page's viewport for `selection`.
 */
export async function beginCapture(options) {
  if (!probe) return null;
  try {
    return await probe.begin(options || {});
  } catch {
    return null;
  }
}

/** Put the outlines back. Always called, including when the capture failed. */
export async function endCapture() {
  if (!probe) return null;
  try {
    return await probe.end();
  } catch {
    return null;
  }
}
