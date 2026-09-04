// The refusals that still said `failed`, and what they say now.
//
//   node test/named-causes.js
//
// The product contract is that a raw host error, or a generic code for a cause
// the code knows the name of, is a defect. This branch closed that for the
// content domain, for `delete_branch`'s unmerged case, for `restore_file`'s
// missing-at-ref and for `publish`'s three sign-in states — and left the
// plainest causes in the git domain generic:
//
//   git.commit with nothing staged   {ok:false, code:'failed',
//                                     message:'On branch main\nnothing to
//                                     commit, working tree clean'}
//   an unknown ref or branch on      code:'failed' with git's own multi-line
//   checkout/merge/delete_branch/    fatal text, `Use '--' to separate paths
//   restore_project/commit_files/    from revisions` help block included
//   file_at
//
// An agent cannot branch on "nothing to commit" against a real failure without
// parsing English, and "nothing to commit" is the commonest refusal in the
// whole domain. Same for the one non-git generic left in an 88-operation sweep:
// asset.move between public/ and src/ is a deliberate, well-explained product
// limit thrown as a bare Error, two lines below a `refuse('bad_path', …)`.
//
// TWO ORACLES, because a code is a claim about something:
//
//   the repository, read with git itself — a refusal that moved HEAD, changed
//   the branch or touched the working tree is a worse defect than the code it
//   was answering with;
//
//   and a POSITIVE CONTROL for every one of them. Every assertion here is
//   refusal-shaped, and a surface that refused everything with a well-chosen
//   code would satisfy all of them.
//
// The direct-mapper block at the end hands `thrownFailure` git's exact stderr,
// including the shapes no fixture provokes — and hands it an unrelated failure
// too, which must still be `failed`: the mapper classifies, it does not
// relabel.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./agent-harness.js');
const { thrownFailure } = require('../electron/mcp/agent/domains.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

/** git, run by the test itself. The oracle, never the thing under test. */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

(async () => {
  const root = H.makeProject({ 'public/img/.keep': '' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'causes@example.com');
  git(root, 'config', 'user.name', 'Named Causes');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');

  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const state = () => ({
    head: git(root, 'rev-parse', 'HEAD'),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
    branches: git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'),
    dirty: git(root, 'status', '--porcelain'),
  });

  try {
    // ── THE GIT CAUSES ───────────────────────────────────────────────────────
    {
      const before = state();
      // Each entry: what it is, the call, and the code git's own words earn.
      const cases = [
        ['a commit with nothing to commit', ['commit', { message: 'nothing should be echoed from this' }], 'nothing_to_commit'],
        ['a commit whose pathspec names no file', ['commit', { message: 'probe', paths: ['src/nope.astro'] }], 'no_file'],
        ['a checkout of a branch that is not there', ['checkout', { branch: 'no-such-branch' }], 'no_branch'],
        ['a merge of a branch that is not there', ['merge', { branch: 'no-such-branch' }], 'no_branch'],
        ['deleting a branch that is not there', ['delete_branch', { branch: 'no-such-branch' }], 'no_branch'],
        ['reading a file at a ref that is not there', ['file_at', { ref: 'no-such-ref', path: 'src/pages/index.astro' }], 'no_ref'],
        ['listing the files of a ref that is not there', ['commit_files', { ref: 'no-such-ref' }], 'no_ref'],
        ['restoring the project to a ref that is not there', ['restore_project', { ref: 'no-such-ref' }], 'no_ref'],
        // resolve_merge re-runs the merge and then commits what it reconciled;
        // with no such branch there is nothing to reconcile and git says so in
        // the words the commit case above earns. What matters is that it is a
        // code and not `failed`.
        ['finishing a merge that never started', ['resolve_merge', { branch: 'no-such-branch' }], 'nothing_to_commit'],
      ];
      for (const [what, [action, args], code] of cases) {
        const env = await run('git', action, args);
        check(`${what} is refused`, env.ok === false, short(env));
        check(`  as ${code}, not the code that means nobody knows`, env.code === code, short({ code: env.code, message: env.message }));
        check('  without this machine in the message', !String(env.message || '').includes(root), short(env.message));
        check('  and without the command line echoed back', !/^Command failed:/.test(String(env.message || '')), short(env.message));
      }
      const after = state();
      check('and not one of them moved the repository', JSON.stringify(after) === JSON.stringify(before), short({ before, after }));
      // The refusal an agent sees must not carry the caller's own commit
      // message back to it — git's status text used to arrive verbatim.
      const clean = await run('git', 'commit', { message: 'nothing should be echoed from this' });
      check('  and the refusal does not repeat the caller’s commit message back', !String(clean.message || '').includes('nothing should be echoed'), short(clean.message));
    }

    // THE POSITIVE CONTROLS. The same operations, with arguments that name
    // something real, have to still work — otherwise every check above is
    // satisfied by a surface that refuses everything.
    {
      fs.writeFileSync(path.join(root, 'src/pages/about.astro'), '---\n---\n<p>changed</p>\n', 'utf8');
      const committed = await run('git', 'commit', { message: 'a real commit' });
      check('a commit with something to commit still happens', committed.ok === true, short(committed));
      check('  and git agrees about the sha', committed.head === git(root, 'rev-parse', 'HEAD'), short({ said: committed.head }));

      const made = await run('git', 'checkout', { branch: 'a-real-branch', create: true });
      check('a checkout that names a real branch still happens', made.ok === true, short(made));
      check('  and git agrees about the branch', git(root, 'rev-parse', '--abbrev-ref', 'HEAD') === 'a-real-branch', git(root, 'rev-parse', '--abbrev-ref', 'HEAD'));
      await run('git', 'checkout', { branch: 'main' });
      const removed = await run('git', 'delete_branch', { branch: 'a-real-branch' });
      check('deleting a branch that is there still happens', removed.ok === true, short(removed));
      check('  and it is gone from git', !git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').includes('a-real-branch'), git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'));

      const at = await run('git', 'file_at', { ref: 'HEAD', path: 'src/pages/about.astro' });
      check('reading a file at a ref that IS there still works', at.ok === true && at.existed === true, short(at));
      check('  with the bytes git has', at.text === git(root, 'show', 'HEAD:src/pages/about.astro') + '\n', short(at.text));
      const files = await run('git', 'commit_files', { ref: 'HEAD' });
      check('listing a real commit’s files still works', files.ok === true && (files.files || []).length > 0, short(files));
    }

    // ── THE ONE NON-GIT GENERIC ──────────────────────────────────────────────
    //
    // Moving an asset between public/ and src/ is refused because the file's
    // IDENTITY changes — a public/ asset is referenced by URL and a src/ one by
    // import — and the handler explains that in a paragraph. It threw a bare
    // Error, so the paragraph arrived under `code: 'failed'`.
    {
      const before = read('public/robots.txt');
      const said = await run('asset', 'move', { path: 'public/robots.txt', toFolder: 'src/assets' });
      check('moving an asset across the roots is refused', said.ok === false, short(said));
      check('  as a limit with a name, not as a failure', said.code === 'unsupported', short({ code: said.code }));
      check('  keeping the sentence that explains it', /references updated too/.test(String(said.message || '')), short(said.message));
      check('  and the file has not moved', read('public/robots.txt') === before, short(read('public/robots.txt')));
      check('  and nothing was created on the other side', read('src/assets/robots.txt') === null, 'the file was copied across the roots');

      // The neighbour cause in the same handler, refused in band: a file that
      // is not there. It answered `{ok:false}` and nothing else, which reaches
      // the wire as `failed` / "That operation was refused." — and a result
      // mapper that shaped only the success would turn it into an `{ok:true}`
      // with an empty answer, which is worse.
      const absent = await run('asset', 'move', { path: 'public/not-here.svg', toFolder: 'public/img' });
      check('moving a file that is not there is refused', absent.ok === false, short(absent));
      check('  by name', absent.code === 'no_file', short({ code: absent.code, message: absent.message }));

      // The control: a move inside one root still moves the file.
      const ok = await run('asset', 'move', { path: 'public/robots.txt', toFolder: 'public/img' });
      check('a move inside one root still happens', ok.ok === true, short(ok));
      check('  with the file where the envelope says', read('public/img/robots.txt') === before && ok.path === 'public/img/robots.txt', short({ path: ok.path }));
    }

    // ── THE MAPPER, HANDED GIT'S OWN STDERR ──────────────────────────────────
    //
    // Every case above reaches the mapper through an operation, which is the
    // half that can drift with a git version. These are the exact strings git
    // 2.x emits, including the ones the fixtures above cannot provoke.
    {
      const said = (message) => thrownFailure(new Error(message), { root });
      const table = [
        ["fatal: ambiguous argument 'x': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:", 'no_ref'],
        ["fatal: invalid object name 'x'.", 'no_ref'],
        ['fatal: Not a valid object name x', 'no_ref'],
        ['fatal: invalid reference: x', 'no_branch'],
        ['merge: x - not something we can merge', 'no_branch'],
        ["error: branch 'x' not found.", 'no_branch'],
        ["fatal: couldn't find remote ref x", 'no_branch'],
        ['On branch main\nnothing to commit, working tree clean', 'nothing_to_commit'],
        ['no changes added to commit (use "git add" and/or "git commit -a")', 'nothing_to_commit'],
        ["fatal: pathspec 'src/nope.astro' did not match any files", 'no_file'],
      ];
      for (const [stderr, code] of table) {
        check(`${JSON.stringify(stderr.split('\n')[0]).slice(0, 60)} is ${code}`, said(stderr).code === code, short(said(stderr)));
      }
      // AND THE CONTROL. A cause this table does not recognise must still be
      // `failed` — the mapper classifies, it does not relabel.
      check('a failure nothing here recognises is still failed', said('the preview server exited with code 137').code === 'failed', short(said('the preview server exited with code 137')));
      check('  and a repository that is not one is still no_repo', said('fatal: not a git repository (or any of the parent directories): .git').code === 'no_repo', short(said('fatal: not a git repository (or any of the parent directories): .git')));
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }
  check('the fixture is gone', !fs.existsSync(root), root);

  if (failures.length) {
    console.error(`named-causes: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`named-causes: ${checked} passed  [a cause the code knows the name of is answered by name]`);
})().catch((err) => {
  console.error('named-causes: threw\n', err?.stack || err);
  process.exit(1);
});
