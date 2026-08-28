// The secure transport.
//
// The same five methods `electron/review/transport.js` defines, so everything
// above it — the sync loop, the ledger, the panel — goes on dealing in
// ordinary arrays of Stacki review events and never learns that an envelope
// exists. That containment is the point of this file: encryption is a property
// of the wire, not a concept the review domain has to grow.
//
//     pushEvents(events)   validate → seal → sign → send
//     pullEvents({after})  receive → verify → decrypt → validate → events
//
// VALIDATE TWICE, WITH THE SAME VALIDATOR. Before encrypting, because sending
// a malformed event would put something in the room that nobody can fold. And
// after decrypting, because the plaintext came from somebody else's
// installation and being able to decrypt it says only that they were in the
// room — it says nothing at all about whether what they wrote is an event.
// Both calls are `reviveEvent`, the same function the local ledger folds with.
//
// FAIL CLOSED, ALWAYS. An envelope that fails any check is dropped and
// counted, never partially projected. The count is surfaced, because silently
// discarding part of somebody's review history while reporting a successful
// sync is precisely the failure this whole model exists not to have.
//
// EVERY ANSWER IS A STATUS, NEVER A THROW — the same rule the legacy transport
// keeps, for the same reason: the caller is a sync loop that has to keep
// working when the network does not.

const {
  reviveEvent,
  MAX_EVENT_BYTES,
} = require('../events.js');
const {
  VERSION,
  MAX_BATCH,
  MAX_PAGE,
  MAX_BODY_BYTES,
  readEnvelope,
  toBase64Url,
} = require('../../../relay/protocol.js');
const {
  deriveKeys,
  newRoomId,
  newRoomSecret,
  newSigningKeys,
  senderIdFor,
  envelopeIdFor,
  sealEvent,
  openEnvelope,
} = require('./crypto.js');
const { unpackCapability, packCapability, relayOrigin } = require('./capability.js');

const TIMEOUT_MS = 15000;
// The largest answer this will read. A relay that sends more than this is a
// relay misbehaving; reading it into memory because it said to is not required.
const MAX_RESPONSE_BYTES = MAX_BODY_BYTES;

const fail = (code, message) => ({ ok: false, code, message });

/**
 * A relay's answer, bounded in BYTES, read a chunk at a time.
 *
 * `await response.text()` was the wrong shape for the same two reasons the
 * Worker's ingress reader was: by the time `text.length` is compared, an
 * untrusted relay has already made this process buffer everything it chose to
 * send — and `length` counts UTF-16 code units, so a body of astral-plane
 * characters is twice the bytes its length reports and could pass a check it
 * should fail.
 *
 * A custom relay is somebody else's server. It is the one party in this design
 * that is not trusted for anything, so what it says about its own size is a
 * hint and what it actually sends is what gets counted.
 */
async function readBounded(response, cap) {
  const declared = Number(response.headers?.get?.('content-length'));
  // Refused before a byte is consumed, when it is honest enough to say.
  if (Number.isFinite(declared) && declared > cap) return { ok: false, code: 'too_large' };

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // No stream to read — an empty body, or a runtime without one. `text()` is
    // safe here only because there is nothing to buffer.
    try {
      const text = await response.text();
      return Buffer.byteLength(text, 'utf8') > cap ? { ok: false, code: 'too_large' } : { ok: true, text };
    } catch {
      return { ok: false, code: 'bad_response' };
    }
  }

  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > cap) {
        // Stop taking it. A relay that keeps sending is talking to nobody.
        await reader.cancel().catch(() => {});
        return { ok: false, code: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, code: 'bad_response' };
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8') };
}

/**
 * One HTTP call to a relay, with every failure given a name.
 *
 * The names are what the panel says out loud and what the sync loop backs off
 * on, so they are part of the product rather than an implementation detail:
 * "this Mac no longer has access" needs a person, "nothing answered" needs
 * patience, and the two must not look alike.
 */
