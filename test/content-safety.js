// What content.write_entry is allowed to touch, and what it is allowed to claim.
//
//   node test/content-safety.js
//
// Three things, all of them measured on disk rather than in an envelope:
//
//   CONTAINMENT.  Every other write in the Agent API resolves its path through
//   the project-containment resolver, and `source.write` refuses `../x.md` with
//   `outside_project`. `content.write_entry` took a client-supplied `entry.file`
//   and handed it to `path.resolve`, which accepts `..` segments and returns an
//   absolute argument unchanged — so one operation in the surface wrote files
//   outside the open project, on `write` risk, two calls from a listing.
//
//   THE LOCATOR.  A file-backed collection keeps every entry inside one data
//   file, and `locator` is what says which record an entry is. `content.entries`
//   dropped it, so writing that entry back addressed the TOP of the file: a
//   two-record authors.json grew a third element that was a bare string, the
//   record the caller meant was untouched, and the envelope said ok.
//
//   THE SCHEMA AND THE VERSION.  `stacki://guide/astro` tells an agent the
//   schema is checked before it writes. Nothing checked it, and nothing checked
//   that the entry was still the one the agent had read.
//
// Everything runs through the wire rig — a real MCP client, real transport, real
// SDK validation, and a fixture with a real Astro install, because the built-in
// harness fixture has no node_modules and answers every collection question
// with "not a collection in this project". A whole domain can look tested and
// not be.

const fs = require('node:fs');
const os = require('node:os');
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

// The fixture's own two collections stay — the rig verifies them by name before
// it hands the project over — and three more are added, because the defects
// below cannot be reached through a glob collection with a lax schema.
const CONFIG = `import { defineCollection, reference, z } from 'astro:content';
import { glob, file } from 'astro/loaders';

const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: z.object({
    title: z.string(),
    draft: z.boolean().default(false),
  }),
});

const links = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/links' }),
  schema: z.object({
    label: z.string(),
    note: reference('notes'),
  }),
});

// A FILE-BACKED collection: every entry is a record inside one JSON array, and
// the only thing that says which record is the locator.
const people = defineCollection({
  loader: file('src/data/people.json'),
  schema: z.object({ id: z.string(), name: z.string() }),
});

// A TYPED collection whose schema says things a shape check cannot guess: a
// coerced date and an array of strings.
const work = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/work' }),
  schema: z.object({
    title: z.string(),
    publishDate: z.coerce.date(),
    tags: z.array(z.string()),
    draft: z.boolean().default(false),
  }),
});

// And one with NO schema at all, so "unchecked" can be told from "checked".
const loose = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/loose' }),
});

// A collection whose entries are BUILT rather than stored. Anything written to
// one is overwritten on the next sync, which is why Stacki refuses to write it
// at all — and the refusal has to survive the write path being rebuilt.
const bespoke = defineCollection({
  loader: { name: 'made-up', load: async () => {} },
  schema: z.object({ title: z.string() }),
});

export const collections = { notes, links, people, work, loose, bespoke };
`;

const EXTRA = {
  'src/content.config.ts': CONFIG,
  'src/data/people.json': `[
  { "id": "ada", "name": "Ada" },
  { "id": "bob", "name": "Bob" }
]
`,
  'src/content/work/first.md': `---
title: The first piece of work
publishDate: 2024-01-02
tags:
  - one
  - two
draft: false
---

A body.
`,
  'src/content/loose/anything.md': `---
whatever: 1
---

Nothing declares a shape for this.
`,
};

