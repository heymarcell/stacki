// Reading a conflicted file, and putting it back together.
//
// When a merge clashes, git writes the file with both versions in it, marked:
//
//     unchanged text
//     <<<<<<< HEAD
//     this branch's version
//     =======
//     the incoming version
//     >>>>>>> other-branch
//     more unchanged text
//
// Everything outside the markers is text both sides agree on. Everything
// inside is one disagreement — and a file can have several, which is the whole
// reason this exists: a page where the heading should come from one branch and
// the footer from the other is completely ordinary, and "keep the whole file
// from one side or the other" cannot express it.
//
// Git decides where the disagreements are, not this code. Two edits closer
// than a few lines come back as a single one, because git could not tell them
// apart either; that is a limit of the merge, not something to work around
// here.
//
// Parsing markers rather than diffing the two versions ourselves means the
// three-way merge is git's — with the common ancestor it alone has — and this
// only has to read the result.

// Longest-common-subsequence line diff, used to break one of git's conflicts
// into the separate decisions it really contains.
//
// Git groups edits that are close together into a single conflict, because its
// merge works in regions rather than in lines. So a page where the heading was
// changed on one branch and the paragraph on the other arrives as ONE choice
// covering both — and no answer to it is right: either side loses an edit, and
// "both" duplicates the heading AND the paragraph.
//
// Comparing the two sides line by line separates them again. The lines they
// agree on stop being part of the choice, and each run they disagree on
// becomes a decision of its own.
function lineDiff(a, b) {
  // A conflict big enough to make this expensive is one nobody is going to
  // resolve line by line anyway; left whole, it still works as one choice.
  if (a.length * b.length > 250000) return [{ ours: a, theirs: b }];
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const runs = [];
  let i = 0;
  let j = 0;
  const push = (run) => {
    const last = runs[runs.length - 1];
    // Adjacent runs of the same sort are one run: two changed lines next to
    // each other are one edit, not two decisions.
    if (last && !!last.common === !!run.common) {
      if (run.common) last.common.push(...run.common);
      else {
        last.ours.push(...run.ours);
        last.theirs.push(...run.theirs);
      }
      return;
    }
    runs.push(run);
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push({ common: [a[i]] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push({ ours: [a[i]], theirs: [] });
      i++;
    } else {
      push({ ours: [], theirs: [b[j]] });
      j++;
    }
  }
  if (i < m || j < n) push({ ours: a.slice(i), theirs: b.slice(j) });
  return runs;
}

// Where one side rewrote the ancestor: a list of `{start, end, lines}` over
// base line numbers, `lines` being what that side put there instead.
function changeIntervals(base, side) {
  const out = [];
  let b = 0;
  for (const run of lineDiff(base, side)) {
    if (run.common) {
      b += run.common.length;
      continue;
    }
    out.push({ start: b, end: b + run.ours.length, lines: run.theirs });
    b += run.ours.length;
  }
  return out;
}

/**
 * One of git's conflicts, split into the decisions it really contains.
 *
 * Comparing the two sides to each OTHER is not enough: when a heading was
 * edited on one branch and the paragraph beneath it on the other, every line
 * differs between the two sides and there is nothing common to split on. What
 * separates them is the ancestor — the version both started from. Against it,
 * the heading was changed only by one branch and the paragraph only by the
 * other, so they are two independent decisions and neither needs asking about.
 *
 * Returns runs: `{ common }` for text nothing touched, or
 * `{ ours, theirs, changedBy }` where `changedBy` is which side actually
 * moved — 'ours', 'theirs', or 'both' when they really do disagree.
 */
function threeWay(base, ours, theirs) {
  const A = changeIntervals(base, ours);
  const B = changeIntervals(base, theirs);
  const runs = [];
  let i = 0;
  let ai = 0;
  let bi = 0;

  while (ai < A.length || bi < B.length) {
    const start = Math.min(ai < A.length ? A[ai].start : Infinity, bi < B.length ? B[bi].start : Infinity);
    if (i < start) {
      runs.push({ common: base.slice(i, start) });
      i = start;
    }
    // Edits that OVERLAP are one decision — two rewrites of the same lines
    // cannot be answered separately. Edits that merely sit next to each other
    // are two, which is the whole point: a heading changed on one branch and
    // the paragraph under it changed on the other are adjacent, not the same
    // question, and joining them would put the user back to choosing a whole
    // block they only wanted half of.
    const mine = [];
    const yours = [];
    let end = start;
    // Take whichever starts here, then anything genuinely overlapping it. A
    // zero-width edit (a pure insertion) sitting exactly at the boundary joins
    // too: both sides inserting at one point really is one disagreement.
    const overlaps = (iv) => iv.start < end || (iv.start === end && iv.start === iv.end);
    const takeA = () => {
      end = Math.max(end, A[ai].end);
      mine.push(A[ai++]);
    };
    const takeB = () => {
      end = Math.max(end, B[bi].end);
      yours.push(B[bi++]);
    };
    if (ai < A.length && A[ai].start === start) takeA();
    if (bi < B.length && B[bi].start === start) takeB();
    for (let moved = true; moved; ) {
      moved = false;
      while (ai < A.length && overlaps(A[ai])) {
        takeA();
        moved = true;
      }
      while (bi < B.length && overlaps(B[bi])) {
        takeB();
        moved = true;
      }
    }
    // What each side says across this stretch: the ancestor's lines with that
    // side's rewrites put back in.
    const build = (ivs) => {
      const out = [];
      let p = start;
      for (const iv of ivs) {
        out.push(...base.slice(p, iv.start));
        out.push(...iv.lines);
        p = iv.end;
      }
      out.push(...base.slice(p, end));
      return out;
    };
    runs.push({
      ours: build(mine),
      theirs: build(yours),
      base: base.slice(start, end),
      changedBy: mine.length && yours.length ? 'both' : mine.length ? 'ours' : 'theirs',
    });
    i = end;
  }
  if (i < base.length) runs.push({ common: base.slice(i) });
  return runs;
}

// Words, punctuation and the gaps between them, kept separately so joining
// them back together reproduces the text exactly. Splitting on whitespace
// alone would lose the whitespace, and a merge that quietly reformats a line
// is a merge nobody can trust.
const tokenize = (text) => String(text ?? '').match(/\s+|[A-Za-z0-9_]+|[^\s A-Za-z0-9_]/g) || [];

/**
 * Two edits to the same lines that do not actually touch each other.
 *
 * A heading where one branch added a class and the other rewrote the words is
 * a single conflicted line, and answering it either way throws away one of the
 * two edits. But inside the line the changes are nowhere near each other — one
 * is in the attributes, one is in the text — so the same three-way split, run
 * over words instead of lines, separates them and both can be kept.
 *
 * Returns the combined text, or null when the edits really do overlap and
 * there is a genuine choice to make.
 */
function mergeInline(base, ours, theirs) {
  if (base == null) return null;
  const runs = threeWay(tokenize(base), tokenize(ours), tokenize(theirs));
  // Any region both sides rewrote is a real disagreement; combining it would
  // be inventing a version neither branch wrote.
  if (runs.some((r) => !r.common && r.changedBy === 'both')) return null;
  if (!runs.some((r) => !r.common)) return null; // nothing to combine
  return runs
    .map((r) => (r.common ? r.common : r.changedBy === 'theirs' ? r.theirs : r.ours).join(''))
    .join('');
}

// Which side actually made the change, judged against what both started from.
// When one side still says what the ancestor said, it did not change — so the
// other side's edit is the only edit, and defaulting to it loses nothing.
// Only when both moved is there a real disagreement to put to the user.
function whoChanged(ours, theirs, base) {
  if (base == null) return 'both';
  const inBase = (text) => text.trim() === '' || base.includes(text.trim());
  const o = inBase(ours);
  const t = inBase(theirs);
  if (o && !t) return 'theirs';
  if (t && !o) return 'ours';
  return 'both';
}

// GIT WRITES ITS MARKERS WITH THE FILE'S OWN LINE ENDING, AND NEITHER `.` NOR
// `$` COULD SEE PAST A CARRIAGE RETURN.
//
// A conflicted file that uses CRLF — anything authored on Windows, anything
// under `core.autocrlf`, anything a .gitattributes marks `text eol=crlf` — has
// its marker written as `<<<<<<< HEAD\r`. These lines are cut on '\n', so the
// '\r' is still on the end of each one, and in JavaScript `.` does not match a
// carriage return while `$` without the `m` flag matches only at the very end
// of the string. `/^<<<<<<< ?(.*)$/` therefore could not match ANY marker in
// such a file.
//
// The consequence was not a worse parse, it was no parse: the whole marked-up
// file — markers, both sides, the ancestor — came back as one `{kind:'same'}`
// part, clashCount() was 0, and the panel's choicesForSend() then took its
// `!list.length` branch and sent the whole-file word "ours" (list[0] being
// undefined). MEASURED end to end against real git with `*.txt text eol=crlf`:
// resolveMerge validated "ours" as legal vocabulary, ran `git checkout --ours`,
// committed a real two-parent merge and answered
// `{ok: true, changed: true, resolved: 1}` — with the incoming branch's work
// nowhere in the tree and the branch now recorded as merged, so the
// safe-delete guard stopped protecting it. On the MCP side the same file went
// out as `{hunks: [], hunksOmitted: false}`: a file git had reported as
// conflicting, described to the agent as having no conflicting hunks.
//
// So every marker tolerates the terminator its file uses.
//
// AND SEVEN IS NOT THE ONLY WIDTH GIT WRITES.
//
// `conflict-marker-size=<n>` in .gitattributes is a documented per-path
// property, and git obeys it for ANY positive integer. MEASURED, git 2.50.1,
// `*.txt conflict-marker-size=32`: git writes a thirty-two-character opener,
// ancestor line, separator and closer, and reports the path unmerged exactly as
// it always does. Sizes 1 through 200 all came out at the width asked for; 0,
// a negative and a non-integer fall back to seven (git warns on the last).
//
// Against markers of a width these regexes did not know about, the parse failed
// in TWO different ways, and neither of them was a refusal:
//
//   WIDER than seven. `^<<<<<<<` matched the first seven characters of a
//   thirty-two-character opener and `(.*?)` swallowed the other twenty-five as
//   the label — so the opener, the ancestor line and the closer all still
//   matched, and only the SEPARATOR did not: `/^=======\s*$/` cannot match
//   thirty-two '=' because `\s*$` has nothing to eat the surplus with. The
//   separator line and everything after it therefore fell into the ANCESTOR
//   bucket, and the incoming side came out EMPTY. MEASURED end to end with real
//   git at sizes 9 and 32, LF and CRLF alike: the file was described — to the
//   panel and to the agent, with `markersUnread: false` — as one hunk whose
//   incoming side deletes those lines, which is a FALSE description rather than
//   a missing one, and answering it `['theirs']` wrote `"head\ntail\n"`, bytes
//   NEITHER BRANCH EVER WROTE, staged them and committed a real two-parent
//   merge as `{ok: true, changed: true, resolved: 1}` over a clean tree. Both
//   branches' work gone, in silence, from a choice the caller made against a
//   description that was not true.
//
//   NARROWER than seven. `<<< HEAD` matched nothing at all, so the whole
//   marked-up file came back as one agreed part — clashCount() 0 — and
//   `unreadMarkers`, whose exact-seven pattern is the class backstop, did not
//   see it either. MEASURED at size 3: `choices: {}` committed this branch's
//   version and answered `{ok: true, resolved: 1}`, the incoming branch's work
//   committed away under a description that said there was nothing to decide.
//
// So the width is a PARAMETER, taken from git's own answer for that path (see
// conflictMarkerSizes in gitBranches.js, which asks `git check-attr`), and the
// markers are matched at EXACTLY that width — `(?!<)` after the run, so a
// longer one is not a match by prefix and a shorter one is not a match at all.
// Seven is the default for every caller that does not say, which is what git
// itself does with an unset or unusable attribute.
const DEFAULT_MARKER_SIZE = 7;

// The largest width git itself will take. MEASURED: `conflict-marker-size=5000`
// and `=100000` are both honoured — git writes a marker that many characters
// wide. ABOVE that, at 4294967296 and at twenty digits, git says
// `warning: invalid marker-size '...', expecting an integer` and uses SEVEN;
// `check-attr` reports the raw string either way, so reading it without this
// bound would take a width git had just refused, match nothing against the
// seven-character markers it really wrote, and refuse an entirely ordinary
// merge. That is what the bound is for.
//
// AND WHAT THE BOUND IS NOT FOR. This comment used to say `=2147483647` "is
// accepted as a number but produces a conflicted path with no markers written
// into it at all". It does not: re-measured on git 2.50.1 (Apple Git-155),
// `=2147483647` and `=1073741824` both kill git with SIGBUS trying to allocate
// the marker, and it leaves NO conflict behind — no unmerged path, no
// MERGE_HEAD, the file untouched. Stacki then answers the unnamed `failed` with
// git's own words, which is a git crash reported as a git crash. Nothing here
// prevents it and nothing here should pretend to: the bound is about the width
// git REFUSES, not about the width that kills it.
const MAX_MARKER_SIZE = 2147483647;

/** Git's own reading of the attribute: a positive integer it can use, or seven. */
const markerWidth = (size) =>
  Number.isInteger(size) && size > 0 && size <= MAX_MARKER_SIZE ? size : DEFAULT_MARKER_SIZE;

// Compiled once per width. A merge touches one width almost always, and
// rebuilding four regexes per file for the sake of it is the kind of cost that
// only ever shows up on the conflict with three hundred files in it.
//
// Bounded, because the widths come from a file in the repository being merged
// and a .gitattributes can name a different one for every path in it. This is a
// convenience, not a store: past the bound it starts again rather than growing
// for as long as the app is open.
const MARKER_CACHE_MAX = 64;
const markerCache = new Map();

function markersFor(size) {
  const n = markerWidth(size);
  const cached = markerCache.get(n);
  if (cached) return cached;
  if (markerCache.size >= MARKER_CACHE_MAX) markerCache.clear();
  // EXACTLY n of the character and no more. Without the negative lookahead a
  // width-7 pattern matches the first seven characters of a width-32 marker and
  // reads the remaining twenty-five as a label — which is the shape that
  // committed bytes neither branch wrote. See above.
  const run = (ch) => {
    const one = ch === '|' ? '\\|' : ch;
    return `${one}{${n}}(?!${one})`;
  };
  const built = {
    size: n,
    // `[ \t](.*?)\r?$`: THE SPACE IS REQUIRED, AND THAT IS THE WHOLE OF THE RULE.
    //
    // These used to read ` ?(.*?)` — the space optional — on the reasoning that
    // "a bare marker with no label is tolerated the way it always was". Meanwhile
    // `unreadMarkers`, the backstop whose one job is to notice when this parse is
    // wrong, took the opposite reading and ignored bare runs. Both halves of one
    // file cannot be right, and the permissive half was the one that cost a
    // commit: MEASURED, a page documenting conflict markers with UNLABELLED ones
    // — which is how a great deal of documentation writes them — had its bare
    // `<<<<<<<` read as structure, and the block it opened was invisible to the
    // backstop, so answering committed a file equal to neither branch. The
    // mirror image, a bare `>>>>>>>` in one side closing git's real block early,
    // rendered the ANCESTOR section into the file.
    //
    // Git settles it. MEASURED across `merge` in all three conflict styles, on a
    // detached HEAD, and `git merge-file --diff3` both with no `-L` at all and
    // with three EMPTY `-L` labels: the opener, the ancestor line and the closer
    // ALWAYS carry the separating space — `<<<<<<< ` even when the label is the
    // empty string — and the SEPARATOR is always bare. So a bare run of angle
    // brackets or pipes is content, and is kept as content, which is the reading
    // the backstop already had.
    START: new RegExp(`^${run('<')}[ \\t](.*?)\\r?$`),
    // `\s*` matches '\r' as well as trailing spaces, which is how the separator
    // survived CRLF before any of this was deliberate. This one IS bare: that is
    // what git writes.
    MIDDLE: new RegExp(`^${run('=')}\\s*$`),
    BASE: new RegExp(`^${run('|')}[ \\t](.*?)\\r?$`), // only present under diff3 conflict style
    END: new RegExp(`^${run('>')}[ \\t](.*?)\\r?$`),
  };
  markerCache.set(n, built);
  return built;
}

/**
 * A conflicted file as a list of parts.
 *
 * Each part is either `{ kind: 'same', text }` — agreed text — or
 * `{ kind: 'clash', ours, theirs, oursLines, theirsLines }`, one disagreement.
 * Joining the `same` parts with a chosen side of each `clash` rebuilds the
 * file; the two counts are how many LINES each side has, which its text cannot
 * be asked once a side of no lines and a side of one blank line are both the
 * empty string. See `sideLines`.
 *
 * A file with no markers comes back as a single `same` part, which is the
 * honest answer: there is nothing to choose.
 *
 * `markerSize` is the width git wrote its markers at for THIS path — the
 * `conflict-marker-size` attribute, asked of git rather than guessed from the
 * text. Left out, it is git's own default of seven, which is what git uses when
 * the attribute is unset or unusable. See markersFor.
 */
function parseConflict(text, markerSize, fromDiff3 = false) {
  const { START, MIDDLE, BASE, END } = markersFor(markerSize);
  const lines = String(text ?? '').split('\n');
  const parts = [];
  let same = [];
  let i = 0;

  const flushSame = () => {
    if (same.length) parts.push({ kind: 'same', text: same.join('\n') });
    same = [];
  };

  while (i < lines.length) {
    if (!START.test(lines[i])) {
      same.push(lines[i]);
      i++;
      continue;
    }
    // WHERE THE STRUCTURE IS, COUNTED RATHER THAN LATCHED.
    //
    // This used to walk the block with two booleans — "have I seen a separator
    // yet", "have I seen the ancestor line yet" — and put every other line in
    // whichever bucket those two named. A separator is `=======` and an ancestor
    // line is `|||||||`, and A LINE OF SOURCE CAN BE EITHER OF THOSE. Git does
    // not widen its own markers to avoid the collision (MEASURED: at the default
    // width it wrote a second `<<<<<<< HEAD` directly under one already in the
    // file), which is exactly why `conflict-marker-size` exists.
    //
    // What the latch did with such a line was not a worse parse, it was a wrong
    // one, and it committed. MEASURED, real git, both branches adding a section
    // whose text contains a bare `=======` line: git's block was
    // `<<< / Title / ======= / OURS / ||| / ======= / Other / ======= / THEIRS /
    // >>>`, the FIRST of those three separators was taken as git's, and the file
    // came back as one hunk with `ours: "Title"` and
    // `theirs: "OURS\nOther\nTHEIRS"` — this branch's own OURS line attributed
    // to the incoming side. `markersUnread` was false, the panel and the agent
    // were both shown that, and `['theirs']` wrote
    // `"top\nOURS\nOther\nTHEIRS\nbottom\n"` — equal to NEITHER branch —
    // staged it and committed a two-parent merge as `ok: true`. The same latch
    // on the ancestor line lost a line the other way round.
    //
    // So the structure is located by counting, and a block git wrote has exactly
    // one separator and at most one ancestor line, the ancestor line first.
    // Anything else is a block whose shape cannot be decided from the text, and
    // guessing at it is the failure above. Those are kept verbatim instead — see
    // the refusal below — which costs a merge that has to be finished by hand
    // and is what `conflict-marker-size` is for.
    let closed = false;
    let j = i + 1;
    const middles = [];
    const bases = [];
    const opens = [];
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (END.test(line)) {
        closed = true;
        break;
      }
      if (MIDDLE.test(line)) middles.push(j);
      // Under diff3 the common ancestor sits between the two sides. It is not
      // a third choice — it is what both started FROM — but it is what says
      // which side actually changed, so it is kept and never offered.
      else if (BASE.test(line)) bases.push(j);
      // AND THE OPENER, WHICH IS THE ONE MARKER NOTHING WAS COUNTING.
      //
      // The other three are found by scanning INSIDE a block, so counting them
      // was natural. The opener is what BEGINS the block, and the line that
      // began this one was never asked whether it was git's. MEASURED, real
      // git, a page whose prose shows a reader what a conflict looks like —
      // six identical lines on both branches, so git leaves them outside its
      // markers entirely — with a real conflict further down: the AUTHORED
      // `<<<<<<< HEAD` opened a block, git's real closer closed it, and the
      // block between them had exactly one separator and one ancestor line, so
      // every structural rule passed. Two hunks were reported where git wrote
      // one, `markersUnread` was false, and answering them committed
      // "A merge conflict looks like this:\ntheirs\nIntro\nTHEIRS\nEnd\n" —
      // the prose gone, a line of it replaced by half of the example — as
      // `{ok: true, resolved: 1}`. Equal to neither branch.
      //
      // Git does not nest its blocks. A second opener inside one is therefore
      // the same evidence the other three are: this is not a block git wrote,
      // and it is kept whole rather than guessed at.
      else if (START.test(line)) opens.push(j);
    }
    // A BLOCK THIS DID NOT FULLY READ IS KEPT WHOLE, NEVER HALF-READ.
    //
    // `closed` was once the only test here, and a block missing its SEPARATOR
    // still passed it: everything from the opener to the closer went into `ours`
    // and the incoming side came out empty — a hunk saying "the other branch
    // deleted this", which is a claim, not a gap. That is the shape a
    // wider-than-seven marker produced before the width became a parameter, and
    // it committed bytes neither branch wrote.
    //
    // Git writes one shape and only one: an opener, an optional ancestor line
    // under diff3, a separator, a closer, every one of them at the same width
    // and in that order, and never nested. A block that is not that shape —
    // unclosed, without a separator, with a second opener, a second separator
    // or a second ancestor line inside it, or with the ancestor line after the
    // separator — is not a block git wrote at this width, and the honest answer
    // is that it was not read. Its lines stay verbatim in the agreed
    // text, where `unreadMarkers` finds the opener still sitting in them and
    // every caller downstream refuses the path by name rather than answering
    // for it.
    // AND UNDER diff3, THE ANCESTOR LINE IS NOT OPTIONAL — WHICH TELLS GIT'S
    // BLOCK FROM ONE SOMEBODY TYPED IN THE DEFAULT SPELLING, AND ONLY THAT ONE.
    //
    // This comment used to claim the ancestor line tells git's block from any
    // block somebody typed. It does not, and the next review said so: an
    // authored example written in the DIFF3 spelling has an ancestor line too,
    // and passes every rule in this function. What answers that is not the shape
    // of the markup at all — see sidesHoldMarkers, which asks git instead.
    //
    // Counting the markers inside a block cannot see a block that is WELL
    // FORMED and simply is not git's. MEASURED, real git, a page whose prose
    // shows a reader what a conflict looks like — the ordinary
    // `<<<<<<< HEAD / ======= / >>>>>>> branch` of the DEFAULT conflict style,
    // six lines identical on both branches so git leaves them outside its
    // markers entirely — with a real conflict further down: the authored block
    // parsed as a conflict of its own, `markersUnread` was false, TWO hunks were
    // reported where git wrote one, and answering them committed
    // "A merge conflict looks like this:\ntheirs\nIntro\nTHEIRS\nEnd\n" as
    // `{ok: true, resolved: 1}` — the prose rewritten, and equal to neither
    // branch.
    //
    // Stacki merges with `-c merge.conflictStyle=diff3` and nothing else, and
    // git under diff3 writes the ancestor line into EVERY block. MEASURED over
    // the shapes that might not have one: an ordinary content clash, add/add
    // with no common ancestor at all, both branches appending at end of file,
    // one side deleting what the other changed, a criss-cross with two merge
    // bases, and a region whose ancestor is empty — all six, one block, one
    // `|||||||` line. So a block without one, in markup that came from such a
    // merge, is not a block that merge wrote.
    //
    // `fromDiff3` is passed by the two callers that know how the markup was
    // made and by nobody else: a caller handing this ordinary `merge`-style
    // text — which is what every fixture in test/conflicts.js does — still gets
    // the forgiving reading, because for that caller the ancestor line really is
    // optional.
    if (
      !closed ||
      opens.length ||
      middles.length !== 1 ||
      bases.length > 1 ||
      (bases.length === 1 && bases[0] > middles[0]) ||
      (fromDiff3 && bases.length !== 1)
    ) {
      same.push(lines[i]);
      i++;
      continue;
    }
    const middleAt = middles[0];
    const baseAt = bases.length ? bases[0] : -1;
    const sawBase = baseAt !== -1;
    const ours = lines.slice(i + 1, sawBase ? baseAt : middleAt);
    const base = sawBase ? lines.slice(baseAt + 1, middleAt) : [];
    const theirs = lines.slice(middleAt + 1, j);
    // One of git's conflicts is often several decisions wearing one coat.
    // Comparing the two sides line by line separates them, so the lines they
    // agree on stop being part of the choice and each run they disagree on
    // becomes its own.
    // With the ancestor, the split is exact — each side's edits are known
    // rather than guessed at. Without it (a repo not set to record it) the two
    // sides are compared to each other, which still separates edits that share
    // untouched lines between them.
    const split = sawBase
      ? threeWay(base, ours, theirs)
      : lineDiff(ours, theirs).map((r) =>
          r.common ? r : { ...r, changedBy: whoChanged(r.ours.join('\n'), r.theirs.join('\n'), null) }
        );
    // AND A BLOCK THAT SPLITS INTO NO DISAGREEMENT AT ALL IS NOT A BLOCK EITHER.
    //
    // Git does not write a conflict whose two sides are identical — it has
    // nothing to ask about — so a block whose split holds no clash is one this
    // did not understand. It used to be DROPPED: the flush ran, the empty split
    // contributed nothing, and the opener, separator and closer left the parse
    // entirely. MEASURED on the three-line block `<<<<<<< HEAD / ======= /
    // >>>>>>> x` a person had typed into a page: clashCount() 0, no unread
    // marker to find, and rebuilding the file returned it three lines shorter
    // than it went in — silent deletion out of the one function whose comment
    // promises nothing is ever silently dropped.
    //
    // Kept whole instead, for the same reason and with the same consequence as
    // the shapes above: the opener stays in the agreed text and the path is
    // refused rather than answered.
    if (!split.some((run) => !run.common)) {
      same.push(lines[i]);
      i++;
      continue;
    }
    flushSame();
    for (const run of split) {
      if (run.common) {
        // AGREED TEXT THAT CAME OUT FROM BETWEEN THE MARKERS, MARKED AS SUCH.
        //
        // Agreed text is agreed text either way, but WHERE it came from is the
        // difference between a terminator git invented and one both branches
        // wrote. Everything inside a conflict block that ends the file ran to
        // the end of that file — whether the split left a clash sitting there
        // or a run the two sides happen to agree on — and `conflictAtEnd`
        // could only recognise the first of those. See its note.
        parts.push({ kind: 'same', text: run.common.join('\n'), inClash: true });
        continue;
      }
      const clash = {
        kind: 'clash',
        ours: run.ours.join('\n'),
        theirs: run.theirs.join('\n'),
        // HOW MANY LINES EACH SIDE HAS, WHICH THE TEXT ITSELF CANNOT SAY. See
        // `sideLines`: a side that was DELETED and a side that is one BLANK
        // line are the same empty string, and rebuilding the two has to produce
        // different files.
        oursLines: run.ours.length,
        theirsLines: run.theirs.length,
        changedBy: run.changedBy || 'both',
      };
      // Both sides touched these lines — but perhaps not the same part of
      // them. Splitting again by word finds out, and where the two edits do
      // not overlap, keeping both is the answer nobody has to think about.
      if (clash.changedBy === 'both' && run.base) {
        const merged = mergeInline(run.base.join('\n'), clash.ours, clash.theirs);
        if (merged !== null) clash.merged = merged;
      }
      parts.push(clash);
    }
    i = j + 1;
  }
  flushSame();
  return parts;
}

