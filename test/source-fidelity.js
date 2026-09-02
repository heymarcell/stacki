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
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }

  if (failures.length) {
    console.error(`source-fidelity: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`source-fidelity: ${checked} passed  [one prop changes one attribute, and nothing else in the file]`);
})().catch((err) => {
  console.error('source-fidelity: threw\n', err?.stack || err);
  process.exit(1);
});
