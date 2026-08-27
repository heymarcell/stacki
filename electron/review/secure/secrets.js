// Where a room's secrets live, and the three places they must never be.
//
// A secure room has three things that are worth stealing:
//
//   the room master secret     — decrypts every comment in the room
//   the member bearer token    — gets in
//   the room signing key       — speaks as this member
//
// NOT IN THE PROJECT. Not a `.stacki` folder, not a dotfile, not a line in a
// config the project already has. A repository that grows a file because
// somebody enabled sharing is a repository that will have that file committed
// and pushed, and the credential with it. This is the same rule the legacy
// workspace registry has, restated because the consequence got worse: a leaked
// legacy token gets somebody into one workspace, and a leaked room secret
// decrypts everything ever said in the room, forever, including after they are
// removed from it.
//
// NOT IN THE RENDERER. Nothing here crosses IPC. `publicOf` is the only shape
// that leaves this file, and it is a status rather than a credential — see the
// IPC audit in test/secure-share.js, which asserts it by walking the object.
//
// NOT IN A LOG. There is no `console.log` in this file and no code path that
// puts a value from it into an error message.
//
// ENCRYPTED AT REST WHERE THE PLATFORM CAN. Electron's `safeStorage` on macOS
// is the Keychain and on Windows is DPAPI. On Linux it is whichever of
// kwallet or gnome-libsecret is present, and on a machine with neither there
// is no OS-backed key at all. That last case is real — a container, a minimal
// desktop, a CI box — and the answer is NOT to refuse to run: the file is
// still 0600, the fallback is reported honestly in diagnostics, and nobody is
// told they have protection they do not have.

const fs = require('node:fs');
const path = require('node:path');

const { relayOrigin } = require('./capability.js');
const { isRoomId, isSenderId, isPublicKey, isCredential, ROOM_SECRET_BYTES, fromBase64Url } = require('../../../relay/protocol.js');

const FILE = 'secure-rooms.json';
const MAX_ROOMS = 100;
const MAX_PROJECTS = 500;
// Names learned from decrypted review events, so a Manage dialog can say
// "Alice" rather than "a member". Bounded because it grows from other
// people's data.
const MAX_NAMES = 60;

const fileFor = (userDataPath) => path.join(userDataPath, FILE);

// The Linux backends that are a real secret store. Electron names them; these
// are the ones where the key is held by something outside this process.
const OS_BACKED_LINUX = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/**
 * The real protector, built lazily.
 *
 * Lazily because this module is required by tests that have no Electron, and
 * `require('electron')` outside an Electron process throws. Every test injects
 * its own protector; nothing automated ever reaches a real Keychain.
 *
 * `isEncryptionAvailable()` IS NOT THE QUESTION. On Linux it answers true even
 * when Electron has fallen back to `basic_text`, which — read Electron's own
 * description of `setUsePlainTextEncryption` — derives the key from an
 * in-memory password because no OS password manager could be determined. That
 * is a reversible encoding, not a secret store: anybody who can read the file
 * can read the room secrets in it. Treating it as protection would mean
 * telling somebody their secrets are encrypted at rest when they are not,
 * which is the one thing a security feature must never do.
 *
 * So `protects` is narrower than `available`, and it is `protects` that
 * decides whether anything is sealed. Where it is false the room is stored in
 * the 0600 file unsealed and `protection()` says so out loud.
 */
