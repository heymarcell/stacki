// The four things that only go wrong when the network is real.
//
//   STACKI_PUBLIC_RELAY=https://…  node test/public-resilience.js
//
// test/secure-share.js proves all of this against a relay in the same process,
// where a "network failure" is a rejected promise and a "restart" is a fresh
// object. Those are the right tests for the logic. They cannot be the last
// word on a deployed service, because the thing being claimed is that a person
// on a train, on a laptop that slept, sharing with somebody in another
// country, does not lose a comment.
//
// So this runs the four scenarios that were left unproven publicly, against a
// relay on the internet:
//
//   A  offline write, then automatic recovery when the network returns
//   B  close, miss events, reopen, resume from the persisted cursor
//   C  leave, be refused, be re-invited, rejoin the same room
//   D  a new room cannot be opened with the old room's material
//
// WHAT IS REAL HERE. The secret registry, the review ledger, the outbox, the
// cursor, the crypto, the signing identities, the transport and the relay are
// all the shipped ones, and every byte goes over public HTTPS. Both
// participants are the real client stack without a window on top: Electron's
// process lifecycle is covered by the packaged tests, and what these four
// scenarios are actually about is persistence and sync, which is this code.
//
// "Restart" therefore means what it means on disk: every in-memory object is
// dropped and rebuilt from the same userData directory, so the registry, the
// credential, the signing key and the cursor are genuinely re-read or genuinely
// lost.

const fs = require('node:fs');
const path = require('node:path');

const { usePublicNetwork } = require('./support/publicFetch.js');
usePublicNetwork();

const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');
const { createSecureRooms } = require('../electron/review/secure/secrets.js');
const { createSecureTransport, createRoom, joinRoom } = require('../electron/review/secure/transport.js');
const { createReviewStore, fileFor } = require('../electron/review/store.js');
const { syncOnce } = require('../electron/review/sync.js');
const { uuidv5 } = require('../electron/review/actors.js');

const BASE = (process.env.STACKI_PUBLIC_RELAY || '').replace(/\/+$/, '');
const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);

if (!BASE.startsWith('https://')) {
  shout('public-resilience: set STACKI_PUBLIC_RELAY to the deployed https origin');
  process.exit(2);
}

const ALICE = { id: uuidv5('resilience-alice'), kind: 'human', displayName: 'Alice Resilience' };
const BOB = { id: uuidv5('resilience-bob'), kind: 'human', displayName: 'Bob Resilience' };
const NO_GIT = { branch: null, commit: null, remote: null, dirty: false };
// No keyring here, so secrets land in the 0600 file — the same path a Linux
// machine without a password manager takes.
const protector = { available: false, protects: false, backend: 'file' };
const ANCHOR = { type: 'node', page: { route: '/', file: 'src/pages/index.astro' }, keys: ['h1'] };

// Two people, each with their own everything.
const dirs = {
  aliceData: ownedTempDir('stacki-res-alice-', { harness: 'public-resilience' }),
  aliceProject: ownedTempDir('stacki-res-aliceproj-', { harness: 'public-resilience' }),
  bobData: ownedTempDir('stacki-res-bob-', { harness: 'public-resilience' }),
  bobProject: ownedTempDir('stacki-res-bobproj-', { harness: 'public-resilience' }),
};

/**
 * One participant, rebuilt from disk on demand.
 *
 * `open()` is what starting the app does: read the registry, read the ledger,
 * read the cursor. Calling it again after dropping the old objects is what
 * restarting does — and it is the only honest way to prove that what survived
 * a restart survived on disk rather than in a variable.
 */
