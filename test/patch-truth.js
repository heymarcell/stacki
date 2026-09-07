// The patch says what changed, and the counts are the counts.
//
//   node test/patch-truth.js
//
// A live dogfood noticed that the line counts on a write bore no relation to
// the size of the change. Measured here, on a 400-line file: two edits three
// hundred lines apart were reported as 321 lines added and 321 removed. The
// real answer is two and two. A hundred and sixty times over.
//
// `diffLines` was not a diff. It walked in from both ends to find the common
// prefix and the common suffix and emitted ONE hunk covering everything between
// them, and `linesAdded`/`linesRemoved` counted that whole span. For a single
// contiguous edit — which is most of what this API does — that is exactly
// right, which is why it survived. For anything with two changed regions it is
// a number with no meaning, and an agent deciding whether to look at a diff is
// reading that number.
//
// It is Myers' algorithm now, the one git uses, with the prefix/suffix trim
// kept in front of it because it makes the common case free.
//
// THE ORACLE IS GIT. Not a table of expected numbers written by whoever wrote
// the fix — `git diff --numstat` on the same two files, run by this process.
// A test whose expected values came from the implementation under test is a
// test that agrees with itself, and the defect being fixed is precisely a set
// of numbers that agreed with themselves for a year.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { patchBetween, diffLines, editScript, MAX_HUNKS, MAX_EDIT_DISTANCE, CONTEXT } = require('../electron/mcp/agent/patch.js');

const made = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-patch-truth-'));
  made.push(dir);
  return dir;
};
const cleanup = () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
};

/**
 * What git says changed between two texts.
 *
 * `--no-index` so no repository is needed, `--numstat` so the answer is two
 * numbers rather than something to parse. A binary or unreadable pair answers
 * `-` for both, which is not a case any of these produce.
 */
