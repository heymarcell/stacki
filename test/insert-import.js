// The import an inserted component brings with it.
//
//   node test/insert-import.js
//
// `target.append_child` with `{ kind: 'component', name: 'Badge' }` answered
// ok:true and wrote `<Badge label="New"></Badge>` into a page that imports no
// Badge. Astro does not render that page; it fails to build. The call was a
// success by every signal the agent could see -- a ref came back, the document
// revision moved, the bytes were on disk -- and the page was broken.
//
// The cause was that the model had no way to learn the specifier. Working out
// how one file should import another is a round trip to the main process
// (`page:importPathFor`), `applyOperations` is synchronous, and `buildNode`
// pushed an import only for an insertable that already carried one -- which
// the renderer's insertables never do. So the human path (the Insert panel,
// which awaits that round trip before it mutates) got its import and the agent
// path silently skipped it.
//
// THE ORACLE IS THE BYTES OF THE PAGE. Not `ok`, not the model's import list,
// not a ref: the file as Astro would read it. Every case here reads the file
// before and after and accounts for every byte that moved.
//
// The last case is the one that makes the rest safe: when the specifier cannot
// be had, the operation must REFUSE. An insert that half-works -- markup in,
// import missing -- is the defect this file exists for, and answering ok about
// it is worse than answering no.
//
// What is NOT measured here: a click on the Insert panel. There is no canvas
// and no palette in jsdom to click. What that path DOES is measured instead --
// its two pieces are the real `page:importPathFor` handler and the real
// `chooseImportPath`, and both fixtures assert the agent's import is spelled
// byte-for-byte the way those two answer, on a page that imports relatively
// and on a page that imports through an alias. `page.component_create` (the
// same App.jsx operation the "Create component" menu item runs, imports and
// all) is exercised end to end next door in test/component-create.js.

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
const short = (x, n = 260) => JSON.stringify(x ?? null).slice(0, n);
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const tag = (text) => `${sha(text).slice(0, 12)} (${Buffer.byteLength(text)}b, ${text.split('\n').length}l)`;

const PAGE = 'src/pages/index.astro';

const BADGE = `---
const { label } = Astro.props;
---
<span class="badge">{label}</span>
`;

// One occurrence, removed. `null` when there is none or more than one, which is
// how "the import landed exactly once" and "these are the only bytes that
// changed" become the same assertion.
const removeOnce = (text, piece) => {
  const at = text.indexOf(piece);
  if (at < 0) return null;
  if (text.indexOf(piece, at + piece.length) >= 0) return null;
  return text.slice(0, at) + text.slice(at + piece.length);
};

const countOf = (text, re) => (text.match(re) || []).length;

// The first line of the file that differs, both sides, so a failure says what
// moved rather than that something did.
const firstDiff = (a, b) => {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, before: la[i] ?? null, after: lb[i] ?? null };
  }
  return null;
};

