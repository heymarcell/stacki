// Where `project.probe` is allowed to send a request.
//
//   node test/probe-origin-fence.js
//
// The audit engine refuses a project route that redirects off-origin, and the
// outside origin receives NOTHING -- the redirect is prevented, not fetched and
// then disapproved of. `project.probe` was measured against the same route in
// the native dogfood and answered `ok:true, status:200` while the outside origin
// logged the request. Pointed straight at an arbitrary host it fetched that too.
//
// It is available at `inspect`, the lowest level that grants project reads, and
// it leaves from the main process, so the MCP wire recorder cannot see it. That
// is a blind outbound network primitive sitting inside a product whose entire
// boundary story is that an agent cannot reach past the project.
//
// THE ORACLE IS A REQUEST COUNTER ON A SERVER THE TEST OWNS, not the envelope
// Stacki returns. A refusal that answers `ok:false` after the packet has left is
// not a fence. And every counter is proven able to move before anything is
// asserted about it staying still -- the dogfood's own worst oracle bug was a
// sink that could not have been hit.
//
// THREE LAYERS, EACH PROVEN WHERE IT LIVES.
//
//   the fence     `probeUrl` with a project origin: every redirect shape, every
//                 scheme, the hop cap, and which socket the request lands on.
//                 Driven directly, because that is how main drives it.
//   the boundary  `project.probe` through the Agent API: a route resolved
//                 against the preview, and an address somewhere else refused
//                 before main is asked for anything.
//   the door      `dev:probe` itself, which fences on Stacki's own record of
//                 the dev server and refuses when it has none.
//
// Proving them one at a time matters: with both fences in place either one
// alone catches most of these, so a suite that only drove the top would stay
// green with the bottom deleted -- which review measured, and which is why the
// boundary's own wording is pinned below.

const http = require('node:http');
const H = require('./agent-harness.js');
const { probeUrl } = require('../electron/devProbe.js');
const { trustedPreviewUrl } = require('../electron/projectOrigin.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 260) => JSON.stringify(x ?? null).slice(0, n);

/** A server on loopback, owned by this run, that counts what reaches it. */
function serve(routes, { host = '127.0.0.1', port = 0 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const route = routes[req.url.split('?')[0]];
    if (typeof route === 'function') return route(req, res);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>ok</title><p>ok</p>');
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const bound = server.address().port;
      done({
        server,
        port: bound,
        hits,
        host,
        origin: `http://${host.includes(':') ? `[${host}]` : host}:${bound}`,
        close: () => new Promise((shut) => server.close(shut)),
      });
    });
  });
}

const redirectTo = (location, status = 302) => (_req, res) => {
  res.writeHead(status, { location });
  res.end();
};

