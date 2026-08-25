import React from 'react';
import AutoTextarea from './AutoTextarea.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { ResolveIcon, DeferIcon, ReopenIcon, OrphanIcon, TrashIcon, CloseIcon, PencilIcon } from './Icons.jsx';
import { canDeleteMessage, canDeleteThread, canEditMessage, checkoutNote } from '../reviewCheckout.js';

// One review, opened.
//
// The same component wherever a thread is read — in the panel and in the
// popover over its pin — because a review that looked like two different
// things depending on where you clicked it would be two features to learn.
//
// What it deliberately doesn't have: mentions, reactions, avatars, attachments,
// rich text. A review is a sentence about an element, and every one of those
// would be another thing between writing the sentence and the agent reading it.
// The body is plain text; a person who wants a backtick can type one.
//
// Since it can be SHARED it says two more things, and they are the two that
// stop a shared thread being misread. Who said each line — because "You" means
// a different person depending on who is looking. And, when it applies, how
// the thread stands against the source in front of you: a review resolved on a
// commit this checkout does not have is not a review that has been fixed HERE,
// and the one thing this must never do is draw a tick over a bug somebody can
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
  const note = checkoutNote(review, { pinned });
  if (!note) return null;
  const who = note.who || 'Somebody';
  if (note.kind === 'resolved-elsewhere') {
    return (
      <div className="review-checkout is-behind">
        <OrphanIcon size={13} />
        <div>
          <strong>
            Resolved by {who}
            {note.commit ? ` on ${note.commit}` : ''}.
          </strong>{' '}
          Your checkout doesn’t include that change yet, so what you are looking at may still be the old version.
        </div>
      </div>
    );
  }
  if (note.kind === 'resolved-unproven') {
    return (
      <div className="review-checkout">
        <OrphanIcon size={13} />
        <div>
          <strong>Resolved by {who}{note.commit ? ` on ${note.commit}` : ''}.</strong>{' '}
          {note.uncommitted
            ? 'That was on uncommitted work, so Stacki can’t tell whether you have it.'
            : 'Stacki can’t tell whether your checkout includes it — that commit isn’t in this repository.'}
          {note.unchanged ? ' The file this was about hasn’t changed here.' : ''}
        </div>
      </div>
    );
  }
  if (note.kind === 'missing-source') {
    return (
      <div className="review-checkout">
        <OrphanIcon size={13} />
        <div>
          <strong>Not in your checkout.</strong> The file this was written about
          {note.branch ? ` on ${note.branch}` : ''} isn’t here, so there is nothing to point at.
        </div>
      </div>
    );
  }
  return (
    <div className="review-checkout">
      <OrphanIcon size={13} />
      <div>
        <strong>Written on {note.branch || 'another branch'}</strong>
        {note.here ? `, and you are on ${note.here}` : ''}.{' '}
        {note.pinned
          ? 'Stacki found the same element here.'
          : 'Stacki won’t place a pin from another branch unless it can prove it is the same element.'}
      </div>
    </div>
  );
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

// The colours a person can file their own notes under. Mirrors the store's
// list, which is what actually enforces it.
export const REVIEW_COLORS = ['blue', 'violet', 'teal', 'green', 'amber', 'rose'];

/**
 * The marker that says what state a review is in.
 *
 * SHAPE is the state — filled is open, hollow is deferred, a dashed ring is an
 * anchor Stacki can no longer find, a faint grey ring is done. COLOUR is the
 * person's own grouping and means nothing about any of that. Keeping the two
 * apart is what lets a pin answer "is this done" without a legend while still
 * letting somebody colour their notes however they like.
 */
export function ReviewStatusDot({ status, anchorState, color }) {
  const title =
    anchorState === 'orphaned'
      ? 'Stacki can no longer find what this was about'
      : status === 'resolved'
        ? 'Resolved'
        : status === 'deferred'
          ? 'Deferred'
          : 'Open';
  return (
    <span
      className={`review-dot is-${status} c-${REVIEW_COLORS.includes(color) ? color : 'blue'}${
        anchorState === 'orphaned' ? ' orphaned' : ''
      }`}
      title={title}
    />
  );
}

