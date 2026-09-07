// The harness, put in front of its own oracle.
//
//   node test/suite-guard-meta.js
//
// Every other suite in this repository asks whether the PRODUCT works. This one
// asks whether a green run means anything, because twice now the answer has
// been no in a way nothing could see.
//
// WHAT WAS MEASURED, in this worktree, before a line of this file existed.
//
// 1. THE GUARD'S FAILING BRANCH WAS CODE THAT COULD ONLY PASS. `guardSuite`
//    (test/support/suiteGuard.js) exists because a suite whose last await never
//    settles drains node's event loop and exits 0 — a silent pass. It was
//    reached by 13 of the 180 entries in the npm test chain, and by NOTHING that
//    asserts what it does: no suite anywhere spawns a guarded child, ends it
//    early, and reads a non-zero status back. Its two failure paths — the exit
//    handler and the deadline — could be deleted and every one of those 180
//    entries would still be green. A guard nobody has watched fail is a comment.
//
// 2. A SUITE THAT ASSERTS NOTHING REPORTS THE SAME ZERO AS ONE THAT ASSERTED
//    EVERYTHING. Measured here, same file, same machine, minutes apart:
//
//        node test/packaged-lifecycle.js                    → EXIT=0  "17 passed"
//        …with the one path its available() probes absent    → EXIT=0  "skipped"
//
//    and three suites that are actually IN the chain do it off an environment
//    variable, so no bundle is even needed to reproduce it:
//
//        STACKI_HOSTED_RUNNER=1 node test/hover-cost.js        → EXIT=0, 0 checks
//        STACKI_HOSTED_RUNNER=1 node test/popover-dropdown.js  → EXIT=0, 0 checks
//        STACKI_HOSTED_RUNNER=1 node test/shared-acceptance.js → EXIT=0, 0 checks
//
//    Nothing in the repository asserts a suite's TRUE process exit status, and
//    nothing asserts that a non-zero one stops the chain. The whole 180-entry
//    chain is one `&&` sequence whose semantics no test has ever checked.
//
// HOW THIS FILE IS DIFFERENT FROM THE THING IT TESTS. Its subject is a process
// exit code, so it may not read one from a summary line, from stdout, or from
// the tail of a pipeline — `node x.js | tail` reports tail's status, which is
// how a suite's failure becomes invisible in the first place. Every child here
// is spawned, OWNED by its pid, and judged on the `code` argument the OS hands
// to its `exit` event. A child that has to be killed to end is a failure, not a
// cleanup detail, and it is killed by that exact pid — never by name.
//
// AND IT CARRIES ITS OWN POSITIVE CONTROLS. A file that only asserts "these
// children exit non-zero" would be satisfied by a node that could not run any
// of them. So the same early-exit shape is run twice, once WITHOUT the guard —
// which must exit 0, proving the hazard is real and that the guard is the only
// difference — and a child that genuinely finishes must exit 0 with its summary
// on stdout, proving the guard does not simply fail everything.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');
const { guardSuite } = require('./support/suiteGuard.js');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(__dirname, 'support', 'suiteGuard.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 240) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);

// The one line every child fixture starts with, pointing at the real guard
// rather than a copy of it: this file must fail when THAT file changes.
const GUARD_REQUIRE = 'const { guardSuite, skipSuite } = require(' + JSON.stringify(GUARD) + ');\n';

/**
 * Run a child and report what the OS said about it.
 *
 * `code` is the exit status as delivered to the `exit` event — the only place in
 * this file a status may come from. `signal` and `killed` are here because a
 * child that had to be put down did not exit on its own, and a suite that reads
 * the resulting 143 as "non-zero, good" would pass on a fixture that hung.
 *
 * The bound is a timer this process owns, and it kills ONE pid: the child's.
 */
const runChild = (file, { env = {}, waitMs = 30000, args = [] } = {}) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => err.push(String(d)));
    let killed = false;
    const bound = setTimeout(() => {
      killed = true;
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* it ended between the timer firing and this line; the exit event decides */
      }
    }, waitMs);
    child.on('exit', (code, signal) => {
      clearTimeout(bound);
      done({ code, signal, killed, stdout: out.join(''), stderr: err.join(''), pid: child.pid });
    });
  });

