// From a page on the internet into an app on this Mac.
//
//   STACKI_PUBLIC_RELAY=https://…workers.dev npx electron test/public-deeplink.js
//
// test/packaged-deeplink.js proves the packaged half: hand macOS a
// `stacki://` URL and the bundle answers. It builds that URL itself, from a
// capability it invented, for a relay that does not exist. Everything about
// the bundle is real and nothing about the invitation is.
//
// This starts at the other end. A room is created on the DEPLOYED relay over
// real HTTPS, a real invitation is minted through the real protocol, the
// PUBLIC share page is loaded in a browser with that invitation in its
// fragment, and the URL handed to the operating system is the one that page's
// own button produced — not one this file wrote. Then macOS routes it, the
// packaged app receives it, and the confirmation is read out of the real
// renderer.
//
// The chain, with nothing simulated in the middle:
//
//   Cloudflare Worker  → invitation
//   public share page  → Open Stacki
//   Launch Services    → the bundle
//   packaged Stacki    → a person is asked

//   node test/public-deeplink.js        (plain node — it needs global WebSocket)
//
// TWO RUNTIMES, ON PURPOSE. Loading a real page needs Chromium; driving the
// packaged app over the DevTools protocol needs a global `WebSocket`, which
// the Node that Electron bundles (20.x) does not have. So the browser half is
// a small Electron helper this file spawns, and everything else runs here.

process.env.STACKI_NO_DIALOGS = '1';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn, spawnSync } = require('child_process');

const { usePublicNetwork } = require('./support/publicFetch.js');
const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');
const { toBase64Url } = require('../relay/protocol.js');

usePublicNetwork();

const BASE = (process.env.STACKI_PUBLIC_RELAY || '').replace(/\/+$/, '');
const root = path.join(__dirname, '..');
const APP = path.join(root, 'release', 'mac-universal', 'Stacki.app');

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

async function until(what, timeout, fn, every = 300) {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) return null;
    await wait(every);
  }
}

if (process.platform !== 'darwin') {
  say('public-deeplink: skipped (this is the macOS Launch Services path)');
  process.exit(0);
}
if (!BASE.startsWith('https://')) {
  shout('public-deeplink: set STACKI_PUBLIC_RELAY to the deployed https origin');
  process.exit(2);
}
if (!fs.existsSync(APP)) {
  shout(`public-deeplink: ${path.relative(root, APP)} is not built — run npm run dist:mac:unsigned`);
  process.exit(1);
}

const userData = ownedTempDir('stacki-publicdeeplink-', { harness: 'public-deeplink' });
let child = null;
let owned = null; // { roomId, token } to clean up

/** A tiny CDP client — enough to ask the packaged renderer one question. */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* closing */
      }
      reject(new Error('devtools did not answer'));
    }, 15000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(msg.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('devtools socket failed'));
    });
  });
}

