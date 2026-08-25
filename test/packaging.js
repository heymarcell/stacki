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
const path = require('path');
const Module = require('module');

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