/** How many disagreements are in a parsed file. */
const clashCount = (parts) => (parts || []).filter((p) => p.kind === 'clash').length;

/**
 * Whether the file's last line is inside the last disagreement.
 *
 * THE ONE PLACE THE FINAL NEWLINE IS NOT IN THE MARKED-UP FILE.
 *
 * A marker has to sit on a line of its own, so when the conflict runs to the
 * end of the file git writes a newline after the chosen side's last line
 * whether or not that side had one. Everywhere else the terminator is ordinary
 * text and survives the round trip; here it is git's invention, and rebuilding
 * from the marked-up file alone cannot tell an invented one from a real one.
 *
 * Recognised as a shape rather than guessed at: the parse ends with the empty
 * `same` part that a file-ending newline always produces, and what comes
 * before it is the conflict block.
 *
 * AND THE BLOCK IS NOT ALWAYS A CLASH BY THE TIME IT GETS HERE.
 *
 * `parseConflict` splits git's block into the runs the two sides actually
 * disagree on, so a conflict whose sides END THE SAME WAY comes back as a
 * clash followed by the agreed run — and the empty part was then preceded by
 * `same`, not by `clash`, and this answered false. MEASURED with real git,
 * base "head\nBASE\ntail\n", ours "head\nOURS\ntail\n", theirs
 * "head\nTHEIRS\ntail" with NO terminator: git conflicts the whole tail
 * (the last lines differ by that missing newline), the parse is
 * [same "head", clash, same "tail", same ""], and `{'a.txt': ['theirs']}`
 * committed "head\nTHEIRS\ntail\n" — a newline neither branch wrote — while
 * `{'a.txt': 'theirs'}`, the same decision in the other shape, committed the
 * blob exactly. `ok: true, resolved: 1` both times.
 *
 * So the walk back skips the agreed runs that came from INSIDE the block —
 * `inClash`, stamped by the split — and asks whether the block itself is what
 * the file ends in. Runs of ordinary agreed text after the block (a common
 * suffix git never marked up) carry no stamp and still stop the walk, because
 * a terminator out there is one the file really has.
 */
