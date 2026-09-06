// Merging a branch and deleting one.
//
//   node test/git-branches.js
//
// Against real repositories, because the whole of this code is a reading of
// what git says when it refuses, and git says it in places that are easy to
// guess wrong about. The conflict report goes to STDOUT — stderr is empty —
// so a handler reading only stderr sees a merge that failed for no stated
// reason and passes an empty string to the user. That is the bug this file
// exists to catch.
//
// The other half is what happens to the working tree. A conflicted merge
// leaves conflict markers in the files, and this editor parses those files as
// markup a moment later; the page would come back broken with nothing to say
// why. So a merge that cannot complete has to leave the branch exactly as it
// found it, and that is checked here as a property of the tree, not of the
// message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  mergeBranch,
  deleteBranch,
  switchBranch,
  resolveMerge,
  conflictDigest,
  conflictMarkerSizes,
} = require('../electron/gitBranches.js');
const { guardSuite } = require('./support/suiteGuard.js');
// The one reading of a parsed conflict T31 needs: whether the clash runs to the
// end of the file, which is the only place the final newline is not in the
// marked-up text.
const { conflictAtEnd, clashCount, unreadMarkers } = require('../electron/conflicts.js');
// The project-relative resolver the rest of the MCP surface puts every path
// through. T22 checks the git domain's `sourcePath` against IT rather than by
// joining strings here: a spelling this file agrees with but resolveInProject
// refuses is exactly the failure that field exists to close.
const { resolveInProject } = require('../electron/mcp/agent/paths.js');
// The shaping layer a client actually reads. Two of the refusals below are
// wrong in the SENTENCE rather than in the code, and the sentence an agent gets
// is composed here and not in gitBranches.js — so the answers are put through
// the real mapper rather than being asserted only where they were minted.
const { DOMAINS } = require('../electron/mcp/agent/domains.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The runner the module takes, without main.js's PATH repair — nothing here
// runs from a packaged app.
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const sh = async (cwd, ...args) => (await git(cwd, args)).stdout.trim();

// A repository on `main` with one commit, and a `feature` branch off it.
async function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
  await sh(dir, 'init', '-q', '-b', 'main', '.');
  await sh(dir, 'config', 'user.email', 'test@example.com');
  await sh(dir, 'config', 'user.name', 'Test');
  // A developer with `commit.gpgsign = true` set globally would have every
  // fixture in this file fail at its first commit, on a machine where nothing
  // is wrong. The identity above is set for the same reason.
  await sh(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'first');
  return dir;
}

const commitOn = async (dir, branch, file, body) => {
  await sh(dir, 'checkout', '-q', branch);
  fs.writeFileSync(path.join(dir, file), body);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', `${file} on ${branch}`);
};

/**
 * A file's text, or null when it is not there.
 *
 * A CONTROL THAT THROWS IS A CONTROL THAT REPORTS NOTHING. `readFileSync`
 * straight inside a `check` takes the whole suite down before the failures it
 * had already collected are printed — and the commonest way for one of these
 * controls to fail is the file being GONE, which is exactly when the report is
 * wanted.
 */
const textOf = (at) => {
  try {
    return fs.readFileSync(at, 'utf8');
  } catch {
    return null;
  }
};

const caught = async (fn) => {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: String(err.message || err) };
  }
};

// --- what the PANEL sends, out of the panel ----------------------------------
//
// THE VALUE THAT DISCARDED A BRANCH WAS COMPOSED IN THE MODAL AND SHOWN TO
// NOBODY.
//
// GitChip's choicesForSend() turns the modal's state into the `choices`
// resolveMerge is given. Its bug was that a file with no readable hunks took
// `list[0]` of an EMPTY list and sent the whole-file word "ours" on the
// strength of `undefined !== 'theirs'` — a decision nothing on screen showed
// and nobody made. Re-implementing that function beside a test would prove
// nothing about it, so the real component is bundled and rendered against a
// real conflict, and what its Merge button hands out is read off the callback.
//
// The bundle and the DOM are built once, on first use, so a suite run that
// never reaches this pays nothing for it.
let panelEnv = null;
async function renderMergeModal(conflict) {
  if (!panelEnv) {
    const esbuild = require('esbuild');
    const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
    fs.mkdirSync(buildDir, { recursive: true });
    const bundlePath = path.join(buildDir, 'gitchip.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'GitChip.jsx')],
      outfile: bundlePath,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
      logLevel: 'silent',
    });
    const { JSDOM } = require('jsdom');
    // pretendToBeVisual, because the code viewer inside the modal is a real
    // CodeMirror and asks the window for animation frames.
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.HTMLElement = dom.window.HTMLElement;
    global.Element = dom.window.Element;
    global.Node = dom.window.Node;
    global.Window = dom.window.Window;
    global.getComputedStyle = dom.window.getComputedStyle;
    global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    global.MutationObserver = dom.window.MutationObserver;
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    dom.window.ResizeObserver = global.ResizeObserver;
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    global.IS_REACT_ACT_ENVIRONMENT = true;
    panelEnv = {
      dom,
      React: require('react'),
      createRoot: require('react-dom/client').createRoot,
      // React.act, not ReactDOMTestUtils.act — the latter logs a deprecation
      // warning through console.error, which is the same channel the render
      // errors below are caught on.
      act: require('react').act || require('react-dom/test-utils').act,
      MergeConflictModal: require(bundlePath).MergeConflictModal,
    };
  }
  const { dom, React, createRoot, act, MergeConflictModal } = panelEnv;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  let sent;
  let sends = 0;
  const root = createRoot(host);
  // React reports a render error to console.error rather than throwing it
  // where a test can see it, so a modal that died on the way up would
  // otherwise read as "the button was not there".
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  try {
    act(() => {
      root.render(
        React.createElement(MergeConflictModal, {
          conflict,
          busy: null,
          onCancel() {},
          onResolve: (choices) => {
            sends += 1;
            sent = choices;
          },
        })
      );
    });
  } finally {
    console.error = realError;
  }
  const buttons = () => [...host.querySelectorAll('button')];
  // Returns whether the button was there to click. A missing one is a
  // FAILURE, not an exception: throwing out of the helper takes the suite down
  // before the checks it had already collected are printed, and "the panel
  // never drew that choice" is exactly the shape this is here to catch.
  const click = (text) => {
    const button = buttons().find((b) => b.textContent === text);
    if (!button) return false;
    act(() => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    return true;
  };
  return {
    labels: () => buttons().map((b) => b.textContent),
    click,
    merge: () => {
      click('Merge with these choices');
      return sent;
    },
    sends: () => sends,
    errors,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

// --- what a refusal is measured against --------------------------------------
//
// `ok:false` ON ITS OWN IS NOT AN ORACLE. A resolve that refused but left the
// tree mid-merge would satisfy it — and so would one that refused after it had
// already committed. Both are worse than the bug being fixed. So every refusal
// below is held to all six of: it said no, it said why in a word a caller can
// branch on, it named the offender, HEAD did not move, the working tree is
// clean with no merge left in progress, and not one byte anywhere in the
// repository changed.

const crypto = require('crypto');

/** Every file in the working tree, by content. Never .git, which merging churns. */
function bytesOf(dir) {
  const out = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(at);
      // A SYMLINK IS ITS TARGET STRING, not the bytes at the end of it.
      // `readFileSync` follows links, so a dangling link threw ENOENT and took
      // the whole oracle with it, and a link whose target changed hashed the
      // same as long as the file it pointed at had not. Both matter here: T35
      // is about conflicted links.
      else if (entry.isSymbolicLink()) out[at] = `link:${fs.readlinkSync(path.join(dir, at))}`;
      else out[at] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, at))).digest('hex');
    }
  };
  walk('');
  return out;
}

const repoState = async (dir) => ({
  head: await sh(dir, 'rev-parse', 'HEAD'),
  status: await sh(dir, 'status', '--porcelain'),
  mergeHead: fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
  bytes: bytesOf(dir),
});

/**
 * A refusal that changed nothing.
 *
 * `names` is a predicate over the answer: whatever in it identifies the thing
 * that was wrong. A refusal that will not say which choice it could not use
 * sends the caller back to re-read every file it named.
 */
async function refusedCleanly(what, answer, dir, before, code, names) {
  check(`${what} is refused`, answer?.ok === false, JSON.stringify(answer));
  check(`  ${what}: as ${code}`, answer?.code === code, JSON.stringify({ code: answer?.code, message: answer?.message }));
  check(`  ${what}: naming what was wrong`, !!names && names(answer), JSON.stringify(answer).slice(0, 400));
  // A code is for the caller; this is for the person the caller is working for.
  check(
    `  ${what}: with a sentence somebody can act on`,
    typeof answer?.message === 'string' && answer.message.length > 40 && /nothing was merged/i.test(answer.message),
    JSON.stringify(answer?.message)
  );
  const after = await repoState(dir);
  check(`  ${what}: HEAD did not move`, after.head === before.head, `${before.head} -> ${after.head}`);
  check(`  ${what}: the working tree is clean`, after.status === '', after.status);
  check(`  ${what}: no merge was left in progress`, after.mergeHead === false);
  const moved = Object.keys({ ...before.bytes, ...after.bytes }).filter((f) => before.bytes[f] !== after.bytes[f]);
  check(`  ${what}: not one file in the repository changed`, moved.length === 0, moved.join(', '));
}

/**
 * A repository whose `src/pages/about.astro` clashes in THREE places, with a
 * second file git reconciles by itself beside it.
 *
 * Three, because two of the ways a per-hunk answer used to go wrong are about
 * the LENGTH of the list, and a one-hunk file cannot tell a short list from an
 * empty one.
 */
async function threeClashRepo(name) {
  const dir = await repo(name);
  const gap = (n) => Array.from({ length: 6 }, (_, i) => `${n}${i}`);
  const page = (a, b, c) => [a, ...gap('k'), b, ...gap('m'), c].join('\n') + '\n';
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/pages/about.astro'), page('A-base', 'B-base', 'C-base'));
  fs.writeFileSync(path.join(dir, 'other.txt'), 'shared\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'about');
  await sh(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'src/pages/about.astro'), page('A-feat', 'B-feat', 'C-feat'));
  // Touched on ONE branch only, so git reconciles it without asking. It is a
  // real path in a real repository and it is never conflicted, which is
  // exactly what makes a choice naming it a choice for nothing.
  fs.writeFileSync(path.join(dir, 'other.txt'), 'shared, edited on feature\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'feature about');
  await sh(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'src/pages/about.astro'), page('A-main', 'B-main', 'C-main'));
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'main about');
  return dir;
}

/** A repository whose a.txt clashes at the top and at the bottom, and nowhere else. */
async function twoClashRepo(name) {
  const dir = await repo(name);
  const page = (top, bottom) => [top, ...Array.from({ length: 6 }, (_, i) => `m${i}`), bottom].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'a.txt'), page('TOP-base', 'BOTTOM-base'));
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'two ends');
  await sh(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), page('TOP-feat', 'BOTTOM-feat'));
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'feature ends');
  await sh(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), page('TOP-main', 'BOTTOM-main'));
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'main ends');
  return dir;
}

// Every fixture repository this file makes, at module scope so the cleanup can
// live in a `finally` and in an exit handler rather than only on the path where
// everything went right. SABOTAGE-PROVED, by inserting `await new
// Promise(() => {})` into resolveMerge: the suite printed ZERO bytes, exited 0
// — node's answer to an empty event loop — and left 62 fixture repositories in
// the temp directory, while `npm test` chained on with && and reported the
// whole run green with 355 assertions that had never executed.
const cleanup = [];

// Two branches that both edit the same file, so git must merge them and will
// conflict. Declared here because blocks throughout the suite build fixtures
// with it; it needs nothing but repo(), sh() and cleanup.
const collide = async (name, { base, ours, theirs }) => {
  const dir = await repo(name);
  cleanup.push(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), base);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'base');
  await sh(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), theirs);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'theirs');
  await sh(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), ours);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'ours');
  return dir;
};

// A conflicted SYMLINK: two branches point the same link somewhere different.
// Hoisted beside collide() because more than one block builds one.
const linked = async (name, { ours, theirs }) => {
  const dir = await repo(name);
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(
    path.join(dir, 'docs', 'notes.md'),
    'A conflict looks like:\n<<<<<<< HEAD\nours line\n||||||| base\nbase line\n=======\ntheirs line\n>>>>>>> other\nend\n'
  );
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'x\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'base');
  await sh(dir, 'branch', 'feature');
  fs.symlinkSync(ours, path.join(dir, 'link'));
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'ours');
  await sh(dir, 'checkout', '-q', 'feature');
  fs.symlinkSync(theirs, path.join(dir, 'link'));
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'theirs');
  await sh(dir, 'checkout', '-q', 'main');
  return dir;
};
const removeFixtures = () => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
};
// The deadline's own exit, and any other way out that misses the finally below,
// still takes the fixtures with it. rmSync is safe here: an exit handler may do
// synchronous work and nothing else.
process.on('exit', removeFixtures);

