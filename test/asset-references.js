// An asset that moves, and everything that pointed at it.
//
//   node test/asset-references.js
//
// A live dogfood moved `public/images/hero.png` into `public/media/` through
// Stacki. The file moved. `<img src="/images/hero.png">` on the page did not,
// and neither did the `url(/images/hero.png)` in the stylesheet. The answer was
// `{ok: true}` with no warning and no list — a site broken in two places by an
// operation that reported success.
//
// The same for `src/assets/logo.png`: the ESM import in the page kept pointing
// at a file that is not there, and Stacki's OWN resolver — `content.resolve_import`
// — then answered `path: null` for it. The product could see the breakage and
// still called the move clean.
//
// THE INVARIANT. After an operation that changes an asset's address, no file in
// the project may hold a statically resolvable reference to the OLD address:
// either every such reference was rewritten in the same operation, or nothing
// moved at all. `ok: true` from an asset move is a claim that this holds.
//
// TWO ADDRESS SPACES, because Astro has two asset models and they are referenced
// differently. `public/images/hero.png` is served at `/images/hero.png` — the
// `public/` prefix is not part of the address. `src/assets/logo.png` is imported
// with a specifier written RELATIVE TO THE IMPORTING FILE, so the same asset is
// `../assets/logo.png` from a page and `./logo.png` from a sibling, and moving
// it changes a different string in every file that imports it.
//
// AND WHAT CANNOT BE REWRITTEN IS REFUSED, BEFORE ANYTHING MOVES.
// `src={`/assets/${name}.png`}` is a real way to reference an asset and there
// is no honest way to rewrite it. A move that went ahead anyway would be the
// original defect with a smaller blast radius, so it does not go ahead: the
// refusal names the file and line, and the file is still where it was.
//
// THE STRONGEST ORACLE HERE IS STACKI'S OWN RESOLVER. For an ESM import, the
// assertion is not "the string looks right" but `content.resolve_import` — the
// operation an agent would use to check — answering with the file's new path.

const fs = require('node:fs');
const path = require('node:path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const H = require('./agent-harness.js');
const assetRefs = require('../electron/assetRefs.js');

const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);

/** A project with a public asset referenced three ways, and a src asset imported. */
function fixture() {
  const root = H.makeProject();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  };
  write('public/images/hero.png', 'PNG');
  write('src/assets/logo.png', 'PNG');
  write(
    'src/pages/gallery.astro',
    '---\n---\n<img src="/images/hero.png" alt="h" />\n<a href="/images/hero.png">full size</a>\n'
  );
  write('src/pages/brand.astro', "---\nimport logo from '../assets/logo.png';\n---\n<img src={logo.src} alt=\"l\" />\n");
  write('src/components/Mark.astro', "---\nimport mark from '../assets/logo.png';\n---\n<img src={mark.src} alt=\"m\" />\n");
  write('src/content/blog/post.md', '---\ntitle: p\n---\n\n![hero](/images/hero.png)\n');
  fs.appendFileSync(path.join(root, 'src/styles/site.css'), '.hero { background: url(/images/hero.png); }\n', 'utf8');
  // A decoy: a longer path that shares a prefix with the asset's address. A
  // rewrite that matched on prefix alone would corrupt it.
  write('src/pages/decoy.astro', '---\n---\n<img src="/images/hero.png.bak" alt="d" />\n<img src="/images/heroic.png" alt="e" />\n');
  return root;
}

