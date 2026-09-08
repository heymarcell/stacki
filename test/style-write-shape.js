// The SHAPE of the CSS Stacki writes into somebody's file.
//
//   node test/style-write-shape.js
//
// A style write is not finished when the declaration is correct. It lands in a
// file a person reads, reviews and commits, and a rule that parses but is laid
// out wrongly is something they have to tidy by hand after every agent edit.
//
// The case here is a rule created inside an Astro `<style>` block, where every
// rule is indented one level in. postcss infers a new node's leading whitespace
// from its siblings, so the selector and the declarations line up — but
// `raws.after`, the whitespace before the closing brace, has no sibling to copy
// and defaults to a bare newline. The result:
//
//   \t.selector {
//   \t\tprop: value;
//   }
//
// A live dogfood found exactly that block in a component and, reading the
// closing brace at column 0, took it for a corruption. It is not — it parses —
// but it is not what anyone would have typed.

const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

// Every line of the block for `selector`, as written.
function blockLines(text, selector) {
  const at = text.indexOf(selector + ' {');
  if (at === -1) return null;
  const end = text.indexOf('}', at);
  if (end === -1) return null;
  return text.slice(at - (text.slice(0, at).length - text.slice(0, at).lastIndexOf('\n') - 1), end + 1).split('\n');
}

(async () => {
  // A component whose global block is indented inside the <style> tag, which is
  // how every Astro component in the world is written.
  const COMPONENT = 'src/components/Themed.astro';
  const root = H.makeProject({
    [COMPONENT]: `---
const { label } = Astro.props;
---

<div class="themed">{label}</div>

<style is:global>
	.themed {
		color: #222;
	}

	.themed-alt {
		color: #444;
	}
</style>
`,
    'src/pages/themed.astro': `---
import Themed from '../components/Themed.astro';
---

<!doctype html>
<html lang="en">
  <body>
    <Themed label="hi" />
  </body>
</html>
`,
  });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  await run('page', 'open', { route: '/themed' });
  await H.settle(400);

  // ── A rule created in an indented block closes where it opened ────────────

  {
    const before = app.read(COMPONENT);
    check('the fixture block is indented', /\n\t\.themed \{/.test(before), short(before));

    const sources = await run('style', 'list_sources');
    const themed = (sources.sources || []).find((s) => String(s.label).includes('Themed'));
    check('the component is offered as a style source', !!themed, short(sources.sources));

    const wrote = await run('style', 'set_property', {
      selector: '.themed-new',
      source: themed.key,
      property: 'letter-spacing',
      value: '0.05em',
    });
    check('a rule can be created in the component block', wrote.ok === true, short(wrote));
    await H.settle(300);

    const after = app.read(COMPONENT);
    check('the rule is in the file', /\.themed-new/.test(after), after);

    // THE INVARIANT. The closing brace is indented like the ones already there,
    // not parked at column 0.
    const lines = blockLines(after, '.themed-new');
    check('the created rule was found', !!lines, after);
    const closing = lines[lines.length - 1];
    check('its closing brace is indented like its neighbours', closing === '\t}', `saw ${short(closing)}\n    ${after}`);
    check('and its declaration is indented one deeper', lines.some((l) => l === '\t\tletter-spacing: 0.05em;'), after);

    // Nothing already in the file moved.
    check('the rules that were already there are untouched', /\n\t\.themed \{\n\t\tcolor: #222;\n\t\}/.test(after), after);
    check('  including the second one', /\n\t\.themed-alt \{\n\t\tcolor: #444;\n\t\}/.test(after), after);

    // And it is still parseable as the same block.
    check('the style block still closes properly', /<\/style>/.test(after) && after.indexOf('</style>') > after.indexOf('.themed-new'), after);
  }

  // ── A stylesheet is unaffected: column 0 is right there ───────────────────

  {
    const wrote = await run('style', 'set_property', {
      selector: '.sheet-rule',
      source: 'file:src/styles/site.css',
      property: 'color',
      value: 'red',
    });
    check('a rule can still be created in a stylesheet', wrote.ok === true, short(wrote));
    await H.settle(300);
    const css = app.read('src/styles/site.css');
    check('and there it closes at column 0, as its neighbours do', /\n\.sheet-rule \{\n\s+color: red;\n\}/.test(css), css);
  }

  await app.stop?.();
  H.removeProject(root);

  if (failures.length) {
    console.error(`style-write-shape: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`style-write-shape: ${checked} passed  [a created rule closes where it opened]`);
})().catch((err) => {
  console.error('style-write-shape: threw', err);
  process.exit(1);
});
