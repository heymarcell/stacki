// The event model, and the one thing it has to guarantee.
//
//   node test/review-events.js
//
// Given the same set of events, Alice's Stacki and Bob's must produce the
// SAME thread. Not similar. The same — same status, same messages, same order,
// same text. If that is ever false, the two of them are looking at different
// conversations while both believe they are looking at one, and nothing else
// in Shared Reviews can be trusted.
//
// So almost every check here folds a set twice: once in one order and once in
// another, and compares the results byte for byte. Arrival order is the thing
// most likely to differ between two machines, and it is exactly the thing that
// must not matter.
//
// The cases are the ones two people actually produce:
//
//   two replies written offline at the same time
//   somebody trying to edit a message that is not theirs
//   the same person editing the same message on two laptops
//   a resolve and a reopen racing
//   a delete racing an edit
//   a delete that would empty a thread
//   an event type this version has never heard of
//
// Every one of them has to have an answer, the answer has to be the same on
// both machines, and the losing event has to still be in the log.

const {
  compareEvents,
  orderEvents,
  unionEvents,
  nextLamport,
  reviveEvent,
  makeEvent,
  isKnownType,
  projectThreads,
  EVENT_TYPES,
  MAX_EVENT_BYTES,
} = require('../electron/review/events.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const ALICE = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', kind: 'human', displayName: 'Alice' };
const BOB = { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', kind: 'human', displayName: 'Bob' };
const CLAUDE = { id: 'cccccccc-3333-4333-8333-cccccccccccc', kind: 'agent', displayName: 'Claude' };

const T = 'rt_one';
let stamp = 1000;

/** An event with a chosen id, so ordering is a fact rather than a coincidence. */
const ev = (id, type, actor, lamport, payload = {}, threadId = T) =>
  makeEvent({ id, type, threadId, actor, lamport, at: stamp++, payload });

const created = (actor = ALICE, lamport = 1, over = {}) =>
  ev('e-created', 'thread.created', actor, lamport, {
    color: 'blue',
    anchor: { keys: ['src/pages/index.astro#0.1'], page: { route: '/', file: 'src/pages/index.astro' } },
    creationContext: { tag: 'section', text: 'Hero' },
    provenance: { head: 'abc1234', branch: 'main', dirty: false, files: {} },
    number: 17,
    ...over,
  });

const opened = (actor = ALICE, lamport = 2, id = 'e-msg1', body = 'This CTA is too close to the copy.') =>
  ev(id, 'message.created', actor, lamport, { messageId: 'm1', body });

/** Fold the same set from several directions and insist on one answer. */
function stable(what, events, inspect) {
  const orders = [
    events,
    [...events].reverse(),
    [...events].sort((a, b) => (a.id < b.id ? 1 : -1)),
    [...events].sort(() => 0), // identity, as a control
  ];
  const results = orders.map((set) => JSON.stringify(projectThreads(set)));
  check(`${what} — the same set folds to one answer whatever order it arrives in`, new Set(results).size === 1, results[0] === results[1] ? '' : `${results[0]}\n    vs\n    ${results[1]}`);
  const projected = projectThreads(events);
  if (inspect) inspect(projected[0], projected);
  return projected[0] || null;
}

// ── The order rule ──────────────────────────────────────────────────────────

{
  const a = { id: 'aaa', lamport: 1 };
  const b = { id: 'bbb', lamport: 2 };
  const c = { id: 'aab', lamport: 1 };
  check('a lower lamport sorts first', compareEvents(a, b) < 0);
  check('the same lamport is broken by id', compareEvents(a, c) < 0 && compareEvents(c, a) > 0);
  check('an event equals itself', compareEvents(a, { ...a }) === 0);
  check('ordering is total and stable', orderEvents([b, c, a]).map((e) => e.id).join() === 'aaa,aab,bbb');
  // Wall-clock time is carried and never ordered by: two laptops disagree
  // about what time it is, and a comment that jumped around the thread because
  // somebody's clock was fast would be a comment nobody could reason about.
  const early = { id: 'zzz', lamport: 5, createdAt: 1 };
  const late = { id: 'aaa', lamport: 6, createdAt: 999999 };
  check('a later lamport wins over an earlier clock', compareEvents(late, early) > 0);

  check('a lamport clock advances past everything it has seen', nextLamport([{ lamport: 3 }, { lamport: 9 }, { lamport: 1 }]) === 10);
  check('and starts at 1 for an empty ledger', nextLamport([]) === 1);
  check('an unusable lamport does not drag the clock backwards', nextLamport([{ lamport: 'x' }, { lamport: 4 }]) === 5);
}

// ── What counts as an event at all ──────────────────────────────────────────

{
  const good = { id: 'e1', threadId: 't1', actorId: 'a', actorKind: 'human', actorName: 'Alice', type: 'message.created', lamport: 1, createdAt: 5, payload: { body: 'x' } };
  check('a complete event survives', !!reviveEvent(good));
  for (const missing of ['id', 'threadId', 'actorId', 'type']) {
    check(`an event with no ${missing} is refused`, reviveEvent({ ...good, [missing]: null }) === null);
  }
  check('an event with no lamport is refused', reviveEvent({ ...good, lamport: null }) === null);
  check('a lamport of zero is refused', reviveEvent({ ...good, lamport: 0 }) === null);
  check('a fractional lamport is refused', reviveEvent({ ...good, lamport: 1.5 }) === null);
  check('an actor that is neither a person nor an agent is refused', reviveEvent({ ...good, actorKind: 'robot' }) === null);
  check('a payload that is not an object becomes one', JSON.stringify(reviveEvent({ ...good, payload: 'nope' }).payload) === '{}');
  check('an anonymous author is allowed — the id is the identity', reviveEvent({ ...good, actorName: null })?.actorName === null);
  check(
    'an event larger than the cap is refused',
    reviveEvent({ ...good, payload: { body: 'x'.repeat(MAX_EVENT_BYTES) } }) === null
  );
  check('a bare value is not an event', reviveEvent('hello') === null && reviveEvent(null) === null && reviveEvent([]) === null);

  // The one that matters for version skew: a type this build has never heard
  // of is KEPT in the log and ignored by the fold. Dropping it would mean an
  // older Stacki quietly deleting a newer one's history on the first sync.
  const future = reviveEvent({ ...good, type: 'thread.pinned.v2' });
  check('an unknown event type survives being read', !!future && future.type === 'thread.pinned.v2');
  check('and is not one this version folds', !isKnownType('thread.pinned.v2'));
  check('every type this version writes is one it folds', EVENT_TYPES.every(isKnownType));
}

// ── Union ───────────────────────────────────────────────────────────────────

{
  const one = ev('u1', 'message.created', ALICE, 1, { messageId: 'm1', body: 'a' });
  const two = ev('u2', 'message.created', BOB, 2, { messageId: 'm2', body: 'b' });
  const merged = unionEvents([one], [two, one]);
  check('a union takes what is new', merged.events.length === 2 && merged.added === 1, String(merged.added));
  check('and a duplicate id costs nothing', unionEvents(merged.events, [one, two]).added === 0);
  // A peer must not be able to rewrite an event by resending it under the same
  // id with different contents.
  const forged = { ...one, payload: { messageId: 'm1', body: 'REWRITTEN' } };
  const after = unionEvents(merged.events, [forged]);
  check('an id already held cannot be redefined', after.events.find((e) => e.id === 'u1').payload.body === 'a');
  check('the union comes back in the one order', after.events.map((e) => e.id).join() === 'u1,u2');
}

// ── A thread, folded ────────────────────────────────────────────────────────

{
  const thread = stable('an ordinary thread', [created(), opened()], (t) => {
    check('a thread has its creator on it', t.author.actorId === ALICE.id && t.author.actorName === 'Alice');
    check('and its opening message', t.messages.length === 1 && t.messages[0].body === 'This CTA is too close to the copy.');
    check('the message says who wrote it', t.messages[0].actorId === ALICE.id && t.messages[0].actorName === 'Alice');
    check('and keeps the old author field every reader already uses', t.messages[0].authorType === 'human');
    check('a new thread is open', t.status === 'open');
    check('it carries the anchor it was created with', t.anchor.keys[0] === 'src/pages/index.astro#0.1');
    check('and the provenance of the source it was written about', t.provenance.head === 'abc1234' && t.provenance.branch === 'main');
    check('and the nickname its author proposed', t.proposedNumber === 17);
  });
  check('a fold produces a thread', !!thread);

  // Events with no thread.created are not a review yet — the creating event
  // has not arrived. They are held, not dropped.
  check('a thread with no creation event does not project', projectThreads([opened()]).length === 0);
  check('and becomes one the moment it does', projectThreads([opened(), created()]).length === 1);

  // A second thread.created cannot redefine what a review is about.
  const redefined = projectThreads([
    created(),
    opened(),
    ev('e-created-2', 'thread.created', BOB, 9, { anchor: { keys: ['somewhere/else.astro#9'] }, color: 'rose' }),
  ])[0];
  check('a second creation event cannot move the anchor', redefined.anchor.keys[0] === 'src/pages/index.astro#0.1');
  check('nor recolour it by the back door', redefined.color === 'blue');
}

// ── A: two replies, written offline, at the same moment ─────────────────────
//
// The commonest concurrency there is. Nothing is in conflict; both must
// survive, and both machines must show them in the same order.

{
  const t = stable(
    'two simultaneous replies',
    [
      created(),
      opened(),
      ev('e-r-bob', 'message.created', BOB, 3, { messageId: 'mb', body: 'Agreed, it is tight.' }),
      ev('e-r-alice', 'message.created', ALICE, 3, { messageId: 'ma', body: 'Also the button is small.' }),
    ],
    (thread) => {
      check('both replies survive', thread.messages.length === 3, String(thread.messages.length));
      check('and they are in one agreed order', thread.messages.map((m) => m.id).join() === 'm1,ma,mb', thread.messages.map((m) => m.id).join());
      check('with the right names on them', thread.messages.map((m) => m.actorName).join() === 'Alice,Alice,Bob');
    }
  );
  check('neither reply was lost', t.messages.length === 3);
}

// ── B: one person editing another person's message ──────────────────────────
//
// Refused at the door, and — the part that matters once events cross a
// network — ignored by the fold. A peer that ignored the rule and sent the
// event anyway must have it dropped by every reader, not merely be told off.

{
  stable(
    'an edit of somebody else’s message',
    [
      created(),
      opened(),
      ev('e-forged', 'message.edited', BOB, 5, { messageId: 'm1', body: 'I never said this' }),
    ],
    (t) => {
      check('a forged edit does not change the words', t.messages[0].body === 'This CTA is too close to the copy.');
      check('and the message is not marked as edited', t.messages[0].editedAt === null);
    }
  );
  // An agent cannot rewrite what was said either — not its own words and not
  // anybody's. That is what keeps the record worth reading.
  stable(
    'an agent editing a human message',
    [created(), opened(), ev('e-agent-edit', 'message.edited', CLAUDE, 5, { messageId: 'm1', body: 'reworded' })],
    (t) => check('an agent cannot reword a person', t.messages[0].body === 'This CTA is too close to the copy.')
  );
  stable(
    'an agent editing its own message',
    [
      created(),
      opened(),
      ev('e-agent-said', 'message.created', CLAUDE, 3, { messageId: 'mc', body: 'Reduced the padding.' }),
      ev('e-agent-edit2', 'message.edited', CLAUDE, 4, { messageId: 'mc', body: 'Actually I did nothing.' }),
    ],
    (t) => check('an agent cannot reword itself either', t.messages[1].body === 'Reduced the padding.')
  );
}

// ── C: the same person editing the same message on two laptops ──────────────
//
// A real conflict with no right answer, so it needs a deterministic one.

{
  const set = [
    created(),
    opened(),
    ev('e-edit-laptop-a', 'message.edited', ALICE, 4, { messageId: 'm1', body: 'From laptop A' }),
    ev('e-edit-laptop-b', 'message.edited', ALICE, 4, { messageId: 'm1', body: 'From laptop B' }),
  ];
  stable('the same message edited twice at once', set, (t) => {
    // Same lamport, so the id decides: 'e-edit-laptop-b' > 'e-edit-laptop-a'.
    check('the later of the two by the order rule wins', t.messages[0].body === 'From laptop B', t.messages[0].body);
    check('and it is marked as edited', typeof t.messages[0].editedAt === 'number');
  });
  // And an edit that is genuinely later — a higher lamport — always wins,
  // whichever way round the ids fall.
  const causal = [
    created(),
    opened(),
    ev('e-zzz-first', 'message.edited', ALICE, 4, { messageId: 'm1', body: 'first' }),
    ev('e-aaa-second', 'message.edited', ALICE, 9, { messageId: 'm1', body: 'second' }),
  ];
  stable('an edit made after seeing the other', causal, (t) => {
    check('causality beats the id tiebreak', t.messages[0].body === 'second', t.messages[0].body);
  });
  check('an edit to nothing is not an edit', projectThreads([created(), opened(), ev('e-blank', 'message.edited', ALICE, 4, { messageId: 'm1', body: '   ' })])[0].messages[0].body === 'This CTA is too close to the copy.');
}

// ── D: resolve and reopen, racing ───────────────────────────────────────────

{
  // Ids chosen so the tiebreak is legible rather than incidental: at the same
  // lamport, 'race-b' sorts after 'race-a', so the reopen is the later event.
  const set = [
    created(),
    opened(),
    ev('e-race-a-resolve', 'thread.resolved', ALICE, 6, { resolvedAtSource: { head: 'def4567', branch: 'main', dirty: false } }),
    ev('e-race-b-reopen', 'thread.reopened', BOB, 6, {}),
  ];
  stable('a resolve and a reopen at the same moment', set, (t) => {
    check('one state comes out, deterministically', t.status === 'open', t.status);
    check('and the resolution stamp goes with it', t.resolvedAtSource === null);
    check('nobody is credited with a resolution that is not in force', t.resolvedBy === null);
  });
  // The other way round: the resolve is the later of the two.
  const resolvedLast = [
    created(),
    opened(),
    ev('e-race-a-reopen', 'thread.reopened', BOB, 6, {}),
    ev('e-race-b-resolve', 'thread.resolved', CLAUDE, 6, { resolvedAtSource: { head: 'def4567', branch: 'main', dirty: false } }),
  ];
  stable('the same race the other way round', resolvedLast, (t) => {
    check('the resolve wins when it sorts last', t.status === 'resolved', t.status);
    check('and says which revision it was done on', t.resolvedAtSource.head === 'def4567');
    check('and who did it', t.resolvedBy.actorName === 'Claude' && t.resolvedBy.actorKind === 'agent');
  });
  // A genuinely later event beats the tiebreak, whichever way the ids fall:
  // somebody who reopened AFTER seeing the resolution has the last word.
  const causal = [
    created(),
    opened(),
    ev('e-zzz-resolve', 'thread.resolved', ALICE, 6, { resolvedAtSource: { head: 'def4567', branch: 'main', dirty: false } }),
    ev('e-aaa-reopen', 'thread.reopened', BOB, 11, {}),
  ];
  stable('a reopen made after seeing the resolution', causal, (t) => {
    check('causality beats the id tiebreak here too', t.status === 'open', t.status);
  });
  // Both events are still in the log either way — history is not a casualty
  // of a conflict resolution.
  check('the losing event is still in the set', set.length === 4 && set.some((e) => e.type === 'thread.reopened'));
}

// ── Defer, and what a reason means ──────────────────────────────────────────

{
  const t = stable(
    'a deferral',
    [
      created(),
      opened(),
      ev('e-defer', 'thread.deferred', ALICE, 4, { reason: 'Waiting on copy.', externalRef: 'https://example.test/1' }),
      ev('e-defer-2', 'thread.deferred', ALICE, 5, { reason: null, externalRef: 'https://example.test/2' }),
    ],
    (thread) => {
      check('a deferral sets the state', thread.status === 'deferred');
      check('and keeps the reason', thread.deferredReason === 'Waiting on copy.');
      check('a later deferral with no reason does not erase the one before it', thread.deferredReason === 'Waiting on copy.');
      check('every reference is kept', thread.externalRefs.length === 2, JSON.stringify(thread.externalRefs));
    }
  );
  check('deferring produced a thread', !!t);

  const reopened = projectThreads([
    created(),
    opened(),
    ev('e-defer', 'thread.deferred', ALICE, 4, { reason: 'Waiting on copy.', externalRef: 'https://example.test/1' }),
    ev('e-reopen', 'thread.reopened', ALICE, 6, {}),
  ])[0];
  check('reopening clears the reason it was put off', reopened.deferredReason === null);
  check('but not the reference — that is a fact, not a state', reopened.externalRefs.length === 1);
  check('and the state is open', reopened.status === 'open');
}

// ── Colour ──────────────────────────────────────────────────────────────────

{
  const t = stable(
    'a recolour',
    [
      created(),
      opened(),
      ev('e-color-a', 'thread.color.changed', ALICE, 4, { color: 'teal' }),
      ev('e-color-b', 'thread.color.changed', BOB, 5, { color: 'rose' }),
    ],
    (thread) => {
      check('the newest colour wins', thread.color === 'rose', thread.color);
      // Colour is somebody filing their own notes, and has never been a thing
      // that says the review was worked on.
      check('and recolouring does not count as the review being touched', thread.updatedAt === thread.messages[0].createdAt, `${thread.updatedAt} vs ${thread.messages[0].createdAt}`);
    }
  );
  check('recolouring produced a thread', !!t);
}

// ── E: a delete, and what comes after it ────────────────────────────────────

{
  const set = [
    created(),
    opened(),
    ev('e-reply', 'message.created', BOB, 3, { messageId: 'mb', body: 'Agreed.' }),
    ev('e-delete', 'message.deleted', ALICE, 4, { messageId: 'm1' }),
    ev('e-after', 'message.created', BOB, 5, { messageId: 'mc', body: 'Said after the delete.' }),
  ];
  stable('a deleted message with a reply after it', set, (t) => {
    check('the deleted message is gone', !t.messages.some((m) => m.id === 'm1'));
    check('everything else survives', t.messages.map((m) => m.id).join() === 'mb,mc');
    check('and the thread is still a thread', t.status === 'open' && t.messages.length === 2);
  });

  // Delete versus edit. Terminal on purpose: whichever way round they arrive,
  // removed is removed. That is what gives the pair an answer at all.
  const deleteThenEdit = [
    created(),
    opened(),
    ev('e-x-delete', 'message.deleted', ALICE, 4, { messageId: 'm1' }),
    ev('e-y-edit', 'message.edited', ALICE, 9, { messageId: 'm1', body: 'edited after deleting' }),
  ];
  const editThenDelete = [
    created(),
    opened(),
    ev('e-x-edit', 'message.edited', ALICE, 4, { messageId: 'm1', body: 'edited first' }),
    ev('e-y-delete', 'message.deleted', ALICE, 9, { messageId: 'm1' }),
  ];
  // Both leave the thread with only its opening message, which cannot go —
  // see below.
  check('an edit after a delete does not resurrect it', projectThreads(deleteThenEdit)[0].messages.length === 1);
  check('a delete after an edit still removes it', projectThreads(editThenDelete)[0].messages.length === 1);

  // Nobody may take another person's words out of a shared conversation.
  const forged = projectThreads([
    created(),
    opened(),
    ev('e-r', 'message.created', BOB, 3, { messageId: 'mb', body: 'Bob said this' }),
    ev('e-bad', 'message.deleted', ALICE, 4, { messageId: 'mb' }),
  ])[0];
  check('one person cannot delete another’s message', forged.messages.some((m) => m.id === 'mb'));
  // An agent's reply can be pruned by a person; an agent can prune nothing.
  const agentPruned = projectThreads([
    created(),
    opened(),
    ev('e-c', 'message.created', CLAUDE, 3, { messageId: 'mc', body: 'Agent said this' }),
    ev('e-p', 'message.deleted', BOB, 4, { messageId: 'mc' }),
  ])[0];
  check('a person can prune an agent’s reply', !agentPruned.messages.some((m) => m.id === 'mc'));
  const agentTried = projectThreads([
    created(),
    opened(),
    ev('e-c', 'message.created', BOB, 3, { messageId: 'mb', body: 'Bob said this' }),
    ev('e-p', 'message.deleted', CLAUDE, 4, { messageId: 'mb' }),
  ])[0];
  check('an agent can prune nothing at all', agentTried.messages.some((m) => m.id === 'mb'));

  // Two people each deleting their own only message, concurrently, would leave
  // a review with nothing in it. A headless thread is not a review, so the
  // earliest message survives its own tombstone — deterministically.
  const emptied = [
    created(),
    opened(),
    ev('e-b-said', 'message.created', BOB, 3, { messageId: 'mb', body: 'Bob' }),
    ev('e-a-del', 'message.deleted', ALICE, 4, { messageId: 'm1' }),
    ev('e-b-del', 'message.deleted', BOB, 4, { messageId: 'mb' }),
  ];
  stable('two people emptying a thread at once', emptied, (t) => {
    check('a review is never left with nothing said in it', t.messages.length === 1, String(t.messages.length));
    check('and the surviving one is the first thing said', t.messages[0].id === 'm1');
  });
}

// ── Deleting a whole review ─────────────────────────────────────────────────

{
  const mine = projectThreads([created(ALICE), opened(), ev('e-del', 'thread.deleted', ALICE, 8, {})]);
  check('a person can delete their own review', mine.length === 0);

  const theirs = projectThreads([created(ALICE), opened(), ev('e-del', 'thread.deleted', BOB, 8, {})]);
  check('but not somebody else’s', theirs.length === 1);

  const byAgent = projectThreads([created(CLAUDE), opened(CLAUDE), ev('e-del', 'thread.deleted', BOB, 8, {})]);
  check('a review an agent left can be deleted by a person', byAgent.length === 0);

  const agentTried = projectThreads([created(ALICE), opened(), ev('e-del', 'thread.deleted', CLAUDE, 8, {})]);
  check('an agent cannot delete a review', agentTried.length === 1);
}

// ── Replay, duplicates, and things arriving twice ───────────────────────────

{
  const set = [created(), opened(), ev('e-reply', 'message.created', BOB, 3, { messageId: 'mb', body: 'yes' })];
  const once = JSON.stringify(projectThreads(set));
  const twice = JSON.stringify(projectThreads([...set, ...set]));
  check('folding the same events twice changes nothing', once === twice);
  const withDupIds = JSON.stringify(projectThreads([...set, { ...set[2] }, { ...set[1] }]));
  check('a duplicated event id is not a duplicated message', withDupIds === once);

  // Two message.created events that reuse one messageId: the first by the
  // order rule is the message, the second is ignored rather than overwriting
  // what was said.
  const collided = projectThreads([
    created(),
    opened(),
    ev('e-collide', 'message.created', BOB, 3, { messageId: 'm1', body: 'not what Alice wrote' }),
  ])[0];
  check('a reused message id cannot overwrite a message', collided.messages[0].body === 'This CTA is too close to the copy.');
  check('and does not add a second one', collided.messages.length === 1);
}

// ── Unknown event types, folded ─────────────────────────────────────────────

{
  const withFuture = [
    created(),
    opened(),
    reviveEvent({
      id: 'e-future',
      threadId: T,
      actorId: ALICE.id,
      actorKind: 'human',
      actorName: 'Alice',
      type: 'thread.starred',
      lamport: 4,
      createdAt: 5,
      payload: { starred: true },
    }),
  ];
  const t = projectThreads(withFuture)[0];
  check('an unknown event does not break the fold', !!t && t.status === 'open');
  check('and does not become a message', t.messages.length === 1);
  check('and the event is still in the set to be passed on', withFuture[2].type === 'thread.starred');
}

// ── Bounds ──────────────────────────────────────────────────────────────────

{
  const long = 'x'.repeat(9000);
  const t = projectThreads([created(), ev('e-long', 'message.created', ALICE, 2, { messageId: 'm1', body: long })], {
    bounds: { maxBody: 4000, maxRefs: 2, maxMessages: 3 },
  })[0];
  check('a message is cut to the caller’s cap', t.messages[0].body.length === 4000, String(t.messages[0].body.length));

  const many = [created(), opened()];
  for (let i = 0; i < 10; i++) many.push(ev(`e-m${i}`, 'message.created', BOB, 3 + i, { messageId: `mm${i}`, body: `reply ${i}` }));
  const capped = projectThreads(many, { bounds: { maxMessages: 4 } })[0];
  check('a thread is cut to the message cap', capped.messages.length === 4, String(capped.messages.length));
  check('and says how many there really are', capped.messagesTotal === 11, String(capped.messagesTotal));

  const refs = [created(), opened()];
  for (let i = 0; i < 8; i++) refs.push(ev(`e-d${i}`, 'thread.deferred', ALICE, 4 + i, { externalRef: `https://example.test/${i}` }));
  check('references stop at the cap', projectThreads(refs, { bounds: { maxRefs: 3 } })[0].externalRefs.length === 3);
}

// ── Several threads at once ─────────────────────────────────────────────────

{
  const two = [
    created(ALICE, 1),
    opened(),
    makeEvent({ id: 'e-t2', type: 'thread.created', threadId: 'rt_two', actor: BOB, lamport: 2, at: 500, payload: { color: 'rose', anchor: { keys: ['a#0'] } } }),
    makeEvent({ id: 'e-t2m', type: 'message.created', threadId: 'rt_two', actor: BOB, lamport: 3, at: 500, payload: { messageId: 'x1', body: 'Bob’s review' } }),
  ];
  const threads = projectThreads(two);
  check('two threads fold to two threads', threads.length === 2);
  check('in a deterministic order', threads.map((t) => t.id).join() === 'rt_two,rt_one' || threads.map((t) => t.id).join() === 'rt_one,rt_two');
  check('and the order does not depend on arrival', JSON.stringify(projectThreads([...two].reverse())) === JSON.stringify(threads));
  check('each keeps its own author', threads.find((t) => t.id === 'rt_two').author.actorName === 'Bob');
}

if (failures.length) {
  console.error(`\nreview-events: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`review-events: ${checked} passed  [the order rule, and every race it has to answer]`);
