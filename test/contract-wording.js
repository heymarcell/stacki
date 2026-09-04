// The product's sentences, checked against the product.
//
//   node test/contract-wording.js
//
// Everything here is a claim Stacki makes in prose — in the permission window,
// in the agent guide, in docs/. Prose has no compiler, so a sentence that was
// true when it was written stays in the shipped bundle long after the thing it
// described changed, and nothing fails. Every one of the overclaims this file
// exists for was found by driving the real product and then reading what the
// product said about it.
//
// The rule for every section: NEVER A GREP ALONE. A forbidden-phrase list on
// its own is worthless — it stays green when the behaviour changes underneath,
// and then it is forbidding a sentence that has become true. So each section
// measures the behaviour first, in the real harness, and only enforces the
// wording when the measurement says the wording would be a lie.

const fs = require('fs');
const path = require('path');

const H = require('./agent-harness.js');
const permissions = require('../electron/mcp/agent/permissions.js');
const { TOPICS } = require('../electron/mcp/guide.js');
const { createContextStore } = require('../electron/mcp/contextStore.js');
const { selectionTrail } = require('../electron/selectionTrail.js');
const { locateSelection } = require('../electron/astroParser.js');

const ROOT = path.join(__dirname, '..');
const readRepo = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const failures = [];
let checked = 0;
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

/** The first forbidden pattern `text` matches, or null. */
const offends = (text, patterns) => patterns.find((re) => re.test(text)) || null;

// Two loopback origins, a real audit window, and a sink that counts what
// reaches it. Electron, because the fact is about a browser: the fence is a
// browser event handler and the thing it does not stop is a subresource load.
// Nothing here touches the project, the network beyond loopback, or any file
// outside its own temp directory.
const FENCE_PROBE = String.raw`
process.env.STACKI_NO_DIALOGS = '1';
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { createAudit } = require(process.argv[2]);
app.on('window-all-closed', () => {});

const PIX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const serve = (handler) =>
  new Promise((done) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => done({ port: s.address().port, close: () => new Promise((r) => s.close(r)) }));
  });

(async () => {
  await app.whenReady();
  let hits = [];
  const sink = await serve((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/style')) { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{outline:0}'); }
    if (req.url.startsWith('/script')) { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('window.__sink = 1;'); }
    if (req.url.startsWith('/pixel')) { res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(PIX); }
    if (req.url.startsWith('/data')) { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end('{"a":1}'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang="en"><head><title>sink</title></head><body>elsewhere</body></html>');
  });
  const project = await serve((req, res) => {
    if (req.url.startsWith('/leaves')) {
      res.writeHead(302, { location: 'http://127.0.0.1:' + sink.port + '/landed' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><html lang="en"><head><title>Project page</title>' +
      '<link rel="stylesheet" href="http://127.0.0.1:' + sink.port + '/style.css"></head><body><h1>hello</h1>' +
      '<img src="http://127.0.0.1:' + sink.port + '/pixel.gif" width="1" height="1" alt="pixel">' +
      '<script src="http://127.0.0.1:' + sink.port + '/script.js"></script>' +
      '<script>fetch("http://127.0.0.1:' + sink.port + '/data.json").catch(() => {});</script>' +
      '</body></html>'
    );
  });
  const audit = createAudit({ BrowserWindow, getPreviewUrl: () => 'http://127.0.0.1:' + project.port, session });

  const one = await audit.run({ route: '/', viewports: [{ width: 900, height: 700 }] });
  const subresource = { ok: one.ok === true, code: one.code || null, hits };

  hits = [];
  const two = await audit.run({ route: '/leaves', viewports: [{ width: 900, height: 700 }] });
  const document = { ok: two.ok === true, code: two.code || null, hits };

  await project.close();
  await sink.close();
  console.log('FENCE ' + JSON.stringify({ subresource, document, windows: BrowserWindow.getAllWindows().length }));
  app.exit(0);
})().catch((err) => {
  console.log('FENCE ' + JSON.stringify({ error: String(err && err.stack || err) }));
  app.exit(1);
});
`;

