// Undo as a transaction: the project moves and the stack moves, or neither does.
//
//   node test/undo-transaction.js
//
// `test/undo-bytes.js` asks whether a SUCCESSFUL undo puts the right bytes back.
// This file asks the other question, the one that only shows up when something
// goes wrong: what is true after an undo that could NOT be carried out?
//
// The old answer was "half of it". Every one of these was measured against the
// shipped renderer before a line of it was changed:
//
//   the entry was popped off `past` and pushed onto `future` BEFORE its inverse
//   ran, so an inverse that threw left {past:2,future:0} as {past:1,future:1}
//   with not one byte different on disk;
//
//   the NEXT undo therefore undid the command UNDERNEATH the failed one -- the
//   caller asked twice for an asset rename to come back and Stacki reverted a
//   content edit instead, while the rename stayed applied;
//
//   and once whatever blocked the inverse had cleared, the failed entry was
//   unreachable from `past` for ever: `project.undo` answered "there is nothing
//   to undo" about a change that was still applied;
//
//   a multi-file inverse wrote its files in a loop with no rollback, so one
//   unwritable file left the project referencing a variable no file declared --
//   a state it had never been in and could not be got out of;
//
//   the snapshot branch had no try/catch at all, so a rejected save threw out
//   of `undo` as `command_failed` (not the documented `undo_failed`) with the
//   editor holding the restored model and the disk holding the edit;
//
//   and the sentence explaining any of it carried this machine's absolute
//   filesystem layout onto the wire in `restored.failed`, which nothing scrubbed.
//
// THE ORACLES ARE BYTES ON DISK, read by this process with fs, and the
// `history` field of the envelope. Not what the app says it did.
//
// HOW A FAILURE IS PRODUCED. Nothing is stubbed: a file the inverse must write
// is made read-only, or a file the inverse must rename onto is put back in the
// way. The real handlers refuse for the real reason, exactly as they would if
// somebody else's editor held the file.
//
// THE ONE EXCEPTION, AND IT IS ABOUT TIMING RATHER THAN BEHAVIOUR. Section 9b
// is about what happens to an undo that is STILL RUNNING when the page it
// belongs to is closed, and that interleave cannot be produced by asking
// politely. So one save is held open at the door -- the real write still
// happens, through the real handler, with the real bytes; only the moment it
// returns is chosen, the way a slow volume chooses it. The hold is asserted
// before the close is started, so a run that lost the race fails rather than
// passes.
//
// HOW "UNCHANGED" IS MEASURED. `project.redo` with an empty `future` is a
// no-op that still reports `history`, so it is the probe: it is taken
// immediately before each sabotaged call and asserts `redone: false`, which
// fails loudly if it was ever anything but a probe.
//
// POSITIVE CONTROLS. Every sabotage is followed by lifting it and asking again,
// and the last section is an undo and a redo with nothing wrong at all. A fix
// that simply refuses every undo fails this file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./agent-harness.js');
const { guardSuite } = require('./support/suiteGuard.js');
// THE HOST-PATH ORACLE IS NOT THIS FILE'S TO SPELL. It used to be, under a
// docstring claiming it was "the same function, at the same strength" as the
// copy in test/refusal-contract.js — and it was weaker: its anchors omitted the
// apostrophe, which is the character every Node fs error puts in front of a
// path (`open '/Users/…'`). Every assertion here is an ABSENCE, so the weaker
// copy passed them all by seeing nothing. See test/support/hostPaths.js.
const { hostPathsIn, QUOTINGS } = require('./support/hostPaths.js');

// THE ROLLBACKS ARE READ OUT OF THE SHIPPED FILES, not reimplemented here.
//
// Section 8 asks what happens to the file whose OWN write failed, and the only
// honest way to produce that is a writer that truncates and then throws --
// which is what a full disk or a dying volume does, and which no chmod can
// imitate: `open(w)` on a read-only file fails BEFORE the truncate, so the file
// it could not write is byte-identical either way and the defect is invisible.
// So the two renderer helpers are lifted out of their files as text and run
// against real files in a temporary folder with that writer injected. A rename
// of either function, or a change to the closure it reads, fails the lift
// loudly rather than quietly testing nothing.
const lift = (rel, from, to) => {
  const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const start = source.indexOf(from);
  if (start < 0) return null;
  const end = source.indexOf(to, start);
  if (end < 0) return null;
  return source.slice(start, end + to.length);
};

/**
 * A writer that TRUNCATES one file and then fails, the way a full disk does.
 *
 * ONCE, because the rollback writes through the same door and a door that
 * refuses for ever refuses the restore too — which is the "the disk is already
 * refusing; there is nothing further to try" case all three rollbacks call best
 * effort, and it makes the fix and the defect indistinguishable. A transient
 * failure (an I/O error, a volume that came back, space freed by something
 * else) is the case where the rollback can act, so it is the case to measure.
 */
const truncatingWriter = (abs) => {
  let broken = false;
  return (target, text) => {
    if (!broken && path.resolve(target) === path.resolve(abs)) {
      broken = true;
      fs.writeFileSync(target, '', 'utf8'); // the truncate `open(w)` does
      const err = new Error('ENOSPC: no space left on device, write');
      err.code = 'ENOSPC';
      throw err;
    }
    fs.writeFileSync(target, text, 'utf8');
  };
};

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 320) => JSON.stringify(x ?? null).slice(0, n);
const same = (a, b) => !!a && !!b && a.past === b.past && a.future === b.future;
// What an undo says it put back. Each entry is `{file, contentDigest}` on the
// wire; the names are what this file asks about.
const filesOf = (envelope) =>
  (envelope?.restored?.files || []).map((entry) => (typeof entry === 'string' ? entry : entry?.file)).filter(Boolean);

const ASSET = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n';
const COLLIDER = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>\n';

// Two stylesheets that each declare a variable and each reference the other's,
// so ONE rename touches BOTH files. That is the shape the multi-file inverse
// exists for, and the only shape in which "the first file was reverted and the
// second was not" is a thing that can be said.
const ONE = `:root {
  --alpha: 1rem;
}

.one-thing {
  padding: var(--gamma);
}
`;
const TWO = `:root {
  --gamma: 3rem;
}

.two-thing {
  margin: var(--alpha);
}
`;

const OTHER_JSON = `${JSON.stringify({ note: 'the second file' }, null, 2)}\n`;

const PAGE = 'src/pages/index.astro';

// The gap two recorded commands need between them to be two steps rather than
// one: `pushCommand` collapses a burst that shares a coalesceKey inside 800 ms,
// and every `content.cms_write` shares one.
const UNCOALESCED = 900;

