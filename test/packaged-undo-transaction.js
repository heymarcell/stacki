// Does a completed `project.undo` mean the state it reports is on disk?
//
//   node test/packaged-undo-transaction.js
//
// `test/undo-bytes.js` proves this against the harness's renderer. The defect it
// pins is a TIMING one — an undo that answered while its restore was still a
// pending timer — and timing is exactly what a harness can flatter. So the same
// sequence is run against the real packaged app, over real MCP, through the real
// renderer and the real save path.
//
// NOT ONE SLEEP BETWEEN THE OPERATIONS. That is the whole shape of it. Every
// delay between an undo and the next call lets the restore land and the defect
// disappear, which is how it survived a green suite and a green native rerun.
//
// THE ORACLE IS THE FILE, read from disk by this process, which the app knows
// nothing about. Not `source.read`, which would ask the thing under test what it
// thinks it wrote.
//
// AND IT IS A CONFIRMATION, NOT THE DISCRIMINATOR -- said here because a test
// that cannot fail must never be mistaken for proof. Measured: a control package
// built with the PRE-FIX renderer passes this file 18/18. The race is between an
// undo answering and the next call arriving, and out here every call crosses a
// process boundary, so the zero-delay save timer always won before the next one
// landed. The defect was latent in the packaged app rather than absent from it,
// and nothing should be built on that latency: it is a property of IPC on this
// machine, not of the code.
//
// What this file is for is the other direction -- proving the contract holds
// end to end in the shipped bundle, through the real renderer and the real save
// path, with the author's own non-canonical bytes coming back exactly. The
// oracle that DISCRIMINATES is `test/undo-bytes.js`, which drives the same
// renderer in-process with no hops to hide behind: 10 of its 55 checks fail
// against the pre-fix commit, and five separate sabotages of the transaction
// guarantee each kill it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startPackagedApp, available, APP } = require('./support/packagedApp.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const brief = (v, n = 220) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s && s.length > n ? `${s.slice(0, n)}…` : s;
  } catch {
    return String(v);
  }
};
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const tag = (t) => `${sha(t).slice(0, 12)} (${Buffer.byteLength(t)}b)`;

// The page the packaged app opens on load. Overridden for this run only --
// `extraFiles` is per-invocation, so no other packaged test sees it -- because
// `target` operates on the document the editor has OPEN, and reading a
// different page does not make it the open one.
const PAGE = 'src/pages/index.astro';

// Authored bytes that are NOT what the serializer would emit: four-space
// indentation, single-quoted attributes, a comment above the import it
// annotates, and one tag whose attributes are spread over several lines. A
// fixture in the serializer's own canonical form would let a re-serializing
// undo pass without anyone noticing.
const SOURCE = `---
// Layout import - the shell every page shares
import Base from '../layouts/Base.astro';

// Component imports
import Hero from '../components/Hero.astro';
---
<Base>
    <Hero
        heading="Transaction"
        class='lead'
    />
    <div class='panel'>
        <p class='fine'>Made carefully.</p>
    </div>
    <footer>
        <p class='sign-off'>Signed.</p>
    </footer>
</Base>
`;

