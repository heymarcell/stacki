// The alpha's reviews, discarded once and only once.
//
//   node test/review-epoch.js
//
// This is the destructive part of the review model change, so it is the part
// worth being exact about. The reset has to do BOTH halves and NEITHER more:
//
//   the ledgers on disk, including quarantined ones nothing could parse;
//   the review-sharing membership — every room, every dormant identity, every
//   workspace credential, every project mapping — because a project still
//   joined to a relay would pull the old events straight back down and the
//   reset would have achieved nothing.
//
// And what it must not touch, which is the half that would be a bug rather
// than a feature:
//
//   the local person. Every comment ever written from this machine is
//   attributed to that uuid. Minting a new one makes somebody a stranger to
//   their own past.
//   the preferred relay, which is a setting somebody typed.
//   anything else in userData at all.
//
// It also has to run exactly once, and it has to be safe to interrupt: a
// half-finished reset must be retried, not recorded as done.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { resetReviewEpoch, epochOf, EPOCH } = require('../electron/review/epoch.js');
const { createSecureRooms } = require('../electron/review/secure/secrets.js');
const { createWorkspaces } = require('../electron/review/workspaces.js');
const { createReviewStore, fileFor, scopeKey, VERSION } = require('../electron/review/store.js');
const { readIdentityFile, localActor } = require('../electron/review/actors.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-epoch-'));
const b64 = (n) => crypto.randomBytes(n).toString('base64url');

