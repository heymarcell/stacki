// Reading a conflicted file, and putting it back together.
//
//   node test/conflicts.js
//
// This is the code that lets someone keep the heading from one branch and the
// footer from the other, so its failures are the worst kind an editor can
// have: a file that is rebuilt slightly wrong, saved, and looks fine until
// somebody notices a line is missing. Nothing throws.
//
// The rule everything here is checked against: **every line is accounted
// for.** Text outside the markers must survive exactly, text inside must
// appear if it was chosen and not if it wasn't, and a file with markers this
// cannot understand must keep all of its lines rather than losing the parts it
// failed to parse.

const { parseConflict, renderResolved, clashCount, conflictAtEnd, threeWay, mergeInline, unreadMarkers } = require('../electron/conflicts.js');
const { guardSuite } = require('./support/suiteGuard.js');

// "THE PROCESS EXITED BEFORE THE SUITE FINISHED" IS A FAILURE, NOT A PASS.
// Nothing in this file awaits anything today, so the guard cannot fire today —
// it is here because that is not a property of the file, it is a property of
// what is in it right now, and the day one of these checks grows an await is
// the day a suite that prints nothing starts exiting 0. See
// test/support/suiteGuard.js.
const suiteDone = guardSuite('conflicts');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const conflicted = [
  'top unchanged',
  '<<<<<<< HEAD',
  'HERO MAIN',
  '=======',
  'HERO FEATURE',
  '>>>>>>> feature',
  'middle unchanged',
  '<<<<<<< HEAD',
  'FOOTER MAIN',
  '=======',
  'FOOTER FEATURE',
  '>>>>>>> feature',
  'bottom unchanged',
].join('\n');

// --- Reading it -------------------------------------------------------------
{
  const parts = parseConflict(conflicted);
  check('both disagreements are found', clashCount(parts) === 2, String(clashCount(parts)));
  const clashes = parts.filter((p) => p.kind === 'clash');
  check('this branch’s side is read', clashes[0].ours === 'HERO MAIN', clashes[0].ours);
  check('and the incoming side', clashes[0].theirs === 'HERO FEATURE', clashes[0].theirs);
  check('the second one too', clashes[1].ours === 'FOOTER MAIN', clashes[1].ours);
  // The markers themselves must never survive into a rebuilt file.
  check(
    'no marker text is kept as content',
    !parts.some((p) => JSON.stringify(p).includes('<<<<<<<') || JSON.stringify(p).includes('=======')),
    JSON.stringify(parts)
  );
}

// --- Putting it back --------------------------------------------------------
{
  const parts = parseConflict(conflicted);
  const ours = renderResolved(parts, ['ours', 'ours']);
  check(
    'keeping this branch throughout gives this branch’s file',
    ours === 'top unchanged\nHERO MAIN\nmiddle unchanged\nFOOTER MAIN\nbottom unchanged',
    JSON.stringify(ours)
  );
  const theirs = renderResolved(parts, ['theirs', 'theirs']);
  check(
    'keeping the incoming one gives theirs',
    theirs === 'top unchanged\nHERO FEATURE\nmiddle unchanged\nFOOTER FEATURE\nbottom unchanged',
    JSON.stringify(theirs)
  );
  // The point of the whole feature: part of the file from each branch.
  const mixed = renderResolved(parts, ['theirs', 'ours']);
  check(
    'one from each branch is possible',
    mixed === 'top unchanged\nHERO FEATURE\nmiddle unchanged\nFOOTER MAIN\nbottom unchanged',
    JSON.stringify(mixed)
  );
  const both = renderResolved(parts, ['both', 'ours']);
  check(
    'keeping both puts them one after the other',
    both === 'top unchanged\nHERO MAIN\nHERO FEATURE\nmiddle unchanged\nFOOTER MAIN\nbottom unchanged',
    JSON.stringify(both)
  );
  // Agreed text is not the part being chosen between, and must come through
  // untouched no matter what is picked.
  for (const picks of [['ours', 'ours'], ['theirs', 'theirs'], ['theirs', 'ours'], ['both', 'both']]) {
    const out = renderResolved(parts, picks);
    check(
      `agreed text survives ${picks.join('/')}`,
      out.includes('top unchanged') && out.includes('middle unchanged') && out.includes('bottom unchanged'),
      out
    );
  }
}

// --- Answers that are missing or wrong --------------------------------------
{
  const parts = parseConflict(conflicted);
  // No answers at all keeps this branch's work. The incoming version is still
  // on its branch; the user's own may exist nowhere else.
  const none = renderResolved(parts, []);
  check('no answer keeps your own work', none.includes('HERO MAIN') && !none.includes('HERO FEATURE'), none);
  check('an unknown answer does the same', renderResolved(parts, ['sideways', 'ours']).includes('HERO MAIN'));
  check('a missing picks argument does not throw', renderResolved(parts).includes('HERO MAIN'));
  check('and neither does a missing file', renderResolved(undefined, ['ours']) === '');
}