function conflictAtEnd(parts) {
  const list = parts || [];
  const last = list[list.length - 1];
  if (!last || last.kind !== 'same' || last.text !== '') return false;
  let at = list.length - 2;
  while (at >= 0 && list[at].kind === 'same' && list[at].inClash) at -= 1;
  const before = list[at];
  return !!before && before.kind === 'clash';
}

/**
 * How many LINES a side of a clash has, which its text cannot be asked.
 *
 * ONE BLANK LINE AND NO LINES AT ALL ARE THE SAME EMPTY STRING. Measured with
 * real git from the ancestor "a\nX\nz\n": a branch that DELETED X and a branch
 * that replaced X with a BLANK line both parse to `{ours: '', theirs: 'C'}`,
 * byte for byte — and rebuilding them has to produce different files, "a\nz\n"
 * for the deletion and "a\n\nz\n" for the blank line. Joining the parts cannot
 * decide between them from the string, so `parseConflict` records the count and
 * everything that has to know asks here.
 *
 * A part built by hand carries no count, and the empty string is then read as
 * no lines at all: that is the shape git writes far more often — one branch
 * deleting what the other changed — and it is already the reading the rest of
 * this file takes.
 */
const sideLines = (part, side) => {
  const counted = part?.[side === 'theirs' ? 'theirsLines' : 'oursLines'];
  if (Number.isInteger(counted)) return counted;
  return part?.[side] === '' ? 0 : 1;
};

