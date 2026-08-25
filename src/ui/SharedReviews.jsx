import React from 'react';
import { ResolveIcon, CloseIcon, OrphanIcon } from './Icons.jsx';

// Sharing, as one line in the Comments panel.
//
// The temptation with something like this is a settings screen: a server
// field, a token field, a members list, a sync log, a connection indicator.
// That would be infrastructure administration living in a panel whose whole
// job is to show somebody three sentences of feedback. So the resting state is
// ONE ROW — who this is shared with, when it last caught up, and a button that
// catches up now — and everything that needs a form is behind a dialog that is
// only ever open while somebody is filling it in.
//
// What is deliberately not here: presence dots, avatars, "Alice is typing",
// unread badges, a live connection light. None of them would be true — this
// synchronises when there is a reason to and not otherwise — and a green dot
// that means "we spoke a minute ago" is a green dot that will be read as "we
// are speaking now".

const shortAgo = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/** What a failed synchronisation should say, in words somebody can act on. */
export function syncProblemText(problem) {
  if (!problem) return null;
  switch (problem.kind) {
    case 'offline':
      return 'Can’t reach the reviews server. Your comments are saved here and will go over when it answers.';
    case 'timeout':
      return 'The reviews server didn’t answer. Nothing is lost — try again in a moment.';
    case 'unauthorized':
      return 'The reviews server refused this workspace credential. Ask for a new invitation.';
    case 'not_found':
      return 'That workspace is no longer on the reviews server.';
    case 'too_large':
      return 'Something in this project is too large to share.';
    case 'workspace_mismatch':
      return 'This project is linked to a different workspace than its comments were shared with.';
    case 'identity_mismatch':
      return 'This computer’s identity isn’t the one that joined this workspace. Ask for a new invitation.';
    case 'refused_events':
      return problem.detail || 'The workspace would not take some of these changes.';
    case 'busy':
      return 'The reviews server asked Stacki to wait a moment.';
    default:
      return problem.detail || 'Synchronising these comments didn’t work.';
  }
}

/**
 * The resting row.
 *
 * `shared.pending` is the number of things written here that have not left
 * this machine. It is shown because it is the only honest way to say "you are
 * not caught up" in a system that does not stream — silence would look
 * identical to being up to date.
 */
export function SharedReviewsBar({ shared, onSync, onSetUp, onManage, busy = false }) {
  if (!shared) return null;
  const problem = syncProblemText(shared.problem);

  if (!shared.enabled) {
    return (
      <div className="shared-bar">
        <span className="shared-off">Comments are only on this computer.</span>
        <button type="button" className="shared-link" onClick={onSetUp}>
          Share…
        </button>
      </div>
    );
  }

  return (
    <div className={`shared-bar${problem ? ' has-problem' : ''}`}>
      <button type="button" className="shared-name" onClick={onManage} title="Shared Reviews">
        {shared.workspace?.displayName || 'Shared'}
      </button>
      <span className="shared-when">
        {shared.syncing || busy ? 'Syncing…' : `Synced ${shortAgo(shared.lastSyncAt)}`}
        {shared.pending > 0 && !problem ? ` · ${shared.pending} to send` : ''}
      </span>
      <button type="button" className="shared-link" onClick={onSync} disabled={busy || shared.syncing}>
        Sync
      </button>
      {problem && (
        <div className="shared-problem">
          <OrphanIcon size={12} />
          <span>{problem}</span>
        </div>
      )}
    </div>
  );
}

const FIELDS = { server: '', signupToken: '', invite: '', name: '' };

/**
 * Starting a workspace, joining one, or looking at the one you are in.
 *
 * Three panes and no tabs beyond the two a person is choosing between, because
 * this is a thing somebody does once per project and then never again.
 */
