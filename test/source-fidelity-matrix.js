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
const { parsePage, anchoredSerialize } = require('../electron/astroParser.js');

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
    `${ind}</section>`,
    `${ind}<Card`,
    `${ind}${ind}title=${q}Wide${q}`,
    `${ind}${ind}body=${q}across lines on purpose${q}`,
    `${ind}/>`,
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

    const pageRef = (await run('target', 'read')).target?.ref ?? null;
    check(`[${f.id}] the page answers with a ref`, !!pageRef, short(pageRef));

    // Every target the operations name, re-resolved before each one: a ref is
    // a position on a tree, and the tree is rebuilt by every undo.
    const resolve = async (which) => {
      const top = (await run('target', 'read', { ref: pageRef })).target?.children || [];
      const byTag = (t) => top.find((c) => c.tag === t) || null;
      if (which === 'hero') return byTag('Hero')?.ref ?? null;
      if (which === 'grid') return byTag('div')?.ref ?? null;
      if (which === 'section') return byTag('section')?.ref ?? null;
      if (which === 'footer') return byTag('footer')?.ref ?? null;
      if (which === 'fine') return byTag('p')?.ref ?? null;
      if (which === 'wideCard') return byTag('Card')?.ref ?? null;
      if (which === 'inlineCard') {
        const section = byTag('section');
        if (!section?.ref) return null;
        const kids = (await run('target', 'read', { ref: section.ref })).target?.children || [];
        return kids.find((c) => c.tag === 'Card')?.ref ?? null;
      }
      return null;
    };

    for (const op of operations(f)) {
      const label = `[${f.id}] ${op.name}`;
      const before = app.read(PAGE);
      if (!check(`${label}: starts from the baseline bytes`, sha(before) === baselineSha, tag(before))) continue;

      const ref = await resolve(op.target);
      if (!check(`${label}: the target resolves`, !!ref, op.target)) continue;

      const [action, args] = op.call(ref, { pageRef });
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
// `target.remove` prunes the import nothing reads any more. The ADDITION half
// cannot be reached that way: `buildNode` only carries an import for an
// insertable that knows its own import path, and the renderer's insertables do
// not carry one -- a component inserted through `target.append_child` lands in
// the page unimported today, which is a defect in a file this suite's fix does
// not touch. So this half is driven straight at the writer, where the splice
// lives, rather than left unmeasured.

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

(async () => {
  for (const f of FIXTURES) await runFixture(f);
  importInsert();
  fileStartCut();

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