/** Pick which of your notes this one belongs with. */
export function ReviewPalette({ value, onPick }) {
  return (
    <div className="review-palette" role="group" aria-label="Comment colour">
      {REVIEW_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`review-swatch c-${c}${value === c ? ' on' : ''}`}
          title={c}
          onClick={(e) => {
            e.stopPropagation();
            onPick(c);
          }}
        />
      ))}
    </div>
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
  onColor,
  onEditMessage,
  onDeleteMessage,
  // Who is reading. Without it every human message would be signed "You",
  // which on a shared thread is a lie about somebody else's words.
  actorId = null,
  pinned = true,
  busy = false,
  autoFocusReply = false,
}) {
  const [reply, setReply] = React.useState('');
  const [picking, setPicking] = React.useState(false);
  const [deferring, setDeferring] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [ref, setRef] = React.useState('');
  // Which message is being reworded, and what it says while that is going on.
  const [editing, setEditing] = React.useState(null);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => {
    setReply('');
    setPicking(false);
    setDeferring(false);
    setReason('');
    setRef('');
    setEditing(null);
    setDraft('');
  }, [review?.id]);

  if (!review) return null;
  const orphaned = review.anchorState === 'orphaned';
  const messages = review.messages || [];
  const send = (action, extra) => onAct?.(action, extra);

  return (
    <div className="review-thread">
      {/* The two things that are ABOUT the thread rather than actions on it —
          throwing it away and closing it — live up here. Down in the action row
          they made three workflow buttons look like five, and put a delete
          next to a Resolve. */}
      <div className="review-thread-head">
        {/* The dot is also the way to recolour: it is the thing whose colour is
            being changed, so it is where somebody reaches for it. */}
        {onColor ? (
          <button
            className="review-dot-btn"
            title="Colour"
            onClick={(e) => {
              e.stopPropagation();
              setPicking((v) => !v);
            }}
          >
            <ReviewStatusDot status={review.status} anchorState={review.anchorState} color={review.color} />
          </button>
        ) : (
          <ReviewStatusDot status={review.status} anchorState={review.anchorState} color={review.color} />
        )}
        {/* What to call it out loud. The uuid is the identity; this is the
            name, and it is the same name on the pin, in the list and in
            whatever an agent was asked to fix. */}
        {review.number != null && <span className="review-number">#{review.number}</span>}
        <ReviewWhere review={review} />
        {onDelete && canDeleteThread(review, actorId) && (
          <button
            className="review-x review-trash"
            title="Delete this comment"
            disabled={busy}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: 'Delete this comment?',
                  body: 'Everything said in it goes with it, and it cannot be brought back. To keep the record instead, resolve it.',
                  confirmLabel: 'Delete',
                  danger: true,
                })
              ) {
                onDelete();
              }
            }}
          >
            <TrashIcon size={12} />
          </button>
        )}
        {onClose && (
          <button className="review-x" onClick={onClose} title="Close">
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {picking && onColor && (
        <ReviewPalette
          value={review.color}
          onPick={(c) => {
            onColor(c);
            setPicking(false);
          }}
        />
      )}

      {orphaned && (
        <div className="review-orphan">
          <OrphanIcon size={13} />
          <div>
            <strong>Its element is gone.</strong> Stacki can’t point at this any more — the markup was deleted, or
            changed past recognising. What it was about is still below.
          </div>
        </div>
      )}

      {/* How this stands against the source that is actually here. Above the
          conversation, because it changes how everything below it should be
          read — a thread that says "resolved" over code that still has the
          bug is the one failure this feature must never produce. */}
      <CheckoutNote review={review} pinned={pinned} />

      {/* What the human was looking at, kept from the moment they wrote it.
          On an orphan this is the only description of the target there is,
          which is exactly why it was frozen.

          It is also the way back to it. "Show me" was a third button in a row
          of workflow verbs, which is both crowded and wrong: going to the
          element is not a decision about the review, it is a fact about where
          the review is — so it belongs on the line that says where. */}
      {(review.creationContext?.text || review.creationContext?.tag) &&
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
                      }
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
                <div className="review-body">{m.body}</div>
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
      {(review.externalRefs || []).map((r) => (
        <div key={r} className="review-note review-ref">
          {/* Openable only when it is actually a web address. An external
              reference is a free string an agent wrote, so anything else is
              shown as text rather than dressed up as a link that does nothing
              — and the main process refuses non-http schemes regardless. */}
          {/^https?:\/\//.test(r) ? (
            <button type="button" title={r} onClick={() => window.avb.openExternal(r)}>
              {r}
            </button>
          ) : (
            <span title={r}>{r}</span>
          )}
        </div>
      ))}

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
              value={reply}
              minRows={1}
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
                }
              }}
            />
            {reply.trim() && (
              <button type="submit" className="primary" disabled={busy}>
                Reply
              </button>
            )}
          </form>

          {/* One row, and it does not wrap. Three verbs at most: where it is,
              and the two things that can happen to it next. */}
          <div className="review-actions">
            <span className="spacer" />
            {review.status === 'open' ? (
              <>
                <button className="ghost" onClick={() => setDeferring(true)} disabled={busy}>
                  <DeferIcon size={12} /> Defer
                </button>
                <button className="primary" onClick={() => send('resolve', {})} disabled={busy}>
                  <ResolveIcon size={12} /> Resolve
                </button>
              </>
            ) : (
              <button className="primary" onClick={() => send('reopen', {})} disabled={busy}>
                <ReopenIcon size={12} /> Reopen
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
