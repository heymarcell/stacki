// The Node secure relay, against the protocol and against itself.
//
//   node --disable-warning=ExperimentalWarning test/secure-relay.js
//
// Two halves. The first is `test/relay-conformance.js`, the suite both relays
// answer to, driven here over a real socket against a real SQLite database.
// The second is everything only this implementation can be asked about: what
// is actually in the file it writes, what actually goes to its log, whether
// the socket that wakes clients up works, and whether the caps hold.
//
// THE PLAINTEXT PROOF is the one that matters most and it is deliberately not
// a grep of the source. A whole share runs — a room, two members, real events
// carrying distinctive strings — and then every byte of the database file is
// searched for those strings. Source can be read wrongly; a file cannot.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { createSecureRelay, WS_SUBPROTOCOL, createLimiter, bearerOf } = require('../relay/node/server.js');
const { openStore, hash } = require('../relay/node/store.js');
const { runConformance, newMember, envelopeFrom, randomBytes, CONFORMANCE_CHECKS } = require('./relay-conformance.js');
const { createSecureRooms } = require('../electron/review/secure/secrets.js');
const { createSecureTransport, createRoom, joinRoom } = require('../electron/review/secure/transport.js');
const { makeEvent } = require('../electron/review/events.js');
const { uuidv5 } = require('../electron/review/actors.js');
const { toBase64Url, MAX_MEMBERS, IDLE_ROOM_TTL_MS } = require('../relay/protocol.js');
// PR #8's discipline: a fixture this run OWNS, marked, so a concurrent harness
// is never mistaken for this one's leak and never deleted by it.
const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = [];
const mkdir = (tag) => {
  const dir = ownedTempDir(`stacki-secure-${tag}-`, { harness: 'secure-relay' });
  temp.push(dir);
  return dir;
};

