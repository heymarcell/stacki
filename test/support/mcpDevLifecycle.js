// dev_start, dev_stop, probe, dev_status and install — for real.
//
// These four were graded BOUNDARY with the reason "spawns a real Astro process
// and binds a port" / "reaches the network". That is not an external
// production side effect. It is a local process this repository already knows
// how to own: test/agent-canvas-fixture.js installs Astro once into a cache and
// copies it, and several suites already run real dev servers.
//
// So they are FULL now, and the postconditions are the ones that matter:
//
//   dev_start   a server this test owns is listening and answers HTTP
//   probe       that same URL is reported as reachable
//   dev_status  the app agrees a preview is running
//   dev_stop    the exact owned process is gone and the port is free again
//   install     the package manager really ran and node_modules really appeared
//
// OWNERSHIP. Everything here is spawned by this file, on a port it chose, in a
// fixture it made. Nothing greps for "an astro process". The stop assertions
// check the port rather than a name, because a port is the thing a leak
// actually costs somebody.
//
// install uses a `file:` dependency packaged inside the fixture, so the real
// npm path runs to a successful conclusion with no registry and no network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

/** Is anything listening there? Used to prove a stop, not to find a victim. */
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 700);
  });
}

const until = async (what, fn, timeoutMs = 90000, everyMs = 400) => {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
};

// ── install ────────────────────────────────────────────────────────────────
//
// A tiny package inside the fixture, depended on by `file:`. The real
// `project:install` handler runs the real package manager; nothing is mocked,
// and nothing is fetched.

const LOCAL_DEP = {
  'vendor/wire-dep/package.json': JSON.stringify({ name: 'wire-dep', version: '1.0.0', main: 'index.js' }, null, 2),
  'vendor/wire-dep/index.js': "module.exports = 'installed by the wire test';\n",
};

async function install({ call, fixture }) {
  const root = fixture.root;
  // Give the fixture a dependency it can install without a registry.
  for (const [rel, text] of Object.entries(LOCAL_DEP)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  }
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  // Only the local one: installing astro here would be a download.
  pkg.dependencies = { 'wire-dep': 'file:vendor/wire-dep' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

  const { envelope } = await call('project', 'install', {});
  const landed = fs.existsSync(path.join(root, 'node_modules', 'wire-dep', 'index.js'));
  const lock = fs.existsSync(path.join(root, 'package-lock.json'));
  const deps = await call('project', 'dependencies', {});

  fixture.observedWorld('looked for node_modules on disk after the package manager ran');
  return {
    envelope,
    checks: [
      ['the package manager really installed the local dependency', landed],
      ['and wrote a lockfile', lock],
      ['and project.dependencies now reports the project as installed', deps.envelope?.installed === true],
    ],
  };
}

// ── the dev server ─────────────────────────────────────────────────────────
//
// One real Astro project per lifecycle run, started and stopped through MCP.

async function devStart({ call, fixture }) {
  const { envelope } = await call('project', 'dev_start', {});
  const url = envelope?.url || envelope?.href || null;
  const port = url ? Number(new URL(url).port) : null;
  fixture.scratch.devUrl = url;
  fixture.scratch.devPort = port;

  try {
    const answered = url
      ? await until('the dev server to answer', async () => {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
            return res.status > 0;
          } catch {
            return false;
          }
        })
      : null;

    fixture.observedWorld('connected to the port the dev server bound, and asked it for a page');
    return {
      envelope,
      checks: [
        ['starting answers with the URL it bound', typeof url === 'string' && url.startsWith('http')],
        ['a port really is listening', port ? await portBusy(port) : false],
        ['and the server answers an HTTP request', answered === true],
        ['and the app agrees a preview is running', envelope?.status === 'on'],
      ],
    };
  } finally {
    // What this scenario started, this scenario stops. It used to leave the
    // server up, and the fixture underneath it was then deleted — so a later
    // scenario asked a live process about a directory that no longer existed.
    await call('project', 'dev_stop', {});
    if (port) await until('the port to be released', async () => !(await portBusy(port)), 30000, 300);
  }
}

