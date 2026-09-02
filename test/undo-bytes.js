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

  // The page's own ref, taken once while the selection is still the freshly
  // opened page. An undo clears the selection when the restored model no longer
  // holds the selected node, so a later bare `target.read` is not reliably the
  // page root.
  let pageRef = null;
  const pageRead = async () => (pageRef ? run('target', 'read', { ref: pageRef }) : run('target', 'read'));
  const refFor = async (tagName) => {
    const page = await pageRead();
    return page.target?.children?.find((c) => c.tag === tagName)?.ref ?? null;
  };

  try {
    // --- THE BASELINE IS THE FILE AS AUTHORED.
    pageRef = (await run('target', 'read')).target?.ref ?? null;
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
    // --- THE TRANSACTION BOUNDARY: NO SETTLE ANYWHERE.
    //
    // `project.undo` used to answer while its restore was still a pending
    // timer, so an operation issued immediately afterwards read the file the
    // undo claimed to have taken back and built on it. Measured against
    // bc9c0195 with no delay inserted anywhere:
    //
    //   S0                    3c5398a9e885
    //   edit A                fc3d804c5810
    //   undo   -> ok, undone  fc3d804c5810   <- still edit A's bytes
    //   edit B -> ok          f9f197bf5a27   <- built on the wrong state
    //   undo   -> ok, undone  fc3d804c5810   <- id="a" STILL IN THE FILE
    //
    // Both undos reported success and the first edit was never undone at all.
    // That is not a byte-fidelity nicety; it is a lost undo.
    //
    // NOT ONE `settle` IN THIS BLOCK. The waiting is what hid it: every delay
    // between an undo and the next operation lets the restore land and the
    // defect disappear. If a settle is ever added here to make this pass, the
    // property it is testing has gone.
    {
      const s0 = app.read(PAGE);
      check('the boundary case starts from the original bytes', sha(s0) === originalSha, tag(s0));

      const refA = await refFor('Hero');
      const editA = await run('target', 'set_prop', { ref: refA, name: 'id', value: 'edit-a' });
      const s1 = app.read(PAGE);
      check('edit A lands with no settle', editA.ok === true && s1.includes('id="edit-a"'), tag(s1));

      const undo1 = await run('project', 'undo');
      const afterUndo1 = app.read(PAGE);
      check('the first undo reports it undid something', undo1.ok === true && undo1.undone === true, short(undo1));
      // THE STATE IT REPORTS IS OBSERVABLE THE MOMENT IT ANSWERS. This is the
      // assertion the whole block exists for.
      check(
        '  and the state it reports is on disk before the next call starts',
        sha(afterUndo1) === originalSha,
        short({ expected: originalSha.slice(0, 12), found: tag(afterUndo1) })
      );

      const refB = await refFor('Hero');
      const editB = await run('target', 'set_prop', { ref: refB, name: 'id', value: 'edit-b' });
      const s2 = app.read(PAGE);
      check('an edit made straight after an undo is written', editB.ok === true && s2.includes('id="edit-b"'), short({ said: editB.ok, has: s2.includes('id="edit-b"') }));
      check('  and is not built on the state undo took back', !s2.includes('id="edit-a"'), s2.slice(0, 200));

      const undo2 = await run('project', 'undo');
      const afterUndo2 = app.read(PAGE);
      check('the second undo reports it undid something', undo2.ok === true && undo2.undone === true, short(undo2));
      check(
        '  and the file is byte-for-byte the original, with no settle anywhere',
        sha(afterUndo2) === originalSha,
        short({ expected: originalSha.slice(0, 12), found: tag(afterUndo2) })
      );
      check('  with neither edit left in it', !afterUndo2.includes('id="edit-a"') && !afterUndo2.includes('id="edit-b"'), afterUndo2.slice(0, 200));
    }

    // --- A STRUCTURAL CHANGE ACROSS THE BOUNDARY, which is the case that needs
    //     the bytes rather than a patch.
    //
    // A local edit can be put back by splicing the node's text into the file,
    // so an entry that lost its bytes is usually rescued by the write path and
    // the loss is invisible. A structural change cannot: the tree has a
    // different shape, the write falls back to serializing the whole document,
    // and only the recorded file returns the original.
    //
    // The entry this undo restores is pushed by the structural commit, reading
    // the state the PREVIOUS save left behind -- so it is exactly the entry
    // that carried no bytes while `flushSave` returned before the state saying
    // it had saved caught up. Measured with that settle removed: this undo
    // lands on a re-serialization instead of S1, while every other check in
    // this file stays green.
    {
      const before = app.read(PAGE);
      check('the structural boundary case starts from the original', sha(before) === originalSha, tag(before));

      await run('target', 'set_prop', { ref: await refFor('Hero'), name: 'id', value: 'boundary' });
      const s1 = app.read(PAGE);
      check('the attribute edit lands', s1.includes('id="boundary"'), tag(s1));

      // NO SETTLE. The next commit's history push must read the state the save
      // above actually left.
      // Back out to whatever contains the current selection first: the edit
      // above may have left it inside the component it touched.
      const page = await pageRead();
      const footer = page.target?.children?.find((c) => c.tag === 'footer');
      check('  the page still reports its footer', !!footer?.ref, short(page.target?.children?.map((c) => c.tag)));
      const removed = await run('target', 'remove', { ref: footer.ref });
      const s2 = app.read(PAGE);
      check('  and a structural change on top of it lands too', removed.ok === true && !s2.includes('<footer>'), short(removed));

      const u1 = await run('project', 'undo');
      const backToS1 = app.read(PAGE);
      check('undoing the structural change reports success', u1.ok === true && u1.undone === true, short(u1));
      check(
        '  and restores the exact bytes it was made on, not a re-serialization',
        sha(backToS1) === sha(s1),
        short({ s1: tag(s1), got: tag(backToS1) })
      );

      const u2 = await run('project', 'undo');
      check('  and unwinding the rest returns the original exactly', u2.ok === true && sha(app.read(PAGE)) === originalSha, tag(app.read(PAGE)));
    }

    // --- REDO ACROSS THE SAME BOUNDARY, also with no settle.
    {
      const refA = await refFor('Hero');
      await run('target', 'set_prop', { ref: refA, name: 'id', value: 'redo-me' });
      const s1 = app.read(PAGE);
      await run('project', 'undo');
      check('undo across the boundary is exact', sha(app.read(PAGE)) === originalSha, tag(app.read(PAGE)));
      const r = await run('project', 'redo');
      const back = app.read(PAGE);
      check('redo reports success with no settle', r.ok === true && r.redone === true, short(r));
      check('  and puts back exactly the state it undid', sha(back) === sha(s1), short({ s1: tag(s1), got: tag(back) }));
      await run('project', 'undo');
      check('  and one more undo returns to the original', sha(app.read(PAGE)) === originalSha, tag(app.read(PAGE)));
    }

    // --- A TWO-EDIT STACK UNWOUND WITH NO SETTLE, each step observable.
    {
      const refA = await refFor('Hero');
      await run('target', 'set_prop', { ref: refA, name: 'id', value: 'stack-a' });
      const s1 = app.read(PAGE);
      const refB = await refFor('div');
      await run('target', 'set_prop', { ref: refB, name: 'data-stack', value: 'b' });
      const s2 = app.read(PAGE);
      check('two edits with no settle both land', s2.includes('id="stack-a"') && s2.includes('data-stack="b"'), tag(s2));
      await run('project', 'undo');
      check('the first undo lands exactly on S1, immediately', sha(app.read(PAGE)) === sha(s1), short({ s1: tag(s1), got: tag(app.read(PAGE)) }));
      await run('project', 'undo');
      check('  and the second lands exactly on the original', sha(app.read(PAGE)) === originalSha, tag(app.read(PAGE)));
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