// --- Files that are not what we expect --------------------------------------
{
  const plain = 'just a file\nwith two lines';
  const parts = parseConflict(plain);
  check('a file with no conflict has nothing to choose', clashCount(parts) === 0);
  check('and rebuilds byte for byte', renderResolved(parts, []) === plain, JSON.stringify(renderResolved(parts, [])));

  check('empty text is handled', renderResolved(parseConflict(''), []) === '');
  check('null text is handled', renderResolved(parseConflict(null), []) === '');

  // A marker somebody left in by hand, never closed. Every line has to
  // survive: dropping the tail would silently delete the rest of the file.
  const broken = 'before\n<<<<<<< HEAD\nsomething\nafter';
  const brokenParts = parseConflict(broken);
  check('an unclosed marker is not treated as a conflict', clashCount(brokenParts) === 0, JSON.stringify(brokenParts));
  check('and no line is lost', renderResolved(brokenParts, []) === broken, JSON.stringify(renderResolved(brokenParts, [])));

  // One side empty — a block added on one branch and absent on the other.
  const added = 'a\n<<<<<<< HEAD\n=======\nnew from them\n>>>>>>> feature\nb';
  const addedParts = parseConflict(added);
  check('a one-sided change is still a choice', clashCount(addedParts) === 1);
  check('taking theirs adds the block', renderResolved(addedParts, ['theirs']) === 'a\nnew from them\nb', JSON.stringify(renderResolved(addedParts, ['theirs'])));
  // The empty side must not leave a blank line behind where nothing was.
  //
  // THIS ASSERTION USED TO DEMAND THE DEFECT. It read `=== 'a\n\nb'` under a
  // sentence saying a blank line must not be left behind, so the one check
  // pointed at this failure was pinning it in place: the parts are runs of
  // LINES and the join puts a newline between them, so a side with no lines in
  // it still collected a separator on each side and the rebuilt file gained an
  // empty line neither branch wrote.
  check('taking ours leaves nothing behind', renderResolved(addedParts, ['ours']) === 'a\nb', JSON.stringify(renderResolved(addedParts, ['ours'])));
  check('both is just the one that exists', renderResolved(addedParts, ['both']) === 'a\nnew from them\nb', JSON.stringify(renderResolved(addedParts, ['both'])));
}

// --- No lines at all, against one blank line --------------------------------
//
// THE TWO SHAPES A JOIN CANNOT TELL APART, and the reason `parseConflict`
// counts lines rather than letting the render ask whether a string is empty.
//
// Both of these were produced by REAL git from the ancestor "a\nX\nz\n" with
// merge.conflictStyle=diff3 — one branch DELETING X, the other REPLACING it
// with a blank line, both merged against a branch that changed X to "C". The
// two conflicted files differ by one byte, the clash objects they parse to are
// identical, and the file each one has to rebuild for `ours` differs by a line.
{
  const deleted = ['a', '<<<<<<< HEAD', '||||||| base', 'X', '=======', 'C', '>>>>>>> feat', 'z', ''].join('\n');
  const blank = ['a', '<<<<<<< HEAD', '', '||||||| base', 'X', '=======', 'C', '>>>>>>> feat', 'z', ''].join('\n');
  const deletedParts = parseConflict(deleted);
  const blankParts = parseConflict(blank);

  const clashOf = (parts) => parts.find((p) => p.kind === 'clash');
  check(
    'the deleted side and the blank-line side read as the same text',
    clashOf(deletedParts).ours === '' && clashOf(blankParts).ours === '',
    JSON.stringify([clashOf(deletedParts).ours, clashOf(blankParts).ours])
  );
  check(
    '  and are told apart only by the line count the parse records',
    clashOf(deletedParts).oursLines === 0 && clashOf(blankParts).oursLines === 1,
    JSON.stringify([clashOf(deletedParts).oursLines, clashOf(blankParts).oursLines])
  );

  // The two files ours actually has. Neither is a guess: they are what the
  // branch that produced each conflict has on disk.
  check(
    'a side that deleted the line rebuilds to the file it deleted it from',
    renderResolved(deletedParts, ['ours']) === 'a\nz\n',
    JSON.stringify(renderResolved(deletedParts, ['ours']))
  );
  check(
    'and a side that is one blank line keeps the blank line',
    renderResolved(blankParts, ['ours']) === 'a\n\nz\n',
    JSON.stringify(renderResolved(blankParts, ['ours']))
  );
  // `both` has the same question to answer and must answer it the same way,
  // or the two readings disagree about what a side is.
  check(
    'keeping both sides skips the one that has nothing',
    renderResolved(deletedParts, ['both']) === 'a\nC\nz\n',
    JSON.stringify(renderResolved(deletedParts, ['both']))
  );
  check(
    'and keeps a blank line that is genuinely there',
    renderResolved(blankParts, ['both']) === 'a\n\nC\nz\n',
    JSON.stringify(renderResolved(blankParts, ['both']))
  );
  check(
    'taking the other side is untouched by any of it',
    renderResolved(deletedParts, ['theirs']) === 'a\nC\nz\n' && renderResolved(blankParts, ['theirs']) === 'a\nC\nz\n',
    JSON.stringify([renderResolved(deletedParts, ['theirs']), renderResolved(blankParts, ['theirs'])])
  );

  // AND THE ONE PLACE THE EMPTY SIDE ALREADY MATTERED, asked at the end of the
  // file where the terminator is git's invention. The two readings must not
  // fight: the side the terminator is read off has to be the side that was
  // actually written, and with `ours` contributing nothing that is what the
  // whole `ours` file says, terminator and all.
  const atEnd = parseConflict(['a', '<<<<<<< HEAD', '||||||| base', 'X', '=======', 'C', '>>>>>>> feat', ''].join('\n'));
  check('a conflict at the end with an empty side is still one', conflictAtEnd(atEnd) === true, JSON.stringify(atEnd));
  check(
    'an ours that ends there and has no terminator does not gain one',
    renderResolved(atEnd, ['ours'], { ours: 'a', theirs: 'a\nC\n' }) === 'a',
    JSON.stringify(renderResolved(atEnd, ['ours'], { ours: 'a', theirs: 'a\nC\n' }))
  );
  check(
    '  and one that has a terminator keeps exactly one',
    renderResolved(atEnd, ['ours'], { ours: 'a\n', theirs: 'a\nC\n' }) === 'a\n',
    JSON.stringify(renderResolved(atEnd, ['ours'], { ours: 'a\n', theirs: 'a\nC\n' }))
  );
}

