// The share page, watched rather than read.
//
//   npm run test:sharepage
//
// The entire privacy claim of the invitation link rests on one character: the
// `#` that makes the capability a fragment. A fragment is not in the request
// line, not in a Referer, and not in anything a server can log. That is a
// claim about what a BROWSER does, so reading the HTML cannot check it and a
// unit test cannot either.
//
// So this loads the real page, in a real browser engine, from a real HTTP
// server, with a real capability in the fragment — and records every single
// request the page causes, with its headers, and searches all of it for a
// canary that exists nowhere but inside that capability.
//
// It also checks the thing a future edit is most likely to break: that the
// page fetches nothing from anywhere. The Content-Security-Policy is what
// enforces that, so the test asserts the policy AND asserts that no
// cross-origin request happened, which are different statements.

process.env.STACKI_NO_DIALOGS = '1';
process.env.STACKI_HIDDEN_WINDOW = '1';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');

const { packCapability } = require('../electron/review/secure/capability.js');
const { toBase64Url } = require('../relay/protocol.js');
const { createLanding, headersFor } = require('../relay/share/serve.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-sharepage-'));
const relayData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-sharepage-relay-'));
app.setPath('userData', userData);

// The capability this run uses. The room secret is not random: it is a canary,
// so that finding it anywhere at all is unambiguous. It is still 32 bytes.
const CANARY = 'CANARYsecret7d4f1a'.padEnd(32, 'x'); // a room secret is exactly 32 bytes
const SECRET = toBase64Url(Buffer.from(CANARY, 'utf8'));
const INVITE = `CANARYinvite${toBase64Url(crypto.randomBytes(16)).slice(0, 20)}`;
const ROOM_ID = toBase64Url(crypto.randomBytes(16));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// EXACTLY WHAT THE SERVER RECEIVED, which is the only view that settles this.
//
// Electron's own webRequest reports a URL that still has the fragment on it —
// the browser knows the fragment, so its bookkeeping shows it. The wire does
// not carry it. So the request line and the raw headers are recorded here, on
// the server side, where "was it sent" has an answer rather than a model of one.
const received = [];
let server = null;

const stopServer = () =>
  new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

const relayOutput = [];