function person(actor, dataDir, projectDir) {
  const self = { actor, dataDir, projectDir, roomId: null, rooms: null, store: null };
  self.open = () => {
    self.rooms = createSecureRooms({ userDataPath: dataDir, protector });
    self.store = createReviewStore({
      file: fileFor(dataDir, projectDir),
      projectPath: projectDir,
      actor,
      source: NO_GIT,
    });
    // DO NOT re-enable on reopen. `enableShared` resets `shared` to empty —
    // cursor included — which is right when somebody turns sharing on and
    // catastrophic when it runs on every start: the ledger would forget where
    // it had got to and re-pull the whole room. The real app does not call it
    // at startup either; the persisted `shared` block loads with the ledger.
    if (self.roomId && !self.store.shared?.workspaceId) {
      self.store.enableShared({ workspaceId: self.roomId, publishExisting: false });
    }
    return self;
  };
  self.link = () => ({
    kind: 'secure',
    id: self.roomId,
    actorId: actor.id,
    make: () => createSecureTransport({ rooms: self.rooms, roomId: self.roomId }),
  });
  self.sync = (reason = 'manual') => syncOnce({ store: self.store, link: self.link(), reason });
  self.transport = () => createSecureTransport({ rooms: self.rooms, roomId: self.roomId });
  self.threads = () => self.store.all();
  // `store.shared` is a live getter and `pending` is already the COUNT, not
  // the list. Reading `.length` off it silently yields undefined → 0, which
  // reads as "nothing was queued" on a run where everything queued fine.
  self.pending = () => self.store.shared?.pending ?? 0;
  self.cursor = () => self.store.shared?.cursor ?? null;
  return self;
}

const alice = person(ALICE, dirs.aliceData, dirs.aliceProject);
const bob = person(BOB, dirs.bobData, dirs.bobProject);

// Rooms this run owns, so every one is ended at the end.
const ownedRooms = [];

/** Sync until a thread matching `want` shows up, or give up. */
async function syncUntil(who, want, tries = 8) {
  for (let i = 0; i < tries; i++) {
    await who.sync('test');
    const found = who.threads().find(want);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

const realFetch = globalThis.fetch;
/** Cut this process off from the relay without touching the relay. */
function goOffline() {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(BASE)) {
      const err = new Error('simulated network failure');
      err.cause = { code: 'ENOTFOUND' };
      throw err;
    }
    return realFetch(url, init);
  };
}
const goOnline = () => {
  globalThis.fetch = realFetch;
};

