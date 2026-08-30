// A real MCP endpoint in front of the real Agent API, for coverage scenarios.
//
// test/agent-harness.js already builds the hard half: the real electron/main.js
// with a stubbed `electron`, the real App bridge in jsdom, the real Astro
// parser and serializer, and a real Agent API over a real fixture project on
// disk. What it does NOT have is a wire — agent-api.js and agent-acceptance.js
// call `api.run(...)` straight.
//
// That is a fine implementation test and it is not wire coverage. The bug we
// actually shipped lived between the implementation and the client: a field
// the service sent and the schema never declared, which every direct call in
// the repository was blind to by construction.
//
// So this puts the real MCP server in front of that real api, and hands back a
// `call()` that goes:
//
//   official MCP client -> HTTP -> Stacki MCP server -> domain tool
//     -> Agent API dispatcher -> real main/App implementation -> fixture
//
// WHAT IS AND IS NOT REAL HERE, stated plainly because a coverage number that
// hides this is worth nothing: source, files, refs, permission gating, the
// parser, the serializer and the undo stack are the shipping code. The CANVAS
// is not — there is no browser painting, so computed styles and screenshots
// answer empty, exactly as the harness documents. Operations whose whole
// meaning is a rendered pixel are graded against the packaged Electron proof
// instead, not here.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('../agent-harness.js');
const { EXTRA, writeBinary } = require('./mcpWireFixture.js');
const { ensureAstro, astroCached, CACHE } = require('../agent-canvas-fixture.js');
const { createStackiMcpServer } = require('../../electron/mcp/server.js');
const { connectMcp } = require('./mcpWire.js');
const net = require('node:net');

/** Whether something is already listening there. */
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

// A base that differs per process, so two suites running at once do not both
// start at the same number and collide — which is not hypothetical: the
// permission matrix and the regression suites, run together, took each other
// out with "port 44120 is already in use".
let nextPort = 44120 + ((process.pid % 400) * 30);

/**
 * Boot a fixture project, a real Agent API over it, an MCP endpoint in front
 * of that, and an official client connected to the endpoint.
 */
/**
 * The project's own dependencies, really installed.
 *
 * The content operations are not testable without them. Reading a content
 * config means bundling it, which electron/contentConfig.js does with the
 * project's OWN esbuild — `esbuildOf(projectPath)` — so without node_modules
 * every collection question can only answer "that needs the dependencies
 * installed". Scenarios were accepting that answer as proof, which meant the
 * whole content domain was graded on its refusal message.
 *
 * Installed once into a shared cache by test/agent-canvas-fixture.js, then
 * cloned per fixture. `cp -c` asks APFS for copy-on-write, which turns 154MB
 * into a metadata operation; the plain copy is there for filesystems that will
 * not do that, and is the same layout either way — a real node_modules, not a
 * symlink farm.
 */
function installDeps(root, log) {
  ensureAstro({ log });
  const from = path.join(CACHE, 'node_modules');
  const to = path.join(root, 'node_modules');
  try {
    execFileSync('cp', ['-Rc', from, to], { stdio: 'pipe' });
  } catch {
    fs.cpSync(from, to, { recursive: true, dereference: false });
  }
  if (!fs.existsSync(path.join(to, 'esbuild', 'package.json'))) {
    throw new Error('the fixture has no esbuild, so its content config cannot be read');
  }
  return to;
}

