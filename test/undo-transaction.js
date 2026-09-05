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
// HOW A FAILURE IS PRODUCED. Nothing is stubbed and nothing is monkey-patched:
// a file the inverse must write is made read-only, or a file the inverse must
// rename onto is put back in the way. The real handlers refuse for the real
// reason, exactly as they would if somebody else's editor held the file.
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

/**
 * Every way a payload could name a place on this machine.
 *
 * The oracle here used to be `JSON.stringify(envelope).includes(root)` and
 * nothing more, which on macOS misses the spelling the operating system
 * actually hands back: the fixture root is `/var/folders/…` and its realpath is
 * `/private/var/folders/…`, so a refusal naming the resolved path of the very
 * file the test locked would have gone through unremarked. The temp and home
 * directories go the same way, and the shape rule catches a path from somewhere
 * none of the four covers.
 *
 * The same function, at the same strength, as `hostPathsIn` in
 * test/refusal-contract.js.
 */
function hostPathsIn(payload, root) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const hits = [];
  const named = [
    ['the fixture root', root],
    ['the fixture root, resolved', fs.realpathSync(root)],
    ['the temp directory', os.tmpdir()],
    ['the home directory', os.homedir()],
  ];
  for (const [what, needle] of named) {
    if (needle && needle !== '/' && text.includes(needle)) hits.push(`${what} (${needle})`);
  }
  // And the shape, anchored on a quote or a space so that a project-relative
  // `src/pages/index.astro` -- which these refusals are expected to name -- is
  // not mistaken for one.
  for (const m of text.matchAll(/(?:^|["\s(])(\/(?:Users|home|var|private|tmp|opt|etc|Applications|Library)\/[^"\s)]{2,})/g)) {
    hits.push(`an absolute path: ${m[1].slice(0, 80)}`);
  }
  return hits;
}

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

        seed({ 'unreadable.css': 'MINE', 'b.css': 'BBB' });
        threw = null;
        try {
          await writeAllOrNone([['unreadable.css', 'U-NEW'], ['b.css', 'B-NEW']], doors('b.css', { readThrowsFor: 'unreadable.css' }));
        } catch (err) {
          threw = String(err?.message || err);
        }
        check('the same, with a file that could not be READ at capture', /ENOSPC/.test(String(threw)), String(threw));
        // "There was no file" and "I could not look" must not be the same
        // answer: deleting on the second destroys bytes nobody asked to lose.
        check('  A FILE IT COULD NOT READ IS NOT DELETED', fs.existsSync(abs('unreadable.css')), 'gone');
      }

      // ---- src/panels/VariablesView.jsx: putFiles, the panel's own twin ----
      const panelText = lift('src/panels/VariablesView.jsx', '    async (texts) => {', '\n    }');
      check('putFiles can be read out of src/panels/VariablesView.jsx', !!panelText && /const written = \[\]/.test(panelText), String(panelText).slice(0, 80));
      if (panelText && /const written = \[\]/.test(panelText)) {
        const UNKNOWN = Symbol('unreadable at capture');
        const makePutFiles = (breaks) => {
          const writer = truncatingWriter(abs(breaks)); // one writer, so it breaks once
          // The panel's `bridge`, which SWALLOWS whatever the handler threw and
          // answers `{ok:false, error}` — the reason a refused write used to
          // walk straight past the rollback.
          const bridge = async (name, payload) => {
            try {
              if (name === 'readStyleFile') return { css: fs.readFileSync(String(payload), 'utf8') };
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
          // eslint-disable-next-line no-new-func
          return new Function('bridge', 'project', 'refresh', 'UNKNOWN', `return (${panelText});`)(
            bridge,
            { path: scratch },
            async () => {},
            UNKNOWN
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
})().catch((err) => {
  console.error('undo-transaction: threw\n', err?.stack || err);
  process.exit(1);
});
