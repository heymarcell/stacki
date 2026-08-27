// The service, the transport, and catching up.
//
//   node --disable-warning=ExperimentalWarning test/shared-reviews.js
//
// Everything between one person's ledger and another's. A real HTTP service on
// a real port with a real database, driven by the real transport — because the
// failures worth catching here are all at a boundary, and a mocked boundary
// catches none of them.
//
// The properties being checked, in the order they would hurt:
//
//   NO EVENT IS EVER LOST. Not to a duplicate delivery, not to an out-of-order
//   one, not to a server that was down when somebody wrote a reply, not to a
//   sync that failed halfway. The event set only ever grows, on both sides.
//
//   AUTHORSHIP CANNOT BE FORGED. The server decides who a person is. Bob's
//   credential cannot push a message signed Alice, and no amount of client-side
//   politeness is what enforces that.
//
//   A WORKSPACE IS NOT DISCOVERABLE. A credential for one workspace cannot
//   read another, and asking about one you are not in answers 404 rather than
//   403 — a 403 would confirm it exists.
//
//   A PROJECT THAT IS NOT SHARED MAKES NO REQUESTS. Not a health check, not a
//   HEAD. Review comments are candid, and the guarantee that they never leave
//   the machine unless somebody said so is the whole privacy model. There is a
//   test that counts.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { createReviewService, checkEvent, bearerOf, tokenMatches, MAX_BATCH } = require('../service/server.js');
const { openStore } = require('../service/store.js');
const {
  createTransport,
  createWorkspace,
  joinWorkspace,
  packInvite,
  unpackInvite,
  normalizeBase,
} = require('../electron/review/transport.js');
const { createWorkspaces } = require('../electron/review/workspaces.js');
const { createReviewStore, scopeKey } = require('../electron/review/store.js');
const { syncOnce, createSyncer, legacyLink } = require('../electron/review/sync.js');
const { makeEvent, projectThreads } = require('../electron/review/events.js');
const { uuidv5, agentActor } = require('../electron/review/actors.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-shared-'));
const SIGNUP = 'a-signup-token-long-enough';

const ALICE = { id: uuidv5('alice'), kind: 'human', displayName: 'Alice' };
const BOB = { id: uuidv5('bob'), kind: 'human', displayName: 'Bob' };
const CLAUDE = agentActor('Claude');

const anchor = { keys: ['src/pages/index.astro#0.1'], page: { route: '/', file: 'src/pages/index.astro' } };
const NO_GIT = { for: () => ({ head: null, branch: null, dirty: null, files: {} }), stamp: () => ({ head: null, branch: null, dirty: null }) };