export function SharedReviewsDialog({
  shared,
  localCount = 0,
  onClose,
  onEnable,
  onJoin,
  onDisable,
  onInvite,
  onRename,
}) {
  const [mode, setMode] = React.useState(shared?.enabled ? 'manage' : 'start');
  const [fields, setFields] = React.useState({ ...FIELDS, name: shared?.identity?.displayName || '' });
  // The privacy decision, and it starts OFF. A project's back catalogue of
  // comments is candid by nature — it is what somebody thinks about work,
  // often somebody else's — and uploading it because a box defaulted to
  // ticked is not a mistake anybody can take back.
  const [publishExisting, setPublishExisting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [invite, setInvite] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (!result?.ok) {
        setError(result?.message || 'That did not work.');
        return null;
      }
      return result;
    } catch (err) {
      setError('That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* a clipboard that refuses is not worth an error message; the text is on screen */
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shared-dialog" role="dialog" aria-modal="true" aria-label="Shared Reviews">
        <div className="modal-header">
          Shared Reviews
          <button className="review-x" onClick={onClose} title="Close">
            <CloseIcon size={12} />
          </button>
        </div>

        {mode === 'manage' && shared?.enabled ? (
          <div className="modal-body shared-body">
            <p className="dim">
              This project’s comments are shared with <strong>{shared.workspace?.displayName || 'a workspace'}</strong>{' '}
              on {shared.workspace?.server}.
            </p>
            <label className="shared-field">
              <span>Your name here</span>
              <input
                value={fields.name}
                maxLength={60}
                placeholder={shared.identity?.displayName || 'You'}
                onChange={set('name')}
                onBlur={() => fields.name.trim() && onRename(fields.name.trim())}
              />
            </label>
            {shared.private > 0 && (
              <p className="dim small">
                {shared.private} {shared.private === 1 ? 'comment stays' : 'comments stay'} on this computer — they were
                here before sharing was turned on and were not published.
              </p>
            )}
            <div className="shared-actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={async () => {
                  const made = await run(() => onInvite());
                  if (made) setInvite(made.invite);
                }}
              >
                Invite someone
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => run(() => onDisable())}>
                Stop sharing
              </button>
            </div>
            {invite && (
              <div className="shared-invite">
                <p className="dim small">
                  Send this to one person. It works once, and it expires. Anyone who has it can read and write this
                  project’s comments — so send it the way you would send a password.
                </p>
                <code>{invite}</code>
                <button type="button" className="ghost" onClick={() => copy(invite)}>
                  {copied ? (
                    <>
                      <ResolveIcon size={12} /> Copied
                    </>
                  ) : (
                    'Copy'
                  )}
                </button>
              </div>
            )}
            <p className="dim small">
              Stopping keeps every comment you have. It only stops this computer talking to the workspace.
            </p>
          </div>
        ) : (
          <div className="modal-body shared-body">
            <div className="seg wide">
              <button className={mode === 'start' ? 'on' : ''} onClick={() => setMode('start')}>
                Start one
              </button>
              <button className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>
                Join with an invitation
              </button>
            </div>

            <label className="shared-field">
              <span>Your name</span>
              <input value={fields.name} maxLength={60} placeholder="You" onChange={set('name')} />
            </label>

            {mode === 'start' ? (
              <>
                <label className="shared-field">
                  <span>Reviews server</span>
                  <input value={fields.server} placeholder="http://127.0.0.1:43822" onChange={set('server')} />
                </label>
                <label className="shared-field">
                  <span>Signup token</span>
                  <input
                    value={fields.signupToken}
                    type="password"
                    placeholder="from the server that printed it"
                    onChange={set('signupToken')}
                  />
                </label>
                <p className="dim small">
                  Stacki has no cloud. Run <code>npm run reviews:serve</code> — or point this at one your team already
                  runs — and it prints the address and the token.
                </p>
              </>
            ) : (
              <label className="shared-field">
                <span>Invitation</span>
                <input value={fields.invite} placeholder="stacki1.…" onChange={set('invite')} />
              </label>
            )}

            {localCount > 0 && (
              <label className="shared-check">
                <input
                  type="checkbox"
                  checked={publishExisting}
                  onChange={(e) => setPublishExisting(e.target.checked)}
                />
                <span>
                  Share the {localCount} {localCount === 1 ? 'comment' : 'comments'} already in this project.
                  <em>
                    {' '}
                    Leave this off and they stay on this computer for good; sharing starts with the next comment.
                  </em>
                </span>
              </label>
            )}

            {error && <div className="shared-error">{error}</div>}

            <div className="shared-actions">
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || (mode === 'start' ? !fields.server.trim() || !fields.signupToken.trim() : !fields.invite.trim())}
                onClick={async () => {
                  if (fields.name.trim()) await onRename(fields.name.trim());
                  const done = await run(() =>
                    mode === 'start'
                      ? onEnable({
                          server: fields.server.trim(),
                          signupToken: fields.signupToken.trim(),
                          publishExisting,
                        })
                      : onJoin({ invite: fields.invite.trim(), publishExisting })
                  );
                  if (done) setMode('manage');
                }}
              >
                {busy ? 'Working…' : mode === 'start' ? 'Start sharing' : 'Join'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SharedReviewsBar;
