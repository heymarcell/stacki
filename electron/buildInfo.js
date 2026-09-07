// Which build this is, precisely enough that two of them cannot be confused.
//
// WHY THIS FILE EXISTS. A live dogfood session reported sixteen defects against
// "Stacki version 0.1.23". The candidate it was supposed to be qualifying also
// reports 0.1.23. Three of the sixteen contradicted mechanisms that were
// demonstrably present in the candidate's source, and the only way to find out
// which build had actually been driven was to extract app.asar and hash all
// eighty of its `electron/**/*.js` files against every commit in the
// repository. They matched a commit ninety-three commits behind the candidate.
//
// A version number is a marketing string that changes when someone remembers to
// change it. It cannot distinguish two builds of the same version, which is
// every build anybody makes between releases — and those are exactly the builds
// that get dogfooded. So the app carries its git identity instead, and any
// report about "what Stacki did" can start by saying which Stacki.
//
// TWO SOURCES, ONE SHAPE.
//
//   packaged   Stamped into `electron/build-info.json` by scripts/buildInfo.js
//              at package time (electron-builder's beforePack hook), because a
//              packaged app has no repository to ask and may have no git at
//              all. The file is gitignored, so stamping it does not dirty the
//              working tree, and it is inside the `electron/**/*` glob, so it
//              is inside app.asar.
//
//   dev        Asked of git, here, at first use. A developer's tree is usually
//              dirty and that is not a defect — but it does mean the head SHA
//              alone does not identify what is running, so `dirty` is part of
//              the identity rather than a footnote to it.
//
// NEVER THROWS, NEVER BLOCKS FOR LONG. This is read by `get_context`, which is
// the first thing an agent calls. A machine with no git, a checkout that is not
// a repository, a stamp file that got truncated: each of those is a build whose
// identity is `unknown`, and saying so is the honest answer. What it must never
// do is make the tool that reports it fail.
//
// NO `require('electron')`. test/agent-harness.js loads electron/main.js with a
// stubbed Electron, and the build identity has to be readable there too.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Where the packager leaves the stamp. Beside this file, inside app.asar. */
const STAMP_FILE = path.join(__dirname, 'build-info.json');

/** The repository root, when there is one: this file's parent's parent. */
const REPO_ROOT = path.join(__dirname, '..');

// Long enough for git to answer on a cold cache, short enough that a wedged
// index cannot hang the first tool call an agent makes.
const GIT_TIMEOUT_MS = 5000;

const SHA = /^[0-9a-f]{40}$/;

/** A 40-hex object name, or null for anything else. */
const sha = (v) => (typeof v === 'string' && SHA.test(v.trim()) ? v.trim() : null);

/**
 * `git`, once, with no shell and no inherited stdio.
 *
 * Returns null for every failure — not a repository, git not installed, a
 * timeout, a non-zero status. The caller's job is to say "unknown", not to
 * distinguish nine ways of not knowing.
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * The identity of the source tree at `root`, as git sees it right now.
 *
 * `dirty` counts TRACKED modifications and untracked files that are not
 * ignored, which is what `git status --porcelain` reports. An ignored file —
 * build-info.json itself, node_modules, release/ — is not a difference from the
 * commit, and counting it would make every build of every clean checkout dirty.
 *
 * Exported because scripts/buildInfo.js stamps a package with exactly this.
 */
function gitIdentity(root = REPO_ROOT) {
  const head = sha(git(['rev-parse', 'HEAD'], root));
  if (!head) return null;
  const tree = sha(git(['rev-parse', 'HEAD^{tree}'], root));
  const status = git(['status', '--porcelain'], root);
  return {
    gitHead: head,
    gitTree: tree,
    // A status that could not be read is not evidence of cleanliness. `null`
    // says the question was not answered; `false` is a claim.
    dirty: status === null ? null : status.trim().length > 0,
  };
}

