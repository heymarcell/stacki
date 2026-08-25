// Whether a review is about the tree you actually have.
//
// This is the problem that makes Stacki's shared reviews different from every
// other shared-comment product. A comment on a Figma frame is about that
// frame; everybody looking at it is looking at the same pixels. A comment on
// source is about source, and Alice's source is not Bob's. She may be on
// another branch, ahead by four commits, behind by ten, or simply have
// unsaved work. So a shared review has TWO states and they must never be run
// together:
//
//   the REVIEW state      open / deferred / resolved. Shared, agreed by
//                         everybody, folded from the event set.
//   the CHECKOUT state    what this particular working copy can say about it.
//                         Local, computed here, never shared and never stored.
//
// The failure this exists to prevent is small and very bad: Claude fixes #17
// on a commit Bob does not have, the shared thread says `resolved`, and Bob's
// Stacki draws a tick over a bug that is still on his screen. He believes it
// is done. Nobody ever finds out. So a resolution carries the revision it
// landed on, and this answers — for Bob's tree, from Bob's git — whether that
// revision is here.
//
// Every answer degrades to `unknown`, and `unknown` is shown as uncertainty
// rather than as absence. A squash merge makes the original SHA unreachable
// while the fix is very much present; saying "you do not have it" there would
// be a confident lie, which is worse than an admitted shrug.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { sourceStamp, containsCommit } = require('./provenance');
const { fileOfKey } = require('./anchor');

// How long the answer to "where is this checkout" is reused for. A list of
// reviews is redrawn on every filter change and every notification; asking git
// three questions each time would put a subprocess on the main thread in a
// loop. Short enough that a branch switch shows up immediately in human terms.
const TREE_TTL_MS = 1500;
// Ancestry answers never change for a given pair, so they are kept for the
// life of the process — bounded, because a pathological ledger should not be
// able to grow a map without limit.
const MAX_ANCESTRY = 500;
const MAX_DIGESTS = 500;

/**
 * The three questions this module asks, cached.
 *
 * `run` is the git runner; injected so every branch of this can be tested
 * against a table of answers rather than against repositories somebody has to
 * build first.
 */