// --- diff3, which carries the common ancestor too ---------------------------
{
  // Some people set merge.conflictStyle=diff3 globally, which adds a third
  // section. It is what both sides started from, not a third option — reading
  // it as one of the two would offer the user a version nobody wrote.
  const diff3 = [
    'a',
    '<<<<<<< HEAD',
    'mine',
    '||||||| base',
    'the original',
    '=======',
    'theirs',
    '>>>>>>> feature',
    'b',
  ].join('\n');
  const parts = parseConflict(diff3);
  check('diff3 markers still give one disagreement', clashCount(parts) === 1, JSON.stringify(parts));
  const clash = parts.find((p) => p.kind === 'clash');
  check('with this branch’s side', clash.ours === 'mine', JSON.stringify(clash.ours));
  check('and the incoming side', clash.theirs === 'theirs', JSON.stringify(clash.theirs));
  check('and the ancestor offered as neither', !JSON.stringify(clash).includes('the original'), JSON.stringify(clash));
  check('rebuilding drops the ancestor', renderResolved(parts, ['ours']) === 'a\nmine\nb', JSON.stringify(renderResolved(parts, ['ours'])));
}

// --- Splitting one conflict into the decisions it really contains -----------
//
// The case this was built for, and the one that made the whole dialog feel
// wrong before it: a branch is made, the heading is changed on one side and
// the paragraph beneath it on the other. Git reports that as ONE conflict,
// because the two edits are adjacent — and no answer to it is right. Keeping
// either side loses an edit; keeping "both" duplicates the heading AND the
// paragraph.
//
// The two sides cannot be told apart by comparing them to each other: every
// line differs. What separates them is the ancestor.
{
  const conflicted = [
    '<<<<<<< HEAD',
    '  <h2>Heading 2</h2>',
    '  <p>Paragraph EDITED ON MAIN</p>',
    '||||||| base',
    '  <h2>Heading 2</h2>',
    '  <p>Paragraph original</p>',
    '=======',
    '  <h2>Heading 3</h2>',
    '  <p>Paragraph original</p>',
    '>>>>>>> new-branch',
  ].join('\n');
  const parts = parseConflict(conflicted);

  check('two adjacent edits are two decisions', clashCount(parts) === 2, JSON.stringify(parts));
  const clashes = parts.filter((p) => p.kind === 'clash');
  // And each is attributed to the branch that actually made it, which is what
  // lets the dialog answer them without asking.
  check('the heading is credited to the incoming branch', clashes[0].changedBy === 'theirs', JSON.stringify(clashes[0]));
  check('the paragraph to this one', clashes[1].changedBy === 'ours', JSON.stringify(clashes[1]));

  // Defaulting to whoever changed each part gives exactly what was wanted,
  // with nothing to pick by hand.
  const picks = clashes.map((c) => (c.changedBy === 'theirs' ? 'theirs' : 'ours'));
  const out = renderResolved(parts, picks);
  check('the heading comes from the branch that changed it', out.includes('Heading 3'), out);
  check('the paragraph from the branch that changed it', out.includes('EDITED ON MAIN'), out);
  check('and nothing is duplicated', !out.includes('Heading 2') && !out.includes('Paragraph original'), out);
  check('the file has just the two lines', out.split('\n').filter((l) => l.trim()).length === 2, JSON.stringify(out));
}

// --- Edits that really do overlap stay one decision -------------------------
{
  // Both branches rewrote the same line. There is no splitting this: it is a
  // genuine disagreement and has to be asked about.
  const conflicted = [
    '<<<<<<< HEAD',
    'title from main',
    '||||||| base',
    'the original title',
    '=======',
    'title from feature',
    '>>>>>>> feature',
  ].join('\n');
  const parts = parseConflict(conflicted);
  check('one line both changed is one decision', clashCount(parts) === 1, JSON.stringify(parts));
  check('and is marked as a real disagreement', parts.find((p) => p.kind === 'clash').changedBy === 'both');
}

// --- The ancestor is never offered as a version -----------------------------
{
  const parts = parseConflict(
    ['<<<<<<< HEAD', 'mine', '||||||| base', 'ORIGINAL', '=======', 'theirs', '>>>>>>> f'].join('\n')
  );
  const out = JSON.stringify(parts);
  check('the ancestor is not one of the choices', !out.includes('ORIGINAL'), out);
  check('and never lands in the rebuilt file', !renderResolved(parts, ['both']).includes('ORIGINAL'));
}

