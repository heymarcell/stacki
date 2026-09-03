// What a small semantic edit is allowed to do to the file it lands in.
//
//   node test/source-fidelity.js
//
// One `target.set_prop` sets one attribute on one element. The bytes that
// change should be the bytes of that attribute. Everything else in the file --
// the comment above an import, the order of the imports, the author's
// indentation, the quotes they chose, the markup they did not touch -- belongs
// to the person who wrote it, and a semantic edit has no business rewriting it.
//
// This is not a style preference. A structured edit that reformats the whole
// file is unreviewable as a diff, and in a project without git -- the ordinary
// case for a new Stacki project -- the original is simply gone.
//
// THE ORACLE IS BYTES, NOT LINE COUNTS. A line-count threshold passes a file
// that was rewritten into the same number of lines. So the checks here take the
// intended change back out of the result and require what is left to be
// byte-identical to what was there before, and separately require the changed
// region to be one small contiguous span.
//
// The fixture is the shape the native-Claude dogfood measured: comments sitting
// directly above the imports they annotate, four-space indentation, and
// single-quoted attributes. Those three are what a whole-file re-serialization
// destroys, and none of them is exotic.

const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);

// The page under test. Overrides the shared fixture's index so the app opens it
// on load, and imports exactly what that fixture already provides, so nothing
// here is unresolvable.
const PAGE = 'src/pages/index.astro';
const SOURCE = `---
// Layout import - the shell every page shares
import Base from '../layouts/Base.astro';

// Component imports
import Hero from '../components/Hero.astro';
import Card from '../components/Card.astro';

// Page data
import site from '../data/site.json';

const plans = [
    { title: 'Starter', body: 'For one person' },
    { title: 'Team', body: 'For a few people' },
];
---
<Base>
    <Hero heading={site.tagline} />
    <div class='pricing-grid'>
        {plans.map((plan) => (
            <Card title={plan.title} body={plan.body} />
        ))}
    </div>
    <Card
        title="Wide"
        body='across lines on purpose'
    />
    <label>Name: <input type='text' name='n' /></label>
    <!-- The footer is deliberately last -->
    <footer>
        <p class='fine-print'>Made carefully.</p>
    </footer>
</Base>
`;

/**
 * The one contiguous region two texts disagree about.
 *
 * Walks in from both ends, which is exactly right for a local edit and honest
 * about a scattered one: a rewrite that moves something at the top and
 * something at the bottom reports the whole middle, which is what it changed.
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
  return {
    start: head,
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
  };
}

/** The frontmatter fence, bytes and all, or null when there isn't one. */
const frontmatterOf = (text) => {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? m[0] : null;
};

const linesChanged = (before, after) => {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.length - head - tail, added: b.length - head - tail };
};

