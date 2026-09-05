const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { parseConflict, renderResolved, clashCount, conflictAtEnd } = require('./conflicts');

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

/** The commit a revision names, or null when it names nothing. */
async function tipOf(git, projectPath, rev) {
  try {
    return (await git(projectPath, ['rev-parse', `${rev}^{commit}`])).stdout.trim() || null;
  } catch {
    return null;
  }
}

// A CONFLICTED FILE THAT CANNOT BE READ IS NOT A CONFLICTED FILE THAT IS EMPTY.
// Digesting the two the same way would let a binary clash and a blank one look
// identical, which is the one thing a digest exists not to do.
const UNREADABLE = '\0stacki:unreadable\0';

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
 */
function conflictDigest(projectPath, files) {
  const hash = crypto.createHash('sha256');
  // Sorted, so two runs that list the same clash in a different order are the
  // same conflict. Git's own order is stable in practice; relying on that
  // would make the digest a measurement of git's sort as well.
  for (const file of [...(files || [])].sort()) {
    hash.update(file, 'utf8');
    hash.update('\0');
    let bytes = null;
    try {
      bytes = fs.readFileSync(path.join(projectPath, file));
    } catch {
      bytes = null;
    }
    hash.update(bytes === null ? Buffer.from(UNREADABLE, 'utf8') : bytes);
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
/** One side of a conflicted file, or null when that side deleted it. */
async function stage(git, projectPath, n, file) {
  try {
    return (await git(projectPath, ['show', `:${n}:${file}`])).stdout;
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
  const named = bound && typeof bound.head === 'string' && bound.head && typeof bound.incoming === 'string' && bound.incoming && typeof bound.digest === 'string' && bound.digest;
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
    expected: { head: bound.head, incoming: bound.incoming, digest: bound.digest },
    current,
    message:
      `The conflict those choices were made against is not the conflict that is there now — ${why}. ` +
      `Nothing was merged and "${into}" is exactly as it was. Run git.merge on "${branch}" again and answer ` +
      'the conflict it reports this time.',
  });
  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 8) : 'nothing');
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
  let blocked = null;
  try {
    // Same style as the trial merge above, or the markers this re-parses would
    // not be the ones the answers were given against.
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', branch]);
    // It went through cleanly this time. Both commits are the ones the caller
    // was shown, so git reconciled everything by itself and kept both sides —
    // there was nothing left to choose between and nothing was discarded.
    return { ok: true, into, changed: true, resolved: 0 };
  } catch (err) {
    /* expected — it clashes again, which is what the choices are for */
    blocked = err;
  }
  const left = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
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
  }
  // AND THE CONFLICT ITSELF, not only the two commits it came from. See
  // conflictDigest: the commits are an argument about git's determinism, this
  // is a measurement of what git actually wrote.
  const digestNow = conflictDigest(projectPath, left);
  if (digestNow !== bound.digest) {
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* already unwound */
    }
    return stale(
      { head: headNow, incoming: incomingNow, digest: digestNow },
      left.length
        ? `both branches are where they were, but git reconciles them differently now — ${left.length} conflicting ` +
          `${left.length === 1 ? 'file' : 'files'} rather than the ones you were shown`
        : // Both commits are the ones the caller was shown and git produced no
          // conflict at all — and not because unsaved work was in the way,
          // which is answered above by name. What is said is what was
          // measured: there is nothing here for these answers to be about.
          'both branches are where they were, but git produced no conflict to answer this time'
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
      parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
    } catch {
      // Binary, or one side deleted it: there is no marked-up text to split,
      // so the only answer this file can take is a whole-file one.
      parts = null;
    }
    parsed.set(file, parts);
    return parts;
  };
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
    // Narrowed to `undefined`. An explicit null used to be read as an
    // omission, so "I have not decided about this file" and "I have decided,
    // and here is nothing" produced the same silent `--ours`.
    if (choice === undefined) continue;
    if (choice === null) {
      unusable.push({ path: file, given: 'null', reason: 'null', expected: [...WHOLE_FILE] });
      continue;
    }
    if (typeof choice === 'string') {
      if (!WHOLE_FILE.has(choice)) unusable.push({ path: file, given: choice, reason: 'bad_value', expected: [...WHOLE_FILE] });
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
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* already unwound */
    }
    // A sentence as well as the list, because this crosses IPC to a panel as
    // well as to the MCP mapper, and a refusal with nothing to show a person is
    // a red box quoting a field name. The mapper composes a longer one from the
    // same `reason`; this is the one anybody gets who does not.
    const first = unusable[0];
    return {
      ok: false,
      code: 'bad_choices',
      badChoices: unusable,
      from: into,
      branch,
      message:
        `Nothing was merged: ${unusable.length} of the choices could not be used, starting with "${first.path}". ` +
        'A choice is "ours" or "theirs" for a whole file, or one answer per disagreement in that file — as many ' +
        'answers as it has disagreements, and only for files the merge actually reported.',
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
        fs.writeFileSync(path.join(projectPath, file), renderResolved(parts, choice, sides));
      } else {
        // One answer for the whole file. Defaults to keeping what is on this
        // branch: a missing choice must never silently prefer the incoming
        // version over the user's own work.
        const side = choice === 'theirs' ? '--theirs' : '--ours';
        await git(projectPath, ['checkout', side, '--', file]);
      }
      await git(projectPath, ['add', '--', file]);
    }
    // Everything git reconciled by itself is already staged; this commits the
    // whole merge, the chosen files included.
    await git(projectPath, ['commit', '--no-edit']);
  } catch (err) {
    // Leave nothing half-merged behind — a tree stuck mid-merge is a state the
    // rest of the app has no way to draw.
    try {
      await git(projectPath, ['merge', '--abort']);
    } catch {
      /* already unwound */
    }
    throw new Error(
      String(err.stderr || err.message || '').trim() || `Could not finish merging "${branch}".`
    );
  }
  return { ok: true, into, changed: true, resolved: left.length };
}