// --- The splitter on its own ------------------------------------------------
{
  const base = ['a', 'b', 'c', 'd'];
  // One side changes the first line, the other the last: two decisions, with
  // the untouched middle no longer part of either.
  const runs = threeWay(base, ['A', 'b', 'c', 'd'], ['a', 'b', 'c', 'D']);
  const clashes = runs.filter((r) => !r.common);
  check('separate edits split apart', clashes.length === 2, JSON.stringify(runs));
  check('each credited to its own side', clashes[0].changedBy === 'ours' && clashes[1].changedBy === 'theirs', JSON.stringify(clashes));
  check('untouched lines are common', runs.some((r) => r.common && r.common.includes('b')), JSON.stringify(runs));

  // Nothing changed on either side: no decisions at all.
  const none = threeWay(base, base, base).filter((r) => !r.common);
  check('an unchanged region asks nothing', none.length === 0, JSON.stringify(none));

  // One side deleted lines the other left alone.
  const del = threeWay(base, ['a', 'd'], base).filter((r) => !r.common);
  check('a deletion is one decision', del.length === 1, JSON.stringify(del));
  check('credited to the side that deleted', del[0].changedBy === 'ours', JSON.stringify(del[0]));
  check('with the other side keeping the lines', del[0].theirs.join(',') === 'b,c', JSON.stringify(del[0]));
}

// --- Two edits to the same line that never touch each other -----------------
//
// The finest grain this goes to, and the one that turns the commonest "real"
// conflict into no conflict at all: a class added to a heading on one branch
// while the words inside it were rewritten on the other. Both edited the same
// line, so git reports a clash and a line-level answer throws one edit away —
// but inside the line the changes are nowhere near each other.
//
// The danger here is the opposite of losing an edit: inventing one. A combined
// line that neither branch wrote, presented as though it were a merge, would
// be worse than asking. So the refusals are checked as carefully as the merge.
{
  check(
    'a class on one side and new words on the other combine',
    mergeInline('<h2>Hi</h2>', '<h2 class="a">Hi</h2>', '<h2>Hello</h2>') === '<h2 class="a">Hello</h2>',
    JSON.stringify(mergeInline('<h2>Hi</h2>', '<h2 class="a">Hi</h2>', '<h2>Hello</h2>'))
  );
  // Whitespace has to come through exactly. A merge that quietly reindents is
  // a merge nobody can trust with a template.
  check(
    'indentation is preserved exactly',
    mergeInline('  <p>a</p>', '  <p class="x">a</p>', '  <p>b</p>') === '  <p class="x">b</p>',
    JSON.stringify(mergeInline('  <p>a</p>', '  <p class="x">a</p>', '  <p>b</p>'))
  );

  // Both rewrote the same words: a real disagreement, and combining would
  // produce a line neither branch wrote.
  check(
    'the same words rewritten twice is still a question',
    mergeInline('<h2>Title</h2>', '<h2>From main</h2>', '<h2>From branch</h2>') === null
  );
  // Both added something at the same place — the order would be invented.
  check(
    'two attributes added at the same spot is still a question',
    mergeInline('<h2>Hi</h2>', '<h2 class="a">Hi</h2>', '<h2 id="b">Hi</h2>') === null
  );
  check('with no ancestor it will not guess', mergeInline(null, 'a', 'b') === null);
  check('and an unchanged line offers nothing', mergeInline('same', 'same', 'same') === null);
}

// --- The combined version, end to end ---------------------------------------
{
  const conflicted = [
    '<<<<<<< HEAD',
    '  <h2 class="title">Heading 2</h2>',
    '||||||| base',
    '  <h2>Heading 2</h2>',
    '=======',
    '  <h2>Heading 3</h2>',
    '>>>>>>> new-branch',
  ].join('\n');
  const parts = parseConflict(conflicted);
  const clash = parts.find((p) => p.kind === 'clash');
  check('a combinable clash carries the combined text', clash.merged != null, JSON.stringify(clash));
  check(
    'holding both edits',
    clash.merged === '  <h2 class="title">Heading 3</h2>',
    JSON.stringify(clash.merged)
  );
  check('and it is still marked as both having changed', clash.changedBy === 'both');
  check(
    'choosing it rebuilds the file with both',
    renderResolved(parts, ['merged']) === '  <h2 class="title">Heading 3</h2>',
    JSON.stringify(renderResolved(parts, ['merged']))
  );
  // Either side on its own must still be reachable — the combination is a
  // default, not a decision taken away.
  check('one side alone is still available', renderResolved(parts, ['ours']).includes('Heading 2'));
  check('and the other', renderResolved(parts, ['theirs']).includes('Heading 3'));

  // A clash with nothing to combine must not grow a merged version, or the UI
  // would offer a button that silently means "ours".
  const plain = parseConflict(
    ['<<<<<<< HEAD', 'aaa', '||||||| base', 'bbb', '=======', 'ccc', '>>>>>>> f'].join('\n')
  ).find((p) => p.kind === 'clash');
  check('an uncombinable clash has no combined version', plain.merged === undefined, JSON.stringify(plain));
  // Asking for one anyway falls back rather than rendering "undefined".
  check(
    'and asking for one falls back to your side',
    renderResolved([plain], ['merged']) === 'aaa',
    JSON.stringify(renderResolved([plain], ['merged']))
  );
}

