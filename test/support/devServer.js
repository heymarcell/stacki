// The preview server a harness started, and proving it is gone.
//
// Astro 7 daemonizes: `astro dev` forks a background process, writes
// `.astro/dev.json` into the project with its pid, port and url, and the CLI
// that started it exits 0. So the thing holding the port is not a child of the
// app, and when a harness ends with `app.exit()` — which skips before-quit —
// nothing has told it to stop.
//
// The teardowns asked it to stop and then checked the wrong thing:
//
//   try { await fetch(previewUrl) } catch { return }   // "it stopped"
//
// A server whose project directory has just been deleted does not refuse
// connections. It answers 500. fetch resolves, the loop keeps going, and the
// deadline would eventually have reported it — except the step before it
// returned early and silently whenever the MCP server was not up or dev_status
// came back in an unexpected shape. A cleanup step that returns early is
// indistinguishable from one that worked, which is the same defect as a caption
// nothing checked.
//
// Measured: five consecutive runs left five orphaned dev servers, one per run,
// each holding the next port up — 4322, 4323, 4324, 4325 — and each answering
// HTTP 500 from a directory that no longer existed.
//
// The order was also wrong. `stopDevServer` hands a daemon to `astro dev stop`,
// which needs the project to still be there; the teardown deleted the fixture
// straight afterwards. So the rule is: ask it to stop, WAIT FOR ITS PID, and
// only then remove the directory it is running in.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * What Astro wrote about the background server it started for this project.
 *
 * `root` is carried along because the pid on its own is not an identity — see
 * isOurDevServer below. It is the project path that makes a pid THIS run's.
 */
function readDevLock(projectRoot) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, '.astro', 'dev.json'), 'utf8'));
    if (lock && Number.isInteger(lock.pid)) {
      return { pid: lock.pid, url: lock.url || null, port: lock.port || null, root: projectRoot };
    }
  } catch {
    /* no lock file — nothing was daemonized, or it has already tidied up */
  }
  return null;
}

// On macOS os.tmpdir() is under /var, a symlink to /private/var, and a fixture
// root is realpath'd while a command line may be spelled either way.
const normalize = (p) => String(p || '').replace(/^\/private\//, '/');

/** The command line of whatever currently owns this pid, or null. */
function processCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Windows has no ps, and there is no equally simple strong answer there. A
  // weak check is worse than none: this returns null, isOurDevServer says no,
  // and the last-resort signal is refused rather than aimed at a guess.
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Is the process holding this pid still THIS run's Astro dev server?
 *
 * A pid is a number the kernel hands back out. Between deciding a server will
 * not stop and signalling it, the server can exit and something else can be
 * given the same number — and the signal would then land on a stranger. Rare,
 * and the cost of being wrong is somebody else's process dying, so it is worth
 * one `ps`.
 *
 * The identity is the fixture path: this run made that directory, its name is
 * unique to this run, and it is in the dev server's own argv. `astro` beside it
 * says the process is the dev server rather than something else that happened
 * to be started from the same place.
 *
 * Anything short of a positive answer is a no. The caller must not signal on a
 * no.
 */
function isOurDevServer(lock) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || !lock.root) return false;
  const cmd = normalize(processCommand(lock.pid));
  if (!cmd) return false;
  return cmd.includes(normalize(lock.root)) && /astro/i.test(cmd);
}

/** Anything other than "definitely gone" counts as still running. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the server named by `lock` to actually exit.
 *
 * Throws if it will not, so the caller's cleanup accounting fails the run
 * rather than reporting a stop that did not happen. The pid came out of this
 * run's own project directory, so a last-resort signal goes to that one number
 * — never to a name, a pattern, or anything this run did not start.
 */
async function awaitDevServerGone(lock, { timeout = 25000, force = true } = {}) {
  if (!lock) return { stopped: true, how: 'nothing was daemonized' };

  const deadline = Date.now() + timeout;
  while (alive(lock.pid) && Date.now() < deadline) await sleep(250);
  if (!alive(lock.pid)) return { stopped: true, how: 'asked, and it went' };

  if (!force) throw new Error(`the preview (pid ${lock.pid}, port ${lock.port}) would not stop`);

  // It was asked and did not go. Leaving it would hold a port and a project
  // directory for as long as the machine is up, and would poison the next run.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    // Checked immediately before EACH signal, not once at the top: the whole
    // risk is the process going away and its number being reissued, and that
    // can happen just as easily between the two signals as before the first.
    if (!isOurDevServer(lock)) {
      throw new Error(
        `the preview (pid ${lock.pid}, port ${lock.port}) could not be shown to still be this run's Astro dev server — refusing to signal it`
      );
    }
    try {
      process.kill(lock.pid, signal);
    } catch {
      /* already gone */
    }
    const until = Date.now() + 6000;
    while (alive(lock.pid) && Date.now() < until) await sleep(250);
    if (!alive(lock.pid)) {
      // Reported, not swallowed: the app's own stop path did not work.
      throw new Error(`the preview (pid ${lock.pid}, port ${lock.port}) needed ${signal} — it did not stop when asked`);
    }
  }
  throw new Error(`the preview (pid ${lock.pid}, port ${lock.port}) would not stop at all`);
}

module.exports = { readDevLock, awaitDevServerGone, alive, isOurDevServer, processCommand };
