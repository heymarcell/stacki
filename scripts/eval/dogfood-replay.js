// The dogfood's own failures, replayed against the exact package, in a window.
//
//   node scripts/eval/dogfood-replay.js --app=<path to Stacki.app> [--project=<dir>]
//   node scripts/eval/dogfood-replay.js --app=… --hidden      # no window, for CI
//
// WHAT THIS IS FOR. A live dogfood session filed sixteen defects and nine
// observations against a packaged Stacki. Ten of the sixteen turned out to be
// true of a build ninety-three commits older than the one being qualified — a
// thing nobody could establish at the time, because both said "0.1.23". The
// rest were real and are fixed. This is the replay: the exact provenance-pinned
// package, on a disposable copy of the dogfood's own project, driven through a
// real MCP client, with the verdicts taken off disk.
//
// IT PRINTS ITS PROVENANCE FIRST, and refuses to run if the package cannot be
// pinned to the source it claims to come from. That is the whole lesson of the
// campaign: a report about "what Stacki did" that cannot name the bytes that
// did it is a report about nothing.
//
// THE ORACLES ARE BYTES AND GIT, NEVER A SENTENCE. Every check below reads a
// file back with `fs`, or asks the packaged app's own MCP surface and compares
// the answer against what is on disk. Nothing grades prose.
//
// THIS PROCESS'S OWN CLIENT, NOT A MODEL. `scripts/eval/blockers/final.js`
// drives a contained Claude Code at the same app and is the right shape for
// "would an agent find this" — an elicitation. This is the other half, and it
// is the half that can be red for a reason worth reading: every scenario here
// is a measurement of STACKI, evaluable on every run, with no model in the
// loop to be lucky.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const { startPackagedApp, available } = require(path.join(REPO, 'test/support/packagedApp.js'));
const provenance = require(path.join(REPO, 'scripts/provenance.js'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (condition) {
    console.log(`    ok   ${what}`);
  } else {
    console.log(`    FAIL ${what}${detail ? `\n         ${detail}` : ''}`);
    failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  }
  return !!condition;
};
const say = (s = '') => console.log(s);
const short = (x, n = 200) => JSON.stringify(x ?? null).slice(0, n);

// --- the project ------------------------------------------------------------
//
// A DISPOSABLE COPY, ALWAYS. The forensic dogfood project is evidence; a replay
// that edited it would destroy the thing the replay is about.

/**
 * A disposable copy of a real project, with the replay's own fixtures over it.
 *
 * THE COPY IS NOT OPTIONAL. The dogfood's project is evidence; a replay that
 * edited it would destroy the thing it is about. And it has to be a copy of a
 * REAL one rather than a fresh directory, because the packaged app refuses to
 * open a project with no dependencies installed — which is correct of it, and
 * means the fixture has to arrive with `node_modules`.
 *
 * The overlay is what makes the scenarios repeatable: the pages, the stylesheet
 * and the asset below are shaped like the exact things that broke, so the
 * replay asks the same questions whatever the borrowed project happens to
 * contain.
 */
function disposableCopy(from) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-replay-project-'));
  fs.cpSync(from, to, { recursive: true, dereference: false });
  fs.rmSync(path.join(to, '.git'), { recursive: true, force: true });
  fs.rmSync(path.join(to, '.stacki'), { recursive: true, force: true });
  fs.rmSync(path.join(to, '.astro'), { recursive: true, force: true });
  return to;
}

