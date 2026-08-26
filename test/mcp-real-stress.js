// The Agent API under load, against a real Stacki, over real HTTP.
//
//   npx electron test/mcp-real-stress.js            # every phase
//   PHASES=1,2 npx electron test/mcp-real-stress.js # a subset
//
// test/mcp.js proves the protocol against a server built for the test.
// test/agent-canvas.js proves one good path against a real app.
// This proves the app survives being used badly.
//
// It runs the shipped main process under Electron, opens projects that were
// genuinely `npm install`ed, and then talks to the endpoint the app is
// actually listening on — no in-process shortcuts for anything the campaign is
// judging. Requests are sent wrong on purpose: no token, the wrong token, a
// truncated body, an unknown tool, an argument one past its limit, fifty at
// once. What is being checked is never "did it work" alone but "did it fail
// the way it says it fails, and is anything different afterwards".
//
// Setup is allowed to use the app's own doors — the folder picker, the
// permission control in the MCP window — because those are the things a person
// does, and there is no person here. Everything the campaign actually judges
// goes over the wire.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

const { makeStressProject, removeStressProject } = require('./stress-fixture.js');
const { createMcpClient, rawSocketRequest } = require('./mcp-real-client.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');

// --- reporting ---------------------------------------------------------------

const failures = [];
let checked = 0;
let phaseNow = 'setup';
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  [${phaseNow}] ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// `process.exit()` does not end an Electron main process, and app.exit() does
// not wait for a piped stdout — both learned the hard way in agent-canvas.js.
const say = (text) => fs.writeSync(1, `${text}\n`);
const shout = (text) => fs.writeSync(2, `${text}\n`);

/**
 * Stop, then leave.
 *
 * `app.exit()` skips before-quit — main.js says so itself, and takes the Astro
 * dev server down by hand for that reason. A test that exits without doing the
 * same orphans a dev server per run: 42 of them, holding 4.2GB, is what that
 * looked like after an afternoon. So the dev server is stopped through the
 * app's own door before anything else, and the temp projects go with it.
 */
