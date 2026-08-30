// A whole Stacki, in one process, with no Electron.
//
// The Agent API is only interesting end to end. Every individual piece of it
// can be right — the ref resolves, the operation applies, the file is written
// — and the feature still be broken, because what it promises is a CHAIN: a
// human points at something, an agent asks Stacki what that is, changes it
// through Stacki, and the change is on the canvas, on the undo stack and on
// disk. A test that stubs any link in that chain is testing the link it wrote
// rather than the one that ships.
//
// So this builds the real thing:
//
//   electron/main.js       loaded with a stubbed `electron`. Every handler is
//                          the real one — the real Astro parser, the real
//                          serializer, the real content and CSS and git code.
//   src/App.jsx            bundled and rendered in jsdom, with its bridge
//                          wired to those handlers rather than to IPC.
//   electron/mcp/agent     the real API, with its `ask` wired to the App's own
//                          mcp:ask handler.
//
// What is NOT real: the canvas. There is no browser painting the page, so
// anything that can only be measured — computed styles, rendered classes, a
// screenshot — answers empty. Everything about SOURCE is exact, and source is
// what this feature is about.
//
// Not a test itself; the files that use it are agent-api.js and
// agent-acceptance.js.

const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- a project on disk -------------------------------------------------------

const FIXTURE = {
  'package.json': JSON.stringify({ name: 'agent-fixture', type: 'module', dependencies: { astro: '^5.0.0' } }, null, 2),
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",

  'src/styles/site.css': `:root {
  --gap: 1rem;
  --brand: #3355ff;
}

.pricing-grid {
  display: grid;
  gap: var(--gap);
}

.card {
  padding: 1rem;
  border: 1px solid #eee;
}
`,

  'src/data/site.json': JSON.stringify({ title: 'Fixture', tagline: 'A place to test things' }, null, 2),

  'src/components/Card.astro': `---
const { title, body } = Astro.props;
---
<article class="card">
  <h3>{title}</h3>
  <p>{body}</p>
</article>
`,

  'src/components/Hero.astro': `---
const { heading } = Astro.props;
---
<section class="hero">
  <h1>Welcome to Stacki</h1>
  <p>{heading}</p>
</section>
`,

  'src/layouts/Base.astro': `---
import '../styles/site.css';
---
<html lang="en">
  <head><title>Fixture</title></head>
  <body>
    <slot />
  </body>
</html>
`,

  'src/pages/index.astro': `---
import Base from '../layouts/Base.astro';
import Hero from '../components/Hero.astro';
import Card from '../components/Card.astro';
import site from '../data/site.json';

const plans = [
  { title: 'Starter', body: 'For one person' },
  { title: 'Team', body: 'For a few people' },
  { title: 'Company', body: 'For a lot of people' },
];
---
<Base>
  <Hero heading={site.tagline} />
  <div class="pricing-grid">
    {plans.map((plan) => (
      <Card title={plan.title} body={plan.body} />
    ))}
  </div>
  <footer>
    <p>Made carefully.</p>
  </footer>
</Base>
`,

  'src/pages/about.astro': `---
import Base from '../layouts/Base.astro';
---
<Base>
  <h1>About</h1>
  <p>Some words about the thing.</p>
</Base>
`,

  // A file Stacki does not model as a tree — the case `source` exists for.
  'src/lib/format.js': `export function money(n) {
  return \`$\${n.toFixed(2)}\`;
}
`,

  'public/robots.txt': 'User-agent: *\nAllow: /\n',

  // A content collection, so the content domain has something real to read and
  // write rather than an empty project's shrug.
  'src/content.config.ts': `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: z.object({
    title: z.string(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { notes };
`,

  'src/content/notes/first.md': `---
title: The first note
draft: false
---

Something worth writing down.
`,

  'src/content/notes/second.md': `---
title: The second note
draft: true
---

And another.
`,
};