/** The replay's own pages, written over whatever the copy had. */
function overlayFixtures(root) {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  };
  // Anything else under src/pages would be a page the scenarios have to account
  // for; the replay owns this project's routes.
  for (const entry of fs.readdirSync(path.join(root, 'src', 'pages'), { withFileTypes: true })) {
    fs.rmSync(path.join(root, 'src', 'pages', entry.name), { recursive: true, force: true });
  }
  // TABS and a joined emoji, exactly as the dogfood's own page had them.
  w(
    'src/pages/index.astro',
    `---
import '../styles/global.css';
import Card from '../components/Card.astro';
---
<main>
\t<h1>🧑‍🚀 Hello, Astronaut!</h1>
\t<p>Ten kilos of nothing.</p>
\t<div class="box">scoped vs global</div>
\t<Card title="One" />
\t<Card title="Two" />
\t<Card title="Three" />
\t<img src="/images/hero.png" alt="hero" />
</main>
<style>
\t.box { color: blue }
</style>
`
  );
  w('src/pages/about.astro', '---\n---\n<main>\n\t<h1>About</h1>\n</main>\n');
  w('src/components/Card.astro', '---\nconst { title } = Astro.props;\n---\n<article class="card">\n\t<h3>{title}</h3>\n</article>\n');
  w(
    'src/components/Feature.astro',
    '---\n---\n<div class="feature">f</div>\n<style>\n\t@media (max-width: 1024px) { .feature { color: teal } }\n</style>\n'
  );
  w(
    'src/styles/global.css',
    `:root {
\t--accent: #2337ff;
\t--gap: 1.25rem;

\t/* Dogfood lab tokens */
}
div.box {
\tcolor: red;
}
body {
\tmargin: 0;
}
@media (max-width: 720px) {
\tbody { font-size: 18px }
}
.hero-bg {
\tbackground: url(/images/hero.png);
}
.sr-only {
\tborder: 0;
\tposition: absolute !important;
\theight: 1px;
\twidth: 1px;
\toverflow: hidden;
\t/* modern browsers, clip-path works inwards from each corner */
\tclip-path: inset(50%);
\twhite-space: nowrap;
}
`
  );
  w('public/images/hero.png', 'PNG-BYTES');
  return root;
}

// --- the run ----------------------------------------------------------------

