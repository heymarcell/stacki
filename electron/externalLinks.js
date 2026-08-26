// What Stacki is willing to hand to the operating system.
//
// One list, in one place, imported by the main process and by the renderer —
// because the alternative was two lists that disagreed, and they did: the
// renderer rendered `mailto:` as a clickable link, the main process opened
// only http and https, and the handler returned `{ ok: true }` either way. So
// a mail link in a comment looked live, was clicked, did nothing, and reported
// success. A control that lies about having worked is worse than one that is
// obviously missing.
//
// mailto is supported deliberately. Somebody writing "ask
// design@example.com" in a review means it, and refusing it would be a
// second lie in the other direction.
//
// Everything else is refused, and the interesting ones are refused for
// specific reasons rather than because they are unusual:
//
//   javascript:  would run in whatever opens it
//   data:        can carry a whole document, including markup
//   file:        opens local files by path — a comment body can be written by
//                an agent, and this is the editor's own hand on the filesystem
//   stacki-asset: the app's private scheme; nothing outside should route it
//
// Pure on purpose: no electron, no filesystem. The main process is still the
// authority — this only tells it what the answer is — and the renderer runs
// the same check first so a dead link is never drawn as a live one.

/** The three schemes a review, or anything else in Stacki, may open. */
const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'];

/** Anything a person could not have typed into a link: spaces, tabs, newlines, controls. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

const SCHEME = new RegExp(`^(${EXTERNAL_SCHEMES.join('|').replace(/:/g, ':')})`, 'i');

/**
 * The url, if Stacki will open it. Null if it will not.
 *
 * A url carrying whitespace or a control character is refused outright rather
 * than stripped and retried — `java\nscript:` is the oldest trick there is and
 * it survives a naive prefix test, and sanitising would mean deciding what
 * somebody meant and then handing the original string on anyway.
 */
function openableUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return null;
  if (CONTROL_OR_SPACE.test(raw)) return null;
  if (!SCHEME.test(raw)) return null;
  return raw;
}

/** Why a url was refused, for a caller that has to say something. */
function refusalFor(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(raw)?.[1]?.toLowerCase() || null;
  return {
    ok: false,
    code: 'refused_scheme',
    scheme,
    message: scheme
      ? `Stacki opens ${EXTERNAL_SCHEMES.join(', ')} links. It will not open ${scheme}`
      : `Stacki opens ${EXTERNAL_SCHEMES.join(', ')} links only.`,
  };
}

module.exports = { EXTERNAL_SCHEMES, openableUrl, refusalFor };
