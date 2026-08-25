// Whether a shared review may point at anything on YOUR screen.
//
// Everything else about Shared Reviews is plumbing. This is the part that can
// be wrong in a way nobody notices: a comment Alice left on `feature-a`
// appears on Bob's `main` with a pin on a card that merely happens to sit at
// the same index. It looks right. It is somebody else's feedback attached to
// unrelated markup, and the only person who could catch it is the one being
// misled by it.
//
// So the ladder from src/reviewAnchor.js gets one more rung on top of it, and
// the rung is about evidence rather than position:
//
//   exact / moved     the node was identified by its recorded marks — the
//                     words, the ancestry, the sibling runs. That is proof
//                     about a NODE, and it is as true on another branch as it
//                     is on this one. Pin it.
//
//   positional        the slot held on structure alone: nothing slid past this
//                     index. That is a statement about THIS TREE, and it is
//                     worth nothing about a different one. On the tree the
//                     review was written against it is the ordinary,
//                     overwhelmingly-correct answer. Across a divergence it is
//                     a coincidence with a good disguise.
//
//   unverified        the file is not open, so nothing has looked at all; the
//                     page merely reported a box at that key. Same rule.
//
// A review that cannot be pinned is NOT hidden. It stays in the panel, with
// where it came from on it, and says why it has no marker. That is the whole
// bargain of this feature: a shared review may be readable even when its pin
// cannot honestly be drawn, and we never trade that for the look of seamless
// collaboration.

/** Which branch a review was written on, from provenance or the old snapshot. */
export function originBranch(review) {
  return review?.provenance?.branch || review?.checkout?.origin?.branch || review?.creationContext?.branch || null;
}

/**
 * Whether this review describes a tree that is not the one in front of you.
 *
 * Four questions, in order of how much they prove, and the first one that has
 * an answer wins:
 *
 *   is a file it was written about missing? Then yes, and nothing else needs
 *   asking. This needs no repository, and it is true across a rename, a
 *   rebase, or a project that has never seen git.
 *
 *   are the FILE BYTES identical to what was recorded? Then no. This is the
 *   strongest evidence there is: the markup the review was written about is
 *   the markup that is here, whatever branch either of them is called.
 *
 *   otherwise, was it written on another branch? Then yes.
 *
 * `changed` is deliberately NOT divergence on its own. Files change every time
 * a piece of feedback is acted on; treating an edited file as another tree
 * would drop the pin off every review at the moment it was addressed.
 *
 * WHAT ABOUT A BRANCH THAT WAS MERGED? `checkout.originIn` says whether the
 * commit the review was written on is in this history, and it is deliberately
 * NOT used here. Being descended from a commit says nothing about whether the
 * tree still resembles it — a branch taken after the merge and then rewritten
 * has that ancestor and none of its markup. A merged review is not lost: it
 * stays in the list, and it pins the moment the resolver can identify its node
 * by the marks it recorded, which is exactly the higher standard a review from
 * elsewhere should be held to.
 */
export function divergent(review) {
  const c = review?.checkout;
  if (!c) return false; // nothing was measured — behave exactly as before
  if (c.source === 'missing') return true;
  if (c.source === 'same') return false;
  return c.sameBranch === false;
}

/**
 * Whether a marker may be drawn.
 *
 * `confidence` is what src/reviewAnchor.js said about this tree, or
 * `unverified` when the file was never read.
 */
export function mayPin(review, confidence) {
  if (!review || review.anchorState === 'orphaned') return false;
  if (!confidence || confidence === 'none') return false;
  // Proof about the node itself travels between trees.
  if (confidence === 'exact' || confidence === 'moved') return true;
  // A position does not.
  return !divergent(review);
}

/**
 * The one thing worth saying about how a review sits against this checkout.
 *
 * At most one, in order of how badly it would mislead somebody:
 *
 *   resolved-elsewhere   the worst. The thread says done and this tree does
 *                        not contain the revision it was done on, so the bug
 *                        may be exactly where it was. Never dressed up as a
 *                        tick.
 *   resolved-unproven    the same shape, honestly unproven: a squash, a rebase
 *                        or a shallow clone means nobody can say. `unknown` is
 *                        shown as uncertainty, never as absence — reporting
 *                        "you do not have it" about a squashed merge would be
 *                        a confident lie.
 *   missing-source       a file this was written about is not here.
 *   other-branch         written somewhere else, and the pin is being withheld
 *                        because of it.
 *
 * Null when there is nothing to warn about, which is the ordinary case.
 */
export function checkoutNote(review, { pinned = true } = {}) {
  const c = review?.checkout;
  if (!c) return null;
  const shortSha = (sha) => (typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : null);

  if (review.status === 'resolved' && review.resolvedAtSource) {
    const who = review.resolvedBy?.actorName || null;
    const at = shortSha(review.resolvedAtSource.head);
    if (c.resolution === 'behind') {
      return { kind: 'resolved-elsewhere', who, commit: at, branch: review.resolvedAtSource.branch || null };
    }
    if (c.resolution === 'unknown' && (at || review.resolvedAtSource.dirty === true)) {
      return {
        kind: 'resolved-unproven',
        who,
        commit: at,
        // Resolved with uncommitted work in the tree: the commit is real and
        // is not where the change is, so having it proves nothing.
        uncommitted: review.resolvedAtSource.dirty === true,
        // A second, independent fact, and often the more useful one: the file
        // this comment is about is byte-for-byte what it was when the comment
        // was written. Whatever was done elsewhere, it was not done here. Said
        // alongside the shrug rather than instead of it, because both are true
        // and neither on its own is the whole picture.
        unchanged: c.source === 'same',
      };
    }
  }
  if (c.source === 'missing') return { kind: 'missing-source', branch: originBranch(review) };
  // Only when the difference actually matters. A comment written on a branch
  // that has since been merged is a comment about source that is here, and
  // saying "written on feature-a" about it would be true and useless.
  if (divergent(review)) return { kind: 'other-branch', branch: originBranch(review), here: c.branch, pinned };
  return null;
}

/**
 * Whether a person may reword a message: their own words, and only a person's.
 *
 * A message carrying no actor at all is from before authorship was recorded,
 * which can only be this installation's own history — a local ledger had
 * exactly one writer. It is yours here and it exists nowhere else, so both
 * halves of that are true at once.
 */
export const canEditMessage = (message, actorId) => {
  if (!message || message.authorType !== 'human') return false;
  if (!message.actorId) return true;
  return !!actorId && message.actorId === actorId;
};

/**
 * Whether a person may take a message out of a thread.
 *
 * Wider than editing, and unchanged from the local rule: your own words, and
 * an agent's replies. Never another person's — taking somebody else's words
 * out of a shared conversation is not tidying, it is editing the record.
 */
export const canDeleteMessage = (message, actorId) => {
  if (!message) return false;
  if (message.authorType === 'agent') return true;
  if (!message.actorId) return true;
  return !!actorId && message.actorId === actorId;
};

/** Whether a person may delete a whole review: theirs, or one an agent left. */
export const canDeleteThread = (review, actorId) => {
  const author = review?.author;
  if (!author) return true; // a review from before authorship was recorded
  if (author.actorKind === 'agent') return true;
  return !!actorId && author.actorId === actorId;
};

export default mayPin;