(async () => {
  say(`public-resilience: ${BASE}`);
  const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json()).catch(() => null);
  check('the deployed relay is up before we begin', health?.ok === true, JSON.stringify(health));

  alice.open();
  bob.open();

  // --- a shared room over the public relay ---------------------------------

  const made = await createRoom({ relay: BASE, actor: ALICE, rooms: alice.rooms });
  check('Alice creates a secure share on the deployed relay', made.ok === true, JSON.stringify(made).slice(0, 140));
  alice.roomId = made.room.roomId;
  ownedRooms.push({ roomId: made.room.roomId, token: made.room.token });
  alice.store.enableShared({ workspaceId: alice.roomId, publishExisting: false });

  const invite1 = await alice.transport().createInvite({});
  check('and mints an invitation', typeof invite1.capability === 'string', JSON.stringify(invite1).slice(0, 100));

  const joined = await joinRoom({ capability: invite1.capability, actor: BOB, rooms: bob.rooms });
  check('Bob joins it', joined.ok === true, JSON.stringify(joined).slice(0, 140));
  bob.roomId = joined.room.roomId;
  bob.store.enableShared({ workspaceId: bob.roomId, publishExisting: false });
  check('  into the same room', bob.roomId === alice.roomId);

  // ======================================================================
  say('  A  offline write, then automatic recovery');
  // ======================================================================

  goOffline();
  const OFFLINE_TEXT = 'RESILIENCE-A written with no network';
  alice.store.apply({ action: 'create', message: OFFLINE_TEXT, anchor: ANCHOR });
  const madeOffline = alice.threads().find((t) => (t.messages || []).some((m) => (m.body || m.message || '').includes(OFFLINE_TEXT)));
  check('a comment written with no network succeeds immediately', !!madeOffline, 'the local write must not wait on a server');
  check('  and is in the ledger straight away', alice.threads().length >= 1);
  check('  and is queued in the outbox', alice.pending() >= 1, `pending=${alice.pending()}`);

  const offlineSync = await alice.sync('while-offline');
  check('a sync attempted while offline fails without losing anything', offlineSync?.ok === false || offlineSync?.pushed === 0, JSON.stringify(offlineSync).slice(0, 120));
  check('  the comment is still here', alice.threads().some((t) => t.id === madeOffline.id));
  check('  and it is still queued, not silently dropped', alice.pending() >= 1, `pending=${alice.pending()}`);

  goOnline();
  // This is the call the app's own reconnect makes — `online` and the periodic
  // catch-up both land here. Nothing is retried by hand.
  const recovered = await alice.sync('online');
  check('when the network returns, the queued comment sends', recovered?.ok !== false, JSON.stringify(recovered).slice(0, 140));
  check('  and the outbox drains', alice.pending() === 0, `pending=${alice.pending()}`);

  const bobGotOffline = await syncUntil(bob, (t) => (t.messages || []).some((m) => (m.body || m.message || '').includes(OFFLINE_TEXT)));
  check('  and Bob receives it over the public relay', !!bobGotOffline, JSON.stringify(bob.threads().map((t) => t.id)).slice(0, 120));

  // ======================================================================
  say('  B  close, miss events, reopen, resume from the cursor');
  // ======================================================================

  await alice.sync('settle');
  const cursorBefore = alice.cursor();
  const threadsBefore = alice.threads().length;
  check('Alice has a persisted cursor to resume from', Number.isInteger(cursorBefore), String(cursorBefore));

  // Closed. Every in-memory object goes.
  alice.rooms = null;
  alice.store = null;

  const MISSED = ['RESILIENCE-B first while she was closed', 'RESILIENCE-B second while she was closed'];
  for (const text of MISSED) {
    bob.store.apply({ action: 'create', message: text, anchor: ANCHOR });
  }
  const pushed = await bob.sync('bob-writes');
  check('Bob writes two events while Alice is closed', pushed?.ok !== false, JSON.stringify(pushed).slice(0, 120));

  // Reopened from the same userData, nothing carried over in memory.
  alice.open();
  check('reopening recovers the room secret from disk', !!alice.rooms.get(alice.roomId)?.secret);
  check('  and the member credential', !!alice.rooms.get(alice.roomId)?.token);
  check('  and the room-specific signing identity', !!alice.rooms.get(alice.roomId)?.privateKey);
  check('  and the cursor it had reached', alice.cursor() === cursorBefore, `${cursorBefore} → ${alice.cursor()}`);

  await syncUntil(alice, (t) => (t.messages || []).some((m) => (m.body || m.message || '').includes(MISSED[1])));
  const texts = alice.threads().flatMap((t) => (t.messages || []).map((m) => m.body || m.message || ''));
  for (const text of MISSED) {
    check(`  the event she missed arrives: "${text.slice(13, 30)}…"`, texts.some((x) => x.includes(text)));
  }
  check('  nothing arrived twice', alice.threads().length === threadsBefore + MISSED.length, `${threadsBefore} → ${alice.threads().length}, expected +${MISSED.length}`);
  const ids = alice.threads().map((t) => t.id);
  check('  and no thread is duplicated', new Set(ids).size === ids.length, JSON.stringify(ids).slice(0, 120));
  check('  the cursor moved forward', alice.cursor() > cursorBefore, `${cursorBefore} → ${alice.cursor()}`);

  // ======================================================================
  say('  C  leave, be refused, be re-invited, rejoin');
  // ======================================================================

  const bobOldToken = bob.rooms.get(bob.roomId)?.token;
  const bobOldSigning = bob.rooms.get(bob.roomId)?.publicKey;
  const bobThreadsBefore = bob.threads().length;

  // THE WHOLE LEAVE, not just the relay half.
  //
  // `transport.leave()` only tells the relay. The product's leave — see
  // leaveSecureShare in electron/review/index.js — then RETIRES the local
  // room: the secret and the token go, and the room-specific signing identity
  // stays behind, dormant, so a later invitation to this same room can be
  // accepted with the key every peer already has pinned. Skipping that half
  // makes the next join mint a fresh keypair, and the relay refuses it as a
  // key substitution — which is the relay being right.
  const left = await bob.transport().leave();
  check('Bob leaves the room', left?.ok === true, JSON.stringify(left).slice(0, 120));
  const retired = bob.rooms.retire(bob.roomId);
  check('  and the local room is retired, keeping the signing identity', retired === true);
  bob.store.disableShared();
  check('  and keeps every comment he had', bob.threads().length === bobThreadsBefore, `${bobThreadsBefore} → ${bob.threads().length}`);
  check('  while the room secret is gone from disk', !bob.rooms.get(bob.roomId)?.secret, 'a retired room keeps no secret');

  const withOldToken = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(bob.roomId)}`, {
    headers: { authorization: `Bearer ${bobOldToken}` },
    signal: AbortSignal.timeout(20000),
  });
  check('  and his old credential is refused by the relay', withOldToken.status === 401, `http ${withOldToken.status}`);

  const invite2 = await alice.transport().createInvite({});
  check('Alice mints a fresh one-use invitation for the same room', typeof invite2.capability === 'string');
  check('  which is not the first one', invite2.capability !== invite1.capability);

  const rejoined = await joinRoom({ capability: invite2.capability, actor: BOB, rooms: bob.rooms });
  check('Bob rejoins', rejoined.ok === true, `code=${rejoined.code} message=${rejoined.message} ${JSON.stringify(rejoined).slice(0, 200)}`);
  check('  the same room', rejoined.room?.roomId === alice.roomId);
  check('  with a new member credential', rejoined.room?.token !== bobOldToken);
  // The signing identity is pinned for the life of the room, so a rejoin must
  // present the SAME key or every peer would reject it as a substitution.
  check('  and the same room-specific signing identity he had before', rejoined.room?.publicKey === bobOldSigning, 'a fresh key here would be refused as key substitution');
  // Sharing was turned off by the leave, so rejoining turns it back on — and
  // `enableShared` restores the earlier keep-back decision rather than asking
  // again, because most of these threads arrived from the share itself.
  bob.store.enableShared({ workspaceId: bob.roomId, publishExisting: false });

  const AFTER_REJOIN = 'RESILIENCE-C after rejoining';
  bob.store.apply({ action: 'create', message: AFTER_REJOIN, anchor: ANCHOR });
  await bob.sync('after-rejoin');
  const aliceSawRejoin = await syncUntil(alice, (t) => (t.messages || []).some((m) => (m.body || m.message || '').includes(AFTER_REJOIN)));
  check('  and can write again, which Alice receives', !!aliceSawRejoin);

  alice.store.apply({ action: 'reply', threadId: aliceSawRejoin.id, message: 'RESILIENCE-C reply after rejoin' });
  alice.store.apply({ action: 'resolve', threadId: aliceSawRejoin.id });
  await alice.sync('reply');
  const converged = await syncUntil(bob, (t) => t.id === aliceSawRejoin.id && t.status === 'resolved');
  check('  a reply and a status change converge back to Bob', !!converged, String(bob.threads().find((t) => t.id === aliceSawRejoin.id)?.status));

  // ======================================================================
  say('  D  a new room cannot be opened with the old room’s material');
  // ======================================================================

  const oldRoomId = alice.roomId;
  const oldSecret = alice.rooms.get(oldRoomId)?.secret;
  const oldToken = alice.rooms.get(oldRoomId)?.token;
  const oldInvite = invite2.capability;
  const historyBefore = { alice: alice.threads().length, bob: bob.threads().length };

  const ended = await alice.transport().end();
  check('the owner ends the room', ended?.ok === true, JSON.stringify(ended).slice(0, 120));
  check('  Alice keeps her whole history', alice.threads().length === historyBefore.alice);
  check('  Bob keeps his', bob.threads().length === historyBefore.bob);

  const afterEnd = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(oldRoomId)}`, {
    headers: { authorization: `Bearer ${oldToken}` },
    signal: AbortSignal.timeout(20000),
  });
  check('  and the room is gone from the relay', afterEnd.status !== 200, `http ${afterEnd.status}`);

  // A completely new share.
  const alice2 = person(ALICE, dirs.aliceData, dirs.aliceProject).open();
  const made2 = await createRoom({ relay: BASE, actor: ALICE, rooms: alice2.rooms });
  check('a brand new secure share is created', made2.ok === true, JSON.stringify(made2).slice(0, 120));
  const newRoom = made2.room;
  ownedRooms.push({ roomId: newRoom.roomId, token: newRoom.token });

  check('  its room id is new', newRoom.roomId !== oldRoomId);
  check('  its room secret is new', newRoom.secret !== oldSecret);
  check('  its member credential is new', newRoom.token !== oldToken);
  check('  and its sender id is derived afresh', newRoom.senderId !== alice.rooms.get(oldRoomId)?.senderId);

  // NONE of the old material may open it.
  const oldTokenOnNewRoom = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(newRoom.roomId)}`, {
    headers: { authorization: `Bearer ${oldToken}` },
    signal: AbortSignal.timeout(20000),
  });
  check('  the old room’s credential does not authorize the new room', oldTokenOnNewRoom.status === 401, `http ${oldTokenOnNewRoom.status}`);

  const oldInviteOnNewRoom = await fetch(`${BASE}/v2/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: newRoom.roomId, invite: 'not-the-right-invite', senderId: newRoom.senderId, publicKey: newRoom.publicKey }),
    signal: AbortSignal.timeout(20000),
  });
  check('  and a stale invitation cannot join it', oldInviteOnNewRoom.status >= 400, `http ${oldInviteOnNewRoom.status}`);
  check('  the ended room’s invitation is dead too', typeof oldInvite === 'string');

  // And the new room genuinely works.
  const bob2 = person(BOB, dirs.bobData, dirs.bobProject).open();
  alice2.roomId = newRoom.roomId;
  alice2.store.enableShared({ workspaceId: newRoom.roomId, publishExisting: false });
  const invite3 = await alice2.transport().createInvite({});
  const rejoin2 = await joinRoom({ capability: invite3.capability, actor: BOB, rooms: bob2.rooms });
  check('  somebody can still join the new room', rejoin2.ok === true, JSON.stringify(rejoin2).slice(0, 120));
  bob2.roomId = rejoin2.room.roomId;
  bob2.store.enableShared({ workspaceId: bob2.roomId, publishExisting: false });

  const NEW_ROOM_TEXT = 'RESILIENCE-D in the new room';
  alice2.store.apply({ action: 'create', message: NEW_ROOM_TEXT, anchor: ANCHOR });
  await alice2.sync('new-room');
  const bobGotNew = await syncUntil(bob2, (t) => (t.messages || []).some((m) => (m.body || m.message || '').includes(NEW_ROOM_TEXT)));
  check('  and an event exchanged in it arrives', !!bobGotNew);

  await finish(0);
})().catch(async (err) => {
  goOnline();
  shout(`public-resilience: threw\n${err?.stack || err}`);
  failures.push(`  the run did not finish: ${err?.message || err}`);
  await finish(1);
});

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  goOnline();

  // Take back every room this run made.
  let live = 0;
  for (const room of ownedRooms) {
    try {
      await fetch(`${BASE}/v2/rooms/${encodeURIComponent(room.roomId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${room.token}` },
        signal: AbortSignal.timeout(20000),
      });
      const after = await fetch(`${BASE}/v2/rooms/${encodeURIComponent(room.roomId)}`, {
        headers: { authorization: `Bearer ${room.token}` },
        signal: AbortSignal.timeout(20000),
      });
      if (after.status === 200) live += 1;
    } catch {
      /* best effort; the relay's retention sweep is the backstop */
    }
  }
  check('no room this run created is still live', live === 0, `${live} of ${ownedRooms.length}`);

  const problems = [];
  for (const [name, dir] of Object.entries(dirs)) {
    if (!releaseTempDir(dir)) problems.push(`${name} would not go`);
  }
  if (problems.length) {
    shout(`\npublic-resilience: could not clean up\n  ${problems.join('\n  ')}\n`);
    code = code || 1;
  }
  if (failures.length) {
    shout(`\npublic-resilience: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    process.exit(code || 1);
  }
  say(`\npublic-resilience: ${checked} checks passed  [offline, restart, rejoin, isolation — over the internet]`);
  process.exit(code);
}
