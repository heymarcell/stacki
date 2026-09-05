// Every semantic edit, against the bytes of the file it lands in.
//
//   node test/source-fidelity-matrix.js
//
// test/source-fidelity.js asks the question for ONE operation — `set_prop` —
// on one page. That is the operation that was already surgical, which is why
// the suite stayed green while a native-Claude dogfood watched `append_child`
// reprint a whole <section>, `insert_after` reprint an entire page body,
// `remove` tear the frontmatter comments off the imports they annotate, and
// `add_class` rewrite an author's `class='x'` as `class="x"`.
//
// So this asks the same question for ALL of them, across files written the
// several ordinary ways: tabs, two spaces, four spaces, CRLF, single quotes,
// double quotes, comments between the imports — with a blank line and, in the
// fifth fixture, without one — a `.map()` over repeated content, an inline
// component child, an element holding nothing but text, a multi-line attribute
// block, Astro expressions, nested components.
//
// And once for the operation whose bytes travel: `move` measured OUT AND BACK,
// because a move is the one edit that can quietly change the two elements it
// was not aimed at, and only the return trip asks about those.
//
// THE ORACLE IS BYTES. For each operation the intended delta is named exactly
// — the attribute, the line, the moved node — taken back out of the result,
// and what remains must equal the file that was there BYTE FOR BYTE. Nothing
// weaker will do:
//
//   * a line-count threshold passes a file rewritten into the same number of
//     lines, and the whole-document reprint this suite exists to catch is
//     within four lines of the original on the fixtures below;
//   * a "changed span is small" budget passes a rewrite whose first and last
//     lines happen to survive;
//   * a semantic comparison passes every one of these defects, because the
//     defect is that the file is re-SPELLED, not re-meant.
//
// For the operations where source NECESSARILY moves — move, remove, duplicate
// — "only the intended span" is spelled out per operation: the moved bytes cut
// out of the result and put back at the offset they came from must give the
// original file; the removed line and its import put back must give it; the
// duplicated copy taken out must give it.
//
// Every mutation is then undone and redone and the bytes checked again, with
// no settle anywhere — a surgical write that undo cannot invert exactly is a
// worse bargain than the reprint it replaced (test/undo-bytes.js is where that
// property is developed; this borrows its oracle).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./agent-harness.js');
const { parsePage, anchoredSerialize, serializePage, applySplices } = require('../electron/astroParser.js');
const { guardSuite } = require('./support/suiteGuard.js');

// A HANG MUST NOT REPORT A PASS. This suite starts real Electron apps and awaits
// real IPC; node exits 0 on an empty event loop, so an await that never settles
// would print nothing after the last line it reached and be recorded as success.
// See test/support/suiteGuard.js.
const suiteDone = guardSuite('source-fidelity-matrix');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const tag = (text) => `${sha(text).slice(0, 12)} (${Buffer.byteLength(text)}b)`;

const PAGE = 'src/pages/index.astro';

/**
 * The one contiguous region two texts disagree about — for the failure
 * message, never for the verdict.
 */
function changedSpan(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { at: head, removed: before.slice(head, before.length - tail), added: after.slice(head, after.length - tail) };
}

/** `text` with the first occurrence of `piece` taken out, or null if it isn't there. */
function removeOnce(text, piece) {
  const at = text.indexOf(piece);
  return at === -1 ? null : text.slice(0, at) + text.slice(at + piece.length);
}

const frontmatterOf = (text) => {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? m[0] : null;
};

/** Every line's leading whitespace, as a set, so a report can name the odd one. */
const indentsIn = (text) =>
  [...new Set(text.split(/\r?\n/).map((line) => (/^[ \t]*/.exec(line) || [''])[0]).filter(Boolean))];

// --- the fixtures ------------------------------------------------------------
//
// One page, written five ways. The shapes are the ones a re-serialization is
// known to destroy, and every one of them is ordinary: the comments sit above
// the imports they annotate rather than in a block of their own, the
// attributes are quoted the way the author quoted them, the Card's attributes
// are spread over three lines on purpose, and the pricing grid is a `.map()`
// rather than repeated markup.
//
// `tight` is the fifth: THE SAME COMMENTS WITH NO BLANK LINE AROUND THEM, and
// a named import in front of the block. That is how the dogfood's page was
// written, and the difference is not cosmetic -- with a blank line above it a
// comment is its own paragraph and a reprint that hoists it below the imports
// is merely ugly; with none, the comment is visibly torn off the statement it
// annotates. Four fixtures all carried the blank lines, so the suite was
// green while a real page came back with three comments stacked under the
// import block. A gap in the fixtures is a defect in the suite.

function makeSource({ ind, eol, q, tight }) {
  const lines = [
    '---',
    // A NAMED import first, which nothing else here has: `parsePage` collects
    // default and named specifiers in two passes and sorts them back together,
    // so which kind stands first decides which span an added import lands
    // after.
    ...(tight ? ["import { getCollection } from 'astro:content';"] : []),
    '// Layout import - the shell every page shares',
    "import Base from '../layouts/Base.astro';",
    ...(tight ? [] : ['']),
    '// Component imports',
    "import Hero from '../components/Hero.astro';",
    "import Card from '../components/Card.astro';",
    ...(tight ? [] : ['']),
    '// Page data',
    "import site from '../data/site.json';",
    '',
    'const plans = [',
    `${ind}{ title: 'Starter', body: 'For one person' },`,
    `${ind}{ title: 'Team', body: 'For a few people' },`,
    '];',
    '---',
    '<Base>',
    `${ind}<Hero heading={site.tagline} />`,
    `${ind}<div class=${q}pricing-grid tight${q}>`,
    `${ind}${ind}{plans.map((plan) => (`,
    `${ind}${ind}${ind}<Card title={plan.title} body={plan.body} />`,
    `${ind}${ind}))}`,
    `${ind}</div>`,
    `${ind}<section class=${q}pills${q}>`,
    `${ind}${ind}<Card title=${q}Inline${q}><strong>Bold</strong> words</Card>`,
    // A MULTI-LINE BLOCK ONE LEVEL DOWN, so a move can carry it out to the
    // body: the bytes travel AND every line in them shifts a step left, and
    // the only fixture that could tell a shift from a reprint before this was
    // a one-line <Hero /> whose reprint is byte-identical to its source.
    `${ind}${ind}<Card`,
    `${ind}${ind}${ind}title=${q}Deep${q}`,
    `${ind}${ind}${ind}body=${q}nested on purpose${q}`,
    `${ind}${ind}/>`,
    // A COMPONENT AND A WORD ON ONE LINE. `isInlineRun` says no -- a component
    // is not an inline tag -- so `serializePage` prints this as three lines,
    // and reading THAT back gives the word a trailing space the one-line
    // spelling does not have. Nothing here edits it; it is the untouched
    // bystander whose reparse used to differ from the reparse of the reprint,
    // which is how a readback gate came to reject a correct splice over an
    // element the call never named. The dogfood's page had one of these
    // (`<Pill><Icon … /> Developer</Pill>`) and none of these fixtures did.
    `${ind}${ind}<h4 class=${q}pill-row${q}><Card title=${q}Tiny${q} /> Developer</h4>`,
    `${ind}</section>`,
    `${ind}<Card`,
    `${ind}${ind}title=${q}Wide${q}`,
    `${ind}${ind}body=${q}across lines on purpose${q}`,
    `${ind}/>`,
    // A BLANK LINE BETWEEN TWO SIBLINGS. `cutNodeSplice` takes the blank lines
    // an author left in FRONT of a node with the node, because left behind
    // they attach to whatever follows and the reparse stops agreeing with the
    // model about where the gaps are -- at which point the write falls back to
    // reprinting the whole document, in two spaces, with every quote changed.
    // Without this line no fixture reaches that rule.
    '',
    `${ind}<p class=${q}fine-print${q}>Made carefully.</p>`,
    `${ind}<footer>`,
    `${ind}${ind}<small>Made in 2026</small>`,
    `${ind}</footer>`,
    '</Base>',
    '',
  ];
  return lines.join(eol);
}

const FIXTURES = [
  { id: 'tabs', ind: '\t', eol: '\n', q: "'" },
  { id: 'two-space', ind: '  ', eol: '\n', q: '"' },
  { id: 'four-space', ind: '    ', eol: '\n', q: "'" },
  { id: 'crlf', ind: '  ', eol: '\r\n', q: "'" },
  { id: 'tight-comments', ind: '\t', eol: '\n', q: "'", tight: true },
].map((f) => ({ ...f, source: makeSource(f) }));

// --- the operations ----------------------------------------------------------
//
// Each one names its target, the call, and the delta it is ALLOWED to make.
// `back` returns the result with that delta taken out; the verdict is that what
// comes back equals the file that was there. `mark` is the positive control —
// bytes that must be IN the result, so an operation that quietly did nothing
// cannot pass the byte check by leaving the file alone.

const IMG = { kind: 'element', tag: 'img', props: { src: '/x.png', alt: 'x' } };
const IMG_TEXT = '<img src="/x.png" alt="x" />';

function operations(f) {
  const { ind, eol, q } = f;
  const heroLine = `${eol}${ind}<Hero heading={site.tagline} />`;
  // The Card whose attributes the author spread over three lines, exactly as
  // the file writes it -- and the same block one nesting level in, which is
  // what a move into the <section> has to produce.
  const cardBlock =
    `${eol}${ind}<Card` +
    `${eol}${ind}${ind}title=${q}Wide${q}` +
    `${eol}${ind}${ind}body=${q}across lines on purpose${q}` +
    `${eol}${ind}/>`;
  // The block that lives inside the <section>, and the same block raised one
  // step -- what a move out to the body has to write.
  const deepBlock =
    `${eol}${ind}${ind}<Card` +
    `${eol}${ind}${ind}${ind}title=${q}Deep${q}` +
    `${eol}${ind}${ind}${ind}body=${q}nested on purpose${q}` +
    `${eol}${ind}${ind}/>`;
  const deepBlockRaised =
    `${eol}${ind}<Card` +
    `${eol}${ind}${ind}title=${q}Deep${q}` +
    `${eol}${ind}${ind}body=${q}nested on purpose${q}` +
    `${eol}${ind}/>`;
  // The `<h4>` holding a component and a word ON ONE LINE, where the file put
  // it, and the same line raised to the body. `serializePage` has no rule for
  // putting a component on an inline line, so a REPRINT of this element is
  // three lines; only copying its own bytes keeps it one.
  const pillLine = `<h4 class=${q}pill-row${q}><Card title=${q}Tiny${q} /> Developer</h4>`;
  const pillRow = `${eol}${ind}${ind}${pillLine}`;
  const pillRowRaised = `${eol}${ind}${pillLine}`;
  return [
    {
      name: 'set_prop on a component',
      target: 'hero',
      call: (ref) => ['set_prop', { ref, name: 'id', value: 'top' }],
      mark: '<Hero heading={site.tagline} id="top" />',
      back: (after) => removeOnce(after, ' id="top"'),
    },
    {
      name: 'set_prop on a multi-line attribute block',
      target: 'wideCard',
      call: (ref) => ['set_prop', { ref, name: 'id', value: 'wide' }],
      mark: `body=${q}across lines on purpose${q} id="wide"${eol}${ind}/>`,
      back: (after) => removeOnce(after, ' id="wide"'),
    },
    {
      name: 'remove_prop',
      target: 'fine',
      call: (ref) => ['remove_prop', { ref, name: 'class' }],
      mark: '<p>Made carefully.</p>',
      // The delta is a removal, so it comes out of the BASELINE instead.
      forward: (before) => removeOnce(before, ` class=${q}fine-print${q}`),
    },
    {
      name: 'add_class',
      target: 'grid',
      call: (ref) => ['add_class', { ref, className: 'wide' }],
      mark: `class=${q}pricing-grid tight wide${q}`,
      back: (after) => removeOnce(after, ' wide'),
    },
    {
      name: 'remove_class',
      target: 'grid',
      call: (ref) => ['remove_class', { ref, className: 'tight' }],
      mark: `class=${q}pricing-grid${q}`,
      forward: (before) => removeOnce(before, ' tight'),
    },
    {
      name: 'set_classes',
      target: 'grid',
      call: (ref) => ['set_classes', { ref, classes: ['grid2'] }],
      mark: `class=${q}grid2${q}`,
      back: (after) => after.replace(`class=${q}grid2${q}`, `class=${q}pricing-grid tight${q}`),
    },
    {
      name: 'set_text on a plain element',
      target: 'fine',
      call: (ref) => ['set_text', { ref, text: 'Made boldly.' }],
      mark: '>Made boldly.<',
      back: (after) => after.replace('Made boldly.', 'Made carefully.'),
    },
    {
      name: 'set_text on a component with an inline child',
      target: 'inlineCard',
      call: (ref) => ['set_text', { ref, text: 'Other words' }],
      mark: '<strong>Bold</strong>Other words</Card>',
      back: (after) => after.replace('<strong>Bold</strong>Other words', '<strong>Bold</strong> words'),
    },
    {
      name: 'set_tag',
      target: 'section',
      call: (ref) => ['set_tag', { ref, tag: 'aside' }],
      mark: `<aside class=${q}pills${q}>`,
      back: (after) => after.replaceAll('<aside', '<section').replaceAll('</aside>', '</section>'),
    },
    {
      name: 'append_child',
      target: 'section',
      call: (ref) => ['append_child', { ref, node: IMG }],
      mark: `${eol}${ind}${ind}${IMG_TEXT}${eol}${ind}</section>`,
      back: (after) => removeOnce(after, `${eol}${ind}${ind}${IMG_TEXT}`),
    },
    {
      // AN ELEMENT HOLDING NOTHING BUT TEXT, which is what `<h3>Heading</h3>`
      // was on the dogfood's page. One text node is an inline run, so the
      // element is written on one line; an <img> is not an inline tag, so the
      // run has to become a block and the text moves onto a line of its own.
      // Read back, the newline and indent on either side of that text are a
      // rendered space, so the node's value is now ' Made carefully. ' where
      // the model still says 'Made carefully.' -- and the write path REFUSED
      // ITS OWN CORRECT SPLICE over it and reprinted the whole document, in
      // two spaces, with every quote changed and every frontmatter comment
      // torn off its import. Nothing else here reaches that: <footer> holds an
      // element, the inline Card holds a <strong>, and every other target is
      // already a block.
      //
      // The delta is the whole reshape of this one element, named exactly, so
      // the reprint cannot hide inside it.
      name: 'append_child into an element holding only text',
      target: 'fine',
      call: (ref) => ['append_child', { ref, node: IMG }],
      mark: `${eol}${ind}${ind}${IMG_TEXT}${eol}${ind}</p>`,
      forward: (before) =>
        removeOnce(before, `${ind}<p class=${q}fine-print${q}>Made carefully.</p>`) === null
          ? null
          : before.replace(
              `${ind}<p class=${q}fine-print${q}>Made carefully.</p>`,
              `${ind}<p class=${q}fine-print${q}>${eol}` +
                `${ind}${ind}Made carefully.${eol}` +
                `${ind}${ind}${IMG_TEXT}${eol}` +
                `${ind}</p>`
            ),
    },
    {
      // <footer> holds one <small>, which this serializer writes on a single
      // line -- so an <img> joining it changes how the WHOLE element is
      // written, and the element is reprinted rather than spliced. Reprinting
      // is allowed to cost exactly nothing: the children go back at the file's
      // own nesting step, which is where `\t  <small>` -- one tab and two
      // spaces -- used to come from.
      name: 'append_child into an element written on one line',
      target: 'footer',
      call: (ref) => ['append_child', { ref, node: IMG }],
      mark: `${eol}${ind}${ind}${IMG_TEXT}${eol}${ind}</footer>`,
      back: (after) => removeOnce(after, `${eol}${ind}${ind}${IMG_TEXT}`),
    },
    {
      name: 'insert_before',
      target: 'footer',
      call: (ref) => ['insert_before', { ref, node: IMG }],
      mark: `${eol}${ind}${IMG_TEXT}${eol}${ind}<footer>`,
      back: (after) => removeOnce(after, `${eol}${ind}${IMG_TEXT}`),
    },
    {
      // In FRONT of the first child, which has no preceding sibling to hang
      // off: the anchor is the first child's own offset and the new line goes
      // above it.
      name: 'insert_before the first child',
      target: 'hero',
      call: (ref) => ['insert_before', { ref, node: IMG }],
      mark: `<Base>${eol}${ind}${IMG_TEXT}${eol}${ind}<Hero`,
      back: (after) => removeOnce(after, `${ind}${IMG_TEXT}${eol}`),
    },
    {
      name: 'insert_after',
      target: 'hero',
      call: (ref) => ['insert_after', { ref, node: IMG }],
      mark: `/>${eol}${ind}${IMG_TEXT}${eol}`,
      back: (after) => removeOnce(after, `${eol}${ind}${IMG_TEXT}`),
    },
    {
      name: 'duplicate',
      target: 'hero',
      call: (ref) => ['duplicate', { ref }],
      mark: `${heroLine}${heroLine}`,
      back: (after) => removeOnce(after, heroLine),
    },
    {
      // The node's line goes, and so does the import nothing reads any more —
      // and NOTHING ELSE, including the `// Component imports` comment that
      // sits above it.
      name: 'remove',
      target: 'hero',
      call: (ref) => ['remove', { ref }],
      mark: '// Component imports' + eol + "import Card from '../components/Card.astro';",
      forward: (before) => {
        const cut = removeOnce(before, heroLine);
        return cut === null ? null : removeOnce(cut, `import Hero from '../components/Hero.astro';${eol}`);
      },
    },
    {
      // The one operation whose source genuinely travels. The property is that
      // the bytes that moved are the SAME BYTES: cut them out of the result,
      // put them back where they came from, and the original file is there.
      name: 'move',
      target: 'hero',
      moveToIndex: 5,
      call: (ref, ctx) => ['move', { ref, to: { parentRef: ctx.pageRef, index: 5 } }],
      mark: `${heroLine}${eol}${ind}<footer>`,
      back: (after, before) => {
        const cut = removeOnce(after, heroLine);
        if (cut === null) return null;
        const at = before.indexOf(heroLine);
        return at === -1 ? null : cut.slice(0, at) + heroLine + cut.slice(at);
      },
    },
    {
      // THE COPIED BYTES ARE THE SAME BYTES. `duplicate` above copies a
      // one-line <Hero />, whose reprint is byte-identical to its source, so
      // it cannot tell a copy from a reprint. This one can: reprinted, the
      // three lines collapse to one and the author's quotes are swapped.
      name: 'duplicate a multi-line attribute block',
      target: 'wideCard',
      call: (ref) => ['duplicate', { ref }],
      mark: `${cardBlock}${cardBlock}`,
      back: (after) => removeOnce(after, cardBlock),
    },
    {
      // ACROSS A NESTING LEVEL, which nothing else here does. The bytes move
      // AND every line in them shifts a step left -- and the shift is a shift,
      // not a reprint: the attribute block is still four lines, in the
      // author's quotes, at the body's indentation. Left un-shifted the block
      // keeps the section's indentation inside the body; reprinted it comes
      // back as one line with the quotes swapped. Both are visible here.
      name: 'move a multi-line block up a nesting level',
      target: 'deepCard',
      call: (ref, ctx) => ['move', { ref, to: { parentRef: ctx.pageRef, index: 5 } }],
      mark: `${deepBlockRaised}${eol}${ind}<footer>`,
      back: (after, before) => {
        const cut = removeOnce(after, deepBlockRaised);
        if (cut === null) return null;
        const at = before.indexOf(deepBlock);
        return at === -1 ? null : cut.slice(0, at) + deepBlock + cut.slice(at);
      },
    },
    {
      // THE MOVED BYTES ARE THE SAME BYTES, and the two moves above cannot say
      // so: a `<Hero />` and a multi-line `<Card>` both come back out of
      // `serializePage` spelled exactly as the file spelled them, so a move
      // that REPRINTED them would pass every check on them. Copying the twin's
      // own bytes -- the mechanism the writer calls "the only way 'move' can
      // mean that the moved bytes are the same bytes" -- was therefore
      // deletable with all nine parser suites green.
      //
      // This element is the one shape in the fixture whose reprint is NOT its
      // source: a component and a word on one line, which the serializer
      // writes as three lines because a component is not an inline tag. Move
      // it up a level and the bytes have to arrive as one line at the body's
      // indent. Reprinted, they arrive as three.
      name: 'move an element written on one line up a nesting level',
      target: 'pillRow',
      call: (ref, ctx) => ['move', { ref, to: { parentRef: ctx.pageRef, index: 5 } }],
      mark: `${pillRowRaised}${eol}${ind}<footer>`,
      back: (after, before) => {
        const cut = removeOnce(after, pillRowRaised);
        if (cut === null) return null;
        const at = before.indexOf(pillRow);
        return at === -1 ? null : cut.slice(0, at) + pillRow + cut.slice(at);
      },
    },
    {
      // The blank line the author left above it goes with it. Left behind, it
      // attaches to the <footer> and the readback no longer agrees with the
      // model -- and the fallback is the whole-document reprint this suite
      // exists to catch.
      name: 'remove a node with a blank line above it',
      target: 'fine',
      call: (ref) => ['remove', { ref }],
      mark: `${eol}${ind}/>${eol}${ind}<footer>`,
      forward: (before) =>
        removeOnce(before, `${eol}${eol}${ind}<p class=${q}fine-print${q}>Made carefully.</p>`),
    },
    {
      name: 'a batched target.edit',
      target: 'section',
      call: (ref) => [
        'edit',
        {
          ref,
          operations: [
            { type: 'set_prop', name: 'data-batch', value: 'yes' },
            { type: 'append_child', node: IMG },
          ],
        },
      ],
      mark: `<section class=${q}pills${q} data-batch="yes">`,
      back: (after) => {
        const one = removeOnce(after, ' data-batch="yes"');
        return one === null ? null : removeOnce(one, `${eol}${ind}${ind}${IMG_TEXT}`);
      },
    },
  ];
}

// --- one fixture -------------------------------------------------------------