async function request(base, path, { method = 'GET', token = null, body = null, timeoutMs = TIMEOUT_MS, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return fail('unsupported', 'This build of Stacki cannot make network requests.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const text = body == null ? null : JSON.stringify(body);
    // Bytes, not characters — the same reason as `readBounded` below.
    if (text && Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      return fail('too_large', 'That is too much to send in one request.');
    }
    response = await doFetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(text ? { 'content-type': 'application/json' } : {}),
      },
      ...(text ? { body: text } : {}),
    });
  } catch (err) {
    if (err?.name === 'AbortError') return fail('timeout', 'The secure relay did not answer in time.');
    return fail('offline', 'Stacki could not reach the secure relay.');
  } finally {
    clearTimeout(timer);
  }

  const read = await readBounded(response, MAX_RESPONSE_BYTES);
  if (!read.ok) {
    return read.code === 'too_large'
      ? fail('too_large', 'The secure relay sent more than Stacki will read.')
      : fail('bad_response', 'The secure relay sent something unreadable.');
  }
  const text = read.text;
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok) return fail('bad_response', 'The secure relay did not answer in JSON.');
    }
  }
  if (response.status === 401 || response.status === 403) {
    return fail(parsed?.error === 'bad_invite' ? 'bad_invite' : 'unauthorized', parsed?.message || null);
  }
  if (response.status === 404) return fail('not_found', parsed?.message || null);
  if (response.status === 409) return fail(parsed?.error === 'room_ended' ? 'room_ended' : 'conflict', parsed?.message || null);
  if (response.status === 413) return fail('too_large', parsed?.message || null);
  if (response.status === 429) return fail('busy', parsed?.message || null);
  if (!response.ok) {
    return fail(response.status >= 500 ? 'server' : 'refused', parsed?.message || `The secure relay answered ${response.status}.`);
  }
  if (!parsed || typeof parsed !== 'object') return fail('bad_response', 'The secure relay sent no answer.');
  return { ok: true, body: parsed };
}

/**
 * A transport for one secure room.
 *
 * `rooms` is the secret registry; the room's secret, token and signing key are
 * read from it here and never handed upwards. `fetchImpl` is injected so the
 * whole of this drives against a relay running in the same process.
 */
