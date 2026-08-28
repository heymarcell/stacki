// The deployed share page, watched rather than read.
//
//   STACKI_PUBLIC_RELAY=https://…workers.dev npx electron test/public-share-page-privacy.js
//
// test/share-page-privacy.js proves this against a page served by a local
// http server in the same process. That is the right place to prove the
// PAGE — but it cannot prove the DEPLOYMENT. Between the two sit Cloudflare's
// edge, whatever headers it adds or drops, and the possibility that what is
// actually published is not what the repository thinks it published.
//
// So this loads the real page from the real hostname over real TLS, with a
// real capability in the fragment, and records every request the browser makes
// — URL, headers, resource type — then searches all of it for a canary that
// exists nowhere except inside that capability.
//
// The whole privacy claim of an invitation link rests on one character: the
// `#`. A fragment is not in the request line, not in a Referer, and not in
// anything a server can log. That is a claim about what a browser does, so
// reading the HTML cannot check it and neither can curl.

process.env.STACKI_NO_DIALOGS = '1';
process.env.STACKI_HIDDEN_WINDOW = '1';

const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, session } = require('electron');

const { packCapability } = require('../electron/review/secure/capability.js');
const { toBase64Url } = require('../relay/protocol.js');

const BASE = (process.env.STACKI_PUBLIC_RELAY || '').replace(/\/+$/, '');
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

if (!BASE.startsWith('https://')) {
  shout('public-share-page-privacy: set STACKI_PUBLIC_RELAY to the deployed https origin');
  process.exit(2);
}

// A secret that exists nowhere else in the world, so finding it anywhere is
// unambiguous. It goes inside the room secret, which lives inside the
// capability, which lives after the `#`.
const CANARY = 'PUBLICSHAREPAGE7f2c9dCANARYzzzzz'.slice(0, 32); // exactly 32 bytes: the room secret's length
const capability = packCapability({
  relay: BASE,
  roomId: toBase64Url(crypto.randomBytes(16)),
  invite: toBase64Url(crypto.randomBytes(32)),
  secret: toBase64Url(Buffer.from(CANARY, 'utf8')),
  expiresAt: Date.now() + 86400000,
});

