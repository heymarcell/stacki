// An audit given up on MID-FLIGHT, in a real browser, over a real socket.
//
//   node --check test/audit-cancel-inflight.js && electron test/audit-cancel-inflight.js
//
// WHY THIS EXISTS BESIDE test/audit-cancel.js. That suite drives the engine
// with a window the test controls, and it is the right tool for control flow —
// which run answered, which window was opened, which promise was still
// outstanding when the answer came. What it cannot do is any of the following,
// because none of them is a fact about JavaScript:
//
//   that a renderer spinning in a tight loop is actually let go, which no
//     timer in the browser process can do and only destroying the frame does
//   that the abort a real MCP client makes on a real Streamable HTTP transport
//     reaches the engine's signal at all
//   that the offscreen window an audit owns is gone from Chromium's own window
//     list within a moment of the caller leaving, rather than at the end of
//     whatever it was blocked on
//   that no picture is composited and no JPEG encoded after the caller has gone
//
// So this is Electron, the real engine, the real endpoint built by
// createStackiMcpServer, and the official @modelcontextprotocol/client over
// StreamableHTTPClientTransport. The abort is the TRANSPORT'S — `callTool(...,
// { signal })` — never a hand-made `{ mcpReq: { signal } }` handed to the
// handler by a test reaching past the wire.
//
// WHAT WAS MEASURED HERE BEFORE THE FIX, so the numbers below are a record and
// not a target. Latency is taken from the moment the ENGINE'S OWN signal fired,
// not from when the client called abort:
//
//   a hanging load      the engine kept working 39,582ms after the signal, then
//                       answered `audit_failed` with "loading /hang-load at
//                       375px did not finish within 20000ms" — a timeout the
//                       abandoned run had caused itself, never saying it had
//                       been cancelled
//   a wedged renderer   19,713ms after the signal, tracking the wedge exactly
//   the window          alive for 157 consecutive samples at 250ms, about 39
//                       seconds, after the caller had gone; it reached zero
//                       only when the blocked operation returned by itself
//   the picture         one capturePage and one JPEG encode with a timestamp
//                       LATER than the abort
//   the queue           a queued-and-abandoned run did no work, correctly, and
//                       then held its caller 18.6 seconds until the run in
//                       front of it finished before saying so
//
// AND THE THINGS THAT WERE ALREADY TRUE, kept here as regression guards rather
// than dressed up as fixes: an already-aborted request opens no window and
// loads no page, no LATER viewport starts after an abort, a late abort is
// inert, and the SDK writes no JSON-RPC body for a request whose transport has
// closed.
//
// THE POSITIVE CONTROLS ARE THE POINT. Every assertion below is that something
// stopped, and an engine that refused every audit would satisfy all of them. So
// each fixture route is also audited with NO abort at all, and has to come back
// with the answer it should: /ok clean, /wedge clean and slow, /hang-load a
// bounded failure.

const http = require('node:http');
const net = require('node:net');
const { app, BrowserWindow, session } = require('electron');

process.env.STACKI_NO_DIALOGS = '1';
process.env.STACKI_HIDDEN_WINDOW = '1';

// Without this an Electron process exits the moment its last window closes —
// and this suite destroys every window it opens, on purpose, in the middle.
app.on('window-all-closed', () => {});

const { createAudit, liveWindowCount } = require('../electron/mcp/audit');
const { createStackiMcpServer } = require('../electron/mcp/server.js');
const { connectMcp } = require('./support/mcpWire.js');
const { freePort } = require('./support/suiteGuard.js');

