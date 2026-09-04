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
// AND WHETHER THE CLIENT CAN READ THE ENVELOPE AT ALL. An answer that is right
// and does not validate is not an answer: the MCP SDK checks a tool's
// structured output against the schema the tool published, and rejects the
// whole call when it does not fit. `git.restore_project` restored the working
// tree and reached a real Claude Code as `Output validation error: …
// changedFiles: Invalid input: expected array, received number` with
// isError:true and no envelope — a destructive operation that succeeded,
// reported as a failure, which is an invitation to run it again. So the
// restore_project case below parses its envelope with the SAME schema the
// server publishes, `Envelope` from agentTools.js, rather than reading fields
// off it and hoping.
//
// Also here, because it is the same complaint: `project.diagnose` reports a
// four-valued dev-server verdict whose healthy answer was the word 'unknown',
// and Stacki knows which package manager a project uses and told nobody.
//
// And the content domain's version of the refusal complaint, at the end. A git
// refusal that echoed `Command failed: <argv>` and a content refusal that
// echoed `ENOENT: no such file or directory, open '/Users/…'` are one defect
// wearing two coats: the host's own runtime text, with the host's own absolute
// paths in it, sent to a client as though it were Stacki speaking.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./agent-harness.js');
const { digestOf } = require('../electron/mcp/agent/digest.js');
const { Envelope } = require('../electron/mcp/agentTools.js');
const { listEntries, writeEntry } = require('../electron/contentEntries.js');

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
    echo "GraphQL: Name $3 already exists on this account (createRepository)" >&2
    echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2
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

    // ── restore_project: the tree really goes back, and the answer parses ────
    //
    // The order of the checks is the point. The world first — the bytes, and
    // what git says HEAD is — because a restore that reported beautifully and
    // restored nothing would pass a test written the other way round. Then the
    // envelope, against the published schema, because that is the difference
    // between an answer and an `isError` with nothing in it.
    {
      if (git(root, 'status', '--porcelain')) {
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'clean before restore_project');
      }
      const at = git(root, 'rev-parse', 'HEAD');
      // A file the editor does NOT have open, which is the case that produced
      // the defect: the count survives into the envelope precisely when no
      // watched file moved, so dirtying the open page would have hidden it.
      const CSS = 'src/styles/site.css';
      const committed = read(CSS);
      write(CSS, `${committed}\n.wrecked-by-a-test { color: red; }\n`);
      check('a stylesheet is dirty before the restore', read(CSS) !== committed);

      const env = await run('git', 'restore_project', { ref: at });

      check('restoring the project puts the stylesheet back byte for byte', read(CSS) === committed, short({ now: read(CSS).slice(-80) }));
      check('  and git says the tree is at that revision', git(root, 'rev-parse', 'HEAD') === at, short({ head: git(root, 'rev-parse', 'HEAD'), at }));
      check('  with nothing of the edit left in the working tree', !git(root, 'status', '--porcelain').includes('site.css'), short(git(root, 'status', '--porcelain')));

      check('  and it reports that it happened', env.ok === true, short(env));
      const parsed = Envelope.safeParse(env);
      check(
        '  in an envelope the tool’s own published output schema accepts',
        parsed.success,
        short(parsed.success ? null : parsed.error.issues)
      );
      // The oracle above must be able to fail, or it proves nothing: this is
      // the exact value the shipped build sent, run through the same schema.
      check(
        '  which is a check that can fail — a count on changedFiles is rejected',
        Envelope.safeParse({ ...env, changedFiles: 0 }).success === false,
        'the output schema accepts a number where it declares an array'
      );
      check('  nothing but the declared array ever sits on changedFiles', env.changedFiles === undefined || Array.isArray(env.changedFiles), short({ changedFiles: env.changedFiles }));
      check('  and the count it does answer with is kept, under a name that says it is a count', typeof env.changedFileCount === 'number', short({ changedFileCount: env.changedFileCount }));
      check('  the ref it was asked for comes back', env.ref === at, short({ ref: env.ref, at }));
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
        // ABOUT A CONSTANT, AND SAID SO. This branch never reaches
        // `ghComplaint`: main.js answers `gh_auth_required` with a sentence it
        // wrote itself, so what this proves is that the sentence somebody may
        // rewrite tomorrow still names no environment variable. The SCRUBBER is
        // proved on the authed branch below, where gh's own stderr goes through
        // it — this check passes with the scrubber deleted and is not evidence
        // about it.
        check('  and the sentence Stacki wrote itself names no environment variable', !String(env.message).includes('GH_TOKEN'), short(env.message));
      });

      await withFakeGh('authed', async (calls) => {
        const env = await run('git', 'publish', { repoName: 'stacki-envelopes-never-created' });
        check('a publish that fails at GitHub is refused', env.ok === false, short(env));
        check('  with its own code, not the same one as being signed out', env.code === 'publish_failed', short({ code: env.code, message: env.message }));
        check('  saying what GitHub said', /already exists/.test(String(env.message)), short(env.message));
        check('  without the command line', !/^Command failed:/.test(String(env.message)) && !String(env.message).includes('--remote'), short(env.message));
        // THE TWO SCRUBBERS, ON STDERR THAT ACTUALLY CARRIES WHAT THEY REMOVE.
        //
        // These two checks used to be made against a fake gh whose stderr was
        // `GraphQL: Name already exists on this account (createRepository)` —
        // no repository name in it and no GH_TOKEN line — so both passed with
        // `ghComplaint`'s filter and its `split(repoName).join('that name')`
        // deleted outright. Real gh puts the name it was given in the GraphQL
        // error and volunteers the GH_TOKEN hint underneath, so the fake now
        // says both, and each check has a POSITIVE half beside it: what the
        // scrubber left behind, not only what it took away. A `ghComplaint`
        // that returned nothing at all would pass every negative here and fail
        // both positives.
        check('  without the repository name Stacki was told to use', !String(env.message).includes('stacki-envelopes-never-created'), short(env.message));
        check('  which was really in what gh said, and came back as "that name"', String(env.message).includes('that name'), short(env.message));
        check('  nor the environment variable gh volunteered underneath', !String(env.message).includes('GH_TOKEN'), short(env.message));
        check('  while the line that says why it failed survived that filter', /Name that name already exists on this account/.test(String(env.message)), short(env.message));
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

    // ── the same complaint one domain over: a content refusal in Stacki's
    //    words, not the host's ────────────────────────────────────────────────
    //
    // The git refusals above stopped echoing `Command failed: <argv>`. The
    // content ones were still echoing Node: `content.cms_read` on a path that
    // is not there answered with the whole of
    // `ENOENT: no such file or directory, open '/Users/…/src/data/nope.json'`,
    // and on a markdown entry or an .astro page — a file whose first line is
    // `---` — with `No number after minus sign in JSON at position 1
    // (line 1 column 2)`, the parser talking about a buffer nobody can see.
    // Both measured over MCP against a packaged build.
    //
    // TWO THINGS ARE ASSERTED OF EVERY REFUSAL HERE and they are different: it
    // must say which file, in the spelling the caller used, and it must contain
    // no absolute path from this machine. The second is the leak; the first is
    // what makes the answer worth reading.
    {
      const hostPath = (text) => String(text).includes(root) || /(^|[\s'"(])\/(Users|private|var|home)\//.test(String(text));

      const missing = await run('content', 'cms_read', { path: 'src/data/nope.json' });
      check('reading a data file that is not there is refused', missing.ok === false, short(missing));
      check('  naming the path the caller used', String(missing.message).includes('src/data/nope.json'), short(missing.message));
      check('  with no absolute path from this machine anywhere in the answer', !hostPath(JSON.stringify(missing)), short(missing.message));
      check('  and not in Node’s words', !/ENOENT|no such file or directory/.test(JSON.stringify(missing)), short(missing.message));

      const markdown = await run('content', 'cms_read', { path: 'src/content/notes/first.md' });
      check('reading a markdown entry as a data file is refused', markdown.ok === false, short(markdown));
      check('  naming the file', String(markdown.message).includes('src/content/notes/first.md'), short(markdown.message));
      check('  and saying what the operation does take instead', /cms_list|#export/.test(String(markdown.message)), short(markdown.message));
      check('  not in the JSON parser’s words', !/minus sign|in JSON at position/.test(JSON.stringify(markdown)), short(markdown.message));

      const page = await run('content', 'cms_read', { path: 'src/pages/index.astro' });
      check('an .astro page read without naming an export is refused the same way', page.ok === false, short(page));
      check('  naming the page', String(page.message).includes('src/pages/index.astro'), short(page.message));
      check('  not in the JSON parser’s words either', !/minus sign|in JSON at position/.test(JSON.stringify(page)), short(page.message));

      // A file that really is JSON and really is broken: the one case where the
      // parser has something to say, said about a named file and trimmed of the
      // offsets that are about its own buffer.
      fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
      write('src/data/broken.json', '{ "a": 1,,, }\n');
      const broken = await run('content', 'cms_read', { path: 'src/data/broken.json' });
      check('a data file that is not valid JSON is refused', broken.ok === false, short(broken));
      check('  naming the file and saying that is what is wrong', /src\/data\/broken\.json/.test(String(broken.message)) && /valid JSON/.test(String(broken.message)), short(broken.message));
      check('  without the parser’s character offsets', !/at position \d|line \d+ column \d+/.test(String(broken.message)), short(broken.message));
      check('  and with no absolute path', !hostPath(JSON.stringify(broken)), short(broken.message));
      fs.unlinkSync(path.join(root, 'src/data/broken.json'));

      // THE SIBLINGS, called directly. `content.entries` and
      // `content.write_entry` read files through electron/contentEntries.js,
      // and both of those reads spelled an fs error straight out — one into a
      // published `reason`, one into a thrown message that nothing catches
      // between the write and the wire. They are exercised here rather than
      // through the API because a content collection needs the project's
      // dependencies installed to resolve at all, and the leak does not.
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-envelopes-content-'));
      try {
        const listed = listEntries(empty, { name: 'team', loader: { kind: 'file', file: './src/data/team.json' } });
        check('a collection whose data file is gone says so', /src\/data\/team\.json/.test(String(listed.reason)), short(listed.reason));
        check('  without spelling out where the project is on this machine', !hostPath(String(listed.reason)), short(listed.reason));
        check('  and without Node’s errno sentence', !/no such file or directory/.test(String(listed.reason)), short(listed.reason));

        let thrown = '';
        try {
          writeEntry(empty, { id: 'a', file: 'src/data/gone.json', locator: [], format: 'json' }, [{ path: ['x'], value: 1 }]);
        } catch (err) {
          thrown = String(err?.message || err);
        }
        check('writing an entry whose file has gone is refused', thrown.length > 0, thrown);
        check('  naming the entry’s own file', thrown.includes('src/data/gone.json'), thrown);
        check('  saying nothing was written', /nothing was written/i.test(thrown), thrown);
        check('  and with no absolute path in it', !hostPath(thrown), thrown);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    }

    // ── and the code the envelope carries, which is the other half ──────────
    //
    // The message stopped being Node's. The CODE did not: `runMain`'s catch was
    // the only thing between a throw and the wire and it answered
    // `{code: 'failed'}` for everything except one git special case, so a cause
    // the handler knew exactly arrived as the code that means "something went
    // wrong and nobody knows what". A client can branch on a code; it cannot
    // branch on a sentence.
    //
    // Handlers here are called two ways — by a panel over IPC, and directly by
    // the Agent API — so the reason rides on the thrown Error as `refusalCode`
    // and the throw itself is untouched. Both halves are checked: the envelope
    // gets a code, and the panel still gets the throw it was written against.
    {
      const hostPath = (text) => String(text).includes(root) || /(^|[\s'"(])\/(Users|private|var|home)\//.test(String(text));
      // Every refusal below must name its own cause, so a code that is right
      // for one case cannot be right for all of them.
      const codes = new Set();

      const cases = [
        ['content', 'cms_read', { path: 'src/data/nope.json' }, 'no_file', 'src/data/nope.json'],
        ['content', 'cms_read', { path: 'src/pages/index.astro' }, 'wrong_kind', 'src/pages/index.astro'],
        ['content', 'cms_write', { path: 'src/data/nope.json', data: [] }, 'no_file', 'src/data/nope.json'],
        ['content', 'entries', { collection: 'nope' }, 'no_collection', 'nope'],
        ['asset', 'read_text', { path: 'src/data/nope.txt' }, 'no_file', 'src/data/nope.txt'],
        ['asset', 'delete', { path: 'src/data/nope.json' }, 'no_file', 'src/data/nope.json'],
        ['page', 'read', { path: 'src/pages/nope.astro' }, 'no_file', 'src/pages/nope.astro'],
        ['page', 'delete', { path: 'src/pages/nope.astro' }, 'no_file', 'src/pages/nope.astro'],
        ['source', 'write', { path: 'src/nope/deep/x.ts', text: 'x' }, 'no_file', 'src/nope/deep/x.ts'],
      ];
      for (const [domain, action, args, code, names] of cases) {
        const env = await run(domain, action, args);
        check(`${domain}.${action} on a cause it knows is refused`, env.ok === false, short(env));
        check(`  with ${code} rather than the code that means nobody knows`, env.code === code, short({ code: env.code, message: env.message }));
        check(`  naming ${names} in the caller's own spelling`, String(env.message).includes(names), short(env.message));
        check('  and with no absolute path from this machine in it', !hostPath(JSON.stringify(env)), short(env.message));
        check('  nor Node\u2019s errno sentence', !/ENOENT|no such file or directory/.test(JSON.stringify(env)), short(env.message));
        codes.add(env.code);
      }
      check('the refusals do not all say the same thing', codes.size >= 3, short([...codes]));

      // POSITIVE CONTROLS. A surface that had learned to refuse everything
      // would pass every line above. These are the same four operations
      // against things that are really there.
      {
        const ok1 = await run('content', 'cms_read', { path: 'src/data/site.json' });
        check('reading a data file that IS there still works', ok1.ok === true, short(ok1));
        const ok2 = await run('page', 'read', { path: 'src/pages/index.astro' });
        check('reading a page that IS there still works', ok2.ok === true, short(ok2));
        const ok3 = await run('asset', 'read_text', { path: 'src/styles/site.css' });
        check('reading a text asset that IS there still works', ok3.ok === true, short(ok3));
        const ok4 = await run('source', 'write', { path: 'src/lib/written-by-a-test.ts', text: 'export const x = 1;\n' });
        check('writing a source file into a directory that exists still works', ok4.ok === true, short(ok4));
        check('  and the bytes are on disk', read('src/lib/written-by-a-test.ts') === 'export const x = 1;\n');
        fs.rmSync(path.join(root, 'src/lib/written-by-a-test.ts'), { force: true });
      }

      // A cause nothing here recognises must still arrive as `failed` — the
      // mapper classifies, it does not relabel.
      {
        const env = await run('project', 'resolve_import', { spec: './nowhere', from: 'src/pages/index.astro' });
        check('an unrecognised failure is not given a code it has not earned', env.ok !== false || env.code !== 'no_file', short(env));
      }

      // THE PANEL HALF. `cms:read` is called by the CMS view over IPC, which
      // gets a rejected promise and shows the message. That is what the codes
      // above must not have cost: the handler still throws, with the same
      // sentence, and nothing about the envelope shape leaked into it.
      {
        const handler = app.handlers.get('cms:read');
        check('the CMS panel\u2019s own handler is registered', typeof handler === 'function');
        let thrown = null;
        let returned;
        try {
          returned = await handler(null, { projectPath: root, rel: 'data/nope.json' });
        } catch (err) {
          thrown = err;
        }
        check('reading a missing data file still THROWS at the handler', thrown instanceof Error, short({ returned }));
        check('  with the sentence the panel shows', String(thrown?.message) === 'src/data/nope.json is not in this project.', short(thrown?.message));
        check('  and no in-band refusal handed back instead', returned === undefined, short(returned));
        // The code rides along for the direct caller and is invisible over IPC:
        // Electron serialises an Error as its message.
        check('  while the cause is on the error for the API to read', thrown?.refusalCode === 'no_file', short(thrown?.refusalCode));
      }

      // THE BACKSTOP, called directly. Every case above reaches the mapper
      // through an operation, and every one of them happens to be an fs error
      // that names its own file — so the rewrite covers them and the scrub is
      // never the thing that saves them. The leaks it exists for cannot be
      // provoked from a fixture: `project.install` puts up to 400 bytes of a
      // package manager's stderr on the wire, and npm's stderr is full of
      // absolute paths. So the mapper is handed those shapes itself.
      const { thrownFailure } = require('../electron/mcp/agent/domains.js');
      {
        const inside = thrownFailure(new Error(`npm install failed: could not read ${root}/package.json`), { root });
        check('a path inside the project is said the way the caller spells it', /(^|[^/])package\.json/.test(inside.message) && !inside.message.includes(root), short(inside.message));
        const outside = thrownFailure(new Error("npm install failed: EACCES '/Users/someone/.npm/_cacache'"), { root });
        check('a path outside it is not repeated at all', !/\/Users\/someone/.test(outside.message), short(outside.message));
        check('  and the rest of the sentence survives', /npm install failed/.test(outside.message), short(outside.message));
        const url = thrownFailure(new Error('the preview at http://localhost:4321/about did not answer'), { root });
        check('a url is not a path and is left alone', url.message.includes('http://localhost:4321/about'), short(url.message));
        const errno = Object.assign(new Error("EACCES: permission denied, open '/etc/shadow'"), { code: 'EACCES', path: '/etc/shadow' });
        check('an errno outside the project keeps its code', thrownFailure(errno, { root }).code === 'permission_denied', short(thrownFailure(errno, { root })));
        check('  and still names nothing on this machine', !thrownFailure(errno, { root }).message.includes('/etc/shadow'), short(thrownFailure(errno, { root }).message));
      }
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
