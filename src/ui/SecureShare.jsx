import React from 'react';
import { ResolveIcon, CloseIcon, OrphanIcon, LockIcon } from './Icons.jsx';

// Sharing, as a product action rather than as server administration.
//
// The old dialog asked for a Reviews server and a signup token, offered "Start
// one" beside "Join with an invitation", and put a Sync button in the resting
// row. Every one of those is infrastructure showing through: they are true
// things about how it works and none of them is what a person came to do. What
// they came to do is show somebody their comments.
//
// So the whole feature is three sentences and a button:
//
//     Comments are private to this Mac.                        Share…
//     Share review comments securely with others.       Create secure share
//     Secure sharing is on.                             Copy invite link
//
// and the resting state of a working share is a lock and two words. No sync
// button, because a share that needs one is a share that is not working; no
// presence, no green dot, no "Alice is typing", because none of them would be
// true — this catches up when there is a reason to, and a dot that means "we
// spoke a minute ago" is a dot that will be read as "we are speaking now".
//
// WHAT IS SAID ABOUT THE CRYPTOGRAPHY, exactly and no more:
//
//     Review content is end-to-end encrypted before it leaves Stacki.
//     The relay cannot read it.
//
// Not "nothing is stored" — encrypted envelopes are stored, that is the whole
// point of asynchronous review. Not "Stacki knows nothing about you" — a relay
// sees an address and a size like every server does. The claim is the one that
// is true, and it is two lines because a person deciding whether to click a
// button is not reading a threat model.

const shortAgo = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What a failed sync should say, in words somebody can act on.
 *
 * Two rules run through all of these. The first sentence is never about
 * cryptography — "Stacki could not verify part of this shared review history"
 * is what a person needs; the code that produced it belongs in a log. The
 * second is that every one of them says, or plainly implies, that the comments
 * are still here. That is the thing somebody is actually frightened of when a
 * sharing feature shows them an error.
 */
export function secureProblemText(problem) {
  if (!problem) return null;
  switch (problem.kind) {
    case 'offline':
      return 'Offline. Your comments are saved here and will send when you’re connected.';
    case 'timeout':
      return 'The relay didn’t answer. Nothing is lost — Stacki will try again.';
    case 'unauthorized':
      return 'This Mac no longer has access to this secure share. Ask for a new invitation.';
    case 'not_found':
    case 'room_ended':
      return 'This secure share has ended. Your local comments are still here.';
    case 'key_changed':
      return 'Stacki could not verify part of this shared review history, so it has stopped syncing. Your local comments are still here.';
    case 'unverified_events':
      return 'Stacki could not verify part of this shared review history. Everything it could verify is here.';
    case 'too_large':
      return 'Something in this project is too large to share.';
    case 'busy':
      return 'The relay asked Stacki to wait a moment.';
    case 'workspace_mismatch':
      return 'This project is linked to a different share than its comments were shared with.';
    case 'identity_mismatch':
      return 'This computer’s identity isn’t the one that joined this share. Ask for a new invitation.';
    case 'refused_events':
      return problem.detail || 'The share would not take some of these changes.';
    default:
      return problem.detail || 'Sharing these comments didn’t work. Your comments are saved here.';
  }
}

/** Whether a problem is one waiting will fix. */
const isTransient = (kind) => kind === 'offline' || kind === 'timeout' || kind === 'busy';

/**
 * The resting row.
 *
 * One line, four states, and the quiet one is the common one. `pending` is the
 * count of things written here that have not left this machine — shown because
 * it is the only honest way to say "you are not caught up" in a system that
 * does not stream, and shown ESPECIALLY when something has gone wrong rather
 * than suppressed exactly when it is what somebody needs to see.
 */
