// What an answer says happened, against what happened.
//
//   node test/answer-truth.js
//
// Two fields a client acts on, both of which described something other than the
// file on disk.
//
// THE DOCUMENT DIGEST MOVED WHEN NOTHING DID. `digestOfModel` hashed
// `JSON.stringify(model)`, and the model carries every node's `id` — numbers
// from a counter in electron/astroParser.js that is never reset. So a REPARSE
// of the same bytes produced a tree of the same shape with different numbers on
// it, and the digest said "different document" about a document nobody had
// touched.
//
// `target.enter` followed by `target.exit` reparses the page. Measured with
// reads only, at the `inspect` level, with the file's own content digest
// unmoved throughout: `document.digest` went 17411fj-13o -> 44l7fg-13v, and a
// write through a ref minted before that navigation was REFUSED AS STALE. Two
// pure reads, and a handle stopped working. The value it moved to was not even
// reproducible between runs, because it is a counter.
//
// The old code said the ids were in there deliberately — "they change when it
// is reparsed, which is exactly when a ref minted against the old parse should
// stop being trusted". That conflates two different things. A ref carries the
// index path to its node and a fingerprint of what was there; after a reparse
// of identical bytes the tree has the same shape, so the path still leads to
// the same node. The digest's job is to answer "is this the same document".
//
// THE GUARD MUST NOT GET WEAKER, and half of this file is about that. A digest
// that stopped moving would be a digest that let a stale write through, which
// is worse than the defect. So every stabilising assertion here is paired with
// one that a real edit still moves it and a stale write is still refused.
//
// ONE FILE WAS REPORTED AS TWO. `changedFiles` listed one physical file twice —
// once as `src/pages/index.astro` and once as the caller's own spelling of it —
// with identical digests and an identical patch. The dogfood saw an absolute
// path; that entry point has since been closed at the ref boundary, but the
// ASSEMBLY was never made spelling-safe, so the same defect came back through
// `touchedBy`, which returns the caller's argument unresolved. Canonicalised
// now rather than merely deduplicated: a single entry reading
// `./src/styles/site.css` is still wrong, because what a client is told a file
// is called has to be what every other answer calls it.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const H = require('./agent-harness.js');
const { digestOfModel } = require('../src/agent/digest.js');

const short = (x, n = 260) => JSON.stringify(x ?? null).slice(0, n);