// --- The newline the markers made up ----------------------------------------
//
// A marker sits on a line of its own, so when the conflict runs to the end of
// the file git writes a newline after the chosen side's last line whether or
// not that side had one. Rebuilding from the marked-up file alone cannot tell
// an invented terminator from a real one — and that made the two ways of
// phrasing the SAME decision produce different bytes: `'theirs'` for the whole
// file is `git checkout --theirs`, which is the incoming file exactly, while
// `['theirs']` came back with a terminator the incoming file did not have.
{
  const atEnd = parseConflict(
    ['a', '<<<<<<< HEAD', 'main', '||||||| base', 'base', '=======', 'feat', '>>>>>>> f', ''].join('\n')
  );
  check('a conflict at the end of the file is recognised as one', conflictAtEnd(atEnd) === true, JSON.stringify(atEnd));
  check(
    'with no sides to consult, it renders as it always did',
    renderResolved(atEnd, ['theirs']) === 'a\nfeat\n',
    JSON.stringify(renderResolved(atEnd, ['theirs']))
  );
  check(
    'an incoming side with no terminator does not gain one',
    renderResolved(atEnd, ['theirs'], { ours: 'a\nmain\n', theirs: 'a\nfeat' }) === 'a\nfeat',
    JSON.stringify(renderResolved(atEnd, ['theirs'], { ours: 'a\nmain\n', theirs: 'a\nfeat' }))
  );
  check(
    'and one that has a terminator keeps exactly one',
    renderResolved(atEnd, ['theirs'], { ours: 'a\nmain', theirs: 'a\nfeat\n' }) === 'a\nfeat\n',
    JSON.stringify(renderResolved(atEnd, ['theirs'], { ours: 'a\nmain', theirs: 'a\nfeat\n' }))
  );
  // The ANSWER decides which side is consulted, not the other way round.
  check(
    'keeping this branch reads this branch’s terminator',
    renderResolved(atEnd, ['ours'], { ours: 'a\nmain', theirs: 'a\nfeat\n' }) === 'a\nmain',
    JSON.stringify(renderResolved(atEnd, ['ours'], { ours: 'a\nmain', theirs: 'a\nfeat\n' }))
  );
  check(
    'and an answer nobody gave keeps this branch’s, like the render itself does',
    renderResolved(atEnd, [], { ours: 'a\nmain', theirs: 'a\nfeat\n' }) === 'a\nmain',
    JSON.stringify(renderResolved(atEnd, [], { ours: 'a\nmain', theirs: 'a\nfeat\n' }))
  );
  // 'both' ends on the incoming side, so that is the side to ask.
  check(
    '"both" ends on the incoming side, so it reads that terminator',
    renderResolved(atEnd, ['both'], { ours: 'a\nmain\n', theirs: 'a\nfeat' }) === 'a\nmain\nfeat',
    JSON.stringify(renderResolved(atEnd, ['both'], { ours: 'a\nmain\n', theirs: 'a\nfeat' }))
  );
  // A side that DELETED the file has no version to take a terminator from, and
  // must not be read as "a version with no terminator".
  check(
    'a deleted side leaves git’s own terminator alone',
    renderResolved(atEnd, ['theirs'], { ours: 'a\nmain\n', theirs: null }) === 'a\nfeat\n',
    JSON.stringify(renderResolved(atEnd, ['theirs'], { ours: 'a\nmain\n', theirs: null }))
  );

  // --- 'BOTH' DOES NOT ALWAYS END ON THE INCOMING SIDE ----------------------
  //
  // The rule above — "'both' and 'merged' end on the incoming side" — is a
  // rule about the WORD, and the renderer's rule is about the TEXT: 'both' is
  // `[ours, theirs].filter(s => s !== '').join('\n')`, so when the incoming
  // side of the last clash is EMPTY the file ends on ours while the terminator
  // was still being read off `sides.theirs`.
  //
  // MEASURED, with ours `"head\nOURSLAST\n"` and theirs `"head"` — no
  // terminator on the incoming side, which is the side that has nothing to
  // contribute here: `['both']` wrote `"head\nOURSLAST"` to disk and `['ours']`
  // wrote `"head\nOURSLAST\n"`. The same retained content, one byte apart,
  // decided by which of two equivalent words the caller happened to use.
  {
    // git's own markup for "this branch added a line at the end, the incoming
    // branch has nothing there".
    const oursOnly = parseConflict(['head', '<<<<<<< HEAD', 'OURSLAST', '=======', '>>>>>>> f', ''].join('\n'));
    check('a clash whose incoming side is empty is still at the end of the file', conflictAtEnd(oursOnly) === true, JSON.stringify(oursOnly));
    const sides = { ours: 'head\nOURSLAST\n', theirs: 'head' };
    check(
      '"both" with an empty incoming side reads the terminator off ours, which is where the text ends',
      renderResolved(oursOnly, ['both'], sides) === 'head\nOURSLAST\n',
      JSON.stringify(renderResolved(oursOnly, ['both'], sides))
    );
    // The point of the pair: two words for the same retained content must not
    // produce two different files.
    check(
      'so "both" and "ours" agree byte for byte when both keep the same text',
      renderResolved(oursOnly, ['both'], sides) === renderResolved(oursOnly, ['ours'], sides),
      `${JSON.stringify(renderResolved(oursOnly, ['both'], sides))} vs ${JSON.stringify(renderResolved(oursOnly, ['ours'], sides))}`
    );
    // AND THE OTHER WAY ROUND, so this is not "always read ours". With the
    // incoming side present it is the one the text ends on, and its missing
    // terminator is the one that counts.
    const both = parseConflict(['head', '<<<<<<< HEAD', 'MINE', '=======', 'YOURS', '>>>>>>> f', ''].join('\n'));
    const twoSided = { ours: 'head\nMINE\n', theirs: 'head\nYOURS' };
    check(
      '"both" with a real incoming side still reads the terminator off theirs',
      renderResolved(both, ['both'], twoSided) === 'head\nMINE\nYOURS',
      JSON.stringify(renderResolved(both, ['both'], twoSided))
    );
    // And the ours-side terminator is not consulted when the file does not end
    // on ours: theirs ends with one, so the file keeps it.
    check(
      'and leaves the newline alone when the side it ends on has one',
      renderResolved(both, ['both'], { ours: 'head\nMINE', theirs: 'head\nYOURS\n' }) === 'head\nMINE\nYOURS\n',
      JSON.stringify(renderResolved(both, ['both'], { ours: 'head\nMINE', theirs: 'head\nYOURS\n' }))
    );
    // A clash where NEITHER side put anything at the end has no version's
    // terminator to take, so git's own newline is the only one there is.
    const neither = parseConflict(['head', '<<<<<<< HEAD', '=======', '>>>>>>> f', ''].join('\n'));
    if (conflictAtEnd(neither)) {
      check(
        'a clash both sides emptied keeps git’s own terminator',
        renderResolved(neither, ['both'], { ours: 'head', theirs: 'head' }).endsWith('\n'),
        JSON.stringify(renderResolved(neither, ['both'], { ours: 'head', theirs: 'head' }))
      );
    }
  }

  // AND THE CASE THIS MUST NOT TOUCH. When the file ends with text both sides
  // agree on, the terminator is ordinary content and came through the markers
  // intact — trimming there would delete a real newline.
  const inMiddle = parseConflict(
    ['<<<<<<< HEAD', 'main', '||||||| base', 'base', '=======', 'feat', '>>>>>>> f', 'z', ''].join('\n')
  );
  check('a conflict with settled text after it is not at the end', conflictAtEnd(inMiddle) === false, JSON.stringify(inMiddle));
  check(
    'and its terminator is left exactly as the file had it',
    renderResolved(inMiddle, ['theirs'], { ours: 'main\nz', theirs: 'feat\nz' }) === 'feat\nz\n',
    JSON.stringify(renderResolved(inMiddle, ['theirs'], { ours: 'main\nz', theirs: 'feat\nz' }))
  );
  // A marked-up file with no final newline has no trailing empty part, so
  // there is nothing to take off and nothing was invented to take off.
  const noTerminator = parseConflict(
    ['a', '<<<<<<< HEAD', 'main', '=======', 'feat', '>>>>>>> f'].join('\n')
  );
  check('a marked-up file with no final newline is not at the end either', conflictAtEnd(noTerminator) === false, JSON.stringify(noTerminator));
  check(
    'and renders without one',
    renderResolved(noTerminator, ['theirs'], { ours: 'a\nmain', theirs: 'a\nfeat' }) === 'a\nfeat',
    JSON.stringify(renderResolved(noTerminator, ['theirs'], { ours: 'a\nmain', theirs: 'a\nfeat' }))
  );
}