export function SecureShareRow({ shared, onShare, onManage, onRetry, busy = false }) {
  if (!shared) return null;
  const problem = shared.problem;
  const text = secureProblemText(problem);
  const pending = shared.pending || 0;

  if (shared.mode !== 'secure') {
    return (
      <div className="share-row">
        <span className="share-off">Comments are private to this Mac.</span>
        <button type="button" className="share-link" onClick={onShare}>
          Share…
        </button>
      </div>
    );
  }

  // Offline is not a failure and does not get the failure treatment. It is a
  // normal state of a laptop, it resolves itself, and the only thing worth
  // saying is how much is waiting.
  if (problem && isTransient(problem.kind)) {
    return (
      <div className="share-row">
        <span className="share-state is-waiting">
          {problem.kind === 'offline' ? 'Offline' : 'Waiting'}
          {pending > 0 ? ` · ${plural(pending, 'comment', 'comments')} waiting to send` : ''}
        </span>
        <button type="button" className="share-link" onClick={onManage}>
          Manage
        </button>
      </div>
    );
  }

  if (problem) {
    return (
      <div className="share-row has-problem">
        <span className="share-state is-paused">Sharing paused</span>
        <button type="button" className="share-link" onClick={onRetry} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
        {/* A sentence, on its own line, because it is something to act on
            rather than a badge. `role="alert"` so it is announced when it
            appears rather than only when somebody happens to be reading. */}
        <div className="share-problem" role="alert">
          <OrphanIcon size={12} />
          <span>{text}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="share-row">
      {/* The lock is decorative. The words carry the state, so nothing here is
          conveyed by an icon or a colour alone. */}
      <LockIcon size={11} aria-hidden="true" />
      <span className="share-state">
        Shared securely
        {pending > 0 ? ` · ${plural(pending, 'comment', 'comments')} waiting to send` : ''}
      </span>
      <button type="button" className="share-link" onClick={onManage}>
        Manage
      </button>
    </div>
  );
}

/** Escape closes, focus comes back where it was, and the dialog takes focus. */
function useDialog(onClose) {
  const ref = React.useRef(null);
  const returnTo = React.useRef(null);

  React.useEffect(() => {
    returnTo.current = document.activeElement;
    // The first thing somebody should hear is what this dialog is, which is
    // its heading — not the first button in it.
    const first = ref.current?.querySelector('[data-autofocus]') || ref.current;
    first?.focus?.();
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const back = returnTo.current;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [onClose]);

  return ref;
}

/** The Advanced disclosure. A real button with real state, not a styled div. */
function Advanced({ open, onToggle, children }) {
  return (
    <div className="share-advanced">
      <button type="button" className="share-disclosure" aria-expanded={open} onClick={onToggle}>
        <span className={`share-caret${open ? ' open' : ''}`} aria-hidden="true">
          ›
        </span>
        Advanced
      </button>
      {open && <div className="share-advanced-body">{children}</div>}
    </div>
  );
}

/**
 * Starting a secure share, and everything after it.
 *
 * One dialog with three faces, because it is one thing a person is doing and
 * they arrive at each face from the one before it. `create` asks the only
 * question there is; `created` hands over a link; `manage` is what they get
 * when they come back later.
 */
export function SecureShareDialog({
  shared,
  localCount = 0,
  mode: initialMode = 'create',
  onClose,
  onCreate,
  onInvite,
  onLeave,
  onEnd,
  onRelay,
  onCopy,
}) {
  const [mode, setMode] = React.useState(initialMode);
  // The privacy decision, and it starts OFF. A project's back catalogue of
  // comments is candid by nature — it is what somebody thinks about work,
  // often somebody else's — and uploading it because a box defaulted to ticked
  // is not a mistake anybody can take back.
  const [publishExisting, setPublishExisting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [invite, setInvite] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [relayField, setRelayField] = React.useState('');
  const [relayError, setRelayError] = React.useState(null);
  const ref = useDialog(onClose);

  // The invitation is held for as long as the dialog is open and not a moment
  // longer. It is a bearer capability that somebody asked to copy, not
  // application state — see §61.
  React.useEffect(() => () => setInvite(null), []);

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
    } catch {
      setError('That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    const done = await onCopy?.(text);
    if (done !== false) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const relayLabel = shared?.relay?.label || 'Stacki hosted';

  const relayControls = (
    <>
      <div className="share-relay-now">
        <span>Relay</span>
        <strong>{relayLabel}</strong>
      </div>
      <label className="share-field">
        <span>Use a custom secure relay</span>
        <input
          value={relayField}
          placeholder="https://relay.example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setRelayField(e.target.value);
            setRelayError(null);
          }}
        />
      </label>
      {relayError && (
        <div className="share-error" role="alert">
          {relayError}
        </div>
      )}
      <div className="share-advanced-actions">
        <button
          type="button"
          className="ghost"
          disabled={busy || !relayField.trim()}
          onClick={async () => {
            const result = await onRelay?.({ relay: relayField.trim() });
            if (result?.ok) {
              setRelayField('');
              setRelayError(null);
            } else {
              setRelayError(result?.message || 'That is not an address Stacki can use.');
            }
          }}
        >
          Use this relay
        </button>
        {shared?.relay && !shared.relay.hosted && (
          <button type="button" className="ghost" disabled={busy} onClick={() => onRelay?.({ relay: null })}>
            Back to Stacki hosted
          </button>
        )}
      </div>
      <p className="dim small">
        Stacki can use any relay that speaks its secure protocol, including one you run yourself. A relay that isn’t on
        this computer has to use https.
      </p>
    </>
  );

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'manage' ? 'Secure sharing' : mode === 'created' ? 'Secure sharing is on' : 'Share comments'}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-header">
          {mode === 'manage' ? 'Secure sharing' : mode === 'created' ? 'Secure sharing is on' : 'Share comments'}
          <button className="review-x" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon size={12} />
          </button>
        </div>

        {mode === 'create' && (
          <div className="modal-body share-body">
            <p className="dim">
              Share review comments securely with others. Review content is end-to-end encrypted before it leaves
              Stacki. The relay cannot read it.
            </p>

            {localCount > 0 && (
              <label className="share-check">
                <input
                  type="checkbox"
                  checked={publishExisting}
                  onChange={(e) => setPublishExisting(e.target.checked)}
                />
                <span>
                  Share the {localCount} existing {localCount === 1 ? 'comment' : 'comments'}.
                  <em> Leave this off and they stay on this Mac; sharing starts with the next comment.</em>
                </span>
              </label>
            )}

            {error && (
              <div className="share-error" role="alert">
                {error}
              </div>
            )}

            <Advanced open={advanced} onToggle={() => setAdvanced((v) => !v)}>
              {relayControls}
            </Advanced>

            <div className="share-actions">
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                data-autofocus
                disabled={busy}
                onClick={async () => {
                  const done = await run(() => onCreate({ publishExisting }));
                  if (!done) return;
                  const made = await run(() => onInvite());
                  if (made) setInvite(made.link || made.capability);
                  setMode('created');
                }}
              >
                {busy ? 'Creating…' : 'Create secure share'}
              </button>
            </div>
          </div>
        )}

        {mode === 'created' && (
          <div className="modal-body share-body">
            <p className="dim">Your review content is end-to-end encrypted.</p>

            {invite ? (
              <>
                <button type="button" className="primary wide" data-autofocus onClick={() => copy(invite)}>
                  {copied ? (
                    <>
                      <ResolveIcon size={12} /> Copied
                    </>
                  ) : (
                    'Copy invite link'
                  )}
                </button>
                {/* Announced rather than only shown, so somebody using a
                    screen reader knows the copy happened. */}
                <span className="visually-hidden" role="status" aria-live="polite">
                  {copied ? 'Invite link copied to the clipboard' : ''}
                </span>
                <p className="dim small">
                  This invitation works once. It expires in 7 days. Treat the link like a password — anyone who has it
                  can read and write this project’s comments.
                </p>
              </>
            ) : (
              <p className="dim small">Stacki could not make an invitation just now. Open Manage to try again.</p>
            )}

            {error && (
              <div className="share-error" role="alert">
                {error}
              </div>
            )}

            <div className="share-actions">
              <button type="button" className="ghost" onClick={() => setMode('manage')}>
                Manage
              </button>
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {mode === 'manage' && (
          <div className="modal-body share-body">
            <p className="dim">
              This project’s comments are shared securely. Review content is end-to-end encrypted before it leaves
              Stacki; the relay cannot read it.
            </p>

            <div className="share-facts">
              <div className="share-fact">
                <span>Relay</span>
                <strong>{relayLabel}</strong>
              </div>
              <div className="share-fact">
                <span>People</span>
                {/* What this machine actually knows, which is not the same as
                    what the relay knows. A member who has joined and never
                    written anything is somebody Stacki knows exists and cannot
                    name — no display name is ever sent to a relay, so naming
                    them would mean inventing a directory. */}
                <strong>
                  {shared?.secure?.participants?.length
                    ? shared.secure.participants.join(', ')
                    : shared?.secure?.memberCount > 1
                      ? `${shared.secure.memberCount} people`
                      : 'Just you so far'}
                </strong>
              </div>
              {shared?.private > 0 && (
                <div className="share-fact">
                  <span>Private</span>
                  <strong>
                    {plural(shared.private, 'comment stays', 'comments stay')} on this Mac
                  </strong>
                </div>
              )}
            </div>

            {invite && (
              <div className="share-invite">
                <button type="button" className="primary wide" onClick={() => copy(invite)}>
                  {copied ? (
                    <>
                      <ResolveIcon size={12} /> Copied
                    </>
                  ) : (
                    'Copy invite link'
                  )}
                </button>
                <span className="visually-hidden" role="status" aria-live="polite">
                  {copied ? 'Invite link copied to the clipboard' : ''}
                </span>
                <p className="dim small">This invitation works once and expires in 7 days. Treat it like a password.</p>
              </div>
            )}

            {error && (
              <div className="share-error" role="alert">
                {error}
              </div>
            )}

            <div className="share-actions stacked">
              <button
                type="button"
                className="ghost"
                data-autofocus
                disabled={busy}
                onClick={async () => {
                  const made = await run(() => onInvite());
                  if (made) {
                    setInvite(made.link || made.capability);
                    setCopied(false);
                  }
                }}
              >
                {invite ? 'Invite another person' : 'Invite someone'}
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => run(() => onLeave())}>
                Leave secure share
              </button>
              {shared?.secure?.isOwner && (
                <button type="button" className="ghost danger" disabled={busy} onClick={() => run(() => onEnd())}>
                  End secure share for everyone
                </button>
              )}
            </div>

            <p className="dim small">
              {shared?.secure?.isOwner
                ? 'Leaving or ending keeps every comment you have. Ending stops the relay carrying this share and deletes what it was holding — it cannot take back copies people have already received.'
                : 'Leaving keeps every comment you have. It only stops this Mac talking to the share.'}
            </p>

            <Advanced open={advanced} onToggle={() => setAdvanced((v) => !v)}>
              {relayControls}
            </Advanced>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Somebody opened an invitation.
 *
 * NEVER SILENT AND NEVER AUTOMATIC. This is the whole of what a deep link can
 * do: put this dialog on the screen. The capability itself never reaches this
 * component — it is held in the main process until somebody presses Join,
 * which is why the accept call takes no argument at all.
 */
export function JoinShareDialog({ invite, onJoin, onCancel }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  // The same question the create dialog asks, for the same reason: a person
  // joining a share has a back catalogue too.
  const [publishExisting, setPublishExisting] = React.useState(false);
  const ref = useDialog(onCancel);
  const localCount = invite?.localCount || 0;

  const problem = invite?.problem;

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal share-dialog" role="dialog" aria-modal="true" aria-label="Join shared comments" ref={ref} tabIndex={-1}>
        <div className="modal-header">
          Join shared comments?
          <button className="review-x" onClick={onCancel} title="Close" aria-label="Close">
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="modal-body share-body">
          {problem ? (
            <>
              <p className="dim">
                {problem === 'expired'
                  ? 'This invitation has expired. Ask for a new one.'
                  : problem === 'used'
                    ? 'This invitation can no longer be used. Ask for a new one.'
                    : problem === 'ended'
                      ? 'This secure share has ended.'
                      : 'This invitation could not be read. Ask for a new one.'}
              </p>
              <div className="share-actions">
                <button type="button" className="primary" data-autofocus onClick={onCancel}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="dim">
                This invitation gives access to shared review comments for a local project. Comments are end-to-end
                encrypted; the relay cannot read them.
              </p>

              <div className="share-facts">
                <div className="share-fact">
                  <span>Local project</span>
                  <strong>{invite?.project || 'No project open'}</strong>
                </div>
                <div className="share-fact">
                  <span>Relay</span>
                  <strong>{invite?.relay?.label || 'Stacki hosted'}</strong>
                </div>
              </div>

              {!invite?.project && (
                <p className="dim small">
                  Open the project these comments are about first, then open the invitation again. Stacki never works
                  out which project an invitation belongs to on its own.
                </p>
              )}

              {invite?.alreadyShared && (
                <p className="dim small">
                  This project’s comments are already shared. Leave that share first if you meant to join this one.
                </p>
              )}

              {localCount > 0 && invite?.project && !invite?.alreadyShared && (
                <label className="share-check">
                  <input
                    type="checkbox"
                    checked={publishExisting}
                    onChange={(e) => setPublishExisting(e.target.checked)}
                  />
                  <span>
                    Share the {localCount} existing {localCount === 1 ? 'comment' : 'comments'}.
                    <em> Leave this off and they stay on this Mac.</em>
                  </span>
                </label>
              )}

              {error && (
                <div className="share-error" role="alert">
                  {error}
                </div>
              )}

              <div className="share-actions">
                <button type="button" className="ghost" onClick={onCancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  data-autofocus
                  disabled={busy || !invite?.project || invite?.alreadyShared}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const result = await onJoin({ publishExisting });
                      if (!result?.ok) setError(result?.message || 'Joining did not work.');
                    } catch {
                      setError('Joining did not work.');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Joining…' : 'Join'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SecureShareRow;