// Deterministic, and never a real Keychain in an automated test.
const protector = {
  available: true,
  backend: 'test',
  encrypt: (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: (blob) => Buffer.from(blob, 'base64').toString('utf8'),
};

/** A room the registry will accept, with no relay anywhere near it. */
const room = (over = {}) => ({
  roomId: b64(16),
  relay: 'https://relay.example',
  secret: b64(32),
  token: b64(32),
  privateKey: b64(32),
  publicKey: b64(32),
  senderId: b64(32),
  actorId: crypto.randomUUID(),
  isOwner: false,
  ...over,
});

// ── A machine with everything on it ─────────────────────────────────────────

const userData = path.join(home, 'user');
fs.mkdirSync(userData, { recursive: true });

// The local person, made the way the app makes one.
const me = localActor(userData);
const projects = [path.join(home, 'p1'), path.join(home, 'p2')];
for (const p of projects) fs.mkdirSync(p, { recursive: true });

// Two ledgers with real reviews in them, written through the real store.
for (const p of projects) {
  const store = createReviewStore({ file: fileFor(userData, p), projectPath: p, actor: me });
  store.apply({ action: 'create', message: `something about ${path.basename(p)}`, anchor: { keys: ['src/pages/index.astro#0.1'] } });
  store.flushSync?.();
}

// One that nothing could parse, set aside by the store rather than deleted.
const quarantined = path.join(userData, 'reviews', 'deadbeefdeadbeef.json.corrupt-1700000000000');
fs.writeFileSync(quarantined, '{ not json at all', 'utf8');

// A settings file that has nothing to do with reviews. It is here to be
// counted afterwards.
const settings = path.join(userData, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({ sound: false }), 'utf8');

const rooms = createSecureRooms({ userDataPath: userData, protector });
const workspaces = createWorkspaces({ userDataPath: userData });

rooms.setPreferredRelay('https://relay.example');
const live = room({ isOwner: true });
const joined = room();
rooms.remember(live);
rooms.remember(joined);
rooms.link(scopeKey(projects[0]), live.roomId);
// A room this machine has left, which keeps a dormant signing identity. `all()`
// does not show it — which is exactly why forgetting each room in turn would
// leave it behind.
const departed = room();
rooms.remember(departed);
rooms.retire(departed.roomId);
// A membership the relay still owes a deletion for.
rooms.rememberCleanup({ roomId: b64(16), relay: 'https://relay.example', token: b64(32), owner: true });

workspaces.remember({ id: 'ws_1', server: 'https://reviews.example', token: b64(32), displayName: 'Team', memberId: 'm1', actorId: me.id });
workspaces.link(scopeKey(projects[1]), 'ws_1');

// What was true before, so that "gone" is a change rather than an assumption.
check('the ledgers are on disk to begin with', fs.readdirSync(path.join(userData, 'reviews')).length === 3, fs.readdirSync(path.join(userData, 'reviews')).join());
check('there are rooms to begin with', rooms.all().length === 2, String(rooms.all().length));
check('a dormant identity too', !!rooms.dormantFor(departed.roomId));
check('a pending relay cleanup too', rooms.pendingCleanups().length === 1);
check('a workspace to begin with', workspaces.all().length === 1);
check('and both projects are pointed somewhere', !!rooms.forProject(scopeKey(projects[0])) && !!workspaces.forProject(scopeKey(projects[1])));
check('nothing has been reset yet', epochOf(userData) === 0, String(epochOf(userData)));

// ── The reset ───────────────────────────────────────────────────────────────
//
// No transport: this asks for none, so no relay is contacted and the local
// half is measured on its own. The relay half is best-effort by construction
// and is checked separately below.

const done = resetReviewEpoch({ userDataPath: userData, rooms, workspaces });

check('it ran', done.ran === true);
check('and finished', done.complete === true, JSON.stringify(done.undeleted));
check('it says which epoch it reset to', done.epoch === EPOCH && EPOCH === VERSION, `${done.epoch} vs ledger ${VERSION}`);
check('every ledger went, quarantined ones included', done.ledgersRemoved === 3, String(done.ledgersRemoved));
check('and the directory is empty', fs.readdirSync(path.join(userData, 'reviews')).length === 0, fs.readdirSync(path.join(userData, 'reviews')).join());
check('the quarantined file went with them', !fs.existsSync(quarantined));

check('no room is left', rooms.all().length === 0);
check('not even the dormant one', !rooms.dormantFor(departed.roomId));
check('nor a pending cleanup', rooms.pendingCleanups().length === 0);
check('nor a project pointed at a room', !rooms.forProject(scopeKey(projects[0])));
check('no workspace is left', workspaces.all().length === 0);
check('nor a project pointed at one', !workspaces.forProject(scopeKey(projects[1])));
check('and it counted what it wiped', done.entriesWiped === 4 && done.workspacesWiped === 1, JSON.stringify({ e: done.entriesWiped, w: done.workspacesWiped }));

// ── What it was not allowed to touch ────────────────────────────────────────

const identity = readIdentityFile(userData);
check('THE LOCAL PERSON SURVIVES', identity.actor?.id === me.id, JSON.stringify(identity.actor));
check('with the name they chose', identity.actor?.displayName === me.displayName);
check('and the day they were made', Number.isInteger(identity.actorCreatedAt));
check('and localActor still answers with the same one', localActor(userData).id === me.id);
check('the preferred relay survives', rooms.preferredRelay() === 'https://relay.example', String(rooms.preferredRelay()));
check('an unrelated settings file is untouched', JSON.parse(fs.readFileSync(settings, 'utf8')).sound === false);
check('and the projects themselves are still there', projects.every((p) => fs.existsSync(p)));

// ── Once, and only once ─────────────────────────────────────────────────────

check('the marker records the epoch', epochOf(userData) === EPOCH, String(epochOf(userData)));

// A review written after the reset must survive the next launch. This is the
// failure that would matter most: a reset that fires every time is a machine
// that cannot keep a comment at all.
const after = createReviewStore({ file: fileFor(userData, projects[0]), projectPath: projects[0], actor: me });
after.apply({ action: 'create', message: 'written after the reset', anchor: { keys: ['src/pages/index.astro#0.2'] } });
after.flushSync?.();
rooms.remember(room());

const second = resetReviewEpoch({ userDataPath: userData, rooms, workspaces });
check('a second run does nothing', second.ran === false);
check('and leaves the new review alone', createReviewStore({ file: fileFor(userData, projects[0]), projectPath: projects[0], actor: me }).size === 1);
check('and the new room alone', rooms.all().length === 1);

// ── A first run with nothing on the machine ─────────────────────────────────
//
// The ordinary case for everybody installing Stacki from here on: the reset
// runs once, finds nothing, and must say NOTHING. It used to announce
// "discarded 0 ledger(s), 0 room entr(ies), 0 workspace(s)" on stderr of every
// fresh install, which is noise in every log and which broke the acceptance
// test that reads one.

{
  const dir = path.join(home, 'brand-new');
  fs.mkdirSync(dir, { recursive: true });
  const said = [];
  const fresh = resetReviewEpoch({
    userDataPath: dir,
    rooms: createSecureRooms({ userDataPath: dir, protector }),
    workspaces: createWorkspaces({ userDataPath: dir }),
    log: (m) => said.push(m),
  });
  check('a first run on an empty machine still runs', fresh.ran === true && fresh.complete === true);
  check('and says nothing at all', said.length === 0, said.join(' | '));
  check('but records itself, so it never runs again', epochOf(dir) === EPOCH);

  // And a run that DOES discard something says so — the log is not simply off.
  const dir2 = path.join(home, 'had-something');
  fs.mkdirSync(dir2, { recursive: true });
  const r2 = createSecureRooms({ userDataPath: dir2, protector });
  r2.remember(room());
  const loud = [];
  resetReviewEpoch({ userDataPath: dir2, rooms: r2, workspaces: createWorkspaces({ userDataPath: dir2 }), log: (m) => loud.push(m) });
  check('a run that discarded something does say so', loud.length === 1 && /review epoch 3/.test(loud[0]), loud.join(' | '));
}

// ── Interrupted halfway ─────────────────────────────────────────────────────
//
// If a ledger cannot be removed, the reset is NOT recorded as done. The
// membership is already gone — which is the half that makes it safe — and the
// file is retried on the next launch rather than left behind under a marker
// claiming it was handled.

{
  const dir = path.join(home, 'stuck');
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  // A directory where a ledger should be: rmSync on it without `recursive`
  // fails, which is the closest reliable stand-in for a file that will not go.
  fs.mkdirSync(path.join(dir, 'reviews', 'wedged.json'));
  const r = createSecureRooms({ userDataPath: dir, protector });
  const w = createWorkspaces({ userDataPath: dir });
  r.remember(room());

  const stuck = resetReviewEpoch({ userDataPath: dir, rooms: r, workspaces: w });
  check('a reset that could not finish says so', stuck.ran === true && stuck.complete === false, JSON.stringify(stuck.undeleted));
  check('and names what it could not remove', stuck.undeleted.some((t) => /wedged\.json/.test(t)), stuck.undeleted.join());
  check('the membership went anyway — that is the half that stops a re-sync', r.all().length === 0);
  check('but no marker was written', epochOf(dir) === 0, String(epochOf(dir)));

  fs.rmSync(path.join(dir, 'reviews', 'wedged.json'), { recursive: true });
  const retried = resetReviewEpoch({ userDataPath: dir, rooms: r, workspaces: w });
  check('so the next launch tries again', retried.ran === true && retried.complete === true);
  check('and records it that time', epochOf(dir) === EPOCH);
}

// ── Saying goodbye to the relay ─────────────────────────────────────────────
//
// Best-effort, and only that. The local half is already done by the time any
// of this is attempted, so a relay that is down cannot leave a machine still
// joined to a room. What it must do is use the right verb: END for a room this
// machine owns, LEAVE for one it merely joined.

(async () => {
  const dir = path.join(home, 'goodbye');
  fs.mkdirSync(dir, { recursive: true });
  const r = createSecureRooms({ userDataPath: dir, protector });
  const w = createWorkspaces({ userDataPath: dir });
  const mine = room({ isOwner: true });
  const theirs = room();
  r.remember(mine);
  r.remember(theirs);

  const said = [];
  const said2 = resetReviewEpoch({
    userDataPath: dir,
    rooms: r,
    workspaces: w,
    transportFor: (roomId) => ({
      end: async () => (said.push(['end', roomId]), { ok: true }),
      leave: async () => (said.push(['leave', roomId]), { ok: true }),
      close: () => said.push(['close', roomId]),
    }),
  });
  check('the local half does not wait for the relay', r.all().length === 0 && said2.complete === true);
  const answers = await said2.notified;
  check('both rooms were told', answers.length === 2 && answers.every((a) => a.ok), JSON.stringify(answers));
  check('a room this machine owns is ENDED', said.some(([verb, id]) => verb === 'end' && id === mine.roomId), JSON.stringify(said));
  check('one it only joined is LEFT', said.some(([verb, id]) => verb === 'leave' && id === theirs.roomId), JSON.stringify(said));
  check('and every connection is closed afterwards', said.filter(([verb]) => verb === 'close').length === 2);

  // A relay that is down, or a transport that throws on construction. Neither
  // may stop the reset, and neither may throw out of it.
  const dir2 = path.join(home, 'offline');
  fs.mkdirSync(dir2, { recursive: true });
  const r2 = createSecureRooms({ userDataPath: dir2, protector });
  const w2 = createWorkspaces({ userDataPath: dir2 });
  r2.remember(room());
  r2.remember(room({ isOwner: true }));
  let built = 0;
  const offline = resetReviewEpoch({
    userDataPath: dir2,
    rooms: r2,
    workspaces: w2,
    transportFor: () => {
      built += 1;
      if (built === 1) throw new Error('no route to host');
      return {
        end: async () => {
          throw new Error('timed out');
        },
        leave: async () => ({ ok: false, code: 'offline' }),
        close: () => {},
      };
    },
  });
  check('a transport that cannot even be built does not stop the reset', offline.complete === true && r2.all().length === 0);
  const outcomes = await offline.notified;
  check('and a relay that never answers is reported, not thrown', outcomes.every((o) => o.ok === false), JSON.stringify(outcomes));
  check('the reset still counted as done', epochOf(dir2) === EPOCH);

  finish();
})().catch((err) => {
  failures.push(`  the goodbye checks threw\n    ${err?.stack || err}`);
  finish();
});

function finish() {
  fs.rmSync(home, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nreview-epoch: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`review-epoch: ${checked} passed  [the ledgers, the membership, and nothing else]`);
}
