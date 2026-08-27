// One room, one Durable Object.
//
// A Durable Object is a single-threaded actor with its own SQLite database, and
// that is an almost exact fit for what a secure share needs: one place that
// decides the order of things, one place that holds them, and no coordination
// with anything else. `env.ROOM.getByName(roomId)` routes every request for a
// room to the same object, so "everything after 47" has one meaning and there
// is nothing to reconcile.
//
// THE SAME PROTOCOL AS THE NODE RELAY, and that is enforced rather than
// intended: `test/relay-conformance.js` is run against both, and the envelope
// format, the limits and the error codes all come from `relay/protocol.js`,
// which neither implementation is allowed a private copy of.
//
// LIKE THE NODE RELAY, IT CANNOT READ ANYTHING. It does not import Stacki's
// event module — there is a test that greps for it — and the schema below has
// no column that could hold a comment. What it holds is ciphertext, a nonce, a
// signature, and two HMACs under keys it has never been given.
//
// ATOMICITY COMES FROM THE ACTOR, NOT FROM A TRANSACTION. A Durable Object
// handles one request at a time, so a read-then-write with no `await` between
// them cannot interleave with anybody else's. That is what makes redeeming an
// invitation safe against two people clicking at once, and it is why every
// method below does all of its awaiting (hashing, signature verification)
// BEFORE it touches the database.

import { DurableObject } from 'cloudflare:workers';

import {
  VERSION,
  TOKEN_BYTES,
  INVITE_BYTES,
  INVITE_TTL_MS,
  MIN_INVITE_TTL_MS,
  MAX_MEMBERS,
  MAX_OPEN_INVITES,
  MAX_ROOM_ENVELOPES,
  MAX_ROOM_BYTES,
  MAX_BATCH,
  MAX_PAGE,
  IDLE_ROOM_TTL_MS,
  readEnvelope,
  serveEnvelope,
  signingBytes,
  isRoomId,
  isSenderId,
  isPublicKey,
  isCredential,
  toBase64Url,
  fromBase64Url,
} from '../../protocol.js';

const WS_SUBPROTOCOL = 'stacki-secure-review.v2';

// Invitation guessing, bounded per room. This is the one place brute force has
// anything to aim at — an invitation is 256 bits, so this is a belt rather
// than a defence, and it is deliberately not authorisation.
const JOIN_WINDOW_MS = 60_000;
const JOIN_ATTEMPTS = 30;

const randomBytes = (n) => {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
};
const newToken = () => toBase64Url(randomBytes(TOKEN_BYTES));
const newInvite = () => toBase64Url(randomBytes(INVITE_BYTES));

/** SHA-256 as hex. The only form a credential is ever stored in. */
async function hash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether an envelope was signed by the member presenting it.
 *
 * The relay's own check, so garbage is refused before it is stored and a
 * member cannot fill a room with envelopes attributed to somebody else. The
 * recipients verify again against a key they pinned themselves — a relay's
 * word about a signature is worth exactly as much as the relay.
 */
async function verifySignature({ roomId, envelope, publicKey }) {
  const raw = fromBase64Url(publicKey, 32);
  const sig = fromBase64Url(envelope.signature, 64);
  if (!raw || !sig) return false;
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    const bytes = signingBytes({
      roomId,
      envelopeId: envelope.envelopeId,
      senderId: envelope.senderId,
      nonce: envelope.nonce,
      ciphertext: envelope.bytes.ciphertext,
    });
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, bytes);
  } catch {
    return false;
  }
}