(async () => {
  say(`public-deeplink: ${BASE}`);

  // --- 1. a real room and a real invitation, on the deployed relay ---------

  const b64 = (b) => toBase64Url(b);
  const roomId = b64(crypto.randomBytes(16));
  const senderId = b64(crypto.randomBytes(32));
  const publicKey = b64(crypto.randomBytes(32));

  const made = await fetch(`${BASE}/v2/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, senderId, publicKey }),
    signal: AbortSignal.timeout(20000),
  });
  const madeBody = await made.json().catch(() => null);
  check('a room was created on the deployed relay', made.status === 200 && !!madeBody?.credential?.token, `http ${made.status}`);
  const token = madeBody?.credential?.token;
  if (token) owned = { roomId, token };

  const invited = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(roomId)}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20000),
  });
  const invitedBody = await invited.json().catch(() => null);
  check('and a real invitation was minted through the protocol', invited.status === 200 && typeof invitedBody?.invite === 'string', `http ${invited.status}`);

  // The capability a real client would build: this relay, this room, this
  // invitation, and a room secret only the two ends ever see.
  const CANARY = 'PUBLICDEEPLINK4a7bCANARYzzzzzzzz'.slice(0, 32);
  const { packCapability } = require('../electron/review/secure/capability.js');
  const capability = packCapability({
    relay: BASE,
    roomId,
    invite: invitedBody.invite,
    secret: toBase64Url(Buffer.from(CANARY, 'utf8')),
    expiresAt: Date.now() + 86400000,
  });
  check('which packs into a capability', typeof capability === 'string' && capability.startsWith('stacki2.'), String(capability).slice(0, 20));

  // --- 2. the PUBLIC page decides what to hand the operating system --------
  //
  // A real Chromium loads the deployed page with this capability in its
  // fragment and clicks the button. Whatever url that produces is what the
  // operating system gets — this file does not write it.

  const handover = spawnSync(
    path.join(root, 'node_modules', '.bin', 'electron'),
    [path.join(__dirname, 'support', 'publicPageHandover.js')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, STACKI_PUBLIC_RELAY: BASE, STACKI_CAPABILITY: capability },
    }
  );
  let page = null;
  for (const line of (handover.stdout || '').split('\n')) {
    if (line.trim().startsWith('{')) {
      try {
        page = JSON.parse(line);
      } catch {
        /* not the line we want */
      }
    }
  }
  check('the browser half reported back', !!page, (handover.stdout || handover.stderr || '').slice(-300));
  check('the deployed page read the invitation', page?.readable === true, JSON.stringify(page).slice(0, 160));
  check('  and stripped the capability out of its own address bar', !String(page?.hrefAfter || '').includes('stacki2.') && page?.hashAfter === '', String(page?.hrefAfter).slice(0, 90));

  const handedOver = page?.handedOver || [];
  check('its own button produced exactly one stacki:// url', handedOver.length === 1 && String(handedOver[0]).startsWith('stacki://join#'), JSON.stringify(handedOver).slice(0, 80));
  const fromThePage = handedOver[0];
  check('  carrying the capability the deployed relay issued', String(fromThePage).includes(capability), 'the page built this url, not this test');

  // --- 3. macOS routes it to the packaged bundle ---------------------------

  const port = 9500 + (process.pid % 400);
  child = spawn(path.join(APP, 'Contents', 'MacOS', 'Stacki'), [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env: { ...process.env, STACKI_NO_DIALOGS: '1', STACKI_HIDDEN_WINDOW: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appOutput = [];
  child.stdout?.on('data', (d) => appOutput.push(String(d)));
  child.stderr?.on('data', (d) => appOutput.push(String(d)));

  const target = await until('the packaged app to expose a renderer', 40000, async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      return (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch {
      return null;
    }
  });
  if (!check('the packaged app came up', !!target, appOutput.join('').slice(-300))) return finish(1);
  const ws = target.webSocketDebuggerUrl;
  await until('its renderer to finish loading', 60000, async () => {
    try {
      return (await evaluate(ws, 'document.readyState === "complete"')) === true;
    } catch {
      return false;
    }
  });

  check('a fresh userData means no project is open', true);
  check('and no join dialog is showing yet', (await evaluate(ws, `!!document.querySelector('.share-dialog')`)) === false);

  // THE HANDOVER. The url is the page's, the routing is the operating
  // system's, and the bundle is the built one.
  execFileSync('open', ['-a', APP, fromThePage], { encoding: 'utf8', timeout: 20000 });

  const dialog = await until('the join confirmation', 30000, async () => {
    try {
      return (await evaluate(ws, `(() => { const d = document.querySelector('.share-dialog'); return d ? d.textContent : null; })()`)) || null;
    } catch {
      return null;
    }
  });
  check('the packaged app asked about the invitation', !!dialog, dialog === null ? 'no dialog appeared' : String(dialog).slice(0, 100));
  check('  asking, not joining', typeof dialog === 'string' && /Join shared comments/i.test(dialog), String(dialog).slice(0, 120));
  check('  and it says there is no project open to join into', typeof dialog === 'string' && /No project open/i.test(dialog), String(dialog).slice(0, 200));

  // The secret went to the app, and nowhere the app could show it.
  check('the dialog does not contain the capability', typeof dialog === 'string' && !dialog.includes(capability));
  check('nor the room secret inside it', typeof dialog === 'string' && !dialog.includes(CANARY));
  const anywhere = await evaluate(ws, `document.documentElement.innerHTML.includes(${JSON.stringify(capability.slice(0, 40))})`);
  check('and it is nowhere in the rendered document', anywhere === false);
  const logged = appOutput.join('');
  check('nor in anything the app printed', !logged.includes(capability) && !logged.includes(CANARY), logged.slice(-160));

  await finish(0);
})().catch(async (err) => {
  shout(`public-deeplink: threw\n${err?.stack || err}`);
  failures.push(`  the run did not finish: ${err?.message || err}`);
  await finish(1);
});

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  const problems = [];

  // End the room this test made on the real service.
  if (owned) {
    try {
      const gone = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(owned.roomId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${owned.token}` },
        signal: AbortSignal.timeout(20000),
      });
      const after = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(owned.roomId)}`, {
        headers: { authorization: `Bearer ${owned.token}` },
        signal: AbortSignal.timeout(20000),
      });
      check('the room this test created was ended on the relay', gone.status === 200 && after.status !== 200, `end ${gone.status}, after ${after.status}`);
    } catch (err) {
      problems.push(`ending the room: ${err.message}`);
    }
  }

  try {
    if (child && child.exitCode === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([gone, wait(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      await wait(500);
    }
  } catch (err) {
    problems.push(`stopping the app: ${err.message}`);
  }
  if (!releaseTempDir(userData)) problems.push('the userData directory would not go');

  if (problems.length) {
    shout(`\npublic-deeplink: could not clean up\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    code = code || 1;
  }
  if (failures.length) {
    shout(`\npublic-deeplink: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    code = code || 1;
  } else if (!code) {
    say(`\npublic-deeplink: ${checked} checks passed  [deployed relay → public page → Launch Services → packaged app]`);
  }
  process.exit(code);
}