/** Run the probe and hand back what the sink saw. */
async function measureOriginFence() {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-fence-'));
  try {
    // Parsed before it is spawned. A syntax error inside Electron is not a
    // stack trace on stdout, it is a native dialog on somebody's screen.
    new (require('vm').Script)(FENCE_PROBE, { filename: 'fence-probe.js' });
    const file = path.join(dir, 'probe.js');
    fs.writeFileSync(file, FENCE_PROBE, 'utf8');
    const electron = path.join(ROOT, 'node_modules', '.bin', 'electron');
    if (!fs.existsSync(electron)) return { error: 'no electron in node_modules — the fence fact cannot be measured here' };
    const out = String(
      execFileSync(electron, [file, path.join(ROOT, 'electron', 'mcp', 'audit', 'index.js')], {
        env: { ...process.env, STACKI_NO_DIALOGS: '1', STACKI_HIDDEN_WINDOW: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      })
    );
    const line = out.split('\n').find((l) => l.startsWith('FENCE '));
    return line ? JSON.parse(line.slice(6)) : { error: out.slice(-400) };
  } catch (err) {
    return { error: String(err.stdout || err.message).slice(-400) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  // ── DOC-1: what "Visual only" says it withholds ────────────────────────────
  //
  // `visual` grants none of the 111 registry operations, and that part is
  // enforced and tested (test/mcp-permission-matrix.js drives all 444 answers).
  // But get_context is not a registry operation and is not gated: at `visual`
  // it still hands back the absolute project root, the file and line range the
  // selection came from, and the selected node's own text. The blurb used to
  // end "It cannot read your project's files", which the snapshot below
  // contradicts field by field.
  {
    const root = H.makeProject();
    const app = await H.start(root, { agentMode: 'visual' });
    await H.settle(400);
    let snap = null;
    try {
      // The gate really is closed — otherwise the rest of this section is
      // measuring a build where `visual` means nothing.
      const denied = await app.api.run('source', 'read', { path: 'src/pages/index.astro' });
      check('at visual, a registry read is refused', denied.ok === false && denied.code === 'permission_denied', short(denied));

      // The same path electron/mcp/index.js takes to answer get_context.
      const store = createContextStore({ resolveTrail: (keys) => selectionTrail({ projectPath: root, keys }, locateSelection) });
      store.publish(app.payload());
      snap = store.read();
    } finally {
      app.stop();
      H.removeProject(root);
    }

    // What the answer actually discloses, measured rather than assumed. The
    // wording below is only enforced for the predicates that hold.
    const disclosed = {
      absoluteProjectPath: typeof snap?.project?.root === 'string' && path.isAbsolute(snap.project.root),
      filePath: typeof snap?.selection?.source?.file === 'string' && snap.selection.source.file.endsWith('.astro'),
      lineNumbers: Number.isInteger(snap?.selection?.source?.startLine) && Number.isInteger(snap?.selection?.source?.endLine),
      nodeText: typeof snap?.selection?.text === 'string' && snap.selection.text.length > 0,
    };
    check('get_context at visual still names where the project is on disk', disclosed.absoluteProjectPath, short(snap?.project));
    check('and which file the selection came from', disclosed.filePath, short(snap?.selection?.source));
    check('and which lines', disclosed.lineNumbers, short(snap?.selection?.source));
    check('and the selected node’s own text', disclosed.nodeText, short(snap?.selection?.text));

    // Claims the snapshot above disproves. Enforced against the gate's own
    // words and against the window a person reads before granting — the two
    // copies test/agent-api.js already pins to each other.
    const DENIALS = [
      /cannot read your project.s files/i,
      /no access to your (?:files|project|source)/i,
      /sees? only what is on screen/i,
      /nothing about your (?:files|source|project)/i,
      /does not know where your project is/i,
    ];
    const disclosesSomething = Object.values(disclosed).some(Boolean);
    if (disclosesSomething) {
      const blurb = permissions.BLURB.visual;
      const bad = offends(blurb, DENIALS);
      check('so the visual blurb denies none of it', !bad, bad ? `${bad} matched: ${blurb}` : '');
      const window = readRepo('src/ui/McpDialog.jsx');
      const table = window.slice(window.indexOf('const ACCESS = ['), window.indexOf('export default function McpDialog')).replace(/'\s*\+\s*'/g, '');
      const badWindow = offends(table, DENIALS);
      check('and neither does the window a person grants in', !badWindow, badWindow ? String(badWindow) : '');
    } else {
      check('get_context at visual disclosed nothing — this section proves nothing', false, short(snap));
    }

    // The other half: a blurb that denied nothing by saying nothing would pass
    // the list above. It has to describe what the level does hand over.
    check('and the visual blurb says the selection’s file and lines are visible', /file and lines/i.test(permissions.BLURB.visual), permissions.BLURB.visual);
    check('and that no file can be opened, listed or changed', /cannot open, list or change any file/i.test(permissions.BLURB.visual), permissions.BLURB.visual);
  }

  // ── E2 / N5 / style coverage: the guide against the answers ────────────────
  //
  // Three things the product does that the guide did not say. Each is measured
  // here first, through the real API, and the sentence is only required because
  // the measurement earned it.
  {
    const root = H.makeProject();
    const app = await H.start(root, { agentMode: 'full' });
    await H.settle(400);
    const seen = {};
    try {
      const first = await app.api.run('target', 'read');
      const stale = first.target.ref;
      const sibling = (first.target.children || [])[0];

      // Move the document under the ref the ordinary way: edit a sibling.
      const bump = await app.api.run('target', 'add_class', { ref: sibling.ref, className: 'wording-bump' });
      seen.writeAnswersWithRef = bump.ok === true && typeof bump.ref === 'string' && !!bump.document;

      const refused = await app.api.run('target', 'add_class', { ref: stale, className: 'should-not-land' });
      seen.staleWriteRefused = refused.ok === false && refused.code === 'stale_target';

      // …and the recovery the guide now names: the stale ref is still a read
      // handle, and what comes back is writable.
      const again = await app.api.run('target', 'read', { ref: stale });
      seen.staleReadResolves = again.ok === true && again.target?.tag === first.target.tag;
      seen.freshRefDiffers = again.ok === true && again.target?.ref !== stale;
      const recovered = await app.api.run('target', 'add_class', { ref: again.target?.ref, className: 'recovered' });
      seen.writeThroughFreshRef = recovered.ok === true;

      // N5's recovery: a write hands back a ref, and that ref re-selects. The
      // CLEARING itself is a canvas fact — the preview drops its selection when
      // the page reloads — and there is no canvas here, so what is pinned is
      // the way back, which is the half an agent has to act on.
      const reselect = await app.api.run('target', 'select', { ref: bump.ref });
      await H.settle(300);
      seen.selectFromWriteRef = reselect.ok === true;
      seen.selectionFollowed = (app.payload()?.selection?.keys || []).length > 0;

      // Style coverage: the answer no longer claims a cascade it cannot
      // justify, and it says why.
      const styles = await app.api.run('style', 'read', { ref: (await app.api.run('target', 'read')).target.ref });
      seen.coverageBlock = styles.ok === true && !!styles.coverage;
      seen.coverageHonest = styles.coverage?.complete === false && typeof styles.coverage?.runtime?.reason === 'string';
      seen.coverageNamesWhatItExcludes = Array.isArray(styles.coverage?.excludes) && styles.coverage.excludes.length > 0;
      seen.documentRulesNullNotEmpty = styles.documentRules === null;
    } finally {
      app.stop();
      H.removeProject(root);
    }

    check('a write answers with a fresh ref and the document it left', seen.writeAnswersWithRef);
    check('a write through a ref the document has moved under is refused', seen.staleWriteRefused);
    check('but that ref still READS, and resolves to the same object', seen.staleReadResolves);
    check('and the read hands back a different, current ref', seen.freshRefDiffers);
    check('which writes', seen.writeThroughFreshRef);
    check('and a write’s own ref re-selects the node it changed', seen.selectFromWriteRef && seen.selectionFollowed);
    check('style.read carries a coverage block', seen.coverageBlock);
    check('and declines to call the cascade complete when it did not consult the document', seen.coverageHonest);
    check('and names what an authored-file answer structurally excludes', seen.coverageNamesWhatItExcludes);
    check('and says nobody looked with null rather than an empty list', seen.documentRulesNullNotEmpty);

    const model = TOPICS['operating-model'].body;
    const editing = TOPICS.editing.body;

    // E2. The recovery is one call and it was written nowhere; "re-read the
    // subject" left an agent to rediscover the object it already had a handle
    // on. The guard itself is not up for negotiation and the guide has to say
    // why, or the next reader will file it as friction.
    if (seen.staleReadResolves && seen.writeThroughFreshRef) {
      check('the guide names the one-call recovery from a stale ref', /target\.read \{ ref \}/.test(model), model.slice(model.indexOf('## Refs'), model.indexOf('## Refs') + 900));
      check('and says a stale ref is still a read handle', /still a good READ handle/i.test(model));
      check('and the design notes say the same, as a cost rather than a defect', /target\.read \{ ref \}/.test(readRepo('docs/agent-api.md')) && /N siblings is N reads/.test(readRepo('docs/agent-api.md')));
    } else {
      check('the stale-ref recovery did not work — this section proves nothing', false, short(seen));
    }
    if (seen.writeAnswersWithRef) {
      check('and that a chain of edits on one node needs no re-read', /EVERY write answers with a fresh/.test(model));
    }
    check('and says why the guard exists rather than apologising for it', /scoped to ONE version of ONE document, deliberately/.test(model));
    check('and does not offer to relax it', !/expectedRevision.*(?:skip|omit|bypass)|ignore the stale/i.test(model));

    // N5.
    if (seen.selectFromWriteRef) {
      check('the guide says what capture target:"selection" does when nothing is selected', /no_selection/.test(editing));
      check('and names the way back', /target\.select with the ref the write answered with/.test(editing));
    }

    // Style coverage. The product itself refuses to claim a complete cascade
    // here; a guide that promised one would be promising past the answer.
    if (seen.coverageBlock && seen.coverageHonest) {
      const CASCADE_OVERCLAIMS = [/every declaration reaching it/i, /all the CSS that reaches/i, /the complete cascade/i, /every rule that applies/i];
      const bad = offends(editing, CASCADE_OVERCLAIMS);
      check('the editing guide promises no cascade style.read cannot justify', !bad, bad ? `${bad} — coverage.complete was false on a real read` : '');
      check('and tells an agent to read coverage first', /READ .?coverage.? BEFORE/i.test(editing), editing.slice(-700));
      check('and says generated CSS is not in any project file', /Generated CSS/.test(editing) && /documentRules/.test(editing));
    } else {
      check('style.read did not answer with coverage — this section proves nothing', false, short(seen));
    }
  }

  // ── F15: the origin fence is a NAVIGATION fence ────────────────────────────
  //
  // The audit stops documents: will-redirect, will-navigate and
  // will-frame-navigate are guarded, so no page from another origin loads in
  // any frame of the audit window. It does not stop REQUESTS — there is no
  // webRequest filter and no CSP — so a project page still fetches its own
  // stylesheets, images and scripts wherever they live, and the script it
  // fetched runs. That is deliberate: an audit of a page that could not load
  // its own fonts would measure a layout no visitor ever sees.
  //
  // The wording said things like "the audit only ever renders this project" and
  // "nothing outside this project is measured", which a reader generalises into
  // "nothing outside this project is contacted". This measures the real
  // behaviour with two loopback origins and a live sink, and only then holds
  // the wording to it — a phrase ban that fired while the behaviour had changed
  // would be banning a sentence that had become true.
  {
    const fence = await measureOriginFence();
    check('the audit renders a project page that points at another origin', fence.subresource?.ok === true, short(fence.subresource));
    check('and the other origin is contacted, four resource kinds over', (fence.subresource?.hits?.length || 0) >= 4, short(fence.subresource?.hits));
    // The sink can receive, so the zero below is a real zero.
    check('a DOCUMENT off the project origin is still refused', fence.document?.ok === false, short(fence.document));
    check('and that one reaches the other origin not at all', (fence.document?.hits?.length || 0) === 0, short(fence.document?.hits));

    const contacted = (fence.subresource?.hits?.length || 0) > 0;
    const FENCE_OVERCLAIMS = [
      /requires no network access/i,
      /sends nothing anywhere/i,
      /only ever renders this project/i,
      /nothing (?:outside|beyond) this project is (?:fetched|contacted|requested|loaded|reached)/i,
      /(?:reaches|contacts|talks to) nothing outside/i,
    ];
    // EVERY surface that describes the fence, including the audit engine's own
    // refusal messages and its tool description. Splitting this list by which
    // file somebody owns is how the guide came to be precise while the message
    // an agent actually reads still said "nothing outside this project is
    // measured" — the claim travels with whichever sentence a reader meets
    // first, so they are all held to the same one.
    const SURFACES = [
      'electron/mcp/guide.js',
      'docs/mcp-v1.md',
      'docs/agent-api.md',
      'docs/mcp-compatibility.md',
      'docs/audit.md',
      'electron/mcp/audit/index.js',
      'electron/mcp/auditTool.js',
    ];
    if (contacted) {
      for (const rel of SURFACES) {
        const bad = offends(readRepo(rel), FENCE_OVERCLAIMS);
        check(`${rel} claims no more of the fence than it enforces`, !bad, bad ? `${bad} — the fence is on documents; subresources of the project's own page are fetched` : '');
      }
    } else {
      check('the audit contacted nothing off-origin — this section proves nothing', false, short(fence));
    }

    // The audit guide tells an agent how to see one route at a width of its
    // own, and names three fields. A guide naming an argument the tool does not
    // take is worse than one that says nothing, so the claims are put to the
    // real schema rather than to a reading of it.
    {
      const { registerAuditTool, AuditOutput } = require('../electron/mcp/auditTool.js');
      let config = null;
      const stub = { registerTool: (name, c) => { config = c; } };
      registerAuditTool(stub, { audit: { run: async () => ({ ok: true }) }, api: { gate: {} } });
      check('the audit tool registered a schema to check against', !!config?.inputSchema, 'registerAuditTool did not register');
      const accepts = (args) => {
        try {
          const s = config.inputSchema;
          const parse = typeof s.parse === 'function' ? s : s._def ? s : null;
          return parse ? (parse.safeParse(args).success === true) : false;
        } catch {
          return false;
        }
      };
      check(
        'and audit({route, viewports:[{width,height}], capture:true}) is really the shape it takes',
        accepts({ route: '/', viewports: [{ width: 1440, height: 900 }], capture: true }),
        'the guide tells an agent to send this'
      );
      // Put values to the schema rather than reading its internals: a declared
      // field accepts its own type and rejects another, and an undeclared one
      // is passed through whatever it holds.
      const truncation = AuditOutput.shape.truncation;
      const base = {
        detected: 1, returned: 1, omitted: 0,
        omittedBeforeScoring: { geometryCulprits: 0, axeNodes: 0 },
        omittedByResponseBudget: 0, omittedByByteBudget: 0, findingsWithShortenedFields: 0,
        responseCap: 60, responseByteCap: 1, fieldCaps: {}, incompleteReserved: 15,
      };
      check(
        'and `truncation.scored` is a declared integer, not a word the guide made up',
        truncation.safeParse({ ...base, scored: 7 }).success === true && truncation.safeParse({ ...base, scored: 'seven' }).success === false,
        'an undeclared key would accept both'
      );
      const captures = AuditOutput.shape.captures;
      const row = { viewport: { key: 'a', width: 1, height: 1 }, included: true, mimeType: null, bytes: null, width: null, height: null, sha256: null, renderedOffscreen: true, note: '' };
      const withoutIncluded = { ...row };
      delete withoutIncluded.included;
      check(
        'and every capture row must say whether its image was sent',
        captures.safeParse([row]).success === true && captures.safeParse([withoutIncluded]).success === false,
        'a row that could omit `included` could imply an image that is not there'
      );
      check('the guide names truncation.scored', /truncation\.scored/.test(TOPICS.audit.body));
      check('and the included:false row', /included:\s*\n?false|included: false/.test(TOPICS.audit.body));
      check('and the viewports+capture call', /audit\(\{route, viewports:\[\{width,height\}\], capture:true\}\)/.test(TOPICS.editing.body));
    }

    // And silence is not honesty either: the two places an agent and a person
    // actually read have to say which half is fenced.
    check(
      'the audit guide says DOCUMENTS are what is fenced',
      /DOCUMENTS are fenced/.test(TOPICS.audit.body) && /route_outside_project/.test(TOPICS.audit.body) && /subresource/i.test(TOPICS.audit.body),
      TOPICS.audit.body.slice(-600)
    );
    check(
      'and docs/mcp-v1.md says the same, both halves',
      /fence is on DOCUMENTS/.test(readRepo('docs/mcp-v1.md')) && /Subresources are a different\s+question/.test(readRepo('docs/mcp-v1.md'))
    );
  }

  // ── COUNT-111: the totals stated in prose ──────────────────────────────────
  //
  // The accounting is right and it is derived properly everywhere it is
  // COMPUTED — get_capabilities, the tool schemas, docs/agent-api-coverage.md
  // (generated, and `--check`ed by test/agent-api.js). Where it is TYPED, in
  // docs/mcp-v1.md and docs/mcp-compatibility.md, nothing read those files, so
  // one added operation would leave them stating a number that used to be true.
  //
  // The figures are wrapped in `<!--count:name-->…<!--/-->`, which renders as
  // nothing, so the docs stay readable and the assertion stays exact rather
  // than being a regex hunting integers out of prose.
  {
    const registry = require('../electron/mcp/agent/registry.js');
    require('./support/mcpScenarioSet.js'); // registering, not running
    const { all: allScenarios } = require('./support/mcpOperationScenarios.js');

    const ops = registry.list();
    const boundary = allScenarios().filter((s) => s.grade === 'boundary');
    const derived = {
      total: ops.length,
      domains: registry.DOMAINS.length,
      modes: permissions.MODES.length,
      full: ops.length - boundary.length,
      boundary: boundary.length,
      permAnswers: ops.length * permissions.MODES.length,
      visualOps: ops.filter((o) => permissions.allows('visual', o.risk)).length,
      inspectOps: ops.filter((o) => permissions.allows('inspect', o.risk)).length,
      editOps: ops.filter((o) => permissions.allows('edit', o.risk)).length,
      fullOps: ops.filter((o) => permissions.allows('full', o.risk)).length,
    };

    check('the registry reports operations at all', derived.total > 0, String(derived.total));
    // The 110/1 split is a claim about WHICH operation is fail-closed, and that
    // is the half worth pinning hardest: a second boundary would be a second
    // thing no test performs.
    check(
      'exactly one operation is graded BOUNDARY, and it is git.publish',
      boundary.length === 1 && boundary[0].domain === 'git' && boundary[0].action === 'publish',
      boundary.map((s) => `${s.domain}.${s.action}`).join(', ') || 'none'
    );

    const MARKED = ['docs/mcp-v1.md', 'docs/mcp-compatibility.md'];
    const MARKER = /<!--count:([a-zA-Z]+)-->([0-9,]+)<!--\/-->/g;
    const seen = new Set();
    for (const rel of MARKED) {
      const text = readRepo(rel);
      const found = [...text.matchAll(MARKER)];
      check(`${rel} states its totals in checkable markers`, found.length > 0, 'no <!--count:…--> marker in the file');
      for (const [, name, value] of found) {
        seen.add(name);
        const want = derived[name];
        check(`${rel} states ${name} as the registry has it`, want != null && Number(value.replace(/,/g, '')) === want, `doc says ${value}, registry says ${want ?? 'no such figure'}`);
      }
    }
    for (const name of Object.keys(derived)) {
      check(`the ${name} figure is pinned in the docs`, seen.has(name), `nothing in ${MARKED.join(' or ')} carries <!--count:${name}-->`);
    }

    // A figure typed outside a marker is a figure nothing checks — which is the
    // whole defect. Only enforced for the two distinctive numbers, because 8, 4
    // and 1 occur legitimately all over a document about a protocol.
    for (const rel of MARKED) {
      const bare = readRepo(rel).replace(MARKER, '');
      for (const n of [derived.total, derived.permAnswers]) {
        check(`${rel} has no unwrapped copy of ${n}`, !new RegExp(`(?<![\\d,])${n}(?![\\d,])`).test(bare), `wrap it in <!--count:…-->${n}<!--/--> or it drifts silently`);
      }
    }

    // The engineering skill states the same figures and is not a product file,
    // so it is pinned WITHOUT being edited: the sentence is parsed where it
    // stands. If somebody rewords it, the anchor check below fails and says so
    // rather than the numbers quietly stopping being read.
    {
      const skill = readRepo('.claude/skills/stacki-engineering/SKILL.md');
      const m = /(\d+) Agent operations across (\d+) domains: (\d+) FULL \+ (\d+) BOUNDARY \(`([a-z.]+)`\)/.exec(skill);
      check('the engineering skill still states the operation accounting', !!m, 'the sentence moved — repoint this check rather than deleting it');
      if (m) {
        check('and states it the way the registry has it', Number(m[1]) === derived.total && Number(m[2]) === derived.domains && Number(m[3]) === derived.full && Number(m[4]) === derived.boundary && m[5] === 'git.publish', m[0]);
      }
      const p = /(\d+)\/(\d+) permission subjects covered/.exec(skill);
      check('and the permission-subject total', !!p && Number(p[1]) === derived.permAnswers && Number(p[2]) === derived.permAnswers, p ? p[0] : 'the sentence moved');
    }
  }

  if (failures.length) {
    console.error(`\ncontract-wording: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`contract-wording: ${checked} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
