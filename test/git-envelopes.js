// What a git write says it did, checked against git.
//
//   node test/git-envelopes.js
//
// `{ok: true}` is not evidence. A commit that answered `{ok:true, files:null}`
// left an agent with no sha, no branch and no list of what went in — so the
// only way to find out what it had just done was to ask git, which is the
// thing the operation was supposed to be. Same for restore_file, delete_branch
// and push: three bare `{ok:true}`s for three writes that move real state.
//
// So every field asserted here is compared against git itself — `rev-parse`,
// `for-each-ref`, `show --name-only`, the bytes on disk — never against
// another field of the same envelope. An envelope that agreed with itself and
// disagreed with the repository would pass a test written the other way.
//
// AND THE REFUSALS. `{ok:false, missing:true}` and `{ok:false, unmerged:true}`
// arrived with no `code` at all, so an agent branching on `code` saw
// undefined; and the generic catch echoed execFile's `Command failed: <argv>`
// — the whole command line, the user's own commit message included.
//
// THE GITHUB BOUNDARY IS NEVER CROSSED. There is one publish case in here and
// it runs against a fake `gh` on PATH that logs what it was asked and then
// fails. It fails closed: if the shadow does not take, or the fake is never
// invoked, this raises rather than letting the real `gh` answer. No test in
// this file can create a repository — the fake has no network and every
// `repo create` it is given exits non-zero.
//
// Also here, because it is the same complaint: `project.diagnose` reports a
// four-valued dev-server verdict whose healthy answer was the word 'unknown',
// and Stacki knows which package manager a project uses and told nobody.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./agent-harness.js');
const { digestOf } = require('../electron/mcp/agent/digest.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

/** git, run by the test itself. The oracle, never the thing under test. */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * A `gh` that cannot reach GitHub, for the length of one body.
 *
 * The same seam test/support/fakeGh.js uses and for the same reason — PATH,
 * because electron/main.js's `run()` resolves through execFile and
 * `ensureToolPath()` only APPENDS. Written here rather than reused because
 * these cases need `gh auth status` to answer differently per case, which that
 * fake does not offer; it must stay exactly as strict, and it does: the shadow
 * is proven before anything runs, every invocation is logged, and a body that
 * never reached the fake is a failure rather than a shrug.
 */
async function withFakeGh(mode, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-envelopes-gh-'));
  const log = path.join(dir, 'calls.txt');
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
MODE=${JSON.stringify(mode)}
case "$1" in
  --version)
    [ "$MODE" = missing ] && exit 127
    echo "gh version 0.0.0-fake (stacki test)"; exit 0 ;;
  auth)
    [ "$MODE" = missing ] && exit 127
    if [ "$MODE" = unauth ]; then
      echo "To get started with GitHub CLI, please run:  gh auth login" >&2
      echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2
      exit 4
    fi
    echo "Logged in to github.com account fake-user"; exit 0 ;;
  repo)
    [ "$MODE" = missing ] && exit 127
    if [ "$MODE" = unauth ]; then
      echo "To get started with GitHub CLI, please run:  gh auth login" >&2
      echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2
      exit 4
    fi
    echo "GraphQL: Name already exists on this account (createRepository)" >&2
    exit 1 ;;
esac
echo "fake gh: refusing unexpected command: $*" >&2
exit 64
`,
    { mode: 0o755 }
  );
  const realPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${realPath}`;
  let resolved = null;
  try {
    resolved = execFileSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).trim();
  } catch {
    resolved = null;
  }
  if (resolved !== bin) {
    process.env.PATH = realPath;
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`fake gh did not take: PATH resolves gh to ${resolved || '(nothing)'}, not ${bin}. Refusing to run — the real gh must never be reachable from a test.`);
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  try {
    return await body(calls);
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) throw new Error(`fake gh directory would not go: ${dir}`);
  }
}

