// The widths an audit renders at, and where they come from.
//
// NOT INVENTED HERE. Stacki already tells the person their site is a desktop at
// 1440, a tablet at 768 and a phone at 375 — those are the frames the canvas
// draws and the buttons above the preview switch between. An audit that measured
// at some other fashionable set of widths would be reporting on a site nobody in
// this application has ever looked at. So the table is the product's own, and
// test/mcp-audit.js fails if it and src/panels/CanvasView.jsx ever disagree.
//
// The one addition is `reflow`, at 320. That width is not a device; it is the
// number in WCAG 2.2 success criterion 1.4.10, which asks that content reflow to
// 320 CSS pixels without a second scroll direction. It is off by default because
// three viewports is a useful audit and four is a slower one, and because a
// project that never claims 1.4.10 should not be told it fails it. Ask for it and
// the finding it produces is a STANDARD; overflow at any other width is
// MECHANICAL — true, measured, and not a rule anybody wrote down.

const VIEWPORTS = {
  // key        width  height  device        standard
  reflow:  { key: 'reflow',  width: 320,  height: 640,  device: null,      standard: 'WCAG 2.2 SC 1.4.10 Reflow' },
  phone:   { key: 'phone',   width: 375,  height: 812,  device: 'phone',   standard: null },
  tablet:  { key: 'tablet',  width: 768,  height: 1024, device: 'tablet',  standard: null },
  desktop: { key: 'desktop', width: 1440, height: 900,  device: 'desktop', standard: null },
};

/** What an audit measures when nobody said otherwise. */
const DEFAULT_MATRIX = ['phone', 'tablet', 'desktop'];

const NAMES = Object.keys(VIEWPORTS);

// A caller may ask for its own widths. These are the walls: an audit of 27
// viewports is a denial of service dressed as thoroughness, and a 2px-wide
// browser is a crash looking for somewhere to happen.
const MAX_VIEWPORTS = 6;
const MIN_WIDTH = 240;
const MAX_WIDTH = 3840;
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 4320;

/**
 * Turn what a caller asked for into viewports to render at.
 *
 * Accepts names from the table, or explicit `{width, height, key?}` objects.
 * Returns `{ok:true, viewports}` or `{ok:false, code, message}` — a bad request
 * is answered, never clamped silently into a different question.
 */
function resolveViewports(requested) {
  if (requested === undefined || requested === null) {
    return { ok: true, viewports: DEFAULT_MATRIX.map((k) => ({ ...VIEWPORTS[k] })) };
  }
  if (!Array.isArray(requested)) {
    return { ok: false, code: 'bad_viewports', message: '`viewports` must be a list of names or {width,height} objects.' };
  }
  if (requested.length === 0) {
    return { ok: false, code: 'bad_viewports', message: 'An audit of no viewports is not an audit. Omit `viewports` for the default three.' };
  }
  if (requested.length > MAX_VIEWPORTS) {
    return {
      ok: false,
      code: 'too_many_viewports',
      message: `At most ${MAX_VIEWPORTS} viewports per audit; ${requested.length} were asked for. Each one is a real page load.`,
    };
  }

  const out = [];
  for (const item of requested) {
    if (typeof item === 'string') {
      const known = VIEWPORTS[item];
      if (!known) {
        return { ok: false, code: 'unknown_viewport', message: `No viewport called ${item}. Stacki has: ${NAMES.join(', ')}.` };
      }
      out.push({ ...known });
      continue;
    }
    if (!item || typeof item !== 'object') {
      return { ok: false, code: 'bad_viewports', message: 'Each viewport must be a name or an object with width and height.' };
    }
    const width = Number(item.width);
    const height = Number(item.height);
    if (!Number.isFinite(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
      return { ok: false, code: 'bad_viewport_size', message: `width must be between ${MIN_WIDTH} and ${MAX_WIDTH}; got ${item.width}.` };
    }
    if (!Number.isFinite(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) {
      return { ok: false, code: 'bad_viewport_size', message: `height must be between ${MIN_HEIGHT} and ${MAX_HEIGHT}; got ${item.height}.` };
    }
    // A custom width that lands exactly on a named one is named, so two audits
    // of the same width report the same viewport key.
    const named = Object.values(VIEWPORTS).find((v) => v.width === Math.round(width) && v.height === Math.round(height));
    out.push(
      named
        ? { ...named }
        : { key: `custom-${Math.round(width)}x${Math.round(height)}`, width: Math.round(width), height: Math.round(height), device: null, standard: null }
    );
  }
  return { ok: true, viewports: out };
}

module.exports = {
  VIEWPORTS,
  DEFAULT_MATRIX,
  NAMES,
  MAX_VIEWPORTS,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
  resolveViewports,
};
