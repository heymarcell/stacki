// Is the dev server serving a page, or an error?
//
// A compile error replaces the site with the dev server's own error screen —
// served with a 5xx, and carrying none of the HMR client the real page has. So
// nothing inside it can hear the file being fixed, and the preview sits on the
// error until something reloads it. Deciding when to reload means being able to
// ask this question, and the HTTP status is the only answer that doesn't depend
// on recognising the error screen's markup or parsing the server's log — both of
// which change with every version of Astro and Vite.

const { originOf, projectOriginTest } = require('./projectOrigin.js');

// A redirect chain long enough for any dev server's route handling and short
// enough that a loop cannot spin. Astro redirects at most a hop or two.
const MAX_HOPS = 5;

/** The refusal, in the audit engine's words for the same situation. */
const outsideProject = (where, projectOrigin) => ({
  ok: false,
  status: 0,
  code: 'route_outside_project',
  message:
    `${where} is not on ${projectOrigin}, which is the project Stacki is serving. ` +
    'Stacki only ever probes this project — the request was not sent.',
});

/**
 * Ask the dev server for a URL and report only the verdict.
 *
 * A server that doesn't answer at all counts the same as one answering 500:
 * either way there is no page there yet, which is what the caller is deciding
 * on. The body is drained and dropped — it can be a megabyte of stack trace,
 * and none of it is wanted.
 *
 * WITH A `projectOrigin`, THIS IS A FENCE AND NOT A FETCH.
 *
 * `project.probe` reaches this function from an agent, at `inspect` — the lowest
 * level that grants project reads — and it leaves from the main process, where
 * the MCP wire recorder cannot see it. Unfenced, that is a blind outbound
 * network primitive: an arbitrary URL fetched, an internal port answered for,
 * and data carried out in the address itself. A native dogfood measured the
 * audit refusing a route that redirects off-origin with the outside origin
 * receiving NOTHING, and this function fetching the same route happily.
 *
 * So when a project origin is given, two things change. The URL is checked
 * before anything is sent, and redirects stop being automatic: each hop's
 * `Location` is resolved and checked, and the request that would leave the
 * project is never made. `redirect: 'manual'` is what makes that possible —
 * the 302 comes back with a readable header and no second request.
 *
 * Called with no project origin it behaves exactly as it always did, which is
 * what the preview watcher and its test rely on.
 */
async function probeUrl(url, fetchImpl = fetch, { projectOrigin = null, maxHops = MAX_HOPS } = {}) {
  if (!url || typeof url !== 'string') return { ok: false, status: 0 };

  if (!projectOrigin) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      try {
        await res.arrayBuffer();
      } catch {
        /* nothing to drain */
      }
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  const isProjectOrigin = projectOriginTest(originOf(projectOrigin));
  let next = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    // Asked of every hop, including the first, so an absolute URL somewhere
    // else and a redirect somewhere else are refused by the same line.
    if (!isProjectOrigin(originOf(next))) return outsideProject(next, projectOrigin);

    let res;
    try {
      res = await fetchImpl(next, { redirect: 'manual' });
    } catch {
      return { ok: false, status: 0 };
    }
    try {
      await res.arrayBuffer();
    } catch {
      /* nothing to drain */
    }

    // 304 is not a redirect and carries no Location; 3xx without one is the
    // server's answer, not a hop.
    const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
    if (!location) return { ok: res.ok, status: res.status };

    // Resolved against the URL that produced it, so a relative Location — which
    // is the common case — is the same origin by construction, and a
    // protocol-relative one is not.
    try {
      next = new URL(location, next).href;
    } catch {
      return { ok: false, status: 0 };
    }
  }
  return {
    ok: false,
    status: 0,
    code: 'too_many_redirects',
    message: `${url} redirected more than ${maxHops} times without settling.`,
  };
}

module.exports = { probeUrl, MAX_HOPS };
