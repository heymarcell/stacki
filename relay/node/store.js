// Where the ciphertext sits.
//
// SQLite through node's own `node:sqlite` — no dependency, no build step, one
// file. The same three properties the plaintext service's store was chosen for
// still apply, and one more that is new:
//
//   an autoincrementing `seq` is the cursor. "Everything after 47" is a WHERE
//   clause and a stable order, forever.
//
//   UNIQUE(room_id, envelope_id) is idempotence. A push that succeeded and
//   lost its answer lands on the same row a second time and changes nothing.
//
//   a transaction makes a batch atomic. Half a push landing is a thread with a
//   reply and no message.
//
//   AND: not one column here holds anything a person wrote. Look at the
//   schema. `ciphertext`, `nonce`, `signature` — opaque; `sender_id`,
//   `envelope_id` — HMACs under keys this process has never seen. There is no
//   `body`, no `thread_id`, no `actor_id`, no `type`. The plaintext service has
//   all five, which is exactly the difference this feature is.
//
// Tokens are stored as SHA-256 hashes and never in the clear, so a database
// dump is not a list of keys to the rooms it describes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  TOKEN_BYTES,
  INVITE_BYTES,
  INVITE_TTL_MS,
  MIN_INVITE_TTL_MS,
  MAX_MEMBERS,
  MAX_OPEN_INVITES,
  MAX_ROOM_ENVELOPES,
  MAX_ROOM_BYTES,
  IDLE_ROOM_TTL_MS,
  toBase64Url,
} = require('../protocol.js');

const hash = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
const newToken = () => toBase64Url(crypto.randomBytes(TOKEN_BYTES));
const newInvite = () => toBase64Url(crypto.randomBytes(INVITE_BYTES));

