// What the source looked like when somebody said something about it.
//
// A review is a sentence about markup, and the markup moves. Locally that has
// always been the anchor's problem: the resolver goes and looks. Shared, it
// becomes a different problem, because the person reading the review is not
// standing on the same tree the person who wrote it was standing on. Bob needs
// to be able to ask "was this written about what I am looking at?" and get an
// answer that is evidence rather than a guess.
//
// So every new review records three kinds of evidence, in descending order of
// how long they stay true:
//
//   files   a digest of the bytes of each source file the anchor names. This
//           is the durable one. It needs no repository, survives a rebase, and
//           answers the only question that actually matters — "is the file
//           this was written about the file I have?" — for a project that has
//           never seen git.
//
//   branch  where it was written. A hint, and the reason cross-branch pins are
//           held to a higher standard than same-branch ones.
//
//   head    the commit. HISTORICAL EVIDENCE, NOT IDENTITY. A squash merge, a
//           rebase, a shallow clone or a gc can all make this SHA unreachable
//           tomorrow, and a review whose readability depended on it would
//           simply stop working. Everything here degrades to null and every
//           reader treats null as "cannot tell" rather than "no".
//
// Git is never required. A project with no repository gets head/branch/dirty
// of null and file digests that work perfectly well.
//
// Synchronous on purpose. The review store's whole contract is that a mutation
// is on disk before it answers, and threading an async git call through that
// would mean either breaking the contract or holding a lock across an await.
// This runs on review creation and on resolution — two or three `git` calls
// each, at human speed, never in a loop.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// A git call that has not answered in this long is a git call that is not
// going to; a review must not hang on a repository somebody has mounted over a
// dead network share.
const GIT_TIMEOUT_MS = 2500;
// Enough output for the answers asked for here, and a hard stop for anything
// pathological.
const GIT_MAX_BUFFER = 1 << 20;

// How many files one review may record digests for. The anchor is already
// capped at MAX_KEYS keys, and a key names one file, so this is a backstop.
const MAX_FILES = 24;
// A file large enough that hashing it is worth noticing. Digests are for
// source, and a 5MB .astro file is not source.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Run git in a project, or answer null. Never throws. */
function git(projectPath, args) {
  if (!projectPath) return null;
  try {
    const out = spawnSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      // A repository that wants a passphrase or a credential helper must not
      // stop the app to ask for one.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    if (!out || out.error || out.status !== 0) return null;
    return String(out.stdout || '');
  } catch {
    return null;
  }
}

/** Whether git can answer about this folder at all. */
const isRepo = (projectPath, run) => run(projectPath, ['rev-parse', '--is-inside-work-tree']) !== null;

const SHA = /^[0-9a-f]{7,64}$/i;
const shaOf = (text) => {
  const line = String(text || '').trim().split('\n')[0].trim();
  return SHA.test(line) ? line.toLowerCase() : null;
};

/**
 * The branch, or null.
 *
 * `--abbrev-ref HEAD` says "HEAD" on a detached checkout, which is not the
 * name of a branch and must not be recorded as one — a review filed under a
 * branch called HEAD would compare equal to every other detached review.
 */
