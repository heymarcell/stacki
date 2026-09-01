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
    // A LOOPBACK CONNECT THAT DOES NEITHER IS NOT EVIDENCE OF A FREE PORT.
    // On 127.0.0.1 a live listener connects and a dead one refuses, both at
    // once. Silence means a loaded machine, a full accept backlog or a socket
    // on its way down -- and this used to read that silence as "free", walk
    // straight into it, and fail the suite with "already in use".
    setTimeout(() => settle(true), 500).unref?.();
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
/** A few deep files that a complete install has and a half-copy does not. */
const DEPS_LANDMARKS = [
  path.join('astro', 'package.json'),
  path.join('astro', 'dist'),
  path.join('astro', 'bin'),
  path.join('.bin', 'astro'),
  path.join('esbuild', 'package.json'),
  path.join('esbuild', 'lib', 'main.js'),
];

/** Whether an installed node_modules has the parts a content config needs. */
const looksComplete = (dir) => DEPS_LANDMARKS.every((rel) => fs.existsSync(path.join(dir, rel)));

function installDeps(root, log) {
  ensureAstro({ log });
  const from = path.join(CACHE, 'node_modules');
  // THE CACHE ITSELF, checked before anything is cloned from it.
  //
  // ensureAstro only looks for astro/package.json, so a cache that was restored
  // half-written — or saved by a run that was cancelled mid-install — passes
  // that and produces a fixture that cannot read a content config. On CI that
  // surfaced as six content operations refusing, which reads as six product
  // failures and is one bad archive. A cache that is not whole is thrown away
  // and built again rather than cloned four hundred times.
  if (fs.existsSync(from) && !looksComplete(from)) {
    if (log) log(`the astro cache at ${CACHE} is incomplete; installing it again`);
    fs.rmSync(CACHE, { recursive: true, force: true });
    ensureAstro({ log });
  }
  const to = path.join(root, 'node_modules');
  // `cp -Rc` asks APFS for copy-on-write and is the fast path. It only works
  // within one volume, and on a CI runner the cache and the temp directory are
  // not always on the same one — so the failure is expected, and the plain copy
  // behind it is not a fallback for a broken machine but the ordinary path
  // there. What is NOT tolerable is a copy that half worked: that produced
  // fixtures whose node_modules had an astro/package.json and not much else,
  // and the only symptom was "notes is not a collection in this project" from
  // six scenarios, which reads as six product failures.
  let how = 'clone';
  try {
    execFileSync('cp', ['-Rc', from, to], { stdio: 'pipe' });
  } catch {
    how = 'copy';
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, dereference: false });
  }
  const missing = DEPS_LANDMARKS.filter((rel) => !fs.existsSync(path.join(to, rel)));
  // And roughly as many packages as the cache has: a copy that stopped partway
  // usually has the first few and not the rest, which no single landmark finds.
  const cached = fs.readdirSync(from).length;
  const copied = fs.existsSync(to) ? fs.readdirSync(to).length : 0;
  if (missing.length || copied < cached) {
    throw new Error(
      `the fixture's dependencies were ${how === 'clone' ? 'cloned' : 'copied'} incompletely — ` +
        `${copied} of ${cached} packages` +
        (missing.length ? `, missing ${missing.join(', ')}` : '') +
        ` (from ${from})`
    );
  }
  // A fixture that is not what it claims must say so HERE, with the reason.
  //
  // Without this a half-copied or stale node_modules produced "notes is not a
  // collection in this project" from six different scenarios — which reads as
  // six product failures and is one fixture failure. The check is the real
  // thing: read the content config the way the operations read it, and refuse
  // to hand back a fixture that cannot answer.
  if (!fs.existsSync(path.join(to, 'esbuild', 'package.json'))) {
    throw new Error('the fixture has no esbuild, so its content config cannot be read');
  }
  const astroPkg = path.join(to, 'astro', 'package.json');
  if (!fs.existsSync(astroPkg)) throw new Error('the fixture has no astro');
  return to;
}

// VERIFIED ONCE PER PROCESS, not once per fixture.
//
// What this checks is a property of the shared Astro cache, and every fixture
// is cloned from that same cache — so bundling a content config in all of them
// re-proves the same fact and pays for a child process and an esbuild service
// each time. On the permission matrix, which builds a fixture per operation per
// level, that was four hundred and forty-three redundant bundles and enough
// added minutes to time the CI job out.
/** Read the config once, so a fixture that cannot is rejected by name. */
async function verifyDeps(root, full) {
  // VERIFIED FOR EVERY FIXTURE THAT WILL READ A CONFIG.
  //
  // Memoising this on "it worked once" was a mistake: the first fixture to ask
  // for dependencies is page.dynamic_paths, which wants a dev server and never
  // reads a collection, so it set the flag and every content fixture after it
  // went unchecked. When those then answered "notes is not a collection in this
  // project" there was nothing to say whether the fixture or the product was at
  // fault — which is the exact confusion this function exists to prevent.
  //
  // The expensive part is a child process per fixture, and only the handful
  // that declare `deps` pay it. Fixtures that only want a dev server are
  // checked by installDeps' landmarks, which is what they need.
  if (!full) return;
  const { readContentConfig } = require('../../electron/contentConfig.js');
  let config = null;
  try {
    // NOT `force`. Forcing stops the config service and its esbuild and starts
    // them again — on the very fixture the scenario is about to use, and back
    // to back with it. On CI that left the next read answering cleanly with no
    // collections at all: no error to report, nothing to blame but the product.
    // A plain read proves the same thing and leaves the service it warmed.
    config = await readContentConfig(root);
  } catch (err) {
    throw new Error(`the fixture's content config could not be read: ${err?.message || err}`);
  }
  const names = (config?.collections || []).map((c) => c.name);
  if (names.includes('notes') && names.includes('links')) return;
  {
    throw new Error(
      `the fixture's content config resolved to [${names.join(', ') || 'nothing'}] — ` +
        `astro ${require(path.join(root, 'node_modules', 'astro', 'package.json')).version} in ${root}` +
        (config?.error ? `: ${config.error}` : '')
    );
  }
}