/**
 * Put the file back together, given one answer per disagreement.
 *
 * `picks` is an array in the order the clashes appear: `'ours'`, `'theirs'`,
 * or `'both'`. Missing or unrecognised answers keep `ours` — between silently
 * dropping the user's own work and silently dropping work they asked to merge
 * in, the first is worse, because the incoming version is still on its branch
 * and theirs may exist nowhere else.
 *
 * `sides` is the two whole versions git is holding — `{ours, theirs}` from
 * stages 2 and 3 — and it is here for one reason: the final newline above.
 * MEASURED, both ways round: with an incoming file that ends without a
 * terminator, `choices: {'a.txt': 'theirs'}` committed `"a\nfeat"` while
 * `choices: {'a.txt': ['theirs']}` committed `"a\nfeat\n"`. Same decision, two
 * different files, and which one you got depended on the shape you happened to
 * phrase it in. Left out, this argument changes nothing — a caller with no
 * stages to hand gets what it always got.
 */
function renderResolved(parts, picks = [], sides = null) {
  let n = -1;
  // A CHOSEN SIDE WITH NO LINES IN IT USED TO BECOME A BLANK LINE.
  //
  // The parts are runs of LINES and the join puts a newline between them, so a
  // hunk that contributes nothing still got a separator on each side of it and
  // the rebuilt file gained an empty line NEITHER BRANCH HAD. That is the
  // ordinary shape of one branch deleting lines the other modified, and it was
  // written, staged and committed as `{ok: true, changed: true, resolved: 1}`.
  // MEASURED with real git — base "a\nX\nz\n", ours "a\nz\n", theirs
  // "a\nC\nz\n", answered `['ours']` — the commit read "a\n\nz\n" against an
  // `ours` that simply had nothing there.
  //
  // So a run of no lines is dropped from the join rather than joined as an
  // empty one, which removes exactly one separator with it. `both` is asked the
  // same way and keeps its newline between two sides that BOTH have lines.
  const chunks = [];
  // The last CLASH that put anything into the file; null while nothing has.
  let endedOn = null;
  for (const part of parts || []) {
    if (part.kind === 'same') {
      // NOT reset here. A conflict block whose two versions end the same way
      // splits into a clash and the agreed run after it, and `conflictAtEnd`
      // calls that shape a conflict at the end — so the terminator behind that
      // agreed run is still the chosen side's. See conflictAtEnd.
      chunks.push(part.text);
      continue;
    }
    n++;
    const pick = picks[n];
    let piece;
    let lines;
    // Both edits, combined — only offered where they were found not to
    // overlap, so this is the two changes and not a duplication.
    if (pick === 'merged' && part.merged != null) {
      piece = part.merged;
      // A combined version is text rather than a list of lines, so there is no
      // count to read: empty is nothing, the same reading the terminator below
      // has always taken of it.
      lines = piece === '' ? 0 : 1;
    } else if (pick === 'theirs') {
      piece = part.theirs;
      lines = sideLines(part, 'theirs');
    } else if (pick === 'both') {
      // Both sides, in the order they appear in the file. A heading changed on
      // two branches is usually one or the other; a list that gained an item on
      // each is usually both. A side with no lines is not one of them — and
      // this asks the count rather than the string, so a side that IS one blank
      // line is kept.
      const kept = ['ours', 'theirs'].filter((side) => sideLines(part, side) > 0);
      piece = kept.map((side) => part[side]).join('\n');
      lines = kept.length;
    } else {
      piece = part.ours;
      lines = sideLines(part, 'ours');
    }
    if (lines === 0) continue;
    // WHICH CLASH THE FILE ACTUALLY ENDS ON, recorded as it is written rather
    // than assumed to be the last one. A clash whose chosen side has no lines
    // contributes nothing, so the file ends on whatever came before it — see
    // the terminator block below, which used to ask the last clash regardless.
    endedOn = { part, pick };
    chunks.push(piece);
  }
  const text = chunks.join('\n');
  if (!sides || typeof sides !== 'object' || !conflictAtEnd(parts) || !text.endsWith('\n')) return text;
  // WHOSE LAST LINE THIS NOW IS — READ OFF THE TEXT, NOT OFF THE WORD.
  //
  // This used to map the ANSWER to a side: 'both' and 'merged' were taken to
  // end on the incoming side because that is the side written last. But 'both'
  // renders `[ours, theirs].filter(s => s !== '').join('\n')`, so when the
  // incoming side of the LAST clash is empty the file ends on OURS while the
  // terminator was still being read off `sides.theirs`. MEASURED, with ours
  // `"head\nOURSLAST\n"` and theirs `"head"` with no terminator: `['both']`
  // wrote `"head\nOURSLAST"` and `['ours']` wrote `"head\nOURSLAST\n"` — the
  // same retained content, one byte apart, decided by which of two equivalent
  // words the caller happened to use.
  //
  // So the side is the one the rendered text actually ENDS on. 'merged' is
  // asked the same way, by suffix, because a combined version ends on whichever
  // side contributed its last run and there is no word that says which.
  // THE CLASH THE FILE ENDS ON, not the last one in the list.
  //
  // These were `parts.filter(clash).at(-1)` and `picks.at(-1)`, which is the
  // same thing only while the last clash contributed lines. When its chosen
  // side has ZERO — the ordinary shape of one branch deleting a trailing line —
  // the file does not end on that clash at all, and its terminator was still
  // read off that side's blob and stripped. MEASURED, ours "a\nX" and theirs
  // "a\nY\n\n" over two hunks: `["theirs","ours"]` committed "a\nY", leaving
  // "Y" unterminated although the "Y" came from theirs and theirs terminates
  // it; `["theirs","theirs"]` committed "a\nY\n\n". Two answers differing by
  // one blank line produced files differing by two bytes.
  //
  // WHEN NO CLASH CONTRIBUTED ANYTHING AT ALL, the rendered file is the agreed
  // text alone — which is the whole of the version being taken, terminator and
  // all. So the last answer still names the version to read it off, which is
  // the reading this had before and the one `atEnd` in test/conflicts.js pins:
  // ours "a", theirs "a\nC\n", answered `['ours']`, is "a" and must not gain a
  // newline. That case and the one above are told apart by whether any clash
  // put a line in, not by which clash is last.
  const list = parts || [];
  const clashes = list.filter((part) => part.kind === 'clash');
  const last = endedOn ? endedOn.part : clashes[clashes.length - 1] || null;
  const pick = endedOn ? endedOn.pick : picks[clashes.length - 1];
  // The last line is sometimes neither side's — it is BOTH sides'. A conflict
  // block whose two versions end the same way splits into a clash and the
  // agreed run after it (see `conflictAtEnd`), so the file can end on text that
  // is in both versions. The question is unchanged: the terminator behind that
  // line is in one version and not the other, and the answer names the version
  // to read it off. 'ours' and 'theirs' name one outright; 'both' and 'merged'
  // fall through to the same readings as everywhere else, which is where they
  // belong — with no line of its own at the end of the file, neither word
  // claims anything this could be more precise about.
  // AND 'ours'/'theirs' ARE ASKED THE SAME QUESTION, because a word does not
  // make a side the one the file ends on.
  //
  // This read the side straight off the pick, and `both` was corrected to ask
  // by line count while these two were left. When the LAST clash's chosen side
  // has ZERO lines — the ordinary shape of one branch deleting a trailing line
  // — the rendered file does not end on that clash at all, and its terminator
  // was still taken off that side's whole blob and stripped. MEASURED, ours
  // "a\nX" and theirs "a\nY\n\n" over two hunks: `["theirs","ours"]`
  // committed "a\nY" — "Y" left with no terminator, although the "Y" came from
  // theirs and theirs terminates it. `["theirs","theirs"]` committed
  // "a\nY\n\n". The two answers differ by one blank line; the files differed
  // by two bytes.
  //
  // A clash whose chosen side contributed nothing falls through to null, which
  // is already the reading for "neither side put anything at the end": git's
  // own terminator is then the only one there is, and the rendered text keeps
  // it.
  let endsOn = 'ours';
  if (pick === 'theirs') endsOn = 'theirs';
  // Asked by line count, the same question the `both` render above asks, so
  // the side the terminator is read off is the side that actually got written.
  else if (pick === 'both') endsOn = sideLines(last, 'theirs') > 0 ? 'theirs' : sideLines(last, 'ours') > 0 ? 'ours' : null;
  else if (pick === 'merged' && last?.merged != null) {
    if (last.merged === '') endsOn = null;
    else if (last.theirs !== '' && last.merged.endsWith(last.theirs)) endsOn = 'theirs';
    else if (last.ours !== '' && last.merged.endsWith(last.ours)) endsOn = 'ours';
    else endsOn = 'theirs';
  }
  // Neither side put anything at the end of the file, so there is no version's
  // terminator to take: git's own newline is the only one there is.
  if (endsOn === null) return text;
  const source = endsOn === 'theirs' ? sides.theirs : sides.ours;
  // Null is a side that deleted the file. There is no version of it to take a
  // terminator from, so git's own is the only answer there is.
  if (typeof source !== 'string' || source === '' || source.endsWith('\n')) return text;
  // AND THE TERMINATOR TAKEN OFF IS THE FILE'S OWN, WHICH IS NOT ALWAYS ONE
  // BYTE.
  //
  // This used to slice exactly one character. In a CRLF file that removes the
  // '\n' of a '\r\n' pair and leaves the '\r' behind — a byte NEITHER BRANCH
  // WROTE, on the last line of the file, invisible in every editor that draws
  // it. MEASURED with real git and `*.txt text eol=crlf`, ours
  // "head\r\nOURS\r\n" and theirs "head\r\nTHEIRS" with no terminator: the
  // answer `['theirs']` rendered "head\r\nTHEIRS\r" where git's own checkout
  // of that side is "head\r\nTHEIRS", and `['both']` rendered
  // "head\r\nOURS\r\nTHEIRS\r". Written, staged and committed as
  // `{ok: true, resolved: 1}`.
  //
  // How much to take is asked of the SIDE, not guessed from the text: the
  // chosen version has no terminator (that is what got us here), so a '\r'
  // immediately before the invented newline belongs to the line ending unless
  // that side's own last line really ends in one. Both readings are evidence
  // rather than convention — the rendered bytes and the blob git is holding.
  return trimTerminator(text, source);
}

