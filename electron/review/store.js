// The reviews, and the file they live in.
//
// Two stores now describe what Stacki is doing, and they are opposites. The
// MCP context store is a photograph: one snapshot, replaced whenever the
// canvas moves, worth nothing a second after it is taken. This one is a
// ledger. A comment written on Tuesday has to still be there on Friday, after
// a crash, after a branch switch, after the element it was about was deleted.
// So none of the context store's shape is reused here beyond its clamps, and
// review state is deliberately never put into it.
//
// Where it lives: one JSON file per project, under the app's own userData —
// NOT in the project. A website repository that grows a `.stacki/` folder
// because somebody left a note on a heading is a website repository that has
// been vandalised by its editor. The only files this feature ever writes into
// a project are the ones a coding agent edits on purpose.
//
// Branch scoping, decided once and written down: reviews are keyed by PROJECT,
// never by branch, and the branch a review was written on is recorded on it.
// The alternative — a file per branch — loses your review list the moment you
// check something out, and duplicates every review across a merge. What the
// requirement actually asks for is that a review does not silently point at
// unrelated code on another branch, and that is what the anchor is for: the
// markup moved or vanished, so the anchor reports `orphaned` and says so. The
// review stays readable, the branch it came from is on it, and nothing is
// synchronised across branches.
//
// Writing: in memory is the truth, the file is a copy of it. Every mutation
// updates memory, bumps a revision, and schedules a write; writes are
// serialised through one promise chain, so two mutations arriving at once
// (the panel and an agent, which is the ordinary case) cannot read the same
// old JSON and overwrite each other. The write itself is tmp-then-rename, so a
// quit in the middle of one leaves the previous file intact rather than half
// of the new one.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { str, int } = require('../mcp/contextStore');
const { leafKey, fileOfKey } = require('./anchor');

const VERSION = 1;

// Bounds. Every one of these is a user-controlled string that ends up in an
// agent's context window, and one pathological review must not be able to cost
// somebody their conversation.
const MAX_BODY = 4000;
const MAX_REASON = 1000;
const MAX_REF = 500;
const MAX_REFS = 10;
const MAX_MESSAGES = 200;
const MAX_THREADS = 2000;
const EXCERPT = 200;
// How many messages a full read carries. A thread may hold 200, each up to
// MAX_BODY — 800KB for one review, and a 50-review page of them is tens of
// megabytes of somebody's context window. The newest are the ones being acted
// on, and the original is in the summary's `message` either way, so a long
// thread comes back as its tail plus a count of what was left out.
const MAX_DETAIL_MESSAGES = 50;

// How large one `get_comments` answer may get.
//
// Messages are capped per review, but nothing capped the response: 200 reviews
// of maximum-length threads is tens of megabytes, and it arrives in somebody's
// context window whether they wanted it or not. 512KB is far more review than
// anyone reads in one go and small enough to be harmless — and the normal
// workflow is a compact list, then focus one, then look at that one closely.
const MAX_RESPONSE_BYTES = 512 * 1024;

const STATUSES = ['open', 'resolved', 'deferred'];
// The colours a comment can be. A fixed set rather than a free picker: these
// have to stay legible as a 22px marker over an arbitrary website, and a
// palette somebody can only choose badly from is not a choice worth offering.
//
// Colour is the person's own way of grouping their notes — it says nothing
// about state. State is the marker's SHAPE: filled is open, hollow is deferred,
// a dashed ring is an anchor Stacki can no longer find. That split is the whole
// point, because a pin has to answer "is this done" before it answers anything
// else, and it has to answer it without a legend.
const COLORS = ['blue', 'violet', 'teal', 'green', 'amber', 'rose'];
const DEFAULT_COLOR = 'blue';
const ANCHOR_STATES = ['attached', 'orphaned'];
const AUTHORS = ['human', 'agent'];
const ACTIONS = ['create', 'reply', 'resolve', 'defer', 'reopen'];

const fail = (code, message) => ({ ok: false, code, message });

const body = (v, max) => {
  if (typeof v !== 'string') return null;
  const text = v.replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

const authorOf = (v) => (AUTHORS.includes(v) ? v : 'human');

/**
 * Which file a project's reviews live in.
 *
 * Keyed on the resolved real path, so a project reached through a symlink and
 * the same project reached directly are one project rather than two review
 * lists that never see each other.
 */
function scopeKey(projectPath) {
  if (!projectPath) return null;
  let resolved = path.resolve(projectPath);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* the folder may have gone; the resolved path is still a stable key */
  }
  return crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 16);
}