// --- a conflict that ends the file ON TEXT BOTH SIDES HAVE -------------------
//
// The split inside a block is the reason this shape exists: two sides that end
// the same way come back as a clash and then the run they agree on, so the
// trailing empty part is no longer preceded by the clash and `conflictAtEnd`
// used to answer false. The terminator correction then never ran, and the
// rebuilt file gained git's own newline over a side that had none.
//
// THE MARKED-UP TEXT HERE IS REAL GIT'S, not a hand-drawn approximation:
// base "head\nBASE\ntail\n", ours "head\nOURS\ntail\n", theirs
// "head\nTHEIRS\ntail" with no terminator, merged with
// merge.conflictStyle=diff3 — the missing newline makes the last lines differ,
// so git marks up the tail as well. Measured before the fix: `['theirs']`
// committed "head\nTHEIRS\ntail\n" while `'theirs'` — the same decision, whole
// file — committed the blob exactly, both answering ok.
{
  const sharedTail = parseConflict(
    'head\n<<<<<<< HEAD\nOURS\ntail\n||||||| 40b9761\nBASE\ntail\n=======\nTHEIRS\ntail\n>>>>>>> feature\n'
  );
  check('the shared tail comes back as its own agreed run', clashCount(sharedTail) === 1, JSON.stringify(sharedTail));
  check(
    '  stamped as having come from inside the markers',
    sharedTail[sharedTail.length - 2]?.kind === 'same' && sharedTail[sharedTail.length - 2]?.inClash === true,
    JSON.stringify(sharedTail)
  );
  check('AND THE CONFLICT STILL ENDS THE FILE', conflictAtEnd(sharedTail) === true, JSON.stringify(sharedTail));
  const bothSides = { ours: 'head\nOURS\ntail\n', theirs: 'head\nTHEIRS\ntail' };
  check(
    'the incoming side with no terminator does not gain one',
    renderResolved(sharedTail, ['theirs'], bothSides) === 'head\nTHEIRS\ntail',
    JSON.stringify(renderResolved(sharedTail, ['theirs'], bothSides))
  );
  check(
    '  while this branch, which has one, keeps exactly one',
    renderResolved(sharedTail, ['ours'], bothSides) === 'head\nOURS\ntail\n',
    JSON.stringify(renderResolved(sharedTail, ['ours'], bothSides))
  );
  // The other way round, so the answer cannot be "always strip".
  const mirrored = { ours: 'head\nOURS\ntail', theirs: 'head\nTHEIRS\ntail\n' };
  check(
    'and with the terminators swapped the answers swap with them',
    renderResolved(sharedTail, ['ours'], mirrored) === 'head\nOURS\ntail' &&
      renderResolved(sharedTail, ['theirs'], mirrored) === 'head\nTHEIRS\ntail\n',
    JSON.stringify([renderResolved(sharedTail, ['ours'], mirrored), renderResolved(sharedTail, ['theirs'], mirrored)])
  );
  // 'both' has no line of its own at the end here — the last line is the one
  // both versions carry — and reads the terminator the way it always has, off
  // the side of the clash that was actually written. What must not happen is
  // the shape going unrecognised again and git's own newline surviving.
  check(
    'keeping both is read off a version too, not left with git’s newline',
    renderResolved(sharedTail, ['both'], bothSides) === 'head\nOURS\nTHEIRS\ntail' &&
      renderResolved(sharedTail, ['both'], mirrored) === 'head\nOURS\nTHEIRS\ntail\n',
    JSON.stringify([renderResolved(sharedTail, ['both'], bothSides), renderResolved(sharedTail, ['both'], mirrored)])
  );
}

