// What actually ends up inside the app you ship.
//
//   node test/packaging.js
//
// Packaging failures are the worst kind: everything works on the machine that
// built it, and the shipped app is quietly missing a file. There is no crash to
// read — a require throws somewhere nobody is watching and a feature just isn't
// there any more.
//
// Stacki has had exactly that. `electron/astroParser.js` is unpacked from
// app.asar because the Astro dev server — a separate node process, which cannot
// read inside an archive — requires it from the generated preview config. But
// `electron/htmlText.js`, which astroParser itself requires, was left inside the
// archive. So the config threw at load time, Stacki fell back to a bare dev
// server, and the packaged app came up with a preview that had no markers, no
// outlines, no click-to-select and nothing for an agent to describe. In
// development it was perfect.
//
// The rule that would have caught it is not "remember htmlText": it is that
// unpacking a module and not unpacking what it requires is never right. That is
// what this checks, along with the other two ways the archive can come up
// short — a dependency the main process needs that was never marked for
// shipping, and a native binding that cannot be loaded from inside an archive
// at all.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = pkg.build?.files || [];
const unpacked = pkg.build?.asarUnpack || [];
const deps = pkg.dependencies || {};
const devDeps = pkg.devDependencies || {};

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// Everything under electron/, which is the main process and its modules.
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};
const mainSide = walk(path.join(root, 'electron'));
check('there is a main process to check', mainSide.length > 20, `${mainSide.length} files`);

const RELATIVE = /require\(\s*'(\.[^']*)'\s*\)/g;
const BARE = /require\(\s*'([^'.][^']*)'\s*\)/g;

/** Where a relative require resolves to, or null. */
const resolveRelative = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

// ── Every relative require points at a file that exists ─────────────────────
//
// A renamed module is a crash on first use, in whichever feature happened to
// need it, and nowhere else.

for (const file of mainSide) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(RELATIVE)) {
    check(
      `${path.relative(root, file)} requires ${m[1]}, which exists`,
      !!resolveRelative(file, m[1]),
      'the module was renamed or moved'
    );
  }
}

// ── Unpacking a module means unpacking what it requires ─────────────────────
//
// asarUnpack exists for files a SEPARATE process has to read: node cannot see
// inside app.asar, so anything handed to the dev server, or any native binding,
// has to sit beside the archive as a real file. A module out there whose own
// requires are still inside it cannot load — and the failure lands in the other
// process, where nothing in this app is watching.

const unpackedFiles = unpacked
  .filter((p) => p.startsWith('electron/') && p.endsWith('.js') && !p.includes('*'))
  .map((p) => path.join(root, p));

check(
  'something of the main process is unpacked at all',
  unpackedFiles.length > 0,
  'build.asarUnpack lists no electron/ file — has the preview config stopped requiring one?'
);

const reachable = (entry, seen = new Set()) => {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  let text;
  try {
    text = fs.readFileSync(entry, 'utf8');
  } catch {
    return seen;
  }
  for (const m of text.matchAll(RELATIVE)) {
    const target = resolveRelative(entry, m[1]);
    if (target) reachable(target, seen);
  }
  return seen;
};

for (const entry of unpackedFiles) {
  const rel = path.relative(root, entry);
  for (const needed of reachable(entry)) {
    const neededRel = path.relative(root, needed);
    check(
      `${neededRel} is unpacked — ${rel} requires it from outside app.asar`,
      unpacked.includes(neededRel),
      'add it to build.asarUnpack; a module beside the archive cannot require one inside it'
    );
  }
}

// ── …and the closure has to LOAD out there, not merely be named ─────────────
//
// The walk above is a regex over the source: it sees `require('./htmlText')`
// and nothing else. A specifier built at runtime, a JSON file, a directory
// resolved through its index — none of them are in it, and each is a module
// that could be missing from beside the archive with every static check above
// still passing. Naming is not loading.
//
// So the unpacked files are copied into an empty directory and required there,
// in a plain node process. That directory IS the packaged condition:
// app.asar.unpacked holds exactly what asarUnpack names and nothing else, and
// the Astro dev server — plain Node, which cannot read inside the archive — has
// only that to work with. Anything the entry reaches for that is not there
// throws here, in this suite, instead of in another process nobody is watching.

