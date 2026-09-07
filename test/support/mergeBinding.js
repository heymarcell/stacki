// A real conflicted merge, inside a harness project.
//
// The git domain is one of the few in this surface where the interesting
// refusals need HISTORY rather than a file: two branches that disagree, and
// then a commit landing on one of them while somebody is deciding what to do
// about it. Building that inline is a dozen lines of `execFileSync` per case,
// which is a dozen lines per case in which the fixture and the thing under
// test can quietly stop describing the same situation.
//
// So it lives here, and the tests that use it say what they are measuring
// rather than how to make a repository. Everything runs git itself — the
// oracle is never the module under test.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** git, run by the test. Never the code being measured. */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * Turn a harness project into a git repository with one commit on `main`.
 *
 * Signing is turned off explicitly: a machine with `commit.gpgsign` on would
 * otherwise fail every commit here for a reason that has nothing to do with
 * what is being measured.
 */
function initRepo(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'merge@example.com');
  git(root, 'config', 'user.name', 'Merge Binding');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the project as it was');
  return root;
}

const write = (root, rel, body) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
};

/**
 * Two branches that disagree about one file.
 *
 * `theirs` is committed on `branch`; `ours` is committed on the branch the
 * repository is left standing on, which is where a merge is then run from.
 */
function makeConflict(root, { branch, file, base, ours, theirs }) {
  const on = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  write(root, file, base);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `${file}: what both branches started from`);
  git(root, 'checkout', '-q', '-b', branch);
  write(root, file, theirs);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `${file} on ${branch}`);
  git(root, 'checkout', '-q', on);
  write(root, file, ours);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `${file} on ${on}`);
  return { branch, file, into: on, tip: git(root, 'rev-parse', `${branch}^{commit}`), head: git(root, 'rev-parse', 'HEAD') };
}

/** A commit on `branch`, leaving the repository standing where it found it. */
function commitOn(root, branch, file, body) {
  const on = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== on) git(root, 'checkout', '-q', branch);
  write(root, file, body);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `${file} moved on ${branch}`);
  const made = git(root, 'rev-parse', 'HEAD');
  if (branch !== on) git(root, 'checkout', '-q', on);
  return made;
}

/**
 * Every file in the working tree, by content.
 *
 * The oracle for "nothing was merged". `ok:false` with the merge on disk is
 * the failure these suites exist to catch, and only the bytes can tell.
 */
function bytesOf(root) {
  const out = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true })) {
      // .git churns on every command, and node_modules is not the subject.
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(at);
      else out[at] = fs.readFileSync(path.join(root, at), 'utf8');
    }
  };
  walk('');
  return out;
}

/** Which files differ between two readings, so a failure names them. */
const movedBetween = (before, after) =>
  Object.keys({ ...before, ...after }).filter((file) => before[file] !== after[file]);

const repoState = (root) => ({
  head: git(root, 'rev-parse', 'HEAD'),
  status: git(root, 'status', '--porcelain'),
  mergeHead: fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')),
  bytes: bytesOf(root),
});

module.exports = { git, initRepo, write, makeConflict, commitOn, bytesOf, movedBetween, repoState };
