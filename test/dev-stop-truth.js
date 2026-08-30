// If dev_stop says it stopped, the server is gone.
//
//   node test/dev-stop-truth.js
//
// This is the one answer about the preview an agent has to be able to believe.
// It could be false: waitForPortFree resolved the same way whether the port had
// been released or the bounded wait had simply run out, and dev:stop turned
// both into { ok: true }. A caller was then told the port was free while a
// server went on listening on it.
//
// HOW THE FAILURE IS FORCED, without a production hook. Astro records the
// daemon it forked in the project's own .astro/dev.json, and that file is what
// Stacki reads to stop it. This test starts a real server, remembers the real
// pid itself, and then rewrites that record to point somewhere harmless — a
// `sleep` this test owns. Stacki then does exactly what it always does, and
// what it does is not enough: the CLI cannot find the daemon through the
// rewritten lock, the recorded pid it falls back to is not the server, and the
// real one keeps the port. Nothing about Stacki is stubbed. It is simply asked
// to stop a server it can no longer reach, which is the case the answer has to
// be honest about.
//
// The real daemon is then ended by the pid this test wrote down before it
// rewrote anything, and the port is proved free again.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { startWireRig } = require('./support/mcpWireRig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const busy = (port) =>
  new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (v) => {
      socket.destroy();
      done(v);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(false), 700).unref?.();
  });

(async () => {
  // ── a stop that works answers that it worked ─────────────────────────────
  {
    const rig = await startWireRig({ realDevServer: true });
    let port = null;
    try {
      const started = await rig.call('project', 'dev_start', {});
      port = Number(new URL(String(started.envelope?.url)).port);
      check('a real preview is running', started.envelope?.ok === true && (await busy(port)), JSON.stringify(started.envelope).slice(0, 140));

      const stopped = await rig.call('project', 'dev_stop', {});
      check('stopping it answers success', stopped.envelope?.ok === true, JSON.stringify(stopped.envelope).slice(0, 200));
      check('  and the port really is free', !(await busy(port)), `port ${port}`);
    } finally {
      await rig.stop();
    }
  }

  // ── a stop that cannot finish answers that it could not ──────────────────
  {
    const rig = await startWireRig({ realDevServer: true });
    let realPid = null;
    let port = null;
    let decoy = null;
    try {
      const started = await rig.call('project', 'dev_start', {});
      port = Number(new URL(String(started.envelope?.url)).port);
      const lockPath = path.join(fs.realpathSync(rig.root), '.astro', 'dev.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      realPid = lock.pid;
      check('the server this test will strand is running', !!realPid && alive(realPid) && (await busy(port)), `pid ${realPid} port ${port}`);

      // Somewhere harmless for Stacki's fallback to aim at, owned by this test.
      decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await sleep(300);
      check('  and the decoy this test will offer instead is alive', alive(decoy.pid), `pid ${decoy.pid}`);

      fs.writeFileSync(lockPath, JSON.stringify({ ...lock, pid: decoy.pid }), 'utf8');

      const stopped = await rig.call('project', 'dev_stop', {});
      check('a stop that cannot reach the server does NOT report success', stopped.envelope?.ok === false, JSON.stringify(stopped.envelope).slice(0, 220));
      check('  and says what is still there', /still listening|did not stop/i.test(String(stopped.envelope?.message)), JSON.stringify(stopped.envelope?.message));
      check('  naming the port', String(stopped.envelope?.message || '').includes(String(port)) || stopped.envelope?.port === port, JSON.stringify(stopped.envelope).slice(0, 200));
      check('  because the server really is still listening', await busy(port), `port ${port}`);
      check('  and the server itself is untouched', alive(realPid), `pid ${realPid}`);

      // The app must not have lied to itself either.
      const status = await rig.call('project', 'dev_status', {});
      check('  the app does not claim the preview is off', status.envelope?.status !== 'off' || !(await busy(port)), JSON.stringify(status.envelope));

      // Only ever what this test started: the decoy, and the daemon whose pid
      // was written down before the lock was rewritten.
      try {
        process.kill(realPid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 40 && (await busy(port)); i += 1) await sleep(250);
      check('the test ended the server it deliberately stranded', !alive(realPid) && !(await busy(port)), `pid ${realPid} port ${port}`);
    } finally {
      if (decoy && decoy.exitCode === null) {
        try {
          decoy.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      if (realPid && alive(realPid)) {
        try {
          process.kill(realPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await rig.stop();
    }
    await sleep(400);
    check('and left neither of the processes it made behind', !alive(realPid) && !(decoy && alive(decoy.pid)));
  }

  if (failures.length) {
    console.error(`\ndev-stop-truth: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`dev-stop-truth: ${checked} passed  [a stop that cannot finish says so]`);
})().catch((err) => {
  console.error('dev-stop-truth threw\n', err);
  process.exit(1);
});
