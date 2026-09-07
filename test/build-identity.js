// A build that cannot be told apart from another build.
//
//   node test/build-identity.js
//
// WHAT THIS IS FOR. A live dogfood session filed sixteen defects against
// "Stacki version 0.1.23". The candidate it was qualifying also reported
// 0.1.23. Three of the sixteen described behaviour the candidate demonstrably
// did not have, and the only way to establish which build had actually been
// driven was to extract app.asar and hash all eighty of its
// `electron/**/*.js` files against every commit in the repository. They matched
// a commit ninety-three commits behind the candidate.
//
// So the product now carries its git identity, and this suite is what makes
// that a check rather than a comment. Every assertion here has a red condition
// that a plausible mistake would actually reach:
//
//   * a stamped package that answers about the machine's own git instead;
//   * a corrupt stamp that quietly falls back to git, which in a packaged app
//     would answer about whoever's repository happens to be open;
//   * `dirty` collapsed to false when nobody could establish it;
//   * a provenance gate that passes a package built from a different commit,
//     from a dirty tree, or with a stamp that disagrees with the running app.
//
// NOTHING HERE TOUCHES A CHECKOUT. Every repository is made under os.tmpdir()
// and removed, git is pinned to a throwaway config so the developer's identity,
// hooks and templates cannot reach it, and no test writes to the repository
// this file lives in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const buildInfo = require('../electron/buildInfo.js');
const stamper = require('../scripts/buildInfo.js');
const provenance = require('../scripts/provenance.js');

