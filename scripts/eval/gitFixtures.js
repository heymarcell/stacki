// Repositories that are genuinely mid-conflict, built from nothing, and the
// exact bytes of each side captured before anybody resolves anything.
//
// WHY THIS IS NOT A LITERAL IN A TEST. The four conflict scenarios in
// scripts/eval/blockers/final.js all end in the same question: "did the bytes
// that got committed come from the side the caller asked for?" The only honest
// answer compares the committed blob against WHAT GIT ACTUALLY HELD IN ITS
// INDEX for that side — `git show :2:<path>` and `:3:<path>` — captured while
// the merge was still in progress. A literal in the harness is a statement of
// what the author believed the fixture produced, and the whole point of these
// scenarios is that the author's belief about a custom merge driver is exactly
// the thing that has been wrong before.
//
// THE DRIVERS ARE REVERSED ON PURPOSE. A custom merge driver is handed the
// three versions and writes whatever it likes; nothing requires markers, and
// nothing requires this branch's side to come first. So the drivers here write
// the INCOMING side above `=======` and the CURRENT side below, with an
// ownership sentinel on the first line. That makes two mistakes visible that a
// same-side driver would hide:
//
//   * a resolver that parses the driver's text as git's own grammar and hands
//     back "theirs" gets THIS branch's bytes, and the comparison against
//     `:3:` fails loudly instead of passing by coincidence;
//   * a fixture where the driver silently did not run at all is caught by the
//     sentinel, rather than being mistaken for a driver that ran and behaved.
//
// NOTHING HERE TOUCHES AN EXISTING CHECKOUT. Every repository is created under
// os.tmpdir() by `makeConflictRepo`, is removed by the handle it returns, and
// every git invocation is pinned to a throwaway global config so the developer's
// own `merge.conflictStyle`, `merge.default`, hooks and identity cannot reach
// it. `git add` is only ever given explicit pathspecs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// STACKI MERGES WITH THIS, SO THE FIXTURE MEASURES WITH THIS.
//
// electron/gitBranches.js runs both its trial merge and its resolving merge as
// `git -c merge.conflictStyle=diff3 merge …`. A fixture that captured the
// conflicted bytes under the default two-marker style would compute a different
// expected per-hunk result from the one the product is going to produce, and
// the difference would be read as a Stacki defect.
const CONFLICT_STYLE = ['-c', 'merge.conflictStyle=diff3'];

const SENTINEL = 'STACKI-DRIVER-RAN';

/** The path every fixture conflicts on, inside the project as well as the repo. */
const CONFLICT_PATH = 'src/data/release-notes.md';

/**
 * The four fixture shapes, and what each is for.
 *
 * `builtin`        no attribute, no `merge.default` — git's own text driver, so
 *                  the markup is git's and per-hunk answers are meaningful.
 * `attr-driver`    `.gitattributes` names a driver; the program runs and its
 *                  output is opaque, so per-hunk must be refused and whole-file
 *                  must still be exact.
 * `default-empty`  no attribute at all; `merge.default = ""` with a driver
 *                  configured under `[merge ""]`. Git runs it.
 * `default-space`  no attribute at all; `merge.default = " text "` with a driver
 *                  under `[merge " text "]`. Git runs that one too — the name is
 *                  data, spaces included, and it is not git's built-in `text`.
 */
const KINDS = ['builtin', 'attr-driver', 'default-empty', 'default-space'];

const DRIVER_NAME = {
  'attr-driver': 'reversed',
  'default-empty': '',
  'default-space': ' text ',
};

// THE LABEL EACH KIND'S DRIVER IS INVOKED WITH, and therefore the exact sentinel
// suffix its output must carry.
//
// `driverRan` and `driverLabel` are read out of the same first line of the same
// file, so "driverLabel is a non-empty string" could not be red while
// `driverRan` was true — it restated the assertion before it. The label is worth
// asserting only against the one this fixture CONFIGURED: it goes red when git
// ran a driver from some `[merge …]` section other than the one the kind means
// to exercise, which is exactly the confusion `default-empty` and
// `default-space` exist to rule out.
const DRIVER_LABEL = {
  'attr-driver': 'ATTR',
  'default-empty': 'EMPTY',
  'default-space': 'SPACETEXT',
};

