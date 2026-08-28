import React from 'react';
import AutoTextarea from './AutoTextarea.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { ResolveIcon, DeferIcon, ReopenIcon, OrphanIcon, TrashIcon, CloseIcon, PencilIcon, PinIcon, BackIcon, MoreIcon } from './Icons.jsx';
import ReviewMarkdown, { safeHref } from './ReviewMarkdown.jsx';
import { applyMarkdownKey, restoreCaret } from './markdownKeys.js';
import { canDeleteMessage, canDeleteThread, canEditMessage, checkoutNote } from '../reviewCheckout.js';
import useDismiss from './useDismiss.js';

// One review, opened.
//
// There is exactly ONE place a review is read: the Inspector, docked beside
// the canvas. Not a popover over its pin — hovering a pin gets a passive Peek
// that cannot be clicked, and clicking one opens this. A conversation that
// appeared on top of the design was covering the thing it was about, and a
// component that had to work both as a floating card and as a docked panel
// was two layouts wearing one name.
//
// What it deliberately doesn't have: mentions, reactions, attachments. A
// review is a sentence about an element, and each of those is another thing
// between writing the sentence and the agent reading it.
//
// The body IS Markdown — see ReviewMarkdown.jsx. Agents write it whether or
// not anything renders it, so the choice was between rendering it and showing
// people raw asterisks. No raw HTML, and links go to the browser rather than
// navigating the app.
//
// Since it can be SHARED it says two more things, and they are the two that
// stop a shared thread being misread. Who said each line — because "You" means
// a different person depending on who is looking, which is also why messages
// carry an avatar here and nowhere else. And, when it applies, how the thread
// stands against the source in front of you: a review resolved on a commit
// this checkout does not have is not a review that has been fixed HERE, and
// the one thing this must never do is draw a tick over a bug somebody can
// still see.

const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 8 ? `${d}d ago` : new Date(t).toLocaleDateString();
};

/**
 * What to call whoever wrote something.
 *
 * "You" only when it really is you. A shared thread read on somebody else's
 * machine that called every human message "You" would be worse than useless —
 * it would be wrong in the most confusing possible way.
 */
export function authorLabel(who, actorId) {
  if (!who) return 'You';
  if (who.actorKind === 'agent' || who.authorType === 'agent') return who.actorName || 'Agent';
  if (actorId && who.actorId && who.actorId === actorId) return 'You';
  // No actor id at all is a message from before authorship was recorded, which
  // only ever exists in this installation's own history.
  if (!who.actorId) return 'You';
  return who.actorName || 'Someone';
}

/**
 * What the checkout has to say about this review, in words.
 *
 * The wording is the least important part of it; the invariant is that a
 * resolution made somewhere this tree has not been is never shown as done
 * here, and that "cannot tell" is said as uncertainty rather than as absence.
 */