/**
 * A server of this scenario's own, started and stopped inside it.
 *
 * Every scenario gets a fresh fixture, so there is no server left running by a
 * neighbour to ask about — `probe` and `dev_status` used to read a
 * `fixture.scratch` that only `dev_start` ever filled in, in a different rig,
 * and so asked their questions of a project with nothing running. Each one
 * raises its own now, and puts it down again whatever happens.
 */
async function withServer({ call, fixture }, body) {
  const started = await call('project', 'dev_start', {});
  const url = started.envelope?.url || null;
  const port = url ? Number(new URL(url).port) : null;
  try {
    return await body({ url, port, started });
  } finally {
    await call('project', 'dev_stop', {});
    if (port) await until('the port to be released', async () => !(await portBusy(port)), 30000, 300);
  }
}

async function probe(ctx) {
  const { call, fixture } = ctx;
  return withServer(ctx, async ({ url, port }) => {
    // ONE subject call, with no url of its own: the operation has to find the
    // running preview from the context, which is both the harder case and what
    // an agent that never called dev_start does. The URL it must have found is
    // checked against the one the server really bound, and against what that
    // address answers when this test asks it directly.
    const { envelope } = await call('project', 'probe', {});
    const direct = await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 0);
    fixture.observedWorld('asked the running dev server for a page over HTTP itself');
    return {
      envelope,
      checks: [
        ['probing with no URL finds the preview that is running', envelope?.ok === true],
        ['and reports the status it really answered with', envelope?.status === direct && direct >= 200],
        ['which is the server this scenario started', typeof url === 'string' && url.includes(String(port))],
      ],
    };
  });
}

async function devStatus(ctx) {
  const { call, fixture } = ctx;
  return withServer(ctx, async ({ url }) => {
    const { envelope } = await call('project', 'dev_status', {});
    const answered = await fetch(String(envelope?.url || ''), { signal: AbortSignal.timeout(5000) })
      .then((r) => r.status)
      .catch(() => 0);
    fixture.observedWorld('compared what the app says about the preview against the server actually answering');
    return {
      envelope,
      checks: [
        ['it reports what the preview is doing', typeof envelope?.status === 'string'],
        ['with a server running it says so', envelope?.status === 'on'],
        ['and names the address that server bound', envelope?.url === url && typeof url === 'string'],
        ['which really answers HTTP', answered >= 200],
      ],
    };
  });
}

/**
 * A SERVER OF ITS OWN, like probe and dev_status.
 *
 * This read `fixture.scratch.devPort`, which only devStart ever writes — and
 * the runner hands every scenario a fresh rig with `scratch: {}`. So `port` was
 * always undefined and both port assertions short-circuited to the literal
 * `true`, leaving `!!envelope` as the only surviving check: a dev_stop that
 * returned `{ ok: true }` and left Astro running with the port still bound
 * passed. The one operation whose whole job is a port going quiet never asked
 * about a port.
 *
 * It cannot use `withServer` — that stops the server in its own `finally`, and
 * a FULL scenario gets exactly one call to the operation it is registered for.
 * So the server is raised here and dev_stop is the only stop; if it fails, the
 * rig's teardown still asks main's own `dev:stop` directly, so nothing leaks.
 */
async function devStop({ call, fixture }) {
  const started = await call('project', 'dev_start', {});
  const url = started.envelope?.url || null;
  const port = url ? Number(new URL(url).port) : null;
  const listening = port ? await portBusy(port) : false;

  const { envelope } = await call('project', 'dev_stop', {});

  const freed = port ? await until('the port to be released', async () => !(await portBusy(port)), 30000, 300) : null;
  const stillAnswering = port ? await portBusy(port) : true;
  const after = await call('project', 'dev_status', {});
  fixture.observedWorld('connected to the port the preview bound, before the stop and after it');
  return {
    envelope,
    checks: [
      ['a server really was listening before the stop', listening === true],
      ['stopping reports the preview off, with no address', envelope?.status === 'off' && envelope?.url === null],
      ['the port that server bound is free again', freed !== null],
      ['and nothing answers there any more', stillAnswering === false],
      ['the app agrees no preview is running', after.envelope?.status === 'off'],
      ['with no address left to give for one', after.envelope?.url === null],
    ],
  };
}

module.exports = { install, devStart, devStop, devStatus, probe, portBusy, until, LOCAL_DEP };
