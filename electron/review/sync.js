// Catching up, and being caught up with.
//
// Shared does not mean live. This synchronises when there is a reason to and
// at no other time: opening a shared project, pressing Sync Reviews, and —
// throttled, and only if a moment has passed — coming back to the window.
// There is no socket, no poll, no timer counting down in the corner.
//
// That is a product decision, not a shortcut. A review is written in minutes
// and read in hours; second-by-second delivery would buy nothing and cost a
// permanent connection, a reconnect state machine, and a background process
// on somebody's laptop. Webflow's comments refresh rather than stream and are
// perfectly useful. The event model underneath is what makes this a choice
// rather than a limitation: pushing the same events down a socket later
// changes this file and nothing else.
//
// THE SHAPE OF ONE SYNCHRONISATION, and the order matters:
//
//   1. push what has not been sent. Ours first, so that a pull which then
//      fails still leaves our work somewhere other than this laptop.
//   2. pull everything after the cursor, a page at a time, until there is no
//      more.
//   3. union both into the local set and refold.
//
// Nothing is replaced and nothing is discarded. A union of append-only sets is
// the whole merge algorithm; there is no case where the remote "wins" and no
// case where a local event is dropped to make room for one. That is why
// offline is not a special mode here — an event written with no network is an
// event in the outbox, and the outbox drains when there is one.
//
// LOCAL-ONLY PROJECTS MAKE NO REQUESTS. Not a HEAD, not a health check, not a
// DNS lookup. The first line of `sync` is the guard, and there is a test that
// counts.

const { createTransport, MAX_BATCH, MAX_PULL } = require('./transport');

/**
 * The link for a legacy plaintext workspace.
 *
 * Here rather than at the call site so that the app and the tests build the
 * same thing — two hand-rolled copies of "how a legacy workspace becomes a
 * transport" is two places for it to drift.
 */
const legacyLink = (workspace, makeTransport = createTransport) =>
  workspace
    ? {
        kind: 'legacy',
        id: workspace.id,
        actorId: workspace.actorId,
        make: () =>
          makeTransport({ kind: 'http', baseUrl: workspace.server, token: workspace.token, workspaceId: workspace.id }),
      }
    : null;

// The most pages one synchronisation will walk. A workspace with more history
// than this catches up over several syncs rather than holding the app for one
// very long one.
const MAX_PAGES = 20;
// How recently a focus-triggered sync must have run before another one is
// simply skipped. Coming back to the window twice in a minute is not two
// reasons to talk to a server.
const FOCUS_QUIET_MS = 60_000;

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Turn a transport failure into what the panel says and whether to keep going.
 *
 * `unauthorized` is the one that must not be retried quietly: a credential
 * that has been revoked will go on being revoked, and an app that keeps trying
 * is an app that never tells anybody why sharing stopped working.
 */
const problemOf = (result) => ({
  kind: result.code || 'sync_failed',
  detail: result.message || null,
  // The ones that will go on failing until a person does something. A
  // credential that has been revoked stays revoked, a room that has ended
  // stays ended, and a member whose signing key changed is a room this
  // machine should stop talking to rather than keep retrying.
  fatal:
    result.code === 'unauthorized' ||
    result.code === 'not_found' ||
    result.code === 'room_ended' ||
    result.code === 'key_changed',
});

/**
 * Run one synchronisation for one open project.
 *
 * `store` is the ledger. `link` is how this project is shared, or null for a
 * project that is not — and it is deliberately the SAME shape for a legacy
 * plaintext workspace and for a secure room:
 *
 *     { id, actorId, kind, make() }
 *
 * `make()` returns something with the five transport methods. That is the
 * whole of what this file knows about either one: it never learns what a
 * server address is, and it never learns that an envelope exists. Adding
 * Secure Share changed the two lines that used to build an HTTP transport and
 * nothing else here, which is what the transport interface was for.
 */
