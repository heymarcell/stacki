// Where shared review events actually live.
//
// SQLite, through node's own `node:sqlite` — no dependency, no build step, one
// file on disk. Three properties are why it is here rather than a JSON file:
//
//   an autoincrementing `seq` is the cursor. Clients ask for "everything after
//   47" and get exactly that, in a stable order, forever. Nothing has to sort,
//   nothing has to remember, and pagination is a WHERE clause.
//
//   `UNIQUE(workspace_id, event_id)` is idempotence. A client that pushed
//   successfully and lost the answer pushes again; the second insert is a
//   no-op rather than a duplicate. That is the whole of the retry story.
//
//   a transaction is what makes a batch atomic. Half a push landing is a
//   thread with a reply and no message.
//
// WHAT THIS SERVICE STORES, and it is worth being exact about because the
// answer is small: review events, and the minimum needed to know who may read
// them. No project source. No screenshots. No file paths of anybody's disk. No
// git access, no shell, no filesystem beyond its own database.
//
// Tokens are stored as sha-256 hashes, so the database is not a list of keys.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TOKEN_BYTES = 32;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME = 60;
const MAX_HINT = 200;

const hash = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

const name = (value, fallback = null) => {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.slice(0, MAX_NAME);
};

/**
 * Open (or create) the database.
 *
 * `:memory:` is a real option and the tests use it — the whole service can be
 * started, driven and stopped without touching a disk.
 */