async function finish(code) {
  // Report before cleaning up, and report on EVERY path out. An early return
  // that exits quietly is a test that fails without saying why, which is how
  // ten minutes go missing.
  if (failures.length) {
    shout(`\nshare-page-privacy: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    code = code || 1;
  }
  if (relayOutput.length) shout(`  the relay said:\n${relayOutput.join('').split('\n').map((l) => `    ${l}`).join('\n')}`);
  const problems = [];
  try {
    await stopServer();
  } catch (err) {
    problems.push(`stopping the page server: ${err.message}`);
  }
  for (const dir of [userData, relayData]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      problems.push(`removing ${dir}: ${err.message}`);
    }
  }
  if (problems.length) {
    shout(`\nshare-page-privacy: could not clean up\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    code = code || 1;
  }
  app.exit(code);
}

app.whenReady().then(async () => {
  try {
    // The page is served by `createLanding` — the same function relay/node/bin.js
    // hands to the relay — so these are the real headers, not a fixture's idea
    // of them. Served from this process so the request line can be recorded.
    const landing = createLanding();
    if (!check('the landing page exists to be served', !!landing)) return finish(1);
    const port = await freePort();
    server = http.createServer((req, res) => {
      received.push({ url: req.url, method: req.method, headers: { ...req.headers }, raw: req.rawHeaders.join('\n') });
      landing(req, res);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${port}`;
    check('the page server is up', server.listening);

    const capability = packCapability({
      relay: origin,
      roomId: ROOM_ID,
      invite: INVITE,
      secret: SECRET,
      expiresAt: Date.now() + 86400000,
    });
    if (!check('the capability was built', !!capability)) return finish(1);
    check('the capability really does contain the canary', capability.includes(toBase64Url(Buffer.from(CANARY, 'utf8')).slice(0, 12)) || Buffer.from(capability.slice(8), 'base64url').toString('utf8').includes(SECRET));

    // --- the headers, from the real server --------------------------------

    const served = await fetch(`${origin}/`);
    check('the page is served', served.ok);
    const csp = served.headers.get('content-security-policy') || '';
    check('nothing may be loaded from anywhere by default', csp.includes("default-src 'none'"), csp);
    check('the one inline script is allowed by hash, not by unsafe-inline', /script-src 'sha256-/.test(csp), csp);
    check('and unsafe-inline is not granted to scripts', !/script-src[^;]*unsafe-inline/.test(csp), csp);
    check('the page cannot be framed', csp.includes("frame-ancestors 'none'"), csp);
    check('there is nowhere to submit to', csp.includes("form-action 'none'"), csp);
    check('and no base tag can move it', csp.includes("base-uri 'none'"), csp);
    check('no referrer is ever sent', served.headers.get('referrer-policy') === 'no-referrer');
    check('the content type is not sniffed', served.headers.get('x-content-type-options') === 'nosniff');
    check('powerful features are switched off', /camera=\(\)/.test(served.headers.get('permissions-policy') || ''));
    check('search engines are told to stay away', /noindex/.test(served.headers.get('x-robots-tag') || ''));
    check('the page is not cached to disk', (served.headers.get('cache-control') || '').includes('no-store'));

    // The hash in the policy is computed from the file, so an edit to the
    // script that forgot to update a constant would break the page rather than
    // silently widen what may run on it.
    const html = await served.clone().text();
    check('the served policy matches the served page', csp === headersFor(html)['content-security-policy'], csp);

    // --- every request the page causes -------------------------------------

    const partition = `share-page-${Date.now()}`;
    const view = session.fromPartition(partition);
    const seen = [];
    view.webRequest.onBeforeSendHeaders((details, callback) => {
      seen.push({ url: details.url, headers: details.requestHeaders || {}, resourceType: details.resourceType });
      callback({ requestHeaders: details.requestHeaders });
    });

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { partition, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });

    // What the app's own protocol handler would receive. Recorded rather than
    // followed, so the click can be observed without launching anything.
    const handedOver = [];
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('http')) {
        event.preventDefault();
        handedOver.push(url);
      }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      handedOver.push(url);
      return { action: 'deny' };
    });

    const target = `${origin}/#${capability}`;
    await win.loadURL(target);
    await wait(900);

    const js = (code) => win.webContents.executeJavaScript(code, true);

    check('the page decided the invitation is readable', await js(`!document.getElementById('ready').classList.contains('hidden')`));
    check('and did not show the unreadable state', await js(`document.getElementById('bad').classList.contains('hidden')`));

    // THE FRAGMENT IS GONE FROM THE VISIBLE URL.
    const afterLoad = await js(`location.href`);
    check('the capability is taken out of the address bar', !afterLoad.includes('stacki2.'), afterLoad);
    check('and the hash is empty', (await js(`location.hash`)) === '', await js(`location.hash`));
    check('while the page still works', await js(`!!document.getElementById('open')`));

    // NOTHING WITH THE CANARY IN IT REACHED THE SERVER.
    //
    // `received` is what arrived on the socket: the request line and the raw
    // headers. This is the assertion the whole design of the link rests on.
    check('the page was actually fetched', received.length >= 1, `${received.length} requests`);
    const canaryBits = [CANARY, SECRET, INVITE, capability, ROOM_ID, 'stacki2.'];
    for (const request of received) {
      for (const bit of canaryBits) {
        check(
          `the request line the server received carries no capability (${request.method} ${request.url})`,
          !request.url.includes(bit),
          `${request.url.slice(0, 140)} contained ${bit.slice(0, 16)}`
        );
        check(
          `no header the server received carries the capability (${request.method} ${request.url})`,
          !request.raw.includes(bit),
          request.raw.slice(0, 200)
        );
      }
      check(
        `no Referer reached the server (${request.method} ${request.url})`,
        !Object.keys(request.headers).some((h) => /^referer$/i.test(h)),
        JSON.stringify(request.headers)
      );
    }
    check('the request line was just the path', received[0]?.url === '/', received[0]?.url);

    // AND NOTHING WENT ANYWHERE ELSE. This one does come from the browser's
    // own view, because "what did the page try to load" is a question about
    // the browser rather than about any one server.
    check('the page caused at least one request', seen.length >= 1, `${seen.length}`);
    const foreign = seen.filter((r) => !r.url.startsWith(origin));
    check('every request the page made went to its own origin', foreign.length === 0, JSON.stringify(foreign.map((f) => f.url)));
    check('and nothing was fetched by script at all', seen.every((r) => r.resourceType !== 'xhr' && r.resourceType !== 'fetch'), JSON.stringify(seen.map((r) => r.resourceType)));

    // --- the one thing the page does ---------------------------------------

    await js(`document.getElementById('open').click()`);
    await wait(600);
    check('clicking Open Stacki hands over exactly one thing', handedOver.length === 1, JSON.stringify(handedOver));
    const handed = handedOver[0] || '';
    check('and it goes to the custom protocol', handed.startsWith('stacki://join#'), handed.slice(0, 40));
    check('carrying the capability', handed.includes(capability), handed.slice(0, 40));
    check('and nothing else', handed === `stacki://join#${capability}`);

    const afterClick = received.length;
    await wait(400);
    check('and reaches no server', received.length === afterClick, JSON.stringify(received.slice(afterClick).map((r) => r.url)));

    // --- a link that is not an invitation ----------------------------------

    const other = new BrowserWindow({ show: false, webPreferences: { partition, backgroundThrottling: false } });
    await other.loadURL(`${origin}/#stacki2.not-a-real-capability`);
    await wait(600);
    const badJs = (code) => other.webContents.executeJavaScript(code, true);
    check('a malformed capability shows the unreadable state', await badJs(`!document.getElementById('bad').classList.contains('hidden')`));
    check('and does not offer to open Stacki', await badJs(`document.getElementById('ready').classList.contains('hidden')`));
    check('and still clears the address bar', (await badJs(`location.hash`)) === '');
    other.destroy();

    // A page opened with no fragment at all is not a crash.
    const bare = new BrowserWindow({ show: false, webPreferences: { partition, backgroundThrottling: false } });
    await bare.loadURL(`${origin}/`);
    await wait(500);
    check('a page with no invitation says so', await bare.webContents.executeJavaScript(`!document.getElementById('bad').classList.contains('hidden')`, true));
    bare.destroy();

    win.destroy();
  } catch (err) {
    shout(`share-page-privacy: threw\n${err?.stack || err}`);
    failures.push(`  the run did not finish: ${err?.message || err}`);
  }

  if (failures.length) return finish(1);
  say(`share-page-privacy: ${checked} checks passed  [a real browser, every request watched]`);
  return finish(0);
});
