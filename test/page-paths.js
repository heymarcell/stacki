// One coordinate system for pages and folders.
//
//   node test/page-paths.js
//
// A live dogfood called `page.folder_rename` with a project-relative path — the
// spelling this API RETURNS from `page.create`, and the spelling every other
// domain takes — and was told:
//
//     src/pages/src/pages/blog is not in this project.
//
// The resolver prefixed `src/pages/` onto whatever it was handed, unconditionally.
// Three of the folder actions did not even fail at it: `folder_create` with
// `src/pages/news` answered `ok: true` and made `src/pages/src/pages/news`, a
// directory that is not a route and that nothing will ever look in.
//
// And underneath that, `page.move` took `from` through the project-relative
// resolver and `to` through the prefixing one. ONE OPERATION, TWO COORDINATE
// SYSTEMS, and nothing in the schema, the docs, the errors or the outputs said
// so — the two arguments were both called "path".
//
// So there is one space now: project-relative, POSIX, under `src/pages`, which
// is what these actions already ANSWER with. The rule lives in one constant in
// electron/mcp/agentTools.js, the resolver that enforces it is `pagesRel` in
// electron/mcp/agent/domains.js, and this file checks that the schema, the
// refusals, the outputs and the filesystem all agree about it.
//
// WHY THE OLD SPELLING IS REFUSED RATHER THAN ACCEPTED AS WELL. Taking both
// would mean guessing, for any value that is ambiguous, which of two things the
// caller meant — and guessing is the whole of what went wrong. A refusal that
// names the path to pass costs one round trip and cannot silently create a
// directory in the wrong place.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const H = require('./agent-harness.js');

const short = (x, n = 260) => JSON.stringify(x ?? null).slice(0, n);

