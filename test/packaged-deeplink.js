// The join link, through the operating system, into the packaged app.
//
//   npm run test:packageddeeplink
//
// Everything else about the deep link is tested against the source: that the
// capability parser refuses hostile input, that the handler cannot run a
// shell. None of that proves the thing a person actually does, which is click
// a link in a browser and have Stacki come up.
//
// That path is:
//
//     open "stacki://join#..."
//         ↓  Launch Services, which will only route the scheme if the app
//         ↓  BUNDLE declares it — a runtime setAsDefaultProtocolClient call
//         ↓  cannot make an unlaunched app reachable
//     Stacki.app
//         ↓  main process `open-url`
//         ↓  capability validation
//     a dialog asking a person
//
// So this drives the REAL packaged application, hands the URL to the REAL
// `open` command, and then looks inside the REAL renderer to see whether the
// confirmation appeared. Calling handleJoinUrl() directly would prove none of
// it, and neither would grepping Info.plist alone: the plist says the app is
// willing, and only the round trip says it works.
//
// The window is never shown (STACKI_HIDDEN_WINDOW), so running this does not
// take the screen from whoever started it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

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

async function until(what, timeout, fn, every = 250) {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) return null;
    await wait(every);
  }
}

if (process.platform !== 'darwin') {
  say('packaged-deeplink: skipped (this proof is the macOS Launch Services path)');
  process.exit(0);
}
if (!fs.existsSync(APP)) {
  shout(`packaged-deeplink: ${path.relative(root, APP)} is not built.`);
  shout('Run `npm run dist:mac:unsigned` first — this test is about the packaged app.');
  process.exit(1);
}

const { packCapability } = require('../electron/review/secure/capability.js');
const { toBase64Url } = require('../relay/protocol.js');
const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');

// A capability that exists nowhere else, so finding it anywhere is unambiguous.
// The relay it names is never contacted: this test stops at the confirmation.
const CANARY = 'PKGDEEPLINK7d4f1acanaryXXXXXXXXX'.slice(0, 32);
const capability = packCapability({
  relay: 'https://relay.invalid.test',
  roomId: toBase64Url(crypto.randomBytes(16)),
  invite: toBase64Url(crypto.randomBytes(32)),
  secret: toBase64Url(Buffer.from(CANARY, 'utf8')),
  expiresAt: Date.now() + 86400000,
});

// --- a very small CDP client ------------------------------------------------
//
// Enough to ask the renderer one question. The packaged app is a black box
// otherwise: there is no test hook in it and there should not be one.

async function pageTarget(port) {
  const list = await until('the devtools target list', 30000, async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const targets = await res.json();
      return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch {
      return null;
    }
  });
  return list;
}

/** Evaluate an expression in the renderer and return its value. */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      reject(new Error('devtools did not answer'));
    }, 15000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('devtools socket failed'));
    });
  });
}

const userData = ownedTempDir('stacki-pkgdeeplink-', { harness: 'packaged-deeplink' });
let child = null;

