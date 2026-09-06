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

/** Git's own reading of the attribute: a positive integer, or seven. */
const markerWidth = (size) => (Number.isInteger(size) && size > 0 ? size : DEFAULT_MARKER_SIZE);

// Compiled once per width. A merge touches one width almost always, and
// rebuilding four regexes per file for the sake of it is the kind of cost that
// only ever shows up on the conflict with three hundred files in it.
const markerCache = new Map();

function markersFor(size) {
  const n = markerWidth(size);
  const cached = markerCache.get(n);
  if (cached) return cached;
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
    // ` ?(.*?)\r?$`: git writes "<<<<<<< HEAD", and a bare marker with no label
    // is tolerated the way it always was. `\r?` so a CRLF file's terminator is
    // part of the marker rather than part of the label.
    START: new RegExp(`^${run('<')} ?(.*?)\\r?$`),
    // `\s*` matches '\r' as well as trailing spaces, which is how the separator
    // survived CRLF before any of this was deliberate.
    MIDDLE: new RegExp(`^${run('=')}\\s*$`),
    BASE: new RegExp(`^${run('|')} ?(.*?)\\r?$`), // only present under diff3 conflict style
    END: new RegExp(`^${run('>')} ?(.*?)\\r?$`),
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
function parseConflict(text, markerSize) {
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
    // A marker that never closes is a file somebody edited by hand and left
    // broken. Treating the rest as ordinary text keeps every line, which
    // matters more here than being clever: nothing is silently dropped.
    const ours = [];
    const theirs = [];
    const base = [];
    let sawMiddle = false;
    let sawBase = false;
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (END.test(line)) {
        closed = true;
        break;
      }
      if (MIDDLE.test(line)) {
        sawMiddle = true;
        continue;
      }
      // Under diff3 the common ancestor sits between the two sides. It is not
      // a third choice — it is what both started FROM — but it is what says
      // which side actually changed, so it is kept and never offered.
      if (BASE.test(line)) {
        sawBase = true;
        continue;
      }
      (sawMiddle ? theirs : sawBase ? base : ours).push(line);
    }
    // A BLOCK THIS DID NOT FULLY READ IS KEPT WHOLE, NEVER HALF-READ.
    //
    // `closed` was the only test here, and a block missing its SEPARATOR still
    // passed it: everything from the opener to the closer went into `ours` (or,
    // under diff3, into the ancestor once the ancestor line had been seen) and
    // the incoming side came out empty — a hunk saying "the other branch
    // deleted this", which is a claim, not a gap. That is exactly the shape a
    // wider-than-seven marker produced before the width became a parameter, and
    // it committed bytes neither branch wrote. See the marker note above.
    //
    // Git writes all four markers or none: an opener, an optional ancestor line
    // under diff3, a separator and a closer, every one of them at the same
    // width. A block missing any of the three that are never optional is
    // therefore not a block git wrote at this width, and the honest answer is
    // that it was not read — so its lines stay verbatim in the agreed text,
    // where `unreadMarkers` finds the opener still sitting in them and every
    // caller downstream refuses the path by name rather than answering for it.
    if (!closed || !sawMiddle) {
      same.push(lines[i]);
      i++;
      continue;
    }
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
  for (const part of parts || []) {
    if (part.kind === 'same') {
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
  const list = parts || [];
  const last = list.filter((part) => part.kind === 'clash')[clashCount(parts) - 1] || null;
  const pick = picks[clashCount(parts) - 1];
  // The last line is sometimes neither side's — it is BOTH sides'. A conflict
  // block whose two versions end the same way splits into a clash and the
  // agreed run after it (see `conflictAtEnd`), so the file can end on text that
  // is in both versions. The question is unchanged: the terminator behind that
  // line is in one version and not the other, and the answer names the version
  // to read it off. 'ours' and 'theirs' name one outright; 'both' and 'merged'
  // fall through to the same readings as everywhere else, which is where they
  // belong — with no line of its own at the end of the file, neither word
  // claims anything this could be more precise about.
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
  const crlf = text.endsWith('\r\n') && !source.endsWith('\r');
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
const unreadMarkers = (parts, markerSize) => {
  const n = markerWidth(markerSize);
  // `<{n}(?!<)` for the width git actually used, `<{7,}` for the default and
  // every wider one. When n is seven or more the first alternative is already
  // covered by the second; when it is smaller — sizes 1 to 6 are all legal —
  // it is the only one of the two that can see the marker at all.
  const opener = new RegExp(`(?:^|\\n)(?:<{${n}}(?!<)|<{7,})(?=[ \\t\\r]|$)`);
  const texts = (parts || []).filter((part) => part && part.kind === 'same').map((part) => part.text || '');
  if (texts.some((text) => opener.test(text))) return true;
  // AND THE ONE MIS-READING THE OPENER ALONE CANNOT CATCH.
  //
  // Every way of being handed the wrong width ends in a refusal except one. Too
  // small a width leaves the real, wider opener unread and the `<{7,}` arm
  // finds it; too large a width leaves a seven-wide opener unread and the same
  // arm finds that. But a real width BELOW seven, read as seven, leaves `<<<
  // HEAD` sitting in agreed text that neither arm can see — and that is the
  // shape that was measured committing this branch's version over the incoming
  // one under `{ok: true, resolved: 1}`.
  //
  // Guessing at short openers on their own is not the answer: a line beginning
  // `< ` is ordinary in diff output, in quoted mail and in documentation, and
  // refusing every conflicted file that contains one would be a false refusal
  // invented rather than inherited. What is NOT ordinary is a whole block —
  // opener, separator and closer, all the same width, in that order, with the
  // separator alone on its line. Git writes exactly that and little else does.
  //
  // Only widths one to six are looked for here. Seven and above are already
  // answered by the opener arm above, which is both cheaper and stricter.
  for (let width = 1; width < 7; width++) {
    const block = new RegExp(
      `(?:^|\\n)<{${width}}(?!<)[ \\t][\\s\\S]*?\\n={${width}}(?!=)[ \\t\\r]*\\n[\\s\\S]*?\\n>{${width}}(?!>)[ \\t]`
    );
    if (texts.some((text) => block.test(text))) return true;
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
  DEFAULT_MARKER_SIZE,
  markerWidth,
};
