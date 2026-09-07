// Two views of one project, and whether they agree.
//
//   node test/project-structure.js
//
// A live dogfood created a page through the Agent API. The file was on disk.
// The route worked. `page.list` returned it. `project:scan` returned it. And
// the page switcher the person was looking at did not have it, and would not
// until they closed the project and opened it again.
//
// WHY, and why it was every page and folder operation rather than one.
//
// Two doors reach these handlers. The Pages panel calls them over IPC and then
// calls `rescan()` itself, so its own list is fresh — that is why nobody had
// noticed. The Agent API calls THE SAME handlers and has no renderer state to
// refresh; it is not the App, it is a caller of main.
//
// The file watcher cannot cover the gap, and that is deliberate rather than an
// oversight: `markSelfWrite` makes the app's own writes invisible to the
// watcher so that every save does not race its own event. Which means the one
// signal that makes the renderer rescan is suppressed for exactly the writes
// that need it. Measured on the shipped build, `page:create` writes the file
// and the watcher's event arrives about 12 ms later, well inside the 1000 ms
// suppression window, and nothing is scheduled.
//
// So main now says it, once, in `notePagesChanged` — the same channel the
// watcher uses, carrying the page paths that came or went, so that the App's
// existing listener does exactly what it does for a change made in Finder:
// rescan, and reload or close the open page if it was one of them. Nothing new
// on the renderer side; the renderer was never the problem.
//
// WHAT THIS FILE HAD TO CHANGE TO BE ABLE TO FAIL. test/agent-harness.js had no
// window, so `send()` in electron/main.js saw `mainWindow === null` and dropped
// every main→renderer announcement on the floor, and its bridge answered every
// `on*` subscription with a function that registered nothing. A harness that
// silently discards the entire main→renderer direction cannot fail a test about
// the main→renderer direction, and did not. It now has both, behind
// `deliverMainEvents`, off by default so the twenty suites written against the
// old fixture are untouched.
//
// THE ORACLE IS THE RENDERED SWITCHER. Not `scan.pages`, not a React variable —
// the menu is opened the way a person opens it and the names in it are read out
// of the DOM. `page.list` agreeing with `project:scan` was never the question;
// both were right the whole time.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const H = require('./agent-harness.js');

const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