async function suite() {
  // --- A merge that has somewhere to go ------------------------------------
  {
    const dir = await repo('ff');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('a merge that moves work reports it', r.changed === true, JSON.stringify(r));
    check('the merge names the branch merged into', r.into === 'main', r.into);
    check(
      'the merged file is on the branch afterwards',
      fs.existsSync(path.join(dir, 'b.txt'))
    );

    // Once merged, git's safe delete is willing.
    const d = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('a merged branch deletes without forcing', d.ok === true, JSON.stringify(d));
    const left = await sh(dir, 'branch', '--format=%(refname:short)');
    check('and is gone from the list', left === 'main', left);
  }

  // --- A merge with nothing to bring ---------------------------------------
  {
    const dir = await repo('noop');
    cleanup.push(dir);
    await sh(dir, 'branch', 'behind');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'behind' });
    // "Merged" here would claim work arrived that was already present. The
    // caller says something different on the strength of this flag.
    check('a merge that moves nothing says so', r.changed === false, JSON.stringify(r));
  }

  // --- A merge that conflicts ----------------------------------------------
  {
    const dir = await repo('conflict');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'a.txt', 'feature wins\n');
    await commitOn(dir, 'main', 'a.txt', 'main wins\n');

    const head = await sh(dir, 'rev-parse', 'HEAD');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });

    // A question, not a failure. It used to throw an error naming a terminal
    // command, which in an app built so nobody needs a terminal was a refusal
    // wearing an explanation.
    check('a clash comes back as something to answer', r.ok === false, JSON.stringify(r));
    check('flagged as a clash', r.conflicted === true, JSON.stringify(r));
    check('naming the file', r.files?.[0]?.path === 'a.txt', JSON.stringify(r.files));
    check('and both branches', r.from === 'main' && r.branch === 'feature', JSON.stringify(r));
    // Both versions come back, because "yours or theirs" cannot be answered
    // from two labels — the person deciding has to see what is in them.
    check('with this branch’s version', r.files[0].ours.trim() === 'main wins', r.files[0].ours);
    check('and the incoming one', r.files[0].theirs.trim() === 'feature wins', r.files[0].theirs);

    // The tree, not the message: this is what keeps the editor from parsing
    // conflict markers as markup while the user is deciding.
    const status = await sh(dir, 'status', '--porcelain');
    check('nothing is left conflicted in the tree', status === '', status);
    check('the branch is where it was', (await sh(dir, 'rev-parse', 'HEAD')) === head);
    check(
      'no conflict markers were left in the file',
      !fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('<<<<<<<')
    );
    check(
      'and the file still says what the branch said',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'main wins'
    );
  }

  // --- Answering the clash, in the app -------------------------------------
  {
    const dir = await repo('resolve');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'base\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'two files');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'feature b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature both');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'main b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main both');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('both clashing files come back', clash.files.length === 2, JSON.stringify(clash.files.map((f) => f.path)));

    // One decision per file — a merge taking the page from one branch and the
    // stylesheet from the other is completely ordinary.
    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours', 'b.txt': 'theirs' },
      // Which conflict these answers are about. The merge is re-run to apply
      // them, so a resolve that cannot say is refused — see the stale-snapshot
      // block below, which is what that guard exists for.
      expect: clash.at,
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));
    check('keeping mine where I said', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'main a');
    check('and theirs where I said', fs.readFileSync(path.join(dir, 'b.txt'), 'utf8').trim() === 'feature b');
    // A real merge commit, so the branch counts as merged afterwards and the
    // safe delete will allow itself.
    check('it is a real merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
    check(
      'and no markers survived',
      !fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('<<<<<<<') &&
        !fs.readFileSync(path.join(dir, 'b.txt'), 'utf8').includes('<<<<<<<')
    );
    const d = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('and the branch now deletes as merged', d.ok === true, JSON.stringify(d));
  }

  // --- Taking part of a file from each branch -------------------------------
  //
  // The whole reason conflicts are shown as separate differences rather than
  // one all-or-nothing switch: a page whose heading came from one branch and
  // whose footer came from the other is completely ordinary.
  {
    const dir = await repo('hunks');
    cleanup.push(dir);
    const page = (hero, footer) =>
      [hero, ...Array.from({ length: 6 }, (_, i) => `unchanged ${i}`), footer].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'p.astro'), page('HERO', 'FOOTER'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'page');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'p.astro'), page('HERO FEATURE', 'FOOTER FEATURE'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature page');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'p.astro'), page('HERO MAIN', 'FOOTER MAIN'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main page');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const file = clash.files.find((f) => f.path === 'p.astro');
    const clashes = (file.parts || []).filter((p) => p.kind === 'clash');
    // Two edits far enough apart that git reports them separately. If they
    // came back as one, there would be nothing to choose between per-part.
    check('the two edits come back separately', clashes.length === 2, JSON.stringify(clashes));
    check('the heading is one of them', clashes[0].ours.trim() === 'HERO MAIN', clashes[0].ours);
    check('and the footer the other', clashes[1].theirs.trim() === 'FOOTER FEATURE', clashes[1].theirs);

    // Heading from the incoming branch, footer from this one.
    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'p.astro': ['theirs', 'ours'] },
      expect: clash.at,
    });
    check('a mixed merge finishes', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(dir, 'p.astro'), 'utf8');
    check('the heading came from the other branch', out.includes('HERO FEATURE'), out);
    check('the footer stayed on this one', out.includes('FOOTER MAIN'), out);
    check('and the versions not chosen are gone', !out.includes('HERO MAIN') && !out.includes('FOOTER FEATURE'), out);
    // The lines both branches agreed on are not part of the choice and must
    // survive untouched — losing one would be silent and permanent.
    check(
      'every agreed line survived',
      Array.from({ length: 6 }, (_, i) => `unchanged ${i}`).every((l) => out.includes(l)),
      out
    );
    check('no markers were left behind', !out.includes('<<<<<<<') && !out.includes('======='), out);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
    check('and it is a real merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
  }

  // --- The real case: one edit each, right next to each other ---------------
  //
  // Make a branch. Change the heading on one side and the paragraph directly
  // under it on the other. Git reports that as a single conflict, because the
  // two edits are adjacent — and every answer to it is wrong: either side
  // loses an edit, and "both" duplicates the heading and the paragraph.
  //
  // Nobody disagrees about anything here. Each branch changed a different
  // thing, and the merge everyone wants is both changes.
  {
    const dir = await repo('adjacent');
    cleanup.push(dir);
    const page = (h, p2) => `<section>\n  <h2>${h}</h2>\n  <p>${p2}</p>\n</section>\n`;
    fs.writeFileSync(path.join(dir, 'index.astro'), page('Heading 2', 'original paragraph'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'page');
    await sh(dir, 'checkout', '-qb', 'new-branch');
    // Only the heading here.
    fs.writeFileSync(path.join(dir, 'index.astro'), page('Heading 3', 'original paragraph'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'new heading');
    await sh(dir, 'checkout', '-q', 'main');
    // Only the paragraph here.
    fs.writeFileSync(path.join(dir, 'index.astro'), page('Heading 2', 'rewritten paragraph'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'new paragraph');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'new-branch' });
    const file = clash.files.find((f) => f.path === 'index.astro');
    const clashes = (file.parts || []).filter((p) => p.kind === 'clash');
    check('the one conflict is split into two decisions', clashes.length === 2, JSON.stringify(clashes));
    check('the heading credited to the branch that changed it', clashes[0].changedBy === 'theirs', JSON.stringify(clashes[0]));
    check('the paragraph to the other one', clashes[1].changedBy === 'ours', JSON.stringify(clashes[1]));
    // Neither is a real disagreement, so neither needs asking about.
    check('neither is contested', !clashes.some((c) => c.changedBy === 'both'), JSON.stringify(clashes));

    // What the dialog defaults to: whoever actually made each change.
    const picks = clashes.map((c) => (c.changedBy === 'theirs' ? 'theirs' : 'ours'));
    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'new-branch',
      choices: { 'index.astro': picks },
      expect: clash.at,
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));

    const out = fs.readFileSync(path.join(dir, 'index.astro'), 'utf8');
    check('the new heading survived', out.includes('Heading 3'), out);
    check('and the rewritten paragraph', out.includes('rewritten paragraph'), out);
    check('the superseded heading is gone', !out.includes('Heading 2'), out);
    check('the superseded paragraph is gone', !out.includes('original paragraph'), out);
    // Nothing duplicated — the failure "both" would have produced.
    check('the heading appears once', (out.match(/<h2>/g) || []).length === 1, out);
    check('the paragraph appears once', (out.match(/<p>/g) || []).length === 1, out);
    check('the markup around them is intact', out.includes('<section>') && out.includes('</section>'), out);
    check('no markers were left', !out.includes('<<<<<<<') && !out.includes('|||||||'), out);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
  }

  // --- A class added here, the words rewritten there ------------------------
  //
  // Both branches edited the SAME line, so git reports a genuine clash and any
  // line-level answer throws one of the two edits away. Inside the line they
  // are nowhere near each other, and both can be kept.
  {
    const dir = await repo('inline');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'index.astro'), '<section>\n  <h2>Heading 2</h2>\n</section>\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'page');
    await sh(dir, 'checkout', '-qb', 'new-branch');
    fs.writeFileSync(path.join(dir, 'index.astro'), '<section>\n  <h2>Heading 3</h2>\n</section>\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'new words');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'index.astro'), '<section>\n  <h2 class="title">Heading 2</h2>\n</section>\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'a class');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'new-branch' });
    const c = (clash.files[0].parts || []).find((p) => p.kind === 'clash');
    check('the same line edited twice is still one clash', !!c, JSON.stringify(clash.files[0].parts));
    check('but a combined version is offered', c.merged != null, JSON.stringify(c));
    check('holding both edits', c.merged.includes('class="title"') && c.merged.includes('Heading 3'), c.merged);

    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'new-branch',
      choices: { 'index.astro': ['merged'] },
      expect: clash.at,
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(dir, 'index.astro'), 'utf8');
    check('the class survived', out.includes('class="title"'), out);
    check('and the new words', out.includes('Heading 3'), out);
    check('the old words are gone', !out.includes('Heading 2'), out);
    check('the heading appears once', (out.match(/<h2/g) || []).length === 1, out);
    check('indentation is intact', /^  <h2/m.test(out), JSON.stringify(out));
    check('and the markup around it', out.includes('<section>') && out.includes('</section>'), out);
    check('no markers left', !out.includes('<<<<<<<') && !out.includes('|||||||'), out);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
  }

  // --- A choice not given ---------------------------------------------------
  {
    const dir = await repo('resolvedefault');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'theirs\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'theirs');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'mine\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'mine');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    // No answer for this file. Between silently dropping your own work and
    // silently dropping work you asked to merge in, the first is worse: the
    // incoming version is still on its branch, yours may exist nowhere else.
    const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: {}, expect: clash.at });
    check('an unanswered file keeps your own version', done.ok === true, JSON.stringify(done));
    check(
      'rather than the incoming one',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'mine',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
    );
  }

  // --- A choice that answers nothing ----------------------------------------
  //
  // The pre-flight checked the VALUES on the paths git had reported and nothing
  // else. Its loop ran over the CONFLICTED files, so a choice was only ever
  // looked up under a name git had already supplied — and every way of getting
  // that name wrong, or of getting the SHAPE of a per-hunk answer wrong,
  // reached the apply loop and was committed. Six of them, each ending in
  // `{ok:true, changed:true}` over a file the caller had not described:
  //
  //   a typo in the path, so the real conflict got no answer and took --ours;
  //   a path git had auto-merged; a path left over from an earlier merge;
  //   two answers for three clashes, and five; "merged" where there is no
  //   combined version; an explicit null; an empty list.
  //
  // Every one of them is now measured the same way: nothing merged, HEAD where
  // it was, no merge in progress, and every byte in the repository unchanged.
  {
    // T1 — A TYPO IN THE PATH. The one that reads as a success: the caller
    // asked for THEIRS and the file it meant was committed as OURS.
    const dir = await threeClashRepo('typokey');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('the fixture really clashes in three places', (clash.files[0].parts || []).filter((p) => p.kind === 'clash').length === 3, JSON.stringify(clash.files.map((f) => f.path)));
    check('and only in the one file', clash.files.length === 1, JSON.stringify(clash.files.map((f) => f.path)));

    const before = await repoState(dir);
    const typo = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      // "abot" — one transposition away from the file git actually named.
      choices: { 'src/pages/abot.astro': ['theirs', 'theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly(
      'T1 a choice under a path git never reported',
      typo,
      dir,
      before,
      'bad_choices',
      (r) => r.badChoices?.[0]?.path === 'src/pages/abot.astro' && r.badChoices[0].reason === 'unknown_path'
    );
    check(
      'T1: the file the caller meant still says what this branch said',
      fs.readFileSync(path.join(dir, 'src/pages/about.astro'), 'utf8').includes('A-main'),
      fs.readFileSync(path.join(dir, 'src/pages/about.astro'), 'utf8').split('\n')[0]
    );

    // T9 — THE ESCALATION. The wrong resolution used to record a real
    // two-parent merge commit, which satisfies git's "fully merged" test — so
    // Stacki's safe branch delete stopped protecting the branch whose work had
    // just been discarded. With the refusal above, it still does.
    const guard = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('T9 the branch is still protected from a plain delete', guard.ok === false && guard.unmerged === true, JSON.stringify(guard));
    check(
      'T9: and the branch is still there',
      (await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );
  }

  {
    // T2 — A CHOICE FOR A PATH GIT MERGED BY ITSELF.
    const dir = await threeClashRepo('notconflicting');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T2: the second file is not one of the conflicts', !clash.files.some((f) => f.path === 'other.txt'), JSON.stringify(clash.files.map((f) => f.path)));
    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'other.txt': 'theirs', 'src/pages/about.astro': ['theirs', 'theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly(
      'T2 a choice for a path that is not conflicted',
      answer,
      dir,
      before,
      'bad_choices',
      (r) => r.badChoices?.some((b) => b.path === 'other.txt' && b.reason === 'unknown_path')
    );
  }

  {
    // T3 — A PATH LEFT OVER FROM AN EARLIER MERGE IN THE SAME REPOSITORY.
    // It was conflicted once, so it reads as a plausible key, and it is not
    // conflicted now.
    const dir = await threeClashRepo('stalepath');
    cleanup.push(dir);
    // An earlier merge, over a different file, settled and committed.
    await sh(dir, 'checkout', '-qb', 'earlier', 'main');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'from the earlier branch\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'earlier old');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'from main\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main old');
    const first = await mergeBranch(git, { projectPath: dir, branch: 'earlier' });
    check('T3: the earlier merge really clashed over old.txt', first.files?.[0]?.path === 'old.txt', JSON.stringify(first.files?.map((f) => f.path)));
    const settled = await resolveMerge(git, { projectPath: dir, branch: 'earlier', choices: { 'old.txt': 'ours' }, expect: first.at });
    check('T3: and it settled', settled.ok === true, JSON.stringify(settled));

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T3: the new conflict is not about old.txt', !clash.files.some((f) => f.path === 'old.txt'), JSON.stringify(clash.files.map((f) => f.path)));
    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'old.txt': 'theirs', 'src/pages/about.astro': ['theirs', 'theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly(
      'T3 a path from an earlier merge in the same repository',
      answer,
      dir,
      before,
      'bad_choices',
      (r) => r.badChoices?.some((b) => b.path === 'old.txt' && b.reason === 'unknown_path')
    );
  }

  {
    // T4 and T5 — TOO FEW ANSWERS AND TOO MANY.
    //
    // Short: `picks[n]` was undefined for the surplus clashes and renderResolved
    // reads that as `ours`, so the third disagreement was answered by nobody.
    // Long: the surplus was dropped without a word, which means the caller and
    // Stacki disagreed about which answer went where.
    // A REPOSITORY EACH.
    //
    // These used to share one, and sharing hid things: the first case in the
    // block is the only one whose repository is in the state the block set up.
    // If a guard stops holding, that first resolve MERGES — and every case
    // after it is then answering against a moved HEAD, so it is refused for a
    // completely different reason and still looks like a pass. Measured while
    // proving these tests can fail: with the length check deleted, the short
    // list committed and the long list came back `stale_merge`, so the case
    // that was supposed to be catching the defect reported green.
    const PAGE = 'src/pages/about.astro';
    const fresh = async (name) => {
      const dir = await threeClashRepo(name);
      cleanup.push(dir);
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      return { dir, clash, before: await repoState(dir) };
    };

    {
      const { dir, clash, before } = await fresh('arrayshort');
      const answer = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { [PAGE]: ['theirs', 'theirs'] }, expect: clash.at });
      await refusedCleanly(
        'T4 two answers for three disagreements',
        answer,
        dir,
        before,
        'bad_choices',
        (r) => r.badChoices?.[0]?.reason === 'wrong_length' && r.badChoices[0].hunks === 3 && r.badChoices[0].given === 2
      );
    }

    {
      const { dir, clash, before } = await fresh('arraylong');
      const answer = await resolveMerge(git, {
        projectPath: dir,
        branch: 'feature',
        choices: { [PAGE]: ['theirs', 'theirs', 'theirs', 'ours', 'ours'] },
        expect: clash.at,
      });
      await refusedCleanly(
        'T5 five answers for three disagreements',
        answer,
        dir,
        before,
        'bad_choices',
        (r) => r.badChoices?.[0]?.reason === 'wrong_length' && r.badChoices[0].hunks === 3 && r.badChoices[0].given === 5
      );
    }

    {
      // T8 — AN EMPTY LIST. `[].find(...)` is undefined, so it validated as a
      // list of acceptable words and then answered every clash with nothing.
      const { dir, clash, before } = await fresh('arrayempty');
      const answer = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { [PAGE]: [] }, expect: clash.at });
      await refusedCleanly(
        'T8 an empty list of answers',
        answer,
        dir,
        before,
        'bad_choices',
        (r) => r.badChoices?.[0]?.reason === 'empty' && r.badChoices[0].path === PAGE
      );
    }

    {
      // T7 — AN EXPLICIT NULL. "I have not decided about this file" and "I have
      // decided, and here is nothing" are not the same sentence, and the guard
      // used to read them as one.
      const { dir, clash, before } = await fresh('nullchoice');
      const answer = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { [PAGE]: null }, expect: clash.at });
      await refusedCleanly(
        'T7 an explicit null for a whole file',
        answer,
        dir,
        before,
        'bad_choices',
        (r) => r.badChoices?.[0]?.reason === 'null' && r.badChoices[0].path === PAGE
      );
    }

    // THE POSITIVE CONTROL, kept beside them rather than at the end of the
    // file: a pre-flight that refused everything would satisfy all four cases
    // above and nothing here would notice.
    const { dir, clash } = await fresh('arrayright');
    const right = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { [PAGE]: ['theirs', 'ours', 'theirs'] },
      expect: clash.at,
    });
    check('and exactly three answers for three disagreements still merges', right.ok === true, JSON.stringify(right));
    const out = fs.readFileSync(path.join(dir, PAGE), 'utf8');
    check('  taking each side where it was asked for', out.includes('A-feat') && out.includes('B-main') && out.includes('C-feat'), out);
    check('  and no other version survived', !out.includes('A-main') && !out.includes('B-feat') && !out.includes('C-main'), out);
    check('  as a real two-parent merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
    check('  on a clean tree', (await sh(dir, 'status', '--porcelain')) === '');
    check('  with no markers surviving', !out.includes('<<<<<<<'), out);
  }

  {
    // T6 — "merged" WHERE THERE IS NOTHING TO MERGE.
    //
    // 'merged' is in the per-hunk vocabulary, so it validated everywhere it was
    // said. renderResolved then asks `part.merged != null` and falls through to
    // `ours`, so asking for the combination of two edits silently kept one.
    const dir = await repo('mergednone');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'the original sentence\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'sentence');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a completely different sentence written on the branch\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature sentence');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'another entirely unrelated line typed here instead\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main sentence');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const c = (clash.files[0].parts || []).find((p) => p.kind === 'clash');
    // ASSERTED FIRST, so the fixture cannot quietly stop being the negative
    // case: if the inline splitter ever learns to combine these two, this whole
    // block is measuring something else and says so here rather than passing.
    check('T6: the fixture offers no combined version', !!c && c.merged === undefined, JSON.stringify(c));
    check('T6: and both branches really did change it', c.changedBy === 'both', JSON.stringify(c));

    const before = await repoState(dir);
    const answer = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['merged'] }, expect: clash.at });
    await refusedCleanly(
      'T6 "merged" for a hunk that has no combined version',
      answer,
      dir,
      before,
      'bad_choices',
      (r) => r.badChoices?.[0]?.reason === 'no_merged' && r.badChoices[0].hunk === 0
    );
    check(
      'T6: and the incoming version was not silently discarded',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('unrelated line'),
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
    );
  }

  // --- The conflict the answers were made against ---------------------------
  //
  // resolveMerge RE-RUNS the merge, so the answers are applied to whatever git
  // produces at that moment — and nothing used to say that had to be the
  // conflict the caller was shown. Six ways it went wrong, all measured with
  // real commits and all answering `{ok:true, changed:true}`.
  //
  // The oracle is the COMMITTED BYTES, not `ok`. A refusal that still committed
  // would pass an `ok:false` check while being the whole defect.
  {
    // T10 (a) — A COMMIT ON THE BRANCH BEING MERGED INTO.
    const dir = await twoClashRepo('stalehead');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    fs.writeFileSync(path.join(dir, 'b.txt'), 'MAIN-2-NEVER-SEEN\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main moves on');
    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': ['theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly(
      'T10 a commit landing on the branch being merged into',
      answer,
      dir,
      before,
      'stale_merge',
      (r) => r.expected?.head === clash.at.head && r.current?.head !== clash.at.head && /main/.test(String(r.message))
    );
    check('T10: no merge commit was made', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P'));
  }

  {
    // T11 (b) — A COMMIT ON THE BRANCH COMING IN. The caller asked for the
    // version it had read; a version it had never seen was committed instead.
    const dir = await twoClashRepo('staleincoming');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    await sh(dir, 'checkout', '-q', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), ['TOP-FEAT-2-NEVER-SEEN', ...Array.from({ length: 6 }, (_, i) => `m${i}`), 'BOTTOM-FEAT-2-NEVER-SEEN'].join('\n') + '\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature moves on');
    await sh(dir, 'checkout', '-q', 'main');
    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': ['theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly(
      'T11 a commit landing on the branch coming in',
      answer,
      dir,
      before,
      'stale_merge',
      (r) => r.expected?.incoming === clash.at.incoming && r.current?.incoming !== clash.at.incoming && /feature/.test(String(r.message))
    );
    check(
      'T11: nothing anybody never read reached the tree',
      !fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('NEVER-SEEN'),
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
    );
    check('T11: and no merge commit was made', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
  }

  {
    // T12 (d) — THE HUNK SWAP, the worst of them.
    //
    // The TOP of the file stops conflicting, so BOTTOM becomes hunk index 0 —
    // and `picks[0]`, the answer given for TOP, lands on BOTTOM. Measured:
    // BOTTOM-main, this branch's own work, was gone from the committed tree
    // under `{"ok":true,"into":"main","changed":true,"resolved":1}`.
    //
    // The discriminating assertion is the COMMITTED BYTES: a refusal that
    // aborted and then committed anyway would pass every `ok` check here.
    const dir = await twoClashRepo('hunkswap');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const clashes = (clash.files[0].parts || []).filter((p) => p.kind === 'clash');
    check('T12: the caller was shown two disagreements', clashes.length === 2, JSON.stringify(clashes.map((c) => c.ours)));
    check('T12: the first of them is the top of the file', clashes[0].ours.trim() === 'TOP-main', clashes[0].ours);

    // Main adopts the branch's top line, so the top stops being a
    // disagreement at all and everything below it shifts up one.
    fs.writeFileSync(path.join(dir, 'a.txt'), ['TOP-feat', ...Array.from({ length: 6 }, (_, i) => `m${i}`), 'BOTTOM-main'].join('\n') + '\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main takes the branch top');

    const before = await repoState(dir);
    // 'theirs' was the answer for TOP. There is now no TOP to answer.
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': ['theirs', 'ours'] },
      expect: clash.at,
    });
    await refusedCleanly('T12 a disagreement that stopped being one', answer, dir, before, 'stale_merge', (r) => !!r.expected?.head && !!r.current);
    const committed = (await git(dir, ['show', 'HEAD:a.txt'])).stdout;
    check('T12: this branch’s own bottom line is still in the committed tree', committed.includes('BOTTOM-main'), JSON.stringify(committed));
    check('T12: and the answer for the top did not land on the bottom', !committed.includes('BOTTOM-feat'), JSON.stringify(committed));
    check('T12: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P'));
  }

  {
    // T13 (d2) — THE COUNT GROWS. A third disagreement appears below the two
    // that were answered, and takes the `ours` default: the incoming work in it
    // is discarded without a word.
    const dir = await twoClashRepo('hunkgrow');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const line = (top, bottom, tail) => [top, ...Array.from({ length: 6 }, (_, i) => `m${i}`), bottom, ...Array.from({ length: 6 }, (_, i) => `n${i}`), tail].join('\n') + '\n';
    await sh(dir, 'checkout', '-q', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), line('TOP-feat', 'BOTTOM-feat', 'TAIL-feat'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature grows a tail');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), line('TOP-main', 'BOTTOM-main', 'TAIL-main'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main grows a different tail');

    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': ['theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly('T13 a third disagreement appearing below the answers', answer, dir, before, 'stale_merge', (r) => !!r.current);
    const committed = (await git(dir, ['show', 'HEAD:a.txt'])).stdout;
    check('T13: the incoming tail was not silently discarded into a commit', !/TAIL-main[\s\S]*merge/.test(committed) && committed.includes('TAIL-main'), JSON.stringify(committed));
    check('T13: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
  }

  {
    // T14 (e) — ONE OF THE CONFLICTED FILES STOPS CONFLICTING. `resolved` came
    // back 1 against 2 choices and nothing said the snapshot had moved.
    const dir = await repo('conflictgone');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'base b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'two files');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'feature b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature both');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'main b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main both');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T14: both files clash to begin with', clash.files.length === 2, JSON.stringify(clash.files.map((f) => f.path)));
    // Main adopts the branch's b.txt, so b.txt is no longer a disagreement.
    fs.writeFileSync(path.join(dir, 'b.txt'), 'feature b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main takes b from the branch');

    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours', 'b.txt': 'ours' },
      expect: clash.at,
    });
    await refusedCleanly('T14 a conflicted file that stopped conflicting', answer, dir, before, 'stale_merge', (r) => !!r.current);
    check('T14: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
  }

  {
    // T15 (f) — A NEW CONFLICT IN A FILE THE CALLER WAS NEVER TOLD ABOUT. It
    // took `--ours` and was committed, and the envelope said "resolved: 2"
    // against one choice.
    const dir = await repo('newconflict');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'base b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'two files');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature a\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature a');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main a\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main a');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T15: only one file clashes to begin with', clash.files.length === 1 && clash.files[0].path === 'a.txt', JSON.stringify(clash.files.map((f) => f.path)));
    // A disagreement over b.txt appears on both branches afterwards.
    await sh(dir, 'checkout', '-q', 'feature');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'feature b, arrived later\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature b');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'main b, arrived later\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main b');

    const before = await repoState(dir);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'theirs' },
      expect: clash.at,
    });
    await refusedCleanly('T15 a conflict in a file the caller was never told about', answer, dir, before, 'stale_merge', (r) => !!r.current);
    check(
      'T15: the unmentioned file was not resolved on the caller’s behalf',
      fs.readFileSync(path.join(dir, 'b.txt'), 'utf8') === 'main b, arrived later\n',
      fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')
    );
    check('T15: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
  }

  {
    // T15b — NEITHER COMMIT MOVED, AND THE CONFLICT DID.
    //
    // The two SHAs are an argument from git's determinism: same two commits,
    // same merge. That is true of the ALGORITHM and not of everything feeding
    // it. `.git/info/attributes` is not in either commit, and marking the file
    // binary makes git stop producing a hunk-level conflict at all — so the
    // per-hunk answers would be applied to something the caller never saw with
    // both SHAs matching exactly. This is the case the content digest is for,
    // and it is the mutation proof that the digest is not decoration.
    const dir = await twoClashRepo('machinerymoved');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'a.txt binary\n');
    const before = await repoState(dir);
    check('T15b: HEAD is where the conflict said it was', before.head === clash.at.head, `${clash.at.head} -> ${before.head}`);
    check('T15b: and so is the branch coming in', (await sh(dir, 'rev-parse', 'feature^{commit}')) === clash.at.incoming);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': ['theirs', 'theirs'] },
      expect: clash.at,
    });
    await refusedCleanly(
      'T15b both commits where they were, and git reconciling them differently',
      answer,
      dir,
      before,
      'stale_merge',
      (r) => r.current?.head === r.expected?.head && r.current?.incoming === r.expected?.incoming && r.current?.digest !== r.expected?.digest
    );
    check('T15b: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
  }

  {
    // T15c — AND THE CONFLICT STOPPED BEING ONE AT ALL.
    //
    // T15b moves the machinery so git reconciles the two commits DIFFERENTLY.
    // This moves it so git reconciles them CLEANLY, which used to be the one
    // way past every guard in the function: the binding was checked against the
    // two SHAs, the merge was re-run, it went through, and `{ok:true,
    // changed:true, resolved:0}` was returned and committed BEFORE the content
    // digest was ever compared. The caller's answers were discarded without a
    // word, and the branch they thought they had merged stopped being protected
    // from deletion.
    //
    // The lever is git's own BUILT-IN union driver, so this needs no git
    // config, no custom program and no tracked file: `*.txt merge=union` in the
    // untracked `.git/info/attributes`, written between the merge and the
    // resolve, makes git keep both sides of every clash and call it agreement.
    // Observed before the fix: resolve answered ok with `resolved: 0`, a.txt
    // held both branches' lines, and `log -1 --format=%P` had two parents.
    const dir = await twoClashRepo('cleanremerge');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T15c: the caller was shown a conflict to answer', clash.ok === false && clash.files?.length === 1, JSON.stringify(clash.files?.map((f) => f.path)));
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.txt merge=union\n');
    const before = await repoState(dir);
    check('T15c: HEAD is where the conflict said it was', before.head === clash.at.head, `${clash.at.head} -> ${before.head}`);
    check('T15c: and so is the branch coming in', (await sh(dir, 'rev-parse', 'feature^{commit}')) === clash.at.incoming);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours' },
      expect: clash.at,
    });
    await refusedCleanly(
      'T15c a conflict that stopped being one, with both commits where they were',
      answer,
      dir,
      before,
      'stale_merge',
      (r) => r.current?.head === r.expected?.head && r.current?.incoming === r.expected?.incoming
    );
    check('T15c: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P'));
    // The bytes, said separately from `refusedCleanly`'s whole-tree compare:
    // the union merge's signature is BOTH branches' lines in one file, and the
    // point of the refusal is that neither of them arrived.
    const onDisk = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
    check('T15c: this branch’s own file is untouched on disk', onDisk.includes('TOP-main') && onDisk.includes('BOTTOM-main'), JSON.stringify(onDisk));
    check('T15c: and the incoming side was not unioned into it behind the caller', !onDisk.includes('TOP-feat') && !onDisk.includes('BOTTOM-feat'), JSON.stringify(onDisk));
    // AND THE CONTROL, so the refusal is about the machinery moving and not
    // about a resolve that stopped working. The same repository, the same
    // binding, with the attributes taken away again.
    fs.unlinkSync(path.join(dir, '.git', 'info', 'attributes'));
    const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at });
    check('T15c control: the same resolve without the union driver still merges', done?.ok === true, JSON.stringify(done));
    check('T15c control: as a two-parent merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
  }

  {
    // T15c-only — THE CLEAN-REMERGE GUARD, WITH NOTHING ELSE ABLE TO CATCH IT.
    //
    // T15c above is named for that guard and CANNOT FAIL WITHOUT IT. Deleting
    // the whole `if (clean)` block from resolveMerge left the suite at 355
    // passed: its fixture simply fell through to the DIGEST comparison one
    // paragraph later, which returned a `stale_merge` satisfying every one of
    // T15c's predicates. The test was measuring the digest check and reading
    // the answer as though it came from the guard.
    //
    // What isolates the guard is a binding whose digest is the one the digest
    // check CANNOT reject: `conflictDigest` over an empty list, which is what a
    // clean re-merge produces. With the guard in place this is refused as
    // `stale_merge` because there is no conflict left for the answers to be
    // about. With the guard deleted, `left` is empty, the digest agrees with
    // itself, `choices: {}` validates against no files at all, and the union
    // merge is COMMITTED — `ok:true, resolved:0` over a merge commit holding
    // both branches' lines that nobody chose. Verified both ways round.
    const dir = await twoClashRepo('cleanonly');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T15c-only: the caller was shown a conflict to answer', clash.ok === false && clash.files?.length === 1, JSON.stringify(clash.files?.map((f) => f.path)));
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.txt merge=union\n');
    const before = await repoState(dir);
    // The digest of no conflicting files at all — the value the comparison
    // downstream of the guard would compute for a merge that came out clean.
    // Taken from the shipped function, so it cannot drift from it.
    const emptyDigest = conflictDigest(dir, []);
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: {},
      // `into` is carried through unchanged: the binding has to be a WHOLE
      // binding or the guard-required refusal answers first, and this section is
      // about the digest check, not about that one.
      expect: { head: clash.at.head, incoming: clash.at.incoming, digest: emptyDigest, into: clash.at.into },
    });
    await refusedCleanly(
      'T15c-only a clean re-merge whose binding the digest check cannot reject',
      answer,
      dir,
      before,
      'stale_merge',
      (r) => r.current?.head === r.expected?.head && r.current?.incoming === r.expected?.incoming
    );
    // The sentence has to be the GUARD's, not the digest comparison's. They are
    // both `stale_merge`, and this is the only thing that tells them apart from
    // the outside.
    check(
      'T15c-only: refused for the reason the guard exists — there is no conflict left to answer',
      /reconciles them cleanly now/.test(String(answer?.message || '')),
      JSON.stringify(answer?.message)
    );
    check('T15c-only: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P'));
    const onDisk = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
    check(
      'T15c-only: and the union of both branches was not committed behind the caller',
      !onDisk.includes('TOP-feat') && !onDisk.includes('BOTTOM-feat'),
      JSON.stringify(onDisk)
    );
  }

  {
    // T16 — A BRANCH NAME IS NOT A PLACE TO PUT AN OPTION.
    //
    // Every git call in gitBranches.js took the caller's branch string as a bare
    // argv token, so a value starting with `-` was read by git as a FLAG and the
    // operation silently became a different operation. Measured against a
    // repository with a real upstream holding one commit — the whole point of
    // the upstream being that `merge.defaultToUpstream` gives
    // `git merge --strategy=ours` something to merge with no ref named at all:
    //
    //   "--strategy=ours" -> {ok:true, into:"main", changed:true}: HEAD MOVED,
    //     a two-parent merge commit existed that discarded every byte of the
    //     upstream work, and the upstream's file never arrived while the merge
    //     commit said it had;
    //   "--squash" -> {ok:true, changed:false}: "nothing changed" over an index
    //     holding a fully staged, uncommitted merge;
    //   "--detach" through the switch -> {ok:true} with HEAD DETACHED, so every
    //     later Stacki commit would land on no branch at all.
    //
    // The oracles are the repository, not the answer: HEAD, the parent count,
    // the index, and whether HEAD is still a branch.
    const up = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-git-argv-up-'));
    cleanup.push(up);
    await sh(up, 'init', '-q', '-b', 'main', '.');
    await sh(up, 'config', 'user.email', 'test@example.com');
    await sh(up, 'config', 'user.name', 'Test');
    // Signing off for the same reason repo() does it: a developer with
    // `commit.gpgsign = true` set globally, and no key that signs headlessly,
    // cannot commit here at all. This used to be on ONE of the seven builders
    // in this file while the comment above repo() said it was on every fixture:
    // the suite died with an UNCAUGHT throw at the first of the other six,
    // before a single assertion printed.
    await sh(up, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(up, 'a.txt'), 'base\n');
    await sh(up, 'add', '-A');
    await sh(up, 'commit', '-qm', 'first');
    fs.writeFileSync(path.join(up, 'upstream-only.txt'), 'UPSTREAM WORK\n');
    await sh(up, 'add', '-A');
    await sh(up, 'commit', '-qm', 'upstream work');

    /** A clone one commit behind its upstream, with main tracking it. */
    const behind = async (name) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
      cleanup.push(dir);
      await sh(dir, 'clone', '-q', up, '.');
      await sh(dir, 'config', 'user.email', 'test@example.com');
      await sh(dir, 'config', 'user.name', 'Test');
      // Signing off for the same reason repo() does it: a developer with
      // `commit.gpgsign = true` set globally, and no key that signs headlessly,
      // cannot commit here at all. This used to be on ONE of the seven builders
      // in this file while the comment above repo() said it was on every fixture:
      // the suite died with an UNCAUGHT throw at the first of the other six,
      // before a single assertion printed.
      await sh(dir, 'config', 'commit.gpgsign', 'false');
      await sh(dir, 'reset', '-q', '--hard', 'HEAD~1');
      return dir;
    };

    for (const option of ['--strategy=ours', '--squash', '-X', '--no-verify']) {
      const dir = await behind('argv-merge');
      const before = await repoState(dir);
      const answer = await caught(() => mergeBranch(git, { projectPath: dir, branch: option }));
      check(
        `T16 merge "${option}" is refused rather than run as a flag`,
        answer.value?.ok === false && answer.value?.code === 'bad_branch_name',
        JSON.stringify(answer)
      );
      const after = await repoState(dir);
      check(`T16 merge "${option}": HEAD did not move`, after.head === before.head, `${before.head} -> ${after.head}`);
      check(`T16 merge "${option}": no merge commit was made`, (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
      check(`T16 merge "${option}": nothing was staged`, after.status === '', after.status);
      check(
        `T16 merge "${option}": the upstream's work did not arrive`,
        !fs.existsSync(path.join(dir, 'upstream-only.txt'))
      );
      const moved = Object.keys({ ...before.bytes, ...after.bytes }).filter((f) => before.bytes[f] !== after.bytes[f]);
      check(`T16 merge "${option}": not one file changed`, moved.length === 0, moved.join(', '));
    }

    for (const option of ['--detach', '--orphan', '-d']) {
      const dir = await behind('argv-switch');
      const answer = await caught(() => switchBranch(git, { projectPath: dir, branch: option }));
      check(
        `T16 switch "${option}" is refused rather than run as a flag`,
        answer.value?.ok === false && answer.value?.code === 'bad_branch_name',
        JSON.stringify(answer)
      );
      // The one that matters: a detached HEAD is not visible in `{ok}` at all,
      // and every commit Stacki made afterwards would land on nothing.
      check(
        `T16 switch "${option}": HEAD is still a branch`,
        (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'main',
        await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
      );
      const created = await caught(() => switchBranch(git, { projectPath: dir, branch: option, create: true }));
      check(
        `T16 switch -c "${option}" is refused too`,
        created.value?.ok === false && created.value?.code === 'bad_branch_name',
        JSON.stringify(created)
      );
      check(
        `T16 switch -c "${option}": still on main`,
        (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'main'
      );
    }

    {
      // DELETE THROWS RATHER THAN RETURNING. The MCP mapper for delete_branch
      // turns any `{ok:false}` it does not recognise by name into
      // `{deleted: <branch>}` — a refusal reported as a success — so this is the
      // one refusal in the file that has to be a throw.
      const dir = await behind('argv-delete');
      await sh(dir, 'branch', 'keepme');
      const before = await repoState(dir);
      const answer = await caught(() => deleteBranch(git, { projectPath: dir, branch: '-D' }));
      check('T16 delete "-D" is refused', answer.value === null && /not a name git will accept/.test(String(answer.error)), JSON.stringify(answer));
      const branches = await sh(dir, 'branch', '--format=%(refname:short)');
      check('T16 delete "-D": every branch is still there', branches.split('\n').sort().join(',') === 'keepme,main', branches);
      const after = await repoState(dir);
      check('T16 delete "-D": HEAD did not move', after.head === before.head);
      // AND THE REFUSAL SAYS NOTHING ABOUT THIS MACHINE.
      check(
        'T16 delete "-D": the sentence carries no filesystem path',
        !/\/(Users|home|var|private|tmp)\//.test(String(answer.error)),
        String(answer.error)
      );
    }

    {
      // AND THE CONTROL, so this is a refusal of options and not a refusal of
      // branches. An ordinary name goes through every one of the three.
      const dir = await behind('argv-control');
      await sh(dir, 'checkout', '-qb', 'work');
      fs.writeFileSync(path.join(dir, 'from-work.txt'), 'work\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'work');
      const back = await switchBranch(git, { projectPath: dir, branch: 'main' });
      check('T16 control: an ordinary name still switches', back.ok === true, JSON.stringify(back));
      const merged = await mergeBranch(git, { projectPath: dir, branch: 'work' });
      check('T16 control: and still merges', merged.ok === true && merged.changed === true, JSON.stringify(merged));
      check('T16 control: bringing the work with it', fs.existsSync(path.join(dir, 'from-work.txt')));
      const gone = await deleteBranch(git, { projectPath: dir, branch: 'work' });
      check('T16 control: and still deletes', gone.ok === true, JSON.stringify(gone));
      // And a name with a leading dash INSIDE it is not a leading dash.
      const odd = await switchBranch(git, { projectPath: dir, branch: 'fix-thing', create: true });
      check('T16 control: a name containing dashes is fine', odd.ok === true, JSON.stringify(odd));
      check('T16 control: and is what got checked out', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'fix-thing');
    }
  }

  {
    // T16b — A BRANCH NAME GIT EXPANDS IS NOT THE BRANCH THAT WAS NAMED.
    //
    // The option guard asks `git check-ref-format --branch` whether a name is a
    // name. That flag does not only VALIDATE — it also EXPANDS git's `@{-n}`
    // previous-checkout syntax, so it answers "yes, and here is the OTHER
    // branch you meant". Measured on the shipped file, on a repository sitting
    // on `feature` after a checkout from `main`:
    //
    //   delete_branch "@{-1}" -> {ok:true}, and MAIN WAS GONE. The trunk guard
    //     compared the caller's own string against 'main' and `@{-1}` is not
    //     'main'; `git branch -d -- '@{-1}'` then expanded it and deleted the
    //     trunk. `--` stops OPTION parsing, not REF resolution. With
    //     `force:true` the same call is `-D`, which destroys commits on no
    //     other branch and never asks the `unmerged` question at all.
    //   switch "@{-1}" -> {ok:true, from:"main"} having moved to a branch the
    //     caller never named.
    //   merge "@{-1}" -> {ok:true, into:"main", changed:true}, with another
    //     branch's commits on main and the envelope naming `@{-1}` as what it
    //     had merged.
    //
    // AND THE OTHER SPELLING THAT MEANT ANOTHER BRANCH: on a case-insensitive
    // filesystem — the macOS default — `git branch -d -- MAIN` printed "Deleted
    // branch MAIN" and main was gone, one keystroke past the same guard.
    //
    // The oracles are the repository, not the answer.
    const on = async (name) => {
      const dir = await repo(name);
      cleanup.push(dir);
      await sh(dir, 'checkout', '-qb', 'feature');
      await commitOn(dir, 'feature', 'b.txt', 'work\n');
      // main -> feature by an ordinary checkout, so `@{-1}` has something to
      // expand to. Without this git would refuse it for want of a reflog and
      // the test would pass on the wrong reason.
      await sh(dir, 'checkout', '-q', 'main');
      await sh(dir, 'checkout', '-q', 'feature');
      return dir;
    };

    {
      const dir = await on('expand-delete');
      const before = await repoState(dir);
      const answer = await caught(() => deleteBranch(git, { projectPath: dir, branch: '@{-1}' }));
      check('T16b delete "@{-1}" is refused', answer.value === null && /not a name git will accept/.test(String(answer.error)), JSON.stringify(answer));
      check(
        'T16b delete "@{-1}": THE TRUNK IS STILL THERE',
        (await sh(dir, 'branch', '--format=%(refname:short)')).split('\n').sort().join(',') === 'feature,main',
        await sh(dir, 'branch', '--format=%(refname:short)')
      );
      check('T16b delete "@{-1}": HEAD did not move', (await repoState(dir)).head === before.head);
      // Forcing is the same call with `-D` behind it, and `-D` is the one that
      // takes commits nothing else holds.
      const forced = await caught(() => deleteBranch(git, { projectPath: dir, branch: '@{-1}', force: true }));
      check('T16b delete "@{-1}" with force is refused too', forced.value === null && !!forced.error, JSON.stringify(forced));
      check(
        'T16b delete "@{-1}" with force: the trunk is still there',
        (await sh(dir, 'branch', '--format=%(refname:short)')).includes('main')
      );
      check(
        'T16b delete "@{-1}": the refusal carries no filesystem path',
        !/\/(Users|home|var|private|tmp)\//.test(String(answer.error)),
        String(answer.error)
      );
    }

    {
      // THE SAME SPELLING THROUGH THE OTHER TWO DOORS.
      const dir = await on('expand-switch');
      const answer = await switchBranch(git, { projectPath: dir, branch: '@{-1}' });
      check('T16b switch "@{-1}" is refused', answer?.ok === false && answer?.code === 'bad_branch_name', JSON.stringify(answer));
      check(
        'T16b switch "@{-1}": still on the branch it was on',
        (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'feature',
        await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
      );

      const merging = await repo('expand-merge');
      cleanup.push(merging);
      await sh(merging, 'checkout', '-qb', 'feature');
      await commitOn(merging, 'feature', 'b.txt', 'work\n');
      await sh(merging, 'checkout', '-q', 'main');
      const before = await repoState(merging);
      const merged = await mergeBranch(git, { projectPath: merging, branch: '@{-1}' });
      await refusedCleanly('T16b merge "@{-1}"', merged, merging, before, 'bad_branch_name', (a) => a.branch === '@{-1}');
      check(
        'T16b merge "@{-1}": the other branch\'s work did not arrive',
        !fs.existsSync(path.join(merging, 'b.txt'))
      );
    }

    {
      // THE TRUNK UNDER A SPELLING THAT IS NOT ITS OWN. On a case-insensitive
      // filesystem this is main; on a case-sensitive one it is a branch that
      // does not exist. Either way it must not delete the trunk, and the
      // refusal must be the trunk's own rather than git's "not found".
      const dir = await on('expand-case');
      const answer = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'MAIN' }));
      check('T16b delete "MAIN" is refused', answer.value === null && !!answer.error, JSON.stringify(answer));
      check('T16b delete "MAIN": as the trunk refusal', /comes back to|main line/i.test(String(answer.error)), String(answer.error));
      check('T16b delete "MAIN": main is still there', (await sh(dir, 'branch', '--format=%(refname:short)')).includes('main'));

      // AND THE TWO SPELLINGS THAT WERE ALWAYS REFUSED GO ON BEING REFUSED —
      // as the TRUNK now, rather than by git a moment later as "branch
      // 'refs/heads/main' not found", which is true of the spelling and reads
      // as a claim about the branch. Both resolve to main, so both are asked
      // the question main is asked.
      for (const spelling of ['refs/heads/main', 'heads/main']) {
        const said = await caught(() => deleteBranch(git, { projectPath: dir, branch: spelling }));
        check(`T16b delete "${spelling}" is refused`, said.value === null && !!said.error, JSON.stringify(said));
        check(
          `T16b delete "${spelling}": as the trunk refusal, not as a name git never heard of`,
          /comes back to|main line/i.test(String(said.error)),
          String(said.error)
        );
        check(
          `T16b delete "${spelling}": main is still there`,
          (await sh(dir, 'branch', '--format=%(refname:short)')).includes('main')
        );
      }

      // AN ALIAS FOR AN ORDINARY BRANCH IS REFUSED TOO, and the refusal names
      // the branch git would have reached. The envelope this feeds reports the
      // caller's own argument as the branch that went, so a spelling that means
      // something else cannot be allowed to succeed however harmless the branch
      // behind it is.
      await sh(dir, 'branch', 'aliased');
      const alias = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'refs/heads/aliased' }));
      check('T16b delete "refs/heads/aliased" is refused', alias.value === null && !!alias.error, JSON.stringify(alias));
      check('T16b delete "refs/heads/aliased": naming the branch git would have reached', /"aliased"/.test(String(alias.error)), String(alias.error));
      check('T16b delete "refs/heads/aliased": and saying to ask for it by that name', /own name/i.test(String(alias.error)), String(alias.error));
      check('T16b delete "refs/heads/aliased": the branch is still there', (await sh(dir, 'branch', '--format=%(refname:short)')).includes('aliased'));

      // `@` is git's shorthand for HEAD, which is the branch you are standing
      // on — so this is the "you are on it" refusal, arrived at through a
      // spelling that does not look like the branch's name at all. Git's own
      // answer is "branch '@' not found".
      const atHead = await caught(() => deleteBranch(git, { projectPath: dir, branch: '@' }));
      check('T16b delete "@" is refused', atHead.value === null && !!atHead.error, JSON.stringify(atHead));
      check('T16b delete "@": as the branch you are on', /branch you are on/i.test(String(atHead.error)), String(atHead.error));
      check('T16b delete "@": and feature is still there', (await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature'));

      // AND THE CONTROL: a branch named by itself still goes, and the answer
      // says which one went. The envelope this feeds
      // (electron/mcp/agent/domains.js) reports the caller's own argument, so
      // "the name means itself" is what makes that report true.
      await sh(dir, 'branch', 'spare');
      const went = await deleteBranch(git, { projectPath: dir, branch: 'spare' });
      check('T16b control: an ordinary branch still deletes', went.ok === true, JSON.stringify(went));
      check('T16b control: and the answer names the branch that went', went.deleted === 'spare', JSON.stringify(went));
      check('T16b control: and it really is gone', !(await sh(dir, 'branch', '--format=%(refname:short)')).includes('spare'));
    }
  }

  {
    // T17 — A PROJECT INSIDE ITS REPOSITORY.
    //
    // The ordinary monorepo layout: the repository is at <root> and the project
    // Stacki has open is <root>/site. Stacki accepts it — `git:info` only asks
    // `rev-parse --is-inside-work-tree` — and git then answers every question
    // about paths relative to the REPOSITORY ROOT, while every read and write in
    // gitBranches.js joined those answers onto the PROJECT path. Measured, with
    // one real text conflict in site/a.txt:
    //
    //   merge -> files:[{p:"site/a.txt", ours:"OURS\n", parts:null}] — the panel
    //     said there was no text in it to compare about an ordinary text file;
    //   conflictDigest could not open ANY conflicted file, so it hashed the
    //     unreadable sentinel for all of them and two genuinely DIFFERENT
    //     conflicts produced the SAME digest;
    //   per-hunk resolve -> bad_choices/not_splittable;
    //   whole-file resolve -> THREW "pathspec 'site/a.txt' did not match any
    //     file(s) known to git".
    //
    // The conflict was unresolvable by every route Stacki offers.
    /** A repository at <root> whose project lives in <root>/site. */
    const nested = async (name, ours, theirs) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
      cleanup.push(root);
      await sh(root, 'init', '-q', '-b', 'main', '.');
      await sh(root, 'config', 'user.email', 'test@example.com');
      await sh(root, 'config', 'user.name', 'Test');
      // Signing off for the same reason repo() does it: a developer with
      // `commit.gpgsign = true` set globally, and no key that signs headlessly,
      // cannot commit here at all. This used to be on ONE of the seven builders
      // in this file while the comment above repo() said it was on every fixture:
      // the suite died with an UNCAUGHT throw at the first of the other six,
      // before a single assertion printed.
      await sh(root, 'config', 'commit.gpgsign', 'false');
      fs.mkdirSync(path.join(root, 'site'));
      fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'base\n');
      await sh(root, 'add', '-A');
      await sh(root, 'commit', '-qm', 'first');
      await sh(root, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(root, 'site', 'a.txt'), theirs);
      await sh(root, 'add', '-A');
      await sh(root, 'commit', '-qm', 'feature');
      await sh(root, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(root, 'site', 'a.txt'), ours);
      await sh(root, 'add', '-A');
      await sh(root, 'commit', '-qm', 'main');
      return { root, project: path.join(root, 'site') };
    };

    const one = await nested('nested-a', 'OURS\n', 'THEIRS\n');
    const clash = await mergeBranch(git, { projectPath: one.project, branch: 'feature' });
    check('T17: the conflict is reported', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    const file = clash.files?.[0];
    check('T17: naming the path git named', file?.path === 'site/a.txt', JSON.stringify(clash.files?.map((f) => f.path)));
    // THE HALF THAT WAS NULL. A text conflict with no `parts` is a panel saying
    // "there is nothing in this file to compare" about a file with two lines in
    // it, and it is also what made a per-hunk answer impossible.
    check('T17: with the disagreement it actually contains', Array.isArray(file?.parts) && file.parts.some((p) => p.kind === 'clash'), JSON.stringify(file?.parts));
    check('T17: and both sides of it', file?.ours === 'OURS\n' && file?.theirs === 'THEIRS\n', JSON.stringify({ ours: file?.ours, theirs: file?.theirs }));

    // THE DIGEST STILL MEASURES CONTENT IN THIS LAYOUT. Two repositories laid
    // out identically, differing only in the bytes that clash: when nothing
    // could be opened, both hashed the same sentinel and the binding agreed
    // about two different conflicts.
    const two = await nested('nested-b', 'OURS-TWO\n', 'THEIRS-TWO\n');
    const clash2 = await mergeBranch(git, { projectPath: two.project, branch: 'feature' });
    check(
      'T17: two conflicts whose CONTENT differs do not share a digest',
      typeof clash.at?.digest === 'string' && clash.at.digest !== clash2.at?.digest,
      `${clash.at?.digest} vs ${clash2.at?.digest}`
    );

    // A PER-HUNK ANSWER. Refused as `not_splittable` before, because the file
    // it tried to parse was <project>/site/a.txt and there is no such file.
    const perHunk = await caught(() =>
      resolveMerge(git, { projectPath: one.project, branch: 'feature', choices: { 'site/a.txt': ['theirs'] }, expect: clash.at })
    );
    check('T17: a per-hunk answer is applied', perHunk.value?.ok === true && perHunk.value?.resolved === 1, JSON.stringify(perHunk));
    check('T17: to the file inside the repository', fs.readFileSync(path.join(one.root, 'site', 'a.txt'), 'utf8') === 'THEIRS\n', JSON.stringify(fs.readFileSync(path.join(one.root, 'site', 'a.txt'), 'utf8')));
    check('T17: as a two-parent merge commit', (await sh(one.root, 'log', '-1', '--format=%P')).split(' ').length === 2);
    check('T17: with nothing left conflicted', (await sh(one.root, 'status', '--porcelain')) === '', await sh(one.root, 'status', '--porcelain'));

    // AND A WHOLE-FILE ANSWER, which used to throw git's own pathspec error
    // straight out of resolveMerge.
    const whole = await caught(() =>
      resolveMerge(git, { projectPath: two.project, branch: 'feature', choices: { 'site/a.txt': 'ours' }, expect: clash2.at })
    );
    check('T17: a whole-file answer does not throw', whole.error === null, String(whole.error));
    check('T17: and is applied', whole.value?.ok === true && whole.value?.resolved === 1, JSON.stringify(whole));
    check('T17: keeping this branch’s version', fs.readFileSync(path.join(two.root, 'site', 'a.txt'), 'utf8') === 'OURS-TWO\n', JSON.stringify(fs.readFileSync(path.join(two.root, 'site', 'a.txt'), 'utf8')));
  }

  {
    // T18 — THE DOCUMENTED DEFAULT, ON A MODIFY/DELETE.
    //
    // "A file you leave out entirely keeps this branch's version" is what the
    // agent-facing contract promises, and it is `git checkout --ours` underneath.
    // On a clash where THIS branch deleted the file there is no stage 2 to take,
    // and the `no_such_side` validator only ever inspected choices that had been
    // GIVEN. Measured with `choices: {}`: resolve THREW git's raw
    // `error: path 'a.txt' does not have our version`, an unnamed failure about
    // a default the caller never typed.
    const dir = await repo('modifydelete');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature edit\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature edits a.txt');
    await sh(dir, 'checkout', '-q', 'main');
    fs.unlinkSync(path.join(dir, 'a.txt'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main deletes a.txt');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T18: the modify/delete is reported as a conflict', clash.ok === false && clash.files?.[0]?.path === 'a.txt', JSON.stringify(clash.files?.map((f) => f.path)));
    check('T18: with only the side that still exists', clash.files?.[0]?.ours === null && clash.files?.[0]?.theirs === 'feature edit\n', JSON.stringify({ ours: clash.files?.[0]?.ours, theirs: clash.files?.[0]?.theirs }));
    const before = await repoState(dir);
    const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: {}, expect: clash.at }));
    check('T18: the default does not throw git’s own sentence', answer.error === null, String(answer.error));
    await refusedCleanly(
      'T18 a default this file has no version for',
      answer.value,
      dir,
      before,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.reason === 'no_such_side' && r?.badChoices?.[0]?.path === 'a.txt' && r?.badChoices?.[0]?.given === 'ours'
    );
    check(
      'T18: naming the side the file does have',
      JSON.stringify(answer.value?.badChoices?.[0]?.sides) === JSON.stringify(['theirs']),
      JSON.stringify(answer.value?.badChoices?.[0])
    );
    // AND THE CONTROL. The answer this file CAN take still works, so the
    // refusal is about the missing side and not about modify/delete.
    const kept = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: clash.at }));
    check('T18 control: "theirs" — the side that exists — still merges', kept.value?.ok === true, JSON.stringify(kept));
    check('T18 control: and the edited file is on the branch', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'feature edit\n');
  }

  {
    // T19 — ONE UNREADABLE REASON IS NOT ANOTHER.
    //
    // conflictDigest hashed a single constant sentinel for every way of failing
    // to open a conflicted file, so a conflicted submodule (EISDIR) and a file
    // whose permissions had been taken away (EACCES) were the same measurement,
    // and a path that moved from one to the other did not move the digest.
    // THE PATH IS THE SAME IN ALL THREE. The name is hashed as well as the
    // bytes, so two DIFFERENT paths would come out different whatever the
    // sentinel said — comparing those would be a test that cannot fail. What
    // has to differ is one path, unreadable for two different reasons.
    const missingAt = await repo('unreadable-missing');
    cleanup.push(missingAt);
    const dirAt = await repo('unreadable-dir');
    cleanup.push(dirAt);
    fs.mkdirSync(path.join(dirAt, 'x'));
    fs.writeFileSync(path.join(dirAt, 'x', 'inner.txt'), 'inner\n');
    const lockedAt = await repo('unreadable-locked');
    cleanup.push(lockedAt);
    fs.writeFileSync(path.join(lockedAt, 'x'), 'secret\n');
    fs.chmodSync(path.join(lockedAt, 'x'), 0o000);
    try {
      const missing = conflictDigest(missingAt, ['x']); // ENOENT
      const directory = conflictDigest(dirAt, ['x']); // EISDIR — a conflicted submodule
      const locked = conflictDigest(lockedAt, ['x']); // EACCES
      check('T19: a path that is absent and one that is a directory do not hash alike', missing !== directory, `${missing} vs ${directory}`);
      check('T19: nor does one whose permissions were taken away', locked !== missing && locked !== directory, `${locked} / ${missing} / ${directory}`);
      // And every one of them is still distinct from a file that is simply
      // empty, which is the collision the sentinel existed to prevent at all.
      const emptyAt = await repo('unreadable-empty');
      cleanup.push(emptyAt);
      fs.writeFileSync(path.join(emptyAt, 'x'), '');
      const empty = conflictDigest(emptyAt, ['x']);
      check('T19: and none of them hashes like an empty file', empty !== missing && empty !== directory && empty !== locked, `${empty} / ${missing} / ${directory} / ${locked}`);
    } finally {
      // A fixture with an unreadable file in it is a fixture the cleanup may
      // not be able to remove.
      fs.chmodSync(path.join(lockedAt, 'x'), 0o644);
    }
  }

  {
    // T15d — A CONFLICT IN A FILE WHOSE NAME GIT WILL NOT PRINT PLAINLY.
    //
    // `core.quotePath` defaults to true, so `git diff --name-only
    // --diff-filter=U` printed `"src/pages/caf\303\251.astro"` — quotation
    // marks included — for a clash in `café.astro`. Measured, all three
    // consequences at once: `conflictDigest` could not open that name so the
    // file hashed as the UNREADABLE sentinel, which is a measurement of nothing
    // wearing the shape of a measurement; the caller was handed the quoted name
    // with `ours`, `theirs` and `parts` all null, so there was nothing to
    // choose between; and a resolve naming the real path was refused as
    // `unknown_path` while one naming the quoted path died inside git on
    // `pathspec ... did not match any file(s) known to git`. A clash in any
    // accented or CJK filename was unresolvable by every route there is.
    const PAGE = 'src/pages/café.astro';
    // AND ONE THE QUOTING FIX DOES NOT REACH, carried in the same fixture
    // because it is the same question asked of the same command. The listing
    // was newline-separated with a `.trim()` over every line, so a path that
    // BEGINS with a space came back without it — a name no file has, arrived at
    // with no quoting involved at all.
    const SPACED = ' draft.astro';
    // The same clash over both files, with `body` the thing the two branches
    // disagree about. Two of these differing only in that is what says the
    // binding measured the files rather than its own failure to open them.
    const accented = async (name, body) => {
      const at = await repo(name);
      cleanup.push(at);
      fs.mkdirSync(path.join(at, 'src', 'pages'), { recursive: true });
      for (const file of [PAGE, SPACED]) fs.writeFileSync(path.join(at, file), 'base\n');
      await sh(at, 'add', '-A');
      await sh(at, 'commit', '-qm', 'both pages');
      await sh(at, 'checkout', '-qb', 'feature');
      for (const file of [PAGE, SPACED]) fs.writeFileSync(path.join(at, file), `from feature, ${body}\n`);
      await sh(at, 'add', '-A');
      await sh(at, 'commit', '-qm', 'feature pages');
      await sh(at, 'checkout', '-q', 'main');
      for (const file of [PAGE, SPACED]) fs.writeFileSync(path.join(at, file), 'from main\n');
      await sh(at, 'add', '-A');
      await sh(at, 'commit', '-qm', 'main pages');
      return at;
    };

    const dir = await accented('nonascii', 'one');
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const listed = (clash.files || []).map((f) => f.path);
    check('T15d: the accented path comes back as the name the file has', listed.includes(PAGE), JSON.stringify(listed));
    check('T15d: and not C-quoted', !listed.some((one) => one.includes('\\')), JSON.stringify(listed));
    check('T15d: a path that begins with a space keeps it', listed.includes(SPACED), JSON.stringify(listed));
    const only = (clash.files || []).find((f) => f.path === PAGE);
    // The two sides are read by `git show :2:` and `:3:` on that same name, so
    // a quoted one came back null from both and left nothing to decide.
    check('T15d: this branch’s version of the accented file was read', only?.ours === 'from main\n', JSON.stringify(only?.ours));
    check('T15d: and the incoming one', only?.theirs === 'from feature, one\n', JSON.stringify(only?.theirs));
    check('T15d: and the marked-up file was parsed into a disagreement', (only?.parts || []).filter((part) => part.kind === 'clash').length === 1, JSON.stringify(only?.parts));
    // AND THE BINDING MEASURED THE FILES, not its own failure to open them.
    // Under the quoted name `conflictDigest` read nothing and hashed the
    // UNREADABLE sentinel, so the SAME conflict in the SAME paths digested to
    // the same value whatever was inside them — a binding that binds nothing.
    // Two repositories with identical paths and different conflicting content
    // say so without needing to know what a digest looks like.
    const twin = await accented('nonascii-twin', 'two');
    const clash2 = await mergeBranch(git, { projectPath: twin, branch: 'feature' });
    check(
      'T15d: two conflicts differing only in content do not share one binding',
      !!clash.at?.digest && clash.at.digest !== clash2.at?.digest,
      JSON.stringify({ one: clash.at?.digest, two: clash2.at?.digest })
    );
    const answer = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { [PAGE]: 'theirs', [SPACED]: 'theirs' }, expect: clash.at });
    check('T15d: a resolve naming those paths goes through', answer?.ok === true, JSON.stringify(answer).slice(0, 400));
    check('T15d: and the incoming bytes are what is on disk', fs.readFileSync(path.join(dir, PAGE), 'utf8') === 'from feature, one\n', fs.readFileSync(path.join(dir, PAGE), 'utf8'));
    check('T15d: for the space-led path too', fs.readFileSync(path.join(dir, SPACED), 'utf8') === 'from feature, one\n', fs.readFileSync(path.join(dir, SPACED), 'utf8'));
    check('T15d: as a two-parent merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
  }

  {
    // T15e — A WORD IN THE VOCABULARY THAT THE FILE HAS NO VERSION FOR.
    //
    // One branch edits a file and the other deletes it. There is no stage 3, so
    // "theirs" names nothing — but it is a legal word, so the validator whose
    // whole purpose is to say no before anything is written passed it, and
    // `git checkout --theirs` then failed with `error: path 'a.txt' does not
    // have their version`. Nothing was corrupted (the catch aborts, and HEAD
    // and the tree were measured intact) but the agent got an unnamed `failed`
    // carrying git's sentence instead of `bad_choices` naming the offender.
    const dir = await repo('modifydelete');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.unlinkSync(path.join(dir, 'a.txt'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'delete a on feature');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'kept, and edited on main\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'edit a on main');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T15e: the file clashes', clash.ok === false && clash.files?.[0]?.path === 'a.txt', JSON.stringify(clash.files?.map((f) => f.path)));
    check('T15e: and the incoming side of it is an absence', clash.files?.[0]?.theirs === null, JSON.stringify(clash.files?.[0]?.theirs));
    const before = await repoState(dir);
    // Through `caught`, because the whole point is that this used to LEAVE the
    // function as a throw. A test that awaited it directly would die on the
    // unhandled rejection and report nothing by name.
    const attempt = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: clash.at }));
    check('T15e: the choice is refused rather than thrown out of git', attempt.error === null, String(attempt.error));
    const answer = attempt.value;
    await refusedCleanly(
      'T15e a side the file does not have',
      answer,
      dir,
      before,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.path === 'a.txt' && r.badChoices[0].reason === 'no_such_side'
    );
    // WHICH SIDES IT DOES HAVE. A refusal that only says no sends the caller
    // back to guess the other word.
    check(
      'T15e: the refusal names the sides that file actually has',
      JSON.stringify(answer?.badChoices?.[0]?.sides) === JSON.stringify(['ours']),
      JSON.stringify(answer?.badChoices?.[0])
    );
    check('T15e: and which branch deleted it', answer?.badChoices?.[0]?.deletedBy === 'theirs', JSON.stringify(answer?.badChoices?.[0]));
    // The sentence a PERSON gets, which for this one reason has to say more
    // than the general one: "a choice is ours or theirs" is exactly what they
    // said, so on its own it sends them back to stare at a word that was fine.
    check(
      'T15e: and the sentence says the file exists on only one branch',
      /only one branch/.test(String(answer?.message)) && /"ours"/.test(String(answer?.message)),
      String(answer?.message)
    );
    check('T15e: no merge commit happened', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1);
    // THE CONTROL, both ways round: the side that does exist still resolves.
    const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at });
    check('T15e control: the side the file does have still merges', done?.ok === true, JSON.stringify(done));
    check('T15e control: keeping the file this branch edited', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'kept, and edited on main\n');

    // AND THE MIRROR IMAGE. This branch deleted it, the incoming one edited it,
    // and 'ours' is the word with nothing behind it — the same defect with the
    // sides swapped, which a check written only for `--theirs` would miss.
    const other = await repo('deletemodify');
    cleanup.push(other);
    await sh(other, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(other, 'a.txt'), 'kept, and edited on feature\n');
    await sh(other, 'add', '-A');
    await sh(other, 'commit', '-qm', 'edit a on feature');
    await sh(other, 'checkout', '-q', 'main');
    fs.unlinkSync(path.join(other, 'a.txt'));
    await sh(other, 'add', '-A');
    await sh(other, 'commit', '-qm', 'delete a on main');
    const clash2 = await mergeBranch(git, { projectPath: other, branch: 'feature' });
    const before2 = await repoState(other);
    const attempt2 = await caught(() => resolveMerge(git, { projectPath: other, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash2.at }));
    check('T15e: the mirror image is refused rather than thrown out of git', attempt2.error === null, String(attempt2.error));
    const answer2 = attempt2.value;
    await refusedCleanly(
      'T15e the mirror image — a file this branch deleted, asked for as "ours"',
      answer2,
      other,
      before2,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.reason === 'no_such_side' && JSON.stringify(r.badChoices[0].sides) === JSON.stringify(['theirs'])
    );
    check('T15e: the mirror image names the branch that deleted it', answer2?.badChoices?.[0]?.deletedBy === 'ours', JSON.stringify(answer2?.badChoices?.[0]));
  }

  {
    // T16 — A RESOLVE WITH NO BINDING AT ALL.
    //
    // An optional guard is the hole the binding exists to close: a caller that
    // simply never sends the field gets a resolve that takes whatever it finds,
    // and the protection exists only for callers that remembered to ask.
    const dir = await twoClashRepo('nobinding');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const before = await repoState(dir);
    const answer = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs', 'theirs'] } });
    await refusedCleanly('T16 a resolve that does not say which conflict it settles', answer, dir, before, 'guard_required', (r) => /which conflict/i.test(String(r.message)));
    // AND THE HALF-BINDINGS. A shape that carries some of it is not a binding.
    for (const [what, partial] of [
      ['an empty object', {}],
      ['only the head', { head: clash.at.head }],
      ['head and incoming but no digest', { head: clash.at.head, incoming: clash.at.incoming }],
      // The one the handle used to be missing altogether. Without it a resolve
      // knows which two commits it is between and not which branch it is
      // landing on, which is how answers about `main` got committed onto a
      // sibling at the same tip — see T27.
      ['the two commits and the digest but no branch to merge into', { head: clash.at.head, incoming: clash.at.incoming, digest: clash.at.digest }],
      ['a string', 'stacki:not-an-observation'],
    ]) {
      const half = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs', 'theirs'] }, expect: partial });
      check(`T16: ${what} is not a binding`, half?.ok === false && half.code === 'guard_required', JSON.stringify(half).slice(0, 200));
    }
    check('T16: and HEAD never moved through any of it', (await sh(dir, 'rev-parse', 'HEAD')) === before.head);
    // THE CONTROL. The same call with the binding it was given still merges.
    const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs', 'theirs'] }, expect: clash.at });
    check('T16 control: the same resolve with its binding still merges', done.ok === true, JSON.stringify(done));
    check('T16 control: as a two-parent merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
  }

  {
    // T17 — THE SAME DECISION, THE SAME BYTES.
    //
    // renderResolved joins with '\n', and when the conflict runs to the end of
    // the file git has written a newline after the last marker whether or not
    // the chosen side had one. Measured, over an incoming file with no
    // terminator: `'theirs'` for the whole file committed "a\nfeat", and
    // `['theirs']` for the same file committed "a\nfeat\n". Same decision, two
    // different files, and which you got depended on how you phrased it.
    const build = async (name, theirsBody) => {
      const dir = await repo(name);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nbase\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), theirsBody);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'feature');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nmain\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'main');
      return dir;
    };
    const settle = async (dir, choice) => {
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': choice }, expect: clash.at });
      check(`T17: the ${Array.isArray(choice) ? 'per-hunk' : 'whole-file'} resolve went through`, done.ok === true, JSON.stringify(done));
      return (await git(dir, ['show', 'HEAD:a.txt'])).stdout;
    };

    // The incoming file has no terminating newline.
    const wholeA = await build('nlwhole', 'a\nfeat');
    cleanup.push(wholeA);
    const hunkA = await build('nlhunk', 'a\nfeat');
    cleanup.push(hunkA);
    const w = await settle(wholeA, 'theirs');
    const h = await settle(hunkA, ['theirs']);
    check('T17 the two ways of saying "take theirs" commit the same bytes', w === h, JSON.stringify({ whole: w, perHunk: h }));
    check('T17: and neither invented a terminator the incoming file did not have', !w.endsWith('\n') && !h.endsWith('\n'), JSON.stringify({ whole: w, perHunk: h }));

    // THE CONTROL, and the case that must not regress the other way: an
    // incoming file that DOES end with a newline keeps exactly one.
    const wholeB = await build('nlwhole2', 'a\nfeat\n');
    cleanup.push(wholeB);
    const hunkB = await build('nlhunk2', 'a\nfeat\n');
    cleanup.push(hunkB);
    const w2 = await settle(wholeB, 'theirs');
    const h2 = await settle(hunkB, ['theirs']);
    check('T17 control: a terminated incoming file agrees too', w2 === h2, JSON.stringify({ whole: w2, perHunk: h2 }));
    check('T17 control: and keeps exactly one terminator', w2 === 'a\nfeat\n' && h2 === 'a\nfeat\n', JSON.stringify({ whole: w2, perHunk: h2 }));
  }

  {
    // T19 — THE BLANK LINE NOBODY WROTE.
    //
    // The ordinary shape of one branch DELETING lines the other modified: the
    // chosen side of the hunk has no lines in it at all. `renderResolved` joins
    // the parts with '\n', so a hunk contributing nothing still collected a
    // separator on each side of it and the rebuilt file gained an empty line
    // NEITHER BRANCH HAD — written, staged and committed as
    // `{ok:true, changed:true, resolved:1}`. The digest binding cannot catch
    // it: the binding is about the conflict git reported, not about what was
    // rendered from it.
    //
    // The oracle is not a shape, it is the file `main` already had on disk.
    // Answering `ours` for every hunk is a decision that cannot change a byte of
    // it, so anything but "identical to ours" is this defect or another one.
    const deletion = async (name, ours) => {
      const dir = await repo(name);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nX\nz\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ancestor');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nC\nz\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'feature changed it');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), ours);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'main did something else');
      return dir;
    };

    const gone = await deletion('deletedhunk', 'a\nz\n');
    cleanup.push(gone);
    const clashG = await mergeBranch(git, { projectPath: gone, branch: 'feature' });
    check('T19: deleting a line the other branch changed conflicts', clashG?.conflicted === true, JSON.stringify(clashG).slice(0, 200));
    check('T19: as one disagreement', (clashG.files?.[0]?.parts || []).filter((p) => p.kind === 'clash').length === 1, JSON.stringify(clashG.files?.[0]?.parts));
    const doneG = await resolveMerge(git, { projectPath: gone, branch: 'feature', choices: { 'a.txt': ['ours'] }, expect: clashG.at });
    check('T19: answering it with your own side goes through', doneG?.ok === true, JSON.stringify(doneG));
    const bytesG = (await git(gone, ['show', 'HEAD:a.txt'])).stdout;
    check(
      'T19: and commits the file this branch already had, without a blank line where it deleted one',
      bytesG === 'a\nz\n',
      JSON.stringify(bytesG)
    );

    // THE CONTROL, AND THE OTHER WAY TO GET THIS WRONG. A side that is one
    // BLANK line parses to the same empty string as a side that is not there
    // at all, so a fix that reads emptiness off the text deletes a line this
    // branch really does have. Same ancestor, same incoming change, one byte
    // different on `main` — and the answer has to differ by a line.
    const blank = await deletion('blankhunk', 'a\n\nz\n');
    cleanup.push(blank);
    const clashB = await mergeBranch(git, { projectPath: blank, branch: 'feature' });
    check('T19 control: a blank line where the other branch edited also conflicts', clashB?.conflicted === true, JSON.stringify(clashB).slice(0, 200));
    const doneB = await resolveMerge(git, { projectPath: blank, branch: 'feature', choices: { 'a.txt': ['ours'] }, expect: clashB.at });
    check('T19 control: and resolves', doneB?.ok === true, JSON.stringify(doneB));
    const bytesB = (await git(blank, ['show', 'HEAD:a.txt'])).stdout;
    check(
      'T19 control: keeping a blank line this branch really wrote',
      bytesB === 'a\n\nz\n',
      JSON.stringify(bytesB)
    );
  }

  {
    // T18 — THE ONE RESOLVE FAILURE AN AGENT HAD TO READ ENGLISH TO CLASSIFY.
    //
    // Uncommitted work in a conflicting file stops git before the merge starts,
    // so there is nothing conflicted to apply the answers to — and the failure
    // surfaced two calls later as the bare string "Command failed: git commit
    // --no-edit", with no code on it at all.
    const dir = await twoClashRepo('dirtyresolve');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'typed after the conflict was reported\n');
    const headBefore = await sh(dir, 'rev-parse', 'HEAD');
    const answer = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': ['theirs', 'theirs'] },
      expect: clash.at,
    });
    check('T18 a resolve blocked by unsaved work is refused', answer?.ok === false, JSON.stringify(answer));
    check('T18: with a code rather than a shell error', answer?.code === 'working_tree_blocked', JSON.stringify({ code: answer?.code, message: answer?.message }));
    check('T18: and not the command line echoed back', !/^Command failed:/.test(String(answer?.message || '')), String(answer?.message));
    check('T18: naming the file in the way', (answer?.files || []).some((f) => String(f).includes('a.txt')), JSON.stringify(answer?.files));
    check('T18: HEAD did not move', (await sh(dir, 'rev-parse', 'HEAD')) === headBefore);
    check('T18: no merge was left in progress', !fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')));
    check(
      'T18: and the unsaved work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'typed after the conflict was reported\n',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
    );
  }

  {
    // THE LAST POSITIVE CONTROL: an exactly-right-length list containing
    // 'both' at a hunk both branches really changed. 'both' is the one answer
    // in the per-hunk vocabulary that none of the blocks above exercises, and a
    // pre-flight that rejected it would be caught nowhere else.
    const dir = await repo('bothpick');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'list.md'), '- base item\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'list');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'list.md'), '- an item added on the branch\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature list');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'list.md'), '- an item added on main\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main list');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const c = (clash.files[0].parts || []).filter((p) => p.kind === 'clash');
    check('the both-sides fixture is one disagreement', c.length === 1, JSON.stringify(c));
    check('and both branches changed it', c[0].changedBy === 'both', JSON.stringify(c[0]));
    const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'list.md': ['both'] }, expect: clash.at });
    check('"both" at a hunk both branches changed still merges', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(dir, 'list.md'), 'utf8');
    check('  keeping this branch’s item', out.includes('added on main'), out);
    check('  and the incoming one', out.includes('added on the branch'), out);
    check('  with no markers left', !out.includes('<<<<<<<'), out);
    check('  on a clean tree', (await sh(dir, 'status', '--porcelain')) === '');
    check('  as a two-parent merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
  }

  // --- A merge with unsaved work that is NOT in the way ---------------------
  //
  // This used to be refused. The app checked for any uncommitted change at all
  // and told you to commit first — but a merge only clashes with unsaved work
  // when it needs to write the SAME file, and most of the time it does not.
  // Being made to commit an unrelated page before merging is the same false
  // obstacle that used to sit in front of switching branches.
  {
    const dir = await repo('dirtyok');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');
    // Unsaved work in a file the merge has no interest in.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'work in progress\n');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('the merge just happens', r.ok === true, JSON.stringify(r));
    check('the branch’s work arrives', fs.existsSync(path.join(dir, 'b.txt')));
    check(
      'and the unsaved work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'work in progress\n',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
    );
  }

  // --- A merge with unsaved work that IS in the way -------------------------
  {
    const dir = await repo('dirtyblocked');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'a.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'unsaved edit\n');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    // A question — park it or commit it — not an error, and shaped like the
    // same question a blocked branch switch asks.
    check('a merge that needs that file stops', r.ok === false, JSON.stringify(r));
    check('and is flagged as work being in the way', r.dirty === true, JSON.stringify(r));
    check('naming the file', (r.files || []).some((f) => f.includes('a.txt')), JSON.stringify(r.files));
    check(
      'the uncommitted work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'unsaved edit\n'
    );
    check('and nothing was merged', (await sh(dir, 'log', '-1', '--format=%s')) !== 'a.txt on feature');
  }

  // --- Merging the branch you are on ---------------------------------------
  {
    const dir = await repo('self');
    cleanup.push(dir);
    const { error } = await caught(() => mergeBranch(git, { projectPath: dir, branch: 'main' }));
    check('merging a branch into itself is refused', !!error, error);
  }

  // --- Deleting a branch holding commits of its own ------------------------
  {
    const dir = await repo('unmerged');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'only here\n');
    await sh(dir, 'checkout', '-q', 'main');

    const r = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    // A question, not an error — it comes back as a value so the caller can
    // ask it rather than showing porcelain about `-D`.
    check('an unmerged branch is not deleted', r.ok === false, JSON.stringify(r));
    check('and it is flagged as the question it is', r.unmerged === true, JSON.stringify(r));
    check(
      'the message says what is at stake',
      /commits/i.test(r.message || '') && /feature/.test(r.message || ''),
      r.message
    );
    check(
      'the branch is still there',
      (await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );

    const forced = await deleteBranch(git, { projectPath: dir, branch: 'feature', force: true });
    check('forcing deletes it', forced.ok === true, JSON.stringify(forced));
    check(
      'and it is gone',
      !(await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );
  }

  // --- Tidying up after a merge ---------------------------------------------
  //
  // Once a branch is folded in it is usually finished, so the app offers to
  // delete it as part of the merge. That only holds up if a just-merged branch
  // deletes by the SAFE route — forcing would be the app deciding, on the
  // user's behalf, that whatever git objected to did not matter.
  {
    const dir = await repo('tidy');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'work\n');
    await sh(dir, 'checkout', '-q', 'main');

    const merged = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('the merge lands', merged.ok === true, JSON.stringify(merged));
    // No force: git is satisfied because the work is now on main.
    const gone = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('the branch deletes without forcing', gone.ok === true, JSON.stringify(gone));
    check('and is gone', !(await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature'));
    check('while its work stayed', fs.existsSync(path.join(dir, 'b.txt')));
  }

  // --- Tidying up a branch that had nothing to give -------------------------
  {
    const dir = await repo('tidynoop');
    cleanup.push(dir);
    await sh(dir, 'branch', 'stale');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'stale' });
    check('a merge with nothing to bring still succeeds', r.ok === true, JSON.stringify(r));
    check('and reports that nothing moved', r.changed === false, JSON.stringify(r));
    // Nothing moved, but the branch is still redundant, so deleting is right
    // and git allows it.
    const gone = await deleteBranch(git, { projectPath: dir, branch: 'stale' });
    check('the redundant branch still deletes cleanly', gone.ok === true, JSON.stringify(gone));
  }

  // --- Deleting the trunk ---------------------------------------------------
  //
  // Git will do this. `git branch -d main` succeeds the moment main is merged
  // into wherever you are standing — which, after any ordinary merge, it is.
  // Nothing warns you, and what is lost is the branch everything comes back
  // to. The button for it is hidden in the UI; this is the other half, so a
  // caller that forgets cannot do it either.
  {
    const dir = await repo('trunk');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'new-branch');
    await commitOn(dir, 'new-branch', 'b.txt', 'work\n');
    // Merged in, so git's own safety check would raise no objection at all.
    await sh(dir, 'checkout', '-q', 'main');
    await sh(dir, 'merge', '--no-edit', '-q', 'new-branch');
    await sh(dir, 'checkout', '-q', 'new-branch');

    const { error } = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'main' }));
    check('the trunk is not deletable', !!error, error);
    check('and the refusal says why', /comes back to|main line/i.test(error || ''), error);
    check(
      'main is still there',
      (await sh(dir, 'branch', '--format=%(refname:short)')).includes('main')
    );

    // An ordinary branch in the same repository is unaffected — the guard is
    // about the trunk, not about caution in general.
    await sh(dir, 'branch', 'scratch');
    const ok = await deleteBranch(git, { projectPath: dir, branch: 'scratch' });
    check('other branches still delete', ok.ok === true, JSON.stringify(ok));

    // And it can still be done deliberately, for a caller that means it.
    const forced = await deleteBranch(git, { projectPath: dir, branch: 'main', allowTrunk: true });
    check('the trunk goes when explicitly allowed', forced.ok === true, JSON.stringify(forced));
  }

  // --- Deleting the branch you are on --------------------------------------
  {
    const dir = await repo('current');
    cleanup.push(dir);
    const { error } = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'main' }));
    check('the current branch is not deletable', !!error, error);
    check('and the refusal says to switch first', /switch/i.test(error || ''), error);
  }

  // --- Deleting a branch checked out in another worktree --------------------
  {
    const dir = await repo('worktree');
    cleanup.push(dir);
    await sh(dir, 'branch', 'elsewhere');
    const wt = path.join(dir, '..', path.basename(dir) + '-wt');
    await sh(dir, 'worktree', 'add', '-q', wt, 'elsewhere');
    cleanup.push(wt);

    const { error } = await caught(() =>
      deleteBranch(git, { projectPath: dir, branch: 'elsewhere' })
    );
    check('a branch held by another worktree is refused', !!error, error);
    // Git leads with a path nobody asked about; this should lead with the name.
    check('and the refusal says which worktree', /worktree/i.test(error || ''), error);
  }

  // --- Switching with work in progress -------------------------------------
  //
  // What every other editor does, and what this used to get wrong: it asked
  // what to do with uncommitted changes BEFORE trying, so the ordinary case —
  // a file that is the same on both branches — became a dialog about a problem
  // that was never going to happen.
  {
    const dir = await repo('switch');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'same on both\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'shared');
    await sh(dir, 'branch', 'feature');

    fs.writeFileSync(path.join(dir, 'shared.txt'), 'work in progress\n');
    const r = await switchBranch(git, { projectPath: dir, branch: 'feature' });
    check('a switch with unsaved work just happens', r.ok === true, JSON.stringify(r));
    check('landing on the branch', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'feature');
    check(
      'with the work carried across',
      fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') === 'work in progress\n',
      fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8')
    );
    check('nothing was parked', r.parked === false, JSON.stringify(r));
    check('and nothing was committed', (await sh(dir, 'log', '-1', '--format=%s')) === 'shared');
  }

  // --- Switching when the work genuinely cannot come ------------------------
  {
    const dir = await repo('switchblocked');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature version\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature edit');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'unsaved work\n');

    const r = await switchBranch(git, { projectPath: dir, branch: 'feature' });
    // A question, not an error — returned with the files git named so the UI
    // can ask about those rather than about "uncommitted changes" in general.
    check('a switch that would destroy work is refused', r.ok === false, JSON.stringify(r));
    check('and flagged as the question it is', r.blocked === true, JSON.stringify(r));
    check('naming the file in the way', (r.files || []).includes('a.txt'), JSON.stringify(r.files));
    // HEAD must not move: an editor that believes it switched when it did not
    // writes every later edit onto the wrong branch.
    check('you are still where you were', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'main');
    check(
      'and the work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'unsaved work\n'
    );
  }

  // --- Making a branch takes the work with it -------------------------------
  {
    const dir = await repo('switchcreate');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'started something\n');

    const r = await switchBranch(git, { projectPath: dir, branch: 'idea', create: true });
    check('a new branch is made', r.ok === true, JSON.stringify(r));
    check('and checked out', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'idea');
    // Starting a branch from what is in front of you means taking it with you.
    check(
      'with the work in progress on it',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'started something\n'
    );
  }


  {
    // T20 — WHERE T17 AND T18 CROSS, WHICH IS WHERE THE VALIDATOR WAS INERT.
    //
    // T17 is the only nested-layout case and it is a plain two-sided content
    // conflict; T18 is the only modify/delete and it runs at the repository
    // root. The two never met, and the whole `no_such_side` validator lived in
    // the gap between them.
    //
    // `left` comes from `git diff`, which spells names from the REPOSITORY
    // ROOT. `git ls-files -u`, which is where the stage sets came from, was run
    // with cwd = the PROJECT — and ls-files is cwd-scoped in both directions:
    // cwd-relative names, and nothing outside the cwd listed at all. So in the
    // <root> / <root>/site layout the keys could never match: `left` said
    // "site/a.txt", the index map was keyed "a.txt", every lookup missed, and
    // `sidesOf` returned its permissive [ours, theirs] default for every file.
    //
    // MEASURED before the fix, project at <root>/site, main deletes site/a.txt,
    // feature edits it, `choices: {}`:
    //   at the repository root -> bad_choices / no_such_side, byDefault
    //   from <root>/site       -> THREW "error: path 'site/a.txt' does not have
    //                             our version", and site/a.txt was gone
    // i.e. exactly the failure T18 exists to prove closed, still live one
    // layout over.

    /** A repository at <root>, project at <root>/site, one modify/delete in it. */
    const nestedDelete = async (name) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
      cleanup.push(root);
      await sh(root, 'init', '-q', '-b', 'main', '.');
      await sh(root, 'config', 'user.email', 'test@example.com');
      await sh(root, 'config', 'user.name', 'Test');
      // Signing off for the same reason repo() does it: a developer with
      // `commit.gpgsign = true` set globally, and no key that signs headlessly,
      // cannot commit here at all. This used to be on ONE of the seven builders
      // in this file while the comment above repo() said it was on every fixture:
      // the suite died with an UNCAUGHT throw at the first of the other six,
      // before a single assertion printed.
      await sh(root, 'config', 'commit.gpgsign', 'false');
      fs.mkdirSync(path.join(root, 'site'));
      fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'base\n');
      await sh(root, 'add', '-A');
      await sh(root, 'commit', '-qm', 'first');
      await sh(root, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'feature edit\n');
      await sh(root, 'add', '-A');
      await sh(root, 'commit', '-qm', 'feature edits site/a.txt');
      await sh(root, 'checkout', '-q', 'main');
      fs.unlinkSync(path.join(root, 'site', 'a.txt'));
      await sh(root, 'add', '-A');
      await sh(root, 'commit', '-qm', 'main deletes site/a.txt');
      return { root, project: path.join(root, 'site') };
    };

    const one = await nestedDelete('nested-modifydelete');
    const clash = await mergeBranch(git, { projectPath: one.project, branch: 'feature' });
    check('T20: the nested modify/delete is reported', clash.ok === false && clash.files?.[0]?.path === 'site/a.txt', JSON.stringify(clash.files?.map((f) => f.path)));
    const before = await repoState(one.root);
    const answer = await caught(() => resolveMerge(git, { projectPath: one.project, branch: 'feature', choices: {}, expect: clash.at }));
    // THE ASSERTION THE OLD CODE FAILED FIRST: it threw git's own sentence.
    check('T20: the default does not throw git’s own sentence in a nested project', answer.error === null, String(answer.error));
    await refusedCleanly(
      'T20 a default this file has no version for, from a project inside its repository',
      answer.value,
      one.root,
      before,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.reason === 'no_such_side' && r?.badChoices?.[0]?.path === 'site/a.txt' && r?.badChoices?.[0]?.byDefault === true
    );
    check(
      'T20: naming the side the file does have',
      JSON.stringify(answer.value?.badChoices?.[0]?.sides) === JSON.stringify(['theirs']),
      JSON.stringify(answer.value?.badChoices?.[0])
    );
    // And the control, so the refusal is about the missing side rather than
    // about the layout: the side that exists still merges, here too.
    const kept = await caught(() => resolveMerge(git, { projectPath: one.project, branch: 'feature', choices: { 'site/a.txt': 'theirs' }, expect: clash.at }));
    check('T20 control: "theirs" — the side that exists — still merges nested', kept.value?.ok === true, JSON.stringify(kept));
    check('T20 control: and the edited file is on the branch', textOf(path.join(one.root, 'site', 'a.txt')) === 'feature edit\n', JSON.stringify(textOf(path.join(one.root, 'site', 'a.txt'))));

    // T20b — AND THE WORSE HALF: THE STAGE SET OF ANOTHER FILE ENTIRELY.
    //
    // Two conflicts, <root>/x.txt and <root>/site/x.txt, in the same merge.
    // From cwd = <root>/site, `ls-files -u` printed the SECOND one as "x.txt",
    // which is the key the FIRST one is looked up under. Measured before the
    // fix, x.txt a two-sided content clash and site/x.txt a modify/delete:
    // `{"x.txt":"ours"}` — a side x.txt certainly has — was REFUSED as
    // no_such_side with sides:["theirs"], and `{"site/x.txt":"ours"}` — which
    // genuinely has no "ours" — was PASSED. Both files answered for by the
    // other. This is the check that a mis-binding is impossible rather than
    // merely unlikely: it fails in BOTH directions if the spaces drift again.
    const both = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-git-nested-collide-'));
    cleanup.push(both);
    await sh(both, 'init', '-q', '-b', 'main', '.');
    await sh(both, 'config', 'user.email', 'test@example.com');
    await sh(both, 'config', 'user.name', 'Test');
    // Signing off for the same reason repo() does it: a developer with
    // `commit.gpgsign = true` set globally, and no key that signs headlessly,
    // cannot commit here at all. This used to be on ONE of the seven builders
    // in this file while the comment above repo() said it was on every fixture:
    // the suite died with an UNCAUGHT throw at the first of the other six,
    // before a single assertion printed.
    await sh(both, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(both, 'site'));
    fs.writeFileSync(path.join(both, 'x.txt'), 'base root\n');
    fs.writeFileSync(path.join(both, 'site', 'x.txt'), 'base site\n');
    await sh(both, 'add', '-A');
    await sh(both, 'commit', '-qm', 'first');
    await sh(both, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(both, 'x.txt'), 'feature root\n');
    fs.writeFileSync(path.join(both, 'site', 'x.txt'), 'feature site\n');
    await sh(both, 'add', '-A');
    await sh(both, 'commit', '-qm', 'feature');
    await sh(both, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(both, 'x.txt'), 'main root\n');
    fs.unlinkSync(path.join(both, 'site', 'x.txt'));
    await sh(both, 'add', '-A');
    await sh(both, 'commit', '-qm', 'main');
    const project = path.join(both, 'site');
    const twoClash = await mergeBranch(git, { projectPath: project, branch: 'feature' });
    check(
      'T20b: both conflicts are reported, repo-root-spelled',
      JSON.stringify((twoClash.files || []).map((f) => f.path).sort()) === JSON.stringify(['site/x.txt', 'x.txt']),
      JSON.stringify(twoClash.files?.map((f) => f.path))
    );
    const stateBefore = await repoState(both);
    // "ours" for BOTH. Only site/x.txt lacks an "ours"; x.txt has one.
    const collide = await caught(() =>
      resolveMerge(git, { projectPath: project, branch: 'feature', choices: { 'x.txt': 'ours', 'site/x.txt': 'ours' }, expect: twoClash.at })
    );
    await refusedCleanly(
      'T20b answering "ours" where only one of two same-named files lacks it',
      collide.value,
      both,
      stateBefore,
      'bad_choices',
      (r) => Array.isArray(r?.badChoices) && r.badChoices.length === 1
    );
    check(
      'T20b: the refusal names site/x.txt — the file that really has no "ours"',
      collide.value?.badChoices?.[0]?.path === 'site/x.txt' && collide.value?.badChoices?.[0]?.reason === 'no_such_side',
      JSON.stringify(collide.value?.badChoices)
    );
    check(
      'T20b: and not x.txt, which has both sides',
      !(collide.value?.badChoices || []).some((b) => b.path === 'x.txt'),
      JSON.stringify(collide.value?.badChoices)
    );
    // THE OTHER DIRECTION. The answers each file really can take go through —
    // so the refusal above is about the sides, not about the layout, and the
    // validator is not simply refusing everything in a nested repository.
    const okBoth = await caught(() =>
      resolveMerge(git, { projectPath: project, branch: 'feature', choices: { 'x.txt': 'ours', 'site/x.txt': 'theirs' }, expect: twoClash.at })
    );
    check('T20b control: the sides that do exist merge', okBoth.value?.ok === true && okBoth.value?.resolved === 2, JSON.stringify(okBoth));
    check('T20b control: keeping this branch’s root file', textOf(path.join(both, 'x.txt')) === 'main root\n', JSON.stringify(textOf(path.join(both, 'x.txt'))));
    check('T20b control: and the incoming nested one', textOf(path.join(both, 'site', 'x.txt')) === 'feature site\n', JSON.stringify(textOf(path.join(both, 'site', 'x.txt'))));

    // T20c — AND THE PATH SPACE IS ASKED FOR, NOT ASSUMED.
    //
    // `git diff --name-only` prints repo-root-relative names until somebody
    // sets `diff.relative`, which is an ordinary user config. Measured with
    // `diff.relative=true` and cwd = <root>/site: the same command printed
    // "a.txt" for site/a.txt, so conflictDigest would have opened <root>/a.txt
    // (absent — the unreadable sentinel), and a resolve keyed the way git.merge
    // reported it would have been refused as unknown_path. Nothing downstream
    // would have noticed.
    const rel = await nestedDelete('nested-diffrelative');
    await sh(rel.root, 'config', 'diff.relative', 'true');
    const relClash = await mergeBranch(git, { projectPath: rel.project, branch: 'feature' });
    check(
      'T20c: diff.relative=true does not move git.merge’s paths out of the repo-root space',
      relClash.files?.[0]?.path === 'site/a.txt',
      JSON.stringify(relClash.files?.map((f) => f.path))
    );
    check(
      'T20c: and the digest still measured a file it could open',
      typeof relClash.at?.digest === 'string' && relClash.at.digest !== conflictDigest(rel.root, []),
      JSON.stringify(relClash.at)
    );
    const relDone = await caught(() =>
      resolveMerge(git, { projectPath: rel.project, branch: 'feature', choices: { 'site/a.txt': 'theirs' }, expect: relClash.at })
    );
    check('T20c: and the resolve still applies', relDone.value?.ok === true, JSON.stringify(relDone));
    check('T20c: to the right file', textOf(path.join(rel.root, 'site', 'a.txt')) === 'feature edit\n', JSON.stringify(textOf(path.join(rel.root, 'site', 'a.txt'))));
  }

  {
    // T21 — A MERGE THAT COULD NOT RUN IS NOT A CONFLICT THAT WENT AWAY.
    //
    // When the re-merge cannot START — another git process holding
    // .git/index.lock, which is what a user with a terminal open produces
    // several times an hour — resolveMerge answered `stale_merge` saying "both
    // branches are where they were, but git produced no conflict to answer this
    // time", and attached `current.digest`. MEASURED, that digest came back
    // "47DEQpj8HBSa-_TImW-5JC", which is base64url(sha256("")) — the digest of
    // the EMPTY file list, a constant, published in the field that exists to say
    // what was measured. And the remedy it gave was the one thing that cannot
    // work: run git.merge again and answer the new conflict, when the next merge
    // will hit the same lock. An agent following it loops.
    const dir = await repo('lockedresolve');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'THEIRS\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'OURS\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main');
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T21: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));

    // Somebody else is holding the repository. Not simulated through this
    // module — the lock is the real file git itself refuses on.
    const lock = path.join(dir, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const before = await repoState(dir);
    const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: clash.at }));
    check('T21: a resolve that could not start does not throw', answer.error === null, String(answer.error));
    await refusedCleanly(
      'T21 a re-merge another process would not let start',
      answer.value,
      dir,
      before,
      'merge_blocked',
      (r) => typeof r?.gitSaid === 'string' && r.gitSaid.length > 0
    );
    // THE THREE THINGS THE OLD ANSWER GOT WRONG, each its own assertion.
    check('T21: it is not called stale_merge', answer.value?.code !== 'stale_merge', JSON.stringify({ code: answer.value?.code }));
    const EMPTY_DIGEST = conflictDigest(dir, []);
    check('T21: the digest of nothing is what the old answer published', EMPTY_DIGEST === '47DEQpj8HBSa-_TImW-5JC', EMPTY_DIGEST);
    check(
      'T21: and nothing in this answer publishes it',
      !JSON.stringify(answer.value).includes(EMPTY_DIGEST),
      JSON.stringify(answer.value).slice(0, 400)
    );
    check(
      'T21: it does not claim git produced no conflict',
      !/produced no conflict/i.test(String(answer.value?.message || '')),
      String(answer.value?.message)
    );
    // AND THE REMEDY IT GIVES. "Run git.merge again" is the loop; "send this
    // call again" is the answer.
    check(
      'T21: it does not send the caller back to git.merge',
      !/run git\.merge/i.test(String(answer.value?.message || '')),
      String(answer.value?.message)
    );
    check(
      'T21: it says to retry this same call',
      /again with the same mergeRef/i.test(String(answer.value?.message || '')),
      String(answer.value?.message)
    );
    check('T21: carrying git’s own sentence', /unable to|lock|index/i.test(String(answer.value?.gitSaid || '')), String(answer.value?.gitSaid));
    // AND NOT THE COMMAND LINE ECHOED BACK, which is the failure the
    // working-tree refusal above already exists not to be. execFile's own
    // `message` starts "Command failed: git -c merge.conflictStyle=diff3 …".
    check(
      'T21: and not the command nobody ran',
      !/Command failed:/i.test(String(answer.value?.gitSaid || '')) && !/Command failed:/i.test(String(answer.value?.message || '')),
      JSON.stringify({ gitSaid: answer.value?.gitSaid, message: answer.value?.message })
    );

    // THE CONTROL, which is what makes the refusal about the lock and not about
    // the fixture: let go, and the very same call goes through.
    fs.unlinkSync(lock);
    const retry = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: clash.at }));
    check('T21 control: the same call with the same mergeRef then merges', retry.value?.ok === true, JSON.stringify(retry));
    check('T21 control: applying the answer that was given', textOf(path.join(dir, 'a.txt')) === 'THEIRS\n', JSON.stringify(textOf(path.join(dir, 'a.txt'))));
  }

  {
    // T22 — THE GIT DOMAIN'S PATH SPACE, DECLARED RATHER THAN GUESSED AT.
    //
    // `files[].path`, the `choices` keys resolve_merge requires and
    // `badChoices[].expected` are all REPO-ROOT-relative, while every other
    // path an agent handles — source.read, source.write, asset and page paths —
    // is PROJECT-relative. Nothing said so. An agent that read a conflicted
    // path and handed it to source.read got a refusal, or, in a repository
    // holding both <root>/x and <root>/site/x, the WRONG FILE.
    //
    // Translating to project-relative was not available: a conflict can land
    // anywhere in the repository and a file ABOVE the project has no
    // project-relative spelling this surface accepts. So both spellings travel,
    // and the envelope names which is which. This drives the mapper directly —
    // it is a pure function of the handler's answer — because the layout it is
    // about needs a repository and the wire suites do not build one.
    const { DOMAINS: MAPPERS } = require('../electron/mcp/agent/domains.js');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-git-pathspace-'));
    cleanup.push(root);
    await sh(root, 'init', '-q', '-b', 'main', '.');
    await sh(root, 'config', 'user.email', 'test@example.com');
    await sh(root, 'config', 'user.name', 'Test');
    // Signing off for the same reason repo() does it: a developer with
    // `commit.gpgsign = true` set globally, and no key that signs headlessly,
    // cannot commit here at all. This used to be on ONE of the seven builders
    // in this file while the comment above repo() said it was on every fixture:
    // the suite died with an UNCAUGHT throw at the first of the other six,
    // before a single assertion printed.
    await sh(root, 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'base\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    await sh(root, 'add', '-A');
    await sh(root, 'commit', '-qm', 'first');
    await sh(root, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'THEIRS\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'THEIRS\n');
    await sh(root, 'add', '-A');
    await sh(root, 'commit', '-qm', 'feature');
    await sh(root, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'OURS\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'OURS\n');
    await sh(root, 'add', '-A');
    await sh(root, 'commit', '-qm', 'main');
    const project = path.join(root, 'site');

    const raw = await mergeBranch(git, { projectPath: project, branch: 'feature' });
    check('T22: the handler reports both conflicts', (raw.files || []).length === 2, JSON.stringify(raw.files?.map((f) => f.path)));
    // The root the paths are relative to has to travel, or the mapper has
    // nothing to translate with.
    check(
      'T22: and says which root its paths are relative to',
      typeof raw.root === 'string' && fs.realpathSync(raw.root) === fs.realpathSync(root),
      JSON.stringify({ root: raw.root })
    );

    const env = await MAPPERS.git.merge.result(raw, { branch: 'feature' }, { root: project, mergeRef: () => 'ref' });
    const byGitPath = Object.fromEntries((env.files || []).map((f) => [f.path, f]));
    check('T22: the envelope declares the space its paths are in', env.pathsRelativeTo === 'repository-root', JSON.stringify(env.pathsRelativeTo));
    check(
      'T22: `path` is still git’s own spelling — the key choices must use',
      Object.keys(byGitPath).sort().join(',') === 'README.md,site/a.txt',
      JSON.stringify(Object.keys(byGitPath))
    );
    // THE HALF THAT WAS MISSING. A path an agent can hand to source.read.
    check(
      'T22: and `sourcePath` is the same file spelled the way the rest of the surface spells it',
      byGitPath['site/a.txt']?.sourcePath === 'a.txt',
      JSON.stringify(byGitPath['site/a.txt'])
    );
    // AND IT RESOLVES TO THE FILE THAT ACTUALLY CLASHED, checked against the
    // project-relative resolver the rest of the surface uses rather than by
    // joining strings here. A `sourcePath` that resolved anywhere else would be
    // the wrong-file failure with a friendlier spelling.
    const resolved = resolveInProject(project, byGitPath['site/a.txt'].sourcePath, { what: 'path' });
    check('T22: which the project resolver accepts', resolved.ok === true, JSON.stringify(resolved));
    check(
      'T22: and which is the conflicting file itself',
      resolved.ok && fs.realpathSync(resolved.abs) === fs.realpathSync(path.join(root, 'site', 'a.txt')),
      JSON.stringify({ abs: resolved.abs })
    );
    // AND THE CASE NO TRANSLATION CAN SERVE, said as null rather than as
    // "../README.md" — which resolveInProject refuses, correctly.
    check(
      'T22: a conflict above the project has no project-relative spelling, and says so',
      byGitPath['README.md']?.sourcePath === null,
      JSON.stringify(byGitPath['README.md'])
    );
    check(
      'T22: while still carrying git’s spelling, so it can be answered',
      byGitPath['README.md']?.path === 'README.md',
      JSON.stringify(byGitPath['README.md'])
    );
    // AND THE REFUSAL THAT IS MOST OFTEN ABOUT THE SPACE SAYS SO TOO. An agent
    // that re-spelled the path the way source.read wants it lands on
    // unknown_path, and the old sentence sent it to re-check the letters.
    const wrong = await resolveMerge(git, { projectPath: project, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: raw.at });
    const wrongEnv = await MAPPERS.git.resolve_merge.result(wrong, { branch: 'feature' }, { root: project });
    check('T22: a project-relative key is refused', wrongEnv?.code === 'bad_choices', JSON.stringify({ code: wrongEnv?.code }));
    check('T22: as unknown_path', wrongEnv?.badChoices?.[0]?.reason === 'unknown_path', JSON.stringify(wrongEnv?.badChoices?.[0]));
    // TWO SENTENCES, TWO ASSERTIONS. The general tail of every bad_choices
    // message names the space; the `unknown_path` clause is the one an agent
    // that mis-spelled the space actually lands on, and it has to point at the
    // list of spellings that WOULD have worked. Asserting only the general one
    // would leave the clause free to go back to "could not be understood".
    check(
      'T22: the general sentence names which root the keys are relative to',
      /relative to the\s+REPOSITORY\s+root, not to the project/i.test(String(wrongEnv?.message || '')),
      String(wrongEnv?.message)
    );
    check(
      'T22: and the unknown_path clause points at the spellings that would have worked',
      /`expected` below lists them exactly as they must be sent/.test(String(wrongEnv?.message || '')),
      String(wrongEnv?.message)
    );
    check(
      'T22: which are git’s spellings, not the one that was sent',
      JSON.stringify(wrongEnv?.badChoices?.[0]?.expected?.slice().sort()) === JSON.stringify(['README.md', 'site/a.txt']),
      JSON.stringify(wrongEnv?.badChoices?.[0]?.expected)
    );
    check('T22: the refusal declares the space too', wrongEnv?.pathsRelativeTo === 'repository-root', JSON.stringify(wrongEnv?.pathsRelativeTo));
    // A PROJECT THAT IS ITS REPOSITORY MUST NOT CHANGE. The two spellings are
    // the same string there, and that is the layout almost everybody is in.
    const flatRaw = await mergeBranch(git, { projectPath: root, branch: 'feature' });
    check('T22 control: the flat layout still conflicts', flatRaw.ok === false && flatRaw.conflicted === true, JSON.stringify(flatRaw).slice(0, 160));
    const flatEnv = await MAPPERS.git.merge.result(flatRaw, { branch: 'feature' }, { root, mergeRef: () => 'ref' });
    check(
      'T22 control: where the project IS the repository the two spellings agree',
      (flatEnv.files || []).every((f) => f.sourcePath === f.path),
      JSON.stringify(flatEnv.files?.map((f) => ({ path: f.path, sourcePath: f.sourcePath })))
    );
    // AND THE SCHEMA, which said the opposite in so many words: "keyed by its
    // project-relative path".
    const TOOLS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mcp', 'agentTools.js'), 'utf8');
    const choicesDoc = TOOLS_SOURCE.slice(TOOLS_SOURCE.indexOf('    choices: z'), TOOLS_SOURCE.indexOf('    choices: z') + 1400);
    check('T22: the published schema no longer calls the choices keys project-relative', !/keyed by its project-relative path/.test(choicesDoc), choicesDoc.slice(0, 200));
    check('T22: it says which root they ARE relative to', /RELATIVE TO THE REPOSITORY ROOT/.test(choicesDoc), choicesDoc.slice(0, 400));
  }

  {
    // T23 — A REFUSAL THAT COULD NOT PUT THE TREE BACK STILL SAID IT HAD.
    //
    // Every refusal past the trial merge is a claim about the working tree as
    // well as about the answers: "Nothing was merged and <branch> is exactly as
    // it was". What makes that true is `merge --abort`, and it was fired into a
    // `catch {}` — so when the abort itself failed the claim went out anyway,
    // over a tree holding conflict markers and an index holding three stages.
    //
    // MEASURED before the fix, exactly as below: `bad_choices`, "Nothing was
    // merged", with `git status` saying `UU a.txt` and the file on disk holding
    // `<<<<<<< HEAD`. Stacki parses that file as markup a moment later.
    //
    // THE ABORT FAILS FOR REAL. Nothing here fakes an error: the wrapper
    // removes `.git/MERGE_HEAD` — which is what a second git process, a crash,
    // or the user's own `git merge --abort` in a terminal does — and then runs
    // the real command, which exits non-zero on its own. Every other call goes
    // straight to the real runner.
    const dir = await repo('abortrefused');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'FEATURE\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'MAIN\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main');
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T23: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));

    // THE CONTROL FIRST, so the refusal below is about the abort and not about
    // the choice: with a git whose abort works, the same call is the ordinary
    // clean refusal this suite already holds every other one to.
    const cleanBefore = await repoState(dir);
    const ordinary = await caught(() =>
      resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'sideways' }, expect: clash.at })
    );
    check('T23 control: the same bad choice does not throw', ordinary.error === null, String(ordinary.error));
    await refusedCleanly(
      'T23 control: a bad choice with a working abort',
      ordinary.value,
      dir,
      cleanBefore,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.reason === 'bad_value'
    );

    let aborts = 0;
    const abortRefusingGit = async (cwd, args) => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        aborts += 1;
        fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'), { force: true });
      }
      return git(cwd, args);
    };
    const before = await repoState(dir);
    const answer = await caught(() =>
      resolveMerge(abortRefusingGit, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'sideways' }, expect: clash.at })
    );
    check('T23: a resolve whose unwind fails does not throw', answer.error === null, String(answer.error));
    check('T23: and the unwind really was attempted', aborts === 1, String(aborts));
    // THE PREMISE, MEASURED. Without this the assertions below could pass over
    // a tree that unwound perfectly well.
    const after = await repoState(dir);
    check('T23: the trial merge really is still in the tree', after.status !== '', JSON.stringify(after.status));
    check('T23:   with the conflicted file still holding markers', /^<<<<<<< /m.test(String(textOf(path.join(dir, 'a.txt')))), JSON.stringify(textOf(path.join(dir, 'a.txt'))));
    check('T23:   and the index still holding its stages', (await sh(dir, 'ls-files', '-u')).length > 0);
    // WHAT IT MUST NOT SAY.
    check('T23: it is not answered as bad_choices', answer.value?.code !== 'bad_choices', JSON.stringify({ code: answer.value?.code }));
    check('T23: it does not claim nothing was merged', !/nothing was merged/i.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T23: it does not claim the branch is as it was', !/exactly as it was/i.test(String(answer.value?.message || '')), String(answer.value?.message));
    // WHAT IT DOES SAY.
    check('T23: it is refused', answer.value?.ok === false, JSON.stringify(answer.value));
    check('T23: as merge_stuck', answer.value?.code === 'merge_stuck', JSON.stringify({ code: answer.value?.code }));
    check('T23: naming the file that is still conflicted', JSON.stringify(answer.value?.files) === JSON.stringify(['a.txt']), JSON.stringify(answer.value?.files));
    check('T23: carrying git’s own sentence about the abort', /no merge to abort|MERGE_HEAD/i.test(String(answer.value?.gitSaid || '')), String(answer.value?.gitSaid));
    check(
      'T23: and not the command nobody ran',
      !/Command failed:/i.test(String(answer.value?.gitSaid || '')) && !/Command failed:/i.test(String(answer.value?.message || '')),
      JSON.stringify({ gitSaid: answer.value?.gitSaid, message: answer.value?.message })
    );
    check('T23: telling the reader how to clear it', /merge --abort/.test(String(answer.value?.message || '')), String(answer.value?.message));
    // NOTHING WAS COMMITTED EITHER — the refusal is about a tree that will not
    // unwind, not about a merge that got through.
    check('T23: HEAD did not move', after.head === before.head, `${before.head} -> ${after.head}`);
    // And the fixture is put back by hand, since the code could not.
    await sh(dir, 'reset', '-q', '--hard', 'HEAD');
  }

  {
    // T24 — A CONFLICT THAT RUNS TO THE END OF THE FILE AND ENDS ON TEXT BOTH
    // BRANCHES WROTE.
    //
    // T17's property — the same decision in two shapes commits the same bytes —
    // held only while the last thing in the file was the disagreement itself.
    // `parseConflict` splits git's block into the runs the two sides really
    // disagree on, so when both sides END THE SAME WAY the parse is
    // [clash, same, same''] and `conflictAtEnd` no longer recognised it. The
    // terminator correction never ran and the per-hunk answer committed git's
    // own newline over a side that had none.
    //
    // The fixture is what makes git mark up the tail: the incoming file has NO
    // final newline, so its last line differs from ours by exactly that byte and
    // git cannot leave it outside the conflict.
    const dir = await repo('sharedtail');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nBASE\ntail\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'a tail both branches keep');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nTHEIRS\ntail'); // no terminator
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nOURS\ntail\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T24: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    check(
      'T24: over one file with one disagreement',
      clash.files?.length === 1 && (clash.files[0].parts || []).filter((p) => p.kind === 'clash').length === 1,
      JSON.stringify(clash.files?.[0]).slice(0, 300)
    );
    // What the incoming branch actually holds, read from git rather than from
    // the fixture literal above — this is the oracle everything below is against.
    const theirsBlob = (await git(dir, ['show', 'feature:a.txt'])).stdout;
    check('T24: the incoming version has no final newline', theirsBlob === 'head\nTHEIRS\ntail', JSON.stringify(theirsBlob));

    const perHunk = await caught(() =>
      resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at })
    );
    check('T24: a per-hunk answer does not throw', perHunk.error === null, String(perHunk.error));
    check('T24: and is applied', perHunk.value?.ok === true && perHunk.value?.resolved === 1, JSON.stringify(perHunk));
    check(
      'T24: THE COMMITTED FILE IS THE INCOMING VERSION, BYTE FOR BYTE',
      textOf(path.join(dir, 'a.txt')) === theirsBlob,
      JSON.stringify({ got: textOf(path.join(dir, 'a.txt')), want: theirsBlob })
    );
    check(
      'T24: with no newline neither branch wrote',
      !String(textOf(path.join(dir, 'a.txt'))).endsWith('tail\n'),
      JSON.stringify(textOf(path.join(dir, 'a.txt')))
    );

    // AND THE OTHER SHAPE OF THE SAME DECISION, which is the property T17
    // states: whole-file `theirs` is `git checkout --theirs`, the blob itself.
    const twin = await repo('sharedtail-whole');
    cleanup.push(twin);
    fs.writeFileSync(path.join(twin, 'a.txt'), 'head\nBASE\ntail\n');
    await sh(twin, 'add', '-A');
    await sh(twin, 'commit', '-qm', 'a tail both branches keep');
    await sh(twin, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(twin, 'a.txt'), 'head\nTHEIRS\ntail');
    await sh(twin, 'add', '-A');
    await sh(twin, 'commit', '-qm', 'feature');
    await sh(twin, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(twin, 'a.txt'), 'head\nOURS\ntail\n');
    await sh(twin, 'add', '-A');
    await sh(twin, 'commit', '-qm', 'main');
    const twinClash = await mergeBranch(git, { projectPath: twin, branch: 'feature' });
    const whole = await caught(() =>
      resolveMerge(git, { projectPath: twin, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: twinClash.at })
    );
    check('T24: the whole-file answer is applied too', whole.value?.ok === true, JSON.stringify(whole));
    check(
      'T24: and the two shapes of one decision commit the same bytes',
      textOf(path.join(twin, 'a.txt')) === textOf(path.join(dir, 'a.txt')),
      JSON.stringify({ whole: textOf(path.join(twin, 'a.txt')), perHunk: textOf(path.join(dir, 'a.txt')) })
    );
  }

  {
    // T25 — THE BINDING PINNED TWO COMMITS AND NOT THE BRANCH BEING MERGED INTO.
    //
    // `into` is read fresh from `git rev-parse --abbrev-ref HEAD` at the top of
    // resolveMerge, and the staleness checks compared `tipOf('HEAD')` against
    // the handle. Two branches at one commit are completely ordinary — a branch
    // cut and not yet committed on is exactly that — so a checkout to a sibling
    // between the conflict and the resolve moved no commit, changed no file,
    // and passed every check there was.
    //
    // MEASURED before the fix, with real git and real commits: the conflict
    // taken on `main`, `git checkout release` where release had just been cut
    // from main, and the resolve answered `{ok: true, into: "release",
    // changed: true, resolved: 1}` over a two-parent merge commit on a branch
    // the caller had never named. This is the PANEL's route — GitChip sends
    // `expect: conflict.at` straight over IPC — and the panel then toasted
    // "Merged feature into release" about a merge nobody had asked for.
    //
    // THE ORACLE IS THE COMMIT GRAPH, not the working tree. A sibling at the
    // same tip has the same files, so `bytesOf` cannot see this one: what says
    // it happened is a second parent on a branch that was never named.
    const dir = await twoClashRepo('siblingtip');
    cleanup.push(dir);
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T25: the caller is shown a conflict', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    check('T25: and the handle says which branch it was merging into', clash.at?.into === 'main', JSON.stringify(clash.at));

    await sh(dir, 'branch', 'release');
    await sh(dir, 'checkout', '-q', 'release');
    check(
      'T25: the sibling is at the very same commit, which is why the SHA check cannot see it',
      (await sh(dir, 'rev-parse', 'release')) === (await sh(dir, 'rev-parse', 'main')),
      `${await sh(dir, 'rev-parse', 'release')} vs ${await sh(dir, 'rev-parse', 'main')}`
    );
    const before = await repoState(dir);
    const elsewhere = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours' },
      expect: clash.at,
    });
    await refusedCleanly(
      'T25 answers for one branch applied while the project is on a sibling at the same commit',
      elsewhere,
      dir,
      before,
      'stale_merge',
      (r) => r.expected?.into === 'main' && r.current?.into === 'release' && /"main"/.test(String(r.message)) && /"release"/.test(String(r.message))
    );
    check(
      'T25: AND NO MERGE COMMIT LANDED ON THE BRANCH NOBODY NAMED',
      (await sh(dir, 'log', '-1', '--format=%P', 'release')).split(' ').length === 1,
      await sh(dir, 'log', '-1', '--format=%P', 'release')
    );
    check(
      'T25:   nor on the one the answers were about',
      (await sh(dir, 'log', '-1', '--format=%P', 'main')).split(' ').length === 1,
      await sh(dir, 'log', '-1', '--format=%P', 'main')
    );

    // A DETACHED HEAD AT THAT COMMIT IS THE SAME CASE, and a worse landing
    // place: a merge committed there has no branch pointing at it afterwards.
    // `rev-parse --abbrev-ref` answers "HEAD" when detached, which is not the
    // branch name the handle carries, so the same guard catches it.
    await sh(dir, 'checkout', '-q', '--detach', 'release');
    const beforeDetached = await repoState(dir);
    const detached = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours' },
      expect: clash.at,
    });
    await refusedCleanly(
      'T25 the same answers applied on a detached HEAD at that commit',
      detached,
      dir,
      beforeDetached,
      'stale_merge',
      (r) => r.expected?.into === 'main' && r.current?.into !== 'main'
    );

    // THE CONTROL. Every check above is refusal-shaped, and a guard that
    // refused every resolve would satisfy all of them. Back on the branch the
    // conflict was about, the SAME handle and the SAME answers still merge.
    await sh(dir, 'checkout', '-q', 'main');
    const settled = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours' },
      expect: clash.at,
    });
    check('T25 control: the same resolve on the branch it was for still merges', settled?.ok === true, JSON.stringify(settled).slice(0, 240));
    check('T25 control:   into the branch the caller was told about', settled?.into === 'main', JSON.stringify({ into: settled?.into }));
    check('T25 control:   as a two-parent merge commit on main', (await sh(dir, 'log', '-1', '--format=%P', 'main')).split(' ').length === 2, await sh(dir, 'log', '-1', '--format=%P', 'main'));
    check('T25 control:   and the sibling was left alone', (await sh(dir, 'log', '-1', '--format=%P', 'release')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P', 'release'));
    check('T25 control:   on a clean tree', (await sh(dir, 'status', '--porcelain')) === '', await sh(dir, 'status', '--porcelain'));

    // AND THE OTHER CONTROL, which is the one a guard like this gets wrong.
    // Refusing a detached HEAD is right only when the binding was made
    // somewhere else. A conflict taken WHILE detached and resolved from the
    // same detached HEAD is one place, not two, and it has to still merge —
    // `rev-parse --abbrev-ref` answers "HEAD" both times, so the comparison
    // agrees with itself. Without this, a guard that simply refused every
    // detached resolve would pass everything above.
    const solo = await twoClashRepo('detachedboth');
    cleanup.push(solo);
    await sh(solo, 'checkout', '-q', '--detach', 'main');
    const detachedClash = await mergeBranch(git, { projectPath: solo, branch: 'feature' });
    check('T25 control: a conflict taken on a detached HEAD is reported', detachedClash.ok === false && detachedClash.conflicted === true, JSON.stringify(detachedClash).slice(0, 160));
    check('T25 control:   with the handle naming where it was', detachedClash.at?.into === 'HEAD', JSON.stringify(detachedClash.at));
    const settledSolo = await resolveMerge(git, {
      projectPath: solo,
      branch: 'feature',
      choices: { 'a.txt': 'theirs' },
      expect: detachedClash.at,
    });
    check('T25 control: and answering it from that same detached HEAD still merges', settledSolo?.ok === true, JSON.stringify(settledSolo).slice(0, 240));
    check('T25 control:   as a two-parent commit', (await sh(solo, 'log', '-1', '--format=%P')).split(' ').length === 2, await sh(solo, 'log', '-1', '--format=%P'));
    check('T25 control:   taking the side that was asked for', /TOP-feat/.test(String(textOf(path.join(solo, 'a.txt')))), JSON.stringify(textOf(path.join(solo, 'a.txt'))));
  }

  {
    // T26 — THE UNWIND NEVER LOOKED WHERE THE DAMAGE IS.
    //
    // T23 gave the failed unwind a name, and measured it in the one shape
    // where the INDEX still shows the trouble: MERGE_HEAD gone, unmerged
    // entries left. Its own docstring names the other half of that scenario —
    // "a second git process, a crash, or an editor plugin's own merge --abort"
    // — and nothing ever measured it. A plain `git reset` (mixed) is exactly
    // that shape: MERGE_HEAD and the index stages both go, and the WORKING
    // TREE keeps every byte the trial merge wrote.
    //
    // Every index-side signal then says "it unwound". `unmergedPaths` answers
    // [], `rev-parse -q --verify MERGE_HEAD` exits 1 with EMPTY stderr because
    // of the -q, so `midMerge` returned null and `abort` answered "nothing to
    // abort, and nothing left behind". MEASURED 3/3 before the fix, with no
    // stubs anywhere:
    //
    //   bad_choices     "Nothing was merged: 1 of the choices could not be
    //                   used…" over an a.txt holding `<<<<<<< HEAD … |||||||
    //                   … ======= … >>>>>>> feature`
    //   digest mismatch `stale_merge`, "…Nothing was merged and "main" is
    //                   exactly as it was."
    //   clean re-merge  the same sentence, over an a.txt holding
    //                   "OURS\nkeep\nTHEIRS\nkeep\n" — bytes NEITHER BRANCH HAS
    //
    // HEAD really was unmoved every time, so the half of the claim that was
    // being checked was true and the half about the tree was not. Stacki
    // parses that file as markup a moment later.
    //
    // NOTHING BELOW IS FAKED. One ordinary `git reset` runs at the moment
    // resolveMerge fires `merge --abort`; the real abort then runs and fails
    // on its own, and every other call goes straight to the real runner.
    const seed = async (name, extra) => {
      const dir = await repo(name);
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, 'other.txt'), 'shared\n');
      if (extra) fs.writeFileSync(path.join(dir, extra), 'base\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'a file neither branch touches');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'THEIRS\nkeep\n');
      if (extra) fs.writeFileSync(path.join(dir, extra), 'THEIRS\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'feature');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'OURS\nkeep\n');
      if (extra) fs.writeFileSync(path.join(dir, extra), 'OURS\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'main');
      return dir;
    };
    /** A runner that loses the merge out from under the abort, the way a second git process does. */
    const resetting = (dir) => {
      let resets = 0;
      const runner = async (cwd, args) => {
        if (args[0] === 'merge' && args[1] === '--abort') {
          resets += 1;
          await git(dir, ['reset', '-q']);
        }
        return git(cwd, args);
      };
      runner.resets = () => resets;
      return runner;
    };
    /**
     * What a refusal over a tree that did not come back has to say.
     *
     * `onDisk` is the oracle for the bytes actually left there, so each case
     * proves its own damage rather than sharing one.
     */
    const leftBehind = async (what, dir, answer, head, files, onDisk) => {
      check(`${what}: does not throw`, answer.error === null, String(answer.error));
      const r = answer.value;
      // THE PREMISE, MEASURED. Without these three the assertions below could
      // pass over a tree that unwound perfectly well.
      check(`${what}: the trial merge really is still in the tree`, (await sh(dir, 'status', '--porcelain')) !== '', await sh(dir, 'status', '--porcelain'));
      check(`${what}:   holding what it wrote`, onDisk(String(textOf(path.join(dir, 'a.txt')))), JSON.stringify(textOf(path.join(dir, 'a.txt'))));
      check(
        `${what}:   and NOTHING on the index side left to notice it`,
        (await sh(dir, 'ls-files', '-u')) === '' && !fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
        `${await sh(dir, 'ls-files', '-u')} | MERGE_HEAD ${fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))}`
      );
      check(`${what}: HEAD did not move`, (await sh(dir, 'rev-parse', 'HEAD')) === head, `${head} -> ${await sh(dir, 'rev-parse', 'HEAD')}`);
      // WHAT IT MUST NOT SAY over that tree.
      check(`${what}: it does not claim nothing was merged`, !/nothing was merged/i.test(String(r?.message || '')), String(r?.message));
      check(`${what}: nor that the branch is exactly as it was`, !/exactly as it was/i.test(String(r?.message || '')), String(r?.message));
      // WHAT IT DOES SAY.
      check(`${what}: it is refused as merge_stuck`, r?.ok === false && r?.code === 'merge_stuck', JSON.stringify({ ok: r?.ok, code: r?.code }));
      check(`${what}:   saying no merge is in progress`, r?.mergeInProgress === false, JSON.stringify({ mergeInProgress: r?.mergeInProgress }));
      check(`${what}:   naming every path left different`, JSON.stringify(r?.files) === JSON.stringify(files), JSON.stringify(r?.files));
      // AND THE REMEDY IS THE ONE THAT WORKS. `git merge --abort` is what the
      // other shape of this refusal says to run, and here it answers "there is
      // no merge to abort" and leaves the person no further forward.
      check(`${what}:   that merge --abort will not clear it`, /`git merge --abort` will not clear this/.test(String(r?.message || '')), String(r?.message));
      check(`${what}:   and something that will`, /git checkout HEAD --/.test(String(r?.message || '')), String(r?.message));
    };

    // (1) THE REFUSAL ABOUT THE CHOICES.
    {
      const dir = await seed('treebad');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      check('T26: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 160));
      const head = await sh(dir, 'rev-parse', 'HEAD');
      const runner = resetting(dir);
      const answer = await caught(() =>
        resolveMerge(runner, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'sideways' }, expect: clash.at })
      );
      check('T26: the unwind was attempted exactly once', runner.resets() === 1, String(runner.resets()));
      await leftBehind('T26 a bad choice over a tree that did not come back', dir, answer, head, ['a.txt'], (text) => /^<<<<<<< /m.test(text));
      // AND IT REACHES A CLIENT AS THIS REFUSAL, not as the choices one. The
      // resolve mapper rewrites anything carrying `badChoices`, and this must
      // not be carrying any.
      const mapped = await DOMAINS.git.resolve_merge.result(answer.value, { branch: 'feature' }, { root: dir });
      check('T26:   and the MCP mapper passes it through as merge_stuck', mapped?.code === 'merge_stuck', JSON.stringify({ code: mapped?.code }));
      check('T26:   with the paths and the shape intact', JSON.stringify(mapped?.files) === '["a.txt"]' && mapped?.mergeInProgress === false, JSON.stringify({ files: mapped?.files, mergeInProgress: mapped?.mergeInProgress }));
    }

    // (2) THE REFUSAL ABOUT THE CONFLICT HAVING MOVED. `b.txt` clashed when the
    // caller was shown it and is union-merged now, so the digest is a
    // different one and the answer is `stale_merge` — over a tree holding the
    // markers of the clash that IS still there.
    {
      const dir = await seed('treedigest', 'b.txt');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      check('T26: the two-file fixture conflicts in both', clash.files?.length === 2, JSON.stringify(clash.files?.map((f) => f.path)));
      const head = await sh(dir, 'rev-parse', 'HEAD');
      fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'b.txt merge=union\n');
      const answer = await caught(() =>
        resolveMerge(resetting(dir), { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours', 'b.txt': 'ours' }, expect: clash.at })
      );
      await leftBehind('T26 a conflict that moved, over a tree that did not come back', dir, answer, head, ['a.txt', 'b.txt'], (text) => /^<<<<<<< /m.test(text));
      check('T26:   and b.txt holds the union nobody asked for', textOf(path.join(dir, 'b.txt')) === 'OURS\nTHEIRS\n', JSON.stringify(textOf(path.join(dir, 'b.txt'))));
    }

    // (3) THE REFUSAL ABOUT THERE BEING NO CONFLICT LEFT. This one is the
    // worst of the three: the re-merge went through CLEANLY, so the file on
    // disk holds neither branch's version — the union driver's own bytes — and
    // the answer said "main" is exactly as it was.
    {
      const dir = await seed('treeclean');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const head = await sh(dir, 'rev-parse', 'HEAD');
      fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.txt merge=union\n');
      const answer = await caught(() =>
        resolveMerge(resetting(dir), { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at })
      );
      await leftBehind(
        'T26 a re-merge that went clean, over a tree that did not come back',
        dir,
        answer,
        head,
        ['a.txt'],
        (text) => text === 'OURS\nkeep\nTHEIRS\nkeep\n'
      );
      check(
        'T26:   and those bytes are on neither branch',
        (await sh(dir, 'show', 'main:a.txt')) !== 'OURS\nkeep\nTHEIRS\nkeep' && (await sh(dir, 'show', 'feature:a.txt')) !== 'OURS\nkeep\nTHEIRS\nkeep',
        `${await sh(dir, 'show', 'main:a.txt')} | ${await sh(dir, 'show', 'feature:a.txt')}`
      );
    }

    // THE CONTROL, AND IT IS THE ONE A CHECK LIKE THIS GETS WRONG. A caller
    // may have unrelated uncommitted work open, and a tree check that reads
    // "dirty" as "damaged" would refuse every resolve on a working project.
    // The same bad choice, with a working abort and a modified file and an
    // untracked file sitting in the tree, is still the ordinary refusal — and
    // both files come out byte for byte.
    {
      const dir = await seed('treecontrol');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      fs.writeFileSync(path.join(dir, 'other.txt'), 'edited and not committed\n');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n');
      const before = await repoState(dir);
      check('T26 control: the tree really is dirty before the call', before.status !== '', JSON.stringify(before.status));
      const bad = await caught(() =>
        resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'sideways' }, expect: clash.at })
      );
      check('T26 control: a bad choice over unrelated dirty work is still bad_choices', bad.value?.code === 'bad_choices', JSON.stringify({ code: bad.value?.code, message: bad.value?.message }).slice(0, 300));
      check('T26 control:   and it still says nothing was merged', /nothing was merged/i.test(String(bad.value?.message || '')), String(bad.value?.message));
      const after = await repoState(dir);
      check('T26 control:   HEAD did not move', after.head === before.head, `${before.head} -> ${after.head}`);
      check('T26 control:   the unrelated edit survived', textOf(path.join(dir, 'other.txt')) === 'edited and not committed\n', JSON.stringify(textOf(path.join(dir, 'other.txt'))));
      check('T26 control:   the untracked file survived', textOf(path.join(dir, 'notes.txt')) === 'untracked\n', JSON.stringify(textOf(path.join(dir, 'notes.txt'))));
      check('T26 control:   and not one byte anywhere else moved', Object.keys({ ...before.bytes, ...after.bytes }).filter((f) => before.bytes[f] !== after.bytes[f]).length === 0, Object.keys(after.bytes).join(', '));
      // AND THE SAME UNRELATED WORK DOES NOT STOP A GOOD ANSWER MERGING. A
      // check that refused everything would pass every assertion above.
      const good = await caught(() =>
        resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at })
      );
      check('T26 control: and the same answers still merge with that work open', good.value?.ok === true && good.value?.resolved === 1, JSON.stringify(good.value).slice(0, 240));
      check('T26 control:   as a two-parent commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2, await sh(dir, 'log', '-1', '--format=%P'));
      check('T26 control:   with the unrelated edit still open', textOf(path.join(dir, 'other.txt')) === 'edited and not committed\n', JSON.stringify(textOf(path.join(dir, 'other.txt'))));
    }
  }

  {
    // T27 — A CONFLICT THE VOCABULARY CANNOT EXPRESS, ANSWERED AS THOUGH THE
    // CALLER HAD PICKED THE WRONG SIDE.
    //
    // Both branches rename the same file to different names. Git's conflict
    // then includes the ORIGINAL name carrying stage 1 and nothing else — the
    // base, with neither branch's own version registered under it — beside the
    // two new names. MEASURED, git 2.50.1: `ls-files -u` gives `orig.txt`
    // stage 1 alone, `sidesOf` answers [], and the default `ours` was refused
    // as `no_such_side` with `sides: []` and `deletedBy: "ours"`, saying
    // `"orig.txt" exists on only one branch here — the other deleted it`. On
    // the MCP surface it read `"orig.txt" was deleted on the current branch`.
    // Three claims and all three false: it is on both branches, under two
    // names, and nobody deleted anything.
    //
    // Refusing is still right — the default is `git checkout --ours` and that
    // dies on `does not have our version` — but there is no other word to send
    // the caller back to try. "ours" and "theirs" both name a version to KEEP
    // and this path has neither.
    const dir = await repo('renamerename');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'orig.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'a file both branches will move');
    await sh(dir, 'checkout', '-qb', 'feature');
    await sh(dir, 'mv', 'orig.txt', 'theirs.txt');
    await sh(dir, 'commit', '-qm', 'renamed on feature');
    await sh(dir, 'checkout', '-q', 'main');
    await sh(dir, 'mv', 'orig.txt', 'ours.txt');
    await sh(dir, 'commit', '-qm', 'renamed on main');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T27: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    check(
      'T27: over the original name as well as the two new ones',
      JSON.stringify((clash.files || []).map((f) => f.path).sort()) === JSON.stringify(['orig.txt', 'ours.txt', 'theirs.txt']),
      JSON.stringify((clash.files || []).map((f) => f.path))
    );
    // THE SHAPE THIS IS ABOUT, read out of git's own report rather than
    // assumed: the original name has neither side, while the two new names
    // have one each. (The index cannot be inspected here — mergeBranch unwinds
    // the merge before it answers — so this is the observation that survives.)
    const sidesReported = (p) => (clash.files || []).find((f) => f.path === p) || {};
    check('T27: git offers neither side under the original name', sidesReported('orig.txt').ours === null && sidesReported('orig.txt').theirs === null, JSON.stringify(sidesReported('orig.txt')));
    check('T27:   while each new name has exactly one', sidesReported('ours.txt').ours !== null && sidesReported('ours.txt').theirs === null && sidesReported('theirs.txt').theirs !== null && sidesReported('theirs.txt').ours === null, JSON.stringify([sidesReported('ours.txt'), sidesReported('theirs.txt')]));

    const before = await repoState(dir);
    const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: {}, expect: clash.at }));
    check('T27: the resolve does not throw', answer.error === null, String(answer.error));
    await refusedCleanly(
      'T27 a rename/rename answered by leaving it out',
      answer.value,
      dir,
      before,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.path === 'orig.txt' && r?.badChoices?.[0]?.reason === 'no_sides'
    );
    const first = answer.value?.badChoices?.[0];
    check('T27:   with no side to offer', JSON.stringify(first?.sides) === '[]' && JSON.stringify(first?.expected) === '[]', JSON.stringify(first));
    // AND NO CULPRIT NAMED, because there is not one. `deletedBy` is what the
    // MCP sentence turns into "deleted on the current branch".
    check('T27:   and nobody named as having deleted it', !('deletedBy' in (first || {})), JSON.stringify(first));
    check('T27: the sentence does not say it was deleted', !/delet/i.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T27: nor that it exists on only one branch', !/only one branch/i.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T27: it says the file has neither side', /has no "ours" and no "theirs"/.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T27:   and that renaming on both branches is what does this', /renaming or moving the same file/.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T27:   and what to do instead', /by hand/.test(String(answer.value?.message || '')), String(answer.value?.message));

    // NAMING THE SIDE EXPLICITLY IS THE SAME ANSWER. There is no word that
    // works, so a caller that spells one out is told the same thing rather
    // than being sent round again.
    const named = await caught(() =>
      resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'orig.txt': 'theirs', 'ours.txt': 'ours', 'theirs.txt': 'theirs' }, expect: clash.at })
    );
    check('T27: naming a side explicitly is refused the same way', named.value?.badChoices?.[0]?.reason === 'no_sides' && named.value?.badChoices?.[0]?.path === 'orig.txt', JSON.stringify(named.value?.badChoices));

    // AND WHAT A CLIENT IS TOLD, which is where the false sentence actually
    // reached an agent.
    const mapped = await DOMAINS.git.resolve_merge.result(answer.value, { branch: 'feature' }, { root: dir });
    check('T27 MCP: still bad_choices', mapped?.code === 'bad_choices', JSON.stringify({ code: mapped?.code }));
    check('T27 MCP: and it no longer says the file was deleted on a branch', !/was deleted on the/i.test(String(mapped?.message || '')), String(mapped?.message));
    check('T27 MCP: it says there is no side to choose', /has no "ours" and no "theirs"/.test(String(mapped?.message || '')), String(mapped?.message));
    check('T27 MCP: and that this merge cannot be finished through resolve_merge', /cannot be finished through resolve_merge/.test(String(mapped?.message || '')), String(mapped?.message));

    // THE CONTROL, on the same repository: a genuine modify/delete still gets
    // the one-sided sentence, so the two shapes are told apart rather than
    // both being answered with the new one.
    const md = await repo('modifydelete');
    cleanup.push(md);
    await sh(md, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(md, 'a.txt'), 'EDITED\n');
    await sh(md, 'add', '-A');
    await sh(md, 'commit', '-qm', 'edited on feature');
    await sh(md, 'checkout', '-q', 'main');
    await sh(md, 'rm', '-q', 'a.txt');
    await sh(md, 'commit', '-qm', 'deleted on main');
    const mdClash = await mergeBranch(git, { projectPath: md, branch: 'feature' });
    check('T27 control: the modify/delete fixture conflicts', mdClash.ok === false && mdClash.conflicted === true, JSON.stringify(mdClash).slice(0, 160));
    const mdAnswer = await caught(() => resolveMerge(git, { projectPath: md, branch: 'feature', choices: {}, expect: mdClash.at }));
    check('T27 control: a file with one side is still no_such_side', mdAnswer.value?.badChoices?.[0]?.reason === 'no_such_side', JSON.stringify(mdAnswer.value?.badChoices));
    check('T27 control:   naming the side it does have', JSON.stringify(mdAnswer.value?.badChoices?.[0]?.sides) === '["theirs"]', JSON.stringify(mdAnswer.value?.badChoices?.[0]));
    check('T27 control:   and still saying the other branch deleted it', /the other deleted it/.test(String(mdAnswer.value?.message || '')), String(mdAnswer.value?.message));
    const mdMapped = await DOMAINS.git.resolve_merge.result(mdAnswer.value, { branch: 'feature' }, { root: md });
    check('T27 control MCP: still says which branch deleted it', /was deleted on the current branch/.test(String(mdMapped?.message || '')), String(mdMapped?.message));
  }

  {
    // T28 — A CRLF CONFLICT PARSED AS ZERO HUNKS, AND THE PANEL COMMITTED THE
    // INCOMING BRANCH AWAY WITHOUT SHOWING ANYBODY A CHOICE.
    //
    // Git writes its conflict markers with the FILE'S own line ending, so in a
    // repository that stores a file CRLF — Windows, core.autocrlf, or a
    // .gitattributes `text eol=crlf`, all completely ordinary — the marker line
    // is `<<<<<<< HEAD\r`. The patterns in electron/conflicts.js could not match
    // that: in JavaScript `.` does not match a carriage return and `$` without
    // the `m` flag matches only at the end of the string. So the whole
    // marked-up file came back as ONE agreed part, clashCount() was 0, and
    // GitChip's choicesForSend() then took `list[0]` of an empty list and sent
    // the whole-file word "ours". resolveMerge validated that as legal
    // vocabulary — it is — ran `git checkout --ours`, and committed a real
    // two-parent merge with `{ok: true, resolved: 1}`. MEASURED: the incoming
    // work was not in the tree afterwards, and the branch was now recorded as
    // merged, so the safe-delete guard stopped protecting it.
    const dir = await repo('crlf');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.astro text eol=crlf\n');
    fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/pages/about.astro'), 'head\nBASE\ntail\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'a page this repository stores with CRLF');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'src/pages/about.astro'), 'head\r\nINCOMING-WORK\r\ntail\r\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'the incoming work');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'src/pages/about.astro'), 'head\r\nOURS\r\ntail\r\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'this branch');

    const PAGE = 'src/pages/about.astro';
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T28: the CRLF page conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    // THE FIXTURE IS REALLY CRLF — asked of git rather than of the bytes this
    // test wrote, because a .gitattributes that was not picked up would make
    // every assertion below pass for the wrong reason.
    check('T28: git stores that page with LF and checks it out with CRLF', (await sh(dir, 'show', 'HEAD:src/pages/about.astro')).indexOf('\r') === -1 && textOf(path.join(dir, PAGE)).includes('\r\n'), JSON.stringify(textOf(path.join(dir, PAGE))));
    const file = (clash.files || []).find((f) => f.path === PAGE) || {};
    const hunks = (file.parts || []).filter((part) => part.kind === 'clash');
    check('T28: THE CONFLICT IS READ AS ONE DISAGREEMENT, NOT AS NONE', hunks.length === 1, JSON.stringify(file.parts));
    check('T28:   with the file’s own line ending carried through both sides', hunks[0]?.ours === 'OURS\r' && hunks[0]?.theirs === 'INCOMING-WORK\r', JSON.stringify(hunks[0]));

    // WHAT THE PANEL SENDS, out of the panel. This is the value that used to
    // discard the branch, and nothing on screen ever showed it.
    const panel = await renderMergeModal(clash);
    check('T28: the modal renders the conflict without error', panel.errors.length === 0, panel.errors[0]);
    check('T28:   and offers a decision for it', panel.labels().some((l) => /1 to decide/.test(l)), JSON.stringify(panel.labels()));
    const asShown = panel.merge();
    check('T28: THE PANEL SENDS AN ANSWER PER HUNK, NOT A WHOLE-FILE WORD', Array.isArray(asShown?.[PAGE]) && asShown[PAGE].length === 1, JSON.stringify(asShown));
    check('T28:   and the hunk offers the incoming branch as a choice', panel.click('feature'), JSON.stringify(panel.labels()));
    const chosen = panel.merge();
    check('T28:   and choosing the incoming branch is what reaches the caller', JSON.stringify(chosen) === JSON.stringify({ [PAGE]: ['theirs'] }), JSON.stringify(chosen));
    panel.close();

    const applied = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: chosen, expect: clash.at });
    check('T28: the merge goes through', applied?.ok === true && applied?.resolved === 1, JSON.stringify(applied));
    check('T28: THE INCOMING WORK IS IN THE TREE AFTERWARDS, BYTE FOR BYTE', textOf(path.join(dir, PAGE)) === 'head\r\nINCOMING-WORK\r\ntail\r\n', JSON.stringify(textOf(path.join(dir, PAGE))));
    check('T28:   as a two-parent merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2, await sh(dir, 'log', '-1', '--format=%P'));

    // THE CONTROL, so the answers are not simply "always theirs": the same
    // fixture answered the other way keeps this branch's CRLF bytes exactly.
    const keep = await repo('crlfkeep');
    cleanup.push(keep);
    fs.writeFileSync(path.join(keep, '.gitattributes'), '*.astro text eol=crlf\n');
    fs.mkdirSync(path.join(keep, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(keep, 'src/pages/about.astro'), 'head\nBASE\ntail\n');
    await sh(keep, 'add', '-A');
    await sh(keep, 'commit', '-qm', 'page');
    await sh(keep, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(keep, 'src/pages/about.astro'), 'head\r\nINCOMING-WORK\r\ntail\r\n');
    await sh(keep, 'add', '-A');
    await sh(keep, 'commit', '-qm', 'incoming');
    await sh(keep, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(keep, 'src/pages/about.astro'), 'head\r\nOURS\r\ntail\r\n');
    await sh(keep, 'add', '-A');
    await sh(keep, 'commit', '-qm', 'ours');
    const keepClash = await mergeBranch(git, { projectPath: keep, branch: 'feature' });
    const kept = await resolveMerge(git, { projectPath: keep, branch: 'feature', choices: { [PAGE]: ['ours'] }, expect: keepClash.at });
    check('T28 control: the other answer also merges', kept?.ok === true, JSON.stringify(kept));
    check('T28 control:   keeping this branch’s CRLF bytes exactly', textOf(path.join(keep, PAGE)) === 'head\r\nOURS\r\ntail\r\n', JSON.stringify(textOf(path.join(keep, PAGE))));

    // AND WHAT AN AGENT IS TOLD, which said the same untruth in its own words:
    // a file git had just reported as conflicting, described as having no
    // conflicting hunks, under an instruction to send exactly as many entries
    // as the hunks listed.
    const { DOMAINS: MAPPERS } = require('../electron/mcp/agent/domains.js');
    const env = await MAPPERS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'ref' });
    const entry = (env?.files || []).find((f) => f.path === PAGE) || {};
    check('T28 MCP: the conflicting file is listed with its one hunk', Array.isArray(entry.hunks) && entry.hunks.length === 1, JSON.stringify(entry).slice(0, 300));
    check('T28 MCP:   and is not marked unreadable', entry.markersUnread === false, JSON.stringify(entry).slice(0, 300));
  }

  {
    // T29 — A FILE GIT SAYS IS CONFLICTED, DESCRIBED AS HAVING NOTHING TO
    // CHOOSE, ANSWERED WITH A WHOLE-FILE DEFAULT.
    //
    // The CRLF markers above were one way to reach that shape and they are
    // fixed. This is the shape itself, reached by another road no parser change
    // can close: a custom merge driver — git's own documented mechanism, set up
    // here in the fixture's own config — that leaves a conflict marker it never
    // closes. parseConflict keeps every one of those lines, correctly, as
    // agreed text; clashCount() is then 0; and the whole-file default "ours"
    // used to sail through the choices validator as legal vocabulary and commit
    // the incoming branch away.
    const dir = await repo('unreadable');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'INCOMING-WORK\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'incoming');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'OURS\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'ours');
    // The driver and the attributes live inside .git, so nothing here is a
    // tracked file and the "not one byte changed" oracle below is about the
    // repository the user would see.
    const driver = path.join(dir, '.git', 'unclosed.sh');
    fs.writeFileSync(driver, '#!/bin/sh\nprintf "<<<<<<< HEAD\\nOURS\\n" > "$1"\nexit 1\n');
    fs.chmodSync(driver, 0o755);
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.txt merge=unclosed\n');
    await sh(dir, 'config', 'merge.unclosed.name', 'leaves a marker it never closes');
    await sh(dir, 'config', 'merge.unclosed.driver', `${driver} %A`);

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T29: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    const file = (clash.files || [])[0] || {};
    check('T29: and the parse finds no hunks in it', (file.parts || []).filter((p) => p.kind === 'clash').length === 0, JSON.stringify(file.parts));
    check('T29:   with git’s marker still sitting in the text it calls agreed', (file.parts || []).some((p) => p.kind === 'same' && p.text.includes('<<<<<<<')), JSON.stringify(file.parts));

    const before = await repoState(dir);
    const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at }));
    check('T29: the resolve does not throw', answer.error === null, String(answer.error));
    await refusedCleanly(
      'T29: a whole-file answer to a file whose markers went unread',
      answer.value,
      dir,
      before,
      'bad_choices',
      (r) => r?.badChoices?.[0]?.path === 'a.txt' && r?.badChoices?.[0]?.reason === 'unreadable_conflict'
    );
    check('T29:   with nothing to suggest sending instead', JSON.stringify(answer.value?.badChoices?.[0]?.expected) === '[]', JSON.stringify(answer.value?.badChoices?.[0]));
    check('T29:   and a sentence that says the markers could not be read', /could not read/.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T29:   and sends the person to the project', /by hand/.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T29: THE INCOMING WORK IS STILL ON ITS BRANCH', (await sh(dir, 'show', 'feature:a.txt')) === 'INCOMING-WORK', await sh(dir, 'show', 'feature:a.txt'));
    check('T29:   and nothing was merged into this one', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P'));

    // THE OTHER THREE WAYS OF ANSWERING IT, refused the same way — the
    // deliberate "theirs" as much as the default nobody typed, because every
    // one of them was decided against a description of the file that was false.
    for (const [what, choices] of [
      ['the incoming side named outright', { 'a.txt': 'theirs' }],
      ['the documented default, left out entirely', {}],
      ['a per-hunk list', { 'a.txt': ['ours'] }],
    ]) {
      const also = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices, expect: clash.at }));
      check(`T29: ${what} is refused too`, also.value?.ok === false && also.value?.badChoices?.[0]?.reason === 'unreadable_conflict', JSON.stringify(also.value?.badChoices || also.error));
    }
    check('T29:   and after all of them the default answer was recorded', answer.value?.badChoices?.[0]?.given === 'ours', JSON.stringify(answer.value?.badChoices?.[0]));

    // WHAT AN AGENT IS TOLD ABOUT SUCH A FILE, on both surfaces.
    const { DOMAINS: MAPPERS } = require('../electron/mcp/agent/domains.js');
    const env = await MAPPERS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'ref' });
    const entry = (env?.files || [])[0] || {};
    check('T29 MCP: the file is NOT described as having zero conflicting hunks', entry.hunks !== null ? false : true, JSON.stringify(entry));
    check('T29 MCP:   and is not passed off as omitted for size', entry.hunksOmitted === false, JSON.stringify(entry));
    check('T29 MCP:   it says the markers went unread', entry.markersUnread === true, JSON.stringify(entry));
    // AND THE ENVELOPE SAYS WHAT THAT FIELD MEANS. The same envelope tells the
    // agent to send "exactly as many entries as the hunks listed here", and for
    // this file there are none to count — a field it has to guess the meaning
    // of would send it back to that instruction.
    check('T29 MCP:   and the note explains what that means for the answer', /markersUnread/.test(String(env?.note || '')) && /by hand/.test(String(env?.note || '')), String(env?.note));
    const mapped = await MAPPERS.git.resolve_merge.result(answer.value, { branch: 'feature' }, { root: dir });
    check('T29 MCP: the refusal is still bad_choices', mapped?.code === 'bad_choices', JSON.stringify({ code: mapped?.code }));
    check('T29 MCP:   naming the unread markers rather than the vocabulary', /markers Stacki could not read/.test(String(mapped?.message || '')), String(mapped?.message));

    // THE CONTROL: a file with no markers because there is genuinely nothing
    // marked up — a modify/delete — still takes a whole-file answer. The
    // refusal above must be about markers that went unread, not about every
    // file that reports no hunks.
    const md = await repo('unreadablecontrol');
    cleanup.push(md);
    await sh(md, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(md, 'a.txt'), 'EDITED-ON-FEATURE\n');
    await sh(md, 'add', '-A');
    await sh(md, 'commit', '-qm', 'edited on feature');
    await sh(md, 'checkout', '-q', 'main');
    await sh(md, 'rm', '-q', 'a.txt');
    await sh(md, 'commit', '-qm', 'deleted on main');
    const mdClash = await mergeBranch(git, { projectPath: md, branch: 'feature' });
    check('T29 control: the modify/delete fixture conflicts with no hunks', mdClash.conflicted === true && (mdClash.files?.[0]?.parts || []).filter((p) => p.kind === 'clash').length === 0, JSON.stringify(mdClash.files?.[0]?.parts));
    const mdKept = await caught(() => resolveMerge(git, { projectPath: md, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: mdClash.at }));
    check('T29 control: a whole-file answer to it still merges', mdKept.value?.ok === true && mdKept.value?.resolved === 1, JSON.stringify(mdKept.value || mdKept.error));
    check('T29 control:   keeping the incoming version', textOf(path.join(md, 'a.txt')) === 'EDITED-ON-FEATURE\n', JSON.stringify(textOf(path.join(md, 'a.txt'))));

    // AND THE PANEL CAN SAY IT. A file with `parts` but no hunks fell between
    // the modal's two halves: the whole-file chooser was drawn only for files
    // with NO parts at all, so this one got the per-hunk half — a header with
    // "All main" / "All feature" buttons that mapped over an empty list and did
    // nothing, no hunks under it, and a choicesForSend() that sent "ours" every
    // time whatever was clicked. There was no way to ask for the incoming
    // version of a modify/delete from the panel at all.
    const mdPanel = await renderMergeModal(mdClash);
    check('T29 control panel: the modal renders it', mdPanel.errors.length === 0, mdPanel.errors[0]);
    check('T29 control panel:   offering a whole-file choice', mdPanel.labels().includes('feature') && mdPanel.labels().includes('main'), JSON.stringify(mdPanel.labels()));
    check('T29 control panel:   which defaults to keeping this branch', JSON.stringify(mdPanel.merge()) === JSON.stringify({ 'a.txt': 'ours' }), JSON.stringify(mdPanel.merge()));
    check('T29 control panel:   with the incoming branch there to click', mdPanel.click('feature'), JSON.stringify(mdPanel.labels()));
    check('T29 control panel: AND ASKING FOR THE INCOMING VERSION IS WHAT GETS SENT', JSON.stringify(mdPanel.merge()) === JSON.stringify({ 'a.txt': 'theirs' }), JSON.stringify(mdPanel.merge()));
    mdPanel.close();
  }

  {
    // T30 — `merge_blocked` SAID "NOTHING WAS WRITTEN" OVER FILES THE TRIAL
    // MERGE HAD ALREADY WRITTEN.
    //
    // It was the one post-trial-merge refusal that never looked at the tree: no
    // `abort()`, and no comparison of `treeBefore` with `treeNow()`. Its
    // reasoning was that an empty unmerged list proves the merge wrote nothing,
    // and that is false — `git merge --no-commit --no-ff` writes the merged
    // WORKING TREE first and can fail partway through, leaving the files it had
    // already created with not one unmerged entry in the index.
    //
    // The residue is not inert: a leftover `src/pages/*.astro` is a file
    // Stacki's own page scan lists as a page of the CURRENT branch, and the next
    // `git add -A` commits the incoming branch's work onto it. The remedy the
    // message gave — send exactly this call again — cannot work for this cause
    // either: the same failure recurs and each retry leaves more behind.
    const dir = await repo('blockedresidue');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'THEIRS\n');
    fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/pages/incoming.astro'), '<h1>incoming</h1>\n');
    // Sorts after src/, so the merge has already written the page by the time
    // it dies here.
    fs.mkdirSync(path.join(dir, 'zz'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'zz/locked.txt'), 'incoming\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'incoming');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'OURS\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'ours');
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('T30: the fixture conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    const PAGE = path.join(dir, 'src/pages/incoming.astro');
    check('T30: and the incoming page is not in the tree before the resolve', fs.existsSync(PAGE) === false);

    // The failure, made real rather than stubbed: a directory the merge has to
    // write into that it cannot. `git merge` dies on it AFTER it has written
    // everything that sorts before it.
    fs.mkdirSync(path.join(dir, 'zz'), { recursive: true });
    fs.chmodSync(path.join(dir, 'zz'), 0o500);
    let answer;
    try {
      answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at }));
    } finally {
      fs.chmodSync(path.join(dir, 'zz'), 0o700);
    }
    check('T30: the resolve does not throw', answer.error === null, String(answer.error));
    check('T30: the trial merge really did leave the incoming page behind', fs.existsSync(PAGE), await sh(dir, 'status', '--porcelain'));
    check('T30: THE REFUSAL DOES NOT CLAIM NOTHING WAS WRITTEN', !/nothing was written/i.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T30: it is merge_stuck, not merge_blocked', answer.value?.code === 'merge_stuck', JSON.stringify({ code: answer.value?.code, message: answer.value?.message }));
    check('T30:   naming the file the merge left behind', JSON.stringify(answer.value?.files) === JSON.stringify(['src/pages/incoming.astro']), JSON.stringify(answer.value?.files));
    check('T30:   and saying there is no merge left to abort', answer.value?.mergeInProgress === false, JSON.stringify({ mergeInProgress: answer.value?.mergeInProgress }));
    check('T30:   with the remedy that fits — put the file back, not retry', /git checkout HEAD --/.test(String(answer.value?.message || '')) && !/send exactly this call again/.test(String(answer.value?.message || '')), String(answer.value?.message));
    check('T30: and nothing was committed', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 1, await sh(dir, 'log', '-1', '--format=%P'));
    const { DOMAINS: MAPPERS } = require('../electron/mcp/agent/domains.js');
    const mapped = await MAPPERS.git.resolve_merge.result(answer.value, { branch: 'feature' }, { root: dir });
    check('T30 MCP: passed through as merge_stuck', mapped?.code === 'merge_stuck', JSON.stringify({ code: mapped?.code }));

    // THE CONTROL, AND THE REASON THE UNWIND IS STILL CONDITIONAL. The case
    // this refusal exists for is another git process holding the repository —
    // an ordinary `index.lock` — and there git stops before writing anything.
    // Firing `merge --abort` into that is the one way to turn a wait into
    // damage, so a tree that did not move must still answer merge_blocked, with
    // the sentence intact.
    const held = await repo('blockedlock');
    cleanup.push(held);
    await sh(held, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(held, 'a.txt'), 'THEIRS\n');
    await sh(held, 'add', '-A');
    await sh(held, 'commit', '-qm', 'incoming');
    await sh(held, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(held, 'a.txt'), 'OURS\n');
    await sh(held, 'add', '-A');
    await sh(held, 'commit', '-qm', 'ours');
    const heldClash = await mergeBranch(git, { projectPath: held, branch: 'feature' });
    check('T30 control: the fixture conflicts', heldClash.conflicted === true, JSON.stringify(heldClash).slice(0, 160));
    const beforeHeld = await repoState(held);
    fs.writeFileSync(path.join(held, '.git', 'index.lock'), '');
    const lockAnswer = await caught(() => resolveMerge(git, { projectPath: held, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: heldClash.at }));
    fs.rmSync(path.join(held, '.git', 'index.lock'), { force: true });
    check('T30 control: a merge that wrote nothing is still merge_blocked', lockAnswer.value?.code === 'merge_blocked', JSON.stringify({ code: lockAnswer.value?.code, error: lockAnswer.error, message: lockAnswer.value?.message }));
    check('T30 control:   still telling the caller to wait and send the same call', /send exactly this call again/.test(String(lockAnswer.value?.message || '')), String(lockAnswer.value?.message));
    check('T30 control:   and quoting git rather than a command line', typeof lockAnswer.value?.gitSaid === 'string' && !/^Command failed/i.test(lockAnswer.value.gitSaid), String(lockAnswer.value?.gitSaid));
    const afterHeld = await repoState(held);
    check('T30 control:   with HEAD unmoved and the tree untouched', afterHeld.head === beforeHeld.head && JSON.stringify(afterHeld.bytes) === JSON.stringify(beforeHeld.bytes), `${beforeHeld.head} -> ${afterHeld.head}`);
    // And the same answers still merge once the lock is gone, so the control is
    // a refusal about the moment rather than about the repository.
    const freed = await caught(() => resolveMerge(git, { projectPath: held, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: heldClash.at }));
    check('T30 control:   and the very same call merges once the lock is gone', freed.value?.ok === true && freed.value?.resolved === 1, JSON.stringify(freed.value || freed.error));
  }

  {
    // T31 — THE FINAL-NEWLINE CORRECTION SWITCHED ITSELF OFF, SILENTLY, ON ANY
    // CONFLICTING FILE OVER A MEGABYTE.
    //
    // `stage()` reads one side of a conflict with `git show :2:path`. The
    // runner underneath is child_process.execFile, whose maxBuffer defaults to
    // 1 MiB, and stage() shelled out with no options at all — so a bigger file
    // rejected with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the catch turned that
    // into the same `null` a DELETED side answers with. renderResolved reads
    // null as "that side is gone, so git's own terminator is the only one there
    // is" and keeps the newline git invented. The result is a merge commit one
    // byte different from the branch it came from, reported as
    // `{ok: true, resolved: 1}`, with nothing anywhere saying so.
    //
    // THE RUNNER HERE IS THE PRODUCTION ONE'S SHAPE. main.js passes an `opts`
    // third argument through to execFile; the two-argument runner the rest of
    // this file uses would swallow the bound being raised and prove nothing, so
    // this one forwards it — and forwards NOTHING when nothing is given, which
    // is where the 1 MiB default lives.
    const opting = (cwd, args, opts = {}) =>
      new Promise((resolve, reject) => {
        execFile('git', args, { cwd, ...opts }, (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
          } else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      });

    const dir = await repo('bigside');
    cleanup.push(dir);
    // Over a megabyte, which is not a large source file — a generated data
    // file, a long page, a committed bundle. The clash is at the END of it,
    // because that is the one place the terminator matters.
    const pad = Array.from({ length: 30000 }, (_, i) => `line ${i} of ordinary padding text in this file`).join('\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), `${pad}\nBASE\n`);
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'a big file');
    await sh(dir, 'checkout', '-qb', 'feature');
    // No terminator on the incoming side: this is what the correction exists
    // for, and what its silent absence puts back.
    fs.writeFileSync(path.join(dir, 'a.txt'), `${pad}\nTHEIRS`);
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'incoming, with no newline at the end');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), `${pad}\nOURS\n`);
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'ours');
    check('T31: the fixture is bigger than execFile’s default buffer', fs.statSync(path.join(dir, 'a.txt')).size > 1024 * 1024, String(fs.statSync(path.join(dir, 'a.txt')).size));

    const clash = await mergeBranch(opting, { projectPath: dir, branch: 'feature' });
    check('T31: it conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
    const hunks = (clash.files?.[0]?.parts || []).filter((p) => p.kind === 'clash').length;
    check('T31: with the clash running to the end of the file', hunks === 1 && conflictAtEnd(clash.files[0].parts) === true, JSON.stringify({ hunks }));
    const applied = await caught(() =>
      resolveMerge(opting, { projectPath: dir, branch: 'feature', choices: { 'a.txt': Array(hunks).fill('theirs') }, expect: clash.at })
    );
    check('T31: the resolve does not throw', applied.error === null, String(applied.error));
    check('T31: it merges', applied.value?.ok === true && applied.value?.resolved === 1, JSON.stringify(applied.value));
    check(
      'T31: AND THE COMMITTED FILE IS THE INCOMING ONE, BYTE FOR BYTE',
      textOf(path.join(dir, 'a.txt')) === `${pad}\nTHEIRS`,
      JSON.stringify({ endsWithNewline: textOf(path.join(dir, 'a.txt'))?.endsWith('\n'), bytes: textOf(path.join(dir, 'a.txt'))?.length })
    );
    check('T31:   with no newline neither branch wrote', textOf(path.join(dir, 'a.txt'))?.endsWith('\n') === false, JSON.stringify(textOf(path.join(dir, 'a.txt'))?.slice(-12)));

    // AND WHEN THE READ REALLY DOES FAIL, IT IS SAID RATHER THAN GUESSED AT.
    // A side the index says is there that comes back unreadable is not the same
    // thing as a side that is not there, and reading it as one is what made the
    // byte above go missing in silence. The runner below refuses exactly that
    // one read — which is what a maxBuffer overflow is, at whatever size the
    // bound sits.
    const small = await repo('unreadableside');
    cleanup.push(small);
    await sh(small, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(small, 'a.txt'), 'head\nTHEIRS');
    await sh(small, 'add', '-A');
    await sh(small, 'commit', '-qm', 'incoming');
    await sh(small, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(small, 'a.txt'), 'head\nOURS\n');
    await sh(small, 'add', '-A');
    await sh(small, 'commit', '-qm', 'ours');
    const smallClash = await mergeBranch(git, { projectPath: small, branch: 'feature' });
    const smallHunks = (smallClash.files?.[0]?.parts || []).filter((p) => p.kind === 'clash').length;
    check('T31: the small fixture clashes to the end of the file too', smallHunks === 1 && conflictAtEnd(smallClash.files[0].parts) === true, JSON.stringify(smallClash.files?.[0]?.parts));
    const refusing = async (cwd, args) => {
      if (args[0] === 'show' && String(args[2] || '').startsWith(':3:')) {
        const err = new Error('stdout maxBuffer length exceeded');
        err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        throw err;
      }
      return git(cwd, args);
    };
    const beforeSmall = await repoState(small);
    const said = await caught(() =>
      resolveMerge(refusing, { projectPath: small, branch: 'feature', choices: { 'a.txt': Array(smallHunks).fill('theirs') }, expect: smallClash.at })
    );
    check('T31: a side that would not read stops the merge instead of guessing', said.error !== null, JSON.stringify(said.value));
    check('T31:   naming the file and which side of it', /a\.txt/.test(String(said.error)) && /incoming branch/.test(String(said.error)), String(said.error));
    const afterSmall = await repoState(small);
    check('T31:   with HEAD unmoved', afterSmall.head === beforeSmall.head, `${beforeSmall.head} -> ${afterSmall.head}`);
    check('T31:   the tree back as it was', JSON.stringify(afterSmall.bytes) === JSON.stringify(beforeSmall.bytes), afterSmall.status);
    check('T31:   and no merge left in progress', afterSmall.mergeHead === false);
    // THE CONTROL: with the read working, the same fixture and the same answer
    // merge, and the terminator correction still happens. Without it a guard
    // that simply refused every resolve would pass everything above.
    const settled = await caught(() =>
      resolveMerge(git, { projectPath: small, branch: 'feature', choices: { 'a.txt': Array(smallHunks).fill('theirs') }, expect: smallClash.at })
    );
    check('T31 control: the same answer merges when the side can be read', settled.value?.ok === true, JSON.stringify(settled.value || settled.error));
    check('T31 control:   with the incoming bytes exactly', textOf(path.join(small, 'a.txt')) === 'head\nTHEIRS', JSON.stringify(textOf(path.join(small, 'a.txt'))));
  }

  {
    // T32 — SEVEN IS NOT THE ONLY WIDTH GIT WRITES ITS CONFLICT MARKERS AT, AND
    // THE TWO WAYS THE PARSE FAILED AGAINST OTHER WIDTHS WERE BOTH ok:true.
    //
    // `conflict-marker-size=<n>` is a documented per-path gitattribute. MEASURED
    // against git 2.50.1: every positive integer from 1 to 200 comes out at
    // exactly the width asked for, on both LF and CRLF files and under all three
    // conflict styles; 0, a negative and a non-integer fall back to seven. So
    // `*.txt conflict-marker-size=32` is an ordinary repository setting, and the
    // patterns in electron/conflicts.js knew only about seven.
    //
    // WIDER THAN SEVEN — THE ONE THAT WROTE BYTES NEITHER BRANCH HAD.
    // `/^<<<<<<< ?(.*?)\r?$/` matched the first seven characters of a
    // thirty-two-character opener and read the other twenty-five as the label,
    // and the ancestor line and closer matched the same way. Only the SEPARATOR
    // did not: `/^=======\s*$/` has nothing to eat thirty-two '=' with. So the
    // separator line and the whole incoming side fell into the ANCESTOR bucket
    // and `theirs` came out EMPTY — a hunk claiming the other branch deleted
    // those lines. MEASURED end to end at sizes 9 and 32, LF and CRLF: the panel
    // and the MCP envelope both described it that way with
    // `markersUnread: false`, and answering `['theirs']` wrote "head\ntail\n" —
    // in neither branch — staged it and committed a real two-parent merge as
    // `{ok: true, changed: true, resolved: 1}` over a clean tree. Both branches'
    // work gone, from a choice made against a description that was not true.
    //
    // NARROWER THAN SEVEN — THE SHAPE THE CRLF FIX WAS WRITTEN TO CLOSE, STILL
    // OPEN. `<<< HEAD` matched nothing, so the marked-up file came back as one
    // agreed part, clashCount() was 0, and `unreadMarkers` — the class backstop,
    // whose pattern was exactly seven '<' — did not see it either. MEASURED at
    // size 3: `choices: {}` committed this branch's version and answered
    // `{ok: true, resolved: 1}`, the incoming branch's work discarded under a
    // description that said there was nothing to decide.
    //
    // The width is now a parameter, read from git's own `check-attr` for that
    // path (see conflictMarkerSizes) and matched exactly, and a width that turns
    // out to be wrong leaves the real markers unread where the backstop finds
    // them — a refusal, never a commit. Every claim above is checked here
    // against real repositories.

    // A BLOB, EXACTLY. `sh` trims, which is right for a rev-parse and wrong for
    // the oracle of this whole block: the final newline is the byte three of the
    // defects in this file were about, and a comparison that trims it cannot see
    // any of them.
    const blob = async (dir, rev) => (await git(dir, ['show', '--end-of-options', rev])).stdout;

    // A repository that clashes in one file, at whatever marker width its
    // .gitattributes asks for.
    const widthRepo = async (name, attrs, { base, ours, theirs, file = 'a.txt' }) => {
      const dir = await repo(name);
      cleanup.push(dir);
      if (attrs) fs.writeFileSync(path.join(dir, '.gitattributes'), attrs);
      fs.writeFileSync(path.join(dir, file), base);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'the version both branches start from');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, file), theirs);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'the incoming work');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, file), ours);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'this branch');
      return dir;
    };

    // WHAT GIT ACTUALLY WROTE, read off a real merge rather than assumed. A
    // .gitattributes that was not picked up would make every assertion below
    // pass for the wrong reason — see T28, which asks git the same way.
    const widthGitWrote = async (dir, file) => {
      await sh(dir, '-c', 'merge.conflictStyle=diff3', 'merge', '--no-commit', '--no-ff', '--no-edit', '--', 'feature').catch(() => {});
      const text = textOf(path.join(dir, file)) || '';
      const opener = (text.match(/(?:^|\n)(<+)/) || [])[1] || '';
      const middle = (text.match(/(?:^|\n)(=+)/) || [])[1] || '';
      const ancestor = (text.match(/(?:^|\n)(\|+)/) || [])[1] || '';
      const closer = (text.match(/(?:^|\n)(>+)/) || [])[1] || '';
      await sh(dir, 'merge', '--abort').catch(() => {});
      return { opener: opener.length, middle: middle.length, ancestor: ancestor.length, closer: closer.length };
    };

    const BASE = 'head\nBASE\ntail\n';
    const OURS = 'head\nOURS\ntail\n';
    const THEIRS = 'head\nTHEIRS\ntail\n';

    // 1-4 + a fifth width, and every one of them under the diff3 style Stacki
    // merges with — so the ancestor line is in the markup too and is matched at
    // the same width as the rest.
    const widths = [
      { name: 'w7lf', label: 'default width, LF', attrs: null, size: 7, crlf: false },
      { name: 'w7crlf', label: 'default width, CRLF', attrs: '*.txt text eol=crlf\n', size: 7, crlf: true },
      { name: 'w32lf', label: 'conflict-marker-size=32, LF', attrs: '*.txt conflict-marker-size=32\n', size: 32, crlf: false },
      { name: 'w32crlf', label: 'conflict-marker-size=32, CRLF', attrs: '*.txt conflict-marker-size=32\n*.txt text eol=crlf\n', size: 32, crlf: true },
      { name: 'w9lf', label: 'conflict-marker-size=9, LF', attrs: '*.txt conflict-marker-size=9\n', size: 9, crlf: false },
      { name: 'w3lf', label: 'conflict-marker-size=3, LF', attrs: '*.txt conflict-marker-size=3\n', size: 3, crlf: false },
    ];

    for (const w of widths) {
      // THE FIXTURE IS REALLY THAT WIDTH. Asked of git, on a real merge, before
      // anything below reads a marker.
      const probe = await widthRepo(`${w.name}-probe`, w.attrs, { base: BASE, ours: OURS, theirs: THEIRS });
      const wrote = await widthGitWrote(probe, 'a.txt');
      check(
        `T32 ${w.label}: git writes all four markers ${w.size} characters wide`,
        wrote.opener === w.size && wrote.middle === w.size && wrote.ancestor === w.size && wrote.closer === w.size,
        JSON.stringify(wrote)
      );

      const read = await widthRepo(`${w.name}-read`, w.attrs, { base: BASE, ours: OURS, theirs: THEIRS });
      const clash = await mergeBranch(git, { projectPath: read, branch: 'feature' });
      check(`T32 ${w.label}: the file conflicts`, clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 200));
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const hunks = (f.parts || []).filter((p) => p.kind === 'clash');
      check(`T32 ${w.label}: ONE disagreement, not none and not a false one`, hunks.length === 1, JSON.stringify(f.parts));
      // The two sides, exactly — this is what caught the wider-than-seven
      // failure, whose `theirs` was the empty string.
      const eol = w.crlf ? '\r' : '';
      check(
        `T32 ${w.label}:   with both sides read`,
        hunks[0]?.ours === `OURS${eol}` && hunks[0]?.theirs === `THEIRS${eol}`,
        JSON.stringify(hunks[0])
      );
      check(`T32 ${w.label}:   and the width git used carried with them`, f.markerSize === w.size, String(f.markerSize));
      // THE ANCESTOR LINE WAS MATCHED TOO, at the same width — which is what
      // makes `changedBy` a three-way answer rather than a guess between two
      // sides. Both branches moved off BASE here, so it is 'both'.
      check(`T32 ${w.label}:   read three-way, against the ancestor git wrote`, hunks[0]?.changedBy === 'both', JSON.stringify(hunks[0]));
      // AND THE AGENT IS TOLD THE SAME THING. `markersUnread` is the field that
      // said `false` over a file described with an empty incoming side.
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: read, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check(
        `T32 ${w.label} MCP: one hunk, markers read`,
        mcpFile.markersUnread === false && Array.isArray(mcpFile.hunks) && mcpFile.hunks.length === 1,
        JSON.stringify(mcpFile)
      );

      // 7, 8, 9, 11 — every answer, against the exact branch bytes. The oracle
      // is the COMMIT: `git show HEAD:a.txt` after the merge against
      // `git show <branch>:a.txt`, both read without `sh`'s trim so a final
      // newline is part of the comparison. On the CRLF rows that comparison is
      // blob against blob and therefore blind to line endings by construction —
      // those rows ask the working tree as well, below.
      const answers = [
        { what: 'explicit "ours"', choices: { 'a.txt': 'ours' }, from: 'main' },
        { what: 'explicit "theirs"', choices: { 'a.txt': 'theirs' }, from: 'feature' },
        { what: 'the per-hunk answer ["ours"]', choices: { 'a.txt': ['ours'] }, from: 'main' },
        { what: 'the per-hunk answer ["theirs"]', choices: { 'a.txt': ['theirs'] }, from: 'feature' },
        { what: 'an omitted choice', choices: {}, from: 'main' },
      ];
      for (const a of answers) {
        const dir = await widthRepo(`${w.name}-${a.from}-${a.choices['a.txt'] ? String(a.choices['a.txt']) : 'default'}`, w.attrs, {
          base: BASE,
          ours: OURS,
          theirs: THEIRS,
        });
        const at = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
        const want = await blob(dir, `${a.from}:a.txt`);
        const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: a.choices, expect: at.at }));
        check(`T32 ${w.label}: ${a.what} merges`, answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
        check(
          `T32 ${w.label}:   committing ${a.from}'s bytes exactly`,
          (await blob(dir, 'HEAD:a.txt')) === want,
          JSON.stringify({ got: await blob(dir, 'HEAD:a.txt'), want })
        );
        check(
          `T32 ${w.label}:   as a merge commit with two parents`,
          (await sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(/\s+/).length === 3
        );
        check(`T32 ${w.label}:   on the branch it started on`, (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'main');
        const state = await repoState(dir);
        check(`T32 ${w.label}:   leaving a clean repository`, state.status === '' && state.mergeHead === false, state.status);
        check(
          `T32 ${w.label}:   and not one marker on disk`,
          !/[<>|]{3}|\n={3,}\n/.test(textOf(path.join(dir, 'a.txt')) || ''),
          JSON.stringify(textOf(path.join(dir, 'a.txt')))
        );
        // AND THE BYTES ON DISK, WHICH THE BLOB ORACLE CANNOT SEE ON THESE ROWS.
        //
        // The comparison above is blob against blob, and a blob under
        // `text eol=crlf` is stored with LF whichever side it came from — so on
        // the two CRLF rows it is precisely line-ending normalisation that makes
        // the two sides comparable, and precisely line-ending damage that it
        // cannot show. Three of the defects this file exists for were one byte
        // of line ending. So the working tree is asked as well, where the
        // terminator is the file's own: every line ends CRLF, none ends on a
        // lone LF, and the whole file is the committed blob with its terminators
        // put back — which is what `text eol=crlf` promises and what a rebuild
        // that dropped or invented one would fail.
        if (w.crlf) {
          const onDisk = textOf(path.join(dir, 'a.txt'));
          check(
            `T32 ${w.label}:   and the working tree holds that side with CRLF, byte for byte`,
            onDisk === want.replace(/\n/g, '\r\n'),
            JSON.stringify({ onDisk, want })
          );
          check(
            `T32 ${w.label}:   with no lone newline left anywhere in it`,
            typeof onDisk === 'string' && !/[^\r]\n/.test(onDisk) && !/^\n/.test(onDisk),
            JSON.stringify(onDisk)
          );
        }
      }

      // 10, 15 — a malformed answer is refused with the repository untouched.
      for (const bad of [
        { what: 'a word that is not a side', choices: { 'a.txt': ['sideways'] }, reason: 'bad_pick' },
        { what: 'more answers than hunks', choices: { 'a.txt': ['ours', 'theirs'] }, reason: 'wrong_length' },
        { what: 'an empty list of answers', choices: { 'a.txt': [] }, reason: 'empty' },
        { what: 'an explicit null', choices: { 'a.txt': null }, reason: 'null' },
        { what: 'a path git never named', choices: { 'a.txt': 'ours', 'nope.txt': 'ours' }, reason: 'unknown_path' },
      ]) {
        const dir = await widthRepo(`${w.name}-bad-${bad.reason}`, w.attrs, { base: BASE, ours: OURS, theirs: THEIRS });
        const at = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
        const before = await repoState(dir);
        const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: bad.choices, expect: at.at }));
        await refusedCleanly(`T32 ${w.label}: ${bad.what}`, answer.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.reason === bad.reason)
        );
      }
    }

    // 6 — A CUSTOM WIDTH WITH SEVERAL HUNKS, ANSWERED ONE AT A TIME. The whole
    // reason the parse exists is that a file can take its heading from one
    // branch and its footer from the other, and a width the parse could not read
    // took that away without saying so.
    {
      const dir = await widthRepo('w32-multi', '*.txt conflict-marker-size=32\n', {
        base: 'top\nA-BASE\nmiddle\nB-BASE\nbottom\n',
        ours: 'top\nA-OURS\nmiddle\nB-OURS\nbottom\n',
        theirs: 'top\nA-THEIRS\nmiddle\nB-THEIRS\nbottom\n',
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const hunks = (f.parts || []).filter((p) => p.kind === 'clash');
      check('T32 multi: two independent disagreements at width 32', hunks.length === 2, JSON.stringify(f.parts));
      const answer = await caught(() =>
        resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['ours', 'theirs'] }, expect: clash.at })
      );
      check('T32 multi: half from each branch merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T32 multi:   with exactly the bytes that asks for',
        (await blob(dir, 'HEAD:a.txt')) === 'top\nA-OURS\nmiddle\nB-THEIRS\nbottom\n',
        JSON.stringify(await blob(dir, 'HEAD:a.txt'))
      );
    }

    // 5 — THE ANCESTOR IS WHAT SAYS WHICH SIDE MOVED, and at a custom width it
    // was being swallowed along with the incoming side. Only ONE branch changes
    // this hunk, so a parse that read the ancestor answers 'theirs' and one that
    // did not cannot tell.
    {
      const dir = await widthRepo('w32-diff3', '*.txt conflict-marker-size=32\n', {
        base: 'head\nBASE\nSHARED\n',
        ours: 'head\nBASE\nOURS-TAIL\n',
        theirs: 'head\nTHEIRS\nSHARED\n',
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const hunks = (f.parts || []).filter((p) => p.kind === 'clash');
      check('T32 diff3: the width-32 ancestor line was read', hunks.some((h) => h.changedBy !== 'both'), JSON.stringify(f.parts));
    }

    // 12 — A MODIFY/DELETE CLASH AT A CUSTOM WIDTH. There are no markers in this
    // shape at all, so the existing no_such_side protection must be exactly as
    // it was: a width fix that started refusing these would be a new false
    // refusal, and one that started allowing them would undo T27.
    {
      const dir = await repo('w32-modifydelete');
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt conflict-marker-size=32\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'a repository with wide conflict markers');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'edited on the incoming branch\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'edited on feature');
      await sh(dir, 'checkout', '-q', 'main');
      await sh(dir, 'rm', '-q', 'a.txt');
      await sh(dir, 'commit', '-qm', 'deleted on main');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      check('T32 modify/delete: it conflicts', clash.ok === false && clash.conflicted === true, JSON.stringify(clash).slice(0, 160));
      const before = await repoState(dir);
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: {}, expect: clash.at }));
      await refusedCleanly('T32 modify/delete: the default "ours"', answer.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'no_such_side' && JSON.stringify(b.sides) === '["theirs"]')
      );
    }

    // 13 — A BINARY CLASH AT A CUSTOM WIDTH. Git writes no markers into a binary
    // file whatever the attribute says, so this file legitimately has no hunks
    // and takes a whole-file word. It is here because the backstop above was
    // broadened, and a backstop that started calling these unreadable would
    // refuse every conflicting image in the project.
    {
      const dir = await repo('w32-binary');
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, '.gitattributes'), '*.bin conflict-marker-size=32\n');
      fs.writeFileSync(path.join(dir, 'x.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 60, 60, 60]));
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'a binary file');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'x.bin'), Buffer.from([0, 9, 9, 9, 0, 255]));
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'x.bin'), Buffer.from([0, 5, 5, 5, 0, 254]));
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ours');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'x.bin') || {};
      check('T32 binary: no hunks, which is the truth about it', (f.parts || []).filter((p) => p.kind === 'clash').length === 0, JSON.stringify(f.parts).slice(0, 200));
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'x.bin') || {};
      check('T32 binary:   and it is NOT called unreadable', mcpFile.markersUnread === false, JSON.stringify(mcpFile));
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'x.bin': 'theirs' }, expect: clash.at }));
      check('T32 binary: the whole-file answer still merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T32 binary:   with the incoming bytes exactly',
        fs.readFileSync(path.join(dir, 'x.bin')).equals(Buffer.from([0, 9, 9, 9, 0, 255]))
      );
    }

    // 14 — A FILE THAT LEGITIMATELY CONTAINS SOMETHING SHAPED LIKE A CONFLICT
    // MARKER. A page explaining what a conflict looks like is ordinary, and
    // MEASURED: git does NOT widen its own markers to avoid colliding with such
    // text — at the default width it wrote a second `<<<<<<< HEAD` directly
    // under the one already in the file.
    //
    // At the DEFAULT width the two look alike character for character — but
    // they are not indistinguishable, because Stacki merges with
    // `merge.conflictStyle=diff3` and git writes an ancestor line into every
    // block of such a merge. The authored one, written in the ordinary `merge`
    // style anybody documenting a conflict would use, has none. See
    // parseConflict: it is kept whole and the path is refused, which is the
    // same treatment the custom-width case below gets and for the same reason.
    //
    // At a CUSTOM width they are distinguishable, and the answer is the one this
    // whole change is built on: the authored seven-wide block is NOT read as a
    // hunk — it is kept verbatim, no line of it lost — and because a marker is
    // then sitting unread in text the parse called agreed, the path is REFUSED
    // rather than answered. A safe refusal on a genuinely ambiguous file, with
    // every byte of the file still there to finish by hand.
    {
      const DOC = 'When git cannot reconcile a file it writes:\n\n<<<<<<< HEAD\nyour version\n=======\ntheir version\n>>>>>>> other-branch\n\n';
      const dir = await widthRepo('w7-authored-markers', null, {
        base: `${DOC}status: BASE\n`,
        ours: `${DOC}status: OURS\n`,
        theirs: `${DOC}status: THEIRS\n`,
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const hunks = (f.parts || []).filter((p) => p.kind === 'clash');
      check('T32 authored markers, default width: only git’s own block is read', hunks.length === 1, JSON.stringify(f.parts));
      check(
        'T32 authored markers, default width:   with the authored one kept verbatim',
        (f.parts || []).some((part) => part.kind === 'same' && part.text.includes('<<<<<<< HEAD')),
        JSON.stringify(f.parts).slice(0, 300)
      );
      const defaultMcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const defaultFile = (defaultMcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 authored markers, default width:   and the agent is told so', defaultFile.markersUnread === true && defaultFile.hunks === null, JSON.stringify(defaultFile));
      const beforeDefault = await repoState(dir);
      const defaultAnswer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'theirs' }, expect: clash.at }));
      await refusedCleanly('T32 authored markers, default width: answering it', defaultAnswer.value, dir, beforeDefault, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
      );

      const wide = await widthRepo('w32-authored-markers', '*.txt conflict-marker-size=32\n', {
        base: `${DOC}status: BASE\n`,
        ours: `${DOC}status: OURS\n`,
        theirs: `${DOC}status: THEIRS\n`,
      });
      const wideClash = await mergeBranch(git, { projectPath: wide, branch: 'feature' });
      const wf = (wideClash.files || []).find((x) => x.path === 'a.txt') || {};
      const wideHunks = (wf.parts || []).filter((p) => p.kind === 'clash');
      check('T32 authored markers, width 32: the authored block is NOT one of git’s', wideHunks.length <= 1, JSON.stringify(wf.parts));
      // NOT ONE LINE OF THE AUTHORED BLOCK IS LOST. The parse keeps what it did
      // not read, verbatim, which is what makes the refusal below safe advice.
      const agreed = (wf.parts || []).filter((p) => p.kind === 'same').map((p) => p.text).join('\n');
      check(
        'T32 authored markers, width 32:   and every line of it is still in the parse',
        agreed.includes('<<<<<<< HEAD') && agreed.includes('=======') && agreed.includes('>>>>>>> other-branch'),
        JSON.stringify(agreed).slice(0, 300)
      );
      const mcp = DOMAINS.git.merge.result(wideClash, { branch: 'feature' }, { root: wide, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 authored markers, width 32: the agent is told the markers went unread', mcpFile.markersUnread === true, JSON.stringify(mcpFile));
      const before = await repoState(wide);
      const answer = await caught(() => resolveMerge(git, { projectPath: wide, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: wideClash.at }));
      await refusedCleanly('T32 authored markers, width 32: answering it at all', answer.value, wide, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
      );
    }

    // AND THE WIDTH TRAVELS WITH THE PARTS, because the surface that describes
    // them to an agent has no repository to ask. A file at a SMALL width with a
    // lone opener of that width left in it — somebody's own text, or a
    // half-edited file — is unread, and a check made at git's default width
    // cannot see a three-character marker at all. That is the one shape neither
    // of the width-agnostic arms of the backstop covers, so it is the one that
    // proves `markerSize` has to reach the MCP domain.
    {
      const DOCS = '<<< see the docs\n';
      const dir = await widthRepo('w3-lone-opener', '*.txt conflict-marker-size=3\n', {
        base: `head\nBASE\ntail\n${DOCS}`,
        ours: `head\nOURS\ntail\n${DOCS}`,
        theirs: `head\nTHEIRS\ntail\n${DOCS}`,
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 lone small opener: the real conflict is still read', (f.parts || []).filter((p) => p.kind === 'clash').length === 1, JSON.stringify(f.parts));
      check('T32 lone small opener:   at width 3', f.markerSize === 3, String(f.markerSize));
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 lone small opener: the agent is told the markers went unread', mcpFile.markersUnread === true && mcpFile.hunks === null, JSON.stringify(mcpFile));
      const before = await repoState(dir);
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at }));
      await refusedCleanly('T32 lone small opener: answering it', answer.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
      );
    }

    // A CONFLICT EXAMPLE WRITTEN IN THE DIFF3 SPELLING — THE SIXTH INSTANCE OF
    // ONE CLASS, AND THE FIRST ANSWER TO THE CLASS ITSELF.
    //
    // Five rules now keep a line of somebody's source out of git's markup:
    // exact width, one opener, one separator, at most one ancestor line before
    // it, and — under diff3 — an ancestor line at all. Each closed the shape in
    // front of it and the next review found another. This is the shape all five
    // pass: an authored example written in the DIFF3 spelling, with an opener,
    // an ancestor line, a separator and a closer, one of each, in order, at the
    // width in force. MEASURED before this: two hunks where git wrote one,
    // `markersUnread` false, and answering them committed a file equal to
    // neither branch under `{ok: true, resolved: 1}`.
    //
    // No rule about the SHAPE of the markup can close that, because the shape is
    // identical — git has the same problem, which is why conflict-marker-size
    // exists. What closes it is the PROVENANCE: git's markers are in no blob.
    // See sidesHoldMarkers.
    for (const spelling of [
      {
        key: 'default',
        what: 'an example written in the default spelling',
        prose: ['A conflict looks like this:', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', ''].join('\n'),
      },
      {
        key: 'diff3',
        what: 'an example written in the diff3 spelling',
        prose: ['A diff3 conflict:', '<<<<<<< HEAD', 'ours', '||||||| base', 'ancestor', '=======', 'theirs', '>>>>>>> feature', ''].join('\n'),
      },
    ]) {
      const dir = await collide(`authored-${spelling.key}`, {
        base: `${spelling.prose}Intro\nBASE\nEnd\n`,
        ours: `${spelling.prose}Intro\nOURS\nEnd\n`,
        theirs: `${spelling.prose}Intro\nTHEIRS\nEnd\n`,
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const file = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check(`T33 ${spelling.what}: the agent is told the markers went unread`, file.markersUnread === true && file.hunks === null, JSON.stringify(file));
      const before = await repoState(dir);
      for (const answer of [{ 'a.txt': 'ours' }, { 'a.txt': 'theirs' }, { 'a.txt': ['ours'] }, { 'a.txt': ['ours', 'ours'] }, {}]) {
        const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: answer, expect: clash.at }));
        await refusedCleanly(`T33 ${spelling.what}: ${JSON.stringify(answer)}`, out.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
        );
      }
    }

    // AND THE CONTROL THIS MUST NOT COST. An ordinary page — no marker-shaped
    // line in either version — merges exactly as before. The rule above is about
    // files that contain a conflict marker, which is a vanishingly small set and
    // the one nobody can answer correctly anyway.
    {
      const dir = await collide('no-marker-text', {
        base: 'An ordinary page about nothing in particular.\nIntro\nBASE\nEnd\n',
        ours: 'An ordinary page about nothing in particular.\nIntro\nOURS\nEnd\n',
        theirs: 'An ordinary page about nothing in particular.\nIntro\nTHEIRS\nEnd\n',
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const file = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T33 no marker text: one hunk, markers read', file.markersUnread === false && (file.hunks || []).length === 1, JSON.stringify(file));
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at }));
      check('T33 no marker text: it merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T33 no marker text:   with the incoming bytes exactly',
        (await blob(dir, 'HEAD:a.txt')) === (await blob(dir, 'feature:a.txt')),
        JSON.stringify(await blob(dir, 'HEAD:a.txt'))
      );
    }

    // A NULL HUNK LIST IS NOT A HUNK LIST THAT DID NOT FIT.
    //
    // The envelope gives three readings for a file with no hunk list, each with
    // a different remedy, and `hunksOmitted` is the field that separates two of
    // them. It was computed from a `fits` that charged the four bytes of the
    // string "null" against the envelope budget like any other entry — so once
    // the budget was nearly spent, a path with NO SIDES AT ALL came back
    // `hunksOmitted: true`, and the note's remedy for THAT shape is "read the
    // file yourself and send a whole-file word": refused for such a path, and
    // naming a file that is not in the working tree to read.
    //
    // Asked of the mapper directly, because the budget boundary is what the case
    // is about and a real repository cannot be built to sit four bytes from it
    // without encoding the mapper's own arithmetic into the fixture.
    {
      const bulky = (n) => ({
        path: `pad${n}.txt`,
        markerSize: 7,
        ours: 'x',
        theirs: 'y',
        parts: [{ kind: 'clash', ours: 'O'.repeat(4000), theirs: 'T'.repeat(4000), oursLines: 1, theirsLines: 1, changedBy: 'both' }],
      });
      const raw = {
        ok: false,
        conflicted: true,
        from: 'main',
        branch: 'feature',
        root: '/nowhere',
        at: { head: 'a', incoming: 'b', digest: 'c', into: 'main' },
        // Enough to spend the envelope budget, then a path with no text to
        // split at all — `parts: null`, which is what both branches renaming the
        // same file leaves behind.
        files: [bulky(0), bulky(1), bulky(2), { path: 'orig.txt', markerSize: 7, ours: null, theirs: null, parts: null }],
      };
      const mapped = DOMAINS.git.merge.result(raw, { branch: 'feature' }, { root: '/nowhere', mergeRef: () => 'REF' });
      const noSides = (mapped?.files || []).find((f) => f.path === 'orig.txt') || {};
      check('T33 budget: a path with no text to split says so, whatever the budget', noSides.hunks === null && noSides.hunksOmitted === false, JSON.stringify(noSides));
      // The control: a real hunk list DOES get omitted when the budget is spent,
      // so the rule above is "null is not an omission" rather than "nothing is".
      const omitted = (mapped?.files || []).filter((f) => f.hunksOmitted === true);
      check('T33 budget:   while a hunk list too large for it is still omitted', omitted.length >= 1, JSON.stringify((mapped?.files || []).map((f) => [f.path, f.hunksOmitted])));
    }

    // A CONFLICTING FILE OUTSIDE THE OPEN PROJECT IS NOT READ THROUGH THIS
    // SURFACE — WHICH IS WHAT THE ENVELOPE'S OWN NOTE SAYS, AND DID NOT DO.
    //
    // A clash carries `ours` and `theirs`: the disputed regions of BOTH
    // branches' versions of the file. The mapper sent them for every conflicting
    // path, containment or not, while its note said "`sourcePath` is null for a
    // conflicting file outside the project altogether — that one can still be
    // answered in `choices`, but not read through this surface". MEASURED, a
    // project at <repo>/site with the clash in <repo>/deploy.env:
    // `source.read("../deploy.env")` answered `outside_project`, and the same
    // file's `API_TOKEN=` lines came back in the merge envelope, both sides,
    // from the same call.
    {
      const dir = await repo('outside-project');
      cleanup.push(dir);
      fs.mkdirSync(path.join(dir, 'site'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'deploy.env'), 'API_TOKEN=BASE\n');
      fs.writeFileSync(path.join(dir, 'site/page.txt'), 'a page\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'a secret above the project');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'deploy.env'), 'API_TOKEN=sk-live-THEIRS\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'deploy.env'), 'API_TOKEN=sk-live-OURS\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ours');
      const project = path.join(dir, 'site');
      const clash = await mergeBranch(git, { projectPath: project, branch: 'feature' });
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: project, mergeRef: () => 'REF' });
      const outside = (mcp?.files || []).find((x) => x.path === 'deploy.env') || {};
      check('T33 outside the project: the file is reported, and named as outside', outside.sourcePath === null, JSON.stringify(outside));
      check('T33 outside the project:   with no hunks — nothing of it is read here', Array.isArray(outside.hunks) && outside.hunks.length === 0, JSON.stringify(outside));
      check('T33 outside the project:   and not for size or for doubt', outside.hunksOmitted === false && outside.markersUnread === false, JSON.stringify(outside));
      // THE ASSERTION THAT MATTERS. Neither branch's version of that file is
      // anywhere in what the agent is handed.
      check(
        'T33 outside the project: neither side’s bytes are in the envelope at all',
        !JSON.stringify(mcp).includes('sk-live'),
        JSON.stringify(mcp).slice(0, 300)
      );
      // And nothing is lost: the note's remedy for a file with no hunks works.
      const answer = await caught(() => resolveMerge(git, { projectPath: project, branch: 'feature', choices: { 'deploy.env': 'theirs' }, expect: clash.at }));
      check('T33 outside the project: a whole-file answer still finishes the merge', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T33 outside the project:   with the incoming bytes exactly',
        (await blob(dir, 'HEAD:deploy.env')) === (await blob(dir, 'feature:deploy.env')),
        JSON.stringify(await blob(dir, 'HEAD:deploy.env'))
      );
      // The control: a file INSIDE the project is still described in full, so
      // the rule above is containment rather than "never send hunks".
      const inside = (mcp?.files || []).find((x) => x.path === 'site/page.txt');
      check('T33 outside the project control: the merge really was about a path above the project', !inside, JSON.stringify((mcp?.files || []).map((x) => x.path)));
    }

    // A REFUSAL MUST NOT BE LARGER THAN THE CALL THAT PROVOKED IT, AND THE CLIP
    // ALONE DID NOT DO IT.
    //
    // MEASURED after the clip was added: 400 keys of exactly 512 characters — a
    // 209 KB request — came back as 2.9 MB on the wire. Three things multiplied:
    // the name is echoed TWICE per entry (`path` and `given`), the twenty-path
    // `expected` list was copied into EVERY entry, and the envelope goes out
    // twice (structuredContent and an indented text block). So the names are
    // counted rather than all listed.
    {
      const dir = await repo('bounded-refusal');
      cleanup.push(dir);
      const names = Array.from(
        { length: 20 },
        (unused, n) => `src/pages/a-fairly-long-astro-path-that-people-really-do-write/section-${n}/index.astro`
      );
      for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), BASE);
      }
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'twenty pages');
      await sh(dir, 'checkout', '-qb', 'feature');
      for (const name of names) fs.writeFileSync(path.join(dir, name), THEIRS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      for (const name of names) fs.writeFileSync(path.join(dir, name), OURS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ours');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const before = await repoState(dir);
      const choices = {};
      for (const name of names) choices[name] = 'ours';
      for (let n = 0; n < 400; n += 1) choices[`${'k'.repeat(508)}${String(n).padStart(4, '0')}`] = 'ours';
      const askedBytes = Buffer.byteLength(JSON.stringify(choices));
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices, expect: clash.at }));
      const answerBytes = Buffer.byteLength(JSON.stringify(answer.value ?? answer.error ?? null));
      check(
        `T33 bounded refusal: the answer is smaller than the question (${answerBytes} vs ${askedBytes} bytes)`,
        answerBytes < askedBytes,
        `${answerBytes} vs ${askedBytes}`
      );
      check(
        'T33 bounded refusal:   with the unusable names counted rather than all listed',
        (answer.value?.badChoices || []).length <= 25,
        String((answer.value?.badChoices || []).length)
      );
      // The count is the finding, so it has to be there.
      check(
        'T33 bounded refusal:   and the count of the rest is on the answer',
        (answer.value?.badChoices || []).some((bad) => Number.isInteger(bad.andMore) && bad.andMore > 300),
        JSON.stringify((answer.value?.badChoices || []).map((bad) => bad.andMore))
      );
      await refusedCleanly('T33 bounded refusal: the call itself', answer.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unknown_path')
      );
    }

    // AND HOW DEEP A NAME IS, NOT ONLY HOW LONG. `check-attr` walks every
    // directory level of a name looking for a `.gitattributes`, so the cost of a
    // name is its depth. MEASURED after the length and count caps were added:
    // 256 names of two thousand levels each — every one inside those caps — took
    // ELEVEN SECONDS before a single key had been checked against the conflicting
    // set, and every one was then refused as `unknown_path` anyway.
    {
      const dir = await widthRepo('deep-keys', null, { base: BASE, ours: OURS, theirs: THEIRS });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const before = await repoState(dir);
      // SHORT SEGMENTS, so the LENGTH cap does not catch these and the DEPTH cap
      // is what has to. The first version of this fixture used `d0/d1/.../d1999`
      // — around ten thousand characters — which MAX_PATH_CHARS excluded on its
      // own, so the check passed with the depth filter deleted.
      const deep = Array.from({ length: 1800 }, () => 'a').join('/');
      const choices = { 'a.txt': 'ours' };
      for (let n = 0; n < 256; n += 1) choices[`${deep}/f${n}.txt`] = 'ours';
      const began = Date.now();
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices, expect: clash.at }));
      const took = Date.now() - began;
      check(`T33 deep keys: answered in ${took}ms rather than eleven seconds`, took < 5000, `${took}ms`);
      await refusedCleanly('T33 deep keys: the call itself', answer.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unknown_path')
      );
    }

    // AND THE WIDTH IS READ PER PATH, FROM GIT, NOT ONCE FOR THE MERGE. Two
    // files in one conflict at two different widths — which is what a
    // .gitattributes with two lines in it produces, and what no single global
    // setting could serve. This is the check that goes red when the width stops
    // being asked of git.
    {
      const dir = await repo('w-mixed');
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt conflict-marker-size=32\n*.md conflict-marker-size=4\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), BASE);
      fs.writeFileSync(path.join(dir, 'b.md'), BASE);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'two files, two widths');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), THEIRS);
      fs.writeFileSync(path.join(dir, 'b.md'), THEIRS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), OURS);
      fs.writeFileSync(path.join(dir, 'b.md'), OURS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ours');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const byPath = Object.fromEntries((clash.files || []).map((f) => [f.path, f]));
      check('T32 mixed: each file carries its own width', byPath['a.txt']?.markerSize === 32 && byPath['b.md']?.markerSize === 4, JSON.stringify(Object.entries(byPath).map(([p, f]) => [p, f.markerSize])));
      check(
        'T32 mixed: both are read as one disagreement each',
        (byPath['a.txt']?.parts || []).filter((p) => p.kind === 'clash').length === 1 &&
          (byPath['b.md']?.parts || []).filter((p) => p.kind === 'clash').length === 1,
        JSON.stringify([byPath['a.txt']?.parts, byPath['b.md']?.parts])
      );
      const answer = await caught(() =>
        resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'], 'b.md': ['ours'] }, expect: clash.at })
      );
      check('T32 mixed: one from each branch merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T32 mixed:   with each file taking exactly the branch it was given',
        (await blob(dir, 'HEAD:a.txt')) === (await blob(dir, 'feature:a.txt')) &&
          (await blob(dir, 'HEAD:b.md')) === (await blob(dir, 'main:b.md')),
        JSON.stringify([await blob(dir, 'HEAD:a.txt'), await blob(dir, 'HEAD:b.md')])
      );
    }

    // THE MERGE ITSELF CAN CHANGE THE ATTRIBUTE THAT DECIDES THE WIDTH, AND THE
    // ANSWER GIT USED IS THE PRE-MERGE ONE.
    //
    // `.gitattributes` is an ordinary tracked file. Asking `check-attr` while
    // the merge is in progress reads the version the merge has just written,
    // which is not the version git resolved attributes against — and the first
    // draft of this change did exactly that. MEASURED, an ordinary branch: the
    // incoming side ADDS `*.txt conflict-marker-size=32`, a.txt clashes, git
    // writes a.txt's markers SEVEN wide because that attribute did not exist
    // when it merged, and check-attr answered 32. The file was then read at 32,
    // found nothing, and a merge that had always worked was refused as
    // unreadable. So the widths are read after the unwind, in the tree git
    // actually merged under.
    {
      const dir = await repo('w-attr-added');
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, 'a.txt'), BASE);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'no attributes at all yet');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt conflict-marker-size=32\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), THEIRS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'the incoming branch adds the attribute');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), OURS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'this branch');
      // What git really did, before anything reads it: seven, because the
      // attribute the incoming branch adds was not in force when it merged.
      const wrote = await widthGitWrote(dir, 'a.txt');
      check('T32 attribute added: git wrote seven-wide markers', wrote.opener === 7 && wrote.middle === 7, JSON.stringify(wrote));
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 attribute added: read at the width git used, not the one it wrote', f.markerSize === 7, String(f.markerSize));
      check('T32 attribute added:   so it is one disagreement, not a refusal', (f.parts || []).filter((p) => p.kind === 'clash').length === 1, JSON.stringify(f.parts));
      const answer = await caught(() =>
        // Only a.txt: git reconciles the added .gitattributes by itself, so it
        // is not a path this merge reported and naming it would be refused as
        // unknown_path — correctly.
        resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at })
      );
      check('T32 attribute added: and the ordinary merge still merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T32 attribute added:   with the incoming bytes exactly',
        (await blob(dir, 'HEAD:a.txt')) === (await blob(dir, 'feature:a.txt')),
        JSON.stringify(await blob(dir, 'HEAD:a.txt'))
      );
    }

    // THE SAME QUESTION WITH `.gitattributes` ITSELF IN THE CONFLICT, which is
    // the hardest version of it: the file that decides the width is one of the
    // files holding markers. MEASURED: 32 on the ancestor, 40 on this branch, 12
    // on the incoming one. Git wrote a.txt's markers FORTY wide — it merged
    // under this branch's attributes — while check-attr, reading the now
    // marked-up .gitattributes off disk afterwards, answers TWELVE. Read before
    // the merge, or after the unwind, the answer is forty and the conflict is an
    // ordinary one.
    //
    // AND THE ONE PATH WHERE THIS STILL CANNOT KNOW. resolveMerge re-runs the
    // merge, so it can only ask about the paths the caller NAMED before running
    // it; a conflicting path left out of `choices` is asked about afterwards,
    // when the answer may be the merge's own. That is deliberate and it is why
    // the backstop exists: the width is then wrong, the markers match nothing,
    // and the path is refused by name with nothing written. Both halves are
    // checked here.
    {
      const build = async (name) => {
        const dir = await repo(name);
        cleanup.push(dir);
        fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt conflict-marker-size=32\n');
        fs.writeFileSync(path.join(dir, 'a.txt'), BASE);
        await sh(dir, 'add', '-A');
        await sh(dir, 'commit', '-qm', 'base');
        await sh(dir, 'checkout', '-qb', 'feature');
        fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt conflict-marker-size=12\n');
        fs.writeFileSync(path.join(dir, 'a.txt'), THEIRS);
        await sh(dir, 'add', '-A');
        await sh(dir, 'commit', '-qm', 'theirs');
        await sh(dir, 'checkout', '-q', 'main');
        fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt conflict-marker-size=40\n');
        fs.writeFileSync(path.join(dir, 'a.txt'), OURS);
        await sh(dir, 'add', '-A');
        await sh(dir, 'commit', '-qm', 'ours');
        return dir;
      };

      const read = await build('w-attrclash-read');
      const wrote = await widthGitWrote(read, 'a.txt');
      check('T32 attribute clash: git wrote this branch’s width of forty', wrote.opener === 40 && wrote.middle === 40, JSON.stringify(wrote));
      const clash = await mergeBranch(git, { projectPath: read, branch: 'feature' });
      check('T32 attribute clash: both files conflict', (clash.files || []).length === 2, JSON.stringify((clash.files || []).map((x) => x.path)));
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 attribute clash: a.txt is read at forty, not at the twelve the merge wrote', f.markerSize === 40, String(f.markerSize));
      check('T32 attribute clash:   so it is one disagreement', (f.parts || []).filter((p) => p.kind === 'clash').length === 1, JSON.stringify(f.parts));
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: read, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T32 attribute clash MCP: markers read', mcpFile.markersUnread === false && (mcpFile.hunks || []).length === 1, JSON.stringify(mcpFile));

      // NAMED — the width is read before the trial merge and the answer applies.
      const named = await build('w-attrclash-named');
      const namedClash = await mergeBranch(git, { projectPath: named, branch: 'feature' });
      const namedAnswer = await caught(() =>
        resolveMerge(git, { projectPath: named, branch: 'feature', choices: { 'a.txt': ['theirs'], '.gitattributes': 'ours' }, expect: namedClash.at })
      );
      check('T32 attribute clash: the answer that names the path merges', namedAnswer.value?.ok === true, JSON.stringify(namedAnswer.value || namedAnswer.error));
      check(
        'T32 attribute clash:   with the incoming bytes exactly',
        (await blob(named, 'HEAD:a.txt')) === (await blob(named, 'feature:a.txt')),
        JSON.stringify(await blob(named, 'HEAD:a.txt'))
      );

      // NOT NAMED — the width can only be read afterwards, and afterwards it is
      // the merge's own. The markers then match nothing, and the documented
      // default of "ours" is refused rather than committed. Nothing is written.
      const unnamed = await build('w-attrclash-unnamed');
      const unnamedClash = await mergeBranch(git, { projectPath: unnamed, branch: 'feature' });
      const before = await repoState(unnamed);
      const unnamedAnswer = await caught(() =>
        resolveMerge(git, { projectPath: unnamed, branch: 'feature', choices: { '.gitattributes': 'ours' }, expect: unnamedClash.at })
      );
      await refusedCleanly('T32 attribute clash: the default, for a path the call never named', unnamedAnswer.value, unnamed, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict' && b.path === 'a.txt')
      );
    }

    // T33 — A LINE OF SOURCE THAT LOOKS LIKE PART OF A MARKER, INSIDE THE BLOCK
    // GIT WROTE.
    //
    // Git does NOT widen its own markers to avoid colliding with the file's
    // text — MEASURED: at the default width it wrote a second `<<<<<<< HEAD`
    // directly under one already in the file — which is exactly why
    // `conflict-marker-size` exists and why this branch now supports it. Until
    // this, the parse walked a block with two booleans ("seen the separator
    // yet", "seen the ancestor line yet") and took the FIRST line matching
    // either as git's. A file whose own text contains such a line was then not
    // parsed worse; it was parsed WRONG, and it committed.
    //
    // Three shapes, all measured against real git, all `{ok: true}` before:
    //
    //   A bare `=======` line inside the region. Both branches adding a section
    //   whose text contains one gave the block `<<< / Title / ======= / OURS /
    //   ||| / ======= / Other / ======= / THEIRS / >>>`; the first separator was
    //   taken as git's, so the hunk read `ours: "Title"` and
    //   `theirs: "OURS\nOther\nTHEIRS"` — this branch's own OURS line attributed
    //   to the incoming side, with `markersUnread: false` on the envelope — and
    //   `['theirs']` committed "top\nOURS\nOther\nTHEIRS\nbottom\n", equal to
    //   NEITHER branch.
    //
    //   A `||||||| note` line inside this branch's side. Everything after it
    //   became the ancestor, so the hunk lost a line of ours: answering `ours`
    //   would have written a file this branch never had.
    //
    //   A `>>>>>>> quoted in the text` line inside the incoming side. It closed
    //   the block early, the two sides happened to read correctly, and git's
    //   REAL closer fell into the agreed text — `['theirs']` committed
    //   "top\nTHEIRS\nMORE\n>>>>>>> feature\nbottom\n": a conflict marker
    //   written into the source, ok: true, HEAD moved. `unreadMarkers` could not
    //   see it, because it looked only for openers and the opener had been
    //   consumed.
    //
    // Git writes one shape: opener, optional ancestor line, separator, closer,
    // all at one width and in that order. Anything else is a block whose
    // structure cannot be decided from the text, and it is now kept whole and
    // refused rather than guessed at. The remedy for a project that hits this is
    // the attribute — which is the thing the rest of T32 is about.

    const colliding = [
      {
        key: 'separator',
        what: 'a bare seven-equals line inside the region',
        base: 'top\nbottom\n',
        ours: 'top\nTitle\n=======\nOURS\nbottom\n',
        theirs: 'top\nOther\n=======\nTHEIRS\nbottom\n',
        // The line git's own markup must contain for the fixture to be the one
        // this is about.
        inMarkup: (text) => (text.match(/(?:^|\n)=======(?:\n|$)/g) || []).length > 1,
      },
      {
        key: 'ancestor',
        what: 'a seven-pipe line inside this branch’s side',
        base: 'top\nbottom\n',
        ours: 'top\nX\n||||||| note\nOURS\nbottom\n',
        theirs: 'top\nY\nTHEIRS\nbottom\n',
        inMarkup: (text) => (text.match(/(?:^|\n)\|{7} /g) || []).length > 1,
      },
      {
        key: 'closer',
        what: 'a seven-angle closer line inside the incoming side',
        base: 'top\nBASE\nbottom\n',
        ours: 'top\nOURS\nbottom\n',
        theirs: 'top\nTHEIRS\n>>>>>>> quoted in the text\nMORE\nbottom\n',
        inMarkup: (text) => (text.match(/(?:^|\n)>{7} /g) || []).length > 1,
      },
    ];

    for (const c of colliding) {
      // THE FIXTURE IS THE ONE THIS IS ABOUT — git really did put that line
      // inside its own block. Asked of git, not assumed.
      const probe = await collide(`collide-${c.key}-probe`, c);
      const markup = await widthGitWrote(probe, 'a.txt');
      void markup;
      await sh(probe, '-c', 'merge.conflictStyle=diff3', 'merge', '--no-commit', '--no-ff', '--no-edit', '--', 'feature').catch(() => {});
      const wrote = textOf(path.join(probe, 'a.txt')) || '';
      await sh(probe, 'merge', '--abort').catch(() => {});
      check(`T33 ${c.what}: git's own markup really contains it twice`, c.inMarkup(wrote), JSON.stringify(wrote));

      const dir = await collide(`collide-${c.key}`, c);
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check(`T33 ${c.what}: the agent is told the markers went unread`, mcpFile.markersUnread === true && mcpFile.hunks === null, JSON.stringify(mcpFile));
      check(`T33 ${c.what}:   and not one line of the file is lost from the parse`, (f.parts || []).map((p) => p.text).join('\n').includes('bottom'), JSON.stringify(f.parts));
      const before = await repoState(dir);
      for (const answer of [{ 'a.txt': 'ours' }, { 'a.txt': 'theirs' }, { 'a.txt': ['theirs'] }, {}]) {
        const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: answer, expect: clash.at }));
        await refusedCleanly(`T33 ${c.what}: ${JSON.stringify(answer)}`, out.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
        );
      }
    }

    // AND THE CONTROL THIS MUST NOT BREAK. The same character, in the AGREED
    // text between two blocks, is ordinary content — git put it outside its
    // markers and there is nothing ambiguous about it. Refusing here would be a
    // false refusal invented rather than inherited, and it is the shape a
    // Markdown file with a setext underline in it actually has.
    {
      const dir = await collide('collide-control', {
        base: 'top\nA\n=======\nB\nbottom\n',
        ours: 'top\nA1\n=======\nB1\nbottom\n',
        theirs: 'top\nA2\n=======\nB2\nbottom\nEXTRA\n',
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const hunks = (f.parts || []).filter((p) => p.kind === 'clash');
      check('T33 control: a separator-shaped line in the AGREED text is content', hunks.length === 2, JSON.stringify(f.parts));
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      check('T33 control:   and the markers are read', ((mcp?.files || [])[0] || {}).markersUnread === false, JSON.stringify((mcp?.files || [])[0]));
      const answer = await caught(() =>
        resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs', 'theirs'] }, expect: clash.at })
      );
      check('T33 control: it merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T33 control:   with the incoming bytes exactly, that line included',
        (await blob(dir, 'HEAD:a.txt')) === (await blob(dir, 'feature:a.txt')),
        JSON.stringify(await blob(dir, 'HEAD:a.txt'))
      );
    }

    // A PAGE THAT SHOWS A READER WHAT A CONFLICT LOOKS LIKE.
    //
    // The three shapes T33 covers are all lines INSIDE git's block. This is the
    // fourth, and it is the one that reads as an ordinary conflict: prose
    // containing a complete `<<<<<<< / ======= / >>>>>>>` example — the DEFAULT
    // conflict style, which is what anybody writing such a page writes —
    // identical on both branches, so git leaves it outside its markers
    // altogether. MEASURED: the authored block parsed as a conflict of its own,
    // TWO hunks were reported where git wrote one, `markersUnread` was false,
    // and answering them committed the prose rewritten — a file equal to
    // neither branch — as `{ok: true, resolved: 1}`.
    //
    // Git under diff3 writes an ancestor line into every block it makes, and
    // Stacki merges with nothing else, so a block without one is not one of
    // git's. See parseConflict.
    {
      const PROSE = ['A merge conflict looks like this:', '<<<<<<< HEAD', 'yours', '=======', 'theirs', '>>>>>>> other', ''].join('\n');
      const dir = await collide('authored-example', {
        base: `${PROSE}Intro\nBASE\nEnd\n`,
        ours: `${PROSE}Intro\nOURS\nEnd\n`,
        theirs: `${PROSE}Intro\nTHEIRS\nEnd\n`,
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T33 authored example: the agent is told the markers went unread', mcpFile.markersUnread === true && mcpFile.hunks === null, JSON.stringify(mcpFile));
      check(
        'T33 authored example:   with the prose still in the parse, verbatim',
        (f.parts || []).some((part) => part.kind === 'same' && part.text.includes('<<<<<<< HEAD')),
        JSON.stringify(f.parts).slice(0, 300)
      );
      const before = await repoState(dir);
      for (const answer of [{ 'a.txt': ['ours', 'ours'] }, { 'a.txt': ['theirs', 'theirs'] }, { 'a.txt': 'theirs' }, {}]) {
        const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: answer, expect: clash.at }));
        await refusedCleanly(`T33 authored example: ${JSON.stringify(answer)}`, out.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
        );
      }
    }

    // A SEPARATOR THE COMMON ANCESTOR ITSELF CONTAINS, which no authored marker
    // is needed for: a Markdown setext underline or a divider comment in the
    // version both branches started from, and both branches changing the lines
    // around it. Git then writes TWO separators into one block, and taking the
    // first bound the ancestor's own lines and a conflict separator to the
    // incoming branch.
    {
      const dir = await collide('ancestor-separator', {
        base: 'top\nX\n=======\nY\nbottom\n',
        ours: 'top\nOURS\nbottom\n',
        theirs: 'top\nTHEIRS\nbottom\n',
      });
      await sh(dir, '-c', 'merge.conflictStyle=diff3', 'merge', '--no-commit', '--no-ff', '--no-edit', '--', 'feature').catch(() => {});
      const markup = textOf(path.join(dir, 'a.txt')) || '';
      await sh(dir, 'merge', '--abort').catch(() => {});
      check(
        'T33 ancestor separator: git really writes two separators into one block',
        (markup.match(/(?:^|\n)={7}(?:\n|$)/g) || []).length === 2 && (markup.match(/(?:^|\n)<{7} /g) || []).length === 1,
        JSON.stringify(markup)
      );
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const mcpFile = (mcp?.files || []).find((x) => x.path === 'a.txt') || {};
      check('T33 ancestor separator: reported unread rather than split at the wrong line', mcpFile.markersUnread === true && mcpFile.hunks === null, JSON.stringify(mcpFile));
      const before = await repoState(dir);
      for (const answer of [{ 'a.txt': ['theirs'] }, { 'a.txt': 'theirs' }, {}]) {
        const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: answer, expect: clash.at }));
        await refusedCleanly(`T33 ancestor separator: ${JSON.stringify(answer)}`, out.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
        );
      }
    }

    // ONE NAME GIT WILL NOT ANSWER FOR MUST NOT COST THE NAMES BESIDE IT.
    //
    // `check-attr` dies on the whole invocation for a path outside the
    // repository — MEASURED: `check-attr … -- a.txt ../outside` exits 128 having
    // already printed a.txt's row — so a batch containing one such name used to
    // take git's default width for every real conflict in it. Asked one at a
    // time after a batch fails, the bad name costs only itself.
    {
      const dir = await widthRepo('retry-batch', '*.txt conflict-marker-size=32\n', { base: BASE, ours: OURS, theirs: THEIRS });
      const clean = await conflictMarkerSizes(git, dir, ['a.txt']);
      check('T33 per-name retry: a list git can answer for is answered', clean.get('a.txt') === 32, JSON.stringify([...clean]));
      // The same list with a name git refuses in it. Without the retry the whole
      // batch is lost and a.txt is absent from the map.
      const poisoned = await conflictMarkerSizes(git, dir, ['a.txt', '../outside.txt']);
      check('T33 per-name retry: and still answered when a bad name is beside it', poisoned.get('a.txt') === 32, JSON.stringify([...poisoned]));
      check('T33 per-name retry:   with the bad name simply absent', !poisoned.has('../outside.txt'), JSON.stringify([...poisoned]));
    }

    // A REFUSAL MUST NOT BE BIGGER THAN THE CALL THAT PROVOKED IT, AND MUST NOT
    // DECIDE HOW MANY GIT PROCESSES STACKI STARTS.
    //
    // `choices` is a record with no cap on how many keys it has or how long they
    // are, and the pre-merge width read runs BEFORE any key has been checked
    // against the conflicting set. MEASURED before this was bounded: 200 keys of
    // 100,000 characters, with one out-of-repository name to force the per-name
    // retry, held the git side of the editor for 87 SECONDS and answered with a
    // 40 MB refusal — twice the request — which the envelope then sends twice.
    {
      const dir = await widthRepo('hostile-choices', '*.txt conflict-marker-size=32\n', { base: BASE, ours: OURS, theirs: THEIRS });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const before = await repoState(dir);
      const choices = { 'a.txt': 'ours' };
      for (let n = 0; n < 200; n += 1) choices[`${'x'.repeat(100000)}${n}`] = 'ours';
      choices['../outside.txt'] = 'ours';
      const askedBytes = Buffer.byteLength(JSON.stringify(choices));
      const began = Date.now();
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices, expect: clash.at }));
      const took = Date.now() - began;
      const answerBytes = Buffer.byteLength(JSON.stringify(answer.value ?? answer.error ?? null));
      check(`T33 hostile choices: answered in ${took}ms rather than a minute and a half`, took < 20000, `${took}ms`);
      check(
        `T33 hostile choices: the refusal is smaller than the request (${answerBytes} vs ${askedBytes} bytes)`,
        answerBytes < askedBytes,
        `${answerBytes} vs ${askedBytes}`
      );
      check(
        'T33 hostile choices:   with no echoed key longer than the clip',
        (answer.value?.badChoices || []).every((bad) => String(bad.path).length <= 600 && String(bad.given).length <= 600),
        JSON.stringify((answer.value?.badChoices || []).map((bad) => String(bad.path).length).slice(0, 5))
      );
      await refusedCleanly('T33 hostile choices: the call itself', answer.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unknown_path')
      );
    }

    // THE WIDTH IS ASKED FROM THE REPOSITORY ROOT, and the layout that proves it
    // is the one repoRoot exists for. `check-attr` spells and scopes its paths
    // from the cwd; git's conflicting paths are spelled from the repository
    // root. Asked from a project inside a larger repository, "site/a.txt" means
    // <root>/site/site/a.txt — a path that does not exist, answered
    // "unspecified", and the whole width feature quietly switches off for the
    // one layout it was hardest to get right in.
    {
      const dir = await repo('w32-subdir');
      cleanup.push(dir);
      fs.mkdirSync(path.join(dir, 'site'), { recursive: true });
      // ANCHORED TO THE SUBDIRECTORY, which is the only shape in which the cwd
      // changes git's answer. `*.txt` matches at any depth, so check-attr says
      // 32 for `site/page.txt` from the repository root AND from the project —
      // and the mutation this fixture exists to catch stayed green. With
      // `site/*.txt`, asking from `<root>/site` means `<root>/site/site/page.txt`
      // and the answer is "unspecified".
      fs.writeFileSync(path.join(dir, '.gitattributes'), 'site/*.txt conflict-marker-size=32\n');
      fs.writeFileSync(path.join(dir, 'site/page.txt'), BASE);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'a project inside a larger repository');
      await sh(dir, 'checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(dir, 'site/page.txt'), THEIRS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'site/page.txt'), OURS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ours');
      const project = path.join(dir, 'site');
      const clash = await mergeBranch(git, { projectPath: project, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'site/page.txt') || {};
      check('T33 subdirectory project: the width is found for a repo-root-spelled path', f.markerSize === 32, JSON.stringify({ path: f.path, markerSize: f.markerSize }));
      check('T33 subdirectory project:   so the conflict is one disagreement', (f.parts || []).filter((p) => p.kind === 'clash').length === 1, JSON.stringify(f.parts));
      const answer = await caught(() =>
        resolveMerge(git, { projectPath: project, branch: 'feature', choices: { 'site/page.txt': ['theirs'] }, expect: clash.at })
      );
      check('T33 subdirectory project: it merges', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T33 subdirectory project:   with the incoming bytes exactly',
        (await blob(dir, 'HEAD:site/page.txt')) === (await blob(dir, 'feature:site/page.txt')),
        JSON.stringify(await blob(dir, 'HEAD:site/page.txt'))
      );
    }

    // GIT'S READING OF THE ATTRIBUTE, NOT A STRICTER ONE. MEASURED:
    // `conflict-marker-size=+5` makes git write FIVE-character markers with no
    // warning at all — it parses the value with the C integer reader, which
    // takes a sign — while `5x`, `0x10` and `1e3` are refused with a warning and
    // fall back to seven. A digits-only test was both stricter than git and
    // wrong in the one direction that costs a merge.
    {
      const dir = await widthRepo('w-plus-five', '*.txt conflict-marker-size=+5\n', { base: BASE, ours: OURS, theirs: THEIRS });
      const wrote = await widthGitWrote(dir, 'a.txt');
      check('T33 "+5": git writes five-wide markers for it', wrote.opener === 5 && wrote.middle === 5, JSON.stringify(wrote));
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const f = (clash.files || []).find((x) => x.path === 'a.txt') || {};
      check('T33 "+5": Stacki reads it as five too', f.markerSize === 5, String(f.markerSize));
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at }));
      check('T33 "+5": so the merge goes through', answer.value?.ok === true, JSON.stringify(answer.value || answer.error));
      check(
        'T33 "+5":   with the incoming bytes exactly',
        (await blob(dir, 'HEAD:a.txt')) === (await blob(dir, 'feature:a.txt')),
        JSON.stringify(await blob(dir, 'HEAD:a.txt'))
      );
    }

    // A CONFLICTING PATH THE MCP SURFACE CANNOT NAME MUST NOT TAKE THE SILENT
    // DEFAULT.
    //
    // `choices` is `z.record(z.string(), z.unknown())`, and MEASURED with zod
    // 4.4.3: parsing `{"__proto__":"theirs","a.txt":"ours"}` returns an object
    // with ONLY `a.txt` on it — the record is rebuilt by assignment, and
    // assigning `__proto__` sets a prototype instead of making a property. So an
    // agent that answers a file named `__proto__` is answering into a hole.
    //
    // The documented default for a file left out is "keeps this branch's
    // version", and applying it here would be a false success: the caller did
    // say something and it did not arrive. It is refused instead — today by
    // `choices?.['__proto__']` reading back `Object.prototype` and failing the
    // shape check, which is accidental safety and exactly why it is pinned. A
    // change to `Object.hasOwn` anywhere in that validator would turn this into
    // the silent default, and this check is what would say so.
    {
      const dir = await repo('proto-path');
      cleanup.push(dir);
      for (const name of ['__proto__', 'a.txt']) fs.writeFileSync(path.join(dir, name), BASE);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'checkout', '-qb', 'feature');
      for (const name of ['__proto__', 'a.txt']) fs.writeFileSync(path.join(dir, name), THEIRS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      for (const name of ['__proto__', 'a.txt']) fs.writeFileSync(path.join(dir, name), OURS);
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'ours');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      check('T33 __proto__: git reports it as one of the conflicting paths', (clash.files || []).some((f) => f.path === '__proto__'), JSON.stringify((clash.files || []).map((f) => f.path)));
      const before = await repoState(dir);
      // Exactly the object a client's `{"__proto__":"theirs","a.txt":"theirs"}`
      // becomes after the schema has parsed it.
      const survived = { 'a.txt': 'theirs' };
      const answer = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: survived, expect: clash.at }));
      await refusedCleanly('T33 __proto__: the answer that could not carry it', answer.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.path === '__proto__')
      );
    }
  }

  {
    // T34 — "THE MERGE WAS UNWOUND, SO THE PROJECT IS EXACTLY AS IT WAS", SAID
    // BY THE ONE REFUSAL THAT NEVER LOOKED.
    //
    // resolveMerge has measured its unwind since T30: `merge --abort` is fired,
    // and if a merge is still in progress or the working tree is not back where
    // it was, the answer is `merge_stuck` instead of the refusal it was going to
    // give. mergeBranch — which runs the same trial merge, for the same reason,
    // and whose envelope makes the MORE detailed claim — fired the same command
    // into a bare `catch {}`.
    //
    // MEASURED with the abort made to fail the way T30's does, MERGE_HEAD
    // removed at the moment it runs: the envelope said `merge_conflict`,
    // "The merge was unwound, so the project is exactly as it was", and its
    // `note` said the files "hold the pre-merge bytes", over a tree that was
    // still `UU` with `<<<<<<< HEAD` in the page — and `sourcePath`, which that
    // same envelope hands the agent to read the file with, pointed straight at
    // those bytes. The guide's "merge_stuck is the only refusal on this surface
    // that says so" was true only because this one did not look.
    const dir = await repo('merge-unwind');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nBASE\ntail\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'base');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nTHEIRS\ntail\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'theirs');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nOURS\ntail\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'ours');
    const headBefore = await sh(dir, 'rev-parse', 'HEAD');

    // The same shape T30 uses: the abort is really attempted and really fails,
    // with the marked-up tree still there.
    let aborts = 0;
    const abortRefusingGit = async (cwd, args) => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        aborts += 1;
        fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'), { force: true });
      }
      return git(cwd, args);
    };
    const answer = await caught(() => mergeBranch(abortRefusingGit, { projectPath: dir, branch: 'feature' }));
    check('T34: the unwind really was attempted', aborts === 1, String(aborts));
    check(
      'T34: git.merge says merge_stuck rather than describing a conflict',
      answer.value?.ok === false && answer.value?.code === 'merge_stuck',
      JSON.stringify(answer.value || answer.error).slice(0, 300)
    );
    check('T34:   and does NOT claim the project is as it was', !/exactly as it was/.test(String(answer.value?.message || '')), String(answer.value?.message).slice(0, 200));
    check('T34:   naming the file that still holds markers', (answer.value?.files || []).includes('a.txt'), JSON.stringify(answer.value?.files));
    check('T34:   and saying a merge is still in progress', answer.value?.mergeInProgress === true, JSON.stringify(answer.value?.mergeInProgress));
    // The tree really is in the state the refusal describes — this is the check
    // that says the refusal is true rather than merely differently worded.
    check('T34:   the file really does still hold markers', /<<<<<<< /.test(textOf(path.join(dir, 'a.txt')) || ''), JSON.stringify(textOf(path.join(dir, 'a.txt'))));
    check('T34:   with HEAD unmoved', (await sh(dir, 'rev-parse', 'HEAD')) === headBefore);
    // And what the agent is told. The mapper passes an unrecognised git refusal
    // through, so this is the sentence a client actually reads.
    const mapped = DOMAINS.git.merge.result(answer.value, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
    check('T34 MCP: the client is told merge_stuck too', mapped?.code === 'merge_stuck', JSON.stringify(mapped).slice(0, 200));
    check('T34 MCP:   and is not handed a hunk list for a tree in that state', !Array.isArray(mapped?.files) || !mapped.files.some((f) => f && typeof f === 'object'), JSON.stringify(mapped?.files));

    // Put the fixture back so the cleanup accounting is honest.
    await sh(dir, 'merge', '--abort').catch(() => {});
    await sh(dir, 'reset', '--hard', '-q', 'HEAD').catch(() => {});
  }


  // T34b — AND THE CLAIM ABOVE repo() IS CHECKED RATHER THAN ASSERTED.
  //
  // "A developer with `commit.gpgsign = true` set globally would have every
  // fixture in this file fail at its first commit" was written above ONE of the
  // seven builders in this file and true of only that one, because this PR grew
  // the file from one builder to seven and the line was copied nowhere.
  // MEASURED on such a machine: an UNCAUGHT `gpg failed to sign the data` at the
  // first unfixed builder, zero assertions printed, non-zero exit — the exact
  // situation the comment says was removed. A count is what keeps the claim and
  // the file together as more builders are added.
  {
    const own = fs.readFileSync(__filename, 'utf8');
    const identities = (own.match(/'config', 'user\.name'/g) || []).length;
    const unsigned = (own.match(/'config', 'commit\.gpgsign', 'false'/g) || []).length;
    check(
      'T34b: every fixture builder in this file turns commit signing off',
      identities > 0 && identities === unsigned,
      `${identities} builders, ${unsigned} of them unsigned`
    );
  }

  // T35 — A PATH GIT SAYS IS CONFLICTED IS NOT AUTOMATICALLY A UTF-8 FILE
  // SITTING AT THAT PATH.
  //
  // Two premises held everywhere hunks are built and applied, and neither was
  // ever checked. Both were MEASURED to commit bytes neither branch wrote.
  //
  //   1. THE BYTES ARE UTF-8. Git calls a file text when it finds no NUL in
  //      the first 8000 bytes, so a Latin-1 page conflicts and is marked up
  //      like any other. The read was `fs.readFileSync(..., 'utf8')`, whose
  //      decoder answers U+FFFD for every byte it cannot decode and never
  //      says so, and the rebuild wrote the replacements back — on lines
  //      IDENTICAL IN BOTH BRANCHES, outside git's markers. MEASURED:
  //      `<p>caf\xE9</p>` came back `<p>caf\xEF\xBF\xBD</p>` in a two-parent
  //      merge commit, `{ok: true, changed: true, resolved: 1}`, clean status.
  //
  //   2. THE PATH IS THE FILE. `readFileSync`/`writeFileSync` follow symlinks,
  //      and git reports a conflicted link as an ordinary unmerged path. An
  //      add/add on a link was read THROUGH: the hunks offered for the link
  //      were the TARGET's, and answering them rewrote a file the merge never
  //      touched. MEASURED: an untouched docs/notes.md cut from nine lines to
  //      three, " M docs/notes.md" after a merge that reported ok, and
  //      HEAD:link still the OURS target although "theirs" was asked for —
  //      `git add -- link` stages the link, so the answer was discarded.
  //
  // The answer is one helper, conflictText: O_NOFOLLOW, must be a regular
  // file, and the decoded string must encode back to the same bytes. It
  // answers null, which is what this code already answers for a binary file —
  // no hunks, whole-file only, and a per-hunk answer refused `not_splittable`.
  // The whole-file answers keep working because those are `git checkout
  // --ours`, where git does its own reading.
  {
    const latin1 = async (name) => {
      const dir = await repo(name);
      cleanup.push(dir);
      const head = Buffer.from('<p>caf\xE9</p>\n', 'latin1');
      const put = (tail) => fs.writeFileSync(path.join(dir, 'page.html'), Buffer.concat([head, Buffer.from(tail)]));
      put('<h1>BASE</h1>\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'branch', 'feature');
      put('<h1>MAIN</h1>\n');
      await sh(dir, 'commit', '-qam', 'ours');
      await sh(dir, 'checkout', '-q', 'feature');
      put('<h1>FEATURE</h1>\n');
      await sh(dir, 'commit', '-qam', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      return dir;
    };
    // The suite's own `git` stringifies stdout, which is exactly the decode
    // this block exists to catch — so the oracle reads bytes for itself.
    const raw = (dir, rev) =>
      new Promise((done, fail) =>
        execFile('git', ['show', '--end-of-options', rev], { cwd: dir, encoding: 'buffer', maxBuffer: 1 << 26 }, (err, stdout) =>
          err ? fail(err) : done(Buffer.from(stdout))
        )
      );

    // THE FILE IS STILL REPORTED — it is conflicted and the agent has to hear
    // about it — but with no hunk list, exactly like a binary file.
    {
      const dir = await latin1('latin1-report');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const file = (clash.files || []).find((f) => f.path === 'page.html');
      check('T35 latin-1: the conflicting page is reported', !!file, JSON.stringify((clash.files || []).map((f) => f.path)));
      check('T35 latin-1:   with no text to split', file?.text === null || file?.text === undefined, JSON.stringify(String(file?.text).slice(0, 60)));
      check('T35 latin-1:   and no hunks', clashCount(file?.parts || []) === 0, String(clashCount(file?.parts || [])));
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const entry = (mcp?.files || []).find((f) => f.path === 'page.html') || {};
      // `[]`, not null: no hunks are offered, but both sides exist and a
      // whole-file word answers it. See T38, which is about that distinction.
      check('T35 latin-1:   the agent is told no hunks are offered', Array.isArray(entry.hunks) && entry.hunks.length === 0, JSON.stringify(entry));
      check('T35 latin-1:   and not that they were dropped for size', entry.hunksOmitted === false, JSON.stringify(entry));
    }

    // A PER-HUNK ANSWER IS REFUSED BY NAME, and the refusal costs nothing.
    {
      const dir = await latin1('latin1-per-hunk');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const before = await repoState(dir);
      for (const answer of [['ours'], ['theirs'], ['ours', 'theirs'], ['merged']]) {
        const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'page.html': answer }, expect: clash.at }));
        await refusedCleanly(`T35 latin-1: per-hunk ${JSON.stringify(answer)}`, out.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.path === 'page.html' && b.reason === 'not_splittable')
        );
      }
    }

    // AND THE WHOLE-FILE ANSWER IS BYTE-EXACT, BOTH DIRECTIONS. This is the
    // answer the refusal above sends the caller to, so it had better be right:
    // the high byte survives, the merge has two parents, and nothing is left
    // over. Answered against `git show`, not against a string this test built.
    for (const [side, rev] of [['ours', 'main:page.html'], ['theirs', 'feature:page.html']]) {
      const dir = await latin1(`latin1-${side}`);
      const want = await raw(dir, rev);
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'page.html': side }, expect: clash.at });
      const got = await raw(dir, 'HEAD:page.html');
      check(`T35 latin-1: whole-file ${side} merges`, out?.ok === true, JSON.stringify(out));
      check(`T35 latin-1:   the committed bytes are ${side}, exactly`, Buffer.compare(want, got) === 0, `${want.toString('hex')} vs ${got.toString('hex')}`);
      check(`T35 latin-1:   the 0xE9 survived`, got.includes(0xe9) && !got.includes(Buffer.from([0xef, 0xbf, 0xbd])), got.toString('hex'));
      const parents = (await sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length - 1;
      check(`T35 latin-1:   as a merge with two parents`, parents === 2, String(parents));
      check(`T35 latin-1:   over a clean tree`, (await sh(dir, 'status', '--porcelain')) === '', await sh(dir, 'status', '--porcelain'));
    }

    // THE CONTROL THIS MUST NOT COST — a UTF-8 file with multibyte characters
    // in it round-trips, so it still splits and still merges per hunk. Without
    // this, "refuse anything with a high byte" would pass everything above.
    {
      const dir = await repo('utf8-multibyte');
      cleanup.push(dir);
      const put = (tail) => fs.writeFileSync(path.join(dir, 'a.txt'), `café ☕\n${tail}\n`);
      put('BASE');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'branch', 'feature');
      put('OURS');
      await sh(dir, 'commit', '-qam', 'ours');
      await sh(dir, 'checkout', '-q', 'feature');
      put('THEIRS');
      await sh(dir, 'commit', '-qam', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const hunks = clashCount(clash.files[0]?.parts || []);
      check('T35 control: a multibyte UTF-8 file still splits', hunks === 1, String(hunks));
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': Array(hunks).fill('ours') }, expect: clash.at });
      const got = await raw(dir, 'HEAD:a.txt');
      check('T35 control:   and merges per hunk', out?.ok === true && out.resolved === 1, JSON.stringify(out));
      check('T35 control:   with its bytes intact', got.equals(Buffer.from('café ☕\nOURS\n', 'utf8')), got.toString('hex'));
    }

    // A CONFLICTED SYMLINK. Two branches point the same link somewhere
    // different, and the one this branch points at is a documentation file
    // that shows what a conflict looks like — which is what made the read
    // through it produce hunks rather than nothing.
    const NOTES = 'A conflict looks like:\n<<<<<<< HEAD\nours line\n||||||| base\nbase line\n=======\ntheirs line\n>>>>>>> other\nend\n';

    {
      const dir = await linked('symlink-report', { ours: 'docs/notes.md', theirs: 'elsewhere' });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const file = (clash.files || []).find((f) => f.path === 'link');
      check('T35 symlink: the conflicting link is reported', !!file, JSON.stringify((clash.files || []).map((f) => f.path)));
      check('T35 symlink:   with no hunks of the file it points at', clashCount(file?.parts || []) === 0, String(clashCount(file?.parts || [])));
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const entry = (mcp?.files || []).find((f) => f.path === 'link') || {};
      check('T35 symlink:   the agent is told no hunks are offered', Array.isArray(entry.hunks) && entry.hunks.length === 0, JSON.stringify(entry));
      const before = await repoState(dir);
      for (const answer of [['ours'], ['theirs']]) {
        const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { link: answer }, expect: clash.at }));
        await refusedCleanly(`T35 symlink: per-hunk ${JSON.stringify(answer)}`, out.value, dir, before, 'bad_choices', (a) =>
          (a.badChoices || []).some((b) => b.path === 'link' && b.reason === 'not_splittable')
        );
        check('T35 symlink:   and the file it points at is untouched', fs.readFileSync(path.join(dir, 'docs', 'notes.md'), 'utf8') === NOTES);
      }
    }

    // THE WHOLE-FILE ANSWER FOR A LINK IS HONOURED — this is the one that used
    // to be silently discarded, answering "ours" to a caller who asked for
    // "theirs" under ok: true.
    for (const side of ['ours', 'theirs']) {
      const dir = await linked(`symlink-${side}`, { ours: 'docs/notes.md', theirs: 'elsewhere' });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { link: side }, expect: clash.at });
      const target = (await sh(dir, 'show', 'HEAD:link')).trim();
      check(`T35 symlink: whole-file ${side} merges`, out?.ok === true, JSON.stringify(out));
      check(`T35 symlink:   and the committed link is the one asked for`, target === (side === 'ours' ? 'docs/notes.md' : 'elsewhere'), target);
      check(`T35 symlink:   the working tree agrees with the commit`, (await sh(dir, 'status', '--porcelain')) === '', await sh(dir, 'status', '--porcelain'));
      check(`T35 symlink:   and the documentation file is byte-for-byte what it was`, fs.readFileSync(path.join(dir, 'docs', 'notes.md'), 'utf8') === NOTES);
    }

    // A LINK OUT OF THE REPOSITORY ENTIRELY. Nothing may be written through it
    // — this is the containment half, and the file it points at is one this
    // repository has no business touching at all.
    {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-outside-'));
      cleanup.push(outside);
      const away = path.join(outside, 'notes.md');
      fs.writeFileSync(away, NOTES);
      const dir = await linked('symlink-escape', { ours: away, theirs: 'elsewhere' });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const file = (clash.files || []).find((f) => f.path === 'link');
      check('T35 escape: a link out of the repository offers no hunks', clashCount(file?.parts || []) === 0, String(clashCount(file?.parts || [])));
      const before = await repoState(dir);
      const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { link: ['theirs'] }, expect: clash.at }));
      await refusedCleanly('T35 escape: per-hunk through a link that leaves the repository', out.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.path === 'link' && b.reason === 'not_splittable')
      );
      check('T35 escape:   and the file outside is byte-for-byte what it was', fs.readFileSync(away, 'utf8') === NOTES);
      const ok = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { link: 'theirs' }, expect: clash.at });
      check('T35 escape:   the whole-file answer still merges', ok?.ok === true, JSON.stringify(ok));
      check('T35 escape:   and STILL did not write outside', fs.readFileSync(away, 'utf8') === NOTES);
    }

    // A FIFO AT A CONFLICTED PATH. What is on disk when the resolve runs is
    // whatever is on disk, not what git put there — and opening a FIFO for
    // reading BLOCKS until somebody opens the other end. Without O_NONBLOCK
    // this held the editor's git path forever; whitespaceRules.js records the
    // same measurement for its own reader (`mkfifo site.css`).
    {
      const dir = await collide('fifo-path', { base: 'head\nBASE\ntail\n', ours: 'head\nOURS\ntail\n', theirs: 'head\nTHEIRS\ntail\n' });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      check('T35 fifo: the fixture conflicts to begin with', clashCount((clash.files || [])[0]?.parts || []) === 1);
      // Replace the marked-up file with a FIFO between the merge and the
      // answer, which is the only window in which this can happen.
      const at = path.join(dir, 'a.txt');
      fs.rmSync(at, { force: true });
      const made = await caught(() => new Promise((done, fail) => execFile('mkfifo', [at], (err) => (err ? fail(err) : done(true)))));
      if (made.error === null) {
        const answered = await Promise.race([
          caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['ours'] }, expect: clash.at })),
          new Promise((done) => setTimeout(() => done({ error: null, value: { code: 'BLOCKED FOREVER' } }), 15000)),
        ]);
        check('T35 fifo: the resolve answers rather than blocking on the open', answered.value?.code !== 'BLOCKED FOREVER', JSON.stringify(answered.value).slice(0, 200));
        check('T35 fifo:   and refuses, because a FIFO has no text to split', answered.value?.ok === false, JSON.stringify(answered.value).slice(0, 200));
      }
      fs.rmSync(at, { force: true });
      await sh(dir, 'merge', '--abort').catch(() => {});
      await sh(dir, 'reset', '--hard', '-q', 'HEAD').catch(() => {});
    }

    // THE DIGEST MEASURED THE WRONG FILE TOO. conflictDigest read through the
    // link, so the same link over two different targets was one measurement —
    // and `stale_merge` is the check that is supposed to notice the tree moved
    // under an answer.
    {
      const one = await linked('symlink-digest-a', { ours: 'docs/notes.md', theirs: 'elsewhere' });
      const two = await linked('symlink-digest-b', { ours: 'docs/notes.md', theirs: 'somewhere-else' });
      const a = await mergeBranch(git, { projectPath: one, branch: 'feature' });
      const b = await mergeBranch(git, { projectPath: two, branch: 'feature' });
      check('T35 digest: two links with different incoming targets are two conflicts', a.at !== b.at, `${a.at} vs ${b.at}`);
    }
  }

  // T36 — MARKUP A `merge=<driver>` PATH CAME BACK WITH IS THE DRIVER'S, NOT
  // GIT'S, AND THE ANCESTOR-LINE RULE DOES NOT HOLD FOR IT.
  //
  // The diff3 reading is entitled to one thing: Stacki merges with
  // `-c merge.conflictStyle=diff3` and git writes the ancestor line into every
  // block IT writes. A `merge=<driver>` attribute hands the path to a program
  // of the project's own, and what comes back is that program's markup —
  // possibly the ordinary two-marker block, possibly no markers at all.
  //
  // MEASURED before this: with `a.txt merge=twomark` and a driver that writes
  // the two-marker block, a merge Stacki ran with diff3 left exactly that on
  // disk, the ancestor-line rule refused to read it, `unreadMarkers` fired, and
  // EVERY answer for the path came back `unreadable_conflict` — including the
  // whole-file "ours" that never touches the markup. Pre-PR the same bytes read
  // as one hunk, so the PR made such a repository unmergeable through Stacki.
  //
  // Git can be asked which paths those are (`check-attr merge`), so it is
  // asked — attribute truth, not a loosened rule for every path. See
  // mergeAttributes.
  {
    const driven = async (name, driver) => {
      const dir = await repo(name);
      cleanup.push(dir);
      await sh(dir, 'config', 'merge.twomark.name', 'a driver of the project`s own');
      await sh(dir, 'config', 'merge.twomark.driver', driver);
      fs.writeFileSync(path.join(dir, '.gitattributes'), 'a.txt merge=twomark\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nBASE\ntail\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'branch', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nOURS\ntail\n');
      await sh(dir, 'commit', '-qam', 'ours');
      await sh(dir, 'checkout', '-q', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'head\nTHEIRS\ntail\n');
      await sh(dir, 'commit', '-qam', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      return dir;
    };
    const TWO_MARKER = 'printf "head\\n<<<<<<< ours\\nOURS\\n=======\\nTHEIRS\\n>>>>>>> theirs\\ntail\\n" > %A; exit 1';

    // THE PREMISE, MEASURED FIRST: git really does leave a two-marker block
    // here, out of a merge run with diff3. Without this the assertions below
    // could be passing over a fixture whose driver never ran.
    {
      const dir = await driven('driver-premise', TWO_MARKER);
      await git(dir, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-commit', 'feature']).catch(() => {});
      const wrote = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
      check('T36 premise: the driver ran and wrote its own markup', wrote.includes('<<<<<<< ours') && !wrote.includes('|||||||'), JSON.stringify(wrote));
      check('T36 premise:   and git says the path has a driver', (await sh(dir, 'check-attr', 'merge', '--', 'a.txt')) === 'a.txt: merge: twomark', await sh(dir, 'check-attr', 'merge', '--', 'a.txt'));
      await sh(dir, 'merge', '--abort').catch(() => {});
    }

    {
      const dir = await driven('driver-reads', TWO_MARKER);
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const file = (clash.files || []).find((f) => f.path === 'a.txt') || {};
      check('T36 driver: the two-marker block reads as one disagreement', clashCount(file.parts || []) === 1, String(clashCount(file.parts || [])));
      check('T36 driver:   and is not reported as unreadable', unreadMarkers(file.parts || [], file.markerSize) === false);
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const entry = (mcp?.files || []).find((f) => f.path === 'a.txt') || {};
      check('T36 driver:   the agent is given the hunk', Array.isArray(entry.hunks) && entry.hunks.length === 1, JSON.stringify(entry).slice(0, 200));
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['theirs'] }, expect: clash.at });
      check('T36 driver:   and the per-hunk answer merges', out?.ok === true && out.resolved === 1, JSON.stringify(out));
      check('T36 driver:   into the bytes it asked for', (await sh(dir, 'show', 'HEAD:a.txt')) === 'head\nTHEIRS\ntail', JSON.stringify(await sh(dir, 'show', 'HEAD:a.txt')));
      check('T36 driver:   over a clean tree', (await sh(dir, 'status', '--porcelain')) === '', await sh(dir, 'status', '--porcelain'));
    }

    // THE WHOLE-FILE ANSWER TOO, both directions.
    for (const side of ['ours', 'theirs']) {
      const dir = await driven(`driver-${side}`, TWO_MARKER);
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': side }, expect: clash.at });
      check(`T36 driver: whole-file ${side} merges`, out?.ok === true, JSON.stringify(out));
      check(`T36 driver:   into ${side}`, (await sh(dir, 'show', 'HEAD:a.txt')) === `head\n${side.toUpperCase()}\ntail`, JSON.stringify(await sh(dir, 'show', 'HEAD:a.txt')));
    }

    // A DRIVER THAT LEAVES NO MARKERS AT ALL still has to come back as a path
    // with no hunks rather than as a misread one — this is the `union` shape,
    // and it is why the rule keys on the attribute rather than on the markup.
    {
      const dir = await driven('driver-silent', 'printf "head\\nBOTH\\ntail\\n" > %A; exit 1');
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const file = (clash.files || []).find((f) => f.path === 'a.txt') || {};
      check('T36 driver: markup with no markers offers no hunks', clashCount(file.parts || []) === 0, String(clashCount(file.parts || [])));
      const before = await repoState(dir);
      const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['ours'] }, expect: clash.at }));
      await refusedCleanly('T36 driver: a per-hunk answer for it', out.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.path === 'a.txt' && b.reason === 'wrong_length')
      );
      const ok = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at });
      check('T36 driver:   and the whole-file answer merges', ok?.ok === true, JSON.stringify(ok));
    }

    // THE CONTROL THIS MUST NOT COST. The ancestor-line rule still holds for
    // every path git DID merge: a two-marker block on a path with no driver is
    // still not something git wrote under diff3, and is still refused. Without
    // this, "always read the forgiving way" passes every assertion above.
    {
      const dir = await collide('no-driver-two-marker', {
        base: 'A conflict looks like this:\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nIntro\nBASE\nEnd\n',
        ours: 'A conflict looks like this:\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nIntro\nOURS\nEnd\n',
        theirs: 'A conflict looks like this:\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nIntro\nTHEIRS\nEnd\n',
      });
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const file = (clash.files || []).find((f) => f.path === 'a.txt') || {};
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      const entry = (mcp?.files || []).find((f) => f.path === 'a.txt') || {};
      check('T36 control: an authored block on a path with no driver is still unreadable', entry.markersUnread === true && entry.hunks === null, JSON.stringify(entry).slice(0, 200));
      const before = await repoState(dir);
      const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at }));
      await refusedCleanly('T36 control: and every answer for it is refused', out.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
      );

      // AND THE REFUSAL SAYS TRUE THINGS ABOUT THE TREE IT LEFT. It used to say
      // the file "still holds conflict markers", composed AFTER the unwind — so
      // an agent sent to look at the file found the pre-merge bytes and a clean
      // `git status`, and could reasonably conclude the conflict was gone.
      const said = String(out.value?.message || '');
      check('T36 refusal: does not claim the file still holds markers', !/still holds conflict markers/.test(said), said.slice(0, 300));
      check('T36 refusal:   says the merge was unwound', /unwound/.test(said), said.slice(0, 400));
      check('T36 refusal:   and names the way out', /conflict-marker-size/.test(said), said.slice(0, 500));
      check('T36 refusal:   which the tree agrees with', (await sh(dir, 'status', '--porcelain')) === '' && !/^<<<<<<< HEAD$/m.test(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').split('\n').slice(6).join('\n')));
    }
  }

  // T37 — A REFUSAL MUST NOT DESCRIBE AN ACT THE READER DID NOT PERFORM.
  //
  // `unwindGuard` is shared by both callers, and its stuck-merge sentence said
  // "the merge Stacki ran to check those answers" for both. mergeBranch is
  // given no answers at all — somebody asked to merge a branch — so a user who
  // hit a stuck unwind there was told about answers nobody had given.
  {
    const dir = await collide('stuck-wording', { base: 'head\nBASE\ntail\n', ours: 'head\nOURS\ntail\n', theirs: 'head\nTHEIRS\ntail\n' });
    let aborts = 0;
    const abortRefusingGit = async (cwd, args) => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        aborts += 1;
        fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'), { force: true });
      }
      return git(cwd, args);
    };
    const stuck = await caught(() => mergeBranch(abortRefusingGit, { projectPath: dir, branch: 'feature' }));
    check('T37: a merge whose unwind fails refuses rather than throwing', stuck.error === null, String(stuck.error));
    check('T37:   and the unwind really was attempted', aborts === 1, String(aborts));
    check('T37:   as merge_stuck', stuck.value?.code === 'merge_stuck', JSON.stringify(stuck.value).slice(0, 200));
    const said = String(stuck.value?.message || '');
    check('T37:   without mentioning answers nobody gave', !/those answers/.test(said), said.slice(0, 400));
    check('T37:   saying what the merge was for', /to find out what conflicts/.test(said), said.slice(0, 400));
    // The resolve side keeps its own wording, which IS about answers.
    await sh(dir, 'merge', '--abort').catch(() => {});
    await sh(dir, 'reset', '--hard', '-q', 'HEAD').catch(() => {});
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    let more = 0;
    const alsoRefusing = async (cwd, args) => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        more += 1;
        fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'), { force: true });
      }
      return git(cwd, args);
    };
    const answered = await caught(() =>
      resolveMerge(alsoRefusing, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'sideways' }, expect: clash.at })
    );
    check('T37: the resolve side still says its merge was to check the answers', /to check those answers/.test(String(answered.value?.message || '')), String(answered.value?.message || '').slice(0, 300));
    await sh(dir, 'merge', '--abort').catch(() => {});
    await sh(dir, 'reset', '--hard', '-q', 'HEAD').catch(() => {});
  }

  // T38 — "NOTHING TO SPLIT" IS NOT "NOTHING ANSWERS IT", AND THE ENVELOPE HAS
  // TO TELL THE CLIENT WHICH.
  //
  // `hunks: null` with both flags false is this envelope's word for the ONE
  // path no `choices` value can answer: both branches renamed the same file, so
  // git kept only the version the merge started from and there is no "ours" and
  // no "theirs" to name. Every other unsplittable path HAS both sides and takes
  // a whole-file word — which is what `[]` means.
  //
  // A binary file, a page whose bytes are not UTF-8 and a symlink used to READ
  // as text and split into no disagreement, so they arrived as `[]` by
  // accident. Once conflictText refused to decode them they became
  // `parts === null` and fell into the rename/rename shape, whose note says "No
  // `choices` value answers that one either". MEASURED: an agent that obeyed it
  // omitted a conflicting PNG, the documented default committed OURS for it
  // inside a two-parent merge reported `{ok: true, resolved: 1}`, and `feature`
  // was recorded as merged — so safe-delete stopped protecting the branch whose
  // image had just been discarded. "theirs" for the same file works and is
  // byte-exact; the client was told not to send it.
  {
    const raw = (dir, rev) =>
      new Promise((done, fail) =>
        execFile('git', ['show', '--end-of-options', rev], { cwd: dir, encoding: 'buffer', maxBuffer: 1 << 26 }, (err, stdout) =>
          err ? fail(err) : done(Buffer.from(stdout))
        )
      );
    // NUL so git calls it binary, and 0x89/0xFF so the bytes are not UTF-8.
    const png = (b) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), Buffer.alloc(40, b), Buffer.from([0xff, 0xfe])]);
    const envelopeFor = async (dir) => {
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const mcp = DOMAINS.git.merge.result(clash, { branch: 'feature' }, { root: dir, mergeRef: () => 'REF' });
      return { clash, files: mcp?.files || [] };
    };

    // A BINARY FILE: offered no hunks, but answerable, and byte-exact both ways.
    for (const [side, want] of [['ours', 2], ['theirs', 3]]) {
      const dir = await repo(`binary-${side}`);
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, 'logo.png'), png(1));
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'branch', 'feature');
      fs.writeFileSync(path.join(dir, 'logo.png'), png(2));
      await sh(dir, 'commit', '-qam', 'ours');
      await sh(dir, 'checkout', '-q', 'feature');
      fs.writeFileSync(path.join(dir, 'logo.png'), png(3));
      await sh(dir, 'commit', '-qam', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      const { clash, files } = await envelopeFor(dir);
      const entry = files.find((f) => f.path === 'logo.png') || {};
      check(`T38 binary: hunks is [] — no hunks offered, but an answer exists`, Array.isArray(entry.hunks) && entry.hunks.length === 0, JSON.stringify(entry));
      check('T38 binary:   not null, which would mean nothing answers it', entry.hunks !== null, JSON.stringify(entry));
      check('T38 binary:   and neither flag is set', entry.hunksOmitted === false && entry.markersUnread === false, JSON.stringify(entry));
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'logo.png': side }, expect: clash.at });
      check(`T38 binary: the whole-file "${side}" merges`, out?.ok === true && out.resolved === 1, JSON.stringify(out));
      const got = await raw(dir, 'HEAD:logo.png');
      check(`T38 binary:   into ${side}, byte for byte`, got.equals(png(want)), `${got.length} bytes, ${got.subarray(0, 4).toString('hex')}`);
      check('T38 binary:   over a clean tree', (await sh(dir, 'status', '--porcelain')) === '', await sh(dir, 'status', '--porcelain'));
    }

    // A NON-UTF-8 PAGE and A SYMLINK: the same shape, for the same reason.
    {
      const latin = await repo('latin1-envelope');
      cleanup.push(latin);
      const head = Buffer.from('<p>caf\xE9</p>\n', 'latin1');
      const put = (tail) => fs.writeFileSync(path.join(latin, 'page.html'), Buffer.concat([head, Buffer.from(tail)]));
      put('BASE\n');
      await sh(latin, 'add', '-A');
      await sh(latin, 'commit', '-qm', 'base');
      await sh(latin, 'branch', 'feature');
      put('OURS\n');
      await sh(latin, 'commit', '-qam', 'ours');
      await sh(latin, 'checkout', '-q', 'feature');
      put('THEIRS\n');
      await sh(latin, 'commit', '-qam', 'theirs');
      await sh(latin, 'checkout', '-q', 'main');
      const { files } = await envelopeFor(latin);
      const entry = files.find((f) => f.path === 'page.html') || {};
      check('T38 latin-1: hunks is [] and an answer exists', Array.isArray(entry.hunks) && entry.hunks.length === 0, JSON.stringify(entry));

      const link = await linked('symlink-envelope', { ours: 'docs/notes.md', theirs: 'elsewhere' });
      const both = await envelopeFor(link);
      const linkEntry = (both.files || []).find((f) => f.path === 'link') || {};
      check('T38 symlink: hunks is [] and an answer exists', Array.isArray(linkEntry.hunks) && linkEntry.hunks.length === 0, JSON.stringify(linkEntry));
    }

    // THE TWO SHAPES THAT MUST STAY NULL. Without these, "answer everything
    // with []" passes every assertion above.
    {
      // Both branches renamed it: no side to name, and resolveMerge says so.
      const dir = await repo('rename-rename-envelope');
      cleanup.push(dir);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
      await sh(dir, 'add', '-A');
      await sh(dir, 'commit', '-qm', 'base');
      await sh(dir, 'branch', 'feature');
      await sh(dir, 'mv', 'a.txt', 'one.txt');
      await sh(dir, 'commit', '-qam', 'ours');
      await sh(dir, 'checkout', '-q', 'feature');
      await sh(dir, 'mv', 'a.txt', 'two.txt');
      await sh(dir, 'commit', '-qam', 'theirs');
      await sh(dir, 'checkout', '-q', 'main');
      const { clash, files } = await envelopeFor(dir);
      const entry = files.find((f) => f.path === 'a.txt') || {};
      check('T38 rename/rename: hunks stays null — nothing answers it', entry.hunks === null, JSON.stringify(entry));
      check('T38 rename/rename:   with neither flag set', entry.hunksOmitted === false && entry.markersUnread === false, JSON.stringify(entry));
      const before = await repoState(dir);
      const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at }));
      await refusedCleanly('T38 rename/rename: and a whole-file word for it', out.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.path === 'a.txt' && b.reason === 'no_sides')
      );
    }
    {
      // Markers that could not be read: BOTH sides exist, so the `hasSide` test
      // would make this `[]` — and resolveMerge refuses every answer for it,
      // including the whole-file word. It has to stay null.
      const dir = await collide('unread-envelope', {
        base: 'A conflict:\n<<<<<<< HEAD\no\n||||||| b\na\n=======\nt\n>>>>>>> f\nIntro\nBASE\nEnd\n',
        ours: 'A conflict:\n<<<<<<< HEAD\no\n||||||| b\na\n=======\nt\n>>>>>>> f\nIntro\nOURS\nEnd\n',
        theirs: 'A conflict:\n<<<<<<< HEAD\no\n||||||| b\na\n=======\nt\n>>>>>>> f\nIntro\nTHEIRS\nEnd\n',
      });
      const { clash, files } = await envelopeFor(dir);
      const entry = files.find((f) => f.path === 'a.txt') || {};
      check('T38 unread: hunks stays null although both sides exist', entry.hunks === null, JSON.stringify(entry));
      check('T38 unread:   and says why', entry.markersUnread === true, JSON.stringify(entry));
      const before = await repoState(dir);
      const out = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': 'ours' }, expect: clash.at }));
      await refusedCleanly('T38 unread: and the whole-file word it would have invited', out.value, dir, before, 'bad_choices', (a) =>
        (a.badChoices || []).some((b) => b.reason === 'unreadable_conflict')
      );
    }
  }

  // T39 — A REFUSAL MUST NOT BE BIGGER THAN THE REQUEST, ON EVERY BRANCH THAT
  // ECHOES THE CALLER'S OWN STRING.
  //
  // `shown()` was applied inside the unknown-key loop alone, while `bad_value`
  // and `bad_pick` put the caller's raw string into `given` — and the mapper
  // interpolates the same string into `message`. `choices` is
  // `z.record(z.string(), z.unknown())` with no bound on a value, so the wrong
  // shape this refusal names by name — "the reconciled file text sent as a
  // choice" — was the one that came back biggest. MEASURED: a 2 MB value made an
  // 8 MB answer, echoed twice per envelope and sent twice on the wire.
  {
    const dir = await collide('refusal-size', { base: 'head\nBASE\ntail\n', ours: 'head\nOURS\ntail\n', theirs: 'head\nTHEIRS\ntail\n' });
    const huge = 'x'.repeat(200000);
    for (const [what, choice] of [
      ['a whole-file word', huge],
      ['one pick in a list', [huge]],
    ]) {
      const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
      const asked = Buffer.byteLength(JSON.stringify({ choices: { 'a.txt': choice } }), 'utf8');
      const out = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': choice }, expect: clash.at });
      const answered = Buffer.byteLength(JSON.stringify(out), 'utf8');
      check(`T39 ${what}: is refused`, out?.ok === false && out.code === 'bad_choices', JSON.stringify(out).slice(0, 200));
      check(`T39 ${what}:   and the answer is smaller than the question`, answered < asked, `${asked} B asked, ${answered} B answered`);
      // Not merely smaller — bounded, so a bigger question does not buy a
      // bigger answer.
      check(`T39 ${what}:   by a bound, not by a ratio`, answered < 8000, `${answered} B`);
      // AND IT STILL SAYS WHICH VALUE WAS WRONG: a clip that showed nothing
      // would pass both checks above and help nobody.
      const said = JSON.stringify(out.badChoices || []);
      check(`T39 ${what}:   while still showing what was sent`, said.includes('xxxxx') && /characters/.test(said), said.slice(0, 200));
    }
  }

  // T40 — THE GUIDE DOES NOT DESCRIBE A REFUSAL THAT CANNOT ARRIVE, OR
  // DESCRIBE ONE WRONGLY.
  //
  // `bad_branch_name` was documented as "that branch is gone, or is not a name
  // git takes". A branch that is gone answers `stale_merge`, MEASURED — and an
  // MCP client cannot provoke the code at all, because resolve_merge takes the
  // branch out of the signed mergeRef and git.merge checked it before minting
  // one. It is still live for the panel, which passes a branch of its own.
  {
    const dir = await collide('guide-truth', { base: 'head\nBASE\ntail\n', ours: 'head\nOURS\ntail\n', theirs: 'head\nTHEIRS\ntail\n' });
    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    await sh(dir, 'branch', '-D', 'feature');
    const gone = await caught(() => resolveMerge(git, { projectPath: dir, branch: 'feature', choices: { 'a.txt': ['ours'] }, expect: clash.at }));
    check('T40: a branch that is GONE answers stale_merge, not bad_branch_name', gone.value?.code === 'stale_merge', JSON.stringify(gone.value).slice(0, 200));
    const model = require('../electron/mcp/guide.js').TOPICS['operating-model'].body;
    const merge = model.slice(model.indexOf('## A merge conflict'), model.indexOf('## Semantic first'));
    check('T40: and the guide no longer says otherwise', !/bad_branch_name\s+that branch is gone/.test(merge), merge.slice(merge.indexOf('bad_branch_name'), merge.indexOf('bad_branch_name') + 160));
    check('T40:   saying instead that it cannot be provoked', /cannot provoke/.test(merge), 'not said');
    check('T40:   and pointing at stale_merge for a branch that is gone', /GONE is stale_merge/.test(merge), 'not said');
    // The code is still reachable from the caller that supplies its own branch.
    const bad = await caught(() => resolveMerge(git, { projectPath: dir, branch: '--strategy=ours', choices: {}, expect: clash.at }));
    check('T40:   while the code itself is still live for the panel', bad.value?.code === 'bad_branch_name', JSON.stringify(bad.value).slice(0, 160));
  }
}

(async () => {
  // "THE PROCESS EXITED BEFORE THE SUITE FINISHED" IS A FAILURE, NOT A PASS.
  // See test/support/suiteGuard.js: node exits 0 on an empty event loop, so an
  // await that never settles reads as success everywhere that reads exit codes.
  const done = guardSuite('git-branches');
  try {
    await suite();
  } finally {
    removeFixtures();
  }
  // Cleanup is a check, not a side effect. A `finally` that silently failed to
  // remove a repository would leave the same litter the success-only path did.
  const left = cleanup.filter((dir) => fs.existsSync(dir));
  check(`every fixture repository was removed (${cleanup.length} made)`, left.length === 0, left.join(', '));

  if (failures.length) {
    console.error(`git-branches: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-branches: ${checked} passed`);
  done();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