(async () => {
  const root = H.makeProject({
    'src/pages/about.astro': '---\nimport Base from "../layouts/Base.astro";\n---\n<Base><h1>About</h1></Base>\n',
  });
  // A real repository, made before the app opens it so git.info sees one.
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'envelopes@example.com');
  git(root, 'config', 'user.name', 'Envelope Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-envelopes-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

  const app = await H.start(root);
  const run = (domain, action, args) => app.api.run(domain, action, args);
  const write = (rel, body) => fs.writeFileSync(path.join(root, rel), body, 'utf8');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  try {
    // ── commit ───────────────────────────────────────────────────────────────
    {
      write('src/pages/about.astro', '---\nimport Base from "../layouts/Base.astro";\n---\n<Base><h1>About us</h1></Base>\n');
      const env = await run('git', 'commit', { message: 'probe commit' });
      check('a commit reports it happened', env.ok === true, short(env));
      check('  with the sha git says HEAD is', env.head === git(root, 'rev-parse', 'HEAD'), short({ head: env.head, real: git(root, 'rev-parse', 'HEAD') }));
      check('  on the branch git says it is on', env.branch === git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), short({ branch: env.branch }));
      const inCommit = git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
      check(
        '  and names the files that went into it, as git lists them',
        Array.isArray(env.files) && env.files.map((f) => f.path).join(',') === inCommit.join(','),
        short({ files: env.files, inCommit })
      );

      // The refusal, and what it must not repeat back.
      const nothing = await run('git', 'commit', { message: 'a message nobody should see echoed' });
      check('committing a clean tree is refused', nothing.ok === false, short(nothing));
      check('  without echoing the command line back', !/^Command failed:/.test(String(nothing.message)), short(nothing.message));
      check('  or the caller’s own commit message inside it', !String(nothing.message).includes('a message nobody should see echoed'), short(nothing.message));
    }

    // ── restore_file ─────────────────────────────────────────────────────────
    {
      const committed = read('src/pages/about.astro');
      write('src/pages/about.astro', '---\n---\n<p>wrecked</p>\n');
      const env = await run('git', 'restore_file', { path: 'src/pages/about.astro' });
      check('restoring a file reports it happened', env.ok === true, short(env));
      check('  and the bytes on disk are the committed ones again', read('src/pages/about.astro') === committed, short(read('src/pages/about.astro')));
      check('  naming the file it put back', env.file === 'src/pages/about.astro', short({ file: env.file }));
      check('  and the ref it took it from', env.ref === 'HEAD', short({ ref: env.ref }));
      check(
        '  with a digest of what is now on disk, so the caller need not re-read',
        env.afterDigest === digestOf(read('src/pages/about.astro')),
        short({ afterDigest: env.afterDigest, real: digestOf(read('src/pages/about.astro')) })
      );

      // A file that was not in that commit is a refusal with a code, not a
      // refusal an agent has to read English to classify.
      write('src/pages/later.astro', '---\n---\n<p>added after</p>\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'adds later.astro');
      const before = git(root, 'rev-parse', 'HEAD~1');
      const missing = await run('git', 'restore_file', { path: 'src/pages/later.astro', ref: before });
      check('restoring a file from before it existed is refused', missing.ok === false, short(missing));
      check('  with a code that says which refusal this is', missing.code === 'missing_at_ref', short({ code: missing.code }));
      check('  and the file is untouched', read('src/pages/later.astro') === '---\n---\n<p>added after</p>\n');
    }

    // ── delete_branch ────────────────────────────────────────────────────────
    {
      git(root, 'branch', 'spare');
      const env = await run('git', 'delete_branch', { branch: 'spare' });
      check('deleting a branch reports it happened', env.ok === true, short(env));
      check('  saying which branch went', env.deleted === 'spare', short({ deleted: env.deleted }));
      const left = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
      check('  and what git says is left', Array.isArray(env.branches) && env.branches.join(',') === left.join(','), short({ branches: env.branches, left }));

      git(root, 'checkout', '-q', '-b', 'unmerged');
      write('src/pages/only-here.astro', '---\n---\n<p>only on this branch</p>\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'work only on unmerged');
      git(root, 'checkout', '-q', 'main');
      const refused = await run('git', 'delete_branch', { branch: 'unmerged' });
      check('deleting a branch with unmerged work is refused', refused.ok === false, short(refused));
      check('  with a code for it', refused.code === 'unmerged_branch', short({ code: refused.code }));
      check('  and the branch is still there', git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').includes('unmerged'));
      await run('git', 'delete_branch', { branch: 'unmerged', force: true });
    }

    // ── push, to a bare repository this test made ────────────────────────────
    {
      git(root, 'remote', 'add', 'origin', bare);
      const env = await run('git', 'push', {});
      check('a push reports it happened', env.ok === true, short(env));
      check('  naming the branch it pushed', env.branch === 'main', short({ branch: env.branch }));
      check(
        '  with the sha that is now in the other repository',
        env.head === execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).trim(),
        short({ head: env.head, bare: execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).trim() })
      );
      check('  and where it went', typeof env.remote === 'string' && env.remote.length > 0, short({ remote: env.remote }));
      check('  with nothing left ahead of it', env.ahead === 0, short({ ahead: env.ahead }));
    }

    // ── publish, at the boundary and never across it ─────────────────────────
    {
      const remotesBefore = git(root, 'remote');

      await withFakeGh('missing', async (calls) => {
        const env = await run('git', 'publish', { repoName: 'stacki-envelopes-never-created' });
        check('publishing with no gh installed is refused', env.ok === false, short(env));
        check('  with a code that says gh is missing', env.code === 'gh_missing', short({ code: env.code, message: env.message }));
        check('  and the fake gh was the one that answered', calls().length > 0, short(calls()));
        check('  having never been asked to create anything', !calls().some((c) => c.startsWith('repo create')), short(calls()));
      });

      await withFakeGh('unauth', async (calls) => {
        const env = await run('git', 'publish', { repoName: 'stacki-envelopes-never-created' });
        check('publishing while signed out is refused', env.ok === false, short(env));
        check('  as a sign-in problem, not a generic failure', env.code === 'gh_auth_required', short({ code: env.code, message: env.message }));
        check('  and it really did ask gh about authentication', calls().some((c) => c.startsWith('auth status')), short(calls()));
        check('  the message does not echo the command line', !/^Command failed:/.test(String(env.message)), short(env.message));
        check('  nor the environment variable gh names in its stderr', !String(env.message).includes('GH_TOKEN'), short(env.message));
      });

      await withFakeGh('authed', async (calls) => {
        const env = await run('git', 'publish', { repoName: 'stacki-envelopes-never-created' });
        check('a publish that fails at GitHub is refused', env.ok === false, short(env));
        check('  with its own code, not the same one as being signed out', env.code === 'publish_failed', short({ code: env.code, message: env.message }));
        check('  saying what GitHub said', /already exists/.test(String(env.message)), short(env.message));
        check('  without the command line', !/^Command failed:/.test(String(env.message)) && !String(env.message).includes('--remote'), short(env.message));
        check('  without the repository name Stacki was told to use', !String(env.message).includes('stacki-envelopes-never-created'), short(env.message));
        check('  and gh was really the thing that failed', calls().some((c) => c.startsWith('repo create')), short(calls()));
      });

      check('no repository was created: the remotes are what they were', git(root, 'remote') === remotesBefore, short({ now: git(root, 'remote'), before: remotesBefore }));
    }

    // ── project.diagnose ─────────────────────────────────────────────────────
    //
    // The dogfood read `kind: "unknown"` as "Stacki does not know which package
    // manager this is". It is not a package manager field at all — it is the
    // dev-server verdict, and 'unknown' was its name for NOTHING IS WRONG. The
    // word was the trap; the real gap is that the four values were never
    // declared, and that the lockfile detection Stacki has had all along was
    // reachable from nowhere an agent could see.
    {
      const locks = [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lock', 'bun'],
        ['bun.lockb', 'bun'],
        ['package-lock.json', 'npm'],
      ];
      for (const [file, want] of locks) {
        write(file, '');
        const env = await run('project', 'diagnose', {});
        check(`a ${file} means ${want}`, env.packageManager?.detected === want, short(env.packageManager));
        check(`  and it says that is where it read it`, env.packageManager?.from === file, short(env.packageManager));
        fs.unlinkSync(path.join(root, file));
      }
      const none = await run('project', 'diagnose', {});
      check('with no lockfile at all it falls back to npm', none.packageManager?.detected === 'npm', short(none.packageManager));
      check('  and says the fallback is a fallback, not a detection', none.packageManager?.from === 'default', short(none.packageManager));

      // Declared and detected are different facts and a project can hold both.
      write('pnpm-lock.yaml', '');
      const pkg = JSON.parse(read('package.json'));
      write('package.json', JSON.stringify({ ...pkg, packageManager: 'yarn@4.1.0' }, null, 2));
      const both = await run('project', 'diagnose', {});
      check('a declared packageManager is reported as declared', both.packageManager?.declared === 'yarn@4.1.0', short(both.packageManager));
      check('  and the lockfile is still what is actually there', both.packageManager?.detected === 'pnpm', short(both.packageManager));
      write('package.json', JSON.stringify(pkg, null, 2));
      fs.unlinkSync(path.join(root, 'pnpm-lock.yaml'));

      const noDeps = await run('project', 'diagnose', {});
      check('a project with no dependencies installed says so', noDeps.kind === 'no-deps', short({ kind: noDeps.kind }));

      // Enough of an install for the diagnosis to come out healthy: the handler
      // reads exactly this file for the version and the engines range.
      fs.mkdirSync(path.join(root, 'node_modules', 'astro'), { recursive: true });
      write('node_modules/astro/package.json', JSON.stringify({ name: 'astro', version: '5.0.0', engines: { node: '>=18.0.0' } }));
      const ready = await run('project', 'diagnose', {});
      check('a project that can start says READY', ready.kind === 'ready', short({ kind: ready.kind }));
      check('  and not the word that means nothing is wrong by not being any of the others', ready.kind !== 'unknown', short({ kind: ready.kind }));
      check('  and still reports what it found', ready.nodeFound === true && ready.astroVersion === '5.0.0', short(ready));
      fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
    fs.rmSync(bare, { recursive: true, force: true });
  }
  check('the fixture is gone', !fs.existsSync(root), root);
  check('and so is the bare remote', !fs.existsSync(bare), bare);

  if (failures.length) {
    console.error(`git-envelopes: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-envelopes: ${checked} passed  [a git write says what it did, and git agrees]`);
})().catch((err) => {
  console.error('git-envelopes: threw\n', err?.stack || err);
  process.exit(1);
});