async function runFixture(f) {
  const root = H.makeProject({ [PAGE]: f.source });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  try {
    // --- THE CONTROL. If opening the project rewrote the page, every byte
    //     comparison below would be measuring the wrong baseline and would
    //     still pass.
    const baseline = app.read(PAGE);
    if (
      !check(`[${f.id}] opening the project does not rewrite the page`, baseline === f.source, short({
        span: changedSpan(f.source, baseline),
      }))
    ) {
      return;
    }
    const baselineSha = sha(baseline);

    let pageRef = (await run('target', 'read')).target?.ref ?? null;
    check(`[${f.id}] the page answers with a ref`, !!pageRef, short(pageRef));

    // Every target the operations name, re-resolved before each one: a ref is
    // a position on a tree, and the tree is rebuilt by every undo.
    const resolve = async (which) => {
      const seen = (await run('target', 'read', { ref: pageRef })).target;
      // READING THE PAGE RE-ISSUES ITS REF against the file that is there now.
      // A `move` names its destination with a ref, and that ref has to have
      // seen the same version as the node being moved -- every operation below
      // rewrites the file, so a page ref taken once at the top is stale by the
      // second one and the move is refused rather than aimed at the wrong tree.
      if (seen?.ref) pageRef = seen.ref;
      const top = seen?.children || [];
      const byTag = (t) => top.find((c) => c.tag === t) || null;
      if (which === 'hero') return byTag('Hero')?.ref ?? null;
      if (which === 'grid') return byTag('div')?.ref ?? null;
      if (which === 'section') return byTag('section')?.ref ?? null;
      if (which === 'footer') return byTag('footer')?.ref ?? null;
      if (which === 'fine') return byTag('p')?.ref ?? null;
      if (which === 'wideCard') return byTag('Card')?.ref ?? null;
      if (which === 'inlineCard' || which === 'deepCard' || which === 'pillRow') {
        const section = byTag('section');
        if (!section?.ref) return null;
        const kids = (await run('target', 'read', { ref: section.ref })).target?.children || [];
        if (which === 'pillRow') return kids.find((c) => c.tag === 'h4')?.ref ?? null;
        const cards = kids.filter((c) => c.tag === 'Card');
        return (which === 'inlineCard' ? cards[0] : cards[1])?.ref ?? null;
      }
      return null;
    };

    for (const op of operations(f)) {
      const label = `[${f.id}] ${op.name}`;
      const before = app.read(PAGE);
      if (!check(`${label}: starts from the baseline bytes`, sha(before) === baselineSha, tag(before))) continue;

      const ref = await resolve(op.target);
      if (!check(`${label}: the target resolves`, !!ref, op.target)) continue;

      const [action, args] = await op.call(ref, { pageRef, resolve });
      const answer = await run('target', action, args);
      const after = app.read(PAGE);

      if (!check(`${label}: the call is accepted`, answer.ok === true, short(answer))) continue;
      // POSITIVE CONTROL: the edit really happened, and its own bytes are
      // there. Without this, an operation that wrote nothing at all would
      // satisfy every byte-identity check below.
      if (
        !check(`${label}: the file changed`, sha(after) !== baselineSha, tag(after)) ||
        !check(`${label}: the new bytes are in the file`, after.includes(op.mark), short({ want: op.mark, span: changedSpan(before, after) }))
      ) {
        // Put the file back so the next operation still starts from baseline.
        await run('project', 'undo');
        continue;
      }

      // --- THE VERDICT: the intended delta out, and nothing else moved.
      // An operation that only REMOVES bytes has no delta to take out of the
      // result: its `forward` takes the delta out of the baseline instead, and
      // the result is compared as it stands.
      const stripped = op.back ? op.back(after, before) : after;
      const wanted = op.forward ? op.forward(before) : before;
      check(
        `${label}: with its own delta taken back out, the file is byte-identical`,
        stripped !== null && wanted !== null && stripped === wanted,
        short({
          span: changedSpan(before, after),
          leftOver: stripped === null || wanted === null ? null : changedSpan(wanted, stripped),
        })
      );

      // --- THE AUTHOR'S FORMATTING, which no operation here named.
      check(
        `${label}:   the file's own indentation unit is the only one in it`,
        indentsIn(after).every((lead) => lead.split(f.ind).every((part) => part === '')),
        short({ unit: f.ind, found: indentsIn(after) })
      );
      check(
        `${label}:   the file's own line ending is the only one in it`,
        f.eol === '\n' ? !after.includes('\r') : !/(?<!\r)\n/.test(after),
        short({ eol: f.eol === '\n' ? 'LF' : 'CRLF', strayAt: after.indexOf(f.eol === '\n' ? '\r' : '\n\n') })
      );
      check(
        `${label}:   each frontmatter comment still sits on the import it annotates`,
        new RegExp(`// Layout import - the shell every page shares\\r?\\nimport Base`).test(after) &&
          (op.name === 'remove' ||
            new RegExp(`// Component imports\\r?\\nimport Hero`).test(after)) &&
          new RegExp(`// Page data\\r?\\nimport site`).test(after),
        short(frontmatterOf(after))
      );

      // --- UNDO AND REDO, with no settle: a surgical write has to be
      //     invertible to the byte, and the state redo restores has to be the
      //     state that was actually there.
      const undone = await run('project', 'undo');
      const back = app.read(PAGE);
      check(`${label}:   undo reports it undid something`, undone.ok === true && undone.undone === true, short(undone));
      check(
        `${label}:   and the file is byte-for-byte the baseline`,
        sha(back) === baselineSha,
        short({ baseline: baselineSha.slice(0, 12), got: tag(back), span: changedSpan(baseline, back) })
      );

      const redone = await run('project', 'redo');
      const again = app.read(PAGE);
      check(`${label}:   redo reports it redid something`, redone.ok === true && redone.redone === true, short(redone));
      check(
        `${label}:   and puts back exactly the bytes the edit wrote`,
        sha(again) === sha(after),
        short({ edited: tag(after), got: tag(again) })
      );

      await run('project', 'undo');
      check(
        `${label}:   and one more undo leaves the baseline for the next operation`,
        sha(app.read(PAGE)) === baselineSha,
        tag(app.read(PAGE))
      );
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }
  check(`[${f.id}] the fixture is gone`, !require('node:fs').existsSync(root), root);
}

// --- THE IMPORT AN INSERT BRINGS WITH IT -------------------------------------
//
// A frontmatter change used to send the whole file through the serializer,
// which is how `remove` came to tear the comments off the imports they
// annotate. The REMOVAL half of that is measured above, end to end, because
// `target.remove` prunes the import nothing reads any more.
//
// The ADDITION half is driven straight at the writer instead, because what it
// is measuring is the SPLICE: that one import statement goes in under the last
// one the file wrote and no other byte moves. That an inserted component brings
// its import at all is a different guarantee, belonging to the model rather
// than the printer, and test/insert-import.js measures it end to end.

function importInsert() {
  for (const f of FIXTURES) {
    const parsed = parsePage(f.source);
    if (!check(`[${f.id}] the fixture parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const section = model.nodes[0].children.find((n) => n.name === 'section');
    if (!check(`[${f.id}] the fixture has its section`, !!section, short(model.nodes[0].children.map((n) => n.name)))) continue;
    section.children.push({
      id: 'inserted',
      kind: 'component',
      name: 'Badge',
      props: { label: { type: 'string', value: 'New' } },
      children: [],
    });
    model.imports.push({ name: 'Badge', path: '../components/Badge.astro' });

    const after = anchoredSerialize(f.source, model);
    const markup = `${f.eol}${f.ind}${f.ind}<Badge label="New"></Badge>`;
    const line = `${f.eol}import Badge from '../components/Badge.astro';`;
    check(
      `[${f.id}] a component and the import it needs both land`,
      after.includes(markup) && after.includes(line),
      short(changedSpan(f.source, after))
    );
    const stripped = removeOnce(after, markup);
    check(
      `[${f.id}]   and those two lines are the only bytes that changed`,
      stripped !== null && removeOnce(stripped, line) === f.source,
      short({ span: changedSpan(f.source, after) })
    );
    check(
      `[${f.id}]   with the new import under the last one the file wrote`,
      new RegExp(`import site from '\\.\\./data/site\\.json';\r?\nimport Badge`).test(after),
      short(frontmatterOf(after))
    );
    check(
      `[${f.id}]   and every comment still above the import it annotates`,
      /\/\/ Component imports\r?\nimport Hero/.test(after) && /\/\/ Page data\r?\nimport site/.test(after),
      short(frontmatterOf(after))
    );

    // AND THE SAME COMPONENT INTO AN ELEMENT THAT HELD ONLY TEXT, which is the
    // dogfood's call verbatim: `append_child` of a component needing a new
    // import, onto an `<h3>` holding one word. The two halves are innocent
    // apart -- the operation list above appends an <img> into this same <p>
    // with no import in sight, and a <Badge> into the <section> above brings
    // an import without reshaping anything -- and together they reprinted the
    // file: 82 lines rewritten to add one, TAB 575 to 316, three comments
    // stacked below the import block. Measured here as the two things that
    // may change and nothing else.
    const m2 = structuredClone(parsed.model);
    const p2 = m2.nodes[0].children.find((n) => n.name === 'p');
    if (!check(`[${f.id}] the fixture has its text-only <p>`, !!p2, short(m2.nodes[0].children.map((n) => n.name)))) continue;
    p2.children.push({
      id: 'inserted',
      kind: 'component',
      name: 'Badge',
      props: { label: { type: 'string', value: 'New' } },
      children: [],
    });
    m2.imports.push({ name: 'Badge', path: '../components/Badge.astro' });
    const both = anchoredSerialize(f.source, m2);
    const reshaped = f.source.replace(
      `${f.ind}<p class=${f.q}fine-print${f.q}>Made carefully.</p>`,
      `${f.ind}<p class=${f.q}fine-print${f.q}>${f.eol}` +
        `${f.ind}${f.ind}Made carefully.${f.eol}` +
        `${f.ind}${f.ind}<Badge label="New"></Badge>${f.eol}` +
        `${f.ind}</p>`
    );
    check(
      `[${f.id}] a component needing an import, appended to an element holding only text`,
      removeOnce(both, line) === reshaped,
      short({ span: changedSpan(reshaped, removeOnce(both, line) ?? '') })
    );
    // Said again in the terms the dogfood measured it in, because "the bytes
    // are equal" is the strongest check and the least readable one: when it
    // goes red, these say which way.
    const census = (t) => ({
      tabs: (t.match(/\t/g) || []).length,
      single: (t.match(/'/g) || []).length,
      attached: /\/\/ Component imports\r?\nimport Hero/.test(t),
    });
    check(
      `[${f.id}]   with the file's tabs, quotes and comment attachment untouched`,
      // The <p> gains three indented lines, so a tab-indented file gains five
      // tabs and no others; the import line the model asked for carries the
      // two single quotes around its path, and no attribute anywhere in the
      // file trades a quote for a double one. Reprinted, this page came back
      // with ZERO tabs and every `'` in the body rewritten.
      census(both).tabs === census(f.source).tabs + (f.ind === '\t' ? 5 : 0) &&
        census(both).single === census(f.source).single + 2 &&
        census(both).attached === true,
      short({ before: census(f.source), after: census(both) })
    );
  }
}

// --- A NODE ON THE FIRST LINE OF THE FILE ------------------------------------
//
// A cut takes the line break in FRONT of the node it removes, which is what
// keeps the line the node stood on from being left behind as an empty one.
// There is no break in front of the first line of a file, so that case takes
// the one behind instead -- the rule `parsePage` already uses for an import it
// cuts. Every fixture above is wrapped in a layout, so nothing there stands on
// the file's first line and nothing there reaches it.

function fileStartCut() {
  // What is left is tab-indented, which the serializer would print with two
  // spaces -- so this can tell a splice from a reprint that happens to say the
  // same thing.
  const source = '<p>one</p>\n<section>\n\t<div>two</div>\n</section>\n';
  const parsed = parsePage(source);
  if (!check('a page with no frontmatter and no wrapper parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  model.nodes.splice(0, 1);
  const after = anchoredSerialize(source, model);
  check(
    'removing the node on the first line leaves what follows byte for byte',
    after === '<section>\n\t<div>two</div>\n</section>\n',
    short({ after })
  );
}

// --- THE SPACES AFTER THE NODE, WHICH ARE ON ITS LINE TOO -------------------
//
// `cutNodeSplice` takes the line break in front of the node and the run of
// spaces or tabs BEHIND it, up to the break. Every fixture above is written
// with no trailing whitespace anywhere, so the second half of that was
// deletable with the suite green -- and an editor that leaves a space at the
// end of a line is the ordinary case, not the odd one. Left behind, those bytes
// land on the parent's own line (`<Base>  `), which is a change to a line the
// call never named.

function trailingSpacesOnTheLineItLeaves() {
  const source = commentedPage("  <p class='a'>one</p>  \n  <p class='b'>two</p>\n");
  const parsed = parsePage(source);
  if (!check('a page with a trailing space after a node parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const gone = root.children.find((n) => n.props?.class?.value === 'a');
  if (!check('  and the node with the trailing space is reachable', !!gone, short(root.children?.map((n) => n.name)))) return;
  root.children = root.children.filter((n) => n !== gone);
  const after = anchoredSerialize(source, model);
  if (!check('removing it removes it', !/class='a'/.test(after), short(changedSpan(source, after)))) return;
  check(
    '  and the spaces that were on its line go with it, rather than onto its parent',
    after === commentedPage("  <p class='b'>two</p>\n"),
    short({ span: changedSpan(commentedPage("  <p class='b'>two</p>\n"), after) })
  );
}

// --- WHITESPACE THE BROWSER RENDERS ------------------------------------------
//
// Inside a <pre> or a <textarea> the leading spaces on each line are content,
// and inside a <script> or a <style> they can be the inside of a template
// literal. Nothing else in this suite can see them: `parsePage` collapses the
// run into value:'alpha beta gamma' and keeps the real bytes in `source`, which
// is an as-written field the write path's readback gate skips -- so a
// cross-level move deleted two spaces the page shows and every tree comparison
// agreed the file still meant the same thing.
//
// THE ORACLE IS THE WHOLE FILE, not the bytes between the tags, and that is the
// whole point of the frontmatter below. The writer defends this in two places
// -- `printNode` refuses to shift a block holding one of these, and
// `anchoredSerialize` reads the rendered runs back off both texts -- and taking
// EITHER of them out leaves the content intact, because the refusal that
// follows falls back to reprinting the document and a reprint keeps a <pre>
// perfectly well. An earlier version of this asked only about the bytes between
// the tags plus the untouched <footer>'s quotes, and a reprint satisfies both:
// both mechanisms were deletable with this green. What a reprint does NOT
// survive is a frontmatter comment sitting on the import it annotates, which is
// the defect the whole suite was written for -- so the page carries two, and
// the verdict is the file, byte for byte.

/** The two-import frontmatter whose comments a reprint moves, and a body. */
const commentedPage = (body) =>
  `---\n// Layout import - the shell every page shares\nimport Base from '../layouts/Base.astro';\n` +
  `// Component imports\nimport Card from '../components/Card.astro';\n---\n<Base>\n${body}</Base>\n`;

// The four tags whose inner whitespace is content, and a body for each that
// shows it: two leading spaces on the second line, in a page indented in two
// spaces, so a shift out of one level slices exactly that prefix off.
const RENDERED_SPACE_BODIES = {
  pre: 'alpha\n  beta\ngamma',
  textarea: 'alpha\n  beta\ngamma',
  script: '\nconst t = `alpha\n  beta\ngamma`;\n',
  style: '\n.a {\n  color: red;\n}\n',
};

function whitespaceThePageRenders() {
  for (const [tag, body] of Object.entries(RENDERED_SPACE_BODIES)) {
    const inner =
      `  <div class='wrap'>\n    <${tag}>${body}</${tag}>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n`;
    const source = commentedPage(inner);
    const parsed = parsePage(source);
    if (!check(`a page with a <${tag}> parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const root = model.nodes[0];
    const div = root.children.find((n) => n.name === 'div');
    const node = div?.children?.find((n) => n.name === tag);
    if (!check(`  and the <${tag}> is where a move can reach it`, !!node, short(div?.children?.map((n) => n.name)))) continue;
    div.children = div.children.filter((n) => n !== node);
    root.children.splice(root.children.indexOf(div) + 1, 0, node);
    const after = anchoredSerialize(source, model);
    // POSITIVE CONTROL: it really left the <div>, so nothing below can be
    // satisfied by a write that did nothing at all.
    if (
      !check(
        `moving a <${tag}> out of its <div> moves it`,
        /<div[^>]*><\/div>/.test(after),
        short(changedSpan(source, after))
      )
    ) {
      continue;
    }
    const want = commentedPage(
      `  <div class='wrap'></div>\n  <${tag}>${body}</${tag}>\n  <footer class='end'>end</footer>\n`
    );
    check(
      `  and the file is the file it was, with the <${tag}> at the body's indent and NOTHING else moved`,
      after === want,
      short({ span: changedSpan(want, after) })
    );
    // Said again as the property it is defending, so a failure above names
    // which half went: the bytes the page shows, and the comment a reprint
    // would hoist off its import.
    const held = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(after);
    check(
      `  and every space the browser renders inside it is still there`,
      !!held && held[1] === body,
      short({ want: body, got: held ? held[1] : null })
    );
    check(
      `  and the page was spliced to do it, not reprinted`,
      /\/\/ Component imports\nimport Card/.test(after),
      short({ span: changedSpan(source, after) })
    );
  }
}

// --- THE TWIN THAT MEANS THE SAME AND IS NOT THE SAME BYTES ------------------
//
// `twinFinder` answers "the base node whose bytes ARE this node's" with the
// FIRST node in the file that `sameMeaning` accepts -- and `sameMeaning`
// deliberately skips the as-written caches, so two <pre> blocks whose collapsed
// value is the same string mean the same thing while their bytes do not.
// Moving the second one copies the first one's bytes, and the page loses a line
// break and two spaces it renders.
//
// This is the producer for `anchoredSerialize`'s rendered-whitespace readback,
// which was otherwise unreachable: with `printNode`'s refusal in place the twin
// copy never damages a run, so the gate was reached 4 times in this suite and
// fired 0, and deleting it changed nothing anyone could measure. Here it fires,
// the write falls back, and the file the author gets is the one they wrote.

// TWO SIBLINGS THAT MEAN THE SAME AND ARE NOT WRITTEN THE SAME.
//
// `theTwinThatIsNotTheSameBytes` below is the `<pre>` version of this, and it
// passes for a reason that does not generalise: the damage it produces is
// whitespace a browser renders, so `anchoredSerialize`'s readback sees it, the
// splice is refused and the write falls back to reprinting the document. The
// author gets the right file by way of a fallback rather than by the twin being
// right.
//
// Take the rendered whitespace away and nothing is left to notice. Two `<img>`
// tags with identical attributes — one written on a line, one with its attribute
// block hand-wrapped over four — are one meaning and two spellings. `sameMeaning`
// skips `attrSource`, so the trees agree; none of those bytes is whitespace a
// browser renders, so the readback agrees too. Measured at ac57c20, moving the
// WRAPPED one produced the FLAT one's bytes at the new location: somebody's
// hand-formatted markup silently reformatted by an operation that was asked to
// move it, `ok: true`, nine suites green.
//
// `twinFinder` now breaks the tie by asking the question `sameMeaning` refuses
// to — among the nodes that mean the same, which one also READS the same — so
// the bytes that travel are the bytes of the node that was moved.
function theTwinWhoseBytesAreItsOwn() {
  const source = commentedPage(
    `  <div class='wrap'>\n    <img src="a.png" alt="Logo">\n    <img\n      src="a.png"\n      alt="Logo"\n    >\n  </div>\n` +
      `  <footer class='end'>end</footer>\n`
  );
  const parsed = parsePage(source);
  if (!check('a page with two identical <img> tags spelled differently parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const div = root.children.find((n) => n.name === 'div');
  const imgs = (div?.children || []).filter((n) => n.name === 'img');
  if (!check('  and both are where a move can reach them', imgs.length === 2, short(div?.children?.map((n) => n.name)))) return;
  // THE PREMISE, asserted rather than assumed: same meaning, different spelling.
  // If the parser ever stops recording the layout, this stops being the fixture
  // and says so here rather than passing for the wrong reason.
  if (
    !check(
      '  and only the second one carries a hand-wrapped attribute block',
      imgs[0].attrSource === undefined && typeof imgs[1].attrSource === 'string' && imgs[1].attrSource.includes('\n'),
      short({ a: imgs[0].attrSource, b: imgs[1].attrSource })
    )
  ) {
    return;
  }
  if (
    !check(
      '  and nothing here is whitespace a browser renders',
      !/<(pre|textarea|script|style)[\s>]/i.test(source),
      'the point of this fixture is that the readback cannot see the damage'
    )
  ) {
    return;
  }

  div.children = div.children.filter((n) => n !== imgs[1]);
  root.children.splice(root.children.indexOf(div) + 1, 0, imgs[1]);
  const after = anchoredSerialize(source, model);

  const moved = /<\/div>\s*\n([\s\S]*?)\n  <footer/.exec(after);
  check(
    'the <img> that moved keeps ITS bytes, not the bytes of the one that means the same',
    !!moved && /\n\s+src="a\.png"/.test(moved[1]) && /\n\s+alt="Logo"/.test(moved[1]),
    short({ got: moved ? moved[1] : null, span: changedSpan(source, after) })
  );
  check(
    '  and it is still one <img>, not two',
    (after.match(/<img/g) || []).length === 2,
    short((after.match(/<img[^>]*>/g) || []).join(' | '))
  );
  check(
    '  and the one that stayed is still inside the div',
    /<div class='wrap'>[\s\S]*?<img[\s\S]*?<\/div>/.test(after),
    short(changedSpan(source, after))
  );
  check(
    '  and the footer nobody touched is untouched',
    after.includes(`  <footer class='end'>end</footer>`),
    short(changedSpan(source, after))
  );
}

function theTwinThatIsNotTheSameBytes() {
  const source = commentedPage(
    `  <div class='wrap'>\n    <pre>alpha beta</pre>\n    <pre>alpha\n  beta</pre>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n`
  );
  const parsed = parsePage(source);
  if (!check('a page with two <pre> blocks that collapse to the same words parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const div = root.children.find((n) => n.name === 'div');
  const pres = (div?.children || []).filter((n) => n.name === 'pre');
  if (!check('  and both are where a move can reach them', pres.length === 2, short(div?.children?.map((n) => n.name)))) return;
  // The two nodes are the same MEANING -- that is the premise, and if the
  // parser ever stops collapsing them this fixture stops being the fixture.
  if (
    !check(
      '  and the second one holds bytes the first one does not',
      pres[0].children?.[0]?.value === pres[1].children?.[0]?.value &&
        pres[1].children?.[0]?.source === 'alpha\n  beta',
      short({ a: pres[0].children?.[0], b: pres[1].children?.[0] })
    )
  ) {
    return;
  }
  div.children = div.children.filter((n) => n !== pres[1]);
  root.children.splice(root.children.indexOf(div) + 1, 0, pres[1]);
  const after = anchoredSerialize(source, model);
  if (
    !check(
      'moving the second <pre> out of its <div> moves it',
      /<pre>alpha beta<\/pre>\n  <\/div>/.test(after),
      short(changedSpan(source, after))
    )
  ) {
    return;
  }
  const held = /<pre>([\s\S]*?)<\/pre>[\s\S]*<pre>([\s\S]*?)<\/pre>/.exec(after);
  check(
    '  and the one that moved keeps ITS bytes, not the bytes of the one that means the same',
    !!held && held[2] === 'alpha\n  beta',
    short({ want: 'alpha\n  beta', got: held ? held[2] : null, span: changedSpan(source, after) })
  );
  check(
    '  and the one that stayed is untouched',
    !!held && held[1] === 'alpha beta',
    short({ got: held ? held[1] : null })
  );
}

// --- A TEXT NODE'S SPAN IS NOT ITS WORDS -------------------------------------
//
// The span starts where the previous node ended, so it carries the line break
// and the indent between them, and `serializeNode` strips a text run's boundary
// spaces on the assumption that those breaks already ARE that whitespace.
// Replacing the wide span with the narrow text deleted a space the page renders
// (`<label>Name: <input /></label>` came back as `<label>Name:<input />`), so
// `replaceNodeSplice` leaves the boundary bytes where they are and replaces
// only the words between them.
//
// Take that branch out and the fall-through refuses the text splice, which is
// SAFE -- the words are right and the space survives -- and costs the parent
// element a reprint. Every fixture above holds its text in an element the
// serializer spells exactly as the file does, so the reprint was invisible and
// the branch was deletable with nine parser suites green. The sibling here is
// the one shape whose reprint is not its source: a component and a word on one
// line. A three-word edit that re-spells the element beside it is the defect
// this whole suite exists to catch, and now it is a byte away.

function wordsWithoutTheBoundaryBytes() {
  const pill = `  <h4 class='pill-row'><Card title='Tiny' /> Developer</h4>\n`;
  const inner = `  <div class='wrap'>\n    intro words here\n${`  ${pill}`}  </div>\n  <footer class='end'>end</footer>\n`;
  const source = commentedPage(inner);
  const parsed = parsePage(source);
  if (!check('a page whose text sits beside a one-line component run parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const div = model.nodes[0].children.find((n) => n.name === 'div');
  const text = div?.children?.find((n) => n.kind === 'text');
  if (!check('  and the text node is where an edit can reach it', !!text, short(div?.children?.map((n) => n.kind)))) return;
  // What `target.set_text` hands the writer: a new value and no as-written
  // cache, because the cache describes bytes that no longer say this.
  text.value = text.value.replace('here', 'THERE');
  delete text.source;
  delete text.raw;
  const after = anchoredSerialize(source, model);
  if (
    !check(
      'setting the text really changes it',
      after.includes('intro words THERE'),
      short(changedSpan(source, after))
    )
  ) {
    return;
  }
  check(
    '  and the three words are the only bytes that moved',
    after === source.replace('intro words here', 'intro words THERE'),
    short({ span: changedSpan(source.replace('intro words here', 'intro words THERE'), after) })
  );
  check(
    '  so the <h4> beside it, which the call never named, is still on one line',
    after.includes(`<h4 class='pill-row'><Card title='Tiny' /> Developer</h4>`),
    short({ span: changedSpan(source, after) })
  );
}

// --- THE NESTING STEP, READ OFF THE TREE -------------------------------------
//
// `indentStepOf` exists so a graft never writes `\t  <Card` -- one tab and two
// spaces inside a single element. Reading it off the raw text brought that back
// from the other side: a scan of `body.split('\n')` cannot tell markup from the
// inside of a raw <script> or a hand-wrapped line, so one tab in a script won
// outright and an ordinary two-space page reprinted an element as `  \t<small>`.
// None of the four fixtures has a script, a pre or an odd-width line in it.

function stepFromTheTree() {
  // <footer> holds its <small> on ONE line, so an <img> joining it changes how
  // the whole element is written and the element is reprinted -- which is the
  // path that asks what a step is.
  const page = (extra) =>
    `---\nimport Base from '../layouts/Base.astro';\n---\n` +
    `<Base>\n  <footer><small>Made in 2026</small></footer>\n${extra}</Base>\n`;
  const cases = [
    { id: 'nothing unusual (the control)', extra: '' },
    { id: 'a tab inside a <script>', extra: "  <script>\n\tconsole.log('hi');\n  </script>\n" },
    { id: 'a tab inside a <style>', extra: '  <style>\n\t.a { color: red; }\n  </style>\n' },
    { id: 'a hand-wrapped one-space line', extra: '  <p>\n odd\n  </p>\n' },
  ];
  for (const c of cases) {
    const source = page(c.extra);
    const parsed = parsePage(source);
    if (!check(`a two-space page with ${c.id} parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const footer = model.nodes[0].children.find((n) => n.name === 'footer');
    if (!check(`  and it has its footer`, !!footer, short(model.nodes[0].children.map((n) => n.name)))) continue;
    footer.children.push({
      id: 'added',
      kind: 'element',
      name: 'img',
      props: { src: { type: 'string', value: '/x.png' }, alt: { type: 'string', value: 'x' } },
      children: null,
    });
    const after = anchoredSerialize(source, model);
    check(
      `appending to a reprinted element with ${c.id} uses the page's own step`,
      after.includes(`\n  <footer>\n    <small>Made in 2026</small>\n    ${IMG_TEXT}\n  </footer>\n`),
      short({ span: changedSpan(source, after) })
    );
    // And nowhere in the file did an indent become two kinds of whitespace.
    check(
      `  with no line indented in spaces and tabs at once`,
      !indentsIn(after).some((lead) => lead.includes(' ') && lead.includes('\t')),
      short(indentsIn(after))
    );
  }
}

// --- TABS AGAINST SPACES IS NOT A SHIFT --------------------------------------
//
// `reindentBlock` refuses when neither indentation is a prefix of the other,
// and the refusal sends the node through the serializer at the destination's
// indentation instead. Without it a tab-indented block grafted into a
// space-indented parent keeps its tabs and the file ends up with `  \ttitle=`
// -- mixed leading whitespace inside one element, which is the defect the
// whole indent machinery exists to prevent.

function tabsAgainstSpaces() {
  const source =
    `---\nimport Base from '../layouts/Base.astro';\n---\n<Base>\n` +
    `\t<div>\n\t\t<Card\n\t\t\ttitle='Wide'\n\t\t/>\n\t</div>\n` +
    `  <section>\n    <p>x</p>\n  </section>\n</Base>\n`;
  const parsed = parsePage(source);
  if (!check('a page written in tabs and spaces at once parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const div = root.children.find((n) => n.name === 'div');
  const section = root.children.find((n) => n.name === 'section');
  const card = div?.children?.find((n) => n.name === 'Card');
  if (!check('  and holds a tab-indented Card and a space-indented section', !!card && !!section, short({ card: !!card, section: !!section }))) return;
  div.children = div.children.filter((n) => n !== card);
  section.children.push(card);
  const after = anchoredSerialize(source, model);
  // The refusal's answer is the serializer's: the node printed fresh at the
  // destination's own indentation. Kept as bytes because "it landed somewhere"
  // is satisfied by the guess too -- shifted, the block arrives as
  // `    <Card` followed by `\t\t\ttitle='Wide'`, tabs inside a space-indented
  // element, and every indentation this suite knows how to look at is still
  // one character wide.
  //
  // The AUTHOR'S QUOTE survives the reprint. Giving up a layout that cannot be
  // shifted is not licence to rewrite the attribute as well: `title="Wide"`
  // here was a second change to a line the move never named, and it is the
  // same change a `move` used to make to the destination parent it landed in
  // and to the source parent it left.
  const want =
    `---\nimport Base from '../layouts/Base.astro';\n---\n<Base>\n` +
    `\t<div>\n\t</div>\n` +
    `  <section>\n    <p>x</p>\n    <Card title='Wide' />\n  </section>\n</Base>\n`;
  check('a tab-indented block moved into a space-indented parent is reprinted, not guessed at', after === want, short({ span: changedSpan(want, after) }));
  const inSection = after.slice(after.indexOf('<section>'), after.indexOf('</section>'));
  check(
    '  with no line inside that parent indented with a tab',
    !/\n[ \t]*\t/.test(inSection),
    short(inSection)
  );
}

// --- A COMMENT THAT SITS ON AN IMPORT ----------------------------------------
//
// The four fixtures put their comments on their own lines above the import
// they annotate, and that shape is measured end to end above. A comment AFTER
// the semicolon is the same annotation written the other ordinary way, and
// cutting the statement out from under it left it behind on a line of its own,
// with a stray leading space, now reading as an annotation on whichever import
// moved up into its place.

function trailingImportComment() {
  const source =
    `---\nimport Base from '../layouts/Base.astro';\n` +
    `import Hero from '../components/Hero.astro'; // above the fold\n` +
    `import Card from '../components/Card.astro';\n---\n` +
    `<Base>\n\t<Hero title='a' />\n\t<Card title='b' />\n</Base>\n`;
  const parsed = parsePage(source);
  if (!check('a page with a comment after an import parses', parsed.editable === true, short(parsed.reason))) return;
  // THE CONTROL: reading and writing it back unchanged does not move the
  // comment either. A serializer that hoists it to the bottom of the block
  // would make the removal below look right for the wrong reason.
  check(
    'writing the page back unchanged leaves the comment on its import',
    anchoredSerialize(source, structuredClone(parsed.model)) === source,
    short(changedSpan(source, anchoredSerialize(source, structuredClone(parsed.model))))
  );

  const model = structuredClone(parsed.model);
  const hero = model.nodes[0].children.find((n) => n.name === 'Hero');
  model.nodes[0].children = model.nodes[0].children.filter((n) => n !== hero);
  model.imports = model.imports.filter((i) => i.name !== 'Hero');
  const after = anchoredSerialize(source, model);
  const want =
    `---\nimport Base from '../layouts/Base.astro';\n` +
    `import Card from '../components/Card.astro';\n---\n` +
    `<Base>\n\t<Card title='b' />\n</Base>\n`;
  check(
    'removing the component takes its import AND the comment on it, and nothing else',
    after === want,
    short({ span: changedSpan(want, after) })
  );

  // A statement is not a line. Another statement after the semicolon is code
  // that has to keep working, so the splice steps aside rather than guessing
  // where the line divides -- and the frontmatter is rebuilt, which is allowed
  // to move things, but the import must not be left half-cut.
  const shared = source.replace(
    `import Hero from '../components/Hero.astro'; // above the fold\n`,
    `import Hero from '../components/Hero.astro'; const n = 1;\n`
  );
  const p2 = parsePage(shared);
  if (!check('a page with two statements on one import line parses', p2.editable === true, short(p2.reason))) return;
  const m2 = structuredClone(p2.model);
  const hero2 = m2.nodes[0].children.find((n) => n.name === 'Hero');
  m2.nodes[0].children = m2.nodes[0].children.filter((n) => n !== hero2);
  m2.imports = m2.imports.filter((i) => i.name !== 'Hero');
  const after2 = anchoredSerialize(shared, m2);
  check(
    'the statement sharing the line survives the import being pruned',
    after2.includes('const n = 1;') && !after2.includes("import Hero from"),
    short({ span: changedSpan(shared, after2) })
  );
}

// --- OUT AND BACK IS THE FILE THAT WAS THERE ---------------------------------
//
// `move` is the one operation whose bytes genuinely travel, and every check
// above measures one move against the file it started from. That misses what a
// move does to the two elements it is not aimed at. A ROUND TRIP CANNOT: carry
// a node out of one parent and back into it, and the only right answer is the
// file, to the byte.
//
// Measured through an MCP host against a packaged build, on a CRLF page indented
// with tabs and quoted with `'`, moving a `<pre id='keepme'>` into a `<footer>`
// and back: bytes 637 -> 630, CRLF 25 -> 23, TAB 13 -> 10, `'` 18 -> 14, `"` 0
// -> 4. Total size barely moved -- a size check would have called that clean.
// Counting the QUOTE CHARACTERS is what exposed it, so they are counted here.
//
// Three separate wrongs, none of them named by the call:
//   * the moved node came back re-quoted, `id='keepme'` as `id="keepme"`;
//   * the DESTINATION parent was re-quoted, and it was never the target;
//   * the SOURCE parent collapsed from three lines to one, its remaining
//     `<span>` reflowed onto the footer's own line -- and moving the <pre> back
//     could not put them apart again, so the loss was permanent.
//
// The <pre> is deliberate on top of that: its leading spaces are content, so
// this also asks whether the bytes a browser renders survive a return trip.

function moveRoundTrip() {
  const eol = '\r\n';
  const body = `  two leading spaces${eol}    four leading spaces${eol}\tone leading tab`;
  const source = [
    '---',
    "import Base from '../layouts/Base.astro';",
    '---',
    '<Base>',
    `\t<section class='fidelity-body'>`,
    `\t\t<pre id='keepme'>${body}</pre>`,
    '\t</section>',
    `\t<footer class='fidelity-foot'>`,
    '\t\t<span>destination</span>',
    '\t</footer>',
    '</Base>',
    '',
  ].join(eol);
  const census = (t) => ({
    bytes: Buffer.byteLength(t),
    crlf: (t.match(/\r\n/g) || []).length,
    tab: (t.match(/\t/g) || []).length,
    single: (t.match(/'/g) || []).length,
    double: (t.match(/"/g) || []).length,
  });

  const parsed = parsePage(source);
  if (!check('the CRLF/tab/single-quote page parses', parsed.editable === true, short(parsed.reason))) return;

  // Out: the <pre> leaves the <section> and joins the <footer>.
  const out = structuredClone(parsed.model);
  {
    const root = out.nodes[0];
    const section = root.children.find((n) => n.name === 'section');
    const footer = root.children.find((n) => n.name === 'footer');
    const pre = section?.children?.find((n) => n.name === 'pre');
    if (!check('  and holds a <pre>, a <section> and a <footer>', !!pre && !!footer, short({ pre: !!pre, footer: !!footer }))) return;
    section.children = section.children.filter((n) => n !== pre);
    footer.children.push(pre);
  }
  const moved = anchoredSerialize(source, out);

  // POSITIVE CONTROL: it really left. Without this every check below is
  // satisfied by a write that did nothing at all -- which is the one way a
  // round trip is trivially byte-identical.
  if (
    !check(
      'the <pre> really moves into the <footer>',
      /<section[^>]*>\r\n\t<\/section>/.test(moved) && /<footer[^>]*>[\s\S]*<pre/.test(moved),
      short(changedSpan(source, moved))
    )
  ) {
    return;
  }
  // The destination parent was never named by this call, and neither was the
  // node's own spelling.
  check(
    "  and neither it nor the parent it lands in is re-quoted",
    moved.includes(`<pre id='keepme'>`) && moved.includes(`<footer class='fidelity-foot'>`),
    short({ census: census(moved), span: changedSpan(source, moved) })
  );

  const there = parsePage(moved);
  if (!check('  and the moved file parses', there.editable === true, short(there.reason))) return;

  // Back: the same node returns to the <section> it came from.
  const home = structuredClone(there.model);
  {
    const root = home.nodes[0];
    const section = root.children.find((n) => n.name === 'section');
    const footer = root.children.find((n) => n.name === 'footer');
    const pre = footer?.children?.find((n) => n.name === 'pre');
    if (!check('  and the <pre> is in the <footer> to be moved back', !!pre, short(footer?.children?.map((n) => n.name)))) return;
    footer.children = footer.children.filter((n) => n !== pre);
    section.children.push(pre);
  }
  const back = anchoredSerialize(moved, home);

  check(
    'a move out and back leaves the file it started as, byte for byte',
    back === source,
    short({ before: census(source), after: census(back), span: changedSpan(source, back) })
  );
  // The census the dogfood took, said as five numbers, because byte equality
  // is the strongest verdict and the least readable one.
  const a = census(source);
  const z = census(back);
  check(
    '  with every CRLF, tab and quote character accounted for',
    z.bytes === a.bytes && z.crlf === a.crlf && z.tab === a.tab && z.single === a.single && z.double === a.double,
    short({ before: a, after: z })
  );
  // And the spaces the browser shows inside the <pre>, which no tree comparison
  // can see: `parsePage` collapses them into `value` and parks the bytes in an
  // as-written field.
  const held = /<pre\b[^>]*>([\s\S]*?)<\/pre>/.exec(back);
  check(
    '  and the <pre> holds the same leading spaces it started with',
    !!held && held[1] === body,
    short({ want: body, got: held ? held[1] : null })
  );
}

// --- TWO SPLICES THAT WOULD CLOBBER EACH OTHER -------------------------------
//
// `applySplices` writes back to front and refuses a list whose spans overlap,
// because the second write would be reading bytes the first one has already
// replaced. No producer in the writer can hand it one today -- the aligned
// runs are disjoint, an opening tag's spans sit outside its children's, and an
// import cut is in the frontmatter -- so the guard is driven here directly
// rather than left to a fixture that cannot reach it.

function overlappingSplices() {
  const source = '<p>one</p>\n<p>two</p>\n';
  check(
    'two splices that do not overlap are applied back to front',
    applySplices(source, [
      { start: 1, end: 2, text: 'b' },
      { start: 12, end: 13, text: 'b' },
    ]) === '<b>one</p>\n<b>two</p>\n',
    short(applySplices(source, [{ start: 1, end: 2, text: 'b' }, { start: 12, end: 13, text: 'b' }]))
  );
  check(
    '  and two that DO overlap are refused, all of them, rather than half-applied',
    applySplices(source, [
      { start: 0, end: 10, text: 'X' },
      { start: 5, end: 15, text: 'Y' },
    ]) === null,
    short(applySplices(source, [{ start: 0, end: 10, text: 'X' }, { start: 5, end: 15, text: 'Y' }]))
  );
  check(
    '  and so is a span reaching past the end of the file',
    applySplices(source, [{ start: 0, end: source.length + 1, text: 'X' }]) === null,
    short(applySplices(source, [{ start: 0, end: source.length + 1, text: 'X' }]))
  );
}

// --- WHITESPACE THE PAGE RENDERS BECAUSE OF CSS ------------------------------
//
// A structural move is allowed to change a file's layout and is not allowed to
// change what the page shows. `reindentBlock` slices the same prefix off every
// line in the block that travels, and whether those leading spaces are layout
// or content is a question about CSS -- which `whitespaceThePageRenders` above
// asks only of the four tags where the answer is always "content".
//
// Everything below is one of the four ways the answer can be "content" without
// one of those tags being anywhere near it. All four were measured at this
// suite's own head, and the first two are silent data loss rather than a
// missing feature:
//
//   * the declaration is in a STYLESHEET. `.preserved { white-space: pre }` is
//     invisible to a parser with no cascade, and an authored
//     `alpha\n      beta\ngamma` came back `alpha\n    beta\ngamma`, ok:true.
//     In Blink that line went from 96.33px to 77.06px -- two monospace glyphs
//     deleted from what the page shows.
//   * `white-space` INHERITS. A node whose ANCESTOR declares it renders its own
//     leading spaces while saying nothing about them, and the guard only looked
//     DOWN. Damage runs both ways: spaces sliced off a block moved within such
//     an ancestor, and spaces INSERTED in front of every line of a block moved
//     into one.
//   * a `<pre>` holding ELEMENT children was re-laid-out as an inline run, and
//     the whole block collapsed to a single line. Nothing could save it: the
//     reprint the fallback would produce collapses it identically.
//   * and the value table, which is what keeps all of this a NARROWING.
//     Measured in Blink: `pre`, `pre-wrap` and `break-spaces` render
//     differently after a reindent; `pre-line`, `normal` and `nowrap` do not.
//     An ordinary block still has to be raised -- that is the property the
//     fixtures at the top of this file are about -- so every fixture here
//     carries its own positive control.

const WS = require('../electron/whitespaceRules.js');

/** The two blocks that are the same bytes, one of which a stylesheet protects. */
function preservedFixture({ ind, eol }) {
  const i = (n) => ind.repeat(n);
  // A middle line indented one step DEEPER than the element itself, so a raise
  // of one level slices a whole unit off it and the loss is a whole unit wide.
  const innerLines = ['alpha', `${i(3)}beta`, 'gamma'];
  const inner = innerLines.join(eol);
  const body =
    `${i(1)}<div class='outer'>${eol}` +
    `${i(2)}<div class='wrap'>${eol}` +
    `${i(3)}<div class='preserved'>${inner}</div>${eol}` +
    `${i(3)}<div class='ordinary'>${inner}</div>${eol}` +
    `${i(2)}</div>${eol}` +
    `${i(1)}</div>${eol}`;
  const source =
    `---${eol}// Layout import - the shell every page shares${eol}` +
    `import Base from '../layouts/Base.astro';${eol}` +
    `// Component imports${eol}import Card from '../components/Card.astro';${eol}---${eol}` +
    `<Base>${eol}${body}</Base>${eol}`;
  // What a raise of one nesting level does to those bytes: `reindentBlock`
  // drops one indentation unit off every line that starts with one.
  const raised = innerLines
    .map((line, n) => (n === 0 || !line.startsWith(ind) ? line : line.slice(ind.length)))
    .join(eol);
  // AND THE WHOLE FILE AFTER THAT MOVE WHEN THE BLOCK'S BYTES ARE HELD, spelled
  // out rather than asked about one substring at a time. `innerOf` looks only
  // between one element's tags, so it cannot see what the splice did to the
  // markup AROUND it -- which is where the damage was: an unparseable
  // stylesheet made the parser mark every node preserving, and every splice
  // then wrote its surrounding layout at COLUMN ZERO. The `<h2>`-equivalents
  // here are the `</div>` lines and the moved element's own line, and this is
  // the only oracle that looks at them.
  const kept = source.replace(
    body,
    `${i(1)}<div class='outer'>${eol}` +
      `${i(2)}<div class='wrap'>${eol}` +
      `${i(3)}<div class='preserved'>${inner}</div>${eol}` +
      `${i(2)}</div>${eol}` +
      `${i(2)}<div class='ordinary'>${inner}</div>${eol}` +
      `${i(1)}</div>${eol}`
  );
  return { source, inner, raised, kept };
}

const innerOf = (text, cls) => {
  const hit = new RegExp(`<div class='${cls}'>([\\s\\S]*?)</div>`).exec(text);
  return hit ? hit[1] : null;
};

/**
 * Move the named block up one nesting level, through the whole product.
 *
 * The move is `target.move` on the real Agent API against a real project on
 * disk, because the thing being tested is a question about that project's CSS
 * and nothing shorter than the product can ask it.
 */
async function raiseThroughTheApp(app, cls) {
  const run = (d, a, args = {}) => app.api.run(d, a, args);
  const page = (await run('target', 'read')).target;
  const outer = (page?.children || []).find((c) => c.tag === 'div');
  if (!outer?.ref) return { ok: false, why: 'no <div class=outer>' };
  const outerRead = (await run('target', 'read', { ref: outer.ref })).target;
  const wrap = (outerRead?.children || []).find((c) => c.tag === 'div');
  if (!wrap?.ref) return { ok: false, why: 'no <div class=wrap>' };
  const wrapRead = (await run('target', 'read', { ref: wrap.ref })).target;
  const kids = wrapRead?.children || [];
  const which = cls === 'preserved' ? 0 : 1;
  if (!kids[which]?.ref) return { ok: false, why: `no child ${which}` };
  return run('target', 'move', { ref: kids[which].ref, to: { parentRef: outerRead.ref, index: 1 } });
}

/**
 * The same raise with nothing mounted, for the failure modes that stop a
 * project being opened at all.
 *
 * The construction is the one T7 (`theSameBytesWithNoWindow`) proves writes the
 * same bytes as the move through the running app, so a byte oracle applied to
 * this is a byte oracle applied to the product.
 */
function raiseHeadless(source, cls, tokens) {
  const parsed = parsePage(source);
  if (!parsed.editable) return null;
  const model = structuredClone(parsed.model);
  const outer = model.nodes[0].children.find((n) => n.name === 'div');
  const wrap = outer?.children?.find((n) => n.name === 'div');
  const kids = (wrap?.children || []).filter((n) => n.name === 'div');
  const moved = kids[cls === 'preserved' ? 0 : 1];
  if (!moved) return null;
  wrap.children = wrap.children.filter((n) => n !== moved);
  outer.children.splice(1, 0, moved);
  return anchoredSerialize(source, model, { preservingTokens: tokens });
}

/**
 * T1 -- the documented residual, end to end, with the CSS on disk.
 *
 * PREMISES FIRST, so this cannot pass for the wrong reason: the rule really is
 * in a file, opening the project really did not rewrite the page, the move
 * really was accepted, and the file really did change. Only then the verdict.
 */
const RULE_IN = {
  // A plain rule in a plain stylesheet -- the shape the residual named.
  stylesheet: (files) => {
    files['src/styles/site.css'] = `${H.FIXTURE['src/styles/site.css']}\n.preserved { white-space: pre; }\n`;
    return ['src/styles/site.css', '.preserved { white-space: pre; }'];
  },
  // The same rule with an at-rule in front of it. Whether the media query
  // matches is a question about a viewport, and this scan is not allowed to
  // depend on one -- the rule is there, so the element could have it.
  media: (files) => {
    files['src/styles/site.css'] =
      `${H.FIXTURE['src/styles/site.css']}\n@media screen and (min-width: 1px) {\n  .preserved { white-space: pre; }\n}\n`;
    return ['src/styles/site.css', '@media screen and (min-width: 1px)'];
  },
  // AND A `<style>` BLOCK, which is not a stylesheet at all. `findStylesheets`
  // walks `.css` files; a rule an author wrote in the layout that wraps every
  // page is invisible to it, and was measured missing along with the rest.
  'style-block': (files) => {
    files['src/layouts/Base.astro'] = `${H.FIXTURE['src/layouts/Base.astro']}<style>\n.preserved { white-space: pre; }\n</style>\n`;
    return ['src/layouts/Base.astro', '<style>'];
  },
};

async function stylesheetPreservedWhitespace(shape, where = 'stylesheet') {
  const label = `[css ${shape.id}/${where}]`;
  const { source, inner, raised } = preservedFixture(shape);
  const files = { [PAGE]: source };
  const [ruleFile, ruleText] = RULE_IN[where](files);
  const root = H.makeProject(files);
  const app = await H.start(root, { agentMode: 'full' });
  await H.settle(400);
  try {
    if (
      !check(
        `${label} the rule is in a file on disk`,
        app.exists(ruleFile) && app.read(ruleFile).includes(ruleText) && app.read(ruleFile).includes('white-space: pre'),
        short(app.read(ruleFile).slice(-80))
      ) ||
      !check(`${label} opening the project does not rewrite the page`, app.read(PAGE) === source, short(changedSpan(source, app.read(PAGE)))) ||
      !check(`${label} the fixture's two blocks start as the same bytes`, innerOf(source, 'preserved') === inner && innerOf(source, 'ordinary') === inner, short({ inner }))
    ) {
      return;
    }
    const baselineSha = sha(source);

    // --- THE ONE THE STYLESHEET PROTECTS.
    const answer = await raiseThroughTheApp(app, 'preserved');
    const after = app.read(PAGE);
    if (
      !check(`${label} the move is accepted`, answer?.ok === true, short(answer)) ||
      !check(`${label} the file changed`, sha(after) !== baselineSha, tag(after))
    ) {
      return;
    }
    check(
      `${label} the block a stylesheet preserves keeps its authored bytes`,
      innerOf(after, 'preserved') === inner,
      short({ want: inner, got: innerOf(after, 'preserved'), span: changedSpan(source, after) })
    );
    // POSITIVE CONTROL, in the same file and the same move: the block NO rule
    // names is still reindented. Without this a fix that refuses every reindent
    // passes.
    check(
      `${label}   and the block no rule names is untouched by that move`,
      innerOf(after, 'ordinary') === inner,
      short({ got: innerOf(after, 'ordinary') })
    );
    check(
      `${label}   and the file's own indentation unit is still the only one in it`,
      indentsIn(after).every((lead) => lead.split(shape.ind).every((part) => part === '')),
      short({ unit: shape.ind, found: indentsIn(after) })
    );

    await app.api.run('project', 'undo', {});
    if (!check(`${label} undo puts the baseline back`, sha(app.read(PAGE)) === baselineSha, tag(app.read(PAGE)))) return;

    // --- THE POSITIVE CONTROL AS ITS OWN MOVE: the ordinary block RAISES.
    const control = await raiseThroughTheApp(app, 'ordinary');
    const afterControl = app.read(PAGE);
    if (
      !check(`${label} the control move is accepted`, control?.ok === true, short(control)) ||
      !check(`${label} the control move changes the file`, sha(afterControl) !== baselineSha, tag(afterControl))
    ) {
      return;
    }
    check(
      `${label} the ordinary block IS raised -- the fix is a narrowing, not a switch-off`,
      innerOf(afterControl, 'ordinary') === raised && raised !== inner,
      short({ want: raised, got: innerOf(afterControl, 'ordinary') })
    );
    check(
      `${label}   and the preserved block, which did not move, still holds its bytes`,
      innerOf(afterControl, 'preserved') === inner,
      short({ got: innerOf(afterControl, 'preserved') })
    );
    check(
      `${label}   and the file's own indentation unit is still the only one in it`,
      indentsIn(afterControl).every((lead) => lead.split(shape.ind).every((part) => part === '')),
      short({ unit: shape.ind, found: indentsIn(afterControl) })
    );
  } finally {
    app.stop();
    H.removeProject(root);
  }
}

/**
 * T5 -- the scanner's negative control.
 *
 * `nowrap` and `pre-line` are declarations about whitespace that a browser
 * measurably does NOT render differently after a reindent. A scanner that keys
 * on the PROPERTY rather than on its VALUE would disable reindentation for the
 * whole project on one of them, which is the switch-off this must not become.
 */
async function neutralRulesChangeNothing(value) {
  const label = `[css ${value}]`;
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source, inner, raised } = preservedFixture(shape);
  const css = `${H.FIXTURE['src/styles/site.css']}\n.preserved { white-space: ${value}; }\n`;
  const root = H.makeProject({ [PAGE]: source, 'src/styles/site.css': css });
  const app = await H.start(root, { agentMode: 'full' });
  await H.settle(400);
  try {
    if (!check(`${label} opening the project does not rewrite the page`, app.read(PAGE) === source, short(changedSpan(source, app.read(PAGE))))) return;
    const answer = await raiseThroughTheApp(app, 'preserved');
    const after = app.read(PAGE);
    if (
      !check(`${label} the move is accepted`, answer?.ok === true, short(answer)) ||
      !check(`${label} the file changed`, sha(after) !== sha(source), tag(after))
    ) {
      return;
    }
    check(
      `${label} a rule that does not change the rendering does not stop the reindent`,
      innerOf(after, 'preserved') === raised && raised !== inner,
      short({ want: raised, got: innerOf(after, 'preserved') })
    );
  } finally {
    app.stop();
    H.removeProject(root);
  }
}

/**
 * T6 -- every failure resolves to keeping the bytes, AND TO NOTHING ELSE.
 *
 * A stylesheet postcss will not parse, one the process cannot read, and one
 * inside a DIRECTORY the process cannot list. None of the three is a stylesheet
 * with no rules in it, and answering "no tokens" for any of them is how a
 * permissions error would quietly re-enable a reindent that deletes rendered
 * spaces. The write still has to SUCCEED -- a broken stylesheet is not a reason
 * to refuse an edit -- and the bytes still have to be there.
 *
 * AND THE SURROUNDING MARKUP HAS TO BE UNTOUCHED, which is the half this used
 * to miss. Its only byte assertion was `innerOf`, which reads between one
 * element's tags; the failure sentinel was also being read as "every element
 * renders its own whitespace", so every splice wrote the layout AROUND it at
 * column zero and this stayed green while unrelated markup was de-indented on
 * every save. The oracle is now the whole file.
 */
async function aStylesheetThatCannotBeReadOrParsed(kind) {
  const label = `[css ${kind}]`;
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source, inner, kept } = preservedFixture(shape);
  const root = H.makeProject({ [PAGE]: source });
  // Its own directory, so the one the app's own style panel reads stays
  // readable and this stays a test of the whitespace scan rather than of
  // everything that walks a project.
  const brokenDir = path.join(root, 'src', 'vendor');
  fs.mkdirSync(brokenDir, { recursive: true });
  const broken = path.join(brokenDir, 'broken.css');
  if (kind === 'unparseable') fs.writeFileSync(broken, '.preserved { white-space: pre\n@media {\n', 'utf8');
  else {
    fs.writeFileSync(broken, '.preserved { white-space: pre; }\n', 'utf8');
    fs.chmodSync(broken, 0o000);
  }
  const app = await H.start(root, { agentMode: 'full' });
  await H.settle(400);
  try {
    // THE PREMISE: the thing really is unusable. A test whose broken input is
    // quietly fine is a test of nothing.
    if (kind === 'unparseable') {
      let threw = false;
      try {
        require('postcss').parse(fs.readFileSync(broken, 'utf8'));
      } catch {
        threw = true;
      }
      if (!check(`${label} postcss really cannot parse the fixture`, threw, 'the fixture parsed')) return;
    } else {
      let readable = true;
      try {
        fs.readFileSync(broken, 'utf8');
      } catch {
        readable = false;
      }
      if (!check(`${label} the fixture really cannot be read`, !readable, 'the file was readable')) return;
    }
    const answer = await raiseThroughTheApp(app, 'ordinary');
    const after = app.read(PAGE);
    check(`${label} the write still succeeds`, answer?.ok === true, short(answer));
    check(`${label} the file changed`, sha(after) !== sha(source), tag(after));
    check(
      `${label} and every block keeps its authored bytes`,
      innerOf(after, 'ordinary') === inner && innerOf(after, 'preserved') === inner,
      short({ want: inner, ordinary: innerOf(after, 'ordinary'), preserved: innerOf(after, 'preserved') })
    );
    // THE ONE THE OLD ASSERTIONS COULD NOT SEE: uncertainty holds the moved
    // block's bytes and changes NOTHING else. Every other line of the file --
    // the two `</div>`s and the line the block now sits on -- keeps the
    // indentation the author wrote.
    check(
      `${label} and the markup around the move keeps the indentation the file had`,
      after === kept,
      short({ span: changedSpan(kept, after) })
    );
  } finally {
    app.stop();
    try {
      fs.chmodSync(brokenDir, 0o755);
      fs.chmodSync(broken, 0o644);
    } catch {
      /* already gone */
    }
    H.removeProject(root);
  }
}

/**
 * T7 -- the bytes do not depend on a window.
 *
 * The live preview could answer the CSS question exactly, and answering it
 * there would make what is written to disk depend on whether a window happens
 * to be open, which route it happens to show and when the paint landed -- and
 * it still could not answer about a destination that does not exist until after
 * the write. So the same move is done twice over the same bytes: once inside a
 * running app with its DOM mounted, and once by calling the writer directly in
 * a process holding no app at all. Anyone wiring `getComputedStyle` into this
 * path makes these two disagree.
 */
async function theSameBytesWithNoWindow() {
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source, inner } = preservedFixture(shape);
  const css = `${H.FIXTURE['src/styles/site.css']}\n.preserved { white-space: pre; }\n`;
  const withWindow = H.makeProject({ [PAGE]: source, 'src/styles/site.css': css });
  const noWindow = H.makeProject({ [PAGE]: source, 'src/styles/site.css': css });
  const app = await H.start(withWindow, { agentMode: 'full' });
  await H.settle(400);
  let live = null;
  try {
    const answer = await raiseThroughTheApp(app, 'preserved');
    live = app.read(PAGE);
    if (!check('[no window] the move through the running app is accepted', answer?.ok === true, short(answer))) return;
    check('[no window] the running app has a document to measure with', typeof globalThis.document?.createElement === 'function', String(typeof globalThis.document));
  } finally {
    app.stop();
    H.removeProject(withWindow);
  }

  // The same edit with nothing mounted: parse, move the node, write.
  const parsed = parsePage(source);
  if (!check('[no window] the page parses outside the app', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const outer = model.nodes[0].children.find((n) => n.name === 'div');
  const wrap = outer?.children?.find((n) => n.name === 'div');
  const moved = wrap?.children?.find((n) => n.name === 'div');
  if (!check('[no window] the block is where a move can reach it', !!moved, short(wrap?.children?.map((n) => n.name)))) return;
  wrap.children = wrap.children.filter((n) => n !== moved);
  outer.children.splice(1, 0, moved);
  WS.forgetCache();
  const headless = anchoredSerialize(source, model, { preservingTokens: WS.preservingTokens(noWindow) });
  H.removeProject(noWindow);

  check('[no window] the bytes a running app writes are the bytes a bare call writes', live === headless, short({ span: live === null ? null : changedSpan(live, headless) }));
  check('[no window]   and both kept the authored whitespace', innerOf(headless, 'preserved') === inner, short({ want: inner, got: innerOf(headless, 'preserved') }));
}

/**
 * T2 -- `white-space` INHERITS, and the guard used to look only DOWN.
 *
 * A page holding the same block twice, once inside an element that declares the
 * property and once inside one that does not, and the move is the same move:
 * up one nesting level, STAYING INSIDE the ancestor. Nothing here is in a
 * stylesheet and nothing here is a `<pre>` -- this is entirely inside the scope
 * the element-local guard already claimed to cover, and it lost two spaces.
 */
function inheritedWhitespace(attr, preserved) {
  const label = `[inherited ${attr || 'nothing'}]`;
  const inner = 'alpha\n      beta\ngamma';
  const raised = 'alpha\n    beta\ngamma';
  const outerTag = attr ? `<div ${attr}>` : `<div class='plain'>`;
  const source = commentedPage(
    `  ${outerTag}\n    <div class='wrap'>\n      <p>${inner}</p>\n    </div>\n` +
      `    <span class='tail'>tail</span>\n  </div>\n`
  );
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const outer = model.nodes[0].children.find((n) => n.name === 'div');
  const wrap = outer?.children?.find((n) => n.name === 'div');
  const p = wrap?.children?.find((n) => n.name === 'p');
  if (!check(`${label} the block is where a move can reach it`, !!p, short(wrap?.children?.map((n) => n.name)))) return;
  wrap.children = wrap.children.filter((n) => n !== p);
  outer.children.splice(outer.children.indexOf(wrap) + 1, 0, p);
  const after = anchoredSerialize(source, model);
  // POSITIVE CONTROL: the move happened. Everything below is satisfied by a
  // write that did nothing at all without it.
  if (!check(`${label} the move empties the wrap`, /<div class='wrap'>\s*<\/div>/.test(after), short(changedSpan(source, after)))) return;
  const got = /<p>([\s\S]*?)<\/p>/.exec(after);
  check(
    preserved
      ? `${label} the block never left the ancestor, so it keeps every space that ancestor renders`
      : `${label} an ordinary ancestor still lets the block be reindented`,
    !!got && got[1] === (preserved ? inner : raised),
    short({ want: preserved ? inner : raised, got: got ? got[1] : null, span: changedSpan(source, after) })
  );
  check(
    `${label}   and the page was spliced to do it, not reprinted`,
    /\/\/ Component imports\nimport Card/.test(after),
    short(changedSpan(source, after))
  );
}

/**
 * T2, the other direction -- a block moved INTO a preserving element.
 *
 * Nothing about the block being moved can answer this: its own bytes are
 * innocent and it declares nothing. The moment it lands inside an element that
 * renders its whitespace, the indentation written in front of it becomes
 * content -- measured, two spaces inserted, including in front of a line that
 * had none. So the break goes in and the indent does not.
 */
function movedIntoPreservedWhitespace(attr, preserved) {
  const label = `[into ${attr || 'nothing'}]`;
  const source = commentedPage(
    `  <div ${attr}>\n    <span class='kept'>one</span>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n  <p>alpha\nbeta</p>\n`
  );
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const box = root.children.find((n) => n.name === 'div');
  const p = root.children.find((n) => n.name === 'p');
  if (!check(`${label} both are where a move can reach them`, !!box && !!p, short(root.children.map((n) => n.name)))) return;
  root.children = root.children.filter((n) => n !== p);
  box.children.push(p);
  const after = anchoredSerialize(source, model);
  if (!check(`${label} the move puts the <p> inside the box`, /<span class='kept'>one<\/span>[\s\S]*<p>[\s\S]*<\/div>/.test(after), short(changedSpan(source, after)))) return;
  const held = /<div [^>]*>([\s\S]*?)<\/div>/.exec(after);
  const inserted = held ? held[1] : '';
  check(
    preserved
      ? `${label} nothing is indented into the element that renders its whitespace`
      : `${label} an ordinary element still gets the sibling's indentation`,
    preserved
      ? inserted === `\n    <span class='kept'>one</span>\n<p>alpha\nbeta</p>\n  `
      : inserted === `\n    <span class='kept'>one</span>\n    <p>alpha\n  beta</p>\n  `,
    short({ got: inserted })
  );
}

/**
 * T2c -- THE SAME MOVE, TO INDEX 0, WHERE A SECOND NODE IS IN THE WAY.
 *
 * `movedIntoPreservedWhitespace` above appends: the only bytes written are the
 * ones in front of the node being put in, and the element's other children are
 * not touched at all. Inserting at index 0 is not that operation. The new node
 * goes in AHEAD of the element's previous first child, and `insertSplice` wrote
 * it at that child's own offset -- so the authored spaces in front of the old
 * first child ended up in front of the NEW one, and the old first child was
 * handed whatever the indent decision said instead.
 *
 * Inside a preserving element that decision is deliberately the empty string,
 * and it is deliberately the empty string ONLY FOR THE NODE BEING INSERTED.
 * Applied to the node that was already there, it is a deletion of content:
 * measured, `\n    <span class='kept'>one</span>` came back as
 * `\n<span class='kept'>one</span>` -- four spaces the page renders, gone from
 * an element the caller named only as the thing to insert BEFORE. Nothing
 * downstream catches it either: `renderedWhitespace` reads the inner bytes of
 * `<pre>` and `<textarea>` only, so a `white-space: pre` `<div>` walks straight
 * through the readback gate, and `sameMeaning` cannot see indentation at all.
 *
 * The oracle is the whole file. The positive control is the ordinary element on
 * the same fixture, where the indent and the authored bytes are the same string
 * and the result must be exactly what it always was; the unproven project is
 * here for the same reason it is in `movedIntoAnUnprovenElement`, because "we
 * could not scan it" must not start moving markup to column zero.
 */
// `lead` is the indent written on the line the moved block lands on -- the
// decision this fix is about. `block` is the moved block's OWN bytes, which is
// a different decision made by `printNode` and is spelled out here so the two
// cannot be confused for each other: the last row has them disagreeing.
const INDEX_ZERO_CASES = [
  { id: "style='white-space: pre'", open: "<div style='white-space: pre'>", close: '</div>', tag: 'div', preserved: true, lead: '', block: 'alpha\nbeta' },
  { id: "class='whitespace-pre'", open: "<div class='whitespace-pre'>", close: '</div>', tag: 'div', preserved: true, lead: '', block: 'alpha\nbeta' },
  { id: '<pre>', open: '<pre>', close: '</pre>', tag: 'pre', preserved: true, lead: '', block: 'alpha\nbeta' },
  { id: "class='plain'", open: "<div class='plain'>", close: '</div>', tag: 'div', preserved: false, lead: '    ', block: 'alpha\n  beta' },
  // A project whose scan failed, and the row where the two decisions point
  // opposite ways. `preserves` says yes -- so the moved block's own bytes
  // travel unshifted -- while `rendersIndent` says no, so the line it lands on
  // still gets the file's own indent and the span in front of which it lands
  // still keeps all four of its spaces.
  {
    id: 'unproven project',
    open: "<div class='plain'>",
    close: '</div>',
    tag: 'div',
    preserved: false,
    lead: '    ',
    block: 'alpha\nbeta',
    tokens: new Set(['*']),
  },
];

function insertedInFrontOfTheFirstChild({ id, open, close, tag, preserved, lead, block, tokens }) {
  const label = `[index 0 of ${id}]`;
  const tail = `  <footer class='end'>end</footer>\n  <p>alpha\nbeta</p>\n`;
  const source = commentedPage(`  ${open}\n    <span class='kept'>one</span>\n  ${close}\n${tail}`);
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const box = root.children.find((n) => n.name === tag);
  const p = root.children.find((n) => n.name === 'p');
  if (!check(`${label} both are where a move can reach them`, !!box && !!p, short(root.children.map((n) => n.name)))) return;
  root.children = root.children.filter((n) => n !== p);
  box.children.unshift(p);
  const after = anchoredSerialize(source, model, tokens ? { preservingTokens: tokens } : {});
  // POSITIVE CONTROL: the <p> really is inside the box, and really is first.
  if (
    !check(
      `${label} the move puts the <p> in front of the span`,
      new RegExp(`<${tag}[^>]*>[\\s\\S]*<p>[\\s\\S]*</p>[\\s\\S]*<span class='kept'>`).test(after),
      short(changedSpan(source, after))
    )
  ) {
    return;
  }
  // THE CLAIM, on its own, in the bytes the reviewer named: the node that used
  // to be first is not part of this edit, so its line is untouched.
  check(
    `${label} the sibling it was inserted in front of keeps every authored space`,
    after.includes(`\n    <span class='kept'>one</span>`),
    short({ span: changedSpan(source, after) })
  );
  const want = commentedPage(
    `  ${open}\n${lead}<p>${block}</p>\n    <span class='kept'>one</span>\n  ${close}\n` +
      tail.slice(0, tail.indexOf('  <p>'))
  );
  check(
    preserved
      ? `${label} the insert writes no indent of its own and moves nobody else's`
      : `${label} an ordinary element still indents a node inserted at index 0`,
    after === want,
    short({ span: changedSpan(want, after) })
  );
}

/**
 * T2d -- the same insert where the destination INHERITS the property.
 *
 * The element being inserted into declares nothing; its parent does. That is
 * the case no property of the destination itself can answer, and it is the one
 * that reaches `insertSplice` through two levels of `childContext` -- so the
 * flag has to survive the walk down as well as be read correctly at the bottom.
 */
function insertedInFrontOfTheFirstChildOfADescendant() {
  const label = '[index 0 of an inherited element]';
  const tail = `  <footer class='end'>end</footer>\n  <p>alpha\nbeta</p>\n`;
  const box = `  <div style='white-space: pre'>\n    <div class='inner'>\n      <span class='kept'>one</span>\n    </div>\n  </div>\n`;
  const source = commentedPage(box + tail);
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const outer = root.children.find((n) => n.name === 'div');
  const inner = outer?.children?.find((n) => n.name === 'div');
  const p = root.children.find((n) => n.name === 'p');
  if (!check(`${label} both are where a move can reach them`, !!inner && !!p, short(outer?.children?.map((n) => n.name)))) return;
  root.children = root.children.filter((n) => n !== p);
  inner.children.unshift(p);
  const after = anchoredSerialize(source, model);
  if (
    !check(
      `${label} the move puts the <p> in front of the span`,
      /<div class='inner'>[\s\S]*<p>[\s\S]*<\/p>[\s\S]*<span class='kept'>/.test(after),
      short(changedSpan(source, after))
    )
  ) {
    return;
  }
  const want = commentedPage(
    `  <div style='white-space: pre'>\n    <div class='inner'>\n<p>alpha\nbeta</p>\n      <span class='kept'>one</span>\n    </div>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n`
  );
  check(
    `${label} the six spaces the inherited element renders in front of the span are still six`,
    after.includes(`\n      <span class='kept'>one</span>`),
    short({ span: changedSpan(source, after) })
  );
  check(
    `${label} and the rest of the file is byte for byte what it was`,
    after === want,
    short({ span: changedSpan(want, after) })
  );
}

/**
 * T2b -- THE SAME MOVE INTO AN ELEMENT NOBODY COULD MEASURE.
 *
 * The destination declares nothing at all; what is unknown is the PROJECT --
 * `preservingTokens` answered `{'*'}` because a stylesheet somewhere in it
 * would not parse. That sentinel used to be read as "every element renders its
 * own whitespace", so the insert went in at COLUMN ZERO: the layout of markup
 * nobody touched, actively rewritten because a scan failed.
 *
 * The two halves of the right answer are asserted in one string, and they pull
 * in opposite directions, which is the whole point. The moved block's own bytes
 * travel UNSHIFTED, because a reindent could be the thing that deletes rendered
 * spaces. The line it lands on gets the SIBLING'S INDENT, because writing
 * nothing there is not caution, it is an edit.
 */
function movedIntoAnUnprovenElement() {
  const label = '[into unproven]';
  const source = commentedPage(
    `  <div class='plain'>\n    <span class='kept'>one</span>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n  <p>alpha\nbeta</p>\n`
  );
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const box = root.children.find((n) => n.name === 'div');
  const p = root.children.find((n) => n.name === 'p');
  if (!check(`${label} both are where a move can reach them`, !!box && !!p, short(root.children.map((n) => n.name)))) return;
  root.children = root.children.filter((n) => n !== p);
  box.children.push(p);
  const after = anchoredSerialize(source, model, { preservingTokens: new Set(['*']) });
  if (!check(`${label} the move puts the <p> inside the box`, /<span class='kept'>one<\/span>[\s\S]*<p>[\s\S]*<\/div>/.test(after), short(changedSpan(source, after)))) return;
  const held = /<div [^>]*>([\s\S]*?)<\/div>/.exec(after);
  const inserted = held ? held[1] : '';
  check(
    `${label} a project that could not be scanned holds the moved bytes and leaves the layout alone`,
    inserted === `\n    <span class='kept'>one</span>\n    <p>alpha\nbeta</p>\n  `,
    short({ got: inserted })
  );
}

/**
 * T3 -- the value table, which is what keeps this a narrowing.
 *
 * Measured in a real Blink window over the same reindent: with `pre`,
 * `pre-wrap` and `break-spaces` the rendered line moves; with `pre-line`,
 * `normal` and `nowrap` it does not, because all three collapse runs of spaces
 * and `pre-line` keeps only the newlines. `pre-line` used to refuse here. It
 * was safe and it was wrong: a refusal costs the author their reindentation for
 * no rendered difference at all.
 *
 * Asked twice, of the two places the answer has to agree: the declaration
 * written on the element, and the scanner that reduces a project's stylesheets.
 */
const WHITESPACE_VALUES = [
  { value: 'pre', refuses: true },
  { value: 'pre-wrap', refuses: true },
  { value: 'break-spaces', refuses: true },
  { value: 'pre-line', refuses: false },
  { value: 'normal', refuses: false },
  { value: 'nowrap', refuses: false },
  // A value nothing can read statically. Guessing it is `normal` is the guess
  // that deletes bytes, so it counts as preserving.
  { value: 'var(--ws)', refuses: true },
];

function theWhitespaceValueTable() {
  const inner = 'alpha\n      beta\ngamma';
  const raised = 'alpha\n    beta\ngamma';
  for (const { value, refuses } of WHITESPACE_VALUES) {
    const label = `[value ${value}]`;
    const source = commentedPage(
      `  <div class='outer'>\n    <div class='wrap'>\n      <p style='white-space: ${value}'>${inner}</p>\n    </div>\n  </div>\n`
    );
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const outer = model.nodes[0].children.find((n) => n.name === 'div');
    const wrap = outer?.children?.find((n) => n.name === 'div');
    const p = wrap?.children?.find((n) => n.name === 'p');
    if (!check(`${label} the block is where a move can reach it`, !!p, short(wrap?.children?.map((n) => n.name)))) continue;
    wrap.children = wrap.children.filter((n) => n !== p);
    outer.children.splice(1, 0, p);
    const after = anchoredSerialize(source, model);
    if (!check(`${label} the move empties the wrap`, /<div class='wrap'>\s*<\/div>/.test(after), short(changedSpan(source, after)))) continue;
    const got = /<p [^>]*>([\s\S]*?)<\/p>/.exec(after);
    check(
      refuses
        ? `${label} a value the browser renders differently after a reindent refuses it`
        : `${label} a value the browser renders the SAME after a reindent still allows it`,
      !!got && got[1] === (refuses ? inner : raised),
      short({ want: refuses ? inner : raised, got: got ? got[1] : null })
    );
    // AND THE SCANNER'S HALF OF THE SAME TABLE. A reducer that keys on the
    // property name rather than on its value answers the same for all six.
    const tokens = WS.tokensInCss(`.card { white-space: ${value}; }`);
    check(
      `${label}   and the stylesheet scanner says the same thing`,
      tokens.has('.card') === refuses && tokens.size === (refuses ? 1 : 0),
      short([...tokens])
    );
  }
}

/**
 * T4 -- THE CRITICAL ONE: a `<pre>` holding ELEMENT children.
 *
 * `printNode`'s refusal asks about the bytes of the node being MOVED, and here
 * the node being moved is an innocent `<span>`. What holds the rendered spaces
 * is the context it lives in, and re-laying the `<pre>`'s children out as an
 * inline run collapsed the whole block onto one line: three lines of rendered
 * text became `alpha beta gamma`.
 *
 * THE ORACLE IS THE AUTHORED BYTES, and it has to be. The readback in
 * `anchoredSerialize` compares the splice against `serializePage` of the same
 * model, and BOTH destroy this run -- the newlines between element children of
 * a `<pre>` live in the model only as an as-written cache -- so the fallback
 * produces the identical damage and the two agree about it.
 */
function elementChildrenInsideAPre() {
  // The third case is the one an element cannot answer about itself: an
  // ordinary `<div>` in a project whose scan FAILED. Uncertainty has to keep
  // the bytes here -- reprinting an inline run from the model is what collapsed
  // `alpha\n beta\ngamma` into one line -- while, in `movedIntoAnUnprovenElement`,
  // the same uncertainty must NOT move the surrounding layout to column zero.
  // Both directions come off one flag each, and this pins the wide one.
  const cases = [
    { tag: 'pre', tokens: null, preserved: true, label: '[children of <pre>]' },
    { tag: 'div', tokens: null, preserved: false, label: '[children of <div>]' },
    { tag: 'div', tokens: new Set(['*']), preserved: true, label: '[children of <div> unproven]' },
  ];
  for (const { tag, tokens, preserved, label } of cases) {
    const body = `  <${tag}><span class='wrap'><span class='moved'>alpha\n beta\ngamma</span></span><span class='tail'>tail</span></${tag}>\n`;
    const source = commentedPage(body);
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const box = model.nodes[0].children.find((n) => n.name === tag);
    const wrap = box?.children?.find((n) => n.name === 'span');
    const moved = wrap?.children?.find((n) => n.name === 'span');
    if (!check(`${label} the inner span is where a move can reach it`, !!moved, short(wrap?.children?.map((n) => n.name)))) continue;
    // THE PREMISE: the bytes really do hold the newlines, and the MODEL really
    // does not. If the parser ever starts carrying them in `value` this stops
    // being the fixture and says so here rather than passing for free.
    if (
      !check(
        `${label} the model collapsed the run the file spells across three lines`,
        moved.children?.[0]?.value === 'alpha beta gamma' && moved.children?.[0]?.source === 'alpha\n beta\ngamma',
        short(moved.children?.[0])
      )
    ) {
      continue;
    }
    wrap.children = wrap.children.filter((n) => n !== moved);
    box.children.splice(1, 0, moved);
    const after = anchoredSerialize(source, model, tokens ? { preservingTokens: tokens } : {});
    // POSITIVE CONTROL: the span really left the wrap.
    if (!check(`${label} the move empties the wrap`, /<span class='wrap'><\/span>/.test(after), short(changedSpan(source, after)))) continue;
    const want = commentedPage(
      preserved
        ? `  <${tag}><span class='wrap'></span><span class='moved'>alpha\n beta\ngamma</span><span class='tail'>tail</span></${tag}>\n`
        : `  <${tag}><span class='wrap'></span><span class='moved'>alpha beta gamma</span><span class='tail'>tail</span></${tag}>\n`
    );
    check(
      preserved
        ? `${label} every space the browser renders in the run is still there`
        : `${label} an ordinary inline run is still re-laid-out, as it always was`,
      after === want,
      short({ span: changedSpan(want, after) })
    );
  }
}

/**
 * T4, the destination side -- a block moved INTO a `<pre>`'s inline run.
 *
 * The same collapse as above, arriving from the other direction: the run the
 * moved element joins is one `inlineString` would rewrite from the model, and
 * the model is where the newlines have already gone. So the bytes that land are
 * the bytes the file already held, joined by nothing -- inside a preserving
 * element there is no layout to add.
 */
function movedIntoAPresInlineRun() {
  for (const tag of ['pre', 'div']) {
    const label = `[into <${tag}>'s run]`;
    const preserved = tag === 'pre';
    const source = commentedPage(
      `  <${tag}><span class='a'>one</span><span class='b'>two</span></${tag}>\n` +
        `  <div class='src'><span class='stay'>stay</span><span class='moved'>alpha\n beta</span></div>\n`
    );
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const root = model.nodes[0];
    const box = root.children.find((n) => n.name === tag);
    const src = root.children.filter((n) => n.name === 'div').pop();
    const moved = src?.children?.[1];
    if (!check(`${label} the span is where a move can reach it`, !!box && !!moved, short(root.children.map((n) => n.name)))) continue;
    src.children = src.children.filter((n) => n !== moved);
    box.children.splice(1, 0, moved);
    const after = anchoredSerialize(source, model);
    // POSITIVE CONTROL: the span really left the element it was in.
    if (
      !check(
        `${label} the move takes the span out of the div it came from`,
        /<div class='src'><span class='stay'>stay<\/span><\/div>/.test(after),
        short(changedSpan(source, after))
      )
    ) {
      continue;
    }
    const want = commentedPage(
      `  <${tag}><span class='a'>one</span><span class='moved'>alpha${preserved ? '\n beta' : ' beta'}</span><span class='b'>two</span></${tag}>\n` +
        `  <div class='src'><span class='stay'>stay</span></div>\n`
    );
    check(
      preserved
        ? `${label} the bytes that land are the bytes the file held, with nothing added between them`
        : `${label} an ordinary inline run is still rewritten from the model, as it always was`,
      after === want,
      short({ span: changedSpan(want, after) })
    );
  }
}

/**
 * T4, once more where the preserving element is written as a BLOCK.
 *
 * A `<pre>`-like element does not have to hold an inline run: a
 * `white-space: pre` `<div>` full of paragraphs is laid out over lines, and a
 * run of its children replaced by a longer run goes through `rangeSplice`
 * rather than through the insert. The indentation between those lines is
 * content there exactly as it is anywhere else inside such an element, so the
 * break goes in and the indent does not.
 */
function replacedInsidePreservedWhitespace(attr, preserved) {
  const label = `[replaced in ${attr}]`;
  const source = commentedPage(`  <div ${attr}>\n    <p>one</p>\n    <p>two</p>\n  </div>\n`);
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const box = model.nodes[0].children.find((n) => n.name === 'div');
  if (!check(`${label} the paragraphs are children of the box`, box?.children?.length === 2, short(box?.children?.map((n) => n.name)))) return;
  const para = (word) => ({ kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: word }] });
  box.children = [para('a'), para('b'), para('c')];
  const after = anchoredSerialize(source, model);
  if (!check(`${label} the three new paragraphs are in the file`, /<p>a<\/p>[\s\S]*<p>b<\/p>[\s\S]*<p>c<\/p>/.test(after), short(changedSpan(source, after)))) return;
  const held = new RegExp(`<div ${attr}>([\\s\\S]*?)</div>`).exec(after);
  check(
    preserved
      ? `${label} the replacement run is written with no indentation to render`
      : `${label} an ordinary element still gets its own indentation on every line`,
    (held ? held[1] : null) ===
      (preserved ? '\n    <p>a</p>\n<p>b</p>\n<p>c</p>\n  ' : '\n    <p>a</p>\n    <p>b</p>\n    <p>c</p>\n  '),
    short({ got: held ? held[1] : null })
  );
}

/**
 * The reducer, on its own -- what a selector is allowed to reduce to.
 *
 * It answers ONE question, "could this rule reach an element with these
 * tokens?", and only the NO is ever acted on, so an over-approximation is
 * sound and a shape it does not fully understand has to answer ANY. The point
 * of asserting the exact sets is that ANY is not the answer to everything:
 * a reducer that returned ANY for every selector would refuse every reindent
 * in every project, which is the switch-off this must not become.
 */
function theSelectorReducer() {
  const cases = [
    ['.preserved { white-space: pre }', ['.preserved']],
    // The SUBJECT is the rightmost compound: `.card p` styles the p.
    ['.card p { white-space: pre }', ['p']],
    ['#top.wide { white-space: pre }', ['#top', '.wide']],
    ['.a, .b { white-space: pre }', ['.a', '.b']],
    ['@media print { .m { white-space: pre } }', ['.m']],
    // Shapes the reducer does not claim to understand.
    ['* { white-space: pre }', ['*']],
    ['[data-keep] { white-space: pre }', ['*']],
    [':is(.a, .b) { white-space: pre }', ['*']],
    ['.card:not(.flat) { white-space: pre }', ['*']],
    // Cut in half by the split and still right: the subject survived it whole.
    ['.a[data-x] .b { white-space: pre }', ['.b']],
    ['[data-x="a b"] { white-space: pre }', ['*']],
    // THE DECLARATION SPELLED AS A UTILITY NAME. postcss hands `@apply` over as
    // an AtRule, not a Decl, so `rule.each` looked straight past it and the
    // rule contributed NOTHING -- not even ANY -- while the element's class was
    // `.preserved`, which the element-local guard does not fire on either.
    ['.preserved { @apply whitespace-pre; }', ['.preserved']],
    ['@layer components { .preserved { @apply whitespace-pre; } }', ['.preserved']],
    // A configured prefix or a variant is the same utility.
    ['.preserved { @apply md:whitespace-pre-wrap; }', ['.preserved']],
    // NEGATIVE CONTROL: an `@apply` that cannot preserve whitespace is read,
    // not shrugged at. A scanner that answered ANY for every `@apply` would
    // switch reindentation off for every project that uses Tailwind that way.
    ['.card { @apply text-sm font-bold; }', []],
    ['.card { @apply whitespace-normal; }', []],
    // A declaration whose SUBJECT is a name somewhere else: whatever `@apply
    // keep-space` is written on inherits it, and which elements those are is
    // not answerable from this text.
    ['@utility keep-space { white-space: pre; }', ['*']],
    ['@mixin keep-space { white-space: pre; }', ['*']],
    // And an `@apply` whose list a preprocessor builds at compile time. This
    // one arrives at ANY through the parse gate rather than through any rule
    // about `@apply` -- postcss throws on the word inside the braces -- and it
    // is here so that stays true rather than being assumed.
    ['.preserved { @apply #{$utils}; }', ['*']],
    // NEGATIVE CONTROLS: nothing here preserves anything, so nothing is
    // contributed -- not even ANY.
    ['.card { color: red }', []],
    ['.card { white-space: nowrap }', []],
    ['', []],
  ];
  for (const [css, want] of cases) {
    const got = [...WS.tokensInCss(css)].sort();
    check(
      `[reducer] ${css || '(empty)'} -> ${want.length ? want.join(' ') : 'nothing'}`,
      got.length === want.length && got.every((one, i) => one === [...want].sort()[i]),
      short({ want, got })
    );
  }
  // A text postcss cannot parse is a text whose rules are unknown, and unknown
  // is the refusing answer rather than the permitting one.
  check(
    '[reducer] a stylesheet that will not parse contributes ANY',
    WS.tokensInCss('.preserved { white-space: pre\n@media {\n').has('*'),
    short([...WS.tokensInCss('.preserved { white-space: pre\n@media {\n')])
  );
  // A `<style>` block is not a stylesheet, and the scan has to find one.
  check(
    '[reducer] a <style> block is found in a component',
    WS.styleBlocksIn('<div>x</div>\n<style>\n.a { color: red }\n</style>\n').join('').includes('.a { color: red }'),
    short(WS.styleBlocksIn('<div>x</div>\n<style>\n.a { color: red }\n</style>\n'))
  );
  // AND THE DECISION ABOUT NO PROJECT AT ALL, asserted rather than assumed:
  // a caller with nothing to scan gets nothing, not everything. The other
  // reading would switch reindentation off for every caller that has no
  // project, and this guard only earns its keep as a narrowing.
  // A STYLESHEET TOO BIG TO BE WORTH READING IS STILL A STYLESHEET. Skipping it
  // would answer "no rules in there" about a file nobody looked at, which is
  // the one answer that costs bytes.
  const big = H.makeProject({});
  fs.writeFileSync(path.join(big, 'src', 'styles', 'big.css'), `/* ${'x'.repeat(3 * 1024 * 1024)} */\n`, 'utf8');
  WS.forgetCache();
  check(
    '[reducer] a stylesheet too big to read contributes ANY',
    WS.preservingTokens(big).has('*'),
    short([...WS.preservingTokens(big)])
  );
  H.removeProject(big);
  WS.forgetCache();
  check(
    '[reducer] no project to scan is an empty answer, not ANY',
    WS.preservingTokens(null).size === 0 && WS.preservingTokens('').size === 0,
    short([...WS.preservingTokens(null)])
  );
}

/**
 * T9 -- the three layouts the WALK missed, each of which answered `[]`.
 *
 * The empty set is not a shrug. The parser reads it as the positive statement
 * "this project has no rule that preserves whitespace", and acts on it by
 * reindenting -- so every hole in the walk is a hole that deletes rendered
 * bytes, and the module header's claim that "every failure also contributes
 * ANY" has to be true of directories and depth caps, not only of files.
 */
function theWalkThatCameBackShort() {
  const rule = '.preserved { white-space: pre; }\n';
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source, inner, raised } = preservedFixture(shape);

  // A DIRECTORY THAT WILL NOT LIST TAKES EVERY STYLESHEET UNDER IT WITH IT.
  // Measured on one fixture and one move: an unreadable FILE answered `['*']`
  // and kept `alpha\n      beta\ngamma`; an unreadable DIRECTORY holding the
  // same file answered `[]` and wrote back `alpha\n    beta\ngamma`, two spaces
  // the page renders deleted. So the bytes are the oracle here too, and the
  // move is done headlessly because an unlistable directory stops the app from
  // opening the project at all.
  const hiddenDir = H.makeProject({ [PAGE]: source, 'src/vendor/keep.css': rule });
  const dir = path.join(hiddenDir, 'src', 'vendor');
  WS.forgetCache();
  const listed = [...WS.preservingTokens(hiddenDir)];
  let listable = true;
  let hidden = null;
  let hiddenText = null;
  try {
    fs.chmodSync(dir, 0o000);
    try {
      fs.readdirSync(dir);
    } catch {
      listable = false;
    }
    WS.forgetCache();
    const tokens = WS.preservingTokens(hiddenDir);
    hidden = [...tokens];
    hiddenText = raiseHeadless(source, 'preserved', tokens);
  } finally {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      /* already gone */
    }
    H.removeProject(hiddenDir);
  }
  if (check('[walk] the fixture directory really cannot be listed', !listable, 'the directory listed')) {
    // PREMISE: while it IS readable the rule in it is found, so the check below
    // is about the permission and not about the walk never reaching the file.
    check('[walk] the rule in that directory is found while it is readable', listed.includes('.preserved'), short(listed));
    check('[walk] a directory that cannot be listed contributes ANY', !!hidden && hidden.includes('*'), short(hidden));
    check(
      '[walk] and the move under it keeps the bytes the hidden rule protects',
      !!hiddenText && innerOf(hiddenText, 'preserved') === inner && raised !== inner,
      short({ want: inner, got: hiddenText === null ? null : innerOf(hiddenText, 'preserved') })
    );
  }

  // A STYLESHEET THE PROJECT REALLY IMPORTS, SITTING OUTSIDE `src`, `public`
  // AND `styles`. Measured: `assets/site.css` imported from the page's own
  // frontmatter answered `[]`, and the authored `alpha\n      beta\ngamma` was
  // written back two spaces shorter.
  const outside = H.makeProject({ 'assets/site.css': rule });
  WS.forgetCache();
  const found = [...WS.preservingTokens(outside)];
  H.removeProject(outside);
  check('[walk] a stylesheet outside the three old roots is still scanned', found.includes('.preserved'), short(found));

  // AND THE DEPTH CAP, which is a part of the tree nobody looked at rather than
  // a part of the tree with nothing in it.
  const deep = H.makeProject({ 'src/a/b/c/d/e/f/g/h/i/j/k/l/m/deep.css': rule });
  WS.forgetCache();
  const capped = [...WS.preservingTokens(deep)];
  H.removeProject(deep);
  check('[walk] a tree deeper than the cap contributes ANY', capped.includes('*'), short(capped));
}

/**
 * T10 -- the cache that never hit.
 *
 * `page:write` asks for the tokens and THEN writes the page, and the page is
 * itself one of the files the scan covers -- so save N moved its size and
 * mtime and save N+1 missed on the page's own stamp. Measured, files read
 * during `preservingTokens` were 3, 3, 3, 3, 3 across five consecutive saves:
 * a synchronous re-read and postcss re-parse of every stylesheet and every
 * style-bearing component, on the main process, on every save.
 *
 * Both halves are asserted, because they can fail apart: that the scanner can
 * hit its cache when the caller hands in the page's bytes, and that a save
 * through the real product actually does.
 */
async function theScanThatRanOnEverySave() {
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source } = preservedFixture(shape);
  const css = `${H.FIXTURE['src/styles/site.css']}\n.preserved { white-space: pre; }\n`;

  // --- THE SCANNER ON ITS OWN, counted by the reads it really does.
  const root = H.makeProject({ [PAGE]: source, 'src/styles/site.css': css });
  const abs = path.join(root, PAGE);
  const realRead = fs.readFileSync;
  const counts = [];
  WS.forgetCache();
  try {
    for (let n = 0; n < 3; n += 1) {
      const before = realRead.call(fs, abs, 'utf8');
      let reads = 0;
      fs.readFileSync = function counted(...args) {
        if (typeof args[0] === 'string' && args[0].startsWith(root)) reads += 1;
        return realRead.apply(fs, args);
      };
      try {
        WS.preservingTokens(root, { knownText: { [abs]: before } });
      } finally {
        fs.readFileSync = realRead;
      }
      counts.push(reads);
      // What page:write does next: the page's own bytes change.
      fs.writeFileSync(abs, `${before}<!-- ${n} -->\n`, 'utf8');
    }
  } finally {
    fs.readFileSync = realRead;
  }
  check('[cache] the first scan really reads the project', counts[0] > 0, short(counts));
  check(
    '[cache] a save that changed only the page reads nothing the second time',
    counts.slice(1).every((n) => n === 0),
    short(counts)
  );
  // AND THE CACHE STILL HAS TO MISS ON THE THING IT COVERS. The page is kept in
  // the scan -- its own `<style>` block styles its own elements -- and stamped
  // by the hash of those blocks, so editing one is a miss.
  WS.forgetCache();
  const without = [...WS.preservingTokens(root, { knownText: { [abs]: '<p>a</p>' } })];
  const with_ = [...WS.preservingTokens(root, { knownText: { [abs]: "<p>a</p><style>.kept{white-space:pre}</style>" } })];
  check(
    '[cache] a page that gains a preserving <style> block is a miss, not a hit',
    !without.includes('.kept') && with_.includes('.kept'),
    short({ without, with: with_ })
  );
  H.removeProject(root);

  // --- AND THE PRODUCT, because the scanner hitting its cache proves nothing
  // about whether page:write hands it what it needs to.
  const live = H.makeProject({ [PAGE]: source, 'src/styles/site.css': css });
  const app = await H.start(live, { agentMode: 'full' });
  await H.settle(400);
  try {
    const run = (d, a, args = {}) => app.api.run(d, a, args);
    const page = (await run('target', 'read')).target;
    const outer = (page?.children || []).find((c) => c.tag === 'div');
    if (!check('[cache] the element a save can be aimed at is there', !!outer?.ref, short(page))) return;
    const first = await run('target', 'set_prop', { ref: outer.ref, name: 'data-n', value: '1' });
    if (!check('[cache] the first save through the product is accepted', first?.ok === true, short(first))) return;
    // A write moves the document's revision on, so the second edit is aimed
    // through a fresh read exactly as an agent's would be. `target.read` writes
    // nothing, so the scan count below is still the second SAVE's.
    const again = (await run('target', 'read')).target;
    const outerAgain = (again?.children || []).find((c) => c.tag === 'div');
    if (!check('[cache] the element is still there for a second save', !!outerAgain?.ref, short(again))) return;
    const before = WS.scansSoFar();
    const second = await run('target', 'set_prop', { ref: outerAgain.ref, name: 'data-n', value: '2' });
    const after = WS.scansSoFar();
    if (!check('[cache] the second save through the product is accepted', second?.ok === true, short(second))) return;
    if (!check('[cache] the second save really wrote the page', app.read(PAGE).includes('data-n="2"'), tag(app.read(PAGE)))) return;
    check(
      '[cache] a second save re-scans no stylesheet the first one already read',
      after === before,
      short({ scansBefore: before, scansAfter: after })
    );
  } finally {
    app.stop();
    H.removeProject(live);
  }
}

/**
 * T8 -- the coverage debt.
 *
 * `declaresRenderedSpace` looks DOWN, and until this fixture existed nothing in
 * test/ could make it return true: the strings 'whitespace-pre' and
 * 'white-space: pre' appeared in no fixture anywhere, so deleting the call from
 * `printNode` left every suite green. Here the node that MOVES declares
 * nothing, sits under no preserving ancestor and holds none of the four tags --
 * the only thing that can save its bytes is the descendant three levels inside
 * it that does declare the property.
 */
function aDescendantThatDeclaresIt() {
  for (const attr of [`style='white-space: pre'`, `class='whitespace-pre'`, `class='plain'`]) {
    const preserved = !attr.includes('plain');
    const label = `[descendant ${attr}]`;
    const inner = 'alpha\n      beta\ngamma';
    const raised = 'alpha\n    beta\ngamma';
    const source = commentedPage(
      `  <div class='outer'>\n    <div class='wrap'>\n      <section>\n        <div ${attr}>${inner}</div>\n      </section>\n    </div>\n  </div>\n`
    );
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const outer = model.nodes[0].children.find((n) => n.name === 'div');
    const wrap = outer?.children?.find((n) => n.name === 'div');
    const section = wrap?.children?.find((n) => n.name === 'section');
    if (!check(`${label} the section is where a move can reach it`, !!section, short(wrap?.children?.map((n) => n.name)))) continue;
    wrap.children = wrap.children.filter((n) => n !== section);
    outer.children.splice(1, 0, section);
    const after = anchoredSerialize(source, model);
    if (!check(`${label} the move empties the wrap`, /<div class='wrap'>\s*<\/div>/.test(after), short(changedSpan(source, after)))) continue;
    const got = new RegExp(`<div ${attr}>([\\s\\S]*?)</div>`).exec(after);
    check(
      preserved
        ? `${label} a node whose DESCENDANT renders its spaces travels unshifted`
        : `${label} a node with nothing inside it to protect is still reindented`,
      !!got && got[1] === (preserved ? inner : raised),
      short({ want: preserved ? inner : raised, got: got ? got[1] : null })
    );
  }
}

/**
 * T11 -- THE SECOND FLAG, FED AN OVER-APPROXIMATION.
 *
 * The token set is documented as a superset and sound "only because it is only
 * ever read as NO": `tokensOfSelector` reduces a selector to its rightmost
 * compound and `matchesPreservingTokens` matches ANY token in it. So an
 * ordinary, correctly-parsed `.prose div { white-space: pre-wrap }` answers
 * `['div']` -- measured, and asserted below rather than assumed -- and while
 * `indentIsContent` read that set, EVERY `<div>` in the project satisfied it:
 * every block insert and every range splice inside any `<div>` wrote the markup
 * around it at COLUMN ZERO. That is the same "active edit rather than a missing
 * one" the second flag was added to prevent, reached from a stylesheet with
 * nothing wrong with it rather than from a broken one, and it is a regression
 * against a base that always used `lineIndentOf`.
 *
 * BOTH DIRECTIONS, because a fix that just ignores the tokens everywhere would
 * pass the first check and lose the whole mechanism: the moved subtree still
 * has to travel as authored, which is what the wide flag is for.
 */
function theTokenThatNamesEveryDiv() {
  const label = '[over-approximated]';
  // PREMISE: the reducer really does hand a bare tag out of a descendant
  // selector. Without this the checks below could pass for want of a token.
  const tokens = WS.tokensInCss('.prose div { white-space: pre-wrap; }');
  if (
    !check(
      `${label} an ordinary descendant selector reduces to a bare tag`,
      tokens.size === 1 && tokens.has('div'),
      short([...tokens])
    )
  ) {
    return;
  }
  const source = commentedPage(
    `  <div class='plain'>\n    <span class='kept'>one</span>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n  <p>alpha\nbeta</p>\n`
  );
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const root = model.nodes[0];
  const box = root.children.find((n) => n.name === 'div');
  const p = root.children.find((n) => n.name === 'p');
  if (!check(`${label} both are where a move can reach them`, !!box && !!p, short(root.children.map((n) => n.name)))) return;
  root.children = root.children.filter((n) => n !== p);
  box.children.push(p);
  const after = anchoredSerialize(source, model, { preservingTokens: tokens });
  if (
    !check(
      `${label} the move puts the <p> inside the box`,
      /<span class='kept'>one<\/span>[\s\S]*<p>[\s\S]*<\/div>/.test(after),
      short(changedSpan(source, after))
    )
  ) {
    return;
  }
  const held = /<div [^>]*>([\s\S]*?)<\/div>/.exec(after);
  const inserted = held ? held[1] : '';
  check(
    `${label} a bare tag off a stylesheet does not put the surrounding markup at column zero`,
    inserted === `\n    <span class='kept'>one</span>\n    <p>alpha\nbeta</p>\n  `,
    short({ got: inserted })
  );
  // AND THE WIDE FLAG IS UNTOUCHED: the same token still holds the moved
  // subtree's own bytes, which is the direction that keeps rendered spaces.
  check(
    `${label}   and the moved subtree still travels as it was authored`,
    inserted.includes('<p>alpha\nbeta</p>'),
    short({ got: inserted })
  );
}

/**
 * T12 -- THE WALK, ROUND TWO: what a `Dirent` does not answer about.
 *
 * `isDirectory()` is false for a symlink TO a directory, so `src/styles ->
 * ../../packages/ui/styles` -- the ordinary monorepo shape -- was neither
 * walked nor counted as a failure: `failed` stayed false and the answer was the
 * empty set, which the parser reads as the positive claim that nothing in this
 * project preserves whitespace. Measured, and asserted here as both halves: the
 * real directory answers `.preserved`, the identical stylesheet behind a
 * symlinked one used to answer nothing, and the move under it then deleted two
 * rendered spaces.
 *
 * The same `else` is why a FIFO named `site.css` was READ: see
 * `theEntryThatIsNotAFile`.
 *
 * AND THE FIX FOR IT WAS A REGRESSION WORSE THAN THE HOLE, which is why the
 * link here now resolves INSIDE the project. Following any directory link at
 * all, with no containment and no bound, on the Electron MAIN process inside
 * `page:write`, is the FIFO failure by another road: one ordinary `src/docs ->
 * ~/Documents` blocks the whole app on every save. The link that matters -- the
 * monorepo `src/styles -> ../../packages/ui/styles` -- resolves back inside the
 * project once the project is the repo, and that is the shape asserted here.
 * The link that leaves is `theLinkOutOfTheProject`.
 */
function theStylesheetBehindASymlink() {
  const rule = '.preserved { white-space: pre; }\n';
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source, inner, raised } = preservedFixture(shape);

  const root = H.makeProject({ [PAGE]: source });
  let real = [];
  let linked = [];
  let text = null;
  try {
    // The shared package the link points at: inside the project, reached only
    // through the link, and out of the way of the walk's own roots -- `..` in
    // the target on purpose, so a containment test that compares written paths
    // rather than resolved ones fails here.
    fs.mkdirSync(path.join(root, 'packages', 'ui', 'styles'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'ui', 'styles', 'shared.css'), rule, 'utf8');
    // PREMISE: the same rule in a real directory in the project is found, so a
    // failure below is about the link and not about the rule.
    WS.forgetCache();
    real = [...WS.preservingTokens(root)];
    fs.rmSync(path.join(root, 'packages'), { recursive: true, force: true });

    // Rebuilt somewhere the walk cannot reach on foot, so the link really is
    // the only way to the rule.
    const hidden = path.join(root, '.vendor', 'ui', 'styles');
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, 'shared.css'), rule, 'utf8');
    // PREMISE: the directory it points at is one the walk skips on its own, so
    // `.preserved` below can only have come through the link.
    WS.forgetCache();
    const withoutLink = [...WS.preservingTokens(root)];
    check(
      '[symlink] the rule is unreachable without the link',
      !withoutLink.includes('.preserved') && !withoutLink.includes('*'),
      short(withoutLink)
    );
    fs.symlinkSync(path.join('..', '.vendor', 'ui', 'styles'), path.join(root, 'src', 'vendored'));
    const entry = fs
      .readdirSync(path.join(root, 'src'), { withFileTypes: true })
      .find((e) => e.name === 'vendored');
    check(
      '[symlink] the fixture really is a link that a Dirent calls no directory',
      !!entry && entry.isSymbolicLink() && entry.isDirectory() === false,
      short({ link: !!entry?.isSymbolicLink?.(), dir: entry?.isDirectory?.() })
    );
    WS.forgetCache();
    const tokens = WS.preservingTokens(root);
    linked = [...tokens];
    text = raiseHeadless(source, 'preserved', tokens);
  } finally {
    H.removeProject(root);
  }
  check('[symlink] the rule is found in a real directory', real.includes('.preserved'), short(real));
  check(
    '[symlink] a link that lands INSIDE the project is walked, not silently dropped',
    linked.includes('.preserved'),
    short(linked)
  );
  check(
    '[symlink] and the move under it keeps the bytes that rule protects',
    !!text && innerOf(text, 'preserved') === inner && raised !== inner,
    short({ want: inner, got: text === null ? null : innerOf(text, 'preserved') })
  );
}

/**
 * T12b -- THE WALK, ROUND FOUR: the link that LEAVES the project, and the bound.
 *
 * Following any directory symlink was added so the monorepo shape above would
 * be scanned, and it was added with no containment and no time bound, running
 * SYNCHRONOUSLY on the Electron main process inside `page:write`. One ordinary
 * link in a project -- `src/docs -> ~/Documents`, `public/assets -> ~/Dropbox`
 * -- then walked somebody's home directory on every save: no repaint, no IPC,
 * the write neither completing nor refusing, which is exactly the FIFO failure
 * this file already has a test for.
 *
 * BOTH ENDS, because either alone is a defect. Not walking out is the fix; not
 * walking out QUIETLY is the `[]` that reads as "nothing in this project
 * preserves whitespace" and deletes rendered bytes -- the same silent skip the
 * unreadable-directory case was written for. So the link out contributes ANY.
 *
 * THE ORACLE FOR THE HANG IS TIME, and it is measured on a tree big enough that
 * walking it is visible and small enough to build: the walk that used to follow
 * the link read every stylesheet under it, and the one that refuses reads none.
 * The claim checked is the one that matters to a user -- the answer arrives,
 * and it is the refusing one -- not a stopwatch threshold that a slow machine
 * would flake on.
 *
 * AND THE BOUND ON ITS OWN, because containment does not cover a project that
 * is simply enormous, or one on a disk that answers slowly. `MAX_ENTRIES` is
 * 20000; a directory holding more than that is walked no further and says ANY.
 */
function theLinkOutOfTheProject() {
  const rule = '.preserved { white-space: pre; }\n';
  const shape = { id: 'two-space', ind: '  ', eol: '\n' };
  const { source, inner, raised } = preservedFixture(shape);

  const root = H.makeProject({ [PAGE]: source });
  const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stacki-elsewhere-'));
  let tokens = null;
  let read = [];
  let text = null;
  try {
    // Somebody's Documents: a hundred stylesheets the project has no business
    // reading, each with a rule in it, so "did the walk go out there" is
    // answerable by which files were opened rather than by a clock.
    fs.mkdirSync(path.join(outside, 'notes'), { recursive: true });
    for (let i = 0; i < 100; i += 1) {
      fs.writeFileSync(path.join(outside, 'notes', `n${i}.css`), rule, 'utf8');
    }
    fs.symlinkSync(outside, path.join(root, 'src', 'docs'));
    const realRead = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (typeof p === 'string') read.push(p);
      return realRead(p, ...rest);
    };
    WS.forgetCache();
    try {
      tokens = WS.preservingTokens(root);
    } finally {
      fs.readFileSync = realRead;
    }
    text = raiseHeadless(source, 'preserved', tokens);
  } finally {
    H.removeProject(root);
    fs.rmSync(outside, { recursive: true, force: true });
  }
  const wentOut = read.filter((p) => p.includes('stacki-elsewhere-') || p.includes(`${path.sep}docs${path.sep}`));
  check(
    '[outside] a link that resolves outside the project is not followed',
    wentOut.length === 0,
    short({ opened: wentOut.slice(0, 3), of: wentOut.length })
  );
  check(
    '[outside] and it contributes ANY rather than being silently skipped',
    !!tokens && tokens.has('*'),
    short(tokens ? [...tokens] : null)
  );
  // AND THE ANY IS LOAD-BEARING: read as the empty set, the move under it
  // deletes two spaces the page renders. This is the same byte oracle the
  // unreadable-directory case uses, on the same fixture.
  check(
    '[outside] and the move under it still keeps the bytes nobody could rule out',
    !!text && innerOf(text, 'preserved') === inner && raised !== inner,
    short({ want: inner, got: text === null ? null : innerOf(text, 'preserved') })
  );

  // --- THE BOUND, with no link in it at all.
  const wide = H.makeProject({});
  const room = path.join(wide, 'src', 'many');
  fs.mkdirSync(room, { recursive: true });
  fs.writeFileSync(path.join(room, 'keeps.css'), rule, 'utf8');
  WS.forgetCache();
  const underCap = [...WS.preservingTokens(wide)];
  for (let i = 0; i < 20100; i += 1) fs.writeFileSync(path.join(room, `f${i}.txt`), '');
  WS.forgetCache();
  const overCap = [...WS.preservingTokens(wide)];
  H.removeProject(wide);
  // PREMISE: under the cap the same tree answers with the rule and no sentinel,
  // so the ANY below is the cap and not something else in the fixture.
  check(
    '[bound] under the entry cap the tree answers with its rule and no sentinel',
    underCap.includes('.preserved') && !underCap.includes('*'),
    short(underCap)
  );
  check(
    '[bound] a tree with more entries than the cap contributes ANY',
    overCap.includes('*'),
    short(overCap)
  );
}

/**
 * T13 -- an entry with a stylesheet's NAME that is not a file at all.
 *
 * The walk classified with `isDirectory()` and an `else`, never `isFile()`, so
 * a FIFO called `site.css` went into the list; `statSync().size` is 0 for one,
 * so the size gate did not fire, and `readFileSync` BLOCKED FOREVER.
 * `preservingTokens` runs synchronously on the Electron MAIN process inside
 * `page:write`, so that is the whole app hung -- no repaint, no IPC, the write
 * neither completing nor refusing. Measured: SIGKILLed after 8s with no answer.
 *
 * Driven in a CHILD process on a deadline, because a synchronous hang in this
 * one cannot be measured from inside it: the suite would hang with it, and
 * `guardSuite`'s own timer would report the hang without naming this as the
 * cause.
 */
function theEntryThatIsNotAFile() {
  const root = H.makeProject({});
  const fifo = path.join(root, 'src', 'styles', 'piped.css');
  let made = false;
  try {
    execFileSync('mkfifo', [fifo], { stdio: 'ignore' });
    made = fs.statSync(fifo).isFIFO();
  } catch {
    made = false;
  }
  if (!check('[not-a-file] the fixture really is a FIFO named like a stylesheet', made, fifo)) {
    H.removeProject(root);
    return;
  }
  const driver = `
    const WS = require(${JSON.stringify(path.resolve(__dirname, '..', 'electron', 'whitespaceRules.js'))});
    WS.forgetCache();
    process.stdout.write(JSON.stringify([...WS.preservingTokens(${JSON.stringify(root)})]));
  `;
  let answered = null;
  let threw = null;
  try {
    answered = execFileSync(process.execPath, ['-e', driver], {
      timeout: 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    threw = err?.signal || err?.code || String(err);
  } finally {
    H.removeProject(root);
  }
  if (
    !check(
      '[not-a-file] the scan answers at all rather than blocking the main process',
      threw === null,
      short({ threw })
    )
  ) {
    return;
  }
  let tokens = null;
  try {
    tokens = JSON.parse(answered);
  } catch {
    tokens = null;
  }
  check(
    '[not-a-file] and an entry it cannot account for contributes ANY',
    Array.isArray(tokens) && tokens.includes('*'),
    short({ answered })
  );
}

/**
 * T14 -- the readback gate throwing the CORRECT bytes away.
 *
 * The relaxation was `run === want || run.replace(/\s+/g, ' ') === want`, which
 * collapses the WHOLE rendered run rather than only where the two texts differ.
 * So the moment a `<pre>` run held whitespace BOTH texts preserved -- a
 * multi-line value inside `<code>` -- the collapse could never equal `want`,
 * the gate refused, and `anchoredSerialize` returned `canonical`: the text that
 * had deleted a rendered newline. Refusing is normally the safe direction; here
 * the refusal's fallback IS the damage.
 *
 * PREMISES FIRST: the reprint really does lose the newline this file has, so a
 * pass below cannot be the two answers agreeing.
 */
function theRunTheReprintCollapsed() {
  const label = '[readback]';
  const body = `  <pre>\n<code>alpha\n  beta</code>\n<span class='tail'>tail</span>\n</pre>\n`;
  const source = commentedPage(body);
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const pre = model.nodes[0].children.find((n) => n.name === 'pre');
  const span = pre?.children?.find((n) => n.name === 'span');
  const word = span?.children?.find((n) => n.kind === 'text');
  if (!check(`${label} the word a plain text edit lands on is there`, !!word, short(pre?.children?.map((n) => n.name)))) return;
  word.value = 'TAIL';
  delete word.source;

  const canonical = serializePage(model);
  const runOf = (text) => {
    const hit = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/.exec(text);
    return hit ? hit[1] : null;
  };
  // PREMISE: the whole-document reprint really is the damaged text here.
  if (
    !check(
      `${label} the reprint really does delete the newlines this file holds`,
      runOf(canonical) === `<code>alpha beta</code> <span class='tail'>TAIL</span>`,
      short({ got: runOf(canonical) })
    )
  ) {
    return;
  }
  const after = anchoredSerialize(source, model);
  check(
    `${label} a run whose whitespace BOTH texts preserved does not refuse the splice`,
    after !== canonical,
    short({ span: changedSpan(canonical, after) })
  );
  check(
    `${label} and the file keeps every rendered byte the edit did not name`,
    after === commentedPage(`  <pre>\n<code>alpha\n  beta</code>\n<span class='tail'>TAIL</span>\n</pre>\n`),
    short({ span: changedSpan(source, after) })
  );
}

/**
 * T14b -- a `remove` that emptied an element and wrote NOTHING to the file.
 *
 * `serializeNode`'s zero-children branch printed `node.source`, the element's
 * inner as the file wrote it. That cache is set for two different elements: one
 * authored empty across lines, and one holding an inline run written across
 * lines. Only the first still has no children. Emptying the second -- removing
 * its last child -- printed the run's own bytes back, so the child was still in
 * the file afterwards and the operation reported success. A no-op write is
 * worse than a refusal, because nothing downstream can tell it apart from a
 * real one.
 *
 * TWO SHAPES, because the defect reaches the file by two roads. `wrapped` puts
 * the child on its own line, so `cutNodeSplice` can lift it out and the anchored
 * write is correct -- the leak is only in the whole-document reprint that is
 * `anchoredSerialize`'s own fallback. `hugging` puts the run against the tags,
 * which the cut refuses, so the reprint IS the write and the emptied `<p>` came
 * back with both children intact. Both are asserted, so a fix that only moved
 * the leak from one road to the other cannot pass.
 *
 * AND THE NARROWING IS ASSERTED TOO. The cache is what makes untouched markup
 * travel byte for byte, so the third check writes an element that really was
 * authored empty across lines and requires its blank line back out of the
 * reprint. A "fix" that simply stopped reading the cache passes the first two
 * checks and fails this one.
 */
function theElementAnEditEmptied() {
  const label = '[emptied]';
  const bodyOf = (text) => {
    const hit = /<Base>\n([\s\S]*)<\/Base>\n$/.exec(text);
    return hit ? hit[1] : null;
  };
  for (const shape of [
    { id: 'wrapped', body: `  <p class='lead'>\n    <strong>Acme</strong>\n  </p>\n`, anchored: `  <p class='lead'>\n  </p>\n` },
    { id: 'hugging', body: `  <p class='lead'>Hello\n    <strong>Acme</strong></p>\n`, anchored: `  <p class='lead'></p>\n` },
  ]) {
    const source = commentedPage(shape.body);
    const parsed = parsePage(source);
    if (!check(`${label} ${shape.id} parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const p = model.nodes[0].children.find((n) => n.name === 'p');
    // PREMISE: the element really is one the parser cached as-written, and it
    // really does hold the child the edit is about to take out. Without this a
    // green below could be a fixture the defect never applied to.
    if (
      !check(
        `${label} ${shape.id} the element carries an as-written cache of the run it holds`,
        typeof p?.source === 'string' && p.source.includes('<strong>') && (p.children || []).length > 0,
        short({ source: p?.source, children: (p?.children || []).map((n) => n.kind + (n.name ? `:${n.name}` : '')) })
      )
    ) {
      continue;
    }
    p.children = [];

    const canonical = serializePage(model);
    check(
      `${label} ${shape.id} the whole-document reprint does not put the removed child back`,
      bodyOf(canonical) === `  <p class='lead'></p>\n`,
      short({ got: bodyOf(canonical) })
    );
    const after = anchoredSerialize(source, model);
    check(
      `${label} ${shape.id} and neither does the write that lands on disk`,
      after === commentedPage(shape.anchored),
      short({ span: changedSpan(source, after) })
    );
    check(
      `${label} ${shape.id} the removed child is gone from the file by every spelling`,
      !after.includes('Acme') && !after.includes('<strong'),
      short({ after })
    );
  }

  // THE NARROWING. An element the author wrote empty across lines still comes
  // back exactly as authored, blank line and all, through the same branch.
  const held = `  <div class='slot'>\n\n  </div>\n  <p>x</p>\n`;
  const parsedEmpty = parsePage(commentedPage(held));
  if (check(`${label} a page with an element authored empty parses`, parsedEmpty.editable === true, short(parsedEmpty.reason))) {
    const div = parsedEmpty.model.nodes[0].children.find((n) => n.name === 'div');
    check(
      `${label} an element authored empty across lines carries the cache`,
      typeof div?.source === 'string' && div.source.includes('\n') && (div.children || []).length === 0,
      short({ source: div?.source })
    );
    const reprint = serializePage(structuredClone(parsedEmpty.model));
    check(
      `${label} and it reprints byte for byte, its blank line included`,
      bodyOf(reprint) === held,
      short({ got: bodyOf(reprint) })
    );
  }
}

/**
 * T15 -- `replaceNodeSplice` reprinting a preserving element from the model.
 *
 * When the node whose span is replaced is ITSELF preserving, reprinting its
 * subtree writes back a `<pre>` whose inter-element newlines the model no
 * longer holds -- `parsePage` collapses them into a text node's `value` and
 * parks the bytes in an as-written cache the printer does not read. Measured on
 * a reorder of two `<span>`s inside a `<pre>` written across lines: the whole
 * block came back on ONE LINE, THE SPLICE wrote it (there was no fallback), and
 * the readback gate passed it because `canonical` had collapsed the same run
 * the same way. `printNode` has four guards for this; this branch had none, and
 * its comment declines to consult `ctx.preserving` -- which is right, and is
 * about a TWIN being the wrong node rather than about the node itself.
 *
 * THE ORACLE IS THE WHOLE FILE, byte for byte, because the fallback here is
 * equally damaged: an oracle that only asked "is this not the reprint" would
 * pass on the reprint's own bytes arriving by another road.
 */
function theReorderInsideAPre() {
  const label = '[reorder in pre]';
  const body = `  <pre>\n<span class='a'>alpha\n  beta</span>\n<span class='b'>tail</span>\n</pre>\n`;
  const source = commentedPage(body);
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const pre = model.nodes[0].children.find((n) => n.name === 'pre');
  const kids = pre?.children || [];
  const at = (cls) => kids.findIndex((n) => n.props?.class?.value === cls);
  const ia = at('a');
  const ib = at('b');
  if (!check(`${label} both spans are where a reorder can reach them`, ia >= 0 && ib >= 0, short(kids.map((n) => n.name)))) return;
  const swap = kids[ia];
  kids[ia] = kids[ib];
  kids[ib] = swap;

  const canonical = serializePage(model);
  // PREMISE: the reprint is not the answer here either, so "not the reprint"
  // would be a weaker oracle than the bytes.
  check(
    `${label} the whole-document reprint collapses the block onto one line`,
    /<pre>[^\n]*<\/pre>/.test(canonical),
    short({ got: /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/.exec(canonical)?.[1] })
  );
  const after = anchoredSerialize(source, model);
  check(
    `${label} the two spans really did swap`,
    /<span class='b'>tail<\/span>[\s\S]*<span class='a'>alpha/.test(after),
    short({ span: changedSpan(source, after) })
  );
  check(
    `${label} and every gap the file wrote is still in it, byte for byte`,
    after === commentedPage(`  <pre>\n<span class='b'>tail</span>\n<span class='a'>alpha\n  beta</span>\n</pre>\n`),
    short({ span: changedSpan(source, after) })
  );
}

/**
 * T15b -- THE SAME REORDER, ONE SHAPE ALONG, WHERE THE FIX ABOVE COULD NOT RUN.
 *
 * `reorderedInPlace` is reached from `replaceNodeSplice`, and `nodeSplices`
 * reaches `replaceNodeSplice` only when the DESCENT came back null. T15's spans
 * are a shape the descent refuses. Block-laid-out children are not: the moment
 * `alignChildren` can pair them up, `nodeSplices` returns `deeper` and the
 * preserving branch below it is dead code for the whole shape.
 *
 * So the reorder went out through the child splices instead, and those write
 * the layout AROUND each child. Inside a preserving element `indentIsContent`
 * is deliberately true and `rangeSplice` deliberately writes no indent -- right
 * for a node being INSERTED, wrong for one whose indentation is already in the
 * file and is rendered content. Measured before the fix on this exact fixture:
 * the moved `<p>` came back at COLUMN ZERO, six rendered spaces gone, `ok`, no
 * fallback, nothing downstream noticing.
 *
 * THE ORACLE IS THE WHOLE FILE, byte for byte, for T15's reason: the fallback
 * reprint is damaged too, so "not the reprint" would pass on the same bytes
 * arriving by another road. And the four shapes are run because the defect is
 * about the DESCENT succeeding, which depends on whether the children's heads
 * match -- two `<p>`s with the same head descend one way, two `<div>`s with
 * different classes another, and both were damaged.
 */
function theReorderOfBlockChildrenInsideAPre() {
  const shapes = [
    { id: 'same head', ind: '      ', a: `<p>alpha</p>`, b: `<p>beta</p>` },
    { id: 'different class', ind: '  ', a: `<div class='a'>alpha\n    one</div>`, b: `<div class='b'>beta\n    two</div>` },
    { id: 'no indent at all', ind: '', a: `<div>alpha\n    one</div>`, b: `<div>beta\n    two</div>` },
    { id: 'textarea', ind: '    ', a: `<p>alpha</p>`, b: `<p class='b'>beta</p>`, tag: 'textarea' },
  ];
  for (const shape of shapes) {
    const label = `[reorder blocks in pre/${shape.id}]`;
    const tag = shape.tag || 'pre';
    const body = `  <${tag}>\n${shape.ind}${shape.a}\n${shape.ind}${shape.b}\n</${tag}>\n`;
    const source = commentedPage(body);
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const box = model.nodes[0].children.find((n) => n.name === tag);
    const kids = box?.children || [];
    // The gap between two children arrives as a whitespace-only text node or as
    // nothing at all, depending on whether the run reads as inline. Either way
    // it is the file's own bytes and it stays where it is; what swaps is the
    // two nodes that are not it.
    const real = kids.map((n, i) => [n, i]).filter(([n]) => !(n.kind === 'text' && !String(n.value ?? '').trim()));
    if (!check(`${label} both children are where a reorder can reach them`, real.length === 2, short(kids.map((n) => n.kind + ':' + n.name)))) {
      continue;
    }
    // PREMISE: the element really is one whose inner whitespace is rendered
    // content, which is what makes the deleted indent a deleted glyph rather
    // than a cosmetic change.
    check(`${label} the container is a whitespace-preserving tag`, tag === 'pre' || tag === 'textarea', tag);
    const [ia, ib] = real.map(([, i]) => i);
    const swap = kids[ia];
    kids[ia] = kids[ib];
    kids[ib] = swap;
    const after = anchoredSerialize(source, model);
    const want = commentedPage(`  <${tag}>\n${shape.ind}${shape.b}\n${shape.ind}${shape.a}\n</${tag}>\n`);
    if (
      !check(
        `${label} the two children really did swap`,
        after.indexOf(shape.b.split('\n')[0]) < after.indexOf(shape.a.split('\n')[0]),
        short({ span: changedSpan(source, after) })
      )
    ) {
      continue;
    }
    check(
      `${label} and every rendered space the file wrote is still in it, byte for byte`,
      after === want,
      short({ span: changedSpan(want, after) })
    );
  }
}

/**
 * T15c -- A REORDER COMBINED WITH AN INSERT OR A DELETE IS STILL A REORDER.
 *
 * T15b fixed a PURE permutation of a preserving element's children by asking
 * `reorderedInPlace` before the descent. That function answered only a pure
 * permutation and returned null for everything else, so a reorder that ALSO
 * added or dropped a sibling fell straight back through to the child splices --
 * and those write the layout AROUND each child, which inside a preserving
 * element is no indent at all. The child that merely MOVED then landed at
 * COLUMN ZERO, with `ok` and no fallback. Measured before the fix, on
 * `<pre>\n      <p>alpha</p>\n      <p>beta</p>\n      <p>gamma</p>\n</pre>`:
 *
 *   [beta, alpha, gamma, +delta] -> `<pre>\n      <p>beta</p>\n<p>alpha</p>\n      <p>gamma</p>\n<p>delta</p>\n</pre>`
 *   [gamma, alpha], beta dropped -> `<pre>\n      <p>gamma</p>\n<p>alpha</p>\n</pre>`
 *
 * Six rendered spaces deleted from a node the edit only asked to MOVE, in a
 * file the caller was told had been written successfully.
 *
 * THE ORACLE IS THE WHOLE FILE, byte for byte, for T15's reason: the fallback
 * reprint is damaged too -- `serializePage` re-lays a `<pre>`'s element
 * children out and the block comes back on one line -- so "not the reprint"
 * would pass on the same damage arriving by another road.
 *
 * THE ORACLE IS ALSO A RULE RATHER THAN A TABLE OF STRINGS, and the rule is the
 * one the fix is stated in: a child THE FILE ALREADY HOLDS contributes its own
 * authored indent, and a child that is genuinely NEW contributes the indent
 * this code is allowed to decide -- nothing inside a preserving element, the
 * sibling's own indent everywhere else. `PLAIN` is the row that keeps the
 * second half honest: an ordinary `<div>` must still indent everything,
 * including the node that moved, so a fix that simply stopped writing indents
 * cannot pass this.
 *
 * And the cascaded row ties this to T18: an element whose preserving
 * declaration is only reachable by reading the cascade in order has to reach
 * every one of these decisions too, not just the one T18 measures.
 */
const REORDER_SHAPES = [
  { id: '<pre>', open: '<pre>', close: '</pre>', tag: 'pre', ind: '      ', closeInd: '', preserved: true },
  { id: '<textarea>', open: '<textarea>', close: '</textarea>', tag: 'textarea', ind: '    ', closeInd: '', preserved: true },
  { id: "style='white-space: pre'", open: "<div style='white-space: pre'>", close: '</div>', tag: 'div', ind: '      ', closeInd: '  ', preserved: true },
  { id: 'cascaded style', open: "<div style='white-space: normal; white-space: pre'>", close: '</div>', tag: 'div', ind: '      ', closeInd: '  ', preserved: true },
  { id: "class='plain'", open: "<div class='plain'>", close: '</div>', tag: 'div', ind: '    ', closeInd: '  ', preserved: false },
  // THE ROW WHERE THE TWO WHITESPACE FLAGS POINT OPPOSITE WAYS, which is the
  // only place the indent this code decides is read off the ACTING flag rather
  // than off the branch that got here. A project whose stylesheet scan shrugged
  // puts every element in `preserves` -- so the reorder path runs at all -- and
  // nothing in `rendersIndent`, so a node it inserts must still be written at
  // the file's own indent. Bytes identical to the plain row above, reached by a
  // different road: writing column zero because the scanner could not answer is
  // how one unparseable stylesheet de-indented every page saved after it.
  {
    id: 'unproven project',
    open: "<div class='plain'>",
    close: '</div>',
    tag: 'div',
    ind: '    ',
    closeInd: '  ',
    preserved: false,
    tokens: new Set(['*']),
  },
];

// Each entry is the child list the model is left holding, written as the
// authored children's own names plus `+delta` for one the file has never seen.
const REORDER_ORDERS = [
  { id: 'reorder + insert at the end', want: ['beta', 'alpha', 'gamma', '+delta'] },
  { id: 'reorder + insert at the front', want: ['+delta', 'beta', 'alpha', 'gamma'] },
  { id: 'reorder + insert in the middle', want: ['beta', '+delta', 'alpha', 'gamma'] },
  { id: 'reorder + delete', want: ['gamma', 'alpha'] },
  { id: 'reorder + delete + insert', want: ['gamma', '+delta', 'alpha'] },
  // The control T15b already owns, run here on the same builder so a fix that
  // answers the new shapes by dropping the old one cannot hide.
  { id: 'pure reorder', want: ['beta', 'alpha', 'gamma'] },
];

function theReorderThatAlsoAddsOrRemovesAChild() {
  for (const shape of REORDER_SHAPES) {
    const authored = ['alpha', 'beta', 'gamma'];
    const body =
      `  ${shape.open}\n` +
      authored.map((name) => `${shape.ind}<p>${name}</p>\n`).join('') +
      `${shape.closeInd}${shape.close}\n`;
    const source = commentedPage(body);
    for (const order of REORDER_ORDERS) {
      const label = `[${order.id}/${shape.id}]`;
      const parsed = parsePage(source);
      if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
      const model = structuredClone(parsed.model);
      const box = model.nodes[0].children.find((n) => n.name === shape.tag);
      if (!check(`${label} the element is where a reorder can reach it`, !!box, short(model.nodes[0].children.map((n) => n.name)))) {
        continue;
      }
      // The gap between two children arrives as a whitespace-only text node or
      // as nothing at all; either way it is the file's bytes and not a child
      // any operation names.
      const real = (box.children || []).filter((n) => !(n.kind === 'text' && !String(n.value ?? '').trim()));
      const named = (name) => real.find((n) => n.children?.[0]?.value === name);
      if (!check(`${label} all three children are addressable`, authored.every(named), short(real.map((n) => n.children?.[0]?.value)))) {
        continue;
      }
      box.children = order.want.map((name) =>
        name.startsWith('+')
          ? { kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: name.slice(1) }] }
          : named(name)
      );
      const after = anchoredSerialize(source, model, shape.tokens ? { preservingTokens: shape.tokens } : {});
      // A NEW child has no authored bytes, so its indent is the one decision
      // this code may make; every other child keeps the one the file gave it.
      const want = commentedPage(
        `  ${shape.open}\n` +
          order.want
            .map((name) => `${shape.preserved && name.startsWith('+') ? '' : shape.ind}<p>${name.replace('+', '')}</p>\n`)
            .join('') +
          `${shape.closeInd}${shape.close}\n`
      );
      // POSITIVE CONTROL: the operation really happened, so a write that
      // changed nothing at all cannot read as a pass.
      if (
        !check(
          `${label} the children really are in the order the model asked for`,
          order.want.map((n) => n.replace('+', '')).join(',') ===
            (after.match(/<p>(\w+)<\/p>/g) || []).map((m) => /<p>(\w+)<\/p>/.exec(m)[1]).join(','),
          short({ span: changedSpan(source, after) })
        )
      ) {
        continue;
      }
      check(
        shape.preserved
          ? `${label} every child the file already held keeps its own authored indent`
          : `${label} an ordinary element still indents all of them`,
        after === want,
        short({ span: changedSpan(want, after) })
      );
    }
  }
}

/**
 * T15e -- A REORDER THAT ALSO EDITS ONE OF THE CHILDREN.
 *
 * T15c stated the rule as "a child THE FILE ALREADY HOLDS keeps its own authored
 * leading bytes", and then answered a narrower question than the rule, because
 * `ctx.twin` is a search BY MEANING and an edited child no longer means what any
 * base node means. So the reorder path read the edited child as NEW and wrote it
 * at the indent it is allowed to decide for one -- which inside a preserving
 * element is column zero. Measured on
 * `<pre>\n      <p>alpha</p>\n      <p>beta</p>\n      <p>gamma</p>\n</pre>`,
 * against electron/astroParser.js at c4a4b39:
 *
 *   [beta, alpha, GAMMA]        -> `\n      <p>beta</p>\n      <p>alpha</p>\n<p>GAMMA</p>\n`
 *   [BETA, alpha, gamma]        -> `\n<p>BETA</p>\n      <p>alpha</p>\n      <p>gamma</p>\n`
 *   [beta, alpha, gamma+class]  -> the same, on a `set_prop` that touched no text
 *
 * Six rendered spaces deleted from a node the edit asked only to move or to
 * retitle, `ok`, no fallback. And the second of those had a second cause worth
 * naming separately: the "did anything move" test was asked of the MEANING
 * matches alone, and `[BETA, alpha, gamma]` matches only `alpha` and `gamma`,
 * whose file positions are 0 then 2 and so read as standing still. The reorder
 * path was skipped entirely and the child splices did the damage.
 *
 * WHAT THE FIX HAD TO BE, and what these rows exist to hold it to: an identity
 * rather than a resemblance. Pairing the leftover children up by position is a
 * guess -- a delete plus an insert leaves exactly the same leftovers as an edit
 * -- and it hands a brand-new child some deleted node's rendered spaces.
 * `parsePage` numbers what it builds `n<counter>` and the editor numbers what it
 * builds `c<counter>`, so the node itself says whether it was ever in the file;
 * the constant offset between the two parses' counters, agreed by every sibling
 * already matched, says WHICH child it was.
 *
 * THE ORACLE IS THE WHOLE FILE for T15's reason: the fallback reprint is damaged
 * too, so "not the reprint" would pass on the same damage arriving by another road.
 *
 * AND THE ORDINARY ROWS ARE NOT DECORATION. `class='plain'` must still reindent
 * every child including the edited one, so a fix that answers these rows by
 * writing no indent at all cannot pass; the `unproven project` row must write
 * the file's own indent for the NEW child while the edited one keeps its own, so
 * a fix that treats "recovered" and "decided" as one answer cannot pass either.
 */
const REORDER_EDIT_ORDERS = [
  { id: 'reorder + edit a child that stayed', want: ['beta', 'alpha', '*gamma'] },
  { id: 'reorder + edit the child that moved', want: ['*beta', 'alpha', 'gamma'] },
  { id: 'reorder + edit + insert', want: ['beta', '*alpha', '+delta', 'gamma'] },
  { id: 'reorder + edit + delete', want: ['*gamma', 'alpha'] },
  { id: 'reorder + edit two of them', want: ['*gamma', '*beta', 'alpha'] },
  { id: 'reorder + set_prop', want: ['beta', 'alpha', '@gamma'] },
];

// How one entry of the tables above reads back out of the file. `*` is a child
// whose text was edited, `@` one whose props were, `+` one the file has never
// seen; anything else is a child exactly as it was authored.
const editedName = (nm) => (nm[0] === '*' ? nm.slice(1).toUpperCase() : nm.replace(/^[@+]/, ''));
// A prop the file never held has no `attrSource` to spell it with, so the
// reprint writes the serializer's own quotes -- which is a change to the node
// the edit DID name, and not the leading bytes this fixture is about.
const editedMarkup = (nm) =>
  nm[0] === '@' ? `<p class="x">${nm.slice(1)}</p>` : `<p>${editedName(nm)}</p>`;

/** The child list an order asks for, built out of a parsed element's own nodes. */
function childrenFor(want, named) {
  return want.map((nm) => {
    if (nm[0] === '+') {
      return { kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: nm.slice(1) }] };
    }
    const node = named(nm.replace(/^[*@]/, ''));
    if (nm[0] === '*') node.children[0].value = nm.slice(1).toUpperCase();
    if (nm[0] === '@') node.props = { class: { type: 'string', value: 'x' } };
    return node;
  });
}

function theReorderThatAlsoEditsAChild() {
  for (const shape of REORDER_SHAPES) {
    const authored = ['alpha', 'beta', 'gamma'];
    const body =
      `  ${shape.open}\n` +
      authored.map((name) => `${shape.ind}<p>${name}</p>\n`).join('') +
      `${shape.closeInd}${shape.close}\n`;
    const source = commentedPage(body);
    for (const order of REORDER_EDIT_ORDERS) {
      const label = `[${order.id}/${shape.id}]`;
      const parsed = parsePage(source);
      if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
      const model = structuredClone(parsed.model);
      const box = model.nodes[0].children.find((n) => n.name === shape.tag);
      if (!check(`${label} the element is where a reorder can reach it`, !!box, short(model.nodes[0].children.map((n) => n.name)))) {
        continue;
      }
      const real = (box.children || []).filter((n) => !(n.kind === 'text' && !String(n.value ?? '').trim()));
      const named = (name) => real.find((n) => n.children?.[0]?.value === name);
      if (!check(`${label} all three children are addressable`, authored.every(named), short(real.map((n) => n.children?.[0]?.value)))) {
        continue;
      }
      // PREMISE: the model really does carry the parse's own numbering, which is
      // the whole basis of the identity the fix uses. A fixture that handed in
      // freshly-built nodes would be measuring nothing.
      check(
        `${label} the authored children carry the ids the parse gave them`,
        real.every((n) => /^n\d+$/.test(n.id || '')),
        short(real.map((n) => n.id))
      );
      box.children = childrenFor(order.want, named);
      const after = anchoredSerialize(source, model, shape.tokens ? { preservingTokens: shape.tokens } : {});
      // A NEW child has no authored bytes, so its indent is the one decision
      // this code may make; every child the file already held -- edited or not
      // -- keeps the one the file gave it.
      const want = commentedPage(
        `  ${shape.open}\n` +
          order.want
            .map((nm) => `${shape.preserved && nm[0] === '+' ? '' : shape.ind}${editedMarkup(nm)}\n`)
            .join('') +
          `${shape.closeInd}${shape.close}\n`
      );
      // POSITIVE CONTROL: the edit really happened, so a write that changed
      // nothing at all cannot read as a pass.
      if (
        !check(
          `${label} the children really are what the model asked for`,
          order.want.map(editedName).join(',') ===
            (after.match(/<p[^>]*>(\w+)<\/p>/g) || []).map((m) => /<p[^>]*>(\w+)<\/p>/.exec(m)[1]).join(','),
          short({ span: changedSpan(source, after) })
        )
      ) {
        continue;
      }
      check(
        shape.preserved
          ? `${label} the edited child keeps the leading bytes the file gave it`
          : `${label} an ordinary element still indents all of them`,
        after === want,
        short({ span: changedSpan(want, after) })
      );
    }
  }
}

/**
 * T15f -- AND THE CHILD'S OWN BYTES RATHER THAN A NEIGHBOUR'S.
 *
 * Every row above is written at ONE indent, so a fix that recovers "the indent
 * this element's children are written at" passes all of them while still not
 * knowing which child it is holding. That is the guess the fix had to refuse:
 * inside a `<pre>` the leading spaces are glyphs, and writing two of them in
 * front of a node the author gave six is a rendered change nothing asked for.
 *
 * So this file indents its three children DIFFERENTLY -- two spaces, six, none
 * -- and the oracle is each child's own lead following it through the reorder.
 * A positional pairing of the leftovers gets the third row wrong, a uniform
 * indent gets every row wrong, and only an identity gets them all.
 *
 * The last two rows are the other direction, and they are what stops the fix
 * from becoming "give every unmatched child some authored lead": a child the
 * EDITOR built has no bytes in this file, and a child dragged in from the
 * `<div>` next door has bytes that are not this element's. Both must land at the
 * indent this code is allowed to decide, which inside a `<pre>` is column zero.
 */
function theEditedChildTheFileIndentedDifferently() {
  const RAG = ['  ', '      ', ''];
  const authored = ['alpha', 'beta', 'gamma'];
  const lead = (name) => RAG[authored.indexOf(name)];
  const body =
    `  <pre>\n` +
    authored.map((name, i) => `${RAG[i]}<p>${name}</p>\n`).join('') +
    `</pre>\n  <div>\n    <p>outside</p>\n  </div>\n`;
  const source = commentedPage(body);

  const ROWS = [
    { id: 'edit the last one', want: ['beta', 'alpha', '*gamma'] },
    { id: 'edit the first one', want: ['*alpha', 'gamma', 'beta'] },
    { id: 'edit and drop a sibling', want: ['*gamma', 'alpha'] },
    { id: 'edit two of three', want: ['*gamma', '*alpha', 'beta'] },
    { id: 'a child the editor built', want: ['beta', 'alpha', '+delta', 'gamma'], fresh: ['delta'] },
    // THE TWO COUNTERS ARE NOT ONE COUNTER, and this is the row that makes the
    // prefix load-bearing rather than decorative. `newId` in src/modelOps.js
    // counts `c1, c2, ...` from its own zero while `makeId` here counts
    // `n1, n2, ...` from its, so a node the editor built genuinely can wear the
    // same NUMBER as a node the parse built -- and a match that read the number
    // without the letter would hand a brand-new child some authored sibling's
    // rendered spaces. `collide` gives it exactly that number -- and the number
    // belongs to the child this row DROPS, so the anchor it would land on is
    // free and the six spaces it would steal are not column zero.
    { id: 'an editor-built child wearing a parse number', want: ['gamma', 'alpha', '+delta'], fresh: ['delta'], collide: 'beta' },
    { id: 'a child from the div next door', want: ['beta', 'alpha', '^outside', 'gamma'], fresh: ['OUTSIDE'] },
  ];

  for (const row of ROWS) {
    const label = `[ragged pre/${row.id}]`;
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const box = model.nodes[0].children.find((n) => n.name === 'pre');
    const div = model.nodes[0].children.find((n) => n.name === 'div');
    if (!check(`${label} both elements are reachable`, !!box && !!div, short({ box: !!box, div: !!div }))) continue;
    const real = (box.children || []).filter((n) => !(n.kind === 'text' && !String(n.value ?? '').trim()));
    const named = (name) => real.find((n) => n.children?.[0]?.value === name);
    // PREMISE: the file really does give its three children three different
    // leads, which is what makes a neighbour's bytes the wrong answer rather
    // than an indistinguishable one.
    check(
      `${label} the file wrote three different leading runs`,
      new Set(RAG).size === 3 && authored.every((n) => source.includes(`\n${lead(n)}<p>${n}</p>`)),
      short(RAG)
    );
    const outside = (div.children || []).find((n) => n.name === 'p');
    box.children = row.want.map((nm) => {
      if (nm[0] === '^') {
        div.children = (div.children || []).filter((n) => n !== outside);
        outside.children[0].value = 'OUTSIDE';
        return outside;
      }
      const built = childrenFor([nm], named)[0];
      // The editor's own numbering, and where asked for it, the number an
      // authored sibling is already wearing under the other letter.
      if (nm[0] === '+') built.id = `c${row.collide ? /^n(\d+)$/.exec(named(row.collide).id)[1] : 1}`;
      return built;
    });
    if (row.collide) {
      check(
        `${label} the built child really does collide with ${row.collide}'s number`,
        box.children.some((n) => n.id === `c${/^n(\d+)$/.exec(named(row.collide).id)[1]}`),
        short(box.children.map((n) => n.id))
      );
    }
    const after = anchoredSerialize(source, model);
    const want = commentedPage(
      `  <pre>\n` +
        row.want
          .map((nm) =>
            nm[0] === '+' || nm[0] === '^'
              ? `<p>${nm[0] === '^' ? 'OUTSIDE' : nm.slice(1)}</p>\n`
              : `${lead(nm.replace(/^[*@]/, ''))}${editedMarkup(nm)}\n`
          )
          .join('') +
        `</pre>\n  <div>\n${row.id.includes('div next door') ? '' : '    <p>outside</p>\n'}  </div>\n`
    );
    if (
      !check(
        `${label} the edit really happened`,
        after !== source && (row.fresh || []).every((w) => after.includes(`<p>${w}</p>`)),
        short({ span: changedSpan(source, after) })
      )
    ) {
      continue;
    }
    check(`${label} every child kept the leading bytes the file gave IT`, after === want, short({ span: changedSpan(want, after) }));
  }
}

/**
 * T15g -- A MODEL TWO PARSES NUMBERED, AND THE OFFSET THAT THEREFORE MEANS
 * NOTHING.
 *
 * The identity is an OFFSET, not a handle: both trees came out of the same walk
 * over the same bytes, so `baseId - modelId` is one constant, and every child
 * this element has already matched by meaning has to agree on it. That
 * agreement is the whole of the safety, so this drives the case where it fails.
 *
 * A model whose nodes were numbered by more than one parse is not a hypothesis.
 * `resolveChunks` splices the nodes of another FILE into a page's model in
 * electron/main.js, and those carry that file's numbering; a caller that
 * assembles a model out of two parses gets the same shape. This fixture makes
 * one directly, by giving a matched child the number one of its siblings wears,
 * because the point is what the parser does when the arithmetic stops meaning
 * anything -- not how the model came to be that way.
 *
 * WHAT MUST HAPPEN IS THAT NOTHING IS INVENTED. With the numbering split, the
 * offset the first matched pair reports maps the edited child onto the WRONG
 * anchor -- the dropped `<p>gamma</p>`, four authored spaces the edited node
 * never had -- and the file would come back with four rendered spaces nobody
 * wrote. Refusing to recover writes the indent this code is allowed to decide,
 * which inside a `<pre>` is column zero, and that is exactly what the edited
 * child was authored with. Trusting one pair rather than requiring agreement is
 * a one-word change, and it makes this file wrong.
 */
const TWO_PARSE_ROWS = [
  // THE OFFSET DISAGREES. A child that is still MATCHED carries a number from
  // somewhere else, so the pairs report two different offsets and none of them
  // can be believed. Trusting the first one maps the edited `<p>kappa</p>` onto
  // the dropped `<p>gamma</p>` and writes gamma's four spaces in front of it.
  {
    id: 'a matched child numbered by another parse',
    rag: { alpha: '  ', beta: '      ', gamma: '    ', kappa: '' },
    renumber: ['beta', 'gamma'],
    edit: 'kappa',
    want: ['*kappa', 'beta', 'alpha'],
  },
  // THE ANCHOR IS ALREADY SPOKEN FOR. Here the offset is perfectly consistent
  // -- only the EDITED child wears a number that is not its own -- so the
  // arithmetic answers, and it answers with a child of this element that
  // another child is already being written from. Believing it would put
  // `<p>beta</p>`'s six rendered spaces in front of `<p>GAMMA</p>` and leave
  // beta wearing them too.
  {
    id: 'the edited child wearing a sibling number',
    rag: { alpha: '  ', beta: '      ', gamma: '', kappa: '    ' },
    renumber: ['gamma', 'beta'],
    edit: 'gamma',
    want: ['*gamma', 'beta', 'alpha'],
  },
];

function theModelNumberedByTwoParses() {
  for (const row of TWO_PARSE_ROWS) {
    const label = `[two parses numbered this model/${row.id}]`;
    const authored = ['alpha', 'beta', 'gamma', 'kappa'];
    const body = `  <pre>\n` + authored.map((n) => `${row.rag[n]}<p>${n}</p>\n`).join('') + `</pre>\n`;
    const source = commentedPage(body);
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const box = model.nodes[0].children.find((n) => n.name === 'pre');
    const real = (box.children || []).filter((n) => !(n.kind === 'text' && !String(n.value ?? '').trim()));
    const named = (name) => real.find((n) => n.children?.[0]?.value === name);
    if (!check(`${label} all four children are addressable`, authored.every(named), short(real.map((n) => n.id)))) continue;

    // PREMISE: one parse numbered them, and after this line two did. The child
    // keeps its meaning and its bytes -- only its number moves -- so the twin
    // lookup still finds whatever it found before.
    const [takes, from] = row.renumber;
    const before = named(takes).id;
    named(takes).id = named(from).id;
    check(
      `${label} two of the children now wear one number`,
      named(takes).id !== before && named(takes).id === named(from).id,
      short({ before, now: named(takes).id })
    );
    // The nodes are picked out by the words the file wrote before the edit
    // rewrites one of them.
    const picked = row.want.map((nm) => named(nm.replace('*', '')));
    named(row.edit).children[0].value = row.edit.toUpperCase();
    box.children = picked;
    const after = anchoredSerialize(source, model);
    // PREMISE: the edited child's own lead is the one this code would write for
    // a child it had never seen, so "refuse to recover" and "get it right" are
    // the same bytes here -- and the only way to fail this row is to write some
    // OTHER child's rendered spaces.
    check(`${label} the edited child was authored at column zero`, row.rag[row.edit] === '', short(row.rag));
    const want = commentedPage(
      `  <pre>\n` +
        row.want.map((nm) => `${row.rag[nm.replace('*', '')]}<p>${nm[0] === '*' ? nm.slice(1).toUpperCase() : nm}</p>\n`).join('') +
        `</pre>\n`
    );
    const dropped = authored.filter((n) => !row.want.some((nm) => nm.replace('*', '') === n));
    if (
      !check(
        `${label} the reorder and the edit really happened`,
        after.includes(`<p>${row.edit.toUpperCase()}</p>`) && dropped.every((n) => !after.includes(`<p>${n}</p>`)),
        short({ span: changedSpan(source, after) })
      )
    ) {
      continue;
    }
    check(
      `${label} no child was handed a lead that could not be proved to be its own`,
      after === want,
      short({ span: changedSpan(want, after) })
    );
  }
}

/**
 * T15d -- AND THE SHAPE THE REORDER PATH MUST HAND BACK.
 *
 * The generalised reorder can place a NEW child only where the file gave every
 * child a line of its own. Inside an INLINE RUN the gaps are text nodes the
 * MODEL holds rather than bytes between anchors, so a break written where the
 * model has no text node produces a tree `saysWhatTheModelSaid` does not
 * recognise -- and a splice that fails the readback does not fall back to the
 * older splice, it falls back to REPRINTING THE DOCUMENT. Measured: a swap of
 * two `<span>`s inside a `<pre>` with a third appended came back with
 * `// Component imports` torn off the import it annotates, on an edit that
 * named neither the frontmatter nor the comment.
 *
 * WHAT THIS CHECKS IS THE BLAST RADIUS, NOT THE `<pre>`. The `<pre>`'s own
 * bytes are collapsed here either way, by the older inline-run limitation
 * `movedIntoAPresInlineRun` is about -- `serializePage` re-lays the run out and
 * `preservedRun` is the splice that owns that shape. What the reorder path owes
 * this fixture is that it does not make things worse by dragging the whole file
 * through the reprint, so the oracle is every byte the `<pre>` is not.
 */
function theReorderBesideAnInlineRun() {
  const label = '[reorder + append in an inline run]';
  const body = `  <pre>\n<span class='a'>alpha\n  beta</span>\n<span class='b'>tail</span>\n</pre>\n`;
  const source = commentedPage(body);
  const parsed = parsePage(source);
  if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const pre = model.nodes[0].children.find((n) => n.name === 'pre');
  const kids = pre?.children || [];
  const ia = kids.findIndex((n) => n.props?.class?.value === 'a');
  const ib = kids.findIndex((n) => n.props?.class?.value === 'b');
  if (!check(`${label} both spans are where a reorder can reach them`, ia >= 0 && ib >= 0, short(kids.map((n) => n.name)))) return;
  const swap = kids[ia];
  kids[ia] = kids[ib];
  kids[ib] = swap;
  kids.push({
    kind: 'element',
    name: 'span',
    props: { class: { type: 'string', value: 'c' } },
    children: [{ kind: 'text', value: 'new' }],
  });
  const after = anchoredSerialize(source, model);
  if (!check(`${label} the third span really was appended`, after.includes('new</span>'), short({ span: changedSpan(source, after) }))) return;
  const head = source.slice(0, source.indexOf('---\n<Base>'));
  check(
    `${label} the frontmatter comments stay on the imports they annotate`,
    after.startsWith(head),
    short({ want: head, got: after.slice(0, head.length) })
  );
  check(
    `${label} and nothing outside the <pre> is rewritten`,
    after.slice(after.indexOf('</pre>')) === '</pre>\n</Base>\n',
    short({ got: after.slice(after.indexOf('</pre>')) })
  );
}

/**
 * T18 -- INLINE CSS READ WITHOUT CASCADE ORDER.
 *
 * `ownWhitespaceRule` tested the DROPPING regex first and both regexes matched
 * anywhere in the `style` attribute, so nothing here read declaration order at
 * all. `style='white-space: normal; white-space: pre'` -- computed `pre` in
 * every browser, because a later declaration of the same property wins -- was
 * treated as NOT preserving in both directions at once:
 *
 *   * the ACTING flag said the element does not render its children's indent,
 *     so an insert into it was written at the sibling's indent -- SIX SPACES of
 *     rendered content in front of a node the caller only asked to add, with
 *     `ok` and no fallback; and
 *   * the WIDE flag said the element preserves nothing, so a block moved OUT of
 *     it was reindented and two rendered spaces went with the move.
 *
 * `white-space: normal; white-space: pre !important` behaved the same, and so
 * did every other ordering, which is the tell: this was not a wrong rule about
 * order, it was no rule about order.
 *
 * THE ROWS THAT MAKE THIS A TEST OF THE CASCADE rather than of "any preserving
 * value wins" are the reversed ones. `white-space: pre; white-space: normal`
 * must come out NOT preserving in both directions -- a fix that reordered the
 * two tests and stopped there fails exactly there -- and
 * `white-space: pre !important; white-space: normal` must come out preserving
 * even though the dropping declaration is last, which is the half that order
 * alone cannot answer.
 *
 * `white-space: pre; white-space: var(--ws)` is the row where the two readers
 * still disagree, and it is deliberately spelled with a readable value FIRST:
 * the winner is the unreadable one, so the acting flag has nothing to act on
 * and abstains, while the wide flag counts it as a could. That difference is
 * documented on `UNREADABLE_SPACE_VALUE` and is not a cascade
 * question; the row is here so the cascade fix cannot quietly erase it.
 */
function theCascadeInsideOneStyleAttribute() {
  const kept = `    <span class='kept'>one</span>`;
  // Does the element RENDER its children's indentation -- the acting flag, read
  // through an insert, which is the only place it writes markup at column zero.
  const ACTING = [
    ['white-space: pre', true],
    ['white-space: normal', false],
    ['white-space: normal; white-space: pre', true],
    ['white-space: normal;white-space:pre', true],
    ['white-space: normal; white-space: pre !important', true],
    ['white-space: pre !important; white-space: normal', true],
    ['white-space: pre; white-space: normal', false],
    ['white-space: nowrap; white-space: break-spaces', true],
    ['color: red; white-space: normal; padding: 0; white-space: pre-wrap', true],
    // `pre-line` collapses runs of spaces, so it is neither, exactly as a bare
    // one always was: the cascade picks it and it still says nothing.
    ['white-space: normal; white-space: pre-line', false],
    ['white-space: pre; white-space: var(--ws)', false],
  ];
  for (const [style, acts] of ACTING) {
    const label = `[cascade acting ${style}]`;
    const source = commentedPage(`  <div style='${style}'>\n${kept}\n  </div>\n`);
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const box = model.nodes[0].children.find((n) => n.name === 'div');
    if (!check(`${label} the div is where an insert can reach it`, !!box, short(model.nodes[0].children.map((n) => n.name)))) continue;
    box.children.push({ kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'new' }] });
    const after = anchoredSerialize(source, model);
    const want = commentedPage(`  <div style='${style}'>\n${kept}\n${acts ? '' : '    '}<p>new</p>\n  </div>\n`);
    check(
      acts
        ? `${label} computes to a preserving value, so the insert writes no indent`
        : `${label} computes to a dropping value, so the file's own indent goes in`,
      after === want,
      short({ span: changedSpan(want, after) })
    );
  }

  // And the WIDE flag, which the same defect got wrong in the other direction:
  // a block moved OUT of the element is reindented unless the element is read
  // as preserving, and a reindent inside one deletes rendered spaces.
  const WIDE = [
    ['white-space: pre', true],
    ['white-space: normal', false],
    ['white-space: normal; white-space: pre', true],
    ['white-space: pre; white-space: normal', false],
    ['white-space: normal; white-space: pre !important', true],
    ['white-space: pre !important; white-space: normal', true],
    ['white-space: normal; white-space: var(--ws)', true],
    ['white-space: normal; white-space: pre-line', false],
  ];
  for (const [style, holds] of WIDE) {
    const label = `[cascade wide ${style}]`;
    const source = commentedPage(
      `  <div class='outer'>\n    <div style='${style}'>\n      <div class='moved'>alpha\n        beta\ngamma</div>\n    </div>\n  </div>\n`
    );
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const outer = model.nodes[0].children.find((n) => n.name === 'div');
    const box = outer?.children?.find((n) => n.name === 'div');
    const moved = box?.children?.find((n) => n.name === 'div');
    if (!check(`${label} the block is where a move can reach it`, !!moved, short(box?.children?.map((n) => n.name)))) continue;
    box.children = box.children.filter((n) => n !== moved);
    outer.children.push(moved);
    const after = anchoredSerialize(source, model);
    const got = /<div class='moved'>([\s\S]*?)<\/div>/.exec(after);
    check(
      holds
        ? `${label} computes to a preserving value, so the moved block travels as authored`
        : `${label} computes to a dropping value, so the moved block is reindented`,
      !!got && got[1] === (holds ? 'alpha\n        beta\ngamma' : 'alpha\n      beta\ngamma'),
      short({ got: got ? got[1] : null })
    );
  }
}

/**
 * T17 -- A COMPONENT IS NOT THE HTML ELEMENT WITH THE SAME NAME.
 *
 * `rendersIndent` is the one flag documented as "evidence rather than a
 * superset" -- the single place the whitespace answer is used to ACT, by
 * writing a splice's surrounding layout at COLUMN ZERO, rather than to abstain.
 * `ownWhitespaceRule` lowercased `node.name` into `PRESERVING_TAGS` and never
 * looked at `node.kind`, so `<Textarea>` -- shadcn/ui's exact component name,
 * and `<Pre>`, `<Script>`, `<Style>` with it -- was treated as the HTML
 * element. What that component renders lives in another file and is quite
 * ordinarily a `<div>` with a label; a component name is not evidence about
 * anybody's whitespace.
 *
 * THE PAIRED CONTROL IS THE POINT. A fix that stopped looking at tags would
 * pass the component half and lose the mechanism, so the same insert is done
 * into the real lowercase element and must STILL go to column zero.
 *
 * AND THE WIDE FLAG IS DELIBERATELY LEFT ALONE: being wrong there only refuses
 * a reindent, so a `<Pre>` still holds its children's authored bytes. That is
 * the third check.
 */
function theComponentNamedAfterATag() {
  for (const name of ['Textarea', 'Pre', 'Script', 'Style']) {
    const label = `[component <${name}>]`;
    const lower = name.toLowerCase();
    const kept = `    <span class='kept'>one</span>`;
    const build = (open) =>
      `---\n// Layout import - the shell every page shares\nimport Base from '../layouts/Base.astro';\n` +
      `// Component imports\nimport ${name} from '../components/${name}.astro';\n---\n` +
      `<Base>\n  <${open}>\n${kept}\n  </${open}>\n</Base>\n`;
    const added = { kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'new' }] };

    // `<script>` and `<style>` are `kind: 'raw'` -- `parsePage` captures their
    // inner text verbatim and gives them no children at all -- so there is no
    // insert to make into the real element, and their acting-flag membership is
    // not observable from here. The paired control runs for the two that CAN
    // hold element children; the component half runs for all four, because
    // `<Script>` and `<Style>` are ordinary components with ordinary children
    // and that is exactly the confusion.
    const pairs = [['component', name]];
    if (lower === 'pre' || lower === 'textarea') pairs.push(['element', lower]);
    for (const [which, open] of pairs) {
      const source = build(open);
      const parsed = parsePage(source);
      if (!check(`${label} the ${which} page parses`, parsed.editable === true, short(parsed.reason))) continue;
      const model = structuredClone(parsed.model);
      const box = model.nodes[0].children.find((n) => n.name === open);
      if (!check(`${label} the ${which} is where an insert can reach it`, !!box, short(model.nodes[0].children.map((n) => n.name)))) {
        continue;
      }
      // PREMISE: the parser really does tell the two apart, so a difference
      // below is about `kind` and not about the name being read wrongly.
      check(`${label} the parser calls <${open}> a ${which}`, box.kind === which, short({ kind: box.kind }));
      box.children.push(structuredClone(added));
      const after = anchoredSerialize(source, model);
      const inner = new RegExp(`<${open}>([\\s\\S]*?)</${open}>`).exec(after);
      const got = inner ? inner[1] : null;
      if (which === 'element') {
        check(
          `${label} the real <${lower}> still writes the inserted sibling at column zero`,
          got === `\n${kept}\n<p>new</p>\n  `,
          short({ got })
        );
      } else {
        check(
          `${label} a component named after a tag does not de-indent the markup around it`,
          got === `\n${kept}\n    <p>new</p>\n  `,
          short({ got })
        );
      }
    }

    // AND THE WIDE FLAG, WHICH MAY STILL CALL IT A COULD: the subtree moved out
    // of the component travels as authored rather than reindented.
    const source =
      `---\n// Layout import - the shell every page shares\nimport Base from '../layouts/Base.astro';\n` +
      `// Component imports\nimport ${name} from '../components/${name}.astro';\n---\n` +
      `<Base>\n  <div class='outer'>\n    <${name}>\n      <div class='moved'>alpha\n        beta\ngamma</div>\n    </${name}>\n  </div>\n</Base>\n`;
    const parsed = parsePage(source);
    if (!check(`${label} the wide-flag page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const outer = model.nodes[0].children.find((n) => n.name === 'div');
    const box = outer?.children?.find((n) => n.name === name);
    const moved = box?.children?.find((n) => n.name === 'div');
    if (!check(`${label} the block is where a move can reach it`, !!moved, short(box?.children?.map((n) => n.name)))) continue;
    box.children = box.children.filter((n) => n !== moved);
    outer.children.push(moved);
    const after = anchoredSerialize(source, model);
    const got = /<div class='moved'>([\s\S]*?)<\/div>/.exec(after);
    check(
      `${label} and the wide flag still holds the moved subtree's authored bytes`,
      !!got && got[1] === 'alpha\n        beta\ngamma',
      short({ got: got ? got[1] : null })
    );
  }
}

/**
 * T18 -- `white-space: var(--anything)` FIRING THE ACTING FLAG.
 *
 * The file documents that branch as an admission: a value that cannot be read
 * statically counts as preserving, "because the only answer this is allowed to
 * get wrong is the one that refuses". That is true of the wide flag and exactly
 * false of the acting one, which writes the surrounding layout at column zero
 * on the strength of it. The variable's value may perfectly well be `normal`;
 * nothing in this file can know, and an unreadable value is not evidence.
 *
 * THE PAIRED CONTROL AGAIN: the readable `white-space: pre` on the same element
 * must still act, or the fix is a switch-off rather than a narrowing. And the
 * wide flag still reads the `var()` as a could, so the subtree moved out of the
 * element travels unreindented.
 */
function theValueNobodyCanRead() {
  const kept = `    <span class='kept'>one</span>`;
  const build = (style) => commentedPage(`  <div style='${style}'>\n${kept}\n  </div>\n`);
  for (const [style, acts] of [
    ['white-space: var(--ws)', false],
    ['white-space: var( --ws , pre )', false],
    ['white-space: pre', true],
  ]) {
    const label = `[unreadable ${style}]`;
    const source = build(style);
    const parsed = parsePage(source);
    if (!check(`${label} the page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const box = model.nodes[0].children.find((n) => n.name === 'div');
    if (!check(`${label} the div is where an insert can reach it`, !!box, short(model.nodes[0].children.map((n) => n.name)))) continue;
    box.children.push({ kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'new' }] });
    const after = anchoredSerialize(source, model);
    const inner = /<div [^>]*>([\s\S]*?)<\/div>/.exec(after);
    const got = inner ? inner[1] : null;
    check(
      acts
        ? `${label} a value this file CAN read still writes the sibling at column zero`
        : `${label} a value this file cannot read does not de-indent the markup around it`,
      got === `\n${kept}\n${acts ? '' : '    '}<p>new</p>\n  `,
      short({ got })
    );
  }
  // AND THE WIDE FLAG: the `var()` is still a could, so a block moved out of
  // the element keeps its authored indentation rather than being reindented.
  const source = commentedPage(
    `  <div class='outer'>\n    <div style='white-space: var(--ws)'>\n      <div class='moved'>alpha\n        beta\ngamma</div>\n    </div>\n  </div>\n`
  );
  const parsed = parsePage(source);
  if (!check('[unreadable] the wide-flag page parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const outer = model.nodes[0].children.find((n) => n.name === 'div');
  const box = outer?.children?.find((n) => n.name === 'div');
  const moved = box?.children?.find((n) => n.name === 'div');
  if (!check('[unreadable] the block is where a move can reach it', !!moved, short(box?.children?.map((n) => n.name)))) return;
  box.children = box.children.filter((n) => n !== moved);
  outer.children.push(moved);
  const after = anchoredSerialize(source, model);
  const got = /<div class='moved'>([\s\S]*?)<\/div>/.exec(after);
  check(
    "[unreadable] and the wide flag still holds a var()'d element's subtree as authored",
    !!got && got[1] === 'alpha\n        beta\ngamma',
    short({ got: got ? got[1] : null })
  );
}

/**
 * T19 -- THE UTILITY CLASS AS TAILWIND ACTUALLY SPELLS IT.
 *
 * The class matcher was anchored to `(^|\s)whitespace-pre...(\s|$)`, which is
 * the BARE utility and nothing else. Every ordinary spelling in a real project
 * carries something on one end of it and every one of them read as NOT
 * preserving: measured before the fix, a `<div class='md:whitespace-pre'>` moved
 * across a nesting level came back with two spaces gone off its middle line --
 * rendered text deleted, reported as success -- and the same four spellings
 * failed to fire the acting flag, so an insert wrote the file's own indent as
 * content inside an element that renders it.
 *
 * THE TABLE IS THE TEST, and it is deliberately not one column. The two flags
 * are supposed to disagree about exactly one thing here: a VARIANT is a rule
 * about some viewports, which is a fair could and is not the "known to render
 * it" the acting flag writes on. A prefix and the important modifier are not
 * variants -- they name a rule that applies whenever the element is on screen
 * at all -- so both flags take them. `whitespace-pre-line` and `plain` are the
 * negative controls that keep this a narrowing rather than a switch-off.
 */
const UTILITY_CLASS_SPELLINGS = [
  { cls: 'whitespace-pre', wide: true, acts: true },
  { cls: 'whitespace-pre-wrap', wide: true, acts: true },
  { cls: 'whitespace-break-spaces', wide: true, acts: true },
  // A variant: a could for the wide flag, not evidence for the acting one.
  { cls: 'md:whitespace-pre', wide: true, acts: false },
  { cls: 'lg:whitespace-break-spaces', wide: true, acts: false },
  { cls: 'print:whitespace-pre-wrap', wide: true, acts: false },
  { cls: 'md:!whitespace-pre-wrap', wide: true, acts: false },
  // A configured prefix and the important modifier, v3's spelling and v4's.
  { cls: 'tw-whitespace-pre', wide: true, acts: true },
  { cls: '!whitespace-pre', wide: true, acts: true },
  { cls: 'whitespace-pre!', wide: true, acts: true },
  // The same tokens where a real page puts them: in a list, with layout classes
  // either side, which is what the `(^|\s)...(\s|$)` anchors were there for.
  { cls: 'p-4 whitespace-pre rounded-lg', wide: true, acts: true },
  // The arbitrary property, which is the declaration itself and is the token
  // whose own `:` must not be read as a variant separator.
  { cls: '[white-space:pre]', wide: true, acts: true },
  { cls: '[white-space:break-spaces]', wide: true, acts: true },
  { cls: 'md:[white-space:pre-wrap]', wide: true, acts: false },
  { cls: '[&:hover]:whitespace-pre', wide: true, acts: false },
  { cls: 'p-4 md:whitespace-pre rounded-lg', wide: true, acts: false },
  // A LIST THAT NAMES BOTH SPELLINGS, which nothing here can resolve -- Tailwind
  // decides it by its own output order, and at a width where the variant fires
  // it is `pre` whatever that order is. The two flags answer it the way each is
  // allowed to be wrong: the wide one keeps the bytes, the acting one withholds
  // the write.
  { cls: 'md:whitespace-pre whitespace-normal', wide: true, acts: false },
  { cls: 'whitespace-pre whitespace-normal', wide: true, acts: false },
  // NEGATIVE CONTROLS. `pre-line` collapses runs of spaces, so a reindent is
  // provably neutral and it is deliberately not in the preserving set; the
  // other two are an element that says it does not preserve and one that says
  // nothing at all.
  { cls: 'whitespace-pre-line', wide: false, acts: false },
  { cls: 'whitespace-normal', wide: false, acts: false },
  { cls: 'plain', wide: false, acts: false },
];

function theUtilityClassAsTailwindSpellsIt() {
  for (const { cls, wide, acts } of UTILITY_CLASS_SPELLINGS) {
    const label = `[class '${cls}']`;
    const quoted = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // THE WIDE FLAG: a move across a nesting level either keeps the block's
    // authored bytes or reindents it by one level.
    const inner = 'alpha\n        beta\ngamma';
    const raised = 'alpha\n      beta\ngamma';
    const wideSource = commentedPage(
      `  <div class='outer'>\n    <div class='wrap'>\n      <div class='${cls}'>${inner}</div>\n    </div>\n  </div>\n`
    );
    const wideParsed = parsePage(wideSource);
    if (!check(`${label} the wide-flag page parses`, wideParsed.editable === true, short(wideParsed.reason))) continue;
    const wideModel = structuredClone(wideParsed.model);
    const outer = wideModel.nodes[0].children.find((n) => n.name === 'div');
    const wrap = outer?.children?.find((n) => n.name === 'div');
    const moved = wrap?.children?.find((n) => n.name === 'div');
    if (!check(`${label} the block is where a move can reach it`, !!moved, short(wrap?.children?.map((n) => n.name)))) continue;
    wrap.children = wrap.children.filter((n) => n !== moved);
    outer.children.push(moved);
    const wideAfter = anchoredSerialize(wideSource, wideModel);
    // POSITIVE CONTROL: the move happened at all.
    if (
      !check(
        `${label} the move empties the wrap`,
        /<div class='wrap'>\s*<\/div>/.test(wideAfter),
        short(changedSpan(wideSource, wideAfter))
      )
    ) {
      continue;
    }
    const wideGot = new RegExp(`<div class='${quoted}'>([\\s\\S]*?)</div>`).exec(wideAfter);
    check(
      wide
        ? `${label} the wide flag reads the spelling and holds the block's authored bytes`
        : `${label} a class that preserves nothing still lets the block be reindented`,
      !!wideGot && wideGot[1] === (wide ? inner : raised),
      short({ want: wide ? inner : raised, got: wideGot ? wideGot[1] : null })
    );

    // THE ACTING FLAG: an insert into the element writes at column zero only
    // when this element is KNOWN to render the indentation between its children.
    const kept = `    <span class='kept'>one</span>`;
    const actSource = commentedPage(`  <div class='${cls}'>\n${kept}\n  </div>\n`);
    const actParsed = parsePage(actSource);
    if (!check(`${label} the acting-flag page parses`, actParsed.editable === true, short(actParsed.reason))) continue;
    const actModel = structuredClone(actParsed.model);
    const box = actModel.nodes[0].children.find((n) => n.name === 'div');
    if (!check(`${label} the div is where an insert can reach it`, !!box, short(actModel.nodes[0].children.map((n) => n.name)))) {
      continue;
    }
    box.children.push({ kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'new' }] });
    const actAfter = anchoredSerialize(actSource, actModel);
    const held = new RegExp(`<div class='${quoted}'>([\\s\\S]*?)</div>`).exec(actAfter);
    const got = held ? held[1] : null;
    check(
      acts
        ? `${label} the acting flag writes the inserted sibling at column zero`
        : `${label} a rule that applies only sometimes does not de-indent the markup around it`,
      got === `\n${kept}\n${acts ? '' : '    '}<p>new</p>\n  `,
      short({ got })
    );
  }

  // AND THE VARIANT IS IGNORED, NOT DENIED. "Not evidence" is not "evidence
  // against": a `md:whitespace-pre` inside a real `white-space: pre` must still
  // inherit the acting answer from the ancestor, or the fix has turned a could
  // into a `false` and started writing rendered spaces under a real `<pre>`.
  const kept = `      <span class='kept'>one</span>`;
  const source = commentedPage(
    `  <div style='white-space: pre'>\n    <div class='md:whitespace-pre'>\n${kept}\n    </div>\n  </div>\n`
  );
  const parsed = parsePage(source);
  if (!check('[variant under a pre] the page parses', parsed.editable === true, short(parsed.reason))) return;
  const model = structuredClone(parsed.model);
  const outer = model.nodes[0].children.find((n) => n.name === 'div');
  const box = outer?.children?.find((n) => n.name === 'div');
  if (!check('[variant under a pre] the inner div is where an insert can reach it', !!box, short(outer?.children?.map((n) => n.name)))) {
    return;
  }
  box.children.push({ kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'new' }] });
  const after = anchoredSerialize(source, model);
  const held = /<div class='md:whitespace-pre'>([\s\S]*?)<\/div>/.exec(after);
  check(
    '[variant under a pre] a variant is not counter-evidence, so the ancestor still answers',
    held && held[1] === `\n${kept}\n<p>new</p>\n    `,
    short({ got: held ? held[1] : null })
  );
}

/**
 * T20 -- A COMPONENT CARRYING THE DECLARATION.
 *
 * The acting pass excluded components from the PRESERVING_TAGS test and from
 * nothing else, so `<Card class='whitespace-pre'>` and `<Card style='white-space:
 * pre'>` fell straight through to the `style` and `class` tests underneath and
 * were treated as elements KNOWN to render the indentation between their
 * children. Measured: a newly inserted child went in at COLUMN ZERO.
 *
 * A component is a function call. `class` and `style` reach it as props and
 * what it does with them is in another file -- it may drop them, or spread them
 * onto a wrapper that is not the parent of these children at all, or render the
 * children into a slot several elements deeper. That is not evidence, and the
 * acting flag is the one place a guess writes.
 *
 * THE PAIRED CONTROL IS THE POINT AGAIN: the identical attribute on a real
 * `<div>` must STILL go to column zero, or the fix is a switch-off. And the
 * WIDE flag deliberately keeps reading the attribute -- being wrong there only
 * refuses a reindent, and a component that DOES forward `class` to the element
 * around its slot is common -- so a subtree moved out of the component still
 * travels as authored.
 */
function theComponentCarryingTheDeclaration() {
  for (const attr of [`class='whitespace-pre'`, `style='white-space: pre'`]) {
    const label = `[<Card ${attr}>]`;
    const kept = `    <span class='kept'>one</span>`;
    for (const [which, open] of [
      ['component', 'Card'],
      ['element', 'div'],
    ]) {
      const source = commentedPage(`  <${open} ${attr}>\n${kept}\n  </${open}>\n`);
      const parsed = parsePage(source);
      if (!check(`${label} the ${which} page parses`, parsed.editable === true, short(parsed.reason))) continue;
      const model = structuredClone(parsed.model);
      const box = model.nodes[0].children.find((n) => n.name === open);
      if (!check(`${label} the ${which} is where an insert can reach it`, !!box, short(model.nodes[0].children.map((n) => n.name)))) {
        continue;
      }
      // PREMISE: the parser really does tell the two apart, so the difference
      // below is about `kind` and not about the attribute being read wrongly.
      check(`${label} the parser calls <${open}> a ${which}`, box.kind === which, short({ kind: box.kind }));
      box.children.push({ kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'new' }] });
      const after = anchoredSerialize(source, model);
      const held = new RegExp(`<${open} [^>]*>([\\s\\S]*?)</${open}>`).exec(after);
      const got = held ? held[1] : null;
      check(
        which === 'element'
          ? `${label} the real <div> with the same attribute still writes at column zero`
          : `${label} a component carrying the declaration does not de-indent the markup around it`,
        got === `\n${kept}\n${which === 'element' ? '' : '    '}<p>new</p>\n  `,
        short({ got })
      );
    }

    // AND THE WIDE FLAG, WHICH MAY STILL CALL IT A COULD.
    const source = commentedPage(
      `  <div class='outer'>\n    <Card ${attr}>\n      <div class='moved'>alpha\n        beta\ngamma</div>\n    </Card>\n  </div>\n`
    );
    const parsed = parsePage(source);
    if (!check(`${label} the wide-flag page parses`, parsed.editable === true, short(parsed.reason))) continue;
    const model = structuredClone(parsed.model);
    const outer = model.nodes[0].children.find((n) => n.name === 'div');
    const box = outer?.children?.find((n) => n.name === 'Card');
    const moved = box?.children?.find((n) => n.name === 'div');
    if (!check(`${label} the block is where a move can reach it`, !!moved, short(box?.children?.map((n) => n.name)))) continue;
    box.children = box.children.filter((n) => n !== moved);
    outer.children.push(moved);
    const after = anchoredSerialize(source, model);
    const got = /<div class='moved'>([\s\S]*?)<\/div>/.exec(after);
    check(
      `${label} and the wide flag still holds the moved subtree's authored bytes`,
      !!got && got[1] === 'alpha\n        beta\ngamma',
      short({ got: got ? got[1] : null })
    );
  }
}

/**
 * T16 -- the stamp for a stylesheet the caller hands in.
 *
 * `knownTextOf` exists so `page:write` need not re-read the page it is about to
 * write, and the file it hands in is stamped by what this scan READS of it. For
 * a page that is its `<style>` blocks; for a `.css` path it is the whole text
 * -- and the stamp asked for `<style>` blocks whatever the path was, which for
 * a stylesheet are ALWAYS none. Every possible text of that file therefore
 * produced the SAME stamp, so the cache would have served the first answer for
 * ever. Not reachable from the single call site today; the documented contract
 * ("the caller hands in the text it already read") is an invitation to reach
 * it, and this is the assertion that it cannot be reached.
 */
function theStampForAStylesheetHandedIn() {
  const root = H.makeProject({});
  const abs = path.join(root, 'src', 'styles', 'site.css');
  fs.writeFileSync(abs, '.card { color: red }\n', 'utf8');
  WS.forgetCache();
  const first = [...WS.preservingTokens(root, { knownText: { [abs]: '.card { color: red }\n' } })];
  const second = [...WS.preservingTokens(root, { knownText: { [abs]: '.preserved { white-space: pre }\n' } })];
  H.removeProject(root);
  check(
    '[stamp] a stylesheet handed in with no preserving rule contributes nothing',
    !first.includes('.preserved'),
    short(first)
  );
  check(
    '[stamp] and a DIFFERENT text for the same .css path is a cache miss, not the first answer again',
    second.includes('.preserved'),
    short(second)
  );
}

(async () => {
  for (const f of FIXTURES) await runFixture(f);
  importInsert();
  fileStartCut();
  whitespaceThePageRenders();
  trailingSpacesOnTheLineItLeaves();
  theTwinThatIsNotTheSameBytes();
  theTwinWhoseBytesAreItsOwn();
  wordsWithoutTheBoundaryBytes();
  stepFromTheTree();
  tabsAgainstSpaces();
  trailingImportComment();
  moveRoundTrip();
  overlappingSplices();

  // --- whitespace a page renders because of CSS, and not because of a tag.
  for (const attr of ["style='white-space: pre'", "class='whitespace-pre'", null]) {
    inheritedWhitespace(attr, attr !== null);
  }
  for (const attr of ["style='white-space: pre'", "class='whitespace-pre'", "class='plain'"]) {
    movedIntoPreservedWhitespace(attr, !attr.includes('plain'));
  }
  for (const c of INDEX_ZERO_CASES) insertedInFrontOfTheFirstChild(c);
  insertedInFrontOfTheFirstChildOfADescendant();
  movedIntoAnUnprovenElement();
  theWhitespaceValueTable();
  elementChildrenInsideAPre();
  movedIntoAPresInlineRun();
  for (const attr of ["style='white-space: pre'", "class='plain'"]) {
    replacedInsidePreservedWhitespace(attr, !attr.includes('plain'));
  }
  aDescendantThatDeclaresIt();
  theSelectorReducer();
  theWalkThatCameBackShort();
  theTokenThatNamesEveryDiv();
  theStylesheetBehindASymlink();
  theLinkOutOfTheProject();
  theEntryThatIsNotAFile();
  theRunTheReprintCollapsed();
  theElementAnEditEmptied();
  theReorderInsideAPre();
  theReorderOfBlockChildrenInsideAPre();
  theReorderThatAlsoAddsOrRemovesAChild();
  theReorderThatAlsoEditsAChild();
  theEditedChildTheFileIndentedDifferently();
  theModelNumberedByTwoParses();
  theReorderBesideAnInlineRun();
  theCascadeInsideOneStyleAttribute();
  theComponentNamedAfterATag();
  theComponentCarryingTheDeclaration();
  theUtilityClassAsTailwindSpellsIt();
  theValueNobodyCanRead();
  theStampForAStylesheetHandedIn();
  for (const shape of [
    { id: 'two-space', ind: '  ', eol: '\n' },
    { id: 'tabs', ind: '\t', eol: '\n' },
    { id: 'crlf', ind: '  ', eol: '\r\n' },
  ]) {
    await stylesheetPreservedWhitespace(shape);
  }
  for (const where of ['media', 'style-block']) {
    await stylesheetPreservedWhitespace({ id: 'two-space', ind: '  ', eol: '\n' }, where);
  }
  for (const value of ['nowrap', 'pre-line']) await neutralRulesChangeNothing(value);
  // 'unreadable-dir' is deliberately NOT here: an unlistable directory stops
  // `listAstroFiles` before a project can be opened at all, so that failure
  // mode is measured end to end in `theWalkThatCameBackShort` instead, with
  // the same bytes and the same move but nothing mounted.
  for (const kind of ['unparseable', 'unreadable']) await aStylesheetThatCannotBeReadOrParsed(kind);
  await theSameBytesWithNoWindow();
  await theScanThatRanOnEverySave();

  if (failures.length) {
    console.error(`source-fidelity-matrix: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    suiteDone();
    process.exit(1);
  }
  console.log(
    `source-fidelity-matrix: ${checked} passed  [every operation changes only the bytes it means to, in five differently-written files]`
  );
  suiteDone();
})().catch((err) => {
  console.error('source-fidelity-matrix: threw\n', err?.stack || err);
  process.exit(1);
});
