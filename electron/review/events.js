// What happened, in the order everybody agrees it happened in.
//
// A local review file could be a mutable list of threads because there was one
// writer. Two people cannot share a mutable blob: whoever writes last wins
// whole, and the other person's reply is gone with no record that it was ever
// made. So the shared thing is an APPEND-ONLY SET OF EVENTS, and a thread is
// what you get when you fold that set. Nothing is ever overwritten and nothing
// is ever merged — a set is unioned, which is an operation that cannot lose
// anything and does not care what order the network delivered in.
//
// THE ORDER RULE, which is the whole of the concurrency design:
//
//     sort by (lamport ascending, id ascending)
//
// `lamport` is a Lamport clock: every event an installation writes gets
// `max(every lamport it has seen) + 1`. That makes causality a fact rather
// than a guess — a reply written after seeing Alice's message always sorts
// after it, on every machine, whatever the wall clocks say. Concurrent events
// can collide on a number, and `id` breaks the tie: two UUIDs, compared as
// strings. Arbitrary, and that is the point — it has to be arbitrary the SAME
// WAY on both machines, and a uuid is the one field guaranteed to be present,
// unique and identical everywhere.
//
// Wall-clock time is carried and never ordered by. Two laptops disagree about
// what time it is; `createdAt` is for showing a person "2h ago" and for
// nothing else.
//
// WHY NOT A CRDT LIBRARY. The state being merged is a handful of
// last-writer-wins registers (status, colour, a message body) plus one grow-only
// set (the messages) plus tombstones. Those are the two simplest CRDTs there
// are, and writing them down explicitly is about eighty lines that can be read
// and tested. Pulling in a framework would be more code, not less, and would
// put the one thing this feature must be able to explain — why Bob sees what
// he sees — inside somebody else's abstraction.
//
// AUTHORISATION IS PART OF THE PROJECTION, not just of the door. A peer can
// send any bytes it likes, so "only your own words can be reworded" has to be
// a rule about which events COUNT, not merely which events this app will
// create. An edit of somebody else's message is dropped when the thread is
// rebuilt, on every machine, forever.

const crypto = require('node:crypto');

// The event vocabulary. Exactly the operations Visual Review already has —
// nothing here anticipates a workflow that does not exist yet.
const EVENT_TYPES = [
  'thread.created',
  'message.created',
  'message.edited',
  'message.deleted',
  'thread.resolved',
  'thread.deferred',
  'thread.reopened',
  'thread.deleted',
];

// Which of those a shared workspace will accept. Identical to the list above,
// named separately so that adding a local-only event type later is a decision
// somebody has to make on purpose.
const SHARED_EVENT_TYPES = EVENT_TYPES;

const MAX_ID = 100;
// One project's history. Reviews are written by hand at human speed, so this is
// a backstop against a loop or a hostile peer rather than a limit anybody meets.
const MAX_EVENTS = 50000;
// The largest event this will build or accept, serialized. An anchor with a
// full creation snapshot is a few KB; this leaves room and refuses a payload
// that is trying to be a file upload.
const MAX_EVENT_BYTES = 64 * 1024;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Compare two events the one way everything compares them.
 *
 * Exported because the service, the client and the tests must not each have
 * their own copy of this — two implementations of "which came first" is two
 * different projections, which is the exact bug this whole model exists to
 * make impossible.
 */
