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
const { mergeBranch, deleteBranch, switchBranch, resolveMerge, conflictDigest } = require('../electron/gitBranches.js');
const { guardSuite } = require('./support/suiteGuard.js');
// The project-relative resolver the rest of the MCP surface puts every path
// through. T22 checks the git domain's `sourcePath` against IT rather than by
// joining strings here: a spelling this file agrees with but resolveInProject
// refuses is exactly the failure that field exists to close.
const { resolveInProject } = require('../electron/mcp/agent/paths.js');

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
