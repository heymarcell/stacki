// The undo of an asset move, against the file the handler actually wrote.
//
//   node test/asset-undo.js
//
// `asset.move` and `asset.rename` are recorded on the app's own undo stack, and
// the inverse used to be computed from the CLIENT'S ARGUMENTS: the landing path
// was assumed to be `toFolder/basename(path)` or `dirname(path)/name`. Neither
// handler promises that. `assets:move` renames around a collision (`uniqueDest`
// — logo.svg landing as logo-1.svg) and `assets:rename` strips `/` and `\` out
// of the name ('sub/KEEP.svg' landing as 'subKEEP.svg'), so the recorded
// inverse named a path the file was not at.
//
// Measured on this branch before the fix, with two files in the fixture:
//
//   public/logo.svg      "ORIGINAL-A"      moved into public/img, which
//   public/img/logo.svg  "ORIGINAL-B"      already held a logo.svg
//
// The move landed correctly at public/img/logo-1.svg. The undo then moved the
// PRE-EXISTING public/img/logo.svg back to public/logo.svg — so public/logo.svg
// held the wrong file's bytes, ORIGINAL-A was stranded under a name nobody
// asked for, and public/img/logo.svg was gone. Two files corrupted, one
// destroyed, and the envelope said `{ok: true, undone: true}`.
//
// This is the same class as the branch's own "an undo that named the wrong
// file", fixed for the style path and missed here.
//
// SO THE ORACLE IS THE BYTES OF EVERY FILE IN PLAY, before and after, by
// sha-256 — never `undone: true`, which is exactly the claim that was false.
// Each case reads back every file it can reach, so "the right file came back"
// and "somebody else's file came back under the right name" cannot pass the
// same assertion.
//
// And the envelope has to SAY where the file went. An agent told only
// `{ok:true}` after a move that renamed cannot find the file it just moved, and
// it is the same fact the undo record needs.

const crypto = require('node:crypto');
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
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

const A = 'ORIGINAL-A — the file that was moved\n';
const B = 'ORIGINAL-B — the file that was already there\n';
const K = 'KEEP — the file that must not be touched\n';