function gitNumstat(before, after) {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'a'), before, 'utf8');
  fs.writeFileSync(path.join(dir, 'b'), after, 'utf8');
  let out = '';
  try {
    // `--minimal` because this implementation IS minimal Myers, and git's
    // default applies a speed heuristic that can settle for a script one edit
    // longer. Grading a minimal diff against a non-minimal oracle would fail on
    // a correct answer — measured: a moved ten-line block, 10 edits against
    // git's default 11.
    out = execFileSync('git', ['diff', '--no-index', '--numstat', '--minimal', '--', 'a', 'b'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // `git diff --no-index` exits 1 when the files differ, which is the normal
    // case here and not a failure.
    out = err.stdout || '';
  }
  const [added, removed] = out.trim().split('\t');
  return { added: Number(added) || 0, removed: Number(removed) || 0 };
}

// EVERY FIXTURE ENDS WITH A NEWLINE. A file whose last line has no terminator
// is a real thing and git marks it specially — `\\ No newline at end of file`
// counts as a changed line on both sides — so a fixture without one would have
// the two sides arguing about the terminator rather than about the edit.
const numbered = (n, label = 'line') => `${Array.from({ length: n }, (_, i) => `${label} ${i}`).join('\n')}\n`;
const BASE = numbered(400);
const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
const join = (arr) => (arr.length ? `${arr.join('\n')}\n` : '');
const replace = (text, from, to) => join(lines(text).map((l) => (l === from ? to : l)));
const drop = (text, which) => join(lines(text).filter((l) => l !== which));

// ── the counts, against git ─────────────────────────────────────────────────

const CASES = {
  'one line changed in the middle': replace(BASE, 'line 200', 'CHANGED'),
  'one line changed at the top': replace(BASE, 'line 0', 'CHANGED'),
  'one line changed at the bottom': replace(BASE, 'line 399', 'CHANGED'),
  'two edits, 320 lines apart': replace(replace(BASE, 'line 20', 'A'), 'line 340', 'B'),
  'three scattered edits': replace(replace(replace(BASE, 'line 5', 'A'), 'line 200', 'B'), 'line 395', 'C'),
  'two edits four lines apart': replace(replace(BASE, 'line 100', 'A'), 'line 104', 'B'),
  'two edits one line apart': replace(replace(BASE, 'line 100', 'A'), 'line 102', 'B'),
  'two adjacent lines changed': replace(replace(BASE, 'line 100', 'A'), 'line 101', 'B'),
  'a line added at the top': `NEW\n${BASE}`,
  'a line added at the bottom': `${BASE}NEW\n`,
  'a line added in the middle': join(lines(BASE).flatMap((l) => (l === 'line 200' ? [l, 'NEW'] : [l]))),
  'a line removed': drop(BASE, 'line 200'),
  'ten lines removed': join(lines(BASE).filter((_, i) => i < 100 || i >= 110)),
  'ten adjacent lines replaced': join(lines(BASE).map((l, i) => (i >= 100 && i < 110 ? `X${i}` : l))),
  'a block moved': join([...lines(BASE).slice(0, 50), ...lines(BASE).slice(60), ...lines(BASE).slice(50, 60)]),
  'every other line changed, twenty times': join(lines(BASE).map((l, i) => (i < 40 && i % 2 === 0 ? `X${i}` : l))),
  'the file emptied': '',
  'a file made from nothing': BASE,
};

for (const [label, after] of Object.entries(CASES)) {
  const before = label === 'a file made from nothing' ? '' : BASE;
  const mine = patchBetween(before, after);
  const git = gitNumstat(before, after);
  if (!check(`[${label}] there is a patch`, mine !== null, 'null')) continue;
  if (mine.approximate) {
    check(`[${label}] an approximate answer says so`, mine.approximate === true && !!mine.note, JSON.stringify(mine.note));
    continue;
  }
  check(`[${label}] linesAdded matches git`, mine.linesAdded === git.added, `${mine.linesAdded} vs git ${git.added}`);
  check(`[${label}] linesRemoved matches git`, mine.linesRemoved === git.removed, `${mine.linesRemoved} vs git ${git.removed}`);
}

// Identical texts have no patch at all — a distinct answer from an empty one.
check('identical texts have no patch', patchBetween(BASE, BASE) === null);
check('and two empty texts have none either', patchBetween('', '') === null);

// ── the hunks are hunks ─────────────────────────────────────────────────────
//
// The counts could be right while the hunks were still one big one, so the
// SHAPE is checked separately. This is the assertion the old code could not
// pass at all: it had exactly one hunk, always, and MAX_HUNKS was dead code.

{
  const two = diffLines(BASE, replace(replace(BASE, 'line 20', 'A'), 'line 340', 'B'));
  check('two distant edits are two hunks', two.length === 2, `${two.length} hunks`);
  // Indexed defensively: a broken implementation answers with ONE hunk, and a
  // throw here would end the file before the rest of the shape is checked. A
  // suite that crashes on the defect it is watching for reports less than one
  // that fails on it.
  check('  and the first is at the first edit', two[0]?.startLine === 21, String(two[0]?.startLine));
  check('  and the second is at the second', two[1]?.startLine === 341, String(two[1]?.startLine));
  check('  and neither carries the lines between them', two[0]?.removed.length === 1 && two[1]?.removed.length === 1, JSON.stringify(two.map((h) => h.removed.length)));

  const three = diffLines(BASE, replace(replace(replace(BASE, 'line 5', 'A'), 'line 200', 'B'), 'line 395', 'C'));
  check('three scattered edits are three hunks', three.length === 3, `${three.length} hunks`);

  // Close together, they are one hunk — otherwise the context blocks would
  // overlap and the reader would see the same lines twice.
  const near = diffLines(BASE, replace(replace(BASE, 'line 100', 'A'), 'line 102', 'B'));
  check('two edits one line apart are one hunk', near.length === 1, `${near.length} hunks`);
  // AND IT IS DISPLAY, NOT CHANGE. The unchanged line between two changes in
  // one hunk belongs in what a reader sees and in neither count — putting it in
  // `removed` and `added` is exactly how a twenty-line change was reported as
  // thirty-nine while this rewrite was being written.
  check('  the line between them is shown', near[0]?.body?.some((e) => e.t === '=' && e.line === 'line 101'), JSON.stringify(near[0].body));
  check('  and counted as neither added nor removed', !near[0]?.removed.includes('line 101') && !near[0]?.added.includes('line 101'), JSON.stringify(near[0]));
  check('  and the hunk renders it as context', / line 101/.test(require('../electron/mcp/agent/patch.js').patchBetween(BASE, replace(replace(BASE, 'line 100', 'A'), 'line 102', 'B')).hunks[0].text));

  const far = diffLines(BASE, replace(replace(BASE, 'line 100', 'A'), 'line 110', 'B'));
  check('two edits ten lines apart are two hunks', far.length === 2, `${far.length} hunks`);
}

// The line numbers point at the file, not at the hunk.
{
  const hunks = diffLines(BASE, replace(BASE, 'line 200', 'CHANGED'));
  check('a hunk starts at the line it changed', hunks[0].startLine === 201, String(hunks[0].startLine));
  check('and carries context from before it', hunks[0].context.before.includes('line 199'), JSON.stringify(hunks[0].context.before));
  check('and from after it', hunks[0].context.after.includes('line 201'), JSON.stringify(hunks[0].context.after));
  check('and CONTEXT lines of it', hunks[0].context.before.length <= CONTEXT && hunks[0].context.after.length <= CONTEXT, `${hunks[0].context.before.length}/${hunks[0].context.after.length}`);
}

// ── the bounds are still bounds ─────────────────────────────────────────────

{
  // More hunks than are shown: the counts still describe all of them, and the
  // answer says how many were left out. Capping the display and then summing
  // what fits would be the same lie pointing the other way.
  const many = join(lines(BASE).map((l, i) => (i % 20 === 0 ? `X${i}` : l)));
  const hunks = diffLines(BASE, many);
  const patch = patchBetween(BASE, many);
  check('a change with many hunks produces many', hunks.length > MAX_HUNKS, `${hunks.length} hunks`);
  check('  but only MAX_HUNKS are rendered', patch.hunks.length === MAX_HUNKS, `${patch.hunks.length} rendered`);
  check('  and it says how many were not', patch.hunksOmitted === hunks.length - MAX_HUNKS, `${patch.hunksOmitted} omitted of ${hunks.length}`);
  const git = gitNumstat(BASE, many);
  check('  and the counts still describe the whole change', patch.linesAdded === git.added && patch.linesRemoved === git.removed, `+${patch.linesAdded}/-${patch.linesRemoved} vs git +${git.added}/-${git.removed}`);
}

{
  // Past the edit-distance bound the answer degrades to the honest summary, and
  // says that it has. A file with no lines in common at all is the worst case.
  const before = numbered(3000, 'alpha');
  const after = numbered(3000, 'beta');
  const patch = patchBetween(before, after);
  check('a wholesale rewrite still answers', patch !== null);
  check('  and admits it is approximate', patch.approximate === true, JSON.stringify(patch.approximate));
  check('  and says why in words', /too large to diff/.test(String(patch.note)), String(patch.note));
  check('  and the digests are pointed at instead', /digests are exact/.test(String(patch.note)), String(patch.note));
  check('  and it is still bounded', patch.hunks.length <= MAX_HUNKS, `${patch.hunks.length}`);
  check('  and the edit script refused rather than ran forever', editScript(lines(before), lines(after)) === null);
}

{
  // Just inside the bound, it is exact.
  const n = Math.floor(MAX_EDIT_DISTANCE / 2) - 10;
  const before = numbered(n + 50, 'same');
  const after = join(lines(before).map((l, i) => (i < n ? `changed ${i}` : l)));
  const patch = patchBetween(before, after);
  const git = gitNumstat(before, after);
  check('a change just inside the bound is exact', patch.approximate !== true, JSON.stringify(patch.approximate));
  check('  and matches git', patch.linesAdded === git.added && patch.linesRemoved === git.removed, `+${patch.linesAdded}/-${patch.linesRemoved} vs git +${git.added}/-${git.removed}`);
}

// ── the shape a caller receives ─────────────────────────────────────────────

{
  const patch = patchBetween('a\nb\nc\n', 'a\nB\nc\n');
  check('a hunk renders with a line number', typeof patch.hunks[0].at === 'number', JSON.stringify(patch.hunks[0]));
  check('and text a person can read', /^- b$/m.test(patch.hunks[0].text) && /^\+ B$/m.test(patch.hunks[0].text), JSON.stringify(patch.hunks[0].text));
  check('and the counts are one and one', patch.linesAdded === 1 && patch.linesRemoved === 1, JSON.stringify(patch));
  check('and an exact patch does not claim to be approximate', !('approximate' in patch), JSON.stringify(patch));
  check('and does not claim omitted hunks it has not omitted', !('hunksOmitted' in patch), JSON.stringify(patch));
}

// ── the property, over random edits ─────────────────────────────────────────
//
// The cases above are the shapes somebody thought of. This is the assertion
// that does not depend on having thought of the right ones: for a hundred
// generated edits, the counts equal git's. Deterministic — the seed is fixed,
// so a failure is reproducible rather than a story about a run.

{
  let seed = 20260907;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let mismatches = 0;
  let cases = 0;
  for (let i = 0; i < 100; i++) {
    const n = 20 + Math.floor(rand() * 200);
    const before = numbered(n);
    let after = lines(before);
    const edits = 1 + Math.floor(rand() * 6);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(rand() * after.length);
      const kind = rand();
      if (kind < 0.4) after[at] = `mutated ${e} ${i}`;
      else if (kind < 0.7) after.splice(at, 1);
      else after.splice(at, 0, `inserted ${e} ${i}`);
    }
    after = join(after);
    const mine = patchBetween(before, after);
    const git = gitNumstat(before, after);
    cases++;
    if (mine === null) {
      if (git.added || git.removed) mismatches++;
      continue;
    }
    if (mine.approximate) continue;
    if (mine.linesAdded !== git.added || mine.linesRemoved !== git.removed) {
      mismatches++;
      if (mismatches <= 3) {
        failures.push(`  [random ${i}] +${mine.linesAdded}/-${mine.linesRemoved} vs git +${git.added}/-${git.removed}`);
      }
    }
  }
  check(`${cases} generated edits all count the way git counts`, mismatches === 0, `${mismatches} disagreed`);
}

cleanup();

if (failures.length) {
  console.error(`\npatch-truth: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`patch-truth: ${checked} passed  [every count graded against git diff --numstat]`);
