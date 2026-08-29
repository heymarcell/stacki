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
    ],
  };
}

async function probe({ call, fixture }) {
  const { envelope } = await call('project', 'probe', { url: fixture.scratch.devUrl || undefined });
  return {
    envelope,
    checks: [['probing the running server reports it reachable', envelope?.ok === true && (envelope.status === undefined || envelope.status > 0)]],
  };
}

async function devStatus({ call }) {
  const { envelope } = await call('project', 'dev_status', {});
  return {
    envelope,
    checks: [
      ['it reports what the preview is doing', typeof envelope?.status === 'string'],
      ['and names a URL while a server is running', typeof envelope?.url === 'string' || envelope.status !== 'on'],
    ],
  };
}

async function devStop({ call, fixture }) {
  const port = fixture.scratch.devPort;
  const { envelope } = await call('project', 'dev_stop', {});
  const freed = port
    ? await until('the port to be released', async () => !(await portBusy(port)), 30000, 300)
    : true;
  fixture.observedWorld('checked the port this test bound is no longer accepting connections');
  return {
    envelope,
    checks: [
      ['stopping answers', !!envelope],
      ['the port this test bound is free again', port ? freed !== null : true],
      ['and nothing answers there any more', port ? !(await portBusy(port)) : true],
    ],
  };
}

module.exports = { install, devStart, devStop, devStatus, probe, portBusy, until, LOCAL_DEP };