async function teardown(code) {
  try {
    if (client) {
      const stopped = await client.call('project', { action: 'dev_stop' }, { deadline: 8000 });
      say(`stress: teardown dev_stop -> ${JSON.stringify(stopped.structured ?? stopped.rpcError ?? null).slice(0, 200)}`);
    }
  } catch (err) {
    say(`stress: teardown dev_stop threw -> ${String(err?.message || err).slice(0, 160)}`);
  }
  // The projects and the app-data directory this run made. Reported rather
  // than swallowed: a removal that quietly fails leaves a gigabyte of
  // node_modules behind every run, which is how a machine ends up with 5GB of
  // temp and no idea where it came from.
  for (const dir of [FIXTURE, OTHER, userData]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      shout(`stress: could not remove ${dir}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  say(`stress: teardown cleaned up, exiting ${code}`);
  app.exit(code);
}
const done = (code) => {
  void teardown(code);
};

async function until(what, fn, { timeout = 60000, every = 250 } = {}) {
  const stop = Date.now() + timeout;
  for (;;) {
    const answer = await fn();
    if (answer) return answer;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await wait(every);
  }
}

/** Poll until the answer stops changing — a live canvas is a moving target. */
async function settled(what, fn, { timeout = 30000, every = 250 } = {}) {
  const stop = Date.now() + timeout;
  let last;
  for (;;) {
    const now = await fn();
    const key = JSON.stringify(now ?? null);
    if (now != null && key === last) return now;
    last = key;
    if (Date.now() > stop) throw new Error(`${what} never settled (last: ${String(last).slice(0, 160)})`);
    await wait(every);
  }
}

// --- boot --------------------------------------------------------------------

app.on('window-all-closed', () => {});

const log = (m) => say(`stress: ${m}`);
log('building the adversarial fixture (installs astro once)');
const FIXTURE = makeStressProject({ log, rows: Number(process.env.STRESS_ROWS || 600) });
// A second real project, so "a ref from A must not touch B" has a B, and so
// project switching has somewhere to switch to.
const OTHER = makeStressProject({ log, rows: 12 });
log(`fixture ${FIXTURE}`);
log(`other   ${OTHER}`);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-stress-user-'));
app.setPath('userData', userData);

// What a person would have granted in a previous session. The fixture starts
// at the level most of the campaign runs at; the other project starts at the
// default so Phase 2 can prove a grant does not follow Stacki between
// projects.
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(FIXTURE)]: 'edit' } }, null, 2),
  'utf8'
);

let pickedFolder = FIXTURE;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickedFolder] });

const mcp = require('../electron/mcp');
require('../electron/main.js');

// --- the doors a person uses -------------------------------------------------

let window_ = null;

/** Whatever the renderer would do if somebody chose this folder in File ▸ Open Project. */
async function openProject(root, { timeout = 240000 } = {}) {
  pickedFolder = root;
  window_.webContents.send('menu:openProject');
  return until(
    `the project at ${path.basename(root)} to open`,
    async () => {
      const ctx = await client.s('get_context', { styleDetail: 'none' });
      return ctx?.project?.root === root ? ctx : null;
    },
    { timeout }
  );
}

/** Wait for the canvas to actually be rendering, not merely for a project to be set. */
const canvasReady = ({ timeout = 240000 } = {}) =>
  until(
    'the canvas to render',
    async () => {
      const ctx = await client.s('get_context', { styleDetail: 'none' });
      return ctx?.selection?.status === 'ready' ? ctx : null;
    },
    { timeout }
  );

/**
 * Move the permission control, the way the person at the keyboard does.
 *
 * Through the renderer's own bridge rather than by writing settings.json:
 * the store keeps the level in memory, and a test that edited the file behind
 * it would be testing a path the app does not have.
 */
async function setMode(mode) {
  const result = await window_.webContents.executeJavaScript(
    `window.avb.setAgentMode(${JSON.stringify(mode)}).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ error: String(e) }))`
  );
  return result;
}

const readMode = () =>
  window_.webContents.executeJavaScript(
    'window.avb.agentAccess().then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ error: String(e) }))'
  );

const diskRead = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

// Enough arguments to get each read action past its schema and in front of the
// permission gate. Several actions need a shape no generic guess produces —
// `content.rename_plan` wants a collection and two names — and a call that
// dies in validation never reaches the gate, so without these the gate would
// look untested where it is merely unreached.
const READ_ARGS = {
  'source.read': { path: 'src/pages/index.astro' },
  'source.read_symbol': { fromFile: 'src/pages/index.astro', spec: '../components/Card.astro', name: 'default' },
  'source.resolve_path': { fromFile: 'src/pages/index.astro', spec: '../components/Card.astro' },
  'style.read_source': { path: 'src/styles/global.css' },
  'page.read': { path: 'src/pages/index.astro' },
  'page.component_usage': { name: 'Card' },
  'page.import_path': { fromFile: 'src/pages/index.astro', targetFile: 'src/components/Card.astro' },
  'page.rebase_import': { fromPage: 'src/pages/index.astro', toPage: 'src/pages/loops.astro', spec: '../components/Card.astro' },
  'page.dynamic_paths': { path: 'src/pages/blog/[slug].astro' },
  'content.cms_read': { path: 'src/content/posts/first.md' },
  'content.cms_usage': { path: 'src/content/posts/first.md' },
  'content.cms_meta': { path: 'src/content/posts/first.md' },
  'content.entries': { collection: 'posts' },
  'content.validate': { collection: 'posts', data: {} },
  'content.targets': { collection: 'posts' },
  'content.rename_plan': { collection: 'posts', from: 'first', to: 'third' },
  'content.sample_entry': { collection: 'posts' },
  'content.resolve_import': { fromFile: 'src/pages/index.astro', spec: '../data/site.json' },
  'asset.read_text': { path: 'src/assets/nested/deeper/note.txt' },
  'asset.dimensions': { path: 'public/pixel.png' },
  'git.file_at': { ref: 'HEAD', path: 'src/pages/index.astro' },
  'git.commit_files': { ref: 'HEAD' },
};

let client = null;
let status = null;

// --- phases ------------------------------------------------------------------

const PHASES = new Map();
const phase = (id, title, fn) => PHASES.set(String(id), { id: String(id), title, fn });

// ---------------------------------------------------------------------------
// 1 — the server itself
// ---------------------------------------------------------------------------

phase(1, 'connection and protocol torture', async () => {
  // Correct use first, so the wrong use below has a baseline.
  const fresh = createMcpClient({ url: status.url, token: status.token });
  const init = await fresh.initialize();
  check('initialize is answered', init.ok === true, short(init.error || init.status));
  check('and negotiates a protocol version', typeof init.result?.protocolVersion === 'string', short(init.result));
  check('and names the server', !!init.result?.serverInfo?.name, short(init.result?.serverInfo));

  const tools = await fresh.listTools();
  check('tools/list answers', tools.ok === true, short(tools.error));
  check('and the Agent API surface is on it', ['get_context', 'capture', 'get_comments', 'comment', 'get_capabilities', 'target', 'style', 'source', 'page', 'content', 'asset', 'project', 'git'].every((t) => tools.names.includes(t)), short(tools.names));

  // Initialising twice on one client, and a second client at the same time.
  const again = await fresh.initialize();
  check('a second initialize on the same client is fine', again.ok === true, short(again.error));
  const parallelClient = createMcpClient({ url: status.url, token: status.token });
  const both = await Promise.all([parallelClient.initialize(), fresh.listTools()]);
  check('a second client can initialize while the first is working', both[0].ok === true && both[1].ok === true, short(both.map((b) => b.ok)));

  // --- wrong requests ------------------------------------------------------
  //
  // Every one of these must come back bounded, and none may change anything.
  const before = await client.s('get_context', { styleDetail: 'none' });

  const noToken = createMcpClient({ url: status.url, token: null });
  const anon = await noToken.raw({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  check('no token is refused', anon.status === 401, `status ${anon.status}`);
  check('and the refusal does not carry a stack trace', !/\n\s+at\s/.test(anon.text), anon.text.slice(0, 160));

  const badToken = createMcpClient({ url: status.url, token: 'not-the-token-'.padEnd(40, 'x') });
  const wrong = await badToken.raw({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  check('the wrong token is refused', wrong.status === 401, `status ${wrong.status}`);

  const malformedAuth = await client.raw({
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    extraHeaders: { authorization: 'Basic bm90OmEtYmVhcmVy' },
  });
  check('a non-bearer Authorization is refused', malformedAuth.status === 401, `status ${malformedAuth.status}`);

  // Host and Origin go over a hand-written socket, not fetch.
  //
  // undici silently replaces a caller's `Host` with the authority it dialled,
  // so a fetch-based check here sends a perfectly correct Host, gets 200, and
  // reports the DNS-rebinding guard as broken. That happened. The socket is
  // the only way to put a chosen Host on the wire.
  const endpoint = new URL(status.url);
  const port = Number(endpoint.port);
  const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const socketCall = (headers, opts = {}) =>
    rawSocketRequest({
      port,
      target: endpoint.pathname,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${status.token}`,
        ...headers,
      },
      body: rpcBody,
      ...opts,
    });

  const goodHost = await socketCall({});
  check('a correct Host over a raw socket is accepted', goodHost.status === 200, `status ${goodHost.status}`);

  const badHost = await socketCall({ host: 'evil.example.com' });
  check('a foreign Host is refused', badHost.status >= 400 && badHost.status < 500, `status ${badHost.status} — ${badHost.body.slice(0, 120)}`);

  const rebind = await socketCall({ host: `evil.example.com:${port}` });
  check('a foreign Host carrying the right port is still refused', rebind.status >= 400 && rebind.status < 500, `status ${rebind.status}`);

  const badOrigin = await socketCall({ origin: 'https://evil.example.com' });
  check('a foreign Origin is refused', badOrigin.status >= 400 && badOrigin.status < 500, `status ${badOrigin.status} — ${badOrigin.body.slice(0, 120)}`);

  // A doubled Host cannot smuggle anything past this server, and the reason is
  // worth stating: Node's parser collapses duplicates to the FIRST value, and
  // that same first value is what `req.headers.host` — and therefore the
  // validator, and therefore the app — sees. Validated and acted-on are the
  // same string by construction. So the meaningful direction is a foreign
  // value arriving first, which must still be refused.
  const doubledLegitFirst = await socketCall({ host: [`127.0.0.1:${port}`, 'evil.example.com'] });
  check('a doubled Host led by the real one is accepted, and acts on the real one', doubledLegitFirst.status === 200, `status ${doubledLegitFirst.status}`);
  const doubledEvilFirst = await socketCall({ host: ['evil.example.com', `127.0.0.1:${port}`] });
  check('a doubled Host led by a foreign one is refused', doubledEvilFirst.status >= 400 && doubledEvilFirst.status < 500, `status ${doubledEvilFirst.status}`);

  const options = await client.raw({ method: 'OPTIONS' });
  check('OPTIONS is answered, not crashed on', options.status > 0 && options.status < 600, `status ${options.status}`);

  const badLine = await rawSocketRequest({ port, requestLine: 'NOTAMETHOD /mcp HTTP/1.1', body: '', headers: {} }).catch((e) => ({ status: -1, body: String(e.message) }));
  check('a nonsense request line does not take the server down', badLine.status !== 0, `status ${badLine.status}`);
  const stillUp = await client.s('get_capabilities', {});
  check('and the endpoint still answers afterwards', stillUp?.ok === true, short(stillUp));

  const bad = [
    ['malformed JSON', '{ this is not json'],
    ['a truncated body', '{"jsonrpc":"2.0","id":1,"method":"tools/'],
    ['an empty body', ''],
    ['a JSON array of nothing', '[]'],
    ['a bare string', '"hello"'],
  ];
  for (const [what, body] of bad) {
    const res = await client.raw({ rawBody: body });
    check(`${what} is answered without crashing`, res.status > 0 && res.status < 600, `status ${res.status}`);
    check(`${what} leaks no local path`, !res.text.includes(FIXTURE), res.text.slice(0, 200));
  }

  const unknownMethod = await client.rpcCall('does/not/exist', {});
  check('an unknown MCP method is a clean error', !!unknownMethod.message?.error, short(unknownMethod.message));

  const unknownTool = await client.call('no_such_tool', {});
  check('an unknown tool is a clean error', !!unknownTool.rpcError || unknownTool.isError === true, short(unknownTool.raw));

  const badAction = await client.call('target', { action: 'not_an_action' });
  check('an invalid action is refused', badAction.isError === true || !!badAction.rpcError, short(badAction.structured || badAction.rpcError));

  const missingArgs = await client.call('style', { action: 'set_property' });
  check('missing required args are refused', missingArgs.isError === true || !!missingArgs.rpcError, short(missingArgs.structured || missingArgs.rpcError));

  const extraArgs = await client.call('get_context', { styleDetail: 'none', notADeclaredArgument: 'x' });
  check('an undeclared argument does not crash the call', extraArgs.status === 200, short(extraArgs.rpcError));

  const overLimit = await client.call('target', { action: 'set_text', text: 'x'.repeat(20001) });
  check('a value past its schema limit is refused', overLimit.isError === true || !!overLimit.rpcError, short(overLimit.structured || overLimit.rpcError));

  const huge = await client.call('target', { action: 'add_class', className: 'y'.repeat(200000) });
  check('a huge string is refused rather than swallowed', huge.isError === true || !!huge.rpcError, short(huge.structured || huge.rpcError));

  const nulls = await client.call('target', { action: null });
  check('a null where a string belongs is refused', nulls.isError === true || !!nulls.rpcError, short(nulls.structured || nulls.rpcError));

  const after = await client.s('get_context', { styleDetail: 'none' });
  check('none of that changed the open document', after?.revision === before?.revision, `${before?.revision} → ${after?.revision}`);
  check('and the project is still open', after?.project?.root === FIXTURE, short(after?.project));

  // --- parallel reads ------------------------------------------------------
  //
  // The correlation check is the point: every answer has to be the answer to
  // the question that was asked, which means asking questions with different
  // answers and checking each one individually.
  const storm = await client.concurrently(
    Array.from({ length: 40 }, (_, i) => ({
      tool: 'get_context',
      args: { styleDetail: 'none' },
      label: `ctx-${i}`,
    }))
  );
  check('40 parallel reads all answer', storm.every((r) => r.ok && r.res.structured), short(storm.filter((r) => !r.ok).slice(0, 3)));
  check('and none of them errored', storm.every((r) => r.ok && !r.res.rpcError), short(storm.find((r) => r.res?.rpcError)));

  const mixed = await client.concurrently([
    { tool: 'get_context', args: { styleDetail: 'none' }, label: 'ctx' },
    { tool: 'get_capabilities', args: {}, label: 'caps' },
    { tool: 'get_comments', args: {}, label: 'comments' },
    { tool: 'project', args: { action: 'info' }, label: 'project' },
    { tool: 'target', args: { action: 'read' }, label: 'target' },
    { tool: 'style', args: { action: 'read' }, label: 'style' },
    { tool: 'page', args: { action: 'list' }, label: 'pages' },
    { tool: 'git', args: { action: 'info' }, label: 'git' },
  ]);
  check('a mixed parallel batch all answers', mixed.every((r) => r.ok), short(mixed.filter((r) => !r.ok)));
  // Each tool's answer has to be recognisably its own — a mix-up would show as
  // one tool's shape arriving under another's name.
  const byLabel = Object.fromEntries(mixed.map((r) => [r.label, r.res?.structured]));
  check('get_context answered get_context', !!byLabel.ctx && 'selection' in byLabel.ctx, short(byLabel.ctx));
  check('get_capabilities answered get_capabilities', !!byLabel.caps && 'domains' in byLabel.caps, short(Object.keys(byLabel.caps || {})));
  check('get_comments answered get_comments', !!byLabel.comments && 'reviews' in byLabel.comments, short(Object.keys(byLabel.comments || {})));
  check('page answered page', !!byLabel.pages && ('pages' in byLabel.pages || 'ok' in byLabel.pages), short(Object.keys(byLabel.pages || {})));

  const repeated = await client.concurrently(
    Array.from({ length: 30 }, (_, i) => (i % 2 ? { tool: 'get_capabilities', args: {}, label: `caps-${i}` } : { tool: 'get_context', args: { styleDetail: 'none' }, label: `ctx-${i}` }))
  );
  const misrouted = repeated.filter((r) => {
    const s = r.res?.structured;
    if (!s) return true;
    return r.label.startsWith('caps') ? !('domains' in s) : !('selection' in s);
  });
  check('interleaved different tools never receive each other’s answers', misrouted.length === 0, short(misrouted.slice(0, 3)));
});