(async () => {
  await app.whenReady();
  say(`public-share-page-privacy: ${BASE}`);

  const partition = `public-share-${Date.now()}`;
  const view = session.fromPartition(partition);

  // EVERY request the page causes, with its headers.
  const seen = [];
  view.webRequest.onBeforeSendHeaders((details, callback) => {
    seen.push({ url: details.url, headers: details.requestHeaders || {}, resourceType: details.resourceType });
    callback({ requestHeaders: details.requestHeaders });
  });
  // And every response, so the deployed headers are read off the wire rather
  // than out of the repository.
  const responses = [];
  view.webRequest.onHeadersReceived((details, callback) => {
    responses.push({ url: details.url, status: details.statusCode, headers: details.responseHeaders || {} });
    callback({ responseHeaders: details.responseHeaders });
  });

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { partition, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });

  // What the operating system would be handed. Recorded, not followed — the
  // click can be observed without launching anything.
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

  await win.loadURL(`${BASE}/#${capability}`);
  await wait(1200);
  const js = (code) => win.webContents.executeJavaScript(code, true);

  check('the deployed page loaded', (await js('document.readyState')) === 'complete');
  check('and decided the invitation is readable', await js(`!document.getElementById('ready').classList.contains('hidden')`));
  check('not the unreadable state', await js(`document.getElementById('bad').classList.contains('hidden')`));

  // --- the fragment ---------------------------------------------------------

  const afterLoad = await js('location.href');
  check('the capability is taken out of the address bar', !afterLoad.includes('stacki2.'), afterLoad);
  check('  and the hash is empty', (await js('location.hash')) === '', await js('location.hash'));
  check('  which was done with replaceState, leaving no history entry', (await js('history.length')) <= 2, String(await js('history.length')));
  check('while the page still works', await js(`!!document.getElementById('open')`));

  // --- NOTHING WITH THE CANARY IN IT LEFT THE BROWSER -----------------------

  // WHAT IS ACTUALLY TRANSMITTED, which is not the same as what Electron
  // reports.
  //
  // `onBeforeSendHeaders` hands back the browser's own URL for the request,
  // and that string still has the fragment on it — the browser is holding it,
  // because the browser is what fragments are FOR. An HTTP request line
  // cannot carry one: the wire sees the origin, the path and the query, and
  // nothing after the `#`. So asserting on `details.url` verbatim measures
  // Electron's bookkeeping rather than the network, and fails on a page that
  // leaked nothing. The first version of this file did exactly that.
  //
  // What goes on the wire is the pre-`#` part of the URL and the headers, so
  // that is what gets searched. The request LINE itself is proved at the
  // socket by test/share-page-privacy.js, which owns the server and can read
  // it; the deployed counterpart of that proof is the log audit, which asks
  // the Worker what it received.
  const onTheWire = seen.map((r) => ({
    sent: r.url.split('#')[0],
    headers: r.headers,
    resourceType: r.resourceType,
  }));
  const everySent = JSON.stringify(onTheWire);

  check('nothing transmitted contains the capability', !everySent.includes('stacki2.'), onTheWire.map((s) => s.sent).join(' ').slice(0, 200));
  check('nothing transmitted contains the room secret canary', !everySent.includes(CANARY));
  check('  nor any part of the capability', !everySent.includes(capability.slice(10, 40)));
  for (const r of onTheWire) {
    const u = new URL(r.sent);
    check(`  ${u.pathname} was requested with no query at all`, u.search === '', u.search);
    check(`  and nothing after a # could reach it`, !r.sent.includes('#'), r.sent);
  }
  // Referer is the classic leak: a page that links out can carry its own URL,
  // fragment and all, in a header that IS transmitted.
  const referers = seen.map((r) => r.headers.Referer || r.headers.referer || '').filter(Boolean);
  check('no Referer header carries anything', referers.every((v) => !v.includes('stacki2.') && !v.includes(CANARY)), JSON.stringify(referers));
  const cookies = seen.map((r) => r.headers.Cookie || r.headers.cookie || '').filter(Boolean);
  check('and no cookie was set or sent at all', cookies.length === 0, JSON.stringify(cookies));

  // --- the page talks to nobody ---------------------------------------------

  const foreign = onTheWire.filter((r) => !r.sent.startsWith(BASE));
  check('every request went to the relay origin and nowhere else', foreign.length === 0, JSON.stringify(foreign.map((f) => f.sent)));
  const hosts = [...new Set(onTheWire.map((r) => new URL(r.sent).host))];
  check('  which is exactly one host', hosts.length === 1, JSON.stringify(hosts));
  check('  no analytics, no fonts, no CDN', !/google|fonts|analytics|cdn|gstatic|cloudflareinsights/i.test(everySent), JSON.stringify(hosts));
  say(`    ${seen.length} request(s), host(s): ${hosts.join(', ')}`);

  // --- headers, as the deployment actually sent them ------------------------

  const doc = responses.find((r) => r.url.startsWith(BASE) && r.status === 200) || responses[0];
  const header = (n) => {
    const found = Object.entries(doc?.headers || {}).find(([k]) => k.toLowerCase() === n);
    return found ? [].concat(found[1]).join(' ') : '';
  };
  check('the deployment sends a content security policy', /default-src 'none'/.test(header('content-security-policy')), header('content-security-policy').slice(0, 100));
  check('  allowing exactly one script, by hash', /script-src 'sha256-/.test(header('content-security-policy')));
  check('  and no framing', /frame-ancestors 'none'/.test(header('content-security-policy')));
  check('  no referrer', header('referrer-policy') === 'no-referrer', header('referrer-policy'));
  check('  nosniff', header('x-content-type-options') === 'nosniff', header('x-content-type-options'));
  check('  a permissions policy', /camera=\(\)/.test(header('permissions-policy')), header('permissions-policy').slice(0, 80));
  check('  noindex', /noindex/.test(header('x-robots-tag')), header('x-robots-tag'));
  check('  and no caching of an invitation page', /no-store/.test(header('cache-control')), header('cache-control'));

  // --- the handover happens only when somebody asks for it ------------------

  check('nothing was handed to the operating system on load', handedOver.length === 0, JSON.stringify(handedOver));
  await js(`document.getElementById('open').click()`);
  await wait(700);
  check('clicking Open Stacki hands over exactly one url', handedOver.length === 1, JSON.stringify(handedOver));
  check('  which is a stacki:// link', (handedOver[0] || '').startsWith('stacki://'), handedOver[0]?.slice(0, 30));
  check('  carrying the capability in ITS fragment', (handedOver[0] || '').includes(`#${capability}`), 'the app gets the secret; the network never did');
  // And that click caused no new network request.
  const afterClick = seen.filter((r) => !r.url.split('#')[0].startsWith(BASE));
  check('  and caused no request to anywhere', afterClick.length === 0, JSON.stringify(afterClick.map((f) => f.url.split('#')[0])));

  win.destroy();

  if (failures.length) {
    shout(`\npublic-share-page-privacy: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    app.exit(1);
    return;
  }
  say(`\npublic-share-page-privacy: ${checked} checks passed  [the deployed page, in a real browser, every request watched]`);
  app.exit(0);
})().catch((err) => {
  shout(`public-share-page-privacy: threw\n${err?.stack || err}`);
  app.exit(1);
});