const bad = (code) => ({ ok: false, code });

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.joinAttempts = { since: 0, n: 0 };
    // Schema only, and only here. `blockConcurrencyWhile` on anything else
    // would serialise the whole object behind it.
    ctx.blockConcurrencyWhile(async () => {
      this.sql = ctx.storage.sql;
      this.ensureSchema();
    });
  }

  /**
   * The tables, created if they are not there.
   *
   * Called from the constructor and again after `deleteAll()`. That second
   * call is not tidiness: `deleteAll` drops the tables out from under a LIVE
   * object, and the constructor will not run again until the object is
   * evicted — so without this, the request after somebody ends a room hits a
   * missing table and answers 500 instead of "no such room".
   */
  ensureSchema() {
    this.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          id             TEXT PRIMARY KEY,
          created_at     INTEGER NOT NULL,
          last_activity  INTEGER NOT NULL,
          owner_sender   TEXT NOT NULL,
          ended_at       INTEGER,
          envelope_count INTEGER NOT NULL DEFAULT 0,
          stored_bytes   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS members (
          sender_id  TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          joined_at  INTEGER NOT NULL,
          left_at    INTEGER,
          is_owner   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS invites (
          token_hash TEXT PRIMARY KEY,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at    INTEGER
        );
        CREATE TABLE IF NOT EXISTS envelopes (
          seq         INTEGER PRIMARY KEY AUTOINCREMENT,
          envelope_id TEXT NOT NULL UNIQUE,
          sender_id   TEXT NOT NULL,
          nonce       TEXT NOT NULL,
          ciphertext  TEXT NOT NULL,
          signature   TEXT NOT NULL,
          received_at INTEGER NOT NULL
        );
    `);
  }

  // --- small readers --------------------------------------------------------

  get meta() {
    return this.sql.exec('SELECT * FROM room_meta LIMIT 1').toArray()[0] || null;
  }

  get head() {
    const row = this.sql.exec('SELECT MAX(seq) AS head FROM envelopes').toArray()[0];
    return Number.isInteger(row?.head) ? row.head : 0;
  }

  members() {
    return this.sql
      .exec('SELECT sender_id, public_key, joined_at, left_at, is_owner FROM members ORDER BY joined_at')
      .toArray()
      .map((m) => ({
        senderId: m.sender_id,
        publicKey: m.public_key,
        joinedAt: m.joined_at,
        leftAt: m.left_at,
        isOwner: !!m.is_owner,
      }));
  }

  /**
   * Push the sweep further out.
   *
   * The retention rule is an alarm rather than a cron job: the object that
   * knows when it was last used is the one that schedules its own removal, and
   * a room nobody touches costs nothing until the day it fires.
   */
  touch(at = Date.now()) {
    this.sql.exec('UPDATE room_meta SET last_activity = ?', at);
    this.ctx.storage.setAlarm(at + IDLE_ROOM_TTL_MS);
  }

  /** A member from a bearer token. Awaits the hash, then reads. */
  async memberFor(token) {
    if (!isCredential(token)) return null;
    const row = this.sql.exec('SELECT * FROM members WHERE token_hash = ?', await hash(token)).toArray()[0];
    return row && !row.left_at ? row : null;
  }

  // --- the API the Worker calls --------------------------------------------

  async create({ roomId, senderId, publicKey }) {
    if (!isRoomId(roomId)) return bad('bad_room');
    if (!isSenderId(senderId)) return bad('bad_sender');
    if (!isPublicKey(publicKey)) return bad('bad_key');
    if (this.meta) return bad('member_exists');
    const token = newToken();
    const tokenHash = await hash(token);
    const at = Date.now();
    this.sql.exec('INSERT INTO room_meta (id, created_at, last_activity, owner_sender) VALUES (?, ?, ?, ?)', roomId, at, at, senderId);
    this.sql.exec(
      'INSERT INTO members (sender_id, public_key, token_hash, joined_at, is_owner) VALUES (?, ?, ?, ?, 1)',
      senderId,
      publicKey,
      tokenHash,
      at
    );
    this.ctx.storage.setAlarm(at + IDLE_ROOM_TTL_MS);
    return { ok: true, room: { id: roomId, createdAt: at }, credential: { token } };
  }

  /**
   * Redeem an invitation.
   *
   * Everything asynchronous happens first; the claim and the insert are one
   * uninterrupted run of synchronous statements, so two people racing the same
   * invitation cannot both get in on it.
   */
  async join({ roomId, invite, senderId, publicKey }) {
    if (!isRoomId(roomId)) return bad('bad_room');
    if (!isCredential(invite)) return bad('bad_invite');
    if (!isSenderId(senderId)) return bad('bad_sender');
    if (!isPublicKey(publicKey)) return bad('bad_key');

    const at = Date.now();
    if (at - this.joinAttempts.since > JOIN_WINDOW_MS) this.joinAttempts = { since: at, n: 0 };
    if (++this.joinAttempts.n > JOIN_ATTEMPTS) return bad('rate_limited');

    const inviteHash = await hash(invite);
    const token = newToken();
    const tokenHash = await hash(token);

    const meta = this.meta;
    // One answer for every kind of bad invitation, so guessing cannot tell a
    // wrong one from a used one from an expired one.
    if (!meta || meta.id !== roomId) return bad('bad_invite');
    if (meta.ended_at) return bad('room_ended');
    const row = this.sql.exec('SELECT * FROM invites WHERE token_hash = ?', inviteHash).toArray()[0];
    if (!row || row.used_at || row.expires_at < at) return bad('bad_invite');

    const existing = this.sql.exec('SELECT * FROM members WHERE sender_id = ?', senderId).toArray()[0];
    // A member's signing key is fixed for the life of the room: peers have the
    // old one pinned, and a rejoin with a different key is indistinguishable
    // from somebody else claiming that sender id.
    if (existing && existing.public_key !== publicKey) return bad('bad_key');
    if (!existing) {
      const live = this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE left_at IS NULL').toArray()[0].n;
      if (live >= MAX_MEMBERS) return bad('room_full');
    }

    const claimed = this.sql.exec('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', at, inviteHash);
    if (!claimed.rowsWritten) return bad('bad_invite');
    if (existing) this.sql.exec('UPDATE members SET token_hash = ?, left_at = NULL WHERE sender_id = ?', tokenHash, senderId);
    else {
      this.sql.exec(
        'INSERT INTO members (sender_id, public_key, token_hash, joined_at, is_owner) VALUES (?, ?, ?, ?, 0)',
        senderId,
        publicKey,
        tokenHash,
        at
      );
    }
    this.touch(at);
    return {
      ok: true,
      room: { id: meta.id, createdAt: meta.created_at },
      credential: { token },
      // Ownership survives a leave — a member row keeps `is_owner` when its
      // token is replaced — so an owner invited back is still the owner.
      member: { senderId, isOwner: !!(existing && existing.is_owner) },
      members: this.members().map((m) => ({ senderId: m.senderId, publicKey: m.publicKey })),
    };
  }

  async status(token) {
    const member = await this.memberFor(token);
    const meta = this.meta;
    if (!member) return bad('unauthorized');
    if (!meta) return bad('unauthorized');
    if (meta.ended_at) return bad('room_ended');
    this.touch();
    return {
      ok: true,
      room: {
        id: meta.id,
        createdAt: meta.created_at,
        endedAt: meta.ended_at,
        envelopeCount: meta.envelope_count,
        storedBytes: meta.stored_bytes,
      },
      member: { senderId: member.sender_id, isOwner: !!member.is_owner },
      members: this.members(),
      head: this.head,
    };
  }

  async pull({ token, after = 0, limit = MAX_PAGE }) {
    const member = await this.memberFor(token);
    if (!member) return bad('unauthorized');
    const meta = this.meta;
    if (!meta) return bad('unauthorized');
    if (meta.ended_at) return bad('room_ended');
    const from = Number.isInteger(after) && after > 0 ? after : 0;
    const size = Math.max(1, Math.min(Number(limit) || MAX_PAGE, MAX_PAGE));
    // One more than asked for, so "is there more" is a fact rather than a
    // guess from a full page.
    const rows = this.sql.exec('SELECT * FROM envelopes WHERE seq > ? ORDER BY seq LIMIT ?', from, size + 1).toArray();
    const page = rows.slice(0, size);
    this.touch();
    return {
      ok: true,
      envelopes: page.map(serveEnvelope),
      cursor: page.length ? page[page.length - 1].seq : from,
      hasMore: rows.length > size,
    };
  }

  async push({ token, envelopes }) {
    const member = await this.memberFor(token);
    if (!member) return bad('unauthorized');
    const meta = this.meta;
    if (!meta) return bad('unauthorized');
    if (meta.ended_at) return bad('room_ended');
    if (!Array.isArray(envelopes)) return bad('bad_request');
    if (envelopes.length > MAX_BATCH) return bad('too_many');

    // Everything asynchronous first: shape, then sender, then signature. Only
    // then is anything written.
    const good = [];
    const rejected = [];
    for (const raw of envelopes) {
      const checked = readEnvelope(raw);
      if (!checked.ok) {
        rejected.push({ envelopeId: typeof raw?.envelopeId === 'string' ? raw.envelopeId.slice(0, 64) : null, code: checked.code });
        continue;
      }
      if (checked.envelope.senderId !== member.sender_id) {
        rejected.push({ envelopeId: checked.envelope.envelopeId, code: 'bad_sender' });
        continue;
      }
      if (!(await verifySignature({ roomId: meta.id, envelope: checked.envelope, publicKey: member.public_key }))) {
        rejected.push({ envelopeId: checked.envelope.envelopeId, code: 'bad_signature' });
        continue;
      }
      good.push(checked.envelope);
    }

    const accepted = [];
    let added = 0;
    let bytes = 0;
    if (good.length) {
      const size = (e) => e.ciphertext.length + e.nonce.length + e.signature.length;
      // THE CAP APPLIES TO WHAT IS ACTUALLY ADDED. A retry is how this
      // protocol recovers from a push whose answer was lost, so a room near
      // its limit must not begin refusing retries of envelopes it already
      // holds — the client would retry them forever and nobody could confirm
      // the last comments were delivered. Only the genuinely new ones are
      // weighed. Reading and writing without an await between them is what
      // makes this atomic here; see the note at the top of the file.
      const fresh = good.filter(
        (e) => !this.sql.exec('SELECT 1 FROM envelopes WHERE envelope_id = ?', e.envelopeId).toArray().length
      );
      const total = fresh.reduce((n, e) => n + size(e), 0);
      if (meta.envelope_count + fresh.length > MAX_ROOM_ENVELOPES) return bad('room_full');
      if (meta.stored_bytes + total > MAX_ROOM_BYTES) return bad('room_full');
      const at = Date.now();
      // Only the new ones are inserted, and `fresh` is what the counters move
      // by. `rowsWritten` is not consulted: this runtime reports a written row
      // for an INSERT that took the ON CONFLICT branch, which would count a
      // duplicate against the room and make a retry near the limit fatal.
      for (const e of fresh) {
        this.sql.exec(
          `INSERT INTO envelopes (envelope_id, sender_id, nonce, ciphertext, signature, received_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(envelope_id) DO NOTHING`,
          e.envelopeId,
          e.senderId,
          e.nonce,
          e.ciphertext,
          e.signature,
          at
        );
      }
      added = fresh.length;
      bytes = total;
      // Every envelope in the batch is accepted, duplicates included: the
      // client's intent — "make sure you have this" — is satisfied either way,
      // and telling it "rejected" would make it retry forever.
      for (const e of good) accepted.push(e.envelopeId);
      if (added) this.sql.exec('UPDATE room_meta SET envelope_count = envelope_count + ?, stored_bytes = stored_bytes + ?', added, bytes);
      this.touch(at);
    }
    if (added) this.wake();
    return { ok: true, accepted, rejected, cursor: this.head };
  }

  async invite({ token, ttlMs = INVITE_TTL_MS }) {
    const member = await this.memberFor(token);
    if (!member) return bad('unauthorized');
    const meta = this.meta;
    if (!meta) return bad('unauthorized');
    if (meta.ended_at) return bad('room_ended');
    const at = Date.now();
    const open = this.sql.exec('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?', at).toArray()[0].n;
    if (open >= MAX_OPEN_INVITES) return bad('too_many');
    const life = Math.max(MIN_INVITE_TTL_MS, Math.min(Number(ttlMs) || INVITE_TTL_MS, INVITE_TTL_MS));
    const invite = newInvite();
    this.sql.exec(
      'INSERT INTO invites (token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)',
      await hash(invite),
      member.sender_id,
      at,
      at + life
    );
    this.touch(at);
    return { ok: true, invite, expiresAt: at + life };
  }

  /**
   * A member stops being one.
   *
   * The credential is replaced with a hash nothing can present rather than
   * removed, and the signing key stays — so envelopes they already sent go on
   * verifying for everybody else, which is the honest outcome: leaving revokes
   * access, it does not unsay what was said.
   */
  async leave(token) {
    const member = await this.memberFor(token);
    if (!member) return bad('unauthorized');
    this.sql.exec('UPDATE members SET left_at = ?, token_hash = ? WHERE sender_id = ?', Date.now(), await hash(newToken()), member.sender_id);
    this.touch();
    return { ok: true };
  }

  /** End it for everybody. The room's creator alone. */
  async end(token) {
    const member = await this.memberFor(token);
    if (!member) return bad('unauthorized');
    if (!member.is_owner) return bad('unauthorized');
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, 'room ended');
      } catch {
        /* already gone */
      }
    }
    await this.ctx.storage.deleteAlarm();
    // Every envelope, every invitation, every credential. What does not go is
    // anybody's local review history, which was never here.
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    return { ok: true };
  }

  /**
   * The retention sweep, as the room's own alarm.
   *
   * It re-checks rather than trusting the schedule: any activity since the
   * alarm was set has already pushed it further out, and an alarm that fires
   * early for any reason must not delete a room somebody is using.
   */
  async alarm() {
    const meta = this.meta;
    if (!meta) return;
    if (Date.now() - meta.last_activity < IDLE_ROOM_TTL_MS) {
      this.ctx.storage.setAlarm(meta.last_activity + IDLE_ROOM_TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
  }

  // --- the wake signal ------------------------------------------------------

  /** Tell every watcher where the head is. No review data, ever. */
  wake() {
    const message = JSON.stringify({ type: 'head', cursor: this.head });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        /* a socket that will not take it is one the runtime is closing */
      }
    }
  }

  /**
   * The WebSocket upgrade.
   *
   * `acceptWebSocket` rather than `accept` so the object may hibernate while
   * the connection stays open — a room with watchers and no traffic should not
   * be a running process. The credential arrives as the second subprotocol
   * because a browser-style WebSocket cannot set an Authorization header, and
   * a token in a URL is a token in an access log.
   */
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/watch')) return new Response('not found', { status: 404 });
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const offered = String(request.headers.get('sec-websocket-protocol') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (offered[0] !== WS_SUBPROTOCOL) return new Response('bad subprotocol', { status: 400 });
    const member = await this.memberFor(offered[1]);
    const meta = this.meta;
    if (!member || !meta || meta.ended_at) return new Response('unauthorized', { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // The current head straight away, so a client that connected just after a
    // push does not wait for the next one.
    try {
      server.send(JSON.stringify({ type: 'head', cursor: this.head }));
    } catch {
      /* the client will sync over HTTP regardless */
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL },
    });
  }

  /**
   * A client said something.
   *
   * There is nothing a client can say here that the HTTP API does not say
   * better, so nothing is interpreted. The socket exists to be written to.
   */
  async webSocketMessage(ws) {
    /* deliberately ignored */
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }
}

export { WS_SUBPROTOCOL, verifySignature, hash, VERSION };
