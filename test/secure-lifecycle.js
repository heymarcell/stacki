// Run it five times and check nothing is left behind.
//
//   npm run test:securelifecycle
//
// A suite that passes and leaks is a suite that will be run again tomorrow,
// and the day after, until the machine has forty dev servers on it and
// presents as being slow rather than as anything to do with tests. Stacki has
// had exactly that.
//
// So the important multi-process flows are run repeatedly, and between runs
// this counts what is actually on the machine: processes, listening ports,
// temporary directories. A leak resets the clean-run count.
//
// WHAT IT COUNTS IS ITS OWN. Every fixture this feature makes is named — the
// relay data directories, the userData directories, the Electron processes
// running these particular scripts — and only those are counted. There is a
// known pre-existing `stacki-rename-*` leak from test/css-vars-rename.js and
// there may be other checkouts of Stacki running on the same machine; neither
// is this feature's leak and neither is touched. Counting broadly would make
// this test fail for somebody else's reason, which is worse than not having it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const RUNS = Number(process.env.STACKI_LIFECYCLE_RUNS || 5);

// The flows worth repeating: each one starts processes, binds ports and makes
// directories, and each one is supposed to give all of them back.
const FLOWS = [
  { name: 'secure relay', script: 'test/secure-relay.js', node: true },
  { name: 'two clients over a relay', script: 'test/secure-share.js', node: true },
  { name: 'the share page in a browser', script: 'test/share-page-privacy.js', node: false },
];

const { readOwner, pidAlive, MARKER, SUITE_ENV } = require('./support/ownedTemp.js');

/** The harnesses these flows run, as they stamp their own fixtures. */
const OUR_HARNESSES = new Set(['secure-relay', 'secure-share', 'share-page-privacy', 'packaged-deeplink']);

/**
 * THIS run of this suite, told to every harness it starts.
 *
 * Set in the environment before anything is spawned; `ownedTempDir` reads it
 * at write time and stamps it into every marker. Nothing else on the machine
 * has this string.
 */
const SUITE_ID = `lifecycle-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
process.env[SUITE_ENV] = SUITE_ID;

/**
 * Fixtures left behind by THIS run.
 *
 * Ownership, not name matching, and not harness names either.
 *
 * The first version listed every directory whose name began with one of a few
 * prefixes, so a second checkout could make this run report a leak it had
 * nothing to do with. The second version read PR #8's ownership marker and
 * asked whether the harness was one of ours and its process gone — better, and
 * still wrong in a way that only shows up when two of these run at once:
 *
 *   run A starts, and leaves a fixture; A's process is alive
 *   run B starts, and takes its baseline — A is alive, so B ignores it
 *   A dies badly, leaving the fixture behind
 *   B finishes a pass and looks again — A's pid is dead now, and A's harness
 *   is one of the four names B also uses, so B counts A's leak as its own
 *
 * B then fails, having leaked nothing. The identity was too coarse: "one of
 * these four harnesses, no longer running" describes every run there has ever
 * been, not this one.
 *
 * So each run of this suite mints an id and puts it in the environment of the
 * harnesses it spawns. A directory counts only when all of these hold:
 *
 *   it carries an ownership marker  — no marker is somebody else's business
 *   the suite id is THIS run's      — a parallel run is not this run, alive or dead
 *   the harness is one of ours      — a stray mark from elsewhere is not a flow
 *   the owning process is gone      — a live one is a child still working
 *
 * The second is what makes the accounting run-specific, and it holds whether
 * or not the other run is still breathing. This is accounting, not collection:
 * nothing here deletes anything. The global stale-run sweep in
 * `sweepStaleRuns` is untouched and still the only thing that removes.
 */
const fixtures = () => {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(os.tmpdir(), name);
    let owner;
    try {
      if (!fs.existsSync(path.join(full, MARKER))) continue;
      owner = readOwner(full);
    } catch {
      continue;
    }
    if (!owner || owner.suite !== SUITE_ID) continue; // another run's, alive or dead
    if (!OUR_HARNESSES.has(owner.harness)) continue;
    if (pidAlive(owner.pid)) continue; // a child still using it
    out.push(name);
  }
  return out.sort();
};

/**
 * Processes running THESE scripts, from THIS checkout.
 *
 * Matched on the script path so another Stacki checkout running its own
 * harnesses on the same machine is somebody else's business.
 */
function ourProcesses() {
  let out = '';
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const ours = [];
  for (const line of out.split('\n')) {
    if (!line.includes(root)) continue;
    const isFlow = FLOWS.some((flow) => line.includes(flow.script));
    const isRelay = line.includes('relay/node/bin.js') || line.includes('service/bin.js');
    if (isFlow || isRelay) ours.push(line.trim().slice(0, 120));
  }
  return ours;
}

const snapshot = () => ({ fixtures: fixtures(), processes: ourProcesses() });

const diff = (before, after) => ({
  fixtures: after.fixtures.filter((f) => !before.fixtures.includes(f)),
  processes: after.processes.filter((p) => !before.processes.includes(p)),
});

function run(flow) {
  const command = flow.node ? 'node' : path.join(root, 'node_modules', '.bin', 'electron');
  const args = flow.node ? ['--disable-warning=ExperimentalWarning', flow.script] : [flow.script];
  try {
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300000,
      env: { ...process.env, STACKI_CANVAS_OFFLINE: '1', [SUITE_ENV]: SUITE_ID },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}`.trim().slice(-600) };
  }
}

