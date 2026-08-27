// Look at Secure Share. Actually look at it.
//
//   npm run test:secureshareui        [outDir]
//
// A DOM snapshot cannot tell you that a dialog is taller than a 665px laptop
// display, that "Sharing paused" and its explanation collide, that the Advanced
// disclosure pushes the buttons off the bottom, or that a relay hostname
// overflows its row. Those are the things this feature can plausibly get
// wrong, so they have to be seen — at every window size somebody actually uses.
//
// EVERY STATE ASSERTS BEFORE IT IS PHOTOGRAPHED. A screenshot named
// "offline-pending" that is really a picture of a healthy share is worse than
// no screenshot, because it is evidence that the state was reached. So each
// capture names the thing that must be on screen, checks it, and a mandatory
// state that cannot be reached FAILS THE RUN rather than being skipped.
//
// It drives the shipped main process, against a real relay on a real port, in
// a window that is never shown — see electron/main.js. Running this does not
// take the screen or the keyboard from whoever started it.

process.env.STACKI_NO_DIALOGS = '1';
process.env.STACKI_HIDDEN_WINDOW = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'stacki-secure-share-ux');

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

async function until(what, fn, { timeout = 120000, every = 200 } = {}) {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await wait(every);
  }
}
/** The same, where not arriving is a finding rather than a crash. */
until.soft = async (what, timeout, fn, every = 200) => {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) return null;
    await wait(every);
  }
};

app.on('window-all-closed', () => {});

if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  say('secure-share-visual: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

sweepStaleRuns(['stacki-share-ux-user-', 'stacki-canvas-']);

const root = makeCanvasProject({ log: (m) => say(`secure-share-visual: ${m}`) });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-share-ux-user-'));
app.setPath('userData', userData);
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(root)]: 'edit' } }, null, 2),
  'utf8'
);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

// The relays run as CHILD PROCESSES, which is what they are.
//
// Not a design flourish: both use `node:sqlite`, and the Node that Electron
// bundles does not have it. Running them in this process fails at require
// time. That is the right answer anyway — a relay is a program somebody runs
// on a machine of their own, and this harness now proves the desktop app works
// against one over a real socket rather than against a library it linked.

const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SIGNUP = 'a-signup-token-long-enough';
const children = [];
const relayData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-share-ux-relay-'));

/**
 * Free ports, synchronously.
 *
 * Synchronously because `electron/main.js` registers a privileged scheme and
 * so has to be required before the app is ready — which means the relay's
 * address has to be known at module scope, before anything can be awaited. A
 * throwaway node process is the least clever way to ask the operating system
 * for a port and give it straight back.
 */
function freePorts(n) {
  const script = `const net=require('net');const out=[];let left=${n};
    const one=()=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{out.push(s.address().port);
    s.close(()=>{ if(--left) one(); else console.log(out.join(' ')); });});};one();`;
  return execFileSync('node', ['-e', script], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
}

const [RELAY_PORT, LEGACY_PORT] = freePorts(2);

/**
 * Start one of the relay programs.
 *
 * They run as CHILD PROCESSES, which is what they are — and not by choice
 * alone: both use `node:sqlite`, and the Node that Electron bundles does not
 * have it. That is the right shape anyway. A relay is a program somebody runs
 * on a machine of their own, and this harness now proves the desktop app works
 * against one over a real socket rather than against a library it linked.
 *
 * `node` off the PATH rather than `process.execPath`, which is Electron.
 */
function startProgram(script, env) {
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.on('error', (err) => shout(`  a relay program could not start: ${err.message}`));
  return child;
}

/** Wait for one to answer, or say which one did not. */
async function waitForHealth(label, port) {
  const alive = await until.soft(`${label} on ${port}`, 25000, async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) })).ok;
    } catch {
      return false;
    }
  });
  if (!alive) throw new Error(`${label} never answered on port ${port}`);
}