function openStore({ file = ':memory:', now = Date.now } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id             TEXT PRIMARY KEY,
      created_at     INTEGER NOT NULL,
      last_activity  INTEGER NOT NULL,
      owner_sender   TEXT NOT NULL,
      ended_at       INTEGER,
      envelope_count INTEGER NOT NULL DEFAULT 0,
      stored_bytes   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS members (
      room_id    TEXT NOT NULL REFERENCES rooms(id),
      sender_id  TEXT NOT NULL,
      public_key TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      joined_at  INTEGER NOT NULL,
      left_at    INTEGER,
      is_owner   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, sender_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL REFERENCES rooms(id),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS envelopes (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id     TEXT NOT NULL REFERENCES rooms(id),
      envelope_id TEXT NOT NULL,
      sender_id   TEXT NOT NULL,
      nonce       TEXT NOT NULL,
      ciphertext  TEXT NOT NULL,
      signature   TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      UNIQUE(room_id, envelope_id)
    );
    CREATE INDEX IF NOT EXISTS envelopes_by_room ON envelopes(room_id, seq);
  `);

  const q = {
    room: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    insertRoom: db.prepare('INSERT INTO rooms (id, created_at, last_activity, owner_sender) VALUES (?, ?, ?, ?)'),
    touchRoom: db.prepare('UPDATE rooms SET last_activity = ? WHERE id = ?'),
    endRoom: db.prepare('UPDATE rooms SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    insertMember: db.prepare(
      'INSERT INTO members (room_id, sender_id, public_key, token_hash, joined_at, is_owner) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    memberByToken: db.prepare('SELECT * FROM members WHERE token_hash = ?'),
    memberBySender: db.prepare('SELECT * FROM members WHERE room_id = ? AND sender_id = ?'),
    membersOf: db.prepare('SELECT sender_id, public_key, joined_at, left_at, is_owner FROM members WHERE room_id = ? ORDER BY joined_at'),
    countMembers: db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id = ? AND left_at IS NULL'),
    rejoin: db.prepare('UPDATE members SET token_hash = ?, left_at = NULL WHERE room_id = ? AND sender_id = ?'),
    leave: db.prepare('UPDATE members SET left_at = ?, token_hash = ? WHERE room_id = ? AND sender_id = ?'),
    insertInvite: db.prepare('INSERT INTO invites (token_hash, room_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    invite: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
    useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
    countInvites: db.prepare('SELECT COUNT(*) AS n FROM invites WHERE room_id = ? AND used_at IS NULL AND expires_at > ?'),
    insertEnvelope: db.prepare(
      `INSERT INTO envelopes (room_id, envelope_id, sender_id, nonce, ciphertext, signature, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room_id, envelope_id) DO NOTHING`
    ),
    hasEnvelope: db.prepare('SELECT 1 AS yes FROM envelopes WHERE room_id = ? AND envelope_id = ?'),
    after: db.prepare('SELECT * FROM envelopes WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    head: db.prepare('SELECT MAX(seq) AS head FROM envelopes WHERE room_id = ?'),
    bump: db.prepare('UPDATE rooms SET envelope_count = envelope_count + ?, stored_bytes = stored_bytes + ? WHERE id = ?'),
    dropEnvelopes: db.prepare('DELETE FROM envelopes WHERE room_id = ?'),
    dropInvites: db.prepare('DELETE FROM invites WHERE room_id = ?'),
    dropMembers: db.prepare('DELETE FROM members WHERE room_id = ?'),
    dropRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
    idleRooms: db.prepare('SELECT id FROM rooms WHERE last_activity < ?'),
  };

  const store = {
    db,
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },

    roomFor: (id) => (typeof id === 'string' && id ? q.room.get(id) || null : null),

    /** Start a room. The creator is its owner, and the only member there is. */
    createRoom({ roomId, senderId, publicKey }) {
      const at = now();
      if (q.room.get(roomId)) return { ok: false, code: 'member_exists' };
      const token = newToken();
      db.prepare('BEGIN IMMEDIATE').run();
      try {
        q.insertRoom.run(roomId, at, at, senderId);
        q.insertMember.run(roomId, senderId, publicKey, hash(token), at, 1);
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      return { ok: true, room: { id: roomId, createdAt: at }, credential: { token } };
    },

    /** The member a bearer token names, or null. Left members are not members. */
    memberFor(token) {
      if (typeof token !== 'string' || !token) return null;
      const row = q.memberByToken.get(hash(token));
      return row && !row.left_at ? row : null;
    },

    membersOf(roomId) {
      return q.membersOf.all(roomId).map((m) => ({
        senderId: m.sender_id,
        publicKey: m.public_key,
        joinedAt: m.joined_at,
        leftAt: m.left_at,
        isOwner: !!m.is_owner,
      }));
    },

    headOf(roomId) {
      const row = q.head.get(roomId);
      return Number.isInteger(row?.head) ? row.head : 0;
    },

    touch(roomId) {
      q.touchRoom.run(now(), roomId);
    },

    /** A single-use invitation, valid for a bounded time. */
    createInvite({ roomId, senderId, ttlMs = INVITE_TTL_MS }) {
      const at = now();
      if (q.countInvites.get(roomId, at).n >= MAX_OPEN_INVITES) return { ok: false, code: 'too_many' };
      const life = Math.max(MIN_INVITE_TTL_MS, Math.min(Number(ttlMs) || INVITE_TTL_MS, INVITE_TTL_MS));
      const invite = newInvite();
      q.insertInvite.run(hash(invite), roomId, senderId, at, at + life);
      return { ok: true, invite, expiresAt: at + life };
    },

    /**
     * Redeem an invitation.
     *
     * Single use, and the claim is a CONDITIONAL UPDATE rather than a read then
     * a write: two people racing the same invitation must not both get in on
     * it. Whoever's UPDATE changes a row is the one who used it, and the other
     * gets the same refusal a wrong invitation gets.
     */
    redeemInvite({ roomId, invite, senderId, publicKey }) {
      const at = now();
      const row = q.invite.get(hash(invite));
      // One answer for every kind of bad invitation, so guessing cannot tell a
      // wrong one from a used one from an expired one.
      if (!row || row.room_id !== roomId) return { ok: false, code: 'bad_invite' };
      if (row.used_at || row.expires_at < at) return { ok: false, code: 'bad_invite' };
      const room = q.room.get(roomId);
      if (!room) return { ok: false, code: 'bad_invite' };
      if (room.ended_at) return { ok: false, code: 'room_ended' };

      const existing = q.memberBySender.get(roomId, senderId);
      // A member's signing key is fixed for the life of the room. Somebody
      // rejoining with a different one would be indistinguishable from
      // somebody else claiming their sender id, and peers have the old key
      // pinned in any case.
      if (existing && existing.public_key !== publicKey) return { ok: false, code: 'bad_key' };
      if (!existing && q.countMembers.get(roomId).n >= MAX_MEMBERS) return { ok: false, code: 'room_full' };

      const token = newToken();
      db.prepare('BEGIN IMMEDIATE').run();
      try {
        const claimed = q.useInvite.run(at, row.token_hash);
        if (!claimed.changes) {
          db.prepare('ROLLBACK').run();
          return { ok: false, code: 'bad_invite' };
        }
        if (existing) q.rejoin.run(hash(token), roomId, senderId);
        else q.insertMember.run(roomId, senderId, publicKey, hash(token), at, 0);
        q.touchRoom.run(at, roomId);
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      // `is_owner` is not touched by a rejoin, so somebody who created the room,
      // left, and was invited back comes back as its owner.
      return {
        ok: true,
        room: { id: roomId, createdAt: room.created_at },
        credential: { token },
        isOwner: !!(existing ? existing.is_owner : 0),
      };
    },

    /**
     * Store a batch, atomically, skipping any already held.
     *
     * A duplicate is ACCEPTED rather than refused: the client's intent — "make
     * sure you have this" — is satisfied either way, and telling it "rejected"
     * would make it retry forever.
     */
    /**
     * Store a batch, atomically, skipping any already held.
     *
     * THE CAP APPLIES TO WHAT IS ACTUALLY ADDED. A retry is how this protocol
     * recovers from a push whose answer was lost, so a room near its limit
     * must not start refusing retries of envelopes it already has: that would
     * turn the last few hundred comments of a room into ones nobody could
     * confirm were delivered, and the client would retry them forever.
     *
     * So the duplicates are identified first — inside the same transaction
     * that does the insert, so nothing can slip in between — and only the
     * genuinely new ones are weighed against the limit.
     */
    appendEnvelopes({ roomId, envelopes }) {
      const at = now();
      const room = q.room.get(roomId);
      const accepted = [];
      let added = 0;
      let bytes = 0;
      const size = (e) => e.ciphertext.length + e.nonce.length + e.signature.length;

      db.prepare('BEGIN IMMEDIATE').run();
      try {
        const fresh = envelopes.filter((e) => !q.hasEnvelope.get(roomId, e.envelopeId));
        const incoming = fresh.reduce((n, e) => n + size(e), 0);
        if (room.envelope_count + fresh.length > MAX_ROOM_ENVELOPES || room.stored_bytes + incoming > MAX_ROOM_BYTES) {
          db.prepare('ROLLBACK').run();
          return { ok: false, code: 'room_full' };
        }
        for (const e of envelopes) {
          const done = q.insertEnvelope.run(roomId, e.envelopeId, e.senderId, e.nonce, e.ciphertext, e.signature, at);
          accepted.push(e.envelopeId);
          if (done.changes) {
            added += 1;
            bytes += size(e);
          }
        }
        if (added) q.bump.run(added, bytes, roomId);
        q.touchRoom.run(at, roomId);
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      return { ok: true, accepted, cursor: store.headOf(roomId), added };
    },

    /** Everything after a cursor, in arrival order, bounded. */
    envelopesAfter({ roomId, after = 0, limit = 200 }) {
      const from = Number.isInteger(after) && after > 0 ? after : 0;
      const size = Math.max(1, Math.min(Number(limit) || 200, 200));
      // One more than asked for, so "is there more" is a fact rather than a
      // guess from a full page.
      const rows = q.after.all(roomId, from, size + 1);
      const page = rows.slice(0, size);
      return {
        envelopes: page,
        cursor: page.length ? page[page.length - 1].seq : from,
        hasMore: rows.length > size,
      };
    },

    /**
     * A member stops being one.
     *
     * The credential is replaced with a value nothing can present — a fresh
     * random hash rather than NULL, because the column is UNIQUE and because
     * "no token" and "a token that cannot exist" should look the same to every
     * query. The signing key stays, so envelopes they already sent go on
     * verifying for everybody else.
     */
    leaveRoom({ roomId, senderId }) {
      q.leave.run(now(), hash(newToken()), roomId, senderId);
      q.touchRoom.run(now(), roomId);
      return { ok: true };
    },

    /**
     * End a room, for everybody.
     *
     * Every envelope, every invitation and every credential goes. What does not
     * go is anybody's local review history, which was never here.
     */
    endRoom(roomId) {
      db.prepare('BEGIN IMMEDIATE').run();
      try {
        q.endRoom.run(now(), roomId);
        q.dropEnvelopes.run(roomId);
        q.dropInvites.run(roomId);
        q.dropMembers.run(roomId);
        q.dropRoom.run(roomId);
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      return { ok: true };
    },

    /** Rooms nobody has authenticated against in a long time. See the retention note. */
    sweepIdle({ ttlMs = IDLE_ROOM_TTL_MS } = {}) {
      const cutoff = now() - ttlMs;
      const ids = q.idleRooms.all(cutoff).map((r) => r.id);
      for (const id of ids) store.endRoom(id);
      return ids.length;
    },
  };
  return store;
}

module.exports = { openStore, hash, newToken, newInvite };
