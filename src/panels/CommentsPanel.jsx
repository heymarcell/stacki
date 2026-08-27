import React from 'react';
import { ReviewWhere, ReviewStatusDot, authorLabel } from '../ui/ReviewThread.jsx';
import { SharedReviewsBar, SharedReviewsDialog } from '../ui/SharedReviews.jsx';
import { SecureShareRow, SecureShareDialog } from '../ui/SecureShare.jsx';
import { ReviewIcon, PinIcon, OrphanIcon } from '../ui/Icons.jsx';

// The comments panel.
//
// Called Comments where a person can see it and Visual Review everywhere in
// the code, which is not a slip: the object underneath is a review thread with
// a workflow, and the thing a person does is leave a comment on something they
// are looking at. Making ordinary feedback sound like ticket triage is how a
// feature like this stops getting used.
//
// This is an INDEX. It lists reviews, filters them, and hands one to the
// Inspector — it does not act on them. It used to take onAct, onDelete,
// onColor, onEditMessage, onDeleteMessage and busyId as well, from back when
// the conversation was docked inside it, and it had stopped using every one of
// them: nine props threaded through App.jsx to be destructured and dropped.
// Reading them here suggested a second place where a review could be resolved
// or deleted, and there is exactly one.
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
  // Which review is selected. Selection and presentation are different
  // things now: a review stays selected when the Inspector closes, which is
  // what keeps its pin marked and a resolved marker visible.
  selectedId = null,
  onOpen,
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
  onSync,
  onShareEnable,
  onShareJoin,
  onShareDisable,
  onShareInvite,
  onSecureCreate,
  onSecureInvite,
  onSecureLeave,
  onSecureEnd,
  onSecureRelay,
  onCopy,
  onRename,
  syncing = false,
}) {
  const [setUp, setSetUp] = React.useState(false);
  // Which face of the secure dialog to open on: `create` from the Share… row,
  // `manage` from a share that already exists.
  const [shareMode, setShareMode] = React.useState(null);

  // A project shared through the old plaintext service keeps the old row and
  // the old dialog, unchanged. Everything else — which is every project
  // nobody has already set one up on — gets Secure Share.
  const legacy = shared?.mode === 'legacy';

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

      {shared && legacy && (
        <SharedReviewsBar
          shared={shared}
          busy={syncing}
          onSync={() => onSync?.('manual')}
          onSetUp={() => setSetUp(true)}
          onManage={() => setSetUp(true)}
        />
      )}

      {shared && !legacy && (
        <SecureShareRow
          shared={shared}
          busy={syncing}
          onShare={() => setShareMode('create')}
          onManage={() => setShareMode('manage')}
          onRetry={() => onSync?.('retry')}
        />
      )}

      {setUp && shared && legacy && (
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

      {shareMode && shared && !legacy && (
        <SecureShareDialog
          shared={shared}
          localCount={totalCount}
          mode={shareMode}
          onClose={() => setShareMode(null)}
          onCreate={onSecureCreate}
          onInvite={onSecureInvite}
          onLeave={async (...args) => {
            const result = await onSecureLeave?.(...args);
            if (result?.ok) setShareMode(null);
            return result;
          }}
          onEnd={async (...args) => {
            const result = await onSecureEnd?.(...args);
            if (result?.ok) setShareMode(null);
            return result;
          }}
          onRelay={onSecureRelay}
          onCopy={onCopy}
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

        {reviews.map((r) => (
          // A row, always. The conversation lives in the Inspector, which has
          // room for it — spelling a thread out inside a 260px navigation list
          // was the same words in two places and a list that jumped around as
          // rows grew into threads.
          <button
            key={r.id}
            // Addressable, so focus can come back here when the Inspector this
            // row opened is closed again. See restoreReviewFocus in App.jsx.
            data-review-row={r.id}
            className={`comments-row${r.id === selectedId ? ' on' : ''}`}
            aria-current={r.id === selectedId ? 'true' : undefined}
            onClick={() => onOpen(r.id)}
          >
            <ReviewStatusDot status={r.status} anchorState={r.anchorState} />
            <span className="comments-row-main">
              <span className="comments-row-top">
                {r.number != null && <span className="review-number">#{r.number}</span>}
                {/* Beside the number, exactly where the Inspector puts it. It
                    was a second dot out in the gutter next to the status dot,
                    which is two dots competing in the narrowest column in the
                    app — and the one that matters least was the one aligned to
                    the top of the row rather than to the text. */}
                {r.color && r.color !== 'blue' && (
                  <span className={`review-swatch-dot c-${r.color}`} aria-hidden="true" />
                )}
                <ReviewWhere review={r} compact />
                <span className="spacer" />
                {r.anchorState === 'orphaned' && <OrphanIcon size={11} />}
                <span className="comments-age">{shortAgo(r.updatedAt)}</span>
              </span>
              <span className="comments-excerpt">{r.message}</span>
              {/* Only when it says something the line above did not. On a
                  project nobody shares every comment is yours, and a column of
                  "You" is noise. */}
              {(r.replies > 0 || shared?.enabled) && (
                <span className="comments-row-meta">
                  {shared?.enabled && (
                    <span className={`comments-row-author is-${r.author?.actorKind || 'human'}`}>
                      {authorLabel(r.author, actorId)}
                    </span>
                  )}
                  {r.replies > 0 && (
                    <span className="comments-count">
                      {r.replies} {r.replies === 1 ? 'reply' : 'replies'}
                    </span>
                  )}
                </span>
              )}
            </span>
          </button>
        ))}

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
    </div>
  );
}
