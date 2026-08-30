// The packaged acceptance, five times, each run accounted for by identity.
//
//   node test/packaged-lifecycle.js
//
// One clean run says the path works. Five say it can be run again — which is
// what CI needs, and what leaks hide.
//
// HOW THIS USED TO BE BLIND, because it is the whole reason the oracle changed.
// It worked by difference: list the temp directories before the child, list them
// after, and look for processes running out of whatever appeared. A child that
// deleted its project and userData SUCCESSFULLY and left a server running out of
// the now-deleted directory produced an empty difference — no paths to search
// for, so no processes found, so the run was declared clean while a port stayed
// bound. That is the exact leak this project found in large numbers.
//
// So the child now writes down what it owns as it acquires it (see
// test/support/ownership.js) and the parent verifies those identities after the
// child has exited and forgotten them. A pid is judged together with the command
// it was recorded under, so a pid the OS has reused is not mistaken for a leak,
// and nothing is identified by a program's name.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { available, APP } = require('./support/packagedApp.js');
const { residueOfManifest, describeManifestResidue } = require('./support/ownership.js');

const RUNS = Number(process.env.STACKI_LIFECYCLE_RUNS || 5);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const runOnce = (manifestPath) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'packaged-acceptance.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        STACKI_NO_DIALOGS: '1',
        STACKI_HIDDEN_WINDOW: '1',
        STACKI_OWNERSHIP_MANIFEST: manifestPath,
      },
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

  const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-lifecycle-manifests-'));
  let consecutive = 0;

  try {
    for (let run = 1; run <= RUNS; run += 1) {
      const manifestPath = path.join(manifestDir, `run-${run}.json`);
      const { code, output } = await runOnce(manifestPath);

      const passed = code === 0;
      check(`run ${run} passed its own assertions`, passed, passed ? '' : output.split('\n').slice(-10).join('\n    '));

      // The manifest has to EXIST. A child that wrote nothing has not proved it
      // owned nothing — it has proved nothing, and treating that as clean is how
      // an oracle stops being one.
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        manifest = null;
      }
      const recorded = manifest
        ? manifest.processes.length + manifest.ports.length + manifest.paths.length
        : 0;
      // WHAT A FINISHED RUN OWNS, by kind — not a count.
      //
      // Three claims are written before the app is even spawned, so a count
      // greater than zero was satisfied by a child that died at launch: it
      // recorded nothing it had acquired and was reported as having recorded
      // what it owned. A run that got as far as running the app must have an
      // app process, a preview port and both directories, and must have said
      // it finished accounting for them.
      const kinds = manifest
        ? {
            completed: manifest.completed === true,
            app: manifest.processes.some((p) => p.what === 'packaged app'),
            preview: manifest.ports.some((p) => p.what === 'preview'),
            mcp: manifest.ports.some((p) => p.what === 'mcp'),
            project: manifest.paths.some((p) => p.what === 'project'),
            userData: manifest.paths.some((p) => p.what === 'userData'),
          }
        : {};
      const missing = Object.entries(kinds).filter(([, had]) => !had).map(([k]) => k);
      const wrote = !!manifest && missing.length === 0;
      check(
        `run ${run} recorded what a finished run owns`,
        wrote,
        manifest ? `never recorded: ${missing.join(', ')}` : `no manifest at ${manifestPath}`
      );

      let clean = false;
      let detail = '';
      if (wrote) {
        const residue = await residueOfManifest(manifest);
        clean = !residue.processes.length && !residue.ports.length && !residue.paths.length;
        detail = describeManifestResidue(residue);
      }
      check(`run ${run} left nothing it had recorded`, wrote && clean, detail);

      const ok = passed && wrote && clean;
      console.log(
        `  run ${run}: ${passed ? 'passed' : 'FAILED'} · ${recorded} owned · ${ok ? 'CLEAN' : 'LEFT RESIDUE'}` +
          (ok ? '' : `  ${detail}`)
      );
      if (!ok) {
        console.log('  streak broken — stopping rather than reporting a longer number');
        break;
      }
      consecutive += 1;
    }
  } finally {
    // The manifests are this suite's own artefact and go with it.
    try {
      fs.rmSync(manifestDir, { recursive: true, force: true });
    } catch {
      /* reported below */
    }
  }
  check('the manifests this suite wrote are gone', !fs.existsSync(manifestDir), manifestDir);
  check(`${RUNS} consecutive clean lifecycles`, consecutive === RUNS, `${consecutive} of ${RUNS}`);

  if (failures.length) {
    console.error(`\npackaged-lifecycle: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged-lifecycle: ${checked} passed  [${consecutive}/${RUNS} consecutive, each accounted for by identity]`);
})().catch((err) => {
  console.error('packaged-lifecycle threw\n', err);
  process.exit(1);
});