/** Run a real shell sequence — the `&&` the npm test chain is made of. */
const runShell = (script, { waitMs = 30000 } = {}) =>
  new Promise((done) => {
    const child = spawn('/bin/sh', ['-c', script], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    let killed = false;
    const bound = setTimeout(() => {
      killed = true;
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, waitMs);
    child.on('exit', (code, signal) => {
      clearTimeout(bound);
      done({ code, signal, killed, output: out.join('') });
    });
  });

/** A status that is genuinely the child's own, and genuinely not success. */
const failedOnItsOwn = (r) => r.killed === false && r.signal === null && typeof r.code === 'number' && r.code !== 0;
const passedOnItsOwn = (r) => r.killed === false && r.signal === null && r.code === 0;
const say = (r) => `code=${JSON.stringify(r.code)} signal=${JSON.stringify(r.signal)} killed=${r.killed} out=${short(r.stdout || r.output)} err=${short(r.stderr)}`;

// ---------------------------------------------------------------------------
// The fixtures. Each is a suite in miniature, and each is one shape a real
// suite in this repository actually has.

const FIXTURES = {
  // The hazard itself, with no guard: an await nobody settles. This one MUST
  // exit 0 — it is the control that makes every "non-zero" below mean
  // something, and it is what 167 of the 180 chain entries would do today.
  'unguarded-never-settles.js':
    "(async () => {\n" +
    "  console.log('unguarded: reached the middle');\n" +
    "  await new Promise(() => {});\n" +
    "  console.log('unguarded: 3 passed');\n" +
    "})();\n",

  // The same shape, guarded. Node still exits 0 on the drained loop; the guard's
  // exit handler is the only thing that can turn that into a failure.
  'guarded-never-settles.js':
    GUARD_REQUIRE +
    "guardSuite('guarded-never-settles');\n" +
    "(async () => {\n" +
    "  console.log('guarded-never-settles: reached the middle');\n" +
    "  await new Promise(() => {});\n" +
    "  console.log('guarded-never-settles: 3 passed');\n" +
    "})();\n",

  // The skip escape under a guard: prints a human-readable line and returns,
  // asserting nothing. This is test/packaged-lifecycle.js's shape exactly, and
  // an UNDECLARED skip must not be able to end a guarded suite quietly.
  'guarded-skip-escape.js':
    GUARD_REQUIRE +
    "guardSuite('guarded-skip-escape');\n" +
    "console.log('guarded-skip-escape: skipped  [no bundle]');\n" +
    "process.exit(0);\n",

  // Held handle: the loop never empties, so the exit handler never runs and only
  // the deadline can end it. 400ms so the suite stays fast.
  'guarded-hangs-holding-a-handle.js':
    "const net = require('node:net');\n" +
    GUARD_REQUIRE +
    "guardSuite('guarded-hangs-holding-a-handle', 400);\n" +
    "net.createServer().listen(0, '127.0.0.1', () => console.log('guarded-hangs-holding-a-handle: holding a socket'));\n",

  // A throw in the middle of the run.
  'guarded-crashes-midrun.js':
    GUARD_REQUIRE +
    "guardSuite('guarded-crashes-midrun');\n" +
    "(async () => {\n" +
    "  console.log('guarded-crashes-midrun: reached the middle');\n" +
    "  throw new Error('the fixture broke here on purpose');\n" +
    "})();\n",

  // The honest ending: assertions, done(), a summary, exit 0.
  'guarded-completes.js':
    GUARD_REQUIRE +
    "const done = guardSuite('guarded-completes');\n" +
    "(async () => {\n" +
    "  await new Promise((r) => setTimeout(r, 10));\n" +
    "  done();\n" +
    "  console.log('guarded-completes: 3 passed  [it really got to the end]');\n" +
    "})();\n",

  // A summary line is not a pass. This one finishes properly, prints its
  // summary, and reports that a check failed — the status is what counts.
  'guarded-completes-with-a-failed-check.js':
    GUARD_REQUIRE +
    "const done = guardSuite('guarded-completes-with-a-failed-check');\n" +
    "(async () => {\n" +
    "  await new Promise((r) => setTimeout(r, 10));\n" +
    "  done();\n" +
    "  console.log('guarded-completes-with-a-failed-check: 1 of 3 failed');\n" +
    "  console.error('  the thing under test did not do the thing');\n" +
    "  process.exit(1);\n" +
    "})();\n",

  // A DECLARED skip: it tells the guard this ending is legitimate, and it tells
  // the caller it asserted nothing. Under STACKI_NO_SKIPS it must refuse to.
  'declared-skip.js':
    GUARD_REQUIRE +
    "const done = guardSuite('declared-skip');\n" +
    "skipSuite('declared-skip', 'no packaged app on this machine', done);\n",
};

// The two halves of a real `&&` chain, used to prove the chain stops.
const CHAIN_FIXTURES = {
  'chain-step-fails.js': "console.log('chain-step-fails: 1 of 1 failed');\nprocess.exit(1);\n",
  'chain-step-passes.js': "console.log('chain-step-passes: 1 passed');\n",
};

// ---------------------------------------------------------------------------
// The inventory half. These read the npm test chain rather than running it —
// 180 entries is an hour of Electron — and they are ratchets, not measurements:
// each one fails in the direction of a NEW hole, and stays quiet when a hole is
// filled.

const chainEntries = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.scripts.test.split('&&').map((step) => {
    const name = step.trim();
    const ref = name.match(/^npm run (\S+)$/);
    const script = ref ? String(pkg.scripts[ref[1]] || '') : name;
    const files = [...script.matchAll(/(test\/[\w./-]+\.js)/g)].map((m) => m[1]);
    return { name, script: ref ? ref[1] : name, files };
  });
};

/** Whether a suite file reaches the guard at all. */
const isGuarded = (file) => {
  const full = path.join(ROOT, file);
  return fs.existsSync(full) && /guardSuite\s*\(/.test(fs.readFileSync(full, 'utf8'));
};

/**
 * Suite files with an UNDECLARED skip escape: a line that prints "skipped" and
 * a return or exit within three lines of it, outside a comment. Deliberately
 * the same crude shape the escape itself has — it is looking for a hand-written
 * early return, not parsing JavaScript.
 */
const skipEscapesIn = (file) => {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return [];
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (!/skipped/.test(line)) return;
    if (!/(console\.log|process\.stdout\.write|say)\s*\(/.test(line)) return;
    if (/skipSuite\s*\(/.test(line)) return;
    if (!/(^|\W)(return|process\.exit\(0\))/.test(lines.slice(i + 1, i + 4).join(' '))) return;
    found.push(`${file}:${i + 1}`);
  });
  return found;
};

// THE FLOOR, not the goal. 13 of 180 on the day this file was written. It may
// only go up; a suite that drops its guard makes this red.
const GUARDED_FLOOR = 13;

// EVERY UNDECLARED SKIP ESCAPE IN THE CHAIN as of 2026-09-07, each measured to
// exit 0 with zero checks. This list may SHRINK — adopting skipSuite removes an
// entry and nothing here complains — but a new one fails this suite, which is
// the only moment anybody will be looking.
const KNOWN_SKIP_ESCAPES = new Set([
  'test/agent-canvas.js',
  'test/field-focus.js',
  'test/hover-cost.js',
  'test/mcp-audit.js',
  'test/panel-field.js',
  'test/panel-surface.js',
  'test/popover-dropdown.js',
  'test/review-ux-visual.js',
  'test/shared-acceptance.js',
  'test/vars-row-height.js',
]);

// The three whose skip is reachable from an environment variable alone, so the
// rule can be checked against REAL chain suites rather than only fixtures.
const ENV_GATED_SKIPS = [
  { file: 'test/hover-cost.js', env: { STACKI_HOSTED_RUNNER: '1' } },
  { file: 'test/popover-dropdown.js', env: { STACKI_HOSTED_RUNNER: '1' } },
  { file: 'test/shared-acceptance.js', env: { STACKI_HOSTED_RUNNER: '1' } },
];

(async () => {
  const suiteDone = guardSuite('suite-guard-meta', 300000);
  const tmp = ownedTempDir('stacki-suite-guard-meta-', { harness: 'suite-guard-meta' });
  const write = (name, source) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, source, 'utf8');
    return file;
  };
  for (const [name, source] of Object.entries(FIXTURES)) write(name, source);
  for (const [name, source] of Object.entries(CHAIN_FIXTURES)) write(name, source);

  try {
    // -----------------------------------------------------------------------
    // 1. THE CONTROL. Without the guard, the exact shape below exits 0.
    {
      const r = await runChild(path.join(tmp, 'unguarded-never-settles.js'));
      check('an UNGUARDED suite whose last await never settles exits 0 — the hazard is real', passedOnItsOwn(r), say(r));
      check('  and it exits 0 having printed no summary at all', !/passed/.test(r.stdout), say(r));
    }

    // 2. THE SAME SHAPE, GUARDED. The only difference is the guard.
    {
      const r = await runChild(path.join(tmp, 'guarded-never-settles.js'));
      check('a GUARDED suite that never settles exits NON-ZERO', failedOnItsOwn(r), say(r));
      check('  and says the process exited before the suite finished', /exited before the suite finished/.test(r.stderr), say(r));
      check('  and the status is the child’s own, not a signal we sent it', r.signal === null && r.killed === false, say(r));
    }

    // 3. THE SKIP ESCAPE, GUARDED. packaged-lifecycle.js's exact shape.
    {
      const r = await runChild(path.join(tmp, 'guarded-skip-escape.js'));
      check('a guarded suite that takes an UNDECLARED skip escape exits NON-ZERO', failedOnItsOwn(r), say(r));
      check('  even though it called process.exit(0) itself', r.code !== 0 && /skipped/.test(r.stdout), say(r));
    }

    // 4. THE DEADLINE. A hang that holds a handle never reaches the exit handler.
    {
      const r = await runChild(path.join(tmp, 'guarded-hangs-holding-a-handle.js'), { waitMs: 15000 });
      check('a guarded suite that hangs HOLDING a handle exits NON-ZERO on its deadline', failedOnItsOwn(r), say(r));
      check('  and names the deadline it blew', /still running after 400ms/.test(r.stderr), say(r));
      check('  and ended itself rather than needing to be killed', r.killed === false, say(r));
    }

    // 5. A CRASH MID-RUN.
    {
      const r = await runChild(path.join(tmp, 'guarded-crashes-midrun.js'));
      check('a guarded suite that throws mid-run exits NON-ZERO', failedOnItsOwn(r), say(r));
      check('  and the reason it stopped is on stderr', /the fixture broke here on purpose/.test(r.stderr), say(r));
    }

    // 6. THE HONEST ENDING. The guard must not simply fail everything.
    {
      const r = await runChild(path.join(tmp, 'guarded-completes.js'));
      check('a guarded suite that finishes properly exits 0', passedOnItsOwn(r), say(r));
      check('  with its summary line on stdout', /guarded-completes: 3 passed/.test(r.stdout), say(r));
      check('  and no failure text on stderr', !/FAILED/.test(r.stderr), say(r));
    }

    // 7. A SUMMARY LINE IS NOT A PASS.
    {
      const r = await runChild(path.join(tmp, 'guarded-completes-with-a-failed-check.js'));
      check('a suite that PRINTS its summary but failed a check still exits NON-ZERO', failedOnItsOwn(r), say(r));
      check('  and it really did print a summary line, so the check above is about the status', /1 of 3 failed/.test(r.stdout), say(r));
    }

    // 8. A DECLARED SKIP: allowed by default, refused when the caller says so.
    {
      const r = await runChild(path.join(tmp, 'declared-skip.js'));
      check('a DECLARED skip exits 0 — skipping stays possible on a laptop', passedOnItsOwn(r), say(r));
      check('  and says it skipped rather than that it passed', /declared-skip: skipped/.test(r.stdout) && !/passed/.test(r.stdout), say(r));

      const strict = await runChild(path.join(tmp, 'declared-skip.js'), { env: { STACKI_NO_SKIPS: '1' } });
      check('the same skip under STACKI_NO_SKIPS exits NON-ZERO', failedOnItsOwn(strict), say(strict));
      check('  and says a suite that asserts nothing was forbidden here', /forbids a suite that asserts nothing/.test(strict.stderr), say(strict));
    }

    // -----------------------------------------------------------------------
    // 9. THE CHAIN STOPS. `npm test` is 180 `&&`s and nothing had ever checked
    //    that a non-zero status ends the sequence. The marker file is the world
    //    state: if the second step ran, it is on disk.
    {
      const marker = path.join(tmp, 'second-step-ran');
      const markerFixture = write('chain-marker.js', 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "ran");\n');
      const q = (p) => JSON.stringify(p);

      fs.rmSync(marker, { force: true });
      const stopped = await runShell(`${q(process.execPath)} ${q(path.join(tmp, 'chain-step-fails.js'))} && ${q(process.execPath)} ${q(markerFixture)}`);
      check('a non-zero suite STOPS the && chain', stopped.killed === false && stopped.code !== 0, say(stopped));
      check('  and the step after it never ran', !fs.existsSync(marker), `marker exists: ${fs.existsSync(marker)}`);

      fs.rmSync(marker, { force: true });
      const ran = await runShell(`${q(process.execPath)} ${q(path.join(tmp, 'chain-step-passes.js'))} && ${q(process.execPath)} ${q(markerFixture)}`);
      check('a passing suite lets the chain continue — the control for the check above', ran.killed === false && ran.code === 0, say(ran));
      check('  and the step after it did run', fs.existsSync(marker), `marker exists: ${fs.existsSync(marker)}`);
    }

    // -----------------------------------------------------------------------
    // 10. THE RULE, against real chain suites rather than fixtures.
    //
    //     A suite that asserts nothing must not look like a suite that asserted
    //     everything. It may exit 0 only while SAYING it skipped, on its own
    //     stdout, and it may never print a pass summary on that path.
    //
    //     The three below reach their skip off an environment variable, so the
    //     rule is checked by running the real files. The half of the rule they
    //     cannot satisfy yet — a caller being able to forbid the skip — is what
    //     skipSuite() is for, and adopting it is an edit to files this suite
    //     does not own. Until then this pins what is true: the line is honest.
    for (const { file, env } of ENV_GATED_SKIPS) {
      const r = await runChild(path.join(ROOT, file), { env, waitMs: 60000 });
      const label = path.basename(file);
      check(`${label} on its skip path exits 0`, passedOnItsOwn(r), say(r));
      check(`  and says "skipped", so a reader can tell it asserted nothing`, /: skipped/.test(r.stdout), say(r));
      check(`  and prints NO pass summary on that path`, !/\d+ passed/.test(r.stdout), say(r));
    }

    // -----------------------------------------------------------------------
    // 11. THE INVENTORY RATCHETS.
    {
      const entries = chainEntries();
      check('the npm test chain still parses into entries', entries.length > 100, `entries: ${entries.length}`);

      const guarded = entries.filter((e) => e.files.some(isGuarded));
      check(
        `at least ${GUARDED_FLOOR} chain entries reach guardSuite (floor, may only rise)`,
        guarded.length >= GUARDED_FLOOR,
        `guarded now: ${guarded.length} — ${guarded.map((e) => e.script).join(', ')}`
      );

      // THIS FILE IS EXCLUDED FROM ITS OWN SCAN, AND ONLY THIS FILE.
      //
      // The detector looks for the SHAPE of a skip escape in a chain suite's
      // source. This suite's source is full of that shape on purpose: it writes
      // child suites — packaged-lifecycle.js's exact escape among them — as
      // string fixtures and then RUNS them to prove what the shape does. Those
      // strings are fixtures, not this file's control flow, so once the suite
      // joined the chain it reported itself and went red on its first run.
      //
      // Excluded by name rather than by a cleverer regex, because a regex that
      // could tell a fixture from a real escape is a regex that could be fooled
      // by a real escape written to look like a fixture. The exclusion is one
      // entry, asserted below to stay one entry, and this file's own skip
      // behaviour is covered instead by the fact that it is the suite doing the
      // asserting: it cannot exit 0 with no checks without failing everything.
      const SELF = 'test/suite-guard-meta.js';
      const files = [...new Set(entries.flatMap((e) => e.files))].filter((f) => f !== SELF);
      const allFiles = [...new Set(entries.flatMap((e) => e.files))];
      check('the excluded file is really in the chain', allFiles.includes(SELF), allFiles.filter((f) => /suite-guard/.test(f)).join(', ') || 'not in the chain');
      check('  and the exclusion is load-bearing, not decoration', skipEscapesIn(SELF).length > 0, `escape shapes found in ${SELF}: ${skipEscapesIn(SELF).length}`);
      const escapes = files.filter((f) => skipEscapesIn(f).length);
      const novel = escapes.filter((f) => !KNOWN_SKIP_ESCAPES.has(f));
      check(
        'no NEW undeclared skip escape has entered the chain',
        novel.length === 0,
        novel.length ? `${novel.join(', ')} — a skip that exits 0 with no checks; use skipSuite() from test/support/suiteGuard.js` : ''
      );

      // And the detector is not vacuous: it must still find the ones we know
      // about. A regex that matched nothing would make the ratchet above green
      // forever.
      check(
        'the skip-escape detector still finds the escapes it was written against',
        escapes.length >= 5,
        `found ${escapes.length}: ${escapes.join(', ')}`
      );
    }
  } finally {
    // Cleanup failure is test failure — the fixtures are this run's own.
    const gone = releaseTempDir(tmp);
    check('the fixture directory this run made is gone', gone, tmp);
  }

  suiteDone();
  if (failures.length) {
    console.error(`suite-guard-meta: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`suite-guard-meta: ${checked} passed  [the guard fails when it should, and a non-zero suite stops the chain]`);
})().catch((err) => {
  console.error('suite-guard-meta: threw', err);
  process.exit(1);
});
