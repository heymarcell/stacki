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
const path = require('node:path');
const H = require('./agent-harness.js');

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

const PAGE = 'src/pages/index.astro';

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
  const unlock = (rel) => {
    try {
      fs.chmodSync(path.join(root, rel), 0o644);
    } catch {
      /* already gone */
    }
    locked.delete(rel);
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

    // ── 1. A FAILED UNDO DOES NOT MOVE THE STACK ─────────────────────────────
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

    // ── 2. THE MIRROR, FOR REDO ──────────────────────────────────────────────
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

    // ── 3. NO PARTIAL FILE STATE ─────────────────────────────────────────────
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

    // ── 4. NO MODEL/DISK DIVERGENCE ──────────────────────────────────────────
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

    // ── 5. AND THE FORWARD OPERATION IS ALL-OR-NOTHING TOO ───────────────────
    //
    // `cssVars.renameVariables` checks everything before it writes anything,
    // and then writes in a loop that can still stop halfway. Its own comment
    // says a half-applied rename is worse than a refused one; this is that
    // sentence as a test. Both files are locked in turn for the same reason as
    // section 3.
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

    // ── 6. NOBODY'S FILESYSTEM ───────────────────────────────────────────────
    //
    // Every refusal above was built somewhere that had an absolute path in its
    // hands. `message` was scrubbed; `restored.failed` was not, and it is the
    // field that carries the reason.
    {
      const carrying = wire.filter((envelope) => JSON.stringify(envelope ?? null).includes(root));
      check(
        `none of the ${wire.length} refusals names this machine's filesystem`,
        carrying.length === 0,
        carrying.map((envelope) => short(envelope, 400)).join('\n    ')
      );
      const reasons = wire.map((envelope) => envelope?.restored?.failed).filter(Boolean);
      check('and the ones that explain a failed inverse said something', reasons.length >= 3, short(reasons));
      check('  in project-relative terms', reasons.every((reason) => !reason.includes(root)), short(reasons));
    }

    // ── 7. POSITIVE CONTROLS, WITH NOTHING WRONG AT ALL ──────────────────────
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
