const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { parseConflict, renderResolved, clashCount, conflictAtEnd, unreadMarkers } = require('./conflicts');

// Merging a branch and deleting one.
//
// Both are one git command with a handful of refusals behind it, and the
// refusals are the whole job: git says "not fully merged" and "would be
// overwritten by merge" to someone at a terminal who can then decide what to
// do. In an editor there is no terminal and no decision offered — the porcelain
// arrives as a red box quoting a command the user never ran. So each refusal
// worth acting on is recognised here and turned into either a sentence that
// says what to do instead, or a question the UI can ask.
//
// Kept out of main.js so the behaviour can be tested against a real repository
// (test/git-branches.js) rather than only through the app.
//
// `git` is passed in rather than imported: main.js runs git through a PATH it
// has had to repair for the packaged app, and the tests run it plainly.

/**
 * The conflicting paths out of `diff --name-only --diff-filter=U -z`.
 *
 * A PATH GIT PRINTED IS NOT ALWAYS A PATH GIT WILL ACCEPT BACK, and the
 * line-oriented listing this replaces got it wrong twice over.
 *
 * `core.quotePath` defaults to true, so git C-quotes any name holding a byte
 * outside ASCII or a control character: `café.astro` came out as
 * `"caf\303\251.astro"`, quotation marks and all. MEASURED, on a clash in one
 * accented file, all three consequences at once — `conflictDigest` could not
 * open that name so the file hashed as the UNREADABLE sentinel, which is a
 * measurement of nothing wearing the shape of a measurement; the panel and the
 * MCP envelope were handed the quoted name with `ours`, `theirs` and `parts`
 * all null, so there was nothing to choose between; and a resolve naming the
 * real path was refused as `unknown_path` while one naming the quoted path died
 * inside git on `pathspec ... did not match any file(s) known to git`. A clash
 * in any accented or CJK filename was unresolvable by every route there is.
 *
 * And the `.trim()` that the line form needed ate the leading and trailing
 * spaces of any path that has them, so ` draft.astro` came back as
 * `draft.astro` — the same defect, arrived at with no quoting involved, and one
 * that turning the quoting off does not reach.
 *
 * -z answers both and is stronger than `-c core.quotePath=false` would be: git
 * emits NUL-terminated names verbatim, with no escaping rule left to get wrong
 * and nothing to strip off either end. (The flag is deliberately NOT also
 * scattered over the merge and switch commands whose stderr this file scrapes
 * file lists out of: measured on those two messages, git does not C-quote
 * there, and a flag that cannot be shown to change anything is decoration.)
 */
const conflictedPaths = (stdout) => String(stdout || '').split('\0').filter(Boolean);

/**
 * The paths git could not reconcile, ALWAYS SPELLED FROM THE REPOSITORY ROOT.
 *
 * ONE PATH SPACE, ASKED FOR RATHER THAN ASSUMED. Everything downstream of this
 * list — `conflictDigest`, the reads and writes under `repoRoot`, the `choices`
 * keys the validator enumerates, the stage sets `sidesOf` looks up — treats
 * these names as repo-root-relative, and every one of them is silently wrong
 * about a DIFFERENT file if they are not.
 *
 * `git diff --name-only` prints repo-root-relative names whatever the cwd, but
 * only until somebody sets `diff.relative`, which is an ordinary user config
 * and is not Stacki's to have an opinion about. Measured, repository at <root>
 * and project at <root>/site with one conflict in site/a.txt: with
 * `diff.relative=true` and cwd=site the same command printed `a.txt`. Nothing
 * downstream would have noticed — `conflictDigest` would have opened
 * <root>/a.txt (absent, so the unreadable sentinel), and a resolve keyed
 * `site/a.txt` would have been refused as `unknown_path`.
 *
 * A later `-c` wins over an earlier one and over the config file, so this is
 * not a request: it pins the answer for this one invocation and touches nothing
 * of the user's.
 */
const unmergedPaths = async (git, cwd) =>
  conflictedPaths((await git(cwd, ['-c', 'diff.relative=false', 'diff', '--name-only', '--diff-filter=U', '-z'])).stdout);

/**
 * A BRANCH NAME IS AN ARGUMENT TO GIT, AND GIT READS ARGUMENTS.
 *
 * Every command in this file used to hand the caller's branch string to git as
 * a bare argv token, with no `--` in front of it and nothing checked. A value
 * beginning with `-` is therefore read as an OPTION, and the operation quietly
 * becomes a different operation. Measured against a repository with a real
 * upstream holding one commit:
 *
 *   `--strategy=ours` answered `{ok:true, into:"main", changed:true}` — HEAD had
 *   moved and a two-parent merge commit existed that discarded every byte of the
 *   upstream work. (`merge.defaultToUpstream` is on by default, so
 *   `git merge --strategy=ours` merges the upstream with no ref named at all.)
 *   The file the merge claimed to have brought in never arrived.
 *
 *   `--squash` answered `{ok:true, changed:false}` over a fully staged,
 *   uncommitted merge sitting in the index — "nothing changed" about a mutated
 *   repository.
 *
 *   `--detach` through the branch switch answered `{ok:true}` with HEAD
 *   detached, so every commit Stacki made afterwards landed on nothing.
 *
 * Two things are needed and neither is enough alone. `--` before the ref stops
 * git parsing it as an option; and the name is checked first, because `--` is
 * not available everywhere (`git switch -c` reads what follows `--` as a start
 * point, not as the new branch) and because a caller sending an option where a
 * branch belongs has made a mistake worth naming rather than a mistake worth
 * routing around.
 *
 * `git check-ref-format --branch` is the authority on the second half — the
 * rules are git's, they are not restated here, and they will not drift from
 * whichever git is actually running. A leading `-` is refused before git is
 * asked at all: it is the shape that becomes an option, and no version of git
 * may be relied upon to read it as a name rather than as a flag.
 *
 * AND A NAME GIT EXPANDS IS NOT THE NAME THAT WAS TYPED.
 *
 * `--branch` does not only validate: it is documented to also EXPAND git's
 * `@{-n}` "previous checkout" syntax, and asking it whether a name is legal
 * therefore accepts a spelling that MEANS A DIFFERENT BRANCH. Measured, on a
 * repository sitting on `feature` after a checkout from `main`:
 * `git check-ref-format --branch '@{-1}'` prints `main` and exits 0, so the
 * name was accepted; `git branch -d -- '@{-1}'` then expanded it the same way
 * and DELETED MAIN, past a trunk guard that compares the caller's own string
 * against `'main'`, and answered `{ok:true}`. `--` stops git parsing the token
 * as an OPTION; it does not stop it resolving the token as a REF. The same
 * spelling took `switch` to another branch and merged another branch, each
 * reporting `@{-1}` as the branch it had acted on.
 *
 * So the expansion itself is the test: git is asked what the name means, and a
 * name that does not come back as itself is refused. That is exactly the
 * `@{-n}` family and nothing else — measured, check-ref-format already refuses
 * `@{u}`, `@{upstream}`, `HEAD@{1}`, `main@{yesterday}`, `@{now}` and every
 * other `@{…}` shape outright, and echoes ordinary names (`feature@work`,
 * `fix/thing`, `@feature`) back unchanged.
 *
 * NOTE what is deliberately still ACCEPTED: `refs/heads/main` and `heads/main`
 * are valid branch names as far as check-ref-format is concerned, and they are
 * refused a moment later — by git itself for merge and switch, and by
 * deleteBranch's own resolution guard, which will not delete under a spelling
 * that names something other than itself.
 */
async function usableBranchName(git, projectPath, branch) {
  if (typeof branch !== 'string' || branch === '' || branch.startsWith('-')) return false;
  try {
    const { stdout } = await git(projectPath, ['check-ref-format', '--branch', branch]);
    // What git printed is what git will act on. Anything else is a name whose
    // meaning is decided after this function has said yes.
    return String(stdout).trim() === branch;
  } catch {
    return false;
  }
}

/**
 * The refusal for a name git would not have read as a name.
 *
 * Returned rather than thrown wherever the caller already reads returned
 * refusals, so it arrives with a code to branch on instead of as a bare string.
 * The offending value is quoted back — it is the caller's own argument, and it
 * carries no path from this machine.
 */
const badBranchName = (branch, extra = {}, undone = 'Nothing was changed.') => ({
  ok: false,
  code: 'bad_branch_name',
  branch: typeof branch === 'string' ? branch : null,
  ...extra,
  message:
    `${typeof branch === 'string' && branch ? `"${branch}"` : 'That'} is not a name git will accept for a branch, ` +
    `so it was never given to git. ${undone} A name that begins with "-" is an option as far as git is ` +
    'concerned, and a name like "@{-1}" is git\'s own shorthand for whichever branch you were on last — ' +
    'neither one names a branch.',
});