const made = [];
const tmp = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-build-id-${label}-`));
  made.push(dir);
  return dir;
};
const cleanup = () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
};

// A repository built from nothing, with a global config of its own so this
// machine's `user.name`, `init.templatedir`, hooks and merge drivers cannot
// reach it. See scripts/eval/gitFixtures.js, which does the same for conflicts.
function makeRepo(files) {
  const dir = tmp('repo');
  const home = tmp('home');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Build Identity Suite');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return {
    dir,
    git,
    head: () => git('rev-parse', 'HEAD').trim(),
    tree: () => git('rev-parse', 'HEAD^{tree}').trim(),
  };
}

// ── gitIdentity: what git actually says ─────────────────────────────────────
{
  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'x', version: '9.9.9' }), 'a.txt': 'one\n' });
  const clean = buildInfo.gitIdentity(repo.dir);
  check('a clean checkout reports its HEAD', clean && clean.gitHead === repo.head(), JSON.stringify(clean));
  check('and its tree', clean && clean.gitTree === repo.tree(), JSON.stringify(clean));
  check('and says it is clean', clean && clean.dirty === false, JSON.stringify(clean));

  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'two\n');
  const dirty = buildInfo.gitIdentity(repo.dir);
  check('a modified tracked file makes it dirty', dirty && dirty.dirty === true, JSON.stringify(dirty));
  check('and the HEAD does not move', dirty && dirty.gitHead === clean.gitHead);

  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo.dir, 'untracked.txt'), 'hello\n');
  const untracked = buildInfo.gitIdentity(repo.dir);
  check('an untracked file makes it dirty too', untracked && untracked.dirty === true, JSON.stringify(untracked));

  // THE REASON build-info.json IS GITIGNORED RATHER THAN MERELY UNTRACKED. If
  // stamping a package made the tree it was built from report itself dirty,
  // every package would be built from a dirty tree and the flag would mean
  // nothing.
  fs.rmSync(path.join(repo.dir, 'untracked.txt'));
  fs.writeFileSync(path.join(repo.dir, '.gitignore'), 'ignored.json\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'ignore');
  fs.writeFileSync(path.join(repo.dir, 'ignored.json'), '{}\n');
  const ignored = buildInfo.gitIdentity(repo.dir);
  check('an ignored file does NOT make it dirty', ignored && ignored.dirty === false, JSON.stringify(ignored));

  const notARepo = buildInfo.gitIdentity(tmp('bare'));
  check('a directory that is not a checkout answers null rather than throwing', notARepo === null, JSON.stringify(notARepo));
}

// ── the real gitignore entry ────────────────────────────────────────────────
{
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  check(
    'this repository ignores the stamp file',
    /^\/electron\/build-info\.json$/m.test(ignore),
    'without this, stamping a build dirties the tree it was built from'
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  check('and the packager stamps it', pkg.build.beforePack === './scripts/buildInfo.js', String(pkg.build.beforePack));
  check(
    'and the stamp is inside the files that get packed',
    pkg.build.files.includes('electron/**/*'),
    JSON.stringify(pkg.build.files)
  );
}

// ── stamp(): what the packager writes ───────────────────────────────────────
{
  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'x', version: '4.5.6' }), 'a.txt': 'one\n' });
  const file = path.join(repo.dir, 'build-info.json');
  const when = new Date('2026-01-02T03:04:05.000Z');
  const record = stamper.stamp({ root: repo.dir, file, now: when });

  check('the stamp records the version', record.packageVersion === '4.5.6', JSON.stringify(record));
  check('the commit', record.gitHead === repo.head(), JSON.stringify(record));
  check('the tree', record.gitTree === repo.tree(), JSON.stringify(record));
  check('that the tree was clean', record.dirty === false, JSON.stringify(record));
  check('and when', record.builtAt === '2026-01-02T03:04:05.000Z', JSON.stringify(record));
  check('and it is on disk as JSON', JSON.parse(fs.readFileSync(file, 'utf8')).gitHead === repo.head());

  // ONE STAMP PER BUILD, WHICH IS WHAT A UNIVERSAL BUILD REQUIRES.
  //
  // electron-builder packs x64 and arm64 separately and reconciles the two trees
  // into one bundle, running `beforePack` once per architecture in the same
  // process. Stamping twice wrote two files that agreed about everything except
  // `builtAt`, and the reconcile refused them outright:
  //
  //   ⨯ Can't reconcile two non-macho files electron/build-info.json
  //
  // A whole package build failed on it, which is exactly the class of thing this
  // suite is for.
  {
    stamper._resetStamp();
    const two = tmp('twopass');
    const twoFile = path.join(two, 'bi.json');
    const first = stamper.stamp({ root: repo.dir, file: twoFile, now: new Date('2026-01-01T00:00:00.000Z') });
    const firstBytes = fs.readFileSync(twoFile, 'utf8');
    const second = stamper.stamp({ root: repo.dir, file: twoFile, now: new Date('2026-06-06T06:06:06.000Z') });
    const secondBytes = fs.readFileSync(twoFile, 'utf8');
    check('a second pass in the same build writes identical bytes', firstBytes === secondBytes, `${firstBytes}\n    vs\n    ${secondBytes}`);
    check('  and the same instant', first.builtAt === second.builtAt, `${first.builtAt} vs ${second.builtAt}`);
    check('  and the file is still there afterwards', fs.existsSync(twoFile));
    // A different build, later, is a different stamp — the reuse is scoped to
    // one invocation, not to whatever is lying on disk.
    stamper._resetStamp();
    const later = stamper.stamp({ root: repo.dir, file: twoFile, now: new Date('2026-06-06T06:06:06.000Z') });
    check('a later build stamps afresh', later.builtAt !== first.builtAt, `${later.builtAt} vs ${first.builtAt}`);
    stamper._resetStamp();
  }

  // It does not refuse. Recording the truth about a work-in-progress build is
  // the point; the gate that refuses is provenance.compare().
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'changed\n');
  const dirtyRecord = stamper.stamp({ root: repo.dir, file, now: when });
  check('a dirty tree is stamped rather than refused', dirtyRecord.gitHead === repo.head(), JSON.stringify(dirtyRecord));
  check('and it says so', dirtyRecord.dirty === true, JSON.stringify(dirtyRecord));
}

// ── computeIdentity: packaged, dev, unknown ─────────────────────────────────
{
  const dir = tmp('stamp');
  const stampFile = path.join(dir, 'build-info.json');
  const head = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  fs.writeFileSync(
    stampFile,
    JSON.stringify({ packageVersion: '1.2.3', gitHead: head, gitTree: tree, dirty: false, builtAt: '2026-01-01T00:00:00.000Z' })
  );

  // `root` deliberately points at THIS repository, which is a real checkout
  // with a different HEAD. A packaged build that consulted git would answer
  // with that HEAD; the whole point is that it must not.
  const packaged = buildInfo.computeIdentity({ stampFile, root: path.join(__dirname, '..') });
  check('a stamped build says packaged', packaged.buildKind === 'packaged', JSON.stringify(packaged));
  check('and reports the stamped commit', packaged.gitHead === head, JSON.stringify(packaged));
  check('and the stamped tree', packaged.gitTree === tree, JSON.stringify(packaged));
  check('and the stamped version', packaged.packageVersion === '1.2.3', JSON.stringify(packaged));
  check('and does NOT consult the git it is standing in', packaged.gitHead !== buildInfo.gitIdentity(path.join(__dirname, '..'))?.gitHead);
  check('and carries when it was built', packaged.builtAt === '2026-01-01T00:00:00.000Z', JSON.stringify(packaged));

  // A stamp that exists and is rubbish means the packaging step ran and
  // produced rubbish. Falling back to git there would answer about whatever
  // repository the user has open, which is worse than not knowing.
  fs.writeFileSync(stampFile, 'not json at all');
  const corrupt = buildInfo.computeIdentity({ stampFile, root: path.join(__dirname, '..') });
  check('a corrupt stamp is unknown, not dev', corrupt.buildKind === 'unknown', JSON.stringify(corrupt));
  check('and reports no commit rather than the wrong one', corrupt.gitHead === null, JSON.stringify(corrupt));
  check('and does not claim to be clean', corrupt.dirty === null, JSON.stringify(corrupt));

  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'x', version: '7.7.7' }) });
  const dev = buildInfo.computeIdentity({ stampFile: path.join(dir, 'absent.json'), root: repo.dir });
  check('no stamp at all is a dev build', dev.buildKind === 'dev', JSON.stringify(dev));
  check('and it asks git', dev.gitHead === repo.head(), JSON.stringify(dev));
  check('and knows it is clean', dev.dirty === false, JSON.stringify(dev));

  const nowhere = buildInfo.computeIdentity({ stampFile: path.join(dir, 'absent.json'), root: tmp('nothing') });
  check('no stamp and no repository is unknown', nowhere.buildKind === 'unknown', JSON.stringify(nowhere));
  check('and says so rather than throwing', nowhere.gitHead === null && nowhere.dirty === null, JSON.stringify(nowhere));
}

// ── the running app's own identity ──────────────────────────────────────────
{
  buildInfo._reset();
  const identity = buildInfo.buildIdentity();
  check('this checkout has all six fields', ['packageVersion', 'gitHead', 'gitTree', 'dirty', 'buildKind', 'builtAt'].every((k) => k in identity), JSON.stringify(identity));
  check('and reports the version in package.json', identity.packageVersion === require('../package.json').version, JSON.stringify(identity));
  check('and a short sha a panel can show', buildInfo.shortSha(identity) === (identity.gitHead ? identity.gitHead.slice(0, 7) : null));
  check('and one line a human can read', /·/.test(buildInfo.describe(identity)), buildInfo.describe(identity));
  check(
    'a dirty dev build says +dirty in that line',
    buildInfo.describe({ packageVersion: '1.0.0', gitHead: 'c'.repeat(40), gitTree: null, dirty: true, buildKind: 'dev', builtAt: null }) === '1.0.0 · ccccccc+dirty · dev',
    buildInfo.describe({ packageVersion: '1.0.0', gitHead: 'c'.repeat(40), gitTree: null, dirty: true, buildKind: 'dev', builtAt: null })
  );
  check(
    'and an unknown build says so instead of pretending',
    buildInfo.describe({ packageVersion: '1.0.0', gitHead: null, gitTree: null, dirty: null, buildKind: 'unknown', builtAt: null }) === '1.0.0 · unknown build'
  );
}

// ── get_context declares it, so a strict client validates it ────────────────
{
  const { ContextOutput, BuildIdentity } = require('../electron/mcp/tools.js');
  const shape = ContextOutput.shape;
  check('get_context declares a build field', !!shape.build, Object.keys(shape).join(','));
  const good = BuildIdentity.safeParse(buildInfo.buildIdentity());
  check('and this build validates against it', good.success, JSON.stringify(good.error?.issues || []));
  const nullish = BuildIdentity.safeParse({ packageVersion: null, gitHead: null, gitTree: null, dirty: null, buildKind: 'unknown', builtAt: null });
  check('and so does an unknown one — a build with no identity is still an answer', nullish.success, JSON.stringify(nullish.error?.issues || []));
  const bad = BuildIdentity.safeParse({ packageVersion: null, gitHead: null, gitTree: null, dirty: null, buildKind: 'whatever', builtAt: null });
  check('but an invented buildKind is refused', !bad.success);
}

// ── the resource ────────────────────────────────────────────────────────────
{
  const intelligence = require('../electron/mcp/intelligence.js');
  check('the build resource has a URI of its own', intelligence.BUILD_URI === 'stacki://build', String(intelligence.BUILD_URI));

  const registered = [];
  const server = {
    registerResource: (name, uri, meta, handler) => registered.push({ name, uri, meta, handler }),
  };
  intelligence.registerResources(server, { api: null });
  const build = registered.find((r) => r.uri === 'stacki://build');
  check('and is registered', !!build, registered.map((r) => r.uri).join(', '));
  check('with a mime type that says it is data', build?.meta?.mimeType === 'application/json', JSON.stringify(build?.meta));
  // NOT public. The guides are byte-identical on every machine and hold nothing
  // about anybody; a dev build's identity says whether this developer's tree was
  // dirty, which is not something to leave in a shared cache.
  check('and is not marked publicly cacheable', !build?.meta?.cacheHint, JSON.stringify(build?.meta?.cacheHint));
}

// The handler is async, so it gets its own block rather than being forced into
// the synchronous one above.
(async () => {
  const intelligence = require('../electron/mcp/intelligence.js');
  const registered = [];
  intelligence.registerResources({ registerResource: (name, uri, meta, handler) => registered.push({ uri, handler }) }, { api: null });
  const build = registered.find((r) => r.uri === 'stacki://build');
  if (build) {
    const body = await build.handler(new URL('stacki://build'));
    const text = body?.contents?.[0]?.text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* reported by the check below */
    }
    check('reading it returns JSON', !!parsed, String(text).slice(0, 120));
    check(
      'and it is the same object get_context carries',
      parsed && parsed.gitHead === buildInfo.buildIdentity().gitHead && parsed.buildKind === buildInfo.buildIdentity().buildKind,
      JSON.stringify(parsed)
    );
  }

  // ── the provenance gate ───────────────────────────────────────────────────
  //
  // Built by hand rather than by packaging a real app: what is under test is
  // the COMPARISON, and a ten-minute electron-builder run to exercise it would
  // mean it never ran on a laptop. test/packaged-mcp.js checks the real bundle.
  {
    const asarModule = require('@electron/asar');
    const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }), 'a.txt': 'one\n' });

    const packApp = async (stamp) => {
      const src = tmp('app');
      fs.mkdirSync(path.join(src, 'electron'), { recursive: true });
      fs.writeFileSync(path.join(src, 'electron', 'build-info.json'), JSON.stringify(stamp));
      fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
      const out = tmp('bundle');
      const asar = path.join(out, 'app.asar');
      await asarModule.createPackage(src, asar);
      return out;
    };

    const trueStamp = { packageVersion: '1.0.0', gitHead: repo.head(), gitTree: repo.tree(), dirty: false, builtAt: '2026-01-01T00:00:00.000Z' };

    const good = provenance.compare({ appPath: await packApp(trueStamp), sourceRoot: repo.dir });
    check('a package stamped from this exact commit passes', good.ok, good.reasons.join(' | '));
    check('and the report quotes an artefact hash', /^[0-9a-f]{64}$/.test(good.artifactSha256 || ''), String(good.artifactSha256));
    check('and the header names all six values', /source HEAD[\s\S]*package HEAD[\s\S]*live MCP HEAD/.test(provenance.report(good)));

    // M19: the sabotage the mission names. A package carrying a deliberately
    // wrong SHA must be red BEFORE a dogfood launches.
    const wrong = provenance.compare({ appPath: await packApp({ ...trueStamp, gitHead: 'd'.repeat(40) }), sourceRoot: repo.dir });
    check('a package stamped with the wrong commit is REFUSED', !wrong.ok, JSON.stringify(wrong.reasons));
    check('and the reason names both SHAs', wrong.reasons.some((r) => r.includes('d'.repeat(40)) && r.includes(repo.head())), JSON.stringify(wrong.reasons));

    const wrongTree = provenance.compare({ appPath: await packApp({ ...trueStamp, gitTree: 'e'.repeat(40) }), sourceRoot: repo.dir });
    check('a package stamped with the wrong TREE is refused too', !wrongTree.ok, JSON.stringify(wrongTree.reasons));

    const dirtyPkg = provenance.compare({ appPath: await packApp({ ...trueStamp, dirty: true }), sourceRoot: repo.dir });
    check('a package built from a dirty tree is refused', !dirtyPkg.ok, JSON.stringify(dirtyPkg.reasons));
    check('and says why', dirtyPkg.reasons.some((r) => /uncommitted/.test(r)), JSON.stringify(dirtyPkg.reasons));

    const unknownDirty = provenance.compare({ appPath: await packApp({ ...trueStamp, dirty: null }), sourceRoot: repo.dir });
    check('a package that will not say whether it was clean is refused', !unknownDirty.ok, JSON.stringify(unknownDirty.reasons));

    // A live app that disagrees with the package it was supposedly launched
    // from. This is the case the dogfood actually hit: the bundle on disk was
    // not the bundle anybody thought.
    const app = await packApp(trueStamp);
    const liveOk = provenance.compare({ appPath: app, sourceRoot: repo.dir, live: { gitHead: repo.head(), gitTree: repo.tree() } });
    check('a running app that agrees with its package passes', liveOk.ok, liveOk.reasons.join(' | '));
    const liveBad = provenance.compare({ appPath: app, sourceRoot: repo.dir, live: { gitHead: 'f'.repeat(40), gitTree: repo.tree() } });
    check('a running app reporting a different commit is REFUSED', !liveBad.ok, JSON.stringify(liveBad.reasons));
    check('and the refusal names what the app said', liveBad.reasons.some((r) => r.includes('f'.repeat(40))), JSON.stringify(liveBad.reasons));

    // A dirty SOURCE tree cannot pin anything either: HEAD does not describe it.
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'two\n');
    const dirtySource = provenance.compare({ appPath: app, sourceRoot: repo.dir });
    check('a dirty SOURCE tree cannot qualify a package', !dirtySource.ok, JSON.stringify(dirtySource.reasons));
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'one\n');

    // A package with no stamp at all — which is every build made before this
    // mechanism existed, including the one the dogfood ran.
    const unstampedSrc = tmp('unstamped');
    fs.mkdirSync(path.join(unstampedSrc, 'electron'), { recursive: true });
    fs.writeFileSync(path.join(unstampedSrc, 'electron', 'main.js'), '// nothing\n');
    const unstampedOut = tmp('unstamped-bundle');
    await asarModule.createPackage(unstampedSrc, path.join(unstampedOut, 'app.asar'));
    const unstamped = provenance.compare({ appPath: unstampedOut, sourceRoot: repo.dir });
    check('a package with no build identity at all is refused', !unstamped.ok, JSON.stringify(unstamped.reasons));
    check('and says the identity is missing', unstamped.reasons.some((r) => /no readable build identity/.test(r)), JSON.stringify(unstamped.reasons));

    // Hashing is of the artefact, not of a description of it.
    const h = provenance.hashFile(path.join(unstampedOut, 'app.asar'));
    const expected = crypto.createHash('sha256').update(fs.readFileSync(path.join(unstampedOut, 'app.asar'))).digest('hex');
    check('the artefact hash is the file’s own SHA-256', h === expected, `${h} vs ${expected}`);
  }

  cleanup();

  if (failures.length) {
    console.error(`\nbuild-identity: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`build-identity: ${checked} passed  [which build this is, and a gate that refuses a different one]`);
})().catch((err) => {
  cleanup();
  console.error('build-identity: threw\n', err);
  process.exit(1);
});