/** Write the fixture into a fresh temporary folder and answer with its path. */
function makeProject(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-agent-'));
  for (const [rel, body] of Object.entries({ ...FIXTURE, ...extra })) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}

const removeProject = (root) => {
  // Retried, because a fixture with dependencies in it is being let go of by
  // processes that have only just been asked to stop — an esbuild binary still
  // mapped out of node_modules will refuse the first attempt and allow the
  // second. The comment here used to say a folder that will not go is not a
  // test failure; it is exactly that, and test/support/ownedResidue.js says so
  // now, so the least this can do is try more than once.
  // Long enough to outlast an esbuild binary still being unmapped out of the
  // fixture's node_modules — the case that used to leave a 52K fragment behind.
  // The residue check no longer removes anything itself, so this is the only
  // thing that does, and it has to be patient enough to be the whole answer.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      if (!fs.existsSync(root)) return;
    } catch {
      /* still held; wait and try again */
    }
    // A short pause, without spinning: a busy-wait here would hold the very
    // event loop the operating system needs to finish letting the files go.
    try {
      execFileSync('sleep', ['0.15'], { stdio: 'ignore' });
    } catch {
      /* nothing to wait with; the next attempt is immediate */
    }
  }
};

// --- the main process --------------------------------------------------------

let mainLoaded = null;

/**
 * Load electron/main.js with a stubbed `electron`, once.
 *
 * Every `ipcMain.handle` it registers is captured, which is the same map the
 * real process's own recorder holds — so `callMain` here reaches exactly the
 * function the Pages panel reaches in the shipped app.
 */
function loadMain() {
  if (mainLoaded) return mainLoaded;
  const Module = require('module');
  const handlers = new Map();
  const sent = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-agent-userdata-'));
  // Taken back when this process ends. One per run is easy to overlook and adds
  // up to gigabytes across a working day — there were three hundred and
  // sixty-five of these on this machine before anybody counted.
  process.on('exit', () => {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* going away with the process anyway */
    }
  });

  const electron = {
    app: {
      getPath: () => userData,
      getVersion: () => '0.0.0-test',
      // Never resolves: the app's own startup must not run here.
      whenReady: () => new Promise(() => {}),
      on() {},
      setName() {},
      setAboutPanelOptions() {},
      requestSingleInstanceLock: () => true,
      isPackaged: false,
      dock: { setIcon() {} },
      quit() {},
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      getAllDisplays: () => [],
    },
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on() {},
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    // Deleting through Stacki puts a file in the trash rather than unlinking it,
    // which is the right behaviour and is not available here. Removing it is
    // near enough for a fixture in a temporary folder.
    shell: {
      openExternal() {},
      trashItem: async (target) => {
        fs.rmSync(target, { recursive: true, force: true });
      },
    },
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
    protocol: { handle() {}, registerSchemesAsPrivileged() {} },
    net: { fetch: () => Promise.reject(new Error('the fixture has no network')) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    clipboard: {
      writeText(text) {
        sent.push({ clipboard: text });
      },
      readText: () => '',
    },
  };

  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') return { autoUpdater: { on() {}, checkForUpdatesAndNotify() {} } };
    return orig.call(this, request, ...rest);
  };
  try {
    require('../electron/main.js');
  } finally {
    Module._load = orig;
  }

  const callMain = async (channel, payload) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn(null, payload);
  };
  mainLoaded = { handlers, callMain, userData, sent };
  return mainLoaded;
}

// --- the renderer ------------------------------------------------------------

let bundlePath = null;

async function buildApp() {
  if (bundlePath) return bundlePath;
  const esbuild = require('esbuild');
  const dir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'agent-app.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'App.jsx')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });
  bundlePath = out;
  return out;
}