(async () => {
  const root = H.makeProject({
    'public/logo.svg': A,
    'public/img/logo.svg': B,
    'public/plain.svg': A,
    'public/renameable.svg': A,
    'public/sanitised.svg': A,
    'public/KEEP.svg': K,
  });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  // null rather than a throw: "that file is not there" is an answer this suite
  // asserts as often as it asserts bytes.
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const at = (rel) => (read(rel) === null ? 'gone' : sha(read(rel)));

  try {
    // ── 1. A MOVE ONTO A COLLISION ───────────────────────────────────────────
    {
      const moved = await run('asset', 'move', { path: 'public/logo.svg', toFolder: 'public/img' });
      check('a move onto a name that is taken still happens', moved.ok === true, short(moved));
      // WHERE, from the handler. Without this the agent has to guess, and the
      // guess is the one the undo record used to make.
      check('  and the envelope says where the file went', moved.path === 'public/img/logo-1.svg', short({ path: moved.path }));
      check('  the moved bytes are at that path', read('public/img/logo-1.svg') === A, at('public/img/logo-1.svg'));
      check('  the file that was already there is untouched', read('public/img/logo.svg') === B, at('public/img/logo.svg'));
      check('  and it really left where it was', read('public/logo.svg') === null, at('public/logo.svg'));

      // THE INVERSE THAT DOES NOT EXIST. The undo vocabulary the panels share
      // has a move and a rename and no way to say both at once, and this
      // operation was both — so there is no one-step inverse that puts the name
      // back. `undoable: false` is the honest answer; the alternative on this
      // branch was a move-shaped inverse that took somebody else's file.
      check('  and it is reported as not undoable, because its inverse is two steps', moved.undoable === false, short({ undoable: moved.undoable }));

      const undone = await run('project', 'undo');
      check('project.undo has nothing to take back', undone.undone === false, short(undone));
      // THE POINT OF THE WHOLE SUITE: whatever undo did or did not do, no file
      // holds another file's bytes afterwards.
      check('  public/img/logo.svg still holds its own bytes', read('public/img/logo.svg') === B, at('public/img/logo.svg'));
      check('  and the moved file is still the moved file', read('public/img/logo-1.svg') === A, at('public/img/logo-1.svg'));
      check('  and nothing was put back over the original path', read('public/logo.svg') === null, at('public/logo.svg'));
    }

    // ── 2. A RENAME THE HANDLER SANITISES ────────────────────────────────────
    {
      const renamed = await run('asset', 'rename', { path: 'public/sanitised.svg', name: 'sub/KEEP.svg' });
      check('a rename with a separator in the name still happens', renamed.ok === true, short(renamed));
      check('  and the envelope says the name it really used', renamed.path === 'public/subKEEP.svg', short({ path: renamed.path }));
      check('  with the bytes there', read('public/subKEEP.svg') === A, at('public/subKEEP.svg'));
      check('  and the file it would have overwritten if the name were taken literally is untouched', read('public/KEEP.svg') === K, at('public/KEEP.svg'));
      check('  and this one IS undoable — one rename undoes one rename', renamed.undoable === true, short({ undoable: renamed.undoable }));

      const undone = await run('project', 'undo');
      await H.settle(200);
      check('project.undo takes it back', undone.ok === true && undone.undone === true, short(undone));
      // Before the fix this answered `undone: true` and moved nothing: the
      // record named public/sub/KEEP.svg, which never existed.
      check('  and the file is really back, with its bytes', read('public/sanitised.svg') === A, at('public/sanitised.svg'));
      check('  under the name it had', read('public/subKEEP.svg') === null, at('public/subKEEP.svg'));
      check('  with the neighbour it nearly clobbered still there', read('public/KEEP.svg') === K, at('public/KEEP.svg'));
    }

    // ── 3. THE POSITIVE CONTROLS ─────────────────────────────────────────────
    //
    // Every assertion above is satisfied by an operation that refuses
    // everything and an undo stack that records nothing. These two are the same
    // operations with nothing unusual about them, and they have to work.
    {
      const moved = await run('asset', 'move', { path: 'public/plain.svg', toFolder: 'public/img' });
      check('an ordinary move still moves the file', moved.ok === true && read('public/img/plain.svg') === A, short(moved));
      check('  and says so', moved.path === 'public/img/plain.svg', short({ path: moved.path }));
      check('  and is undoable', moved.undoable === true, short({ undoable: moved.undoable }));
      const undone = await run('project', 'undo');
      await H.settle(200);
      check('  and the undo puts it back where it was', undone.undone === true && read('public/plain.svg') === A, short({ undone: undone.undone, plain: at('public/plain.svg') }));
      check('  and takes it out of the folder it went to', read('public/img/plain.svg') === null, at('public/img/plain.svg'));
    }
    {
      const renamed = await run('asset', 'rename', { path: 'public/renameable.svg', name: 'renamed.svg' });
      check('an ordinary rename still renames the file', renamed.ok === true && read('public/renamed.svg') === A, short(renamed));
      check('  and says the name it used', renamed.path === 'public/renamed.svg', short({ path: renamed.path }));
      const undone = await run('project', 'undo');
      await H.settle(200);
      check('  and the undo puts the name back', undone.undone === true && read('public/renameable.svg') === A, short({ undone: undone.undone, back: at('public/renameable.svg') }));
      check('  with nothing left under the new name', read('public/renamed.svg') === null, at('public/renamed.svg'));
    }

    // ── 4. AND THE FILES NOBODY NAMED ────────────────────────────────────────
    //
    // The defect's signature was a THIRD file changing, so the suite ends by
    // reading the whole of public/ back.
    {
      check('public/img/logo.svg was never anything but ORIGINAL-B', read('public/img/logo.svg') === B, at('public/img/logo.svg'));
      check('public/KEEP.svg was never anything but KEEP', read('public/KEEP.svg') === K, at('public/KEEP.svg'));
      const listing = fs.readdirSync(path.join(root, 'public')).sort().join(',');
      check('and public/ holds exactly the files this suite left there', listing === 'KEEP.svg,img,plain.svg,renameable.svg,robots.txt,sanitised.svg', listing);
      const img = fs.readdirSync(path.join(root, 'public/img')).sort().join(',');
      check('  and public/img the two logos', img === 'logo-1.svg,logo.svg', img);
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }
  check('the fixture is gone', !fs.existsSync(root), root);

  if (failures.length) {
    console.error(`asset-undo: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`asset-undo: ${checked} passed  [an asset undo is built from where the file actually went]`);
})().catch((err) => {
  console.error('asset-undo: threw\n', err?.stack || err);
  process.exit(1);
});