function branchOf(projectPath, run) {
  const raw = String(run(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  if (!raw || raw === 'HEAD') return null;
  return raw.slice(0, 200);
}

/**
 * Whether the tree differs from the commit.
 *
 * Untracked files count, for the same reason `git:info` counts them: a page
 * that exists only in the working tree is a difference between what the review
 * was written about and what the commit contains.
 */
function dirtyOf(projectPath, run) {
  const out = run(projectPath, ['status', '--porcelain']);
  if (out === null) return null;
  return out.split('\n').some((line) => line.trim().length > 0);
}

/** sha1 of a file's bytes, in the form the ledger stores. Null if unreadable. */
function digestFile(absolute) {
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return `sha1:${crypto.createHash('sha1').update(fs.readFileSync(absolute)).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * Digests for the project-relative files a review is about.
 *
 * A file that is not there gets NO entry, rather than a null one. "I hashed
 * nothing" and "there was nothing to hash" are different facts, and a map that
 * conflated them would let a reader compare a missing file against a missing
 * file and call it a match.
 */
function digestsFor(projectPath, files, { digest = digestFile } = {}) {
  const out = {};
  if (!projectPath) return out;
  const seen = new Set();
  for (const rel of Array.isArray(files) ? files : []) {
    if (typeof rel !== 'string' || !rel || rel.length > 512) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (seen.size > MAX_FILES) break;
    // Project-relative only. A key that climbed out of the project, or named
    // an absolute path, is not a thing this hashes — the ledger must never be
    // a way to read a file outside the folder that is open.
    const absolute = path.resolve(projectPath, rel);
    const inside = absolute === projectPath || absolute.startsWith(projectPath + path.sep);
    if (path.isAbsolute(rel) || !inside) continue;
    const d = digest(absolute);
    if (d) out[rel] = d;
  }
  return out;
}

/**
 * The provenance of a review being written right now.
 *
 * `files` are the project-relative source files the anchor names. `run` is
 * injected so the whole of this can be tested against a table of git answers
 * rather than against a repository somebody has to build first.
 */
function provenanceFor(projectPath, files, { run = git, digest = digestFile } = {}) {
  const repo = isRepo(projectPath, run);
  return {
    head: repo ? shaOf(run(projectPath, ['rev-parse', 'HEAD'])) : null,
    branch: repo ? branchOf(projectPath, run) : null,
    dirty: repo ? dirtyOf(projectPath, run) : null,
    files: digestsFor(projectPath, files, { digest }),
  };
}

/**
 * Where the source stood at the moment a review was resolved.
 *
 * The same three git facts and deliberately no digests: this records the
 * revision a fix landed on, so that somebody whose checkout predates it can be
 * told so. Which files were touched is the commit's business, not the ledger's.
 */
function sourceStamp(projectPath, { run = git } = {}) {
  const repo = isRepo(projectPath, run);
  if (!repo) return { head: null, branch: null, dirty: null };
  return {
    head: shaOf(run(projectPath, ['rev-parse', 'HEAD'])),
    branch: branchOf(projectPath, run),
    dirty: dirtyOf(projectPath, run),
  };
}

/**
 * Whether `commit` is contained in `HEAD`'s history.
 *
 *   'yes'      it is an ancestor, or it IS head — the resolution is here.
 *   'no'       git knows the commit and it is not in this history.
 *   'unknown'  git cannot say. The commit is unreachable (squashed, rebased
 *              away, gc'd, or never fetched), there is no repository, or the
 *              clone is shallow enough that the answer would be a guess.
 *
 * Three answers rather than two, because this is exactly the place where a
 * boolean would lie. A squash merge makes the original SHA unreachable while
 * the FIX is very much present; reporting `false` there would tell somebody
 * their tree is behind when it is not. `unknown` is the honest word for it and
 * every reader is written to show it as uncertainty rather than as absence.
 */
function containsCommit(projectPath, commit, { run = git } = {}) {
  const wanted = shaOf(commit);
  if (!wanted) return 'unknown';
  if (!isRepo(projectPath, run)) return 'unknown';
  // A shallow clone genuinely cannot answer an ancestry question about
  // anything older than its horizon, and `--is-ancestor` will happily say no.
  const shallow = run(projectPath, ['rev-parse', '--is-shallow-repository']);
  if (shallow !== null && shallow.trim() === 'true') return 'unknown';
  // Does this repository have the object at all?
  if (run(projectPath, ['cat-file', '-e', `${wanted}^{commit}`]) === null) return 'unknown';
  const head = shaOf(run(projectPath, ['rev-parse', 'HEAD']));
  if (!head) return 'unknown';
  if (head.startsWith(wanted) || wanted.startsWith(head)) return 'yes';
  // Exit status is the answer, so a null (non-zero) result means "not an
  // ancestor" rather than "could not ask" — which is why every failure mode
  // that is really "could not ask" is ruled out above.
  return run(projectPath, ['merge-base', '--is-ancestor', wanted, 'HEAD']) === null ? 'no' : 'yes';
}

/**
 * A remote URL reduced to something two people would write the same way.
 *
 * A HINT, and nothing else. It is how Stacki can say "this repository may
 * already have a shared workspace"; it is never authorization, never a
 * workspace id, and never a reason to join anything. A public clone must not
 * be a key to somebody's private review comments — see electron/review/
 * workspaces.js, where joining is always an explicit act with an invitation.
 */
function normalizeRemote(url) {
  if (typeof url !== 'string') return null;
  let text = url.trim();
  if (!text || text.length > 512) return null;
  // scp-style: git@github.com:owner/repo.git
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(text);
  if (scp) text = `ssh://${scp[1]}/${scp[2]}`;
  let host = null;
  let repoPath = null;
  try {
    const parsed = new URL(text);
    host = parsed.host.toLowerCase();
    repoPath = parsed.pathname;
  } catch {
    return null;
  }
  if (!host) return null;
  repoPath = String(repoPath || '')
    .replace(/\.git\/?$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
  if (!repoPath) return null;
  return `${host}/${repoPath}`;
}

/** The project's origin remote, normalized. Null when there isn't one. */
function remoteHint(projectPath, { run = git } = {}) {
  if (!isRepo(projectPath, run)) return null;
  return normalizeRemote(run(projectPath, ['remote', 'get-url', 'origin']));
}

module.exports = {
  provenanceFor,
  sourceStamp,
  containsCommit,
  digestsFor,
  digestFile,
  normalizeRemote,
  remoteHint,
  branchOf,
  dirtyOf,
  shaOf,
  isRepo,
  git,
  MAX_FILES,
  MAX_FILE_BYTES,
  GIT_TIMEOUT_MS,
};