/** The version in the package.json that ships beside this file. */
function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The stamp a packaged build carries, or null if there is none or it is unusable. */
function readStamp(file = STAMP_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A stamp that exists and cannot be parsed is worse than no stamp: it means
    // the packaging step ran and produced rubbish. Say `unknown` rather than
    // silently falling back to asking git, which in a packaged app would answer
    // about whatever repository the user happens to have open.
    return { corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object') return { corrupt: true };
  return parsed;
}

/**
 * The one canonical answer to "which build is this?".
 *
 * Shape, always all six keys present:
 *
 *   packageVersion  string | null   the version in package.json
 *   gitHead         string | null   40-hex commit, or null when unknown
 *   gitTree         string | null   40-hex tree of that commit
 *   dirty           boolean | null  true, false, or null for "not established"
 *   buildKind       'packaged' | 'dev' | 'unknown'
 *   builtAt         string | null   ISO-8601, packaged builds only
 *
 * `dirty` is deliberately three-valued. A packaged build stamped from a clean
 * commit says `false` and means it; a packaged build stamped from a dirty tree
 * says `true` and means that too — the stamper does not refuse to stamp, it
 * records what was there, and the provenance gate in test/build-identity.js is
 * what refuses. `null` is "nobody could tell", which is not the same claim.
 */
function computeIdentity({ stampFile = STAMP_FILE, root = REPO_ROOT } = {}) {
  const stamp = readStamp(stampFile);

  if (stamp && !stamp.corrupt) {
    return {
      packageVersion: typeof stamp.packageVersion === 'string' ? stamp.packageVersion : packageVersion(),
      gitHead: sha(stamp.gitHead),
      gitTree: sha(stamp.gitTree),
      dirty: typeof stamp.dirty === 'boolean' ? stamp.dirty : null,
      buildKind: 'packaged',
      builtAt: typeof stamp.builtAt === 'string' ? stamp.builtAt : null,
    };
  }

  if (stamp && stamp.corrupt) {
    return {
      packageVersion: packageVersion(),
      gitHead: null,
      gitTree: null,
      dirty: null,
      buildKind: 'unknown',
      builtAt: null,
    };
  }

  const identity = gitIdentity(root);
  if (!identity) {
    return {
      packageVersion: packageVersion(),
      gitHead: null,
      gitTree: null,
      dirty: null,
      buildKind: 'unknown',
      builtAt: null,
    };
  }
  return {
    packageVersion: packageVersion(),
    gitHead: identity.gitHead,
    gitTree: identity.gitTree,
    dirty: identity.dirty,
    buildKind: 'dev',
    builtAt: null,
  };
}

// Memoized. A packaged build's identity cannot change while it runs, and a dev
// build's could — but re-shelling out to git on every `get_context` would put
// three process spawns on the hot path of the tool an agent calls first, to
// report a value that is only interesting once per session. The identity is of
// the BUILD, which is the bytes that were loaded into this process, and those
// were fixed when it started.
let cached = null;

/** The build identity of the running app. Computed once. */
function buildIdentity() {
  if (!cached) cached = computeIdentity();
  return cached;
}

/** `a1b2c3d`, or null. What a status panel has room for. */
function shortSha(identity = buildIdentity()) {
  return identity && identity.gitHead ? identity.gitHead.slice(0, 7) : null;
}

/**
 * One line a human can read out of a screenshot.
 *
 * `0.1.23 · a1b2c3d · packaged`, `0.1.23 · a1b2c3d+dirty · dev`,
 * or `0.1.23 · unknown build`.
 */
function describe(identity = buildIdentity()) {
  const version = identity.packageVersion || '?';
  if (!identity.gitHead) return `${version} · unknown build`;
  const dirty = identity.dirty === true ? '+dirty' : '';
  return `${version} · ${identity.gitHead.slice(0, 7)}${dirty} · ${identity.buildKind}`;
}

/** For tests: forget the memoized answer. */
function _reset() {
  cached = null;
}

module.exports = {
  buildIdentity,
  computeIdentity,
  gitIdentity,
  readStamp,
  shortSha,
  describe,
  STAMP_FILE,
  _reset,
};