// --- A conflicted file that does not use LF ----------------------------------
//
// GIT WRITES ITS MARKERS WITH THE FILE'S OWN LINE ENDING, AND THE MARKER
// PATTERNS COULD NOT SEE PAST A CARRIAGE RETURN.
//
// `<<<<<<< HEAD\r` is what a CRLF file gets — anything authored on Windows,
// anything under core.autocrlf, anything a .gitattributes marks
// `text eol=crlf`. In JavaScript `.` does not match '\r' and `$` without the
// `m` flag matches only at the very end of the string, so `/^<<<<<<< ?(.*)$/`
// matched no marker in such a file at all: the whole marked-up thing came back
// as ONE agreed part, clashCount() was 0, and the panel then sent the
// whole-file word "ours" for a file it had shown the user nothing about. The
// bytes below are real git output, `merge.conflictStyle=diff3`, taken from a
// repository with `*.txt text eol=crlf`.
{
  const marked =
    'head\r\n<<<<<<< HEAD\r\nOURS\r\n||||||| 77ebd51\r\nBASE\r\n=======\r\nTHEIRS\r\n>>>>>>> feature\r\ntail\r\n';
  const parts = parseConflict(marked);
  check('a CRLF conflict is a disagreement, not one agreed file', clashCount(parts) === 1, JSON.stringify(parts));
  check(
    '  and not one marker is left in the text called agreed',
    !parts.some((p) => p.kind === 'same' && /(?:^|\n)(?:<{7}|\|{7}|={7}|>{7})/.test(p.text)),
    JSON.stringify(parts)
  );
  // THE ROUND TRIP, BYTE FOR BYTE. The two branch versions below are the files
  // git checks out for `--ours` and `--theirs` in that repository, CRLF and
  // all, so anything this rebuilds that is not one of them is a byte nobody
  // wrote.
  check(
    'keeping this branch rebuilds its CRLF file exactly',
    renderResolved(parts, ['ours']) === 'head\r\nOURS\r\ntail\r\n',
    JSON.stringify(renderResolved(parts, ['ours']))
  );
  check(
    '  and keeping the incoming branch rebuilds its CRLF file exactly',
    renderResolved(parts, ['theirs']) === 'head\r\nTHEIRS\r\ntail\r\n',
    JSON.stringify(renderResolved(parts, ['theirs']))
  );
  check(
    '  and keeping both keeps CRLF between them',
    renderResolved(parts, ['both']) === 'head\r\nOURS\r\nTHEIRS\r\ntail\r\n',
    JSON.stringify(renderResolved(parts, ['both']))
  );
  // The same file with LF, so the CRLF answers above cannot be right by
  // accident of some rule that ignores the ending altogether.
  const lf = parseConflict('head\n<<<<<<< HEAD\nOURS\n||||||| 77ebd51\nBASE\n=======\nTHEIRS\n>>>>>>> feature\ntail\n');
  check(
    'CONTROL: the LF file of the same shape still rebuilds with LF',
    renderResolved(lf, ['theirs']) === 'head\nTHEIRS\ntail\n' && clashCount(lf) === 1,
    JSON.stringify(renderResolved(lf, ['theirs']))
  );
}

