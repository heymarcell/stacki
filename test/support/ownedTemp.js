// Temp directories a harness owns — and the only ones it is allowed to delete.
//
// The harnesses that drive a real Electron leave two things in the temp
// directory that teardown cannot get rid of. Electron rewrites a small userData
// during shutdown, after the harness has deleted it and checked it is gone, so
// one reappears per run. And a run that was killed mid-flight never reached its
// teardown at all. Neither is large, which is the problem: they accumulate one
// per run until somebody wonders where their disk went.
//
// So they are swept at startup. The sweep used to be:
//
//     readdir(os.tmpdir()) → basename starts with one of these prefixes → rm -rf
//
// on the theory that a directory another process was using would refuse to be
// deleted. On macOS and every other Unix that is simply not true. Unlink does
// not consult anybody: a process can be running with its cwd inside a tree, and
// files open in it, while another process takes the whole thing out from under
// it. What that process then sees is its own project half-missing, which looks
// like the app corrupting a project rather than like another test.
//
// It happens for real. `review-ux-visual` sweeps `stacki-canvas-`, which is the
// prefix of the Astro fixture EVERY canvas harness builds — so running the
// visual harness while `agent-canvas` was working deleted the project out of
// the middle of the other run. Two of these can now be going at once, in
// different worktrees, driven by different people.
//
// A prefix is not ownership. A prefix is a naming convention, and `/tmp` is
// shared with the rest of the machine. So ownership is written down:
//
//     .stacki-temp-owner.json   { kind, harness, runId, pid, createdAt }
//
// and the rule for removing somebody else's directory is that there has to BE
// somebody else, they have to be one of ours, and they have to be gone:
//
//     no marker            → not ours, keep it
//     marker we can't read → we don't know what it is, keep it
//     recorded pid alive   → it is in use, keep it
//     created moments ago  → keep it; a race is not a leak
//     ours, and dead       → remove it
//
// Every uncertain case keeps the directory. Deleting a live run's project costs
// somebody an afternoon; leaving a dead run's 40KB costs nothing, and the next
// sweep will get it.
//
// A run's own directories are a different matter — it made them, it knows they
// are its, and it removes them directly.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '.stacki-temp-owner.json';
const KIND = 'stacki-harness-temp';

/**
 * Long enough that a directory created while a sweep is walking past it is
 * never mistaken for a dead run's leftovers, short enough to be no use to
 * anyone as a hiding place. The marker is written immediately after mkdtemp,
 * so this is belt to that braces.
 */
const GRACE_MS = 60_000;

/** This process's runs, so teardown can say what it still owns. */
const OWNED = new Set();

const runId = () => `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const RUN_ID = runId();

/**
 * Whether a pid belongs to a process that is still there.
 *
 * Anything other than "it is definitely gone" answers true, because every
 * answer here decides whether to delete somebody's files. A pid we cannot
 * signal (EPERM) is a process owned by another user — which is a running
 * process, and a reason to leave its directory alone.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** The ownership marker in `dir`, or null if there isn't a readable one. */
function readOwner(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, MARKER), 'utf8');
  } catch {
    return null;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!owner || typeof owner !== 'object') return null;
  if (owner.kind !== KIND) return null;
  // A marker missing the two facts the decision is made on is a marker that
  // cannot be acted on. Unknown, therefore kept.
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
  if (!Number.isFinite(owner.createdAt)) return null;
  return owner;
}

/**
 * A temp directory this run owns, marked as such.
 *
 * Resolved through realpath, because on macOS os.tmpdir() is under /var, which
 * is a symlink to /private/var — and Vite resolves module ids to real paths, so
 * a project opened at the symlinked spelling has a dev server whose ids never
 * match what the marker plugin compares against. The page then renders
 * perfectly with no markers in it at all, which looks like a broken canvas
 * rather than a fixture in an unusual place.
 */
function ownedTempDir(prefix, { harness = 'stacki', dir = os.tmpdir() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, prefix)));
  fs.writeFileSync(
    path.join(root, MARKER),
    `${JSON.stringify({ kind: KIND, harness, runId: RUN_ID, pid: process.pid, createdAt: Date.now() }, null, 2)}\n`,
    'utf8'
  );
  OWNED.add(root);
  return root;
}

/**
 * Remove a directory this run made. Its own; no ceremony required.
 *
 * Ownership is given up only when the directory is actually gone. It used to be
 * dropped from OWNED first, so a removal that threw — a read-only parent, a
 * file another process still has open on a filesystem that minds — left a real
 * directory on disk that `ownedTempRoots()` then swore this run no longer held.
 * That is a leak the lifecycle accounting cannot see, which is the one kind
 * worth being careful about.
 *
 * @returns {boolean} whether the directory is gone. False means it is still
 *   this run's, still on disk, and still in ownedTempRoots() to be reported.
 */
function releaseTempDir(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    return false;
  }
  // rmSync can return without throwing and without having finished — force
  // swallows ENOENT, and a partial recursive removal leaves the root behind.
  // The question is whether it is there, not whether the call complained.
  if (fs.existsSync(root)) return false;
  OWNED.delete(root);
  return true;
}

/** What this run made and has not released — for teardown to account for. */
const ownedTempRoots = () => [...OWNED];

/**
 * Remove what DEAD runs of these harnesses left behind, and nothing else.
 *
 * Returns `{ swept, kept }`, both explaining themselves, so a harness can say
 * in its log what it removed and — more usefully — what it walked past and why.
 */
function sweepStaleRuns(prefixes = [], { dir = os.tmpdir(), graceMs = GRACE_MS, now = Date.now() } = {}) {
  const swept = [];
  const kept = [];
  if (!prefixes.length) return { swept, kept };

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { swept, kept };
  }

  for (const entry of entries) {
    const name = entry.name;
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    // The installed-once Astro cache is what stops every run reinstalling
    // Astro. It is not a run and has no marker, so the rule below would keep it
    // anyway; it is named here because losing it by accident is a five-minute
    // apology per run.
    if (name.includes('astro-cache')) {
      kept.push({ name, why: 'the shared astro cache' });
      continue;
    }
    const full = path.join(dir, name);
    if (!entry.isDirectory()) {
      kept.push({ name, why: 'not a directory' });
      continue;
    }
    if (OWNED.has(full)) {
      kept.push({ name, why: 'this run owns it' });
      continue;
    }

    const owner = readOwner(full);
    if (!owner) {
      // Someone else's, or something whose marker we cannot read. Either way
      // this is not the code that gets to decide it is rubbish.
      kept.push({ name, why: 'no ownership marker this can read' });
      continue;
    }
    if (pidAlive(owner.pid)) {
      kept.push({ name, why: `pid ${owner.pid} is alive (${owner.harness})` });
      continue;
    }
    if (now - owner.createdAt < graceMs) {
      kept.push({ name, why: 'made moments ago' });
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      swept.push({ name, harness: owner.harness, pid: owner.pid, runId: owner.runId });
    } catch (err) {
      kept.push({ name, why: `would not delete: ${String(err && err.message)}` });
    }
  }
  return { swept, kept };
}

module.exports = {
  MARKER,
  KIND,
  GRACE_MS,
  RUN_ID,
  ownedTempDir,
  releaseTempDir,
  ownedTempRoots,
  sweepStaleRuns,
  readOwner,
  pidAlive,
};