export function CheckoutNote({ review, pinned = true }) {
  const [open, setOpen] = React.useState(false);
  // Folded again whenever this is about a different review. Without it, opening
  // the details on one thread and then clicking through to the next leaves the
  // next one expanded — the state belongs to the note being read, not to the
  // slot it is being read in.
  React.useEffect(() => setOpen(false), [review?.id]);
  const note = checkoutNote(review, { pinned });
  if (!note) return null;
  const who = note.who || 'Somebody';

  // One line that says what happened, and a sentence behind it that says what
  // it means for what is on screen right now.
  //
  // It used to be the sentence, always, in a yellow box — three or four lines
  // of a card that is only about fifteen lines tall, above every message, on
  // every thread that had ever crossed a branch. The information is worth
  // keeping and was worth far less room, so the line is the default and the
  // explanation is a click away.
  //
  // Tone is the one thing here that must not drift. A resolution this checkout
  // cannot see, and a resolution Stacki cannot prove, are both marked as
  // unsettled — quietly, but marked — because the whole point of this note is
  // to stop a tick being drawn over a bug somebody can still see. Only the
  // ordinary case, where the review came from another branch and its element
  // was found here, is allowed to be silent-coloured.
  let tone = 'note';
  let icon = <PinIcon size={12} />;
  let bits = [];
  let detail = null;

  if (note.kind === 'resolved-elsewhere') {
    tone = 'behind';
    icon = <OrphanIcon size={12} />;
    bits = [`Resolved by ${who}`, note.commit, 'not in your checkout'];
    detail = 'Your checkout doesn’t include that change yet, so what you are looking at may still be the old version.';
  } else if (note.kind === 'resolved-unproven') {
    tone = 'unproven';
    icon = <OrphanIcon size={12} />;
    bits = [`Resolved by ${who}`, note.commit, note.uncommitted ? 'uncommitted' : 'checkout unknown'];
    detail = note.uncommitted
      ? 'That was on uncommitted work, so Stacki can’t tell whether you have it.'
      : 'Stacki can’t tell whether your checkout includes it — that commit isn’t in this repository.';
    if (note.unchanged) detail += ' The file this was about hasn’t changed here.';
  } else if (note.kind === 'missing-source') {
    tone = 'behind';
    icon = <OrphanIcon size={12} />;
    bits = ['Not in your checkout', note.branch ? `written on ${note.branch}` : null];
    detail = 'The file this was written about isn’t here, so there is nothing to point at.';
  } else if (note.pinned) {
    // Written elsewhere, found here. Worth saying — it explains a comment you
    // do not remember writing — and not worth an alarm: drawn in the warning
    // colour, every review from a merged branch would carry a permanent
    // yellow warning about nothing.
    tone = 'note';
    icon = <PinIcon size={12} />;
    bits = [`Written on ${note.branch || 'another branch'}`, note.here ? `you are on ${note.here}` : null];
    detail = 'Stacki found the same element here.';
  } else {
    tone = 'unproven';
    icon = <OrphanIcon size={12} />;
    bits = [`Written on ${note.branch || 'another branch'}`, 'not placed here'];
    detail = 'Stacki won’t place a pin from another branch unless it can prove it is the same element.';
  }

  const line = bits.filter(Boolean).join(' · ');
  return (
    <div className={`review-prov is-${tone}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="review-prov-strip"
        aria-expanded={open}
        title={detail || line}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="review-prov-icon">{icon}</span>
        <span className="review-prov-line">{line}</span>
        {detail ? <span className="review-prov-more">{open ? 'Less' : 'Details'}</span> : null}
      </button>
      {open && detail ? <div className="review-prov-detail">{detail}</div> : null}
    </div>
  );
}

/**
 * What to call this review in the Inspector header.
 *
 * The innermost component it is inside, which is what somebody recognises,
 * falling back to the file and then to the tag. The number is already beside
 * this, so the job here is a NAME, and every step of the ladder now has to
 * produce one worth reading.
 *
 * What it used to do at each step, and why that was not enough:
 *
 *  - A chain of exactly one was skipped entirely, on the grounds that the page
 *    component is not a useful title. It is a better one than the file it came
 *    from, and it was falling through to that file anyway.
 *  - Only `.astro` came off the filename, so a review on a `.tsx`, `.vue`,
 *    `.svelte` or `.md` island was headed "Card.tsx".
 *  - `index.astro`, `[slug].astro` and `+page.svelte` are filenames that name
 *    a route rather than a thing, and every one of them rendered as "index" or
 *    "[slug]". The folder holding them is the name somebody would use out
 *    loud, so that is what comes back.
 *  - The last resort was the word "Comment", which is what every review is.
 *    A page name says more than a category, so it is tried first.
 */
const ROUTE_FILENAMES = /^(index|_index|page|\+page|\+layout|route|default)$/i;
const PLACE_FOLDERS = /^(src|pages|components|app|routes|layouts|islands)$/i;

/** A path, or a chain entry that happens to be one, reduced to a name. */
function nameFromPath(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  const file = parts[parts.length - 1] || '';
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  // A route file is named for its position, not its content. Its folder is the
  // thing with a name: content/blog/index.astro is "blog".
  if (stem && !ROUTE_FILENAMES.test(stem) && !/^\[.*\]$/.test(stem)) return stem;
  const folder = parts[parts.length - 2];
  if (folder && !PLACE_FOLDERS.test(folder)) return folder;
  return stem || null;
}

export function titleOf(review) {
  const chain = (review?.creationContext?.componentChain || []).filter(Boolean);
  // A chain entry is usually a component name — "PlanCard" — but the outermost
  // one is often the file it came from, extension and all. "index.astro" as a
  // header is a path where a name belongs, so anything that looks like a
  // filename goes through the same reduction the source path does.
  if (chain.length) {
    const leaf = String(chain[chain.length - 1]);
    return /[./]/.test(leaf) ? nameFromPath(leaf) || leaf : leaf;
  }

  if (review?.source) {
    const name = nameFromPath(review.source);
    if (name) return name;
  }

  if (review?.creationContext?.tag) return `<${review.creationContext.tag}>`;
  if (review?.page) return review.page === '/' ? 'Home' : review.page;
  return 'Comment';
}

/** Where a review is, in one line: the page, the component trail, the breakpoint. */
export function ReviewWhere({ review, compact = false }) {
  const chain = review?.creationContext?.componentChain || [];
  const source = review?.source || null;
  const bits = [];
  if (review?.page) bits.push(review.page);
  if (chain.length > 1) bits.push(chain.slice(1).join(' › '));
  else if (source) bits.push(source.split('/').pop());
  if (review?.breakpoint && review.breakpoint !== 'desktop') bits.push(review.breakpoint);
  if (review?.occurrenceCount > 1 && Number.isInteger(review.occurrence)) {
    bits.push(`copy ${review.occurrence + 1}/${review.occurrenceCount}`);
  }
  return <span className={`review-where${compact ? ' compact' : ''}`}>{bits.join(' · ')}</span>;
}

/**
 * The one word for what state a review is in.
 *
 * Four states, one vocabulary: open, deferred, resolved, orphaned. Every
 * review surface derives its colour, its shape and its accessible name from
 * this, so the dot in the index, the pin on the canvas and the row in the
 * cluster chooser can never disagree about what a review is.
 */
export function statusWord(status, anchorState) {
  if (anchorState === 'orphaned') return 'orphaned';
  if (status === 'resolved') return 'resolved';
  if (status === 'deferred') return 'deferred';
  return 'open';
}

/**
 * What state a review is in.
 *
 * Colour says the state and nothing else: blue open, grey deferred, green
 * resolved. It used to say the person's own grouping colour instead, with the
 * SHAPE carrying the state — which meant a review somebody had filed under
 * green looked resolved, and a deferred one could be violet. Two facts were
 * sharing one channel and the more important of them was losing.
 *
 * Shape still carries it too, so the dot survives being printed in grey or
 * looked at by somebody who cannot separate the hues: filled is open, a ring
 * is deferred, a ring with a tick is resolved, a dashed ring is an anchor
 * Stacki can no longer find.
 *
 * There is no second colour on a review any more. A user-chosen filing colour
 * used to sit alongside this one and earned nothing: it painted a 6px dot
 * nobody could read, competed with the state this dot exists to say, and left
 * every review surface ambiguous about which colour meant what. It is gone,
 * and this is the only colour a review has.
 *
 * `labelled` is for the surfaces where the dot is the ONLY thing saying the
 * state. Where the control around it already names it, the dot stays out of
 * the accessibility tree rather than repeating it.
 */
export function ReviewStatusDot({ status, anchorState, labelled = true }) {
  const word = statusWord(status, anchorState);
  const title =
    word === 'orphaned'
      ? 'Stacki can no longer find what this was about'
      : word.charAt(0).toUpperCase() + word.slice(1);
  return (
    <span
      className={`review-dot is-${word}`}
      {...(labelled ? { title, role: 'img', 'aria-label': title } : { 'aria-hidden': 'true' })}
    />
  );
}

/**
 * The whole thread: what was said, who said it, and the four things that can
 * happen to it next.
 *
 * `onAct` takes the same action names the MCP tool does, because they are the
 * same actions — the panel and an agent go through one implementation, so
 * "resolve" cannot come to mean two things.
 */
export default function ReviewThread({
  review,
  onAct,
  onFocus,
  onDelete,
  onClose,
  onEditMessage,
  onDeleteMessage,
  // Who is reading. Without it every human message would be signed "You",
  // which on a shared thread is a lie about somebody else's words.
  actorId = null,
  pinned = true,
  busy = false,
  autoFocusReply = false,
  // Back to the Comments index. The Inspector is a detail surface and every
  // detail surface needs a way out that is not "close everything".
  onBack = null,
  // Moving through the reviews without going back to the list for each one.
  // Every mature review tool has this — Figma's ‹ › in a comment, VS Code's
  // next problem, GitHub's next file — because triaging a page of feedback is
  // a sequence, and making somebody return to an index between every item
  // turns eight reviews into sixteen navigations.
  onPrev = null,
  onNext = null,
  position = null,
  // The unsent reply, held by whoever owns the Inspector rather than by this
  // component. It has to outlive the thread being swapped underneath it:
  // typing half a reply, going to look at another review and coming back to
  // find it gone is the kind of loss people do not forgive an editor for.
  reply = '',
  onReplyChange = null,
}) {

  /**
   * ⌘B / ⌘I / ⌘E / ⌘K on a plain textarea.
   *
   * Applied by hand rather than by execCommand so undo still behaves and the
   * value stays exactly what the store will hold. Anything that is not one of
   * the four falls straight through — a handler that swallowed ⌘A or ⌘C to be
   * safe would break selecting and copying in a box people write in.
   */
  const replyRef = React.useRef(null);

  /** What the three marks in the composer bar do, without a keyboard. */
  const applyTool = (key) => {
    const field = replyRef.current;
    if (!field) return;
    const next = applyMarkdownKey(
      { value: field.value, selectionStart: field.selectionStart, selectionEnd: field.selectionEnd },
      { key, metaKey: true }
    );
    if (!next) return;
    setReply(next.value);
    restoreCaret(field, next);
  };

  const markdownKeys = (setter) => (e) => {
    const field = e.currentTarget;
    const next = applyMarkdownKey(
      { value: field.value, selectionStart: field.selectionStart, selectionEnd: field.selectionEnd },
      e
    );
    if (!next) return false;
    e.preventDefault();
    setter(next.value);
    restoreCaret(field, next);
    return true;
  };
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef(null);
  const menuButtonRef = React.useRef(null);
  useDismiss(menuRef, menuOpen, () => setMenuOpen(false));
  const [deferring, setDeferring] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [ref, setRef] = React.useState('');
  // Which message is being reworded, and what it says while that is going on.
  const [editing, setEditing] = React.useState(null);
  const [draft, setDraft] = React.useState('');

  const setReply = (v) => onReplyChange?.(v);

  React.useEffect(() => {
    setMenuOpen(false);
    setDeferring(false);
    setReason('');
    setRef('');
    setEditing(null);
    setDraft('');
    // Deliberately NOT clearing `reply`: it belongs to the review, not to this
    // slot, and the owner keeps one per thread.
  }, [review?.id]);

  if (!review) return null;
  const orphaned = review.anchorState === 'orphaned';
  const messages = review.messages || [];
  const send = (action, extra) => onAct?.(action, extra);
  // Whose words, other than yours, are in this thread — named, because
  // deleting it takes them too.
  const othersHere = [
    ...new Set(
      messages
        .filter((m) => m.authorType === 'human' && m.actorId && m.actorId !== actorId)
        .map((m) => m.actorName)
        .filter(Boolean)
    ),
  ].join(' and ');

  return (
    <div className="review-thread">
      {/* The Inspector header.

          Back, what state it is in, what it is called, what it is about, and
          the one navigation action — going to the thing on the page. Anything
          rarer than that is behind the overflow, because a header with six
          controls in it is a header nobody reads.

          What used to be here and is not any more: a drag grip, for a window
          that no longer floats, and an expand toggle, for a second reading
          density that no longer exists. */}
      <div className="review-thread-head">
        {onBack && (
          <button className="review-back" onClick={onBack} title="All comments" aria-label="Back to all comments">
            <BackIcon size={13} />
          </button>
        )}
        {/* The dot says the state, and only the state. It used to be the
            colour picker as well, so pressing the thing that told you a review
            was resolved opened a palette that then changed the colour it had
            been saying "resolved" with. Both it and the filing colour it set
            are gone. */}
        <ReviewStatusDot status={review.status} anchorState={review.anchorState} />
        {/* What to call it out loud. The uuid is the identity; this is the
            name, and it is the same name on the pin, in the list and in
            whatever an agent was asked to fix. */}
        {review.number != null && <span className="review-number">#{review.number}</span>}
        <span className="review-head-title">{titleOf(review)}</span>
        {position && (
          <span className="review-step">
            <button
              type="button"
              className="review-x"
              onClick={onPrev}
              disabled={!onPrev}
              title="Previous comment (⌥↑)"
              aria-label="Previous comment"
            >
              ‹
            </button>
            {/* `detached` is a review that has left the filtered list while
                being read — resolved, most often. The count is still true; the
                ordinal is not, so it goes. */}
            <span
              className={`review-step-n${position.detached ? ' is-detached' : ''}`}
              aria-live="polite"
              title={
                position.detached
                  ? 'This comment is no longer in the current filter. Next carries on from where it was.'
                  : undefined
              }
            >
              {position.detached
                ? `${position.total} ${position.total === 1 ? 'other' : 'others'}`
                : `${position.index} of ${position.total}`}
            </span>
            <button
              type="button"
              className="review-x"
              onClick={onNext}
              disabled={!onNext}
              title="Next comment (⌥↓)"
              aria-label="Next comment"
            >
              ›
            </button>
          </span>
        )}
        {onFocus && !orphaned && (
          <button className="review-locate" onClick={onFocus} disabled={busy} title="Go to it on the page">
            Locate
          </button>
        )}
        {onDelete && (
          // A menu that could not be dismissed.
          //
          // It had no Escape and no click-away: the only way out was to press
          // the same ⋯ again, and pressing Escape — which is what anybody does
          // — fell through to the app, where it closed the whole Inspector.
          // Somebody who opened this menu to look at it lost the review they
          // were reading.
          //
          // Escape now closes the menu and nothing else, and focus goes back to
          // the button that opened it. `useDismiss` handles the click-away, and
          // it is the same one every other popup in the app uses — including
          // the part that matters here, that a click INTO the canvas iframe
          // never reaches this document.
          <div
            className="review-overflow"
            ref={menuRef}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !menuOpen) return;
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen(false);
              menuButtonRef.current?.focus();
            }}
          >
            <button
              ref={menuButtonRef}
              className="review-x"
              title="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              <MoreIcon size={13} />
            </button>
            {menuOpen && (
              <div className="review-menu" role="menu">
                {onDelete && canDeleteThread(review, actorId) && (
                  <button
                    role="menuitem"
                    className="is-danger"
                    disabled={busy}
                    onClick={async () => {
                      setMenuOpen(false);
                      if (
                        await confirmDialog({
                          title: 'Delete this comment?',
                          // On a shared thread "everything said in it" is other
                          // people's words, on their machines, and somebody
                          // agreeing to that has a right to know it.
                          body: othersHere
                            ? `Everything said in it goes with it — including ${othersHere}’s — for everyone in this workspace, and it cannot be brought back. To keep the record instead, resolve it.`
                            : 'Everything said in it goes with it, and it cannot be brought back. To keep the record instead, resolve it.',
                          confirmLabel: 'Delete',
                          danger: true,
                        })
                      ) {
                        onDelete();
                      }
                    }}
                  >
                    Delete comment…
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {onClose && (
          <button className="review-x" onClick={onClose} title="Close">
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {/* Where it lives, under the title rather than beside it — the file and
          the breakpoint are context for everything below, not part of the
          name. */}
      {/* Where it lives. The source path is what somebody acts on — the
          page route is already implied by the canvas they are looking at. */}
      <div className="review-thread-context">
        <span className="review-source-path">{review.source || review.page || ''}</span>
        {review.breakpoint && <span className="review-context-dot">·</span>}
        {review.breakpoint && <span>{review.breakpoint}</span>}
        {review.occurrenceCount > 1 && Number.isInteger(review.occurrence) && (
          <>
            <span className="review-context-dot">·</span>
            <span>
              copy {review.occurrence + 1}/{review.occurrenceCount}
            </span>
          </>
        )}
      </div>
      {/* Provenance sits here, above the conversation and below the name,
          because it changes how everything under it should be read. */}
      <CheckoutNote review={review} pinned={pinned} />

      {/* The ONLY thing that scrolls.

          The shell is `overflow: hidden` and this is the one region inside it
          with `overflow-y: auto`, which is what keeps the header and the reply
          box on screen through a two-thousand-word conversation. Before this,
          the whole panel scrolled: past the first screenful the number, the
          location, the stepper and the reply box had all gone, and the only
          way back to any of them was to scroll a wall of text. */}
      <div className="review-thread-scroll">
      {orphaned && (
        <div className="review-orphan">
          <OrphanIcon size={13} />
          <div>
            <strong>Its element is gone.</strong> Stacki can’t point at this any more — the markup was deleted, or
            changed past recognising. What it was about is still below.
          </div>
        </div>
      )}


      {/* What the human was looking at, kept from the moment they wrote it.
          On an orphan this is the only description of the target there is,
          which is exactly why it was frozen.

          It is also the way back to it. "Show me" was a third button in a row
          of workflow verbs, which is both crowded and wrong: going to the
          element is not a decision about the review, it is a fact about where
          the review is — so it belongs on the line that says where. */}
      {orphaned && (review.creationContext?.text || review.creationContext?.tag) &&
        React.createElement(
          onFocus && !orphaned ? 'button' : 'div',
          {
            className: `review-target${onFocus && !orphaned ? ' can-go' : ''}`,
            ...(onFocus && !orphaned
              ? { onClick: onFocus, disabled: busy, title: 'Go to it on the page' }
              : {}),
          },
          <code key="tag">
            {review.creationContext.tag ? `<${review.creationContext.tag}>` : review.creationContext.nodeKind}
          </code>,
          review.creationContext.text ? (
            <span key="text" className="review-target-text">
              “{review.creationContext.text}”
            </span>
          ) : null
        )}

      <div className="review-messages">
        {messages.map((m) => {
          // Only your own words can be reworded. An agent's reply can be taken
          // out of the thread, but it cannot be made to say something else
          // while still signed with its name — and another person's message is
          // not yours to touch at all. Both rules are enforced again in the
          // store and once more in the projection; this is only the button.
          const mine = canEditMessage(m, actorId);
          const removable = canDeleteMessage(m, actorId);
          const last = messages.length <= 1;
          const isEditing = editing === m.id;
          return (
            <div key={m.id} className={`review-msg is-${m.authorType}${isEditing ? ' editing' : ''}`}>
              <div className="review-msg-head">
                {/* A small initial rather than a coloured rule down the side.
                    The rail marked every message as important; an avatar marks
                    who said it, which is the thing that actually differs. */}
                <span className={`review-avatar is-${m.authorType}`} aria-hidden="true">
                  {(authorLabel(m, actorId) || '?').trim().charAt(0).toUpperCase()}
                </span>
                <span className={`review-author is-${m.authorType}`}>{authorLabel(m, actorId)}</span>
                <span className="review-time">{ago(m.createdAt)}</span>
                {/* Said out loud. A message somebody replied to and then
                    changed is a different thing from one nobody touched. */}
                {m.editedAt ? (
                  <span className="review-edited" title={`Edited ${ago(m.editedAt)}`}>
                    edited
                  </span>
                ) : null}
                {!isEditing && ((mine && onEditMessage) || (removable && onDeleteMessage)) && (
                  <span className="review-msg-tools">
                    {mine && onEditMessage && (
                      <button
                        type="button"
                        title="Edit this"
                        disabled={busy}
                        onClick={() => {
                          setEditing(m.id);
                          setDraft(m.body);
                        }}
                      >
                        <PencilIcon size={11} />
                      </button>
                    )}
                    {onDeleteMessage && removable && (
                      <button
                        type="button"
                        // The only thing in a thread is the thread. Deleting it
                        // from in here would be deleting the review sideways,
                        // so it says so rather than being quietly missing.
                        title={last ? 'This is the only thing in this review — delete the review instead' : 'Delete this'}
                        disabled={busy || last}
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: 'Delete this message?',
                              body: 'It goes out of the thread and cannot be brought back. The rest of the review stays.',
                              confirmLabel: 'Delete',
                              danger: true,
                            })
                          ) {
                            onDeleteMessage(m.id);
                          }
                        }}
                      >
                        <TrashIcon size={11} />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {isEditing ? (
                <form
                  className="review-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = draft.trim();
                    if (!text || text === m.body) {
                      setEditing(null);
                      return;
                    }
                    onEditMessage(m.id, text);
                    setEditing(null);
                  }}
                >
                  <AutoTextarea
                    value={draft}
                    minRows={2}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // The same two keys as the reply box: ⌘↩ saves, Escape
                      // puts it back the way it was.
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                        return;
                      }
                      if (markdownKeys(setDraft)(e)) return;
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <div className="review-actions">
                    <button type="button" className="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={busy || !draft.trim()}>
                      Save
                    </button>
                  </div>
                </form>
              ) : (
                <ReviewMarkdown text={m.body} />
              )}
            </div>
          );
        })}
      </div>

      {review.deferredReason && (
        <div className="review-note">
          <DeferIcon size={12} />
          <span>{review.deferredReason}</span>
        </div>
      )}
      {(review.externalRefs || []).map((r) => {
        // ONE link policy for the whole app. This had its own inline
        // `/^https?:\/\//` test, which is a second answer to a question
        // `safeHref` already answers: it let `mailto:` through as dead text
        // where a comment body renders it as a live link, and it accepted
        // `https:/\nevil` because a prefix test does not care what follows.
        // An external ref is a free string an agent wrote, so it gets the same
        // scrutiny a pasted link gets.
        const safe = safeHref(r);
        return (
          <div key={r} className="review-note review-ref">
            {safe ? (
              <button type="button" title={safe} onClick={() => window.avb.openExternal(safe)}>
                {r}
              </button>
            ) : (
              <span className="review-md-deadlink" title="Stacki only opens http, https and mailto links">
                {r}
              </span>
            )}
          </div>
        );
      })}

      </div>

      {/* Fixed. Whatever is being said above, the way to answer it and the
          two things that can happen next are always right here. */}
      <div className="review-thread-foot">
      {deferring ? (
        <form
          className="review-defer"
          onSubmit={(e) => {
            e.preventDefault();
            send('defer', { reason: reason.trim(), externalRef: ref.trim() });
            setDeferring(false);
          }}
        >
          <AutoTextarea
            value={reason}
            minRows={2}
            autoFocus
            placeholder="Why is this not being done now?"
            onChange={(e) => setReason(e.target.value)}
          />
          <input value={ref} placeholder="Tracked somewhere else? (link)" onChange={(e) => setRef(e.target.value)} />
          <div className="review-actions">
            <button type="button" className="ghost" onClick={() => setDeferring(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              Defer
            </button>
          </div>
        </form>
      ) : (
        <>
          <form
            className="review-reply"
            onSubmit={(e) => {
              e.preventDefault();
              const body = reply.trim();
              if (!body) return;
              send('reply', { message: body });
              setReply('');
            }}
          >
            <AutoTextarea
              ref={replyRef}
              value={reply}
              minRows={2}
              maxRows={10}
              autoFocus={autoFocusReply}
              placeholder="Reply…"
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                // ⌘↩ sends, ↩ makes a paragraph. A comment is often two
                // sentences and losing the second to a stray Enter is worse
                // than one extra keystroke.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                  return;
                }
                markdownKeys(setReply)(e);
              }}
            />
            {/* One line under the field: what it understands, and how to send.
                Said quietly, where somebody is already looking — a formatting
                toolbar above every reply box would be a row of buttons for a
                syntax most people writing here already know.

                The footer is deliberately small until it needs to be bigger. On
                a 14-inch laptop a composer that starts three rows tall is a
                third of the conversation gone before anybody types. */}
            {/* Three marks and a reminder. Not a formatting toolbar — these
                type the characters somebody would otherwise type, and the
                shortcut beside them is the thing most people will use. */}
            <div className="review-reply-bar">
              <button type="button" className="review-tool" title="Bold (⌘B)" onMouseDown={(e) => e.preventDefault()} onClick={() => applyTool('b')}>
                <b>B</b>
              </button>
              <button type="button" className="review-tool" title="Italic (⌘I)" onMouseDown={(e) => e.preventDefault()} onClick={() => applyTool('i')}>
                <i>I</i>
              </button>
              <button type="button" className="review-tool" title="Code (⌘E)" onMouseDown={(e) => e.preventDefault()} onClick={() => applyTool('e')}>
                {'</>'}
              </button>
              <span className="review-md-hint">Markdown</span>
              <span className="review-reply-spacer" />
              {reply.trim() ? (
                <button type="submit" className="primary review-send" disabled={busy}>
                  Reply
                </button>
              ) : (
                <span className="review-md-hint">⌘↩ to reply</span>
              )}
            </div>
          </form>

          {/* One row, and it does not wrap. Two verbs: the things that can
              happen to this review next.

              There is no second ⋯ down here. There were two, both opening the
              same menu from opposite ends of the panel, and a menu that can be
              reached from two places is a menu somebody has to check twice to
              be sure they have seen all of it. The one in the header stays,
              next to the thing it acts on. */}
          <div className="review-actions">
            <span className="spacer" />
            {review.status === 'open' ? (
              <>
                {/* Neutral. Deferring is not an achievement and not a
                    setback — it is "not now". */}
                <button className="ghost" onClick={() => setDeferring(true)} disabled={busy}>
                  <DeferIcon size={12} /> Defer
                </button>
                {/* Green, and the same green as a resolved dot. The button
                    that reaches the state and the mark that reports it were
                    different colours, so nothing on screen connected the act
                    to its result. */}
                <button className="review-resolve" onClick={() => send('resolve', {})} disabled={busy}>
                  <ResolveIcon size={12} /> Resolve
                </button>
              </>
            ) : (
              /* Deliberately NOT green: reopening undoes resolution, and the
                 resolve colour on the button that un-resolves is a lie. */
              <button className="primary" onClick={() => send('reopen', {})} disabled={busy}>
                <ReopenIcon size={12} /> Reopen
              </button>
            )}
          </div>
        </>
      )}
      </div>
    </div>
  );
}