async function startWireRig({ era = 'modern', agentMode = 'full', extra = {}, withDeps = false, realDevServer = false, log = () => {} } = {}) {
  // The shared fixture plus what the wire scenarios need to assert anything
  // real: a dynamic route, a genuine image, a canary in robots.txt.
  const root = H.makeProject({ ...EXTRA, ...extra });
  writeBinary(fs, path, root);
  if (withDeps || realDevServer) installDeps(root, log);
  const harness = await H.start(root, { agentMode, realDevServer });

  // Skips past anything already listening: a port a previous rig has only just
  // let go of is still busy for a moment, and so is one another process took.
  let port = nextPort++;
  for (let tries = 0; tries < 200 && (await portTaken(port)); tries += 1) port = nextPort++;
  const token = `wire-rig-token-${port}-aaaaaaaaaaaa`;
  const url = `http://127.0.0.1:${port}/mcp`;

  const server = createStackiMcpServer({
    port,
    token,
    version: '0.0.0-wire',
    api: harness.api,
    // The four core tools still have to exist for the endpoint to build. The
    // context one is answered from the App's own published payload, so
    // get_context over the wire is the App's real snapshot.
    getContext: async () => harness.payload(),
    capture: async (args) => ({
      image: null,
      mimeType: null,
      // The harness has no canvas. A capture here is an honest refusal WITH
      // meta, which is exactly what createCapture returns when it cannot
      // photograph anything — never a bare { ok:false }.
      meta: {
        revision: 0,
        status: 'preview_not_ready',
        target: args.target,
        requestedTarget: args.target,
        format: args.format,
        source: null,
        view: null,
        occurrence: 0,
        occurrenceCount: 0,
        rect: null,
        pixelSize: null,
        bytes: 0,
        note: 'This rig has no canvas; screenshots are proven against packaged Stacki.',
      },
    }),
    getComments: async () => ({
      ok: true, revision: 1, status: 'open', scope: 'project',
      total: 0, returned: 0, truncated: false, reviews: [], problem: null,
    }),
    comment: async () => ({ ok: false, code: 'no_project', message: 'This rig has no review ledger.' }),
  });
  await server.start?.();

  const { client, close: closeClient } = await connectMcp({ url, token, era, name: 'Stacki Phase A Agent' });

  /**
   * One Agent operation, through the wire.
   *
   * Returns the envelope the client validated against the tool's declared
   * output schema — so a schema drift throws here rather than being silently
   * accepted, which is the whole reason this path exists.
   */
  // Starting a real Astro dev server is the slowest thing any operation does,
  // and it is slower still the first time a fixture runs one. The client's
  // default deadline is shorter than that, so a working lifecycle came back as
  // "Request timed out" — a wire timeout dressed up as an operation failure.
  const CALL_TIMEOUT_MS = 180000;

  const call = async (domain, action, args = {}) => {
    const res = await client.callTool({ name: domain, arguments: { action, ...args } }, undefined, { timeout: CALL_TIMEOUT_MS });
    return { envelope: res.structuredContent, raw: res };
  };

  /** get_capabilities, get_context and the rest of the non-domain surface. */
  const tool = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    return { envelope: res.structuredContent, raw: res };
  };

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await closeClient();
    await server.stop?.();
    // NO DEV SERVER OUTLIVES THE FIXTURE IT SERVES.
    //
    // `devServer` is one module-level value in electron/main.js and the harness
    // loads main once, so a server a scenario forgets is still running when the
    // next scenario starts — pointed at a directory this teardown is about to
    // delete. That is how five scenarios could each pass alone and two of them
    // fail in the suite. Asked of main's own handler, so it is the real stop.
    try {
      const stopDev = harness.handlers.get('dev:stop');
      if (stopDev) await stopDev(null);
    } catch {
      /* nothing was running */
    }
    try {
      harness.stop();
    } catch {
      /* a jsdom that will not close must not fail the suite */
    }
    // The content config is answered by a CHILD PROCESS, held open on purpose
    // so the next question does not pay to start one — and deliberately not
    // unref'd, because the pipes are what carry the answers. Nothing else in
    // this rig ends it, so without this a fixture with dependencies leaves a
    // node behind per scenario and the suite never exits.
    //
    // AFTER the window comes down, not before. Unmounting runs the app's own
    // effects one last time, and one of them asks about the content config —
    // which starts a fresh service, moments after the old one was stopped. Done
    // in this order, the last thing to want a config has already finished.
    try {
      require('../../electron/contentConfig.js').stopAllServices();
    } catch {
      /* nothing was ever started */
    }
    H.removeProject(root);
  };

  return { root, harness, client, call, tool, stop, url, token, port, withDeps, realDevServer };
}

module.exports = { startWireRig, astroCached };
