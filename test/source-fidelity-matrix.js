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
const H = require('./agent-harness.js');
const { parsePage, anchoredSerialize, applySplices } = require('../electron/astroParser.js');

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

  if (failures.length) {
    console.error(`source-fidelity-matrix: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `source-fidelity-matrix: ${checked} passed  [every operation changes only the bytes it means to, in five differently-written files]`
  );
})().catch((err) => {
  console.error('source-fidelity-matrix: threw\n', err?.stack || err);
  process.exit(1);
});