async function stopApp() {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([gone, wait(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await wait(500);
}

async function finish(code) {
  const problems = [];
  try {
    await stopApp();
  } catch (err) {
    problems.push(`stopping the app: ${err.message}`);
  }
  // Anything the packaged app may still be holding under this userData.
  if (!releaseTempDir(userData)) problems.push('the userData directory would not go');
  if (problems.length) {
    shout(`\npackaged-deeplink: could not clean up\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    code = code || 1;
  }
  if (failures.length) {
    shout(`\npackaged-deeplink: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    code = code || 1;
  } else if (!code) {
    say(`packaged-deeplink: ${checked} checks passed  [the real bundle, the real open(1), the real renderer]`);
  }
  process.exit(code);
}

async function main() {
  // --- what the bundle tells the operating system --------------------------
  //
  // Read from the built app, not from package.json. A configuration that does
  // not survive into the bundle is a configuration that does nothing.

  const plistJson = execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(APP, 'Contents', 'Info.plist')], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const plist = JSON.parse(plistJson);
  const urlTypes = plist.CFBundleURLTypes || [];
  check('the packaged bundle declares URL types at all', Array.isArray(urlTypes) && urlTypes.length > 0, JSON.stringify(urlTypes));
  const stacki = urlTypes.find((t) => (t.CFBundleURLSchemes || []).includes('stacki'));
  check('and one of them is the stacki scheme', !!stacki, JSON.stringify(urlTypes));
  check('declared with a name a person could recognise', typeof stacki?.CFBundleURLName === 'string' && stacki.CFBundleURLName.length > 3, stacki?.CFBundleURLName);
  // Narrow on purpose: this app answers for exactly one scheme.
  const everyScheme = urlTypes.flatMap((t) => t.CFBundleURLSchemes || []);
  check('and it is the only scheme the bundle claims', everyScheme.length === 1 && everyScheme[0] === 'stacki', JSON.stringify(everyScheme));

  // --- the real path -------------------------------------------------------

  const port = 9333 + (process.pid % 500);
  child = spawn(path.join(APP, 'Contents', 'MacOS', 'Stacki'), [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env: { ...process.env, STACKI_NO_DIALOGS: '1', STACKI_HIDDEN_WINDOW: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appOutput = [];
  child.stdout?.on('data', (d) => appOutput.push(String(d)));
  child.stderr?.on('data', (d) => appOutput.push(String(d)));
  child.on('error', (err) => appOutput.push(`spawn failed: ${err.message}\n`));

  const target = await pageTarget(port);
  if (!check('the packaged app came up with a renderer to inspect', !!target, appOutput.join('').slice(-500))) return finish(1);

  const ws = target.webSocketDebuggerUrl;
  const ready = await until('the renderer to finish loading', 60000, async () => {
    try {
      return (await evaluate(ws, 'document.readyState === "complete" && !!document.body')) === true;
    } catch {
      return false;
    }
  });
  check('and the renderer is loaded', !!ready);

  const before = await evaluate(ws, `!!document.querySelector('.share-dialog')`);
  check('no join dialog is open before the link arrives', before === false);

  // THE OPERATING SYSTEM DELIVERS IT. `open -a` addresses this bundle, and
  // Launch Services still consults the bundle's own Info.plist for the scheme —
  // which is what makes this a test of the packaging and not only of the
  // handler.
  let opened = true;
  let openError = '';
  try {
    execFileSync('open', ['-a', APP, `stacki://join#${capability}`], { encoding: 'utf8', timeout: 20000 });
  } catch (err) {
    opened = false;
    openError = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`.slice(0, 300);
  }
  check('the operating system accepted the stacki:// URL for this bundle', opened, openError);

  const appeared = await until('the join confirmation', 25000, async () => {
    try {
      return (await evaluate(ws, `(() => {
        const d = document.querySelector('.share-dialog');
        return d ? d.textContent : null;
      })()`)) || null;
    } catch {
      return null;
    }
  });
  check('a join confirmation appeared in the packaged app', !!appeared, appeared === null ? 'no dialog' : String(appeared).slice(0, 120));
  check('and it is asking, not joining', typeof appeared === 'string' && /Join shared comments/i.test(appeared), String(appeared).slice(0, 160));

  // The capability stays in the main process. The renderer is told what the
  // invitation is FOR, never what it contains.
  check('the dialog does not contain the capability', typeof appeared === 'string' && !appeared.includes(capability));
  check('nor the room secret inside it', typeof appeared === 'string' && !appeared.includes(CANARY));
  const anywhere = await evaluate(ws, `document.documentElement.innerHTML.includes(${JSON.stringify(capability.slice(0, 40))})`);
  check('and the capability is nowhere in the rendered document', anywhere === false);

  // --- the narrowness of the protocol --------------------------------------
  //
  // `join` is the only thing it does. Another action is refused before the
  // capability is even looked at, so nothing is put on screen.

  await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.share-dialog button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); return true; })()`);
  await wait(600);
  check('the confirmation can be dismissed', (await evaluate(ws, `!!document.querySelector('.share-dialog')`)) === false);

  for (const [what, url] of [
    ['another action', `stacki://run#${capability}`],
    ['no action', `stacki://#${capability}`],
    ['a legacy capability', 'stacki://join#stacki1.abc'],
    ['a malformed capability', 'stacki://join#stacki2.not-real'],
  ]) {
    try {
      execFileSync('open', ['-a', APP, url], { encoding: 'utf8', timeout: 20000 });
    } catch {
      /* the OS refusing outright is also an acceptable answer */
    }
    await wait(1200);
    const shown = await evaluate(ws, `!!document.querySelector('.share-dialog')`);
    check(`a link with ${what} puts nothing on screen`, shown === false);
  }

  // Nothing about any of this wrote a secret where it could be read later.
  const stored = fs.existsSync(path.join(userData, 'secure-rooms.json'))
    ? fs.readFileSync(path.join(userData, 'secure-rooms.json'), 'utf8')
    : '';
  check('an offered invitation is not stored anywhere until it is accepted', !stored.includes(CANARY), stored.slice(0, 120));
  const logged = appOutput.join('');
  check('and nothing about it reaches the app’s own output', !logged.includes(capability) && !logged.includes(CANARY), logged.slice(-200));

  return finish(0);
}

main().catch(async (err) => {
  shout(`packaged-deeplink: threw\n${err?.stack || err}`);
  failures.push(`  the run did not finish: ${err?.message || err}`);
  await finish(1);
});
