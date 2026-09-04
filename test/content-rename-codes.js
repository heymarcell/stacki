// The three causes a content rename knows the name of, on the wire.
//
//   node test/content-rename-codes.js
//
// `planRename` in electron/contentRefs.js refuses three things before it moves
// anything: a collection this project does not have, an id that is not in it,
// and an id that is already taken. All three used to arrive at a client as
// `code: 'failed'` — the code that means "something went wrong and nobody
// knows what" — because the handler threw a plain Error and `runMain`'s catch
// had nothing to read off it. They now throw through `refuse()`, which puts the
// cause on the Error as `refusalCode` for `thrownFailure` to lift into the
// envelope.
//
// Nothing asserted any of that. Reverting `refuse` to `new Error(message)` —
// deleting the whole mechanism — left nine suites green, so the codes could go
// back to `failed` without a single test noticing. This is the suite that
// notices.
//
// It runs on the wire, with a real MCP client and a fixture with a real Astro
// install, for the same reason test/content-safety.js does: the built-in
// fixture has no node_modules and answers every collection question with "notes
// is not a collection in this project", which is `no_collection` for the wrong
// reason and would make this whole file pass while proving nothing. So the
// three refusals are told apart from each other AND from the shape of a broken
// fixture — and a rename that really works, whose file really moves, is asserted
// beside them so a server that had learned to refuse everything could not pass.

const fs = require('node:fs');
const path = require('node:path');