/** Stop one, and wait for the port to actually be free again. */
async function stopProgram(child) {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([gone, wait(4000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await wait(300);
}

const secureEnv = () => ({ STACKI_RELAY_PORT: String(RELAY_PORT), STACKI_RELAY_DATA: path.join(relayData, 'secure') });
let relayChild = startProgram('relay/node/bin.js', secureEnv());
const legacyChild = startProgram('service/bin.js', {
  STACKI_REVIEWS_PORT: String(LEGACY_PORT),
  STACKI_REVIEWS_DATA: path.join(relayData, 'legacy'),
  STACKI_REVIEWS_SIGNUP_TOKEN: SIGNUP,
});

// Before main.js, so the default relay is this run's relay and no dialog ever
// has to be told about it. That is the flow being photographed: a person who
// never opens Advanced never sees a relay address.
process.env.STACKI_SECURE_RELAY = `http://127.0.0.1:${RELAY_PORT}`;

const mcp = require('../electron/mcp');
const reviews = require('../electron/review');
require('../electron/main.js');

/** Take the relay away, and bring it back on the address the app already knows. */
const stopRelay = () => stopProgram(relayChild);
async function restartRelay({ fresh = false } = {}) {
  await stopRelay();
  if (fresh) fs.rmSync(path.join(relayData, 'secure'), { recursive: true, force: true });
  relayChild = startProgram('relay/node/bin.js', secureEnv());
  await waitForHealth('the secure relay', RELAY_PORT);
  return relayChild;
}

/** Stop, then leave — and fail if anything could not be stopped. */
async function teardown(code) {
  const problems = [];
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      problems.push(`${what}: ${String(err?.message || err)}`);
    }
  };

  await attempt('stopping the preview', async () => {
    const status = mcp.status();
    if (!status?.running || !status.url || !status.token) return;
    const call = async (args) => {
      const res = await fetch(status.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${status.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'tools/call', params: { name: 'project', arguments: args } }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
      try {
        return JSON.parse(line.replace(/^data:\s*/, ''))?.result?.structuredContent || null;
      } catch {
        return null;
      }
    };
    await call({ action: 'dev_stop' });
  });
  await attempt('stopping mcp', () => mcp.stopMcp());
  await attempt('stopping the relay programs', async () => {
    for (const child of children) await stopProgram(child);
    const still = children.filter((c) => c.exitCode === null && !c.killed);
    if (still.length) throw new Error(`${still.length} relay process(es) would not stop`);
  });
  await attempt('removing relay data', () => fs.rmSync(relayData, { recursive: true, force: true }));
  await attempt('removing the project', () => removeCanvasProject(root));
  await attempt('removing userData', () => fs.rmSync(userData, { recursive: true, force: true }));

  if (problems.length) {
    shout(`\nsecure-share-visual: could not clean up\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    code = code || 1;
  }
  app.exit(code);
}

// Every state this run must produce. A missing one is a failure, not a gap —
// see the note at the top.
const REQUIRED = [
  'local-only',
  'create-no-comments',
  'create-with-comments',
  'creating',
  'invite-created',
  'invite-copied',
  'shared-healthy',
  'offline-pending',
  'sharing-paused',
  'manage',
  'invite-another',
  'join-confirm',
  'join-no-project',
  'join-expired',
  'join-used',
  'access-lost',
  'advanced-relay',
  'legacy-workspace',
];

const taken = new Set();
const SHOTS = [];

app.whenReady().then(async () => {
  try {
    await waitForHealth('the secure relay', RELAY_PORT);
    await waitForHealth('the legacy service', LEGACY_PORT);
  } catch (err) {
    shout(`secure-share-visual: could not start\n${err?.stack || err}`);
    return teardown(1);
  }

  const { BrowserWindow } = require('electron');
  fs.mkdirSync(OUT, { recursive: true });

  try {
    const win = await until('the window', async () => BrowserWindow.getAllWindows()[0] || null, { timeout: 60000 });
    await until('the window to load', () => (win.webContents.isLoading() ? null : true));
    await wait(600);
    win.setSize(1512, 982);
    // The app opens a project when a person picks Open Project; the dialog is
    // stubbed above, so this is that click.
    win.webContents.send('menu:openProject');

    const js = (code) => win.webContents.executeJavaScript(code, true);

    /**
     * Photograph a state, but only after proving it is the state.
     *
     * `expect` is a snippet that must evaluate truthy in the renderer. When it
     * does not, the shot is still written — a picture of the wrong thing is
     * useful when you are working out why — but it is recorded as a failure
     * and the name is not counted as taken.
     */
    const shot = async (name, expect = null, note = null) => {
      await wait(450);
      let ok = true;
      if (expect) {
        const got = await until.soft(`${name}: ${expect}`, 6000, () => js(`!!(${expect})`).catch(() => false));
        ok = check(`state "${name}" is on screen before it is photographed`, !!got, note || expect);
      }
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
      SHOTS.push(name);
      if (ok) taken.add(name);
      say(`  shot ${name}${ok ? '' : '  (STATE NOT REACHED)'}`);
    };

    /** Click something by selector, or say why not. */
    const click = async (selector) => {
      const done = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
      if (!done) shout(`  could not click ${selector}`);
      return done;
    };

    /** A button whose text matches, anywhere in the dialog. */
    const clickText = async (text) => {
      const done = await js(
        `(() => { const b = [...document.querySelectorAll('.share-dialog button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`
      );
      if (!done) shout(`  could not click a button starting "${text}"`);
      return done;
    };

    const escape = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

    await until('the canvas', async () => (await js(`!!document.querySelector('iframe') && !document.querySelector('.welcome')`)) || null, {
      timeout: 240000,
    });
    await wait(3500);

    // The rail buttons carry no title — the tooltip is a separate element — so
    // this is the last one, which is Comments. See src/ui/LeftRail.jsx.
    const openComments = () =>
      js(`(() => {
        const rail = [...document.querySelectorAll('.rail-btn')];
        if (!rail.length) return false;
        rail[rail.length - 1].click();
        return true;
      })()`);
    check('the Comments rail button exists', await openComments());
    await until('the comments panel', () => js(`!!document.querySelector('.comments-panel')`));

    // --- 1. nobody has shared anything ------------------------------------

    await shot('local-only', `document.querySelector('.share-off')?.textContent.includes('private to this Mac')`);
    check(
      'the local row offers Share rather than a server address',
      await js(`document.querySelector('.share-row')?.textContent.includes('Share…')`)
    );
    check('and says nothing about a relay, a server or a token', await js(
      `!/relay|server|token|signup/i.test(document.querySelector('.share-row')?.textContent || '')`
    ));

    // --- 12-14. the join dialog, before this project is shared -------------
    //
    // Driven by sending the payload the main process sends, which is the shape
    // `inspectInvite` produces and which test/secure-share.js proves it
    // produces. What is being photographed here is the dialog.

    // The payload the main process sends when somebody opens an invitation.
    // Sent here directly so every join state can be photographed without
    // needing an operating system to hand over a URL — the shape is the one
    // `inspectInvite` produces, and test/secure-share.js proves it produces it.
    win.webContents.send('reviews:invite', {
      relay: { ok: true, hosted: false, origin: process.env.STACKI_SECURE_RELAY, label: 'On this computer' },
      project: path.basename(root),
      alreadyShared: false,
      expiresAt: Date.now() + 7 * 86400000,
      problem: null,
    });
    await shot('join-confirm', `document.querySelector('.share-dialog')?.textContent.includes('Join shared comments')`);
    check('the join dialog names the local project', await js(`document.querySelector('.share-dialog')?.textContent.includes(${JSON.stringify(path.basename(root))})`));
    check('and never joins on its own', await js(`!!document.querySelector('.share-dialog .primary')`));
    await escape();
    await wait(300);

    win.webContents.send('reviews:invite', {
      relay: { ok: true, hosted: true, origin: 'https://relay.stacki.app', label: 'Stacki hosted' },
      project: null,
      alreadyShared: false,
      expiresAt: null,
      problem: null,
    });
    await shot('join-no-project', `document.querySelector('.share-dialog')?.textContent.includes('No project open')`);
    check('it says to open the project first', await js(`document.querySelector('.share-dialog')?.textContent.includes('Open the project')`));
    check('and Join is not available', await js(`[...document.querySelectorAll('.share-dialog .primary')].every((b) => b.disabled || !b.textContent.includes('Join'))`));
    await escape();
    await wait(300);

    win.webContents.send('reviews:invite', {
      relay: { ok: true, hosted: true, origin: 'https://relay.stacki.app', label: 'Stacki hosted' },
      project: path.basename(root),
      alreadyShared: false,
      expiresAt: Date.now() - 86400000,
      problem: 'expired',
    });
    await shot('join-expired', `document.querySelector('.share-dialog')?.textContent.includes('invitation has expired')`);
    await escape();
    await wait(300);

    // --- 2-3. the create dialog -------------------------------------------

    await click('.share-row .share-link');
    await shot(
      'create-no-comments',
      `document.querySelector('.share-dialog')?.textContent.includes('end-to-end encrypted') && !document.querySelector('.share-check')`
    );
    check(
      'the create dialog claims only what is true',
      await js(`document.querySelector('.share-dialog')?.textContent.includes('The relay cannot read it')`)
    );
    check(
      'and never says nothing is stored',
      await js(`!/nothing is stored|knows nothing about you|anonymous/i.test(document.querySelector('.share-dialog')?.textContent || '')`)
    );

    // --- 17. Advanced ------------------------------------------------------

    await click('.share-disclosure');
    await shot('advanced-relay', `document.querySelector('.share-advanced-body')`);
    check('Advanced is a real disclosure', await js(`document.querySelector('.share-disclosure')?.getAttribute('aria-expanded') === 'true'`));
    check('it offers a custom relay', await js(`document.querySelector('.share-advanced-body')?.textContent.includes('custom secure relay')`));
    check('and says https is required off this computer', await js(`document.querySelector('.share-advanced-body')?.textContent.includes('https')`));
    await click('.share-disclosure');
    await escape();
    await wait(300);

    // Some comments, so the historical-consent question has something to ask
    // about. Through the review module's own door — the path a click takes.
    for (let i = 0; i < 17; i++) {
      const made = reviews.act({
        action: 'create',
        message: `Comment ${i + 1}: this needs another look before it ships.`,
        authorType: 'human',
        pin: { x: 0.2 + (i % 5) * 0.12, y: 0.2 + Math.floor(i / 5) * 0.15 },
      });
      if (!made?.ok && i === 0) shout(`  could not seed comments: ${JSON.stringify(made)}`);
    }
    await wait(700);

    await click('.share-row .share-link');
    await shot('create-with-comments', `document.querySelector('.share-check')`);
    // Measured, not eyeballed. The app's global `input` rule is written for
    // text fields and a checkbox inherits all of it, which once left the label
    // sitting against the box with the gap landing somewhere invisible.
    const box = await js(`(() => {
      const input = document.querySelector('.share-check input');
      const label = document.querySelector('.share-check span');
      if (!input || !label) return null;
      const a = input.getBoundingClientRect();
      const b = label.getBoundingClientRect();
      const cs = getComputedStyle(input);
      const parent = getComputedStyle(input.parentElement);
      return {
        gap: Math.round(b.left - a.right),
        width: Math.round(a.width),
        height: Math.round(a.height),
        position: cs.position,
        display: cs.display,
        float: cs.cssFloat,
        parentDisplay: parent.display,
        parentGap: parent.gap,
        tag: input.parentElement.tagName,
        first: input.parentElement.firstElementChild?.tagName,
      };
    })()`);
    check('the consent checkbox has room between it and its label', box && box.gap >= 6, JSON.stringify(box));
    check('and is the size of a checkbox rather than a text field', box && box.width <= 20 && box.height <= 20, JSON.stringify(box));

    const count = await js(`document.querySelector('.share-check')?.textContent || ''`);
    check('the checkbox names how many comments there are', /\d+ existing comment/.test(count), count);
    check('and it is off', await js(`document.querySelector('.share-check input')?.checked === false`));
    check(
      'and says plainly what off means',
      await js(`document.querySelector('.share-check')?.textContent.includes('stay on this Mac')`)
    );

    // --- 4. creating -------------------------------------------------------
    //
    // A relay that is simply GONE refuses the connection instantly, so the
    // in-flight state lasts a few milliseconds and cannot be photographed. A
    // relay that accepts and then says nothing is the state that actually
    // holds a person waiting — a hung server, a captive portal, a laptop that
    // has a route but no answer — so that is what this puts in front of it.
    await stopRelay();
    const blackHole = net.createServer((socket) => socket.on('error', () => {}));
    await new Promise((resolve, reject) => {
      blackHole.once('error', reject);
      blackHole.listen(RELAY_PORT, '127.0.0.1', resolve);
    });
    await clickText('Create secure share');
    await shot('creating', `[...document.querySelectorAll('.share-dialog button')].some((b) => b.textContent.includes('Creating'))`);
    // Bounded: a socket the runtime will not let go of must not take the whole
    // run with it. The port is then waited for explicitly, because binding it
    // again a moment too early is an EADDRINUSE nobody would look for here.
    blackHole.closeAllConnections?.();
    await Promise.race([new Promise((resolve) => blackHole.close(resolve)), wait(3000)]);
    await until.soft('the port to come free', 15000, async () => {
      try {
        await new Promise((resolve, reject) => {
          const probe = net.createServer();
          probe.once('error', reject);
          probe.listen(RELAY_PORT, '127.0.0.1', () => probe.close(resolve));
        });
        return true;
      } catch {
        return false;
      }
    });
    await until.soft('the failed creation to settle', 25000, () => js(`!!document.querySelector('.share-error')`));
    await escape();
    await wait(300);

    try {
      await restartRelay();
    } catch (err) {
      shout(`  could not restart the relay: ${err.message}`);
    }

    // --- 5-6. created, and copied -----------------------------------------

    await click('.share-row .share-link');
    await clickText('Create secure share');
    await shot('invite-created', `document.querySelector('.share-dialog')?.textContent.includes('Copy invite link')`);
    check(
      'the created state says the invitation is single use and expires',
      await js(`document.querySelector('.share-dialog')?.textContent.includes('works once') && document.querySelector('.share-dialog')?.textContent.includes('7 days')`)
    );
    check(
      'and says to treat it like a password',
      await js(`document.querySelector('.share-dialog')?.textContent.includes('like a password')`)
    );
    check('no invitation is shown as raw text to be selected', await js(`!document.querySelector('.share-dialog code')`));

    await clickText('Copy invite link');
    await shot('invite-copied', `[...document.querySelectorAll('.share-dialog button')].some((b) => b.textContent.includes('Copied'))`);
    check(
      'copying is announced, not only coloured',
      await js(`document.querySelector('.share-dialog [role="status"]')?.textContent.includes('copied')`)
    );

    // --- 10-11. manage -----------------------------------------------------

    await clickText('Manage');
    await shot('manage', `document.querySelector('.share-dialog')?.textContent.includes('Leave secure share')`);
    check('manage offers to end it, because this machine started it', await js(`document.querySelector('.share-dialog')?.textContent.includes('End secure share')`));
    check('manage says where it points', await js(`document.querySelector('.share-facts')?.textContent.includes('Relay')`));
    check(
      'manage is honest that ending cannot take back copies',
      await js(`document.querySelector('.share-dialog')?.textContent.includes('cannot take back copies')`)
    );
    check(
      'manage names only people this machine has learned about',
      await js(`document.querySelector('.share-facts')?.textContent.includes('Just you so far') || /people/.test(document.querySelector('.share-facts')?.textContent || '')`)
    );

    // The dialog came from the created state, so it still holds the invitation
    // it made and the button says so.
    if (!(await clickText('Invite another person'))) await clickText('Invite someone');
    await shot('invite-another', `document.querySelector('.share-invite')`);
    await escape();
    await wait(400);

    // --- 7. the resting state ---------------------------------------------

    await shot('shared-healthy', `document.querySelector('.share-state')?.textContent.trim().startsWith('Shared securely')`);
    check('a healthy share has no Sync button', await js(`!/\\bSync\\b/.test(document.querySelector('.share-row')?.textContent || '')`));
    check('and no presence or online indicator', await js(`!/online|typing|active now/i.test(document.querySelector('.share-row')?.textContent || '')`));
    check(
      'the lock is decorative and the words carry the state',
      await js(`document.querySelector('.share-row svg')?.getAttribute('aria-hidden') === 'true'`)
    );

    // --- 8. offline, with things waiting -----------------------------------

    await stopRelay();
    for (let i = 0; i < 3; i++) {
      reviews.act({ action: 'create', message: `Written with no network ${i + 1}.`, authorType: 'human', pin: { x: 0.5, y: 0.4 + i * 0.05 } });
    }
    await reviews.syncNow('manual').catch(() => {});
    await wait(600);
    await shot('offline-pending', `/Offline/.test(document.querySelector('.share-row')?.textContent || '')`);
    check(
      'offline says how much is waiting',
      await js(`/waiting to send/.test(document.querySelector('.share-row')?.textContent || '')`)
    );
    check(
      'offline is not dressed as a failure',
      await js(`!document.querySelector('.share-row.has-problem')`)
    );

    // --- 9 & 16. access lost ------------------------------------------------
    //
    // The room ended, or this member was removed. From here those are the same
    // thing, which is what the message says.

    // Back, with an empty database — which is exactly what this machine's
    // credential meets when the owner has ended the share somewhere else.
    let ended = false;
    try {
      await restartRelay({ fresh: true });
      ended = true;
    } catch (err) {
      shout(`  could not restart the relay for the paused state: ${err.message}`);
    }
    if (ended) {
      await reviews.syncNow('manual').catch(() => {});
      await wait(700);
      await shot('sharing-paused', `document.querySelector('.share-row.has-problem')`);
      check('a paused share offers Retry', await js(`/Retry/.test(document.querySelector('.share-row')?.textContent || '')`));
      check(
        'and still says how much has not left this machine',
        await js(`/waiting/.test(document.querySelector('.share-row')?.textContent || '')`),
        await js(`document.querySelector('.share-row')?.textContent`)
      );
      await shot(
        'access-lost',
        `document.querySelector('.share-problem')?.textContent.includes('no longer has access')`
      );
      check(
        'and says the local comments are still here',
        await js(`document.querySelector('.share-problem')?.textContent.includes('still here')`)
      );
      check(
        'and never shows a cryptographic error',
        await js(`!/signature|ciphertext|nonce|AES|Ed25519|HMAC/i.test(document.querySelector('.share-row')?.textContent || '')`)
      );
      check(
        'the problem is announced',
        await js(`document.querySelector('.share-problem')?.getAttribute('role') === 'alert' || document.querySelector('[role="alert"]')`)
      );
    }

    // --- 15. an invitation that has been used ------------------------------

    win.webContents.send('reviews:invite', {
      relay: { ok: true, hosted: false, origin: `http://127.0.0.1:${RELAY_PORT}`, label: 'On this computer' },
      project: path.basename(root),
      alreadyShared: false,
      expiresAt: Date.now() + 86400000,
      problem: null,
    });
    await wait(400);
    // There is no pending invitation in the main process, so pressing Join is
    // refused — the same shape a consumed invitation produces.
    await clickText('Join');
    await shot('join-used', `document.querySelector('.share-dialog .share-error')`);
    check(
      'a refused join says so without a cryptographic word in it',
      await js(`!/signature|ciphertext|nonce/i.test(document.querySelector('.share-dialog .share-error')?.textContent || '')`)
    );
    await escape();
    await wait(300);

    // --- 18. a legacy plaintext workspace ----------------------------------

    reviews.leaveSecureShare && (await reviews.leaveSecureShare().catch(() => {}));
    await wait(400);
    const legacy = await reviews
      .enableShared({
        server: `http://127.0.0.1:${LEGACY_PORT}`,
        signupToken: SIGNUP,
        publishExisting: false,
      })
      .catch((err) => ({ ok: false, message: err.message }));
    if (!legacy?.ok) shout(`  could not start a legacy workspace: ${JSON.stringify(legacy)}`);
    await wait(800);
    await shot('legacy-workspace', `document.querySelector('.shared-bar')`);
    check(
      'a legacy workspace keeps the row it always had, Sync and all',
      await js(`/Sync/.test(document.querySelector('.shared-bar')?.textContent || '')`)
    );

    // --- viewports ----------------------------------------------------------
    //
    // The sizes real Stacki windows are. Manage with Advanced open is the
    // tallest thing this feature draws, so that is what gets measured.

    await reviews.disableShared();
    await wait(300);
    await click('.share-row .share-link');
    await click('.share-disclosure');
    await wait(400);

    for (const [name, w, h] of [
      ['mbp14-largest', 1024, 665],
      ['mbp16-largest', 1168, 755],
      ['mbp14-default', 1512, 982],
      ['mbp16-default', 1728, 1117],
      ['external-1080', 1920, 1080],
    ]) {
      win.setSize(w, h);
      await wait(600);
      const box = await js(`(() => {
        const d = document.querySelector('.share-dialog');
        const b = document.querySelector('.share-dialog .modal-body');
        if (!d) return null;
        const r = d.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          height: Math.round(r.height),
          viewport: window.innerHeight,
          docScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          bodyScrolls: b ? b.scrollHeight > b.clientHeight + 1 : false,
          buttonsVisible: [...document.querySelectorAll('.share-dialog .share-actions button')].every((el) => {
            const rr = el.getBoundingClientRect();
            return rr.bottom <= window.innerHeight + 1 && rr.top >= -1;
          }),
        };
      })()`);
      await shot(`viewport-${name}`, `document.querySelector('.share-dialog')`);
      if (box) {
        check(`at ${w}x${h} the dialog fits the window`, box.bottom <= box.viewport + 1, JSON.stringify(box));
        check(`at ${w}x${h} nothing overflows sideways`, box.docScrollX === false, JSON.stringify(box));
        check(`at ${w}x${h} every action button can be reached`, box.buttonsVisible === true, JSON.stringify(box));
      } else {
        check(`at ${w}x${h} the dialog is on screen`, false);
      }
    }
    win.setSize(1512, 982);
    await escape();
    await wait(300);

    // --- the Inspector is untouched -----------------------------------------

    check('the comments index is still there', await js(`!!document.querySelector('.comments-panel')`));
    check('and still lists reviews', await js(`document.querySelectorAll('.comments-row').length > 0`));

    // --- mandatory states ---------------------------------------------------

    for (const name of REQUIRED) {
      check(`the run produced the "${name}" state`, taken.has(name));
    }

    // --- the contact sheet --------------------------------------------------

    fs.writeFileSync(
      path.join(OUT, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>Secure Share states</title>
<style>body{background:#111;color:#ddd;font:13px -apple-system,sans-serif;margin:0;padding:24px}
h1{font-size:16px;font-weight:600}figure{margin:0 0 28px}figcaption{padding:6px 0;color:#9aa3b2}
img{display:block;width:100%;height:auto;background:#000;border-radius:8px}</style>
<h1>Secure Share — ${SHOTS.length} states</h1>
${SHOTS.map((n) => `<figure><figcaption>${n}</figcaption><img src="${n}.png" alt="${n}"></figure>`).join('\n')}`,
      'utf8'
    );
  } catch (err) {
    shout(`secure-share-visual: threw\n${err?.stack || err}`);
    failures.push(`  the run did not finish: ${err?.message || err}`);
  }

  say(`\nsecure-share-visual: ${SHOTS.length} states written to ${OUT}`);
  if (failures.length) {
    shout(`\nsecure-share-visual: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    return teardown(1);
  }
  say(`secure-share-visual: ${checked} checks passed`);
  return teardown(0);
});
