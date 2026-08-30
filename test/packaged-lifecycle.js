// The packaged acceptance, five times, each run cleaning up after itself.
//
//   node test/packaged-lifecycle.js
//
// One clean run says the path works. Five say it can be run again — which is
// the thing CI actually needs, and the thing leaks hide. A process left holding
// a port, a fixture left on disk, a userData nobody removed: none of that shows
// up once, and all of it shows up by the fifth.
//
// The streak is strict. A run that passes its own assertions but leaves
// anything behind is not a clean run, and the streak resets rather than being
// reported as "five with one retry".
//
// What counts as owned, and how it is checked, is the same rule as everywhere
// else here: the exact directories and the exact pid this run created. Nothing
// matches on a program's name.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { available, APP } = require('./support/packagedApp.js');
const { processTable } = require('./support/ownedResidue.js');

const RUNS = Number(process.env.STACKI_LIFECYCLE_RUNS || 5);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

/** Temp directories this suite's runs are allowed to make, by prefix. */
const PREFIXES = ['stacki-agent-', 'stacki-packaged-userdata-'];

const tempEntries = () => {
  const dir = fs.realpathSync(os.tmpdir());
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => PREFIXES.some((p) => name.startsWith(p)))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

/** Anything running out of a directory that did not exist before this run. */
const strayProcesses = (created) =>
  processTable().filter((p) => created.some((dir) => p.command.includes(path.basename(dir))));

const runOnce = () =>
  new Promise((done) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'packaged-acceptance.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, STACKI_NO_DIALOGS: '1', STACKI_HIDDEN_WINDOW: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    child.on('exit', (code) => done({ code, output: out.join('') }));
  });

(async () => {
  if (!available()) {
    console.log(`packaged-lifecycle: skipped  [no ${APP} — run npm run dist:mac:unsigned]`);
    return;
  }

  const results = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const before = new Set(tempEntries());
    const { code, output } = await runOnce();

    // A moment for the app to finish going, then what is left that was not
    // there before this run started.
    await new Promise((r) => setTimeout(r, 2000));
    const created = tempEntries().filter((dir) => !before.has(dir));
    const stray = strayProcesses(created);

    const passed = code === 0;
    const clean = created.length === 0 && stray.length === 0;
    results.push({ run, passed, clean, created, stray, output });

    check(`run ${run} passed its own assertions`, passed, passed ? '' : output.split('\n').slice(-8).join('\n    '));
    check(
      `run ${run} left nothing behind`,
      clean,
      [
        created.length ? `${created.length} temp director${created.length === 1 ? 'y' : 'ies'}: ${created.slice(0, 3).map((d) => path.basename(d)).join(', ')}` : '',
        stray.length ? `${stray.length} process(es): ${stray.slice(0, 3).map((p) => `${p.pid} ${p.command.slice(0, 70)}`).join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')
    );

    console.log(`  run ${run}: ${passed ? 'passed' : 'FAILED'} · ${clean ? 'CLEAN' : 'LEFT RESIDUE'}`);
    if (!passed || !clean) {
      // The streak is the point; there is nothing to learn from four more runs
      // once one of them has failed.
      console.log('  streak broken — stopping rather than reporting a longer number');
      break;
    }
  }

  const streak = results.findIndex((r) => !r.passed || !r.clean);
  const consecutive = streak === -1 ? results.length : streak;
  check(`${RUNS} consecutive clean lifecycles`, consecutive === RUNS, `${consecutive} of ${RUNS}`);

  if (failures.length) {
    console.error(`\npackaged-lifecycle: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged-lifecycle: ${checked} passed  [${consecutive}/${RUNS} consecutive, each clean]`);
})().catch((err) => {
  console.error('packaged-lifecycle threw\n', err);
  process.exit(1);
});
