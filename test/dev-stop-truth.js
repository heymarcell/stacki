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
const { execFileSync } = require('node:child_process');

const { startWireRig } = require('./support/mcpWireRig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whoever is listening there — this fixture's own server, by the port it took. */
function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .split('\n')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** End what this test started, by pid and by the port it is holding. */
function endOwned(pid, port) {
  for (const target of [pid, ...listenersOn(port)].filter(Boolean)) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(target, signal);
      } catch {
        break;
      }
    }
  }
}
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
  //
  // HOW THE FAILURE IS FORCED, without a production hook and without depending
  // on the machine. An earlier version rewrote Astro's lock file to point
  // somewhere harmless and expected the server to survive; on a runner
  // `astro dev stop` found and stopped it anyway, so the test was asserting
  // something only true of this laptop.
  //
  // What is deterministic everywhere is the other half of the same rule: Stacki
  // will not signal a process it cannot confirm is its own. So this test ends
  // the real server itself, by the pid it recorded, and then takes the port
  // with a listener of its own. Stacki is then asked to stop a server it still
  // holds a record for, finds something listening on that port, cannot
  // establish that it is the dev server, and correctly refuses to kill it. The
  // port stays busy, and the answer has to say so rather than claim success.
  {
    const rig = await startWireRig({ realDevServer: true });
    let realPid = null;
    let port = null;
    let squatter = null;
    try {
      const started = await rig.call('project', 'dev_start', {});
      port = Number(new URL(String(started.envelope?.url)).port);
      const lockPath = path.join(fs.realpathSync(rig.root), '.astro', 'dev.json');
      realPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
      check('a real preview is running to begin with', !!realPid && alive(realPid) && (await busy(port)), `pid ${realPid} port ${port}`);

      // The test ends the server, so what follows is not Stacki's to stop.
      // By the port as well as the pid: Astro's daemon forks, and the process
      // named in the lock is not always the one holding the socket.
      endOwned(realPid, port);
      for (let i = 0; i < 60 && (await busy(port)); i += 1) {
        await sleep(250);
        endOwned(realPid, port);
      }
      check('  and the test has ended it', !(await busy(port)), `pid ${realPid} port ${port}`);

      // Somebody else's server, on the port Stacki still thinks is its own.
      squatter = net.createServer(() => {});
      await new Promise((done, fail) => {
        squatter.once('error', fail);
        squatter.listen(port, '127.0.0.1', done);
      });
      check('  and something else has taken the port', await busy(port), `port ${port}`);

      const stopped = await rig.call('project', 'dev_stop', {});
      check('a stop it cannot complete does NOT report success', stopped.envelope?.ok === false, JSON.stringify(stopped.envelope).slice(0, 220));
      check('  and says what is still there', /still listening|did not stop/i.test(String(stopped.envelope?.message)), JSON.stringify(stopped.envelope?.message));
      check('  naming the port', String(stopped.envelope?.message || '').includes(String(port)) || stopped.envelope?.port === port, JSON.stringify(stopped.envelope).slice(0, 200));
      check('  and the process it could not identify is untouched', !!squatter.listening, String(squatter.listening));
      check('  which is the point: it will not kill what it cannot confirm is its own', await busy(port), `port ${port}`);
    } finally {
      if (squatter) await new Promise((done) => squatter.close(done));
      endOwned(realPid, port);
      await rig.stop();
    }
    await sleep(600);
    check('and the test left nothing of its own behind', !(await busy(port)), `port ${port}`);
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