(async () => {
  // A CANARY THIS TEST OWNS, outside the project and inside a directory it made
  // and will remove. The escape has to leave the fixture root to be an escape;
  // it must not leave what the test cleans up.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-containment-'));
  const canary = path.join(outside, 'canary.md');
  const CANARY_BYTES = '---\ntitle: nothing has written here\n---\n\nA file outside every project.\n';
  fs.writeFileSync(canary, CANARY_BYTES, 'utf8');

  const rig = await startWireRig({ era: 'modern', agentMode: 'edit', withDeps: true, extra: EXTRA });
  const problems = [];
  try {
    // ── F12a: containment ────────────────────────────────────────────────────
    //
    // Both spellings of the escape the neighbouring `source.write` refuses. The
    // relative one is computed from the fixture root, so it reaches this test's
    // own directory rather than whatever happens to sit beside the fixture.
    const escapes = [
      ['a relative path that climbs out of the project', path.relative(rig.root, canary).split(path.sep).join('/')],
      ['an absolute path', canary],
    ];
    for (const [what, file] of escapes) {
      // Put the canary back between the two, and write a different value each
      // time, so neither case can be reported as harmless because the other one
      // had already done the damage.
      fs.writeFileSync(canary, CANARY_BYTES, 'utf8');
      const said = await rig.call('content', 'write_entry', {
        collection: 'notes',
        entry: { file, locator: [] },
        edits: [{ path: ['title'], value: `WRITTEN FROM OUTSIDE THE PROJECT via ${what}` }],
      });
      check(`write_entry refuses ${what}`, said.envelope?.ok === false, short(said.envelope));
      check(
        '  with a code that says why, not a crash',
        ['outside_project', 'bad_request', 'no_entry'].includes(String(said.envelope?.code)),
        short(said.envelope?.code)
      );
      // THE DISCRIMINATING HALF. An envelope-only assertion is satisfied by any
      // unrelated refusal; the bytes are what say nothing left the project.
      check('  and the file outside the project is byte-identical', fs.readFileSync(canary, 'utf8') === CANARY_BYTES, 'the canary was written to');
    }

    // The control that keeps the two halves honest: the same escape through the
    // operation that has always refused it.
    {
      const said = await rig.call('source', 'write', { path: '../stacki-escape-probe.md', text: 'x' });
      check('source.write still refuses the same escape', said.envelope?.code === 'outside_project', short(said.envelope));
    }

    // ── F12b: the locator ────────────────────────────────────────────────────
    {
      const list = await rig.call('content', 'entries', { collection: 'people' });
      const entries = list.envelope?.entries || [];
      check('content.entries reads a file-backed collection', entries.length === 2, short(list.envelope));
      check(
        'every entry carries the locator that says which record it is',
        entries.every((e) => Array.isArray(e.locator)),
        short(entries.map((e) => ({ id: e.id, locator: e.locator })))
      );
      check(
        '  and the second record is addressed by its position, not by the top of the file',
        JSON.stringify(entries.find((e) => e.id === 'bob')?.locator) === '[1]',
        short(entries.find((e) => e.id === 'bob'))
      );

      const bob = entries.find((e) => e.id === 'bob');
      const said = await rig.call('content', 'write_entry', {
        collection: 'people',
        id: 'bob',
        entry: bob,
        edits: [{ path: ['name'], value: 'Robert' }],
      });
      check('writing one record of a file-backed collection succeeds', said.envelope?.ok === true, short(said.envelope));

      const after = JSON.parse(rig.harness.read('src/data/people.json'));
      check('  the file still holds exactly two records', Array.isArray(after) && after.length === 2, short(after));
      check('  none of which is a bare string', Array.isArray(after) && after.every((r) => r && typeof r === 'object' && !Array.isArray(r)), short(after));
      check('  the record that was named is the one that changed', after?.[1]?.name === 'Robert' && after?.[1]?.id === 'bob', short(after?.[1]));
      check('  and the record beside it is untouched', JSON.stringify(after?.[0]) === JSON.stringify({ id: 'ada', name: 'Ada' }), short(after?.[0]));
    }

    // ── F12: the schema, and the version ─────────────────────────────────────
    //
    // The entry as Stacki reports it right now, which is where the digest a
    // write is guarded by comes from.
    const entryOf = async (collection, id) => {
      const list = await rig.call('content', 'entries', { collection });
      return (list.envelope?.entries || []).find((e) => e.id === id) || null;
    };
    const WORK = 'src/content/work/first.md';

    {
      // `publishDate` is `z.coerce.date()` and `tags` is `z.array(z.string())`.
      // Neither of these values is either, and neither is a shape check away
      // from being told so — only the collection's own schema knows.
      const before = rig.harness.read(WORK);
      const said = await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        entry: await entryOf('work', 'first'),
        edits: [
          { path: ['publishDate'], value: 'definitely-not-a-date' },
          { path: ['tags'], value: 12345 },
        ],
      });
      check('a write that breaks the schema is refused', said.envelope?.ok === false, short(said.envelope));
      check('  with a code a client can branch on', said.envelope?.code === 'invalid_entry', short(said.envelope?.code));
      const issues = said.envelope?.issues || [];
      check('  naming the date field', issues.some((i) => i.path?.[0] === 'publishDate'), short(issues));
      check('  and the array field', issues.some((i) => i.path?.[0] === 'tags'), short(issues));
      check('  in the same {path, message, code} shape content.validate uses', issues.every((i) => Array.isArray(i.path) && typeof i.message === 'string' && typeof i.code === 'string'), short(issues));
      check('  and it says the schema really was consulted', said.envelope?.validation === 'checked', short(said.envelope?.validation));
      // THE DISCRIMINATING HALF: a refusal that had already written is not a
      // refusal. The bytes are the oracle, not `changed:false`.
      check('  and NOTHING was written', rig.harness.read(WORK) === before, 'the entry file moved on a refused write');
    }

    {
      const said = await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        entry: await entryOf('work', 'first'),
        edits: [{ path: ['title'], value: 'Retitled, and valid' }],
      });
      check('a write that satisfies the schema still succeeds', said.envelope?.ok === true, short(said.envelope));
      check('  and says the schema was consulted', said.envelope?.validation === 'checked', short(said.envelope?.validation));
      check('  and it is really on disk', /title:\s*Retitled, and valid/.test(rig.harness.read(WORK)), rig.harness.read(WORK).slice(0, 200));
    }

    {
      // A collection that declares no schema is a REAL answer, not a missing
      // one — and it must not be reported as a check that happened.
      const said = await rig.call('content', 'write_entry', {
        collection: 'loose',
        id: 'anything',
        entry: await entryOf('loose', 'anything'),
        edits: [{ path: ['whatever'], value: 2 }],
      });
      check('a schemaless collection is still writable', said.envelope?.ok === true, short(said.envelope));
      check('  and says so rather than claiming a check', said.envelope?.validation === 'unchecked', short(said.envelope?.validation));
      check('  with a reason a person can read', typeof said.envelope?.validationReason === 'string' && said.envelope.validationReason.length > 10, short(said.envelope?.validationReason));
    }

    {
      // THE GUARD IS NOT OPTIONAL. content.entries mints a digest per entry and
      // the client hands it straight back inside the entry, so there is nothing
      // to remember — but a caller that names no version at all is refused,
      // exactly as content.cms_write refuses one.
      const said = await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        edits: [{ path: ['title'], value: 'Written with no idea what was there' }],
      });
      check('a write that names no version is refused', said.envelope?.ok === false && said.envelope?.code === 'guard_required', short(said.envelope));
      check('  and is told what the current version is', typeof said.envelope?.currentDigest === 'string', short(said.envelope?.currentDigest));
    }

    {
      // Read, then somebody else rewrites the file, then write. The edit must
      // not land on top of the stranger.
      const stale = await entryOf('work', 'first');
      const STRANGER = `---\ntitle: Written by somebody else\npublishDate: 2024-05-05\ntags:\n  - three\ndraft: false\n---\n\nSomebody else's body.\n`;
      rig.harness.write(WORK, STRANGER);
      const said = await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        entry: stale,
        edits: [{ path: ['title'], value: 'The agent wrote this on top' }],
      });
      check('a write against a version that has moved on is refused', said.envelope?.ok === false, short(said.envelope));
      check('  as stale, not as something else', said.envelope?.code === 'stale_target', short(said.envelope?.code));
      check('  saying what is there now', typeof said.envelope?.currentDigest === 'string', short(said.envelope?.currentDigest));
      check("  and the other writer's bytes are untouched", rig.harness.read(WORK) === STRANGER, 'the stranger was written over');
    }

    {
      // The deliberate override. It writes, and it still reports what it broke,
      // so an accident becomes a decision rather than a silence.
      const said = await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        entry: await entryOf('work', 'first'),
        allowInvalid: true,
        edits: [{ path: ['tags'], value: 12345 }],
      });
      check('allowInvalid writes anyway', said.envelope?.ok === true && said.envelope?.changed === true, short(said.envelope));
      check('  and still reports what it broke', (said.envelope?.issues || []).some((i) => i.path?.[0] === 'tags'), short(said.envelope?.issues));
      check('  and the invalid value really is on disk', /tags:\s*12345/.test(rig.harness.read(WORK)), rig.harness.read(WORK).slice(0, 200));
    }

    {
      // A COLLECTION STACKI CANNOT WRITE, refused with the reason
      // contentEntries.js already writes rather than with a generic failure.
      const said = await rig.call('content', 'write_entry', {
        collection: 'bespoke',
        id: 'anything',
        edits: [{ path: ['title'], value: 'x' }],
      });
      check('a collection built by a loader is not written', said.envelope?.ok === false, short(said.envelope));
      check('  refused as read-only', said.envelope?.code === 'read_only', short(said.envelope?.code));
      check(
        '  with the reason Stacki already had for it',
        /rebuilt from scratch on every sync/.test(String(said.envelope?.message || '')),
        short(said.envelope?.message)
      );
    }

    // ── F12c: "no such collection" is not "no schema" ────────────────────────
    //
    // Both used to answer {issues: [], unchecked: true}, so an agent that
    // misspelled a collection name was told its data was fine — and the schema
    // cache memoised the ambiguity, so asking again could not clear it up.
    {
      const said = await rig.call('content', 'validate', { collection: 'definitely-not-a-collection', data: { anything: 1 } });
      check('validating against a collection that does not exist is refused', said.envelope?.ok === false, short(said.envelope));
      check('  with the code the rest of the API uses for it', said.envelope?.code === 'no_collection', short(said.envelope?.code));
      check('  naming the collection it could not find', String(said.envelope?.message || '').includes('definitely-not-a-collection'), short(said.envelope?.message));
      // The cache used to make the wrong answer stick. Asking twice is how that
      // shows up at all.
      const again = await rig.call('content', 'validate', { collection: 'definitely-not-a-collection', data: { anything: 1 } });
      check('  and asking again says the same thing', again.envelope?.ok === false && again.envelope?.code === 'no_collection', short(again.envelope));
    }
    {
      const said = await rig.call('content', 'validate', { collection: 'loose', data: { anything: 1 } });
      check('a collection with no schema is a real answer, not a refusal', said.envelope?.ok === true, short(said.envelope));
      check('  with nothing to report', Array.isArray(said.envelope?.issues) && said.envelope.issues.length === 0, short(said.envelope?.issues));
      check('  and it says plainly that nothing was checked', said.envelope?.checked === false && said.envelope?.unchecked === true, short(said.envelope));
      check('  with a reason', typeof said.envelope?.reason === 'string' && said.envelope.reason.length > 10, short(said.envelope?.reason));
    }
    {
      // The control. A collection that DOES have a schema still reaches a
      // verdict, and says the check really happened.
      const said = await rig.call('content', 'validate', { collection: 'work', data: { title: 'x', publishDate: 'definitely-not-a-date', tags: 12345 } });
      check('a real schema still finds what is wrong', (said.envelope?.issues || []).length >= 2, short(said.envelope?.issues));
      check('  and says the check happened', said.envelope?.checked === true, short(said.envelope));
    }

    // ── F13: a content write is on the same undo stack a person's is ─────────
    //
    // content.cms_write — same domain, same dispatcher, same generic bytes
    // restore — has always answered `undoable: true` with a patch, and
    // `project.undo` really put its bytes back. write_entry answered
    // {ok:true,changed:true} and `project.undo` answered `undone: false`. The
    // difference was two table entries, not a missing capability.
    {
      // Back to something valid first, so this block is about the undo stack
      // and not about the schema.
      await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        entry: await entryOf('work', 'first'),
        edits: [{ path: ['tags'], value: ['one', 'two'] }],
      });
      // AND THEN ONE STEP OF SOMETHING ELSE, deliberately. Consecutive agent
      // writes of the SAME operation inside 800ms collapse into one undo step
      // (App.jsx pushCommand), the way a slider drag is one ⌘Z — so without a
      // different step in between, "undo the write below" would silently mean
      // "undo both writes" and this assertion would be measuring the clock.
      const site = await rig.call('content', 'cms_read', { path: 'src/data/site.json' });
      await rig.call('content', 'cms_write', {
        path: 'src/data/site.json',
        expectedDigest: site.envelope?.digest,
        data: { ...(site.envelope?.data || {}), burstBreaker: true },
      });
      const before = rig.harness.read(WORK);
      const said = await rig.call('content', 'write_entry', {
        collection: 'work',
        id: 'first',
        entry: await entryOf('work', 'first'),
        edits: [{ path: ['title'], value: 'On the undo stack' }],
      });
      const after = rig.harness.read(WORK);
      check('a content entry write reports whether undo reaches it', said.envelope?.undoable === true, short(said.envelope?.undoable));
      const files = said.envelope?.changedFiles || [];
      const record = files.find((f) => f.file === WORK);
      check('  and names the file it changed', !!record, short(files));
      check('  with the digest either side', typeof record?.beforeDigest === 'string' && typeof record?.afterDigest === 'string' && record.beforeDigest !== record.afterDigest, short(record));
      check('  and a patch somebody can read', !!record?.patch && Array.isArray(record.patch.hunks) && record.patch.hunks.length > 0, short(record?.patch));
      check('  and the write really happened', after !== before && after.includes('On the undo stack'), after.slice(0, 200));

      const undone = await rig.call('project', 'undo', {});
      check('project.undo takes it back', undone.envelope?.undone === true, short(undone.envelope));
      // THE ORACLE IS THE BYTES, not an equivalent model.
      check('  restoring the file exactly as it was', rig.harness.read(WORK) === before, 'the entry file came back different');

      const redone = await rig.call('project', 'redo', {});
      check('project.redo puts it back', redone.envelope?.ok === true, short(redone.envelope));
      check('  byte for byte', rig.harness.read(WORK) === after, 'the redo produced different bytes');
    }

    {
      // THE HONESTY HALF, on an operation that is deliberately NOT undoable: a
      // rename moves a file and rewrites every reference to it, which is a
      // rename-inverse rather than a bytes-inverse. The field has to be there
      // saying false, because absent is what an agent reads as "nobody knows".
      const said = await rig.call('content', 'write_entry', {
        collection: 'loose',
        id: 'anything',
        entry: await entryOf('loose', 'anything'),
        edits: [{ path: ['whatever'], value: 3 }],
      });
      check('every write answers the undo question', typeof said.envelope?.undoable === 'boolean', short(said.envelope));
      const rename = await rig.call('content', 'rename', { collection: 'notes', from: 'second', to: 'renamed-second' });
      check('  including the one that is not on the stack', rename.envelope?.ok === true && rename.envelope?.undoable === false, short(rename.envelope));
    }

    // ── THE CMS PANEL'S OWN PATH, which none of the above goes down ──────────
    //
    // The schema preflight is something the agent path OPTS INTO. The panel
    // writes on a 400ms debounce and validates on a separate one, painting the
    // issues into the form — right for a person watching a form, wrong for a
    // caller that reads {ok:true} and moves on. If `requireValid` ever stopped
    // defaulting to off, that autosave would start refusing mid-keystroke, and
    // that is the one way this change could break the app. So the panel's exact
    // call is made here, at the handler the preload exposes to it.
    {
      const write = rig.harness.handlers.get('content:writeEntry');
      const before = rig.harness.read('src/content/loose/anything.md');
      const said = await write(null, {
        projectPath: rig.root,
        // Exactly what ContentView.jsx sends: a file and a locator, no
        // collection, no `validate`.
        entry: { file: 'src/content/loose/anything.md', locator: [] },
        edits: [{ path: ['whatever'], value: 42 }],
        body: undefined,
      });
      check('the panel’s own call still writes', said?.ok === true && said?.changed === true, short(said));
      check('  and is never refused for a schema it did not ask about', said?.code === undefined, short(said?.code));
      check('  with the bytes on disk', /whatever:\s*42/.test(rig.harness.read('src/content/loose/anything.md')), rig.harness.read('src/content/loose/anything.md').slice(0, 120));
      check('  and it really changed something', rig.harness.read('src/content/loose/anything.md') !== before, 'nothing moved, so this proved nothing');

      // AND THE CHECK IS OPT-IN, not implied by knowing which collection this
      // is. A caller that names the collection and does not ask to be checked
      // gets the panel's behaviour, so `validate` defaulting the other way
      // shows up here rather than in somebody's autosave.
      const workBefore = rig.harness.read(WORK);
      const bad = await write(null, {
        projectPath: rig.root,
        collection: 'work',
        entry: { file: WORK, locator: [] },
        edits: [{ path: ['publishDate'], value: 'definitely-not-a-date' }],
      });
      check('a caller that does not ask to be checked is not checked', bad?.ok === true && bad?.changed === true, short(bad));
      check('  and it lands', /publishDate:\s*definitely-not-a-date/.test(rig.harness.read(WORK)), rig.harness.read(WORK).slice(0, 200));
      check('  which is a change, not a no-op', rig.harness.read(WORK) !== workBefore, 'nothing moved');
    }
  } finally {
    const said = await rig.stop();
    problems.push(...(said?.problems || []));
    try {
      fs.rmSync(outside, { recursive: true, force: true });
    } catch (err) {
      problems.push(`the canary directory would not go away: ${err?.message || err}`);
    }
  }

  // Cleanup failure is test failure.
  check('the rig left nothing behind', problems.length === 0, problems.join('; '));
  check('and neither did the canary directory', !fs.existsSync(outside), outside);

  if (failures.length) {
    console.error(`content-safety: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`content-safety: ${checked} passed  [containment, locator, schema preflight and the version guard, on disk]`);
})().catch((err) => {
  console.error('content-safety: threw\n', err?.stack || err);
  process.exit(1);
});