(async () => {
  // `chooseImportPath` is the renderer's, and the renderer is ESM: bundled to
  // CJS the way test/insert-target.js reaches src/insertTarget.js, so this
  // measures the shipped function rather than a copy of its rule.
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'insert-import.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'modelOps.js')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { chooseImportPath } = require(bundle);

  // ── A page that imports relatively ─────────────────────────────────────────

  {
    const root = H.makeProject({ 'src/components/Badge.astro': BADGE });
    const app = await H.start(root, { agentMode: 'full' });
    const run = (domain, action, args = {}) => app.api.run(domain, action, args);
    await H.settle(400);

    try {
      const baseline = app.read(PAGE);
      const baselineSha = sha(baseline);
      check('the fixture opens without a Badge import', !/\bimport Badge\b/.test(baseline), tag(baseline));

      const pageRef = (await run('target', 'read')).target?.ref ?? null;
      const pageRead = async () => run('target', 'read', { ref: pageRef });
      const childRef = async (tagName) =>
        (await pageRead()).target?.children?.find((c) => c.tag === tagName)?.ref ?? null;

      // What the Insert panel would write: main's own answer, spelled by the
      // model's own rule. Nothing here reimplements either.
      const paths = await app.callMain('page:importPathFor', {
        pagePath: path.join(root, PAGE),
        targetPath: path.join(root, 'src/components/Badge.astro'),
        projectPath: root,
      });
      const humanSpec = chooseImportPath({ imports: [{ path: '../layouts/Base.astro' }] }, paths);
      check(
        'the Insert panel machinery answers a relative specifier for this page',
        humanSpec === '../components/Badge.astro',
        short({ paths, humanSpec })
      );
      const IMPORT_LINE = `\nimport Badge from '${humanSpec}';`;

      // --- 1. append_child of a component this page does not import ----------

      const footer = await childRef('footer');
      if (!check('the page has its footer', !!footer)) throw new Error('no footer ref');

      const appended = await run('target', 'append_child', {
        ref: footer,
        node: { kind: 'component', name: 'Badge', props: { label: 'New' } },
      });
      const afterAppend = app.read(PAGE);
      check('append_child of an unimported component answers ok', appended.ok === true, short(appended));
      check(
        '  and the page imports it',
        /^import Badge from/m.test(afterAppend),
        short({ frontmatter: afterAppend.slice(0, afterAppend.indexOf('---', 3)) })
      );
      check(
        '  exactly once',
        countOf(afterAppend, /^import Badge from/gm) === 1,
        short({ found: countOf(afterAppend, /^import Badge from/gm) })
      );
      check(
        '  from where the component actually lives',
        afterAppend.includes(`import Badge from '${humanSpec}';`),
        short({ expected: humanSpec, line: (afterAppend.match(/^import Badge from.*$/m) || [null])[0] })
      );
      check(
        '  written under the last import the page already had',
        /import site from '\.\.\/data\/site\.json';\r?\nimport Badge from/.test(afterAppend),
        short((afterAppend.match(/^import .*$/gm) || []).slice(-3))
      );
      check(
        '  and the markup is inside the footer',
        /<p>Made carefully\.<\/p>\r?\n\s*<Badge label="New"><\/Badge>/.test(afterAppend),
        short(afterAppend.slice(afterAppend.indexOf('<footer>')))
      );

      // And nothing else moved. Two pieces out, and what is left is the file as
      // it was authored -- indentation, quoting, blank lines and all.
      const MARKUP = '\n    <Badge label="New"></Badge>';
      const strippedMarkup = removeOnce(afterAppend, MARKUP);
      const strippedBoth = strippedMarkup === null ? null : removeOnce(strippedMarkup, IMPORT_LINE);
      check(
        '  and those two lines are the only bytes that changed',
        strippedBoth === baseline,
        short({ diff: firstDiff(baseline, strippedBoth ?? afterAppend), after: tag(afterAppend) })
      );

      // --- 6. undo puts the file back, import included -----------------------

      const undone = await run('project', 'undo');
      const afterUndo = app.read(PAGE);
      check('undo says it undid something', undone.ok === true && undone.undone === true, short(undone));
      check(
        '  and the file is byte-for-byte what it was, import and all',
        sha(afterUndo) === baselineSha,
        short({ baseline: tag(baseline), afterUndo: tag(afterUndo), diff: firstDiff(baseline, afterUndo) })
      );

      // --- 2. a component the page already imports gains no second import ----

      const again = await run('target', 'append_child', {
        ref: await childRef('footer'),
        node: { kind: 'component', name: 'Badge', props: { label: 'New' } },
      });
      check('the same insert lands again', again.ok === true, short(again));
      const second = await run('target', 'append_child', {
        ref: await childRef('footer'),
        node: { kind: 'component', name: 'Badge', props: { label: 'Also' } },
      });
      const afterTwo = app.read(PAGE);
      check('a second Badge lands too', second.ok === true, short(second));
      check(
        '  with both instances in the page',
        countOf(afterTwo, /<Badge /g) === 2,
        short({ instances: countOf(afterTwo, /<Badge /g) })
      );
      check(
        '  and still exactly one import of it',
        countOf(afterTwo, /^import Badge from/gm) === 1,
        short((afterTwo.match(/^import .*$/gm) || []))
      );

      // A component the page imported all along is not re-imported either.
      const card = await run('target', 'append_child', {
        ref: await childRef('footer'),
        node: { kind: 'component', name: 'Card', props: { title: 'Extra' } },
      });
      const afterCard = app.read(PAGE);
      check('a component the page already imported inserts', card.ok === true, short(card));
      check(
        '  without a second import of it',
        countOf(afterCard, /^import Card from/gm) === 1,
        short((afterCard.match(/^import Card.*$/gm) || []))
      );

      for (let i = 0; i < 3; i += 1) await run('project', 'undo');
      check(
        'the three inserts unwind to the original bytes',
        sha(app.read(PAGE)) === baselineSha,
        short({ diff: firstDiff(baseline, app.read(PAGE)), got: tag(app.read(PAGE)) })
      );

      // --- 3. insert_before and insert_after carry the same guarantee --------

      for (const [action, pattern, markup] of [
        ['insert_before', /<Badge label="Before"><\/Badge>\r?\n\s*<footer>/, '\n  <Badge label="Before"></Badge>'],
        ['insert_after', /<\/footer>\r?\n\s*<Badge label="After"><\/Badge>/, '\n  <Badge label="After"></Badge>'],
      ]) {
        const where = action === 'insert_before' ? 'Before' : 'After';
        const result = await run('target', action, {
          ref: await childRef('footer'),
          node: { kind: 'component', name: 'Badge', props: { label: where } },
        });
        const text = app.read(PAGE);
        check(`${action} of an unimported component answers ok`, result.ok === true, short(result));
        check(`  and the page imports it exactly once`, countOf(text, /^import Badge from/gm) === 1, short((text.match(/^import Badge.*$/gm) || [])));
        check(`  from where it lives`, text.includes(`import Badge from '${humanSpec}';`), short((text.match(/^import Badge.*$/gm) || [])));
        check(`  with the markup where it was asked for`, pattern.test(text), short(text.slice(text.indexOf('<footer>') - 80)));
        const strippedOne = removeOnce(text, markup);
        check(
          `  and nothing else in the file moved`,
          (strippedOne === null ? null : removeOnce(strippedOne, IMPORT_LINE)) === baseline,
          short({ diff: firstDiff(baseline, strippedOne ?? text) })
        );
        await run('project', 'undo');
        check(`  and undo restores the original bytes`, sha(app.read(PAGE)) === baselineSha, short({ diff: firstDiff(baseline, app.read(PAGE)) }));
      }

      // --- The other door: a batch, as one undo step ------------------------
      //
      // `target.edit` is the same commit with several operations in it, and it
      // is the door an agent reaches for when it is doing more than one thing.
      // Two components in one batch need two imports.
      {
        const batch = await run('target', 'edit', {
          ref: await childRef('footer'),
          operations: [
            { type: 'append_child', node: { kind: 'component', name: 'Badge', props: { label: 'One' } } },
            { type: 'append_child', node: { kind: 'component', name: 'Hero', props: { heading: 'Two' } } },
            { type: 'append_child', node: { kind: 'element', tag: 'small', text: 'Since 2024' } },
          ],
        });
        const text = app.read(PAGE);
        check('a batch of inserts lands as one step', batch.ok === true, short(batch));
        check('  and the component the page lacked is imported once', countOf(text, /^import Badge from/gm) === 1, short((text.match(/^import Badge.*$/gm) || [])));
        check('  and the one it already had is not imported twice', countOf(text, /^import Hero from/gm) === 1, short((text.match(/^import Hero.*$/gm) || [])));
        check('  with all three insertions in the footer', /<Badge label="One"><\/Badge>[\s\S]*<Hero heading="Two"[\s\S]*<small>Since 2024<\/small>/.test(text), short(text.slice(text.indexOf('<footer>'))));
        await run('project', 'undo');
        check('  and ONE undo takes the whole batch, import included, back to the original bytes', sha(app.read(PAGE)) === baselineSha, short({ diff: firstDiff(baseline, app.read(PAGE)) }));
      }

      // --- 4. a component whose import cannot be resolved is REFUSED ---------
      //
      // The specifier comes from the main process, and a round trip can fail:
      // an open document with no path on disk, a handler that throws, a window
      // torn down between the ask and the answer. From the renderer all three
      // look the same, and this makes one happen. What may NOT happen is
      // markup in a page that cannot import it.
      {
        // The renderer's own bridge, which is what the app calls. Shadowed for
        // one call and then deleted, so the proxy answers from main again --
        // assigning the old value back would leave an own property of
        // `undefined` and break every later call.
        const bridge = globalThis.avb;
        bridge.importPathFor = async () => {
          throw new Error('the fixture refuses to resolve import paths');
        };
        let refused;
        try {
          refused = await run('target', 'append_child', {
            ref: await childRef('footer'),
            node: { kind: 'component', name: 'Badge', props: { label: 'Doomed' } },
          });
        } finally {
          delete bridge.importPathFor;
        }
        const afterRefusal = app.read(PAGE);
        check('an insert whose import cannot be resolved is refused', refused?.ok === false, short(refused));
        check('  and says so in a way that names the component', /Badge/.test(String(refused?.message || '')), short(refused));
        check(
          '  and NOT ONE BYTE of the page changed',
          sha(afterRefusal) === baselineSha,
          short({ diff: firstDiff(baseline, afterRefusal), got: tag(afterRefusal) })
        );
        check('  so no unimportable markup was written', !/<Badge/.test(afterRefusal), short(afterRefusal.slice(afterRefusal.indexOf('<footer>'))));

        // And the refusal was about the round trip, not about Badge: with main
        // answering again, the same insert lands.
        const recovered = await run('target', 'append_child', {
          ref: await childRef('footer'),
          node: { kind: 'component', name: 'Badge', props: { label: 'Doomed' } },
        });
        check('  and the very same insert lands once main answers again', recovered.ok === true && /^import Badge from/m.test(app.read(PAGE)), short(recovered));
        await run('project', 'undo');
        check('  leaving the original bytes behind it', sha(app.read(PAGE)) === baselineSha, short({ diff: firstDiff(baseline, app.read(PAGE)) }));
      }

      // A name nothing in the project provides still fails the way it always
      // did -- by name, before any of this.
      {
        const nothing = await run('target', 'append_child', {
          ref: await childRef('footer'),
          node: { kind: 'component', name: 'NothingProvidesThis' },
        });
        check('a component nothing provides is still refused by name', nothing.ok === false && nothing.code === 'unknown_component', short(nothing));
        check('  with the page untouched', sha(app.read(PAGE)) === baselineSha, short({ diff: firstDiff(baseline, app.read(PAGE)) }));
      }
    } finally {
      await app.stop?.();
      H.removeProject(root);
    }
    check('the relative-import fixture is gone', !fs.existsSync(root), root);
  }

  // ── A page that imports through an alias ───────────────────────────────────
  //
  // `chooseImportPath` spells a new import the way the page spells the ones it
  // has. That rule is the Insert panel's, and an agent that wrote a relative
  // path into a page whose every import is `@/…` would be writing something a
  // person never would -- and, in a project whose alias is the only resolvable
  // form, something that does not build.

  {
    const ALIASED = `---
import Base from '@/layouts/Base.astro';
import Card from '@/components/Card.astro';
---
<Base>
  <div class="pricing-grid">
    <Card title="Starter" body="For one person" />
  </div>
</Base>
`;
    const root = H.makeProject({ 'src/components/Badge.astro': BADGE, [PAGE]: ALIASED });
    const app = await H.start(root, { agentMode: 'full' });
    const run = (domain, action, args = {}) => app.api.run(domain, action, args);
    await H.settle(400);

    try {
      const baseline = app.read(PAGE);
      check('the aliased fixture opens as authored', baseline === ALIASED, short({ diff: firstDiff(ALIASED, baseline) }));

      const paths = await app.callMain('page:importPathFor', {
        pagePath: path.join(root, PAGE),
        targetPath: path.join(root, 'src/components/Badge.astro'),
        projectPath: root,
      });
      const humanSpec = chooseImportPath({ imports: [{ path: '@/layouts/Base.astro' }, { path: '@/components/Card.astro' }] }, paths);
      check(
        'the Insert panel machinery keeps the alias for a new import',
        humanSpec === '@/components/Badge.astro',
        short({ paths, humanSpec })
      );

      const page = await run('target', 'read');
      const div = page.target?.children?.find((c) => c.tag === 'div');
      if (!check('the aliased page has its grid', !!div?.ref, short(page.target?.children))) throw new Error('no div ref');

      const appended = await run('target', 'append_child', {
        ref: div.ref,
        node: { kind: 'component', name: 'Badge', props: { label: 'New' } },
      });
      const after = app.read(PAGE);
      check('append_child lands on the aliased page', appended.ok === true, short(appended));
      check(
        '  and the agent spells the import exactly as the panel would',
        after.includes(`import Badge from '${humanSpec}';`),
        short({ expected: humanSpec, line: (after.match(/^import Badge from.*$/m) || [null])[0] })
      );
      check(
        '  not as a relative path the page uses nowhere else',
        !after.includes("import Badge from '../components/Badge.astro';"),
        short((after.match(/^import .*$/gm) || []))
      );
      const stripped = removeOnce(after, '\n    <Badge label="New"></Badge>');
      check(
        '  and nothing else in the file moved',
        (stripped === null ? null : removeOnce(stripped, `\nimport Badge from '${humanSpec}';`)) === baseline,
        short({ diff: firstDiff(baseline, stripped ?? after) })
      );

      await run('project', 'undo');
      check('  and undo restores the aliased page byte for byte', app.read(PAGE) === ALIASED, short({ diff: firstDiff(ALIASED, app.read(PAGE)) }));
    } finally {
      await app.stop?.();
      H.removeProject(root);
    }
    check('the aliased fixture is gone', !fs.existsSync(root), root);
  }

  if (failures.length) {
    console.error(`insert-import: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`insert-import: ${checked} passed  [an inserted component brings its import, or the insert refuses]`);
})().catch((err) => {
  console.error('insert-import: threw\n', err?.stack || err);
  process.exit(1);
});
