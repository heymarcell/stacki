// Is this address the project Stacki is serving?
//
// The audit engine has asked that question carefully since it was written, and
// `project.probe` did not ask it at all — it fetched whatever URL it was
// handed, followed redirects off the project origin, and reported the status.
// A native-Claude dogfood measured the two doors against the SAME route: the
// audit refused and the outside origin received nothing; the probe answered
// `ok:true, status:200` and the outside origin received the request.
//
// The answer is not to write a second origin check. A relaxation that exists in
// two places drifts, and this one is a relaxation: loopback has more than one
// spelling and the same server answers to all of them. So the audit's test moved
// here, unchanged, and both doors call it.
//
// Nothing in this file may depend on Electron. It is required by the main
// process, by the audit engine, and by tests running in bare Node.

/**
 * The origin of a URL, or null when it does not have one.
 *
 * `data:`, `about:`, `file:` and `javascript:` are OPAQUE origins, and the URL
 * standard spells those as the string "null". Returning that string put the word
 * "null" into a refusal message as though it were a hostname and stopped the
 * "unreadable origin" wording ever being reached. An opaque origin is not an
 * origin, so it comes back as one.
 */
function originOf(u) {
  try {
    const origin = new URL(u).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

// THE SAME SERVER, SPELLED TWO WAYS.
//
// The preview URL Stacki builds itself is `http://127.0.0.1:PORT`, but a dev
// server the user started and Stacki adopted is scraped from Astro's own output,
// which prints `http://localhost:PORT`. Those are different origins to a string
// compare, so a redirect between them -- which frameworks do -- would have been
// refused as "outside the project" on a page that never left the machine. Same
// scheme, same port and both names for the loopback interface is the same server.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A test for "is this origin the project's", tolerant of loopback spelling only. */
function projectOriginTest(projectOrigin) {
  let base = null;
  try {
    base = new URL(projectOrigin);
  } catch {
    /* falls through to an exact compare, which will simply never match */
  }
  const loopback = !!base && LOOPBACK_NAMES.has(base.hostname);
  return (origin) => {
    if (!origin) return false;
    if (origin === projectOrigin) return true;
    if (!loopback) return false;
    let other = null;
    try {
      other = new URL(origin);
    } catch {
      return false;
    }
    return other.protocol === base.protocol && other.port === base.port && LOOPBACK_NAMES.has(other.hostname);
  };
}

module.exports = { originOf, projectOriginTest, LOOPBACK_NAMES };
