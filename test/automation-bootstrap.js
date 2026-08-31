// The one non-interactive way to open a project, and every way it refuses.
//
//   node test/automation-bootstrap.js
//
// Opening a project is a human act in Stacki, deliberately: without this the
// packaged app cannot be driven by a test at all, and the packaged proof could
// only cover the half that needs nothing open. So there is exactly one door,
// and this is the file that says what it will not open for.
//
// The function is read out of electron/main.js and evaluated on its own rather
// than reached through a running app, because what is being tested is the
// FENCE — four conditions, each of which must refuse alone. Booting Electron to
// ask fourteen questions about a path would prove less and take a minute.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

/** The real implementation, lifted out of main and given its own globals. */
function loadAutomationProject(env) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const start = src.indexOf('function automationProject()');
  const end = src.indexOf("handle('project:pending'");
  if (start < 0 || end < 0 || end < start) throw new Error('automationProject is no longer where this test reads it from');
  const body = src.slice(start, end);
  // `os` is injected as well as `process`, and its tmpdir() answers from the
  // INJECTED environment. Node's real os.tmpdir() reads the real process.env,
  // so a test that only swapped `process` could not reproduce the thing it is
  // checking: a launcher setting TMPDIR beside the automation flags. Without
  // this, removing the platform-root list entirely left every check green.
  const fakeOs = {
    ...os,
    tmpdir: () => env.TMPDIR || env.TMP || env.TEMP || os.tmpdir(),
    homedir: () => os.homedir(),
  };
  return new Function('fs', 'os', 'path', 'process', `${body}; return automationProject;`)(fs, fakeOs, path, { env, platform: process.platform });
}

const MARKER = 'nonce-3f9c2a-owned-by-this-test';

/** A project that satisfies every condition, so each check can break one. */
function makeGoodProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bootstrap-'));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'pages', 'index.astro'), '<h1>fixture</h1>\n', 'utf8');
  fs.writeFileSync(path.join(root, '.stacki-automation'), `${MARKER}\n`, 'utf8');
  return root;
}

const owned = [];
const cleanup = () => {
  for (const dir of owned) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* reported below */
    }
  }
};

try {
  const root = makeGoodProject();
  owned.push(root);

  // ── it opens, when everything is true ──────────────────────────────────
  const ok = loadAutomationProject({ STACKI_AUTOMATION_PROJECT: root, STACKI_AUTOMATION_MARKER: MARKER })();
  check('a project this run made, named and marked, opens', !!ok, String(ok));
  check('  and it answers with the project itself', ok === fs.realpathSync(root), `${ok} vs ${fs.realpathSync(root)}`);

  // ── and refuses, one condition at a time ───────────────────────────────
  check(
    'without the flag there is no door at all',
    loadAutomationProject({})() === null
  );
  check(
    'the path alone is not enough — the nonce is required',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: root })() === null
  );
  check(
    'the nonce alone is not enough either',
    loadAutomationProject({ STACKI_AUTOMATION_MARKER: MARKER })() === null
  );
  check(
    'a WRONG marker is refused, which is what makes a stale fixture unusable',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: root, STACKI_AUTOMATION_MARKER: 'not-the-nonce' })() === null
  );

  // A project outside the owned temp root that is PERFECT in every other way:
  // a real project, correctly marked, with the right nonce. Only the temp-root
  // rule can refuse it, which is the point — the first version of this check
  // pointed at an unmarked directory, so the marker rule refused it first and
  // deleting the temp-root rule entirely changed nothing here.
  const outside = fs.mkdtempSync(path.join(__dirname, '..', '.stacki-bootstrap-outside-'));
  owned.push(outside);
  fs.mkdirSync(path.join(outside, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside' }), 'utf8');
  fs.writeFileSync(path.join(outside, 'src', 'pages', 'index.astro'), '<h1>outside</h1>\n', 'utf8');
  fs.writeFileSync(path.join(outside, '.stacki-automation'), `${MARKER}\n`, 'utf8');
  check(
    'a path OUTSIDE the temp root is refused, however well marked',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: outside, STACKI_AUTOMATION_MARKER: MARKER })() === null,
    outside
  );
  check(
    'and a relative path is refused before anything is read',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: 'some/relative/path', STACKI_AUTOMATION_MARKER: MARKER })() === null
  );
  check(
    'the temp root itself is not a project to open',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: os.tmpdir(), STACKI_AUTOMATION_MARKER: MARKER })() === null
  );

  // A directory next to the temp root whose name merely starts the same way.
  const lookalike = `${fs.realpathSync(os.tmpdir()).replace(/\/$/, '')}-elsewhere`;
  check(
    'a directory whose name only begins like the temp root is refused',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: lookalike, STACKI_AUTOMATION_MARKER: MARKER })() === null,
    lookalike
  );

  // Marked, in the right place, and not a project.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bootstrap-bare-'));
  owned.push(bare);
  fs.writeFileSync(path.join(bare, '.stacki-automation'), MARKER, 'utf8');
  check(
    'a marked directory that is not a project is refused',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: bare, STACKI_AUTOMATION_MARKER: MARKER })() === null
  );

  // A project in the right place with no marker at all.
  const unmarked = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bootstrap-unmarked-'));
  owned.push(unmarked);
  fs.mkdirSync(path.join(unmarked, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(unmarked, 'package.json'), '{}', 'utf8');
  check(
    'an unmarked project in the right place is refused',
    loadAutomationProject({ STACKI_AUTOMATION_PROJECT: unmarked, STACKI_AUTOMATION_MARKER: MARKER })() === null
  );

  // ── the environment cannot move the fence ──────────────────────────────
  //
  // os.tmpdir() reads TMPDIR out of the environment, and the environment is set
  // by whoever launches the app — the same actor that sets the two flags. So a
  // launcher could once point TMPDIR at `/` and make "inside the temp
  // directory" mean anywhere at all. The project below is real, marked, and
  // correctly nonced; only the temp-root rule can refuse it.
  {
    const elsewhere = fs.mkdtempSync(path.join(__dirname, '..', '.stacki-bootstrap-tmpmoved-'));
    owned.push(elsewhere);
    fs.mkdirSync(path.join(elsewhere, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(elsewhere, 'src', 'pages', 'index.astro'), '<h1>moved</h1>\n', 'utf8');
    fs.writeFileSync(path.join(elsewhere, '.stacki-automation'), MARKER, 'utf8');
    check(
      'pointing TMPDIR at the parent does not make a project inside it openable',
      loadAutomationProject({
        TMPDIR: path.join(__dirname, '..'),
        STACKI_AUTOMATION_PROJECT: elsewhere,
        STACKI_AUTOMATION_MARKER: MARKER,
      })() === null,
      elsewhere
    );
    check(
      'nor does pointing it at the filesystem root',
      loadAutomationProject({ TMPDIR: '/', STACKI_AUTOMATION_PROJECT: elsewhere, STACKI_AUTOMATION_MARKER: MARKER })() === null
    );
  }

  // ── nothing is written down ────────────────────────────────────────────
  //
  // The door must not become a preference: a second run with no flag must land
  // exactly where a cold start lands.
  check(
    'opening this way leaves nothing behind that would open it again',
    loadAutomationProject({})() === null
  );
} finally {
  cleanup();
}

// Cleanup is a result here too.
const left = owned.filter((dir) => fs.existsSync(dir));
check('every directory this test made is gone', left.length === 0, left.join(', '));

if (failures.length) {
  console.error(`\nautomation-bootstrap: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`automation-bootstrap: ${checked} passed  [one door, and everything it will not open for]`);