(async () => {
  // ── the digest is about the document, not about the parse ─────────────────

  {
    const root = H.makeProject();
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const digest = (r) => r.document?.digest;
      const bytes = () => app.read('src/pages/index.astro');

      const first = await run('target', 'read');
      const pageRef = first.target.ref;
      const hero = (first.target?.children || []).find((c) => c.tag === 'Hero');
      const before = bytes();

      check('a read reports a document digest', typeof digest(first) === 'string' && digest(first).length > 0, short(first.document));
      const second = await run('target', 'read');
      check('two reads of the same document agree', digest(first) === digest(second), `${digest(first)} vs ${digest(second)}`);

      // THE DEFECT. enter/exit is two reads, and it reparses.
      const entered = await run('target', 'enter', { ref: hero.ref });
      check('entering a component succeeds', entered.ok !== false, short(entered));
      const inside = await run('target', 'read');
      check('and the digest inside is a different document', digest(inside) !== digest(first), `${digest(inside)}`);
      check('  because it IS a different file', inside.document?.file !== first.document?.file, `${inside.document?.file}`);

      await run('target', 'exit');
      const back = await run('target', 'read');
      check('the file is byte-identical after the round trip', bytes() === before, 'the navigation wrote something');
      check('and the digest is the one it started with', digest(back) === digest(first), `${digest(first)} -> ${digest(back)}`);
      check('and the revision never moved', back.document?.revision === first.document?.revision, `${first.document?.revision} -> ${back.document?.revision}`);

      // AND THE HANDLE STILL WORKS. This is what the moving digest cost.
      const write = await run('target', 'add_class', { ref: pageRef, className: 'after-navigation' });
      check('a write through a ref minted BEFORE the navigation lands', write.ok === true, short(write));
      check('  and the class is on disk', bytes().includes('after-navigation'), bytes().slice(0, 160));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── and the guard is exactly as strong as it was ──────────────────────────

  {
    const root = H.makeProject();
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const digest = (r) => r.document?.digest;
      const first = await run('target', 'read');
      const kids = first.target?.children || [];
      const hero = kids.find((c) => c.tag === 'Hero');
      const footer = kids.find((c) => c.tag === 'footer');
      const staleDigest = digest(first);
      const staleRef = (await run('target', 'read', { ref: footer.ref })).target.ref;

      // A real edit, by another route.
      const edit = await run('target', 'add_class', { ref: hero.ref, className: 'a-real-edit' });
      check('a real edit succeeds', edit.ok === true, short(edit));
      const after = await run('target', 'read');
      check('and it MOVES the digest', digest(after) !== staleDigest, `${staleDigest} -> ${digest(after)}`);

      const refused = await run('target', 'add_class', { ref: staleRef, className: 'should-not-land', expectedDigest: staleDigest });
      check('a write naming the old digest is refused', refused.ok === false, short(refused));
      check('  as stale, by name', refused.code === 'stale_target', short(refused));
      check('  and nothing was written', !app.read('src/pages/index.astro').includes('should-not-land'));

      const fresh = (await run('target', 'read', { ref: footer.ref })).target.ref;
      const allowed = await run('target', 'add_class', { ref: fresh, className: 'this-one-lands', expectedDigest: digest(after) });
      check('a write naming the current digest lands', allowed.ok === true, short(allowed));
      check('  and is on disk', app.read('src/pages/index.astro').includes('this-one-lands'));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── the digest function itself ────────────────────────────────────────────
  //
  // Asserted directly, because the two call sites — the ref's observation and
  // the in-queue recheck — MUST move together, and they move together only by
  // both calling this.

  {
    const a = { nodes: [{ id: 'n1', kind: 'element', name: 'p', children: [{ id: 'n2', kind: 'text', value: 'hi' }] }] };
    const b = { nodes: [{ id: 'n97', kind: 'element', name: 'p', children: [{ id: 'n98', kind: 'text', value: 'hi' }] }] };
    const c = { nodes: [{ id: 'n1', kind: 'element', name: 'p', children: [{ id: 'n2', kind: 'text', value: 'HI' }] }] };
    check('renumbering the parse does not change the digest', digestOfModel(a) === digestOfModel(b), `${digestOfModel(a)} vs ${digestOfModel(b)}`);
    check('but changing what the document says does', digestOfModel(a) !== digestOfModel(c), `${digestOfModel(a)} vs ${digestOfModel(c)}`);
    const tagged = { nodes: [{ id: 'n1', kind: 'element', name: 'div', children: [{ id: 'n2', kind: 'text', value: 'hi' }] }] };
    check('and so does changing a tag', digestOfModel(a) !== digestOfModel(tagged));
    const extra = { nodes: [...a.nodes, { id: 'n3', kind: 'text', value: 'x' }] };
    check('and so does adding a node', digestOfModel(a) !== digestOfModel(extra));
    check('raw source still digests as itself', typeof digestOfModel('some source') === 'string');
    check('and null is null', digestOfModel(null) === null);
  }

  // ── one physical file, one entry, spelled one way ─────────────────────────

  {
    const SPELLINGS = [
      'src/pages/index.astro',
      './src/pages/index.astro',
      'src/pages/./index.astro',
      'src//pages/index.astro',
      'src/lib/../pages/index.astro',
    ];
    for (const spelling of SPELLINGS) {
      const root = H.makeProject();
      const app = await H.start(root, { agentMode: 'full' });
      await H.settle(500);
      try {
        const read = await app.api.run('content', 'cms_read', { path: 'src/pages/index.astro#plans' });
        const res = await app.api.run('content', 'cms_write', {
          path: `${spelling}#plans`,
          data: [{ name: 'X', price: 1 }],
          expectedDigest: read.digest,
        });
        if (!check(`[${spelling}] the write lands`, res.ok === true, short(res))) continue;
        const files = (res.changedFiles || []).map((f) => f.file);
        check(`  and reports ONE changed file`, files.length === 1, short(files));
        check(`  spelled the way every other answer spells it`, files[0] === 'src/pages/index.astro', short(files));
      } finally {
        app.stop();
        H.removeProject(root);
      }
    }

    // The single-entry case, where deduplication alone would not have helped:
    // one entry, carrying the caller's spelling.
    const root = H.makeProject();
    const app = await H.start(root, { agentMode: 'full' });
    await H.settle(500);
    try {
      const read = await app.api.run('style', 'read_source', { path: 'src/styles/site.css' });
      const res = await app.api.run('style', 'write_source', {
        path: './src/styles/site.css',
        css: '.x{color:red}\n',
        expectedDigest: read.digest,
      });
      check('a style write through a non-canonical path lands', res.ok === true, short(res));
      const files = (res.changedFiles || []).map((f) => f.file);
      check('  and names the file canonically', files.length === 1 && files[0] === 'src/styles/site.css', short(files));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  if (failures.length) {
    console.error(`\nanswer-truth: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`answer-truth: ${checked} passed  [a digest about the document, and one entry per file]`);
  process.exit(0);
})().catch((err) => {
  console.error('answer-truth: threw\n', err);
  process.exit(1);
});