// ---------------------------------------------------------------------------
// 2 — permission, under load and while it moves
// ---------------------------------------------------------------------------

phase(2, 'permissions', async () => {
  const caps = await client.s('get_capabilities', {});
  const domainsOf = (c) => c.domains.flatMap((d) => d.actions.map((a) => ({ op: `${d.domain}.${a.action}`, risk: a.risk, allowed: a.allowed })));

  // --- visual only ---------------------------------------------------------
  await setMode('visual');
  const visual = await client.s('get_capabilities', {});
  check('the level moves to visual', visual.access.mode === 'visual', short(visual.access));
  check('and nothing in any domain is allowed at visual', domainsOf(visual).every((a) => a.allowed === false), short(domainsOf(visual).filter((a) => a.allowed).slice(0, 5)));

  check('get_context still works at visual', !!(await client.s('get_context', { styleDetail: 'none' }))?.selection, 'no selection');
  check('get_comments still works at visual', (await client.s('get_comments', {}))?.ok === true);

  // Every read action in every domain, actually called — the registry saying
  // `allowed: false` and the dispatcher agreeing are two different claims.
  // Every read action in every domain, actually called.
  //
  // Two forms per action, because many of them require an argument and a call
  // that fails schema validation never reaches the gate at all. That is not a
  // bypass — nothing is read either way — but it is also not proof, so the
  // second form supplies a plausible path. What must hold is both halves: no
  // form may succeed, and at least one form must be stopped by the gate rather
  // than by the schema, which is what shows the gate is the thing saying no.
  const readOps = domainsOf(visual).filter((a) => a.risk === 'read');
  const succeeded = [];
  const ungated = [];
  for (const { op } of readOps) {
    const [domain, action] = op.split('.');
    const forms = [{ action }, ...(READ_ARGS[op] ? [{ action, ...READ_ARGS[op] }] : [])];
    let gated = false;
    for (const args of forms) {
      const res = await client.call(domain, args);
      const s = res.structured;
      if (s?.ok === true) succeeded.push({ op, args: Object.keys(args) });
      if (s?.code === 'permission_denied') gated = true;
    }
    if (!gated) ungated.push(op);
  }
  check(`no read action returns data at visual (${readOps.length} checked)`, succeeded.length === 0, short(succeeded.slice(0, 6)));
  check('and every read action is stopped by the permission gate itself', ungated.length === 0, short(ungated.slice(0, 8)));

  // --- inspect -------------------------------------------------------------
  await setMode('inspect');
  const inspect = await client.s('get_capabilities', {});
  check('the level moves to inspect', inspect.access.mode === 'inspect', short(inspect.access));
  check('reads are allowed at inspect', domainsOf(inspect).filter((a) => a.risk === 'read').every((a) => a.allowed), short(domainsOf(inspect).filter((a) => a.risk === 'read' && !a.allowed).slice(0, 4)));
  check('and writes are not', domainsOf(inspect).filter((a) => a.risk !== 'read').every((a) => !a.allowed), short(domainsOf(inspect).filter((a) => a.risk !== 'read' && a.allowed).slice(0, 4)));

  const readAtInspect = await client.call('target', { action: 'read' });
  check('target.read works at inspect', readAtInspect.structured?.ok === true, short(readAtInspect.structured));
  const writeAtInspect = await client.call('target', { action: 'add_class', className: 'should-not-land' });
  check('a write is refused at inspect', writeAtInspect.structured?.code === 'permission_denied', short(writeAtInspect.structured));
  check('and the refusal changed nothing on disk', !diskRead(FIXTURE, 'src/pages/index.astro').includes('should-not-land'));

  // --- edit ----------------------------------------------------------------
  await setMode('edit');
  const edit = await client.s('get_capabilities', {});
  check('the level moves to edit', edit.access.mode === 'edit', short(edit.access));
  check('writes are allowed at edit', domainsOf(edit).filter((a) => a.risk === 'write').every((a) => a.allowed), short(domainsOf(edit).filter((a) => a.risk === 'write' && !a.allowed).slice(0, 4)));
  check('and high-risk operations are not', domainsOf(edit).filter((a) => a.risk === 'high').every((a) => !a.allowed), short(domainsOf(edit).filter((a) => a.risk === 'high' && a.allowed).slice(0, 4)));

  const highAtEdit = await client.call('git', { action: 'commit', message: 'should never happen' });
  check('a high-risk git operation is refused at edit', highAtEdit.structured?.code === 'permission_denied', short(highAtEdit.structured));

  // --- the level moves while the connection stays open ---------------------
  //
  // There must be no authorization decided at initialize and remembered.
  const long = createMcpClient({ url: status.url, token: status.token });
  await long.initialize();
  const allowedNow = await long.call('target', { action: 'read' });
  check('a long-lived client can read at edit', allowedNow.structured?.ok === true, short(allowedNow.structured));
  await setMode('visual');
  const afterDowngrade = await long.call('target', { action: 'read' });
  check('the same open client is refused after a downgrade', afterDowngrade.structured?.code === 'permission_denied', short(afterDowngrade.structured));
  await setMode('edit');
  const afterUpgrade = await long.call('target', { action: 'read' });
  check('and allowed again after an upgrade, with no reconnect', afterUpgrade.structured?.ok === true, short(afterUpgrade.structured));

  // --- the race ------------------------------------------------------------
  //
  // Slow reads in flight, the level tightened underneath them, then a
  // mutation. The mutation is judged when it is dispatched, so it must be
  // refused — and nothing may have landed.
  const slow = [
    client.call('project', { action: 'scan' }),
    client.call('style', { action: 'read' }),
    client.call('target', { action: 'read' }),
  ];
  await setMode('visual');
  const raced = await client.call('target', { action: 'add_class', className: 'raced-in' });
  await Promise.allSettled(slow);
  check('a mutation dispatched after a downgrade is refused', raced.structured?.code === 'permission_denied', short(raced.structured));
  check('and nothing from the race reached disk', !diskRead(FIXTURE, 'src/pages/index.astro').includes('raced-in'));
  await setMode('edit');

  // --- the grant does not follow Stacki to another project -----------------
  await openProject(OTHER);
  await canvasReady();
  const there = await client.s('get_capabilities', {});
  check('another project starts at the default level', there.access.mode === 'visual', short(there.access));
  check('and its name is the one now open', there.project?.name === path.basename(OTHER), short(there.project));
  const refusedThere = await client.call('target', { action: 'read' });
  check('so a read is refused there', refusedThere.structured?.code === 'permission_denied', short(refusedThere.structured));

  await openProject(FIXTURE);
  await canvasReady();
  const back = await client.s('get_capabilities', {});
  check('and coming back finds the original grant intact', back.access.mode === 'edit', short(back.access));
});