(async () => {
  // ── discovery, before anything is asked to move ───────────────────────────

  {
    const root = fixture();
    try {
      const found = assetRefs.referencesTo(root, 'public/images/hero.png');
      const files = [...new Set(found.refs.map((r) => r.file))].sort();
      check('a public asset is found where it is used', files.includes('src/pages/gallery.astro'), short(files));
      check('  in a stylesheet', files.includes('src/styles/site.css'), short(files));
      check('  and in markdown', files.includes('src/content/blog/post.md'), short(files));
      check('  and it is the URL, not the file path, that is looked for', found.refs.every((r) => r.address === '/images/hero.png'), short(found.refs.map((r) => r.address)));
      // THE DECOY. `/images/hero.png.bak` and `/images/heroic.png` both begin
      // with the asset's address as a string.
      check('a longer path that shares the prefix is NOT a reference', !files.includes('src/pages/decoy.astro'), short(found.refs.filter((r) => r.file.includes('decoy'))));
      check('and nothing was mistaken for a runtime-built reference', found.dynamic.length === 0, short(found.dynamic));

      const imports = assetRefs.referencesTo(root, 'src/assets/logo.png');
      const importFiles = [...new Set(imports.refs.map((r) => r.file))].sort();
      check('a src asset is found through its ESM imports', importFiles.includes('src/pages/brand.astro'), short(importFiles));
      check('  from every file that imports it', importFiles.includes('src/components/Mark.astro'), short(importFiles));
      check('  and the specifier is the one THAT file would write', imports.refs.some((r) => r.address === '../assets/logo.png'), short(imports.refs.map((r) => r.address)));
    } finally {
      H.removeProject(root);
    }
  }

  // ── a public asset moves, and its references go with it ───────────────────

  {
    const root = fixture();
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const decoyBefore = app.read('src/pages/decoy.astro');
      const moved = await run('asset', 'move', { path: 'public/images/hero.png', toFolder: 'public/media' });
      check('the move succeeds', moved.ok === true, short(moved));
      check('and says where it landed', moved.path === 'public/media/hero.png', short(moved));
      check('the file is at the new address', app.exists('public/media/hero.png'));
      check('and not at the old one', !app.exists('public/images/hero.png'));

      for (const [label, file] of [
        ['the page', 'src/pages/gallery.astro'],
        ['the stylesheet', 'src/styles/site.css'],
        ['the markdown', 'src/content/blog/post.md'],
      ]) {
        const text = app.read(file);
        check(`${label} points at the new address`, text.includes('/media/hero.png'), text.slice(0, 200));
        check(`  and no longer at the old one`, !text.includes('/images/hero.png'), text.slice(0, 200));
      }
      // BOTH references in the page, not just the first.
      const gallery = app.read('src/pages/gallery.astro');
      check('both the src and the href moved', (gallery.match(/\/media\/hero\.png/g) || []).length === 2, gallery);

      // THE DECOY IS UNTOUCHED, byte for byte.
      check('the file holding lookalike paths is byte-identical', app.read('src/pages/decoy.astro') === decoyBefore, app.read('src/pages/decoy.astro'));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── a src asset moves, and its imports resolve afterwards ─────────────────
  //
  // Graded with Stacki's own resolver, which is the operation an agent would
  // use to check — and which answered `null` for this exact case before.

  {
    const root = fixture();
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const moved = await run('asset', 'move', { path: 'src/assets/logo.png', toFolder: 'src/assets/brand' });
      check('the move succeeds', moved.ok === true, short(moved));
      check('the file is at the new address', app.exists('src/assets/brand/logo.png'));

      for (const file of ['src/pages/brand.astro', 'src/components/Mark.astro']) {
        const spec = (app.read(file).match(/from '([^']+)'/) || [])[1];
        check(`[${file}] the import was rewritten`, spec !== '../assets/logo.png', String(spec));
        const resolved = await run('content', 'resolve_import', { fromFile: file, spec });
        check(`  and Stacki's own resolver finds the file`, resolved.path === 'src/assets/brand/logo.png', short(resolved));
      }
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── a rename is an address change too ─────────────────────────────────────

  {
    const root = fixture();
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const renamed = await run('asset', 'rename', { path: 'public/images/hero.png', name: 'banner.png' });
      check('the rename succeeds', renamed.ok === true, short(renamed));
      const gallery = app.read('src/pages/gallery.astro');
      check('and the page follows it', gallery.includes('/images/banner.png'), gallery.slice(0, 200));
      check('  with nothing left at the old name', !gallery.includes('/images/hero.png'), gallery.slice(0, 200));
      check('and the stylesheet follows too', app.read('src/styles/site.css').includes('/images/banner.png'));

      const srcRename = await run('asset', 'rename', { path: 'src/assets/logo.png', name: 'mark.png' });
      check('a src asset can be renamed too', srcRename.ok === true, short(srcRename));
      const spec = (app.read('src/pages/brand.astro').match(/from '([^']+)'/) || [])[1];
      const resolved = await run('content', 'resolve_import', { fromFile: 'src/pages/brand.astro', spec });
      check('  and its import still resolves', resolved.path === 'src/assets/mark.png', short(resolved));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── what cannot be rewritten is refused BEFORE anything moves ─────────────

  {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'src/pages/dyn.astro'),
      "---\nconst name = 'hero';\n---\n<img src={`/images/${name}.png`} alt=\"d\" />\n",
      'utf8'
    );
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const before = app.read('src/pages/gallery.astro');
      const moved = await run('asset', 'move', { path: 'public/images/hero.png', toFolder: 'public/media' });
      check('a move that would break a runtime-built reference is refused', moved.ok === false, short(moved));
      check('  by name', moved.code === 'unsupported', short(moved));
      check('  naming the file and line', /src\/pages\/dyn\.astro:\d+/.test(String(moved.message)), String(moved.message));
      check('  and saying nothing was moved', /[Nn]othing was moved/.test(String(moved.message)), String(moved.message));

      // NOTHING MOVED. Not the asset, and not one byte of any reference.
      check('the asset is still where it was', app.exists('public/images/hero.png'), 'the asset moved anyway');
      check('and nothing is at the destination', !app.exists('public/media/hero.png'));
      check('and the page that COULD have been rewritten was not', app.read('src/pages/gallery.astro') === before, 'a reference was rewritten for a move that did not happen');

      const renamed = await run('asset', 'rename', { path: 'public/images/hero.png', name: 'banner.png' });
      check('and a rename is refused for the same reason', renamed.ok === false && renamed.code === 'unsupported', short(renamed));
      check('  with the asset still under its own name', app.exists('public/images/hero.png'));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── an asset nothing points at moves quietly ──────────────────────────────
  //
  // The control. Reference safety must not turn every move into a negotiation.

  {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'public/images/unused.png'), 'PNG', 'utf8');
    const app = await H.start(root, { agentMode: 'full' });
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    await H.settle(600);
    try {
      const before = app.read('src/pages/gallery.astro');
      const moved = await run('asset', 'move', { path: 'public/images/unused.png', toFolder: 'public/media' });
      check('an unreferenced asset moves', moved.ok === true, short(moved));
      check('and nothing else was touched', app.read('src/pages/gallery.astro') === before);
      check('and the asset that IS referenced did not move', app.exists('public/images/hero.png'));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  if (failures.length) {
    console.error(`\nasset-references: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`asset-references: ${checked} passed  [an asset and its pointers move together, or neither moves]`);
  process.exit(0);
})().catch((err) => {
  console.error('asset-references: threw\n', err);
  process.exit(1);
});