(async () => {
  const appPath = arg('app', path.join(REPO, 'release', 'mac-universal', 'Stacki.app'));
  const visible = !flag('hidden');

  if (!available(appPath)) {
    console.error(`dogfood-replay: no packaged app at ${appPath}. Run npm run dist:mac:unsigned first.`);
    process.exit(2);
  }

  // ── PROVENANCE FIRST, AND IT IS A GATE ────────────────────────────────────
  const sourceRoot = arg('source', REPO);
  const pin = provenance.compare({ appPath, sourceRoot });
  say('='.repeat(78));
  say('DOGFOOD REPLAY — the exact package, in a window');
  say('='.repeat(78));
  say(provenance.report(pin));
  say();
  if (!pin.ok) {
    console.error('dogfood-replay: the package cannot be pinned to its source. Nothing was run.');
    console.error('A dogfood report about a build nobody can name is what this whole campaign was about.');
    process.exit(1);
  }

  // The dogfood's own project by default — a COPY of it, with the replay's
  // fixtures written over the top.
  const source = arg('project', '/Users/heymarcell/DEV/stacki-live-dogfood');
  if (!fs.existsSync(path.join(source, 'node_modules', 'astro'))) {
    console.error(`dogfood-replay: ${source} has no installed astro. Pass --project=<a project with node_modules>.`);
    process.exit(2);
  }
  say(`copying ${source} …`);
  const project = overlayFixtures(disposableCopy(source));
  say(`project (a disposable copy, fixtures overlaid): ${project}`);
  say(`window: ${visible ? 'VISIBLE — this will take the screen' : 'hidden'}`);
  say();

  let app = null;
  const started = Date.now();
  try {
    // `edit`, NOT `full`. `full` is destructive and remote, and
    // electron/mcp/agent/access.js makes it session-only on purpose — it cannot
    // be written into settings, so asking for it here gets the DEFAULT, which is
    // `visual`, and every write in this file comes back `permission_denied`.
    // The first dry run did exactly that. Nothing below needs `high`.
    app = await startPackagedApp({ access: 'edit', project, app: appPath, visible, contained: false });
  } catch (err) {
    console.error(`dogfood-replay: the app did not start — ${err.message}`);
    fs.rmSync(project, { recursive: true, force: true });
    process.exit(1);
  }

  const call = async (domain, action, args = {}) => {
    const res = await app.client.callTool({ name: domain, arguments: { action, ...args } }, { timeout: 120000 });
    return res.structuredContent ?? {};
  };
  const tool = async (name, args = {}) => {
    const res = await app.client.callTool({ name, arguments: args }, { timeout: 120000 });
    return res.structuredContent ?? {};
  };
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(project, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const exists = (rel) => fs.existsSync(path.join(project, rel));

  try {
    // ── L (first, because everything else is a claim about this build) ──────
    say('DOGFOOD L — which build is answering');
    {
      const ctx = await tool('get_context', {});
      check('get_context carries a build identity', !!ctx.build, short(ctx.build));
      check('  and it is the packaged commit', ctx.build?.gitHead === pin.packaged.gitHead, `${ctx.build?.gitHead} vs ${pin.packaged.gitHead}`);
      check('  and the packaged tree', ctx.build?.gitTree === pin.packaged.gitTree, `${ctx.build?.gitTree}`);
      check('  and it says it is packaged', ctx.build?.buildKind === 'packaged', short(ctx.build));
      check('  built from a clean tree', ctx.build?.dirty === false, short(ctx.build));
      // THE SIX VALUES AGREE. This is the check the dogfood could not make.
      const live = provenance.compare({ appPath, sourceRoot, live: { gitHead: ctx.build?.gitHead, gitTree: ctx.build?.gitTree } });
      check('source, package and the running app all name one commit', live.ok, live.reasons.join(' | '));

      const prompts = await app.client.listPrompts();
      check('prompts/list answers with the three prompts', (prompts.prompts || []).length === 3, short((prompts.prompts || []).map((p) => p.name)));
      const resources = await app.client.listResources();
      const uris = (resources.resources || []).map((r) => r.uri);
      check('and stacki://build is a resource', uris.includes('stacki://build'), short(uris));
      const built = await app.client.readResource({ uri: 'stacki://build' });
      const body = JSON.parse(built.contents?.[0]?.text || '{}');
      check('  whose body is the same identity', body.gitHead === ctx.build?.gitHead, short(body));
    }

    // ── A — source fidelity ────────────────────────────────────────────────
    say('\nDOGFOOD A — a joined emoji through a structural edit');
    {
      const before = read('src/pages/index.astro');
      check('the page starts with a literal joiner', before.includes('\u{1F9D1}‍\u{1F680}'), 'the fixture is wrong');
      check('  and no numeric entity', !before.includes('&#8205;'), before.slice(0, 120));
      const h1Line = before.split('\n').find((l) => l.includes('<h1>'));

      const page = await call('target', 'read');
      const mainRef = page.target?.ref;
      const appended = await call('target', 'append_child', { ref: mainRef, node: { kind: 'element', tag: 'small', text: 'Since 2024' } });
      check('append_child lands', appended.ok === true, short(appended));

      const after = read('src/pages/index.astro');
      check('the joiner is still literal on disk', after.includes('\u{1F9D1}‍\u{1F680}'), 'it was rewritten');
      check('  and was not turned into an entity', !after.includes('&#8205;'), after.split('\n').find((l) => l.includes('<h1>')));
      check('  and the untouched <h1> line is byte-identical', after.split('\n').find((l) => l.includes('<h1>')) === h1Line, `${h1Line}\n         became ${after.split('\n').find((l) => l.includes('<h1>'))}`);
      check('  and no tab became a space', !after.split('\n').some((l) => /^\t* {2,}\S/.test(l)), after.split('\n').filter((l) => /^\t* {2,}\S/.test(l)).join(' | '));
      // A ONE-NODE INSERTION IS ONE LINE.
      const added = after.split('\n').length - before.split('\n').length;
      check('  and the file grew by one line', added === 1, `${added} lines`);
      await call('project', 'undo');
      await sleep(400);
    }

    // ── B — refs around repeated siblings ──────────────────────────────────
    say('\nDOGFOOD B — three near-identical cards, and a stale handle');
    {
      // FROM A KNOWN PAGE. A read with no ref describes the SELECTION, and the
      // selection after scenario A's undo is not something this scenario should
      // be guessing about.
      await call('page', 'open', { route: '/' });
      await sleep(600);
      const page = await call('target', 'read');
      const cards = (page.target?.children || []).filter((c) => c.tag === 'Card');
      check('the page has three cards', cards.length === 3, short((page.target?.children || []).map((c) => c.tag)));
      const first = cards[0]?.ref;
      const second = cards[1]?.ref;
      check('each carries a ref of its own', !!first && !!second && first !== second);

      const changed = await call('target', 'set_prop', { ref: first, name: 'title', value: 'Changed' });
      check('editing the first card lands', changed.ok === true, short(changed));
      await sleep(300);
      const stale = await call('target', 'set_prop', { ref: second, name: 'title', value: 'ShouldRefuse' });
      check('a write through the sibling ref taken BEFORE that edit is refused', stale.ok === false, short(stale));
      check('  as stale, by name', stale.code === 'stale_target', short(stale));
      // AND THE WORDING IS THE TARGET DOMAIN'S.
      const words = String(stale.message || '');
      check('  in target language, not review language', !/orphaned|this review|creationContext/i.test(words), words);
      check('  and nothing was written', !read('src/pages/index.astro').includes('ShouldRefuse'));

      const fresh = await call('target', 'read');
      const again = (fresh.target?.children || []).filter((c) => c.tag === 'Card')[1]?.ref;
      const ok = await call('target', 'set_prop', { ref: again, name: 'title', value: 'Two-Edited' });
      check('a re-read gives a handle that works', ok.ok === true, short(ok));
      check('  and it is on disk', read('src/pages/index.astro').includes('Two-Edited'));
      await call('project', 'undo');
      await sleep(300);
      await call('project', 'undo');
      await sleep(300);
    }

    // ── C — the page loop ──────────────────────────────────────────────────
    say('\nDOGFOOD C — make a page, list it, open it');
    {
      const made = await call('page', 'create', { name: 'mcp-dogfood-2' });
      check('page.create lands', made.ok === true, short(made));
      check('  and answers project-relative', made.path === 'src/pages/mcp-dogfood-2.astro', short(made));
      check('  and the file is there', exists('src/pages/mcp-dogfood-2.astro'));
      await sleep(700);

      const list = await call('page', 'list');
      const routes = (list.pages || []).map((p) => p.route);
      check('page.list sees it', routes.includes('/mcp-dogfood-2'), short(routes));

      const opened = await call('page', 'open', { route: '/mcp-dogfood-2' });
      check('page.open navigates to it', opened.ok === true && opened.moved === true, short(opened));
      await sleep(600);
      const ctx = await tool('get_context', {});
      check('  and get_context says that route', ctx.page?.route === '/mcp-dogfood-2', short(ctx.page));
      check('  and names its file', ctx.page?.file === 'src/pages/mcp-dogfood-2.astro', short(ctx.page));

      const back = await call('page', 'open', { route: '/' });
      check('and it can navigate back', back.ok === true, short(back));
      await sleep(500);
    }

    // ── D — scoped style ───────────────────────────────────────────────────
    say('\nDOGFOOD D — a scoped rule against a global one');
    {
      const page = await call('target', 'read');
      const box = (page.target?.children || []).find((c) => c.tag === 'div');
      const styles = await call('style', 'read', { ref: box.ref, properties: ['color'] });
      const decls = (styles.rules || []).flatMap((r) =>
        (r.declarations || []).filter((d) => d.property === 'color').map((d) => ({ sel: r.selector, scope: r.source?.scope, value: d.value, winning: d.winning }))
      );
      const winner = decls.find((d) => d.winning);
      check('both rules are seen', decls.length >= 2, short(decls));
      // Astro serves `.box` as `.box[data-astro-cid-…]`, which beats `div.box`.
      check('the scoped rule wins, as the browser paints it', winner?.value === 'blue', short(decls));
      check('  and it is the scoped source', winner?.scope === 'scoped', short(winner));
      check('  and no problem is invented for a right answer', (styles.problems || []).length === 0, short(styles.problems));

      // A component instance is not an element, and says so.
      const card = (page.target?.children || []).find((c) => c.tag === 'Card');
      const instance = await call('style', 'read', { ref: card.ref });
      check('a component instance says what it is', instance.about?.kindOfThing === 'component_instance', short(instance.about));
      // EITHER ANSWER IS RIGHT, AND THE EMPTY SUCCESS IS NEITHER. With a canvas
      // running, `resolveTarget` finds the box the instance renders and the read
      // is about a real element — the better answer, and the one this build
      // gives here. Without one it must SAY it did not resolve. What the dogfood
      // got was the third thing: no box, no explanation, and a rule list
      // indistinguishable from an element with no CSS.
      const resolved = instance.about?.unresolvedInstance === false && !!instance.element?.tag;
      const explained = instance.about?.unresolvedInstance === true && (instance.problems || []).length > 0;
      check('  and either resolves the rendered box or says it could not', resolved || explained, `${short(instance.about)} element=${short(instance.element)} problems=${short(instance.problems)}`);
    }

    // ── E — CSS sections ───────────────────────────────────────────────────
    say('\nDOGFOOD E — the heading operations, on a real stylesheet');
    {
      const css = read('src/styles/global.css');
      const srOnly = css.slice(css.indexOf('.sr-only'));
      const at = css.indexOf('/* Dogfood lab tokens */');
      check('the stylesheet has the dogfood heading', at > 0);

      const renamed = await call('style', 'edit', {
        action: 'set_section_title',
        edit: { file: 'src/styles/global.css', start: at, end: at + '/* Dogfood lab tokens */'.length, expect: '/* Dogfood lab tokens */', title: 'Lab tokens' },
      });
      check('set_section_title answers', renamed.ok === true, short(renamed));
      const afterRename = read('src/styles/global.css');
      check('  and writes a DELIMITED comment', /\/\*\s*Lab tokens\s*\*\//.test(afterRename), afterRename.split('\n').find((l) => l.includes('Lab tokens')));
      check('  and :root did not gain clip-path', !/:root\s*\{[^}]*clip-path/.test(afterRename), afterRename.slice(0, 300));
      check('  and .sr-only is byte-identical', afterRename.slice(afterRename.indexOf('.sr-only')) === srOnly, 'the neighbour moved');
      check('  and the braces still balance', (afterRename.match(/\{/g) || []).length === (afterRename.match(/\}/g) || []).length);
      check('  and the site did not lose 90% of its CSS', afterRename.split('\n').length >= css.split('\n').length - 1, `${css.split('\n').length} -> ${afterRename.split('\n').length}`);

      const now = afterRename.indexOf('/* Lab tokens */');
      const moved = await call('style', 'edit', {
        action: 'move_heading',
        edit: { file: 'src/styles/global.css', selector: ':root', start: now, end: now + '/* Lab tokens */'.length, expect: '/* Lab tokens */', before: '--accent' },
      });
      check('move_heading answers', moved.ok === true, short(moved));
      const afterMove = read('src/styles/global.css');
      check('  and clip-path is still .sr-only’s', /\.sr-only\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(afterMove), afterMove.slice(afterMove.indexOf('.sr-only'), afterMove.indexOf('.sr-only') + 260));
      check('  and :root has none', !/:root\s*\{[^}]*clip-path/.test(afterMove), afterMove.slice(0, 300));
      check('  and .sr-only is still byte-identical', afterMove.slice(afterMove.indexOf('.sr-only')) === srOnly);

      const gone = afterMove.indexOf('/* Lab tokens */');
      const removed = await call('style', 'edit', {
        action: 'remove_section',
        edit: { file: 'src/styles/global.css', start: gone, end: gone + '/* Lab tokens */'.length, expect: '/* Lab tokens */' },
      });
      check('remove_section answers', removed.ok === true, short(removed));
      const afterRemove = read('src/styles/global.css');
      const lost = afterMove.split('\n').length - afterRemove.split('\n').length;
      check('  and removes ONE line, not ninety-four', lost === 1, `${lost} lines`);
      check('  and body survives', /(^|\n)body\s*\{/.test(afterRemove));
      check('  and the @media block survives', afterRemove.includes('@media (max-width: 720px)'));
      check('  and .sr-only survives byte-identically', afterRemove.slice(afterRemove.indexOf('.sr-only')) === srOnly);
    }

    // ── F — an explicit style write with no selection ──────────────────────
    say('\nDOGFOOD F — an explicitly addressed rule, with nothing selected');
    {
      const before = read('src/styles/global.css');
      const written = await call('style', 'set_declarations', {
        source: 'file:src/styles/global.css',
        selector: '.written-without-selection',
        declarations: [{ property: 'z-index', value: '7' }, { property: 'opacity', value: '0.5' }],
      });
      check('an explicit style write lands', written.ok === true, short(written));
      const after = read('src/styles/global.css');
      check('  and the rule is on disk', after.includes('.written-without-selection'), after.slice(-260));
      check('  with both declarations', after.includes('z-index') && after.includes('opacity'));
      check('  and it changed the file', after !== before);
    }

    // ── G — content ────────────────────────────────────────────────────────
    say('\nDOGFOOD G — a malformed content write is a structured refusal');
    {
      const bad = await call('content', 'write_entry', { collection: 'nope', id: 'nothing', edit: { fields: {} } });
      check('a write to a collection that is not there is refused', bad.ok === false, short(bad));
      check('  with a code a client can branch on', typeof bad.code === 'string' && bad.code !== 'failed', short(bad));
      const words = String(bad.message || '');
      check('  and no raw Node internals', !/paths\[\d\]|ERR_INVALID_ARG_TYPE|TypeError/.test(words), words);
      check('  and no host path', !words.includes('/var/folders') && !words.includes(os.homedir()), words);
    }

    // ── H — folders ────────────────────────────────────────────────────────
    say('\nDOGFOOD H — one path space for folders');
    {
      const made = await call('page', 'folder_create', { dir: 'src/pages/guides' });
      check('folder_create takes a project-relative path', made.ok === true, short(made));
      check('  and does not double the prefix', !exists('src/pages/src/pages/guides'), 'a phantom tree was made');
      check('  and the folder is where it said', exists('src/pages/guides'));
      const old = await call('page', 'folder_create', { dir: 'legacy-spelling' });
      check('and the old spelling is refused rather than guessed at', old.ok === false && old.code === 'bad_path', short(old));
      check('  naming the path to pass', /src\/pages\/legacy-spelling/.test(String(old.message)), String(old.message));
      const renamed = await call('page', 'folder_rename', { from: 'src/pages/guides', to: 'src/pages/handbook' });
      check('folder_rename takes both ends in that space', renamed.ok === true, short(renamed));
      check('  and the folder moved', exists('src/pages/handbook') && !exists('src/pages/guides'));
      // `folder_delete` is `high` and this session is `edit`, so it is refused —
      // which is the permission gate doing its job, not a scenario failure. The
      // folder goes with the disposable project.
      const denied = await call('page', 'folder_delete', { dir: 'src/pages/handbook' });
      check('and a high-risk delete is refused at this access level', denied.ok === false && denied.code === 'permission_denied', short(denied));
    }

    // ── I — assets ─────────────────────────────────────────────────────────
    say('\nDOGFOOD I — an asset moves and its references go with it');
    {
      const pageBefore = read('src/pages/index.astro');
      const cssBefore = read('src/styles/global.css');
      check('the page references the asset', pageBefore.includes('/images/hero.png'));
      check('and so does the stylesheet', cssBefore.includes('url(/images/hero.png)'));

      const moved = await call('asset', 'move', { path: 'public/images/hero.png', toFolder: 'public/media' });
      check('asset.move lands', moved.ok === true, short(moved));
      check('  and the file is at the new address', exists('public/media/hero.png'));
      const pageAfter = read('src/pages/index.astro');
      const cssAfter = read('src/styles/global.css');
      check('  and the page follows it', pageAfter.includes('/media/hero.png'), pageAfter.split('\n').find((l) => l.includes('img')));
      check('    with nothing left at the old address', !pageAfter.includes('/images/hero.png'));
      check('  and the stylesheet follows it', cssAfter.includes('/media/hero.png'), cssAfter.split('\n').find((l) => l.includes('url(')));
      check('    with nothing left at the old address', !cssAfter.includes('url(/images/hero.png)'));
    }

    // ── J — the contract ───────────────────────────────────────────────────
    say('\nDOGFOOD J — a typoed argument dispatches nothing');
    {
      const ctxBefore = await tool('get_context', {});
      const page = await call('target', 'read');
      const bytesBefore = read('src/pages/index.astro');
      const typo = await call('target', 'remove', { target: page.target?.ref });
      check('a misspelled ref field is refused', typo.ok === false, short(typo));
      check('  as bad_arguments', typo.code === 'bad_arguments', short(typo));
      check('  naming the key', /target/.test(String(typo.message)), String(typo.message));
      check('  and NOTHING was removed', read('src/pages/index.astro') === bytesBefore, 'the file moved');
      const ctxAfter = await tool('get_context', {});
      check('  and the selection is untouched', ctxAfter.selection?.status === ctxBefore.selection?.status, `${ctxBefore.selection?.status} -> ${ctxAfter.selection?.status}`);
    }

    // ── K — the profile ────────────────────────────────────────────────────
    say('\nDOGFOOD K — every authored breakpoint, including the scoped one');
    {
      const res = await app.client.readResource({ uri: 'stacki://project/profile' });
      const profile = JSON.parse(res.contents?.[0]?.text || '{}')?.profile;
      const bps = profile?.breakpoints;
      const px = (bps?.items || []).map((b) => b.px).sort((a, b) => a - b);
      check('the global stylesheet breakpoint is reported', px.includes(720), short(bps));
      check('and the one in a component’s scoped <style> is too', px.includes(1024), short(bps));
      check('  attributed to the component that authored it', (bps?.items || []).some((b) => b.px === 1024 && /Feature\.astro$/.test(String(b.source))), short(bps?.items));
      check('and it says how many sources it read', typeof bps?.stylesheetsRead === 'number' && bps.stylesheetsRead > 0, short(bps));
      check('and does not claim the project has none', !/has no authored breakpoints/i.test(String(bps?.note)), String(bps?.note));
    }

    // ── M — the ordinary loop still works ──────────────────────────────────
    say('\nDOGFOOD M — one ordinary edit, undone, redone');
    {
      await call('page', 'open', { route: '/' });
      await sleep(600);
      const before = read('src/pages/index.astro');
      const page = await call('target', 'read');
      const p = (page.target?.children || []).find((c) => c.tag === 'p');
      if (!p) {
        check('the page has a paragraph to edit', false, short((page.target?.children || []).map((c) => c.tag)));
        throw new Error('scenario M cannot start');
      }
      const edited = await call('target', 'set_text', { ref: p.ref, text: 'Edited by the replay.' });
      check('an ordinary edit lands', edited.ok === true, short(edited));
      await sleep(400);
      const afterEdit = read('src/pages/index.astro');
      check('  and is on disk', afterEdit.includes('Edited by the replay.'));
      check('  and reports the file it changed, once', (edited.changedFiles || []).filter((f) => f.file === 'src/pages/index.astro').length === 1, short(edited.changedFiles));
      check('  and the patch counts the lines it actually changed', (edited.changedFiles?.[0]?.patch?.linesAdded ?? 99) <= 2, short(edited.changedFiles?.[0]?.patch));

      const undone = await call('project', 'undo');
      await sleep(400);
      check('undo reports it undid something', undone.undone === true, short(undone));
      check('  and the bytes are back', read('src/pages/index.astro') === before, 'the undo did not restore the file');

      const redone = await call('project', 'redo');
      await sleep(400);
      check('redo reports it redid something', redone.redone === true, short(redone));
      check('  and the edit is back', read('src/pages/index.astro').includes('Edited by the replay.'));

      // A NO-OP LEAVES NO STEP.
      const fresh = (await call('target', 'read')).target?.children?.find((c) => c.tag === 'p')?.ref;
      const again = await call('target', 'set_text', { ref: fresh, text: 'Edited by the replay.' });
      await sleep(400);
      check('writing the same text again succeeds', again.ok === true, short(again));
      check('  and reports no changed file', (again.changedFiles || []).length === 0, short(again.changedFiles));
      const back = await call('project', 'undo');
      await sleep(400);
      check('  and one undo still takes the real edit back', back.undone === true && read('src/pages/index.astro') === before, short(back));
    }
  } finally {
    say();
    const residue = app ? await app.stop() : null;
    if (residue) {
      const left = residue.paths?.length || residue.processes?.length || 0;
      check('the app and everything it owned are gone', !left, JSON.stringify(residue).slice(0, 300));
    }
    fs.rmSync(project, { recursive: true, force: true });
    check('and the disposable project is removed', !fs.existsSync(project));
  }

  say();
  say('='.repeat(78));
  say(`package        ${pin.packaged.packageVersion}  ${pin.packaged.gitHead}`);
  say(`tree           ${pin.packaged.gitTree}`);
  say(`artifact       sha256 ${pin.artifactSha256}`);
  say(`elapsed        ${Math.round((Date.now() - started) / 1000)}s`);
  if (failures.length) {
    say(`dogfood-replay: ${failures.length} FAILED of ${checked}`);
    for (const f of failures) say(`  - ${f}`);
    process.exit(1);
  }
  say(`dogfood-replay: ${checked} passed  [every dogfood failure that reproduced, replayed against this exact package]`);
  process.exit(0);
})().catch((err) => {
  console.error('dogfood-replay: threw\n', err);
  process.exit(1);
});
