// What actually changed on disk, in a few lines.
//
// A mutation that answers "ok" and nothing else is a mutation an agent has to
// verify by reading the file back — which is the round trip this whole feature
// exists to remove. So every write says what it did, as a patch.
//
// Bounded, hard. A raw source write can replace a thousand-line file, and a
// tool result that carries the whole of it costs more than the read it saved.
// So: only the hunks that differ, only a few of them, and a count of what was
// left out. The digests beside it are the exact answer for anybody who needs
// one; the patch is for reading.
//
// WHAT THIS USED TO DO, AND WHAT IT COST. `diffLines` was not a diff. It walked
// in from both ends to find the common prefix and the common suffix and emitted
// ONE hunk covering everything between them — which is exactly right when the
// change is one contiguous region, and wrong the moment it is not. Two edits
// three hundred lines apart in one file were reported as three hundred lines
// removed and three hundred added, and `linesAdded`/`linesRemoved` counted that
// whole span. A live dogfood measured the overstatement at up to thirty-one
// times. `MAX_HUNKS` was dead: there was never more than one.
//
// It is a real diff now — Myers' O(ND) greedy algorithm, the one git uses —
// with the prefix/suffix trim kept in front of it because it makes the common
// case free. The bound is on the EDIT DISTANCE rather than on the file size, so
// a large file with a small change is exact and a wholesale rewrite falls back
// to the old honest answer: these lines became those lines, said once.

const MAX_HUNKS = 6;
const MAX_HUNK_LINES = 40;
const CONTEXT = 2;

// How far Myers is allowed to search before the answer stops being worth
// having. `d` is the number of inserted plus deleted lines, so this is "up to
// two thousand changed lines, exactly" — past that a reader wants the shape,
// not the detail, and the fallback gives them the shape. The algorithm is
// O(ND), so this also bounds the work: the worst case here is a few million
// comparisons, on a path that already read two files off disk.
const MAX_EDIT_DISTANCE = 2000;

/**
 * The edit script between two line arrays, or null if it is too big to be worth
 * computing.
 *
 * Returns entries of `{ t: '=' | '-' | '+', line }` in file order. Myers'
 * greedy algorithm: walk the edit graph one diagonal at a time, keeping the
 * furthest point reached on each, and stop at the first `d` that reaches the
 * end. `trace` keeps the frontier at every `d` so the path can be walked back.
 */
function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(MAX_EDIT_DISTANCE, n + m);
  const v = new Map([[1, 0]]);
  const trace = [];

  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      // The free part: as far as the two sides agree, move diagonally.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Back to the start, one `d` at a time, reading off which move was taken.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const frontier = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = frontier.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: '=', line: a[x] });
    }
    if (down) {
      y--;
      ops.push({ t: '+', line: b[y] });
    } else {
      x--;
      ops.push({ t: '-', line: a[x] });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: '=', line: a[x] });
  }
  return ops.reverse();
}

/** The whole of one side replaced by the whole of the other, said once. */
const wholesale = (a, b) => [
  {
    startLine: 1,
    removed: a,
    added: b,
    body: [...a.map((line) => ({ t: '-', line })), ...b.map((line) => ({ t: '+', line }))],
    context: { before: [], after: [] },
    approximate: true,
  },
];

/**
 * A text as its lines.
 *
 * The final newline TERMINATES the last line; it does not begin another one. A
 * `split` sees an empty segment after it and calling that a line is how a
 * one-line file comes to be counted as two — and it is why the counts here have
 * to agree with `git diff --numstat`, which counts the way this does. An empty
 * file has no lines at all, which is a different thing from a file holding one
 * empty line.
 */
function toLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * The edit script grouped into hunks.
 *
 * TWO KINDS OF LINE, KEPT APART. `removed` and `added` are the lines that
 * ACTUALLY CHANGED, and nothing else is ever put in them — they are what the
 * counts are summed from. `body` is what a reader sees, which includes the
 * unchanged lines sitting between two changes close enough to share a hunk.
 * Putting those in `removed` and `added` as well is the first thing this
 * rewrite got wrong, and it inflated a twenty-line change to thirty-nine.
 */
