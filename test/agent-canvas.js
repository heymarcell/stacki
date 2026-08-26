// The Agent API against a real Stacki, with a real page on the canvas.
//
//   npx electron test/agent-canvas.js
//
// agent-acceptance.js drives the whole stack with no browser: real main
// process, real parser, real files, real editor — and a canvas that is not
// painting. That covers the source half exactly, and it cannot cover the half
// this feature is named for:
//
//   a visual object → the exact Stacki object → a semantic edit → the rendered
//   result
//
// Computed styles come from an engine. Rendered classes come from a page that
// ran. A capture is a photograph. So this runs the shipped main process under
// Electron, opens a project with Astro genuinely installed in it, waits for the
// dev server and the canvas, and then talks to the Agent API the way an agent
// does: over HTTP, to the real endpoint, with the real bearer token, through
// the real permission gate.
//
// Nothing here names a file to find a target. Every target comes from a
// previous answer — which is the claim, and the reason the last check in this
// file reads the file back and counts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const { dialog } = require('electron');

// Nobody is watching an automated run, and a modal dialog would stop it dead
// waiting for a click that is never coming. Set before main.js is required.
process.env.STACKI_NO_DIALOGS = '1';

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// How this process talks, and how it ends.
//
// `process.exit()` does not end an Electron main process: it returns, execution
// carries on past it, and the exit code is not set. A test that printed its
// failures and then its own success line is how that was noticed here.
// `app.exit()` is the one that stops — and it does not wait for a piped stdout
// to flush, so everything is written synchronously. Both of these are the
// pattern test/thumbs.js already uses, for the same two reasons.
const say = (text) => fs.writeSync(1, `${text}\n`);
const shout = (text) => fs.writeSync(2, `${text}\n`);
// `app.exit()` skips before-quit, so the Astro dev server this run started
// outlives it — one orphaned server, holding its port and its memory, per run.
// main.js takes it down by hand for the same reason; so does this, in the
// report section below, while the MCP server it calls through is still up.
let stopPreview = async () => {};
const done = (code) => {
  app.exit(code);
};

/**
 * Poll until `fn` answers the same thing twice running, then answer with it.
 *
 * A live page is a moving target: an edit anywhere sends a patch, and while one
 * is in flight the canvas can report a half-rendered answer that is perfectly
 * true for an instant. Taking the first non-null reading of "how many copies of
 * this node are there" caught the page mid-patch and read one. Waiting for the
 * number to stop changing is the difference between a flaky test and a test.
 */
async function settled(what, fn, { timeout = 30000, every = 300 } = {}) {
  const stop = Date.now() + timeout;
  let last;
  for (;;) {
    const now = await fn();
    const key = JSON.stringify(now ?? null);
    if (now != null && key === last) return now;
    last = key;
    if (Date.now() > stop) throw new Error(`${what} never settled (last: ${String(last).slice(0, 120)})`);
    await wait(every);
  }
}

/** Poll until `fn` answers something truthy, or give up and say so. */
async function until(what, fn, { timeout = 60000, every = 250 } = {}) {
  const stop = Date.now() + timeout;
  for (;;) {
    const answer = await fn();
    if (answer) return answer;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await wait(every);
  }
}

// A window that closes must not end the run before anything has been checked.
app.on('window-all-closed', () => {});

// Everything below happens before the app is ready, and has to: main.js
// registers a custom scheme at require time, which Electron only allows before
// then, and it reads userData for its settings on the way past.
if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  console.log('agent-canvas: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

// What earlier runs left behind. Electron rewrites a small userData during
// shutdown, after teardown has removed it, so one reappears per run and they
// pile up quietly. Swept here rather than pretended about.
sweepStaleRuns(['stacki-canvas-user-']);

const root = makeCanvasProject({ log: (m) => console.log(`agent-canvas: ${m}`) });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-user-'));
app.setPath('userData', userData);

// Two things written before the app starts, because they are the two things a
// person would have done in a previous session:
//
//   which project to open — the same file "Reload window" uses.
//   what the agent may do — granted for THIS project, at the level being
//   tested. Nothing here grants full control; none of these flows needs it,
//   and a test that quietly ran at the highest level would not be testing the
//   level people will actually be on.
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(root)]: 'edit' } }, null, 2),
  'utf8'
);