const fileFor = (userDataPath, projectPath) =>
  path.join(userDataPath, 'reviews', `${scopeKey(projectPath)}.json`);

// --- reading what is on disk ------------------------------------------------

/** A thread from disk, checked field by field. Null for anything unusable. */
function reviveThread(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 100);
  if (!id) return null;
  const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : null;
  if (!anchor || !Array.isArray(anchor.keys) || !anchor.keys.length) return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((m) => {
      const text = body(m?.body, MAX_BODY);
      if (!text) return null;
      return {
        id: str(m.id, 100) || `rm_${crypto.randomUUID()}`,
        authorType: authorOf(m.authorType),
        body: text,
        createdAt: int(m.createdAt) || 0,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_MESSAGES);
  // A thread with nothing said in it is not a review.
  if (!messages.length) return null;
  return {
    id,
    // The short handle a person says out loud. The uuid is the identity; this
    // is the name — see `nextNumber` below.
    number: Number.isInteger(raw.number) && raw.number > 0 ? raw.number : null,
    color: COLORS.includes(raw.color) ? raw.color : DEFAULT_COLOR,
    status: STATUSES.includes(raw.status) ? raw.status : 'open',
    anchorState: ANCHOR_STATES.includes(raw.anchorState) ? raw.anchorState : 'attached',
    anchor,
    creationContext: raw.creationContext && typeof raw.creationContext === 'object' ? raw.creationContext : {},
    messages,
    deferredReason: body(raw.deferredReason, MAX_REASON),
    externalRefs: (Array.isArray(raw.externalRefs) ? raw.externalRefs : [])
      .map((r) => body(r, MAX_REF))
      .filter(Boolean)
      .slice(0, MAX_REFS),
    createdAt: int(raw.createdAt) || messages[0].createdAt,
    updatedAt: int(raw.updatedAt) || messages[messages.length - 1].createdAt,
  };
}

/**
 * Read the file, and be specific about what was wrong with it.
 *
 * Three outcomes that are not "here are your reviews", and each wants
 * different behaviour:
 *
 *   missing    — the ordinary first run. Empty, writable.
 *   unreadable — malformed JSON, or a shape that is not a review file. The
 *                file is moved aside rather than overwritten: it is the only
 *                copy of somebody's review history, and a parse error is not
 *                a licence to delete it.
 *   newer      — written by a later Stacki. Nothing is moved and nothing is
 *                written; an older app quietly rewriting a newer file in the
 *                old format is how review history gets destroyed for real.
 */
/** The fingerprint of a ledger's bytes. Null for "there is no file". */
const digest = (text) => (text == null ? null : crypto.createHash('sha1').update(text).digest('hex'));

function loadFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { threads: [], nextNumber: 1, digest: null, writable: true, problem: null };
    return { threads: [], nextNumber: 1, digest: null, writable: false, problem: { kind: 'unreadable', detail: err.message } };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { threads: [], nextNumber: 1, digest: null, writable: true, problem: { kind: 'corrupt', detail: err.message, quarantine: true } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { threads: [], nextNumber: 1, digest: null, writable: true, problem: { kind: 'corrupt', detail: 'not an object', quarantine: true } };
  }
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version < 1) {
    return { threads: [], nextNumber: 1, digest: null, writable: true, problem: { kind: 'corrupt', detail: `version ${parsed.version}`, quarantine: true } };
  }
  if (version > VERSION) {
    return {
      threads: [],
      nextNumber: 1,
      digest: null,
      writable: false,
      problem: { kind: 'newer', detail: `this file was written by a newer Stacki (version ${version})` },
    };
  }
  if (!Array.isArray(parsed.threads)) {
    return { threads: [], nextNumber: 1, digest: null, writable: true, problem: { kind: 'corrupt', detail: 'threads is not a list', quarantine: true } };
  }
  const threads = parsed.threads.map(reviveThread).filter(Boolean);
  const dropped = parsed.threads.length - threads.length;
  return {
    threads,
    // What the file said when we read it. Any later write compares against
    // this to find out whether another Stacki has been here since.
    digest: digest(text),
    // The high-water mark, as the last write left it. Deleting #3 must not free
    // #3 up for the next comment — an agent told "fix #3" before a restart and
    // acting after one would otherwise act on a different review. Derived from
    // the surviving threads it would do exactly that, so it is written down.
    nextNumber: Number.isInteger(parsed.nextNumber) && parsed.nextNumber > 0 ? parsed.nextNumber : 1,
    writable: true,
    // Some threads survived and some did not: worth saying, not worth
    // refusing over. The readable ones are somebody's actual review.
    problem: dropped ? { kind: 'partial', detail: `${dropped} unreadable thread(s) dropped` } : null,
  };
}