(async () => {
  // "THE PROCESS EXITED BEFORE THE SUITE FINISHED" IS A FAILURE, NOT A PASS.
  //
  // Everything in this file is an await, several of them against a whole
  // renderer and a whole main process, and node exits 0 on an empty event loop
  // — so an await that never settles prints nothing after the line it reached
  // and the runner records a pass. `npm test` chains with && ; the whole run
  // would go green with none of these assertions executed. See
  // test/support/suiteGuard.js.
  const suiteDone = guardSuite('undo-transaction');

  // ── 0. THE PANEL'S OWN INVERSES ──────────────────────────────────────────
  //
  // Run first, and in its own jsdom, because the harness below takes the DOM
  // globals over for the whole App. Same defect class, other caller: see
  // test/support/undoTxnPanel.js.
  {
    const { assetsPanelInverses } = require('./support/undoTxnPanel.js');
    const { callMain } = H.loadMain();
    await assetsPanelInverses({ check, makeProject: H.makeProject, removeProject: H.removeProject, callMain });
  }

  const root = H.makeProject({
    'public/keep.svg': ASSET,
    'src/styles/one.css': ONE,
    'src/styles/two.css': TWO,
    // A SECOND content file, so that two recorded commands can touch two
    // different files. Section 1 needs to be able to say WHICH of two entries
    // an undo ran, and it can only say that if they do not overlap on disk.
    'src/data/other.json': OTHER_JSON,
  });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  const at = (rel) => (app.exists(rel) ? app.read(rel) : null);

  // Every chmod this file makes, so the finally can put them all back: a
  // fixture with a read-only file in it is a fixture that may not be removable,
  // and the removal is one of the checks.
  const locked = new Set();
  const lock = (rel) => {
    fs.chmodSync(path.join(root, rel), 0o444);
    locked.add(rel);
  };
  // THE DELETE BELONGS TO THE CHMOD THAT WORKED, and used to happen either way.
  // It sat outside the try, so the set emptied itself whatever the chmod did —
  // which made "every chmod was lifted" at the bottom of this file an assertion
  // that could not fail: a chmod that threw left the file read-only on disk and
  // `locked` empty all the same. Inside the try, the set says what it means.
  const unlock = (rel) => {
    try {
      fs.chmodSync(path.join(root, rel), 0o644);
      locked.delete(rel);
    } catch {
      /* still read-only, and the set goes on saying so */
    }
  };

  // Envelopes that a person must never be able to read this machine's layout
  // out of. Collected as they happen and checked together at the end.
  const wire = [];

  const probe = async (why) => {
    const answer = await run('project', 'redo');
    check(`${why}: the history probe is a no-op`, answer.ok === true && answer.redone === false, short(answer));
    return answer.history;
  };

  await H.settle(400);

  try {
    const start = await probe('at the start');
    check('the stack starts empty', same(start, { past: 0, future: 0 }), short(start));

    // ── 1. TWO UNDOS AT ONCE ARE TWO UNDOS ───────────────────────────────────
    //
    // The transactionality above is bought by PEEKING the top entry, running
    // its inverse, and moving the stack only once that resolves. Between the
    // peek and the move there is a window, and a second undo arriving inside it
    // used to peek THE SAME ENTRY: both ran its inverse, the first `takeOut`
    // removed it, the second found nothing to remove, and both pushed it onto
    // `future`. Measured before this section existed, with these exact two
    // writes and one `Promise.all`:
    //
    //   past: {past:1, future:2}, `src/data/other.json` named by BOTH calls,
    //   `src/data/site.json` still holding the edit nobody had undone, and both
    //   calls answering `ok: true, undone: true` — because `project.undo` reads
    //   success as `past` having got shorter, which it had, once, for two
    //   callers. Nothing serialised these: ⌘Z is `void undo()` and the MCP
    //   server does not queue either.
    //
    // Two files rather than one, so "which entry did this undo run" is a
    // question the BYTES can answer. Both inverses are byte restores and are
    // idempotent, so running the wrong one twice does not fail — it just leaves
    // the other change applied, which is the defect.
    {
      const siteWas = app.read('src/data/site.json');
      const otherWas = app.read('src/data/other.json');

      const readSite = await run('content', 'cms_read', { path: 'src/data/site.json' });
      const wroteSite = await run('content', 'cms_write', {
        path: 'src/data/site.json',
        data: { title: 'Fixture', tagline: 'THE FIRST OF TWO' },
        ref: readSite.ref,
      });
      check('the first of two writes lands', wroteSite.ok === true, short(wroteSite));
      await H.settle(UNCOALESCED);
      const readOther = await run('content', 'cms_read', { path: 'src/data/other.json' });
      const wroteOther = await run('content', 'cms_write', {
        path: 'src/data/other.json',
        data: { note: 'THE SECOND OF TWO' },
        ref: readOther.ref,
      });
      check('  and so does the second', wroteOther.ok === true, short(wroteOther));
      const siteEdited = app.read('src/data/site.json');
      const otherEdited = app.read('src/data/other.json');
      check('  with both files really changed', siteEdited !== siteWas && otherEdited !== otherWas);

      const before = await probe('before the concurrent undos');
      check('  and two separate steps on the stack', same(before, { past: 2, future: 0 }), short(before));

      const [first, second] = await Promise.all([run('project', 'undo'), run('project', 'undo')]);
      await H.settle(300);
      wire.push(first, second);
      check('both concurrent undos are answered', first.ok === true && second.ok === true, short({ first, second }));
      check('  neither reports a failed inverse', !first.restored?.failed && !second.restored?.failed, short({ a: first.restored?.failed, b: second.restored?.failed }));

      // THE BYTES, WHICH IS THE WHOLE POINT. Two undos were asked for and two
      // different changes have to have come back.
      check('THE SECOND WRITE IS UNDONE, byte for byte', app.read('src/data/other.json') === otherWas, short(app.read('src/data/other.json')));
      check('AND SO IS THE FIRST, which the racing undo used to skip', app.read('src/data/site.json') === siteWas, short(app.read('src/data/site.json')));

      const after = second.history?.past === 0 ? second.history : first.history;
      check('  the stack is emptied and the redo stack holds two', same(after, { past: 0, future: 2 }), short({ first: first.history, second: second.history }));

      // AND THEY WERE TWO DIFFERENT ENTRIES. Both racers used to name the same
      // file, because both had run the same inverse.
      const named = [filesOf(first), filesOf(second)];
      check(
        '  the two undos put back two different files',
        named.some((list) => list.includes('src/data/site.json')) && named.some((list) => list.includes('src/data/other.json')),
        short(named)
      );

      // AND SO DOES `future`: two concurrent redos have to bring both edits
      // back, which they cannot if the same entry is on it twice.
      const [redoA, redoB] = await Promise.all([run('project', 'redo'), run('project', 'redo')]);
      await H.settle(300);
      wire.push(redoA, redoB);
      check('both concurrent redos are answered', redoA.ok === true && redoB.ok === true, short({ redoA, redoB }));
      check('  the first edit is back, byte for byte', app.read('src/data/site.json') === siteEdited, short(app.read('src/data/site.json')));
      check('  and so is the second', app.read('src/data/other.json') === otherEdited, short(app.read('src/data/other.json')));
      const redone = redoB.history?.future === 0 ? redoB.history : redoA.history;
      check('  with the stack back where it started', same(redone, { past: 2, future: 0 }), short({ redoA: redoA.history, redoB: redoB.history }));
      const redoNames = [filesOf(redoA), filesOf(redoB)];
      check(
        '  and the two redos replayed two different entries',
        redoNames.some((list) => list.includes('src/data/site.json')) && redoNames.some((list) => list.includes('src/data/other.json')),
        short(redoNames)
      );

      // Back to an empty `past` and the fixture's own bytes, one step at a
      // time, for the sections below. `probe` cannot be used to read the stack
      // here: it IS a redo, and with two entries on `future` it would replay
      // one of them.
      await run('project', 'undo');
      await H.settle(150);
      const drained = await run('project', 'undo');
      await H.settle(150);
      check('the two files are as the fixture wrote them again', app.read('src/data/site.json') === siteWas && app.read('src/data/other.json') === otherWas, short({
        site: app.read('src/data/site.json'),
        other: app.read('src/data/other.json'),
      }));
      check('  with nothing left on past', drained.history?.past === 0, short(drained.history));
    }

    // ── 1b. `undone` IS ABOUT THIS CALL, NOT ABOUT THE DEPTH OF THE STACK ────
    //
    // Section 1 above is about the STACK, and serialising the callers fixed it.
    // The FLAG survived that fix untouched: `project.undo` computed `undone` as
    // `historyDepth().past < before.past`, with `before` read SYNCHRONOUSLY —
    // before `a.undo()` joined the queue that makes the step run later. So
    // `before` describes the stack in front of the whole in-flight batch, and
    // every caller in the batch compares against the same number.
    //
    // MEASURED against the shipped renderer, with the queue in place:
    //
    //   two `project.undo` in one Promise.all against ONE entry — BOTH answered
    //   `ok: true, undone: true`, and the second's `restored` was null;
    //
    //   three against two entries — all three answered `undone: true`;
    //
    //   an undo and a redo together at {past: 1, future: 1} — the redo put its
    //   change back on disk and answered `redone: false`, because `future` was
    //   1 before the pair and 1 after it.
    //
    // THE INVARIANT, asserted on every call below rather than only on the ones
    // whose depth happens to come out wrong: `undone === !!restored &&
    // !restored.failed`. `restored` is what the renderer hands back for THIS
    // step — null when there was nothing left for it to take off the stack, the
    // entry with a `failed` on it when the inverse refused, the entry otherwise
    // — and it was already right in every case measured above. No depth reading
    // can say what one step of a batch did, so the flag is the entry.
    //
    // THE SURPLUS CALLER IS WHAT MAKES THE COUNT AN ASSERTION. Three undos
    // against three entries would pass on the broken code too. Three against
    // TWO cannot: one of them has nothing to undo and has to say so.
    {
      // Every answer this section takes, held to the invariant in one place, so
      // a call added here cannot quietly skip it.
      const honest = (label, r, flag) => {
        const did = !!r.restored && !r.restored.failed;
        check(`1b: ${label} says what IT did, not how deep the stack is`, r[flag] === did, short({ [flag]: r[flag], restored: r.restored }));
      };

      const siteWas = app.read('src/data/site.json');
      const otherWas = app.read('src/data/other.json');
      const readSite = await run('content', 'cms_read', { path: 'src/data/site.json' });
      const wroteSite = await run('content', 'cms_write', {
        path: 'src/data/site.json',
        data: { title: 'Fixture', tagline: 'ONE OF TWO, THREE CALLERS' },
        ref: readSite.ref,
      });
      check('1b: the first of two writes lands', wroteSite.ok === true, short(wroteSite));
      await H.settle(UNCOALESCED);
      const readOther = await run('content', 'cms_read', { path: 'src/data/other.json' });
      const wroteOther = await run('content', 'cms_write', {
        path: 'src/data/other.json',
        data: { note: 'TWO OF TWO, THREE CALLERS' },
        ref: readOther.ref,
      });
      check('1b:   and so does the second', wroteOther.ok === true, short(wroteOther));
      const siteEdited = app.read('src/data/site.json');
      const otherEdited = app.read('src/data/other.json');
      check('1b:   with both files really changed', siteEdited !== siteWas && otherEdited !== otherWas);

      const depth = await probe('1b before three undos against two entries');
      check('1b: two entries on the stack and three callers about to ask', same(depth, { past: 2, future: 0 }), short(depth));

      const three = await Promise.all([run('project', 'undo'), run('project', 'undo'), run('project', 'undo')]);
      await H.settle(300);
      wire.push(...three);
      check('1b: all three undos are answered', three.every((r) => r.ok === true), short(three.map((r) => ({ ok: r.ok, code: r.code }))));
      check('1b:   and none of them reports a failed inverse', three.every((r) => !r.restored?.failed), short(three.map((r) => r.restored?.failed ?? null)));
      three.forEach((r, i) => honest(`undo ${i} of three`, r, 'undone'));

      // THE COUNT. Two entries, three callers: exactly two of them undid
      // something and exactly one had nothing to undo.
      const claimed = three.filter((r) => r.undone === true);
      const surplus = three.filter((r) => r.undone === false);
      check('1b: EXACTLY TWO OF THE THREE UNDID SOMETHING', claimed.length === 2, short(three.map((r) => r.undone)));
      check('1b:   and the surplus caller says it did not', surplus.length === 1, short(three.map((r) => r.undone)));
      check('1b:   with nothing restored to show for it', surplus.length === 1 && surplus[0].restored === null, short(surplus.map((r) => r.restored)));
      check('1b:   while the two that did name what they put back', claimed.every((r) => filesOf(r).length > 0), short(claimed.map((r) => filesOf(r))));

      // THE BYTES, which is what the flags are claims about.
      check('1b: the second edit is undone, byte for byte', app.read('src/data/other.json') === otherWas, short(app.read('src/data/other.json')));
      check('1b:   and so is the first', app.read('src/data/site.json') === siteWas, short(app.read('src/data/site.json')));

      // ── AND AN UNDO AND A REDO IN THE SAME BATCH ──────────────────────────
      //
      // {past: 1, future: 1} reached by putting one of the two entries back.
      // Both calls below have something real to do, so both have to answer
      // true — and the pair converges on the same stack and the same bytes
      // whichever order the queue runs them in, which is what makes the oracle
      // stable rather than a coin toss.
      const one = await run('project', 'redo');
      await H.settle(300);
      honest('the redo that sets the pair up', one, 'redone');
      check('1b: the pair starts at one on each stack', same(one.history, { past: 1, future: 1 }), short(one.history));
      const siteMid = app.read('src/data/site.json');
      const otherMid = app.read('src/data/other.json');

      const [pairUndo, pairRedo] = await Promise.all([run('project', 'undo'), run('project', 'redo')]);
      await H.settle(300);
      wire.push(pairUndo, pairRedo);
      check('1b: both halves of the pair are answered', pairUndo.ok === true && pairRedo.ok === true, short({ pairUndo, pairRedo }));
      check('1b:   and neither reports a failed inverse', !pairUndo.restored?.failed && !pairRedo.restored?.failed, short({ u: pairUndo.restored?.failed, r: pairRedo.restored?.failed }));
      honest('the undo of the pair', pairUndo, 'undone');
      honest('the redo of the pair', pairRedo, 'redone');
      // Said again as the two sentences the defect was reported in, because
      // those are the two shapes the depth reading produced and a reader should
      // not have to derive them from the invariant above.
      check(
        '1b: NEITHER HALF CLAIMS TO HAVE MOVED SOMETHING IT DID NOT',
        !(pairUndo.undone && !pairUndo.restored) && !(pairRedo.redone && !pairRedo.restored),
        short({ undo: { undone: pairUndo.undone, restored: pairUndo.restored }, redo: { redone: pairRedo.redone, restored: pairRedo.restored } })
      );
      check(
        '1b: AND NEITHER DENIES A CHANGE IT PUT BACK ON DISK',
        !(pairUndo.undone === false && pairUndo.restored && !pairUndo.restored.failed) &&
          !(pairRedo.redone === false && pairRedo.restored && !pairRedo.restored.failed),
        short({ undo: { undone: pairUndo.undone, restored: pairUndo.restored }, redo: { redone: pairRedo.redone, restored: pairRedo.restored } })
      );
      // Whichever way round the queue ran them, one entry came off `past` and
      // one came off `future`, so the stack and the files are where the pair
      // found them.
      const settled = pairUndo.history?.past === 1 && pairUndo.history?.future === 1 ? pairUndo.history : pairRedo.history;
      check('1b: the pair leaves the stack where it found it', same(settled, { past: 1, future: 1 }), short({ undo: pairUndo.history, redo: pairRedo.history }));
      check('1b:   and the files too', app.read('src/data/site.json') === siteMid && app.read('src/data/other.json') === otherMid, short({
        site: app.read('src/data/site.json'),
        other: app.read('src/data/other.json'),
      }));

      // Back to an empty `past` for the sections below, one step at a time.
      const drained = await run('project', 'undo');
      await H.settle(200);
      honest('the drain', drained, 'undone');
      check('1b: the fixture bytes are back', app.read('src/data/site.json') === siteWas && app.read('src/data/other.json') === otherWas, short({
        site: app.read('src/data/site.json'),
        other: app.read('src/data/other.json'),
      }));
      check('1b:   with nothing left on past', drained.history?.past === 0, short(drained.history));
    }

    // ── 2. AN EDIT DURING AN UNDO ENDS THE REDO STACK ────────────────────────
    //
    // `pushHistory` and `pushCommand` empty `future` because a new edit is
    // where the redo branch stops. The undo's redo point is pushed AFTER its
    // inverse resolves, so an edit that landed while the inverse was running
    // cleared `future` and the resolving undo then filled it back in — redo
    // live again, pointing at a snapshot taken before that edit existed.
    // Measured: `past: [S1]` with `future: [S1]`, and the redo replaying bytes
    // the person had since written over.
    //
    // THE INTERLEAVE IS ITSELF AN ASSERTION. If the write finished after the
    // undo had already resolved, everything below would pass for the wrong
    // reason — `pushCommand` clears `future` either way — so whether the race
    // really happened is checked rather than assumed.
    {
      const siteWas = app.read('src/data/site.json');
      const otherWas = app.read('src/data/other.json');
      const readSite = await run('content', 'cms_read', { path: 'src/data/site.json' });
      const wrote = await run('content', 'cms_write', {
        path: 'src/data/site.json',
        data: { title: 'Fixture', tagline: 'THE ONE BEING UNDONE' },
        ref: readSite.ref,
      });
      check('the write that will be undone lands', wrote.ok === true, short(wrote));
      await H.settle(UNCOALESCED);

      let undoSettled = false;
      const undoing = run('project', 'undo').then((answer) => {
        undoSettled = true;
        return answer;
      });
      const readOther = await run('content', 'cms_read', { path: 'src/data/other.json' });
      const during = await run('content', 'cms_write', {
        path: 'src/data/other.json',
        data: { note: 'WRITTEN WHILE THE UNDO WAS RUNNING' },
        ref: readOther.ref,
      });
      const raced = !undoSettled;
      const undone = await undoing;
      await H.settle(300);

      check('the new edit landed while the inverse was still in flight', raced, short({ undoSettled }));
      check('  and it landed', during.ok === true && app.read('src/data/other.json') !== otherWas, short(during));
      check('the undo still happened', undone.ok === true && app.read('src/data/site.json') === siteWas, short(app.read('src/data/site.json')));

      // Read off the undo's OWN envelope, which reports the stack as the undo
      // left it. Asking `project.redo` first would answer about the stack after
      // the redo, and a redo that should not have been possible would have
      // emptied `future` on its way through and reported zero.
      check('THE REDO STACK THE NEW EDIT CLEARED STAYS CLEARED', undone.history?.future === 0, short(undone.history));
      const answer = await run('project', 'redo');
      wire.push(answer);
      check('  so there is nothing to redo', answer.redone === false, short({ redone: answer.redone }));
      check('  and the stack still says so', answer.history.future === 0, short(answer.history));
      check('  and the new edit is still what is on disk', app.read('src/data/other.json') !== otherWas, short(app.read('src/data/other.json')));

      // The new edit is the only thing on the stack now; take it back off, so
      // the sections below start from the fixture's own bytes again. Read
      // through the undo's own answer rather than `probe`, which is a redo and
      // would replay what this just put back.
      const drained = await run('project', 'undo');
      await H.settle(200);
      check('the interleaved edit is undone too', app.read('src/data/other.json') === otherWas, short(app.read('src/data/other.json')));
      check('  with an empty past again', drained.history?.past === 0, short(drained.history));
    }

    // ── 3. A FAILED UNDO DOES NOT MOVE THE STACK ─────────────────────────────
    //
    // Two commands, so that "the next undo skipped to the one underneath" is
    // observable rather than a matter of opinion.
    let siteAfter = null;
    {
      const read = await run('content', 'cms_read', { path: 'src/data/site.json' });
      const wrote = await run('content', 'cms_write', {
        path: 'src/data/site.json',
        data: { title: 'Fixture', tagline: 'CHANGED BY THE TEST' },
        ref: read.ref,
      });
      check('a content write lands', wrote.ok === true, short(wrote));
      siteAfter = app.read('src/data/site.json');
      check('  and is in the file', /CHANGED BY THE TEST/.test(siteAfter), siteAfter.slice(0, 120));

      const renamed = await run('asset', 'rename', { path: 'public/keep.svg', name: 'keep-renamed.svg' });
      check('an asset rename lands on top of it', renamed.ok === true && at('public/keep-renamed.svg') === ASSET, short(renamed));

      // THE OBSTRUCTION. Something is at the name the inverse has to rename
      // back to, so `assets:rename` refuses with `exists` — the same refusal a
      // person would hit having recreated the file by hand.
      app.write('public/keep.svg', COLLIDER);

      const before = await probe('before the blocked undo');
      check('  two commands are on the stack', same(before, { past: 2, future: 0 }), short(before));

      const failed = await run('project', 'undo');
      wire.push(failed);
      check('the blocked undo is refused', failed.ok === false, short(failed));
      check('  with the documented code', failed.code === 'undo_failed', short({ code: failed.code }));
      check('  and says it did not undo anything', failed.undone === false, short({ undone: failed.undone }));
      check('  AND THE STACK HAS NOT MOVED', same(failed.history, before), short({ before, after: failed.history }));
      check('  the rename is still applied', at('public/keep-renamed.svg') === ASSET, short(at('public/keep-renamed.svg')));
      check('  the obstruction is untouched', at('public/keep.svg') === COLLIDER, short(at('public/keep.svg')));
      check('  and the content write underneath it is still applied', app.read('src/data/site.json') === siteAfter);

      // THE RETRY IS THE POINT. Take the obstruction away and ask again: it has
      // to be the SAME command that comes back, not the one beneath it.
      fs.rmSync(path.join(root, 'public/keep.svg'));
      const retried = await run('project', 'undo');
      await H.settle(150);
      check('with the obstruction gone the same undo goes through', retried.ok === true && retried.undone === true, short(retried));
      const names = filesOf(retried);
      check(
        '  and it is the ASSET RENAME that was undone, not the write beneath it',
        names.includes('public/keep.svg') && names.includes('public/keep-renamed.svg') && !names.includes('src/data/site.json'),
        short(names)
      );
      check('  the file is back under its own name, byte for byte', at('public/keep.svg') === ASSET, short(at('public/keep.svg')));
      check('  with nothing left under the new one', at('public/keep-renamed.svg') === null, short(at('public/keep-renamed.svg')));
      check('  the content write is STILL applied', app.read('src/data/site.json') === siteAfter);
      check('  and the stack moved exactly one step', same(retried.history, { past: 1, future: 1 }), short(retried.history));
    }

    // ── 4. THE MIRROR, FOR REDO ──────────────────────────────────────────────
    //
    // The asset rename undone above is on `future` now. Put the obstruction
    // back at the name the REDO has to rename onto.
    {
      const before = { past: 1, future: 1 };
      app.write('public/keep-renamed.svg', COLLIDER);

      const failed = await run('project', 'redo');
      wire.push(failed);
      check('a blocked redo is refused', failed.ok === false, short(failed));
      check('  with the documented code', failed.code === 'redo_failed', short({ code: failed.code }));
      check('  and says it did not redo anything', failed.redone === false, short({ redone: failed.redone }));
      check('  AND THE STACK HAS NOT MOVED', same(failed.history, before), short({ before, after: failed.history }));
      check('  the asset is still where the undo left it', at('public/keep.svg') === ASSET, short(at('public/keep.svg')));
      check('  and the obstruction is untouched', at('public/keep-renamed.svg') === COLLIDER, short(at('public/keep-renamed.svg')));

      fs.rmSync(path.join(root, 'public/keep-renamed.svg'));
      const retried = await run('project', 'redo');
      await H.settle(150);
      check('with the obstruction gone the same redo goes through', retried.ok === true && retried.redone === true, short(retried));
      const names = filesOf(retried);
      check('  and it is the same command', names.includes('public/keep-renamed.svg'), short(names));
      check('  the file is renamed again, byte for byte', at('public/keep-renamed.svg') === ASSET, short(at('public/keep-renamed.svg')));
      check('  with nothing left under the old name', at('public/keep.svg') === null, short(at('public/keep.svg')));
      check('  and the stack moved exactly one step', same(retried.history, { past: 2, future: 0 }), short(retried.history));
    }

    // ── 4b. AND IT IS THE TOP OF `future`, NOT THE ONE UNDERNEATH IT ─────────
    //
    // Section 4 above mirrors section 3 in everything except the assertion
    // section 3 exists for. At its retry `future` is ONE deep, so "the retry
    // targets the same command" and "the retry targets the only command" are
    // the same sentence, and the check that reads the restored file names
    // could not have failed for a redo that took the wrong entry: there was no
    // other entry for it to take. Section 3 has the discriminator — two
    // entries on `past`, and the write beneath the failed one asserted NOT to
    // be the one that came back — and this is the missing half of it.
    //
    // MEASURED, with the one-line off-by-one that IS this defect: in
    // `redoStep`, `h.future[h.future.length - 1]` read as
    // `h.future[Math.max(0, h.future.length - 2)]` — the same entry whenever
    // `future` is one deep, the one UNDERNEATH whenever it is two. The whole
    // of section 4 passed on it, unchanged, including "and it is the same
    // command".
    //
    // So: two entries on `future`, put there by two undos, with the blocked
    // one on top. They touch different files — `public/keep-renamed.svg` for
    // the asset rename on top, `src/data/other.json` for the content write
    // beneath it — so WHICH entry the retry replayed is a question the bytes
    // on disk answer, and the two answers cannot be mistaken for each other.
    {
      // THE ENTRY THAT WILL SIT UNDERNEATH. It goes on `past` last, so it
      // comes off first, so it lands on `future` first — which is the bottom.
      const otherBefore = app.read('src/data/other.json');
      const readOther = await run('content', 'cms_read', { path: 'src/data/other.json' });
      const wroteOther = await run('content', 'cms_write', {
        path: 'src/data/other.json',
        data: { note: 'THE ENTRY UNDERNEATH THE BLOCKED REDO' },
        ref: readOther.ref,
      });
      check('4b: a content write on a second file lands', wroteOther.ok === true, short(wroteOther));
      const otherAfter = app.read('src/data/other.json');
      check('4b:   and is in the file', otherAfter !== otherBefore && /UNDERNEATH THE BLOCKED REDO/.test(otherAfter), otherAfter.slice(0, 120));

      const undoneWrite = await run('project', 'undo');
      await H.settle(150);
      check('4b: the content write is undone', undoneWrite.ok === true && undoneWrite.undone === true, short(undoneWrite));
      check('4b:   and its file is back, byte for byte', app.read('src/data/other.json') === otherBefore, short(app.read('src/data/other.json')));

      const undoneRename = await run('project', 'undo');
      await H.settle(150);
      check('4b: and the asset rename beneath it is undone too', undoneRename.ok === true && undoneRename.undone === true, short(undoneRename));
      check('4b:   the file is back under its own name, byte for byte', at('public/keep.svg') === ASSET && at('public/keep-renamed.svg') === null, short({ keep: at('public/keep.svg'), renamed: at('public/keep-renamed.svg') }));
      const before = undoneRename.history;
      check('4b:   SO THE REDO STACK IS TWO DEEP, with the rename on top', same(before, { past: 1, future: 2 }), short(before));

      // THE OBSTRUCTION, at the name the entry on TOP has to rename onto. It
      // obstructs that entry and no other: the content write underneath goes
      // nowhere near this file, so a redo that refuses is a redo that reached
      // for the top of the stack.
      app.write('public/keep-renamed.svg', COLLIDER);
      const failed = await run('project', 'redo');
      wire.push(failed);
      check('4b: the blocked redo is refused', failed.ok === false, short(failed));
      check('4b:   with the documented code', failed.code === 'redo_failed', short({ code: failed.code }));
      check('4b:   and says it did not redo anything', failed.redone === false, short({ redone: failed.redone }));
      check('4b:   AND THE STACK HAS NOT MOVED', same(failed.history, before), short({ before, after: failed.history }));
      check('4b:   the obstruction is untouched', at('public/keep-renamed.svg') === COLLIDER, short(at('public/keep-renamed.svg')));
      check('4b:   and the entry UNDERNEATH it did not run in its place', app.read('src/data/other.json') === otherBefore, short(app.read('src/data/other.json')));

      // THE RETRY, WITH SOMETHING UNDER IT — the sentence section 4 cannot
      // say. Not "a command was replayed" but "the one on TOP was, and the one
      // beneath it is still where the undo left it".
      fs.rmSync(path.join(root, 'public/keep-renamed.svg'));
      const retried = await run('project', 'redo');
      await H.settle(150);
      check('4b: with the obstruction gone the same redo goes through', retried.ok === true && retried.redone === true, short(retried));
      const names = filesOf(retried);
      check(
        '4b:   and it is the ASSET RENAME ON TOP that was replayed, not the write beneath it',
        names.includes('public/keep-renamed.svg') && !names.includes('src/data/other.json'),
        short(names)
      );
      check('4b:   the file is renamed again, byte for byte', at('public/keep-renamed.svg') === ASSET && at('public/keep.svg') === null, short({ renamed: at('public/keep-renamed.svg'), keep: at('public/keep.svg') }));
      // THE BYTES THAT MAKE THE LINE ABOVE AN ASSERTION RATHER THAN A LABEL. A
      // redo that took the entry underneath would have rewritten this file and
      // answered `ok: true, redone: true` with the asset still sitting where
      // the undo left it.
      check('4b:   AND THE CONTENT WRITE UNDERNEATH IS STILL UNDONE, byte for byte', app.read('src/data/other.json') === otherBefore, short(app.read('src/data/other.json')));
      check('4b:   with the stack moved exactly one step', same(retried.history, { past: 2, future: 1 }), short(retried.history));

      // POSITIVE CONTROL. The entry underneath is still on `future` and still
      // reachable: a redo that had simply refused to go past the top entry
      // would pass every check above.
      const under = await run('project', 'redo');
      await H.settle(150);
      check('4b: the entry underneath is still there to be redone', under.ok === true && under.redone === true, short(under));
      check('4b:   and it is the content write this time', filesOf(under).includes('src/data/other.json'), short(filesOf(under)));
      check('4b:   whose bytes are back', app.read('src/data/other.json') === otherAfter, short(app.read('src/data/other.json')));
      check('4b:   with the redo stack empty', same(under.history, { past: 3, future: 0 }), short(under.history));

      // Back to what section 4 left behind, so the sections below start from
      // the stack and the bytes they always did.
      const put = await run('project', 'undo');
      await H.settle(150);
      check('4b: the extra command is taken back off', put.ok === true && app.read('src/data/other.json') === otherBefore, short(app.read('src/data/other.json')));
      check('4b:   leaving the rename and the site.json write on the stack', same(put.history, { past: 2, future: 1 }), short(put.history));
    }

    // ── 5. NO PARTIAL FILE STATE ─────────────────────────────────────────────
    //
    // One rename across two stylesheets, undone with one of them read-only.
    // Run twice, once with each file locked, because which of the two the
    // inverse writes SECOND is a property of the walk order rather than of
    // anything this test is entitled to assume — and it is the second one that
    // makes the rollback the only thing standing between the project and a
    // state it was never in.
    const preOne = app.read('src/styles/one.css');
    const preTwo = app.read('src/styles/two.css');
    for (const [label, from, to, lockRel] of [
      ['locking the file that declares it', '--alpha', '--alpha-x', 'src/styles/one.css'],
      ['locking the file that references it', '--gamma', '--gamma-x', 'src/styles/two.css'],
    ]) {
      const renamed = await run('style', 'rename_variables', { renames: [{ from, to }] });
      check(`${from} is renamed across both stylesheets`, renamed.ok === true, short(renamed));
      const postOne = app.read('src/styles/one.css');
      const postTwo = app.read('src/styles/two.css');
      check('  both files really changed', postOne !== preOne && postTwo !== preTwo, short({ one: postOne.length, two: postTwo.length }));
      check(`  and ${to} is what they now say`, postOne.includes(to) && postTwo.includes(to), short({ postOne, postTwo }));

      lock(lockRel);
      const before = await probe(`before the half-writable undo (${label})`);
      const failed = await run('project', 'undo');
      wire.push(failed);
      check(`the undo is refused when one of its files cannot be written (${label})`, failed.ok === false, short(failed));
      check('  with the documented code', failed.code === 'undo_failed', short({ code: failed.code }));
      check('  AND THE STACK HAS NOT MOVED', same(failed.history, before), short({ before, after: failed.history }));
      // THE ASSERTION THIS SECTION EXISTS FOR. Not "the locked file is
      // unchanged" -- of course it is -- but that the OTHER one, which the
      // inverse could write and did, was put back.
      check('  the file it COULD write was put back as it found it', app.read('src/styles/one.css') === postOne, short({
        expected: postOne.slice(0, 90),
        found: app.read('src/styles/one.css').slice(0, 90),
      }));
      check('  and so is the other', app.read('src/styles/two.css') === postTwo, short({
        expected: postTwo.slice(0, 90),
        found: app.read('src/styles/two.css').slice(0, 90),
      }));
      check(`  so nothing references ${from} that nothing declares`, !`${app.read('src/styles/one.css')}${app.read('src/styles/two.css')}`.includes(`var(${from})`));

      unlock(lockRel);
      const retried = await run('project', 'undo');
      await H.settle(200);
      check(`with the file writable again the same undo goes through (${label})`, retried.ok === true && retried.undone === true, short(retried));
      check('  and BOTH stylesheets are byte-identical to what they were', app.read('src/styles/one.css') === preOne && app.read('src/styles/two.css') === preTwo, short({
        one: app.read('src/styles/one.css').slice(0, 90),
        two: app.read('src/styles/two.css').slice(0, 90),
      }));
      check('  with the stack one step shorter', retried.history.past === before.past - 1 && retried.history.future === before.future + 1, short({ before, after: retried.history }));
      // Back to a cleared `future` for the next round, which the next command
      // does on its own.
    }

    // ── 6. NO MODEL/DISK DIVERGENCE ──────────────────────────────────────────
    //
    // The snapshot branch. A page edit, the page made read-only, and an undo
    // whose save cannot land. What must not happen is the editor moving to the
    // restored model while the file still holds the edit: every later ref and
    // digest check is then answering from the wrong side of a disagreement
    // nobody can see.
    let pristine = null;
    {
      const opened = await run('target', 'read');
      const ref = opened.target?.ref || null;
      check('the open page has a ref to write through', !!ref, short({ ref }));
      pristine = app.read(PAGE);
      const before = opened.document?.digest || null;

      const edit = await run('target', 'set_prop', { ref, name: 'id', value: 'edit-a' });
      await H.settle(200);
      const edited = app.read(PAGE);
      check('the page edit lands', edit.ok === true && edited.includes('id="edit-a"'), short(edit));
      const after = edit.document?.digest || null;
      check('  and the editor reports a new digest for it', !!after && after !== before, short({ before, after }));

      lock(PAGE);
      const baseline = await probe('before the unsaveable undo');
      const failed = await run('project', 'undo');
      wire.push(failed);
      check('an undo whose save cannot land is refused', failed.ok === false, short(failed));
      check('  as undo_failed, not command_failed', failed.code === 'undo_failed', short({ code: failed.code }));
      check('  AND THE STACK HAS NOT MOVED', same(failed.history, baseline), short({ before: baseline, after: failed.history }));
      check('  the file still holds the edit', app.read(PAGE) === edited, short(app.read(PAGE).slice(0, 120)));
      // THE HALF THE STACK CANNOT SEE. The bytes above prove the disk did not
      // move; this proves the MODEL did not either.
      check(
        '  AND THE EDITOR STILL REPORTS THE EDITED DOCUMENT, not the one it failed to restore',
        failed.document?.digest === after,
        short({ postEdit: after, pristine: before, reported: failed.document?.digest })
      );

      unlock(PAGE);
      const retried = await run('project', 'undo');
      await H.settle(300);
      check('with the page writable again the same undo goes through', retried.ok === true && retried.undone === true, short(retried));
      check('  and the file is byte-for-byte what it was', app.read(PAGE) === pristine, short(app.read(PAGE).slice(0, 120)));
      check('  with the editor agreeing', retried.document?.digest === before, short({ expected: before, reported: retried.document?.digest }));
      check('  and the stack one step shorter', retried.history.past === baseline.past - 1 && retried.history.future === baseline.future + 1, short({ before: baseline, after: retried.history }));
    }

    // ── 7. AND THE FORWARD OPERATION IS ALL-OR-NOTHING TOO ───────────────────
    //
    // `cssVars.renameVariables` checks everything before it writes anything,
    // and then writes in a loop that can still stop halfway. Its own comment
    // says a half-applied rename is worse than a refused one; this is that
    // sentence as a test. Both files are locked in turn for the same reason as
    // section 5.
    for (const lockRel of ['src/styles/one.css', 'src/styles/two.css']) {
      lock(lockRel);
      const refused = await run('style', 'rename_variables', { renames: [{ from: '--alpha', to: '--alpha-y' }] });
      wire.push(refused);
      check(`a rename that cannot write ${lockRel} is refused`, refused.ok === false, short(refused));
      check('  and NEITHER stylesheet was left rewritten', app.read('src/styles/one.css') === preOne && app.read('src/styles/two.css') === preTwo, short({
        one: app.read('src/styles/one.css').slice(0, 90),
        two: app.read('src/styles/two.css').slice(0, 90),
      }));
      check('  so nothing declares --alpha-y', !`${app.read('src/styles/one.css')}${app.read('src/styles/two.css')}`.includes('--alpha-y'));
      unlock(lockRel);
    }
    {
      // The positive control for the section above: the same rename, with
      // nothing in the way, still renames both files.
      const done = await run('style', 'rename_variables', { renames: [{ from: '--alpha', to: '--alpha-y' }] });
      check('with nothing locked the same rename goes through', done.ok === true, short(done));
      check('  and reaches both files', app.read('src/styles/one.css').includes('--alpha-y') && app.read('src/styles/two.css').includes('var(--alpha-y)'), short({
        one: app.read('src/styles/one.css').slice(0, 90),
        two: app.read('src/styles/two.css').slice(0, 90),
      }));
      const back = await run('project', 'undo');
      await H.settle(200);
      check('  and undoing it puts both stylesheets back exactly', back.ok === true && app.read('src/styles/one.css') === preOne && app.read('src/styles/two.css') === preTwo, short(back));
    }

    // ── 8. THE FILE WHOSE OWN WRITE FAILED IS ROLLED BACK TOO ────────────────
    //
    // Everything above sabotages a write by making a file read-only, and that
    // catches the rollback's first hole and not its second. `open(w)` on a
    // read-only file fails BEFORE it truncates, so the file that could not be
    // written is byte-identical whether or not anybody put it back.
    //
    // A disk that fills up, an I/O error, a volume unplugged mid-write: those
    // fail AFTER the truncate, and `fs.writeFileSync` opens with `w`. All three
    // rollbacks recorded the file in `written` only once its write had
    // RESOLVED, so the one file the write had actually broken was the one file
    // the rollback skipped — left empty or half written while every file around
    // it was restored. Its bytes were already in hand; the ordering was the
    // whole defect.
    //
    // And a file that did not exist when the bytes were captured was created by
    // the forward pass and then skipped by `typeof was !== 'string'` — a
    // rollback that leaves a new file standing has not rolled back.
    //
    // The writer here truncates and then throws, which is what those failures
    // do. The oracle is the bytes on disk, read by this process.
    {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-rollback-'));
      const abs = (name) => path.join(scratch, name);
      const textAt = (name) => (fs.existsSync(abs(name)) ? fs.readFileSync(abs(name), 'utf8') : null);
      const seed = (files) => {
        fs.rmSync(scratch, { recursive: true, force: true });
        fs.mkdirSync(scratch, { recursive: true });
        for (const [name, body] of Object.entries(files)) fs.writeFileSync(abs(name), body, 'utf8');
      };

      // ---- src/App.jsx: writeAllOrNone, as the Agent API's undo calls it ----
      const appText = lift('src/App.jsx', "const UNKNOWN = Symbol('unreadable at capture');", '\n}\n');
      check('writeAllOrNone can be read out of src/App.jsx', !!appText && /async function writeAllOrNone/.test(appText), String(appText).slice(0, 80));
      if (appText && /async function writeAllOrNone/.test(appText)) {
        // eslint-disable-next-line no-new-func
        const writeAllOrNone = new Function(`${appText}\nreturn writeAllOrNone;`)();
        const doors = (breaks, { readThrowsFor = null } = {}) => {
          const writer = truncatingWriter(abs(breaks)); // one writer, so it breaks once
          return {
            read: async (rel) => {
              if (rel === readThrowsFor) throw new Error('EACCES: permission denied, open');
              if (!fs.existsSync(abs(rel))) return null;
              return fs.readFileSync(abs(rel), 'utf8');
            },
            write: async (rel, text) => writer(abs(rel), text),
            remove: async (rel) => fs.rmSync(abs(rel), { force: true }),
          };
        };

        seed({ 'a.css': 'AAA', 'b.css': 'BBB' });
        let threw = null;
        try {
          await writeAllOrNone([['a.css', 'A-NEW'], ['b.css', 'B-NEW']], doors('b.css'));
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('a write that fails halfway comes out as the original error', /ENOSPC/.test(String(threw)), String(threw));
        check('  the file that was written first is put back', textAt('a.css') === 'AAA', String(textAt('a.css')));
        check('  AND SO IS THE FILE THE WRITE ITSELF BROKE', textAt('b.css') === 'BBB', String(textAt('b.css')));

        seed({ 'b.css': 'BBB' });
        threw = null;
        try {
          await writeAllOrNone([['made-up.css', 'BRAND NEW'], ['b.css', 'B-NEW']], doors('b.css'));
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('the same, with a file that did not exist at capture', /ENOSPC/.test(String(threw)), String(threw));
        check('  THE FILE THE ROLLBACK CREATED IS TAKEN AWAY AGAIN', !fs.existsSync(abs('made-up.css')), String(textAt('made-up.css')));
        check('  and the broken file is still put back', textAt('b.css') === 'BBB', String(textAt('b.css')));

        // AND A FILE WHOSE "BEFORE" IS UNKNOWN IS NOT WRITTEN AT ALL.
        //
        // The capture recorded UNKNOWN and the forward pass wrote the file
        // anyway, so the one file the rollback could never repair was the one
        // file the operation had definitely changed — and everything around it
        // was then put back, leaving a project in neither the state before the
        // change nor the state after it, with the unrepairable difference in
        // the file nobody could read. "All or nothing" cannot be promised over
        // bytes that were never captured, so the whole set is refused BEFORE
        // anything is written.
        //
        // THE OTHER WRITE HERE WOULD HAVE SUCCEEDED: nothing breaks the writer
        // in this case, so "nothing was written" is a decision this made and
        // not a failure it ran into.
        seed({ 'unreadable.css': 'MINE', 'b.css': 'BBB' });
        threw = null;
        try {
          await writeAllOrNone([['unreadable.css', 'U-NEW'], ['b.css', 'B-NEW']], doors('nothing-breaks.css', { readThrowsFor: 'unreadable.css' }));
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('a file that could not be READ at capture refuses the whole write', !!threw, 'it went through');
        check('  naming the file it could not read', /unreadable\.css/.test(String(threw)), String(threw));
        check('  and saying nothing was written', /nothing was written/i.test(String(threw)), String(threw));
        check('  keeping the original error as the reason', /EACCES/.test(String(threw)), String(threw));
        // "There was no file" and "I could not look" must not be the same
        // answer: deleting on the second destroys bytes nobody asked to lose.
        check('  A FILE IT COULD NOT READ IS NOT DELETED', fs.existsSync(abs('unreadable.css')), 'gone');
        check('  NOR WRITTEN OVER', textAt('unreadable.css') === 'MINE', String(textAt('unreadable.css')));
        check('  and the file it COULD have written is untouched', textAt('b.css') === 'BBB', String(textAt('b.css')));

        // The same refusal when the unreadable file is second in the list: the
        // capture pass is over the whole set before any of it is written, so
        // the order the entries arrive in cannot decide whether a file moves.
        seed({ 'a.css': 'AAA', 'unreadable.css': 'MINE' });
        threw = null;
        try {
          await writeAllOrNone([['a.css', 'A-NEW'], ['unreadable.css', 'U-NEW']], doors('nothing-breaks.css', { readThrowsFor: 'unreadable.css' }));
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('the same when the unreadable file is not the first entry', !!threw, 'it went through');
        check('  and the file BEFORE it in the list never moved', textAt('a.css') === 'AAA', String(textAt('a.css')));
      }

      // ---- src/App.jsx: settledSave, WHAT A FINISHED SAVE MAY CLAIM ----
      //
      // `flushSave` reads the open document, writes it over IPC, and records
      // the outcome afterwards. Between those two the state can have moved —
      // and the person editing on the canvas is not on the queue that
      // serialises the agent's four doors, so it is a UI edit that gets in
      // here. The updater used to clear `dirty` on whatever it was handed, so
      // an edit that arrived during the write was marked saved without ever
      // being written: on screen, not on disk, and with the one flag that
      // would have made the next save write it now cleared. `savedSource` went
      // the same way, recording the OLD model's bytes as the new model's —
      // which is what `applySnapshot`'s bytes-landed check reads to decide
      // whether a restore actually happened.
      //
      // LIFTED RATHER THAN DRIVEN, and this is the reason: the harness has no
      // canvas and no person, so the one door that reaches this cannot be
      // opened from here. Section 9f drives the door that CAN be opened — an
      // agent operation racing a restore — through the whole stack. This is the
      // shipped function itself, run against the two states it has to tell
      // apart, so a change to it fails here rather than quietly nowhere.
      {
        const saveText = lift('src/App.jsx', 'function settledSave(now, written, source) {', '\n}\n');
        check('settledSave can be read out of src/App.jsx', !!saveText && /const moved =/.test(String(saveText)), String(saveText).slice(0, 80));
        if (saveText && /const moved =/.test(saveText)) {
          // eslint-disable-next-line no-new-func
          const settledSave = new Function(`${saveText}\nreturn settledSave;`)();
          const model = { nodes: [{ id: 'a' }] };
          const written = { file: 'src/pages/index.astro', model, source: 'OLD', savedSource: 'OLD', restoreSource: null, dirty: true, editable: true };

          // NOTHING MOVED: the ordinary save, which must still settle.
          const settled = settledSave({ ...written }, written, 'WHAT WAS WRITTEN');
          check('a save over a document nobody touched clears dirty', settled.dirty === false, short(settled));
          check('  and records the bytes it wrote', settled.savedSource === 'WHAT WAS WRITTEN', short(settled.savedSource));
          check('  and clears the pending restore', settled.restoreSource === null, short(settled.restoreSource));

          // A MODEL THAT MOVED UNDER THE WRITE: a canvas edit during the IPC.
          const edited = { ...written, model: { nodes: [{ id: 'a' }, { id: 'b' }] }, dirty: true };
          const afterEdit = settledSave(edited, written, 'WHAT WAS WRITTEN');
          check('AN EDIT THAT LANDED DURING THE WRITE IS NOT MARKED SAVED', afterEdit.dirty === true, short(afterEdit));
          check('  so the save it scheduled still has something to write', afterEdit.model === edited.model, short(afterEdit.model));
          check('  and the older bytes are not recorded as this document’s', afterEdit.savedSource === 'OLD', short(afterEdit.savedSource));

          // THE OTHER TWO THINGS A SAVE IS ABOUT, each on its own.
          const navigated = settledSave({ ...written, file: 'src/pages/about.astro' }, written, 'WHAT WAS WRITTEN');
          check('a document that changed under the write is not marked saved either', navigated.dirty === true, short(navigated));
          const retyped = settledSave({ ...written, source: 'NEWER' }, written, 'WHAT WAS WRITTEN');
          check('nor is a raw source that moved', retyped.dirty === true && retyped.source === 'NEWER', short(retyped));
          const restoring = settledSave({ ...written, restoreSource: 'A RESTORE ARRIVED' }, written, 'WHAT WAS WRITTEN');
          check('nor is a restore that arrived during it', restoring.dirty === true && restoring.restoreSource === 'A RESTORE ARRIVED', short(restoring));

          // A save that reports no bytes keeps what the state already had —
          // `writePage` answering without text is not a claim about the file.
          const noText = settledSave({ ...written }, written, undefined);
          check('a write that reported no bytes leaves savedSource as it was', noText.dirty === false && noText.savedSource === 'OLD', short(noText));
          // And a document that closed under the write is not resurrected.
          check('a document that closed under the write stays closed', settledSave(null, written, 'X') === null, 'a state appeared from nowhere');
        }
      }


      // ---- src/App.jsx: the restore oracle asks the FILE, not savedSource ----
      //
      // Required core CI caught a state the previous postcondition called
      // impossible: a batched target.edit was physically undone byte-for-byte,
      // while React had not yet committed the `savedSource` bookkeeping update.
      // `settledSave` is allowed to keep that metadata stale on purpose, so it
      // cannot also be the proof that the write reached disk.
      {
        const reachedText = lift(
          'src/App.jsx',
          'async function restoreReachedFile(file, source, readPage) {',
          '\n}\n'
        );
        check(
          'restoreReachedFile can be read out of src/App.jsx',
          !!reachedText && /await readPage\(file\)/.test(String(reachedText)),
          String(reachedText).slice(0, 120)
        );
        if (reachedText && /await readPage\(file\)/.test(reachedText)) {
          // eslint-disable-next-line no-new-func
          const restoreReachedFile = new Function(`${reachedText}\nreturn restoreReachedFile;`)();
          let asked = null;
          const staleSavedSource = 'THE EDIT, DELIBERATELY STALE';
          const landed = await restoreReachedFile('src/pages/index.astro', 'THE SNAPSHOT', async (file) => {
            asked = file;
            return { source: 'THE SNAPSHOT' };
          });
          check(
            'a restore that IS on disk is accepted even while savedSource is stale',
            landed === true && staleSavedSource !== 'THE SNAPSHOT',
            short({ landed, staleSavedSource })
          );
          check('  and it asked the exact file being restored', asked === 'src/pages/index.astro', String(asked));
          check(
            'a different file value does not pass for the snapshot',
            (await restoreReachedFile('src/pages/index.astro', 'THE SNAPSHOT', async () => ({ source: 'SOMETHING ELSE' }))) === false,
            'a mismatched file was accepted'
          );
          check(
            'a file that cannot be read does not become a successful undo',
            (await restoreReachedFile('src/pages/index.astro', 'THE SNAPSHOT', async () => {
              throw new Error('EIO');
            })) === false,
            'a failed read was accepted'
          );
        }

        const appSource = fs.readFileSync(path.join(__dirname, '..', 'src/App.jsx'), 'utf8');
        const applyAt = appSource.indexOf('const applySnapshot = useCallback(async (entry) => {');
        const flushAt = appSource.indexOf('await flushSave();', applyAt);
        const diskAt = appSource.indexOf(
          'await restoreReachedFile(entry.file, entry.source, window.avb.readPage)',
          flushAt
        );
        check(
          'applySnapshot verifies the file itself AFTER flushSave returns',
          applyAt >= 0 && flushAt > applyAt && diskAt > flushAt && diskAt - flushAt < 3000,
          short({ applyAt, flushAt, diskAt })
        );
      }

      // ---- src/panels/VariablesView.jsx: putFiles, the panel's own twin ----
      const panelText = lift('src/panels/VariablesView.jsx', '    async (texts) => {', '\n    }');
      check('putFiles can be read out of src/panels/VariablesView.jsx', !!panelText && /const written = \[\]/.test(panelText), String(panelText).slice(0, 80));
      // AND THE SENTINEL IS LIFTED TOO, because it is half of what is being
      // graded.
      //
      // This used to declare its OWN `Symbol('unreadable at capture')` and pass
      // it in, because the shipped `const UNKNOWN = ...` sits outside the
      // lifted span. So the value the rollback compares against was this file's
      // and the shipped one was never run: replacing it with
      // `const UNKNOWN = null;` left this suite at 193 passed while the panel's
      // rollback stopped being able to tell "there was no file" from "I could
      // not look at the file", and started deleting sheets it had never read.
      // The header of this file promises that a change to the closure the lift
      // reads fails loudly rather than quietly testing nothing; lifting the
      // declaration itself is what makes that true of this one.
      //
      // `src/App.jsx`'s lift above starts AT its own copy of this line, so the
      // twin has been graded all along — which is exactly why the two must not
      // drift.
      const panelUnknown = lift('src/panels/VariablesView.jsx', 'const UNKNOWN =', ';');
      check(
        'the sentinel putFiles compares against is read out of the panel too',
        /^const UNKNOWN = \S.*;$/.test(String(panelUnknown)),
        String(panelUnknown)
      );
      if (panelText && /const written = \[\]/.test(panelText) && panelUnknown) {
        const makePutFiles = (breaks, { readThrowsFor = null } = {}) => {
          const writer = truncatingWriter(abs(breaks)); // one writer, so it breaks once
          // The panel's `bridge`, which SWALLOWS whatever the handler threw and
          // answers `{ok:false, error}` — the reason a refused write used to
          // walk straight past the rollback.
          const bridge = async (name, payload) => {
            try {
              if (name === 'readStyleFile') {
                if (readThrowsFor && String(payload) === abs(readThrowsFor)) {
                  throw new Error('EACCES: permission denied, open');
                }
                return { css: fs.readFileSync(String(payload), 'utf8') };
              }
              if (name === 'writeStyleFile') {
                writer(payload.filePath, payload.css);
                return { ok: true };
              }
              if (name === 'deleteAsset') {
                fs.rmSync(path.join(payload.projectPath, payload.rel), { force: true });
                return { ok: true };
              }
              return { ok: true };
            } catch (err) {
              return { ok: false, error: String(err?.message || err) };
            }
          };
          // The shipped declaration runs INSIDE the closure the lift builds, so
          // `UNKNOWN` in the lifted body is the shipped value and nothing else.
          // eslint-disable-next-line no-new-func
          return new Function('bridge', 'project', 'refresh', `${panelUnknown}\nreturn (${panelText});`)(
            bridge,
            { path: scratch },
            async () => {}
          );
        };

        seed({ 'a.css': 'AAA', 'b.css': 'BBB' });
        let threw = null;
        try {
          await makePutFiles('b.css')({ 'a.css': 'A-NEW', 'b.css': 'B-NEW' });
        } catch (err) {
          threw = String(err?.message || err);
        }
        // The panel's bridge never throws, so a refused write reported success
        // and the rollback below this was unreachable code.
        check('the panel’s putFiles raises a refused write instead of swallowing it', /ENOSPC/.test(String(threw)), String(threw));
        check('  the sheet it wrote first is put back', textAt('a.css') === 'AAA', String(textAt('a.css')));
        check('  AND SO IS THE SHEET THE WRITE ITSELF BROKE', textAt('b.css') === 'BBB', String(textAt('b.css')));

        seed({ 'b.css': 'BBB' });
        threw = null;
        try {
          await makePutFiles('b.css')({ 'made-up.css': 'BRAND NEW', 'b.css': 'B-NEW' });
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('the panel’s rollback, with a sheet that did not exist at capture', /ENOSPC/.test(String(threw)), String(threw));
        check('  THE SHEET IT CREATED IS TAKEN AWAY AGAIN', !fs.existsSync(abs('made-up.css')), String(textAt('made-up.css')));
        check('  and the broken one is still put back', textAt('b.css') === 'BBB', String(textAt('b.css')));

        // The third capture state, the one the sentinel exists for — AND BOTH
        // HALVES OF IT, which is what this used to ask only one of.
        //
        // "There was no file" and "I could not look" must not be the same
        // answer: deleting on the second throws away bytes nobody asked to
        // lose. That half was here. The other half is that a sheet whose old
        // bytes could not be read must not be WRITTEN either — it is the one
        // file the rollback can never repair, so writing it and putting every
        // other file back around it leaves the project in neither the state
        // before the change nor the state after it. `writeAllOrNone` in
        // src/App.jsx is asked both, and its comment says "fix one and fix the
        // other"; only one was fixed. Measured on the shipped panel before
        // this, with the read of unreadable.css refused and the write of b.css
        // refused: b.css came back to "BBB" and unreadable.css was left holding
        // "U-NEW", its original bytes gone.
        //
        // THE UNREADABLE SHEET IS FIRST IN THE ENTRY ORDER, so the write really
        // is attempted on it — an entry the loop never reaches would pass this
        // for the wrong reason. And NOTHING ELSE BREAKS: the writer is armed
        // for a file that is not in the set, so "nothing was written" is a
        // decision the panel made and not a failure it ran into.
        seed({ 'unreadable.css': 'MINE', 'b.css': 'BBB' });
        threw = null;
        try {
          await makePutFiles('nothing-breaks.css', { readThrowsFor: 'unreadable.css' })({ 'unreadable.css': 'U-NEW', 'b.css': 'B-NEW' });
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('a sheet the panel could not READ at capture refuses the whole write', !!threw, 'it went through');
        check('  naming the sheet it could not read', /unreadable\.css/.test(String(threw)), String(threw));
        check('  and saying nothing was written', /nothing was written/i.test(String(threw)), String(threw));
        check('  keeping the original error as the reason', /EACCES/.test(String(threw)), String(threw));
        check('  A SHEET IT COULD NOT READ IS NOT DELETED BY THE PANEL EITHER', fs.existsSync(abs('unreadable.css')), 'gone');
        check('  NOR WRITTEN OVER BY THE PANEL EITHER', textAt('unreadable.css') === 'MINE', String(textAt('unreadable.css')));
        check('  and the sheet it COULD have written is untouched', textAt('b.css') === 'BBB', String(textAt('b.css')));

        // The same refusal with the unreadable sheet SECOND: the capture pass
        // covers the whole set before any of it is written, so the order the
        // entries arrive in cannot decide whether a sheet moves.
        seed({ 'a.css': 'AAA', 'unreadable.css': 'MINE' });
        threw = null;
        try {
          await makePutFiles('nothing-breaks.css', { readThrowsFor: 'unreadable.css' })({ 'a.css': 'A-NEW', 'unreadable.css': 'U-NEW' });
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('the same when the unreadable sheet is not the first entry', !!threw, 'it went through');
        check('  and the sheet BEFORE it in the list never moved', textAt('a.css') === 'AAA', String(textAt('a.css')));
      }

      fs.rmSync(scratch, { recursive: true, force: true });
    }

    // ── 8b. AND THE MAIN PROCESS'S OWN COMMIT LOOP ───────────────────────────
    //
    // `cssVars.renameVariables` is the third copy of the same rollback, and it
    // is called directly rather than lifted: it is an ordinary module in this
    // process, so the seam is `fs.writeFileSync` itself. Patched to truncate
    // and throw on its FIRST write, whichever file the walk reaches first —
    // which makes the assertion independent of the walk order, unlike the
    // read-only sabotage in section 7.
    {
      const scratch = H.makeProject({
        'src/styles/one.css': ONE,
        'src/styles/two.css': TWO,
      });
      const { renameVariables } = require('../electron/cssVars.js');
      const wasOne = fs.readFileSync(path.join(scratch, 'src/styles/one.css'), 'utf8');
      const wasTwo = fs.readFileSync(path.join(scratch, 'src/styles/two.css'), 'utf8');
      const real = fs.writeFileSync;
      let broke = null;
      fs.writeFileSync = function (target, data, encoding) {
        if (!broke && String(target).startsWith(scratch) && /\.css$/.test(String(target))) {
          broke = String(target);
          real.call(fs, target, '', 'utf8'); // the truncate `open(w)` does
          const err = new Error('ENOSPC: no space left on device, write');
          err.code = 'ENOSPC';
          throw err;
        }
        return real.call(fs, target, data, encoding);
      };
      let threw = null;
      try {
        renameVariables(scratch, { renames: [{ from: '--alpha', to: '--alpha-q' }] });
      } catch (err) {
        threw = String(err?.message || err);
      } finally {
        fs.writeFileSync = real;
      }
      check('a rename whose first write fails after truncating is refused', /ENOSPC/.test(String(threw)), String(threw));
      check('  and it did break a file, so the rollback had something to do', !!broke && /\.css$/.test(String(broke)), String(broke));
      check(
        '  BOTH STYLESHEETS ARE BYTE-IDENTICAL, INCLUDING THE ONE IT TRUNCATED',
        fs.readFileSync(path.join(scratch, 'src/styles/one.css'), 'utf8') === wasOne &&
          fs.readFileSync(path.join(scratch, 'src/styles/two.css'), 'utf8') === wasTwo,
        short({
          one: fs.readFileSync(path.join(scratch, 'src/styles/one.css'), 'utf8').slice(0, 60),
          two: fs.readFileSync(path.join(scratch, 'src/styles/two.css'), 'utf8').slice(0, 60),
        })
      );
      check('  so nothing declares --alpha-q', !`${fs.readFileSync(path.join(scratch, 'src/styles/one.css'), 'utf8')}${fs.readFileSync(path.join(scratch, 'src/styles/two.css'), 'utf8')}`.includes('--alpha-q'));
      H.removeProject(scratch);
    }

    // ── 9. NOBODY'S FILESYSTEM ───────────────────────────────────────────────
    //
    // Every refusal above was built somewhere that had an absolute path in its
    // hands. `message` was scrubbed; `restored.failed` was not, and it is the
    // field that carries the reason.
    //
    // THE ORACLE USED TO BE ONE SPELLING OF ONE STRING. `includes(root)` and
    // nothing else, and on macOS the fixture root is `/var/folders/…` while its
    // realpath is `/private/var/folders/…` — so a refusal naming the RESOLVED
    // spelling of the very same file passed unremarked, as would one naming the
    // home directory, the temp directory, or any absolute path from somewhere
    // else entirely. It is the same oracle test/refusal-contract.js uses, and
    // it is here at the same strength.
    {
      const carrying = wire.map((envelope) => [envelope, hostPathsIn(envelope, root)]).filter(([, hits]) => hits.length);
      check(
        `none of the ${wire.length} envelopes names this machine's filesystem`,
        carrying.length === 0,
        carrying.map(([envelope, hits]) => `${hits.join('; ')} :: ${short(envelope, 300)}`).join('\n    ')
      );
      const reasons = wire.map((envelope) => envelope?.restored?.failed).filter(Boolean);
      check('and the ones that explain a failed inverse said something', reasons.length >= 3, short(reasons));
      check('  in project-relative terms', reasons.every((reason) => hostPathsIn(reason, root).length === 0), short(reasons));

      // AND THE ORACLE CAN SEE A PATH WHEN THERE IS ONE. Every assertion above
      // is an absence, so an oracle that had stopped looking would satisfy all
      // of them. Four spellings, each of which has to be caught. (The resolved
      // root is the weakest of the four on macOS, where realpath prefixes
      // `/private` and the old one-string oracle caught it as a substring by
      // luck; the home directory and a path from somewhere else are the two it
      // genuinely could not see, and narrowing this back turns both red.)
      for (const [what, needle] of [
        ['the fixture root', root],
        ['the resolved fixture root', fs.realpathSync(root)],
        ['the home directory', os.homedir()],
        ['a path from somewhere else', '/Applications/Something.app/Contents'],
      ]) {
        // A space in front, which is what the shape rule anchors on: a
        // project-relative `src/pages/index.astro` must not be mistaken for an
        // absolute path, so the rule cannot simply look for a leading slash.
        check(`  the oracle catches ${what}`, hostPathsIn({ restored: { failed: `open ${needle}/x.css` } }, root).length > 0, needle);
      }

      // AND IT CATCHES THEM HOWEVER THE MESSAGE QUOTES THEM.
      //
      // The four rows above all put a SPACE in front of the path, and the copy
      // of the oracle that used to live in this file anchored only on a space,
      // a double quote or an open paren. Node's fs errors use none of those —
      // `EACCES: permission denied, open '/Users/…'` puts an APOSTROPHE there —
      // so the one spelling that actually arrives was the one spelling the
      // oracle could not see, and every absence assertion above passed on it.
      // The path here is deliberately not under the fixture root, the temp
      // directory or the home directory, so none of the four named needles can
      // answer for the shape rule: this measures the shape rule alone.
      for (const [how, message] of QUOTINGS) {
        const elsewhere = '/Applications/Something.app/Contents';
        check(
          `  and catches a path written ${how}`,
          hostPathsIn({ restored: { failed: message(elsewhere) } }, root).length > 0,
          message(elsewhere)
        );
      }
      // AND STILL DOES NOT CALL A PROJECT-RELATIVE FILE A LEAK, which is the
      // property the anchoring exists for and the one a wider rule would lose:
      // a "fix" that matched any slash turns every refusal this suite is built
      // on into a false positive, and this is where that would show.
      for (const relative of ['src/pages/index.astro', "EACCES: permission denied, open 'src/styles/one.css'"]) {
        check(
          `  and does not mistake ${relative.slice(0, 42)} for a host path`,
          hostPathsIn({ restored: { failed: relative } }, root).length === 0,
          relative
        );
      }

      // ── THE SCRUBBER ITSELF, ON THE TWO SHAPES A WALK CAN GET WRONG ────────
      //
      // `scrubHostPaths` kept a set of every object it had visited and answered
      // `return value` — the ORIGINAL — on a second visit. That is not a cycle
      // guard, it is a de-duplicator, and it fired for an ordinary graph: one
      // error object carried under two fields of a refusal. Electron's IPC uses
      // structured clone, which PRESERVES shared references, so the first field
      // went out project-relative and the second went out with the host path
      // intact — the exact thing the function exists to stop. Neither shape can
      // be ordered up from an end-to-end refusal, because the renderer builds
      // the object, so the function is asked directly.
      {
        const { scrubHostPaths } = require('../electron/mcp/agent');
        const shared = { failed: `EACCES: open '${root}/src/styles/one.css'` };
        const both = scrubHostPaths({ ok: false, restored: shared, cause: shared, all: [shared] }, root);
        check('a scrubbed refusal says the first reference project-relative', both.restored.failed === "EACCES: open 'src/styles/one.css'", String(both.restored.failed));
        check('  AND THE SECOND REFERENCE TO THE SAME OBJECT TOO', both.cause.failed === "EACCES: open 'src/styles/one.css'", String(both.cause.failed));
        check('  and a third from inside an array', both.all[0].failed === "EACCES: open 'src/styles/one.css'", String(both.all[0].failed));
        check('  so nothing in it names this machine', hostPathsIn(both, root).length === 0, short(both));
        check('  with the sharing preserved, not the host path', both.restored === both.cause, 'the two fields are separate copies');

        // And a real cycle still terminates — the reason the visited set was
        // there at all — onto the SCRUBBED copy rather than the original.
        const loop = { message: `EACCES: open '${root}/src/styles/two.css'` };
        loop.self = loop;
        loop.list = [loop];
        const walked = scrubHostPaths(loop, root);
        check('a cycle is walked without a stack overflow', walked.message === "EACCES: open 'src/styles/two.css'", String(walked.message));
        check('  and closes onto the scrubbed copy', walked.self === walked && walked.list[0] === walked, 'the loop reopened the original');
        check('  so a cycle names this machine nowhere either', hostPathsIn(walked.message, root).length === 0, String(walked.message));
      }
    }

    // ── 9b. CLOSING A PAGE ENDS THE REDO BRANCH TOO ──────────────────────────
    //
    // `dropPageHistory` exists for one reason: a page snapshot describes ONE
    // document, so when that document is closed the snapshot must not survive
    // to be replayed onto another. It rebuilt both stacks with
    // `filter(e => e.kind === 'cmd')` — and never bumped `redoEpoch`.
    //
    // The epoch is what an undo still in flight compares against. It takes its
    // redo point — a snapshot of the page being closed — BEFORE its restore
    // reaches disk and pushes it AFTER, guarded by `stillRedoable()`. With the
    // epoch untouched that guard was true straight across the purge, so the
    // snapshot the filter had just removed came back onto `future` a moment
    // later, and the next redo applied a page's bytes to whatever document was
    // open by then.
    //
    // MEASURED, against the shipped renderer with the epoch bump removed:
    // `future: 1` after the undo, `project.redo` answering `redone: true`, and
    // src/pages/about.astro on disk holding the whole of src/pages/index.astro.
    //
    // HOW THE INTERLEAVE IS MADE, and why it is not a stub. Nothing is
    // reimplemented: the real undo runs the real restore through the real main
    // handler. One save is HELD OPEN at the door — the way a slow volume holds
    // one — so the page close happens while the undo is genuinely mid-flight
    // rather than whenever the machine happens to schedule it. The hold is
    // itself asserted: the navigation does not start until the save is known to
    // be waiting, so a run in which the undo had already finished cannot pass
    // here by accident.
    {
      const refs = require('../electron/mcp/agent/refs.js');
      const ON_INDEX = { keys: ['src/pages/index.astro#0.2'], fingerprint: { tag: 'footer' }, page: { file: 'src/pages/index.astro' } };
      const ON_ABOUT = { keys: ['src/pages/about.astro#0.0'], fingerprint: { tag: 'h1' }, page: { file: 'src/pages/about.astro' } };
      const refFor = (anchor) => refs.mint('node', anchor, { projectRoot: root });

      const opened = await run('target', 'read', { ref: refFor(ON_INDEX) });
      check('9b: the page to be closed is open', opened.ok === true && opened.target?.page?.file === 'src/pages/index.astro', short(opened.target?.page));
      const indexWas = app.read('src/pages/index.astro');
      const aboutWas = app.read('src/pages/about.astro');
      const wrote = await run('target', 'set_text', { ref: opened.target.ref, text: 'EDITED ON INDEX' });
      check('9b: an edit to it is recorded', wrote.ok === true, short(wrote));
      await H.settle(200);
      check('9b:   and is on disk', app.read('src/pages/index.astro').includes('EDITED ON INDEX'), short(app.read('src/pages/index.astro').slice(0, 120)));

      // The door the restore goes through, held open once. The real handler
      // still does the real write; only the moment it returns is chosen.
      let opening = null;
      const atTheDoor = new Promise((done) => {
        opening = done;
      });
      let letGo = null;
      const held = new Promise((done) => {
        letGo = done;
      });
      const realWrite = global.avb.writePageRaw;
      let holding = false;
      global.avb.writePageRaw = async (arg) => {
        if (!holding) {
          holding = true;
          opening();
          await held;
        }
        return realWrite(arg);
      };
      let undone = null;
      try {
        const undoing = run('project', 'undo');
        await atTheDoor;
        check('9b: the undo is genuinely mid-restore when the page closes', holding === true);
        // The page closes. This is the ordinary navigation — the same
        // `selectPage` -> `openFile` -> `dropPageHistory` a person's click makes.
        const moved = await run('target', 'read', { ref: refFor(ON_ABOUT) });
        check('9b: a different document is open now', moved.ok === true && moved.target?.page?.file === 'src/pages/about.astro', short(moved.target?.page));
        letGo();
        undone = await undoing;
        await H.settle(300);
      } finally {
        global.avb.writePageRaw = realWrite;
      }

      check('9b: the undo itself still happened', undone?.ok === true && undone?.undone === true, short(undone));
      // THE ASSERTION THE DEFECT FAILS. The snapshot belonged to a page that is
      // no longer open, so there is nothing for redo to be about.
      check(
        '9b: a snapshot of the closed page is not left on the redo stack',
        undone?.history?.future === 0,
        short(undone?.history)
      );
      const redone = await run('project', 'redo');
      await H.settle(300);
      check('9b: so redo has nothing to replay', redone.ok === true && redone.redone === false, short(redone));
      // AND THE BYTES, which is what the whole guard is for: the other page's
      // file must not hold the page the snapshot came from.
      check(
        '9b: the page that is open was not overwritten with the page that closed',
        app.read('src/pages/about.astro') === aboutWas,
        short(app.read('src/pages/about.astro').slice(0, 160))
      );
      check(
        '9b:   and it is still the about page',
        !app.read('src/pages/about.astro').includes('pricing-grid'),
        short(app.read('src/pages/about.astro').slice(0, 160))
      );
      // The undo did what it said: the edit is off the page it was made on.
      check('9b: the edit was taken back where it was made', app.read('src/pages/index.astro') === indexWas, short(app.read('src/pages/index.astro').slice(0, 160)));
    }

    // ── 9c. AND SO DOES A REDO ───────────────────────────────────────────────
    //
    // 9b is the undo direction. The redo direction was left ungated on the
    // reasoning that a redo which ran is undoable whatever happened next, and
    // that reasoning is right about a COMMAND and wrong about a page SNAPSHOT.
    //
    // `redoStep` takes its undo point — a snapshot of the page that is open —
    // before its restore reaches disk and pushes it after. `dropPageHistory`
    // purges both stacks in between, because a snapshot replayed onto the
    // wrong file cannot be got back. Measured on the shipped renderer with
    // `project.redo` and `target.enter` in one `Promise.all`, three runs in
    // three: the snapshot of src/pages/index.astro landed on `past` after the
    // purge, and the `project.undo` after it wrote the whole of index.astro
    // over src/layouts/Base.astro — answering `ok: true, undone: true` with
    // `document: {file: "src/layouts/Base.astro"}`.
    //
    // The interleave is made the same way 9b makes it: one real save held at
    // the real door, with the hold itself asserted before the page is closed,
    // so a run that lost the race fails rather than passes.
    {
      const refs = require('../electron/mcp/agent/refs.js');
      const ON_INDEX = { keys: ['src/pages/index.astro#0.2'], fingerprint: { tag: 'footer' }, page: { file: 'src/pages/index.astro' } };
      const ON_ABOUT = { keys: ['src/pages/about.astro#0.0'], fingerprint: { tag: 'h1' }, page: { file: 'src/pages/about.astro' } };
      const refFor = (anchor) => refs.mint('node', anchor, { projectRoot: root });

      // Taken before anything is pushed, because what this section asserts is
      // that the purge leaves the stack EXACTLY as deep as the commands on it
      // — the snapshot in flight is not on it, and nor is the one the redo took.
      const base = await probe('9c: before the held redo');

      const opened = await run('target', 'read', { ref: refFor(ON_INDEX) });
      check('9c: the page the snapshot belongs to is open', opened.ok === true && opened.target?.page?.file === 'src/pages/index.astro', short(opened.target?.page));
      const indexWas = app.read('src/pages/index.astro');
      const aboutWas = app.read('src/pages/about.astro');
      const wrote = await run('target', 'set_text', { ref: opened.target.ref, text: 'EDITED FOR THE REDO' });
      check('9c: an edit to it is recorded', wrote.ok === true, short(wrote));
      await H.settle(200);
      const indexEdited = app.read('src/pages/index.astro');
      check('9c:   and is on disk', indexEdited.includes('EDITED FOR THE REDO'), short(indexEdited.slice(0, 120)));
      const undone = await run('project', 'undo');
      await H.settle(200);
      check('9c: it is undone, so there is something to redo', undone.ok === true && undone.history?.future === 1, short(undone.history));
      check('9c:   and the page is back as it was', app.read('src/pages/index.astro') === indexWas, short(app.read('src/pages/index.astro').slice(0, 120)));

      let opening = null;
      const atTheDoor = new Promise((done) => {
        opening = done;
      });
      let letGo = null;
      const held = new Promise((done) => {
        letGo = done;
      });
      const realWrite = global.avb.writePageRaw;
      let holding = false;
      global.avb.writePageRaw = async (arg) => {
        if (!holding) {
          holding = true;
          opening();
          await held;
        }
        return realWrite(arg);
      };
      let redone = null;
      let moved = null;
      try {
        const redoing = run('project', 'redo');
        await atTheDoor;
        check('9c: the redo is genuinely mid-restore when the page closes', holding === true);
        moved = await run('target', 'read', { ref: refFor(ON_ABOUT) });
        check('9c: a different document is open now', moved.ok === true && moved.target?.page?.file === 'src/pages/about.astro', short(moved.target?.page));
        letGo();
        redone = await redoing;
        await H.settle(300);
      } finally {
        global.avb.writePageRaw = realWrite;
      }

      check('9c: the redo itself still happened', redone?.ok === true && redone?.redone === true, short(redone));
      // THE ASSERTION THE DEFECT FAILS. `past` may hold the commands earlier
      // sections recorded — those survive the purge and are meant to — and
      // nothing else. One more than that is the snapshot of the page that just
      // closed, sitting where the next undo will find it.
      check(
        '9c: A SNAPSHOT OF THE CLOSED PAGE IS NOT LEFT ON THE UNDO STACK',
        redone?.history?.past === base.past,
        short({ base, after: redone?.history })
      );
      const after = await run('project', 'undo');
      await H.settle(300);
      check(
        '9c: so the undo after it is not about a page that is no longer open',
        after.ok === false || after.undone === false || after.restored?.kind === 'cmd',
        short(after)
      );
      // AND THE BYTES, which is what the whole guard is for.
      check(
        '9c: the page that is open was not overwritten with the page that closed',
        app.read('src/pages/about.astro') === aboutWas,
        short(app.read('src/pages/about.astro').slice(0, 160))
      );
      check(
        '9c:   and it is still the about page',
        !app.read('src/pages/about.astro').includes('pricing-grid'),
        short(app.read('src/pages/about.astro').slice(0, 160))
      );
      // The redo did what it said, and on the page the edit was made on.
      check('9c: the redo was replayed where the edit was made', app.read('src/pages/index.astro') === indexEdited, short(app.read('src/pages/index.astro').slice(0, 160)));
      // Back to the fixture's own bytes for what follows: `after` above already
      // undid whatever command was on top, so this puts the page back by hand.
      const back = await run('target', 'read', { ref: refFor(ON_INDEX) });
      if (back.ok) await run('target', 'set_text', { ref: back.target.ref, text: 'Made carefully.' });
      await H.settle(200);
    }

    // ── 9d. AN UNDO AND AN EDIT AT ONCE ARE BOTH TRUE ────────────────────────
    //
    // `oneAtATime` serialised undo against undo and redo against undo. Nothing
    // serialised either against an EDIT — and `applySnapshot` rewrites the
    // WHOLE document from a state captured before the concurrent edit existed,
    // so whichever save lost was discarded without a word.
    //
    // Measured on the shipped renderer, `project.undo` and `target.set_text` in
    // one `Promise.all`, three runs in three: the undo landed, `target.set_text`
    // answered `ok: true`, and its bytes were never on disk at all. Both calls
    // reported success for a pair of changes only one of which had happened.
    //
    // The same held door as 9b and 9c, and it is what makes the ordering an
    // assertion rather than a hope: the undo is parked inside its real write,
    // and the edit is issued while it is parked. An edit that runs during that
    // window is an edit racing a whole-document restore.
    {
      const refs = require('../electron/mcp/agent/refs.js');
      const ON_INDEX = { keys: ['src/pages/index.astro#0.2'], fingerprint: { tag: 'footer' }, page: { file: 'src/pages/index.astro' } };
      const refFor = (anchor) => refs.mint('node', anchor, { projectRoot: root });

      // Read by ref to open the page and put the selection on the footer; then
      // edit THROUGH THE SELECTION, with no ref. That is the shape the defect
      // was measured in, and it is the shape that reaches the renderer: a ref
      // carries the revision it was minted at and is refused as stale after the
      // undo has moved it, which is a different (and correct) refusal that
      // would answer this section's question by not asking it.
      const opened = await run('target', 'read', { ref: refFor(ON_INDEX) });
      check('9d: the page is open', opened.ok === true && opened.target?.page?.file === 'src/pages/index.astro', short(opened.target?.page));
      check('9d:   with the node to edit selected', opened.target?.tag === 'footer', short(opened.target?.tag));
      const before = await run('target', 'set_text', { text: 'FIRST OF THE PAIR' });
      check('9d: the edit that will be undone lands', before.ok === true, short(before));
      await H.settle(UNCOALESCED);
      check('9d:   and is on disk', app.read('src/pages/index.astro').includes('FIRST OF THE PAIR'), short(app.read('src/pages/index.astro').slice(0, 120)));

      let opening = null;
      const atTheDoor = new Promise((done) => {
        opening = done;
      });
      let letGo = null;
      const held = new Promise((done) => {
        letGo = done;
      });
      const realWrite = global.avb.writePageRaw;
      let holding = false;
      global.avb.writePageRaw = async (arg) => {
        if (!holding) {
          holding = true;
          opening();
          await held;
        }
        return realWrite(arg);
      };
      let undone = null;
      let edited = null;
      let startedUnderTheUndo = null;
      try {
        const undoing = run('project', 'undo');
        await atTheDoor;
        check('9d: the undo is genuinely mid-restore when the edit arrives', holding === true);
        let editSettled = false;
        const editing = run('target', 'set_text', { text: 'SECOND OF THE PAIR' }).then((answer) => {
          editSettled = true;
          return answer;
        });
        // Long enough for an unserialised edit to run to the end: it writes
        // through a different door (`writePage`, for a model) and nothing holds
        // that one, so it settles here or it was made to wait.
        await H.settle(300);
        startedUnderTheUndo = editSettled;
        letGo();
        undone = await undoing;
        edited = await editing;
        await H.settle(400);
      } finally {
        global.avb.writePageRaw = realWrite;
      }

      // THE SERIALISATION ITSELF. An edit issued while a restore is parked
      // inside its own write must wait for it, exactly as a second undo does.
      check('9d: AN EDIT ISSUED DURING AN UNDO WAITS FOR IT', startedUnderTheUndo === false, short({ settledWhileHeld: startedUnderTheUndo }));
      check('9d: the undo is answered', undone?.ok === true, short(undone));
      check('9d: the edit is answered', edited?.ok === true, short(edited));
      const now = app.read('src/pages/index.astro');
      // THE BYTES, WHICH IS THE WHOLE POINT. Two changes were asked for and both
      // of them have to be true of the file: the first is taken back and the
      // second is written.
      check('9d: THE EDIT MADE WHILE THE UNDO WAS IN FLIGHT IS ON DISK', now.includes('SECOND OF THE PAIR'), short(now.slice(0, 200)));
      check('9d:   and the undone edit is gone from it', !now.includes('FIRST OF THE PAIR'), short(now.slice(0, 200)));
      // AND NEITHER ANSWER CLAIMS SOMETHING THE FILE DOES NOT SAY. `undone` is
      // computed as "the past stack got shorter", which is true whatever the
      // bytes did; this is the sentence that ties it to them.
      check(
        '9d: `undone` is not reported for bytes that did not land',
        undone?.undone !== true || !now.includes('FIRST OF THE PAIR'),
        short({ undone: undone?.undone, holdsTheUndoneEdit: now.includes('FIRST OF THE PAIR') })
      );
      check(
        '9d: `ok` is not reported for an edit that did not land',
        edited?.ok !== true || now.includes('SECOND OF THE PAIR'),
        short({ ok: edited?.ok, holdsTheEdit: now.includes('SECOND OF THE PAIR') })
      );

      // ── 9e. THE SAME PAIR, WITH A REF ────────────────────────────────────
      //
      // 9d edits THROUGH THE SELECTION, on the stated reasoning that "a ref
      // carries the revision it was minted at and is refused as stale after
      // the undo has moved it, which is a different (and correct) refusal".
      // That reasoning holds when the two calls are made one after the other.
      // It does NOT hold when they are issued CONCURRENTLY, which is how an MCP
      // host issues parallel tool calls and how every `target.*` write an agent
      // makes is shaped: the ref's revision is compared in commands.js, BEFORE
      // `commit` joins the queue, so between the comparison and the write the
      // undo runs to completion and nothing refuses anything.
      //
      // MEASURED, 5 runs in 5, both of 9d's closing assertions failing: the
      // undo answered `{ok: true, undone: true}`, the edit answered
      // `{ok: true}`, and the file held NEITHER change — word for word the
      // sentence 9d's header says was fixed.
      //
      // The check is made again inside `commitNow`, where the write is, so a
      // document that moved while the edit waited its turn refuses instead of
      // overwriting. See commitNow.
      {
        const fresh = await run('target', 'read', { ref: refFor(ON_INDEX) });
        check('9e: the node reads back for a fresh ref', fresh.ok === true, short(fresh));
        const first = await run('target', 'set_text', { ref: fresh.ref, text: 'FIRST OF THE REF PAIR' });
        check('9e: the edit that will be undone lands', first.ok === true, short(first));
        await H.settle(UNCOALESCED);
        check('9e:   and is on disk', app.read('src/pages/index.astro').includes('FIRST OF THE REF PAIR'), short(app.read('src/pages/index.astro').slice(0, 140)));
        const second = await run('target', 'read', { ref: refFor(ON_INDEX) });
        check('9e:   and a ref minted after it reads back', second.ok === true, short(second));

        // Issued together, the way a host issues parallel tool calls. No held
        // door: the point is the window between the ref's check and the write,
        // which is open on its own.
        const [undoAnswer, editAnswer] = await Promise.all([
          run('project', 'undo'),
          run('target', 'set_text', { ref: second.ref, text: 'SECOND OF THE REF PAIR' }),
        ]);
        await H.settle(UNCOALESCED);
        const disk = app.read('src/pages/index.astro');
        const holdsFirst = disk.includes('FIRST OF THE REF PAIR');
        const holdsSecond = disk.includes('SECOND OF THE REF PAIR');
        // WHICHEVER ORDER THEY RAN IN, THE FILE IS ONE OF THE TWO STATES THAT
        // WERE ASKED FOR — never a third, and never a mixture. Both orderings
        // are legitimate: undo-then-edit leaves SECOND, edit-then-undo takes
        // the edit straight back and leaves FIRST.
        check(
          '9e: the file holds one of the two states asked for, not a third',
          holdsFirst !== holdsSecond,
          short({ holdsFirst, holdsSecond, disk: disk.slice(0, 160) })
        );
        // AND THE EDIT EITHER LANDED OR SAID WHY NOT, by name, so the caller
        // knows to read again rather than believing bytes are there.
        check(
          '9e:   an edit that lost the race is refused as stale, not silently',
          editAnswer?.ok === true || editAnswer?.code === 'stale_target',
          short({ ok: editAnswer?.ok, code: editAnswer?.code, message: String(editAnswer?.message || '').slice(0, 160) })
        );
        // AND THE UNDO'S OWN ENVELOPE DOES NOT CONTRADICT ITSELF.
        //
        // `undone` is computed as "the past stack got shorter", which is true
        // whatever the bytes did — and the envelope carries the two digests
        // that say what the bytes DID do. MEASURED at 10b8b33, both from one
        // Promise.all: `undone: true` beside
        // `contentDigest === beforeDigest` — the API observing that the watched
        // file had not moved — while the edit it raced answered `ok: true` and
        // its bytes were never written. Two calls, two claims of success, one
        // file that did not move at all.
        //
        // An undo that moved nothing and an edit that claims to have landed
        // cannot both be true of the same file.
        const restored = (undoAnswer?.restored?.files || [])[0] || null;
        const movedNothing = !!restored && restored.contentDigest === restored.beforeDigest;
        check(
          '9e: an undo that moved no bytes does not sit beside an edit that claims it landed',
          !(movedNothing && undoAnswer?.undone === true && editAnswer?.ok === true),
          short({ undone: undoAnswer?.undone, movedNothing, editOk: editAnswer?.ok, restored })
        );
      }

      // Back to the fixture's own words, so section 10 starts from a page
      // nobody has left half-edited.
      const back = await run('target', 'read', { ref: refFor(ON_INDEX) });
      if (back.ok) await run('target', 'set_text', { text: 'Made carefully.' });
      await H.settle(200);
    }

    // ── 9f. THE FOURTH DOOR INTO THE OPEN DOCUMENT ───────────────────────────
    //
    // 9d proves an EDIT waits for a restore. It proves it about `commit`, which
    // is one of the doors `oneAtATime` covers. `page.component_create` is the
    // other kind: it rewrites the WHOLE page model — the markup replaced by an
    // instance, plus the import — through `extractComponent`, and that was
    // handed to the agent surface unqueued.
    //
    // MEASURED before the fix, with the undo parked inside its real
    // `writePageRaw` and the component made while it was parked:
    //
    //   component_create answered `{ok: true, replaced: true}` and wrote
    //   src/components/PricingGrid.astro; the PAGE on disk still held the inline
    //   markup and had gained no import, because the restore's bytes landed over
    //   it; and the model in memory held the extraction, so the canvas showed a
    //   component the file did not have. A component file nothing imports, an
    //   edit reported ok that was never saved, and nothing left to save it.
    //
    // THE REF IS MINTED DURING THE HOLD, deliberately. A ref taken before the
    // undo is stale by the time this runs and `component_create` refuses it —
    // correctly, and that refusal would answer this section's question by not
    // asking it. An agent that reads and then acts, both while a restore is in
    // flight, has a ref with nothing wrong with it.
    {
      const refs = require('../electron/mcp/agent/refs.js');
      const ON_INDEX = { keys: ['src/pages/index.astro#0.2'], fingerprint: { tag: 'footer' }, page: { file: 'src/pages/index.astro' } };
      const refFor = (anchor) => refs.mint('node', anchor, { projectRoot: root });

      const opened = await run('target', 'read', { ref: refFor(ON_INDEX) });
      check('9f: the page is open', opened.ok === true && opened.target?.page?.file === PAGE, short(opened.target?.page));
      const first = await run('target', 'set_text', { text: 'FIRST, TO BE TAKEN BACK' });
      check('9f: the edit that will be undone lands', first.ok === true, short(first));
      await H.settle(UNCOALESCED);
      check('9f:   and is on disk', app.read(PAGE).includes('FIRST, TO BE TAKEN BACK'), short(app.read(PAGE).slice(0, 120)));

      let opening = null;
      const atTheDoor = new Promise((done) => {
        opening = done;
      });
      let letGo = null;
      const held = new Promise((done) => {
        letGo = done;
      });
      const realWrite = global.avb.writePageRaw;
      let holding = false;
      global.avb.writePageRaw = async (arg) => {
        if (!holding) {
          holding = true;
          opening();
          await held;
        }
        return realWrite(arg);
      };
      let undone = null;
      let created = null;
      let startedUnderTheUndo = null;
      try {
        const undoing = run('project', 'undo');
        await atTheDoor;
        check('9f: the undo is genuinely mid-restore', holding === true);
        // A ref READ right here, for the node this is about — the page's
        // `<div class="pricing-grid">`. Read rather than hand-minted, because a
        // WRITE is refused through a ref that recorded no version; and read HERE
        // rather than before the undo, because a ref that recorded the version
        // before the restore is stale by now and `component_create` refuses it —
        // correctly, and that refusal would answer this section's question by
        // never letting the race happen. An agent that reads and then writes,
        // both while a restore is in flight, holds a ref with nothing wrong.
        const fresh = await run('target', 'read', {
          ref: refFor({ keys: [`${PAGE}#0.1`], fingerprint: { tag: 'div' }, page: { file: PAGE } }),
        });
        const gridRef = fresh.target?.ref;
        check('9f: a ref for the node to extract can still be read', fresh.ok === true && typeof gridRef === 'string', short({ ok: fresh.ok, tag: fresh.target?.tag }));
        let settled = false;
        const creating = run('page', 'component_create', { ref: gridRef, name: 'PricingGrid' }).then((answer) => {
          settled = true;
          return answer;
        });
        // Long enough for an unqueued extraction to run to the end: its own save
        // goes through `writePage`, which nothing here holds.
        await H.settle(400);
        startedUnderTheUndo = settled;
        letGo();
        undone = await undoing;
        created = await creating;
        await H.settle(600);
      } finally {
        global.avb.writePageRaw = realWrite;
      }

      check('9f: MAKING A COMPONENT DURING AN UNDO WAITS FOR IT', startedUnderTheUndo === false, short({ settledWhileHeld: startedUnderTheUndo }));
      check('9f: the undo is answered', undone?.ok === true && undone?.undone === true, short(undone));
      check('9f: the component is made', created?.ok === true && created?.replaced === true, short(created));
      const now = app.read(PAGE);
      // THE BYTES. Both operations were asked for and both have to be true of
      // the file: the edit is taken back, and the extraction is IN THE PAGE.
      check('9f:   the undone edit is gone from the page', !now.includes('FIRST, TO BE TAKEN BACK'), short(now.slice(0, 200)));
      check('9f:   THE EXTRACTION IS ON DISK, not only on the canvas', /<PricingGrid/.test(now), short(now.slice(0, 400)));
      check('9f:   with the import the instance needs', /import PricingGrid from/.test(now), short(now.slice(0, 400)));
      check('9f:   and the component file it points at', app.exists('src/components/PricingGrid.astro'), 'no component file');
      // The failure this closes, stated as itself: a component file with
      // nothing importing it is what the unqueued version left behind.
      check(
        '9f: no component was left standing that the page does not use',
        !app.exists('src/components/PricingGrid.astro') || /import PricingGrid from/.test(now),
        short(now.slice(0, 400))
      );
      await H.settle(UNCOALESCED);
    }

    // ── 9e. A BURST IS ONE STEP ONLY WHILE IT IS ABOUT ONE SET OF FILES ──────
    //
    // `pushCommand` collapses commands that share a coalesceKey inside 800 ms,
    // keeping the FIRST one's `undo` and the LAST one's `redo`. That is an
    // inverse only while every command in the burst touched the same files.
    // The Agent API keys a burst `agent:<domain>.<action>` — see recordUndo in
    // electron/mcp/agent/index.js — with no file in the key at all, so two
    // writes of one action to two DIFFERENT files inside the window were one
    // entry whose `undo` restored the first file, whose `redo` re-applied the
    // second, and whose `files` listed both. One ⌘Z then reported two files
    // undone with one file's bytes back.
    //
    // Measured before the fix, exactly the pair below: `{past: 1}`, the undo
    // answering `ok: true` and naming both files, `other.json` still holding
    // its edit.
    //
    // THE CONTROL IS WHAT MAKES THE TIMING AN ASSERTION. A pair that is two
    // steps because the calls were slower than 800 ms would satisfy the first
    // half of this on any code at all — so the same pair of round trips is run
    // against ONE file first, and has to still collapse. If the window were
    // shut, that would be one step too many.
    {
      const siteWas = app.read('src/data/site.json');
      const otherWas = app.read('src/data/other.json');

      // (a) THE CONTROL: two writes, one file, no pause. Still one step.
      const beforeSame = await probe('before a same-file burst');
      const readOne = await run('content', 'cms_read', { path: 'src/data/site.json' });
      await run('content', 'cms_write', { path: 'src/data/site.json', data: { title: 'Fixture', tagline: 'BURST ONE' }, ref: readOne.ref });
      const readTwo = await run('content', 'cms_read', { path: 'src/data/site.json' });
      const secondSame = await run('content', 'cms_write', { path: 'src/data/site.json', data: { title: 'Fixture', tagline: 'BURST TWO' }, ref: readTwo.ref });
      check('9e: both writes to one file land', secondSame.ok === true, short(secondSame));
      const afterSame = await probe('after a same-file burst');
      const collapsed = afterSame.past === beforeSame.past + 1;
      check('9e: A BURST OVER ONE FILE IS STILL ONE STEP', collapsed, short({ before: beforeSame, after: afterSame }));
      // Everything below only means something if that burst really was inside
      // the coalescing window, which `collapsed` is the evidence for.
      const undoneSame = await run('project', 'undo');
      check('9e:   and one undo takes the whole burst back', undoneSame.ok === true && app.read('src/data/site.json') === siteWas, short(app.read('src/data/site.json')));

      // (b) THE SAME BURST OVER TWO FILES.
      //
      // The stack is read off the undo above rather than probed: `probe` is a
      // `project.redo`, and there is something to redo here now.
      const beforeSplit = undoneSame.history;
      const readA = await run('content', 'cms_read', { path: 'src/data/site.json' });
      await run('content', 'cms_write', { path: 'src/data/site.json', data: { title: 'Fixture', tagline: 'SPLIT ONE' }, ref: readA.ref });
      const readB = await run('content', 'cms_read', { path: 'src/data/other.json' });
      const wroteB = await run('content', 'cms_write', { path: 'src/data/other.json', data: { note: 'SPLIT TWO' }, ref: readB.ref });
      check('9e: both writes to two files land', wroteB.ok === true, short(wroteB));
      const siteSplit = app.read('src/data/site.json');
      const otherSplit = app.read('src/data/other.json');
      check('9e:   with both files really changed', siteSplit !== siteWas && otherSplit !== otherWas, short({ site: siteSplit.length, other: otherSplit.length }));
      const afterSplit = await probe('after a two-file burst');
      check(
        '9e: TWO FILES IN ONE BURST ARE TWO STEPS',
        afterSplit.past === beforeSplit.past + 2,
        short({ before: beforeSplit, after: afterSplit })
      );

      // AND THE BYTES. One undo is one step: the file that step was about comes
      // back, and the other one does not move.
      const undoneSplit = await run('project', 'undo');
      check('9e: the first undo is answered', undoneSplit.ok === true && undoneSplit.undone === true, short(undoneSplit));
      check('9e:   it names only the file it put back', JSON.stringify(filesOf(undoneSplit)) === JSON.stringify(['src/data/other.json']), short(filesOf(undoneSplit)));
      check('9e:   THE FILE IT NAMED IS THE FILE THAT MOVED', app.read('src/data/other.json') === otherWas, short(app.read('src/data/other.json')));
      check('9e:   and the other one still holds its edit', app.read('src/data/site.json') === siteSplit, short(app.read('src/data/site.json')));
      const undoneRest = await run('project', 'undo');
      check('9e: the second undo takes the other file back', undoneRest.ok === true && app.read('src/data/site.json') === siteWas, short(app.read('src/data/site.json')));
      check('9e:   and it named that file', JSON.stringify(filesOf(undoneRest)) === JSON.stringify(['src/data/site.json']), short(filesOf(undoneRest)));
      await H.settle(UNCOALESCED);
    }

    // ── 10. POSITIVE CONTROLS, WITH NOTHING WRONG AT ALL ──────────────────────
    //
    // Everything above is satisfied by an undo that refuses everything and a
    // stack that never moves. These are the same operations with nothing in
    // their way, and they have to work.
    {
      const read = await run('content', 'cms_read', { path: 'src/data/site.json' });
      const beforeBytes = app.read('src/data/site.json');
      const wrote = await run('content', 'cms_write', {
        path: 'src/data/site.json',
        data: { title: 'Fixture', tagline: 'A CONTROL' },
        ref: read.ref,
      });
      check('the control write lands', wrote.ok === true, short(wrote));
      const afterBytes = app.read('src/data/site.json');
      check('  and changed the file', afterBytes !== beforeBytes);

      const base = await probe('before the control undo');
      const undone = await run('project', 'undo');
      await H.settle(200);
      check('an undo with nothing wrong reports it undid something', undone.ok === true && undone.undone === true, short(undone));
      check('  shortens past by exactly one', undone.history.past === base.past - 1, short({ base, after: undone.history }));
      check('  lengthens future by exactly one', undone.history.future === base.future + 1, short({ base, after: undone.history }));
      check('  and restores the exact bytes', app.read('src/data/site.json') === beforeBytes, short(app.read('src/data/site.json').slice(0, 120)));
      check('  naming the file it put back', filesOf(undone).includes('src/data/site.json'), short(undone.restored));

      const redone = await run('project', 'redo');
      await H.settle(200);
      check('and the redo after it reports it redid something', redone.ok === true && redone.redone === true, short(redone));
      check('  lengthens past by exactly one', redone.history.past === undone.history.past + 1, short({ before: undone.history, after: redone.history }));
      check('  shortens future by exactly one', redone.history.future === undone.history.future - 1, short({ before: undone.history, after: redone.history }));
      check('  and puts the exact bytes back', app.read('src/data/site.json') === afterBytes, short(app.read('src/data/site.json').slice(0, 120)));
    }
  } finally {
    for (const rel of [...locked]) unlock(rel);
    await app.stop?.();
    H.removeProject(root);
  }
  // Cleanup is a check, not a log line.
  check('every chmod was lifted', locked.size === 0, [...locked].join(','));
  check('the fixture is gone', !fs.existsSync(root), root);

  if (failures.length) {
    console.error(`undo-transaction: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`undo-transaction: ${checked} passed  [a failed undo moves neither the project nor the stack]`);
  suiteDone();
})().catch((err) => {
  console.error('undo-transaction: threw\n', err?.stack || err);
  process.exit(1);
});