// The project is opened the way a person opens one: File ▸ Open Project, which
// shows a folder picker. The picker is the one thing here that cannot answer
// for itself, so it is told what somebody would have chosen — and everything
// after it is the app's own path, unchanged.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

// The shipped main process, required the way Electron requires it: before
// ready, so its own whenReady handler is the one that opens the window, starts
// the MCP server and opens the review ledger.
const mcp = require('../electron/mcp');
require('../electron/main.js');

(async () => {
  await app.whenReady();

  const status = await until('the MCP server', () => {
    const s = mcp.status();
    return s.running ? s : null;
  });

  // Wait for the window, then take File ▸ Open Project on the fixture.
  const window_ = await until('the app window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to finish loading', () => (window_.webContents.isLoading() ? null : true), { timeout: 60000 });
  await wait(500);
  window_.webContents.send('menu:openProject');
  check('the real MCP endpoint is listening', !!status.url, short(status));
  check('and it has a token', typeof status.token === 'string' && status.token.length >= 32);

  let rpc = 1;
  const call = async (name, args) => {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
    const body = JSON.parse(line.replace(/^data:\s*/, ''));
    if (body.error) return { ok: false, code: 'rpc_error', message: JSON.stringify(body.error) };
    return body.result?.structuredContent ?? { ok: false, code: 'no_content' };
  };
  const capture = async (args = {}) => {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name: 'capture', arguments: args } }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
    const body = JSON.parse(line.replace(/^data:\s*/, ''));
    const image = (body.result?.content || []).find((c) => c.type === 'image') || null;
    return { meta: body.result?.structuredContent || {}, image };
  };

  stopPreview = () => call('project', { action: 'dev_stop' });

  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  // --- the app, actually running -------------------------------------------

  const ready = await until(
    'the preview to render the page',
    async () => {
      const ctx = await call('get_context', { styleDetail: 'none' });
      return ctx.project?.root && ctx.selection?.status === 'ready' ? ctx : null;
    },
    { timeout: 180000 }
  );
  check('the project opened and the canvas is rendering', ready.selection.status === 'ready', short(ready.selection?.status));
  check('and get_context hands back a ref for what is selected', typeof ready.selection.ref === 'string');

  const caps = await call('get_capabilities', {});
  check('the level the person granted is the one in force', caps.access.mode === 'edit', short(caps.access));
  check('and it is scoped to the project', caps.access.scope === 'project');

  // --- 1. A node inside `{show && ( … )}` ----------------------------------
  //
  // Before upstream 0.1.21 nothing inside a conditional had a source offset at
  // all, so this could name the file and nothing else. The exact range is the
  // check.

  const page = await call('target', { action: 'read', ref: ready.selection.ref });
  const top = page.ok ? page : await call('target', { action: 'read' });
  const hero = (top.target?.children || []).find((c) => c.tag === 'Hero');
  check('the page reads, with the component on it', !!hero, short(top.target?.children));
  // Kept for the sections that come after a navigation: a read with no ref
  // means "whatever is selected", and several things below move that.
  const pageRef = top.target.ref;
  const pageNow = () => call('target', { action: 'read', ref: pageRef });

  const inHero = await call('target', { action: 'enter', ref: hero.ref });
  check('the component opens', inHero.ok === true, short(inHero));
  const heroKids = inHero.target?.children || [];
  const conditional = heroKids.find((c) => c.kind === 'cond');
  check(
    'and its conditional is a node of its own',
    !!conditional,
    short(heroKids.map((c) => ({ kind: c.kind, tag: c.tag, label: c.label })))
  );
  if (!conditional) {
    shout(`agent-canvas: the component tree had no conditional in it — ${short(heroKids, 600)}`);
    return done(1);
  }

  const cond = await call('target', { action: 'read', ref: conditional.ref });
  check('a conditional has an exact source range', Number.isInteger(cond.target?.source?.startLine), short(cond.target?.source));
  check('and not merely a file', cond.target.source.startLine > 0 && cond.target.source.endLine >= cond.target.source.startLine, short(cond.target?.source));
  const heroSource = read('src/components/Hero.astro').split('\n');
  check(
    'the range is where the markup actually is',
    /hero_inner|h1|We're/.test(heroSource.slice(cond.target.source.startLine - 1, cond.target.source.endLine).join('\n')),
    heroSource.slice(cond.target.source.startLine - 1, cond.target.source.endLine).join(' / ').slice(0, 120)
  );

  // A conditional's children are its branches; the markup is inside one of
  // them. `{x && ( … )}` has a single `then`, which the navigator draws through
  // rather than as a row of its own.
  const branchOf = async (node) => {
    const kids = node.children || [];
    const branch = kids.find((c) => c.kind === 'branch');
    if (!branch) return node;
    const read_ = await call('target', { action: 'read', ref: branch.ref });
    check('the branch has a source range of its own', Number.isInteger(read_.target?.source?.startLine), short(read_.target?.source));
    return read_.target;
  };

  const thenBranch = await branchOf(cond.target);
  const insideCond = (thenBranch.children || []).find((c) => c.label === 'hero_inner' || c.tag === 'div');
  check('the conditional holds the markup', !!insideCond, short((thenBranch.children || []).map((c) => c.tag || c.kind)));
  const inner = await call('target', { action: 'read', ref: insideCond.ref });
  check('a node INSIDE the conditional has one too', Number.isInteger(inner.target?.source?.startLine), short(inner.target?.source));
  const h1 = (inner.target.children || []).find((c) => c.tag === 'h1');
  const heading = await call('target', { action: 'read', ref: h1.ref });
  check('and so does the heading two levels into it', Number.isInteger(heading.target?.source?.startLine), short(heading.target?.source));
  check(
    'which points at the heading',
    /<h1>/.test(heroSource[heading.target.source.startLine - 1] || ''),
    heroSource[heading.target.source.startLine - 1]
  );
  // The apostrophe that started all of this.
  check('and the apostrophe did not send the file to code view', heading.target.text.own === "We're here for you", short(heading.target?.text));

  // --- 2. A ternary branch --------------------------------------------------

  const ternary = (inHero.target?.children || []).filter((c) => c.kind === 'cond')[1];
  check('the ternary is a node as well', !!ternary, short((inHero.target?.children || []).map((c) => c.kind)));
  const tern = await call('target', { action: 'read', ref: ternary.ref });
  check('with a source range of its own', Number.isInteger(tern.target?.source?.startLine), short(tern.target?.source));
  const branches = (tern.target.children || []).filter((c) => c.kind === 'branch');
  check('and two branches', branches.length === 2, short((tern.target.children || []).map((b) => `${b.kind}:${b.label}`)));
  for (const [i, branch] of branches.entries()) {
    const side = await call('target', { action: 'read', ref: branch.ref });
    check(`ternary branch ${i} has an exact range`, Number.isInteger(side.target?.source?.startLine), short(side.target?.source));
    const markup = (side.target?.children || [])[0];
    if (markup) {
      const leaf = await call('target', { action: 'read', ref: markup.ref });
      check(`and the markup inside branch ${i} does too`, Number.isInteger(leaf.target?.source?.startLine), short(leaf.target?.source));
    }
  }

  // --- 3. A Fragment is not the thing inside it ----------------------------

  await call('target', { action: 'exit' });
  const backOnPage = await call('target', { action: 'read' });
  const panel = (backOnPage.target?.children || []).find((c) => c.tag === 'Panel');
  const panelRead = await call('target', { action: 'read', ref: panel.ref });
  const fragment = (panelRead.target.children || []).find((c) => c.tag === 'Fragment');
  check('the Fragment is in the tree', !!fragment, short(panelRead.target?.children));
  const frag = await call('target', { action: 'read', ref: fragment.ref });
  check('and reads as a Fragment', frag.target.tag === 'Fragment', short(frag.target?.tag));
  check(
    'not as the component root inside it',
    !(frag.target.classes.rendered || []).includes('inner_wrap'),
    short(frag.target?.classes)
  );
  check('and it carries no classes of its own', (frag.target.classes.authored || []).length === 0, short(frag.target?.classes?.authored));

  // The component inside it, selected, DOES report what it rendered with.
  const innerComp = (frag.target.children || []).find((c) => c.tag === 'Inner');
  if (innerComp) {
    await call('target', { action: 'select', ref: innerComp.ref });
    await wait(600);
    const innerRead = await call('target', { action: 'read', ref: innerComp.ref });
    check(
      'while the component in the slot is described as itself',
      innerRead.target.tag === 'Inner',
      short(innerRead.target?.tag)
    );
  }

  // --- 4. Styles, from a page that ran -------------------------------------

  const grid = (backOnPage.target?.children || []).find((c) => c.label === 'pricing-grid');
  await call('target', { action: 'select', ref: grid.ref });
  await wait(800);
  const styles = await call('style', { action: 'read', ref: grid.ref });
  check('style.read answers about a real element', styles.ok === true, short(styles));
  const rule = (styles.rules || []).find((r) => r.selector === '.pricing-grid');
  check('with the rule that matched', !!rule, short((styles.rules || []).map((r) => r.selector)));
  check('and where it was authored', rule.source.file === 'src/styles/site.css', short(rule.source));
  const gap = rule.declarations.find((d) => d.property === 'gap');
  check('the authored value is what the file says', gap.value === 'var(--gap)', short(gap));
  check('and the variable it reads is named', gap.variables[0] === '--gap', short(gap.variables));
  check('the engine resolved it', styles.computed && styles.computed.gap === '12px', short(styles.computed?.gap));
  check('and reported the layout with it', styles.computed?.display === 'grid', short(styles.computed?.display));
  check('the declaration says whether it wins', typeof gap.winning === 'boolean');

  const beforeShot = await capture({ target: 'selection', paddingPx: 0 });
  check('a capture of the selection comes back as an image', !!beforeShot.image, short(beforeShot.meta));
  check('with real pixels', (beforeShot.meta.pixelSize?.width || 0) > 0 && beforeShot.meta.bytes > 100, short(beforeShot.meta.pixelSize));
  const widthBefore = beforeShot.meta.pixelSize?.width || 0;

  // --- 5. The variable behind the property ---------------------------------

  const vars = await call('style', { action: 'variables' });
  const gapCell = (vars.files || [])
    .flatMap((f) => (f.groups || []).flatMap((g) => (g.blocks || []).flatMap((b) => b.rows || [])))
    .find((r) => r.name === '--gap')?.cells?.[0];
  check('the variable is found without searching for it', !!gapCell, short(vars.files?.length));
  check('and says which file and where in it', gapCell.file === 'src/styles/site.css' && Number.isInteger(gapCell.valueStart), short(gapCell));

  const setVar = await call('style', {
    action: 'set_variable',
    edit: { file: gapCell.file, valueStart: gapCell.valueStart, valueEnd: gapCell.valueEnd, value: '48px', expect: '12px' },
  });
  check('the variable can be changed', setVar.ok === true, short(setVar));
  check('and the stylesheet says so', /--gap: 48px/.test(read('src/styles/site.css')));

  // The page has to actually change. This is the check the whole file exists
  // for: a value edited three files away, seen on the canvas.
  const grew = await until(
    'the canvas to take the new gap',
    async () => {
      const now = await call('style', { action: 'read', ref: grid.ref });
      return now.computed?.gap === '48px' ? now : null;
    },
    { timeout: 30000 }
  );
  check('and the rendered page picks it up', grew.computed.gap === '48px', short(grew.computed?.gap));
  const afterShot = await capture({ target: 'selection', paddingPx: 0 });
  check('and a capture after it is a different picture', (afterShot.meta.pixelSize?.width || 0) !== widthBefore || afterShot.meta.bytes !== beforeShot.meta.bytes, short({ before: widthBefore, after: afterShot.meta.pixelSize?.width }));

  // --- 6. Bound content ----------------------------------------------------

  const heroNow = await call('target', { action: 'read', ref: hero.ref });
  const bound = (heroNow.target.bindings || []).find((b) => b.where === 'prop:heading');
  check('the heading prop is reported as bound', bound?.source?.kind === 'import', short(bound?.source));
  const resolved = await call('content', { action: 'resolve_import', fromFile: 'src/pages/index.astro', spec: bound.source.spec });
  check('and resolves to the data file', resolved.path === 'src/data/site.json', short(resolved));

  const data = await call('content', { action: 'cms_read', path: resolved.path });
  check('which reads as data', data.data?.tagline === 'Words that live in a file', short(data.data));
  const wroteData = await call('content', {
    action: 'cms_write',
    path: resolved.path,
    data: { ...data.data, tagline: 'Changed where the words live' },
    ref: data.ref,
  });
  check('and can be changed at the source', wroteData.ok === true, short(wroteData));
  check('with the expression left alone', /\{heading\}/.test(read('src/components/Hero.astro')));

  const rendered = await until(
    'the page to show the new words',
    async () => {
      const ctx = await call('get_context', { styleDetail: 'none' });
      return ctx.selection?.status === 'ready' ? ctx : null;
    },
    { timeout: 30000 }
  );
  check('and the page is still rendering after it', rendered.selection.status === 'ready');

  // --- 7. A repeated occurrence --------------------------------------------

  const gridRead = await call('target', { action: 'read', ref: grid.ref });
  check('the grid reads', gridRead.ok === true, short(gridRead));
  const loop = await call('target', { action: 'read', ref: gridRead.target.children[0].ref });
  const cardRef = loop.target.children[0].ref;
  const card = await call('target', { action: 'read', ref: cardRef });
  check('a node in the loop says it is a shared template', card.target.occurrence.scope === 'shared_template', short(card.target?.occurrence?.scope));
  check('and says so BEFORE anything is edited', /changes every copy/.test(card.target.occurrence.note), short(card.target?.occurrence?.note));
  check('and points at the data item behind one copy', card.target.occurrence.perOccurrence?.kind === 'loop_item', short(card.target?.occurrence?.perOccurrence?.kind));

  // How MANY copies is a question only the rendered page can answer, and it
  // answers about what is selected — so this is what a person doing it would
  // do: select the card, then ask.
  await call('target', { action: 'select', ref: cardRef, occurrence: 2 });
  const counted = await settled('the copy count', async () => {
    const now = await call('target', { action: 'read', ref: cardRef });
    const occ = now.target?.occurrence;
    return occ?.count ? { count: occ.count, index: occ.index } : null;
  });
  check('the canvas counted the copies', counted.count === 3, short(counted));
  check('and says which one is in hand', counted.index === 2, short(counted));
  const cardShot = await capture({ target: 'selection', paddingPx: 8 });
  check('and a capture of the third card is a picture of one card', !!cardShot.image && cardShot.meta.occurrence === 2, short(cardShot.meta));

  const plansFile = (await call('content', { action: 'cms_list' })).files.find((f) => /#plans$/.test(f.path));
  const plans = await call('content', { action: 'cms_read', path: plansFile.path });
  const oneChanged = plans.data.map((e, i) => (i === 2 ? { ...e, title: 'Enterprise' } : e));
  const wrotePlans = await call('content', { action: 'cms_write', path: plansFile.path, data: oneChanged, ref: plans.ref });
  check('one item can be changed on its own', wrotePlans.ok === true, short(wrotePlans));
  const source = read('src/pages/index.astro');
  check('the other two are untouched', /Starter/.test(source) && /Team/.test(source) && /Enterprise/.test(source) && !/Company/.test(source));
  check('and the template is untouched', /<Card title=\{plan.title\} body=\{plan.body\} \/>/.test(source));

  // --- 8. A semantic edit, undone, redone, each seen on the canvas ----------

  // Down to the heading again, through the conditional and its branch. Every
  // step is a ref out of the previous answer.
  await call('target', { action: 'enter', ref: hero.ref });
  const heroInside = await call('target', { action: 'read' });
  const condNow = (heroInside.target.children || []).find((c) => c.kind === 'cond');
  const readNow = await call('target', { action: 'read', ref: condNow.ref });
  const branchNow = (readNow.target.children || []).find((c) => c.kind === 'branch');
  const holder = branchNow ? await call('target', { action: 'read', ref: branchNow.ref }) : readNow;
  const divNow = (holder.target.children || []).find((c) => c.tag === 'div');
  check('the heading is reachable again through the conditional', !!divNow, short((holder.target.children || []).map((c) => c.tag || c.kind)));
  const divRead = await call('target', { action: 'read', ref: divNow.ref });
  const h1Ref = (divRead.target.children || []).find((c) => c.tag === 'h1');
  const h1Now = await call('target', { action: 'read', ref: h1Ref.ref });

  const edited = await call('target', { action: 'set_text', ref: h1Now.target.ref, text: 'Edited through Stacki' });
  check('the heading can be edited through the ref', edited.ok === true, short(edited));
  check('and the file says so', /Edited through Stacki/.test(read('src/components/Hero.astro')));

  const shown = await until(
    'the canvas to show the edit',
    async () => {
      const now = await call('target', { action: 'read', ref: edited.ref });
      return now.ok && now.target.text.own === 'Edited through Stacki' ? now : null;
    },
    { timeout: 30000 }
  );
  check('and the editor is holding it', shown.target.text.own === 'Edited through Stacki');
  const shotAfterEdit = await capture({ target: 'viewport' });
  check('a viewport capture after the edit works', !!shotAfterEdit.image, short(shotAfterEdit.meta));

  const undone = await call('project', { action: 'undo' });
  check('undo goes through', undone.ok === true, short(undone));
  await until('the file to come back', async () => (/We're here for you/.test(read('src/components/Hero.astro')) ? true : null), { timeout: 20000 });
  check('and the original text is back on disk', /We're here for you/.test(read('src/components/Hero.astro')));

  const redone = await call('project', { action: 'redo' });
  check('redo goes through', redone.ok === true, short(redone));
  await until('the file to change again', async () => (/Edited through Stacki/.test(read('src/components/Hero.astro')) ? true : null), { timeout: 20000 });
  check('and the edit is back', /Edited through Stacki/.test(read('src/components/Hero.astro')));
  await call('project', { action: 'undo' });
  await wait(600);
  await call('target', { action: 'exit' });

  // --- 9. A raw write to the open document, and its undo -------------------

  const openDoc = await call('source', { action: 'read', path: 'src/pages/index.astro' });
  check('the open document reads as source', openDoc.ok === true, short(openDoc.code));
  const beforeRaw = read('src/pages/index.astro');
  const rawWrite = await call('source', {
    action: 'write',
    path: 'src/pages/index.astro',
    text: openDoc.text.replace('A panel', 'A renamed panel'),
    ref: openDoc.ref,
  });
  check('a raw write to it goes through the editor', rawWrite.ok === true && rawWrite.through === 'editor', short(rawWrite));
  check('and says Stacki can take it back', rawWrite.undoable === true);
  check('and the file has it', /A renamed panel/.test(read('src/pages/index.astro')));
  await call('project', { action: 'undo' });
  await until('the raw write to come back', async () => (read('src/pages/index.astro') === beforeRaw ? true : null), { timeout: 20000 });
  check('and one undo restores it', read('src/pages/index.astro') === beforeRaw);

  // --- 10. A stale ref whose node is visually unchanged --------------------

  const targetPage = await pageNow();
  check('the page still reads after all of that', targetPage.ok === true, short(targetPage));
  const gridRef = (targetPage.target.children || []).find((c) => c.label === 'pricing-grid').ref;
  const observed = await call('target', { action: 'read', ref: gridRef });
  const person = await call('target', { action: 'add_class', ref: observed.target.ref, className: 'is-tight' });
  check('somebody changes a class on it', person.ok === true, short(person));
  await wait(400);
  const late = await call('target', { action: 'set_prop', ref: observed.target.ref, name: 'data-late', value: '1' });
  check('and the ref from before that is refused', late.ok === false && late.code === 'stale_target', short(late));
  check('with nothing written', !/data-late/.test(read('src/pages/index.astro')));
  const stillThere = await call('target', { action: 'read', ref: observed.target.ref });
  check('though the node itself still resolves', stillThere.ok === true && stillThere.target.label === 'pricing-grid', short(stillThere.target?.label));

  // --- 11. Nothing above named a file to find a target ---------------------

  {
    const body = fs.readFileSync(__filename, 'utf8');
    const targetCalls = [...body.matchAll(/call\('(?:target|style)', \{([^}]*)\}/g)].map((m) => m[1]);
    const named = targetCalls.filter((args) => /path:\s*'src\//.test(args));
    check('no target or style call located something by path', named.length === 0, named.join(' | '));
  }

  // --- the report ----------------------------------------------------------

  // The preview goes first, and it has to: the two lines under this one take
  // the windows and the MCP server away, and dev_stop is a call THROUGH that
  // server. Stopping it afterwards fails with "fetch failed" and leaves an
  // Astro process running for as long as the machine is up — one per run.
  // Cleanup is part of correctness. A run that passed every assertion and left
  // an Astro dev server behind is a run that will be repeated until the machine
  // has forty of them holding several gigabytes — which is what happened, and
  // which presents as the machine being slow rather than as anything to do with
  // tests. So every step below is attempted even after an earlier one fails,
  // and any failure makes this a failing run however well the assertions went.
  const cleanupProblems = [];
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      cleanupProblems.push(`${what}: ${String(err?.message || err)}`);
    }
  };

  const where = await call('project', { action: 'dev_status' }).catch(() => null);
  const previewUrl = where?.url || where?.preview?.url || null;

  await attempt('stopping the preview', async () => {
    const stopped = await stopPreview();
    if (!stopped || stopped.ok === false) throw new Error(JSON.stringify(stopped ?? null).slice(0, 140));
  });

  // `ok` means "asked", not "stopped": Astro 7 daemonizes its dev server, so
  // stopDevServer hands the job to `astro dev stop` and returns. Exiting on
  // that ok deletes the project directory out from under the command and
  // leaves the server running for as long as the machine is up.
  if (previewUrl) {
    await attempt('waiting for the preview to stop answering', async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        try {
          await fetch(previewUrl, { signal: AbortSignal.timeout(1000) });
        } catch {
          return;
        }
        if (Date.now() > deadline) throw new Error(`${previewUrl} would not stop`);
        await wait(400);
      }
    });
  }

  await attempt('closing the windows', () => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await attempt('stopping the MCP server', () => mcp.stopMcp());
  await attempt(`removing the fixture ${root}`, () => {
    removeCanvasProject(root);
    if (fs.existsSync(root)) throw new Error('still there');
  });
  await attempt(`removing the app data ${userData}`, () => {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (fs.existsSync(userData)) throw new Error('still there');
  });

  if (failures.length) {
    shout(`\nagent-canvas: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
  }
  if (cleanupProblems.length) {
    shout(`\nagent-canvas: ${cleanupProblems.length} cleanup failure(s) — this is a failing run\n`);
    for (const problem of cleanupProblems) shout(`  ${problem}`);
  }
  if (!failures.length && !cleanupProblems.length) {
    say(`agent-canvas: ${checked} passed  [a real page, a real edit, a real picture]`);
  }
  return done(failures.length || cleanupProblems.length ? 1 : 0);
})().catch((err) => {
  shout(`agent-canvas: ${err && (err.stack || err)}`);
  done(1);
});
