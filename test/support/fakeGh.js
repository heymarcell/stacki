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
  const log = path.join(dir, 'invocations.log');
  const bin = path.join(dir, 'gh');

  // Deliberately tiny, and deliberately refuses anything it was not written
  // for: a fake that answers every command is a fake that hides a mistake.
  //
  // THE LOG USED TO DEPEND ON `node` BEING ON THE CALLER'S PATH.
  //
  // The record was `printf '%s\n' "$(node -e '…JSON.stringify(argv)…' -- "$@")"`.
  // When `node` did not resolve on the PATH of whatever invoked `gh` — a
  // packaged app launched from Finder, an agent host with a trimmed
  // environment, the deliberately-empty PATH one containment test spawns with —
  // the command substitution came back EMPTY, `printf` appended a bare newline,
  // and `calls()`'s `.filter(Boolean)` threw that line away. The fake still
  // answered the caller correctly, so nothing failed; the LOG simply came up
  // one call short. That log is the evidence a trial did not reach GitHub, so a
  // silent gap in it is a containment claim resting on nothing.
  //
  // So the record is written BY THE SHELL. `printf` is a builtin in every sh
  // this runs under, which means no PATH lookup and nothing to be missing. The
  // format is NUL-separated because argv is: `$#` first, then that many
  // arguments, each NUL-terminated. A count in front is what makes it
  // unambiguous — `printf '%s\0' "$@"` alone cannot distinguish a trailing
  // empty argument from the end of a record — and NUL is the one byte argv
  // cannot contain, so no argument can forge a field boundary.
  //
  // AND A RECORD THAT CANNOT BE WRITTEN IS NOT SWALLOWED. If the append fails
  // the fake says so on stderr and exits non-zero instead of answering, because
  // an answer nobody recorded is exactly the hole this replaces.
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\0' "$#" "$@" >> ${JSON.stringify(log)} || {
  echo "fake gh: could not record this invocation, so refusing to answer it: $*" >&2
  exit 70
}
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

  /**
   * Every invocation, in order, as argv arrays.
   *
   * THROWS on a log it cannot read whole, rather than returning the part it
   * could. The old reader dropped anything it failed to parse, which is how a
   * missing record became invisible; here a truncated or corrupt tail is a
   * loud failure in the suite that asked, because the only honest answer to
   * "what did gh see" is either all of it or an error.
   */
  const calls = () => {
    if (!fs.existsSync(log)) return [];
    const fields = fs.readFileSync(log, 'utf8').split('\0');
    // A well-formed log ends with a NUL, so the split leaves one empty tail.
    const last = fields.pop();
    if (last !== '') throw new Error(`fake gh log ends mid-record (${JSON.stringify(last.slice(0, 80))}): ${log}`);
    const out = [];
    for (let i = 0; i < fields.length; ) {
      const count = Number(fields[i]);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`fake gh log is corrupt at field ${i} (${JSON.stringify(fields[i].slice(0, 80))}): ${log}`);
      }
      if (i + 1 + count > fields.length) {
        throw new Error(`fake gh log claims ${count} arguments it does not carry, at field ${i}: ${log}`);
      }
      out.push(fields.slice(i + 1, i + 1 + count));
      i += 1 + count;
    }
    return out;
  };

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
