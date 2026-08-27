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

/**
 * The real protector, built lazily.
 *
 * Lazily because this module is required by tests that have no Electron, and
 * `require('electron')` outside an Electron process throws. Every test injects
 * its own protector; nothing automated ever reaches a real Keychain.
 */
function electronProtector() {
  let safeStorage = null;
  try {
    ({ safeStorage } = require('electron'));
  } catch {
    safeStorage = null;
  }
  return {
    get available() {
      try {
        return !!safeStorage?.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    /** What the OS is actually using, for diagnostics. Never a key, never a secret. */
    get backend() {
      try {
        if (!safeStorage) return 'none';
        if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend) {
          return safeStorage.getSelectedStorageBackend();
        }
        return safeStorage.isEncryptionAvailable() ? (process.platform === 'darwin' ? 'keychain' : 'dpapi') : 'none';
      } catch {
        return 'unknown';
      }
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

  /** One room entry, sealed if the platform can seal it. */
  const seal = (room) => {
    if (!keeper.available) return { protected: false, room };
    try {
      return { protected: true, blob: keeper.encrypt(JSON.stringify(room)) };
    } catch {
      // A keychain that refuses at the moment of writing must not lose the
      // room. Stored unsealed, and `secure()` reports the truth about it.
      return { protected: false, room };
    }
  };

  const unseal = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.protected !== true) return reviveRoom(entry.room);
    try {
      return reviveRoom(JSON.parse(keeper.decrypt(entry.blob)));
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
   * Forget a room and every project pointed at it.
   *
   * Local review history is untouched. This drops the credential, the secret
   * and the mapping — nothing that is a comment.
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

  return {
    file: fileFor(userDataPath),
    all,
    get,
    publicOf,
    remember,
    update,
    pin,
    learnName,
    forget,
    forProject,
    link,
    unlink,
    /** How well this machine can keep a secret. For diagnostics, never for the renderer. */
    protection() {
      return {
        encrypted: !!keeper.available,
        backend: keeper.backend || (keeper.available ? 'os' : 'file'),
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
