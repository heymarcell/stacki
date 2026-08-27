// A pid is a number, not an identity.
//
//   node test/dev-server-identity.js
//
// The teardown reads Astro's pid out of `.astro/dev.json`, waits for it, and —
// if it will not go — signals that exact number. Between "it will not go" and
// the signal, the server can exit and the kernel can hand its number to
// something else. The signal would then land on a stranger's process: rare,
// silent, and somebody else's afternoon.
//
// So nothing is signalled until the process holding that pid has been shown to
// still be THIS run's Astro dev server. The identity is the fixture path — this
// run made that directory, its name is unique to this run, and it is in the dev
// server's own argv. Everything short of a positive answer is a refusal, and a
// refusal fails the cleanup rather than guessing.
//
// The processes below are real. Nothing is mocked, because the thing being
// checked is what `ps` says about a live process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readDevLock, awaitDevServerGone, isOurDevServer, alive } = require('./support/devServer.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const yard = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-devid-')));
const started = [];

/**
 * A stand-in for the daemon Astro leaves behind: a real process whose argv
 * names this fixture and the astro entry point, exactly as the real one does
 *
 *   node /private/tmp/…/stacki-canvas-XXXX/node_modules/astro/bin/astro.mjs dev --port 4322
 */
function startFakeDevServer(root, { ignoreTerm = false } = {}) {
  const entry = path.join(root, 'node_modules', 'astro', 'bin', 'astro.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(
    entry,
    `${ignoreTerm ? "process.on('SIGTERM', () => {});\n" : ''}setInterval(() => {}, 1000);\n`,
    'utf8'
  );
  const child = spawn(process.execPath, [entry, 'dev', '--port', '4322', '--host', '127.0.0.1'], {
    stdio: 'ignore',
    detached: false,
  });
  started.push(child);
  return child;
}

/** Wait until a spawned child has actually exited and been reaped. */
const exited = (child) =>
  new Promise((done) => (child.exitCode !== null || child.signalCode ? done() : child.once('exit', () => done())));

(async () => {
  try {
    // ── the lock file carries the identity, not just the number ─────────────
    {
      const root = fs.mkdtempSync(path.join(yard, 'proj-'));
      fs.mkdirSync(path.join(root, '.astro'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.astro', 'dev.json'),
        JSON.stringify({ pid: 4242, port: 4322, url: 'http://127.0.0.1:4322/' }),
        'utf8'
      );
      const lock = readDevLock(root);
      check('the lock file is read', !!lock, JSON.stringify(lock));
      check('with the pid', lock?.pid === 4242, JSON.stringify(lock));
      check('the port', lock?.port === 4322, JSON.stringify(lock));
      check('and the project it belongs to', lock?.root === root, JSON.stringify(lock));
      check('a project with no lock file answers null', readDevLock(path.join(yard, 'nothing-here')) === null);
    }

    // ── a live process that IS this run's dev server ────────────────────────
    {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(yard, 'live-')));
      const child = startFakeDevServer(root);
      await wait(400);
      const lock = { pid: child.pid, port: 4322, root };
      check('a live dev server started from this fixture is recognised', isOurDevServer(lock) === true, String(child.pid));
      // The two halves of the identity, each necessary.
      check(
        'the same pid is NOT ours under another project path',
        isOurDevServer({ ...lock, root: path.join(yard, 'some-other-project') }) === false
      );
      check('and a lock with no project path is never ours', isOurDevServer({ pid: child.pid, port: 4322 }) === false);
      child.kill('SIGKILL');
      await exited(child);
    }

    // ── a live process that is NOT ours is never signalled ──────────────────
    //
    // The case the guard exists for: the number is right, the process is not.
    {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(yard, 'stranger-')));
      const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      started.push(stranger);
      await wait(400);
      const lock = { pid: stranger.pid, port: 4322, root };
      check('a process that is not this run\'s dev server is not ours', isOurDevServer(lock) === false, String(stranger.pid));

      let threw = null;
      try {
        await awaitDevServerGone(lock, { timeout: 500 });
      } catch (err) {
        threw = String(err.message);
      }
      check('trying to stop it fails rather than signalling it', !!threw, String(threw));
      check('and says why', /refusing to signal/.test(threw || ''), String(threw));
      // The proof: it is still running. Nothing was sent to it.
      check('the process it could not identify is untouched', alive(stranger.pid) === true);
      check('and really still running', stranger.exitCode === null && !stranger.signalCode, String(stranger.exitCode));
      stranger.kill('SIGKILL');
      await exited(stranger);
    }

    // ── a pid that has already gone ─────────────────────────────────────────
    {
      const gone = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }).pid;
      const root = fs.realpathSync(fs.mkdtempSync(path.join(yard, 'gone-')));
      const result = await awaitDevServerGone({ pid: gone, port: 4322, root }, { timeout: 500 });
      check('a pid that has vanished is a stop', result.stopped === true, JSON.stringify(result));
      check('and no signal was needed', /went/.test(result.how || ''), JSON.stringify(result));
    }

    // ── a server that stops when asked ──────────────────────────────────────
    //
    // The ordinary path, and the one that must never reach the force branch.
    {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(yard, 'polite-')));
      const child = startFakeDevServer(root);
      await wait(300);
      setTimeout(() => child.kill('SIGTERM'), 500); // stands in for `astro dev stop`
      const result = await awaitDevServerGone({ pid: child.pid, port: 4322, root }, { timeout: 8000 });
      check('a server that goes when asked is a clean stop', result.stopped === true, JSON.stringify(result));
      check('reported as asked, not forced', result.how === 'asked, and it went', JSON.stringify(result));
      await exited(child);
    }

    // ── a verified server that will not go IS signalled, and reported ───────
    {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(yard, 'stubborn-')));
      const child = startFakeDevServer(root);
      await wait(400);
      let threw = null;
      try {
        await awaitDevServerGone({ pid: child.pid, port: 4322, root }, { timeout: 500 });
      } catch (err) {
        threw = String(err.message);
      }
      check('a verified server that would not stop is signalled', !!threw, String(threw));
      check('and the run is failed rather than quietly tidied', /needed SIG/.test(threw || ''), String(threw));
      await exited(child);
      check('and it is actually gone', alive(child.pid) === false);
    }

    // ── nothing to stop ─────────────────────────────────────────────────────
    {
      const result = await awaitDevServerGone(null);
      check('a run that daemonized nothing has nothing to wait for', result.stopped === true, JSON.stringify(result));
    }
  } finally {
    for (const child of started) {
      try {
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(yard, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\ndev-server-identity: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`dev-server-identity: ${checked} passed  [a pid is a number, not an identity]`);
})();
