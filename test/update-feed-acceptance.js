// Does a packaged Stacki actually ask anybody for an update?
//
//   node test/update-feed-acceptance.js            # against release/mac-universal
//   node test/update-feed-acceptance.js <App.app>
//
// Not part of `npm test`: it needs a packaged app, and building one takes
// minutes. Run it after `npm run dist:mac:unsigned`.
//
// "No error dialog appeared" is not evidence that nothing was requested. It is
// evidence that nothing went wrong with a request that may well have happened
// — and the bug this guards against was a build quietly reaching the official
// feed, succeeding, and only failing later when Squirrel refused to stage what
// it downloaded. So this counts requests.
//
// A copy of the app is pointed at a local HTTP server that counts every hit,
// by writing the app-update.yml that afterPack removes. That is the adversarial
// arrangement on purpose: a feed IS present and reachable, so the only thing
// standing between the app and a request is the runtime policy. Zero hits
// means the policy held.
//
// The positive control is the other half. A build marked update-enabled — the
// same flag the release workflow sets — is pointed at the same server and must
// hit it. Without that, "zero requests" is equally consistent with a counting
// server that never worked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const REPO = path.join(__dirname, '..');
const DEFAULT_APP = path.join(REPO, 'release', 'mac-universal', 'Stacki.app');

/** A server that records every request anybody makes to it. */
function countingFeed({ offer = '0.0.1' } = {}) {
  const hits = [];
  const state = { offer };
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, at: Date.now() });
    // Answer like a generic electron-updater feed would, but name a version
    // OLDER than anything Stacki ships.
    //
    // The request is the whole measurement — it has already been counted by
    // the time this replies. Offering a newer version would make the control
    // build download it, fail the (fake) checksum, and put a real "Stacki
    // could not check for updates" dialog on the screen of whoever is running
    // the test. Nothing is learned from that download, so it does not happen.
    res.writeHead(200, { 'content-type': 'application/x-yaml' });
    res.end(`version: ${state.offer}\npath: Stacki-${state.offer}-universal-mac.zip\nsha512: ${'0'.repeat(88)}\nreleaseDate: '2020-01-01T00:00:00.000Z'\n`);
  });
  return {
    hits,
    state,
    listen: () =>
      new Promise((done) => {
        server.listen(0, '127.0.0.1', () => done(server.address().port));
      }),
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * A throwaway copy of the app, pointed at the local feed.
 *
 * Copied rather than edited in place: this writes a feed file the real build
 * deliberately does not ship, and leaving that behind in release/ would be a
 * booby trap for the next person who launches it.
 */
function stageApp(appPath, port, { enabled }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-feed-test-'));
  const copy = path.join(dir, path.basename(appPath));
  execFileSync('cp', ['-R', appPath, copy]);
  const resources = path.join(copy, 'Contents', 'Resources');
  fs.writeFileSync(
    path.join(resources, 'app-update.yml'),
    `provider: generic\nurl: http://127.0.0.1:${port}\nupdaterCacheDirName: stacki-feed-test\n`,
    'utf8'
  );
  if (enabled) {
    // The positive control needs the metadata the release workflow injects.
    // Rewriting it inside the asar is what the release build effectively does
    // with -c.extraMetadata, without spending another full build to do it.
    const asar = path.join(resources, 'app.asar');
    const work = path.join(dir, 'unpacked');
    execFileSync('npx', ['--yes', 'asar', 'extract', asar, work], { cwd: REPO, stdio: 'pipe' });
    const manifest = path.join(work, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    pkg.stackiAutoUpdate = true;
    fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2), 'utf8');
    execFileSync('npx', ['--yes', 'asar', 'pack', work, asar], { cwd: REPO, stdio: 'pipe' });
  }
  return { dir, copy };
}

