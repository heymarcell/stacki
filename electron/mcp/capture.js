// Taking the picture.
//
// Split out from the Electron wiring so the part that is easy to get wrong can
// be checked without a window: what the crop is, and — the one that leaves a
// mess behind when it goes wrong — that the app's background-throttling setting
// is put back exactly as it was found, on every path out, including the ones
// that threw.
//
// It touches no Electron API of its own. Everything it needs arrives as the
// window it was handed, so a test can hand it a fake one.

const { captureRect, fitWidth } = require('./captureRect');

// A tool response is text on a wire. 1400px on the longest side keeps a
// screenshot readable — a headline, a label, a border radius — without turning
// one call into megabytes of base64.
const MAX_EDGE = 1400;
const MAX_BYTES = 3_500_000;
const JPEG_QUALITY = 82;

/** Encode, shrinking until the response is a sane size. */
function encodeImage(image, format) {
  let current = image;
  const size = current.getSize();
  const wanted = fitWidth(size.width, size.height, MAX_EDGE);
  if (wanted < size.width) current = current.resize({ width: wanted, quality: 'better' });

  const encode = (img) => (format === 'jpeg' ? img.toJPEG(JPEG_QUALITY) : img.toPNG());
  let buffer = encode(current);
  // A screenshot of a dense page can still be large after the edge cap. Halve
  // it rather than posting several megabytes of base64 into a conversation.
  let guard = 0;
  while (buffer.length > MAX_BYTES && guard++ < 3) {
    const now = current.getSize();
    const next = Math.max(200, Math.round(now.width * 0.6));
    if (next >= now.width) break;
    current = current.resize({ width: next, quality: 'better' });
    buffer = encode(current);
  }
  return { buffer, size: current.getSize(), shrunk: guard > 0 };
}

/**
 * Build the `capture` tool's implementation.
 *
 * `getWindow()` is the app window, `ask(kind, params, timeout)` asks the
 * renderer a question, `readSnapshot()` is the published context.
 */
function createCapture({ getWindow, ask, readSnapshot, captureTimeoutMs = 8000 }) {
  return async function capture({ target, paddingPx, format }) {
    const snapshot = readSnapshot();
    const win = getWindow();
    const meta = {
      revision: snapshot.revision,
      status: snapshot.selection.status,
      target,
      requestedTarget: target,
      format,
      source: snapshot.selection.source,
      view: snapshot.view,
      occurrence: snapshot.selection.occurrence,
      occurrenceCount: snapshot.selection.occurrenceCount,
      rect: null,
      pixelSize: null,
      bytes: 0,
      note: null,
    };
    if (!win || win.isDestroyed()) {
      return { image: null, mimeType: null, meta: { ...meta, note: 'The Stacki window is not open.' } };
    }
    if (snapshot.selection.status === 'no_project') {
      return { image: null, mimeType: null, meta: { ...meta, note: 'No project is open in Stacki.' } };
    }

    // A window nobody is looking at may not be painting.
    //
    // Chromium throttles a page whose visibility is `hidden` — no rAF, no
    // compositor frames — and capturePage then hands back the last frame it
    // drew. Which is the wrong picture twice over: the page as it was before
    // whatever the agent is asking about, with the editor's outlines still on
    // top of it. Measured on a minimised window, a capture is fresh 5 times in
    // 10 while throttled, and waiting longer makes it worse rather than better
    // (3 in 10 at +500ms) — time is not what is missing, frames are.
    //
    // So throttling is lifted for the length of one capture and put back
    // exactly as it was found. Not at window creation: that would leave every
    // animation in the app and in the previewed site running whenever Stacki
    // is in the background, forever, to serve a screenshot nobody has asked
    // for yet. On macOS it is usually not even engaged — Electron ships with
    // occlusion detection off, so a window merely covered by another app keeps
    // painting — and this costs nothing there. Where it IS engaged (minimised,
    // and other platforms), lifting it takes rAF from 0/s to full rate within
    // 1–4ms, and the two painted frames the renderer waits for below then make
    // the capture fresh 10 times in 10.
    //
    // It has to be lifted BEFORE the renderer is asked to paint: the frames it
    // waits for are the ones this makes possible.
    const wc = win.webContents;
    const throttlingWas = wc.getBackgroundThrottling?.() ?? false;
    if (throttlingWas) wc.setBackgroundThrottling(false);
    try {
      // The canvas gets the page in front of the camera: the selected
      // occurrence scrolled into view, and Stacki's own outlines taken off it,
      // so what comes back is the site rather than the editor.
      const geometry = await ask('capture:begin', { target }, captureTimeoutMs);
      if (!geometry || !geometry.frame) {
        return {
          image: null,
          mimeType: null,
          meta: { ...meta, note: 'The Stacki preview is not showing a page yet.' },
        };
      }
      // The window's zoom factor turns the renderer's CSS pixels into the
      // device-independent ones capturePage measures in. It is 1 in practice,
      // and the one time it isn't is the one time a crop lands on the wrong
      // half of the app.
      const zoom = wc.getZoomFactor?.() || 1;
      const plan = captureRect({ ...geometry, zoom }, { target, paddingPx });
      if (!plan.rect || plan.rect.width < 1 || plan.rect.height < 1) {
        return {
          image: null,
          mimeType: null,
          meta: { ...meta, note: 'The preview frame is too small to photograph.' },
        };
      }
      const shot = await wc.capturePage(plan.rect);
      if (!shot || shot.isEmpty()) {
        return {
          image: null,
          mimeType: null,
          meta: { ...meta, note: 'The capture came back empty — the Stacki window may be minimised.' },
        };
      }
      const { buffer, size, shrunk } = encodeImage(shot, format);
      const notes = [];
      if (plan.fellBack) notes.push('The selection is not on screen; the whole preview frame was captured.');
      if (shrunk) notes.push('The image was scaled down to keep the response small.');
      // A minimised window is the one case lifting throttling cannot rescue.
      // The previewed site renders in a frame of its own, and Chromium has no
      // per-frame lever — the host wakes up, the site does not, and what gets
      // composited is the last frame it managed to draw. Measured at 2–6 times
      // in 10 rather than 10 in 10. Saying so is the difference between an
      // agent knowing the picture might be old and one believing it isn't.
      if (win.isMinimized?.()) {
        notes.push('Stacki is minimised, so the page in this image may be older than the current render.');
      }
      return {
        image: buffer.toString('base64'),
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        meta: {
          ...meta,
          target: plan.target,
          rect: plan.windowRect,
          pixelSize: { width: size.width, height: size.height },
          bytes: buffer.length,
          note: notes.length ? notes.join(' ') : null,
        },
      };
    } finally {
      try {
        // Always: the outlines going missing because a capture failed would be
        // a far more visible bug than the failure itself. Done while the window
        // is still painting, so they come back now rather than whenever the
        // page next happens to draw.
        await ask('capture:end', {});
      } finally {
        // And always this, on every path out — an app left un-throttled by a
        // capture that threw would go on burning battery in the background with
        // nothing to show for it.
        try {
          if (throttlingWas && !wc.isDestroyed()) wc.setBackgroundThrottling(true);
        } catch {
          /* the window went away mid-capture; there is nothing left to restore */
        }
      }
    }
  };
}

module.exports = { createCapture, encodeImage, MAX_EDGE, MAX_BYTES, JPEG_QUALITY };
