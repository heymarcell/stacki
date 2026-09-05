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
const { mergeBranch, deleteBranch, switchBranch, resolveMerge } = require('../electron/gitBranches.js');

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

(async () => {
  const cleanup = [];

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

  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`git-branches: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-branches: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