// ---------------------------------------------------------------------------
// 3 — review to target, end to end
// ---------------------------------------------------------------------------

/**
 * The identity of a node, as two different answers can be compared.
 *
 * Not the ref string: two refs minted a moment apart legitimately differ in
 * what they observed, so comparing them by value would fail on a difference
 * nobody cares about. What must match is the thing they name — the file, the
 * lines, the marks, the tag, and which rendered copy.
 */
const identityOf = (read) => {
  const t = read?.target;
  if (!t) return null;
  return {
    file: t.source?.file ?? null,
    startLine: t.source?.startLine ?? null,
    endLine: t.source?.endLine ?? null,
    tag: t.tag ?? null,
    kind: t.kind ?? null,
    keys: t.keys || null,
    occurrence: t.occurrence ?? null,
    chain: t.componentChain || null,
  };
};

phase(3, 'review to target', async () => {
  await setMode('edit');
  await canvasReady();

  // Reviews are made where the app is looking, so each one needs its node
  // selected first. These are chosen to be the awkward cases: a plain node on
  // the page, one four components deep behind a slot, one inside a
  // conditional, one inside a ternary, one inside a Fragment, and one that is
  // a single template rendered many times.
  const wanted = [
    { what: 'a plain page node', find: (kids) => kids.find((c) => c.tag === 'h1') },
    { what: 'a node inside a conditional', find: (kids) => kids.find((c) => c.kind === 'cond') },
    { what: 'a node inside a Fragment', find: (kids) => kids.find((c) => c.tag === 'Fragment' || c.label === 'Fragment') },
    { what: 'a repeated node', find: (kids) => kids.find((c) => c.label === 'repeat-list' || c.kind === 'map') },
    { what: 'a component instance', find: (kids) => kids.find((c) => c.tag === 'Shell') },
  ];

  const page = await client.s('target', { action: 'read' });
  check('the fixture page reads', page?.ok === true, short(page));
  const kids = page?.target?.children || [];
  check('and has children to work with', kids.length > 3, short(kids.map((k) => ({ t: k.tag, k: k.kind }))));

  const made = [];
  for (const { what, find } of wanted) {
    const node = find(kids);
    if (!node) {
      check(`the fixture offers ${what}`, false, short(kids.map((k) => ({ tag: k.tag, kind: k.kind, label: k.label }))));
      continue;
    }
    const selected = await client.s('target', { action: 'select', ref: node.ref });
    if (!check(`${what} can be selected`, selected?.ok === true, short(selected))) continue;
    const review = await client.s('comment', { action: 'create', message: `stress: ${what}` });
    if (!check(`a review can be left on ${what}`, review?.ok === true, short(review))) continue;
    made.push({ what, number: review.review.number, id: review.review.id });
  }
  check('every awkward shape took a review', made.length === wanted.length, short(made));

  // --- the invariant -------------------------------------------------------
  //
  // Focus a review and the ref it hands back must name the node the canvas
  // actually selected. Not something similar, not the parent, not another copy
  // of the same template: the same node. This is checked by reading through
  // the returned ref and reading through no ref at all — which means "whatever
  // is selected" — and requiring the two to describe the same thing.
  for (const entry of made) {
    const focused = await client.s('comment', { action: 'focus', threadId: String(entry.number) });
    if (!check(`focusing ${entry.what} lands`, focused?.ok === true, short(focused))) continue;

    check(`focusing ${entry.what} hands back a ref over the wire`, typeof focused.targetRef === 'string' && focused.targetRef.startsWith('stacki:'), short(focused.targetRef));
    check(`and says how it identified it`, typeof focused.confidence === 'string', short(focused.confidence));
    if (typeof focused.targetRef !== 'string') continue;

    const viaRef = await client.s('target', { action: 'read', ref: focused.targetRef });
    check(`the returned ref reads for ${entry.what}`, viaRef?.ok === true, short(viaRef));
    const viaSelection = await client.s('target', { action: 'read' });
    check(`and the live selection reads for ${entry.what}`, viaSelection?.ok === true, short(viaSelection));

    const a = identityOf(viaRef);
    const b = identityOf(viaSelection);
    check(
      `the ref focus returned for ${entry.what} names the node the canvas selected`,
      a && b && JSON.stringify(a) === JSON.stringify(b),
      `ref=${short(a, 200)} selection=${short(b, 200)}`
    );

    // Nothing about this flow may have needed the filesystem: the source is in
    // the answer, which is the whole claim of the feature.
    check(`the answer names the file for ${entry.what}`, typeof viaRef?.target?.source?.file === 'string', short(viaRef?.target?.source));
    check(`and the lines`, Number.isInteger(viaRef?.target?.source?.startLine), short(viaRef?.target?.source));

    // A writable ref requires evidence. Where the pin is withheld, the write
    // must be withheld too.
    if (focused.targetEditable === false) {
      const write = await client.s('target', { action: 'add_class', className: 'should-not-land', ref: focused.targetRef });
      check(`a non-editable ref for ${entry.what} refuses a write`, write?.ok !== true, short(write));
    }
  }

  // --- an orphan -----------------------------------------------------------
  //
  // A review whose node is gone must degrade rather than point at whatever is
  // nearby, and must hand back no ref to write through.
  const victim = made.find((m) => m.what === 'a plain page node');
  if (victim) {
    const wasAt = await client.s('comment', { action: 'focus', threadId: String(victim.number) });
    const wasRead = wasAt?.targetRef ? await client.s('target', { action: 'read', ref: wasAt.targetRef }) : null;
    log(`orphan probe — before deletion: confidence=${wasAt?.confidence} keys=${short(wasRead?.target?.keys)} tag=${wasRead?.target?.tag} source=${short(wasRead?.target?.source)}`);
    const before = diskRead(FIXTURE, 'src/pages/index.astro');
    fs.writeFileSync(
      path.join(FIXTURE, 'src/pages/index.astro'),
      before.replace('<h1 class="page-title">{heading}</h1>', ''),
      'utf8'
    );
    await settled('the page to settle after the node was cut out', async () => {
      const list = await client.s('get_comments', { status: 'open', detail: 'summary' });
      return list?.reviews?.find((r) => r.number === victim.number)?.anchorState || null;
    }, { timeout: 60000 });
    const orphaned = await client.s('comment', { action: 'focus', threadId: String(victim.number) });
    const orphanRead = orphaned?.targetRef ? await client.s('target', { action: 'read', ref: orphaned.targetRef }) : null;
    log(`orphan probe — after deletion: ok=${orphaned?.ok} anchorState=${orphaned?.review?.anchorState} confidence=${orphaned?.confidence} editable=${orphaned?.targetEditable}`);
    log(`orphan probe — ref now names: keys=${short(orphanRead?.target?.keys)} tag=${orphanRead?.target?.tag} kind=${orphanRead?.target?.kind} source=${short(orphanRead?.target?.source)}`);
    log(`orphan probe — page still contains page-title? ${diskRead(FIXTURE, 'src/pages/index.astro').includes('page-title')}`);
    check('focusing a review whose node was deleted does not report success', orphaned?.ok === false, short(orphaned));
    check('and hands back no ref to act through', orphaned?.targetRef === null, short(orphaned?.targetRef));
    check('and says it is not editable', orphaned?.targetEditable === false, short(orphaned?.targetEditable));
    fs.writeFileSync(path.join(FIXTURE, 'src/pages/index.astro'), before, 'utf8');
    await canvasReady();
  }
});