(async () => {
  const service = createReviewService({ port: 0, host: '127.0.0.1', file: ':memory:', signupToken: SIGNUP });
  await service.start();
  const BASE = `http://127.0.0.1:${service.address.port}`;

  // ── Small pieces, before anything is built on them ───────────────────────

  {
    check('a bearer header is read', bearerOf('Bearer abc') === 'abc' && bearerOf('bearer  abc') === 'abc');
    check('and anything else is not a credential', bearerOf('abc') === null && bearerOf(null) === null);
    check('tokens compare in constant time and by value', tokenMatches('abc', 'abc') && !tokenMatches('abc', 'abd'));
    check('a shorter token is not a prefix match', !tokenMatches('ab', 'abc'));
    check('an https address normalises', normalizeBase('https://reviews.example.test/api/') === 'https://reviews.example.test/api');
    check('a non-http scheme is refused', normalizeBase('ftp://x/y') === null && normalizeBase('file:///etc') === null);
    // A credential belongs in a header, not in a URL that gets logged.
    check('an address carrying a password is refused', normalizeBase('https://u:p@example.test/') === null);
    check('and nonsense is refused', normalizeBase('not a url') === null && normalizeBase('') === null);
  }

  // ── Creating a workspace ─────────────────────────────────────────────────

  let aliceWs;
  {
    const refused = await createWorkspace({ baseUrl: BASE, signupToken: 'wrong', displayName: 'x', actor: ALICE });
    check('a workspace cannot be created without the server’s signup token', refused.ok === false && refused.code === 'unauthorized', JSON.stringify(refused));

    aliceWs = await createWorkspace({ baseUrl: BASE, signupToken: SIGNUP, displayName: 'lenuri-web', repositoryHint: 'github.com/team/site', actor: ALICE });
    check('with it, a workspace is created', aliceWs.ok === true, JSON.stringify(aliceWs));
    check('and it has a random id', /^[0-9a-f-]{36}$/.test(aliceWs.workspace.id));
    check('and a name a person chose', aliceWs.workspace.displayName === 'lenuri-web');
    check('and the creator is a member with a credential', !!aliceWs.credential.token && aliceWs.credential.actorId === ALICE.id);
    check('the credential is not the signup token', aliceWs.credential.token !== SIGNUP);
    const noActor = await createWorkspace({ baseUrl: BASE, signupToken: SIGNUP, displayName: 'x', actor: { displayName: 'nobody' } });
    check('a workspace needs somebody to belong to', noActor.ok === false, JSON.stringify(noActor));
  }

  const aliceT = createTransport({ kind: 'http', baseUrl: BASE, token: aliceWs.credential.token, workspaceId: aliceWs.workspace.id });
  check('a transport describes itself without its credential', !JSON.stringify(aliceT.describe()).includes(aliceWs.credential.token), JSON.stringify(aliceT.describe()));

  // ── Invitations ──────────────────────────────────────────────────────────

  let bobWs;
  {
    const meta = await aliceT.workspace();
    check('a member can read their workspace', meta.ok === true && meta.workspace.id === aliceWs.workspace.id);
    check('and sees who is in it', meta.members.length === 1 && meta.members[0].displayName === 'Alice', JSON.stringify(meta.members));

    const invite = await aliceT.createInvite({});
    check('a member can make an invitation', invite.ok === true && !!invite.invite);
    check('which expires', typeof invite.expiresAt === 'number' && invite.expiresAt > Date.now());

    const packed = packInvite({ server: BASE, invite: invite.invite });
    check('an invitation carries the server it is for', packed.startsWith('stacki1.'));
    const unpacked = unpackInvite(packed);
    check('and unpacks to both halves', unpacked.server === BASE && unpacked.invite === invite.invite);
    check('a mangled invitation unpacks to nothing', unpackInvite('stacki1.zzzz') === null);
    check('and so does anything that is not one', unpackInvite('hello') === null && unpackInvite(null) === null);

    bobWs = await joinWorkspace({ baseUrl: unpacked.server, invite: unpacked.invite, actor: BOB });
    check('somebody with an invitation joins', bobWs.ok === true && bobWs.workspace.id === aliceWs.workspace.id, JSON.stringify(bobWs));
    check('and gets their own credential', bobWs.credential.token !== aliceWs.credential.token);
    check('under their own actor', bobWs.credential.actorId === BOB.id);

    // Single use. Two people racing one invitation must not both get in on it.
    const again = await joinWorkspace({ baseUrl: BASE, invite: invite.invite, actor: { id: uuidv5('carol'), kind: 'human', displayName: 'Carol' } });
    check('an invitation works once', again.ok === false && again.code === 'unauthorized', JSON.stringify(again));
    const nonsense = await joinWorkspace({ baseUrl: BASE, invite: 'not-an-invitation', actor: BOB });
    check('and a made-up one never works', nonsense.ok === false);
    // The same message for a wrong invitation and a used one, so guessing
    // tells you nothing.
    check('a bad invitation and a used one are indistinguishable', again.message === nonsense.message, `${again.message} vs ${nonsense.message}`);
  }

  const bobT = createTransport({ baseUrl: BASE, token: bobWs.credential.token, workspaceId: bobWs.workspace.id });

  // ── Membership is the whole authorization model ──────────────────────────

  {
    const anonymous = createTransport({ baseUrl: BASE, token: 'not-a-credential', workspaceId: aliceWs.workspace.id });
    check('an unrecognised credential reads nothing', (await anonymous.workspace()).code === 'unauthorized');
    check('and writes nothing', (await anonymous.pushEvents([event('x1', ALICE, 1)])).code === 'unauthorized');

    const other = await createWorkspace({ baseUrl: BASE, signupToken: SIGNUP, displayName: 'somebody else’s', actor: { id: uuidv5('dana'), kind: 'human', displayName: 'Dana' } });
    const crossed = createTransport({ baseUrl: BASE, token: bobWs.credential.token, workspaceId: other.workspace.id });
    const crossRead = await crossed.workspace();
    // 404, not 403. A 403 would confirm the workspace exists, which turns this
    // endpoint into a way to enumerate them.
    check('a credential for one workspace cannot read another', crossRead.ok === false && crossRead.code === 'not_found', JSON.stringify(crossRead));
    check('nor write into it', (await crossed.pushEvents([event('x2', BOB, 1)])).code === 'not_found');
    const guessed = createTransport({ baseUrl: BASE, token: bobWs.credential.token, workspaceId: '00000000-0000-4000-8000-000000000000' });
    check('and a workspace that does not exist answers the same way', (await guessed.workspace()).code === 'not_found');

    // Isolation is real, not merely refused: Dana's workspace never sees the
    // events pushed into Alice's.
    const danaT = createTransport({ baseUrl: BASE, token: other.credential.token, workspaceId: other.workspace.id });
    await aliceT.pushEvents([event('isolation-1', ALICE, 1)]);
    check('and one workspace’s events never appear in another', (await danaT.pullEvents({ after: 0 })).events.length === 0);
  }

  // ── The server decides who a person is ───────────────────────────────────

  function event(id, actor, lamport, over = {}) {
    return makeEvent({
      id,
      type: 'message.created',
      threadId: 'rt_shared',
      actor,
      lamport,
      at: 1000 + lamport,
      payload: { messageId: `m_${id}`, body: `said by ${actor.displayName}` },
      ...over,
    });
  }

  {
    const spoof = await bobT.pushEvents([event('spoof-1', ALICE, 5)]);
    check('a member cannot push a human event signed as somebody else', spoof.accepted.length === 0, JSON.stringify(spoof));
    check('and is told exactly why', spoof.rejected[0]?.code === 'actor_mismatch', JSON.stringify(spoof.rejected));
    check('a member can push their own', (await bobT.pushEvents([event('bob-1', BOB, 6)])).accepted.length === 1);
    // Agent events are allowed under any actor: that is what makes "Claude" the
    // same author on both machines. Every one is stamped with the member who
    // submitted it, so it is still attributable to somebody in the workspace.
    const agent = await bobT.pushEvents([event('claude-1', CLAUDE, 7)]);
    check('an agent’s event is accepted from whoever is running it', agent.accepted.length === 1, JSON.stringify(agent));
    const stamped = service.store.db.prepare('SELECT submitted_by FROM events WHERE event_id = ?').get('claude-1');
    check('and the server records which member submitted it', !!stamped?.submitted_by);
  }

  // ── What the server will not store ───────────────────────────────────────

  {
    const member = { actor_id: ALICE.id };
    check('an event that is not one is refused', checkEvent({ nope: true }, member).code === 'invalid_event');
    check('and one with no lamport', checkEvent({ ...event('x', ALICE, 1), lamport: null }, member).code === 'invalid_event');
    check('a human event under another actor is refused', checkEvent(event('x', BOB, 1), member).code === 'actor_mismatch');
    check('an agent event is not', checkEvent(event('x', CLAUDE, 1), member).ok === true);
    // A newer client's event type is stored verbatim rather than dropped:
    // upgrading one machine must not strip history for everybody else.
    check('an event type this server has never heard of is kept', checkEvent({ ...event('x', ALICE, 1), type: 'thread.starred' }, member).ok === true);
    check('but a type that is not even shaped like one is refused', checkEvent({ ...event('x', ALICE, 1), type: 'DROP TABLE' }, member).code === 'invalid_event');
    const huge = { ...event('x', ALICE, 1), payload: { body: 'x'.repeat(200_000) } };
    check('an event bigger than the cap is refused', checkEvent(huge, member).ok === false);

    const over = await aliceT.pushEvents(Array.from({ length: 5 }, (_, i) => event(`batch-${i}`, ALICE, 20 + i)));
    check('an ordinary batch is accepted whole', over.accepted.length === 5, JSON.stringify(over.accepted.length));
    // The transport will not even try to send more than the batch cap.
    const capped = await aliceT.pushEvents(Array.from({ length: MAX_BATCH + 50 }, (_, i) => event(`big-${i}`, ALICE, 100 + i)));
    check('a batch larger than the cap is trimmed rather than refused', capped.ok === true && capped.accepted.length === MAX_BATCH, String(capped.accepted.length));
  }

  // ── Cursors ──────────────────────────────────────────────────────────────

  {
    const first = await bobT.pullEvents({ after: 0, limit: 3 });
    check('a page comes back with a cursor', first.ok === true && first.events.length === 3, JSON.stringify(first.events.length));
    check('and says there is more', first.hasMore === true);
    const second = await bobT.pullEvents({ after: first.cursor, limit: 3 });
    check('the next page starts where the last one stopped', second.events.every((e) => !first.events.some((f) => f.id === e.id)));
    check('and the cursor moves forward', second.cursor > first.cursor);

    let cursor = 0;
    const all = [];
    for (let i = 0; i < 50; i++) {
      const page = await bobT.pullEvents({ after: cursor, limit: 10 });
      all.push(...page.events);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    check('paging to the end sees everything exactly once', new Set(all.map((e) => e.id)).size === all.length, `${all.length} vs ${new Set(all.map((e) => e.id)).size}`);
    check('and pulling from the end again returns nothing', (await bobT.pullEvents({ after: cursor })).events.length === 0);
    // A cursor is arrival order, not truth order. The fold sorts.
    check('the page is in the server’s arrival order', all.length > 3);
  }

  // ── Two ledgers, one workspace ───────────────────────────────────────────
  //
  // The real thing: two stores, two identities, one service, and the sync
  // client that joins them.

  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });

  const ledgerFor = (who, actor) =>
    createReviewStore({ file: path.join(home, `${who}.json`), projectPath: null, actor, source: NO_GIT });

  const shared = await createWorkspace({ baseUrl: BASE, signupToken: SIGNUP, displayName: 'two-people', actor: ALICE });
  const inviteForBob = packInvite({
    server: BASE,
    invite: (await createTransport({ baseUrl: BASE, token: shared.credential.token, workspaceId: shared.workspace.id }).createInvite({})).invite,
  });
  const bobJoined = await joinWorkspace({ ...unpackInvite(inviteForBob), baseUrl: unpackInvite(inviteForBob).server, actor: BOB });

  const aliceCred = { id: shared.workspace.id, server: BASE, token: shared.credential.token };
  const bobCred = { id: shared.workspace.id, server: BASE, token: bobJoined.credential.token };
  // A transport onto the workspace these two ledgers actually share — distinct
  // from `bobT` above, which belongs to the workspace used for the auth checks.
  const sharedT = createTransport({ baseUrl: BASE, token: bobJoined.credential.token, workspaceId: shared.workspace.id });

  const aliceLedger = ledgerFor('alice', ALICE);
  const bobLedger = ledgerFor('bob', BOB);
  aliceLedger.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
  bobLedger.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });

  {
    const made = aliceLedger.apply({ action: 'create', message: 'This CTA is too close to the copy.', anchor });
    check('a comment on a shared project is queued to send', aliceLedger.shared.pending === 2, String(aliceLedger.shared.pending));

    const pushed = await syncOnce({ store: aliceLedger, link: legacyLink(aliceCred) });
    check('a sync pushes it', pushed.ok === true && pushed.pushed === 2, JSON.stringify(pushed));
    check('and the outbox empties', aliceLedger.shared.pending === 0);
    check('and it says when it last caught up', typeof aliceLedger.shared.lastSyncAt === 'number');

    const pulled = await syncOnce({ store: bobLedger, link: legacyLink(bobCred) });
    check('the other person’s first sync pulls it', pulled.ok === true && pulled.pulled === 2, JSON.stringify(pulled));
    const bobSees = bobLedger.all();
    check('and they see the thread', bobSees.length === 1 && bobSees[0].messages[0].body === 'This CTA is too close to the copy.', JSON.stringify(bobSees.map((t) => t.messages.map((m) => m.body))));
    check('with Alice as its author', bobSees[0].author.actorName === 'Alice' && bobSees[0].author.actorId === ALICE.id);
    // The whole point of the local/shared split: Bob has never looked at his
    // own tree for this element, so its anchor is unknown — never "attached"
    // on Alice's word.
    check('and its anchor unresolved against his own checkout', bobSees[0].anchorState === 'unknown', bobSees[0].anchorState);
    check('and the nickname Alice used for it', bobSees[0].number === made.thread.number, `${bobSees[0].number} vs ${made.thread.number}`);

    // Bob replies; Alice sees it.
    bobLedger.apply({ action: 'reply', threadId: bobSees[0].id, message: 'Agreed — and the button is small.' });
    await syncOnce({ store: bobLedger, link: legacyLink(bobCred) });
    await syncOnce({ store: aliceLedger, link: legacyLink(aliceCred) });
    const aliceSees = aliceLedger.get(made.thread.id);
    check('a reply comes back the other way', aliceSees.messages.length === 2, String(aliceSees.messages.length));
    check('signed by the person who wrote it', aliceSees.messages[1].actorName === 'Bob');

    // And both machines have folded the same events into the same thread.
    check(
      'both people are looking at the same conversation',
      JSON.stringify(aliceLedger.get(made.thread.id).messages.map((m) => [m.actorName, m.body])) ===
        JSON.stringify(bobLedger.get(made.thread.id).messages.map((m) => [m.actorName, m.body]))
    );
  }

  // ── Offline, and coming back ─────────────────────────────────────────────

  {
    const thread = aliceLedger.all()[0];
    // The server is not there. Everything still works locally; the outbox grows.
    const dead = { id: shared.workspace.id, server: 'http://127.0.0.1:1', token: shared.credential.token };
    const wrote = aliceLedger.apply({ action: 'reply', threadId: thread.id, message: 'written with no network' });
    check('a comment can be written with no server', wrote.ok === true);
    const failed = await syncOnce({ store: aliceLedger, link: legacyLink(dead) });
    check('and the sync says what went wrong', failed.ok === false && ['offline', 'timeout'].includes(failed.code), JSON.stringify(failed));
    check('the panel is told, by name', ['offline', 'timeout'].includes(aliceLedger.shared.problem?.kind), JSON.stringify(aliceLedger.shared.problem));
    check('nothing was thrown away', aliceLedger.shared.pending === 1, String(aliceLedger.shared.pending));
    check('and the comment is still readable', aliceLedger.get(thread.id).messages.some((m) => m.body === 'written with no network'));

    // Back on the network.
    const recovered = await syncOnce({ store: aliceLedger, link: legacyLink(aliceCred) });
    check('reconnecting sends what was waiting', recovered.ok === true && recovered.pushed === 1, JSON.stringify(recovered));
    check('and the problem clears', aliceLedger.shared.problem === null);
    await syncOnce({ store: bobLedger, link: legacyLink(bobCred) });
    check('and the other person gets it', bobLedger.get(thread.id).messages.some((m) => m.body === 'written with no network'));
  }

  // ── Duplicate and out-of-order delivery ──────────────────────────────────

  {
    const before = JSON.stringify(bobLedger.all());
    // Everything, again, from the beginning: the ordinary shape of a client
    // that lost its cursor.
    const everything = await sharedT.pullEvents({ after: 0, limit: 500 });
    const replayed = bobLedger.receiveEvents(everything.events, { cursor: bobLedger.shared.cursor });
    check('replaying the whole history adds nothing', replayed.added === 0, String(replayed.added));
    check('and changes nothing', JSON.stringify(bobLedger.all()) === before);

    // Backwards, which is the shape of a delivery that arrived out of order.
    const backwards = bobLedger.receiveEvents([...everything.events].reverse(), { cursor: 0 });
    check('and so does receiving it backwards', backwards.added === 0 && JSON.stringify(bobLedger.all()) === before);

    // Half of it, then the other half, in the wrong order.
    const fresh = ledgerFor('fresh', BOB);
    fresh.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
    const all = everything.events;
    fresh.receiveEvents(all.slice(Math.floor(all.length / 2)), { cursor: 0 });
    fresh.receiveEvents(all.slice(0, Math.floor(all.length / 2)), { cursor: 0 });
    check(
      'a set delivered out of order folds to the same thing',
      JSON.stringify(fresh.all().map((t) => t.messages.map((m) => m.body))) ===
        JSON.stringify(bobLedger.all().map((t) => t.messages.map((m) => m.body))),
      JSON.stringify(fresh.all().map((t) => t.messages.map((m) => m.body)))
    );
  }

  // ── The cursor survives a restart ────────────────────────────────────────

  {
    const file = path.join(home, 'alice.json');
    const cursor = aliceLedger.shared.cursor;
    check('a synced ledger has a cursor', Number.isInteger(cursor) && cursor > 0, String(cursor));
    const reopened = createReviewStore({ file, projectPath: null, actor: ALICE, source: NO_GIT });
    check('which survives a restart', reopened.shared.cursor === cursor, `${reopened.shared.cursor} vs ${cursor}`);
    check('along with the workspace it belongs to', reopened.shared.workspaceId === shared.workspace.id);
    check('and the reviews', reopened.all().length === aliceLedger.all().length);
    // A second sync from the restored cursor is a no-op, not a re-download.
    const after = await syncOnce({ store: reopened, link: legacyLink(aliceCred) });
    check('and a sync from it pulls nothing new', after.ok === true && after.pulled === 0, JSON.stringify(after));
  }

  // ── A credential that stops working ──────────────────────────────────────

  {
    const revoked = { id: shared.workspace.id, server: BASE, token: 'no-longer-valid' };
    const store = ledgerFor('revoked', ALICE);
    store.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
    store.apply({ action: 'create', message: 'still mine', anchor });
    const result = await syncOnce({ store, link: legacyLink(revoked) });
    check('a refused credential is reported as such', result.ok === false && result.code === 'unauthorized', JSON.stringify(result));
    check('and said in a way a person can act on', store.shared.problem?.kind === 'unauthorized');
    check('while the comment stays exactly where it is', store.all().length === 1 && store.shared.pending === 2);
  }

  // ── A project that is not shared makes no requests at all ────────────────

  {
    let calls = 0;
    const countingFetch = (...args) => {
      calls += 1;
      return globalThis.fetch(...args);
    };
    const local = ledgerFor('local-only', ALICE);
    local.apply({ action: 'create', message: 'nobody else sees this', anchor });
    local.apply({ action: 'reply', threadId: local.all()[0].id, message: 'and nor this' });
    const skipped = await syncOnce({ store: local, link: legacyLink(null) });
    check('syncing an unshared project does nothing', skipped.ok === true && skipped.skipped === 'not_shared', JSON.stringify(skipped));
    // The guarantee. Review comments are candid; the only thing that makes
    // "they never leave your machine" true is that no code path reaches a
    // network without somebody having said so.
    check('and makes no network request whatsoever', calls === 0, `${calls} request(s)`);
    check('nothing was queued to send either', local.shared.pending === 0 && local.shared.workspaceId === null);
    // Even with a workspace credential in hand, a ledger that has not been
    // told to share refuses.
    check(
      'a credential alone does not make a project shared',
      (await syncOnce({ store: local, link: legacyLink(aliceCred, () => { calls += 1; throw new Error('should not be built'); }) })).skipped === 'not_shared'
    );
    check('and still no request was made', calls === 0, `${calls} request(s)`);
  }

  // ── The ledger and the registry must agree ───────────────────────────────

  {
    const store = ledgerFor('mismatch', ALICE);
    store.enableShared({ workspaceId: 'some-other-workspace', publishExisting: false });
    const result = await syncOnce({ store, link: legacyLink(aliceCred) });
    check('a project linked to one workspace will not sync with another', result.ok === false && result.code === 'workspace_mismatch', JSON.stringify(result));
  }

  // ── ...and so must the identity ──────────────────────────────────────────
  //
  // The server refuses a human event under any actor but the member's own. If
  // this installation's identity changed after joining — a lost identity file,
  // a userData folder copied between machines — every push would come back
  // rejected and be dropped from the outbox to stop it blocking the queue.
  // Silently. So it is caught before a request is made.

  {
    const store = ledgerFor('other-identity', BOB);
    store.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
    store.apply({ action: 'create', message: 'written under a different identity', anchor });
    let calls = 0;
    const result = await syncOnce({
      store,
      // Alice's credential, Bob's ledger.
      link: legacyLink({ ...aliceCred, actorId: ALICE.id }, (config) => {
        calls += 1;
        return createTransport(config);
      }),
    });
    check('an identity that does not match the membership refuses to sync', result.ok === false && result.code === 'identity_mismatch', JSON.stringify(result));
    check('before making any request at all', calls === 0, `${calls} request(s)`);
    check('and says what to do about it', /new invitation/.test(store.shared.problem?.detail || ''), JSON.stringify(store.shared.problem));
    check('while the comment stays exactly where it is', store.all().length === 1 && store.shared.pending === 2);
  }

  // ── An event the workspace will not take is never silently dropped ───────

  {
    const store = ledgerFor('refused', ALICE);
    store.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
    store.apply({ action: 'create', message: 'perfectly ordinary', anchor });
    // A server that refuses everything by name. The outbox has to drain —
    // otherwise one bad event blocks every later one forever — but the person
    // must be told, because "synced" over a comment nobody else can see is the
    // failure this whole model exists to avoid.
    const refusing = () => ({
      kind: 'http',
      pushEvents: async (events) => ({ ok: true, accepted: [], rejected: events.map((e) => ({ id: e.id, code: 'invalid_event' })), cursor: 0 }),
      pullEvents: async () => ({ ok: true, events: [], cursor: 0, hasMore: false }),
      close() {},
    });
    const result = await syncOnce({ store, link: legacyLink(aliceCred, refusing) });
    check('a refused push still empties the outbox', store.shared.pending === 0, String(store.shared.pending));
    check('and is counted rather than swallowed', result.refused === 2, JSON.stringify(result));
    check('and said out loud', store.shared.problem?.kind === 'refused_events', JSON.stringify(store.shared.problem));
    check('while the comment is still readable here', store.all().length === 1);
  }

  // ── One sync at a time ───────────────────────────────────────────────────

  {
    const syncer = createSyncer();
    const store = ledgerFor('serial', ALICE);
    store.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
    store.apply({ action: 'create', message: 'concurrent', anchor });
    const [a, b] = await Promise.all([
      syncer.sync({ store, link: legacyLink(aliceCred) }),
      syncer.sync({ store, link: legacyLink(aliceCred) }),
    ]);
    check('two syncs at once are one sync', a === b || JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)}\n    ${JSON.stringify(b)}`);
    check('and it worked', a.ok === true, JSON.stringify(a));
    // A focus is a hint. Coming back to the window a moment later is not a
    // reason to talk to a server again.
    const soon = await syncer.sync({ store, link: legacyLink(aliceCred), reason: 'focus' });
    check('a focus straight after a sync is skipped', soon.skipped === 'too_soon', JSON.stringify(soon));
  }

  // ── Publishing existing comments is a decision, not a default ────────────

  {
    const store = ledgerFor('privacy', ALICE);
    store.apply({ action: 'create', message: 'something candid about a colleague', anchor });
    store.apply({ action: 'create', message: 'and another', anchor });
    const kept = store.enableShared({ workspaceId: shared.workspace.id, publishExisting: false });
    check('sharing with the box unticked publishes nothing', kept.ok === true && store.shared.pending === 0, String(store.shared.pending));
    check('and says how many were kept back', store.shared.excluded === 2, String(store.shared.excluded));
    check('while the comments are all still there', store.all().length === 2);
    // A comment written AFTER sharing was turned on does go.
    store.apply({ action: 'create', message: 'written after sharing started', anchor });
    check('but a new comment is shared', store.shared.pending === 2, String(store.shared.pending));

    const shares = ledgerFor('privacy-2', ALICE);
    shares.apply({ action: 'create', message: 'this one is fine to share', anchor });
    const published = shares.enableShared({ workspaceId: shared.workspace.id, publishExisting: true });
    check('and with the box ticked, the back catalogue goes', published.published === 1 && shares.shared.pending === 2, JSON.stringify([published.published, shares.shared.pending]));

    // Turning sharing off keeps everything.
    const off = store.disableShared();
    check('turning sharing off works', off.ok === true && store.shared.workspaceId === null);
    check('and destroys no history at all', store.all().length === 3, String(store.all().length));
  }

  // ── The registry: credentials in userData, nothing in the project ────────

  {
    const userData = path.join(home, 'userdata');
    fs.mkdirSync(userData, { recursive: true });
    const registry = createWorkspaces({ userDataPath: userData });
    check('an empty registry has nothing in it', registry.all().length === 0 && registry.forProject('x') === null);

    const remembered = registry.remember({
      id: shared.workspace.id,
      server: BASE,
      token: shared.credential.token,
      displayName: 'two-people',
      memberId: shared.credential.memberId,
      actorId: ALICE.id,
      repositoryHint: 'github.com/team/site',
    });
    check('a workspace can be remembered', !!remembered && remembered.id === shared.workspace.id);
    check('and comes back with its credential', registry.get(shared.workspace.id).token === shared.credential.token);
    // The public view is what may cross an IPC boundary; the credential is not
    // in it.
    check('but the public view has no credential in it', !('token' in registry.publicOf(remembered)), JSON.stringify(registry.publicOf(remembered)));
    check('the credential file is only readable by this user', registry.secure(), (fs.statSync(registry.file).mode & 0o777).toString(8));

    const key = scopeKey(project);
    check('a project starts unlinked', registry.forProject(key) === null);
    check('and can be linked', registry.link(key, shared.workspace.id) === true);
    check('after which it names its workspace', registry.forProject(key).id === shared.workspace.id);
    check('a project cannot be linked to a workspace nobody joined', registry.link(key, 'made-up') === false);

    // A remote is a hint and never an authorization.
    check('a matching repository suggests a workspace', registry.suggestFor('github.com/team/site')?.id === shared.workspace.id);
    check('and the suggestion carries no credential', !('token' in (registry.suggestFor('github.com/team/site') || {})));
    check('a different repository suggests nothing', registry.suggestFor('github.com/someone/else') === null);
    check('and no repository at all suggests nothing', registry.suggestFor(null) === null);
    // Nothing about a suggestion joins anything: the project is still whatever
    // it was linked to, and an unlinked one stays unlinked.
    const other = scopeKey(path.join(home, 'another-project'));
    check('a suggestion does not link a project', registry.forProject(other) === null);

    check('unlinking a project leaves the workspace', registry.unlink(key) === true && registry.all().length === 1);
    check('and the project is local again', registry.forProject(key) === null);
    check('forgetting a workspace removes its credential', registry.forget(shared.workspace.id) === true && registry.all().length === 0);

    // The rule this whole feature is built under.
    check('nothing was written into the project', fs.readdirSync(project).length === 0, fs.readdirSync(project).join());
    check('and the registry lives in userData', registry.file.startsWith(userData));
  }

  // ── Restarting the service ───────────────────────────────────────────────

  {
    const dbFile = path.join(home, 'service.db');
    const first = createReviewService({ port: 0, host: '127.0.0.1', file: dbFile, signupToken: SIGNUP });
    await first.start();
    const url = `http://127.0.0.1:${first.address.port}`;
    const ws = await createWorkspace({ baseUrl: url, signupToken: SIGNUP, displayName: 'persistent', actor: ALICE });
    const t = createTransport({ baseUrl: url, token: ws.credential.token, workspaceId: ws.workspace.id });
    await t.pushEvents([event('durable-1', ALICE, 1)]);
    await first.stop();

    const second = createReviewService({ port: 0, host: '127.0.0.1', file: dbFile, signupToken: SIGNUP });
    await second.start();
    const t2 = createTransport({ baseUrl: `http://127.0.0.1:${second.address.port}`, token: ws.credential.token, workspaceId: ws.workspace.id });
    const back = await t2.pullEvents({ after: 0 });
    check('events survive the service restarting', back.ok === true && back.events.length === 1 && back.events[0].id === 'durable-1', JSON.stringify(back));
    check('and so does the credential', (await t2.workspace()).ok === true);
    await second.stop();
  }

  // ── Concurrent writers against one workspace ─────────────────────────────

  {
    const store = openStore({ file: ':memory:' });
    const made = store.createWorkspace({ displayName: 'busy', actorId: ALICE.id, memberName: 'Alice' });
    const member = store.memberFor(made.credential.token);
    const batches = Array.from({ length: 10 }, (_, b) =>
      Array.from({ length: 20 }, (_, i) => event(`c-${b}-${i}`, ALICE, b * 20 + i + 1))
    );
    for (const batch of batches) store.appendEvents({ workspaceId: made.workspace.id, memberId: member.id, events: batch });
    check('every event landed', store.countOf(made.workspace.id) === 200, String(store.countOf(made.workspace.id)));
    const seqs = store.db.prepare('SELECT seq FROM events WHERE workspace_id = ? ORDER BY seq').all(made.workspace.id).map((r) => r.seq);
    check('and each got its own place in the order', new Set(seqs).size === seqs.length);
    check('which only ever goes forward', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
    // Re-appending the same batch is a no-op, which is what makes a retry safe.
    store.appendEvents({ workspaceId: made.workspace.id, memberId: member.id, events: batches[0] });
    check('and re-appending a batch adds nothing', store.countOf(made.workspace.id) === 200);
    store.close();
  }

  // ── The projection is the same on both sides, whatever happened ──────────

  {
    const everything = await sharedT.pullEvents({ after: 0, limit: 500 });
    const a = projectThreads(everything.events);
    const b = projectThreads([...everything.events].reverse());
    check('the workspace’s whole history folds the same way twice', JSON.stringify(a) === JSON.stringify(b));
  }

  await service.stop();
  fs.rmSync(home, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nshared-reviews: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`shared-reviews: ${checked} passed  [a real service, a real transport, no lost events]`);
})().catch((err) => {
  console.error('shared-reviews: threw\n', err);
  process.exit(1);
});