function buildHunks(ops) {
  const hunks = [];
  let current = null;
  let aLine = 0;
  let recent = [];

  const flush = () => {
    if (!current) return;
    const pending = current.pending;
    current.context.after = pending.slice(0, CONTEXT);
    delete current.pending;
    hunks.push(current);
    current = null;
    // Whatever ran past this hunk's trailing context is the next one's leading
    // context, if a next one starts soon.
    recent = pending.slice(-CONTEXT);
  };

  for (const op of ops) {
    if (op.t === '=') {
      if (current) {
        current.pending.push(op.line);
        if (current.pending.length > 2 * CONTEXT) flush();
      } else {
        recent.push(op.line);
        if (recent.length > CONTEXT) recent.shift();
      }
      aLine++;
      continue;
    }
    if (!current) {
      current = {
        startLine: aLine + 1,
        removed: [],
        added: [],
        body: [],
        context: { before: recent.slice(-CONTEXT), after: [] },
        pending: [],
      };
    } else if (current.pending.length) {
      for (const line of current.pending) current.body.push({ t: '=', line });
      current.pending = [];
    }
    if (op.t === '-') {
      current.removed.push(op.line);
      current.body.push({ t: '-', line: op.line });
      aLine++;
    } else {
      current.added.push(op.line);
      current.body.push({ t: '+', line: op.line });
    }
  }
  flush();
  return hunks;
}

/**
 * A unified-ish diff of two texts.
 *
 * Every hunk's `removed` and `added` are the lines that actually changed, so
 * summing them gives the real totals — that is the property the old version did
 * not have and the reason the numbers were wrong.
 *
 * `approximate: true` on a hunk means the edit was too large to diff and this is
 * the "these lines became those lines" fallback. It is set so the caller can say
 * so rather than presenting a guess as a measurement.
 */
function diffLines(before, after) {
  const a = toLines(before);
  const b = toLines(after);

  // The trim is what keeps `d` small for the edits this API actually makes,
  // which is what makes the bound generous. It is applied to the MYERS INPUT
  // only: the hunks are built from the whole file, because a hunk's context is
  // the lines around it and those live in the part that was trimmed off.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head === a.length && head === b.length) return [];

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const middle = editScript(midA, midB);
  if (!middle) return wholesale(a, b);

  const ops = [
    ...a.slice(0, head).map((line) => ({ t: '=', line })),
    ...middle,
    ...a.slice(a.length - tail).map((line) => ({ t: '=', line })),
  ];
  return buildHunks(ops);
}

/** One hunk as text, capped. */
function renderHunk(hunk) {
  const lines = [];
  for (const line of hunk.context.before) lines.push(`  ${line}`);
  // FROM `body`, WHICH IS IN FILE ORDER. Printing every removal and then every
  // addition is fine for one contiguous change and misleading for a hunk that
  // holds two, because it puts the second change's removal above the first
  // change's addition and the reader has to reconstruct the order.
  const MARK = { '=': ' ', '-': '-', '+': '+' };
  let shown = 0;
  for (const entry of hunk.body) {
    if (shown >= MAX_HUNK_LINES) break;
    lines.push(`${MARK[entry.t]} ${entry.line}`);
    shown++;
  }
  const omitted = Math.max(0, hunk.body.length - shown);
  if (omitted) lines.push(`… ${omitted} more line${omitted === 1 ? '' : 's'} in this hunk`);
  for (const line of hunk.context.after) lines.push(`  ${line}`);
  return { at: hunk.startLine, text: lines.join('\n') };
}

/**
 * The patch between two versions of a file.
 *
 * Null when nothing changed — which is a real answer, and a more useful one
 * than an empty string: a write that produced identical bytes did nothing, and
 * an agent should be told so rather than shown a blank diff.
 *
 * THE COUNTS ARE OVER EVERY HUNK, NOT OVER THE ONES THAT FIT. Capping the
 * display at MAX_HUNKS and then summing what was left would report a smaller
 * change than happened, which is the same class of lie as the one this file was
 * fixed for, pointing the other way. `hunksOmitted` says what is not shown.
 */
function patchBetween(before, after) {
  if (before === after) return null;
  const all = diffLines(before, after);
  if (!all.length) return null;
  const shown = all.slice(0, MAX_HUNKS);
  const patch = {
    hunks: shown.map(renderHunk),
    linesRemoved: all.reduce((n, h) => n + h.removed.length, 0),
    linesAdded: all.reduce((n, h) => n + h.added.length, 0),
  };
  if (all.length > shown.length) patch.hunksOmitted = all.length - shown.length;
  // Said out loud, because the difference between "these are the lines that
  // changed" and "this region became that region" is the difference between a
  // measurement and a summary, and a reader cannot tell from the shape.
  if (all.some((h) => h.approximate)) {
    patch.approximate = true;
    patch.note =
      'This change was too large to diff line by line, so the whole changed region is shown as removed and added. ' +
      'The digests are exact.';
  }
  return patch;
}

module.exports = { patchBetween, diffLines, editScript, MAX_HUNKS, MAX_HUNK_LINES, MAX_EDIT_DISTANCE, CONTEXT };