function compareEvents(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** The same set, in the order everybody folds it in. */
const orderEvents = (events) => [...events].sort(compareEvents);

/**
 * Union two event sets by id.
 *
 * Duplicate delivery is normal — a push that succeeded but whose answer was
 * lost comes back on the next pull — so arriving at an id already held is not
 * an error and not a conflict. The one already held wins, so a peer cannot
 * rewrite an event by resending it under the same id with different contents.
 */
function unionEvents(existing, incoming) {
  const byId = new Map();
  for (const e of existing || []) if (e && e.id) byId.set(e.id, e);
  let added = 0;
  for (const e of incoming || []) {
    if (!e || !e.id || byId.has(e.id)) continue;
    byId.set(e.id, e);
    added += 1;
  }
  return { events: orderEvents([...byId.values()]), added };
}

/** The next Lamport number for an installation that has seen these events. */
const nextLamport = (events) =>
  Math.max(0, ...(events || []).map((e) => (Number.isInteger(e?.lamport) ? e.lamport : 0))) + 1;

const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

/**
 * An event from anywhere — disk, an agent, another person's machine — checked
 * field by field.
 *
 * Null for anything unusable. Nothing here trusts its input: an event set is
 * the one structure in this app that arrives over a network from somebody
 * else's installation.
 */
function reviveEvent(raw) {
  if (!isPlainObject(raw)) return null;
  const id = str(raw.id, MAX_ID);
  const threadId = str(raw.threadId, MAX_ID);
  const actorId = str(raw.actorId, MAX_ID);
  const type = str(raw.type, 64);
  if (!id || !threadId || !actorId || !type) return null;
  if (!Number.isInteger(raw.lamport) || raw.lamport < 1) return null;
  const actorKind = raw.actorKind === 'agent' ? 'agent' : raw.actorKind === 'human' ? 'human' : null;
  if (!actorKind) return null;
  const event = {
    id,
    threadId,
    actorId,
    actorKind,
    // The name as it read when the event was written, carried on the event
    // itself. A shared thread must be readable without a directory of people:
    // "Alice" has to render on a machine that has never heard of Alice, and it
    // has to keep rendering after she leaves the workspace.
    actorName: str(raw.actorName, 60),
    // An unknown type is KEPT. A newer Stacki that grew an event type must not
    // have its events quietly discarded by an older one — that would turn a
    // version skew into permanent data loss the moment the older one synced.
    // The projection below ignores what it does not understand; the log does
    // not get to.
    type,
    lamport: raw.lamport,
    createdAt: Number.isInteger(raw.createdAt) && raw.createdAt >= 0 ? raw.createdAt : 0,
    payload: isPlainObject(raw.payload) ? raw.payload : {},
  };
  if (JSON.stringify(event).length > MAX_EVENT_BYTES) return null;
  return event;
}

/** Whether a decoded event is one this version of the projection understands. */
const isKnownType = (type) => EVENT_TYPES.includes(type);

/**
 * Build an event.
 *
 * `lamport` is passed in rather than read from a clock inside here, because
 * the clock belongs to the ledger that holds the events and there must be
 * exactly one of it.
 */
function makeEvent({ type, threadId, actor, payload = {}, lamport, at, id = null }) {
  return reviveEvent({
    id: id || crypto.randomUUID(),
    threadId,
    actorId: actor?.id || null,
    actorKind: actor?.kind || null,
    actorName: actor?.displayName || null,
    type,
    lamport,
    createdAt: at,
    payload,
  });
}

// --- the projection ----------------------------------------------------------
//
// Fold the ordered set into the read model the rest of the app already knows.
// Pure, and deliberately so: given the same events it must produce the same
// threads on Alice's machine and on Bob's, forever, with no reference to who
// is running it or when.

const STATUS_EVENTS = {
  'thread.resolved': 'resolved',
  'thread.deferred': 'deferred',
  'thread.reopened': 'open',
};

/**
 * Whether an edit event is allowed to change a message.
 *
 * The message's author, and only if both are people. Enforced here, in the
 * fold, so that a forged event is ignored by every reader rather than merely
 * refused by the one app that would not have sent it.
 */
const editApplies = (event, message) =>
  event.actorKind === 'human' && message.actorKind === 'human' && event.actorId === message.actorId;

/**
 * Whether a delete event is allowed to remove a message.
 *
 * Wider than editing on purpose, and unchanged from the local rule: a person
 * may prune their own words and an agent's replies to them. Nobody may delete
 * another person's words, and an agent may delete nothing at all.
 */
/**
 * Whether a delete event is allowed to remove a whole thread.
 *
 * Its author, and nobody else — with one exception: a review an AGENT created
 * may be deleted by any person, because an agent has no standing to keep a
 * note somebody does not want and cannot delete it itself.
 */
const deleteThreadApplies = (event, created) =>
  event.actorKind === 'human' &&
  (!created || created.actorKind === 'agent' || created.actorId === event.actorId);

const deleteApplies = (event, message) => {
  if (event.actorKind !== 'human') return false;
  if (message.actorKind === 'agent') return true;
  return message.actorId === event.actorId;
};

/**
 * Every thread the events describe.
 *
 * `bounds` are the store's own caps, passed in so that this file does not hold
 * a second opinion about how long a comment may be.
 */
function projectThreads(events, { bounds = {} } = {}) {
  const maxMessages = bounds.maxMessages || 200;
  const maxRefs = bounds.maxRefs || 10;

  const ordered = orderEvents(events || []);
  const threads = new Map();

  const threadOf = (id) => {
    let t = threads.get(id);
    if (!t) {
      t = {
        id,
        created: null, // the thread.created event, once one is seen
        deletedBy: null,
        messages: new Map(),
        statusEvent: null,
        deferEvents: [],
        reopenAt: null, // the ordering position of the newest reopen
        updatedAt: 0,
      };
      threads.set(id, t);
    }
    return t;
  };

  for (const event of ordered) {
    if (!isKnownType(event.type)) continue; // kept in the log, not understood here
    const t = threadOf(event.threadId);

    if (event.type === 'thread.created') {
      // The first one wins. A second thread.created for the same id is either
      // a duplicate or a peer trying to redefine an anchor after the fact, and
      // neither gets to change what the review is about.
      if (!t.created) t.created = event;
      continue;
    }

    // Everything else needs the thread to exist. An event that arrives before
    // its thread.created is held rather than dropped — out-of-order delivery
    // is ordinary — because the fold is over a sorted set and thread.created
    // always sorts first among a thread's events on the machine that made it.
    // A set missing its thread.created projects to nothing at all, below.

    if (event.type === 'thread.deleted') {
      // A person deletes their own review. Anyone else's attempt is ignored
      // here rather than only at the door: erasing somebody else's feedback is
      // the one destructive operation in this model, so the rule has to hold
      // against a peer that did not ask.
      if (deleteThreadApplies(event, t.created)) t.deletedBy = t.deletedBy || event;
      continue;
    }

    if (event.type === 'message.created') {
      const messageId = str(event.payload?.messageId, MAX_ID) || event.id;
      if (t.messages.has(messageId)) continue; // duplicate delivery
      t.messages.set(messageId, {
        id: messageId,
        actorId: event.actorId,
        actorKind: event.actorKind,
        actorName: event.actorName,
        body: str(event.payload?.body, bounds.maxBody || 4000) || '',
        createdAt: event.createdAt,
        editedAt: null,
        editEvent: null,
        deleteEvent: null,
        order: event,
      });
      t.updatedAt = Math.max(t.updatedAt, event.createdAt);
      continue;
    }

    if (event.type === 'message.edited') {
      const message = t.messages.get(str(event.payload?.messageId, MAX_ID));
      if (!message || !editApplies(event, message)) continue;
      // Last writer wins, where "last" is the order rule and not arrival. Two
      // laptops editing the same sentence produce one answer, the same answer
      // on both, and the losing edit is still in the log.
      if (message.editEvent && compareEvents(event, message.editEvent) <= 0) continue;
      const body = str(event.payload?.body, bounds.maxBody || 4000);
      if (!body) continue; // an edit to nothing is not an edit
      message.editEvent = event;
      message.body = body;
      message.editedAt = event.createdAt;
      t.updatedAt = Math.max(t.updatedAt, event.createdAt);
      continue;
    }

    if (event.type === 'message.deleted') {
      const message = t.messages.get(str(event.payload?.messageId, MAX_ID));
      if (!message || !deleteApplies(event, message)) continue;
      // A tombstone is terminal. It does not matter whether an edit sorts
      // after it: removed is removed, on every machine, whatever order the
      // two arrived in. Making delete beat edit unconditionally is what makes
      // "edit versus delete" have an answer at all rather than a coin toss.
      message.deleteEvent = message.deleteEvent || event;
      t.updatedAt = Math.max(t.updatedAt, event.createdAt);
      continue;
    }

    if (STATUS_EVENTS[event.type]) {
      if (!t.statusEvent || compareEvents(event, t.statusEvent) > 0) t.statusEvent = event;
      if (event.type === 'thread.deferred') t.deferEvents.push(event);
      if (event.type === 'thread.reopened' && (!t.reopenAt || compareEvents(event, t.reopenAt) > 0)) {
        t.reopenAt = event;
      }
      t.updatedAt = Math.max(t.updatedAt, event.createdAt);
      continue;
    }

  }

  const out = [];
  for (const t of threads.values()) {
    // No thread.created means the set does not describe a review yet — the
    // creating event has not arrived. Its other events are kept and this
    // becomes a thread the moment it does.
    if (!t.created || t.deletedBy) continue;
    const payload = isPlainObject(t.created.payload) ? t.created.payload : {};

    // In the order they were said, by the one rule — not by wall clock, which
    // two machines disagree about.
    const messages = [...t.messages.values()].sort((a, b) => compareEvents(a.order, b.order));

    // A review with nothing said in it is not a review, and two people each
    // deleting their own only message concurrently would otherwise produce
    // one. The earliest message survives its own tombstone — deterministic,
    // and it keeps the record readable rather than leaving a headless thread.
    const alive = messages.filter((m) => !m.deleteEvent);
    if (!alive.length && messages.length) {
      messages[0].deleteEvent = null;
    }

    const surviving = messages.filter((m) => !m.deleteEvent).slice(0, maxMessages);
    if (!surviving.length) continue;

    const status = t.statusEvent ? STATUS_EVENTS[t.statusEvent.type] : 'open';
    // The reason it is being put off, if it is still being put off.
    //
    // Two rules, and both are restatements of what the local ledger always
    // did. A deferral older than the newest reopen no longer describes
    // anything — reopening says the reason no longer applies. And a deferral
    // that carried no reason does not erase the one before it: deferring again
    // to add a link is not somebody withdrawing what they said.
    const liveDeferrals = t.deferEvents
      .filter((e) => !t.reopenAt || compareEvents(e, t.reopenAt) > 0)
      .filter((e) => str(e.payload?.reason, bounds.maxReason || 1000));
    const lastDeferral = liveDeferrals.length ? liveDeferrals[liveDeferrals.length - 1] : null;

    const refs = [];
    for (const e of t.deferEvents) {
      const ref = str(e.payload?.externalRef, bounds.maxRef || 500);
      if (ref && !refs.includes(ref) && refs.length < maxRefs) refs.push(ref);
    }

    out.push({
      id: t.id,
      // What the person who wrote it calls it. A hint, taken when it is free
      // on this machine and otherwise ignored — see the note on nicknames in
      // store.js.
      proposedNumber: Number.isInteger(payload.number) && payload.number > 0 ? payload.number : null,
      status,
      anchor: isPlainObject(payload.anchor) ? payload.anchor : null,
      creationContext: isPlainObject(payload.creationContext) ? payload.creationContext : {},
      // Null for every review written before provenance existed, and never
      // guessed at afterwards. See provenance.js.
      provenance: isPlainObject(payload.provenance) ? payload.provenance : null,
      // Who left it, and whether they were a person.
      author: {
        actorId: t.created.actorId,
        actorKind: t.created.actorKind,
        actorName: t.created.actorName,
      },
      messages: surviving.map((m) => ({
        id: m.id,
        actorId: m.actorId,
        actorKind: m.actorKind,
        actorName: m.actorName,
        // The old field, kept so that every existing reader — the panel, the
        // MCP schema, the pins — goes on working unchanged.
        authorType: m.actorKind,
        body: m.body,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
      })),
      messagesTotal: messages.filter((m) => !m.deleteEvent).length,
      deferredReason: lastDeferral ? str(lastDeferral.payload?.reason, bounds.maxReason || 1000) : null,
      externalRefs: refs,
      // Where the source stood when it was resolved, and who resolved it. Both
      // null unless the thread is resolved right now — a stamp from a
      // resolution that was later reopened describes nothing.
      resolvedAtSource:
        status === 'resolved' && isPlainObject(t.statusEvent?.payload?.resolvedAtSource)
          ? t.statusEvent.payload.resolvedAtSource
          : null,
      resolvedBy:
        status === 'resolved' && t.statusEvent
          ? { actorId: t.statusEvent.actorId, actorKind: t.statusEvent.actorKind, actorName: t.statusEvent.actorName }
          : null,
      createdAt: t.created.createdAt,
      updatedAt: Math.max(t.updatedAt, t.created.createdAt),
    });
  }

  // Oldest first, deterministically: the order threads were created in, by the
  // one rule. Callers sort for display; this is the canonical order.
  out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** The ids of every thread the set mentions, including ones since deleted. */
function threadIdsIn(events) {
  const ids = new Set();
  for (const e of events || []) if (e?.threadId) ids.add(e.threadId);
  return ids;
}

module.exports = {
  EVENT_TYPES,
  SHARED_EVENT_TYPES,
  MAX_EVENTS,
  MAX_EVENT_BYTES,
  MAX_ID,
  compareEvents,
  orderEvents,
  unionEvents,
  nextLamport,
  reviveEvent,
  makeEvent,
  isKnownType,
  projectThreads,
  threadIdsIn,
  editApplies,
  deleteApplies,
  deleteThreadApplies,
};