(async () => {
  // Two origins the test owns. `outside` stands for everything that is not the
  // project: another site, another service, another port on this machine.
  const outside = await serve({});
  const project = await serve({
    '/redirect-out': redirectTo(`${outside.origin}/landed`),
    '/redirect-in': redirectTo('/landed'),
    '/chain-1': redirectTo('/chain-2'),
    '/chain-2': redirectTo(`${outside.origin}/landed`),
    '/permanent-out': redirectTo(`${outside.origin}/landed`, 308),
    '/see-other-out': redirectTo(`${outside.origin}/landed`, 303),
    '/temporary-out': redirectTo(`${outside.origin}/landed`, 307),
    '/moved-out': redirectTo(`${outside.origin}/landed`, 301),
    '/protocol-relative': redirectTo(`//127.0.0.1:${outside.port}/landed`),
    '/no-location': (_req, res) => {
      res.writeHead(302);
      res.end();
    },
    '/loop': redirectTo('/loop'),
    '/five-hundred': (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    },
  });

  // A THIRD SOCKET WITH THE SAME PORT NUMBER, on the other loopback stack.
  // Stacki spawns Astro with `--host 127.0.0.1`, so the project binds v4 only,
  // and `localhost` resolves to `::1` first on this platform. Anything holding
  // that port on v6 is a DIFFERENT process that the origin test's loopback
  // tolerance would otherwise call the project.
  let shadow = null;
  try {
    shadow = await serve({}, { host: '::1', port: project.port });
  } catch {
    /* the port is not free on v6 here; that half of the check is skipped */
  }

  const root = H.makeProject();
  const app = await H.start(root, { agentMode: 'full', devUrl: project.origin });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(300);

  const outsideHits = () => outside.hits.length;

  try {
    // --- THE COUNTERS CAN MOVE.
    //
    // Asserted first and asserted for real, because almost every check below is
    // a count that stays at zero, and a count that stays at zero because
    // nothing could ever reach it proves nothing whatever.
    {
      const before = outsideHits();
      const res = await fetch(`${outside.origin}/liveness`);
      await res.arrayBuffer();
      check('the outside origin is reachable and counts what reaches it', res.status === 200 && outsideHits() === before + 1, short({
        status: res.status,
        before,
        after: outsideHits(),
      }));
      if (shadow) {
        const s = await fetch(`http://[::1]:${shadow.port}/liveness`);
        await s.arrayBuffer();
        check('  and so does the v6 socket sharing the project port', s.status === 200 && shadow.hits.length === 1, short({ status: s.status, hits: shadow.hits.length }));
      }
    }
    const baseline = outsideHits();
    const shadowBaseline = shadow ? shadow.hits.length : 0;

    // ── 1. THE FENCE ──────────────────────────────────────────────────────
    //
    // `probeUrl` with a project origin, which is exactly how main calls it.
    const fenced = (url) => probeUrl(url, fetch, { projectOrigin: project.origin });

    {
      const ok = await fenced(`${project.origin}/landed`);
      check('the fence answers for a route on the project', ok.ok === true && ok.status === 200, short(ok));
      const five = await fenced(`${project.origin}/five-hundred`);
      check('  and reports a 500 as a 500 rather than a refusal', five.ok === false && five.status === 500, short(five));
      const inward = await fenced(`${project.origin}/redirect-in`);
      check('  and follows a SAME-ORIGIN redirect, as it always did', inward.ok === true && inward.status === 200, short(inward));
      const spelled = await fenced(`http://localhost:${project.port}/landed`);
      check('  and accepts the same server spelled `localhost`', spelled.ok === true && spelled.status === 200, short(spelled));
    }

    // THE SOCKET, NOT THE NAME. `localhost` may resolve to the v6 loopback,
    // where a different process can be listening on the same port number.
    if (shadow) {
      const before = shadow.hits.length;
      await fenced(`http://localhost:${project.port}/v6-probe`);
      await fenced(`http://[::1]:${project.port}/v6-probe`);
      check(
        'a loopback spelling that resolves elsewhere still reaches the project socket',
        shadow.hits.length === before,
        short({ shadowGot: shadow.hits.slice(before), projectGot: project.hits.slice(-2) })
      );
    }

    const fenceRefuses = async (what, url) => {
      const before = outsideHits();
      const res = await fenced(url);
      check(`the fence refuses ${what}`, res.ok === false, short(res));
      check(`  ${what}: and the outside origin got nothing`, outsideHits() === before, short({ reached: outside.hits.slice(before) }));
      return res;
    };

    await fenceRefuses('an absolute URL on another origin', `${outside.origin}/landed`);
    for (const [name, route] of [
      ['a 301 off the project origin', '/moved-out'],
      ['a 302 off the project origin', '/redirect-out'],
      ['a 303 off the project origin', '/see-other-out'],
      ['a 307 off the project origin', '/temporary-out'],
      ['a 308 off the project origin', '/permanent-out'],
      ['a chain that ends outside', '/chain-1'],
      ['a protocol-relative redirect outside', '/protocol-relative'],
    ]) {
      const res = await fenceRefuses(name, `${project.origin}${route}`);
      check(`  ${name}: names the reason`, res.code === 'route_outside_project', short({ code: res.code }));
    }
    await fenceRefuses('another port on this machine', `http://127.0.0.1:${outside.port}/landed`);
    await fenceRefuses('a different protocol on the project host', `https://127.0.0.1:${project.port}/landed`);
    await fenceRefuses('a URL with the project origin in its userinfo', `http://127.0.0.1:${project.port}@127.0.0.1:${outside.port}/landed`);
    for (const [what, url] of [
      ['a file: URL', 'file:///etc/hosts'],
      ['a data: URL', 'data:text/html,<p>hi</p>'],
      ['an about: URL', 'about:blank'],
      ['a javascript: URL', 'javascript:void(0)'],
      // `blob:` is NOT an opaque origin -- it borrows the origin of the URL in
      // its path -- so an origin check alone waves it through to `fetch`.
      ['a blob: URL wearing the project origin', `blob:${project.origin}/x`],
      ['a malformed URL', 'http://[::1'],
      ['a scheme-relative URL', '//127.0.0.1/landed'],
    ]) {
      const res = await fenceRefuses(what, url);
      check(`  ${what}: and never reports a status as though it had loaded`, !(res.status > 0), short({ status: res.status }));
    }

    {
      const looped = await fenced(`${project.origin}/loop`);
      check('a redirect loop stops at the hop cap', looped.ok === false && looped.code === 'too_many_redirects', short(looped));
      const none = await fenced(`${project.origin}/no-location`);
      check('a 3xx with no Location is the answer, not a hop', none.ok === false && none.status === 302, short(none));
    }

    // ── 2. THE BOUNDARY ───────────────────────────────────────────────────
    //
    // What the agent itself is handed. `input.url` no longer wins over the
    // trusted preview address: a route is resolved against it, and an address
    // somewhere else is refused HERE, before main is asked for anything.
    //
    // WHAT THE ACCEPT PATH LOOKS LIKE FROM HERE. Main fences on its own record
    // of the dev server, and this harness has never started one, so an allowed
    // route gets as far as the door and is refused there for a different
    // reason. That difference is the proof: a route the boundary did NOT
    // resolve has no origin at all, so the boundary itself would have refused
    // it with `route_outside_project`. Reaching `no_preview` means it resolved.
    // The end-to-end accept path is proven where a real preview exists -- the
    // fence section above, and the native rerun against the packaged app.
    {
      const res = await run('project', 'probe', { url: '/landed' });
      check('a bare project route gets past the boundary, so it was resolved', res.code === 'no_preview', short(res));
      check('  rather than being refused as foreign', res.code !== 'route_outside_project', short(res));
      check('  and reaches nothing outside', outsideHits() === baseline, short({ hits: outside.hits.slice(baseline) }));
    }
    {
      const res = await run('project', 'probe');
      check('probing with no url at all names the preview and gets past too', res.code === 'no_preview', short(res));
    }
    {
      const before = outsideHits();
      const res = await run('project', 'probe', { url: `${outside.origin}/landed` });
      check('an address on another origin is refused', res.ok === false && res.code === 'route_outside_project', short(res));
      // The wording is the boundary's own. Both layers refuse this URL with the
      // same code, so without pinning the message the mapper could be deleted
      // and the suite would not notice -- which review measured.
      check('  by the boundary, before main is asked', /project\.probe only ever reaches this project/.test(String(res.message)), short(res.message));
      check('  and the outside origin got nothing', outsideHits() === before, short({ reached: outside.hits.slice(before) }));
    }
    {
      const before = outsideHits();
      const res = await run('project', 'probe', { url: `${project.origin}/redirect-out` });
      check('a route that redirects off the project is refused', res.ok === false, short(res));
      check('  and the outside origin got nothing', outsideHits() === before, short({ reached: outside.hits.slice(before) }));
    }

    // ── 3. THE DOOR ───────────────────────────────────────────────────────
    //
    // `dev:probe` fences on Stacki's OWN record of the dev server. In this
    // harness main has never started one, so it holds none -- and the door
    // refuses rather than becoming the one operation that fetches anything.
    {
      const before = outsideHits();
      const res = await app.callMain('dev:probe', `${outside.origin}/landed`);
      check('the door refuses when Stacki holds no dev server', res?.ok === false && res?.code === 'no_preview', short(res));
      check('  and sends nothing', outsideHits() === before, short({ reached: outside.hits.slice(before) }));
    }
    {
      const before = outsideHits();
      const res = await app.callMain('dev:probe', { url: `${outside.origin}/landed`, projectOrigin: outside.origin });
      check('and a caller cannot nominate the origin it will be fenced to', res?.ok === false && res?.code === 'no_preview', short(res));
      check('  so nothing is sent for that either', outsideHits() === before, short({ reached: outside.hits.slice(before) }));
    }

    // --- WHAT COUNTS AS THE PROJECT'S PREVIEW AT ALL.
    //
    // The fence is only as good as what it is fenced to, and two of the three
    // ways `devServer.url` is set read a project file or the dev server's own
    // stdout. A repository that ships `.astro/dev.json` naming another host
    // chose the origin every fenced door compares against -- measured, four
    // real requests to a non-project origin, all answered ok:true.
    {
      check('a preview address on another host is not trusted', trustedPreviewUrl('http://evil.example:4321') === null, 'a non-loopback host was accepted');
      check('  nor one with no port', trustedPreviewUrl('http://127.0.0.1') === null, 'a portless address was accepted');
      check('  nor a non-http scheme', trustedPreviewUrl('file:///etc/hosts') === null, 'a file: URL was accepted');
      check('  nor a subdomain of a loopback name', trustedPreviewUrl('http://localhost.evil.example:4321') === null, 'a lookalike host was accepted');
      check('  and a real one is kept, as an origin', trustedPreviewUrl('http://127.0.0.1:4321/some/path') === 'http://127.0.0.1:4321', short(trustedPreviewUrl('http://127.0.0.1:4321/some/path')));
      check('  including the spelling an adopted Astro prints', trustedPreviewUrl('http://localhost:4321/') === 'http://localhost:4321', short(trustedPreviewUrl('http://localhost:4321/')));
    }

    // --- THE WHOLE RUN, IN ONE NUMBER.
    check('across every probe in this suite the outside origin received nothing',
      outsideHits() === baseline,
      short({ baseline, now: outsideHits(), reached: outside.hits.slice(baseline) }));
    if (shadow) {
      check('and the socket sharing its port number received nothing either',
        shadow.hits.length === shadowBaseline,
        short({ reached: shadow.hits.slice(shadowBaseline) }));
    }

    // --- AND AN ALLOWED ADDRESS IS STILL ALLOWED, after all of that.
    {
      const res = await run('project', 'probe', { url: `${project.origin}/landed` });
      check('an allowed address is still allowed through the boundary at the end', res.code === 'no_preview', short(res));
      const live = await fenced(`${project.origin}/landed`);
      check('  and the fence still answers for it', live.ok === true && live.status === 200, short(live));
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
    await project.close();
    await outside.close();
    if (shadow) await shadow.close();
  }

  // Cleanup is a check, not a log line.
  check('every owned server is closed', !project.server.listening && !outside.server.listening && !(shadow && shadow.server.listening), short({
    project: project.server.listening,
    outside: outside.server.listening,
    shadow: shadow ? shadow.server.listening : 'none',
  }));
  check('the fixture is gone', !require('node:fs').existsSync(root), root);

  if (failures.length) {
    console.error(`probe-origin-fence: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `probe-origin-fence: ${checked} passed  [project.probe cannot leave the project's own origin${shadow ? '' : ' (v6 shadow unavailable here)'}]`
  );
})().catch((err) => {
  console.error('probe-origin-fence: threw\n', err?.stack || err);
  process.exit(1);
});