// AN EXIT CODE THAT IS NOT A REPORT IS NOT A PASS.
//
// Every case here holds something the engine is supposed to stop waiting for —
// a load that never ends, a renderer that will not answer. A build that does
// not stop waiting leaves this process with nothing to do, and an Electron
// process with nothing to do and no window exits ZERO having printed nothing.
// Only the report at the bottom may end this run cleanly.
let finished = false;
const SUITE_DEADLINE_MS = 420000;
const watchdog = setTimeout(() => {
  console.error(`audit-cancel-inflight: the suite did not finish within ${SUITE_DEADLINE_MS}ms — an audit is still waiting on something`);
  process.exit(1);
}, SUITE_DEADLINE_MS);
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.error('audit-cancel-inflight: the process exited without finishing — an audit never answered, so nothing was reported');
  process.exitCode = 1;
});

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => {
  try {
    return typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v ?? null)?.slice(0, 300);
  } catch {
    return String(v);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// HOW LONG AFTER THE SIGNAL AN ABANDONED RUN MAY TAKE TO LET GO. Two seconds is
// generous for "destroy a window and unwind", and it is an order of magnitude
// under everything this suite is built to catch: the wedge is eight seconds and
// the hanging load is two twenty-second budgets.
const TOLERANCE_MS = 2000;
// Long enough that a run which waits it out cannot be mistaken for one that did
// not, and short enough to keep the suite honest about its own runtime.
const SPIN_MS = 8000;
// The unhandled rejections and endpoint errors this run produced. Both are
// assertions at the end: a cancel that arrives as an unhandled rejection is a
// cancel that will one day take a process down.
const unhandled = [];
const endpointErrors = [];
process.on('unhandledRejection', (err) => unhandled.push(String(err?.message || err)));

// --- the fixture, which this suite owns -------------------------------------
//
// Three shapes of page, each the smallest thing that produces the behaviour:
// one that finishes, one whose response never ends, one whose load handler
// takes the renderer's main thread away for eight seconds. Nothing here is
// Astro, and nothing here is shared: a cancellation test wants a page that
// misbehaves on demand, which is not a thing to ask of a fixture other suites
// grade findings against.

/** Every document request the fixture served, with the moment it arrived. */
const served = [];
/** Responses written but never ended, so teardown can close them. */
const hanging = new Set();

const PAGE_OK =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ok</title></head>' +
  '<body><h1>A page that finishes</h1><p>Nothing here is wrong.</p></body></html>';

const spinner = (delayMs) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wedge</title></head>' +
  '<body><h1>A page that takes the main thread</h1><script>' +
  `window.addEventListener('load', function () { setTimeout(function () {` +
  `var end = Date.now() + ${SPIN_MS}; while (Date.now() < end) {} }, ${delayMs}); });` +
  '</script></body></html>';

const fixture = http.createServer((req, res) => {
  const route = (req.url || '/').split('?')[0];
  served.push({ route, at: Date.now() });
  if (route === '/hang-load') {
    // Headers and a partial body, and then nothing, for ever. This is the
    // shape a dev server in trouble actually has: the connection is open, the
    // page is parsing, and `did-finish-load` never comes.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>hang</title></head><body><p>');
    hanging.add(res);
    res.on('close', () => hanging.delete(res));
    return;
  }
  if (route === '/wedge') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(spinner(0));
    return;
  }
  if (route === '/ok' || route === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_OK);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="en"><body>no</body></html>');
});

/**
 * How many documents the fixture has served for one route.
 *
 * A COUNT, NOT A TIMESTAMP COMPARISON. This used to be `servedAfter(route, at)`,
 * and the assertion built on it -- "no LATER viewport loads the page again" --
 * counted any document request whose clock reading was later than the abort.
 * Nothing in that ties a request to a VIEWPORT: a run that had loaded the page
 * for two of its three viewports before the abort satisfied it, and a run that
 * loaded the page for its FIRST viewport a moment after the abort failed it,
 * which is the only thing a fixed 600ms abort could reliably produce on a fast
 * machine. Three viewports asked for and one document served is a statement
 * about viewports; a timestamp is a statement about the clock.
 */
const servedCount = (route) => served.filter((s) => s.route === route).length;

