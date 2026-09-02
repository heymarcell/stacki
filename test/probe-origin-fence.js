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
// not a fence. And the counter is proven able to move before anything is
// asserted about it staying still -- the dogfood's own worst oracle bug was a
// sink that could not have been hit.

const http = require('node:http');
const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 260) => JSON.stringify(x ?? null).slice(0, n);

/** A server on loopback, owned by this run, that counts what reaches it. */
function serve(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const route = routes[req.url.split('?')[0]];
    if (typeof route === 'function') return route(req, res);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>ok</title><p>ok</p>');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      done({
        server,
        port,
        hits,
        origin: `http://127.0.0.1:${port}`,
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
    '/protocol-relative': redirectTo(`//127.0.0.1:${outside.port}/landed`),
  });

  const root = H.makeProject();
  const app = await H.start(root, { agentMode: 'full', devUrl: project.origin });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(300);

  const outsideHits = () => outside.hits.length;

  try {
    // --- THE COUNTER CAN MOVE.
    //
    // Asserted first and asserted for real, because every check below is a
    // count that stays at zero, and a count that stays at zero because nothing
    // could ever reach it proves nothing whatever.
    {
      const before = outsideHits();
      const res = await fetch(`${outside.origin}/liveness`);
      await res.arrayBuffer();
      check('the outside origin is reachable and counts what reaches it', res.status === 200 && outsideHits() === before + 1, short({
        status: res.status,
        before,
        after: outsideHits(),
      }));
    }
    const baseline = outsideHits();

    // --- THE ORDINARY CASE STILL WORKS.
    {
      const res = await run('project', 'probe');
      check('probing the preview with no url answers', res.ok === true && res.status === 200, short(res));
      check('  and did not touch the outside origin', outsideHits() === baseline, short({ hits: outside.hits.slice(baseline) }));
    }
    {
      const res = await run('project', 'probe', { url: `${project.origin}/landed` });
      check('a route on the project origin answers', res.ok === true && res.status === 200, short(res));
      check('  and still nothing outside', outsideHits() === baseline, short({ hits: outside.hits.slice(baseline) }));
    }
    {
      const res = await run('project', 'probe', { url: `${project.origin}/redirect-in` });
      check('a SAME-ORIGIN redirect is followed, as it always was', res.ok === true && res.status === 200, short(res));
      check('  and reaches nothing outside', outsideHits() === baseline, short({ hits: outside.hits.slice(baseline) }));
    }
    {
      // The loopback spelling relaxation the audit engine already makes: Stacki
      // builds `127.0.0.1`, an adopted Astro prints `localhost`, and a redirect
      // between them never left the machine.
      const res = await run('project', 'probe', { url: `http://localhost:${project.port}/landed` });
      check('the same server spelled `localhost` is the same server', res.ok === true && res.status === 200, short(res));
      check('  and reaches nothing outside', outsideHits() === baseline, short({ hits: outside.hits.slice(baseline) }));
    }

    // --- AND THE DOOR IS SHUT.
    //
    // Each of these must refuse BEFORE the request, which is why the hit count
    // is asserted beside every one of them rather than once at the end.
    const refuses = async (what, url) => {
      const before = outsideHits();
      const res = await run('project', 'probe', { url });
      check(`${what} is refused`, res.ok === false, short(res));
      check(`  ${what}: with a code that names the reason`, res.code === 'route_outside_project', short({ code: res.code, message: res.message }));
      check(`  ${what}: and the outside origin got nothing`, outsideHits() === before, short({ reached: outside.hits.slice(before) }));
      return res;
    };

    await refuses('an absolute URL on another origin', `${outside.origin}/landed`);
    await refuses('a 302 off the project origin', `${project.origin}/redirect-out`);
    await refuses('a 303 off the project origin', `${project.origin}/see-other-out`);
    await refuses('a 308 off the project origin', `${project.origin}/permanent-out`);
    await refuses('a redirect chain that ends outside', `${project.origin}/chain-1`);
    await refuses('a protocol-relative redirect outside', `${project.origin}/protocol-relative`);
    await refuses('another port on this machine', `http://127.0.0.1:${outside.port}/landed`);
    await refuses('a host that merely starts with the project origin', `${project.origin}.evil.example/landed`);
    await refuses('a URL with the project origin in its userinfo', `http://127.0.0.1:${project.port}@127.0.0.1:${outside.port}/landed`);
    await refuses('a different protocol on the project host', `https://127.0.0.1:${project.port}/landed`);

    // Non-http schemes never reach a server at all, but they must still be
    // refused rather than reported as a working page.
    for (const [what, url] of [
      ['a file: URL', 'file:///etc/hosts'],
      ['a data: URL', 'data:text/html,<p>hi</p>'],
      ['an about: URL', 'about:blank'],
      ['a malformed URL', 'http://[::1'],
      ['a scheme-relative URL', '//127.0.0.1/landed'],
    ]) {
      const before = outsideHits();
      const res = await run('project', 'probe', { url });
      check(`${what} is refused`, res.ok === false, short(res));
      check(`  ${what}: and never reports a status as though it had loaded`, !(res.status > 0), short({ status: res.status }));
      check(`  ${what}: and reached nothing outside`, outsideHits() === before, short({ reached: outside.hits.slice(before) }));
    }

    // --- THE WHOLE RUN, IN ONE NUMBER.
    check('across every probe in this suite the outside origin received nothing',
      outsideHits() === baseline,
      short({ baseline, now: outsideHits(), reached: outside.hits.slice(baseline) }));

    // --- AND THE REFUSAL IS AT THE OPERATION, not a broken probe.
    {
      const res = await run('project', 'probe', { url: `${project.origin}/landed` });
      check('after all those refusals an allowed probe still works', res.ok === true && res.status === 200, short(res));
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
    await project.close();
    await outside.close();
  }

  // Cleanup is a check, not a log line.
  check('both owned servers are closed', !project.server.listening && !outside.server.listening, short({
    project: project.server.listening,
    outside: outside.server.listening,
  }));

  if (failures.length) {
    console.error(`probe-origin-fence: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`probe-origin-fence: ${checked} passed  [project.probe cannot leave the project's own origin]`);
})().catch((err) => {
  console.error('probe-origin-fence: threw\n', err?.stack || err);
  process.exit(1);
});