/** Move a file out of the way under a name that says what it is. */
function quarantine(file, stamp) {
  const moved = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, moved);
    return moved;
  } catch {
    return null;
  }
}

// How long a lock may be held before it is presumed abandoned. A write is
// microseconds; anything approaching this is a Stacki that died holding it, and
// a ledger nobody can ever write to again is worse than a rare stolen lock.
// How long a lock with nobody's name on it may sit before it is assumed to be
// the leftovers of a process that died.
const LOCK_STALE_MS = 10_000;
// And how long one whose owner still answers may sit. This is a backstop for a
// pid that got recycled, not a timeout for honest work: the lock is held for a
// read, a write and a rename, so a Stacki that has held it for a minute is not
// coming back.
const LOCK_ABANDONED_MS = 60_000;
const LOCK_TRIES = 100;
const LOCK_WAIT_MS = 10;

/** Sleep without a promise — the write path is synchronous on purpose. */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable; spin briefly instead */
    const until = Date.now() + ms;
    while (Date.now() < until);
  }
}

/**
 * Take the ledger's lock, or answer null.
 *
 * `mkdir` is the atomic primitive here: it either creates the directory or
 * fails with EEXIST, with no window between the two. That is what makes this a
 * lock rather than a check — two processes cannot both believe they hold it,
 * which is exactly the failure a stat-then-write has.
 */
/** Whether a process is still there to be waited for. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // It exists but belongs to somebody else. Still a reason to wait.
    return err.code === 'EPERM';
  }
}

/**
 * Whether a lock somebody else is holding can be taken away from them.
 *
 * Age alone is not the question, and this is the part that used to be wrong.
 * A lock is held for a read, a write and a rename — microseconds — so one that
 * is ten seconds old is almost certainly abandoned. Almost. A process that was
 * suspended, stopped at a breakpoint, or on a laptop that went to sleep mid
 * write is still going to finish that write when it wakes up, and reaping its
 * lock puts two writers inside the one section this whole file exists to keep
 * to one. That is the silent-overwrite bug, reintroduced through the back door.
 *
 * So the owner is asked about first. A pid that no longer exists is a crash,
 * and its lock goes immediately rather than after ten seconds of waiting. A pid
 * that still answers is given room. Age remains, as a backstop for the two
 * cases a pid cannot cover: a crash between taking the lock and writing the
 * name into it, and a pid that has since been handed to somebody else.
 *
 * The pid is meaningful because the ledger lives in this machine's own
 * application-support directory. It is not a lock for a shared drive and does
 * not pretend to be one.
 */
function reapable(lock) {
  let age;
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    // Released while we were looking at it; there is nothing to reap and the
    // next mkdir is the one that matters.
    return true;
  }
  let pid = null;
  try {
    pid = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim()) || null;
  } catch {
    /* no name on it — fall back to age, which is the rule this always had */
  }
  if (pid === null) return age > LOCK_STALE_MS;
  if (!alive(pid)) return true;
  return age > LOCK_ABANDONED_MS;
}

function acquireLock(file) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    try {
      fs.mkdirSync(lock);
      // Whose it is, so somebody finding it later can ask whether waiting is
      // pointless. Best effort: a lock with no name still works, it is just
      // reaped on age alone.
      try {
        fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
      } catch {
        /* the lock is held either way */
      }
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      if (reapable(lock)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      pause(LOCK_WAIT_MS);
    }
  }
  return null;
}

const releaseLock = (lock) => {
  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
};

/**
 * Write, or leave the previous file exactly as it was.
 *
 * rename(2) is atomic within a filesystem, so a reader never sees half a file
 * and a crash mid-write costs the newest change rather than the whole history.
 * The fsync before it is what makes that true after a power cut rather than
 * only after a process death.
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* some filesystems refuse fsync; the rename below is still atomic */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// --- the store ---------------------------------------------------------------

/**
 * Open (or start) the review ledger for one project.
 *
 * `now` and `newId` are injected so the whole of this file can be tested
 * against fixed timestamps and predictable ids.
 */