/**
 * `text` with the terminator git invented taken off, one line ending's worth.
 *
 * Shared by both readings above so they cannot drift apart: the one that names
 * a side, and the one where the file ends on agreed text and BOTH sides say
 * there is no terminator.
 *
 * HOW MUCH TO TAKE IS ASKED OF THE SIDES, NOT GUESSED FROM THE TEXT. This used
 * to slice exactly one character. In a CRLF file that removes the '\n' of a
 * '\r\n' pair and leaves the '\r' behind — a byte NEITHER BRANCH WROTE, on the
 * last line of the file, invisible in every editor that draws it. MEASURED with
 * real git and `*.txt text eol=crlf`, ours "head\r\nOURS\r\n" and theirs
 * "head\r\nTHEIRS" with no terminator: `['theirs']` rendered
 * "head\r\nTHEIRS\r" where git's own checkout of that side is
 * "head\r\nTHEIRS". Written, staged and committed as `{ok: true, resolved: 1}`.
 *
 * The chosen version has no terminator — that is what got us here — so a '\r'
 * immediately before the invented newline belongs to the line ending unless a
 * side's own last line really ends in one.
 */
function trimTerminator(text, ...sources) {
  const own = sources.some((source) => typeof source === 'string' && source.endsWith('\r'));
  const crlf = text.endsWith('\r\n') && !own;
  return text.slice(0, crlf ? -2 : -1);
}