async function startWireRig({
  era = 'modern',
  agentMode = 'full',
  extra = {},
  withDeps = false,
  realDevServer = false,
  audit = null,
  // A PROJECT THIS RIG DID NOT BUILD.
  //
  // Everything above `project` describes the shared fixture — the one every
  // coverage scenario is written against, and the one Phase B was designed
  // against. `extra` can only ADD files to it; it cannot remove `Hero.astro`,
  // `--brand` or the two collections, so no overlay makes that fixture
  // unfamiliar. A held-out evaluation needs a project the surface under test
  // has never seen, so it hands one over whole and this rig opens it through
  // the app's own `loadProject` exactly as it opens the fixture.
  //
  // Its dependencies are the caller's business: `installDeps` writes the
  // fixture's own package.json, which would be wrong here, and `verifyDeps`
  // looks for the fixture's two collections, which a real project has no
  // reason to have. Both are skipped, and `realDevServer` therefore requires
  // that the caller has already installed them.
  project = null,
  log = () => {},
} = {}) {
  // The shared fixture plus what the wire scenarios need to assert anything
  // real: a dynamic route, a genuine image, a canary in robots.txt.
  const root = project || H.makeProject({ ...EXTRA, ...extra });
  if (!project) {
    writeBinary(fs, path, root);
    if (withDeps || realDevServer) {
      installDeps(root, log);
      await verifyDeps(root, withDeps);
    }
  } else if (realDevServer && !fs.existsSync(path.join(root, 'node_modules', 'astro'))) {
    throw new Error(`no astro is installed in ${root}; a held-out project must arrive with its dependencies`);
  }
  const harness = await H.start(root, { agentMode, realDevServer });

  // Skips past anything already listening: a port a previous rig has only just
  // let go of is still busy for a moment, and so is one another process took.
  let port = nextPort++;
  for (let tries = 0; tries < 200 && (await portTaken(port)); tries += 1) port = nextPort++;
  let token = `wire-rig-token-${port}-aaaaaaaaaaaa`;
  let url = `http://127.0.0.1:${port}/mcp`;

  const buildServer = (port, token) => createStackiMcpServer({
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
      // The product registers `audit` when the app hands one over. A rig that
    // omits it serves a 13-tool surface nobody has, which is how the agent
    // benchmark came to measure a server that does not exist.
    audit,
});

  // ASKING WHETHER A PORT IS FREE AND BINDING IT ARE TWO SEPARATE MOMENTS.
  //
  // Whatever the probe above learns is already history by the time listen()
  // runs: another suite's process, or one of ours on its way out, can take the
  // port in between. On a CI runner that is not hypothetical -- it took out the
  // permission matrix with "port 55555 is already in use, so the Stacki MCP
  // server did not start", a message about somebody else's Stacki that here
  // meant a lost race. Losing the race is now retried instead of thrown; every
  // other start failure still throws, because those are real.
  let server = buildServer(port, token);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await server.start?.();
      break;
    } catch (err) {
      const inUse = /already in use|EADDRINUSE/i.test(String(err?.message || err));
      if (!inUse || attempt >= 25) throw err;
      await Promise.resolve(server.stop?.()).catch(() => {});
      port = nextPort++;
      for (let tries = 0; tries < 200 && (await portTaken(port)); tries += 1) port = nextPort++;
      token = `wire-rig-token-${port}-aaaaaaaaaaaa`;
      url = `http://127.0.0.1:${port}/mcp`;
      server = buildServer(port, token);
    }
  }

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
  let stopProblems = [];
  const stop = async () => {
    if (stopped) return { problems: stopProblems };
    stopped = true;
    stopProblems = [];
    const closed = await closeClient();
    if (closed && closed.ok === false) stopProblems.push(`the MCP client would not close: ${closed.error}`);
    await server.stop?.();
    // NO DEV SERVER OUTLIVES THE FIXTURE IT SERVES.
    //
    // `devServer` is one module-level value in electron/main.js and the harness
    // loads main once, so a server a scenario forgets is still running when the
    // next scenario starts — pointed at a directory this teardown is about to
    // delete. That is how five scenarios could each pass alone and two of them
    // fail in the suite. Asked of main's own handler, so it is the real stop.
    // AND WHAT IT ANSWERED. dev:stop can now refuse — it returns
    // `{ ok:false }` rather than throwing when the port is still bound — and
    // this dropped the answer entirely, so a fixture was deleted out from under
    // a server that was still serving and the suite called it a clean teardown.
    // "There was nothing running" and "we owned one and could not stop it" are
    // the two states this whole file exists to keep apart.
    try {
      const stopDev = harness.handlers.get('dev:stop');
      if (stopDev) {
        const said = await stopDev(null);
        if (said && said.ok === false) stopProblems.push(said.message || 'the dev server would not stop');
      }
    } catch (err) {
      stopProblems.push(`stopping the dev server threw: ${String(err?.message || err)}`);
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
    // A PROJECT THIS RIG DID NOT BUILD IS NOT THIS RIG'S TO DELETE. The
    // held-out corpus is materialised, hashed and owned by its caller, and one
    // teardown that forgot the difference would remove the evidence the next
    // trial is measured against.
    if (!project) H.removeProject(root);
    return { problems: stopProblems };
  };

  return { root, harness, client, call, tool, stop, url, token, port, withDeps, realDevServer };
}

module.exports = { startWireRig, astroCached };