// --- the file the branches disagree about ------------------------------------
//
// THREE REGIONS, AND ONLY ONE OF THEM CONFLICTS. That is what makes a per-hunk
// answer distinguishable from a whole-file one:
//
//   A  changed on the CURRENT branch only     -> survives any correct merge
//   B  changed on BOTH, differently           -> the one conflicting hunk
//   C  changed on the INCOMING branch only    -> survives any correct merge
//
// So a correct per-hunk "theirs" is  A-current + B-incoming + C-incoming, which
// is neither `:2:` (A-current + B-current + C-base) nor `:3:` (A-base +
// B-incoming + C-incoming). A resolver that quietly substituted a whole-file
// answer for the per-hunk one it was asked for lands on `:3:` and is caught.
// A fixture that failed to arrange this is caught too: `makeConflictRepo`
// refuses to return one where those three are not three different things.

const GAP = Array.from({ length: 8 }, (_, i) => `unchanged context line ${i + 1}`).join('\n');

const notes = ({ a, b, c }) =>
  [
    '# Release notes',
    '',
    `## Region A — ${a}`,
    '',
    GAP,
    '',
    `## Region B — ${b}`,
    '',
    GAP,
    '',
    `## Region C — ${c}`,
    '',
  ].join('\n');

const BASE = notes({ a: 'base', b: 'base', c: 'base' });
const CURRENT = notes({ a: 'current branch rewrote this', b: 'current branch rewrote this', c: 'base' });
const INCOMING = notes({ a: 'base', b: 'incoming branch rewrote this', c: 'incoming branch rewrote this' });

// --- git, run somewhere that cannot see the developer's configuration --------

/**
 * A throwaway global config, so nothing about this machine reaches a fixture.
 *
 * `merge.default` is the setting scenario 8 is entirely about; a developer with
 * one set globally would silently change what `builtin` even means. The same
 * goes for `merge.conflictStyle`, for hooks, and for the identity commits need.
 */
function makeGitEnv(dir) {
  const config = path.join(dir, 'gitconfig');
  fs.writeFileSync(config, '[user]\n\tname = Stacki Fixture\n\temail = fixture@stacki.invalid\n[core]\n\thooksPath = /dev/null\n', 'utf8');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: '/usr/bin/false',
    GIT_AUTHOR_NAME: 'Stacki Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@stacki.invalid',
    GIT_COMMITTER_NAME: 'Stacki Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@stacki.invalid',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  };
}