(async () => {
  const root = H.makeProject({ [PAGE]: SOURCE });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  try {
    // --- THE FILE ARRIVED AS WRITTEN.
    //
    // A control, and not a decorative one: if opening the project rewrote the
    // page before any edit, everything below would be measuring the wrong
    // baseline and would still pass.
    {
      const onDisk = app.read(PAGE);
      check('opening the project does not rewrite the page', onDisk === SOURCE, short({
        same: onDisk === SOURCE,
        span: onDisk === SOURCE ? null : changedSpan(SOURCE, onDisk),
      }));
    }

    // --- ONE PROP, THROUGH THE PRODUCTION RENDERER PATH.
    const before = app.read(PAGE);
    const page = await run('target', 'read');
    const hero = page.target?.children?.find((c) => c.tag === 'Hero');
    check('the page reports its Hero instance', !!hero?.ref, short(page.target?.children));

    const set = await run('target', 'set_prop', { ref: hero.ref, name: 'id', value: 'top' });
    await H.settle(250);
    const after = app.read(PAGE);

    check('the prop is set', set.ok === true, short(set));
    check('  and the new value is really in the file', /<Hero[^>]*id="top"/.test(after), short(after.slice(0, 400)));
    check('  and the file actually changed', after !== before, 'nothing was written');

    // --- WHAT IT WAS ALLOWED TO TOUCH.
    const span = changedSpan(before, after);
    const lines = linesChanged(before, after);

    check(
      'the change is one small contiguous span',
      span.removed.length + span.added.length <= 200,
      short({ removedBytes: span.removed.length, addedBytes: span.added.length, removed: span.removed, added: span.added })
    );
    check(
      '  touching a handful of lines, not the file',
      lines.removed <= 3 && lines.added <= 3,
      short(lines)
    );

    // --- AND WHAT IT WAS NOT.
    //
    // The strongest form of the question: take the intended change back out and
    // require every remaining byte to be the byte that was there. This cannot
    // be satisfied by a file that was reformatted into the same shape.
    check(
      'with the new attribute removed, the file is byte-identical to before',
      after.replace(/ id="top"/, '') === before,
      short({ span })
    );

    // --- THE FRONTMATTER, WHICH THE EDIT NEVER NAMED.
    const fmBefore = frontmatterOf(before);
    const fmAfter = frontmatterOf(after);
    check('the frontmatter is byte-identical', fmBefore !== null && fmAfter === fmBefore, short({
      before: fmBefore,
      after: fmAfter,
    }));
    check(
      '  so each comment still sits above the import it annotates',
      /\/\/ Layout import - the shell every page shares\nimport Base/.test(after) &&
        /\/\/ Component imports\nimport Hero/.test(after) &&
        /\/\/ Page data\nimport site/.test(after),
      short(fmAfter)
    );
    check(
      '  and the imports are in the order they were written',
      after.indexOf("import Base") < after.indexOf("import Hero") &&
        after.indexOf("import Hero") < after.indexOf("import Card") &&
        after.indexOf("import Card") < after.indexOf("import site"),
      short(fmAfter)
    );

    // --- THE AUTHOR'S FORMATTING, EVERYWHERE THE EDIT DID NOT GO.
    check(
      'four-space indentation survives',
      after.includes("\n    <div class='pricing-grid'>") && after.includes('\n        {plans.map('),
      short(after.slice(after.indexOf('<Base>'), after.indexOf('<Base>') + 200))
    );
    check(
      'single-quoted attributes elsewhere keep their quotes',
      after.includes("class='pricing-grid'") && after.includes("class='fine-print'"),
      short(after.slice(after.indexOf('<div'), after.indexOf('<div') + 120))
    );
    check(
      'the markup comment stays where it was',
      /<!-- The footer is deliberately last -->\n    <footer>/.test(after),
      short(after.slice(after.indexOf('<!--'), after.indexOf('<!--') + 120))
    );

    // --- A SECOND EDIT ON A DIFFERENT NODE, so the first one's result is not a
    //     lucky property of the very first write to a freshly-parsed file.
    {
      const beforeTwo = app.read(PAGE);
      const p2 = await run('target', 'read');
      const div = p2.target?.children?.find((c) => c.tag === 'div');
      const set2 = await run('target', 'set_prop', { ref: div.ref, name: 'data-test', value: 'grid' });
      await H.settle(250);
      const afterTwo = app.read(PAGE);
      check('a second prop, on another node, also lands', set2.ok === true && /data-test="grid"/.test(afterTwo), short(set2));
      check(
        '  and again changes nothing else',
        afterTwo.replace(/ data-test="grid"/, '') === beforeTwo,
        short({ span: changedSpan(beforeTwo, afterTwo) })
      );
      check(
        '  with the single quotes on the same tag untouched',
        afterTwo.includes("class='pricing-grid'"),
        short(afterTwo.slice(afterTwo.indexOf('<div'), afterTwo.indexOf('<div') + 140))
      );
    }
    // --- A TAG WHOSE ATTRIBUTES ARE WRITTEN ACROSS LINES.
    //
    // Reprinting the node flattens the block onto one line, which is a diff on
    // every line of a tag for an edit that added one attribute. The block is
    // the author's, and the new attribute joins it rather than replacing it.
    {
      const beforeMulti = app.read(PAGE);
      const p3 = await run('target', 'read');
      const card = p3.target?.children?.find((c) => c.tag === 'Card');
      check('the page reports its multi-line Card', !!card?.ref, short(p3.target?.children?.map((c) => c.tag)));
      const set3 = await run('target', 'set_prop', { ref: card.ref, name: 'id', value: 'wide' });
      await H.settle(250);
      const afterMulti = app.read(PAGE);
      check('a prop on a multi-line tag lands', set3.ok === true && /id="wide"/.test(afterMulti), short(set3));
      check(
        '  and the attribute block keeps its lines',
        /<Card\n        title="Wide"\n        body='across lines on purpose'/.test(afterMulti),
        short(afterMulti.slice(afterMulti.indexOf('<Card'), afterMulti.indexOf('<Card') + 160))
      );
      check('  and the other attributes keep their quotes', afterMulti.includes("body='across lines on purpose'"), short(afterMulti.slice(afterMulti.indexOf('<Card'), afterMulti.indexOf('<Card') + 160)));
      check(
        '  and removing the new one gives the file back',
        afterMulti.replace(/ id="wide"/, '') === beforeMulti,
        short({ span: changedSpan(beforeMulti, afterMulti) })
      );
    }

    // --- A COMPONENT INSIDE A `.map()`, which is where half the components on
    //     a real page live.
    //
    // The write reads its result back and requires it to say what was asked
    // for. Comparing SERIALIZED TEXT could not do that -- the serializer keeps
    // a file's own layout where it can, so the same meaning has many spellings
    // and this splice was thrown away, falling back to rewriting the whole
    // document: 582 bytes out, 580 in, the frontmatter comments torn off their
    // imports. Found by review. The check compares meaning now.
    {
      const beforeMap = app.read(PAGE);
      const p5 = await run('target', 'read');
      const grid = p5.target?.children?.find((c) => c.tag === 'div');
      const inGrid = grid?.ref ? await run('target', 'read', { ref: grid.ref }) : null;
      const findCard = (list) => {
        for (const c of list || []) {
          if (c.tag === 'Card') return c;
          if (Array.isArray(c.children)) {
            const deeper = findCard(c.children);
            if (deeper) return deeper;
          }
        }
        return null;
      };
      let card = findCard(inGrid?.target?.children);
      if (!card) {
        const branch = inGrid?.target?.children?.[0];
        const inBranch = branch?.ref ? await run('target', 'read', { ref: branch.ref }) : null;
        card = findCard(inBranch?.target?.children);
      }
      if (card?.ref) {
        const set5 = await run('target', 'set_prop', { ref: card.ref, name: 'data-in-map', value: 'yes' });
        await H.settle(250);
        const afterMap = app.read(PAGE);
        check('a prop on a component inside a .map() lands', set5.ok === true && /data-in-map="yes"/.test(afterMap), short(set5));
        check(
          '  and does not rewrite the document to do it',
          afterMap.replace(/ data-in-map="yes"/, '') === beforeMap,
          short({ span: changedSpan(beforeMap, afterMap) })
        );
        check('  with the frontmatter comments still on their imports', /\/\/ Component imports\nimport Hero/.test(afterMap), short(frontmatterOf(afterMap)));
      } else {
        check('the grid reports the Card inside its map', false, short(inGrid?.target?.children?.map((c) => c.tag || c.kindOfThing)));
      }
    }

    // --- TEXT NEXT TO A SIBLING THE INLINE RUN DOES NOT RECOGNISE.
    //
    // A text node's source range starts where the PREVIOUS node ended, so it
    // carries the line break and indent between them -- and the serializer
    // strips a text run's boundary spaces, because normally those line breaks
    // ARE that whitespace. Splicing the narrow text into the wide span deleted
    // a space the page renders: `<label>Name: <input /></label>` came back as
    // `<label>Name:<input />`. Found by review; the write now refuses to
    // replace a span that is not exactly the node's own text.
    {
      const p4 = await run('target', 'read');
      const label = p4.target?.children?.find((c) => c.tag === 'label');
      check('the page reports its label', !!label?.ref, short(p4.target?.children?.map((c) => c.tag)));
      const kids = label?.ref ? await run('target', 'read', { ref: label.ref }) : null;
      const text = kids?.target?.children?.find((c) => !c.tag || c.tag === '#text' || c.kindOfThing === 'text');
      if (text?.ref) {
        const set4 = await run('target', 'set_text', { ref: text.ref, text: 'Full name: ' });
        await H.settle(250);
        const afterText = app.read(PAGE);
        check('a text edit lands', set4.ok === true && afterText.includes('Full name:'), short(set4));
        check(
          '  and the space the page renders before the input survives',
          /Full name:(\s|&nbsp;)/.test(afterText.slice(afterText.indexOf('Full name:'))) &&
            !/Full name:<input/.test(afterText),
          short(afterText.slice(afterText.indexOf('<label'), afterText.indexOf('<label') + 180))
        );
        check('  and the input is still there', /<input[^>]*name=/.test(afterText), 'the input went missing');
      } else {
        check('the label reports a text child to edit', false, short(kids?.target?.children));
      }
    }

    // --- THE QUOTES THE AUTHOR CHOSE, ON AN ATTRIBUTE THE EDIT REWRITES.
    //
    // Every check above passes without this one, because `patchAttrs` keeps a
    // tag's own bytes for every attribute whose MEANING is unchanged. The
    // moment a VALUE changes the attribute is written out again -- and it was
    // written with double quotes whatever the file said, so `add_class` on
    // `class='x'` came back as `class="x y"`. Two bytes nobody asked for, on
    // the surgical path, where no amount of shrinking the blast radius reaches
    // them.
    {
      const beforeQuote = app.read(PAGE);
      const p6 = await run('target', 'read');
      const card = p6.target?.children?.find((c) => c.tag === 'Card');
      const set6 = await run('target', 'set_prop', { ref: card.ref, name: 'body', value: 'across lines still' });
      await H.settle(250);
      const afterQuote = app.read(PAGE);
      check(
        "rewriting a single-quoted value keeps the author's quotes",
        set6.ok === true && afterQuote.includes("body='across lines still'"),
        short({ ok: set6.ok, at: afterQuote.slice(afterQuote.indexOf('<Card'), afterQuote.indexOf('<Card') + 180) })
      );
      check(
        '  and changes the value and nothing else',
        afterQuote.replace("body='across lines still'", "body='across lines on purpose'") === beforeQuote,
        short({ span: changedSpan(beforeQuote, afterQuote) })
      );

      // --- AND THE ONE VALUE THOSE QUOTES CANNOT HOLD. There is no escape for
      //     `'` inside a single-quoted attribute, so the choice is the other
      //     quote or invalid markup.
      const beforeApos = app.read(PAGE);
      // A fresh ref: the edit above moved the file on, and a ref carries the
      // revision it was read at.
      const p7 = await run('target', 'read');
      const sameCard = p7.target?.children?.find((c) => c.tag === 'Card');
      const set7 = await run('target', 'set_prop', { ref: sameCard.ref, name: 'body', value: "it's here" });
      await H.settle(250);
      const afterApos = app.read(PAGE);
      check(
        'a value carrying an apostrophe takes double quotes instead',
        set7.ok === true && afterApos.includes('body="it\'s here"'),
        short({ ok: set7.ok, at: afterApos.slice(afterApos.indexOf('<Card'), afterApos.indexOf('<Card') + 180) })
      );
      check(
        '  and still changes only that attribute',
        afterApos.replace('body="it\'s here"', "body='across lines still'") === beforeApos,
        short({ span: changedSpan(beforeApos, afterApos) })
      );
      const p8 = await run('target', 'read');
      const readBack = await run('target', 'read', { ref: p8.target?.children?.find((c) => c.tag === 'Card')?.ref });
      check(
        '  and reads back as the value that was asked for',
        readBack.target?.props?.body?.value === "it's here",
        short(readBack.target?.props)
      );
    }

    // --- A STRUCTURAL EDIT, IN THE FILE THAT CARRIES EVERYTHING ELSE.
    //
    // Everything above is one attribute on one node, which is the case this
    // path always handled. An insert changes how many children a level has, and
    // the answer to that used to be "reprint the level" -- here `<Base>`, which
    // is the whole body: 844 bytes rewritten to add 30, the tabs turned into
    // spaces and the frontmatter comments torn off their imports.
    // test/source-fidelity-matrix.js measures every operation across four
    // differently-written files; this asks the one question that needs THIS
    // fixture, which also holds a `.map()` and a rendered space inside a
    // <label> that the insert never named.
    {
      const beforeInsert = app.read(PAGE);
      const p9 = await run('target', 'read');
      const footer = p9.target?.children?.find((c) => c.tag === 'footer');
      check('the page reports its footer', !!footer?.ref, short(p9.target?.children?.map((c) => c.tag)));
      const inserted = await run('target', 'append_child', {
        ref: footer.ref,
        node: { kind: 'element', tag: 'img', props: { src: '/logo.png', alt: 'Logo' } },
      });
      await H.settle(250);
      const afterInsert = app.read(PAGE);
      const line = '\n        <img src="/logo.png" alt="Logo" />';
      check('a child can be appended', inserted.ok === true && afterInsert.includes('<img src="/logo.png"'), short(inserted));
      check(
        "  at the file's own four-space indentation",
        afterInsert.includes(`${line}\n    </footer>`),
        short(afterInsert.slice(afterInsert.indexOf('<footer'), afterInsert.indexOf('<footer') + 200))
      );
      check(
        '  and every other byte in the file is the byte that was there',
        afterInsert.replace(line, '') === beforeInsert,
        short({ span: changedSpan(beforeInsert, afterInsert) })
      );
      check(
        '  including the map, the label and the comments above the imports',
        afterInsert.includes('\n        {plans.map(') &&
          /Full name:(\s|&nbsp;)/.test(afterInsert.slice(afterInsert.indexOf('Full name:'))) &&
          /\/\/ Component imports\nimport Hero/.test(afterInsert),
        short(frontmatterOf(afterInsert))
      );
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }
  check('the fixture is gone', !require('node:fs').existsSync(root), root);

  if (failures.length) {
    console.error(`source-fidelity: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`source-fidelity: ${checked} passed  [one prop changes one attribute, and nothing else in the file]`);
})().catch((err) => {
  console.error('source-fidelity: threw\n', err?.stack || err);
  process.exit(1);
});
