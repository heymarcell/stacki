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
// double quotes, comments between the imports, a `.map()` over repeated
// content, an inline component child, a multi-line attribute block, Astro
// expressions, nested components.
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
// One page, written four ways. The shapes are the ones a re-serialization is
// known to destroy, and every one of them is ordinary: the comments sit above
// the imports they annotate rather than in a block of their own, the
// attributes are quoted the way the author quoted them, the Card's attributes
// are spread over three lines on purpose, and the pricing grid is a `.map()`
// rather than repeated markup.

function makeSource({ ind, eol, q }) {
  const lines = [
    '---',
    '// Layout import - the shell every page shares',
    "import Base from '../layouts/Base.astro';",
    '',
    '// Component imports',
    "import Hero from '../components/Hero.astro';",
    "import Card from '../components/Card.astro';",
    '',
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
      if (which === 'inlineCard' || which === 'deepCard') {
        const section = byTag('section');
        if (!section?.ref) return null;
        const kids = (await run('target', 'read', { ref: section.ref })).target?.children || [];
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

// --- WHITESPACE THE BROWSER RENDERS ------------------------------------------
//
// Inside a <pre> or a <textarea> the leading spaces on each line are content.
// Nothing else in this suite can see them: `parsePage` collapses the run into
// value:'alpha beta gamma' and keeps the real bytes in `source`, which is an
// as-written field the write path's readback gate skips -- so a cross-level
// move deleted two spaces the page shows and every tree comparison agreed the
// file still meant the same thing. The oracle here is the bytes between the
// tags.

function whitespaceThePageRenders() {
  for (const tag of ['pre', 'textarea']) {
    // TWO SPACES ON THE SECOND LINE, in a page indented in two spaces: a shift
    // out of one level slices exactly that prefix off every line in the block,
    // and those two are content. The <footer> nobody touches keeps the
    // author's single quotes only if the write was a SPLICE -- a fall back to
    // reprinting the document also preserves the <pre>, so without it
    // "refused and reprinted the whole page" would read as success.
    const body = 'alpha\n  beta\ngamma';
    const source =
      `---\nimport Base from '../layouts/Base.astro';\n---\n<Base>\n` +
      `  <div class='wrap'>\n    <${tag}>${body}</${tag}>\n  </div>\n` +
      `  <footer class='end'>end</footer>\n</Base>\n`;
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
    // POSITIVE CONTROL: it really left the <div>, so "the content survived"
    // cannot be satisfied by a write that did nothing at all.
    if (
      !check(
        `moving a <${tag}> out of its <div> moves it`,
        /<div[^>]*><\/div>/.test(after),
        short(changedSpan(source, after))
      )
    ) {
      continue;
    }
    const held = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(after);
    check(
      `  and every space the browser renders inside it is still there`,
      !!held && held[1] === body,
      short({ want: body, got: held ? held[1] : null })
    );
    check(
      `  and the page was spliced to do it, not reprinted`,
      after.includes(`<footer class='end'>end</footer>`),
      short({ span: changedSpan(source, after) })
    );
  }
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
  const want =
    `---\nimport Base from '../layouts/Base.astro';\n---\n<Base>\n` +
    `\t<div>\n\t</div>\n` +
    `  <section>\n    <p>x</p>\n    <Card title="Wide" />\n  </section>\n</Base>\n`;
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
  stepFromTheTree();
  tabsAgainstSpaces();
  trailingImportComment();
  overlappingSplices();

  if (failures.length) {
    console.error(`source-fidelity-matrix: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `source-fidelity-matrix: ${checked} passed  [every operation changes only the bytes it means to, in four differently-written files]`
  );
})().catch((err) => {
  console.error('source-fidelity-matrix: threw\n', err?.stack || err);
  process.exit(1);
});