(async () => {
  if (!available()) {
    console.log(`packaged-undo-transaction: skipped  [no ${APP} — run npm run dist:mac:unsigned]`);
    return;
  }

  const app = await startPackagedApp({ access: 'edit', extraFiles: { [PAGE]: SOURCE } });
  const onDisk = () => fs.readFileSync(path.join(app.project, PAGE), 'utf8');

  try {
    await app.untilOpen();

    // Open the page under test and take a ref for it, once, while the selection
    // is the freshly opened page: an undo clears the selection when the restored
    // model no longer holds the selected node.
    const S0 = onDisk();
    check('and its authored bytes are on disk untouched', S0 === SOURCE, brief({ found: tag(S0), authored: tag(SOURCE) }));
    const originalSha = sha(S0);

    const page = await app.run('target', 'read');
    const pageRef = page?.target?.ref ?? null;
    const pageRead = () => (pageRef ? app.run('target', 'read', { ref: pageRef }) : app.run('target', 'read'));
    const refFor = async (tagName) => {
      const p = await pageRead();
      return p?.target?.children?.find((c) => c.tag === tagName)?.ref ?? null;
    };
    const hero = await refFor('Hero');
    check('the page reports its Hero instance', !!hero, brief(page?.target?.children?.map((c) => c.tag)));

    // ── THE SEQUENCE. No sleep anywhere below this line. ──────────────────
    const editA = await app.run('target', 'set_prop', { ref: hero, name: 'id', value: 'edit-a' });
    const S1 = onDisk();
    check('edit A lands', editA?.ok === true && S1.includes('id="edit-a"'), brief(editA));
    check('  and says it is undoable', editA?.undoable !== false, brief(editA?.undoable));

    const undo1 = await app.run('project', 'undo');
    const afterUndo1 = onDisk();
    check('the first undo reports it undid something', undo1?.ok === true && undo1.undone === true, brief(undo1));
    // THE ASSERTION THE WHOLE FILE EXISTS FOR.
    check(
      '  and the state it reports is on disk the moment it answers',
      sha(afterUndo1) === originalSha,
      brief({ expected: originalSha.slice(0, 12), found: tag(afterUndo1) })
    );

    const heroAgain = await refFor('Hero');
    const editB = await app.run('target', 'set_prop', { ref: heroAgain, name: 'id', value: 'edit-b' });
    const S2 = onDisk();
    check('an edit made straight after the undo is written', editB?.ok === true && S2.includes('id="edit-b"'), brief(editB));
    check('  and is not built on the state the undo took back', !S2.includes('id="edit-a"'), brief(S2.slice(0, 200)));

    const undo2 = await app.run('project', 'undo');
    const afterUndo2 = onDisk();
    check('the second undo reports it undid something', undo2?.ok === true && undo2.undone === true, brief(undo2));
    check(
      '  and the file is byte-for-byte the original, with no sleep anywhere',
      sha(afterUndo2) === originalSha,
      brief({ expected: originalSha.slice(0, 12), found: tag(afterUndo2) })
    );
    check('  with neither edit left in it', !afterUndo2.includes('id="edit-a"') && !afterUndo2.includes('id="edit-b"'), brief(afterUndo2.slice(0, 200)));

    // ── AND THE STRUCTURAL CASE, which is the one that needs the recorded
    //    bytes rather than a patch. ─────────────────────────────────────────
    await app.run('target', 'set_prop', { ref: await refFor('Hero'), name: 'id', value: 'boundary' });
    const T1 = onDisk();
    check('an attribute edit lands for the structural case', T1.includes('id="boundary"'), tag(T1));

    const footer = await refFor('footer');
    const removed = await app.run('target', 'remove', { ref: footer });
    const T2 = onDisk();
    check('  and a structural change on top of it, with no sleep between', removed?.ok === true && !T2.includes('<footer>'), brief(removed));

    const undo3 = await app.run('project', 'undo');
    const backToT1 = onDisk();
    check('undoing the structural change reports success', undo3?.ok === true && undo3.undone === true, brief(undo3));
    check(
      '  and restores the exact bytes it was made on, not a re-serialization',
      sha(backToT1) === sha(T1),
      brief({ expected: tag(T1), found: tag(backToT1) })
    );

    const undo4 = await app.run('project', 'undo');
    const home = onDisk();
    check('and unwinding the rest returns the original exactly', undo4?.ok === true && sha(home) === originalSha, brief({ expected: originalSha.slice(0, 12), found: tag(home) }));
    check('  with the author\'s own formatting intact', home.includes("class='lead'") && home.includes('\n    <div') && /\/\/ Component imports\nimport Hero/.test(home), brief(home.slice(0, 220)));
  } catch (err) {
    check('the run completed without throwing', false, String(err?.stack || err).slice(0, 400));
  } finally {
    const stopped = await app.stop();
    // Cleanup is a check, not a log line.
    check('the packaged app left nothing behind', !stopped?.problems?.length, brief(stopped?.problems));
  }

  if (failures.length) {
    console.error(`packaged-undo-transaction: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged-undo-transaction: ${checked} passed  [a completed undo is on disk before the next call]`);
})().catch((err) => {
  console.error('packaged-undo-transaction: threw\n', err?.stack || err);
  process.exit(1);
});
