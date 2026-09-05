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

const START = /^<<<<<<< ?(.*)$/;
const MIDDLE = /^=======\s*$/;
const BASE = /^\|\|\|\|\|\|\| ?(.*)$/; // only present under diff3 conflict style
const END = /^>>>>>>> ?(.*)$/;

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
 */
function parseConflict(text) {
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
    if (!closed) {
      same.push(lines[i]);
      i++;
      continue;
    }
    flushSame();
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
    for (const run of split) {
      if (run.common) {
        parts.push({ kind: 'same', text: run.common.join('\n') });
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
 * `same` part that a file-ending newline always produces, and the part before
 * it is the clash.
 */
function conflictAtEnd(parts) {
  const list = parts || [];
  const last = list[list.length - 1];
  if (!last || last.kind !== 'same' || last.text !== '') return false;
  const before = list[list.length - 2];
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
  const last = (parts || []).filter((part) => part.kind === 'clash')[clashCount(parts) - 1] || null;
  const pick = picks[clashCount(parts) - 1];
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
  return text.slice(0, -1);
}

module.exports = { parseConflict, renderResolved, clashCount, conflictAtEnd, threeWay, lineDiff, mergeInline };