async function syncOnce({ store, link, now = Date.now, reason = 'manual' } = {}) {
  // The guard. A project that has not been shared never reaches a network.
  if (!store || !store.shared?.workspaceId || !link) {
    return { ok: true, skipped: 'not_shared', pushed: 0, pulled: 0 };
  }
  if (link.id !== store.shared.workspaceId) {
    // The ledger and the registry disagree about which workspace this project
    // belongs to. Refusing is right: pushing this project's comments into a
    // workspace it was not shared with is the one mistake that cannot be
    // taken back.
    store.setSyncProblem('workspace_mismatch', 'This project is linked to a different workspace.');
    return fail('workspace_mismatch', 'This project is linked to a different workspace.');
  }
  // The workspace remembers which actor this member joined as, and the server
  // refuses a human event under any other id. If this installation's identity
  // has since changed — an identity file lost and remade, a userData folder
  // copied between machines — every push would come back rejected, be taken
  // out of the outbox to stop it blocking the queue, and quietly never be
  // shared. That failure is silent, which is what makes it worth a guard.
  if (link.actorId && store.actor?.id && link.actorId !== store.actor.id) {
    const why = 'This computer’s identity is not the one that joined this workspace. Ask for a new invitation.';
    store.setSyncProblem('identity_mismatch', why);
    return fail('identity_mismatch', why);
  }

  let transport;
  try {
    transport = link.make();
  } catch (err) {
    store.setSyncProblem('bad_workspace', err.message);
    return fail('bad_workspace', err.message);
  }

  let pushed = 0;
  let pulled = 0;
  let refused = 0;
  let unverified = 0;
  try {
    // 1 — ours, first.
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = store.pendingEvents(MAX_BATCH);
      if (!batch.length) break;
      const sent = await transport.pushEvents(batch);
      if (!sent.ok) {
        const problem = problemOf(sent);
        store.setSyncProblem(problem.kind, problem.detail);
        return { ok: false, code: problem.kind, message: problem.detail, pushed, pulled };
      }
      // Anything the server refused by name is never going to be accepted, so
      // it comes out of the outbox too — otherwise one bad event blocks every
      // later one forever. It stays in the local log and stays readable here,
      // and it is COUNTED: silently dropping somebody's comment from a
      // workspace while telling them the sync worked is exactly the failure
      // this whole model is supposed not to have.
      const settled = [...sent.accepted, ...sent.rejected.map((r) => r?.id).filter(Boolean)];
      if (!settled.length) break;
      store.ackPushed(settled);
      pushed += sent.accepted.length;
      refused += sent.rejected.length;
      if (batch.length < MAX_BATCH) break;
    }

    // 2 — theirs.
    let cursor = store.shared.cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await transport.pullEvents({ after: cursor, limit: MAX_PULL });
      if (!got.ok) {
        const problem = problemOf(got);
        store.setSyncProblem(problem.kind, problem.detail);
        return { ok: false, code: problem.kind, message: problem.detail, pushed, pulled };
      }
      // 3 — union, refold, and remember how far we got. The cursor moves even
      // when the page was empty of new events: a duplicate delivery still
      // means everything up to here has been seen.
      const taken = store.receiveEvents(got.events, {
        cursor: Number.isInteger(got.cursor) ? got.cursor : cursor,
        at: now(),
      });
      if (!taken.ok) {
        store.setSyncProblem(taken.code || 'store_refused', taken.message || null);
        return { ok: false, code: taken.code || 'store_refused', message: taken.message, pushed, pulled };
      }
      pulled += taken.added || 0;
      unverified += got.unverified || 0;
      cursor = Number.isInteger(got.cursor) ? got.cursor : cursor;
      if (!got.hasMore) break;
    }

    // Something in the room did not verify. It is not shown as a crypto error
    // — see SecureShare.jsx for the sentence — but it is never silent: a sync
    // that quietly dropped part of somebody's history while reporting success
    // is the exact failure this whole model exists not to have.
    if (unverified) {
      store.setSyncProblem('unverified_events', `${unverified} ${unverified === 1 ? 'change' : 'changes'} could not be verified.`);
      return { ok: true, pushed, pulled, refused, unverified, at: now(), reason };
    }

    if (refused) {
      store.setSyncProblem('refused_events', `The workspace would not take ${refused} of these changes.`);
      return { ok: true, pushed, pulled, refused, at: now(), reason };
    }
    store.setSyncProblem(null);
    return { ok: true, pushed, pulled, refused: 0, at: now(), reason };
  } finally {
    transport.close?.();
  }
}

/**
 * The thing the app holds: one synchronisation at a time, per project.
 *
 * Two syncs running at once against one ledger would each push what the other
 * had already pushed and race each other's cursor. So a second request while
 * one is in flight joins the one in flight rather than starting another.
 */
function createSyncer({ now = Date.now } = {}) {
  let inFlight = null;
  let lastAt = 0;

  async function sync({ store, link, reason = 'manual' } = {}) {
    if (inFlight) return inFlight;
    // A focus is a hint, not an instruction. Coming back to the window a
    // moment after the last sync is not a reason to talk to a server again.
    if (reason === 'focus' && now() - lastAt < FOCUS_QUIET_MS) {
      return { ok: true, skipped: 'too_soon', pushed: 0, pulled: 0 };
    }
    inFlight = syncOnce({ store, link, now, reason })
      .catch((err) => fail('sync_failed', err?.message || 'Synchronising did not work.'))
      .finally(() => {
        inFlight = null;
      });
    const result = await inFlight;
    if (result?.ok && !result.skipped) lastAt = now();
    return result;
  }

  return {
    sync,
    get busy() {
      return !!inFlight;
    },
    get lastAt() {
      return lastAt;
    },
    /** A new project is open; the throttle should not carry over from the last one. */
    reset() {
      lastAt = 0;
    },
  };
}

// How often an ACTIVE secure share looks for somebody else's comments while
// the window is on screen.
//
// The window is jittered so that a room full of people does not turn into a
// room full of clients asking at the same instant, and it is minutes rather
// than seconds because a review is written in minutes and read in hours. This
// is not presence and it is not streaming: it is the answer to a real gap,
// which is that somebody who leaves Stacki focused all afternoon would
// otherwise never learn a colleague had replied.
const CATCH_UP_MIN_MS = 30_000;
const CATCH_UP_MAX_MS = 60_000;

/**
 * A repeating, jittered catch-up.
 *
 * Deliberately a tiny state machine with injected time, because "it polls
 * about every 45 seconds" is otherwise a property nothing can test without
 * sitting there for 45 seconds. `armed` is the only state; `due` is the only
 * effect.
 */
function createCatchUp({
  onDue,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  minMs = CATCH_UP_MIN_MS,
  maxMs = CATCH_UP_MAX_MS,
} = {}) {
  let timer = null;

  const wait = () => minMs + Math.floor(random() * Math.max(0, maxMs - minMs));

  function arm() {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      // The effect first, then re-arm: a catch-up that threw would otherwise
      // stop the loop for the rest of the session.
      try {
        onDue?.('catchup');
      } finally {
        arm();
      }
    }, wait());
    timer?.unref?.();
  }

  function disarm() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return {
    /** Run while a secure share is open AND the window is on screen. */
    set(active) {
      if (active) arm();
      else disarm();
    },
    get armed() {
      return timer !== null;
    },
    disarm,
  };
}

module.exports = { syncOnce, createSyncer, createCatchUp, legacyLink, FOCUS_QUIET_MS, MAX_PAGES, CATCH_UP_MIN_MS, CATCH_UP_MAX_MS };