// --- The final newline, in a file whose newline is two bytes -----------------
//
// THE CORRECTION TOOK OFF ONE CHARACTER, AND A CRLF TERMINATOR IS TWO.
//
// When the conflict runs to the end of the file git writes a terminator after
// the chosen side whether or not that side had one, and renderResolved takes
// it back off when the side it ends on has none. Slicing exactly one character
// out of a CRLF file removes the '\n' and leaves the '\r' — a byte NEITHER
// BRANCH WROTE, on the last line, invisible in every editor that draws it.
// MEASURED with real git, ours "head\r\nOURS\r\n" and theirs
// "head\r\nTHEIRS" with no terminator: `['theirs']` rendered
// "head\r\nTHEIRS\r" and `['both']` rendered "head\r\nOURS\r\nTHEIRS\r",
// both written, staged and committed as ok.
{
  const parts = parseConflict('head\r\n<<<<<<< HEAD\r\nOURS\r\n=======\r\nTHEIRS\r\n>>>>>>> feature\r\n');
  check('the CRLF conflict that ends the file is recognised as one', conflictAtEnd(parts) === true, JSON.stringify(parts));
  // Stages 2 and 3 as `git show` gives them — the index blob, which for an
  // `eol=crlf` file is stored with LF. Whether it ends in a terminator is the
  // only thing read off it, and normalisation does not change that.
  const sides = { ours: 'head\nOURS\n', theirs: 'head\nTHEIRS' };
  check(
    'the incoming side with no terminator gains neither a newline nor a stray CR',
    renderResolved(parts, ['theirs'], sides) === 'head\r\nTHEIRS',
    JSON.stringify(renderResolved(parts, ['theirs'], sides))
  );
  check(
    '  while this branch, which has one, keeps the whole CRLF pair',
    renderResolved(parts, ['ours'], sides) === 'head\r\nOURS\r\n',
    JSON.stringify(renderResolved(parts, ['ours'], sides))
  );
  check(
    '  and keeping both ends on the incoming side, terminator and all',
    renderResolved(parts, ['both'], sides) === 'head\r\nOURS\r\nTHEIRS',
    JSON.stringify(renderResolved(parts, ['both'], sides))
  );
  // CONTROL, AND THE REASON THIS IS ASKED OF THE SIDE RATHER THAN OF THE TEXT.
  // A '\r' at the end of the last line is not always part of a line ending: an
  // LF-terminated file can carry one as content. The side git is holding says
  // which this is, and stripping two bytes there would eat a byte the branch
  // really wrote.
  const carried = { ours: 'head\nOURS\n', theirs: 'head\nTHEIRS\r' };
  check(
    'CONTROL: a CR the incoming side really ends on is not taken for a line ending',
    renderResolved(parts, ['theirs'], carried) === 'head\r\nTHEIRS\r',
    JSON.stringify(renderResolved(parts, ['theirs'], carried))
  );
  // And the LF file of the same shape is unmoved by any of it.
  const lf = parseConflict('head\n<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> feature\n');
  check(
    'CONTROL: the LF file still loses exactly its one newline',
    renderResolved(lf, ['theirs'], { ours: 'head\nOURS\n', theirs: 'head\nTHEIRS' }) === 'head\nTHEIRS',
    JSON.stringify(renderResolved(lf, ['theirs'], { ours: 'head\nOURS\n', theirs: 'head\nTHEIRS' }))
  );
}

// --- Markers that survived into the text this called agreed ------------------
//
// A MARKED-UP FILE THAT PARSES TO NOTHING LOOKS EXACTLY LIKE A FILE WITH
// NOTHING TO CHOOSE, AND THE DIFFERENCE IS THE WHOLE MERGE.
//
// parseConflict keeps anything it cannot read as `same` text, which is right —
// no line is ever dropped — but `same` means "both branches agree on this" and
// a `<<<<<<<` line is git saying the opposite. Every caller reads
// clashCount() === 0 as "no disagreements", so the shape has to be
// recognisable on its own. The CRLF markers above were one way to reach it;
// this is the shape rather than that cause.
{
  const readable = parseConflict('a\n<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> f\nb\n');
  check('a conflict that was read carries no unread markers', unreadMarkers(readable) === false, JSON.stringify(readable));
  const crlf = parseConflict('a\r\n<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> f\r\nb\r\n');
  check('  nor does the CRLF one, now that it is read', unreadMarkers(crlf) === false, JSON.stringify(crlf));
  const plain = parseConflict('a file with no markers in it at all\n');
  check('  and a file with no markers has none unread either', unreadMarkers(plain) === false, JSON.stringify(plain));
  // The two shapes that do reach it: a block nobody closed, and a marker whose
  // opener this could not match at all. Both leave the opener in agreed text.
  const unclosed = parseConflict('a\n<<<<<<< HEAD\nO\n=======\nT\n');
  check('an unclosed block is nought hunks AND says its markers went unread', clashCount(unclosed) === 0 && unreadMarkers(unclosed) === true, JSON.stringify(unclosed));
  check(
    '  with every one of its lines still in the parse',
    renderResolved(unclosed) === 'a\n<<<<<<< HEAD\nO\n=======\nT\n',
    JSON.stringify(renderResolved(unclosed))
  );
  // Not a marker: seven is the count git writes, and a longer run of the same
  // character is somebody's own text.
  check('a longer run of the same character is not a marker', unreadMarkers(parseConflict('a\n<<<<<<<<\nb\n')) === false);
}

if (failures.length) {
  console.error(`conflicts: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`conflicts: ${checked} passed`);
suiteDone();