function createReviewStore({ file, projectPath = null, now = Date.now, newId, onChange } = {}) {
  if (!file) throw new Error('a review store needs a file to live in');
  const id = newId || (() => crypto.randomUUID());

  let threads = [];
  let writable = true;
  let problem = null;
  // The next short number.
  //
  // A uuid is the right identity and the wrong name: nobody says "resolve
  // rt_ff6a0aab". So every review also gets a small integer, unique within the
  // project and never reused — the number on the pin, the number in the list,
  // and the thing a person can type at an agent. Taken from the high-water
  // mark rather than the count, so deleting #2 does not make the next one #2.
  let nextNumber = 1;
  // The bytes this store believes are on disk. Any write that finds something
  // else there is a write on top of another Stacki's work.
  let owned = null;
  // Counts CHANGES, like the context store's does — so a UI can ask "is there
  // anything new" without diffing, and a read can never make one happen.
  let revision = 0;

  /**
   * Become whatever the file says, discarding whatever was held before.
   *
   * Used to open the ledger, and used again when a write is refused — see
   * `persist`. Both are the same operation: the file is the truth and this is
   * a view of it.
   */
  function readFresh() {
    const loaded = loadFile(file);
    threads = loaded.threads;
    writable = loaded.writable;
    problem = loaded.problem || null;
    owned = loaded.digest;
    if (problem?.quarantine) {
      const moved = quarantine(file, now());
      problem = { ...problem, movedTo: moved, quarantine: undefined };
    }
    // Whichever is higher: what the last write recorded, or one past the
    // highest number still present. The recorded value is what makes a deleted
    // number stay dead across a restart; the scan is the floor for a file
    // written by an older Stacki, or one somebody edited by hand.
    nextNumber = Math.max(loaded.nextNumber || 1, threads.reduce((max, t) => Math.max(max, t.number || 0), 0) + 1);
    // A review written before numbering gets one now, oldest first, so the
    // order people see matches the order they wrote them. A number that somehow
    // appears twice is treated the same way: "#3" has to name exactly one
    // review, so the later of the two is renumbered rather than left ambiguous.
    const seen = new Set();
    const needsOne = [];
    for (const t of [...threads].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!t.number || seen.has(t.number)) needsOne.push(t);
      else seen.add(t.number);
    }
    if (needsOne.length) {
      for (const t of needsOne) t.number = nextNumber++;
      threads = [...threads];
    }
  }

  readFresh();

  const snapshotText = () =>
    JSON.stringify({ version: VERSION, projectPath, nextNumber, threads }, null, 2);

  /**
   * Put the current state on disk, unless somebody else got there first.
   *
   * Two Stackis can have the same project open, and each holds its own copy of
   * the ledger. Writing is replacing the whole file, so without this the second
   * one to write silently erases the first one's reviews and hands their
   * numbers out again.
   *
   * The compare and the write happen inside one lock, which is what makes this
   * safe rather than merely unlikely: check-then-write with no lock lets both
   * processes read the same file and then overwrite each other. Under the lock,
   * the loser sees a ledger it does not recognise and refuses.
   *
   * Refusing is deliberate. Merging two review histories automatically is a way
   * to get both of them wrong; keeping the newer file and saying so leaves the
   * person with something true.
   */
  function commit() {
    const lock = acquireLock(file);
    if (!lock) return { kind: 'write_failed', detail: 'another Stacki is holding the review file' };
    try {
      let current = null;
      try {
        current = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (digest(current) !== owned) {
        // Somebody else has written since we loaded. Theirs is newer; ours is
        // stale by definition, so it does not go over the top of it.
        return {
          kind: 'foreign_write',
          detail: 'another Stacki changed these comments first',
        };
      }
      const text = snapshotText();
      writeAtomic(file, text);
      owned = digest(text);
      return null;
    } catch (err) {
      console.warn('[stacki] could not save reviews:', err.message);
      return { kind: 'write_failed', detail: err.message };
    } finally {
      releaseLock(lock);
    }
  }

  /**
   * Save the mutation that just happened, or undo it.
   *
   * This runs INSIDE the mutation, before it answers, and that is the whole
   * point. The write used to be scheduled: a mutation changed memory, returned
   * `ok: true`, and a later commit discovered somebody else had written the
   * file and quietly refused. An agent had been told a review was resolved
   * when nothing would remember it, and `get_comments` from this window
   * reported the resolution as though it were a fact. "It worked" has to mean
   * "it is on disk", and the only way for one call to promise that is to do it.
   *
   * When the write is refused the change does not stay in memory as a ghost.
   * The file is re-read, which either picks up the other Stacki's newer list
   * (a foreign write — theirs won, and this window now shows theirs) or puts
   * back exactly what was there before (a failed write — rename(2) is atomic,
   * so the old file is intact). Either way this store ends up describing what
   * is actually on disk, and the caller is told, in the answer to the call it
   * made, that its change did not happen.
   *
   * The reviews are not merged. Two histories combined automatically is a way
   * to get both of them wrong; the newer file wins whole and the person is told
   * to look at it.
   */
  function persist() {
    const trouble = commit();
    if (!trouble) return { ok: true };
    const stale = threads;
    readFresh();
    if (trouble.kind === 'foreign_write') {
      return fail(
        'foreign_write',
        'Another Stacki changed these comments first, so this change was not saved. ' +
          'Stacki has reloaded their list — read it and, if it still applies, do this again.'
      );
    }
    // Nothing landed and nothing was taken away either; the file is as it was.
    // If it could not even be re-read the store is now read-only and says so,
    // which is the honest end of a disk that has stopped answering.
    if (!writable && threads.length === 0 && stale.length) {
      problem = problem || { kind: 'write_failed', detail: trouble.detail };
    }
    return fail('write_failed', `These comments could not be saved: ${trouble.detail}`);
  }

  /**
   * A mutation happened. Save it, tell anybody listening, and answer whether
   * it is real.
   */
  function changed() {
    revision += 1;
    const saved = persist();
    try {
      onChange?.(revision);
    } catch {
      /* a listener that throws must not take the mutation with it */
    }
    return saved;
  }

  /**
   * A review by whatever it was called.
   *
   * The uuid, or the short number with or without a hash — because the number
   * is what a person reads off a pin and types at an agent, and an agent that
   * could only take the uuid would make them go and look it up.
   */
  const find = (ref) => {
    if (ref == null) return null;
    const text = String(ref).trim();
    if (!text) return null;
    const byId = threads.find((t) => t.id === text);
    if (byId) return byId;
    const n = Number(text.replace(/^#/, ''));
    if (!Number.isInteger(n) || n <= 0) return null;
    return threads.find((t) => t.number === n) || null;
  };

  const message = (text, authorType, at) => ({
    id: `rm_${id()}`,
    authorType: authorOf(authorType),
    body: text,
    createdAt: at,
  });

  /**
   * Every mutation an agent can make, and every one the panel makes, through
   * one door. Deleting is not here — see `remove`.
   */
  function apply(input) {
    const req = input && typeof input === 'object' ? input : {};
    const action = req.action;
    if (!ACTIONS.includes(action)) {
      return fail('bad_action', `action must be one of ${ACTIONS.join(', ')}.`);
    }
    if (!writable) {
      return fail(
        'read_only',
        problem?.kind === 'newer'
          ? 'These reviews were written by a newer version of Stacki, so this one will not change them. Update Stacki.'
          : 'The review file cannot be written.'
      );
    }
    const at = now();
    const authorType = authorOf(req.authorType);

    if (action === 'create') {
      const text = body(req.message, MAX_BODY);
      if (!text) return fail('no_message', 'A comment needs something written in it.');
      if (!req.anchor || !Array.isArray(req.anchor.keys) || !req.anchor.keys.length) {
        return fail('no_target', 'There is nothing selected in Stacki to comment on.');
      }
      if (threads.length >= MAX_THREADS) {
        return fail('too_many', `This project already has ${MAX_THREADS} reviews.`);
      }
      const thread = {
        id: `rt_${id()}`,
        number: nextNumber++,
        color: COLORS.includes(req.color) ? req.color : DEFAULT_COLOR,
        status: 'open',
        // The human just pointed at it, so it is attached by definition. From
        // here on the renderer's resolver owns this field.
        anchorState: 'attached',
        anchor: req.anchor,
        creationContext: req.creationContext || {},
        messages: [message(text, authorType, at)],
        deferredReason: null,
        externalRefs: [],
        createdAt: at,
        updatedAt: at,
      };
      threads = [...threads, thread];
      // Only true once it is on disk. A refused write puts the ledger back to
      // what the file says, so this thread no longer exists to return.
      const saved = changed();
      if (!saved.ok) return saved;
      return { ok: true, thread };
    }

    const thread = find(str(req.threadId, 100));
    if (!thread) return fail('no_thread', `No review called ${req.threadId || '(none)'}.`);

    const say = (text) => {
      if (!text) return true;
      if (thread.messages.length >= MAX_MESSAGES) return false;
      thread.messages = [...thread.messages, message(text, authorType, at)];
      return true;
    };

    if (action === 'reply') {
      const text = body(req.message, MAX_BODY);
      if (!text) return fail('no_message', 'A reply needs something written in it.');
      if (!say(text)) return fail('too_many_messages', `This review already has ${MAX_MESSAGES} messages.`);
    } else if (action === 'resolve') {
      if (!say(body(req.message, MAX_BODY))) {
        return fail('too_many_messages', `This review already has ${MAX_MESSAGES} messages.`);
      }
      thread.status = 'resolved';
    } else if (action === 'defer') {
      if (!say(body(req.message, MAX_BODY))) {
        return fail('too_many_messages', `This review already has ${MAX_MESSAGES} messages.`);
      }
      thread.status = 'deferred';
      const reason = body(req.reason, MAX_REASON);
      if (reason) thread.deferredReason = reason;
      const ref = body(req.externalRef, MAX_REF);
      // Stored as a string and nothing else. Stacki does not fetch it, does
      // not parse it, and has never heard of GitHub — the agent that made the
      // issue is the one with the credentials, and it keeps them.
      if (ref && !thread.externalRefs.includes(ref) && thread.externalRefs.length < MAX_REFS) {
        thread.externalRefs = [...thread.externalRefs, ref];
      }
    } else if (action === 'reopen') {
      if (!say(body(req.message, MAX_BODY))) {
        return fail('too_many_messages', `This review already has ${MAX_MESSAGES} messages.`);
      }
      thread.status = 'open';
      // The reason it was put off no longer applies; the message history still
      // says it was, and why.
      thread.deferredReason = null;
    }

    thread.updatedAt = at;
    threads = threads.map((t) => (t.id === thread.id ? { ...thread } : t));
    const saved = changed();
    if (!saved.ok) return saved;
    return { ok: true, thread: find(thread.id) };
  }

  /**
   * Recolour a review.
   *
   * Deliberately not an `apply` action, for the same reason delete is not: this
   * is a person organising their own notes, and an agent quietly recolouring
   * somebody's comments would be changing something it has no opinion worth
   * having about. Not an edit either — the colour is not part of what was said,
   * so `updatedAt` stays where it is.
   */
  function setColor(ref, color) {
    if (!writable) return fail('read_only', 'The review file cannot be written.');
    if (!COLORS.includes(color)) return fail('bad_color', `A colour must be one of ${COLORS.join(', ')}.`);
    const thread = find(str(ref, 100));
    if (!thread) return fail('no_thread', `No review called ${ref || '(none)'}.`);
    if (thread.color === color) return { ok: true, thread: { ...thread } };
    threads = threads.map((t) => (t.id === thread.id ? { ...t, color } : t));
    const saved = changed();
    if (!saved.ok) return saved;
    return { ok: true, thread: find(thread.id) };
  }

  /**
   * Delete a review outright.
   *
   * Deliberately not an `apply` action, so the MCP surface cannot reach it by
   * passing a string. An agent that decides a comment is wrong should resolve
   * it with its reasoning, which leaves the human able to disagree; erasing
   * their feedback is not a thing it gets to do.
   */
  function remove(threadId) {
    if (!writable) return fail('read_only', 'The review file cannot be written.');
    const thread = find(str(threadId, 100));
    if (!thread) return fail('no_thread', `No review called ${threadId || '(none)'}.`);
    threads = threads.filter((t) => t.id !== thread.id);
    const saved = changed();
    if (!saved.ok) return saved;
    return { ok: true, thread };
  }

  /**
   * Take the renderer's word for which anchors still resolve.
   *
   * Only the renderer holds the parsed models, so only it can say. Applied in
   * a batch and only where something actually differs, so a page load that
   * confirms what was already known costs no revision and no write.
   */
  function syncAnchors(list) {
    if (!Array.isArray(list) || !list.length) return { ok: true, changed: 0 };
    let touched = 0;
    const next = threads.map((t) => {
      const update = list.find((u) => u && u.id === t.id);
      if (!update) return t;
      const state = ANCHOR_STATES.includes(update.anchorState) ? update.anchorState : t.anchorState;
      // Re-anchoring. A node that moved — somebody added a section above it —
      // is still the same node, and the renderer has just found it at a new
      // position. Writing that back is what stops the review paying for the
      // search again on every read, and stops it reporting the file:line of
      // whatever now sits where it used to be.
      const keys =
        Array.isArray(update.keys) && update.keys.length && update.keys.join() !== (t.anchor?.keys || []).join()
          ? update.keys
          : null;
      if (state === t.anchorState && !keys) return t;
      touched++;
      // Not an edit by anybody, so updatedAt does not move: an anchor going
      // orphaned because somebody deleted a section is not the review being
      // worked on, and sorting by "recently updated" should not say it was.
      return { ...t, anchorState: state, anchor: keys ? { ...t.anchor, keys } : t.anchor };
    });
    if (!touched) return { ok: true, changed: 0 };
    threads = next;
    const saved = changed();
    if (!saved.ok) return saved;
    return { ok: true, changed: touched };
  }

  return {
    file,
    projectPath,
    get revision() {
      return revision;
    },
    get writable() {
      return writable;
    },
    /** What went wrong reading the file, for the UI to say out loud. Null when nothing did. */
    get problem() {
      return problem;
    },
    /** Every thread, newest change first. Copies, so callers cannot mutate the store. */
    all() {
      return threads.map((t) => JSON.parse(JSON.stringify(t)));
    },
    get(ref) {
      const found = find(ref);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },
    get size() {
      return threads.length;
    },
    apply,
    remove,
    setColor,
    syncAnchors,
    /**
     * Nothing is ever waiting: every mutation is on disk before it answers.
     *
     * Both of these are kept because callers depend on them — the quit hook,
     * closing a project, the tests — and because "make sure it is saved" is
     * still the right thing for those callers to say. There is simply nothing
     * left for them to do.
     */
    flush() {
      return Promise.resolve();
    },
    /** The same, for a quit that cannot await. */
    flushSync() {},
  };
}

// --- projections -------------------------------------------------------------
//
// What a review looks like to somebody who asked for a list, and to somebody
// who asked about one. Pure functions of a thread, kept out of the store so
// they can be checked directly and so the MCP tool and the panel cannot end up
// describing the same review differently.

const firstMessage = (t) => t.messages[0] || null;
const lastMessage = (t) => t.messages[t.messages.length - 1] || null;

const excerptOf = (text) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 1)}…` : line;
};

/**
 * A review in one row.
 *
 * Sized so that a project's worth of open reviews is a paragraph rather than a
 * context window. `source` is a file, not a file:line — lines cost a parse
 * each and an agent that is about to act on a review calls focus and
 * get_context anyway, which answers with the current ones.
 */
function summarize(thread) {
  const first = firstMessage(thread);
  const last = lastMessage(thread);
  return {
    id: thread.id,
    // What to call it in a sentence. Either this or the id works everywhere a
    // review is named.
    number: thread.number || null,
    color: thread.color || DEFAULT_COLOR,
    status: thread.status,
    anchorState: thread.anchorState,
    message: excerptOf(first?.body),
    replies: Math.max(0, thread.messages.length - 1),
    lastAuthor: last?.authorType || 'human',
    page: thread.anchor?.page?.route || thread.anchor?.page?.file || null,
    breakpoint: thread.anchor?.breakpoint?.device || null,
    source: fileOfKey(leafKey(thread.anchor?.keys)),
    occurrence: thread.anchor?.occurrence ?? null,
    occurrenceCount: thread.anchor?.occurrenceCount ?? null,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Everything about one review.
 *
 * `resolveSource(keys)` answers with the CURRENT file:line trail for the
 * anchor — the same resolver ⇧⌘C and get_context use. Injected because it
 * costs a parse per file and only a full read is worth spending it on.
 */
/**
 * The anchor as it goes on the wire: every field present, always.
 *
 * A review written before a field existed simply has no such key, and a
 * ledger can also be hand-edited or written by an older Stacki. Passing the
 * stored object straight out would publish a response missing a declared
 * property, which a strict client rejects wholesale — not the field, the whole
 * answer. The shape a caller sees is decided here, not by how old the review
 * is or who wrote it.
 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function wireAnchor(anchor, trail) {
  const a = anchor && typeof anchor === 'object' ? anchor : {};
  const page = a.page && typeof a.page === 'object' ? a.page : {};
  const bp = a.breakpoint && typeof a.breakpoint === 'object' ? a.breakpoint : {};
  const pin = a.pin && typeof a.pin === 'object' ? a.pin : null;
  return {
    page: { route: page.route ?? null, file: page.file ?? null },
    keys: Array.isArray(a.keys) ? a.keys : [],
    breakpoint: {
      device: bp.device ?? null,
      viewportWidth: num(bp.viewportWidth),
      viewportHeight: num(bp.viewportHeight),
    },
    // Both halves or neither: a pin with one coordinate cannot be placed, and
    // publishing it as though it could is worse than saying there isn't one.
    pin: pin && num(pin.xRatio) !== null && num(pin.yRatio) !== null ? { xRatio: pin.xRatio, yRatio: pin.yRatio } : null,
    fingerprint: wireFingerprint(a.fingerprint),
    // Where the anchor points RIGHT NOW, lines and all. Null for an orphan,
    // which is the honest answer rather than the last place it was seen.
    sourceTrail: trail,
  };
}

function wireFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return null;
  return {
    nodeKind: fp.nodeKind ?? null,
    tag: fp.tag ?? null,
    text: fp.text ?? null,
    componentChain: Array.isArray(fp.componentChain) ? fp.componentChain : null,
    breadcrumbs: Array.isArray(fp.breadcrumbs) ? fp.breadcrumbs : null,
    peers: Array.isArray(fp.peers) ? fp.peers : null,
  };
}

function detail(thread, resolveSource) {
  const trail = (typeof resolveSource === 'function' ? resolveSource(thread.anchor?.keys) : null) || null;
  const all = thread.messages || [];
  const omitted = Math.max(0, all.length - MAX_DETAIL_MESSAGES);
  return {
    ...summarize(thread),
    createdAt: thread.createdAt,
    messages: omitted ? all.slice(-MAX_DETAIL_MESSAGES) : all,
    // Said rather than silently swallowed: a thread that looks 50 long when it
    // is 200 long is a thread whose history an agent will assume it has read.
    messagesOmitted: omitted,
    deferredReason: thread.deferredReason || null,
    externalRefs: thread.externalRefs || [],
    anchor: wireAnchor(thread.anchor, trail),
    creationContext: thread.creationContext || {},
  };
}

/**
 * The threads a request asked for.
 *
 * Pure, and separate from the store, because "which reviews" is a question
 * with several answers (a panel filter, an agent's scope) and none of them
 * should be able to change anything.
 */
function selectThreads(threads, { status = 'open', scope = 'project', page = null, keys = null, limit = 50 } = {}) {
  let list = threads;
  if (status && status !== 'all') list = list.filter((t) => t.status === status);
  if (scope === 'page') {
    const route = page?.route || null;
    const file = page?.file || null;
    list = list.filter(
      (t) =>
        (route && t.anchor?.page?.route === route) ||
        (file && t.anchor?.page?.file === file)
    );
  } else if (scope === 'selection') {
    const want = leafKey(keys);
    list = want ? list.filter((t) => leafKey(t.anchor?.keys) === want) : [];
  }
  // Most recently touched first: what somebody is working on now is what they
  // want at the top, and an agent working down a list wants the same order a
  // human would read.
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  return { threads: sorted.slice(0, capped), total: sorted.length, truncated: sorted.length > capped };
}

/**
 * What a selection of threads looks like on the wire, built against a byte
 * budget.
 *
 * Lives here rather than in the service because it is pure — threads in, a
 * response body out — and because it is the one projection every reader shares.
 * A caller that built the list itself would be a second implementation of the
 * answer, which is where the size cap would quietly stop applying.
 */
function project(picked, { detail: level = 'summary', resolver = null } = {}) {
  const reviews = [];
  let bytes = 0;
  let overBudget = false;
  for (const thread of picked.threads) {
    const one = level === 'full' ? detail(thread, resolver) : summarize(thread);
    bytes += JSON.stringify(one).length;
    // The first review always goes in, however large — an answer with nothing
    // in it would be worse than a big one.
    if (bytes > MAX_RESPONSE_BYTES && reviews.length) {
      overBudget = true;
      break;
    }
    reviews.push(one);
  }
  return {
    reviews,
    total: picked.total,
    // True when the list was cut — by the limit asked for, or by the size of
    // what came back. Either way the caller knows it is not the whole story.
    truncated: picked.truncated || overBudget,
    returned: reviews.length,
  };
}

module.exports = {
  createReviewStore,
  selectThreads,
  project,
  summarize,
  detail,
  scopeKey,
  fileFor,
  loadFile,
  writeAtomic,
  reviveThread,
  VERSION,
  STATUSES,
  COLORS,
  DEFAULT_COLOR,
  ANCHOR_STATES,
  ACTIONS,
  AUTHORS,
  MAX_BODY,
  MAX_REASON,
  MAX_REF,
  MAX_REFS,
  MAX_MESSAGES,
  MAX_THREADS,
  MAX_DETAIL_MESSAGES,
  MAX_RESPONSE_BYTES,
  EXCERPT,
};
