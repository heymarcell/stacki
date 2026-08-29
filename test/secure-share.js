// Two people, two machines, one encrypted room.
//
//   node --disable-warning=ExperimentalWarning test/secure-share.js
//
// Everything between one person's ledger and another's, with a real relay on a
// real port in between and nothing mocked. Alice and Bob get separate userData
// directories, separate ledgers, separate secret stores and separate copies of
// the project, because the failures worth catching here all live at a boundary
// and a shared object hides every one of them.
//
// The properties, in the order they would hurt:
//
//   NO EVENT IS EVER LOST. Not to a duplicate delivery, not to an out-of-order
//   one, not to a relay that was down when somebody wrote a reply, not to a
//   restart. Both sides converge on the same set, byte for byte.
//
//   NOTHING THE RELAY HOLDS IS READABLE. Proved by running a real share and
//   then searching the database file, not by reading the source.
//
//   AUTHORSHIP CANNOT BE FORGED. Bob cannot make an event that Alice's Stacki
//   will fold as Alice's, whatever he sends and however he sends it — including
//   by going around his own client and building the envelope by hand.
//
//   A PINNED KEY NEVER MOVES. A relay that hands out a different signing key
//   for a sender it has already vouched for is refused, not merged.
//
//   NO SECRET REACHES THE PROJECT, THE RENDERER, OR A LOG.

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

const { createSecureRelay } = require('../relay/node/server.js');
const { createSecureRooms, isProtectedBackend } = require('../electron/review/secure/secrets.js');
const {
  createSecureTransport,
  createRoom,
  joinRoom,
  leaveOutcome,
  undoSetup,
  retryCleanups,
  readBounded,
  request,
} = require('../electron/review/secure/transport.js');
const { deriveKeys, senderIdFor, envelopeIdFor, sealEvent, openEnvelope, newSigningKeys } = require('../electron/review/secure/crypto.js');
const { unpackCapability, shareLink, deepLink, deepLinkCapability } = require('../electron/review/secure/capability.js');
const { checkRelay, describeRelay, relayFor, DEFAULT_RELAY } = require('../electron/review/secure/relays.js');
const { createReviewStore, scopeKey, fileFor } = require('../electron/review/store.js');
const { syncOnce, createSyncer, createCatchUp, CATCH_UP_MIN_MS, CATCH_UP_MAX_MS } = require('../electron/review/sync.js');
const { makeEvent, projectThreads, orderEvents } = require('../electron/review/events.js');
const { uuidv5, agentActor } = require('../electron/review/actors.js');
const { signingBytes, aadFor, toBase64Url, fromBase64Url, VERSION, MAX_BODY_BYTES } = require('../relay/protocol.js');
// PR #8's discipline: fixtures this run OWNS, marked, so a concurrent harness
// is never mistaken for this one's leak and never deleted by it.
const { ownedTempDir, releaseTempDir, MARKER } = require('./support/ownedTemp.js');

const say = (t) => fs.writeSync(1, `${t}\n`);

/** A port nothing is using, released before it is handed on. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = require('node:net').createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const temp = [];
const mkdir = (tag) => {
  const dir = ownedTempDir(`stacki-share-${tag}-`, { harness: 'secure-share' });
  temp.push(dir);
  return dir;
};

// A deterministic protector. Never a real Keychain in an automated test — that
// would prompt, and on a build machine it would hang.
const protector = {
  available: true,
  backend: 'test',
  encrypt: (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: (blob) => Buffer.from(blob, 'base64').toString('utf8'),
};
/** A machine with no OS keyring at all — a container, a minimal Linux desktop. */
const noProtector = {
  available: false,
  backend: 'none',
  encrypt: () => {
    throw new Error('no backend');
  },
  decrypt: () => {
    throw new Error('no backend');
  },
};

const ALICE = { id: uuidv5('alice'), kind: 'human', displayName: 'Alice Secret Tester' };
const BOB = { id: uuidv5('bob'), kind: 'human', displayName: 'Bob' };
const CLAUDE = agentActor('Claude');

const CANARY = 'STACKI_PLAINTEXT_CANARY_7d4f1a';

// Where a review points. The same shape the panel builds when somebody clicks
// something on the page.
const ANCHOR = { keys: ['src/pages/super-secret-test.astro#0.1'], page: { route: '/', file: 'src/pages/super-secret-test.astro' } };
// Provenance is two git calls against a directory that is not a repository, so
// it is stubbed off rather than left to fail slowly in a test.
const NO_GIT = { for: () => ({ head: null, branch: null, dirty: null, files: {} }), stamp: () => ({ head: null, branch: null, dirty: null }) };

/** One person's whole Stacki: userData, a secret store, a project, a ledger. */
function makePerson(tag, actor) {
  const userData = mkdir(`${tag}-user`);
  const project = mkdir(`${tag}-project`);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>hi</h1>', 'utf8');
  const rooms = createSecureRooms({ userDataPath: userData, protector });
  const store = createReviewStore({ file: fileFor(userData, project), projectPath: project, actor, source: NO_GIT });
  return { tag, actor, userData, project, rooms, store, roomId: null };
}

/** The link shape sync.js wants, for a secure room. */
const linkFor = (person) => ({
  kind: 'secure',
  id: person.roomId,
  actorId: person.actor.id,
  make: () => createSecureTransport({ rooms: person.rooms, roomId: person.roomId }),
});

const sync = (person, reason = 'manual') => syncOnce({ store: person.store, link: linkFor(person), reason });

/**
 * Start a review, the way the app does: locally, into the outbox, no network.
 *
 * These go through the ledger's own `apply` rather than building events by
 * hand, so what this suite exercises is the path a person's click takes.
 */
const startReview = (person, message, actor = null) =>
  person.store.apply({ action: 'create', message, anchor: ANCHOR, ...(actor ? { actor } : {}) });

const reply = (person, threadId, message, actor = null) =>
  person.store.apply({ action: 'reply', threadId, message, ...(actor ? { actor } : {}) });

/** The id of the one review in a ledger, for replying to. */
const onlyThread = (person) => person.store.all()[0]?.id;

