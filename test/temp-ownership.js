// Whose temp directory is it, and may this run delete it.
//
//   node test/temp-ownership.js
//
// The harnesses that drive a real Electron sweep the temp directory at startup,
// because each run leaves a userData behind that teardown cannot remove. The
// sweep used to be a prefix match followed by rm -rf, on the assumption that a
// directory another process was using would refuse to be deleted.
//
// Unlink does not consult anybody. A process can be running with files open
// inside a tree while another process deletes it, and on macOS that is exactly
// what happened: `review-ux-visual` swept `stacki-canvas-`, which is the prefix
// of the Astro fixture EVERY canvas harness builds, so starting it while
// `agent-canvas` was working deleted the project out of the middle of the other
// run. Two of these can now be going at once, in different worktrees, driven by
// different people.
//
// So ownership is written down rather than guessed from a name, and the five
// cases below are the whole decision. Four of them keep the directory.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  MARKER,
  KIND,
  GRACE_MS,
  ownedTempDir,
  releaseTempDir,
  ownedTempRoots,
  sweepStaleRuns,
  readOwner,
  pidAlive,
} = require('./support/ownedTemp.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// Everything happens inside one directory of this run's own, so a suite about
// not deleting other people's files does not go looking through /tmp to prove
// it. `dir` is an option for exactly this reason.
const yard = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ownership-yard-')));
const PREFIX = 'stacki-owned-';
const at = (name) => path.join(yard, name);

/** A directory with a marker of our choosing — the shapes a sweep can meet. */
const plant = (name, marker) => {
  const dir = at(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'something a run was using', 'utf8');
  if (marker !== undefined) fs.writeFileSync(path.join(dir, MARKER), marker, 'utf8');
  return dir;
};

/** A pid that is definitely finished: a child that has already exited. */
const deadPid = (() => {
  const r = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  return r.pid;
})();

const old = Date.now() - GRACE_MS - 60_000;
const ownerJSON = (over = {}) =>
  JSON.stringify({ kind: KIND, harness: 'a-test', runId: 'r1', pid: deadPid, createdAt: old, ...over });

try {
  // ── the current run's own resources ───────────────────────────────────────
  const mine = ownedTempDir(PREFIX, { harness: 'temp-ownership', dir: yard });
  check('a run gets a temp directory of its own', fs.existsSync(mine));
  check('and it is marked', fs.existsSync(path.join(mine, MARKER)));
  const own = readOwner(mine);
  check('the marker names this process', own?.pid === process.pid, JSON.stringify(own));
  check('and the harness that asked for it', own?.harness === 'temp-ownership', JSON.stringify(own));
  check('and a run id, so two runs of one harness are told apart', typeof own?.runId === 'string' && own.runId.length > 0);
  check('and when it was made', Number.isFinite(own?.createdAt));
  check('the run knows what it is holding', ownedTempRoots().includes(mine));

  // ── a LIVE owned run survives the sweep ───────────────────────────────────
  //
  // The one that mattered: this process is alive, so this process's fixture is
  // in use, and a sweep running beside it must walk past.
  const live = plant('stacki-owned-live', ownerJSON({ pid: process.pid, harness: 'another-live-harness', createdAt: old }));
  // …and one belonging to a live process that is not this one, which is the
  // real parallel case. `process.ppid` is alive by definition: it is the shell
  // waiting on this.
  const liveOther = plant('stacki-owned-live-other', ownerJSON({ pid: process.ppid, harness: 'a-parallel-harness', createdAt: old }));

  // ── a DEAD owned run is removable ─────────────────────────────────────────
  const dead = plant('stacki-owned-dead', ownerJSON());

  // ── a same-prefix directory nobody claimed ────────────────────────────────
  //
  // Somebody else's, or something older than this scheme. Not this code's to
  // decide about.
  const unmarked = plant('stacki-owned-unknown', undefined);

  // ── markers that cannot be believed ───────────────────────────────────────
  const malformed = plant('stacki-owned-malformed', '{ this is not json');
  const foreign = plant('stacki-owned-foreign', JSON.stringify({ kind: 'someone-elses-tool', pid: deadPid, createdAt: old }));
  const noPid = plant('stacki-owned-nopid', JSON.stringify({ kind: KIND, harness: 'a-test', runId: 'r', createdAt: old }));
  const badPid = plant('stacki-owned-badpid', ownerJSON({ pid: 'not-a-number' }));
  const noTime = plant('stacki-owned-notime', JSON.stringify({ kind: KIND, harness: 'a-test', runId: 'r', pid: deadPid }));

  // ── a dead run that only just finished ────────────────────────────────────
  const fresh = plant('stacki-owned-fresh', ownerJSON({ createdAt: Date.now() }));

  // ── something that is not a directory ─────────────────────────────────────
  fs.writeFileSync(at('stacki-owned-a-file'), 'not a directory', 'utf8');

  // ── the shared astro cache ────────────────────────────────────────────────
  const cache = plant('stacki-owned-astro-cache', ownerJSON());

  const { swept, kept } = sweepStaleRuns([PREFIX, 'stacki-owned-'], { dir: yard });
  const sweptNames = swept.map((s) => s.name);
  const keptNames = kept.map((k) => k.name);
  const why = (name) => kept.find((k) => k.name === name)?.why || '(not kept)';

  check('a dead run is swept', sweptNames.includes('stacki-owned-dead'), JSON.stringify(sweptNames));
  check('and is really gone', !fs.existsSync(dead));

  check("this run's own directory survives", fs.existsSync(mine), why(path.basename(mine)));
  check('a live owned run survives', fs.existsSync(live), why('stacki-owned-live'));
  check('including one owned by another live process', fs.existsSync(liveOther), why('stacki-owned-live-other'));
  check('and the sweep says why it kept it', /alive/.test(why('stacki-owned-live-other')), why('stacki-owned-live-other'));

  check('an unmarked same-prefix directory survives', fs.existsSync(unmarked), why('stacki-owned-unknown'));
  check('a malformed marker survives', fs.existsSync(malformed), why('stacki-owned-malformed'));
  check("another tool's marker survives", fs.existsSync(foreign), why('stacki-owned-foreign'));
  check('a marker with no pid survives', fs.existsSync(noPid), why('stacki-owned-nopid'));
  check('a marker with a pid that is not a number survives', fs.existsSync(badPid), why('stacki-owned-badpid'));
  check('a marker with no creation time survives', fs.existsSync(noTime), why('stacki-owned-notime'));
  check('a run that has only just finished survives', fs.existsSync(fresh), why('stacki-owned-fresh'));
  check('the shared astro cache survives', fs.existsSync(cache), why('stacki-owned-astro-cache'));
  check('a plain file is not treated as a run', fs.existsSync(at('stacki-owned-a-file')), why('stacki-owned-a-file'));

  check('nothing else was swept', swept.length === 1, JSON.stringify(sweptNames));
  check('and everything kept is accounted for with a reason', kept.every((k) => typeof k.why === 'string' && k.why.length > 0), JSON.stringify(kept));
  check('the keep list names them all', keptNames.length >= 11, JSON.stringify(keptNames));

  // ── a name that is not ours is never even looked at ───────────────────────
  //
  // stacki-rename-* is a temp leak that predates all of this and belongs to a
  // different part of the app. A sweep is given prefixes; it must not widen
  // them.
  const rename = plant('stacki-rename-1234', ownerJSON());
  sweepStaleRuns([PREFIX, 'stacki-owned-'], { dir: yard });
  check('a prefix that was not asked for is left alone', fs.existsSync(rename));

  // ── and a run removes its own, normally ───────────────────────────────────
  const removed = releaseTempDir(mine);
  check('a run can remove its own fixture', removed === true);
  check('and it is gone', !fs.existsSync(mine));
  check('and it is no longer counted as held', !ownedTempRoots().includes(mine));

  // ── pidAlive answers safely when it cannot know ───────────────────────────
  check('this process is alive', pidAlive(process.pid) === true);
  check('a finished child is not', pidAlive(deadPid) === false, String(deadPid));
  check('and anything unreadable is treated as alive', pidAlive(0) === true && pidAlive(-1) === true && pidAlive(null) === true);

  // ── an empty prefix list sweeps nothing ───────────────────────────────────
  const nothing = sweepStaleRuns([], { dir: yard });
  check('no prefixes means no sweep', nothing.swept.length === 0 && nothing.kept.length === 0);
} finally {
  fs.rmSync(yard, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\ntemp-ownership: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`temp-ownership: ${checked} passed  [a prefix is not ownership]`);