// --- a wire that counts ------------------------------------------------------
//
// The client connects through this rather than to the endpoint directly, so the
// bytes the server actually wrote for a cancelled request can be counted from
// outside both of them. A JSON-RPC body written for a request whose transport
// has closed is work nobody reads and, worse, a second cancellation
// architecture waiting to be invented; the SDK already prevents it, and this is
// the guard that says so.
function byteCountingProxy(upstreamPort) {
  let downstream = 0;
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(upstream);
    // A cancelled request resets its connection at both ends; that is the
    // behaviour under test, not a failure of the proxy.
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on('data', (chunk) => upstream.write(chunk));
    upstream.on('data', (chunk) => {
      downstream += chunk.length;
      client.write(chunk);
    });
  });
  return {
    server,
    bytes: () => downstream,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Every liveWindowCount() reading between two moments, at 100ms.
 *
 * The oracle for "the window went at the abort" has to be a SAMPLE rather than
 * a reading at the end: a count of zero once the run has unwound says nothing
 * about whether the window was alive for the thirty-nine seconds before it.
 */
function sampleWindows(everyMs = 100) {
  const samples = [];
  const timer = setInterval(() => samples.push({ at: Date.now(), live: liveWindowCount() }), everyMs);
  return {
    samples,
    stop: () => {
      clearInterval(timer);
      return samples;
    },
  };
}

(async () => {
  await app.whenReady();

  await new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const fixturePort = fixture.address().port;
  const base = `http://127.0.0.1:${fixturePort}`;

  // --- the real engine, watched from the outside ----------------------------
  //
  // The client cannot read the answer to a request it cancelled — an abort
  // raises AbortError and the payload never arrives — so what the ENGINE said,
  // and when, is recorded here, between the endpoint and the engine. The signal
  // is still the transport's: this wrapper only listens to it.
  // Every JPEG this run encoded, with the moment it happened.
  const encodes = [];
  const engine = createAudit({
    BrowserWindow,
    getPreviewUrl: () => base,
    session,
    // A SPY THAT IS OTHERWISE THE REAL ENCODER'S CONTRACT: `{ buffer, size }`,
    // and a timestamp, so a picture composited after the caller left is
    // countable rather than merely suspected.
    encodeImage: (image, format) => {
      const size = image.getSize ? image.getSize() : { width: 0, height: 0 };
      const buffer = Buffer.from('not a real jpeg');
      encodes.push({ at: Date.now(), format, size });
      return { buffer, size };
    },
  });
  const runs = [];
  const audit = async (args, opts = {}) => {
    const record = { args, startedAt: Date.now(), signalFiredAt: null, answeredAt: null, code: null, ok: null };
    runs.push(record);
    const signal = opts?.signal || null;
    const note = () => {
      if (record.signalFiredAt === null) record.signalFiredAt = Date.now();
    };
    if (signal) {
      if (signal.aborted) note();
      else signal.addEventListener('abort', note, { once: true });
    }
    try {
      const res = await engine.run(args, opts);
      record.answeredAt = Date.now();
      record.ok = res?.ok ?? null;
      record.code = res?.code ?? null;
      record.message = res?.message ?? null;
      return res;
    } finally {
      if (signal) signal.removeEventListener('abort', note);
    }
  };
  /** How long after ITS OWN signal fired the engine answered. */
  const deltaAfterAbort = (record) =>
    record && record.signalFiredAt !== null && record.answeredAt !== null ? record.answeredAt - record.signalFiredAt : null;

  const TOKEN = 'audit-cancel-inflight-token-aaaaaaaa';
  // A port nobody else in this repository starts on, chosen per process so two
  // suites at once do not collide.
  //
  // PROBED, NOT ASSUMED. `45300 + (process.pid % 200)` was bound straight, with
  // no probe and no retry, while the two sibling suites added beside it use the
  // `freePort` helper written for exactly this: pid spans overlap the ones the
  // wire rigs allocate from, so two suites in one run can want the same number
  // and the loser dies on EADDRINUSE. That is noise here rather than a finding,
  // and this suite is the expensive one to re-run.
  const ENDPOINT_PORT = await freePort(45300 + (process.pid % 200));
  const server = createStackiMcpServer({
    port: ENDPOINT_PORT,
    token: TOKEN,
    version: '0.0.0-cancel',
    getContext: async () => ({ project: null, selection: null }),
    capture: async () => ({ image: null, mimeType: null, meta: { status: 'preview_not_ready', bytes: 0 } }),
    getComments: async () => ({ ok: true, revision: 1, status: 'open', scope: 'project', total: 0, returned: 0, truncated: false, reviews: [], problem: null }),
    comment: async () => ({ ok: false, code: 'no_project', message: 'This rig has no review ledger.' }),
    api: {
      run: async () => ({ ok: false, code: 'no_project', message: 'This rig has no project.' }),
      capabilities: async () => ({ ok: true, stacki: { version: '0' }, access: { mode: 'build' } }),
      // The door `audit` asks. Open, so a refusal here can never be mistaken
      // for a cancellation.
      checkAccess: () => null,
      nodeRef: () => null,
    },
    audit,
    onError: (err) => endpointErrors.push(String(err?.message || err)),
  });
  await server.start();

  const proxy = byteCountingProxy(ENDPOINT_PORT);
  const proxyPort = await proxy.listen();
  const { client, close: closeClient } = await connectMcp({
    url: `http://127.0.0.1:${proxyPort}/mcp`,
    token: TOKEN,
    era: 'modern',
    name: 'audit-cancel-inflight',
  });

  /** One audit over the wire. `signal` is the transport's own. */
  const callAudit = async (args, options = {}) => {
    try {
      const res = await client.callTool({ name: 'audit', arguments: args }, { timeout: 120000, ...options });
      return { ok: true, res };
    } catch (err) {
      return { ok: false, error: String(err?.name || '') || 'error', message: String(err?.message || err) };
    }
  };
  const lastRun = () => runs[runs.length - 1];

  try {
    // ---- POSITIVE CONTROLS -------------------------------------------------
    //
    // Three routes, no abort anywhere, and each has to answer the way it
    // should. Without these an engine that cancelled everything, or a fixture
    // that served nothing, would satisfy every assertion below.
    {
      const before = liveWindowCount();
      const started = Date.now();
      const { ok, res, message } = await callAudit({ route: '/ok', viewports: ['phone'], rules: [], capture: true });
      const took = Date.now() - started;
      check('a page that loads is audited', ok === true, message);
      check('  and the audit succeeded', res?.structuredContent?.ok === true, short(res?.structuredContent));
      check('  and it measured the viewport asked for', res?.structuredContent?.viewports?.length === 1, short(res?.structuredContent?.viewports));
      check('  and the fixture actually served it', served.some((s) => s.route === '/ok'), short(served.slice(-3)));
      // The other half of the encode assertion further down: a run nobody
      // cancelled DOES photograph the page, so "no encode after the abort"
      // cannot be satisfied by an engine that never encodes anything.
      check('  and it photographed the viewport', encodes.length === 1, short(encodes));
      check('  and said so on the capture row', res?.structuredContent?.captures?.[0]?.included === true, short(res?.structuredContent?.captures));
      check('  and no window survived it', liveWindowCount() === before, `${before} -> ${liveWindowCount()} in ${took}ms`);
    }

    {
      const started = Date.now();
      const { ok, res, message } = await callAudit({ route: '/wedge', viewports: ['phone'], rules: [] });
      const took = Date.now() - started;
      check('a page that wedges the renderer is still audited when nobody cancels', ok === true, message);
      check('  and it succeeds', res?.structuredContent?.ok === true, short(res?.structuredContent));
      check(`  and it really did take the wedge (>= ${SPIN_MS}ms)`, took >= SPIN_MS, `${took}ms`);
      check('  and no window survived it', liveWindowCount() === 0, String(liveWindowCount()));
    }

    {
      // Two LOAD_TIMEOUT_MS windows: the loadURL budget and then the
      // did-finish-load budget behind it. Bounded is the claim, not fast.
      const started = Date.now();
      const { ok, res, message } = await callAudit({ route: '/hang-load', viewports: ['phone'], rules: [] }, { timeout: 120000 });
      const took = Date.now() - started;
      check('a response that never ends is bounded rather than waited on for ever', ok === true, message);
      check('  and comes back a refusal, not a clean audit', res?.structuredContent?.ok === false, short(res?.structuredContent));
      check('  and names what did not finish', /did not finish within/.test(String(res?.structuredContent?.message || '')), short(res?.structuredContent?.message));
      check('  within a minute and a half', took < 90000, `${took}ms`);
      check('  and no window survived it', liveWindowCount() === 0, String(liveWindowCount()));
    }

    // ---- 2. ABORT DURING A HANGING LOAD ------------------------------------
    {
      const ac = new AbortController();
      const watch = sampleWindows();
      setTimeout(() => ac.abort(), 400);
      const started = Date.now();
      const out = await callAudit({ route: '/hang-load', viewports: ['phone', 'tablet', 'desktop'], rules: [] }, { signal: ac.signal });
      // The engine's own answer, which the client never sees: an abort raises
      // AbortError and the payload is not delivered.
      for (let i = 0; i < 3000 && lastRun().answeredAt === null; i += 1) await wait(20);
      const settled = lastRun();
      // A few more samples after the answer, so "the window reached zero" is
      // read off the sampler rather than off the moment the poll loop happened
      // to stop. A run that lets go in under one sampling interval otherwise
      // produces no sample at all on the far side of the abort.
      await wait(400);
      watch.stop();
      const delta = deltaAfterAbort(settled);
      check('the client is told its cancelled audit was cancelled', out.ok === false && /abort/i.test(out.error + out.message), short(out));
      check('the engine saw the transport abort at all', settled.signalFiredAt !== null, short({ startedAt: settled.startedAt, signalFiredAt: settled.signalFiredAt }));
      check(
        `an audit abandoned during a hanging load lets go within ${TOLERANCE_MS}ms of its signal`,
        delta !== null && delta <= TOLERANCE_MS,
        `${delta}ms after the signal (was 39,582ms); total ${Date.now() - started}ms`
      );
      check('  and says it was cancelled', settled.code === 'cancelled', short({ ok: settled.ok, code: settled.code, message: settled.message }));
      check(
        '  rather than reporting the timeout it caused itself',
        !/did not finish within/.test(String(settled.message || '')),
        short(settled.message)
      );

      // ---- 4. THE WINDOW, SAMPLED --------------------------------------------
      const zeroAt = watch.samples.find((s) => s.at > settled.signalFiredAt && s.live === 0);
      const stillUp = watch.samples.filter((s) => s.at > settled.signalFiredAt && s.live > 0).length;
      check(
        `  and its offscreen window is gone within ${TOLERANCE_MS}ms of the signal`,
        !!zeroAt && zeroAt.at - settled.signalFiredAt <= TOLERANCE_MS,
        `zero at ${zeroAt ? zeroAt.at - settled.signalFiredAt : 'never'}ms, ${stillUp} samples still showing a live window (was 157)`
      );
      check('  and Chromium is holding none either', BrowserWindow.getAllWindows().length === 0, String(BrowserWindow.getAllWindows().length));
    }

    // ---- 3 + 5 + 6. ABORT DURING A WEDGED RENDERER --------------------------
    //
    // The renderer is inside a tight JavaScript loop, which no timer and no
    // signal in the browser process can interrupt. Destroying the frame is the
    // only thing that ends it, and this is the case that says whether that is
    // what happens. `capture: true` is on so the picture and the encode behind
    // it are countable, and three viewports are asked for so a LATER page load
    // after the abort would show up in the fixture's own log.
    {
      const encodesBefore = encodes.length;
      const wedgesBefore = servedCount('/wedge');
      const ac = new AbortController();
      const watch = sampleWindows();
      // THE ABORT FOLLOWS THE RUN'S PROGRESS RATHER THAN A CLOCK.
      //
      // It was `setTimeout(() => ac.abort(), 600)`, a guess at how long the
      // engine takes to clear its session, open an offscreen window and get a
      // document out of the fixture. Guessing wrong in either direction changes
      // what this case is about: too early and the abort lands before the page
      // is requested, too late and it lands after the wedge has ended. So the
      // fixture's own log is the trigger -- the abort is fired once the page has
      // actually been asked for, plus a moment for `load` to fire and the spin
      // to start, which is still SPIN_MS minus that moment inside the wedge.
      //
      // `wedgeDocAt` reads the moment THIS run's first /wedge document was asked
      // for, by index
      // rather than by "the last thing the fixture saw": an abort that fired
      // before the page was requested must leave this null, so the guard below
      // catches it rather than reading a request some earlier case made.
      const wedgeDocAt = (n) => served.filter((s) => s.route === '/wedge')[n]?.at ?? null;
      const abortInsideTheWedge = (async () => {
        for (let i = 0; i < 2000 && servedCount('/wedge') === wedgesBefore; i += 1) await wait(10);
        await wait(400);
        ac.abort();
      })();
      const started = Date.now();
      const out = await callAudit(
        { route: '/wedge', viewports: ['phone', 'tablet', 'desktop'], rules: [], capture: true },
        { signal: ac.signal }
      );
      await abortInsideTheWedge;
      for (let i = 0; i < 3000 && lastRun().answeredAt === null; i += 1) await wait(20);
      const settled = lastRun();
      // A few more samples after the answer, so "the window reached zero" is
      // read off the sampler rather than off the moment the poll loop happened
      // to stop. A run that lets go in under one sampling interval otherwise
      // produces no sample at all on the far side of the abort.
      await wait(400);
      watch.stop();
      const delta = deltaAfterAbort(settled);
      const abortedAt = settled.signalFiredAt;
      check('the client is told its cancelled audit was cancelled', out.ok === false && /abort/i.test(out.error + out.message), short(out));
      check(
        `an audit abandoned inside a wedged renderer lets go within ${TOLERANCE_MS}ms of its signal`,
        delta !== null && delta <= TOLERANCE_MS,
        `${delta}ms after the signal (was 14,720-19,713ms); total ${Date.now() - started}ms`
      );
      check('  and says it was cancelled', settled.code === 'cancelled', short({ ok: settled.ok, code: settled.code, message: settled.message }));

      // 5 — no picture is composited for a caller who has gone.
      const lateEncodes = encodes.slice(encodesBefore).filter((e) => e.at > abortedAt);
      check(
        '  and no picture is encoded after the abort',
        lateEncodes.length === 0,
        `${lateEncodes.length} encode(s) after the signal (was 1); ${encodes.length - encodesBefore} in this run`
      );

      // 6 — the checkpoint that already worked, kept honest, and now counted.
      //
      // Three viewports were asked for and each one loads the page once, so the
      // number this run is entitled to is ONE: the viewport that was already
      // loading when the caller left. Two is the second viewport starting after
      // the abort, three is the whole run finishing. That is a claim about
      // viewports; `servedAfter(route, abortedAt) === 0`, which this replaces,
      // was a claim about which side of a timestamp a request happened to fall.
      const wedgeLoads = servedCount('/wedge') - wedgesBefore;
      check(
        '  and no LATER viewport loads the page again: one document served for a three-viewport run',
        wedgeLoads === 1,
        `${wedgeLoads} document request(s) for /wedge, for 3 viewports`
      );
      const firstWedgeAt = wedgeDocAt(wedgesBefore);
      check(
        '  and the abort really did land after that first load, so the case is the one it says it is',
        firstWedgeAt !== null && abortedAt !== null && abortedAt > firstWedgeAt,
        `page served at ${firstWedgeAt}, signal at ${abortedAt}`
      );

      // 4, again, on the case that used to track the wedge exactly.
      const zeroAt = watch.samples.find((s) => s.at > abortedAt && s.live === 0);
      check(
        `  and its window is gone within ${TOLERANCE_MS}ms of the signal`,
        !!zeroAt && zeroAt.at - abortedAt <= TOLERANCE_MS,
        `zero at ${zeroAt ? zeroAt.at - abortedAt : 'never'}ms`
      );
      check('  and Chromium is holding none', BrowserWindow.getAllWindows().length === 0, String(BrowserWindow.getAllWindows().length));
    }

    // ---- 8. THE WIRE ---------------------------------------------------------
    //
    // Counted around one cancelled call and one healthy one, from a proxy that
    // sees the bytes rather than from either end's opinion about them.
    let cancelledBytes = null;
    {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 400);
      const before = proxy.bytes();
      await callAudit({ route: '/wedge', viewports: ['phone'], rules: [] }, { signal: ac.signal });
      for (let i = 0; i < 3000 && lastRun().answeredAt === null; i += 1) await wait(20);
      // A moment for anything the server might still write to arrive.
      await wait(500);
      cancelledBytes = proxy.bytes() - before;
    }
    {
      const before = proxy.bytes();
      const { res } = await callAudit({ route: '/ok', viewports: ['phone'], rules: [] });
      const healthyBytes = proxy.bytes() - before;
      check('a healthy call writes a body', healthyBytes > 500, `${healthyBytes} bytes`);
      check('  and a cancelled one writes none at all', cancelledBytes === 0, `${cancelledBytes} bytes for the cancelled call, ${healthyBytes} for the healthy one`);
      check('  and the healthy one still answers', res?.structuredContent?.ok === true, short(res?.structuredContent));
    }

    // ---- 7. THE QUEUE --------------------------------------------------------
    //
    // Audits are serialised. A run abandoned while it is WAITING does no work —
    // that was already true — but its caller used to be held until the run in
    // front of it finished before being told so.
    {
      const servedBefore = served.length;
      const ac = new AbortController();
      const first = callAudit({ route: '/wedge', viewports: ['phone'], rules: [] });
      // Far enough in that the first run is demonstrably holding the queue: it
      // has served its own document and the renderer is spinning.
      for (let i = 0; i < 500 && served.length === servedBefore; i += 1) await wait(20);
      check('  the run in front is holding the queue open', served.slice(servedBefore).some((x) => x.route === '/wedge'), short(served.slice(servedBefore)));
      await wait(300);
      const runsBefore = runs.length;
      const second = callAudit({ route: '/ok', viewports: ['phone'], rules: [] }, { signal: ac.signal });
      await wait(200);
      const abortAt = Date.now();
      ac.abort();
      const secondOut = await second;
      check('the queued audit is refused', secondOut.ok === false && /abort/i.test(secondOut.error + secondOut.message), short(secondOut));
      // The client is told by its own AbortError, which arrives before the
      // server's handler has returned. What the ENGINE said, and when, is the
      // measurement, so it is waited for rather than sampled at the moment the
      // client gave up.
      const queuedRecord = () => runs.slice(runsBefore).find((r) => r.args?.route === '/ok');
      for (let i = 0; i < 3000 && !(queuedRecord() && queuedRecord().answeredAt !== null); i += 1) await wait(20);
      const queued = queuedRecord();
      check('  and the engine answered it', !!queued && queued.answeredAt !== null, short(queued && { code: queued.code }));
      check(
        `  within ${TOLERANCE_MS}ms of its abort rather than when the run in front finished`,
        !!queued && queued.answeredAt - abortAt <= TOLERANCE_MS,
        `${queued ? queued.answeredAt - abortAt : 'never'}ms after the abort (was 18,600ms)`
      );
      check('  saying it was cancelled', queued?.code === 'cancelled', short(queued && { ok: queued.ok, code: queued.code }));
      check('  and it did no work: the fixture served nothing for it', served.slice(servedBefore).filter((s) => s.route === '/ok').length === 0, short(served.slice(servedBefore)));
      const firstOut = await first;
      check('  while the audit in front of it still finishes', firstOut.ok === true && firstOut.res?.structuredContent?.ok === true, short(firstOut.res?.structuredContent || firstOut));
      check('  and exactly one document was served for the pair', served.slice(servedBefore).filter((s) => s.route === '/wedge' || s.route === '/ok').length === 1, short(served.slice(servedBefore)));
    }

    // ---- A. ALREADY-ABORTED, AND H. A LATE ABORT ----------------------------
    //
    // Both were already true and neither is allowed to stop being true.
    {
      const servedBefore = served.length;
      const ac = new AbortController();
      ac.abort();
      const out = await callAudit({ route: '/ok', viewports: ['phone'], rules: [] }, { signal: ac.signal });
      await wait(300);
      check('a request that arrived already abandoned is refused', out.ok === false, short(out));
      check('  and loads no page at all', served.slice(servedBefore).length === 0, short(served.slice(servedBefore)));
      check('  and opens no window', liveWindowCount() === 0 && BrowserWindow.getAllWindows().length === 0, `${liveWindowCount()} / ${BrowserWindow.getAllWindows().length}`);
    }
    {
      const ac = new AbortController();
      const { ok, res } = await callAudit({ route: '/ok', viewports: ['phone'], rules: [] }, { signal: ac.signal });
      ac.abort();
      await wait(200);
      check('an abort after the answer changes nothing', ok === true && res?.structuredContent?.ok === true, short(res?.structuredContent));
      check('  and leaves no window behind', liveWindowCount() === 0 && BrowserWindow.getAllWindows().length === 0, `${liveWindowCount()} / ${BrowserWindow.getAllWindows().length}`);
    }
  } finally {
    // ---- 9. HYGIENE. Cleanup failure is a test failure. --------------------
    const closed = await closeClient();
    check('the MCP client closed', !closed || closed.ok !== false, short(closed));
    await server.stop?.();
    await proxy.close();
    for (const res of [...hanging]) {
      try {
        res.end('</p></body></html>');
      } catch {
        /* the socket may already be gone; that is the point of the route */
      }
    }
    await new Promise((resolve) => fixture.close(resolve));
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.destroy();
      } catch {
        /* counted below rather than swallowed */
      }
    }
  }

  await wait(300);
  check('no audit window survived the suite', liveWindowCount() === 0, String(liveWindowCount()));
  check('and Chromium is holding none', BrowserWindow.getAllWindows().length === 0, String(BrowserWindow.getAllWindows().length));
  check('no cancel arrived as an unhandled rejection', unhandled.length === 0, short(unhandled));
  check('and the endpoint reported no error', endpointErrors.length === 0, short(endpointErrors));

  finished = true;
  clearTimeout(watchdog);
  if (failures.length) {
    console.error(`audit-cancel-inflight: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    app.exit(1);
    return;
  }
  console.log(`audit-cancel-inflight: ${checked} passed  [a real abort, on a real transport, interrupts real work]`);
  app.exit(0);
})().catch((err) => {
  finished = true;
  clearTimeout(watchdog);
  console.error('audit-cancel-inflight: threw\n', err?.stack || err);
  app.exit(1);
});