// A single-node walk-through, printed, for pinning down where an identity
// stops matching. Not part of the matrix — run it with PHASES=probe.
phase('probe', 'one node, every step printed', async () => {
  await setMode('edit');
  await canvasReady();

  const page = await client.s('target', { action: 'read' });
  log(`root read: tag=${page?.target?.tag} kind=${page?.target?.kind} keys=${short(page?.target?.keys)}`);
  const h1 = (page?.target?.children || []).find((c) => c.tag === 'h1');
  log(`h1 child: ${short(h1)}`);

  const selected = await client.s('target', { action: 'select', ref: h1.ref });
  log(`select ok=${selected?.ok} -> ${short(selected?.target && identityOf(selected))}`);

  const ctx = await client.s('get_context', { styleDetail: 'none' });
  log(`get_context selection: status=${ctx?.selection?.status} tag=${ctx?.selection?.tag} source=${short(ctx?.selection?.source)} chain=${short(ctx?.selection?.componentChain)}`);

  const readNoRef = await client.s('target', { action: 'read' });
  log(`read(no ref):  ${short(identityOf(readNoRef), 300)}`);
  const readWithRef = await client.s('target', { action: 'read', ref: h1.ref });
  log(`read(h1 ref):  ${short(identityOf(readWithRef), 300)}`);

  const review = await client.s('comment', { action: 'create', message: 'probe: the h1' });
  log(`review created ok=${review?.ok} number=${review?.review?.number}`);
  log(`review anchor keys:      ${short(review?.review?.anchor?.keys)}`);
  log(`review anchor fingerprint:${short(review?.review?.anchor?.fingerprint, 260)}`);
  log(`review creationContext:  keys=${short(review?.review?.creationContext?.keys)} tag=${review?.review?.creationContext?.tag}`);

  const focused = await client.s('comment', { action: 'focus', threadId: String(review.review.number) });
  log(`focus ok=${focused?.ok} confidence=${focused?.confidence} editable=${focused?.targetEditable} restored=${short(focused?.restored)}`);
  const viaRef = await client.s('target', { action: 'read', ref: focused.targetRef });
  log(`focus ref names: ${short(identityOf(viaRef), 300)}`);
  const viaSel = await client.s('target', { action: 'read' });
  log(`selection now:   ${short(identityOf(viaSel), 300)}`);
});