/**
 * A conflict marker still sitting in text this parse called AGREED.
 *
 * A MARKED-UP FILE THAT PARSES TO NOTHING IS INDISTINGUISHABLE FROM A FILE
 * WITH NOTHING TO CHOOSE, AND THE DIFFERENCE IS THE WHOLE MERGE.
 *
 * `parseConflict` is deliberately forgiving: anything it cannot read as a
 * conflict block it keeps, verbatim, as `{kind: 'same'}` text — which is right,
 * because nothing is ever silently dropped. But `same` means "both branches
 * agree on this", and a `<<<<<<<` line is git saying the exact opposite. Every
 * caller downstream reads clashCount() === 0 as "no disagreements here", and
 * for such a file that is false: the disagreement is still in there, unread.
 *
 * The CRLF markers were one way to arrive at that shape and are fixed; a block
 * whose opener and closer disagree about their line endings, one missing its
 * separator, one whose sides split into no disagreement at all, and one a
 * person hand-edited and left unclosed are others, and there is no reason to
 * believe the list is complete. So the shape itself is recognisable, and the
 * callers that would otherwise answer for such a file — resolveMerge's
 * validator, and the MCP git domain describing hunks to an agent — ask here.
 *
 * Only the OPENER is looked for: a block always starts with one, so a marker
 * this could not read leaves that line in the agreed text whichever half of it
 * failed.
 *
 * TWO WIDTHS ARE LOOKED FOR, AND THE SECOND ONE IS THE POINT.
 *
 * `markerSize` is what git says it wrote for this path, and an opener of
 * exactly that width in agreed text is the direct finding. But the reason this
 * function exists is that the parse can be wrong in ways nobody has thought of
 * yet — including being handed the WRONG width, if the attribute that decides
 * it changed between the merge and the read. So a run of SEVEN OR MORE is
 * caught as well, whatever the configured width: seven is git's default and
 * every larger width is a deliberate `conflict-marker-size`, and a line of that
 * shape sitting unread in a file git has just called conflicting is not
 * something to answer a merge over. That is a refusal Stacki can be wrong
 * about safely; the alternative was measured committing bytes neither branch
 * wrote.
 *
 * What it deliberately does NOT do is treat a long run as a marker on its own.
 * The run has to be followed by a space, a tab, a carriage return or the end of
 * the text, which is how git writes one and is not how a rule of angle
 * brackets or a line of somebody's ASCII art is written.
 */
