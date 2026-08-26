import React from 'react';
import ReviewThread, { ReviewWhere, ReviewStatusDot, authorLabel } from '../ui/ReviewThread.jsx';
import { SharedReviewsBar, SharedReviewsDialog } from '../ui/SharedReviews.jsx';
import { ReviewIcon, PinIcon, OrphanIcon, BackIcon } from '../ui/Icons.jsx';

// The comments panel.
//
// Called Comments where a person can see it and Visual Review everywhere in
// the code, which is not a slip: the object underneath is a review thread with
// a workflow, and the thing a person does is leave a comment on something they
// are looking at. Making ordinary feedback sound like ticket triage is how a
// feature like this stops getting used.
//
// Two filters and nothing else. Status, because "what still wants doing" is
// the question this panel exists to answer, and scope, because a page's worth
// of comments and a project's worth are both things somebody wants. No
// assignees, no labels, no sort order, no columns — a bigger table would not
// make a single comment easier to act on.
//
// Sharing adds exactly one row and one name. The row says who these comments
// are shared with and when they last caught up; the name says who wrote each
// one, because on a shared thread "You" is a different person depending on who
// is reading. Everything else sharing could have brought — presence, unread
// counts, avatars, activity — is not here, and the reason is the same reason
// there are only two filters.

const STATUS_TABS = [
  { id: 'open', label: 'Open' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const shortAgo = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

export default function CommentsPanel({
  reviews = [],
  status,
  onStatus,
  scope,
  onScope,
  openId,
  onOpen,
  // Whether the open thread has taken over the panel body. See App.jsx: a long
  // conversation is docked here rather than opened in a card over the design.
  expanded = false,
  onExpand = null,
  onAct,
  onFocus,
  onDelete,
  onColor,
  onEditMessage,
  onDeleteMessage,
  busyId = null,
  problem = null,
  hiddenPins = 0,
  pinsVisible = true,
  onTogglePins,
  commenting = false,
  onToggleComment,
  // Sharing. Absent on a project that has never been shared, which is every
  // project until somebody says otherwise.
  shared = null,
  // Every review in the project, not the filtered view — the question "share
  // the ones already here?" is about all of them.
  totalCount = 0,
  actorId = null,
  withheldIds = null,
  onSync,
  onShareEnable,
  onShareJoin,
  onShareDisable,
  onShareInvite,
  onRename,
  syncing = false,
}) {
  const open = reviews.find((r) => r.id === openId) || null;
  const [setUp, setSetUp] = React.useState(false);
  // The thread the panel is showing, when it is showing one on its own.
  const openReview = openId ? reviews.find((r) => r.id === openId) || null : null;

  return (
    <div className="panel-section grow comments-panel">
      <div className="panel-header">
        <h2>Comments</h2>
        <div className="comments-head-actions">
          <button
            className={`icon-btn ${pinsVisible ? 'on' : ''}`}
            title={`${pinsVisible ? 'Hide' : 'Show'} comment pins (⇧C)`}
            onClick={onTogglePins}
          >
            <PinIcon size={14} />
          </button>
          <button
            className={`icon-btn ${commenting ? 'on' : ''}`}
            title="Leave a comment on the page (C)"
            onClick={onToggleComment}
          >
            <ReviewIcon size={16} />
          </button>
        </div>
      </div>

      {shared && (
        <SharedReviewsBar
          shared={shared}
          busy={syncing}
          onSync={() => onSync?.('manual')}
          onSetUp={() => setSetUp(true)}
          onManage={() => setSetUp(true)}
        />
      )}

      {setUp && shared && (
        <SharedReviewsDialog
          shared={shared}
          localCount={totalCount}
          onClose={() => setSetUp(false)}
          onEnable={onShareEnable}
          onJoin={onShareJoin}
          onDisable={onShareDisable}
          onInvite={onShareInvite}
          onRename={onRename}
        />
      )}

      {/* The ledger itself went wrong. Rare, and worth a sentence rather than
          a silence — a panel that is simply empty because a file could not be
          read looks exactly like a project nobody has commented on. */}
      {problem && problem.kind !== 'partial' && (
        <div className="comments-problem">
          {problem.kind === 'newer'
            ? 'These comments were saved by a newer version of Stacki, so this one is leaving them alone. Update Stacki to read them.'
            : problem.kind === 'corrupt'
              ? 'The saved comments could not be read, so they have been set aside rather than deleted. New comments will save normally.'
              : problem.kind === 'write_failed'
                ? 'Comments are not being saved to disk right now — they will be lost when Stacki closes.'
                : 'The comment file could not be opened.'}
        </div>
      )}

      <div className="comments-filters">
        <div className="seg">
          {STATUS_TABS.map((t) => (
            <button key={t.id} className={status === t.id ? 'on' : ''} onClick={() => onStatus(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="seg wide">
          <button className={scope === 'page' ? 'on' : ''} onClick={() => onScope('page')}>
            This page
          </button>
          <button className={scope === 'project' ? 'on' : ''} onClick={() => onScope('project')}>
            All pages
          </button>
        </div>
      </div>

      {/* The docked reader.

          It replaces the list rather than sitting inside it, so the thread's
          own header and reply box are pinned to the panel instead of scrolling
          with a list of other comments. The pin on the canvas stays selected
          the whole time — this is a second way of reading the same thread, not
          a different place for it to live — and there is one obvious way back. */}
      {expanded && openReview ? (
        <div className="panel-body comments-reader">
          <button className="comments-back" onClick={() => onExpand?.(false)}>
            <BackIcon size={12} /> All comments
          </button>
          <ReviewThread
            review={openReview}
            actorId={actorId}
            density="expanded"
            pinned={!withheldIds?.has(openReview.id)}
            busy={busyId === openReview.id}
            onAct={(action, extra) => onAct(openReview.id, action, extra)}
            onFocus={() => onFocus(openReview)}
            onDelete={() => onDelete(openReview.id)}
            onColor={(c) => onColor?.(openReview.id, c)}
            onEditMessage={onEditMessage ? (messageId, message) => onEditMessage(openReview.id, messageId, message) : null}
            onDeleteMessage={onDeleteMessage ? (messageId) => onDeleteMessage(openReview.id, messageId) : null}
            onExpand={onExpand ? () => onExpand(false) : null}
            onClose={() => onOpen(null)}
          />
        </div>
      ) : (
      <div className="panel-body comments-body">
        {!reviews.length && (
          <div className="comments-empty">
            {status === 'open' ? (
              <>
                <ReviewIcon size={20} />
                <p>Nothing open here.</p>
                <p className="dim">
                  Press <kbd>C</kbd> and click something on the page to leave a comment on it. Your coding agent can
                  read them through Stacki’s MCP server.
                </p>
              </>
            ) : (
              <p className="dim">
                No{status === 'all' ? '' : ` ${status}`} comments {scope === 'page' ? 'on this page' : 'in this project'}.
              </p>
            )}
          </div>
        )}

        {reviews.map((r) =>
          r.id === openId ? (
            <div key={r.id} className="comments-open">
              <ReviewThread
                review={r}
                actorId={actorId}
                pinned={!withheldIds?.has(r.id)}
                busy={busyId === r.id}
                onAct={(action, extra) => onAct(r.id, action, extra)}
                onFocus={() => onFocus(r)}
                onDelete={() => onDelete(r.id)}
                onColor={(c) => onColor?.(r.id, c)}
                onEditMessage={onEditMessage ? (messageId, message) => onEditMessage(r.id, messageId, message) : null}
                onDeleteMessage={onDeleteMessage ? (messageId) => onDeleteMessage(r.id, messageId) : null}
                onExpand={onExpand ? () => onExpand(true) : null}
                onClose={() => onOpen(null)}
              />
            </div>
          ) : (
            <button key={r.id} className="comments-row" onClick={() => onOpen(r.id)}>
              <ReviewStatusDot status={r.status} anchorState={r.anchorState} color={r.color} />
              <span className="comments-row-main">
                <span className="comments-row-top">
                  {r.number != null && <span className="review-number">#{r.number}</span>}
                  {/* Who left it, but only when that is not obvious. On a
                      project nobody shares, every comment is yours and a
                      column of "You" is noise. */}
                  {shared?.enabled && (
                    <span className={`comments-row-author is-${r.author?.actorKind || 'human'}`}>
                      {authorLabel(r.author, actorId)}
                    </span>
                  )}
                  <ReviewWhere review={r} compact />
                  <span className="spacer" />
                  {r.anchorState === 'orphaned' && <OrphanIcon size={11} />}
                  {r.replies > 0 && <span className="comments-count">{r.replies + 1}</span>}
                  <span className="comments-age">{shortAgo(r.updatedAt)}</span>
                </span>
                <span className="comments-excerpt">{r.message}</span>
              </span>
            </button>
          )
        )}

        {/* Reviews that are real but have nowhere to point on this render.
            Said out loud, because a pin count that quietly differs from a list
            count is the sort of thing people assume is a bug in the list. */}
        {hiddenPins > 0 && pinsVisible && (
          <div className="comments-hidden-note">
            {hiddenPins} {hiddenPins === 1 ? 'comment has' : 'comments have'} no pin on this page — the element isn’t
            rendered here, Stacki can’t find it any more, or it was written against source this checkout doesn’t have.
          </div>
        )}
      </div>
      )}
    </div>
  );
}