function electronProtector() {
  let safeStorage = null;
  try {
    ({ safeStorage } = require('electron'));
  } catch {
    safeStorage = null;
  }

  /** What the platform is actually using. Never a key, never a secret. */
  const backendOf = () => {
    try {
      if (!safeStorage) return 'none';
      if (!safeStorage.isEncryptionAvailable()) return 'none';
      if (process.platform === 'darwin') return 'keychain';
      if (process.platform === 'win32') return 'dpapi';
      if (process.platform === 'linux') {
        return typeof safeStorage.getSelectedStorageBackend === 'function'
          ? safeStorage.getSelectedStorageBackend()
          : 'unknown';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };

  return {
    /** Whether encrypt/decrypt can be called at all. */
    get available() {
      try {
        return !!safeStorage?.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    get backend() {
      return backendOf();
    },
    /** Whether that backend is somewhere a secret is genuinely kept. */
    get protects() {
      const backend = backendOf();
      if (backend === 'keychain' || backend === 'dpapi') return true;
      return OS_BACKED_LINUX.has(backend);
    },
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
  };
}

const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  if (!text || text.length > max) return null;
  return text;
};

/**
 * A stored room, checked field by field.
 *
 * Everything that could have been edited by hand, corrupted, or written by a
 * different version is refused rather than half-loaded — a room with a
 * malformed secret is not a room this app can be careful with.
 */
function reviveRoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const roomId = str(raw.roomId, 64);
  const relay = relayOrigin(raw.relay);
  if (!roomId || !isRoomId(roomId) || !relay) return null;
  if (!fromBase64Url(raw.secret, ROOM_SECRET_BYTES)) return null;
  if (!isCredential(raw.token)) return null;
  if (!fromBase64Url(raw.privateKey, 32)) return null;
  if (!isPublicKey(raw.publicKey)) return null;
  if (!isSenderId(raw.senderId)) return null;

  const pins = {};
  for (const [sender, key] of Object.entries(raw.pins || {})) {
    if (isSenderId(sender) && isPublicKey(key)) pins[sender] = key;
  }
  const names = {};
  let n = 0;
  for (const [sender, shown] of Object.entries(raw.names || {})) {
    if (n >= MAX_NAMES) break;
    if (isSenderId(sender) && typeof shown === 'string' && shown.trim()) {
      names[sender] = shown.trim().slice(0, 60);
      n += 1;
    }
  }
  return {
    roomId,
    relay,
    secret: raw.secret,
    token: raw.token,
    privateKey: raw.privateKey,
    publicKey: raw.publicKey,
    senderId: raw.senderId,
    actorId: str(raw.actorId, 100),
    isOwner: raw.isOwner === true,
    joinedAt: Number.isInteger(raw.joinedAt) ? raw.joinedAt : 0,
    pins,
    names,
  };
}

/**
 * What is kept about a room this machine has LEFT.
 *
 * Leaving revokes a credential. It does not, and must not, throw away this
 * member's signing identity — because a sender id is derived from the room
 * secret and the actor id, so somebody who leaves and is later invited back to
 * the SAME room comes back as the same sender. If a fresh keypair were
 * generated then, the relay would refuse it (a member's key is fixed for the
 * life of the room) and every peer would refuse it too, correctly, as a key
 * substitution. Rejoining would be impossible for the one person it is most
 * likely to be offered to.
 *
 * So a departed room keeps exactly what is needed to be recognised again:
 *
 *   the room id, the signing keypair, the sender id, the actor it belongs to,
 *   and the keys of peers already pinned.
 *
 * And nothing else. NOT the room master secret — a new invitation carries that
 * again — and NOT a bearer token, which the relay has revoked. Holding a room
 * secret for a room this machine has left would be keeping the ability to read
 * a conversation it has walked out of.
 */
function reviveDormant(raw) {
  if (!raw || typeof raw !== 'object' || raw.dormant !== true) return null;
  const roomId = str(raw.roomId, 64);
  if (!roomId || !isRoomId(roomId)) return null;
  if (!fromBase64Url(raw.privateKey, 32)) return null;
  if (!isPublicKey(raw.publicKey)) return null;
  if (!isSenderId(raw.senderId)) return null;

  const pins = {};
  for (const [sender, key] of Object.entries(raw.pins || {})) {
    if (isSenderId(sender) && isPublicKey(key)) pins[sender] = key;
  }
  return {
    dormant: true,
    roomId,
    relay: relayOrigin(raw.relay),
    privateKey: raw.privateKey,
    publicKey: raw.publicKey,
    senderId: raw.senderId,
    actorId: str(raw.actorId, 100),
    isOwner: raw.isOwner === true,
    pins,
    leftAt: Number.isInteger(raw.leftAt) ? raw.leftAt : 0,
  };
}

/**
 * The room registry.
 *
 * A thin object over one file, like the legacy workspace registry beside it,
 * so a test points it at a temporary directory and the app points it at
 * userData and neither is a special case.
 */
function createSecureRooms({ userDataPath, protector = null, now = Date.now } = {}) {
  if (!userDataPath) throw new Error('the secure room registry needs a userData directory');
  const keeper = protector || electronProtector();

  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFor(userDataPath), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  /**
   * Write it back, 0600, atomically.
   *
   * The mode is set on create AND again after, because `writeFileSync` leaves
   * an existing file's mode alone — a file that was once 0644 would stay 0644
   * forever otherwise.
   */
  const write = (data) => {
    const file = fileFor(userDataPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* a filesystem with no modes; the rename still happens */
    }
    fs.renameSync(tmp, file);
  };

  /**
   * Whether this protector is somewhere a secret is genuinely kept.
   *
   * `protects` when the protector says so; an injected test protector that
   * only says `available` is taken at its word. Never `isEncryptionAvailable`
   * alone — see electronProtector.
   */
  const protects = () => (typeof keeper.protects === 'boolean' ? keeper.protects : !!keeper.available);

  /** One room entry, sealed if the platform can genuinely keep a secret. */
  const seal = (room) => {
    if (!protects()) return { protected: false, room };
    try {
      return { protected: true, blob: keeper.encrypt(JSON.stringify(room)) };
    } catch {
      // A keychain that refuses at the moment of writing must not lose the
      // room. Stored unsealed, and `secure()` reports the truth about it.
      return { protected: false, room };
    }
  };

  /** The stored object, whether it was sealed or not. Null if unreadable. */
  const opened = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.protected !== true) return entry.room || null;
    try {
      return JSON.parse(keeper.decrypt(entry.blob));
    } catch {
      return null;
    }
  };

  /** An ACTIVE room. A dormant identity is not one and never answers as one. */
  const unseal = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.protected !== true) return entry.room?.dormant ? null : reviveRoom(entry.room);
    try {
      const raw = JSON.parse(keeper.decrypt(entry.blob));
      return raw?.dormant ? null : reviveRoom(raw);
    } catch {
      // A blob this machine can no longer decrypt — a restored backup, a
      // different user account, a reset keychain. It is not recoverable and
      // pretending otherwise would mean syncing with a room we cannot read.
      return null;
    }
  };

  function all() {
    const data = read();
    const rooms = data.rooms && typeof data.rooms === 'object' ? data.rooms : {};
    return Object.values(rooms).map(unseal).filter(Boolean).slice(0, MAX_ROOMS);
  }

  const get = (roomId) => {
    if (!roomId) return null;
    const data = read();
    return unseal(data.rooms?.[roomId]) || null;
  };

  /**
   * The only shape that may cross IPC.
   *
   * No room id, no relay credential, no key material. The renderer is told
   * that sharing is on, where it points, whether this machine may end it, and
   * who is known to be in it — which is everything the UI has to draw and
   * nothing else.
   */
  const publicOf = (room) =>
    room
      ? {
          relay: room.relay,
          isOwner: room.isOwner,
          joinedAt: room.joinedAt,
          // Members this machine has actually observed, which is not the same
          // as members the relay knows about — see `learnName`.
          memberCount: Object.keys(room.pins).length,
          participants: Object.entries(room.names)
            .filter(([sender]) => sender !== room.senderId)
            .map(([, shown]) => shown),
        }
      : null;

  function remember(room) {
    const entry = reviveRoom({ ...room, joinedAt: room.joinedAt || now() });
    if (!entry) return null;
    const data = read();
    const rooms = data.rooms && typeof data.rooms === 'object' ? { ...data.rooms } : {};
    if (Object.keys(rooms).length >= MAX_ROOMS && !rooms[entry.roomId]) return null;
    rooms[entry.roomId] = seal(entry);
    write({ ...data, version: 2, rooms });
    return entry;
  }

  /** Change part of a room in place — a pin learned, a name observed, a token replaced. */
  function update(roomId, patch) {
    const existing = get(roomId);
    if (!existing) return null;
    return remember({ ...existing, ...patch, joinedAt: existing.joinedAt });
  }

  /**
   * Learn a member's signing key, once.
   *
   * THE PIN NEVER MOVES. A sender id whose public key is already known and
   * arrives with a different one is a key substitution — a relay handing out
   * somebody else's key so that its own envelopes verify — and it is refused
   * rather than merged. Returns false when that happens, and the caller stops.
   *
   * This is deliberately not a PKI. There is no revocation, no chain, no
   * expiry. It is one map, and the property it gives is exactly "the person
   * who was Alice yesterday is the person who is Alice today".
   */
  function pin(roomId, senderId, publicKey) {
    if (!isSenderId(senderId) || !isPublicKey(publicKey)) return { ok: false, code: 'bad_key' };
    const room = get(roomId);
    if (!room) return { ok: false, code: 'not_found' };
    const known = room.pins[senderId];
    if (known && known !== publicKey) return { ok: false, code: 'key_changed' };
    if (known) return { ok: true, changed: false };
    update(roomId, { pins: { ...room.pins, [senderId]: publicKey } });
    return { ok: true, changed: true };
  }

  /**
   * Remember what a member calls themselves.
   *
   * Learned from a DECRYPTED review event and from nowhere else. No display
   * name is ever sent to a relay, so a member who has joined and never written
   * anything is somebody this machine knows exists and cannot name — which is
   * the honest answer, and better than inventing a cloud people directory to
   * avoid it.
   */
  function learnName(roomId, senderId, displayName) {
    if (!isSenderId(senderId) || typeof displayName !== 'string' || !displayName.trim()) return false;
    const room = get(roomId);
    if (!room) return false;
    const shown = displayName.trim().slice(0, 60);
    if (room.names[senderId] === shown) return false;
    if (Object.keys(room.names).length >= MAX_NAMES && !room.names[senderId]) return false;
    update(roomId, { names: { ...room.names, [senderId]: shown } });
    return true;
  }

  /**
   * Step out of a room, keeping only enough to be recognised if invited back.
   *
   * This is what a CONFIRMED leave does. The room master secret and the bearer
   * token go — this machine can no longer read the room and no longer has a
   * way in — and the signing identity stays, because the relay and every peer
   * have it pinned for the life of the room. See reviveDormant.
   *
   * Local review history is untouched, as ever. Nothing here is a comment.
   */
  function retire(roomId) {
    const room = get(roomId);
    if (!room) return false;
    const data = read();
    const rooms = data.rooms && typeof data.rooms === 'object' ? { ...data.rooms } : {};
    const identity = reviveDormant({
      dormant: true,
      roomId: room.roomId,
      relay: room.relay,
      privateKey: room.privateKey,
      publicKey: room.publicKey,
      senderId: room.senderId,
      actorId: room.actorId,
      isOwner: room.isOwner,
      pins: room.pins,
      leftAt: now(),
    });
    if (!identity) return false;
    rooms[roomId] = seal(identity);
    const projects = { ...(data.projects || {}) };
    for (const [key, value] of Object.entries(projects)) {
      if (value?.roomId === roomId) delete projects[key];
    }
    write({ ...data, version: 2, rooms, projects });
    return true;
  }

  /** The signing identity kept from a room this machine has left, if any. */
  function dormantFor(roomId) {
    if (!roomId) return null;
    return reviveDormant(opened(read().rooms?.[roomId])) || null;
  }

  /**
   * Forget a room and every project pointed at it, entirely.
   *
   * Used when there is nothing to come back to — the room has ended. Local
   * review history is untouched. This drops the credential, the secret, the
   * signing identity and the mapping — nothing that is a comment.
   */
  function forget(roomId) {
    const data = read();
    const rooms = { ...(data.rooms || {}) };
    if (!rooms[roomId]) return false;
    delete rooms[roomId];
    const projects = { ...(data.projects || {}) };
    for (const [key, value] of Object.entries(projects)) {
      if (value?.roomId === roomId) delete projects[key];
    }
    write({ ...data, rooms, projects });
    return true;
  }

  const forProject = (key) => {
    if (!key) return null;
    const roomId = str(read().projects?.[key]?.roomId, 64);
    return roomId ? get(roomId) : null;
  };

  function link(key, roomId) {
    if (!key || !get(roomId)) return false;
    const data = read();
    const projects = data.projects && typeof data.projects === 'object' ? { ...data.projects } : {};
    if (Object.keys(projects).length >= MAX_PROJECTS && !projects[key]) return false;
    projects[key] = { roomId, linkedAt: now() };
    write({ ...data, version: 2, projects });
    return true;
  }

  function unlink(key) {
    const data = read();
    if (!data.projects?.[key]) return false;
    const projects = { ...data.projects };
    delete projects[key];
    write({ ...data, projects });
    return true;
  }

  /**
   * Which relay this installation creates new shares against.
   *
   * A preference and not a credential: it is stored unencrypted beside the
   * rooms, it may be read by anything that can read the file, and a bad value
   * is ignored rather than fatal. See relays.js for the order it is consulted
   * in.
   */
  const preferredRelay = () => relayOrigin(read().preferredRelay);

  function setPreferredRelay(origin) {
    const data = read();
    const normalized = origin ? relayOrigin(origin) : null;
    if (origin && !normalized) return false;
    write({ ...data, version: 2, preferredRelay: normalized });
    return true;
  }

  return {
    file: fileFor(userDataPath),
    all,
    get,
    publicOf,
    preferredRelay,
    setPreferredRelay,
    remember,
    update,
    retire,
    dormantFor,
    pin,
    learnName,
    forget,
    forProject,
    link,
    unlink,
    /**
     * How well this machine can keep a secret. For diagnostics, never for the
     * renderer, and never rounded up: `encrypted` means an OS-backed key held
     * outside this process, not merely that a call succeeded.
     */
    protection() {
      const backend = keeper.backend || (protects() ? 'os' : 'file');
      return {
        encrypted: protects(),
        // True when Electron would encrypt but the key is not really kept
        // anywhere — Linux with no password manager. Reported rather than
        // rounded to either answer.
        weakBackend: !!keeper.available && !protects(),
        backend,
        mode: (() => {
          try {
            return (fs.statSync(fileFor(userDataPath)).mode & 0o077) === 0 ? 'private' : 'loose';
          } catch {
            return 'private'; // nothing written yet
          }
        })(),
      };
    },
  };
}

module.exports = { createSecureRooms, reviveRoom, fileFor, electronProtector, FILE, MAX_ROOMS, MAX_PROJECTS };