/** Whether the working tree has anything uncommitted in it. */
async function isDirty(git, projectPath) {
  const { stdout } = await git(projectPath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

async function currentBranch(git, projectPath) {
  try {
    return (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * THE BRANCH GIT WILL ACT ON, ASKED FOR RATHER THAN ASSUMED.
 *
 * A destructive command must not be guarded by a string comparison against the
 * caller's spelling, because git resolves the spelling afterwards and can
 * resolve it to something else. `usableBranchName` closes the `@{-n}` family
 * ahead of this; this closes the shapes that survive it, and it is the answer
 * the guard and the report are both taken from rather than the argument.
 *
 * Returns the short name under `refs/heads/`, or null when the name resolves to
 * nothing (git's own "branch not found" is a better sentence than one invented
 * here) or to something that is not a local branch at all — a tag, a
 * remote-tracking ref — which `git branch -d` would refuse anyway.
 *
 * `--end-of-options` for the same reason as everywhere else in this file, with
 * one wrinkle worth knowing: rev-parse ECHOES that token back on a line of its
 * own before it answers, so the answer is the last line and not the first.
 */
async function resolvedBranch(git, projectPath, branch) {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', '--symbolic-full-name', '--end-of-options', branch]);
    const lines = String(stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const full = lines[lines.length - 1] || '';
    return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

/**
 * The commit a revision names, or null when it names nothing.
 *
 * `--end-of-options` for the same reason as the `--` elsewhere: this takes a
 * caller-supplied ref, and `rev-parse` reads a leading `-` as a flag. `--` is
 * not the separator here — for rev-parse it means "paths follow" — so it is the
 * one place the option-terminator has to be spelled the other way.
 */
async function tipOf(git, projectPath, rev) {
  try {
    return (await git(projectPath, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * WHERE THE REPOSITORY ACTUALLY STARTS.
 *
 * The open project does not have to BE the repository. Stacki accepts a project
 * that is a subdirectory of one — the ordinary monorepo layout — because
 * `git:info` only asks `rev-parse --is-inside-work-tree`. Git then answers every
 * question about paths in REPO-ROOT-relative terms, and every read and write in
 * this file used to join those answers onto the PROJECT path instead. Measured,
 * with the repository at <root> and the project at <root>/site and one real
 * conflict in site/a.txt: the conflict came back with `parts: null`, so the
 * panel said there was no text in it to compare about an ordinary text file;
 * `conflictDigest` could not open a single conflicted file so it hashed the
 * unreadable sentinel for all of them, and two genuinely different conflicts
 * produced the SAME digest — a binding that had stopped measuring content while
 * still looking like a measurement; a per-hunk resolve was refused as
 * `not_splittable`; and a whole-file resolve died inside git on `pathspec
 * 'site/a.txt' did not match any file(s) known to git`. The conflict was
 * unresolvable by every route Stacki offers.
 *
 * So the root is asked for once and everything that resolves one of git's paths
 * — reading, digesting, writing, and the pathspecs handed back to git — is
 * resolved against it. A project that IS its repository gets the same path it
 * always got.
 *
 * Falls back to the project path: a directory git will not answer for is one
 * where nothing else here was going to work either, and a throw from this would
 * turn a working merge into an error about a question nobody asked.
 */
async function repoRoot(git, projectPath) {
  try {
    return (await git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim() || projectPath;
  } catch {
    return projectPath;
  }
}

// A CONFLICTED FILE THAT CANNOT BE READ IS NOT A CONFLICTED FILE THAT IS EMPTY.
// Digesting the two the same way would let a binary clash and a blank one look
// identical, which is the one thing a digest exists not to do.
//
// AND ONE UNREADABLE REASON IS NOT ANOTHER. This was a single constant, so every
// way of failing to open a file hashed to the same bytes: a conflicted submodule
// (EISDIR) and a file whose permissions were taken away (EACCES) were one
// measurement, and a path that changed from one to the other did not move the
// digest. The reason is part of the sentinel, so two different unreadable
// situations do not collide.
const unreadable = (why) => `\0stacki:unreadable:${why || 'unknown'}\0`;

/**
 * WHAT THE CONFLICT ACTUALLY IS, measured rather than argued from.
 *
 * The two commit SHAs either side of a merge are an argument: git is
 * deterministic, so the same two commits reconcile the same way, so if neither
 * moved the conflict cannot have. That argument is true of the merge ALGORITHM
 * and not of everything feeding it — attributes out of `.git/info/attributes`,
 * a merge driver, a rename limit, an end-of-line setting all live outside both
 * commits and all change what git writes into the working tree.
 *
 * So the SHAs are checked AND this is: the conflicted paths in a stable order
 * with the exact bytes git wrote under diff3 beside them. One function, called
 * from the merge that hands the conflict out and from the resolve that applies
 * the answers, because two functions computing "the same" digest is a bug
 * waiting for the day they stop agreeing.
 *
 * `at` is the REPOSITORY ROOT, not the project — see repoRoot. Git's paths are
 * repo-root-relative, and joining them onto a project that sits inside its
 * repository opened nothing at all.
 */
function conflictDigest(at, files) {
  const hash = crypto.createHash('sha256');
  // Sorted, so two runs that list the same clash in a different order are the
  // same conflict. Git's own order is stable in practice; relying on that
  // would make the digest a measurement of git's sort as well.
  for (const file of [...(files || [])].sort()) {
    hash.update(file, 'utf8');
    hash.update('\0');
    let bytes = null;
    let why = null;
    try {
      bytes = fs.readFileSync(path.join(at, file));
    } catch (err) {
      bytes = null;
      why = err?.code || err?.errno || 'unknown';
    }
    hash.update(bytes === null ? Buffer.from(unreadable(why), 'utf8') : bytes);
    hash.update('\0');
  }
  return hash.digest('base64url').slice(0, 22);
}

/**
 * Fold `branch` into the branch currently checked out.
 *
 * Named for the argument git takes, so "merge home-test" means what
 * `git merge home-test` means — the direction is never something to work out
 * from where a button sits.
 *
 * Returns `{ ok, into, changed }`. `changed` is false for a merge that moved
 * nothing: reporting "merged" there would suggest work arrived that was
 * already present.
 */
/**
 * One side of a conflicted file, or null when that side deleted it.
 *
 * `:<n>:<path>` is resolved by git against the top of the working tree whatever
 * the cwd is, so this is the one path-taking call that already worked from a
 * project inside its repository. `--end-of-options` is here for the same reason
 * as everywhere else in this file: nothing after it is read as a flag.
 */
/**
 * AND THE READ IS NOT ALLOWED TO GIVE UP QUIETLY AT ONE MEGABYTE.
 *
 * The runner underneath is `child_process.execFile`, whose `maxBuffer` defaults
 * to 1 MiB — and this shells out with no options at all, so a conflicting file
 * whose side is bigger than that rejected with
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the `catch` below turned it into the
 * same `null` a DELETED side answers with. The two are not the same thing. A
 * null here switches off renderResolved's final-newline correction, silently,
 * for exactly the files most likely to be a person's real work; the only
 * symptom is a merge commit one byte different from the branch it came from.
 *
 * A megabyte is not a large source file by accident of anything — a generated
 * data file, a bundled asset committed by hand, a long page — so the bound is
 * raised to something no text file a person edits will reach, and it is stated
 * here rather than inherited from a default nobody chose. `opts` is the third
 * argument main.js's runner already takes; a runner that takes two ignores it.
 */
const STAGE_MAX_BUFFER = 64 * 1024 * 1024;

async function stage(git, projectPath, n, file) {
  try {
    return (await git(projectPath, ['show', '--end-of-options', `:${n}:${file}`], { maxBuffer: STAGE_MAX_BUFFER })).stdout;
  } catch {
    return null;
  }
}

/**
 * Finish a merge that clashed, with the user's choice for each file.
 *
 * `choices` is `{ [path]: 'ours' | 'theirs' }`. The merge is run again here
 * rather than having been left open while the user decided, so the files never
 * sit on disk with conflict markers in them where the editor would try to
 * parse them as markup.
 *
 * What comes out is an ordinary merge commit with two parents — nothing about
 * it is special afterwards, and nothing about it needs undoing differently.
 */
async function resolveMerge(git, { projectPath, branch, choices, expect }) {
  const into = await currentBranch(git, projectPath);
  // Before the binding, before the merge, before anything: a name git would
  // read as an option is not a branch, and re-running the merge with one is how
  // `--strategy=ours` got to commit. See usableBranchName.
  if (!(await usableBranchName(git, projectPath, branch))) {
    return badBranchName(branch, { from: into }, 'Nothing was merged.');
  }
  // Everything git says about a path, it says relative to the top of the
  // working tree — which is not always the project. See repoRoot.
  const at = await repoRoot(git, projectPath);
  // THE ANSWERS ARE ABOUT A CONFLICT, AND A CONFLICT IS A MOMENT.
  //
  // This re-runs the merge rather than having left one open, so the choices
  // are applied to whatever git produces NOW — and nothing used to say that
  // had to be what the caller was shown. Measured, with real commits: a commit
  // landing on either branch in between committed work nobody had read; a hunk
  // that stopped conflicting shifted the rest up one, so the answer given for
  // the top of a file landed on the bottom and this branch's own work vanished
  // from the tree; a conflict appearing in a file the caller was never told
  // about took `--ours` and was committed. Every one of them answered
  // `{ok:true, changed:true}`.
  //
  // So a resolve names the conflict it is about, and an unnamed one is refused
  // rather than assumed to be this one. Optional would be no guard at all: a
  // caller that simply never sent the field is exactly the caller this exists
  // to stop.
  const bound = expect && typeof expect === 'object' && !Array.isArray(expect) ? expect : null;
  // ALL FOUR FACTS, OR IT IS NOT A BINDING. `into` is in here for the same
  // reason the other three are: a field a caller may leave out is a guard that
  // protects only the callers who remembered to ask for it, and the caller that
  // never sends it is the one this exists to stop. Both routes carry it — the
  // panel from `at`, the MCP surface from the signed ref's data.
  const named =
    bound &&
    typeof bound.head === 'string' && bound.head &&
    typeof bound.incoming === 'string' && bound.incoming &&
    typeof bound.digest === 'string' && bound.digest &&
    typeof bound.into === 'string' && bound.into;
  if (!named) {
    return {
      ok: false,
      code: 'guard_required',
      from: into,
      branch,
      message:
        `Finishing the merge of "${branch}" has to say which conflict the choices were made against, and this call ` +
        'named none. Nothing was merged. Run the merge again and answer the conflict it reports.',
    };
  }
  // Cheap, and before anything is started: if either side has moved there is
  // no point re-running a merge only to unwind it.
  const headNow = await tipOf(git, projectPath, 'HEAD');
  const incomingNow = await tipOf(git, projectPath, branch);
  const stale = (current, why) => ({
    ok: false,
    code: 'stale_merge',
    from: into,
    branch,
    expected: { head: bound.head, incoming: bound.incoming, digest: bound.digest, into: bound.into },
    // The branch the project is actually on, on every one of these. The call
    // sites below each measure commits and pass those; a `current` that reports
    // less than `expected` is not something a caller can compare.
    current: { into, ...current },
    message:
      `The conflict those choices were made against is not the conflict that is there now — ${why}. ` +
      `Nothing was merged and "${into}" is exactly as it was. Run git.merge on "${branch}" again and answer ` +
      'the conflict it reports this time.',
  });
  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 8) : 'nothing');
  // THE BRANCH BEING MERGED INTO IS PART OF THE CONFLICT, AND ONLY THE COMMIT
  // WAS BEING CHECKED.
  //
  // `into` is read fresh from currentBranch above, and the guard below compares
  // `tipOf('HEAD')`. Two branches at one commit are completely ordinary, so a
  // checkout between the conflict and the resolve is invisible to a SHA
  // comparison. MEASURED, with real git: the conflict taken on `main`, `git
  // checkout release` where release had just been cut from main and had no
  // commits of its own, and the resolve answered `{ok: true, into: "release",
  // changed: true, resolved: 1}` over a two-parent merge commit on a branch the
  // caller had never named — with the panel then toasting that it had merged
  // into a branch the person never chose. A detached HEAD at that commit is the
  // same case and is refused here too: `rev-parse --abbrev-ref` says "HEAD"
  // there, which is not the branch name the binding carries.
  //
  // Refused before the trial merge rather than after it, so this is the one
  // staleness refusal that never has a tree to unwind.
  if (into !== bound.into) {
    return stale(
      { head: headNow, incoming: incomingNow, digest: null },
      `those answers were for merging into "${bound.into}" and the project is on "${into || 'no branch'}" now`
    );
  }
  if (headNow !== bound.head) {
    return stale(
      { head: headNow, incoming: incomingNow, digest: null },
      `"${into}" was at ${short(bound.head)} and is now at ${short(headNow)}`
    );
  }
  if (incomingNow !== bound.incoming) {
    return stale(
      { head: headNow, incoming: incomingNow, digest: null },
      `"${branch}" was at ${short(bound.incoming)} and is now at ${short(incomingNow)}`
    );
  }
  /**
   * Put the trial merge back, AND SAY SO WHEN IT WOULD NOT GO BACK.
   *
   * Everything below this point that refuses does it AFTER the trial merge has
   * run, so every one of those refusals is a claim about the tree as well as
   * about the answers: "nothing was merged and the branch is exactly as it
   * was". The unwind is what makes that claim true, and it used to be fired
   * into a `catch {}` — so a merge --abort that failed left the claim
   * standing over a working tree full of conflict markers.
   *
   * MEASURED, with real git and a real repository: `.git/MERGE_HEAD` removed
   * between the merge and the abort — which is what a second git process, a
   * crash, or an editor plugin's own `git merge --abort` does — makes the
   * abort exit non-zero with "fatal: There is no merge to abort". The answer
   * was `bad_choices`, "Nothing was merged", while `git status` said `UU
   * a.txt`, the index held three stages, and the file on disk held
   * `<<<<<<< HEAD`. Stacki parses that file as markup a moment later, and the
   * page comes back broken with nothing to say why.
   *
   * So the failure is MEASURED rather than assumed in either direction. An
   * abort that fails because there was nothing to abort has left nothing
   * behind and the original refusal is still the true one; an abort that fails
   * with a merge still in progress has, and that is a different answer with a
   * name of its own. Asked of the index, not of the exit code: unmerged
   * entries, or a MERGE_HEAD git is still holding.
   */
  const midMerge = async () => {
    try {
      const left = await unmergedPaths(git, projectPath);
      if (left.length) return left;
      await git(projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      return [];
    } catch (err) {
      // `rev-parse --verify` on a MERGE_HEAD that is not there exits 1 with
      // nothing on stderr, which is the ordinary "it unwound" answer. Anything
      // that actually said something is a repository that would not answer the
      // question, and after a failed abort the honest reading of that is the
      // cautious one.
      return String(err?.stderr || '').trim() ? [] : null;
    }
  };
  /**
   * THE WORKING TREE, WHICH IS WHERE THE DAMAGE IS AND THE ONE PLACE THE
   * UNWIND NEVER LOOKED.
   *
   * `midMerge` above asks the INDEX and the metadata: unmerged entries, or a
   * MERGE_HEAD git is still holding. Its own docstring names the scenario it
   * was written for — MERGE_HEAD removed between the merge and the abort by a
   * second git process, a crash, or an editor plugin's own `merge --abort` —
   * and it was only ever measured for the half of that scenario where the
   * unmerged ENTRIES survive. A plain `git reset` (mixed) clears MERGE_HEAD
   * AND the stages while leaving the working tree exactly as the trial merge
   * wrote it, and that is the blind spot: `unmergedPaths` answers [],
   * `rev-parse -q --verify MERGE_HEAD` exits 1 with EMPTY stderr because of
   * the -q, so `midMerge` read "it unwound" and `abort` answered "nothing to
   * abort, and nothing left behind".
   *
   * MEASURED 3/3, no stubs, the only extra thing being one ordinary `git
   * reset` run at the moment `merge --abort` would have run:
   *
   *   bad_choices    "Nothing was merged: 1 of the choices could not be
   *                  used…" while a.txt on disk held `<<<<<<< HEAD … |||||||
   *                  … ======= … >>>>>>> feature`
   *   unknown_path   the same sentence over the same file
   *   clean re-merge `stale_merge`, "…Nothing was merged and "main" is exactly
   *                  as it was.", while a.txt held "OURS\nkeep\nTHEIRS\nkeep\n"
   *                  — bytes NEITHER BRANCH HAS
   *
   * HEAD really was unmoved in all three, so the half of the claim this file
   * already checked was true and the half about the tree was not. Stacki
   * parses that file as markup a moment later.
   *
   * WHAT IS COMPARED, AND THE FALSE POSITIVE IT IS SHAPED AROUND. A caller may
   * legitimately have unrelated uncommitted work open, and refusing because of
   * THAT would be a new defect worse than the one being fixed. So this is a
   * difference between two readings, not a dirtiness test: `diff --name-only
   * HEAD` names the paths whose WORKING TREE bytes differ from the commit HEAD
   * is on and `ls-files --others` adds the ones git is not tracking; both are
   * read once before the trial merge and once after the unwind, and a path in
   * both readings is the caller's own business. MEASURED with an unrelated
   * modified file and an untracked file in the tree: the ordinary refusal is
   * still `bad_choices`, both files survive byte for byte, and the same
   * answers still merge.
   *
   * `diff HEAD` rather than `status` because status splits its answer between
   * the index and the tree, and this claim is about the tree — the file Stacki
   * is about to parse as markup.
   *
   * The same path-space pins as everywhere else in this file: `diff.relative`
   * is an ordinary user config and is pinned for the invocation, `--full-name`
   * with a cwd of the repository root stops `ls-files` answering about the
   * project only, and -z means these names are spelled the way every other
   * list in this refusal is.
   */
  const treeNow = async () => {
    try {
      const changed = conflictedPaths(
        (await git(at, ['-c', 'diff.relative=false', 'diff', '--name-only', '-z', 'HEAD'])).stdout
      );
      const untracked = conflictedPaths(
        (await git(at, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name'])).stdout
      );
      return [...new Set([...changed, ...untracked])].sort();
    } catch {
      // A repository that will not answer is not evidence that something was
      // left behind, and refusing on it would turn a working merge into a
      // refusal. The index and MERGE_HEAD are still asked below.
      return null;
    }
  };
  /** The paths this call left different, out of two `treeNow` readings. */
  const changedSince = (was, is) => {
    if (!was || !is) return [];
    const before = new Set(was);
    const after = new Set(is);
    return [...new Set([...is.filter((f) => !before.has(f)), ...was.filter((f) => !after.has(f))])].sort();
  };
  // Read immediately before the trial merge, below. Declared here so `abort`
  // can close over it; `abort` is only ever called after that merge has run.
  let treeBefore = null;
  const abort = async () => {
    let refused = null;
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch (err) {
      refused = err;
    }
    // TWO QUESTIONS, AND THE ANSWER TO THE FIRST IS NOT THE ANSWER TO THE
    // SECOND. Is a merge still in progress — asked only when the abort
    // refused, because an abort that returned 0 concluded the merge by
    // definition — and is the working tree back where it was.
    const mid = refused ? await midMerge() : null;
    const touched = changedSince(treeBefore, await treeNow());
    if (mid === null && !touched.length) return null; // nothing left behind
    const said = String(refused?.stderr || refused?.message || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(hint|warning):/i.test(line))
      .join(' ')
      .replace(/\.+$/, '');
    // WHAT TO NAME. A merge still in progress is named by its unmerged
    // entries; when there is none of that left to point at, the paths the tree
    // itself differs at are what a person has to go and look at.
    const files = mid && mid.length ? mid : touched;
    const one = files.length === 1;
    const list = files.slice(0, 10).join(', ');
    return {
      ok: false,
      code: 'merge_stuck',
      from: into,
      branch,
      // WHICH OF THE TWO SHAPES THIS IS, because the remedy differs and the
      // advice for one of them cannot reach the other: a caller who runs `git
      // merge --abort` on the second shape is told there is no merge to abort
      // and is no further forward.
      mergeInProgress: mid !== null,
      gitSaid: said || null,
      files,
      message:
        mid !== null
          ? `Nothing of "${branch}" was committed, but the merge Stacki ran to check those answers could not be ` +
            `unwound${said ? ` — git said: ${said}` : ''}, so the project is still in the middle of it` +
            `${files.length ? ` and ${files.length} ${one ? 'file holds' : 'files hold'} conflict markers: ${list}` : ''}. ` +
            'Nothing else here can be trusted until that is cleared: run `git merge --abort` in the project (or ' +
            'finish the merge there by hand), then ask Stacki again.'
          : `Nothing of "${branch}" was committed and "${into}" did not move, but the merge Stacki ran to check ` +
            `those answers did not come back out of the working tree${said ? ` — git said: ${said}` : ''}: ` +
            `${files.length} ${one ? 'file is' : 'files are'} not as ${one ? 'it was' : 'they were'} before it ` +
            `ran — ${list}. ${one ? 'It may hold' : 'They may hold'} conflict markers, or bytes neither branch ` +
            'wrote. There is no merge left in progress, so `git merge --abort` will not clear this: look at ' +
            `${one ? 'that file' : 'those files'} in the project and put back what you did not want ` +
            '(`git checkout HEAD -- <path>` — nothing was committed, so HEAD still holds the version this ' +
            'started from), then ask Stacki again.',
    };
  };
  let blocked = null;
  let clean = false;
  // The reading every "nothing was merged" below is measured against. Taken
  // here rather than at the top of the function so it is the tree as it was
  // the instant before git touched it, and taken on every path that runs a
  // trial merge rather than only on the ones that expect to unwind.
  treeBefore = await treeNow();
  try {
    // Same style as the trial merge above, or the markers this re-parses would
    // not be the ones the answers were given against.
    //
    // --no-commit --no-ff: NOTHING HERE MAY REACH A COMMIT BEFORE THE BINDING
    // HAS BEEN CONSULTED. This used to be a plain merge, so a re-run that went
    // through cleanly committed itself before any of the checks below ran —
    // see the refusal underneath. Leaving it uncommitted costs nothing: the
    // clashing path never committed either, and the `git commit --no-edit` at
    // the end of the apply loop is what finishes both. (A fast-forward cannot
    // happen here — the caller was shown a conflict from these same two
    // commits, and a fast-forward never conflicts — but --no-ff says so rather
    // than leaving it to be worked out, because a fast-forward is the one
    // merge --no-commit cannot stop and the one `merge --abort` cannot undo.)
    //
    // `--` before the branch: everything after it is a ref, never a flag. See
    // usableBranchName for what a bare `--strategy=ours` did here.
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-commit', '--no-ff', '--no-edit', '--', branch]);
    clean = true;
  } catch (err) {
    /* expected — it clashes again, which is what the choices are for */
    blocked = err;
  }
  // A RESOLVE THAT WAS TOLD ABOUT A CONFLICT AND FINDS NONE IS A STALE BINDING,
  // NOT A SUCCESS.
  //
  // This used to answer `{ok:true, changed:true, resolved:0}` and commit, on
  // the reasoning that both commits were where the caller left them so git had
  // simply reconciled everything itself. The reasoning is the SHA argument
  // again, and it is wrong for the same reason conflictDigest exists: the merge
  // machinery is not in either commit. MEASURED, with git's own built-in union
  // driver and an untracked `.git/info/attributes` holding `*.txt merge=union`
  // written between the merge and the resolve — no git config, no tracked file:
  // a caller that asked for `{a.txt: 'ours'}` got `"OURS\nTHEIRS\n"` committed
  // as a two-parent merge, and was told ok. Its choice was never applied and
  // never mentioned. With a custom driver the mirror image — asked theirs, got
  // ours, and the incoming work was gone while the branch stopped being
  // protected from deletion.
  //
  // The digest below cannot catch it, because there is nothing left to digest:
  // the conflict the answers were about is not there. So the absence IS the
  // finding, and it is refused by name with the merge unwound and HEAD where it
  // was.
  if (clean) {
    // A clean --no-commit merge has staged its result and written MERGE_HEAD,
    // so this refusal is as dependent on the unwind as the conflicted ones.
    const stuck = await abort();
    if (stuck) return stuck;
    return stale(
      { head: headNow, incoming: incomingNow, digest: null },
      'both branches are where they were, but git reconciles them cleanly now — there is no conflict left for ' +
        'those answers to be about, and applying them would have discarded them in silence'
    );
  }
  const left = await unmergedPaths(git, projectPath);
  if (!left.length) {
    // THE MERGE NEVER STARTED, and until this it had no name. Unsaved work in
    // one of the conflicting files stops git before it writes anything, so
    // there is nothing conflicted to apply the choices to — and the failure
    // surfaced two calls later as the string "Command failed: git commit
    // --no-edit", the one resolve failure an agent had to read English to
    // classify. Same cause, same code and same shape as the merge that is
    // blocked by uncommitted work, because it is the same question.
    const detail = `${blocked?.stdout || ''}\n${blocked?.stderr || blocked?.message || ''}`;
    if (/would be overwritten|Please commit your changes|Your local changes/i.test(detail)) {
      const inTheWay = detail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(error|Please|Aborting|warning|hint|Updating|Merge with)/i.test(l) && !l.endsWith(':'));
      return {
        ok: false,
        code: 'working_tree_blocked',
        dirty: true,
        from: into,
        branch,
        files: inTheWay,
        message:
          `Finishing the merge of "${branch}" needs to write files that have uncommitted changes, so git would not ` +
          'start it. Commit them, park them, or discard them first — nothing was merged.',
      };
    }
    // A MERGE THAT COULD NOT RUN IS NOT A CONFLICT THAT WENT AWAY.
    //
    // Everything below this point reasons about what git PRODUCED. Reaching
    // here means git produced nothing at all: the merge above threw, and there
    // is not one unmerged entry in the index — so git did not get as far as
    // writing a conflict, and the reason is in its own sentence rather than in
    // anything this code can measure.
    //
    // It used to fall through anyway. `conflictDigest(at, [])` is sha256 of an
    // empty list, and the answer went out as `stale_merge` with
    // `current.digest: "47DEQpj8HBSa-_TImW-5JC"` — base64url(sha256("")), a
    // constant, published in the field that exists to say what was measured —
    // and with the sentence "both branches are where they were, but git
    // produced no conflict to answer this time". MEASURED against an ordinary
    // `.git/index.lock` left by a second git process, which is what a user with
    // a terminal open does several times an hour: that is the answer, and it is
    // wrong twice. Nothing was hashed, and the remedy it gives — run git.merge
    // again and answer the new conflict — is the one thing that cannot work,
    // because the next merge is holding the same lock. An agent following it
    // loops.
    //
    // So the failure gets its own name and carries git's own words. The binding
    // is still good: neither branch moved and nothing was written, so the SAME
    // call with the SAME mergeRef is what to retry once whatever held the
    // repository has let go.
    //
    // AND AN EMPTY UNMERGED LIST IS NOT EVIDENCE THAT THIS MERGE WROTE
    // NOTHING.
    //
    // That is what the comment here used to claim, and the sentence below —
    // "Nothing was merged and nothing was written" — rested on it. It is false.
    // `git merge --no-commit --no-ff` writes the merged WORKING TREE first and
    // can fail partway through doing it: a directory it cannot write into, a
    // full disk, a file something else has locked. What it leaves behind is the
    // files it had already created, with not one unmerged entry in the index —
    // which is precisely the shape that lands here.
    //
    // MEASURED, real git, no stubs: `feature` adds `src/pages/incoming.astro`
    // and a file under a directory chmod 500, `main` and `feature` also clash
    // in a.txt. The trial merge died on `error: unable to create file
    // zz/locked.txt: Permission denied`, `diff --diff-filter=U` was EMPTY, and
    // this answered `merge_blocked` — "Nothing was merged and nothing was
    // written" — over a working tree that now contained
    // `src/pages/incoming.astro`, a file from the incoming branch that Stacki's
    // own page scan lists as a page of the CURRENT branch and that the next
    // `git add -A` commits onto it. The remedy the sentence gives cannot work
    // for this cause either: the same failure recurs on every retry and each
    // one leaves more behind.
    //
    // So this path is measured like every other post-trial-merge refusal:
    // `treeBefore` against `treeNow()`, and `merge_stuck` when they differ.
    //
    // The abort is still CONDITIONAL on that difference, and the old reasoning
    // is why. When git wrote nothing there is nothing to unwind, and firing
    // `merge --abort` into a repository another process is holding — the
    // ordinary `index.lock` case, which is what this refusal is mostly for — is
    // the one way to turn a wait into damage. A tree that differs is the
    // evidence that there IS something to unwind, and only then is it asked
    // for. `abort` re-measures afterwards, so a merge that unwinds cleanly
    // falls through to the sentence below with the sentence now true.
    const residue = changedSince(treeBefore, await treeNow());
    if (residue.length) {
      const stuck = await abort();
      if (stuck) return stuck;
    }
    const said = String(blocked?.stderr || blocked?.message || blocked?.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(hint|warning):/i.test(line))
      // AND NOT THE COMMAND LINE ECHOED BACK. `err.message` from execFile is
      // "Command failed: git -c merge.conflictStyle=diff3 merge …" with git's
      // own words underneath it, and quoting the first line at an agent is the
      // failure the working-tree refusal above was written to stop being — a
      // sentence about a command nobody ran.
      .filter((line) => !/^Command failed:/i.test(line))
      .join(' ')
      // Git ends its own sentence, and quoting it inside one of ours put two
      // full stops together — "Unable to write index.. Nothing was merged".
      .replace(/\.+$/, '');
    return {
      ok: false,
      code: 'merge_blocked',
      from: into,
      branch,
      // Git's sentence, kept whole and attributed, rather than folded into the
      // message as though Stacki had worked it out.
      gitSaid: said || null,
      message:
        `Finishing the merge of "${branch}" could not be started${said ? ` — git said: ${said}` : ''}. Nothing was ` +
        'merged and nothing was written, and the conflict those answers are about is still the current one. This is ' +
        'usually another git process holding the repository for a moment; wait and send exactly this call again ' +
        'with the same mergeRef.',
    };
  }
  // AND THE CONFLICT ITSELF, not only the two commits it came from. See
  // conflictDigest: the commits are an argument about git's determinism, this
  // is a measurement of what git actually wrote.
  //
  // `left` is non-empty by here — the empty case is answered above by name,
  // because a digest of no files is a constant and not a measurement.
  const digestNow = conflictDigest(at, left);
  if (digestNow !== bound.digest) {
    const stuck = await abort();
    if (stuck) return stuck;
    return stale(
      { head: headNow, incoming: incomingNow, digest: digestNow },
      `both branches are where they were, but git reconciles them differently now — ${left.length} conflicting ` +
        `${left.length === 1 ? 'file' : 'files'} rather than the ones you were shown`
    );
  }
  // WHAT A CHOICE IS ALLOWED TO SAY, CHECKED BEFORE ANYTHING IS WRITTEN.
  //
  // The loop below took `choice === 'theirs'` as the only way to ask for the
  // incoming side, and anything else — an object, the reconciled file text, a
  // capitalised "THEIRS", a shape somebody guessed at — fell through to
  // `--ours` and was then COMMITTED. The envelope said `{ok: true, changed:
  // true, resolved: N}`, with `undoable: false`, so the other branch's work was
  // discarded silently and Stacki's own undo could not bring it back.
  //
  // AND IT CHECKED THE VALUES ON THE PATHS GIT REPORTED, WHICH IS ONLY HALF OF
  // IT. The loop ran over the CONFLICTED files, so a choice was only ever
  // looked up by a name git had already supplied — and every way of getting the
  // name wrong went unread. `{"src/pages/abot.astro": "theirs"}` against a real
  // clash in `about.astro` enumerated nothing, so the real file got no answer,
  // took `--ours` and was committed: the caller asked for THEIRS, got OURS, and
  // was told `ok:true, resolved:1`. A path git auto-merged, or one left over
  // from an earlier merge in the same repository, did the same. Two picks for
  // three clashes silently answered the third with `ours`; five for three
  // dropped two; `'merged'` where no combined version exists validated as
  // vocabulary and then fell through to `ours` in renderResolved; an explicit
  // `null` and an empty array both slipped the guard entirely.
  //
  // So the KEYS are enumerated as well as the values, and an array is checked
  // against the number of disagreements it claims to answer.
  //
  // A MISSING choice still keeps this branch's work. That is a deliberate
  // default and it is what the AGENT-facing documentation promises — but the
  // sentence that used to sit here, "the panel relies on it", was simply not
  // true: GitChip's choicesForSend() maps over conflict.files and emits an
  // entry for every conflicting file, always exactly clashesOf(f).length picks
  // or a whole-file string. It never omits a file, and it never sends a short
  // array, a long one, a null or an empty one.
  const WHOLE_FILE = new Set(['ours', 'theirs']);
  const PER_HUNK = new Set(['ours', 'theirs', 'both', 'merged']);
  const conflicted = new Set(left);
  // Parsed once and kept. The apply loop below reads the same answer rather
  // than opening the file a second time — and, more to the point, rather than
  // deciding a length against one parse and applying it against another.
  const parsed = new Map();
  const partsOf = (file) => {
    if (parsed.has(file)) return parsed.get(file);
    let parts = null;
    try {
      parts = parseConflict(fs.readFileSync(path.join(at, file), 'utf8'));
    } catch {
      // Binary, or one side deleted it: there is no marked-up text to split,
      // so the only answer this file can take is a whole-file one.
      parts = null;
    }
    parsed.set(file, parts);
    return parts;
  };
  // WHICH SIDES EACH CONFLICTED FILE ACTUALLY HAS, asked once.
  //
  // Stage 2 is this branch's version and stage 3 the incoming one, and a
  // modify/delete clash has only one of them. `git show :3:path` would answer
  // the same question by reading the whole blob — which for the binary files
  // this validator also has to cover means pulling a video through a pipe to
  // ask whether it exists. `ls-files -u` is the index itself, and -z for the
  // same reason conflictedPaths uses it: NUL-terminated names are verbatim, so
  // the name matched against `left` here is the name git reported there.
  //
  // AND IT WAS ASKED IN THE WRONG PATH SPACE, WHICH MADE THE WHOLE VALIDATOR
  // INERT IN THE ONE LAYOUT repoRoot EXISTS FOR.
  //
  // `left` comes from `git diff`, which spells its names from the REPOSITORY
  // ROOT. `git ls-files` is CWD-SCOPED in both directions: it prints names
  // relative to the cwd, and it OMITS everything outside the cwd. Run from the
  // project, in a repository at <root> with the project at <root>/site, the two
  // lists could not meet — `left` said "site/a.txt" and the index map was keyed
  // "a.txt". Every lookup missed, `sidesOf` fell through to its "no evidence of
  // absence" default of [ours, theirs], and the validator whose one job is to
  // say no BEFORE anything is written passed everything. MEASURED, main deletes
  // site/a.txt, feature edits it, `choices: {}`: at the repo root this refuses
  // cleanly as `bad_choices`/`no_such_side`; from <root>/site it THREW
  // `error: path 'site/a.txt' does not have our version` — the exact failure
  // the last change was written to close, still live one layout over.
  //
  // WORSE THAN INERT: MIS-BOUND. In that same layout a conflict at <root>/x.txt
  // and one at <root>/site/x.txt both key "x.txt" — one from `diff`, one from
  // the cwd-relative `ls-files` — so one file's stage set answered for the
  // other. Measured, x.txt a two-sided content clash and site/x.txt a
  // modify/delete: `{"x.txt":"ours"}`, which x.txt certainly has, was REFUSED
  // as no_such_side with `sides:["theirs"]` (site/x.txt's stages), while
  // `{"site/x.txt":"ours"}`, which genuinely has no ours, was PASSED. The
  // validator answered about the wrong file in both directions.
  //
  // Two things, and neither is enough alone. The cwd is the repository root, so
  // nothing is omitted; and `--full-name` pins the names to the root whatever
  // the cwd, so the fix does not quietly depend on `at` having resolved.
  //
  // AND THEN IT IS CHECKED, BECAUSE A MIS-BINDING IS WORSE THAN AN ABSENCE.
  //
  // Dropping the keys that are not in `left` is NOT enough and was measured not
  // to be: in the collision above the wrong-space name for site/x.txt is
  // "x.txt", which IS in `left` — it is the other conflicted file. A per-key
  // test cannot tell a right answer from a wrong one; only the shape of the
  // whole list can.
  //
  // `ls-files -u` and `diff --diff-filter=U` enumerate the same thing — the
  // unmerged entries of one index — so the set of names has to be EQUAL. A
  // difference means these two commands are not talking about the same paths,
  // and there is no per-file repair for that. So the map is built to one side
  // and adopted only if it covers `left` exactly; otherwise it is abandoned and
  // every file falls to `sidesOf`'s permissive default. That is the old bug —
  // a validator that stops adding refusals — and it is the failure to prefer:
  // the apply loop's own catch still unwinds, whereas a stage set bound to the
  // wrong file makes this refuse the merge that was fine and pass the one that
  // was not.
  const sidesByFile = new Map();
  try {
    const found = new Map();
    for (const row of (await git(at, ['ls-files', '-u', '-z', '--full-name'])).stdout.split('\0')) {
      // "<mode> <object> <stage>\t<path>"
      const tab = row.indexOf('\t');
      if (tab === -1) continue;
      const stage = Number(row.slice(0, tab).trim().split(/\s+/)[2]);
      const file = row.slice(tab + 1);
      if (!found.has(file)) found.set(file, new Set());
      found.get(file).add(stage);
    }
    if (found.size === left.length && left.every((file) => found.has(file))) {
      for (const [file, stages] of found) sidesByFile.set(file, stages);
    }
  } catch {
    /* no index to ask — every side reads as present, and the apply loop's own
       catch is what is left. Refusing here on a git that would not answer would
       turn a working merge into a refusal. */
  }
  const sidesOf = (file) => {
    const stages = sidesByFile.get(file);
    // A file the index said nothing about is not evidence of an absence, so
    // both sides read as present and nothing new is refused.
    if (!stages || !stages.size) return ['ours', 'theirs'];
    return [...(stages.has(2) ? ['ours'] : []), ...(stages.has(3) ? ['theirs'] : [])];
  };
  /**
   * ONE SIDE MISSING AND NO SIDES AT ALL ARE DIFFERENT REFUSALS.
   *
   * A conflicted path can carry stage 1 and NOTHING ELSE — the base, with
   * neither branch's own version registered under that name. MEASURED, git
   * 2.50.1, both branches renaming the same file (`orig.txt` -> `ours.txt` on
   * main, -> `theirs.txt` on feature): `diff --diff-filter=U` reports all
   * three paths and `ls-files -u` gives orig.txt stage 1 alone, so `sidesOf`
   * answers [] and the default `ours` was refused as `no_such_side` with
   * `sides: []` and `deletedBy: "ours"`. The refusal then said `"orig.txt"
   * exists on only one branch here — the other deleted it`, and the MCP
   * sentence said it `was deleted on the current branch` — three claims, all
   * false: it exists on both branches, under two different names, and nobody
   * deleted anything.
   *
   * Refusing is still right — the default is `git checkout --ours`, which dies
   * on `does not have our version` — but the reason is not that the caller
   * picked the wrong side. There is no side to pick. "ours" and "theirs" both
   * name a version to KEEP and this path has neither, so the vocabulary cannot
   * express this conflict at all, and the sentence has to say that rather than
   * send someone back to try the other word.
   */
  const noSide = (file, given, has, extra) => ({
    path: file,
    given,
    reason: has.length ? 'no_such_side' : 'no_sides',
    sides: has,
    expected: has,
    // `deletedBy` is only true of the one-sided shape. On a path with neither
    // side nobody deleted anything, and a field naming a culprit there would
    // be the same untruth the sentence is being corrected for.
    ...(has.length ? { deletedBy: given } : {}),
    ...extra,
  });
  const unusable = [];
  // A NAME GIT NEVER SAID. Named first, because it is the failure that used to
  // be completely invisible: the file the caller meant is still down there
  // waiting to take its default.
  const conflictedList = [...conflicted].slice(0, 20);
  for (const key of Object.keys(choices || {})) {
    if (conflicted.has(key)) continue;
    unusable.push({ path: key, given: key, reason: 'unknown_path', expected: conflictedList });
  }
  for (const file of left) {
    const choice = choices?.[file];
    // A FILE GIT MARKED UP THAT THIS COULD NOT READ IS A REFUSAL, NOT AN
    // "ours".
    //
    // Everything below decides what a caller is allowed to SAY. Nothing below
    // asks whether the description the caller was answering was true — and
    // when the parse cannot read git's markers it is not: the file comes back
    // as one agreed run, clashCount() is 0, and both surfaces then describe a
    // file git reported as conflicting as having no conflicting hunks. The
    // panel's choicesForSend() turns an empty hunk list into the whole-file
    // word "ours" (list[0] of an empty list), which is legal vocabulary, so the
    // all-or-nothing validator — whose stated job is to stop exactly this —
    // passed it, `git checkout --ours` ran, and the incoming branch's work was
    // committed away under `{ok: true, resolved: 1}` with the branch then
    // recorded as merged so safe-delete stopped protecting it. MEASURED end to
    // end with `*.txt text eol=crlf`; see the marker regexes in conflicts.js,
    // which is where that particular way of arriving here was fixed.
    //
    // The regexes are the cause that was found. This is the class: a whole-file
    // default must never be reached BECAUSE the file could not be read, and no
    // list of parser fixes can promise that on its own. So the shape is refused
    // by name, for every answer alike — the deliberate "theirs" as much as the
    // silent default, because the caller who typed it was answering the same
    // false description of the file.
    if (unreadMarkers(partsOf(file))) {
      unusable.push({
        path: file,
        given:
          choice === undefined
            ? 'ours'
            : Array.isArray(choice)
              ? `${choice.length} answers`
              : typeof choice === 'string'
                ? choice
                : typeof choice,
        reason: 'unreadable_conflict',
        // Nothing can be sent for this path. Left empty deliberately: an
        // `expected` listing words that will be refused again is worse than
        // none.
        expected: [],
        ...(choice === undefined ? { byDefault: true } : {}),
      });
      continue;
    }
    // Narrowed to `undefined`. An explicit null used to be read as an
    // omission, so "I have not decided about this file" and "I have decided,
    // and here is nothing" produced the same silent `--ours`.
    //
    // AND THE DOCUMENTED DEFAULT IS A CHOICE, SO IT IS VALIDATED LIKE ONE.
    //
    // "A file you leave out entirely keeps this branch's version" is what the
    // agent-facing contract promises, and it is `git checkout --ours` under the
    // covers. On a modify/delete where THIS branch deleted the file there is no
    // stage 2 for it to take, and the validator below — which knows exactly
    // that — only ever looked at choices that had been GIVEN. Measured, with
    // `choices: {}` against a clash where main deleted a.txt and feature edited
    // it: resolve THREW git's own `error: path 'a.txt' does not have our
    // version`, an unnamed failure about a default the caller never typed, and
    // a.txt did not exist afterwards. The one job of a validator is to say no
    // before anything is written; a default that cannot be carried out has to
    // go through it too.
    if (choice === undefined) {
      const has = sidesOf(file);
      if (!has.includes('ours')) {
        unusable.push(noSide(file, 'ours', has, { byDefault: true }));
      }
      continue;
    }
    if (choice === null) {
      unusable.push({ path: file, given: 'null', reason: 'null', expected: [...WHOLE_FILE] });
      continue;
    }
    if (typeof choice === 'string') {
      if (!WHOLE_FILE.has(choice)) {
        unusable.push({ path: file, given: choice, reason: 'bad_value', expected: [...WHOLE_FILE] });
        continue;
      }
      // A SIDE THAT IS IN THE VOCABULARY IS NOT ALWAYS A SIDE THIS FILE HAS.
      //
      // A modify/delete clash — one branch edited the file, the other deleted
      // it — has no stage 3 (or no stage 2, the other way round). "theirs"
      // passed this validator as a word, and then `git checkout --theirs`
      // failed with `error: path 'a.txt' does not have their version`, which
      // reached the agent as an unnamed `failed` with git's sentence in it.
      // Nothing was corrupted (the catch aborts, and HEAD and the tree were
      // measured intact) but the one job of a validator is to say no BEFORE
      // anything is written, and this got through it.
      //
      // Note what the refusal has to say as well as which sides exist: when the
      // incoming side deleted the file there is no way to ACCEPT that deletion
      // here. The vocabulary is "ours" and "theirs", both of which name a
      // version to keep, and neither names an absence. Keeping the file is the
      // only answer this file can take, and an agent that wanted the deletion
      // has to make it a commit of its own.
      const has = sidesOf(file);
      if (!has.includes(choice)) {
        unusable.push(noSide(file, choice, has));
      }
      continue;
    }
    if (Array.isArray(choice)) {
      // `[].find(...)` is undefined, so an empty array validated as a list of
      // acceptable words and then answered every clash with nothing.
      if (!choice.length) {
        unusable.push({ path: file, given: '[]', reason: 'empty', expected: [...PER_HUNK], hunks: clashCount(partsOf(file)) });
        continue;
      }
      const bad = choice.find((pick) => !PER_HUNK.has(pick));
      if (bad !== undefined) {
        unusable.push({ path: file, given: typeof bad === 'string' ? bad : typeof bad, reason: 'bad_pick', expected: [...PER_HUNK] });
        continue;
      }
      const parts = partsOf(file);
      if (parts === null) {
        unusable.push({ path: file, given: 'an array', reason: 'not_splittable', expected: [...WHOLE_FILE] });
        continue;
      }
      const hunks = clashCount(parts);
      // ONE ANSWER PER DISAGREEMENT, and exactly that many. Too few and the
      // surplus clashes took `picks[n] === undefined` — which renderResolved
      // reads as `ours`; too many and the extra answers were dropped without a
      // word. Both were `{ok:true}` over a file the caller had not described.
      if (choice.length !== hunks) {
        unusable.push({ path: file, given: choice.length, reason: 'wrong_length', hunks, expected: [hunks] });
        continue;
      }
      // 'merged' IS ONLY OFFERED WHERE IT EXISTS. It is in the vocabulary, so
      // it validated everywhere — and where no combined version was found,
      // renderResolved's `part.merged != null` fell through to `ours`.
      const clashes = parts.filter((part) => part.kind === 'clash');
      const missing = choice.findIndex((pick, i) => pick === 'merged' && clashes[i]?.merged == null);
      if (missing !== -1) {
        unusable.push({
          path: file,
          given: 'merged',
          reason: 'no_merged',
          hunk: missing,
          expected: [...PER_HUNK].filter((pick) => pick !== 'merged'),
        });
      }
      continue;
    }
    unusable.push({ path: file, given: typeof choice, reason: 'bad_shape', expected: [...WHOLE_FILE] });
  }
  if (unusable.length) {
    const stuck = await abort();
    // The choices are still wrong, but they are no longer the thing that has to
    // be said: a tree left mid-merge is a state nothing else here can read.
    // WITHOUT `badChoices` on it — the MCP mapper recognises a resolve refusal
    // by that field and would rewrite this one as `bad_choices`, which is the
    // answer that is being corrected. What could not be used is in `unusable`
    // and is the smaller problem; `merge_stuck` names the bigger one.
    if (stuck) return stuck;
    // A sentence as well as the list, because this crosses IPC to a panel as
    // well as to the MCP mapper, and a refusal with nothing to show a person is
    // a red box quoting a field name. The mapper composes a longer one from the
    // same `reason`; this is the one anybody gets who does not.
    const first = unusable[0];
    // AND THE TWO REASONS THE GENERAL SENTENCE ACTIVELY MISLEADS. "A choice is
    // 'ours' or 'theirs' for a whole file" is exactly what the caller said, so
    // reading only that leaves a person staring at a word they already used.
    // The vocabulary is not what was wrong: the file has one side, not two —
    // or, in the second case, it has none, and the vocabulary cannot say
    // anything about it at all. See noSide.
    const also =
      first.reason === 'unreadable_conflict'
        ? ` "${first.path}" still holds conflict markers Stacki could not read, so it was described as having ` +
          'no disagreements when git says it has some. Nothing that could be sent for it would be answering ' +
          'the real file. Finish that one in the project by hand.'
        : first.reason === 'no_such_side'
        ? ` "${first.path}" exists on only one branch here — the other deleted it — so it takes ` +
          `${(first.sides || []).map((side) => `"${side}"`).join(' or ')} and nothing else, ` +
          'and accepting the deletion means keeping the file now and deleting it in a commit of its own.'
        : first.reason === 'no_sides'
          ? ` "${first.path}" has no "ours" and no "theirs": git kept only the version this merge started from ` +
            'under that name, which is what both branches renaming or moving the same file leaves behind. Both ' +
            'words name a version to keep and there is neither, so no choice can answer for that path — this ' +
            'merge has to be finished in the project by hand.'
          : '';
    return {
      ok: false,
      code: 'bad_choices',
      badChoices: unusable,
      from: into,
      branch,
      message:
        `Nothing was merged: ${unusable.length} of the choices could not be used, starting with "${first.path}". ` +
        'A choice is "ours" or "theirs" for a whole file, or one answer per disagreement in that file — as many ' +
        `answers as it has disagreements, and only for files the merge actually reported.${also}`,
    };
  }

  try {
    for (const file of left) {
      const choice = choices?.[file];
      // An answer per disagreement — the file is rebuilt from git's own
      // markers with the chosen side of each. This is what makes it possible
      // to take part of a file from each branch.
      if (Array.isArray(choice)) {
        const parts = parsed.get(file);
        // Both whole versions, but only for the one case that needs them: a
        // conflict running to the end of the file, where git wrote a newline
        // after the last marker whether or not the chosen side had one. See
        // renderResolved.
        const sides = conflictAtEnd(parts)
          ? { ours: await stage(git, projectPath, 2, file), theirs: await stage(git, projectPath, 3, file) }
          : null;
        // AND A SIDE THAT IS THERE BUT WOULD NOT READ IS NOT A SIDE THAT IS NOT
        // THERE.
        //
        // `stage` answers null for both, and renderResolved reads null as "that
        // side deleted the file, so git's own terminator is the only one there
        // is" — which silently switches the final-newline correction off. For a
        // deletion that is right. For a read that failed it is a merge commit
        // one byte away from the branch it came from, with nothing anywhere
        // saying so. The index knows which of the two this is, and it was
        // already asked: `sidesByFile` is the stage map the validator built,
        // and it is consulted only when it was ADOPTED, so a repository that
        // would not answer still merges rather than being refused on a guess.
        //
        // Raising the read's bound (see STAGE_MAX_BUFFER) is what makes this
        // rare; saying so out loud is what makes it not silent.
        const unread = sides && sidesByFile.has(file)
          ? ['ours', 'theirs'].find((side) => sides[side] === null && sidesOf(file).includes(side))
          : null;
        if (unread) {
          throw new Error(
            `Could not read the ${unread === 'theirs' ? 'incoming' : 'current'} branch's version of "${file}" out of ` +
              'the merge, and the conflict runs to the end of that file — so whether it ends in a newline could not ' +
              'be settled without guessing.'
          );
        }
        fs.writeFileSync(path.join(at, file), renderResolved(parts, choice, sides));
      } else {
        // One answer for the whole file. Defaults to keeping what is on this
        // branch: a missing choice must never silently prefer the incoming
        // version over the user's own work.
        const side = choice === 'theirs' ? '--theirs' : '--ours';
        // Run from the repository root, because that is what git's own path
        // is relative to — from a project inside its repository this pathspec
        // used to name <project>/<repo-relative path> and git answered
        // "pathspec ... did not match any file(s) known to git".
        await git(at, ['checkout', side, '--', file]);
      }
      await git(at, ['add', '--', file]);
    }
    // Everything git reconciled by itself is already staged; this commits the
    // whole merge, the chosen files included.
    await git(projectPath, ['commit', '--no-edit']);
  } catch (err) {
    // Leave nothing half-merged behind — a tree stuck mid-merge is a state the
    // rest of the app has no way to draw. And when it cannot be helped, SAY SO
    // in the same sentence: this is a throw rather than an envelope, so the
    // only place the caller will ever read it is the message.
    const stuck = await abort();
    const why = String(err.stderr || err.message || '').trim() || `Could not finish merging "${branch}".`;
    throw new Error(stuck ? `${why.replace(/\.+$/, '')}. ${stuck.message}` : why);
  }
  return { ok: true, into, changed: true, resolved: left.length };
}

async function mergeBranch(git, { projectPath, branch }) {
  const into = await currentBranch(git, projectPath);
  if (branch === into) {
    throw new Error(`"${branch}" is the branch you are on — there is nothing to merge into.`);
  }
  // A name git would read as an option is not a branch. Checked before HEAD is
  // even read: `--strategy=ours` merged the upstream and reported the merge the
  // caller asked for. See usableBranchName.
  if (!(await usableBranchName(git, projectPath, branch))) {
    return badBranchName(branch, { from: into }, 'Nothing was merged.');
  }
  // Git's paths are relative to the top of the working tree, which is not
  // always the project. See repoRoot.
  const root = await repoRoot(git, projectPath);
  // No check for uncommitted work here.
  //
  // There used to be one, and it made the app refuse merges git would have
  // done: a merge only clashes with unsaved work when it touches the SAME
  // files, and most of the time it does not. Being told to commit before
  // merging — when the thing you have open is unrelated to the branch coming
  // in — is the same false obstacle that used to sit in front of switching
  // branches. Git decides; the refusal is handled below.
  const before = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  // The other end of the merge, read before it runs. Together with `before` it
  // is what a conflict is a conflict BETWEEN, and resolveMerge refuses to apply
  // answers across a move in either of them.
  const incoming = await tipOf(git, projectPath, branch);
  try {
    // --no-edit: a merge commit here must not open an editor nobody is sitting
    // at. Git still fast-forwards when it can.
    //
    // conflictStyle=diff3 writes the common ancestor into the markers as well
    // as the two sides. That third version is never offered as a choice — it
    // is what both branches started from — but it is what makes it possible to
    // tell which side actually changed each part, and so to default to the one
    // that did instead of asking about edits nobody disagrees over. Set with
    // -c so the user's own git config is not touched.
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', '--', branch]);
  } catch (err) {
    // Which files git could not reconcile — asked of git rather than scraped
    // out of its prose, which comes in several shapes (content, modify/delete,
    // add/add) and on STDOUT, not stderr. Read before the abort, which is what
    // clears it.
    let files = [];
    try {
      files = await unmergedPaths(git, projectPath);
    } catch {
      /* no index to ask about — the merge never started */
    }
    if (files.length) {
      // Both sides of every clash, read while the merge is still in progress —
      // stage 2 is this branch's version of the file, stage 3 is the incoming
      // one. This is what lets the app ask "which of these two?" instead of
      // sending someone to a terminal, which for most of the people this
      // editor is for is the same as refusing.
      const clashes = [];
      for (const file of files) {
        // The file as git left it, both versions in it and marked. Parsing
        // that rather than diffing the two sides here means the three-way
        // merge stays git's — it has the common ancestor, and this does not —
        // and each disagreement comes back separately, so a page whose heading
        // should come from one branch and whose footer should come from the
        // other can say so.
        let parts = null;
        try {
          parts = parseConflict(fs.readFileSync(path.join(root, file), 'utf8'));
        } catch {
          // A binary file, or one side deleted it: there is no marked-up text
          // to read, and the choice is the whole file or nothing.
          parts = null;
        }
        clashes.push({
          path: file,
          ours: await stage(git, projectPath, 2, file),
          theirs: await stage(git, projectPath, 3, file),
          parts,
        });
      }
      // WHICH CONFLICT THIS IS. Computed here, while the marked-up files are
      // still on disk — after the abort there is nothing left to measure, and
      // a digest taken from the copies above would be a digest of this code's
      // reading of git rather than of git.
      // AND WHICH BRANCH THIS WAS BEING MERGED INTO, the fourth fact a resolve
      // needs and the one this handle used to leave out. `head` pins
      // the COMMIT, and two branches at one commit are ordinary — a branch cut
      // and not yet committed on is exactly that — so a checkout to a sibling
      // at the same tip passed every staleness check there was and the answers
      // given about merging into `main` were committed onto the other branch.
      // See resolveMerge, which refuses that now. Named the same as `from` on
      // the envelope; `into` here because that is what the argument to
      // resolveMerge's guard is about.
      const at = { head: before, incoming, digest: conflictDigest(root, files), into };
      // Unwound before returning. Conflict markers sitting in the files would
      // be read as markup by the editor a moment later, and the page would
      // come back broken with nothing to say why. So the tree goes back to
      // exactly how it was and the choice is made against the copies above;
      // applying it re-runs the merge (see resolveMerge), which keeps the
      // markers from ever existing while anyone is looking at the app.
      try {
        await git(projectPath, ['merge', '--abort']);
      } catch {
        /* already unwound */
      }
      // WHICH PATH SPACE THOSE `path`s ARE IN, said rather than left to be
      // worked out. Every `path` above is repo-root-relative, and the project
      // is not always the repository — so a caller that wants to open one of
      // these files, or to tell an agent a path it can hand to a tool that
      // takes project-relative ones, needs the root they are relative to. The
      // MCP git domain translates with it; the panel, which is Stacki and reads
      // whole files off `ours`/`theirs`, ignores it.
      return { ok: false, conflicted: true, from: into, branch, files: clashes, at, root };
    }
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* not a conflict, or already unwound — nothing to undo */
    }
    // Unsaved work in a file the merge needs to write. Git stops without
    // moving anything, so this is a question — park it, or commit it — rather
    // than an error, and it comes back shaped like the same question from a
    // branch switch so the UI can ask it the same way.
    const detail = `${err.stdout || ''}\n${err.stderr || err.message || ''}`;
    if (/would be overwritten|Please commit your changes|Your local changes/i.test(detail)) {
      const inTheWay = detail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(error|Please|Aborting|warning|hint|Updating|Merge with)/i.test(l) && !l.endsWith(':'));
      return { ok: false, dirty: true, from: into, branch, files: inTheWay };
    }
    throw new Error(
      String(err.stderr || err.message || '').trim() ||
        `Could not merge "${branch}" into "${into}".`
    );
  }
  const after = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, into, changed: after !== before };
}

/**
 * Delete `branch`.
 *
 * `-d` is git's safe form: it refuses a branch holding commits that exist
 * nowhere else, which is the one refusal that is a question rather than an
 * error. That one comes back as `{ ok: false, unmerged: true, message }` for
 * the UI to ask about — returned rather than thrown, because a rejection
 * crossing IPC arrives as a bare string with nothing to branch on. Forcing past
 * it is a second, separately asked-for call with `force`.
 */
async function deleteBranch(git, { projectPath, branch, force, allowTrunk }) {
  // THE NAME IS SETTLED BEFORE ANY GUARD IS ASKED ABOUT IT, because every guard
  // below compares something against it and a comparison against a string that
  // is not yet a branch name compares nothing.
  //
  // THROWN, not returned, and this is the one place in the file where that is
  // deliberate rather than habit. A delete that answers `{ok:false}` in any
  // shape the MCP mapper does not recognise by name is turned into
  // `{deleted: <branch>}` — a refusal reported as a success. There is no name
  // to recognise here, because there is no branch: the caller sent an option,
  // or a spelling that means some other branch.
  if (!(await usableBranchName(git, projectPath, branch))) {
    throw new Error(badBranchName(branch).message);
  }
  // WHAT GIT WOULD DELETE, NOT WHAT WAS TYPED. Every guard below is a question
  // about a branch, so every one of them is asked about the branch git will
  // actually reach — `refs/heads/main` and `heads/main` are the trunk, and `@`
  // is the branch you are standing on, however little they look like it.
  const target = await resolvedBranch(git, projectPath, branch);
  const here = await currentBranch(git, projectPath);
  if ((target || branch) === here) {
    throw new Error(`"${branch}" is the branch you are on — switch to another one first.`);
  }
  // Git will delete main as readily as anything else — `git branch -d main`
  // succeeds the moment main is merged into wherever you are standing, which
  // after any ordinary merge it is. The button for this is hidden, and it is
  // refused here as well: the branch everything comes back to should not go
  // because a caller somewhere forgot.
  // (Reaching here at all means another branch is checked out, so there is
  // always somewhere for the trunk's work to have gone — no need to check.)
  //
  // CASE-INSENSITIVELY, because on a case-insensitive filesystem — macOS's
  // default — git resolves a loose ref through the filesystem and the guard is
  // one keystroke wide. Measured, on a repository holding only `main` and
  // `feature`: `git branch -d -- MAIN` printed "Deleted branch MAIN" and main
  // was gone, past a guard that had compared `'MAIN' === 'main'`. Where the
  // filesystem IS case-sensitive this refuses a genuinely different branch
  // called `Main`, which is a refusal with `allowTrunk` behind it rather than
  // a loss with nothing behind it.
  const trunk = (target || branch).toLowerCase();
  if (!allowTrunk && (trunk === 'main' || trunk === 'master')) {
    throw new Error(
      `"${branch}" is the branch everything comes back to. Deleting it would leave the project without its main line of work.`
    );
  }
  // AND NOTHING GOES UNDER AN ALIAS, even a harmless one.
  //
  // Deleting under a spelling that is not the branch's own name cannot be
  // reported honestly: the MCP envelope for this operation is built in
  // electron/mcp/agent/domains.js out of the caller's OWN argument
  // (`{ deleted: input.branch }`), so the only spelling whose success can be
  // described truthfully is one that names itself. It also keeps git's own
  // answer for these from being the last word — `git branch -d refs/heads/x`
  // says "branch 'refs/heads/x' not found", which is true of the spelling and
  // reads as a claim about the branch.
  if (target && target !== branch) {
    throw new Error(
      `"${branch}" is how git spells "${target}" from where you are standing, not a branch name. ` +
        'Nothing was deleted. Ask for the branch by its own name.'
    );
  }
  try {
    await git(projectPath, ['branch', force ? '-D' : '-d', '--', branch]);
  } catch (err) {
    const detail = String(err.stderr || err.message || '');
    if (/not fully merged/i.test(detail)) {
      return {
        ok: false,
        unmerged: true,
        message: `"${branch}" has commits that aren't on any other branch. Deleting it loses them.`,
      };
    }
    // Checked out somewhere else — another worktree of this same repository.
    // Not the branch you are on, so the check above let it through, and git's
    // own wording leads with a path nobody asked about.
    const worktree = detail.match(/used by worktree at '([^']+)'/);
    if (worktree) {
      throw new Error(
        `"${branch}" is checked out in another worktree (${worktree[1]}). Close or switch that one first.`
      );
    }
    throw new Error(detail.trim() || `Could not delete "${branch}".`);
  }
  // The branch that actually went, named. It is `branch` by construction —
  // anything git would have resolved elsewhere was refused above — and saying
  // so here is what lets a caller check that rather than take it on trust.
  return { ok: true, deleted: target || branch };
}

/**
 * Move to another branch.
 *
 * Plain `git switch`, tried before anything is asked. Git carries uncommitted
 * work across by itself whenever the files involved do not differ between the
 * two branches, which is nearly always — and asking "what shall I do with your
 * changes?" before trying turns the ordinary case into a dialog about a
 * problem that was not going to happen.
 *
 * When the work genuinely cannot come along, git refuses without moving HEAD
 * and names the files. That comes back as `{ ok: false, blocked: true, files }`
 * rather than an error, because it is a question for the user — leave the work
 * here, or commit it first — and a rejection crossing IPC arrives as a bare
 * string with no file list in it.
 *
 * `park` and `unpark` are passed in: they live in main.js, over the stash.
 */
async function switchBranch(git, { projectPath, branch, create, parkFirst, park, unpark }) {
  const from = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  // Before anything is parked. `--detach` went through here as a branch name
  // and answered `{ok:true, from:"main"}` with HEAD detached, so every commit
  // Stacki made afterwards landed on no branch at all. See usableBranchName —
  // and note the check is what protects `switch -c`, where the `--` cannot go
  // in front of the name.
  if (!(await usableBranchName(git, projectPath, branch))) {
    return badBranchName(branch, { from }, 'Nothing was changed and you are still on the branch you were on.');
  }
  let parked = false;
  // Only when asked. Creating a branch carries the work onto it, which is what
  // starting a branch from what is in front of you means.
  if (parkFirst && !create && park) parked = await park();
  // `switch`, not `checkout`: it does one thing, and it cannot silently detach
  // HEAD or restore a file over a mistyped branch name.
  try {
    await git(projectPath, create ? ['switch', '-c', branch, '--'] : ['switch', '--', branch]);
  } catch (err) {
    // Put the work straight back rather than leaving it stashed behind a
    // branch change that never happened.
    if (parked && unpark) await unpark(from);
    const detail = String(err.stderr || err.message || '');
    if (/would be overwritten|Please commit your changes|overwritten by/i.test(detail)) {
      const files = detail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(error|Please|Aborting|warning|hint)/i.test(l) && !l.endsWith(':'));
      return { ok: false, blocked: true, from, branch, files };
    }
    throw new Error(detail.trim() || `Could not switch to "${branch}".`);
  }
  return { ok: true, from, parked };
}

module.exports = { mergeBranch, deleteBranch, switchBranch, resolveMerge, conflictDigest };