/** Run the app long enough for startup update scheduling to have happened. */
async function runFor(copy, seconds, port) {
  const bin = path.join(copy, 'Contents', 'MacOS', 'Stacki');
  const log = [];
  const child = spawn(bin, [], {
    // A free MCP port, so a copy started here never fights the app the person
    // at the keyboard has open — and no modal dialogs, because this run has
    // nobody watching it and a message box would leave the app waiting for a
    // click on somebody's screen until the test's timeout.
    env: { ...process.env, STACKI_MCP_PORT: String(port), STACKI_NO_DIALOGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  await wait(seconds * 1000);
  try {
    child.kill('SIGTERM');
    await wait(1500);
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  return log.join('');
}

(async () => {
  const appPath = process.argv[2] || DEFAULT_APP;
  if (!fs.existsSync(appPath)) {
    console.log(`update-feed-acceptance: skipped — no packaged app at ${appPath}`);
    console.log('  build one with: npm run dist:mac:unsigned');
    process.exit(0);
  }

  const feed = countingFeed();
  const port = await feed.listen();
  const staged = [];

  try {
    // --- the build people actually get -------------------------------------
    const local = stageApp(appPath, port, { enabled: false });
    staged.push(local.dir);
    const localLog = await runFor(local.copy, 30, 44101);
    const localHits = feed.hits.length;

    check('an ordinary package makes no request to its update feed', localHits === 0, `${localHits} request(s): ${JSON.stringify(feed.hits.slice(0, 3))}`);
    check('and says why in its log', /Automatic updates disabled for this build/.test(localLog), localLog.slice(0, 300));
    check('and never reports checking', !/Checking for updates/.test(localLog), localLog.slice(0, 300));
    check('and shows no update failure', !/could not check for updates/i.test(localLog), localLog.slice(0, 300));

    // --- the positive control ----------------------------------------------
    //
    // Same app, same feed, same machine — only the release flag differs. If
    // this does not reach the server then the check above proved nothing.
    feed.hits.length = 0;
    const release = stageApp(appPath, port, { enabled: true });
    staged.push(release.dir);
    const releaseLog = await runFor(release.copy, 30, 44102);
    const releaseHits = feed.hits.length;

    check('an update-enabled build does reach the feed', releaseHits > 0, `${releaseHits} request(s) — if this is 0 the negative result above is meaningless`);
    check('and the control build says it is checking', /Checking for updates/.test(releaseLog), releaseLog.slice(0, 300));
    // The feed offers an older version, so a correct client asks and then does
    // nothing. A download here would mean the control is doing more than
    // measuring.
    check('and downloads nothing, because the offered version is older', !/Update downloaded|checksum mismatch/i.test(releaseLog), releaseLog.slice(0, 300));
    // --- the dialog that used to stop everything ---------------------------
    //
    // The exact arrangement that put a real "Stacki could not check for
    // updates" box on somebody's screen mid-test: a build allowed to update,
    // a feed offering something newer, and a checksum that will not match. A
    // modal dialog here waits for a click that is never coming, so an
    // unattended run hangs until its timeout with the app frozen behind it.
    //
    // Headless, the same failure must be a log line and nothing else.
    feed.hits.length = 0;
    feed.state.offer = '99.0.0';
    const noisy = stageApp(appPath, port, { enabled: true });
    staged.push(noisy.dir);
    const noisyLog = await runFor(noisy.copy, 40, 44103);

    check('a failing update is still attempted when enabled', feed.hits.length > 0, `${feed.hits.length} request(s)`);
    check('and the failure is reported to the log', /Auto update error|checksum mismatch/i.test(noisyLog), noisyLog.slice(-400));
    check('but no dialog is put on screen', /Dialog suppressed/.test(noisyLog), noisyLog.slice(-400));
    check('and the app is still running when the run ends', !/quitAndInstall/.test(noisyLog));
  } finally {
    await feed.close();
    for (const dir of staged) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a temp copy that will not go is not a test failure */
      }
    }
  }

  if (failures.length) {
    console.error(`\nupdate-feed-acceptance: ${failures.length} failed, ${checked - failures.length} passed\n`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`update-feed-acceptance: ${checked} passed  [a real package, a real feed, zero requests]`);
})().catch((err) => {
  console.error(`update-feed-acceptance: ${err?.stack || err}`);
  process.exit(1);
});