function openStore({ file = ':memory:', now = Date.now } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  // Durability and concurrency, in that order. WAL lets a reader and a writer
  // coexist; NORMAL is the right synchronous mode alongside it.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      repository_hint TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      actor_id      TEXT NOT NULL,
      display_name  TEXT,
      token_hash    TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      UNIQUE(workspace_id, actor_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash   TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      used_at      INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      event_id     TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      actor_id     TEXT NOT NULL,
      actor_kind   TEXT NOT NULL,
      lamport      INTEGER NOT NULL,
      submitted_by TEXT NOT NULL,
      received_at  INTEGER NOT NULL,
      body         TEXT NOT NULL,
      UNIQUE(workspace_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS events_by_workspace ON events(workspace_id, seq);
  `);

  const q = {
    workspace: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    insertWorkspace: db.prepare(
      'INSERT INTO workspaces (id, display_name, repository_hint, created_at) VALUES (?, ?, ?, ?)'
    ),
    insertMember: db.prepare(
      'INSERT INTO members (id, workspace_id, actor_id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    memberByToken: db.prepare('SELECT * FROM members WHERE token_hash = ?'),
    memberByActor: db.prepare('SELECT * FROM members WHERE workspace_id = ? AND actor_id = ?'),
    membersOf: db.prepare('SELECT actor_id, display_name FROM members WHERE workspace_id = ? ORDER BY created_at'),
    renameMember: db.prepare('UPDATE members SET display_name = ? WHERE id = ?'),
    insertInvite: db.prepare(
      'INSERT INTO invites (token_hash, workspace_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ),
    invite: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
    useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
    insertEvent: db.prepare(
      `INSERT INTO events (workspace_id, event_id, thread_id, actor_id, actor_kind, lamport, submitted_by, received_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, event_id) DO NOTHING`
    ),
    eventsAfter: db.prepare('SELECT seq, body FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    head: db.prepare('SELECT MAX(seq) AS head FROM events WHERE workspace_id = ?'),
    countEvents: db.prepare('SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?'),
  };

  return {
    db,
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },

    /** Start a workspace, with its first member. */
    createWorkspace({ displayName, repositoryHint, actorId, memberName }) {
      const at = now();
      const id = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const token = newToken();
      const run = db.prepare('BEGIN');
      run.run();
      try {
        q.insertWorkspace.run(id, name(displayName, 'Shared reviews'), name(repositoryHint, null), at);
        q.insertMember.run(memberId, id, actorId, name(memberName, null), hash(token), at);
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      return {
        workspace: { id, displayName: name(displayName, 'Shared reviews'), repositoryHint: name(repositoryHint, null), createdAt: at },
        credential: { token, memberId, actorId },
      };
    },

    /** The member a bearer token names, or null. */
    memberFor(token) {
      if (typeof token !== 'string' || !token) return null;
      const row = q.memberByToken.get(hash(token));
      return row || null;
    },

    workspaceFor(id) {
      if (typeof id !== 'string' || !id) return null;
      return q.workspace.get(id) || null;
    },

    membersOf(workspaceId) {
      return q.membersOf.all(workspaceId).map((m) => ({ actorId: m.actor_id, displayName: m.display_name }));
    },

    headOf(workspaceId) {
      const row = q.head.get(workspaceId);
      return Number.isInteger(row?.head) ? row.head : 0;
    },

    countOf(workspaceId) {
      return q.countEvents.get(workspaceId)?.n || 0;
    },

    /** A single-use invitation, valid for a bounded time. */
    createInvite({ workspaceId, memberId, ttlMs = INVITE_TTL_MS }) {
      const at = now();
      const token = newToken();
      const life = Math.max(60_000, Math.min(Number(ttlMs) || INVITE_TTL_MS, INVITE_TTL_MS));
      q.insertInvite.run(hash(token), workspaceId, memberId, at, at + life);
      return { invite: token, expiresAt: at + life };
    },

    /**
     * Redeem an invitation.
     *
     * Single use, and the marking is a conditional UPDATE rather than a read
     * then a write: two people racing the same invitation must not both get in
     * on it. Whoever's UPDATE changes a row is the one who used it.
     */
    redeemInvite({ invite, actorId, memberName }) {
      const at = now();
      const row = q.invite.get(hash(invite));
      if (!row) return { ok: false, code: 'bad_invite' };
      if (row.used_at) return { ok: false, code: 'used_invite' };
      if (row.expires_at < at) return { ok: false, code: 'expired_invite' };
      const claimed = q.useInvite.run(at, row.token_hash);
      if (!claimed.changes) return { ok: false, code: 'used_invite' };

      const workspace = q.workspace.get(row.workspace_id);
      if (!workspace) return { ok: false, code: 'bad_invite' };

      // Somebody rejoining — a reinstall, a second machine — keeps the same
      // actor and gets a fresh credential rather than becoming a second person.
      const existing = q.memberByActor.get(workspace.id, actorId);
      const token = newToken();
      if (existing) {
        db.prepare('UPDATE members SET token_hash = ?, display_name = ? WHERE id = ?').run(
          hash(token),
          name(memberName, existing.display_name),
          existing.id
        );
        return {
          ok: true,
          workspace: toWorkspace(workspace),
          credential: { token, memberId: existing.id, actorId },
        };
      }
      const memberId = crypto.randomUUID();
      q.insertMember.run(memberId, workspace.id, actorId, name(memberName, null), hash(token), at);
      return { ok: true, workspace: toWorkspace(workspace), credential: { token, memberId, actorId } };
    },

    renameMember(memberId, displayName) {
      q.renameMember.run(name(displayName, null), memberId);
    },

    /**
     * Append events, atomically, skipping any already held.
     *
     * The insert is ON CONFLICT DO NOTHING, so a duplicate is accepted rather
     * than refused: the client's intent — "make sure you have this" — is
     * satisfied either way, and telling it "rejected" would make it retry
     * forever.
     */
    appendEvents({ workspaceId, memberId, events }) {
      const at = now();
      const accepted = [];
      db.prepare('BEGIN IMMEDIATE').run();
      try {
        for (const event of events) {
          q.insertEvent.run(
            workspaceId,
            event.id,
            event.threadId,
            event.actorId,
            event.actorKind,
            event.lamport,
            memberId,
            at,
            JSON.stringify(event)
          );
          accepted.push(event.id);
        }
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      return { accepted, cursor: this.headOf(workspaceId) };
    },

    /** Everything after a cursor, in arrival order, bounded. */
    eventsAfter({ workspaceId, after = 0, limit = 200 }) {
      const from = Number.isInteger(after) && after > 0 ? after : 0;
      const size = Math.max(1, Math.min(Number(limit) || 200, 500));
      // One more than asked for, so "is there more" is a fact rather than a
      // guess from a full page.
      const rows = q.eventsAfter.all(workspaceId, from, size + 1);
      const page = rows.slice(0, size);
      const events = [];
      for (const row of page) {
        try {
          events.push(JSON.parse(row.body));
        } catch {
          /* a row that will not parse is a row this server wrote wrong; skip it */
        }
      }
      return {
        events,
        cursor: page.length ? page[page.length - 1].seq : from,
        hasMore: rows.length > size,
      };
    },
  };
}

const toWorkspace = (row) => ({
  id: row.id,
  displayName: row.display_name,
  repositoryHint: row.repository_hint,
  createdAt: row.created_at,
});

module.exports = { openStore, hash, newToken, INVITE_TTL_MS, MAX_NAME, MAX_HINT };
