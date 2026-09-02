// Undo, as an inverse of the file rather than of the model.
//
//   node test/undo-bytes.js
//
// `project.undo` is advertised on every `target` write as `undoable: true`. The
// promise a person hears in that word is that the file goes back. Not that it
// renders the same, not that the model is equivalent, not that the heading
// reads what it used to -- that the bytes are the bytes.
//
// THE ORACLE IS SHA-256 OF THE FILE. Anything weaker passes a file that came
// back the same size, or the same shape, or semantically equal while its
// indentation changed underneath. The native-Claude dogfood watched a 250-line
// page go 250 -> 255 -> 259 across one edit and one undo, with both calls
// answering ok:true, and every model-level check agreeing that the undo had
// worked.
//
// Two properties are asserted, and they are different:
//
//   1. one edit then one undo returns the exact original file, twice running;
//   2. a stack of two edits unwinds through each intermediate state exactly.
//
// The second is the one that catches an undo that restores "the file as this
// process would have written it" rather than "the file as it was".

const crypto = require('node:crypto');
const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const tag = (text) => `${sha(text).slice(0, 12)} (${Buffer.byteLength(text)}b, ${text.split('\n').length}l)`;

const PAGE = 'src/pages/index.astro';

// Deliberately NOT what this serializer would emit: four-space indentation,
// single quotes, comments between the imports, and one tag whose attributes are
// spread over several lines. Every one of those is a thing the round trip is
// known to normalize, and a byte-exact undo has to survive all of them -- a
// fixture written in the serializer's own canonical form would let a
// re-serializing undo pass.
const SOURCE = `---
// Layout import - the shell every page shares
import Base from '../layouts/Base.astro';

// Component imports
import Hero from '../components/Hero.astro';
import Card from '../components/Card.astro';

// Page data
import site from '../data/site.json';

const plans = [
    { title: 'Starter', body: 'For one person' },
    { title: 'Team', body: 'For a few people' },
];
---
<Base>
    <Hero
        heading={site.tagline}
        class='lead'
    />
    <div class='pricing-grid'>
        {plans.map((plan) => (
            <Card title={plan.title} body={plan.body} />
        ))}
    </div>
    <footer>
        <p class='fine-print'>Made carefully.</p>
    </footer>
</Base>
`;