// --- the accounting is about THIS run ---------------------------------------
//
// Proved before anything else, because a leak report that cannot tell a
// parallel session's work from its own is a leak report nobody can act on.
{
  const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');

  // A pid that cannot be running. 1 is init, and never one of these harnesses,
  // so a very high one this machine has not reached is used instead.
  const GONE = 4194303;
  const restamp = (dir, patch) => {
    const marker = path.join(dir, MARKER);
    fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(fs.readFileSync(marker, 'utf8')), ...patch }), 'utf8');
    return dir;
  };
  /** A fixture made as though by another run of this same suite. */
  const otherRun = (prefix, harness, suite) => {
    const was = process.env[SUITE_ENV];
    process.env[SUITE_ENV] = suite;
    try {
      return ownedTempDir(prefix, { harness });
    } finally {
      process.env[SUITE_ENV] = was;
    }
  };
  const counted = (dir) => fixtures().includes(path.basename(dir));

  // Our own child, still working. Alive, so not a leak.
  const ours = ownedTempDir('stacki-share-mine-', { harness: 'secure-share' });
  check('a fixture whose owner is still running is not counted as a leak', !counted(ours), path.basename(ours));

  // A directory with the same prefix and no marker at all — another checkout,
  // an older Stacki, somebody's mkdtemp. Not ours to count and not ours to touch.
  const unmarked = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-share-unmarked-'));
  check('an unmarked directory of the same shape is somebody else’s business', !counted(unmarked));

  // A fixture from a harness that is not one of these flows.
  const other = ownedTempDir('stacki-share-other-', { harness: 'review-ux-visual' });
  check('another harness’s fixture is not counted either', !counted(other));

  // THE ONE THE OLD MODEL GOT WRONG.
  //
  // Run A is a parallel run of THIS suite: same four harness names, same
  // shape of directory. While A is alive, both models ignore it. Then A dies
  // badly and leaves the fixture — and the old model, which asked only
  // "one of our harnesses, and is the process gone?", started counting it as
  // this run's leak. It is not: it carries A's suite id, not ours.
  const runA = otherRun('stacki-share-parallel-', 'secure-share', 'lifecycle-someone-else');
  check('a parallel run of this same suite is not counted while it is alive', !counted(runA), path.basename(runA));
  restamp(runA, { pid: GONE });
  check('AND IS STILL NOT COUNTED ONCE IT DIES', !counted(runA), path.basename(runA));

  // A fixture from a run with no suite id at all — a harness started by hand,
  // or an older build. Also not this run's.
  const loose = otherRun('stacki-share-loose-', 'secure-share', '');
  restamp(loose, { pid: GONE });
  check('nor is a dead fixture that belongs to no suite run', !counted(loose), path.basename(loose));

  // And one of OURS whose owner is gone: that IS a leak, and it must be seen.
  const dead = restamp(ownedTempDir('stacki-share-dead-', { harness: 'secure-share' }), { pid: GONE });
  check('a fixture of THIS run whose owner has gone IS counted', counted(dead), path.basename(dead));

  releaseTempDir(ours);
  releaseTempDir(other);
  releaseTempDir(dead);
  releaseTempDir(runA);
  releaseTempDir(loose);
  fs.rmSync(unmarked, { recursive: true, force: true });
  check('and the proof cleaned up after itself', fixtures().length === 0, JSON.stringify(fixtures()));
}

const baseline = snapshot();
say(`secure-lifecycle: ${RUNS} consecutive runs of ${FLOWS.length} flows`);
say(`  starting with ${baseline.fixtures.length} owned leftover(s) and ${baseline.processes.length} process(es) already here\n`);

let clean = 0;
for (let pass = 1; pass <= RUNS; pass++) {
  const before = snapshot();
  let allPassed = true;
  for (const flow of FLOWS) {
    const result = run(flow);
    if (!result.ok) {
      allPassed = false;
      check(`pass ${pass}: ${flow.name} passed`, false, result.output);
    }
  }
  // A moment for an operating system to reap what was closed. Nothing here
  // waits on a timer to pass — this is only so the count is not taken while a
  // process is still in the middle of exiting.
  execFileSync('sleep', ['1']);
  const after = snapshot();
  const left = diff(before, after);

  const noProcesses = check(`pass ${pass}: no process was left running`, left.processes.length === 0, left.processes.join('\n    '));
  const noFixtures = check(`pass ${pass}: no fixture directory was left behind`, left.fixtures.length === 0, left.fixtures.join(', '));

  if (allPassed && noProcesses && noFixtures) {
    clean += 1;
    say(`  pass ${pass}: clean`);
  } else {
    // A leak resets the count. Five clean runs means five in a row.
    clean = 0;
    shout(`  pass ${pass}: NOT clean`);
  }
}

const finalState = snapshot();
const overall = diff(baseline, finalState);
check(`${RUNS} consecutive clean runs`, clean === RUNS, `${clean} in a row`);
check('nothing accumulated across all of them', overall.processes.length === 0 && overall.fixtures.length === 0, JSON.stringify(overall));

// The ports these flows bind are all ephemeral and chosen at run time, so
// "the port is reusable" is the same statement as "the process is gone" —
// which is what was just counted. What is worth asserting separately is that
// nothing here binds a FIXED port that a second run would collide with.
const fixedPorts = [];
for (const flow of FLOWS) {
  const text = fs.readFileSync(path.join(root, flow.script), 'utf8');
  if (/listen\(\s*\d{4,5}\s*,/.test(text)) fixedPorts.push(flow.script);
}
check('no flow binds a fixed port', fixedPorts.length === 0, fixedPorts.join(', '));

if (failures.length) {
  shout(`\nsecure-lifecycle: ${failures.length} failed, ${checked - failures.length} passed\n`);
  shout(failures.join('\n') + '\n');
  process.exit(1);
}
say(`\nsecure-lifecycle: ${checked} checks passed  [${RUNS} clean runs, nothing left behind]`);