// Does a selection made through the API become the selection the next call
// sees? Run with PHASES=probe2.
phase('probe2', 'select then immediately act', async () => {
  await setMode('edit');
  await canvasReady();

  const page = await client.s('target', { action: 'read' });
  const kids = page?.target?.children || [];
  const picks = [
    kids.find((c) => c.tag === 'h1'),
    kids.find((c) => c.label === 'tagline'),
    kids.find((c) => c.label === 'inline-styled'),
  ].filter(Boolean);

  for (const pick of picks) {
    const sel = await client.s('target', { action: 'select', ref: pick.ref });
    // Nothing between the select and the thing that consumes the selection.
    const ctx = await client.s('get_context', { styleDetail: 'none' });
    // How long until get_context agrees, if ever?
    const t0 = Date.now();
    let agreedAt = null;
    for (let i = 0; i < 40; i++) {
      const c = await client.s('get_context', { styleDetail: 'none' });
      if (JSON.stringify(c?.selection?.keys) === JSON.stringify(pick.keys)) { agreedAt = Date.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    log(`  ${pick.label}: get_context first=${ctx?.selection?.tag}/${short(ctx?.selection?.keys)} agreedAfter=${agreedAt === null ? 'NEVER' : agreedAt + 'ms'}`);
    const review = await client.s('comment', { action: 'create', message: `probe2: ${pick.label}` });
    const agreed = JSON.stringify(review?.review?.anchor?.keys) === JSON.stringify(pick.keys);
    log(`${pick.label}: select.ok=${sel?.ok} ctxTag=${ctx?.selection?.tag} wantKeys=${short(pick.keys)} reviewKeys=${short(review?.review?.anchor?.keys)} ${agreed ? 'AGREE' : 'DISAGREE'}`);
    check(`a review created straight after selecting ${pick.label} anchors to it`, agreed, `wanted ${short(pick.keys)} got ${short(review?.review?.anchor?.keys)}`);
    check(`and get_context reports ${pick.label} as selected`, ctx?.selection?.tag === pick.tag, `wanted ${pick.tag} got ${ctx?.selection?.tag}`);
  }
});

// --- run ---------------------------------------------------------------------

(async () => {
  await app.whenReady();
  status = await until('the MCP server', () => {
    const s = mcp.status();
    return s.running ? s : null;
  });
  check('the endpoint is listening', !!status.url, short(status));
  check('and it minted a token', typeof status.token === 'string' && status.token.length >= 32);
  client = createMcpClient({ url: status.url, token: status.token });

  window_ = await until('the app window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to load', () => (window_.webContents.isLoading() ? null : true), { timeout: 60000 });
  await wait(500);

  log('opening the fixture');
  await openProject(FIXTURE);
  await canvasReady();
  log('canvas is live');

  const wanted = (process.env.PHASES || [...PHASES.keys()].join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const id of wanted) {
    const entry = PHASES.get(id);
    if (!entry) {
      shout(`stress: no phase ${id}`);
      continue;
    }
    phaseNow = entry.id;
    const started = Date.now();
    const before = failures.length;
    log(`phase ${entry.id} — ${entry.title}`);
    try {
      await entry.fn();
    } catch (err) {
      failures.push(`  [${entry.id}] threw: ${err?.stack || err}`);
    }
    log(`phase ${entry.id} done in ${Math.round((Date.now() - started) / 1000)}s (${failures.length - before} new failures)`);
  }

  const stats = client.stats();
  say('');
  say(`stress: ${checked} checks, ${client.stats().calls} tool calls, latency p50 ${stats.latency.p50}ms p95 ${stats.latency.p95}ms max ${stats.latency.max}ms`);
  if (failures.length) {
    shout(`\nmcp-real-stress: ${failures.length} failed, ${checked - failures.length} passed\n`);
    for (const f of failures) shout(f);
    return done(1);
  }
  say(`mcp-real-stress: ${checked} passed  [a real server, a real project, used badly]`);
  return done(0);
})().catch((err) => {
  shout(`mcp-real-stress: ${err?.stack || err}`);
  done(1);
});