check(
  'the parser the preview config requires is the one that gets unpacked',
  /astroParser\.js/.test(fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')),
  'main.js no longer names it — has the generated config stopped requiring it?'
);

/** Empty stderr if the entry loads with only its unpacked closure around it. */
const loadsAlone = (entry) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-packaging-closure-'));
  try {
    for (const needed of reachable(entry)) {
      const neededRel = path.relative(root, needed);
      // Only what asarUnpack actually names. Anything else is still inside the
      // archive as far as the dev server is concerned, which is the point.
      if (!unpacked.includes(neededRel)) continue;
      const to = path.join(dir, neededRel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(needed, to);
    }
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(dir, path.relative(root, entry)))})`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      timeout: 30000,
    });
    return '';
  } catch (err) {
    return String(err.stderr || err.message).split('\n').find((l) => /Error/.test(l)) || 'it threw';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// One of them has to reach further than itself, or the walk above is reporting
// success over nothing. The leaves of the closure — htmlText is one — are
// rightly lone files; the entry the dev server loads is not.
check(
  'an unpacked entry pulls in more than itself, so there is a closure to check',
  unpackedFiles.some((entry) => reachable(entry).size > 1),
  unpackedFiles.map((e) => `${path.relative(root, e)}: ${reachable(e).size}`).join(', ')
);

for (const entry of unpackedFiles) {
  const rel = path.relative(root, entry);
  const error = loadsAlone(entry);
  check(`${rel} loads beside the archive, with only what asarUnpack names around it`, !error, error);
}

// ── Everything the main process requires is actually shipped ────────────────
//
// A package under devDependencies is not copied into the app at all. It works
// in `npm run dev`, where node_modules is simply there, and is missing in the
// build — the same shape of failure as the one above, one layer out.

const builtin = new Set(Module.builtinModules);
const packageOf = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

const required = new Map(); // package -> files that require it
for (const file of mainSide) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(BARE)) {
    const name = packageOf(m[1]);
    if (name === 'electron' || builtin.has(name) || name.startsWith('node:')) continue;
    if (!required.has(name)) required.set(name, []);
    const where = path.relative(root, file);
    if (!required.get(name).includes(where)) required.get(name).push(where);
  }
}

check('the main process requires something from node_modules', required.size > 3, `${required.size}`);

for (const [name, where] of [...required].sort()) {
  check(
    `${name} ships with the app`,
    !!deps[name],
    `required by ${where.join(', ')} but only in devDependencies or nowhere — it will be missing from the build`
  );
  check(`${name} is not a dev dependency`, !devDeps[name], 'a dev dependency is never copied into the app');
  check(
    `${name} resolves`,
    (() => {
      try {
        require.resolve(name + '/package.json', { paths: [root] });
        return true;
      } catch {
        try {
          require.resolve(name, { paths: [root] });
          return true;
        } catch {
          return false;
        }
      }
    })(),
    'run npm install'
  );
}

// ── Native bindings cannot be loaded from inside an archive ─────────────────
//
// dlopen needs a real path on disk. A production dependency that ships a .node
// binary and is not unpacked throws the moment it is required, in the shipped
// app only.

const nativeIn = (dir, depth = 0) => {
  if (depth > 4) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = nativeIn(full, depth + 1);
      if (found) return found;
    } else if (entry.name.endsWith('.node')) return full;
  }
  return null;
};

const coversPackage = (name) =>
  unpacked.some((p) => p.includes(`node_modules/${name}/`) || p.includes(`node_modules/${name}/**`));

let natives = 0;
for (const name of required.keys()) {
  const dir = path.join(root, 'node_modules', name);
  const binary = nativeIn(dir);
  if (!binary) continue;
  natives++;
  check(
    `${name} is unpacked — it ships a native binding`,
    coversPackage(name),
    `${path.relative(root, binary)} cannot be dlopen'd from inside app.asar`
  );
}
check('the native check found the one native dependency there is', natives >= 1, `${natives} found`);

// ── The reference Shared Reviews service is NOT the app ─────────────────────
//
// `service/` is a program somebody runs on a machine of their own. It has a
// database, it listens on a port, and it has no business inside a desktop
// application — shipping it would put a server in every install of Stacki,
// and would mean an experimental node built-in (node:sqlite) became a runtime
// dependency of the editor. So the boundary is checked in both directions:
// nothing packages it, and nothing in the main process reaches into it.

const serviceDir = path.join(root, 'service');
if (fs.existsSync(serviceDir)) {
  check(
    'the reference reviews service is not packaged',
    !files.some((f) => f.startsWith('service')),
    JSON.stringify(files.filter((f) => f.includes('service')))
  );
  check('nor unpacked beside the archive', !unpacked.some((f) => f.startsWith('service')), JSON.stringify(unpacked));
  for (const file of mainSide) {
    const text = fs.readFileSync(file, 'utf8');
    check(
      `${path.relative(root, file)} does not require the reviews service`,
      !/require\(\s*'[^']*\/service\//.test(text),
      'the desktop app must work with no server anywhere'
    );
  }
  // The other direction is allowed and deliberate: the service imports the
  // event model from electron/review/events.js rather than keeping a second
  // opinion about what an event is. That module must therefore stay free of
  // anything Electron.
  const eventModel = path.join(root, 'electron', 'review', 'events.js');
  check('the event model exists where the service expects it', fs.existsSync(eventModel));
  check(
    'and needs nothing from Electron',
    !/require\(\s*'electron'\s*\)/.test(fs.readFileSync(eventModel, 'utf8')),
    'the service loads it in a plain node process'
  );
  // And it must not need anything from node_modules either, or a self-hosted
  // service would need the app's dependency tree to run.
  for (const m of fs.readFileSync(eventModel, 'utf8').matchAll(BARE)) {
    const name = packageOf(m[1]);
    check(`the event model's require of ${m[1]} is a node builtin`, builtin.has(name) || m[1].startsWith('node:'), 'the service must run without the app installed');
  }
}

// ── The relays are NOT the app, and one shared file is ──────────────────────
//
// `relay/` holds two programs somebody runs somewhere else — a Node server with
// a database, and a Cloudflare Worker with Wrangler and a Vitest toolchain in
// its own package.json. None of that belongs inside a desktop application, and
// the Cloudflare half in particular would drag a deployment CLI into every
// install of Stacki.
//
// Exactly ONE file crosses: `relay/protocol.js`, the envelope format. It is
// shared rather than duplicated because three implementations of "is this
// envelope well formed" is three different answers, and the two that are wrong
// are a client whose comments a relay silently drops and a relay that stores
// whatever it is handed.

const relayDir = path.join(root, 'relay');
if (fs.existsSync(relayDir)) {
  check('the shared envelope format is packaged', files.includes('relay/protocol.js'), JSON.stringify(files));
  check(
    'the Node relay is not packaged',
    !files.some((f) => f.startsWith('relay/node')),
    JSON.stringify(files.filter((f) => f.includes('relay')))
  );
  check(
    'the Cloudflare Worker is not packaged',
    !files.some((f) => f.startsWith('relay/cloudflare')),
    JSON.stringify(files.filter((f) => f.includes('relay')))
  );
  check(
    'no relay directory is packaged wholesale',
    !files.some((f) => /^relay\/(\*|\*\*)/.test(f) || f === 'relay' || f === 'relay/**/*'),
    JSON.stringify(files.filter((f) => f.includes('relay')))
  );
  check('no relay file is unpacked beside the archive', !unpacked.some((f) => f.startsWith('relay')), JSON.stringify(unpacked));

  // Cloudflare's toolchain lives in its own package.json and must not leak
  // into the app's. Wrangler in `dependencies` would be shipped; in
  // `devDependencies` it would still be somebody's mistake waiting to happen.
  for (const name of ['wrangler', '@cloudflare/vitest-plugin', '@cloudflare/vitest-pool-workers', '@cloudflare/workers-types', 'miniflare', 'vitest']) {
    check(`${name} is not a dependency of the app`, !deps[name], 'Cloudflare tooling has its own package.json in relay/cloudflare');
    check(`${name} is not a dev dependency of the app either`, !devDeps[name], 'it belongs to relay/cloudflare, not to Stacki');
  }
  const cfPkg = path.join(relayDir, 'cloudflare', 'package.json');
  if (fs.existsSync(cfPkg)) {
    const cf = JSON.parse(fs.readFileSync(cfPkg, 'utf8'));
    check('the Cloudflare package keeps its own tooling', !!(cf.devDependencies || {}).wrangler, JSON.stringify(cf.devDependencies));
    check('and is marked private so it is never published', cf.private === true);
    check('and has no runtime dependencies at all', Object.keys(cf.dependencies || {}).length === 0, JSON.stringify(cf.dependencies));
  }
  // A deployment config with credentials in it would be a secret in the repo
  // and, if the glob ever widened, a secret in the shipped app.
  const wrangler = path.join(relayDir, 'cloudflare', 'wrangler.jsonc');
  if (fs.existsSync(wrangler)) {
    const text = fs.readFileSync(wrangler, 'utf8');
    check('the Cloudflare config carries no account id', !/account_id/.test(text), 'deployment credentials do not belong in the repository');
    check('nor an API token', !/api_token|CLOUDFLARE_API/.test(text));
    check('nor a production route', !/"routes"|"route"/.test(text), 'routes are attached at deploy time, deliberately');
  }
  // No relay database, ever, anywhere near the build.
  for (const stray of ['relay.db', 'relay.db-wal', 'relay.db-shm']) {
    check(`no ${stray} is committed`, !fs.existsSync(path.join(relayDir, 'node', stray)));
  }

  // THE RELAY CANNOT READ A REVIEW, and this is the check that says so about
  // the code rather than about the intention: neither implementation imports
  // Stacki's event model. A relay that could parse a review event is a relay
  // that could be asked to.
  const relayFiles = [];
  const walkRelay = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.wrangler') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkRelay(full);
      else if (/\.(js|mjs|jsx)$/.test(entry.name)) relayFiles.push(full);
    }
  };
  walkRelay(relayDir);
  check('there is a relay to check', relayFiles.length >= 4, `${relayFiles.length} files`);
  for (const file of relayFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const where = path.relative(root, file);
    // An IMPORT, not a mention: these files explain in their own comments why
    // they must not do this, and a grep for the path alone would flag the
    // explanation.
    check(
      `${where} does not import Stacki's review events`,
      !/(?:require\(\s*|from\s+)['"][^'"]*review\/events/.test(text),
      'a relay that can parse a review event is a relay that could be asked to'
    );
    check(
      `${where} does not reach into electron/`,
      !/require\(\s*['"][^'"]*electron\//.test(text) && !/from\s+['"][^'"]*electron\//.test(text),
      'the relay runs on machines that have never had Stacki installed'
    );
  }

  // The shared file has to run in Node AND in a Worker, so it may require
  // nothing at all.
  const protocol = path.join(relayDir, 'protocol.js');
  check('the shared envelope format exists', fs.existsSync(protocol));
  if (fs.existsSync(protocol)) {
    const text = fs.readFileSync(protocol, 'utf8');
    check('the shared envelope format requires nothing', !/\brequire\(/.test(text), 'it runs unchanged in Node and in workerd');
    check('and imports nothing', !/^\s*import\s/m.test(text));
    check('and knows nothing about review events', !/thread|actorKind|lamport/.test(text));
  }
}

// ── The bundle has to tell the operating system about the scheme ────────────
//
// A runtime `setAsDefaultProtocolClient` call cannot make an unlaunched bundle
// reachable: Launch Services routes a URL scheme by what the BUNDLE declares.
// Without this the packaged app received nothing at all, and clicking an
// invitation did nothing and reported nothing. test/packaged-deeplink.js proves
// the round trip against a built app; this is the fast check that the
// configuration which makes it possible is still there.

const protocols = Array.isArray(pkg.build?.protocols) ? pkg.build.protocols : pkg.build?.protocols ? [pkg.build.protocols] : [];
check('the build declares a URL protocol', protocols.length > 0, JSON.stringify(pkg.build?.protocols));
const joinProtocol = protocols.find((p) => (Array.isArray(p.schemes) ? p.schemes : []).includes('stacki'));
check('and it is the stacki scheme', !!joinProtocol, JSON.stringify(protocols));
check('with a name a person could recognise', typeof joinProtocol?.name === 'string' && joinProtocol.name.length > 3, joinProtocol?.name);
// One scheme, because this app answers for exactly one thing.
const declaredSchemes = protocols.flatMap((p) => (Array.isArray(p.schemes) ? p.schemes : []));
check('and it is the only scheme claimed', declaredSchemes.length === 1, JSON.stringify(declaredSchemes));

// ── The join link is a join link ────────────────────────────────────────────
//
// `stacki://join#…` is the one thing the custom protocol does, and the danger
// with a URL handler is not that it is wrong today — it is that somebody adds
// a second action to it later, and a link from a web page becomes a way to run
// something. So the handler's body is read, and it may not mention any of the
// verbs that would make it one.

const mainText = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const handler = /function handleJoinUrl\(url\) \{[\s\S]*?\n\}/.exec(mainText);
check('the join link handler is where the test expects it', !!handler, 'if this moved, this check needs to move with it');
if (handler) {
  const body = handler[0];
  for (const [what, pattern] of [
    ['spawn a process', /\bspawn\b|\bexec\b|execFile|child_process/],
    ['open a file', /readFile|writeFile|createReadStream|shell\.openPath/],
    ['open an external URL', /shell\.openExternal/],
    ['run git', /\bgit\b/],
    ['reach MCP', /\bmcp\b/i],
    ['evaluate anything', /executeJavaScript|\beval\(|new Function/],
    ['load a URL into the window', /loadURL|loadFile/],
  ]) {
    check(`the join link handler cannot ${what}`, !pattern.test(body), body.slice(0, 200));
  }
  check('and its only effect is to offer the invitation to a person', /reviews\.offerInvite\(/.test(body), body.slice(0, 200));
}
// Nothing else in the main process may claim the scheme for another purpose.
const schemeUses = [...mainText.matchAll(/setAsDefaultProtocolClient\(([^)]*)\)/g)].map((m) => m[1]);
check('the app claims exactly one custom scheme', schemeUses.length >= 1 && schemeUses.every((u) => u.includes('JOIN_SCHEME')), JSON.stringify(schemeUses));

// ── The archive contains the app ────────────────────────────────────────────

check('the main process is packaged', files.includes('electron/**/*'), JSON.stringify(files));
check('the built renderer is packaged', files.includes('dist/**/*'), JSON.stringify(files));
check('package.json is packaged', files.includes('package.json'), JSON.stringify(files));
check(
  'nothing excludes node_modules from the build',
  !files.some((f) => /^!.*node_modules/.test(f)),
  JSON.stringify(files.filter((f) => f.startsWith('!')))
);
check(
  'main points at a file that is packaged',
  typeof pkg.main === 'string' && pkg.main.startsWith('electron/') && fs.existsSync(path.join(root, pkg.main)),
  pkg.main
);

if (failures.length) {
  console.error(`\npackaging: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(
  `packaging: ${checked} passed  [${mainSide.length} main-process files, ${required.size} runtime deps, ${unpackedFiles.length} unpacked]`
);