/** git, as text. Throws with git's own stderr, which is the useful part. */
function git(root, env, args) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** git, as bytes. `git show :2:<path>` is the reason this exists. */
function gitBytes(root, env, args) {
  return execFileSync('git', args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** git, where a non-zero exit is an ANSWER — a conflicting merge exits 1. */
function gitAllowingFailure(root, env, args) {
  try {
    return { code: 0, out: execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status ?? -1, out: String(err.stdout || ''), err: String(err.stderr || '') };
  }
}

// --- the driver ---------------------------------------------------------------

/**
 * A merge driver that reverses the sides and signs its work.
 *
 * `%A` is both an input and the file git takes the result from, so the output
 * is built elsewhere and moved into place — writing into it while `cat`ting it
 * would truncate the side being read. Exit 1 is how a low-level driver tells git
 * the merge conflicted; anything else would report a clean merge.
 */
function writeDriver(dir) {
  const script = path.join(dir, 'reversed-driver.sh');
  fs.writeFileSync(
    script,
    `#!/bin/sh
# $1 label, $2 %O ancestor, $3 %A current (and the result file), $4 %B incoming
label="$1"
ours="$3"
theirs="$4"
tmp="$ours.stacki-driver-tmp"
{
  printf '%s\\n' "${SENTINEL}:$label"
  printf '%s\\n' "<<<<<<< the-incoming-side-is-written-FIRST"
  cat "$theirs"
  printf '%s\\n' "======="
  cat "$ours"
  printf '%s\\n' ">>>>>>> the-current-side-is-written-SECOND"
} > "$tmp" || exit 2
mv "$tmp" "$ours" || exit 2
exit 1
`,
    { mode: 0o755 }
  );
  return script;
}

/**
 * The repository-local config each kind needs, written as config TEXT.
 *
 * `git config` will not take a key whose subsection is empty or is made of
 * spaces, and those two names are precisely what scenario 8 exists to exercise —
 * so the section headers are written literally. Git's own parser reads them
 * back; whether it then RUNS them is not asserted here, it is measured by
 * `makeConflictRepo` and printed by the self-test.
 */
function configFor(kind, script) {
  const run = () => `${script} ${DRIVER_LABEL[kind]}`;
  if (kind === 'attr-driver') {
    return `[merge "reversed"]\n\tname = reversed, named by a .gitattributes line\n\tdriver = ${run()} %O %A %B\n`;
  }
  if (kind === 'default-empty') {
    return `[merge ""]\n\tname = reversed, named by the empty string\n\tdriver = ${run()} %O %A %B\n[merge]\n\tdefault = ""\n`;
  }
  if (kind === 'default-space') {
    return `[merge " text "]\n\tname = reversed, named with the spaces intact\n\tdriver = ${run()} %O %A %B\n[merge]\n\tdefault = " text "\n`;
  }
  return '';
}

// --- conflict markup ----------------------------------------------------------

/**
 * Every conflict block in `text`, as offsets and sides.
 *
 * Written for git's own diff3 markup, which is what Stacki's merges produce, and
 * DELIBERATELY strict: an unterminated block, a `=======` outside a block or a
 * second `|||||||` throws rather than being skipped. This function's answer
 * becomes the expected bytes of a scenario, so a block it silently mis-parsed
 * would become an expectation nobody wrote.
 */
function conflictBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let open = null;
  lines.forEach((line, index) => {
    if (line.startsWith('<<<<<<<')) {
      if (open) throw new Error(`nested conflict start at line ${index + 1}`);
      open = { start: index, base: null, mid: null, end: null };
      return;
    }
    if (!open) {
      if (line.startsWith('|||||||') || line === '=======' || line.startsWith('>>>>>>>')) {
        throw new Error(`conflict marker outside a block at line ${index + 1}: ${line}`);
      }
      return;
    }
    if (line.startsWith('|||||||')) {
      if (open.base !== null) throw new Error(`two ancestor markers in one block at line ${index + 1}`);
      open.base = index;
      return;
    }
    if (line === '=======') {
      if (open.mid !== null) throw new Error(`two separators in one block at line ${index + 1}`);
      open.mid = index;
      return;
    }
    if (line.startsWith('>>>>>>>')) {
      if (open.mid === null) throw new Error(`conflict block with no separator ending at line ${index + 1}`);
      open.end = index;
      blocks.push(open);
      open = null;
    }
  });
  if (open) throw new Error('a conflict block was never closed');
  return blocks;
}

/**
 * `text` with every conflict block replaced by one side of itself.
 *
 * This is how the expected result of a per-hunk answer is COMPUTED rather than
 * assumed. `side` is 'ours' (above the separator, below any ancestor line) or
 * 'theirs' (below the separator).
 */
function resolveBlocks(text, side) {
  const lines = text.split('\n');
  const blocks = conflictBlocks(text);
  if (!blocks.length) throw new Error('there are no conflict blocks to resolve');
  const out = [];
  let at = 0;
  for (const block of blocks) {
    out.push(...lines.slice(at, block.start));
    const oursEnd = block.base === null ? block.mid : block.base;
    out.push(...(side === 'ours' ? lines.slice(block.start + 1, oursEnd) : lines.slice(block.mid + 1, block.end)));
    at = block.end + 1;
  }
  out.push(...lines.slice(at));
  return out.join('\n');
}

// --- the fixture ---------------------------------------------------------------

/**
 * A repository sitting one `git merge incoming` away from a conflict, with the
 * bytes of every side of that conflict already captured.
 *
 * The capture is done by running the merge here, reading git's index, and
 * aborting — so what is returned is what git itself held, and the repository is
 * handed on in exactly the state it was in before. That the abort really did put
 * it back is checked, not assumed.
 *
 * `seed` is called with the repository root before the first commit, for a
 * caller that needs the repository to also be a runnable project. Whatever it
 * writes must be listed in the `track` it returns, because nothing here ever
 * runs `git add -A`.
 */
function makeConflictRepo({ kind, at = null, seed = null, label = kind } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown conflict fixture kind: ${kind}`);
  const home = at || fs.mkdtempSync(path.join(os.tmpdir(), `stacki-conflict-${kind}-`));
  fs.mkdirSync(home, { recursive: true });
  const support = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-conflict-support-'));
  const env = makeGitEnv(support);
  const script = kind === 'builtin' ? null : writeDriver(support);
  const root = at ? home : path.join(home, 'repo');
  fs.mkdirSync(root, { recursive: true });

  const cleanup = () => {
    const problems = [];
    for (const dir of at ? [support] : [support, home]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        problems.push(`${dir}: ${err?.message || err}`);
      }
      if (fs.existsSync(dir)) problems.push(`${dir} would not go`);
    }
    return problems;
  };

  try {
    git(root, env, ['init', '-b', 'main']);
    // Written into `.git/config` as text: two of the three driver names cannot
    // be spelled as a `git config` key at all.
    const extra = configFor(kind, script);
    if (extra) fs.appendFileSync(path.join(root, '.git', 'config'), `${extra}`, 'utf8');

    const write = (rel, text) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    };

    // Everything that must never be committed, and that would otherwise make
    // `git status --porcelain` non-empty for the rest of the run — which is one
    // of the oracles.
    write('.gitignore', ['node_modules/', '.astro/', 'dist/', '.stacki-automation', '.DS_Store', ''].join('\n'));
    const track = ['.gitignore', CONFLICT_PATH];
    if (kind === 'attr-driver') {
      write('.gitattributes', `${CONFLICT_PATH} merge=reversed\n`);
      track.push('.gitattributes');
    }
    write(CONFLICT_PATH, BASE);
    if (typeof seed === 'function') {
      const seeded = seed(root) || [];
      for (const rel of seeded) track.push(rel);
    }
    git(root, env, ['add', '--', ...track]);
    git(root, env, ['commit', '-m', 'base']);
    const baseCommit = git(root, env, ['rev-parse', 'HEAD']);

    git(root, env, ['switch', '-c', 'incoming']);
    write(CONFLICT_PATH, INCOMING);
    git(root, env, ['add', '--', CONFLICT_PATH]);
    git(root, env, ['commit', '-m', 'incoming rewrites B and C']);
    const incomingCommit = git(root, env, ['rev-parse', 'HEAD']);

    git(root, env, ['switch', 'main']);
    write(CONFLICT_PATH, CURRENT);
    git(root, env, ['add', '--', CONFLICT_PATH]);
    git(root, env, ['commit', '-m', 'current rewrites A and B']);
    const headBefore = git(root, env, ['rev-parse', 'HEAD']);

    // --- the trial merge, purely to read git's index --------------------------
    const merged = gitAllowingFailure(root, env, [...CONFLICT_STYLE, 'merge', '--no-commit', '--no-ff', '--no-edit', '--', 'incoming']);
    const unmerged = git(root, env, ['ls-files', '-u', '--full-name', '-z', '--', CONFLICT_PATH]);
    if (merged.code === 0 || !unmerged) {
      throw new Error(`${label}: the fixture merge did not conflict (exit ${merged.code}); this fixture measures nothing`);
    }
    const stage1 = gitBytes(root, env, ['show', `:1:${CONFLICT_PATH}`]);
    const stage2 = gitBytes(root, env, ['show', `:2:${CONFLICT_PATH}`]);
    const stage3 = gitBytes(root, env, ['show', `:3:${CONFLICT_PATH}`]);
    const conflicted = fs.readFileSync(path.join(root, CONFLICT_PATH), 'utf8');
    const driverRan = conflicted.includes(`${SENTINEL}:`);
    const driverLabel = driverRan ? (conflicted.split('\n')[0] || '').slice(SENTINEL.length + 1) : null;

    // WHICH SIDE THE DRIVER PUT FIRST, ANSWERED FROM BYTES.
    //
    // The driver labels its own markers `…-is-written-FIRST` / `…-SECOND`, and
    // the first version of this asserted on those LABELS. Mutation-tested: with
    // the two `cat`s swapped so the driver writes the CURRENT side above the
    // separator, both labels are still present and the assertion stayed green —
    // it was checking that a string this file writes is a string this file
    // writes. The reversal is the whole reason a wrong "theirs" is detectable,
    // so it is compared against what git held in its index instead.
    let driverWroteIncomingFirst = null;
    if (driverRan) {
      const blocks = conflictBlocks(conflicted);
      if (blocks.length !== 1) throw new Error(`${label}: the driver wrote ${blocks.length} conflict blocks; this fixture assumes one`);
      const lines = conflicted.split('\n');
      const [block] = blocks;
      const trim = (s) => s.replace(/\n+$/, '');
      const above = trim(lines.slice(block.start + 1, block.base === null ? block.mid : block.base).join('\n'));
      const below = trim(lines.slice(block.mid + 1, block.end).join('\n'));
      driverWroteIncomingFirst = above === trim(stage3.toString('utf8')) && below === trim(stage2.toString('utf8'));
    }

    git(root, env, ['merge', '--abort']);
    // THE ABORT IS CHECKED, because everything after this point assumes the
    // repository is back where it started and the agent's merge is the first
    // one that counts.
    const afterAbort = git(root, env, ['rev-parse', 'HEAD']);
    const dirt = git(root, env, ['status', '--porcelain']);
    if (afterAbort !== headBefore) throw new Error(`${label}: the abort moved HEAD (${headBefore} -> ${afterAbort})`);
    if (dirt) throw new Error(`${label}: the abort left the tree dirty:\n${dirt}`);
    if (fs.readFileSync(path.join(root, CONFLICT_PATH), 'utf8') !== CURRENT) {
      throw new Error(`${label}: the abort did not put ${CONFLICT_PATH} back to this branch's version`);
    }

    // --- what the sides mean, checked before anything relies on it -----------
    const expectedWholeTheirs = stage3;
    const expectedWholeOurs = stage2;
    const expectedPerHunkTheirs = driverRan ? null : Buffer.from(resolveBlocks(conflicted, 'theirs'), 'utf8');
    // A FIXTURE WHERE THE THREE ANSWERS COINCIDE PROVES NOTHING. If per-hunk
    // "theirs" and whole-file "theirs" are the same bytes, scenario 5 cannot
    // tell a resolver that honoured the hunk list from one that ignored it.
    if (!driverRan) {
      if (expectedPerHunkTheirs.equals(stage3)) throw new Error(`${label}: per-hunk "theirs" is byte-identical to the whole incoming file`);
      if (expectedPerHunkTheirs.equals(stage2)) throw new Error(`${label}: per-hunk "theirs" is byte-identical to the whole current file`);
    }
    if (stage2.equals(stage3)) throw new Error(`${label}: the two sides are the same bytes`);

    return {
      kind,
      label,
      root,
      home,
      support,
      driverScript: script,
      driverName: DRIVER_NAME[kind] ?? null,
      expectDriver: kind !== 'builtin',
      driverRan,
      driverLabel,
      // The sentinel suffix THIS kind's `[merge …]` section was written to
      // print, so a caller can ask whether the program that ran is the one the
      // fixture configured rather than merely that some program ran.
      expectedDriverLabel: DRIVER_LABEL[kind] ?? null,
      driverWroteIncomingFirst,
      path: CONFLICT_PATH,
      branch: 'incoming',
      baseCommit,
      incomingCommit,
      headBefore,
      stage1,
      stage2,
      stage3,
      conflicted,
      expectedWholeOurs,
      expectedWholeTheirs,
      expectedPerHunkTheirs,
      git: (args) => git(root, env, args),
      gitBytes: (args) => gitBytes(root, env, args),
      env,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * What the repository looks like now, in the terms the scenarios grade on.
 *
 * Read with git rather than with the model's account of what it did: the commit
 * it is on, how many parents that commit has (a real merge has two), the exact
 * bytes committed at the conflict path, and whether anything is uncommitted.
 */
function observe(repo) {
  const head = repo.git(['rev-parse', 'HEAD']);
  const parents = repo.git(['log', '-1', '--format=%P']).split(/\s+/).filter(Boolean);
  let blob = null;
  try {
    blob = repo.gitBytes(['show', `HEAD:${repo.path}`]);
  } catch {
    blob = null;
  }
  let worktree = null;
  try {
    worktree = fs.readFileSync(path.join(repo.root, repo.path));
  } catch {
    worktree = null;
  }
  return {
    head,
    headMoved: head !== repo.headBefore,
    parents,
    isMergeCommit: parents.length === 2,
    mergedIncoming: parents.includes(repo.incomingCommit),
    status: repo.git(['status', '--porcelain']),
    unmerged: repo.git(['ls-files', '-u', '--full-name']),
    blob,
    blobSha: blob ? crypto.createHash('sha256').update(blob).digest('hex') : null,
    worktreeSha: worktree ? crypto.createHash('sha256').update(worktree).digest('hex') : null,
    blobHasMarkers: blob ? /^(<{7}|={7}$|>{7}|\|{7})/m.test(blob.toString('utf8')) : false,
    blobHasDriverSentinel: blob ? blob.toString('utf8').includes(`${SENTINEL}:`) : false,
  };
}

module.exports = {
  KINDS,
  CONFLICT_PATH,
  SENTINEL,
  DRIVER_LABEL,
  BASE,
  CURRENT,
  INCOMING,
  makeConflictRepo,
  observe,
  conflictBlocks,
  resolveBlocks,
  makeGitEnv,
};