function createCheckout({ projectPath = null, run = undefined, now = Date.now, ttl = TREE_TTL_MS } = {}) {
  const opts = run ? { run } : {};
  let tree = null;
  let treeAt = 0;
  const ancestry = new Map();
  const digests = new Map();

  /** Where this working copy stands. One git round trip, reused for a moment. */
  function where() {
    const at = now();
    if (tree && at - treeAt < ttl) return tree;
    tree = projectPath ? sourceStamp(projectPath, opts) : { head: null, branch: null, dirty: null };
    treeAt = at;
    return tree;
  }

  /** Forget everything. Used when the project changes under this module. */
  function reset() {
    tree = null;
    treeAt = 0;
    ancestry.clear();
    digests.clear();
  }

  /**
   * The digest of a file as it is on disk right now.
   *
   * Keyed on size and mtime as well as the path, so a redraw that changes
   * nothing costs a stat rather than a read, and an edit is picked up the
   * moment it lands.
   */
  function digestNow(rel) {
    if (!projectPath || typeof rel !== 'string' || !rel) return null;
    const absolute = path.resolve(projectPath, rel);
    if (path.isAbsolute(rel) || !(absolute === projectPath || absolute.startsWith(projectPath + path.sep))) return null;
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return 'missing';
    }
    if (!stat.isFile()) return 'missing';
    const key = `${absolute}|${stat.size}|${stat.mtimeMs}`;
    const held = digests.get(key);
    if (held) return held;
    let value;
    try {
      value = `sha1:${crypto.createHash('sha1').update(fs.readFileSync(absolute)).digest('hex')}`;
    } catch {
      value = 'missing';
    }
    if (digests.size >= MAX_DIGESTS) digests.clear();
    digests.set(key, value);
    return value;
  }

  /**
   * Whether the files a review was written about still say what they said.
   *
   *   same      every recorded file is byte-identical. The strongest evidence
   *             there is, and it needs no repository at all.
   *   changed   they are all here and at least one has been edited. Ordinary:
   *             it is what happens when the feedback is acted on.
   *   missing   a file the review was about is not in this tree. Usually a
   *             different branch, sometimes a deletion.
   *   unknown   the review has no recorded digests — it predates provenance,
   *             or was written on a machine that could not read the files.
   */
  function sourceState(provenance) {
    const files = provenance && typeof provenance === 'object' ? provenance.files : null;
    const entries = files && typeof files === 'object' ? Object.entries(files) : [];
    if (!entries.length) return 'unknown';
    let changed = false;
    for (const [rel, recorded] of entries) {
      const current = digestNow(rel);
      if (current === null) return 'unknown';
      if (current === 'missing') return 'missing';
      if (current !== recorded) changed = true;
    }
    return changed ? 'changed' : 'same';
  }

  /**
   * Whether a resolution's revision is in this checkout's history.
   *
   *   present   the commit is an ancestor of HEAD, or is HEAD. Whatever was
   *             fixed is here.
   *   behind    git knows the commit and it is not in this history. The fix
   *             was made somewhere this tree has not been.
   *   unknown   nobody can say: no repository, an unreachable commit (squashed,
   *             rebased, never fetched), a shallow clone, or a resolution made
   *             against a DIRTY tree — where the commit proves nothing, because
   *             the change was not in it.
   */
  function presenceOf(commit) {
    if (typeof commit !== 'string' || !commit) return 'unknown';
    const head = where().head;
    const key = `${head || 'none'}|${commit}`;
    if (ancestry.has(key)) return ancestry.get(key);
    const answer = projectPath ? containsCommit(projectPath, commit, opts) : 'unknown';
    const state = answer === 'yes' ? 'present' : answer === 'no' ? 'behind' : 'unknown';
    if (ancestry.size >= MAX_ANCESTRY) ancestry.clear();
    ancestry.set(key, state);
    return state;
  }

  function resolutionState(stamp) {
    if (!stamp || typeof stamp !== 'object') return 'unknown';
    // Resolved with uncommitted work in the tree. The SHA is real and it is
    // not where the fix is, so having that commit proves nothing at all.
    if (stamp.dirty === true) return 'unknown';
    return presenceOf(typeof stamp.head === 'string' ? stamp.head : null);
  }

  /**
   * Everything this checkout can say about one review.
   *
   * Deliberately a description rather than a verdict. It reports what is true
   * and lets the panel and the agent decide what to say about it; a boolean
   * `isStale` here would be the same guess made once, in the wrong place.
   */
  function forThread(thread) {
    if (!thread) return null;
    const here = where();
    const provenance = thread.provenance && typeof thread.provenance === 'object' ? thread.provenance : null;
    const originBranch = provenance?.branch || thread.creationContext?.branch || null;
    const source = sourceState(provenance);
    const resolved = thread.status === 'resolved';
    return {
      // Where this working copy is.
      branch: here.branch,
      head: here.head,
      dirty: here.dirty,
      // And where the review came from. Null for a review written before
      // provenance existed; the legacy `creationContext.branch` still answers
      // the branch half for those.
      origin: provenance
        ? { branch: provenance.branch, head: provenance.head, dirty: provenance.dirty }
        : originBranch
          ? { branch: originBranch, head: null, dirty: null }
          : null,
      // Null rather than false when either side is unknown: "written somewhere
      // else" and "nobody recorded where" are different, and only one of them
      // is a reason to be careful about a pin.
      sameBranch: originBranch && here.branch ? originBranch === here.branch : null,
      // Whether the commit the review was WRITTEN on is in this history. This
      // is what lets a project-wide review survive a branch merge: once
      // `feature-a` is merged into `main`, a comment written on `feature-a` is
      // a comment about source that is now here, and holding it to the
      // cross-branch standard would be treating a merge as a divergence.
      originIn: provenance?.head ? presenceOf(provenance.head) : null,
      source,
      // Only meaningful while it IS resolved. A reopened thread's old
      // resolution describes nothing.
      resolution: resolved ? resolutionState(thread.resolvedAtSource) : null,
    };
  }

  return { where, forThread, sourceState, resolutionState, presenceOf, digestNow, reset };
}

/**
 * The project-relative files a review's anchor names.
 *
 * The same derivation the ledger uses when it records provenance, so the files
 * compared later are the files that were hashed.
 */
const filesOfAnchor = (anchor) => [...new Set((anchor?.keys || []).map(fileOfKey).filter(Boolean))];

module.exports = { createCheckout, filesOfAnchor, TREE_TTL_MS };