(async () => {
  const root = H.makeProject();
  const app = await H.start(root, { agentMode: 'full', deliverMainEvents: true });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(800);

  const doc = app.document();

  /**
   * The pages the switcher offers, read the way a person reads them.
   *
   * The menu renders only while it is open, so this opens it, takes the names,
   * and closes it again — a click on the button, which is the gesture.
   */
  const switcherPages = async () => {
    const btn = doc.querySelector('.page-switch-btn');
    if (!btn) return null;
    btn.click();
    await H.settle(120);
    const names = Array.from(doc.querySelectorAll('.page-menu-name')).map((el) => el.textContent);
    const routes = Array.from(doc.querySelectorAll('.page-menu-route')).map((el) => el.textContent);
    btn.click();
    await H.settle(60);
    return { names: names.slice().sort(), routes: routes.slice().sort() };
  };

  /** What the Agent API says exists. */
  const apiRoutes = async () => {
    const list = await run('page', 'list');
    return (list.pages || []).map((p) => p.route).sort();
  };

  // ── the starting point ────────────────────────────────────────────────────

  const start = await switcherPages();
  if (!check('the page switcher is rendered at all', !!start, 'no .page-switch-btn in the document')) {
    H.removeProject(root);
    process.exit(1);
  }
  check('and it lists the fixture’s pages', start.names.length >= 2, short(start));
  const startCount = start.names.length;
  check('and the Agent API agrees with it to begin with', (await apiRoutes()).length === startCount, `${short(await apiRoutes())} vs ${short(start.routes)}`);

  // ── page.create ───────────────────────────────────────────────────────────

  {
    const before = app.mainEvents().length;
    const made = await run('page', 'create', { name: 'contact' });
    check('page.create answers ok', made.ok === true, short(made));
    check('and says where the page went', made.path === 'src/pages/contact.astro', short(made));
    check('and the file is on disk', app.exists('src/pages/contact.astro'));
    await H.settle(600);

    // MAIN SAID SO.
    const announced = app.mainEvents().slice(before).filter((e) => e.channel === 'fs:changed');
    check('main announces the change', announced.length >= 1, short(app.mainEvents().slice(before).map((e) => e.channel)));
    check(
      'and names the page that appeared',
      announced.some((e) => (e.payload?.files || []).some((f) => f.endsWith('src/pages/contact.astro'))),
      short(announced.map((e) => e.payload))
    );

    // AND THE PERSON'S SWITCHER HEARD IT — with no reopen, no rescan by hand.
    const now = await switcherPages();
    check('the page switcher gains the page', now.names.length === startCount + 1, `${short(start.names)} -> ${short(now.names)}`);
    check('and it is the page that was made', now.names.includes('contact'), short(now.names));
    check('and its route is there too', now.routes.includes('/contact'), short(now.routes));
    check('and the Agent API and the switcher say the same thing', (await apiRoutes()).length === now.routes.length, `${short(await apiRoutes())} vs ${short(now.routes)}`);
  }

  // ── page.move ─────────────────────────────────────────────────────────────

  {
    const before = app.mainEvents().length;
    const moved = await run('page', 'move', { from: 'src/pages/contact.astro', to: 'src/pages/reach-us.astro' });
    check('page.move answers ok', moved.ok === true, short(moved));
    await H.settle(600);

    const announced = app.mainEvents().slice(before).filter((e) => e.channel === 'fs:changed');
    const named = announced.flatMap((e) => e.payload?.files || []);
    // BOTH ENDS. The renderer decides whether the OPEN page was affected by
    // looking for its path in this list, and for a move that is the path it had
    // before as much as the one it has now.
    check('a move announces the path it left', named.some((f) => f.endsWith('src/pages/contact.astro')), short(named));
    check('and the path it arrived at', named.some((f) => f.endsWith('src/pages/reach-us.astro')), short(named));

    const now = await switcherPages();
    check('the switcher loses the old name', !now.names.includes('contact'), short(now.names));
    check('and gains the new one', now.names.includes('reach-us'), short(now.names));
    check('and the count is unchanged', now.names.length === startCount + 1, short(now.names));
  }

  // ── page.delete ───────────────────────────────────────────────────────────

  {
    const before = app.mainEvents().length;
    const gone = await run('page', 'delete', { path: 'src/pages/reach-us.astro' });
    check('page.delete answers ok', gone.ok === true, short(gone));
    await H.settle(600);

    const named = app.mainEvents().slice(before).filter((e) => e.channel === 'fs:changed').flatMap((e) => e.payload?.files || []);
    check('a delete announces the page that went', named.some((f) => f.endsWith('src/pages/reach-us.astro')), short(named));

    const now = await switcherPages();
    check('the switcher is back to where it started', now.names.length === startCount, `${short(start.names)} -> ${short(now.names)}`);
    check('and the Agent API agrees', (await apiRoutes()).length === startCount, short(await apiRoutes()));
  }

  // ── folders ───────────────────────────────────────────────────────────────
  //
  // A folder is not a page, so the switcher does not draw one — but a folder
  // rename MOVES the pages inside it, and those are what the switcher draws and
  // what the open-page check needs to hear about.

  {
    const made = await run('page', 'folder_create', { dir: 'src/pages/docs' });
    check('folder_create answers ok', made.ok === true, short(made));
    await H.settle(400);

    const inside = await run('page', 'create', { name: 'docs/intro' });
    check('a page can be made inside it', inside.ok === true, short(inside));
    await H.settle(600);
    let now = await switcherPages();
    // A nested page's label is its path under src/pages with the extension
    // taken off — `docs/intro`, not `intro`. The switcher is a flat list, so
    // the folder is how one `index` is told from another.
    check('and the switcher shows it', now.names.includes('docs/intro'), short(now.names));

    const before = app.mainEvents().length;
    const renamed = await run('page', 'folder_rename', { from: 'src/pages/docs', to: 'src/pages/guides' });
    check('folder_rename answers ok', renamed.ok === true, short(renamed));
    await H.settle(600);

    const named = app.mainEvents().slice(before).filter((e) => e.channel === 'fs:changed').flatMap((e) => e.payload?.files || []);
    check('a folder rename announces the page that left', named.some((f) => f.endsWith('src/pages/docs/intro.astro')), short(named));
    check('and the page that arrived', named.some((f) => f.endsWith('src/pages/guides/intro.astro')), short(named));

    check('the page is on disk under the new folder', app.exists('src/pages/guides/intro.astro'));
    check('and gone from the old one', !app.exists('src/pages/docs/intro.astro'));
    const routes = await apiRoutes();
    check('the Agent API reports the new route', routes.includes('/guides/intro'), short(routes));
    now = await switcherPages();
    check('and the switcher reports it too', now.routes.includes('/guides/intro'), short(now.routes));
    check('and under the new folder name', now.names.includes('guides/intro'), short(now.names));
    check('and no longer the old one', !now.routes.includes('/docs/intro'), short(now.routes));
    check('and not under the old folder name', !now.names.includes('docs/intro'), short(now.names));

    const deleted = await run('page', 'folder_delete', { dir: 'src/pages/guides' });
    check('folder_delete answers ok', deleted.ok === true, short(deleted));
    await H.settle(600);
    const gone = app.mainEvents().filter((e) => e.channel === 'fs:changed').flatMap((e) => e.payload?.files || []);
    check('a folder delete announces the pages that went', gone.some((f) => f.endsWith('src/pages/guides/intro.astro')), short(gone.slice(-6)));
    now = await switcherPages();
    check('and the switcher is back to the starting set', now.names.length === startCount, `${short(start.names)} -> ${short(now.names)}`);
    check('and so is the Agent API', (await apiRoutes()).length === startCount, short(await apiRoutes()));
  }

  // ── the two views never disagree ──────────────────────────────────────────
  //
  // The summary assertion: after all of that, everything the API says exists is
  // something the person can switch to, and nothing the person can switch to is
  // missing from the API. That is the invariant; the individual checks above
  // are how it gets broken.

  {
    const routes = await apiRoutes();
    const now = await switcherPages();
    check('every route the API reports is in the switcher', routes.every((r) => now.routes.includes(r)), `${short(routes)} vs ${short(now.routes)}`);
    check('and every route in the switcher is reported by the API', now.routes.every((r) => routes.includes(r)), `${short(now.routes)} vs ${short(routes)}`);
  }

  H.removeProject(root);

  if (failures.length) {
    console.error(`\nproject-structure: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`project-structure: ${checked} passed  [what the API says exists, and what the person can switch to]`);
  process.exit(0);
})().catch((err) => {
  console.error('project-structure: threw\n', err);
  process.exit(1);
});