(async () => {
  const root = H.makeProject();
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  // ── the canonical spelling works, and does not double ─────────────────────

  {
    const made = await run('page', 'folder_create', { dir: 'src/pages/news' });
    check('folder_create takes a project-relative path', made.ok === true, short(made));
    check('and answers in the same space it was given', made.path === 'src/pages/news', short(made));
    check('and the folder is where it said', app.exists('src/pages/news'));
    // THE DEFECT, as an assertion.
    check('and there is no phantom src/pages/src/pages', !app.exists('src/pages/src/pages'), 'the prefix was applied twice');

    const renamed = await run('page', 'folder_rename', { from: 'src/pages/news', to: 'src/pages/archive' });
    check('folder_rename takes both ends project-relative', renamed.ok === true, short(renamed));
    check('and names where it came from', renamed.from === 'src/pages/news', short(renamed));
    check('and where it went', renamed.path === 'src/pages/archive', short(renamed));
    check('and the folder moved', app.exists('src/pages/archive') && !app.exists('src/pages/news'));

    const deleted = await run('page', 'folder_delete', { dir: 'src/pages/archive' });
    check('folder_delete takes a project-relative path', deleted.ok === true, short(deleted));
    check('and says what it removed', deleted.deleted === 'src/pages/archive', short(deleted));
    check('and it is gone', !app.exists('src/pages/archive'));
  }

  // ── the answer of one call is the argument of the next ────────────────────
  //
  // The round trip that used to double. Nothing here types a path: every one
  // comes out of a previous answer, which is how an agent actually works.

  {
    const made = await run('page', 'create', { name: 'contact' });
    check('page.create answers with a project-relative path', made.path === 'src/pages/contact.astro', short(made));

    const moved = await run('page', 'move', { from: made.path, to: 'src/pages/reach-us.astro' });
    check('and page.move accepts that answer as its `from`', moved.ok === true, short(moved));
    check('and answers in the same space', moved.path === 'src/pages/reach-us.astro', short(moved));
    check('and the file is there', app.exists('src/pages/reach-us.astro'));

    const gone = await run('page', 'delete', { path: moved.path });
    check('and page.delete accepts THAT answer', gone.ok === true, short(gone));
    check('and the file is gone', !app.exists('src/pages/reach-us.astro'));
  }

  // ── every path argument in the domain speaks the same space ───────────────

  {
    await run('page', 'folder_create', { dir: 'src/pages/docs' });
    const made = await run('page', 'create', { name: 'docs/intro' });
    check('page.create takes a NAME, folders and all', made.ok === true, short(made));
    check('and answers with the path', made.path === 'src/pages/docs/intro.astro', short(made));

    const read = await run('page', 'read', { path: 'src/pages/docs/intro.astro' });
    check('page.read takes the same path', read.ok === true, short(read));

    const list = await run('page', 'list');
    const routes = (list.pages || []).map((p) => p.route);
    check('and the route is what a project-relative path implies', routes.includes('/docs/intro'), short(routes));
    const paths = (list.pages || []).map((p) => p.path);
    check('and page.list reports project-relative paths too', paths.every((f) => f.startsWith('src/pages/')), short(paths));

    await run('page', 'folder_delete', { dir: 'src/pages/docs' });
  }

  // ── the refusals, and whether they are worth reading ──────────────────────

  const refusals = [
    ['the old spelling — relative to src/pages', { dir: 'news' }, /Pass src\/pages\/news/],
    ['a nested old spelling', { dir: 'blog/posts' }, /Pass src\/pages\/blog\/posts/],
    ['traversal', { dir: '../escape' }, /inside the project/],
    ['traversal in the middle', { dir: 'src/pages/../../escape' }, /inside the project/],
    ['an absolute path', { dir: '/etc/passwd' }, /inside the project/],
    ['somewhere else in the project', { dir: 'src/components' }, /somewhere else in the project/],
    ['the empty string', { dir: '' }, /is required/],
  ];

  for (const [label, args, wants] of refusals) {
    const before = app.exists('src/pages') ? 'ok' : 'gone';
    const out = await run('page', 'folder_create', args);
    check(`folder_create refuses ${label}`, out.ok === false, short(out));
    check(`  and the code is bad_path`, out.code === 'bad_path', short(out));
    // A REFUSAL SOMEBODY CAN ACT ON. Prefixing `src/pages/` onto `../escape`
    // produces advice that is a traversal, and onto `/etc/passwd` advice that
    // is a fiction; telling somebody to pass one of those is worse than telling
    // them nothing, so each shape gets the sentence that fits it.
    check(`  and it says what to do about it`, wants.test(String(out.message || '')), String(out.message));
    check(`  and says nothing was changed`, /Nothing was changed|is required/.test(String(out.message || '')), String(out.message));
    check(`  and src/pages is intact`, (app.exists('src/pages') ? 'ok' : 'gone') === before);
  }

  // The advice for a traversal must never itself be a traversal, and the advice
  // for an absolute path must never be one either.
  {
    const out = await run('page', 'folder_create', { dir: '../escape' });
    check('the advice for a traversal contains no ..', !/\.\.\//.test(String(out.message || '').split('such as')[1] || ''), String(out.message));
    const abs = await run('page', 'folder_create', { dir: '/etc/passwd' });
    check('and the advice for an absolute path is not src/pages/etc/passwd', !/src\/pages\/etc\/passwd/.test(String(abs.message || '')), String(abs.message));
  }

  // ── from/to symmetry ──────────────────────────────────────────────────────
  //
  // Both ends of a two-ended operation are judged by the same rule. `from`
  // going through one resolver and `to` through another is the defect itself.

  {
    await run('page', 'folder_create', { dir: 'src/pages/a' });
    for (const [label, args] of [
      ['from in the old spelling', { from: 'a', to: 'src/pages/b' }],
      ['to in the old spelling', { from: 'src/pages/a', to: 'b' }],
      ['from outside src/pages', { from: 'src/components', to: 'src/pages/b' }],
      ['to outside src/pages', { from: 'src/pages/a', to: 'src/components/b' }],
      ['to traversing out', { from: 'src/pages/a', to: 'src/pages/../../b' }],
    ]) {
      const out = await run('page', 'folder_rename', args);
      check(`folder_rename refuses ${label}`, out.ok === false && out.code === 'bad_path', short(out));
      check(`  and moved nothing`, app.exists('src/pages/a'));
    }

    // The same, for page.move — the operation that had two spaces.
    await run('page', 'create', { name: 'movable' });
    for (const [label, args] of [
      ['from in the old spelling', { from: 'movable.astro', to: 'src/pages/moved.astro' }],
      ['to in the old spelling', { from: 'src/pages/movable.astro', to: 'moved.astro' }],
      ['to outside src/pages', { from: 'src/pages/movable.astro', to: 'src/components/moved.astro' }],
    ]) {
      const out = await run('page', 'move', args);
      check(`page.move refuses ${label}`, out.ok === false && out.code === 'bad_path', short(out));
      check(`  and the page is still where it was`, app.exists('src/pages/movable.astro'));
    }
    await run('page', 'delete', { path: 'src/pages/movable.astro' });
    await run('page', 'folder_delete', { dir: 'src/pages/a' });
  }

  // ── spellings that mean the same place ────────────────────────────────────

  {
    // A Windows-shaped separator is punctuation, not a different location.
    const win = await run('page', 'folder_create', { dir: 'src\\pages\\win' });
    check('a backslash separator is accepted as the same path', win.ok === true, short(win));
    check('and lands where the POSIX spelling would', app.exists('src/pages/win'), short(win));
    check('and is answered in POSIX', win.path === 'src/pages/win', short(win));
    await run('page', 'folder_delete', { dir: 'src/pages/win' });

    const dot = await run('page', 'folder_create', { dir: './src/pages/dotted' });
    check('a leading ./ is accepted', dot.ok === true, short(dot));
    check('and answered without it', dot.path === 'src/pages/dotted', short(dot));
    await run('page', 'folder_delete', { dir: 'src/pages/dotted' });

    // A space and a non-ASCII name are ordinary folder names, not path syntax.
    const spaced = await run('page', 'folder_create', { dir: 'src/pages/case studies' });
    check('a folder name with a space works', spaced.ok === true, short(spaced));
    check('and is answered as given', spaced.path === 'src/pages/case studies', short(spaced));
    await run('page', 'folder_delete', { dir: 'src/pages/case studies' });

    const unicode = await run('page', 'folder_create', { dir: 'src/pages/tükörfúró' });
    check('a folder name with accents works', unicode.ok === true, short(unicode));
    check('and is answered as given', unicode.path === 'src/pages/tükörfúró', short(unicode));
    await run('page', 'folder_delete', { dir: 'src/pages/tükörfúró' });
  }

  // ── src/pages itself ──────────────────────────────────────────────────────

  {
    const out = await run('page', 'folder_delete', { dir: 'src/pages' });
    check('the pages directory itself cannot be deleted', out.ok === false, short(out));
    check('and it is still there', app.exists('src/pages'));
  }

  // ── the published schema says what the resolver enforces ──────────────────
  //
  // The other half of "one space": a client reads the schema, not this file. A
  // rule enforced in a resolver and described nowhere is a rule callers learn by
  // being refused.

  {
    const { toolShapes } = require('../electron/mcp/agentTools.js');
    let page = null;
    try {
      page = toolShapes ? toolShapes().find((t) => t.name === 'page') : null;
    } catch {
      /* the shape helper is optional; the text check below is the one that matters */
    }
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'electron', 'mcp', 'agentTools.js'), 'utf8');
    check(
      'the path rule is stated once, in a constant',
      /const PAGE_PATH_RULE = /.test(source),
      'the schema should not repeat the rule in six descriptions'
    );
    check('and it names the space', /Project-relative and under src\/pages\//.test(source), 'PAGE_PATH_RULE');
    check(
      'and every page/folder path argument uses it',
      (source.match(/PagePath/g) || []).length >= 8,
      `${(source.match(/PagePath/g) || []).length} uses`
    );
    check(
      'and page.create says it takes a NAME rather than a path',
      /name is a name rather than a path|is a name rather than a path/.test(source),
      'the one argument in the domain that is not a path has to say so'
    );
    void page;
  }

  H.removeProject(root);

  if (failures.length) {
    console.error(`\npage-paths: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`page-paths: ${checked} passed  [one coordinate system, in the schema, the refusals, the answers and the filesystem]`);
  process.exit(0);
})().catch((err) => {
  console.error('page-paths: threw\n', err);
  process.exit(1);
});
