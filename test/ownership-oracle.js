// The leak the old lifecycle oracle could not see.
//
//   node test/ownership-oracle.js
//
// packaged-lifecycle used to decide cleanliness by difference: the temp
// directories that appeared while the child ran, and any process running out of
// one of them. That misses the case this project found in large numbers — a run
// that deletes its directory SUCCESSFULLY and leaves a process alive out of it.
// The difference is empty, so there is nothing to search for, so nothing is
// found, so the run is clean.
//
// This file is the proof that the replacement is not blind to it, and that the
// thing it replaced was. It builds exactly that situation with a process of its
// own and asks both oracles.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createManifest, residueOfManifest, commandOf } = require('./support/ownership.js');
const { residueOf } = require('./support/ownedResidue.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-agent-oracleproof-'));
  const manifestFile = path.join(os.tmpdir(), `stacki-oracle-manifest-${process.pid}.json`);
  let child = null;
  let listener = null;
  let port = 0;

  try {
    // A process of this test's own, whose command line names the directory —
    // which is exactly how a stranded dev server looks.
    const script = path.join(dir, 'occupant.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n', 'utf8');
    child = spawn(process.execPath, [script], { stdio: 'ignore' });
    await sleep(400);

    // And a port of this test's own, so the port half is proved too.
    listener = net.createServer(() => {});
    await new Promise((done) => listener.listen(0, '127.0.0.1', done));
    port = listener.address().port;

    const manifest = createManifest(manifestFile);
    manifest.path('the fixture', dir);
    manifest.process('the occupant', child.pid);
    manifest.port('the socket', port);
    check('the manifest recorded all three', manifest.read().paths.length === 1 && manifest.read().processes.length === 1 && manifest.read().ports.length === 1);
    check('  and wrote them down where a parent can read them', fs.existsSync(manifestFile));

    // NOW THE DIRECTORY GOES, AND THE PROCESS DOES NOT. This is the shape of
    // the leak: cleanup that succeeded at the part it could see.
    fs.rmSync(dir, { recursive: true, force: true });
    check('the directory really is gone', !fs.existsSync(dir));
    check('  while the process it came from is still alive', commandOf(child.pid) !== null);

    // The old oracle, asked the way the lifecycle actually asked it.
    //
    // It searched for processes running out of the directories that APPEARED
    // while the child ran. This one was deleted, so it is not in that list, so
    // the list handed to the search is empty — and an empty list finds nothing
    // however much is still running. That emptiness is the blind spot, and it
    // is what the argument below models: not "ask about this directory", but
    // "ask about the directories still there", which is none of them.
    const survivingDirs = [dir].filter((d) => fs.existsSync(d));
    check('the old oracle would have had nothing to search for', survivingDirs.length === 0);
    const byDifference = await residueOf(survivingDirs, { graceMs: 1500 });
    check(
      'so the difference-based oracle sees nothing, which is why it was replaced',
      byDifference.dirs.length === 0 && byDifference.processes.length === 0,
      `dirs ${byDifference.dirs.length}, processes ${byDifference.processes.length}`
    );

    // The manifest oracle, asked about identities recorded before the deletion.
    const byIdentity = await residueOfManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), { graceMs: 1500 });
    check('the manifest oracle still finds the process', byIdentity.processes.length === 1, JSON.stringify(byIdentity.processes));
    check('  naming what it was', byIdentity.processes[0]?.what === 'the occupant', JSON.stringify(byIdentity.processes[0] || {}));
    check('  and the port that is still bound', byIdentity.ports.length === 1 && byIdentity.ports[0].port === port, JSON.stringify(byIdentity.ports));
    check('  while agreeing the directory is gone', byIdentity.paths.length === 0);

    // A pid the OS has since given to something else is not this run's leak.
    const reused = await residueOfManifest(
      { processes: [{ what: 'a pid since reused', pid: child.pid, command: 'something else entirely' }], ports: [], paths: [] },
      { graceMs: 500 }
    );
    check('a recorded pid running a different command is not reported', reused.processes.length === 0, JSON.stringify(reused.processes));
  } finally {
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (listener) await new Promise((done) => listener.close(done));
    for (const p of [dir, manifestFile]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* asserted below */
      }
    }
  }

  await sleep(500);
  check('the test ended everything it started', commandOf(child.pid) === null, `pid ${child?.pid}`);
  check('  and removed what it wrote', !fs.existsSync(dir) && !fs.existsSync(manifestFile));

  if (failures.length) {
    console.error(`\nownership-oracle: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`ownership-oracle: ${checked} passed  [a live process out of a deleted directory, seen by identity]`);
})().catch((err) => {
  console.error('ownership-oracle threw\n', err);
  process.exit(1);
});
