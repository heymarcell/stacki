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

/** Temporary directories this feature's tests make, and only those. */
const FIXTURE_PREFIXES = [
  'stacki-secure-',
  'stacki-share-',
  'stacki-sharepage-',
  'stacki-share-ux-',
];

const fixtures = () => {
  try {
    return fs
      .readdirSync(os.tmpdir())
      .filter((name) => FIXTURE_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .sort();
  } catch {
    return [];
  }
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
      env: { ...process.env, STACKI_CANVAS_OFFLINE: '1' },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}`.trim().slice(-600) };
  }
}

const baseline = snapshot();
say(`secure-lifecycle: ${RUNS} consecutive runs of ${FLOWS.length} flows`);
say(`  starting with ${baseline.fixtures.length} fixture dir(s) and ${baseline.processes.length} process(es) already here\n`);

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