const unreadMarkers = (parts, markerSize, ...sides) => {
  const n = markerWidth(markerSize);
  // WALKED LINE BY LINE, NOT MATCHED WITH A REGEX OVER THE WHOLE TEXT.
  //
  // The first version of the small-width scan below was six regexes of the form
  // `<{w}[ \t][\s\S]*?\n={w}[ \t\r]*\n[\s\S]*?\n>{w}[ \t]`, run over the agreed
  // text of every conflicting file. Two unanchored lazy spans in one pattern
  // backtrack quadratically at best, and the text they run over is a file out of
  // the repository being merged — which is to say, content somebody else chose.
  // A merge is not a place to hand the main process a pattern whose cost is
  // decided by the input. Walking the lines is linear and says the same thing.
  const markerOf = (line) => {
    const run = /^([<=|>])\1*/.exec(line);
    if (!run) return null;
    const ch = run[1];
    const rest = line.slice(run[0].length);
    // WHAT MAKES A MARKER LINE, AND IT IS NOT THE RUN ALONE.
    //
    // Git writes an opener and a closer with a LABEL after them — the branch,
    // HEAD, a filename — never bare; and it writes the separator bare. So an
    // opener or closer needs the space that separates it from its label, which
    // is what tells a marker from a rule somebody drew across the page. That
    // distinction was already the shipped one and is kept: a line of twenty '<'
    // and nothing else is not a conflict marker at any width.
    // The same reading `markersFor` takes, which is git's: an opener, an ancestor
    // line and a closer carry a separating space; the separator is bare. Those
    // two readings used to disagree, and the disagreement was the defect.
    if (ch === '=') {
      if (!/^\s*$/.test(rest)) return null;
    } else if (!/^[ \t]/.test(rest)) return null;
    return { ch, width: run[0].length };
  };
  for (const part of parts || []) {
    if (!part || part.kind !== 'same') continue;
    // Per width, the last structural marker seen: an opener arms it, a
    // separator advances it, and a closer completes a block. Six counters and
    // one pass, whatever the text is.
    const stage = new Map();
    for (const line of String(part.text || '').split('\n')) {
      const marker = markerOf(line);
      if (!marker) continue;
      const { ch, width } = marker;
      const raw = line;
      // THE OPENER, AND THE CLOSER TOO — a block has both, and the one this
      // used to look for is not always the one left behind.
      //
      // Only the opener was looked for, on the reasoning that a block always
      // starts with one. It does — but the parse does not always LOSE the
      // opener. MEASURED, real git: a line reading `>>>>>>> quoted in the text`
      // inside the incoming side ended the block early, so the parse read the
      // two sides correctly, put git's REAL closer into the agreed text, and
      // `['theirs']` committed `"top\nTHEIRS\nMORE\n>>>>>>> feature\nbottom\n"`
      // — a conflict marker written into the source, ok: true, HEAD moved. The
      // opener was consumed; the closer was the evidence.
      //
      // Both are checked at the width git says it used and at seven or more,
      // which is git's default and every deliberate `conflict-marker-size`
      // above it. A refusal here is one Stacki can be wrong about safely; the
      // alternative was measured committing bytes neither branch wrote.
      // THE OPENER IS LOOKED FOR AT ANY WIDTH FROM SEVEN UP; THE CLOSER ONLY AT
      // THE WIDTH IN FORCE.
      //
      // A width this was not given leaves BOTH behind, and the opener arm is
      // enough to find it — an opener is what begins a block, so an unconsumed
      // one is the stronger evidence and the one worth casting wide for. Casting
      // the closer that wide was a false refusal with nothing to buy it:
      // MEASURED, a README whose banner reads `>>>>>>>> WARNING <<<<<<<<`, in
      // text both branches are identical on, refused an otherwise perfectly
      // parsed merge outright — the hunk beside it was exactly right. The closer
      // is still checked at the width in force, which is the shape that matters:
      // git's own closer, left in the agreed text because a labelled closer in
      // somebody's source ended the block early.
      //
      // AND A WIDE HIT IS ONLY EVIDENCE IF THE LINE IS GIT'S.
      //
      // The wide arm is what catches a marker git wrote at a width this was
      // told wrongly — MEASURED, `.gitattributes` itself in the conflict: git
      // merged under this branch's 40 and check-attr, asked afterwards, said
      // 12, so 40-wide markers sat in text the parse called agreed. Without the
      // wide arm they are invisible and the documented default commits over
      // them. It must stay.
      //
      // But it also fired for a line the FILE has always contained, at every
      // width — so a project that took this file's own advice and widened its
      // markers got the identical refusal back, the remedy having changed
      // nothing. MEASURED, an authored `<<<<<<< HEAD` in prose: byte-identical
      // refusals at 7, at 32 and at 64.
      //
      // The two are the same shape and are told apart the only way they can be:
      // git's markers are in no blob. A wide-arm line that appears in a side is
      // the author's and is not evidence of a misread width; one that appears
      // in neither is git's. `sides` is how the caller says so — without it
      // this keeps the cautious reading, because a caller that cannot show the
      // blobs has not shown the line is authored.
      const authored = (line) => sides.some((side) => typeof side === 'string' && side.split('\n').includes(line));
      if (ch === '<' && (width === n || (width >= 7 && !authored(raw)))) return true;
      if (ch === '>' && width === n) return true;
      // AND THE ONE SHAPE THOSE TWO CANNOT SEE. Every way of being handed the
      // wrong width ends in a refusal except one: a real width BELOW seven,
      // read as seven, leaves `<<< HEAD` where neither check above can find it.
      // Guessing at short openers alone is not the answer — a line beginning
      // `< ` is ordinary in diff output, in quoted mail and in documentation —
      // so what is looked for is a whole BLOCK at one of those widths: opener,
      // separator, closer, in that order. Git writes exactly that and little
      // else does.
      if (width >= 7) continue;
      if (ch === '<') stage.set(width, 'opened');
      else if (ch === '=' && stage.get(width) === 'opened') stage.set(width, 'split');
      else if (ch === '>' && stage.get(width) === 'split') return true;
    }
  }
  return false;
};