/** A jsdom window with everything the app touches on a machine that has none. */
function makeDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.MutationObserver = dom.window.MutationObserver;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext || class {};
  dom.window.WebGLRenderingContext = global.WebGLRenderingContext;
  global.WebGL2RenderingContext = dom.window.WebGL2RenderingContext || class {};
  dom.window.WebGL2RenderingContext = global.WebGL2RenderingContext;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // The handful of DOM methods jsdom leaves unimplemented and the app calls
  // unconditionally. Each one throws rather than returning undefined, which
  // takes a render down over something that only matters on a screen.
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy', 'showPopover', 'hidePopover', 'releasePointerCapture', 'setPointerCapture']) {
    if (!dom.window.Element.prototype[name]) dom.window.Element.prototype[name] = function () {};
  }
  if (!dom.window.Element.prototype.animate) {
    dom.window.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });
  }
  return dom;
}

const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

/**
 * Start the whole stack against one project.
 *
 * Answers the two things a test wants: `api`, which is the Agent API exactly
 * as the MCP tools call it, and a handful of levers for playing the part of
 * the human — select something, edit a file behind the agent's back, read what
 * is on disk.
 */
async function start(root, { agentMode = 'full', realDevServer = false } = {}) {
  const { handlers, callMain } = loadMain();
  const dom = makeDom();

  // Everything the app publishes about itself, kept so the API can read it the
  // way the real main process does.
  let payload = null;
  // Where main's dev server is, as of the last start or stop that went through
  // this bridge — the harness's stand-in for reading `devServer` in main.
  let devUrlNow = null;
  // The app's own answer to an mcp:ask, registered by its effect.
  let askHandler = null;
  const replies = new Map();
  let nextAsk = 1;

  const bridge = new Proxy(
    {
      platform: 'darwin',
      settings: async () => ({ sound: false, agentMode }),
      // How the app reopens what was last open — which is how the fixture gets
      // opened here, through the app's own loadProject rather than by poking
      // state into it.
      pendingProject: async () => root,
      // The fixture has no node_modules and must not try to acquire any: a
      // test that runs `npm install` is a test that fails on an aeroplane.
      hasNodeModules: async () => ({ has: true }),
      // A REAL SERVER WHEN THERE IS ONE TO START.
      //
      // A fixture built with its dependencies installed can run the project's
      // own Astro, so these go to main's real handlers rather than round them —
      // which is the only way project.dev_start, dev_status and probe can be
      // about anything. Without dependencies they REFUSE BY THROWING, because
      // that is what production does: doDevStart either answers with a url or
      // throws, and the resolved `{ error }` this used to hand back walked
      // straight past startPreview's catch and left the app reporting a preview
      // that was on with no address.
      startDevServer: realDevServer
        ? (projectPath) =>
            Promise.resolve()
              .then(() => handlers.get('dev:start')(null, projectPath || root))
              .then((r) => {
                devUrlNow = r?.url || null;
                return r;
              })
        : async () => {
            throw new Error('the fixture has no dev server');
          },
      stopDevServer: realDevServer
        ? () =>
            Promise.resolve()
              .then(() => handlers.get('dev:stop')(null))
              .then((r) => {
                devUrlNow = null;
                return r;
              })
        : async () => ({ ok: true }),
      diagnoseDev: async () => ({ kind: realDevServer ? 'ready' : 'no-deps' }),
      probeDevPage: realDevServer
        ? (url) => Promise.resolve().then(() => handlers.get('dev:probe')(null, url))
        : async () => null,
      refreshThumb: async () => null,
      watchProject: async () => ({ ok: true }),
      mcpPublish: async (next) => {
        payload = next;
        return 1;
      },
      mcpStatus: async () => ({ running: false }),
      mcpReply: async ({ id, value }) => {
        replies.get(id)?.(value);
        return { ok: true };
      },
      onMcpAsk: (cb) => {
        askHandler = cb;
        return () => {
          askHandler = null;
        };
      },
      getFilePath: () => null,
      // Reviews are the ledger's, and the ledger wants a userData path it has
      // not been given here; a fixture has no comments in it.
      reviewsList: async () => ({ reviews: [], problem: null, shared: null }),
      reviewsSyncAnchors: async () => ({ ok: true }),
      gitInfo: async () => ({ isRepo: false, branch: null }),
      gitLog: async () => ({ commits: [], atEnd: true }),
      gitWorktrees: async () => [],
      gitStatus: async () => [],
      onCssChanged: () => () => {},
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        if (prop.startsWith('on')) return () => () => {};
        // Everything else is one of main's own handlers, under the name the
        // preload gives it.
        const channel = CHANNEL_OF[prop];
        // Always a promise, whatever the handler returns. ipcRenderer.invoke
        // gives one unconditionally, and half the app's effects call .then on
        // the result — a handler that answers `null` synchronously would take
        // the whole first render down.
        if (channel && handlers.has(channel)) {
          return (arg) => Promise.resolve().then(() => handlers.get(channel)(null, arg));
        }
        return async () => null;
      },
    }
  );
  dom.window.avb = bridge;
  global.avb = bridge;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const App = require(await buildApp()).default;

  // React reports render problems through console.error, and a fixture with no
  // preview produces a few that mean nothing here. Restored in a finally: a
  // render that throws with the reporter still muted is a test that fails in
  // silence, which is worse than a noisy one.
  const noisy = console.error;
  console.error = () => {};
  const rootEl = document.getElementById('root');
  const reactRoot = createRoot(rootEl);
  try {
    require('react-dom').flushSync(() => {
      reactRoot.render(React.createElement(App));
    });
  } finally {
    console.error = noisy;
  }

  // The renderer round trip, the way electron/mcp/index.js does it.
  const ask = (kind, params, timeoutMs = 15000) =>
    new Promise((resolve) => {
      if (!askHandler) return resolve(null);
      const id = nextAsk++;
      const timer = setTimeout(() => {
        replies.delete(id);
        resolve(null);
      }, timeoutMs);
      replies.set(id, (value) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(value);
      });
      void askHandler({ id, kind, params });
    });

  const { createAgentApi } = require('../electron/mcp/agent');
  const { selectionTrail } = require('../electron/selectionTrail');
  const { locateSelection } = require('../electron/astroParser');
  let mode = agentMode;

  const api = createAgentApi({
    getProjectRoot: () => root,
    getAgentMode: () => mode,
    callMain,
    ask,
    readPayload: () => payload,
    // The same authority the app gives it: main's own dev server, asked
    // through the handler rather than read out of a closure.
    getDevUrl: () => devUrlNow,
    resolveTrail: (keys) => selectionTrail({ projectPath: root, keys }, locateSelection),
    version: '0.0.0-test',
  });

  // Open the project the way the app does: scan, then a page.
  await callMain('project:scan', root);
  await settle(20);
  await api.run('project', 'info');

  return {
    api,
    callMain,
    handlers,
    // The three doors the MCP wiring gives the review ledger, so a test can
    // wire the ledger up the way electron/mcp/index.js does.
    ask,
    payload: () => payload,
    resolveTrail: (keys) => selectionTrail({ projectPath: root, keys }, locateSelection),
    setMode: (next) => {
      mode = next;
    },
    settle,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    write: (rel, text) => {
      // Makes the directories on the way. A fixture that can only write beside
      // files that already exist cannot set up a nested case, and every caller
      // that wanted one had to reach past this helper to do it.
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    },
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    stop: () => {
      try {
        reactRoot.unmount();
      } catch {
        /* a root that will not unmount does not fail a test */
      }
      dom.window.close();
    },
  };
}

// What the preload calls each handler, so the bridge proxy can find it.
// Generated from electron/preload.js so the two cannot drift.
const CHANNEL_OF = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const body = source.slice(source.indexOf('contextBridge.exposeInMainWorld'));
  const out = {};
  for (const m of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*invoke\('([^']+)'\)/gm)) out[m[1]] = m[2];
  return out;
})();

module.exports = { makeProject, removeProject, start, loadMain, settle, FIXTURE, CHANNEL_OF };