function createSecureTransport({ rooms, roomId, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const room = rooms?.get?.(roomId);
  if (!room) throw new Error('a secure share needs a room this machine belongs to');
  const keys = deriveKeys(room.secret, room.roomId);
  // A working copy, so a pin learned mid-sync is usable for the rest of it
  // without a re-read of the file for every envelope.
  const pins = { ...room.pins };
  let closed = false;
  let refreshedMembers = false;

  const root = `/v2/rooms/${encodeURIComponent(room.roomId)}`;
  const call = (path, options = {}) =>
    closed
      ? Promise.resolve(fail('closed', 'This secure share connection is closed.'))
      : request(room.relay, path, { token: room.token, fetchImpl, timeoutMs, ...options });

  /**
   * Take a member's signing key into the pin map, or refuse.
   *
   * A key that differs from one already pinned for this sender is a
   * substitution attempt and it is fatal for the sync rather than skipped: a
   * relay that can swap a member's key can sign anything as that member, so
   * carrying on with the rest of the page would be carrying on with a
   * compromised room.
   */
  function takePin(senderId, publicKey) {
    const known = pins[senderId];
    if (known && known !== publicKey) return { ok: false, code: 'key_changed' };
    if (known) return { ok: true };
    const stored = rooms.pin(room.roomId, senderId, publicKey);
    if (!stored.ok) return stored;
    pins[senderId] = publicKey;
    return { ok: true };
  }

  /** Learn who is in the room, and their keys. */
  async function refreshMembers() {
    const answer = await call(root);
    if (!answer.ok) return answer;
    for (const member of Array.isArray(answer.body.members) ? answer.body.members : []) {
      if (!member?.senderId || !member?.publicKey) continue;
      const pinned = takePin(member.senderId, member.publicKey);
      if (!pinned.ok) {
        return fail('key_changed', 'A member of this secure share is presenting a different signing key.');
      }
    }
    return { ok: true, body: answer.body };
  }

  /**
   * One envelope, all the way to a Stacki event, or a reason it is not one.
   *
   * The order is the protocol document's §12 and every step of it matters:
   * shape before crypto so a signature check cannot be spent on garbage; the
   * pinned key rather than any key the relay offers; the signature before the
   * decryption; Stacki's own validator on the plaintext; and only then the two
   * bindings that tie the envelope to what is inside it.
   */
  function openOne(raw) {
    const read = readEnvelope(raw, { served: true });
    if (!read.ok) return { ok: false, code: read.code };
    const envelope = read.envelope;

    const publicKey = pins[envelope.senderId];
    if (!publicKey) return { ok: false, code: 'unknown_sender', senderId: envelope.senderId };

    const opened = openEnvelope({ keys, envelope, publicKey });
    if (!opened.ok) return { ok: false, code: opened.code };

    const event = reviveEvent(opened.event);
    if (!event) return { ok: false, code: 'invalid_event' };

    // The envelope says which event it carries. If the two disagree, somebody
    // has re-filed one event under another's name — which would let a member
    // overwrite the retry identity of an event they did not write.
    if (envelopeIdFor(keys, event.id) !== envelope.envelopeId) return { ok: false, code: 'envelope_mismatch' };

    // The rule that survives from the plaintext service, restated in a form
    // that does not need the relay to know anybody's actor id: a human event
    // must come from the member whose sender id that actor derives to.
    if (event.actorKind === 'human' && senderIdFor(keys, event.actorId) !== envelope.senderId) {
      return { ok: false, code: 'actor_mismatch' };
    }
    // Agent events are deliberately not checked this way. A person may submit
    // Claude's reply, and Claude's actor id is derived from its name rather
    // than from anybody's membership — see actors.js. The outer envelope is
    // still signed by the human who sent it, so it stays attributable.

    return { ok: true, event, senderId: envelope.senderId };
  }

  return {
    kind: 'secure',
    workspaceId: room.roomId,

    /** Enough to show a person where this points. No secret, no credential, no room id. */
    describe: () => ({ kind: 'secure', relay: room.relay, isOwner: room.isOwner }),

    async workspace() {
      const answer = await refreshMembers();
      if (!answer.ok) return answer;
      const body = answer.body;
      return {
        ok: true,
        workspace: { id: room.roomId, relay: room.relay, endedAt: body.room?.endedAt ?? null },
        members: Array.isArray(body.members) ? body.members : [],
        head: Number.isInteger(body.head) ? body.head : null,
      };
    },

    /**
     * Everything after a cursor, decrypted.
     *
     * An envelope from a sender this machine has not pinned triggers ONE
     * member refresh and one retry — somebody joining and writing between two
     * syncs is ordinary, and refusing their first comment until the next sync
     * would be a bug people would report as "comments arrive late".
     */
    async pullEvents({ after = null, limit = MAX_PAGE } = {}) {
      const params = new URLSearchParams();
      if (Number.isInteger(after) && after >= 0) params.set('after', String(after));
      params.set('limit', String(Math.max(1, Math.min(Number(limit) || MAX_PAGE, MAX_PAGE))));
      const answer = await call(`${root}/envelopes?${params.toString()}`);
      if (!answer.ok) return answer;

      const raw = Array.isArray(answer.body.envelopes) ? answer.body.envelopes : [];
      const events = [];
      // Names observed on decrypted events, so Manage can say "Alice" rather
      // than "a member". Collected here and written once at the end — a member
      // writes many events and this is a file on disk.
      const names = new Map();
      let unverified = 0;
      let pending = [];

      const take = (got) => {
        events.push(got.event);
        if (got.event.actorKind === 'human' && got.event.actorName) names.set(got.senderId, got.event.actorName);
      };

      for (const one of raw) {
        const got = openOne(one);
        if (got.ok) {
          take(got);
          continue;
        }
        if (got.code === 'unknown_sender') pending.push(one);
        else unverified += 1;
      }

      if (pending.length && !refreshedMembers) {
        refreshedMembers = true;
        const refreshed = await refreshMembers();
        if (!refreshed.ok) return refreshed;
        const again = pending;
        pending = [];
        for (const one of again) {
          const got = openOne(one);
          if (got.ok) take(got);
          else unverified += 1;
        }
      }
      // Anything still from an unknown sender after a refresh is an envelope
      // from somebody the relay will not vouch for. Counted, not taken.
      unverified += pending.length;

      // A display name is never sent to a relay, so this is the ONLY way this
      // machine can learn one: out of a review event it was able to decrypt.
      // Somebody who has joined and never written anything stays "another
      // member", which is the honest answer.
      for (const [senderId, shown] of names) rooms.learnName(room.roomId, senderId, shown);

      return {
        ok: true,
        events,
        cursor: Number.isInteger(answer.body.cursor) ? answer.body.cursor : (after ?? null),
        hasMore: answer.body.hasMore === true,
        unverified,
      };
    },

    /**
     * Append. Answers in EVENT ids, because that is what the outbox is keyed
     * by — the envelope identity is this file's business and nobody else's.
     */
    async pushEvents(events) {
      const batch = (Array.isArray(events) ? events : []).slice(0, MAX_BATCH);
      if (!batch.length) return { ok: true, accepted: [], rejected: [], cursor: null };

      const byEnvelope = new Map();
      const envelopes = [];
      const rejected = [];
      for (const event of batch) {
        const checked = reviveEvent(event);
        if (!checked || JSON.stringify(checked).length > MAX_EVENT_BYTES) {
          rejected.push({ id: event?.id || null, code: 'invalid_event' });
          continue;
        }
        // An honest Stacki never seals a human event attributed to somebody
        // else. The relay cannot check this — it has no idea what an actor id
        // is — and recipients reject it on arrival, so this is not the defence.
        // It is the guard that stops a bug here putting a forgery in a room
        // that every peer will then, correctly, refuse to read.
        if (checked.actorKind === 'human' && senderIdFor(keys, checked.actorId) !== room.senderId) {
          rejected.push({ id: checked.id, code: 'actor_mismatch' });
          continue;
        }
        const sealed = sealEvent({ keys, senderId: room.senderId, event: checked, privateKey: room.privateKey });
        if (!sealed.ok) {
          rejected.push({ id: checked.id, code: sealed.code });
          continue;
        }
        byEnvelope.set(sealed.envelope.envelopeId, checked.id);
        envelopes.push(sealed.envelope);
      }
      if (!envelopes.length) return { ok: true, accepted: [], rejected, cursor: null };

      const answer = await call(`${root}/envelopes`, { method: 'POST', body: { envelopes } });
      if (!answer.ok) return answer;

      const accepted = (Array.isArray(answer.body.accepted) ? answer.body.accepted : [])
        .map((id) => byEnvelope.get(id))
        .filter(Boolean);
      for (const one of Array.isArray(answer.body.rejected) ? answer.body.rejected : []) {
        const eventId = byEnvelope.get(one?.envelopeId);
        if (eventId) rejected.push({ id: eventId, code: one?.code || 'refused' });
      }
      return {
        ok: true,
        accepted,
        rejected,
        cursor: Number.isInteger(answer.body.cursor) ? answer.body.cursor : null,
      };
    },

    /**
     * A single-use way in for one more person.
     *
     * The relay makes the invitation; this adds the room secret to it, on this
     * machine, and hands back the capability. The relay is never told the
     * second half — which is the whole reason the two halves exist.
     */
    async createInvite({ ttlMs = null } = {}) {
      const answer = await call(`${root}/invites`, { method: 'POST', body: ttlMs ? { ttlMs } : {} });
      if (!answer.ok) return answer;
      const capability = packCapability({
        relay: room.relay,
        roomId: room.roomId,
        invite: answer.body.invite,
        secret: room.secret,
        expiresAt: Number.isSafeInteger(answer.body.expiresAt) ? answer.body.expiresAt : 0,
      });
      if (!capability) return fail('bad_response', 'The secure relay sent an invitation Stacki could not use.');
      return { ok: true, capability, expiresAt: answer.body.expiresAt ?? null, relay: room.relay };
    },

    /** Stop this member's access at the relay. Local history is not touched. */
    leave() {
      return call(`${root}/membership/me`, { method: 'DELETE' });
    },

    /** End it for everybody. Only the room's creator may, and the relay enforces that too. */
    end() {
      return call(root, { method: 'DELETE' });
    },

    /** Whether this machine has seen a signing key for this member. */
    knows: (senderId) => !!pins[senderId],

    close() {
      closed = true;
    },
  };
}

/**
 * Walk back a share whose remote half succeeded and whose local half did not.
 *
 * The invariant this exists to hold: after any local setup failure, EITHER the
 * remote room/membership is confirmed gone and the credential may be
 * discarded, OR the credential is retained so the deletion can be retried.
 * Never neither. The version this replaces did `await abandonRoom(...)`,
 * ignored the answer, and then forgot the room unconditionally — so a DELETE
 * that failed left a room on the relay with nothing anywhere able to remove
 * it, and the caller could not tell.
 *
 * `abandon` is injected so this can be driven both ways without a network.
 */
async function undoSetup({ rooms, room, owner = false, abandon = abandonRoom, fetchImpl = null } = {}) {
  if (!rooms || !room?.roomId) return { cleaned: false, retained: false };
  const undone = await abandon({
    relay: room.relay,
    roomId: room.roomId,
    token: room.token,
    owner,
    fetchImpl,
  });
  if (undone?.ok) {
    forgetQuietly(rooms, room.roomId);
    return { cleaned: true, retained: false, held: false };
  }
  // The relay still has it. Keep the one credential that can take it away —
  // sealed, unlinked from any project, and unable to read anything — so a
  // later run can finish the job.
  let retained = false;
  try {
    retained = rooms.rememberCleanup?.({
      roomId: room.roomId,
      relay: room.relay,
      token: room.token,
      owner,
    }) === true;
  } catch {
    retained = false; // a registry that throws is a registry that did not store it
  }
  if (retained) {
    forgetQuietly(rooms, room.roomId);
    return { cleaned: false, retained: true, held: false, code: undone?.code || 'offline' };
  }

  // NEITHER CONFIRMED NOR RECORDED — so the room record STAYS.
  //
  // This is the third corner the invariant has, and the version this replaces
  // fell into it: it forgot the room whether or not the cleanup record had
  // been written. Both of those failing together is not exotic — the disk that
  // could not store the room is the same disk that cannot store a note about
  // it — and the result was a room on a relay with no credential anywhere able
  // to remove it.
  //
  // Leaving the record is the one recovery step that needs no write, which is
  // exactly why it is the right one here. The caller unlinks the project and
  // turns sharing off, so nothing points at it and nothing pretends it worked;
  // `retryCleanups` finds it again through `orphanedRooms()`.
  return { cleaned: false, retained: false, held: true, code: undone?.code || 'offline' };
}

/** Forgetting must never be the thing that throws on the way out of a walk-back. */
function forgetQuietly(rooms, roomId) {
  try {
    rooms.forget(roomId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remember a room whose remote half already exists — or take the remote half
 * back.
 *
 * Both setup paths reach a point where the relay has made something real and
 * this machine has not yet written it down. What happens next is the whole of
 * the "never neither" invariant, and it used to be written out twice, slightly
 * differently, with the same two holes in each copy:
 *
 *   `rooms.remember()` can THROW as well as return false. `write()` is a
 *   `writeFileSync` and a `renameSync` with nothing around them, so a full
 *   disk, a read-only volume or an EACCES leaves by exception — and an
 *   exception walked straight out of `createRoom`/`joinRoom` past every line
 *   of compensation. A local write that failed loudly got LESS cleanup than
 *   one that failed quietly.
 *
 *   A failed DELETE dropped the credential. The caller was told an empty room
 *   might remain, which was true, and the only token able to remove it was
 *   discarded in the same breath, which made that permanent.
 *
 * So both are one class here — REMOTE STATE EXISTS, LOCAL STATE DID NOT
 * COMPLETE — and it ends in exactly one of: cleaned, or retained for retry.
 */
async function storeOrUndo({ rooms, room, owner = false, abandon = abandonRoom, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  let stored = null;
  try {
    stored = rooms.remember(room);
  } catch {
    stored = null; // a throw and a refusal mean the same thing to the relay
  }
  if (stored) return { ok: true, room: stored };

  const undone = await abandon({
    relay: room.relay,
    roomId: room.roomId,
    token: room.token,
    owner,
    fetchImpl,
    timeoutMs,
  });
  if (undone?.ok) return { ok: false, cleaned: true, retained: false };

  let retained = false;
  try {
    retained = rooms.rememberCleanup?.({ roomId: room.roomId, relay: room.relay, token: room.token, owner }) === true;
  } catch {
    retained = false;
  }
  return { ok: false, cleaned: false, retained, code: undone?.code || 'offline' };
}

/**
 * Try again to delete what a failed setup left behind.
 *
 * Best effort and silent: nobody asked for this, it holds nothing readable,
 * and the relay's own retention sweep removes it eventually anyway. Called
 * when a project opens, which is the next moment there is a network.
 */
async function retryCleanups({ rooms, abandon = abandonRoom, fetchImpl = null, limit = 4 } = {}) {
  // The relay agreeing it is gone, and the relay saying it never heard of it,
  // are the same outcome: there is nothing left to delete.
  const settled = (r) => r?.ok === true || r?.code === 'unauthorized' || r?.code === 'not_found';
  let done = 0;

  const owed = rooms?.pendingCleanups?.() || [];
  for (const one of owed.slice(0, limit)) {
    const undone = await abandon({ relay: one.relay, roomId: one.roomId, token: one.token, owner: one.owner, fetchImpl });
    if (settled(undone)) {
      rooms.forgetCleanup(one.roomId);
      done += 1;
    }
  }

  // And the rooms held back because even the note could not be written. They
  // have no cleanup record — they ARE the record. See `orphanedRooms()`.
  const orphans = rooms?.orphanedRooms?.() || [];
  for (const one of orphans.slice(0, limit)) {
    const undone = await abandon({ relay: one.relay, roomId: one.roomId, token: one.token, owner: one.owner, fetchImpl });
    if (settled(undone)) {
      forgetQuietly(rooms, one.roomId);
      done += 1;
    }
    // If it still cannot be delivered, the room stays exactly where it is and
    // is found again next time. Nothing is promoted, nothing is deleted.
  }

  return { done, owed: owed.length + orphans.length, held: orphans.length };
}

// The refusals that mean "try again in a moment" rather than "this is over".
const TRANSIENT = new Set(['offline', 'timeout', 'busy', 'server', 'bad_response', 'unsupported', 'closed']);

/**
 * What a leave attempt actually established.
 *
 *   confirmed — the relay has revoked this membership, or is saying it has no
 *               such membership, which is the state leaving was for.
 *   transient — nothing was established. Change nothing.
 *   failed    — the relay refused for a reason waiting will not fix.
 *
 * A pure decision, exported so it can be checked without an Electron process
 * around it: getting this wrong is how Stacki once told somebody they had left
 * a share whose token was still valid.
 */
function leaveOutcome(result) {
  if (result?.ok === true) return 'confirmed';
  const code = result?.code;
  if (code === 'unauthorized' || code === 'not_found') return 'confirmed';
  if (TRANSIENT.has(code)) return 'transient';
  return 'failed';
}

// --- before there is a room to have a transport for -------------------------

/**
 * Undo a room this machine created or joined but could not finish setting up.
 *
 * A remote mutation that lands while local persistence fails is the one place
 * this design can leave litter: a room nobody owns, or a redeemed invitation
 * that bought a membership nobody holds. Neither can be fixed later, because
 * the credential that could fix them is the thing that was not stored — so it
 * is used HERE, while it is still in hand, before anything is given up.
 *
 * Best effort by nature: if the relay cannot be reached to undo it either, the
 * caller is told so plainly rather than left to assume. What is left behind in
 * that case is an empty room holding nothing readable, which the retention
 * sweep removes.
 */
async function abandonRoom({ relay, roomId, token, owner = false, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  if (!relay || !roomId || !token) return fail('nothing_to_undo', null);
  const path = owner
    ? `/v2/rooms/${encodeURIComponent(roomId)}`
    : `/v2/rooms/${encodeURIComponent(roomId)}/membership/me`;
  try {
    return await request(relay, path, { method: 'DELETE', token, fetchImpl, timeoutMs });
  } catch (err) {
    return fail('offline', err?.message || null);
  }
}


/**
 * Start a secure share.
 *
 * Everything secret is made here, on this machine, before a single request:
 * the room id, the room secret, this member's sender id and this member's
 * room-specific signing keypair. The relay is then told the three values it
 * needs to route and authenticate, and none of the ones it must never have.
 */
async function createRoom({ relay, actor, rooms, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const origin = relayOrigin(relay);
  if (!origin) return fail('bad_relay', 'A secure relay needs an https address.');
  if (!actor?.id) return fail('no_actor', 'Stacki has no identity to share as.');

  const roomId = newRoomId();
  const secret = toBase64Url(newRoomSecret());
  const keys = deriveKeys(secret, roomId);
  const senderId = senderIdFor(keys, actor.id);
  const { publicKey, privateKey } = newSigningKeys();

  const answer = await request(origin, '/v2/rooms', {
    method: 'POST',
    fetchImpl,
    timeoutMs,
    body: { roomId, senderId, publicKey },
  });
  if (!answer.ok) return answer;
  const token = answer.body?.credential?.token;
  if (!token) return fail('bad_response', 'The secure relay did not issue a credential.');

  // The room exists on the relay and this machine has not written it down yet.
  // Everything from here is `storeOrUndo`: stored, or taken back, or kept so
  // it can be taken back later. Never neither.
  const kept = await storeOrUndo({
    rooms,
    owner: true,
    fetchImpl,
    timeoutMs,
    room: {
      roomId,
      relay: origin,
      secret,
      token,
      privateKey,
      publicKey,
      senderId,
      actorId: actor.id,
      isOwner: true,
      pins: { [senderId]: publicKey },
      names: {},
    },
  });
  if (kept.ok) return { ok: true, room: kept.room };
  if (kept.cleaned) return fail('not_stored', 'Stacki could not store this secure share, so it was not created.');
  return {
    ...fail(
      'not_stored_needs_cleanup',
      kept.retained
        ? 'Stacki could not store this secure share, and could not reach the relay to remove the empty room it had already made. It will try again later. The room holds nothing readable.'
        : 'Stacki could not store this secure share, and could not reach the relay to remove the empty room it had already made. It holds nothing readable and the relay removes it automatically.'
    ),
    retained: kept.retained,
  };
}

/**
 * Accept an invitation.
 *
 * The capability carries the relay it belongs to, so joining is one paste and,
 * more to the point, never something Stacki can work out on its own. A git
 * remote is a hint and never a key — the rule the legacy registry states, and
 * it matters more here because the thing on the other side is a decryption key
 * rather than a workspace membership.
 */
async function joinRoom({ capability, actor, rooms, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const invitation = unpackCapability(capability);
  if (!invitation) return fail('bad_capability', 'That invitation could not be read.');
  if (!actor?.id) return fail('no_actor', 'Stacki has no identity to join as.');

  const keys = deriveKeys(invitation.secret, invitation.roomId);
  const senderId = senderIdFor(keys, actor.id);

  // COMING BACK TO A ROOM THIS MACHINE HAS LEFT.
  //
  // A sender id is derived from the room secret and the actor id, so somebody
  // invited back to the same room returns as the same sender — and a member's
  // signing key is fixed for the life of the room, at the relay and in every
  // peer's pin map. Generating a fresh keypair here would be refused by both,
  // correctly, as a key substitution: rejoining would fail for the one person
  // it is most likely to be offered to. So a kept identity is reused, and only
  // when it really is the same room and the same actor.
  const kept = rooms?.dormantFor?.(invitation.roomId) || null;
  const reusable = kept && kept.senderId === senderId && (!kept.actorId || kept.actorId === actor.id);
  const { publicKey, privateKey } = reusable
    ? { publicKey: kept.publicKey, privateKey: kept.privateKey }
    : newSigningKeys();

  const answer = await request(invitation.relay, '/v2/join', {
    method: 'POST',
    fetchImpl,
    timeoutMs,
    body: { roomId: invitation.roomId, invite: invitation.invite, senderId, publicKey },
  });
  if (!answer.ok) return answer;
  const token = answer.body?.credential?.token;
  if (!token) return fail('bad_response', 'The secure relay did not issue a credential.');

  // Everybody already in the room, pinned at the moment of joining. This is
  // the one point where the relay is trusted about who is who — it is telling
  // this machine what it will be told again later, and from here on a change
  // is refused.
  // Anything already pinned from before survives: a key this machine once
  // accepted for a sender is the key it goes on accepting, and a rejoin is not
  // an occasion to start trusting the relay's word again.
  const pins = { ...(reusable ? kept.pins : {}), [senderId]: publicKey };
  for (const member of Array.isArray(answer.body.members) ? answer.body.members : []) {
    if (!member?.senderId || !member?.publicKey) continue;
    if (pins[member.senderId] && pins[member.senderId] !== member.publicKey) {
      return fail('key_changed', 'A member of this secure share is presenting a different signing key.');
    }
    pins[member.senderId] = member.publicKey;
  }

  const remembered = {
    roomId: invitation.roomId,
    relay: invitation.relay,
    secret: invitation.secret,
    token,
    privateKey,
    publicKey,
    senderId,
    actorId: actor.id,
    // The relay decides who owns a room, and it remembers across a leave: a
    // member row keeps `is_owner` when its token is replaced. Asking rather
    // than assuming, so somebody rejoining their own share is still its owner.
    isOwner: answer.body?.member?.isOwner === true || (reusable && kept.isOwner === true),
    pins,
    names: {},
  };
  // The invitation is spent and the membership exists. Same invariant as
  // creating: give it back now while the token that can is still in hand, or
  // keep that token so it can be given back later.
  const outcome = await storeOrUndo({ rooms, room: remembered, owner: false, fetchImpl, timeoutMs });
  if (outcome.ok) return { ok: true, room: outcome.room };
  if (outcome.cleaned) {
    return fail('not_stored', 'Stacki could not store this secure share, so it did not join. Ask for a new invitation.');
  }
  return {
    ...fail(
      'not_stored_needs_cleanup',
      outcome.retained
        ? 'Stacki could not store this secure share, and could not reach the relay to give the membership back. It will try again later. Ask for a new invitation.'
        : 'Stacki could not store this secure share, and could not reach the relay to give the membership back. Ask for a new invitation.'
    ),
    retained: outcome.retained,
  };
}

module.exports = {
  createSecureTransport,
  createRoom,
  joinRoom,
  abandonRoom,
  readBounded,
  undoSetup,
  storeOrUndo,
  retryCleanups,
  leaveOutcome,
  request,
  TIMEOUT_MS,
  MAX_BATCH,
  MAX_PAGE,
  VERSION,
};