// Never a real keychain in an automated test. See secrets.js.
const protector = {
  available: true,
  backend: 'test',
  encrypt: (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: (blob) => Buffer.from(blob, 'base64').toString('utf8'),
};

const ALICE = { id: uuidv5('alice'), kind: 'human', displayName: 'Alice Secret Tester' };
const BOB = { id: uuidv5('bob'), kind: 'human', displayName: 'Bob' };

// The strings that must never turn up in a relay's storage or its log.
const CANARY = {
  body: 'STACKI_PLAINTEXT_CANARY_7d4f1a',
  file: 'src/pages/super-secret-test.astro',
  branch: 'private-test-branch',
  name: 'Alice Secret Tester',
};

async function main() {
  const logged = [];
  const dataDir = mkdir('relaydb');
  const dbFile = path.join(dataDir, 'relay.db');
  // Real time, deliberately: the conformance suite proves an invitation
  // expires by waiting for it, which an injected clock would quietly turn into
  // a test that proves nothing. The sweep test below gets its own clock.
  let clock = Date.now();
  const relay = createSecureRelay({
    port: 0,
    host: '127.0.0.1',
    file: dbFile,
    log: (line) => logged.push(String(line)),
    onError: () => {},
  });
  await relay.start();
  const base = `http://127.0.0.1:${relay.address.port}`;

  /** One request, as the conformance suite wants it. */
  const call = async (pathname, { method = 'GET', body = null, headers = {} } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { accept: 'application/json', ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };

  const conformance = await runConformance({ call, label: 'node' });
  checked += conformance.checked;
  failures.push(...conformance.failures);
  check('the whole conformance suite ran', conformance.checked === CONFORMANCE_CHECKS, `${conformance.checked} of ${CONFORMANCE_CHECKS}`);

  check('the relay answers a health check', (await call('/health')).body?.ok === true);

  // --- a real share, then look in the database ------------------------------

  const aliceData = mkdir('alice');
  const bobData = mkdir('bob');
  const aliceRooms = createSecureRooms({ userDataPath: aliceData, protector });
  const bobRooms = createSecureRooms({ userDataPath: bobData, protector });

  const made = await createRoom({ relay: base, actor: ALICE, rooms: aliceRooms });
  check('a client can create a secure share against this relay', made.ok, made.code);
  const roomId = made.room.roomId;
  const aliceT = createSecureTransport({ rooms: aliceRooms, roomId });

  const invite = await aliceT.createInvite({});
  check('a client can make an invitation', invite.ok && typeof invite.capability === 'string');

  const bobJoin = await joinRoom({ capability: invite.capability, actor: BOB, rooms: bobRooms });
  check('a second client can join with it', bobJoin.ok, bobJoin.code);
  const bobT = createSecureTransport({ rooms: bobRooms, roomId });

  const thread = makeEvent({
    type: 'thread.created',
    threadId: 'thread-canary',
    actor: ALICE,
    lamport: 1,
    at: 1,
    payload: {
      color: 'blue',
      anchor: { path: CANARY.file, trail: ['main', 'section', 'h1'] },
      provenance: { branch: CANARY.branch, commit: 'deadbeefdeadbeefdeadbeef' },
    },
  });
  const message = makeEvent({
    type: 'message.created',
    threadId: 'thread-canary',
    actor: ALICE,
    lamport: 2,
    at: 2,
    payload: { messageId: 'msg-1', body: CANARY.body },
  });
  const pushed = await aliceT.pushEvents([thread, message]);
  check('a real review pushes', pushed.ok && pushed.accepted.length === 2, JSON.stringify(pushed.rejected));

  const pulled = await bobT.pullEvents({ after: null });
  check('the other client receives it', pulled.ok && pulled.events.length === 2, `${pulled.events?.length} / unverified ${pulled.unverified}`);
  check('and can read what it said', pulled.events.some((e) => e.payload?.body === CANARY.body));
  check('and nothing failed verification', pulled.unverified === 0);

  // THE PROOF. Every byte of the database, searched for what a person wrote.
  const raw = fs.readFileSync(dbFile);
  const walFile = `${dbFile}-wal`;
  const bytes = Buffer.concat([raw, fs.existsSync(walFile) ? fs.readFileSync(walFile) : Buffer.alloc(0)]).toString('latin1');
  for (const [what, value] of Object.entries(CANARY)) {
    check(`the relay database holds no plaintext ${what}`, !bytes.includes(value));
  }
  for (const [what, value] of [
    ['the room secret', made.room.secret],
    ['a private signing key', made.room.privateKey],
    ['an actor id', ALICE.id],
    ['an event id', message.id],
    ['a thread id', 'thread-canary'],
    ['an event type', 'message.created'],
  ]) {
    check(`the relay database holds no ${what}`, !bytes.includes(value));
  }
  check('the relay database does hold ciphertext', relay.store.db.prepare('SELECT COUNT(*) AS n FROM envelopes').get().n === 2);

  // Credentials are stored hashed, never in the clear.
  const memberRows = relay.store.db.prepare('SELECT * FROM members WHERE room_id = ?').all(roomId);
  check('a member row stores a token hash', memberRows.every((m) => /^[0-9a-f]{64}$/.test(m.token_hash)));
  check('no member row holds a usable token', !bytes.includes(aliceRooms.get(roomId).token));
  check('no invite row holds a usable invitation', relay.store.db.prepare('SELECT * FROM invites').all().every((i) => /^[0-9a-f]{64}$/.test(i.token_hash)));

  // --- the log --------------------------------------------------------------

  const logText = logged.join('\n');
  check('the log said something', logged.length > 0);
  for (const [what, value] of [
    ['a member token', aliceRooms.get(roomId).token],
    ['a room secret', made.room.secret],
    ['a capability', invite.capability],
    ['a room id', roomId],
    ['a sender id', made.room.senderId],
    ['comment text', CANARY.body],
    ['a ciphertext', 'ciphertext'],
  ]) {
    check(`the log never contains ${what}`, !logText.includes(value), logText.slice(0, 200));
  }
  check('the log is coarse operational codes', logged.every((line) => /^[a-z_]+$/.test(line)), logged.join(','));

  // --- the doorbell ---------------------------------------------------------

  const socket = new WebSocket(`ws://127.0.0.1:${relay.address.port}/v2/rooms/${roomId}/watch`, [
    WS_SUBPROTOCOL,
    bobRooms.get(roomId).token,
  ]);
  const heads = [];
  socket.addEventListener('message', (e) => {
    try {
      heads.push(JSON.parse(e.data));
    } catch {
      /* nothing else is sent */
    }
  });
  const opened = await new Promise((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    socket.addEventListener('error', () => resolve(false));
    setTimeout(() => resolve(false), 4000);
  });
  check('a member can open the wake socket', opened);
  await wait(200);
  check('the socket says the head straight away', heads.length === 1 && heads[0].type === 'head', JSON.stringify(heads));
  const headBefore = heads[heads.length - 1]?.cursor;

  const later = makeEvent({ type: 'message.created', threadId: 'thread-canary', actor: BOB, lamport: 3, at: 3, payload: { messageId: 'msg-2', body: 'a reply' } });
  await bobT.pushEvents([later]);
  await wait(400);
  check('a push wakes the socket', heads.length >= 2, JSON.stringify(heads));
  check('the wake carries a higher cursor', heads[heads.length - 1]?.cursor > headBefore);
  check('the wake carries no review data', heads.every((h) => Object.keys(h).sort().join(',') === 'cursor,type'));

  // Correctness never depends on it: the same event arrives over plain HTTP.
  const aliceGot = await aliceT.pullEvents({ after: null });
  check('the same event arrives over ordinary HTTP', aliceGot.events.some((e) => e.payload?.body === 'a reply'));

  const refused = new WebSocket(`ws://127.0.0.1:${relay.address.port}/v2/rooms/${roomId}/watch`, [WS_SUBPROTOCOL, 'not-a-token']);
  const rejected = await new Promise((resolve) => {
    refused.addEventListener('open', () => resolve(false));
    refused.addEventListener('error', () => resolve(true));
    refused.addEventListener('close', () => resolve(true));
    setTimeout(() => resolve(false), 4000);
  });
  check('the wake socket refuses a wrong credential', rejected);
  socket.close();
  await wait(150);
  check('a closed socket is let go of', relay.watcherCount === 0, `${relay.watcherCount}`);

  // --- caps -----------------------------------------------------------------

  // Rate limiting would answer long before the member cap does, and the cap is
  // what this is about. Raised here rather than removed, so the limiter is
  // still in the path.
  const capRelay = createSecureRelay({
    port: 0,
    host: '127.0.0.1',
    onError: () => {},
    rateLimits: { rooms: 10_000, join: 10_000 },
  });
  await capRelay.start();
  const capBase = `http://127.0.0.1:${capRelay.address.port}`;
  const capCall = async (pathname, options = {}) => {
    const response = await fetch(`${capBase}${pathname}`, {
      method: options.method || 'GET',
      headers: { accept: 'application/json', ...(options.body != null ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      ...(options.body != null ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const owner = await newMember();
  const capRoom = toBase64Url(randomBytes(16));
  const ownerToken = (await capCall('/v2/rooms', { method: 'POST', body: { roomId: capRoom, senderId: owner.senderId, publicKey: owner.publicKey } })).body.credential.token;
  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  let lastJoin = 200;
  for (let i = 1; i < MAX_MEMBERS + 2 && lastJoin === 200; i++) {
    const invitation = await capCall(`/v2/rooms/${capRoom}/invites`, { method: 'POST', body: {}, headers: bearer(ownerToken) });
    if (invitation.status !== 200) break;
    const joiner = await newMember();
    lastJoin = (await capCall('/v2/join', { method: 'POST', body: { roomId: capRoom, invite: invitation.body.invite, senderId: joiner.senderId, publicKey: joiner.publicKey } })).status;
  }
  check('a room stops taking members at its cap', lastJoin === 413, `${lastJoin}`);
  check('the room is at its member cap', capRelay.store.membersOf(capRoom).filter((m) => !m.leftAt).length === MAX_MEMBERS);

  // Open invitations are bounded too.
  const invRoom = toBase64Url(randomBytes(16));
  const invOwner = await newMember();
  const invToken = (await capCall('/v2/rooms', { method: 'POST', body: { roomId: invRoom, senderId: invOwner.senderId, publicKey: invOwner.publicKey } })).body.credential.token;
  let lastInvite = 200;
  for (let i = 0; i < 25 && lastInvite === 200; i++) {
    lastInvite = (await capCall(`/v2/rooms/${invRoom}/invites`, { method: 'POST', body: {}, headers: bearer(invToken) })).status;
  }
  check('open invitations are capped', lastInvite === 413, `${lastInvite}`);

  await capRelay.stop();

  // --- a full room still takes a retry --------------------------------------
  //
  // The real cap is two hundred thousand envelopes, which no test can drive, so
  // this relay is given a cap of three. The property is the one that matters
  // near any cap: an envelope already held costs nothing, so a retry must not
  // be the thing that tips a room over.
  const tightRelay = createSecureRelay({
    port: 0,
    host: '127.0.0.1',
    onError: () => {},
    limits: { maxEnvelopes: 3 },
    rateLimits: { rooms: 1000, join: 1000 },
  });
  await tightRelay.start();
  const tightBase = `http://127.0.0.1:${tightRelay.address.port}`;
  const tightCall = async (pathname, options = {}) => {
    const response = await fetch(`${tightBase}${pathname}`, {
      method: options.method || 'GET',
      headers: { accept: 'application/json', ...(options.body != null ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      ...(options.body != null ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const tightOwner = await newMember();
  const tightRoom = toBase64Url(randomBytes(16));
  const tightToken = (await tightCall('/v2/rooms', { method: 'POST', body: { roomId: tightRoom, senderId: tightOwner.senderId, publicKey: tightOwner.publicKey } })).body.credential.token;
  const tightAuth = { authorization: `Bearer ${tightToken}` };

  const three = await Promise.all([0, 1, 2].map(() => envelopeFrom(tightOwner, tightRoom)));
  const filled = await tightCall(`/v2/rooms/${tightRoom}/envelopes`, { method: 'POST', body: { envelopes: three }, headers: tightAuth });
  check('a room fills to its cap', filled.status === 200 && filled.body.accepted.length === 3, JSON.stringify(filled.body).slice(0, 120));
  const atCap = await tightCall(`/v2/rooms/${tightRoom}`, { headers: tightAuth });
  check('and is at it', atCap.body.room.envelopeCount === 3, `${atCap.body.room.envelopeCount}`);

  const retryAtCap = await tightCall(`/v2/rooms/${tightRoom}/envelopes`, { method: 'POST', body: { envelopes: [three[0]] }, headers: tightAuth });
  check('a retry of something already held is still accepted at the cap', retryAtCap.status === 200 && retryAtCap.body.accepted?.length === 1, JSON.stringify(retryAtCap.body).slice(0, 140));
  const afterRetryAtCap = await tightCall(`/v2/rooms/${tightRoom}`, { headers: tightAuth });
  check('and costs the room nothing', afterRetryAtCap.body.room.envelopeCount === 3, `${afterRetryAtCap.body.room.envelopeCount}`);
  check('nor any bytes', afterRetryAtCap.body.room.storedBytes === atCap.body.room.storedBytes);

  const oneMore = await envelopeFrom(tightOwner, tightRoom);
  const overflow = await tightCall(`/v2/rooms/${tightRoom}/envelopes`, { method: 'POST', body: { envelopes: [oneMore] }, headers: tightAuth });
  check('but a genuinely new envelope past the cap is refused', overflow.status === 413 && overflow.body.error === 'room_full', JSON.stringify(overflow.body));
  const afterOverflow = await tightCall(`/v2/rooms/${tightRoom}`, { headers: tightAuth });
  check('and the room is unchanged by the attempt', afterOverflow.body.room.envelopeCount === 3);
  await tightRelay.stop();

  // --- retention ------------------------------------------------------------

  const sweepStore = openStore({ file: ':memory:', now: () => clock });
  const sweepMember = await newMember();
  const sweepRoom = toBase64Url(randomBytes(16));
  sweepStore.createRoom({ roomId: sweepRoom, senderId: sweepMember.senderId, publicKey: sweepMember.publicKey });
  check('a fresh room is not swept', sweepStore.sweepIdle({ ttlMs: IDLE_ROOM_TTL_MS }) === 0);
  check('the room survived', !!sweepStore.roomFor(sweepRoom));
  clock += IDLE_ROOM_TTL_MS + 1000;
  check('an abandoned room is swept', sweepStore.sweepIdle({ ttlMs: IDLE_ROOM_TTL_MS }) === 1);
  check('a swept room is gone', !sweepStore.roomFor(sweepRoom));
  sweepStore.close();

  // --- small pieces ---------------------------------------------------------

  check('a bearer header is read', bearerOf('Bearer abc-123') === 'abc-123');
  check('a bearer header of the wrong shape is not', bearerOf('Basic abc') === null && bearerOf(null) === null);
  check('a bearer header with a space in the token is not', bearerOf('Bearer a b') === null);
  check('a token hash is a sha256', /^[0-9a-f]{64}$/.test(hash('anything')));

  let ticks = 0;
  const limiter = createLimiter({ now: () => ticks });
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (limiter.allow('rooms', '1.2.3.4')) allowed += 1;
  check('room creation is rate limited', allowed === 20, `${allowed}`);
  check('another source is unaffected', limiter.allow('rooms', '5.6.7.8'));
  ticks += 61_000;
  check('the window reopens', limiter.allow('rooms', '1.2.3.4'));

  await relay.stop();
}

main()
  .then(() => {
    for (const dir of temp) releaseTempDir(dir);
    if (failures.length) {
      console.error(`\nsecure-relay: ${failures.length} failed, ${checked - failures.length} passed\n`);
      console.error(failures.join('\n') + '\n');
      process.exit(1);
    }
    console.log(`secure-relay: ${checked} checks passed`);
  })
  .catch((err) => {
    for (const dir of temp) releaseTempDir(dir);
    console.error('secure-relay: threw\n', err);
    process.exit(1);
  });