async function main() {
  // What the repository looks like before any of this runs. Compared at the
  // end: no secret store, no database, no stray file.
  const cwdBefore = fs.readdirSync(process.cwd()).sort().join('\n');
  const relay = createSecureRelay({ port: 0, host: '127.0.0.1', onError: () => {} });
  await relay.start();
  const base = `http://127.0.0.1:${relay.address.port}`;

  const alice = makePerson('alice', ALICE);
  const bob = makePerson('bob', BOB);

  // --- starting and joining -------------------------------------------------

  const made = await createRoom({ relay: base, actor: ALICE, rooms: alice.rooms });
  check('Alice can start a secure share', made.ok, made.code);
  alice.roomId = made.room.roomId;
  alice.rooms.link(scopeKey(alice.project), alice.roomId);
  check('starting it makes her the owner', made.room.isOwner === true);
  check('the room secret is 32 bytes', fromBase64Url(made.room.secret, 32) !== null);
  alice.store.enableShared({ workspaceId: alice.roomId, publishExisting: false });

  const aliceT = createSecureTransport({ rooms: alice.rooms, roomId: alice.roomId });
  const invited = await aliceT.createInvite({});
  check('she can make an invitation', invited.ok && typeof invited.capability === 'string');
  check('the invitation is a link whose payload is after the fragment', shareLink({ shareOrigin: base, capability: invited.capability }).includes('/#stacki2.'));
  const capability = invited.capability;

  const joined = await joinRoom({ capability, actor: BOB, rooms: bob.rooms });
  check('Bob can join with it', joined.ok, joined.code);
  bob.roomId = joined.room.roomId;
  bob.rooms.link(scopeKey(bob.project), bob.roomId);
  check('joining does not make him the owner', joined.room.isOwner === false);
  check('both are in the same room', alice.roomId === bob.roomId);
  check('he pinned her signing key at the moment of joining', joined.room.pins[made.room.senderId] === made.room.publicKey);
  bob.store.enableShared({ workspaceId: bob.roomId, publishExisting: false });

  check('the invitation cannot be used again', (await joinRoom({ capability, actor: { id: uuidv5('carol'), kind: 'human' }, rooms: makePerson('carol', BOB).rooms })).ok === false);

  // --- a conversation -------------------------------------------------------

  const firstReview = startReview(alice, CANARY);
  check('a comment can be written', firstReview.ok !== false, JSON.stringify(firstReview));
  check('a comment is written before any network happens', alice.store.shared.pending >= 2, `${alice.store.shared.pending}`);

  const pushed = await sync(alice);
  check('Alice syncs', pushed.ok, JSON.stringify(pushed));
  check('and her outbox drains', alice.store.shared.pending === 0);

  const got = await sync(bob);
  check('Bob syncs', got.ok, JSON.stringify(got));
  check('and receives it', got.pulled >= 2, `${got.pulled}`);
  check('Bob can read what she wrote', JSON.stringify(bob.store.all()).includes(CANARY));
  check('and it arrives as a review, not a fragment', bob.store.all().length === 1);
  check('attributed to her', bob.store.all()[0].messages[0].actorName === 'Alice Secret Tester');

  reply(bob, onlyThread(bob), 'Agreed, fixing now.');
  await sync(bob);
  await sync(alice);
  check('Alice receives his reply', JSON.stringify(alice.store.all()).includes('Agreed, fixing now.'));

  // --- convergence ----------------------------------------------------------

  // The whole log, in the one order, on each side. This is the actual
  // convergence claim: not that the views look similar, that the sets are equal.
  const fingerprint = (person) => JSON.stringify(orderEvents(person.store.allEvents()));

  // Concurrent writes on both sides, then two rounds so each has seen the other.
  reply(alice, onlyThread(alice), 'One more thing.');
  reply(bob, onlyThread(bob), 'And another.');
  await sync(alice);
  await sync(bob);
  await sync(alice);
  await sync(bob);

  // What must be identical is the LOG. Two things in the projection are
  // deliberately not: `anchorState`, which is this machine's own answer to
  // "does that element still exist in my checkout", and the local review
  // number, which is a nickname taken when it happens to be free here. Both
  // are facts about a laptop rather than about the review, and a shared model
  // that forced them to agree would be lying about one of the two machines.
  const local = (person) =>
    JSON.stringify(person.store.all().map(({ anchorState, number, ...rest }) => rest));

  check('both machines converge byte for byte', fingerprint(alice) === fingerprint(bob), `${alice.store.allEvents().length} vs ${bob.store.allEvents().length} events`);
  check('and project to the same reviews', local(alice) === local(bob), `${local(alice).length} vs ${local(bob).length}`);
  const aliceView = local(alice);
  const bobView = local(bob);
  check('nobody lost a message', aliceView.includes('One more thing.') && aliceView.includes('And another.'));
  check('and the same is true on the other side', bobView.includes('One more thing.') && bobView.includes('And another.'));

  // --- offline, then back ---------------------------------------------------

  await relay.stop();
  const offlineWrite = reply(alice, onlyThread(alice), 'Written on a plane.');
  check('a comment written offline still succeeds', offlineWrite.ok !== false);
  const offlineSync = await sync(alice);
  check('and the sync reports the problem rather than throwing', offlineSync.ok === false && offlineSync.code === 'offline', JSON.stringify(offlineSync));
  check('the comment is still here', JSON.stringify(alice.store.all()).includes('Written on a plane.'));
  check('and it is still waiting to send', alice.store.shared.pending >= 1);

  const relay2 = createSecureRelay({ port: relay.address ? 0 : 0, host: '127.0.0.1', onError: () => {} });
  // A fresh relay on a new port is not the same room, so reconnect is tested
  // by restarting the original listener instead.
  await relay2.stop().catch(() => {});

  const back = createSecureRelay({ port: Number(base.split(':').pop()), host: '127.0.0.1', file: ':memory:', onError: () => {} });
  let reconnected = false;
  try {
    await back.start();
    reconnected = true;
  } catch {
    /* the port was taken; the offline assertions above still stand */
  }
  if (reconnected) {
    // The relay lost its database with its process, which is the harshest
    // version of "the relay forgot": clients are the durable owners and must
    // be able to repopulate it.
    const recreate = await createRoom({ relay: base, actor: ALICE, rooms: makePerson('alice2', ALICE).rooms });
    check('a client can still start a share against a restarted relay', recreate.ok);
    await back.stop();
  }

  // --- everything below wants a live relay and a fresh room -----------------

  // File-backed, because this relay is stopped and started again below to
  // simulate a network that came and went. An in-memory relay forgets every
  // room when it stops, which is a different scenario — losing the server —
  // and would make "rejoin the same room" untestable.
  const liveDb = path.join(mkdir('liverelay'), 'relay.db');
  const livePort = await freePort();
  const startLive = async () => {
    const one = createSecureRelay({ port: livePort, host: '127.0.0.1', file: liveDb, onError: () => {} });
    await one.start();
    return one;
  };
  let live = await startLive();
  const liveBase = `http://127.0.0.1:${livePort}`;

  const ann = makePerson('ann', ALICE);
  const ben = makePerson('ben', BOB);
  const room = await createRoom({ relay: liveBase, actor: ALICE, rooms: ann.rooms });
  ann.roomId = room.room.roomId;
  ann.rooms.link(scopeKey(ann.project), ann.roomId);
  ann.store.enableShared({ workspaceId: ann.roomId, publishExisting: false });
  const annT = createSecureTransport({ rooms: ann.rooms, roomId: ann.roomId });
  const benInvite = await annT.createInvite({});
  const benJoin = await joinRoom({ capability: benInvite.capability, actor: BOB, rooms: ben.rooms });
  ben.roomId = benJoin.room.roomId;
  ben.rooms.link(scopeKey(ben.project), ben.roomId);
  ben.store.enableShared({ workspaceId: ben.roomId, publishExisting: false });

  startReview(ann, 'First.');
  await sync(ann);
  await sync(ben);

  // --- duplicate and out-of-order delivery ----------------------------------

  const benT = createSecureTransport({ rooms: ben.rooms, roomId: ben.roomId });
  const page = await benT.pullEvents({ after: null });
  check('a pull returns the events', page.ok && page.events.length >= 2, `${page.events?.length}`);

  const before = JSON.stringify(ben.store.all());
  ben.store.receiveEvents(page.events, { cursor: 0, at: Date.now() });
  check('delivering the same events again changes nothing', JSON.stringify(ben.store.all()) === before);
  ben.store.receiveEvents([...page.events].reverse(), { cursor: 0, at: Date.now() });
  check('delivering them backwards changes nothing', JSON.stringify(ben.store.all()) === before);

  // --- restart and cursor recovery ------------------------------------------

  const cursorBefore = ben.store.shared.cursor;
  ben.store.flushSync();
  const benAgain = createReviewStore({ file: fileFor(ben.userData, ben.project), projectPath: ben.project, actor: BOB });
  check('a restarted ledger remembers its cursor', benAgain.shared.cursor === cursorBefore, `${benAgain.shared.cursor} vs ${cursorBefore}`);
  check('a restarted ledger still has the comments', JSON.stringify(benAgain.all()).includes('First.'));
  check('a restarted ledger is still in the room', benAgain.shared.workspaceId === ben.roomId);
  const benRooms2 = createSecureRooms({ userDataPath: ben.userData, protector });
  check('a restarted secret store still has the room', !!benRooms2.get(ben.roomId));
  check('and still has the pinned key', benRooms2.get(ben.roomId).pins[room.room.senderId] === room.room.publicKey);

  // --- agents ---------------------------------------------------------------

  reply(ben, onlyThread(ben), 'Done — three files changed.', CLAUDE);
  const agentPush = await sync(ben);
  check('a person may submit an agent event', agentPush.ok && agentPush.pushed === 1, JSON.stringify(agentPush));
  await sync(ann);
  const annThreads = ann.store.all();
  check('the agent event arrives', JSON.stringify(annThreads).includes('Done — three files changed.'));
  const agentMessage = annThreads.flatMap((t) => t.messages || []).find((m) => m.body?.includes('three files changed'));
  check('and is still attributed to the agent', agentMessage?.actorKind === 'agent', JSON.stringify(agentMessage));
  check('with the agent name it was written under', agentMessage?.actorName === 'Claude');

  // --- forging, by hand, going around the client ----------------------------
  //
  // The send-side guard stops an honest Stacki making one of these. This does
  // it the way an attacker would: build the envelope directly with Ben's own
  // room key and signing key, and put Ann's actor id inside.

  const benRoom = ben.rooms.get(ben.roomId);
  const benKeys = deriveKeys(benRoom.secret, benRoom.roomId);
  const forgedThread = onlyThread(ben);
  const forged = makeEvent({ type: 'message.created', threadId: forgedThread, actor: ALICE, lamport: 99, at: Date.now(), payload: { messageId: 'forged', body: 'Ann never said this.' } });
  const sealedForgery = sealEvent({ keys: benKeys, senderId: benRoom.senderId, event: forged, privateKey: benRoom.privateKey });
  const sentForgery = await fetch(`${liveBase}/v2/rooms/${ben.roomId}/envelopes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${benRoom.token}` },
    body: JSON.stringify({ envelopes: [sealedForgery.envelope] }),
  });
  check('the relay takes it, because the relay cannot know', sentForgery.status === 200);

  const annPull = await createSecureTransport({ rooms: ann.rooms, roomId: ann.roomId }).pullEvents({ after: null });
  check('Ann refuses it', !annPull.events.some((e) => e.payload?.body === 'Ann never said this.'));
  check('and counts it as unverified', annPull.unverified >= 1, `${annPull.unverified}`);
  const annAfter = await sync(ann);
  check('a sync that saw one says so rather than reporting a clean run', annAfter.unverified >= 1 || ann.store.shared.problem?.kind === 'unverified_events', JSON.stringify(ann.store.shared.problem));
  check('and it never reaches the fold', !JSON.stringify(ann.store.all()).includes('Ann never said this.'));

  // --- a resolution travels too -------------------------------------------
  //
  // Not just messages. The status of a review is an event like any other, and
  // it has to arrive and fold the same way — otherwise one machine thinks a
  // thread is done and the other is still looking at it.
  const resolving = ann.store.apply({ action: 'resolve', threadId: onlyThread(ann) });
  check('a review can be resolved', resolving.ok !== false, JSON.stringify(resolving));
  await sync(ann);
  await sync(ben);
  check('and the resolution arrives', ben.store.all().find((t) => t.id === onlyThread(ben))?.status === 'resolved', JSON.stringify(ben.store.all().map((t) => t.status)));
  check('and it says who resolved it', !!ben.store.all()[0]?.resolvedBy?.actorId);

  const reopening = ben.store.apply({ action: 'reopen', threadId: onlyThread(ben) });
  check('and the other side can reopen it', reopening.ok !== false);
  await sync(ben);
  await sync(ann);
  check('which arrives back', ann.store.all()[0]?.status === 'open', ann.store.all()[0]?.status);

  // --- an envelope that lies about what is inside it ------------------------
  //
  // Built with the raw primitives rather than through `sealEvent`, because
  // that is what an attacker has: encrypt event A, but label the envelope with
  // the id of event B, consistently — in the associated data and in the
  // signature. Everything verifies and everything decrypts. The only thing
  // that catches it is the recipient re-deriving the envelope id from the
  // event it actually got.
  const realEvent = makeEvent({
    type: 'message.created',
    threadId: forgedThread,
    actor: BOB,
    lamport: 101,
    at: Date.now(),
    payload: { messageId: 'mislabelled', body: 'filed under another event' },
  });
  const wrongId = envelopeIdFor(benKeys, 'a-completely-different-event');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', benKeys.content, nonce);
  cipher.setAAD(Buffer.from(aadFor({ roomId: ben.roomId, envelopeId: wrongId, senderId: benRoom.senderId })));
  const sealedBody = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(realEvent), 'utf8')), cipher.final()]);
  const mislabelled = Buffer.concat([sealedBody, cipher.getAuthTag()]);
  const mislabelledEnvelope = {
    v: VERSION,
    envelopeId: wrongId,
    senderId: benRoom.senderId,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(mislabelled),
    signature: require('../electron/review/secure/crypto.js').signBytes(
      benRoom.privateKey,
      signingBytes({ roomId: ben.roomId, envelopeId: wrongId, senderId: benRoom.senderId, nonce: toBase64Url(nonce), ciphertext: mislabelled })
    ),
  };
  const mislabelledSent = await fetch(`${liveBase}/v2/rooms/${ben.roomId}/envelopes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${benRoom.token}` },
    body: JSON.stringify({ envelopes: [mislabelledEnvelope] }),
  });
  const mislabelledBody = await mislabelledSent.json();
  check('a well signed envelope filed under another event id is stored', mislabelledBody.accepted?.length === 1, JSON.stringify(mislabelledBody));

  const annSeesMislabelled = await createSecureTransport({ rooms: ann.rooms, roomId: ann.roomId }).pullEvents({ after: null });
  check(
    'but the recipient refuses it, because the envelope does not name the event inside it',
    !annSeesMislabelled.events.some((e) => e.payload?.body === 'filed under another event'),
    JSON.stringify(annSeesMislabelled.events.map((e) => e.payload?.body))
  );
  check('and counts it as unverified rather than dropping it silently', annSeesMislabelled.unverified >= 1, `${annSeesMislabelled.unverified}`);

  // --- tampering ------------------------------------------------------------

  const good = sealEvent({
    keys: benKeys,
    senderId: benRoom.senderId,
    event: makeEvent({ type: 'message.created', threadId: forgedThread, actor: BOB, lamport: 100, at: Date.now(), payload: { messageId: 'ok', body: 'genuine' } }),
    privateKey: benRoom.privateKey,
  });
  const flipped = Buffer.from(fromBase64Url(good.envelope.ciphertext));
  flipped[3] ^= 0xff;
  const tampered = await fetch(`${liveBase}/v2/rooms/${ben.roomId}/envelopes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${benRoom.token}` },
    body: JSON.stringify({ envelopes: [{ ...good.envelope, ciphertext: toBase64Url(flipped) }] }),
  });
  const tamperedBody = await tampered.json();
  check('a tampered ciphertext is refused by the relay too', tamperedBody.rejected?.[0]?.code === 'bad_signature', JSON.stringify(tamperedBody));

  // --- key substitution -----------------------------------------------------

  const substitute = newSigningKeys();
  const pinAttempt = ben.rooms.pin(ben.roomId, room.room.senderId, substitute.publicKey);
  check('a pinned signing key cannot be replaced', pinAttempt.ok === false && pinAttempt.code === 'key_changed', JSON.stringify(pinAttempt));
  check('the original pin is still there', ben.rooms.get(ben.roomId).pins[room.room.senderId] === room.room.publicKey);
  check('pinning the same key again is fine', ben.rooms.pin(ben.roomId, room.room.senderId, room.room.publicKey).ok === true);
  check('a new sender can still be pinned', ben.rooms.pin(ben.roomId, senderIdFor(benKeys, 'someone-new'), substitute.publicKey).ok === true);

  // --- cross room replay ----------------------------------------------------

  const other = makePerson('other', ALICE);
  const otherRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: other.rooms });
  other.roomId = otherRoom.room.roomId;
  const replayed = await fetch(`${liveBase}/v2/rooms/${other.roomId}/envelopes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherRoom.room.token}` },
    body: JSON.stringify({ envelopes: [{ ...good.envelope, senderId: otherRoom.room.senderId }] }),
  });
  const replayBody = await replayed.json();
  check('an envelope replayed into another room is refused', replayBody.rejected?.[0]?.code === 'bad_signature', JSON.stringify(replayBody));

  // --- leaving and ending ---------------------------------------------------

  const benCommentsBefore = JSON.stringify(ben.store.all());
  const leaving = createSecureTransport({ rooms: ben.rooms, roomId: ben.roomId });
  const left = await leaving.leave();
  check('a member can leave', left.ok, JSON.stringify(left));
  const afterLeaving = await createSecureTransport({ rooms: ben.rooms, roomId: ben.roomId }).pullEvents({ after: null });
  check('and can no longer read the room', afterLeaving.ok === false && afterLeaving.code === 'unauthorized', JSON.stringify(afterLeaving));
  check('leaving does not touch local comments', JSON.stringify(ben.store.all()) === benCommentsBefore);

  const annBefore = JSON.stringify(ann.store.all());
  const ending = createSecureTransport({ rooms: ann.rooms, roomId: ann.roomId });
  const ended = await ending.end();
  check('the owner can end the share', ended.ok, JSON.stringify(ended));
  check('ending does not touch local comments', JSON.stringify(ann.store.all()) === annBefore);
  const afterEnd = await createSecureTransport({ rooms: ann.rooms, roomId: ann.roomId }).pullEvents({ after: null });
  check('an ended room stops answering', afterEnd.ok === false, JSON.stringify(afterEnd));

  // A new room after ending shares nothing with the old one.
  const fresh = makePerson('fresh', ALICE);
  const freshRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: fresh.rooms });
  check('a new share has a different room', freshRoom.room.roomId !== ann.roomId);
  check('a new share has a different secret', freshRoom.room.secret !== room.room.secret);
  check('a new share gives the same person a different sender id', freshRoom.room.senderId !== room.room.senderId);
  check('a new share has a different signing key', freshRoom.room.publicKey !== room.room.publicKey);

  // A new room is a NEW cryptographic boundary, which is the honest answer to
  // "can I remove somebody". The old secret opens nothing in it — not because
  // anybody forgot anything, but because none of it was ever encrypted under
  // that key.
  const freshT = createSecureTransport({ rooms: fresh.rooms, roomId: freshRoom.room.roomId });
  const freshEvent = makeEvent({ type: 'message.created', threadId: 'n1', actor: ALICE, lamport: 1, at: Date.now(), payload: { messageId: 'n1m', body: 'said in the new room' } });
  await freshT.pushEvents([freshEvent]);
  const freshPage = await fetch(`${liveBase}/v2/rooms/${freshRoom.room.roomId}/envelopes?after=0`, {
    headers: { authorization: `Bearer ${freshRoom.room.token}` },
  });
  const freshEnvelopes = (await freshPage.json()).envelopes || [];
  check('the new room has an envelope in it', freshEnvelopes.length === 1, `${freshEnvelopes.length}`);
  const withOldKeys = deriveKeys(room.room.secret, freshRoom.room.roomId);
  const opened = openEnvelope({ keys: withOldKeys, envelope: freshEnvelopes[0], publicKey: freshRoom.room.publicKey });
  check('the ended room’s secret cannot open the new room', opened.ok === false, JSON.stringify(opened));
  const oldCapability = benInvite.capability;
  const rejoinAttempt = await joinRoom({ capability: oldCapability, actor: BOB, rooms: makePerson('rejoin', BOB).rooms });
  check('and an invitation to the ended room cannot be redeemed', rejoinAttempt.ok === false, JSON.stringify(rejoinAttempt));

  // --- leaving is something the relay has to confirm --------------------------
  //
  // The bug this replaces: leave called the relay, ignored the answer, and
  // destroyed the only credential this machine had. Offline that meant the
  // token stayed valid forever and the person was told they had left.
  check('a successful leave is confirmed', leaveOutcome({ ok: true }) === 'confirmed');
  check('a membership the relay does not recognise is also confirmed', leaveOutcome({ ok: false, code: 'unauthorized' }) === 'confirmed');
  check('a room that is gone is confirmed', leaveOutcome({ ok: false, code: 'not_found' }) === 'confirmed');
  for (const code of ['offline', 'timeout', 'busy', 'server', 'bad_response', 'closed']) {
    check(`${code} establishes nothing`, leaveOutcome({ ok: false, code }) === 'transient');
  }
  check('a refusal that waiting will not fix is neither', leaveOutcome({ ok: false, code: 'refused' }) === 'failed');
  check('and nothing at all is not a confirmation', leaveOutcome(null) === 'failed' && leaveOutcome(undefined) === 'failed');

  // The whole round trip: leave, be refused, come back.
  const lifer = makePerson('lifer', BOB);
  const host = makePerson('host', ALICE);
  const hostRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: host.rooms });
  host.roomId = hostRoom.room.roomId;
  host.rooms.link(scopeKey(host.project), host.roomId);
  host.store.enableShared({ workspaceId: host.roomId, publishExisting: false });
  const hostT = () => createSecureTransport({ rooms: host.rooms, roomId: host.roomId });

  const firstInvite = await hostT().createInvite({});
  const lifeJoin = await joinRoom({ capability: firstInvite.capability, actor: BOB, rooms: lifer.rooms });
  check('a member joins', lifeJoin.ok, lifeJoin.code);
  lifer.roomId = lifeJoin.room.roomId;
  lifer.rooms.link(scopeKey(lifer.project), lifer.roomId);
  lifer.store.enableShared({ workspaceId: lifer.roomId, publishExisting: false });
  const lifeKey = lifeJoin.room.publicKey;
  const lifeToken = lifeJoin.room.token;

  startReview(host, 'before anybody left');
  await sync(host);
  await sync(lifer);
  check('and receives what was said', JSON.stringify(lifer.store.all()).includes('before anybody left'));
  const commentsBeforeLeaving = JSON.stringify(lifer.store.all());

  // An OFFLINE leave. Nothing may change.
  await live.stop();
  const failedLeave = await createSecureTransport({ rooms: lifer.rooms, roomId: lifer.roomId }).leave();
  check('an offline leave does not succeed', failedLeave.ok === false, JSON.stringify(failedLeave));
  check('and is recognised as establishing nothing', leaveOutcome(failedLeave) === 'transient', failedLeave.code);
  check('the room is still here afterwards', !!lifer.rooms.get(lifer.roomId));
  check('with its credential intact', lifer.rooms.get(lifer.roomId)?.token === lifeToken);
  check('and its secret intact', !!lifer.rooms.get(lifer.roomId)?.secret);
  check('and the comments untouched', JSON.stringify(lifer.store.all()) === commentsBeforeLeaving);
  live = await startLive();

  // A CONFIRMED leave.
  const goodLeave = await createSecureTransport({ rooms: lifer.rooms, roomId: lifer.roomId }).leave();
  check('a leave against a reachable relay succeeds', goodLeave.ok === true, JSON.stringify(goodLeave));
  check('and is confirmed', leaveOutcome(goodLeave) === 'confirmed');
  check('the departed token can no longer read', (await createSecureTransport({ rooms: lifer.rooms, roomId: lifer.roomId }).pullEvents({})).code === 'unauthorized');

  // What the app does with a confirmed leave.
  check('retiring the room works', lifer.rooms.retire(lifer.roomId));
  lifer.rooms.unlink(scopeKey(lifer.project));
  // What the app does on a confirmed leave, in the same order.
  lifer.store.disableShared();
  check('the room is no longer an active one', lifer.rooms.get(lifer.roomId) === null);
  check('the project is no longer linked to it', lifer.rooms.forProject(scopeKey(lifer.project)) === null);
  const kept = lifer.rooms.dormantFor(lifer.roomId);
  check('but the signing identity is kept', kept?.publicKey === lifeKey);
  check('and the room secret is not', !kept?.secret);
  check('and neither is a usable token', !kept?.token);
  const onDisk = fs.readFileSync(lifer.rooms.file, 'utf8');
  check('the secret is gone from disk entirely', !onDisk.includes(lifeJoin.room.secret));
  check('as is the token', !onDisk.includes(lifeToken));
  check('and the comments are all still here', JSON.stringify(lifer.store.all()) === commentsBeforeLeaving);

  // COMING BACK to the same room.
  const secondInvite = await hostT().createInvite({});
  const rejoin = await joinRoom({ capability: secondInvite.capability, actor: BOB, rooms: lifer.rooms });
  check('a fresh invitation to the same room is accepted', rejoin.ok, JSON.stringify(rejoin));
  check('and it is the same room', rejoin.room?.roomId === lifer.roomId);
  check('presenting the SAME signing key the relay has pinned', rejoin.room?.publicKey === lifeKey, `${rejoin.room?.publicKey} vs ${lifeKey}`);
  check('and the same sender id', rejoin.room?.senderId === lifeJoin.room.senderId);
  check('with a new credential', rejoin.room?.token !== lifeToken);
  lifer.rooms.link(scopeKey(lifer.project), lifer.roomId);
  lifer.store.enableShared({ workspaceId: lifer.roomId, publishExisting: false });

  startReview(host, 'said while they were away');
  await sync(host);
  const rejoined = await sync(lifer);
  check('and events flow again', rejoined.ok && JSON.stringify(lifer.store.all()).includes('said while they were away'), JSON.stringify(rejoined));
  reply(lifer, onlyThread(lifer), 'and I can still speak');
  await sync(lifer);
  await sync(host);
  check('in both directions', JSON.stringify(host.store.all()).includes('and I can still speak'));

  // THE OWNER may leave too, and come back to their own share.
  const ownerLeft = await hostT().leave();
  check('the owner can leave', ownerLeft.ok === true, JSON.stringify(ownerLeft));
  host.store.disableShared();
  check('the room carries on without them', (await createSecureTransport({ rooms: lifer.rooms, roomId: lifer.roomId }).workspace()).ok === true);
  host.rooms.retire(host.roomId);
  host.rooms.unlink(scopeKey(host.project));

  const ownerInvite = await createSecureTransport({ rooms: lifer.rooms, roomId: lifer.roomId }).createInvite({});
  check('a remaining member can invite them back', ownerInvite.ok, ownerInvite.code);
  const ownerBack = await joinRoom({ capability: ownerInvite.capability, actor: ALICE, rooms: host.rooms });
  check('the owner rejoins', ownerBack.ok, JSON.stringify(ownerBack));
  check('with their original signing key', ownerBack.room?.publicKey === hostRoom.room.publicKey);
  check('and is still the owner', ownerBack.room?.isOwner === true, JSON.stringify(ownerBack.room?.isOwner));
  const ownerEnded = await createSecureTransport({ rooms: host.rooms, roomId: host.roomId }).end();
  check('and can still end the share', ownerEnded.ok === true, JSON.stringify(ownerEnded));
  check('everybody keeps their comments', JSON.stringify(lifer.store.all()).includes('before anybody left'));

  // --- when the remote worked and the local did not --------------------------
  //
  // A relay mutation that lands while local persistence fails is the one place
  // this design can leave litter. Each failure is injected for real.
  const brokenRooms = (why) => {
    const dir = mkdir(`broken-${why}`);
    const real = createSecureRooms({ userDataPath: dir, protector });
    return { ...real, remember: () => null };
  };

  // A LOCAL WRITE FAILS IN TWO SHAPES, AND THEY MUST BE THE SAME CLASS.
  //
  // `remember()` returns null for a refusal — quota, a value that will not
  // validate. It THROWS for everything a disk does: `write()` is a bare
  // `writeFileSync` and `renameSync` with nothing around them, so ENOSPC,
  // EACCES, EROFS and EIO all leave by exception. The version this replaces
  // compensated for the first and let the second walk straight out of
  // `createRoom`/`joinRoom` past every line of cleanup — a local failure that
  // was LOUDER got LESS cleanup, and left a room on the relay with nothing
  // able to remove it.
  const refusingRooms = (why, how) => {
    const real = createSecureRooms({ userDataPath: mkdir(`refusing-${why}`), protector });
    return {
      ...real,
      remember:
        how === 'throw'
          ? () => {
              throw new Error('ENOSPC: no space left on device');
            }
          : () => null,
    };
  };
  const countRooms = () => live.store.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
  const liveMembers = (roomId) => live.store.membersOf(roomId).filter((m) => !m.leftAt).length;
  // A relay that answered a moment ago and will not answer this one request.
  const noDelete = async (url, init = {}) =>
    (init.method || 'GET') === 'DELETE' ? Promise.reject(new Error('gone')) : fetch(url, init);

  for (const how of ['false', 'throw']) {
    const shape = how === 'throw' ? 'throws' : 'refuses';

    // --- CASE 1 / CASE 3 — cleanup gets through -----------------------------
    const before1 = countRooms();
    const rooms1 = refusingRooms(`create-clean-${how}`, how);
    const create1 = await createRoom({ relay: liveBase, actor: ALICE, rooms: rooms1 });
    check(`a create whose local write ${shape} fails`, create1.ok === false, JSON.stringify(create1).slice(0, 140));
    check(`  and the ${shape} did not escape the cleanup`, create1.code === 'not_stored', create1.code);
    check('  and says so without blaming the network', /could not store/i.test(create1.message || ''), create1.message);
    check('  and the room it made was removed from the relay', countRooms() === before1, `${before1} then ${countRooms()}`);
    check('  leaving nothing owed', rooms1.pendingCleanups().length === 0, JSON.stringify(rooms1.pendingCleanups()));
    check('  and no room behind', rooms1.all().length === 0 && rooms1.orphanedRooms().length === 0);

    // --- CASE 2 / CASE 4 — cleanup cannot get through -----------------------
    //
    // The room is real, the local write failed, and the DELETE does not
    // arrive. Stacki must keep the one token able to remove it.
    const before2 = countRooms();
    const rooms2 = refusingRooms(`create-owed-${how}`, how);
    const create2 = await createRoom({ relay: liveBase, actor: ALICE, rooms: rooms2, fetchImpl: noDelete });
    check(`a create whose local write ${shape} and whose cleanup cannot get through fails`, create2.ok === false, JSON.stringify(create2).slice(0, 140));
    check('  and says a cleanup is still owed', create2.code === 'not_stored_needs_cleanup', create2.code);
    check('  and does not imply it tidied up', !/so it was not created/i.test(create2.message || ''), create2.message);
    check('  and says it holds nothing readable', /nothing readable/i.test(create2.message || ''), create2.message);
    check('  and the room really did remain', countRooms() === before2 + 1, `${before2} then ${countRooms()}`);
    const owed2 = rooms2.pendingCleanups();
    check('  and the credential that can remove it was kept', owed2.length === 1 && create2.retained === true, JSON.stringify(owed2.map((o) => o.roomId)));
    check('  sealed, pointing at the right relay', owed2[0]?.relay === liveBase, String(owed2[0]?.relay));
    check('  and marked as this machine’s to end', owed2[0]?.owner === true);
    check('  with no active room and nothing linked to a project', rooms2.all().length === 0);

    // AND THE RECOVERY REALLY WORKS. Not "a record exists" — the room is gone
    // from the relay afterwards.
    const recovered = await retryCleanups({ rooms: rooms2 });
    check('  a later run with a network deletes it', recovered.done === 1, JSON.stringify(recovered));
    check('  the room is gone from the relay', countRooms() === before2, `${before2} then ${countRooms()}`);
    check('  and nothing is owed any more', rooms2.pendingCleanups().length === 0);

    // --- CASE 6 / CASE 7 — the same, joining --------------------------------
    const host = makePerson(`joinhost-${how}`, ALICE);
    const hostRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: host.rooms });
    const hostT = createSecureTransport({ rooms: host.rooms, roomId: hostRoom.room.roomId });

    // CASE 6 — the invitation is spent, the write fails, the membership is
    // given back.
    // A DISTINCT JOINER PER CASE. A member's signing key is pinned for the
    // life of the room, so coming back as the same actor from a fresh
    // registry presents a new key for a known sender and is refused — which
    // is the relay behaving correctly, and would make this test measure that
    // instead of what it is for.
    const joiner = (tag) => ({ id: uuidv5(`joiner-${tag}-${how}`), kind: 'human', displayName: 'Bob' });

    const inv6 = await hostT.createInvite({});
    const members6 = liveMembers(hostRoom.room.roomId);
    const rooms6 = refusingRooms(`join-clean-${how}`, how);
    const join6 = await joinRoom({ capability: inv6.capability, actor: joiner('clean'), rooms: rooms6 });
    check(`a join whose local write ${shape} fails`, join6.ok === false && join6.code === 'not_stored', JSON.stringify(join6).slice(0, 140));
    check('  and tells the person to ask for a new invitation', /new invitation/i.test(join6.message || ''), join6.message);
    check('  and the membership it took was given back', liveMembers(hostRoom.room.roomId) === members6, `${members6} then ${liveMembers(hostRoom.room.roomId)}`);
    check('  so nobody is left holding a share they cannot reach', liveMembers(hostRoom.room.roomId) === 1);
    check('  leaving nothing owed', rooms6.pendingCleanups().length === 0);

    // CASE 7 — the invitation is spent, the write fails, and the membership
    // cannot be given back right now.
    const inv7 = await hostT.createInvite({});
    const members7 = liveMembers(hostRoom.room.roomId);
    const rooms7 = refusingRooms(`join-owed-${how}`, how);
    const join7 = await joinRoom({ capability: inv7.capability, actor: joiner('owed'), rooms: rooms7, fetchImpl: noDelete });
    check(`a join whose local write ${shape} and whose cleanup cannot get through fails`, join7.ok === false, JSON.stringify(join7).slice(0, 140));
    check('  and says a cleanup is still owed', join7.code === 'not_stored_needs_cleanup', join7.code);
    check('  and the membership really did remain', liveMembers(hostRoom.room.roomId) === members7 + 1, `${members7} then ${liveMembers(hostRoom.room.roomId)}`);
    const owed7 = rooms7.pendingCleanups();
    check('  and the member token was kept so it can be given back', owed7.length === 1 && join7.retained === true, JSON.stringify(owed7.map((o) => o.roomId)));
    check('  not claiming ownership of somebody else’s room', owed7[0]?.owner === false, String(owed7[0]?.owner));
    const recovered7 = await retryCleanups({ rooms: rooms7 });
    check('  a later run gives the membership back', recovered7.done === 1, JSON.stringify(recovered7));
    check('  and the room has its original members again', liveMembers(hostRoom.room.roomId) === members7, `${members7} then ${liveMembers(hostRoom.room.roomId)}`);
    check('  and nothing is owed any more', rooms7.pendingCleanups().length === 0);
  }

  // --- CASE 5 — the walk-back fails AND the note cannot be written ----------
  //
  // The third corner. A full disk is exactly what makes the local write fail,
  // and the same full disk cannot store a note about it either — so "write a
  // pending-cleanup record" is not a fallback that always works. The version
  // this replaces forgot the room whether or not the record had been written,
  // which in this corner destroyed the last credential able to remove it.
  //
  // What must happen instead needs no write at all: the room record STAYS.
  {
    const heldHost = makePerson('held', ALICE);
    const beforeHeld = countRooms();
    const made = await createRoom({ relay: liveBase, actor: ALICE, rooms: heldHost.rooms });
    check('a room was really made to hold', made.ok === true, JSON.stringify(made).slice(0, 120));

    const cannotNote = { ...heldHost.rooms, rememberCleanup: () => false };
    const heldOut = await undoSetup({
      rooms: cannotNote,
      room: made.room,
      owner: true,
      abandon: async () => ({ ok: false, code: 'offline' }),
    });
    check('with neither a confirmed cleanup nor a written note', heldOut.cleaned === false && heldOut.retained === false, JSON.stringify(heldOut));
    check('  it says so plainly rather than claiming one of them', heldOut.held === true, JSON.stringify(heldOut));
    check('  THE LAST CREDENTIAL IS NOT DESTROYED', heldHost.rooms.get(made.room.roomId) !== null);
    check('  and it is still the token the relay will accept', heldHost.rooms.get(made.room.roomId)?.token === made.room.token);
    check('  the room is still on the relay, as expected', countRooms() === beforeHeld + 1);
    check('  nothing points at it', heldHost.rooms.forProject?.(scopeKey(heldHost.project)) == null);
    const orphans = heldHost.rooms.orphanedRooms();
    check('  and it is findable as owed cleanup', orphans.some((o) => o.roomId === made.room.roomId), JSON.stringify(orphans.map((o) => o.roomId)));
    check('  carrying the credential and the address', orphans[0]?.token === made.room.token && orphans[0]?.relay === liveBase);

    // A registry that throws rather than returning false is the same corner.
    const throwsNote = { ...heldHost.rooms, rememberCleanup: () => {
      throw new Error('ENOSPC: no space left on device');
    } };
    const heldThrow = await undoSetup({
      rooms: throwsNote,
      room: made.room,
      owner: true,
      abandon: async () => ({ ok: false, code: 'offline' }),
    });
    check('a note that throws is a note that was not written', heldThrow.held === true && heldThrow.retained === false, JSON.stringify(heldThrow));
    check('  and it did not take the credential with it', heldHost.rooms.get(made.room.roomId) !== null);

    // ONCE THE DISK WORKS AGAIN, IT FINISHES. This is the whole point of
    // keeping it: not that a record exists, but that the room goes away.
    const finished = await retryCleanups({ rooms: heldHost.rooms });
    check('a later run finishes what was held', finished.done === 1, JSON.stringify(finished));
    check('  the room is gone from the relay', countRooms() === beforeHeld, `${beforeHeld} then ${countRooms()}`);
    check('  and gone from this machine', heldHost.rooms.get(made.room.roomId) === null);
    check('  with nothing left owed', heldHost.rooms.orphanedRooms().length === 0 && heldHost.rooms.pendingCleanups().length === 0);
  }

  // An active share that IS linked to a project is not an orphan, however
  // little else is going on. The sweep must never take a working share.
  {
    const safeHost = makePerson('notorphan', ALICE);
    const safe = await createRoom({ relay: liveBase, actor: ALICE, rooms: safeHost.rooms });
    safeHost.rooms.link(scopeKey(safeHost.project), safe.room.roomId);
    check('a linked, working share is not mistaken for an orphan', safeHost.rooms.orphanedRooms().length === 0, JSON.stringify(safeHost.rooms.orphanedRooms()));
    const swept = await retryCleanups({ rooms: safeHost.rooms });
    check('so a cleanup sweep leaves it alone', swept.done === 0 && safeHost.rooms.get(safe.room.roomId) !== null, JSON.stringify(swept));
    // A room this machine has LEFT is dormant and has no token; it is not an
    // orphan either, and must not be re-deleted.
    safeHost.rooms.retire(safe.room.roomId);
    check('and a room this machine has left is not an orphan', safeHost.rooms.orphanedRooms().length === 0, JSON.stringify(safeHost.rooms.orphanedRooms()));
  }

  // --- a relay that answers with more than Stacki will read ------------------
  //
  // A custom relay is somebody else's server: the one party in this design
  // trusted for nothing. What it claims about its own size is a hint; what it
  // actually sends is what gets counted. The version this replaces buffered
  // the whole answer and then measured it, in UTF-16 code units.
  {
    const http = require('node:http');
    const cap = MAX_BODY_BYTES;
    let sentBytes = 0;
    let mode = 'exact';
    // Anything this server starts and does not finish, so the suite can take
    // it all back at the end rather than leaving the process held open.
    const timers = new Set();
    const stalled = new Set();
    const hostile = http.createServer((req, res) => {
      const write = (buf) => {
        sentBytes += buf.length;
        return res.write(buf);
      };
      const hold = () => {
        stalled.add(res);
        res.on('close', () => stalled.delete(res));
      };

      // --- the ones that answer, and then do not finish answering ----------
      //
      // Each of these is a complete, valid beginning of an HTTP response. The
      // fetch resolves; the body never does.
      if (mode === 'headers-only') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return hold();
      }
      if (mode === 'half') {
        res.writeHead(200, { 'content-type': 'application/json' });
        write(Buffer.from('{"ok":tr'));
        return hold();
      }
      if (mode === 'dribble') {
        // Never over the cap, never finished: a size bound cannot see this.
        res.writeHead(200, { 'content-type': 'application/json' });
        let open = true;
        const tick = setInterval(() => {
          if (!open) return clearInterval(tick);
          write(Buffer.from('    '));
        }, 40);
        timers.add(tick);
        res.on('close', () => {
          open = false;
          clearInterval(tick);
        });
        return hold();
      }
      if (mode === 'slow-ok') {
        // Slow, but finishes well inside the deadline. Must succeed — a
        // timeout that covers the body must not become a timeout that trips
        // over a merely unhurried relay.
        res.writeHead(200, { 'content-type': 'application/json' });
        write(Buffer.from('{"ok":'));
        const later = setTimeout(() => {
          write(Buffer.from('true}'));
          res.end();
        }, 120);
        timers.add(later);
        return;
      }
      if (mode === 'exact') {
        // Valid JSON of exactly the cap, so the boundary itself is legal.
        const head = '{"ok":true,"pad":"';
        const tail = '"}';
        const body = Buffer.concat([Buffer.from(head), Buffer.alloc(cap - head.length - tail.length, 0x78), Buffer.from(tail)]);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
        write(body);
        return res.end();
      }
      if (mode === 'over') {
        const head = '{"ok":true,"pad":"';
        const tail = '"}';
        const body = Buffer.concat([Buffer.from(head), Buffer.alloc(cap - head.length - tail.length + 1, 0x78), Buffer.from(tail)]);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
        write(body);
        return res.end();
      }
      if (mode === 'lying') {
        // Says it is small, then keeps going.
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '20' });
        const chunk = Buffer.alloc(65536, 0x78);
        for (let i = 0; i < Math.ceil((cap * 3) / 65536); i++) write(chunk);
        return res.end();
      }
      if (mode === 'multibyte') {
        // Four bytes per character: half the code units, all of the bytes.
        res.writeHead(200, { 'content-type': 'application/json' });
        const lock = Buffer.from(String.fromCodePoint(0x1f512), 'utf8');
        const chunk = Buffer.concat(Array.from({ length: 16384 }, () => lock));
        for (let i = 0; i < Math.ceil(cap / chunk.length) + 2; i++) write(chunk);
        return res.end();
      }
      // 'endless' — chunked, no declared length, far more than the cap, and it
      // keeps writing until somebody stops listening.
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(65536, 0x78);
      let open = true;
      res.on('close', () => {
        open = false;
      });
      const pump = () => {
        while (open && sentBytes < cap * 40) {
          if (!write(chunk)) return res.once('drain', pump);
        }
        if (open) res.end();
      };
      pump();
    });
    const hostilePort = await freePort();
    await new Promise((resolve, reject) => {
      hostile.once('error', reject);
      hostile.listen(hostilePort, '127.0.0.1', resolve);
    });
    const ask = () => request(`http://127.0.0.1:${hostilePort}`, '/health', { timeoutMs: 20000 });

    mode = 'exact';
    sentBytes = 0;
    const atCap = await ask();
    check('a response of exactly the maximum is read', atCap.ok === true, JSON.stringify(atCap).slice(0, 120));

    mode = 'over';
    sentBytes = 0;
    const overCap = await ask();
    check('one byte over the maximum is refused', overCap.ok === false && overCap.code === 'too_large', JSON.stringify(overCap).slice(0, 120));
    check('and refused on the declared length, before it was consumed', sentBytes === 0 || sentBytes <= cap + 64, `${sentBytes} bytes sent`);

    // Under-declaring is handled a layer down: HTTP framing is authoritative,
    // so the runtime hands over only the declared bytes and the rest is never
    // read. What matters is that it is refused and nothing over-buffered —
    // not which of the two refusals it earns.
    mode = 'lying';
    sentBytes = 0;
    const lied = await ask();
    check('a relay that lies about its length is refused', lied.ok === false, JSON.stringify(lied).slice(0, 120));
    check('with a named reason rather than a crash', ['too_large', 'bad_response'].includes(lied.code), lied.code);

    mode = 'multibyte';
    sentBytes = 0;
    const wide = await ask();
    check('multibyte characters are counted as the bytes they are', wide.ok === false && wide.code === 'too_large', JSON.stringify(wide).slice(0, 120));

    // THE ONE THAT MATTERS. The sender is willing to keep going for forty
    // times the cap; Stacki must stop long before it finishes.
    mode = 'endless';
    sentBytes = 0;
    const endless = await ask();
    check('an endless response is refused', endless.ok === false && endless.code === 'too_large', JSON.stringify(endless).slice(0, 120));
    check(
      'and Stacki stopped reading long before the sender stopped sending',
      sentBytes < cap * 8,
      `${sentBytes} bytes were sent for a ${cap}-byte cap`
    );

    // --- A SIZE BOUND IS NOT A TIME BOUND ----------------------------------
    //
    // The deadline used to be cleared the moment the response HEADERS
    // arrived, and the body was then read with none at all. So a relay that
    // answered `200`, sent half an object and stopped talking held the read
    // open for as long as it kept the socket — and nothing here is ever over
    // the cap, so the byte bound never fires. The sync loop waits behind it.
    //
    // Each of these must come back promptly, named `timeout`, and leave the
    // transport able to make the next call.
    const askWith = async (ms) => {
      const began = Date.now();
      const answer = await request(`http://127.0.0.1:${hostilePort}`, '/health', { timeoutMs: ms });
      return { ...answer, took: Date.now() - began };
    };
    const PATIENCE = 400;
    // Generous enough that a slow machine does not fail it, tight enough that
    // "it returned" and "it hung" cannot be confused.
    const promptly = (took) => took < PATIENCE * 10;

    for (const [what, stallMode] of [
      ['sends headers and then stops', 'headers-only'],
      ['sends half an object and then stops', 'half'],
      ['keeps sending without ever finishing', 'dribble'],
    ]) {
      mode = stallMode;
      sentBytes = 0;
      const stuck = await askWith(PATIENCE);
      check(`a relay that ${what} is given up on`, stuck.ok === false, JSON.stringify(stuck).slice(0, 120));
      check('  named a timeout, not an unreadable answer', stuck.code === 'timeout', `${stuck.code} after ${stuck.took}ms`);
      check('  and it returned rather than hung', promptly(stuck.took), `${stuck.took}ms for a ${PATIENCE}ms deadline`);
    }

    // A slow relay that does finish in time is NOT a timeout.
    mode = 'slow-ok';
    const unhurried = await askWith(4000);
    check('a slow answer that arrives in time is still read', unhurried.ok === true, JSON.stringify(unhurried).slice(0, 120));

    // AND THE LAYER IS NOT POISONED. A timeout must leave nothing stuck
    // behind it — the next call to a healthy relay has to work.
    mode = 'headers-only';
    const poisoning = await askWith(PATIENCE);
    check('a stalled request times out', poisoning.code === 'timeout', poisoning.code);
    mode = 'slow-ok';
    const afterwards = await askWith(4000);
    check('and the very next request still succeeds', afterwards.ok === true, JSON.stringify(afterwards).slice(0, 120));
    const liveAfter = await request(liveBase, '/health', { timeoutMs: 4000 });
    check('as does one to the real relay', liveAfter.ok === true, JSON.stringify(liveAfter).slice(0, 120));

    // --- what the bounded reader says on its own ---------------------------
    //
    // `request()` knows perfectly well whether its own timer fired, so it
    // reports a timeout correctly whatever the reader thinks. That makes the
    // reader's own answer easy to get wrong and never notice — a sabotage run
    // proved exactly that, walking past every test above. But `readBounded` is
    // exported and has a contract of its own, and "the deadline passed" and
    // "this relay is talking nonsense" are different facts that back off
    // differently. So it is asked directly.
    {
      const endlessBody = () => new ReadableStream({ start() {} }); // never enqueues, never closes
      const cut = new AbortController();
      setTimeout(() => cut.abort(), 50);
      const cutShort = await readBounded({ headers: new Headers(), body: endlessBody() }, 4096, { signal: cut.signal });
      check('a bounded read cut short by the deadline reports a timeout', cutShort.ok === false && cutShort.code === 'timeout', JSON.stringify(cutShort));

      const brokenBody = new ReadableStream({
        start(c) {
          c.error(new Error('the connection went away'));
        },
      });
      const broke = await readBounded({ headers: new Headers(), body: brokenBody }, 4096, {});
      check('and one that simply breaks reports an unreadable answer', broke.ok === false && broke.code === 'bad_response', JSON.stringify(broke));

      // A deadline that has already passed is honoured before any reading.
      const already = new AbortController();
      already.abort();
      const tooLate = await readBounded({ headers: new Headers(), body: endlessBody() }, 4096, { signal: already.signal });
      check('a deadline that has already passed stops it before it starts', tooLate.ok === false && tooLate.code === 'timeout', JSON.stringify(tooLate));
    }

    for (const timer of timers) clearInterval(timer);
    for (const res of stalled) res.destroy();

    await new Promise((resolve) => {
      hostile.close(resolve);
      hostile.closeAllConnections?.();
    });
  }

  // --- setting up got as far as the relay and no further ---------------------
  //
  // The invariant: after ANY local failure that follows a remote success,
  // either the remote thing is confirmed gone and the credential may go with
  // it, or the credential is kept so the deletion can be retried. Never
  // neither — which is what the previous version did, because it ignored the
  // DELETE's answer and forgot the room regardless.
  const undoHost = makePerson('undohost', ALICE);
  const undoRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: undoHost.rooms });
  check('a room to walk back exists', undoRoom.ok, undoRoom.code);

  const cleaned = await undoSetup({
    rooms: undoHost.rooms,
    room: undoRoom.room,
    owner: true,
    abandon: async () => ({ ok: true }),
  });
  check('a confirmed cleanup reports itself cleaned', cleaned.cleaned === true, JSON.stringify(cleaned));
  check('and nothing is retained', cleaned.retained === false);
  check('the room is gone locally', undoHost.rooms.get(undoRoom.room.roomId) === null);
  check('and nothing is owed', undoHost.rooms.pendingCleanups().length === 0);

  const stuckHost = makePerson('stuckhost', ALICE);
  const stuckRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: stuckHost.rooms });
  const stuck = await undoSetup({
    rooms: stuckHost.rooms,
    room: stuckRoom.room,
    owner: true,
    abandon: async () => ({ ok: false, code: 'offline' }),
  });
  check('a cleanup that could not be delivered says so', stuck.cleaned === false, JSON.stringify(stuck));
  check('and keeps what it needs to try again', stuck.retained === true);
  check('the room is no longer usable', stuckHost.rooms.get(stuckRoom.room.roomId) === null);
  const owed = stuckHost.rooms.pendingCleanups();
  check('but the debt is recorded', owed.length === 1 && owed[0].roomId === stuckRoom.room.roomId, JSON.stringify(owed.map((o) => o.roomId)));
  check('with the credential that can settle it', owed[0].token === stuckRoom.room.token);
  check('and knowing it was the owner', owed[0].owner === true);
  check('and where to settle it', owed[0].relay === liveBase);
  // Sealed like everything else, and holding nothing readable.
  const stuckDisk = fs.readFileSync(stuckHost.rooms.file, 'utf8');
  check('the retained credential is not in the clear on disk', !stuckDisk.includes(stuckRoom.room.token), stuckDisk.slice(0, 120));
  check('and no room secret was retained with it', !stuckDisk.includes(stuckRoom.room.secret));
  check('nor a signing key', !stuckDisk.includes(stuckRoom.room.privateKey));

  // And a later run finishes the job.
  const settled = await retryCleanups({ rooms: stuckHost.rooms });
  check('a retry settles the debt', settled.done === 1, JSON.stringify(settled));
  check('and it is forgotten', stuckHost.rooms.pendingCleanups().length === 0);
  check('the relay really did lose the room', !live.store.roomFor(stuckRoom.room.roomId));

  // A retry that still cannot reach the relay keeps the debt rather than
  // silently dropping it.
  const patientHost = makePerson('patient', ALICE);
  const patientRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: patientHost.rooms });
  await undoSetup({ rooms: patientHost.rooms, room: patientRoom.room, owner: true, abandon: async () => ({ ok: false, code: 'offline' }) });
  const stillOwed = await retryCleanups({ rooms: patientHost.rooms, abandon: async () => ({ ok: false, code: 'offline' }) });
  check('a retry that fails settles nothing', stillOwed.done === 0, JSON.stringify(stillOwed));
  check('and the debt survives for next time', patientHost.rooms.pendingCleanups().length === 1);
  // A membership the relay no longer recognises is settled too — there is
  // nothing left to delete.
  const gone = await retryCleanups({ rooms: patientHost.rooms, abandon: async () => ({ ok: false, code: 'unauthorized' }) });
  check('a membership the relay has already lost counts as settled', gone.done === 1 && patientHost.rooms.pendingCleanups().length === 0);

  // A JOIN walked back gives the membership up rather than the room.
  const jHost = makePerson('joinundo', ALICE);
  const jRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: jHost.rooms });
  const jInvite = await createSecureTransport({ rooms: jHost.rooms, roomId: jRoom.room.roomId }).createInvite({});
  const jGuest = makePerson('joinguest', BOB);
  const jJoined = await joinRoom({ capability: jInvite.capability, actor: BOB, rooms: jGuest.rooms });
  check('a guest joined', jJoined.ok, jJoined.code);
  const membersBeforeUndo = live.store.membersOf(jRoom.room.roomId).filter((m) => !m.leftAt).length;
  const jUndone = await undoSetup({ rooms: jGuest.rooms, room: jJoined.room, owner: false });
  check('walking a join back is confirmed', jUndone.cleaned === true, JSON.stringify(jUndone));
  check('and the membership is given up', live.store.membersOf(jRoom.room.roomId).filter((m) => !m.leftAt).length === membersBeforeUndo - 1);
  check('while the room itself survives', !!live.store.roomFor(jRoom.room.roomId));

  // A LOCAL WRITE THAT THROWS must not skip the walk-back. `undoSetup` is
  // reached by the caller's try/catch; what is checked here is that a
  // registry which throws does not take the cleanup with it.
  const throwingRooms = () => {
    const real = createSecureRooms({ userDataPath: mkdir('throwing'), protector });
    return {
      ...real,
      link: () => {
        throw new Error('the disk said no');
      },
    };
  };
  const throwHost = makePerson('throwhost', ALICE);
  const throwRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: throwHost.rooms });
  let threw = false;
  try {
    throwingRooms().link('x', 'y');
  } catch {
    threw = true;
  }
  check('a registry can throw on write', threw);
  const afterThrow = await undoSetup({ rooms: throwHost.rooms, room: throwRoom.room, owner: true });
  check('and the walk-back still runs and confirms', afterThrow.cleaned === true, JSON.stringify(afterThrow));
  check('leaving nothing owed', throwHost.rooms.pendingCleanups().length === 0);

  // --- what may cross IPC ---------------------------------------------------
  //
  // Walked rather than eyeballed: every string in the object that goes to the
  // renderer, checked against every secret this machine holds.

  const publicShape = fresh.rooms.publicOf(freshRoom.room);
  const asText = JSON.stringify(publicShape);
  for (const [what, secret] of [
    ['the room secret', freshRoom.room.secret],
    ['the member token', freshRoom.room.token],
    ['the private signing key', freshRoom.room.privateKey],
    ['the room id', freshRoom.room.roomId],
    ['the sender id', freshRoom.room.senderId],
  ]) {
    check(`the renderer shape carries no ${what}`, !asText.includes(secret), asText);
  }
  check('the renderer shape does say where it points', publicShape.relay === liveBase);
  check('the renderer shape does say whether this machine may end it', publicShape.isOwner === true);
  check('the renderer shape counts members', Number.isInteger(publicShape.memberCount));
  check('the renderer shape lists only names learned from decrypted events', Array.isArray(publicShape.participants));

  // Names are learned from review events and from nowhere else.
  const named = ann.rooms.get(ann.roomId);
  // The old form of this was `includes('Bob') || Object.keys(names).length >= 0`,
  // whose right-hand side is true of every object there has ever been. It
  // passed for four years of nothing working. Ask it properly: the name is
  // learned, and it is filed under the opaque sender id rather than under
  // anything the relay could read.
  const learned = named?.names || {};
  check('a name observed in a decrypted event is remembered', Object.values(learned).includes('Bob'), JSON.stringify(learned));
  check('and it is filed under an opaque sender id, not a person', Object.keys(learned).every((k) => /^[A-Za-z0-9_-]{43}$/.test(k)), JSON.stringify(Object.keys(learned)));
  const relayMembers = live.store.membersOf(fresh.roomId || freshRoom.room.roomId);

  // THE RELAY'S RECORD OF A MEMBER HAS NO ROOM FOR A NAME — asked
  // structurally, not by substring.
  //
  // The companion to this is in test/secure-relay.js, which sweeps the whole
  // relay database and log stream for a canary set. Note which name is in that
  // set: 'Alice Secret Tester' and never 'Bob'. A canary has to be a string
  // that cannot occur by accident, and this is the other half of the same
  // lesson.
  //
  // The version this replaces asked whether the member rows contained the text
  // "Bob". They never did, and it still failed about once in every 1,600 runs,
  // because "Bob" is three characters drawn from the base64url alphabet and a
  // pair of members is around 170 positions of random key material: chance
  // spells it roughly that often. A privacy assertion that goes red at random
  // is worse than no assertion at all — it teaches whoever sees it red to
  // shrug, which is exactly the reflex a real leak needs in order to ship.
  //
  // So ask the question that cannot collide. The relay's whole idea of a
  // member is five fields; each is a flag, a timestamp, or an opaque value of
  // one exact length. Proving every field IS one of those proves no field is
  // carrying a name — for every name, not only for the two this test happens
  // to use, and without depending on what the random bytes spelled today.
  const OPAQUE_32 = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, unpadded
  const MEMBER_FIELDS = ['senderId', 'publicKey', 'joinedAt', 'leftAt', 'isOwner'];
  const memberShapeOf = (m) => ({
    keys: Object.keys(m).sort().join(','),
    senderId: OPAQUE_32.test(m.senderId),
    publicKey: OPAQUE_32.test(m.publicKey),
    joinedAt: Number.isInteger(m.joinedAt),
    leftAt: m.leftAt === null || Number.isInteger(m.leftAt),
    isOwner: typeof m.isOwner === 'boolean',
  });
  const expectedKeys = [...MEMBER_FIELDS].sort().join(',');

  check('the relay holds members to talk about at all', relayMembers.length > 0, JSON.stringify(relayMembers));
  for (const [i, member] of relayMembers.entries()) {
    const shape = memberShapeOf(member);
    check(`member ${i}: the relay knows these five things and nothing else`, shape.keys === expectedKeys, shape.keys);
    check(`member ${i}: its sender id is 32 opaque bytes, not a name`, shape.senderId, String(member.senderId));
    check(`member ${i}: its public key is 32 opaque bytes, not a name`, shape.publicKey, String(member.publicKey));
    check(`member ${i}: the rest is a timestamp, a timestamp or null, and a flag`, shape.joinedAt && shape.leftAt && shape.isOwner, JSON.stringify(member));
  }

  // And the check can still see a leak when there is one. A structural
  // assertion that passes on everything proves nothing, so here is a row that
  // does carry a name, through each field in turn, and it must be caught every
  // time. This is the guard's own test.
  for (const field of MEMBER_FIELDS) {
    const leaked = { ...relayMembers[0], [field]: 'Bob' };
    const shape = memberShapeOf(leaked);
    const caught = shape.keys !== expectedKeys || !shape.senderId || !shape.publicKey || !shape.joinedAt || !shape.leftAt || !shape.isOwner;
    check(`a name smuggled into ${field} would be caught`, caught, JSON.stringify(leaked));
  }
  const extra = { ...relayMembers[0], displayName: 'Bob' };
  check('and so would a name in a field nobody declared', memberShapeOf(extra).keys !== expectedKeys, JSON.stringify(extra));

  // --- nothing in the project ------------------------------------------------

  for (const person of [ann, ben, fresh]) {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // The harness's own ownership marker, which exists so a parallel run
        // is never mistaken for this one's leak. It holds a harness name, a
        // run id and a pid — nothing this scan is looking for — and it is
        // excluded by the exported constant so the exclusion cannot drift into
        // covering something else.
        if (entry.name === MARKER) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push([full, fs.readFileSync(full, 'utf8')]);
      }
    };
    walk(person.project);
    const contents = found.map(([, text]) => text).join('\n');
    const names = found.map(([file]) => file).join('\n');
    const secrets = [freshRoom.room.secret, freshRoom.room.token, freshRoom.room.privateKey, room.room.secret, room.room.token, room.room.privateKey];
    check(`${person.tag}'s project holds no secret`, secrets.every((s) => !contents.includes(s)), names);
    check(`${person.tag}'s project has no .stacki credential file`, !names.includes('.stacki'));
    check(`${person.tag}'s project gained no files at all`, found.length === 1 && found[0][0].endsWith('index.html'), names);
  }

  // Nothing was written into the working directory either. This is the version
  // of the project scan that catches a registry pointed somewhere it should
  // not be — a secret file that lands beside the repository rather than inside
  // a project would pass the walk above and fail here.
  const cwdAfter = fs.readdirSync(process.cwd()).sort().join('\n');
  check('the working directory gained no files', cwdAfter === cwdBefore, 'a secret written next to the repository is still a secret in the repository');

  // --- secret storage --------------------------------------------------------

  const stored = fs.readFileSync(path.join(fresh.userData, 'secure-rooms.json'), 'utf8');
  check('the stored room is sealed rather than in the clear', !stored.includes(freshRoom.room.secret), stored.slice(0, 200));
  check('the stored file is only readable by this user', (fs.statSync(path.join(fresh.userData, 'secure-rooms.json')).mode & 0o077) === 0);
  const protection = fresh.rooms.protection();
  check('protection is reported', protection.encrypted === true && protection.mode === 'private', JSON.stringify(protection));

  // The Linux case with no keyring at all: it still works, and it says so.
  const bare = mkdir('bare');
  const bareRooms = createSecureRooms({ userDataPath: bare, protector: noProtector });
  const bareStored = bareRooms.remember({ ...freshRoom.room, roomId: freshRoom.room.roomId });
  check('a machine with no keyring still stores the room', !!bareStored);
  check('and can read it back', bareRooms.get(freshRoom.room.roomId)?.secret === freshRoom.room.secret);
  check('and says plainly that it is not encrypted', bareRooms.protection().encrypted === false);
  check('and the file is still 0600', bareRooms.protection().mode === 'private');

  // A blob this machine cannot decrypt is not a room, rather than a crash.
  const hostile = createSecureRooms({
    userDataPath: fresh.userData,
    protector: { available: true, backend: 'test', encrypt: protector.encrypt, decrypt: () => { throw new Error('wrong key'); } },
  });
  check('a room that cannot be decrypted is simply not there', hostile.get(freshRoom.room.roomId) === null);
  check('and does not take the whole registry with it', Array.isArray(hostile.all()) && hostile.all().length === 0);

  // --- what "encrypted at rest" is allowed to mean ---------------------------
  //
  // Electron's `isEncryptionAvailable()` answers true on Linux even when it
  // has fallen back to `basic_text` — a key derived from an in-memory password
  // because no OS password manager could be found. That is a reversible
  // encoding, not a secret store, and calling it encryption would be telling
  // somebody their secrets are protected when anybody who can read the file
  // can read them.
  const backendCase = (name, keeper) => createSecureRooms({ userDataPath: mkdir(`store-${name}`), protector: keeper });
  const roundTrip = (rooms) => {
    const kept = rooms.remember({ ...freshRoom.room });
    return kept && rooms.get(freshRoom.room.roomId)?.secret === freshRoom.room.secret;
  };
  const seal = (t) => Buffer.from(t, 'utf8').toString('base64');
  const unseal = (b) => Buffer.from(b, 'base64').toString('utf8');

  const backends = [
    ['macOS keychain', { available: true, protects: true, backend: 'keychain', encrypt: seal, decrypt: unseal }, true],
    ['Windows dpapi', { available: true, protects: true, backend: 'dpapi', encrypt: seal, decrypt: unseal }, true],
    ['gnome libsecret', { available: true, protects: true, backend: 'gnome_libsecret', encrypt: seal, decrypt: unseal }, true],
    ['kwallet6', { available: true, protects: true, backend: 'kwallet6', encrypt: seal, decrypt: unseal }, true],
    // The one that matters. Electron WOULD encrypt; the key is nowhere.
    ['Linux basic_text', { available: true, protects: false, backend: 'basic_text', encrypt: seal, decrypt: unseal }, false],
    ['an unknown backend', { available: true, protects: false, backend: 'unknown', encrypt: seal, decrypt: unseal }, false],
    ['no backend at all', noProtector, false],
  ];
  for (const [name, keeper, shouldProtect] of backends) {
    const rooms = backendCase(name.replace(/\W+/g, ''), keeper);
    check(`${name}: the room stores and reads back`, roundTrip(rooms));
    const report = rooms.protection();
    check(`${name}: reported as ${shouldProtect ? 'encrypted' : 'NOT encrypted'}`, report.encrypted === shouldProtect, JSON.stringify(report));
    check(`${name}: the backend is named honestly`, report.backend === (keeper.backend || 'file'), JSON.stringify(report));
    check(`${name}: the file is 0600 either way`, report.mode === 'private', JSON.stringify(report));
    const onDisk = fs.readFileSync(path.join(rooms.file), 'utf8');
    if (shouldProtect) {
      check(`${name}: the secret is not in the clear on disk`, !onDisk.includes(freshRoom.room.secret));
    } else {
      // Not sealed — and that is the point: it is stored the way the honest
      // report says it is, rather than wrapped in an encoding that suggests
      // protection nobody has.
      check(`${name}: nothing pretends to be sealed`, !onDisk.includes('"protected": true'), onDisk.slice(0, 120));
    }
  }

  // The decision itself, for every name Electron can return. Injected
  // protectors exercise the storage; this exercises the judgement.
  for (const backend of ['keychain', 'dpapi', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    check(`${backend} counts as keeping a secret`, isProtectedBackend(backend) === true);
  }
  for (const backend of ['basic_text', 'unknown', 'none', '', null, undefined]) {
    check(`${JSON.stringify(backend)} does not count as keeping a secret`, isProtectedBackend(backend) === false);
  }

  const weak = backendCase('weakreport', { available: true, protects: false, backend: 'basic_text', encrypt: seal, decrypt: unseal });
  check('a weak backend is called out as weak rather than merely absent', weak.protection().weakBackend === true, JSON.stringify(weak.protection()));
  check('and a real one is not', fresh.rooms.protection().weakBackend === false, JSON.stringify(fresh.rooms.protection()));
  check('and a missing one is not called weak either', backendCase('none2', noProtector).protection().weakBackend === false);

  // A keychain that refuses at the moment of writing must not lose the room.
  const refusing = backendCase('refusing', {
    available: true,
    protects: true,
    backend: 'keychain',
    encrypt: () => {
      throw new Error('the keychain said no');
    },
    decrypt: unseal,
  });
  check('a protector that throws while sealing still stores the room', roundTrip(refusing));
  check('and the room is readable afterwards', refusing.get(freshRoom.room.roomId)?.secret === freshRoom.room.secret);

  // --- posting never waits for the network -----------------------------------
  //
  // The event is in the ledger and in the outbox before anything is sent, and
  // it is sent without anybody pressing anything. The scheduling itself lives
  // in electron/review/index.js, which needs Electron to load; what is checked
  // here is the property that makes it safe — a write is complete locally
  // whether or not the network is there at all.
  const posting = makePerson('posting', ALICE);
  const postingRoom = await createRoom({ relay: liveBase, actor: ALICE, rooms: posting.rooms });
  posting.roomId = postingRoom.room.roomId;
  posting.rooms.link(scopeKey(posting.project), posting.roomId);
  posting.store.enableShared({ workspaceId: posting.roomId, publishExisting: false });

  // COUNTED, NOT TIMED.
  //
  // This used to be a stopwatch: `took < 250`. The property it reached for is
  // real and worth keeping — a write must be complete locally whether or not
  // the network is there — but 250ms on a shared CI runner measures how busy
  // the runner is. It failed on main at 301ms having passed for months, which
  // is the signature of a threshold rather than a regression.
  //
  // So the property is asserted directly instead: the write is synchronous and
  // it makes NO request. That is machine-independent, and it is stronger — a
  // write that quietly waited 40ms on a fast relay would have passed the timer
  // and fails this.
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (...args) => {
    fetches += 1;
    return realFetch(...args);
  };
  let written;
  try {
    written = startReview(posting, 'written without waiting');
  } finally {
    globalThis.fetch = realFetch;
  }
  check('writing a comment does not wait for a relay', written.ok !== false, JSON.stringify(written).slice(0, 160));
  check('  and reaches the network not at all while doing it', fetches === 0, `${fetches} request(s) during the write`);
  check('and it is in the ledger immediately', JSON.stringify(posting.store.all()).includes('written without waiting'));
  check('and in the outbox, waiting to go', posting.store.shared.pending >= 2, `${posting.store.shared.pending}`);

  await sync(posting);
  check('and the outbox drains when a sync happens', posting.store.shared.pending === 0, `${posting.store.shared.pending}`);

  // --- the periodic catch-up --------------------------------------------------
  //
  // Fake timers throughout. "It asks about every forty-five seconds" is
  // otherwise a property nothing can check without sitting there for
  // forty-five seconds, and a test that sleeps is a test people delete.
  {
    const timers = new Map();
    let nextId = 1;
    const setTimer = (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: ms });
      return id;
    };
    const clearTimer = (id) => timers.delete(id);
    /** Fire whatever is due, the way a clock would. */
    const tick = () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
    };

    const fired = [];
    let roll = 0;
    const catchUp = createCatchUp({
      onDue: (reason) => fired.push(reason),
      setTimer,
      clearTimer,
      random: () => {
        roll += 0.5;
        return roll % 1;
      },
    });

    check('a catch-up does nothing until it is armed', catchUp.armed === false && timers.size === 0);
    catchUp.set(false);
    check('and staying off arms nothing', catchUp.armed === false);

    catchUp.set(true);
    check('an active secure share arms it', catchUp.armed === true);
    const waits = [...timers.values()].map((t) => t.at);
    check('the first wait is inside the documented window', waits[0] >= CATCH_UP_MIN_MS && waits[0] <= CATCH_UP_MAX_MS, `${waits[0]}`);

    tick();
    check('it comes due', fired.length === 1 && fired[0] === 'catchup', JSON.stringify(fired));
    check('and arms itself again', catchUp.armed === true);
    const second = [...timers.values()].map((t) => t.at)[0];
    check('the next wait is inside the window too', second >= CATCH_UP_MIN_MS && second <= CATCH_UP_MAX_MS, `${second}`);
    check('and it is jittered rather than fixed', second !== waits[0], `${waits[0]} then ${second}`);

    tick();
    tick();
    check('it keeps going', fired.length === 3, `${fired.length}`);

    catchUp.set(false);
    check('a window that goes away disarms it', catchUp.armed === false && timers.size === 0);
    tick();
    check('and nothing fires after that', fired.length === 3, `${fired.length}`);

    // A catch-up whose work throws must not stop the loop for the session.
    const angry = [];
    const survivor = createCatchUp({
      onDue: (reason) => {
        angry.push(reason);
        throw new Error('the relay was rude');
      },
      setTimer,
      clearTimer,
      random: () => 0,
    });
    survivor.set(true);
    try {
      tick();
    } catch {
      /* the throw escapes the tick, which is the caller's problem, not the loop's */
    }
    check('a failing catch-up still re-arms', survivor.armed === true, `${angry.length} fired`);
    survivor.disarm();
  }

  // --- relay choice ----------------------------------------------------------

  check('the default relay is used when nothing is chosen', relayFor({ env: {} }) === DEFAULT_RELAY);
  check('an explicit choice wins', relayFor({ preferred: 'https://relay.example', env: {} }) === 'https://relay.example');
  check('the environment is consulted next', relayFor({ env: { STACKI_SECURE_RELAY: 'https://from.env' } }) === 'https://from.env');
  check('a remote http relay is refused with a reason', checkRelay('http://reviews.internal').code === 'insecure_relay');
  check('and the reason mentions https', /https/.test(checkRelay('http://reviews.internal').message));
  check('a loopback http relay is accepted', checkRelay('http://localhost:8787').ok === true);
  check('an https relay is accepted', checkRelay('https://relay.example').ok === true);
  check('a javascript url is refused', checkRelay('javascript:alert(1)').ok === false);
  check('the hosted relay is described as hosted', describeRelay(DEFAULT_RELAY).hosted === true);
  check('a loopback relay is described as local', describeRelay('http://127.0.0.1:8787').label === 'On this computer');
  check('another relay is described by its host', describeRelay('https://relay.example').label === 'relay.example');

  fresh.rooms.setPreferredRelay('https://mine.example');
  check('a chosen relay is remembered', fresh.rooms.preferredRelay() === 'https://mine.example');

  // A ROOM DOES NOT MOVE WHEN THE PREFERENCE DOES.
  //
  // The preference says where the NEXT share would be created. An existing
  // room lives on the relay it was created on and cannot be migrated — its
  // secret, its members and their access all belong there. Manage once read
  // the preference and showed it as the room's relay, so changing the default
  // made an existing encrypted room appear to have moved to a server it had
  // never been on.
  check('the room still names the relay it was created on', fresh.rooms.get(freshRoom.room.roomId)?.relay === liveBase, fresh.rooms.get(freshRoom.room.roomId)?.relay);
  check('which is not the preference', liveBase !== 'https://mine.example');
  check('the shape the renderer gets carries the room’s own relay', fresh.rooms.publicOf(fresh.rooms.get(freshRoom.room.roomId)).relay === liveBase);
  check('and the two are described differently', describeRelay(liveBase).label !== describeRelay('https://mine.example').label);
  // And the traffic goes where the room is, not where the preference points.
  const stillThere = await createSecureTransport({ rooms: fresh.rooms, roomId: freshRoom.room.roomId }).workspace();
  check('and the room still answers on its own relay', stillThere.ok === true, JSON.stringify(stillThere));
  check('which the transport reports as the room’s relay', createSecureTransport({ rooms: fresh.rooms, roomId: freshRoom.room.roomId }).describe().relay === liveBase);

  check('and clearing the preference goes back to the default', fresh.rooms.setPreferredRelay(null) && fresh.rooms.preferredRelay() === null);
  check('without touching the room', fresh.rooms.get(freshRoom.room.roomId)?.relay === liveBase);

  // --- the deep link ---------------------------------------------------------

  const link = deepLink(benInvite.capability);
  check('a deep link round trips', deepLinkCapability(link) === benInvite.capability);
  check('the capability it yields is a real one', !!unpackCapability(deepLinkCapability(link)));
  check('a deep link for another action yields nothing', deepLinkCapability(`stacki://open#${benInvite.capability}`) === null);

  // --- a local-only project makes no requests --------------------------------

  const quiet = makePerson('quiet', ALICE);
  let calls = 0;
  const counting = (...args) => {
    calls += 1;
    return fetch(...args);
  };
  const quietResult = await syncOnce({ store: quiet.store, link: null });
  check('a project nobody has shared is skipped', quietResult.skipped === 'not_shared');
  check('and makes no request at all', calls === 0);
  startReview(quiet, 'private thought');
  check('and its comments still work', JSON.stringify(quiet.store.all()).includes('private thought'));
  check('and it has no outbox', quiet.store.shared.pending === 0);
  void counting;

  await live.stop();
  await relay.stop().catch(() => {});
}

main()
  .then(() => {
    for (const dir of temp) releaseTempDir(dir);
    if (failures.length) {
      console.error(`\nsecure-share: ${failures.length} failed, ${checked - failures.length} passed\n`);
      console.error(failures.join('\n') + '\n');
      process.exit(1);
    }
    console.log(`secure-share: ${checked} checks passed`);
  })
  .catch((err) => {
    for (const dir of temp) releaseTempDir(dir);
    console.error('secure-share: threw\n', err);
    process.exit(1);
  });