async function mergeBranch(git, { projectPath, branch }) {
  const into = await currentBranch(git, projectPath);
  if (branch === into) {
    throw new Error(`"${branch}" is the branch you are on — there is nothing to merge into.`);
  }
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
    await git(projectPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', branch]);
  } catch (err) {
    // Which files git could not reconcile — asked of git rather than scraped
    // out of its prose, which comes in several shapes (content, modify/delete,
    // add/add) and on STDOUT, not stderr. Read before the abort, which is what
    // clears it.
    let files = [];
    try {
      files = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U'])).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
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
          parts = parseConflict(fs.readFileSync(path.join(projectPath, file), 'utf8'));
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
      const at = { head: before, incoming, digest: conflictDigest(projectPath, files) };
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
      return { ok: false, conflicted: true, from: into, branch, files: clashes, at };
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
  const here = await currentBranch(git, projectPath);
  if (branch === here) {
    throw new Error(`"${branch}" is the branch you are on — switch to another one first.`);
  }
  // Git will delete main as readily as anything else — `git branch -d main`
  // succeeds the moment main is merged into wherever you are standing, which
  // after any ordinary merge it is. The button for this is hidden, and it is
  // refused here as well: the branch everything comes back to should not go
  // because a caller somewhere forgot.
  // (Reaching here at all means another branch is checked out, so there is
  // always somewhere for the trunk's work to have gone — no need to check.)
  if (!allowTrunk && (branch === 'main' || branch === 'master')) {
    throw new Error(
      `"${branch}" is the branch everything comes back to. Deleting it would leave the project without its main line of work.`
    );
  }
  try {
    await git(projectPath, ['branch', force ? '-D' : '-d', branch]);
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
  return { ok: true };
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
  let parked = false;
  // Only when asked. Creating a branch carries the work onto it, which is what
  // starting a branch from what is in front of you means.
  if (parkFirst && !create && park) parked = await park();
  // `switch`, not `checkout`: it does one thing, and it cannot silently detach
  // HEAD or restore a file over a mistyped branch name.
  try {
    await git(projectPath, create ? ['switch', '-c', branch] : ['switch', branch]);
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
