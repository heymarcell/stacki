// A packaged Stacki, launched and driven, and taken down again.
//
// Everything that makes the packaged proof possible lives here so the tests
// that use it read as tests rather than as process management: a fixture with
// the project's own dependencies really installed, the automation nonce the app
// checks for, an isolated userData, a port nobody else is on, and a teardown
// that reports what it could not clean up rather than swallowing it.
//
// OWNERSHIP. Every path and every process here is made by this module. The
// stop() records exact pids and exact directories, and answers with what
// survived — nothing greps for "a Stacki" or "an astro".

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const H = require('../agent-harness.js');
const { EXTRA, writeBinary } = require('./mcpWireFixture.js');
const { connectMcp } = require('./mcpWire.js');
const { CACHE, ensureAstro } = require('../agent-canvas-fixture.js');
const { projectFingerprint } = require('../../electron/mcp/agent/refs.js');

const APP = path.join(__dirname, '..', '..', 'release', 'mac-universal', 'Stacki.app');
const BINARY = path.join(APP, 'Contents', 'MacOS', 'Stacki');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const available = () => fs.existsSync(BINARY);

const portTaken = (port) =>
  new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (taken) => {
      socket.destroy();
      done(taken);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(false), 300).unref?.();
  });

async function freePort(from) {
  for (let port = from; port < from + 200; port += 1) {
    if (!(await portTaken(port))) return port;
  }
  throw new Error('no free port for the packaged MCP endpoint');
}

/**
 * A fixture the packaged app is allowed to open.
 *
 * The dependencies are real — cloned from the shared cache — because a project
 * that cannot run Astro cannot render, and a packaged proof that never renders
 * is the in-process proof again with a longer startup.
 */
function makeFixture({ nonce }) {
  ensureAstro();
  const project = H.makeProject({ ...EXTRA });
  writeBinary(fs, path, project);
  try {
    execFileSync('cp', ['-Rc', path.join(CACHE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'pipe' });
  } catch {
    fs.cpSync(path.join(CACHE, 'node_modules'), path.join(project, 'node_modules'), { recursive: true, dereference: false });
  }
  // The nonce the app will look for. Written here, passed separately in the
  // environment: matching the two is what makes a stale fixture unusable.
  fs.writeFileSync(path.join(project, '.stacki-automation'), nonce, 'utf8');
  return project;
}

/**
 * Launch it, wait for its MCP server, and connect an official client.
 *
 * `access` is written into the app's own settings file, keyed the way the app
 * keys it — the same grant a person makes from the access menu. `full` is
 * deliberately not reachable this way (see electron/mcp/agent/access.js: it
 * comes from a live session or not at all), so `edit` is the ceiling here and
 * that is what a write needs.
 */
async function startPackagedApp({ access = 'edit', nonce = null, portFrom = 43990 } = {}) {
  if (!available()) throw new Error(`no packaged app at ${APP}`);
  const marker = nonce || `stacki-automation-${process.pid}-${(process.hrtime.bigint() % 1000000n).toString()}`;
  const project = makeFixture({ nonce: marker });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-packaged-userdata-'));
  const port = await freePort(portFrom);

  // The app resolves the automation path before opening it, so the grant has to
  // be keyed to what it will actually open.
  const opened = fs.realpathSync(project);
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(opened)]: access } }),
    'utf8'
  );

  const output = [];
  let exited = null;
  const child = spawn(BINARY, [`--user-data-dir=${userData}`], {
    env: {
      ...process.env,
      STACKI_NO_DIALOGS: '1',
      STACKI_HIDDEN_WINDOW: '1',
      STACKI_MCP_PORT: String(port),
      STACKI_AUTOMATION_PROJECT: project,
      STACKI_AUTOMATION_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  child.on('exit', (code) => {
    exited = code;
  });

  let token = null;
  for (let i = 0; i < 160 && token === null && exited === null; i += 1) {
    await sleep(500);
    try {
      token = JSON.parse(fs.readFileSync(path.join(userData, 'mcp-token.json'), 'utf8')).token;
    } catch {
      /* not written yet */
    }
  }
  if (!token) {
    throw new Error(`the packaged app did not start its MCP server (exit=${exited})\n${output.join('').slice(-800)}`);
  }

  const url = `http://127.0.0.1:${port}/mcp`;
  const { client, close } = await connectMcp({ url, token, era: 'modern', name: 'Stacki Phase A Agent' });

  const call = async (name, args = {}) =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout: 240000 })).structuredContent;
  const run = (domain, action, args = {}) => call(domain, { action, ...args });

  /** Wait for the window to finish opening the project it was pointed at. */
  const untilOpen = async (timeoutMs = 90000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await run('project', 'info');
      if (info?.ok === true && info?.project?.open) return info;
      if (Date.now() > deadline) return info;
      await sleep(500);
    }
  };

  /**
   * Wait until the app is actually SHOWING the page.
   *
   * Not the same as the project being open: the dev server has to be up and
   * the canvas has to have loaded it before a computed style or a screenshot
   * means anything. Asked of capture itself, because `preview_not_ready` is
   * exactly the answer a premature proof would have accepted.
   */
  const untilPreviewReady = async (timeoutMs = 180000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await call('capture', { target: 'viewport', format: 'png' });
      if (last?.status && last.status !== 'preview_not_ready' && last.status !== 'preview_starting') return last;
      if (Date.now() > deadline) return last;
      await sleep(1000);
    }
  };

  const stop = async () => {
    const problems = [];
    try {
      await close();
    } catch {
      problems.push('the MCP client would not close');
    }
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        problems.push('the app would not take SIGTERM');
      }
      for (let i = 0; i < 40 && child.exitCode === null; i += 1) await sleep(250);
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(250);
      }
    }
    if (child.exitCode === null) problems.push(`the app (pid ${child.pid}) is still running`);
    for (const dir of [userData, project]) {
      for (let attempt = 0; attempt < 6 && fs.existsSync(dir); attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* still held */
        }
        if (fs.existsSync(dir)) await sleep(300);
      }
      if (fs.existsSync(dir)) problems.push(`${dir} would not go`);
    }
    if (await portTaken(port)) problems.push(`port ${port} is still in use`);
    return { problems, pid: child.pid, port, project, userData };
  };

  return { child, client, call, run, untilOpen, untilPreviewReady, stop, project, opened, userData, port, marker, output, url, token };
}

module.exports = { startPackagedApp, available, APP, BINARY, sleep, portTaken };