/**
 * Whether either SIDE of this conflict contains a conflict-marker line of its
 * own — in which case none of the markers in the file can be told from git's.
 *
 * THE SIXTH INSTANCE OF ONE CLASS, AND THE FIRST ANSWER TO THE CLASS ITSELF.
 *
 * Five separate rules now keep a line of somebody's source from being read as
 * part of git's markup: exact width, one opener, one separator, at most one
 * ancestor line before it, and — under diff3 — an ancestor line at all. Each
 * closed the shape in front of it and the next round found another. The last was
 * an authored example written in the DIFF3 spelling: opener, ancestor line,
 * separator, closer, one of each, in order, at the width in force. It passes
 * every one of the five. MEASURED, real git: two hunks reported where git wrote
 * one, `markersUnread` false, and answering them committed a file equal to
 * neither branch under `{ok: true, resolved: 1}`.
 *
 * No rule about the SHAPE of the text can close that, because the shape is
 * identical — git has the same problem, which is why `conflict-marker-size`
 * exists. What closes it is a fact about the text's PROVENANCE, and git holds
 * it: THE MARKERS GIT WRITES ARE IN NO BLOB. They are the merge machinery's
 * invention, added on the way to the working tree. So a marker line that is
 * present in either side's committed version is not a marker git wrote — and a
 * file holding one cannot have its own markers told apart from git's at all.
 *
 * The stages are already read for every conflicting path. This asks them.
 *
 * A safe refusal, and a narrow one: it costs a merge only for a file that both
 * conflicts AND contains a conflict-marker line, which is the file nobody can
 * answer correctly anyway. Everything else — the overwhelming ordinary case —
 * is untouched, because an ordinary source file has no such line in it.
 */
const sidesHoldMarkers = (markerSize, ...sides) => {
  const n = markerWidth(markerSize);
  for (const side of sides) {
    if (typeof side !== 'string' || !side) continue;
    // The same reading `unreadMarkers` takes of an opener, including where it
    // casts wider than the width in force and why: at git's default seven this
    // may not be the real width, at an explicit width it is. The closer is not
    // asked for — an opener is what begins a block, and a file with one has
    // already answered the question.
    for (const line of side.split('\n')) {
      const run = /^(<+)[ \t]/.exec(line);
      if (!run) continue;
      if (run[1].length === n || (n === DEFAULT_MARKER_SIZE && run[1].length >= 7)) return true;
    }
  }
  return false;
};

module.exports = {
  parseConflict,
  renderResolved,
  clashCount,
  conflictAtEnd,
  threeWay,
  lineDiff,
  mergeInline,
  unreadMarkers,
  sidesHoldMarkers,
  DEFAULT_MARKER_SIZE,
  MAX_MARKER_SIZE,
  MARKER_CACHE_MAX,
  // Only so the bound can be asserted; nothing reads it to decide anything.
  markerCacheSize: () => markerCache.size,
  markerWidth,
};
