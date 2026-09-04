// A `gh` that cannot reach GitHub.
//
// THIS EXISTS BECAUSE A TEST CREATED A REAL REPOSITORY.
//
// The `git.publish` scenario was graded BOUNDARY on the assumption that the
// operation would refuse before doing anything external. It did not. The real
// `git:publish` handler ran, `run('gh', ['repo','create', …])` resolved the
// developer's authenticated `gh`, and GitHub made
// `heymarcell/stacki-wire-test-never-created` — private, empty, and pushed to
// one second later. A boundary nobody verified is not a boundary; it is a
// hope.
//
// So the external program is replaced, and nothing above it is. The MCP wire,
// the schema, the permission gate, the Agent dispatcher, the domain adapter
// and `git:publish` itself all run exactly as they ship. Only the executable
// at the very end is ours.
//
// The seam is PATH, and it is sound for a specific reason: `run()` in
// electron/main.js resolves through `execFile`, and `ensureToolPath()`
// APPENDS its directories — "the system's own resolution order stays intact"
// — so a directory prepended here wins.
//
// FAIL CLOSED, always. If the fake cannot be installed, if PATH does not
// resolve to it, or if it never actually ran, the caller raises rather than
// letting a test quietly reach the real thing. There is no path through this
// module that ends in "well, it probably didn't call GitHub".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Install a fake `gh` for the duration of `body`.
 *
 * Hands the body a `calls()` reader so a test can assert what intent reached
 * the boundary — which repo name, private or public, which flags.
 */
/**
 * Write a fake `gh` into a directory of its own, and hand back how to read it.
 *
 * Split out of `withFakeGh` because there are two shapes of the same need. A
 * test shadows `gh` for ITSELF, by editing `process.env.PATH`. A harness that
 * spawns somebody else's process — a real agent host — must shadow it for THAT
 * CHILD, without touching its own environment, and must be able to prove the
 * shadow took inside the child's PATH rather than its own. Both start here.
 */
function makeFakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-fake-gh-'));
  const log = path.join(dir, 'invocations.jsonl');
  const bin = path.join(dir, 'gh');

  // Deliberately tiny, and deliberately refuses anything it was not written
  // for: a fake that answers every command is a fake that hides a mistake.
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@")" >> ${JSON.stringify(log)}
case "$1" in
  --version) echo "gh version 0.0.0-fake (stacki test)"; exit 0 ;;
  repo)
    case "$2" in
      create) echo "https://github.com/fake-owner/fake-repo"; exit 0 ;;
    esac
    ;;
esac
echo "fake gh: refusing unexpected command: $*" >&2
exit 64
`,
    { mode: 0o755 }
  );

  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [];

  const cleanup = () => {
    // Owned, so removal is not optional: a leftover fake `gh` on PATH would be
    // a worse problem than the one this file solves.
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) throw new Error(`the fake gh directory would not go: ${dir}`);
  };

  return { dir, bin, log, calls, cleanup };
}

/**
 * PATH with the fake first, and the proof that it took.
 *
 * Asks the question the CHILD will ask — `command -v gh` under the environment
 * the child is about to be given — rather than the question this process would
 * ask about its own PATH. Those are different questions whenever the child's
 * environment is not this one's, which is exactly the case this exists for.
 */
function shadowedPath(dir, basePath = process.env.PATH) {
  const shadowed = `${dir}${path.delimiter}${basePath}`;
  let resolved = null;
  try {
    resolved = execFileSync('/bin/sh', ['-c', 'command -v gh'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: shadowed },
    }).trim();
  } catch {
    resolved = null;
  }
  const bin = path.join(dir, 'gh');
  if (resolved !== bin) {
    throw new Error(
      `fake gh did not take: PATH resolves gh to ${resolved || '(nothing)'}, not ${bin}. ` +
        'Refusing to run — the real gh must never be reachable.'
    );
  }
  return shadowed;
}

async function withFakeGh(body) {
  const fake = makeFakeGh();
  const realPath = process.env.PATH;
  try {
    process.env.PATH = shadowedPath(fake.dir, realPath);
  } catch (err) {
    fake.cleanup();
    throw err;
  }
  try {
    return await body({ calls: fake.calls, bin: fake.bin, dir: fake.dir });
  } finally {
    process.env.PATH = realPath;
    fake.cleanup();
  }
}

module.exports = { withFakeGh, makeFakeGh, shadowedPath };