const { startWireRig } = require('./support/mcpWireRig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null).slice(0, 300);

(async () => {
  // `edit` is the level a rename needs; the fixture's own `notes` collection is
  // the one the rig verifies by name before it hands the project over, so a
  // `no_collection` here is about the argument and not about a fixture that
  // failed to build.
  const rig = await startWireRig({ era: 'modern', agentMode: 'edit', withDeps: true });
  const problems = [];
  const at = (rel) => path.join(rig.root, rel);
  try {
    const FIRST = 'src/content/notes/first.md';
    const SECOND = 'src/content/notes/second.md';
    const firstBytes = fs.readFileSync(at(FIRST), 'utf8');

    // ── the fixture really has the collection these refusals are about ───────
    //
    // Every check below is "Stacki refused, and said why". That is worth
    // nothing unless the same surface can be shown answering. So: the
    // collection lists, and both entries are in it.
    {
      const listed = await rig.call('content', 'entries', { collection: 'notes' });
      const ids = (listed.envelope?.entries || []).map((e) => e.id).sort();
      check('the fixture has a notes collection with both entries', listed.envelope?.ok === true && ids.join(',') === 'first,second', short({ ok: listed.envelope?.ok, ids }));
    }

    // ── the three causes, through content.rename ─────────────────────────────
    const said = {};
    {
      const noCollection = await rig.call('content', 'rename', { collection: 'nope', from: 'first', to: 'renamed' });
      said.no_collection = noCollection.envelope;
      check('renaming inside a collection this project does not have is refused', noCollection.envelope?.ok === false, short(noCollection.envelope));
      check('  with the cause named, not the code that means nobody knows', noCollection.envelope?.code === 'no_collection', short({ code: noCollection.envelope?.code, message: noCollection.envelope?.message }));
      check('  and the sentence a person reads still names the collection', /nope/.test(String(noCollection.envelope?.message)), short(noCollection.envelope?.message));

      const notFound = await rig.call('content', 'rename', { collection: 'notes', from: 'no-such-id', to: 'renamed' });
      said.not_found = notFound.envelope;
      check('renaming an id the collection does not hold is refused', notFound.envelope?.ok === false, short(notFound.envelope));
      check('  with the cause named', notFound.envelope?.code === 'not_found', short({ code: notFound.envelope?.code, message: notFound.envelope?.message }));
      check('  and the sentence names the id that is missing', /no-such-id/.test(String(notFound.envelope?.message)), short(notFound.envelope?.message));

      const exists = await rig.call('content', 'rename', { collection: 'notes', from: 'first', to: 'second' });
      said.exists = exists.envelope;
      check('renaming onto an id that is already taken is refused', exists.envelope?.ok === false, short(exists.envelope));
      check('  with the cause named', exists.envelope?.code === 'exists', short({ code: exists.envelope?.code, message: exists.envelope?.message }));
      check('  and the sentence names the id that is in the way', /second/.test(String(exists.envelope?.message)), short(exists.envelope?.message));
    }

    // THREE CAUSES, THREE CODES. A `refusalCode` mechanism that answered the
    // same string to everything would pass every check above one at a time; a
    // mechanism that answered `failed` to everything is what this file exists
    // to stop coming back.
    {
      const codes = [said.no_collection?.code, said.not_found?.code, said.exists?.code];
      check('the three causes come back as three different codes', new Set(codes).size === 3, short(codes));
      check('  and none of them is the code that means nobody knows', !codes.includes('failed'), short(codes));
    }

    // ── and nothing moved on the way to any of them ──────────────────────────
    //
    // A refusal that has already renamed the file is worse than a generic one.
    check('both entries are still on disk after three refusals', fs.existsSync(at(FIRST)) && fs.existsSync(at(SECOND)), short({ first: fs.existsSync(at(FIRST)), second: fs.existsSync(at(SECOND)) }));
    check('  and the one that was nearly moved is byte-identical', fs.readFileSync(at(FIRST), 'utf8') === firstBytes, 'first.md changed under a refusal');

    // ── the same three, through rename_plan ──────────────────────────────────
    //
    // `rename_plan` is the read an agent is told to make BEFORE the write, so
    // it is the first place a cause is any use — and it goes through the same
    // `planRename`, which is exactly why both have to be asserted: one of them
    // could be routed somewhere else tomorrow and the other would still pass.
    {
      const plans = {
        no_collection: await rig.call('content', 'rename_plan', { collection: 'nope', from: 'first', to: 'renamed' }),
        not_found: await rig.call('content', 'rename_plan', { collection: 'notes', from: 'no-such-id', to: 'renamed' }),
        exists: await rig.call('content', 'rename_plan', { collection: 'notes', from: 'first', to: 'second' }),
      };
      for (const [cause, plan] of Object.entries(plans)) {
        check(`rename_plan refuses ${cause} too`, plan.envelope?.ok === false, short(plan.envelope));
        check(`  and calls it ${cause}, the same as the write does`, plan.envelope?.code === cause, short({ code: plan.envelope?.code, message: plan.envelope?.message }));
      }
    }

    // ── the positive control: the operation these refusals belong to works ────
    //
    // Measured on disk rather than in the envelope. Without this, every check
    // in this file is satisfied by a content domain that refuses everything.
    {
      const plan = await rig.call('content', 'rename_plan', { collection: 'notes', from: 'first', to: 'first-renamed' });
      check('a rename it can do is planned rather than refused', plan.envelope?.ok === true, short(plan.envelope));

      const done = await rig.call('content', 'rename', { collection: 'notes', from: 'first', to: 'first-renamed' });
      check('and it really renames', done.envelope?.ok === true && done.envelope?.renamed === true, short(done.envelope));
      check('  the file is at the new id', fs.existsSync(at('src/content/notes/first-renamed.md')), 'the renamed file is not there');
      check('  and gone from the old one', !fs.existsSync(at(FIRST)), 'the old file is still there');
      check('  with its bytes intact', fs.readFileSync(at('src/content/notes/first-renamed.md'), 'utf8') === firstBytes, 'the rename rewrote the entry');

      // AND THE CAUSE IS STILL READ AFTER A SUCCESS. `not_found` is now true of
      // the id that existed a moment ago, which is the same code arrived at
      // through a different history — a mechanism that only works on a cold
      // fixture is not one an agent can rely on mid-session.
      const stale = await rig.call('content', 'rename', { collection: 'notes', from: 'first', to: 'first-again' });
      check('renaming the id that has just moved away is not_found, not failed', stale.envelope?.ok === false && stale.envelope?.code === 'not_found', short(stale.envelope));
    }
  } finally {
    const said = await rig.stop();
    problems.push(...(said?.problems || []));
  }

  // Cleanup failure is test failure.
  check('the rig left nothing behind', problems.length === 0, problems.join('; '));

  if (failures.length) {
    console.error(`content-rename-codes: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`content-rename-codes: ${checked} passed  [no_collection, not_found and exists, through rename and rename_plan]`);
})().catch((err) => {
  if (failures.length) console.error(`content-rename-codes: ${failures.length} of ${checked} had already failed\n${failures.join('\n')}`);
  console.error('content-rename-codes: threw\n', err?.stack || err);
  process.exit(1);
});