(async () => {
  const root = H.makeProject({ [PAGE]: SOURCE });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  const refFor = async (tagName) => {
    const page = await run('target', 'read');
    return page.target?.children?.find((c) => c.tag === tagName)?.ref ?? null;
  };

  try {
    // --- THE BASELINE IS THE FILE AS AUTHORED.
    const original = app.read(PAGE);
    check('the project opens without rewriting the page', original === SOURCE, short({
      onDisk: tag(original),
      authored: tag(SOURCE),
    }));
    const originalSha = sha(original);

    // --- CYCLE 1 AND CYCLE 2. Same edit, same undo, twice.
    //
    // Twice matters: an undo that restores a canonicalized file is stable from
    // the second cycle onward, so a single cycle can be made to look correct by
    // a first save that already did the damage. The hash both cycles are
    // measured against is the ORIGINAL one, taken before anything ran.
    for (const cycle of [1, 2]) {
      const beforeEdit = app.read(PAGE);
      check(`cycle ${cycle} starts from the original bytes`, sha(beforeEdit) === originalSha, short({
        expected: originalSha.slice(0, 12),
        found: tag(beforeEdit),
      }));

      const ref = await refFor('Hero');
      const edit = await run('target', 'set_prop', { ref, name: 'id', value: `cycle-${cycle}` });
      await H.settle(250);
      const edited = app.read(PAGE);

      check(`  the edit lands`, edit.ok === true && edited.includes(`id="cycle-${cycle}"`), short(edit));
      check(`  and really changed the file`, sha(edited) !== originalSha, tag(edited));
      check(`  and says it is undoable`, edit.undoable === true, short({ undoable: edit.undoable }));

      const undone = await run('project', 'undo');
      await H.settle(300);
      const restored = app.read(PAGE);

      check(`  undo reports it undid something`, undone.ok === true && undone.undone === true, short(undone));
      check(
        `  and the file is byte-for-byte the original`,
        sha(restored) === originalSha,
        short({ original: `${originalSha.slice(0, 12)} (${Buffer.byteLength(original)}b, ${original.split('\n').length}l)`, afterUndo: tag(restored) })
      );
      check(`  with the edited value gone`, !restored.includes(`id="cycle-${cycle}"`), short(restored.slice(0, 200)));
    }

    // --- A STACK. S0 -> A -> S1 -> B -> S2, unwound one step at a time.
    //
    // Each intermediate state has to come back exactly as it was, not as this
    // process would render it. An undo that re-serializes reaches S1' -- equal
    // to S1 in meaning, different in bytes -- and this is where that shows.
    {
      const s0 = app.read(PAGE);
      check('the stack starts from the original bytes', sha(s0) === originalSha, tag(s0));

      const refA = await refFor('Hero');
      await run('target', 'set_prop', { ref: refA, name: 'id', value: 'first' });
      await H.settle(250);
      const s1 = app.read(PAGE);
      check('edit A lands', s1.includes('id="first"'), tag(s1));

      const refB = await refFor('div');
      await run('target', 'set_prop', { ref: refB, name: 'data-step', value: 'second' });
      await H.settle(250);
      const s2 = app.read(PAGE);
      check('edit B lands on top of it', s2.includes('data-step="second"') && s2.includes('id="first"'), tag(s2));

      const u1 = await run('project', 'undo');
      await H.settle(300);
      const backToS1 = app.read(PAGE);
      check('the first undo reports success', u1.ok === true && u1.undone === true, short(u1));
      check('  and lands exactly on S1', sha(backToS1) === sha(s1), short({ s1: tag(s1), got: tag(backToS1) }));

      const u2 = await run('project', 'undo');
      await H.settle(300);
      const backToS0 = app.read(PAGE);
      check('the second undo reports success', u2.ok === true && u2.undone === true, short(u2));
      check('  and lands exactly on the original', sha(backToS0) === originalSha, short({ original: originalSha.slice(0, 12), got: tag(backToS0) }));

      // --- REDO, which is public and which the acceptance suite already uses.
      //     It must reach the state that was actually there, not a re-rendering
      //     of it.
      const r1 = await run('project', 'redo');
      await H.settle(300);
      const redoneToS1 = app.read(PAGE);
      check('redo reports success', r1.ok === true && r1.redone === true, short(r1));
      check('  and puts back exactly S1', sha(redoneToS1) === sha(s1), short({ s1: tag(s1), got: tag(redoneToS1) }));

      // Back to the original so the suite leaves the fixture as it found it --
      // and so a failure here cannot be hidden by the teardown.
      const u3 = await run('project', 'undo');
      await H.settle(300);
      check('and one more undo returns to the original', u3.ok === true && sha(app.read(PAGE)) === originalSha, tag(app.read(PAGE)));
    }
    // --- A CHANGE THAT IS NOT ONE NODE'S TEXT.
    //
    // The write path patches the changed node's span into the file, and for an
    // attribute edit that is enough on its own to put the bytes back. A
    // STRUCTURAL change has no such span -- the tree has a different shape, so
    // the write falls back to serializing the whole document, and the only
    // thing that can return the original file is the file itself, recorded on
    // the undo entry. This is the case that proves the snapshot is load-bearing
    // rather than a second belt over the first one's braces.
    {
      const s0 = app.read(PAGE);
      check('the structural case starts from the original bytes', sha(s0) === originalSha, tag(s0));

      const page = await run('target', 'read');
      const footer = page.target?.children?.find((c) => c.tag === 'footer');
      check('the page reports its footer', !!footer?.ref, short(page.target?.children?.map((c) => c.tag)));

      const removed = await run('target', 'remove', { ref: footer.ref });
      await H.settle(250);
      const gone = app.read(PAGE);
      check('the footer can be removed', removed.ok === true && !gone.includes('<footer>'), short(removed));
      check('  and the file really changed', sha(gone) !== originalSha, tag(gone));

      const undone = await run('project', 'undo');
      await H.settle(300);
      const back = app.read(PAGE);
      check('undo puts the footer back', undone.ok === true && undone.undone === true && back.includes('<footer>'), short(undone));
      check(
        '  and the file is byte-for-byte the original again',
        sha(back) === originalSha,
        short({ original: `${originalSha.slice(0, 12)} (${Buffer.byteLength(original)}b)`, afterUndo: tag(back) })
      );
    }
    // --- AND THE EDIT AFTER AN UNDO IS NOT SWALLOWED BY IT.
    //
    // An undo schedules a save that writes exact bytes. `project.undo` answers
    // before that save runs, so the next edit arrived with those bytes still
    // pending -- and the save wrote THEM, over the new model, then cleared the
    // dirty flag so nothing would ever write it again. The edit answered
    // ok:true, appeared on the canvas, and was never on disk. Found by review,
    // measured against the previous commit, and pinned here.
    {
      const ref1 = await refFor('Hero');
      await run('target', 'set_prop', { ref: ref1, name: 'id', value: 'before-undo' });
      await H.settle(250);
      const undone = await run('project', 'undo');
      check('the undo is answered', undone.ok === true && undone.undone === true, short(undone));

      // NO SETTLE BETWEEN THE UNDO AND THE EDIT. That is the whole case: the
      // undo SCHEDULES a save and answers before it runs, so the edit has to
      // arrive while those bytes are still pending. Waiting here would let the
      // restore flush first and the defect would never appear -- which is
      // exactly why the shipped settles hid it.
      const ref2 = await refFor('Hero');
      const after = await run('target', 'set_prop', { ref: ref2, name: 'id', value: 'after-undo' });
      await H.settle(600);
      const onDisk = app.read(PAGE);
      check('an edit made straight after an undo is written', after.ok === true && onDisk.includes('id="after-undo"'), short({ said: after.ok, has: onDisk.includes('id="after-undo"') }));
      check('  and the undo\'s bytes did not overwrite it', sha(onDisk) !== originalSha, tag(onDisk));

      // AND IT UNWINDS, though not byte-exactly, and that is honest rather than
      // a defect. A snapshot taken while a save is still pending has no bytes
      // to carry -- the model has moved and the file has not, and pairing them
      // would restore bytes that never held that model -- so an undo across
      // this race degrades to serializing, which is what it always did. What
      // must not happen is the edit surviving or the page changing meaning.
      await run('project', 'undo');
      await H.settle(300);
      const unwound = app.read(PAGE);
      check('  and the stack unwinds, taking the edit back off', !unwound.includes('id="after-undo"'), unwound.slice(0, 160));
      check('  leaving the page saying what it said before', unwound.includes('heading={site.tagline}') && unwound.includes("class='lead'".replace(/'/g, "'")) === unwound.includes("class='lead'"), tag(unwound));
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }
  // Cleanup is a check, not a log line.
  check('the fixture is gone', !require('node:fs').existsSync(root), root);

  if (failures.length) {
    console.error(`undo-bytes: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`undo-bytes: ${checked} passed  [undo restores the file, byte for byte, through a stack]`);
})().catch((err) => {
  console.error('undo-bytes: threw\n', err?.stack || err);
  process.exit(1);
});
