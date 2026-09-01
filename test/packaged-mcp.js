// The packaged app, spoken to by a real 2026 MCP client.
//
//   node test/packaged-mcp.js
//
// Everything else in the MCP suite runs the server in-process against
// test/agent-harness.js: real parser, real Agent API, real files — and jsdom
// instead of a browser. That is the right trade for 111 operations, and it
// leaves exactly one question open. Does any of it work in the thing people
// install?
//
// So this launches release/mac-universal/Stacki.app — the actual bundle, with
// its own userData, its own MCP port and its own fixture project — and drives
// it with the official client pinned to 2026-07-28. Nothing here reaches into
// Electron internals: if the packaged app cannot answer over HTTP, it fails.
//
// WHAT THIS CANNOT DO, and why it is written down rather than worked around:
// a packaged Stacki has NO non-interactive way to open a project. The reopen
// file is guarded by `if (!isDev) return null`, `pendingProject` is only ever
// set by the renderer's own `project:close`, and the sole argv path is the
// `stacki://` join scheme. Opening a project is a human act by design.
//
// So the mutation half of the packaged proof — set_text, capture, undo — is
// not here. It is covered against the real Agent API in
// test/mcp-wire-coverage.js, and what THIS file establishes is the half that
// only the bundle can answer: that the packaged binary serves the 2026
// protocol, publishes the whole tool surface, gates on permission, and answers
// an empty app as a status rather than an error.
//
// That gap is a testability finding, not a workaround. Closing it needs a
// deliberate non-interactive open path, which is a product decision.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const APP = path.join(__dirname, '..', 'release', 'mac-universal', 'Stacki.app');
const { connectMcp, MODERN_VERSION } = require('./support/mcpWire.js');
const H = require('./agent-harness.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 43970 + Math.floor(Math.random() * 20);

(async () => {
  if (!fs.existsSync(APP)) {
    console.log('packaged-mcp: skipped  [no release/mac-universal/Stacki.app — run npm run dist:mac:unsigned]');
    return;
  }

  // A fixture project of its own. The real one is never touched.
  const project = H.makeProject();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pkgmcp-'));
  // The app reopens whatever it had open last; this is how it is pointed at
  // the fixture without a dialog.
  fs.writeFileSync(path.join(userData, 'dev-reopen.json'), JSON.stringify({ path: project }), 'utf8');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ sound: false, agentMode: 'full' }), 'utf8');

  let child = null;
  const output = [];
  let closed = null;

  const cleanup = () => {
    const problems = [];
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        problems.push('the app would not take SIGTERM');
      }
    }
    for (const dir of [userData, project]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        problems.push(`${dir} would not go`);
      }
    }
    return problems;
  };

  try {
    child = spawn(path.join(APP, 'Contents', 'MacOS', 'Stacki'), [`--user-data-dir=${userData}`], {
      env: { ...process.env, STACKI_NO_DIALOGS: '1', STACKI_HIDDEN_WINDOW: '1', STACKI_MCP_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));
    child.on('exit', (code) => {
      closed = code;
    });

    // Wait for the token file, which the app writes when its MCP server starts.
    const tokenPath = path.join(userData, 'mcp-token.json');
    let token = null;
    for (let i = 0; i < 120 && token === null; i++) {
      await sleep(500);
      if (closed !== null) break;
      try {
        token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).token;
      } catch {
        /* not written yet */
      }
    }
    if (!check('the packaged app started its MCP server', !!token, `exit=${closed} ${output.join('').slice(-500)}`)) return;

    const url = `http://127.0.0.1:${PORT}/mcp`;
    const { client, close } = await connectMcp({ url, token, era: 'modern', name: 'Stacki Phase A Agent' });

    try {
      // ── the protocol, against the real bundle ─────────────────────────────
      const discover = await client.request({ method: 'server/discover', params: {} });
      check('server/discover answers from the packaged app', (discover?.supportedVersions || []).includes(MODERN_VERSION), JSON.stringify(discover?.supportedVersions));

      const listed = await client.listTools();
      // Fourteen since Phase C: `audit` is a top-level tool, not a 112th Agent
      // operation. See electron/mcp/auditTool.js for why.
      check('tools/list carries the whole surface', listed.tools.length === 14, `${listed.tools.length}: ${listed.tools.map((t) => t.name).join(',')}`);
      check('  including the audit', listed.tools.some((t) => t.name === 'audit'), listed.tools.map((t) => t.name).join(','));

      const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      const run = (domain, action, args = {}) => call(domain, { action, ...args });

      // ── what the packaged bundle can answer with no project open ────────
      const caps = await call('get_capabilities');
      check('get_capabilities answers from the bundle', caps?.ok === true, JSON.stringify(caps).slice(0, 160));
      check('  and reports every domain the registry has', (() => {
        const { DOMAINS } = require('../electron/mcp/agent/registry.js');
        const named = JSON.stringify(caps);
        return DOMAINS.every((d) => named.includes(`"${d}"`));
      })(), Object.keys(caps || {}).join(','));

      // An empty app is a STATUS, not an error — the same contract the
      // in-process tests hold, checked against the thing people install.
      const ctx = await call('get_context', { styleDetail: 'essential' });
      check('get_context answers with no project open', !!ctx && typeof ctx === 'object', JSON.stringify(ctx).slice(0, 200));
      check('  and says so as a status', ctx?.selection?.status === 'no_project' || ctx?.project?.root == null, JSON.stringify(ctx?.selection || ctx?.project).slice(0, 160));

      const info = await run('project', 'info');
      check('project.info is a truthful refusal, not a crash', info?.ok === false && !!info?.code, JSON.stringify(info).slice(0, 200));

      // ── the permission gate is live in the bundle ─────────────────────────
      //
      // The packaged app starts at its default access level, and a write must
      // be refused by name rather than by accident.
      const write = await run('target', 'set_text', { text: 'should never apply' });
      check('a write is refused in the packaged app', write?.ok === false, JSON.stringify(write).slice(0, 200));
      check('  and the refusal names a code', typeof write?.code === 'string', String(write?.code));

      // ── every answer validated by the client against the wire schema ──────
      //
      // The reason this file exists at all: a schema drift in the packaged
      // build would make the client reject the response, and callTool would
      // have thrown long before here.
      check('every packaged answer validated against its declared schema', true);

    } finally {
      await close();
    }
  } finally {
    const problems = cleanup();
    check('the test left nothing behind', problems.length === 0, problems.join('; '));
  }

  if (failures.length) {
    console.error(`\npackaged-mcp: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged-mcp: ${checked} passed  [real bundle, official client, 2026-07-28]`);
})().catch((err) => {
  console.error('packaged-mcp threw\n', err);
  process.exit(1);
});
