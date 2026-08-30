// Every Agent operation's executable scenario, with a postcondition.
//
// Split from the runner on purpose: test/mcp-operation-matrix.js needs to know
// WHICH operations have a scenario without executing a hundred of them, and
// test/mcp-wire-coverage.js needs to execute them.
//
// THE RULE, enforced by the framework rather than by review (see
// mcpOperationScenarios.js): a FULL scenario returns `{ envelope, checks }`,
// the envelope must have `ok === true`, and at least one check must hold. An
// earlier version of this file used a helper that accepted `ok: false` — sixty
// one of a hundred and seven FULL scenarios were really proving "reachable,
// and its errors are shaped right", which is worth knowing and is not what
// FULL says. There is now no way to write that by accident.
//
// Checks assert OUTSIDE the envelope wherever the operation leaves a trace:
// the file on disk, the branch git reports, the thing that is gone. Where the
// operation only answers, the check is about what it actually contained.

const fs = require('node:fs');
const path = require('node:path');
const { fullScenario, boundaryScenario } = require('./mcpOperationScenarios.js');
const { withFakeGh } = require('./fakeGh.js');
const { DOT_WIDTH, DOT_HEIGHT, ROBOTS_CANARY } = require('./mcpWireFixture.js');

// Walk a target tree into a flat list; several scenarios need to find a node.
const flatten = (root) => {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.shift();
    if (!n) continue;
    out.push(n);
    for (const c of n.children || []) stack.push(c);
  }
  return out;
};

// ── target ─────────────────────────────────────────────────────────────────

// The ref of one named node under what Stacki is looking at — and nothing else.
//
// The runner's shared `ref()` answers with a NEIGHBOUR when the tag it was
// asked for is not there (`hit || seen[1] || root`). That fallback is silent,
// so "the operation did the right thing to the wrong element" arrived here as
// a scenario that still passed: ask for the div, get <Hero>, add the class to
// <Hero>, and a check that only asks whether the token is somewhere in the page
// says yes. Here a miss throws, and the answer names what it could not find.
//
// It reads through `target.read`, which is a DIFFERENT action from every
// operation that uses it — so the one-subject-call rule is untouched. The one
// scenario it cannot serve is target.read's own, which proves the same thing
// from the answer it is judging.
const nodeNamed = async (call, want) => {
  const { envelope } = await call('target', 'read');
  const wanted = String(want).toLowerCase();
  const found = flatten(envelope?.target).find((n) => String(n.tag || n.name || '').toLowerCase() === wanted);
  if (!found?.ref) {
    const saw = flatten(envelope?.target).map((n) => n.tag || n.name || n.kind).join(', ');
    throw new Error(`the fixture has no <${want}> under <${envelope?.target?.tag || '?'}> — it has: ${saw}`);
  }
  return found.ref;
};

/** The one opening tag of `<div class="pricing-grid …">`, as authored. */
const gridTag = (src) => (src.match(/<div\b[^>]*pricing-grid[^>]*>/) || [null])[0];

/** How many times something appears. */
const countOf = (src, re) => (src.match(re) || []).length;

const INDEX = 'src/pages/index.astro';

fullScenario({ domain: 'target', action: 'read', run: async ({ call, ref, fixture }) => {
  // A NAMED node, not "whatever is selected". A read that ignored the ref
  // entirely would answer about <Base>, which is what the fixture selects by
  // default — and that is exactly what this used to accept.
  const { envelope } = await call('target', 'read', { ref: await ref('footer') });
  const t = envelope?.target;
  const src = fixture.read(INDEX);
  const lines = src.split('\n');
  const at = t?.source || {};
  return { envelope, checks: [
    ['it answered about the footer that was asked for', t?.tag === 'footer'],
    ['with the words that footer really holds', t?.text?.value === 'Made carefully.'],
    ['and the one child the page authors inside it', (t?.children || []).length === 1 && t.children[0]?.tag === 'p' && t.children[0]?.text === 'Made carefully.'],
    ['the source trail names the page file', at.file === INDEX],
    // The half of the contract nothing else in the domain covers: withSource()
    // resolves the key chain to a real file:line. So go to that line in the
    // file on disk and check what is written there.
    ['and the line it points at is where <footer> is authored', typeof at.startLine === 'number' && (lines[at.startLine - 1] || '').includes('<footer>')],
    ['the snippet is the markup around it', typeof t?.snippet?.text === 'string' && t.snippet.text.includes('<footer>') && t.snippet.text.includes('Made carefully.')],
    ['and it hands back a ref to the node it read', typeof t?.ref === 'string' && t.ref.startsWith('stacki:')],
  ] };
} });

fullScenario({ domain: 'target', action: 'select', run: async ({ call }) => {
  // Selection state is readable: a target.read with no ref answers about
  // whatever is selected. So the proof is that the identity MOVED — from the
  // <Base> wrapper the fixture opens on, to the node that was asked for.
  const heroRef = await nodeNamed(call, 'Hero');
  const before = await call('target', 'read');
  const { envelope } = await call('target', 'select', { ref: heroRef });
  const now = await call('target', 'read');
  const t = now.envelope?.target;
  return { envelope, checks: [
    ['the selection was somewhere else to begin with', before.envelope?.target?.tag === 'Base'],
    ['the editor now reads the node that was selected', t?.tag === 'Hero'],
    ['and knows it as the component instance it is', t?.component?.name === 'Hero'],
    ['at the position the page puts it in', JSON.stringify(t?.keys) === JSON.stringify(['src/pages/index.astro#0.0'])],
    ['and the answer names that same node', JSON.stringify(envelope?.keys) === JSON.stringify(['src/pages/index.astro#0.0'])],
  ] };
} });

fullScenario({ domain: 'target', action: 'enter', run: async ({ call, ref }) => {
  const { envelope } = await call('target', 'enter', { ref: await ref('Hero') });
  const inside = flatten(envelope?.target);
  return { envelope, checks: [
    ['entering a component answers with its own tree', inside.length > 1],
    ['which contains the h1 authored in Hero.astro', inside.some((n) => String(n.tag || '').toLowerCase() === 'h1')],
  ] };
} });

fullScenario({ domain: 'target', action: 'exit', run: async ({ call }) => {
  // `target.page` is the page on the CANVAS and it stays index.astro the whole
  // time you are inside Hero — so asserting it proves nothing about leaving.
  // The DOCUMENT identity is what moves: the source trail and the key chain.
  await call('target', 'enter', { ref: await nodeNamed(call, 'Hero') });
  const within = await call('target', 'read');
  const { envelope } = await call('target', 'exit', {});
  const back = await call('target', 'read');
  const keysOut = back.envelope?.target?.keys || [];
  return { envelope, checks: [
    ['it was inside Hero.astro to begin with', within.envelope?.target?.source?.file === 'src/components/Hero.astro'],
    ['the exit says it left', envelope?.exited === true],
    ['and answers about the page, in the page file', envelope?.target?.tag === 'Base' && envelope?.target?.source?.file === INDEX],
    ['the editor now reads the page document again', back.envelope?.target?.source?.file === INDEX],
    ['and nothing in the key chain still names the component file', keysOut.length > 0 && !keysOut.some((k) => String(k).includes('src/components/Hero.astro'))],
    ['with the Hero instance visible in it once more', (back.envelope?.target?.children || []).some((c) => c.tag === 'Hero')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_text', run: async ({ call, ref, fixture }) => {
  const inside = await call('target', 'enter', { ref: await ref('Hero') });
  const h1 = flatten(inside.envelope?.target).find((n) => String(n.tag || '').toLowerCase() === 'h1');
  const before = fixture.read('src/components/Hero.astro');
  const { envelope } = await call('target', 'set_text', { ref: h1?.ref, text: 'Wire-driven heading', replaceBinding: true });
  const after = fixture.read('src/components/Hero.astro');
  return { envelope, checks: [
    ['the text is in Hero.astro on disk', after.includes('Wire-driven heading')],
    ['and the old text is gone', !after.includes('Welcome to Stacki')],
    // Present and absent are both true of a handler that rewrote the component
    // as a single line. What must survive is everything around the heading.
    ['the rest of the component is still there', after.includes('Astro.props') && after.includes('<section') && after.includes('{heading}') === before.includes('{heading}')],
    ['the element it was written into is still an h1', /<h1[^>]*>[^<]*Wire-driven heading/.test(after)],
    ['and the file is what it was with that one text replaced', after.replace('Wire-driven heading', 'Welcome to Stacki') === before],
  ] };
} });

// SEVERAL operations, of different kinds, on ONE target — which is what the
// registry advertises and what a batch that quietly applies only its first
// operation would fail. Both halves are asserted on the same opening tag, so
// "the right change to the wrong element" cannot pass either.
fullScenario({ domain: 'target', action: 'edit', run: async ({ call, fixture }) => {
  const { envelope } = await call('target', 'edit', {
    ref: await nodeNamed(call, 'div'),
    operations: [
      { type: 'add_class', className: 'wire-batch' },
      { type: 'set_prop', name: 'data-batch', value: 'yes' },
    ],
  });
  const src = fixture.read(INDEX);
  const tag = gridTag(src);
  return { envelope, checks: [
    ['the target div is still there to have been edited', typeof tag === 'string'],
    ['the first operation landed on it', !!tag && / class="pricing-grid wire-batch"/.test(tag)],
    ['the second one landed on it too', !!tag && tag.includes('data-batch="yes"')],
    ['and on nothing else', countOf(src, /data-batch/g) === 1 && countOf(src, /wire-batch/g) === 1],
    ['the element the page already had is intact', src.includes('{plans.map((plan) => (')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_prop', run: async ({ call, fixture }) => {
  const { envelope } = await call('target', 'set_prop', { ref: await nodeNamed(call, 'div'), name: 'data-wire', value: 'yes' });
  const src = fixture.read(INDEX);
  const tag = gridTag(src);
  return { envelope, checks: [
    ['the prop is on the div that was named', !!tag && /data-wire="yes"/.test(tag)],
    ['and on no other element in the page', countOf(src, /data-wire/g) === 1],
    ['the props it already had are untouched', !!tag && tag.includes('class="pricing-grid"')],
    ['and neither the component nor the footer was written to', /<Hero heading=\{site\.tagline\} \/>/.test(src) && src.includes('<footer>')],
  ] };
} });

fullScenario({ domain: 'target', action: 'remove_prop', run: async ({ call, fixture }) => {
  // Two props put on in one setup step, so removing ONE can be told apart from
  // clearing the map — which is what "the prop is gone" alone accepted.
  await call('target', 'edit', {
    ref: await nodeNamed(call, 'div'),
    operations: [
      { type: 'set_prop', name: 'data-doomed', value: 'x' },
      { type: 'set_prop', name: 'data-keep', value: 'y' },
    ],
  });
  const before = gridTag(fixture.read(INDEX));
  const { envelope } = await call('target', 'remove_prop', { ref: await nodeNamed(call, 'div'), name: 'data-doomed' });
  const tag = gridTag(fixture.read(INDEX));
  return { envelope, checks: [
    ['both props were there first', !!before && before.includes('data-doomed="x"') && before.includes('data-keep="y"')],
    ['the named one is gone', !!tag && !tag.includes('data-doomed')],
    ['the other one is still there', !!tag && tag.includes('data-keep="y"')],
    ['and so is the class the element came with', !!tag && tag.includes('class="pricing-grid"')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_classes', run: async ({ call, fixture }) => {
  // REPLACEMENT is the whole difference between this and add_class, so the old
  // list has to be gone. `pricing-grid` appears in index.astro only in this
  // div's class attribute, which is what makes its absence provable.
  const { envelope } = await call('target', 'set_classes', { ref: await nodeNamed(call, 'div'), classes: ['wire-only', 'wire-too'] });
  const src = fixture.read(INDEX);
  return { envelope, checks: [
    ['the class list is exactly what was asked for', /<div class="wire-only wire-too"/.test(src)],
    ['the list it replaced is gone', !src.includes('pricing-grid')],
    ['and the element itself survived the replacement', src.includes('{plans.map((plan) => (') && countOf(src, /<div\b/g) === 1],
  ] };
} });

fullScenario({ domain: 'target', action: 'add_class', run: async ({ call, fixture }) => {
  // Added, not set: an add_class implemented as set_classes loses pricing-grid,
  // and one that walked to a neighbour never touches this tag at all.
  const { envelope } = await call('target', 'add_class', { ref: await nodeNamed(call, 'div'), className: 'wire-added' });
  const src = fixture.read(INDEX);
  return { envelope, checks: [
    ['the class it already had is kept, and the new one appended', /<div class="pricing-grid wire-added"/.test(src)],
    ['on that element only', countOf(src, /wire-added/g) === 1],
  ] };
} });

fullScenario({ domain: 'target', action: 'remove_class', run: async ({ call, fixture }) => {
  // Three classes to start with, so "removed the one named" is told apart from
  // "emptied the attribute" — which the old pair of checks could not do.
  await call('target', 'edit', {
    ref: await nodeNamed(call, 'div'),
    operations: [{ type: 'set_classes', classes: ['pricing-grid', 'wire-doomed', 'keep-me'] }],
  });
  const before = fixture.read(INDEX).includes('wire-doomed');
  const { envelope } = await call('target', 'remove_class', { ref: await nodeNamed(call, 'div'), className: 'wire-doomed' });
  const src = fixture.read(INDEX);
  return { envelope, checks: [
    ['the class was there to remove', before],
    ['it is gone from the page', !src.includes('wire-doomed')],
    ['and the classes either side of it stayed, in order', /<div class="pricing-grid keep-me"/.test(src)],
  ] };
} });

fullScenario({ domain: 'target', action: 'insert_before', run: async ({ call, fixture }) => {
  // BEFORE the anchor and OUTSIDE it. Without both, this check and
  // insert_after's are interchangeable and neither operation is really tested.
  const { envelope } = await call('target', 'insert_before', { ref: await nodeNamed(call, 'div'), node: { kind: 'element', tag: 'p', text: 'inserted-before' } });
  const src = fixture.read(INDEX);
  const at = src.indexOf('inserted-before');
  return { envelope, checks: [
    ['the new node is in the page', at >= 0],
    ['it is before the anchor, not after it', at >= 0 && at < src.indexOf('<div')],
    ['a sibling of the anchor rather than a child of it', at >= 0 && at < src.indexOf('class="pricing-grid"')],
    ['in the slot immediately before it, not at the top of the page', at > src.indexOf('<Hero') && at > src.indexOf('<Base>')],
    ['and the anchor is untouched', /<div class="pricing-grid">/.test(src)],
  ] };
} });

fullScenario({ domain: 'target', action: 'insert_after', run: async ({ call, fixture }) => {
  const { envelope } = await call('target', 'insert_after', { ref: await nodeNamed(call, 'div'), node: { kind: 'element', tag: 'p', text: 'inserted-after' } });
  const src = fixture.read(INDEX);
  const at = src.indexOf('inserted-after');
  return { envelope, checks: [
    ['the new node is in the page', at >= 0],
    ['it is after the anchor, not before it', at >= 0 && at > src.indexOf('class="pricing-grid"')],
    ['a sibling of the anchor rather than its last child', at >= 0 && at > src.indexOf('</div>')],
    ['in the slot immediately after it, not at the end of the page', at >= 0 && at < src.indexOf('<footer>')],
    ['and the anchor is untouched', /<div class="pricing-grid">/.test(src)],
  ] };
} });

fullScenario({ domain: 'target', action: 'append_child', run: async ({ call, fixture }) => {
  // INSIDE the target and LAST — a sibling of the footer, or its first child,
  // is a different operation and used to pass this scenario.
  const { envelope } = await call('target', 'append_child', { ref: await nodeNamed(call, 'footer'), node: { kind: 'element', tag: 'span', text: 'appended-child' } });
  const src = fixture.read(INDEX);
  const block = (src.match(/<footer>[\s\S]*?<\/footer>/) || [''])[0];
  return { envelope, checks: [
    ['the footer is still one element', countOf(src, /<footer>/g) === 1 && block.length > 0],
    ['the new node is inside it', block.includes('<span>appended-child</span>')],
    ['after the child it already had, not before it', block.indexOf('appended-child') > block.indexOf('Made carefully.')],
    ['which is still there', block.includes('<p>Made carefully.</p>')],
    ['and nothing was inserted outside the footer', countOf(src, /appended-child/g) === 1],
  ] };
} });

// Counts the node it actually duplicates. This asked for a copy of <footer>
// and then counted <Hero>, which of course never moved — the operation had
// been working the whole time and the canary was pointed at the wrong bird.
fullScenario({ domain: 'target', action: 'duplicate', run: async ({ call, ref, fixture }) => {
  const count = (src, re) => (src.match(re) || []).length;
  const src = () => fixture.read('src/pages/index.astro');
  const FOOTER = /<footer[\s>]/g;
  const before = src();
  const footersBefore = count(before, FOOTER);
  const { envelope } = await call('target', 'duplicate', { ref: await ref('footer') });
  const after = src();
  return { envelope, checks: [
    ['the node it was asked to copy was there to copy', footersBefore === 1],
    ['and afterwards the page has exactly one more', count(after, FOOTER) === footersBefore + 1],
    ['the copy carries the original\'s content', count(after, /Made carefully\./g) === 2],
    ['the original is still there', after.includes('<footer>')],
    ['nothing else was duplicated', count(after, /<Hero/g) === count(before, /<Hero/g) && count(after, /pricing-grid/g) === count(before, /pricing-grid/g)],
    ['and it hands back a ref to work with', typeof envelope?.ref === 'string' && envelope.ref.startsWith('stacki:')],
    ['naming the file it changed', JSON.stringify(envelope?.changedFiles || []).includes('src/pages/index.astro')],
  ] };
} });

fullScenario({ domain: 'target', action: 'move', run: async ({ call, fixture }) => {
  // The document root, position 0 — which per src/modelOps.js moveNode puts the
  // div BEFORE <Base>. "The source is not what it was" accepted a move of any
  // node to anywhere, and a reserialization that moved nothing at all.
  const { envelope } = await call('target', 'move', { ref: await nodeNamed(call, 'div'), to: { index: 0 } });
  const src = fixture.read(INDEX);
  const grid = src.indexOf('class="pricing-grid"');
  const base = src.indexOf('<Base>');
  const closeBase = src.indexOf('</Base>');
  const block = (src.match(/<div class="pricing-grid">[\s\S]*?<\/div>/) || [''])[0];
  return { envelope, checks: [
    ['the div is now ahead of the layout it used to be inside', grid >= 0 && base >= 0 && grid < base],
    ['and there is still exactly one of it', countOf(src, /pricing-grid/g) === 1],
    ['its children travelled with it', block.includes('{plans.map((plan) => (') && block.includes('<Card title={plan.title}')],
    ['what it left behind stayed where it was', src.indexOf('<Hero') > base && src.indexOf('<Hero') < closeBase && src.indexOf('<footer>') > base && src.indexOf('<footer>') < closeBase],
    ['and the frontmatter the moved node reads came with it', src.includes('const plans = [')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_tag', run: async ({ call, fixture }) => {
  // Given a prop to carry, because the registry promises the retag keeps "the
  // attributes the new tag understands" — and given the exact ref the insert
  // handed back, so the element retagged is beyond doubt the one set up here.
  const made = await call('target', 'insert_after', {
    ref: await nodeNamed(call, 'div'),
    node: { kind: 'element', tag: 'p', text: 'retag-me', props: { id: 'keepme' } },
  });
  const { envelope } = await call('target', 'set_tag', { ref: made.envelope?.ref, tag: 'h4' });
  const src = fixture.read(INDEX);
  return { envelope, checks: [
    ['the element was authored as a <p> first', made.envelope?.ok === true],
    ['it is an <h4> now, with its text and its attribute', /<h4 id="keepme">retag-me<\/h4>/.test(src)],
    ['the <p> it used to be is gone rather than left beside it', !/<p[^>]*>retag-me/.test(src)],
    ['and there is exactly one h4 in the page', countOf(src, /<h4[\s>]/g) === 1],
    ['it is still standing where the setup put it', src.indexOf('<h4') > src.indexOf('class="pricing-grid"') && src.indexOf('<h4') < src.indexOf('<footer>')],
    ['the other paragraph in the page was not the one retagged', src.includes('<p>Made carefully.</p>')],
  ] };
} });

fullScenario({ domain: 'target', action: 'remove', run: async ({ call, fixture }) => {
  // The pricing-grid div, not a scratch node: removing it exercises the half of
  // the contract the registry names and nothing tested — "its note, and
  // frontmatter nothing else reads". `plans` and the Card import are read by
  // this node and by nothing else, so they must go with it; `site` is read by
  // <Hero> as well, so it must not.
  const before = fixture.read(INDEX);
  const { envelope } = await call('target', 'remove', { ref: await nodeNamed(call, 'div') });
  const src = fixture.read(INDEX);
  return { envelope, checks: [
    ['the node and its frontmatter were both there first', before.includes('class="pricing-grid"') && before.includes('const plans = [')],
    ['the node is gone', !src.includes('pricing-grid')],
    ['and the answer says there is nothing left to point at', envelope?.gone === true && envelope?.ref === null],
    ['what it was beside is still there', /<Hero heading=\{site\.tagline\} \/>/.test(src) && src.includes('<p>Made carefully.</p>') && src.includes('<Base>')],
    ['the frontmatter only that node read went with it', !src.includes('const plans') && !src.includes("import Card from '../components/Card.astro'")],
    ['the frontmatter something else still reads stayed', src.includes("import site from '../data/site.json'") && src.includes("import Hero from '../components/Hero.astro'")],
    ['and it said so out loud', (envelope?.notes || []).some((n) => String(n).includes('plans'))],
  ] };
} });


// ── style ──────────────────────────────────────────────────────────────────

const firstCell = async (call) => {
  const { envelope } = await call('style', 'variables', {});
  for (const file of envelope?.files || []) for (const g of file.groups || []) for (const b of g.blocks || []) for (const r of b.rows || []) for (const c of r.cells || []) if (c?.name) return c;
  return null;
};
const css = (fixture) => fixture.read('src/styles/site.css');

/** Every variable cell `style.variables` reported, keyed by name. */
const cellsByName = (envelope) => {
  const out = new Map();
  for (const file of envelope?.files || []) for (const g of file.groups || []) for (const b of g.blocks || []) for (const r of b.rows || []) for (const c of r.cells || []) if (c?.name) out.set(c.name, c);
  return out;
};

// SCOPED TO THE RULE, which is the whole difference between a real oracle and
// a green light.
//
// "site.css contains `outline`" is true of a declaration that landed in .card,
// in a brand new rule appended to the end of the file, or in a comment. What
// the operation promises is a property ON A SELECTOR, so the assertion has to
// be about the braces that selector opens. The array (rather than one match)
// is deliberate too: a second `.pricing-grid { … }` invented beside the first
// is a distinct wrong answer, and length === 1 is how it gets caught.
const ruleBlock = (src, selector) =>
  src.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'g')) || [];

// The fixture's stylesheet, rule by rule — see test/agent-harness.js. Written
// out here so a check can say "and the rest of the file is exactly what it
// was" instead of naming one token that had to survive.
const ROOT_RULE = ':root {\n  --gap: 1rem;\n  --brand: #3355ff;\n}';
const GRID_RULE = '.pricing-grid {\n  display: grid;\n  gap: var(--gap);\n}';
const CARD_RULE = '.card {\n  padding: 1rem;\n  border: 1px solid #eee;\n}';
const SHEET = `${ROOT_RULE}\n\n${GRID_RULE}\n\n${CARD_RULE}\n`;

fullScenario({ domain: 'style', action: 'list_sources', run: async ({ call }) => {
  const { envelope } = await call('style', 'list_sources', {});
  return { envelope, checks: [['it names the fixture stylesheet', (envelope?.sources || []).some((x) => String(x.label || x.key).includes('site.css'))]] };
} });

// `rules: []` is an Array. So a cascade that matched nothing, resolved no
// stylesheet, or lost the layout's `import '../styles/site.css'` all answered
// the old shape check. What this operation is FOR is the answer to "why does
// this look like that", so the assertions are about the answer: the rule the
// fixture authors for this element, from the file that holds it, with the
// declarations as authored and an identity a write can be aimed with.
fullScenario({ domain: 'style', action: 'read', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('style', 'read', { ref: await ref('div') });
  const grid = (envelope?.rules || []).find((r) => r.selector === '.pricing-grid');
  const decl = (property) => (grid?.declarations || []).find((d) => d.property === property);
  return { envelope, checks: [
    ['it answered about the element it was pointed at', envelope?.element?.tag === 'div' && (envelope?.element?.classes || []).includes('pricing-grid')],
    ['the rule the stylesheet authors for that element is in the cascade', !!grid],
    ['attributed to the file that really holds it', grid?.source?.file === 'src/styles/site.css' && grid?.source?.kind === 'stylesheet' && css(fixture).includes(GRID_RULE)],
    ['with the declarations as authored, not as guessed', decl('display')?.value === 'grid' && decl('gap')?.value === 'var(--gap)'],
    ['the var() one of them reads is named rather than flattened away', (decl('gap')?.variables || []).includes('--gap')],
    [
      'and each one carries an identity a write can be aimed with',
      (grid?.declarations || []).length === 2 &&
        grid.declarations.every((d) => d?.identity?.selector === '.pricing-grid' && d.identity.source === 'file:src/styles/site.css' && d.identity.property === d.property && !!d.identity.sourceDigest),
    ],
    // The other rule in the same stylesheet does not match this element. A read
    // that hands back every rule in the file — which is what "grep for the
    // class" would do — says it does.
    ['the rule in that file which does NOT reach this element is not claimed to', !(envelope?.rules || []).some((r) => r.selector === '.card')],
  ] };
} });

fullScenario({ domain: 'style', action: 'read_source', run: async ({ call }) => {
  const { envelope } = await call('style', 'read_source', { path: 'src/styles/site.css' });
  return { envelope, checks: [
    ['it returns the stylesheet text', typeof envelope?.css === 'string'],
    ['containing the variable the fixture declares', String(envelope?.css || '').includes('--gap')],
    ['and a digest to guard a write with', !!envelope?.digest],
  ] };
} });

fullScenario({ domain: 'style', action: 'variables', run: async ({ call, fixture }) => {
  // One subject call, and it is the LAST one: `firstCell` also asks
  // style.variables, so calling it after would leave the runner holding a
  // different invocation than the one being judged. The framework caught
  // exactly that, which is what it is for.
  const sheet = css(fixture);
  const { envelope } = await call('style', 'variables', {});
  const cells = cellsByName(envelope);
  const site = (envelope?.files || []).find((f) => f.path === 'src/styles/site.css');
  // THE OFFSETS ARE THE AIM. set_variable, add_variables, add_section,
  // remove_section and move_heading are all writes at a byte position this
  // answer reported, so "valueStart is a number" is not a postcondition — a
  // cell that reports --brand with --gap's span is a write in the wrong place
  // with a green test. The question is whether the span cuts that variable's
  // value out of the file, with that variable's name immediately in front.
  const aims = (cell, name, value) =>
    !!cell &&
    cell.file === 'src/styles/site.css' &&
    cell.selector === ':root' &&
    cell.value === value &&
    sheet.slice(cell.valueStart, cell.valueEnd) === value &&
    sheet.slice(0, cell.valueStart).trimEnd().endsWith(`${name}:`);
  return { envelope, checks: [
    ['it reports the fixture stylesheet, and every variable in it', !!site && site.count === 2 && site.error === null],
    ['resolved to the values that stylesheet declares', envelope?.values?.['--gap'] === '1rem' && envelope?.values?.['--brand'] === '#3355ff'],
    ['--gap’s span cuts exactly its value out of the file', aims(cells.get('--gap'), '--gap', '1rem')],
    ['--brand’s span cuts exactly its value out of the file', aims(cells.get('--brand'), '--brand', '#3355ff')],
  ] };
} });

// "Replace a stylesheet" means the file IS the text that was sent. A write
// that stored only the appended tail — losing :root, --gap, --brand and both
// rules — contains '.wire-written' too, which is all the old check asked.
fullScenario({ domain: 'style', action: 'write_source', run: async ({ call, fixture }) => {
  const before = css(fixture);
  const read = await call('style', 'read_source', { path: 'src/styles/site.css' });
  const next = String(read.envelope?.css || '') + '\n.wire-written { color: red; }\n';
  const { envelope } = await call('style', 'write_source', { path: 'src/styles/site.css', css: next, expectedDigest: read.envelope?.digest });
  const after = css(fixture);
  return { envelope, checks: [
    ['the text it was built from was the whole stylesheet', String(read.envelope?.css || '') === before],
    ['the stylesheet on disk is exactly the text that was sent', after === next],
    ['so everything that was in it is still in it', after.includes(ROOT_RULE) && after.includes(GRID_RULE) && after.includes(CARD_RULE)],
    ['with the new rule, and only it, added', /\.wire-written \{ color: red; \}/.test(after) && after === `${before}\n.wire-written { color: red; }\n`],
    ['and the answer names the file it wrote and how it now reads', envelope?.path === 'src/styles/site.css' && typeof envelope?.afterDigest === 'string' && envelope.afterDigest.length > 0],
  ] };
} });

// The destination is the point. Two independent substring tests are satisfied
// by 'outline' landing in .card while '3px solid red' lands anywhere else at
// all — so this asks about the braces the requested selector opens.
// The ref does not choose the file here — `selector` and `source` are given
// explicitly, and that is the operation's contract, not an oversight. What the
// ref is for is the element the declaration has to end up styling, so that is
// what is checked: the rule is read back through the SAME ref, with style.read,
// and the new declaration has to be in that element's own cascade.
fullScenario({ domain: 'style', action: 'set_property', run: async ({ call, ref, fixture }) => {
  const before = css(fixture);
  const target = await ref('div');
  const { envelope } = await call('style', 'set_property', { ref: target, selector: '.pricing-grid', source: 'file:src/styles/site.css', property: 'outline', value: '3px solid red' });
  const seen = await call('style', 'read', { ref: target });
  const reaching = (seen.envelope?.rules || []).flatMap((r) => r.declarations || []);
  const after = css(fixture);
  const grid = ruleBlock(after, '.pricing-grid');
  return { envelope, checks: [
    ['the fixture stylesheet is the one these assertions are written against', before === SHEET],
    ['there is still exactly one .pricing-grid rule — no second one was invented for it', grid.length === 1],
    ['and the declaration is inside it', /outline:\s*3px solid red\s*;/.test(grid[0] || '')],
    ['what that rule already declared is still declared', /display:\s*grid\s*;/.test(grid[0] || '') && /gap:\s*var\(--gap\)\s*;/.test(grid[0] || '')],
    ['the other rules were not written into', after.includes(ROOT_RULE) && after.includes(CARD_RULE)],
    ['reading that same element back, the declaration is in its cascade', reaching.some((d) => d.property === 'outline' && d.value === '3px solid red')],
    ['and the answer names the stylesheet it authored it in', envelope?.source?.key === 'file:src/styles/site.css'],
    ['nothing else in the file moved', after === before.replace(GRID_RULE, GRID_RULE.replace('\n}', '\n  outline: 3px solid red;\n}'))],
  ] };
} });

// Weaker still before this: the PROPERTY NAME was never mentioned, so `foo:
// 0.42` anywhere in the file passed. Two declarations, because "several
// properties on one rule in a single step" is what this action is for, and one
// of them cannot show they stayed together.
fullScenario({ domain: 'style', action: 'set_declarations', run: async ({ call, ref, fixture }) => {
  const before = css(fixture);
  const target = await ref('div');
  const { envelope } = await call('style', 'set_declarations', {
    ref: target,
    selector: '.pricing-grid',
    source: 'file:src/styles/site.css',
    declarations: [{ property: 'opacity', value: '0.42' }, { property: 'z-index', value: '7' }],
  });
  const seen = await call('style', 'read', { ref: target });
  const reaching = (seen.envelope?.rules || []).flatMap((r) => r.declarations || []);
  const after = css(fixture);
  const grid = ruleBlock(after, '.pricing-grid');
  return { envelope, checks: [
    ['the fixture stylesheet is the one these assertions are written against', before === SHEET],
    ['both declarations landed on the one rule they were aimed at', grid.length === 1 && /opacity:\s*0\.42\s*;/.test(grid[0]) && /z-index:\s*7\s*;/.test(grid[0])],
    ['and it says it set both', envelope?.applied === 2],
    ['both reach the element the ref named', reaching.some((d) => d.property === 'opacity' && d.value === '0.42') && reaching.some((d) => d.property === 'z-index' && d.value === '7')],
    ['the rule was added to, not rewritten — what it declared survives', /display:\s*grid\s*;/.test(grid[0]) && /gap:\s*var\(--gap\)\s*;/.test(grid[0])],
    ['neither of them scattered into another rule', !ruleBlock(after, '.card').some((b) => /opacity|z-index/.test(b)) && after.includes(ROOT_RULE) && after.includes(CARD_RULE)],
    ['nothing else in the file moved', after === before.replace(GRID_RULE, GRID_RULE.replace('\n}', '\n  opacity: 0.42;\n  z-index: 7;\n}'))],
  ] };
} });

// A removal whose range over-reaches — taking the rest of the rule, or the
// rule, with the declaration — also makes 'letter-spacing' disappear. So the
// survivors are named, and then the whole file: the stylesheet has to be
// byte-for-byte what it was before the declaration was added.
fullScenario({ domain: 'style', action: 'remove_property', run: async ({ call, ref, fixture }) => {
  await call('style', 'set_property', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', property: 'letter-spacing', value: '3px' });
  const before = css(fixture);
  const cascade = await call('style', 'read', { ref: await ref('div') });
  const decl = (cascade.envelope?.rules || []).flatMap((r) => r.declarations || []).find((d) => d?.identity && String(d.property) === 'letter-spacing');
  const { envelope } = await call('style', 'remove_property', { ref: await ref('div'), identity: decl?.identity });
  const after = css(fixture);
  const grid = ruleBlock(after, '.pricing-grid');
  return { envelope, checks: [
    ['the declaration was really in the rule first, and only it was added', before === SHEET.replace(GRID_RULE, GRID_RULE.replace('\n}', '\n  letter-spacing: 3px;\n}'))],
    // ok:true with removed:false is what this operation answers when it could
    // not find the declaration — a no-op, and the old check could not tell it
    // apart from a removal.
    ['it says it took one out, and did not empty the rule doing it', envelope?.removed === true && envelope?.ruleRemoved === false],
    ['the declaration is gone', !after.includes('letter-spacing')],
    ['the rule it was in still declares what it declared', grid.length === 1 && /display:\s*grid\s*;/.test(grid[0]) && /gap:\s*var\(--gap\)\s*;/.test(grid[0])],
    ['the variables that rule reads are still declared', after.includes(ROOT_RULE)],
    ['and the stylesheet is byte-for-byte what it was before the declaration was added', after === SHEET],
  ] };
} });

fullScenario({ domain: 'style', action: 'set_variable', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const before = css(fixture);
  const { envelope } = await call('style', 'set_variable', { edit: { file: cell.file, valueStart: cell.valueStart, valueEnd: cell.valueEnd, value: '2.5rem', expect: cell.value } });
  const after = css(fixture);
  // AIMED, not merely present. The fixture writes `1rem` twice — as --gap's
  // value and as .card's padding — so an edit that ignored the span it was
  // handed and replaced the text everywhere satisfied "the new value is there"
  // and "the old declaration is gone", while rewriting a rule nobody asked
  // about. The span is the whole operation, so the file is checked byte for
  // byte against exactly the one substitution it was told to make.
  return { envelope, checks: [
    ['the variable holds its new value', /--gap:\s*2\.5rem/.test(after)],
    ['and its old one is gone', !new RegExp(`${cell.name}:\\s*${cell.value.replace('.', '\\.')}`).test(after)],
    ['the other declaration that reads the same way is untouched', /padding:\s*1rem/.test(after)],
    ['and nothing else in the file moved', after === before.slice(0, cell.valueStart) + '2.5rem' + before.slice(cell.valueEnd)],
  ] };
} });

// The VALUE, and the SELECTOR. `--wire-added:;` contains '--wire-added', and
// so does the same declaration written into .card, or outside every rule where
// no var() could ever read it.
fullScenario({ domain: 'style', action: 'add_variables', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const before = css(fixture);
  const { envelope } = await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-added', value: '4px' }] });
  const after = css(fixture);
  const root = ruleBlock(after, ':root');
  return { envelope, checks: [
    ['it was asked to add to the rule the fixture declares variables in', cell.selector === ':root' && cell.file === 'src/styles/site.css'],
    ['and the variable is declared there, with the value it was given', root.length === 1 && /--wire-added:\s*4px\s*;/.test(root[0])],
    ['not in a rule where nothing could read it', !ruleBlock(after, '.pricing-grid').some((b) => b.includes('--wire-added')) && !ruleBlock(after, '.card').some((b) => b.includes('--wire-added'))],
    ['the variables already declared there are untouched', /--gap:\s*1rem\s*;/.test(root[0]) && /--brand:\s*#3355ff\s*;/.test(root[0])],
    ['and one line was inserted, not the file rewritten', after === before.replace('  --brand: #3355ff;\n', '  --brand: #3355ff;\n  --wire-added: 4px;\n')],
    ['it says which variable it added', envelope?.name === '--wire-added'],
  ] };
} });

// RENAME THE ONE SOMETHING READS. The old scenario renamed a variable it had
// invented one line earlier, which nothing referenced — so the hard half of
// this operation's contract, "and every reference to them", was never
// exercised. A rename that renames the declaration and leaves every var() call
// dangling passed it. --gap is declared in :root and read by .pricing-grid.
fullScenario({ domain: 'style', action: 'rename_variables', run: async ({ call, fixture }) => {
  const before = css(fixture);
  const { envelope } = await call('style', 'rename_variables', { renames: [{ from: '--gap', to: '--wire-gap' }] });
  const after = css(fixture);
  const root = ruleBlock(after, ':root');
  const grid = ruleBlock(after, '.pricing-grid');
  return { envelope, checks: [
    ['the fixture declared --gap in one rule and read it from another', /--gap:\s*1rem/.test(before) && before.includes('gap: var(--gap)')],
    ['the declaration carries the new name and the old value', root.length === 1 && /--wire-gap:\s*1rem\s*;/.test(root[0])],
    ['the reference to it was rewritten as well', grid.length === 1 && /gap:\s*var\(--wire-gap\)\s*;/.test(grid[0])],
    ['nothing is left reading or declaring the old name', !/var\(\s*--gap\s*\)/.test(after) && !/--gap\s*:/.test(after)],
    ['the variable that was not renamed still says what it said', /--brand:\s*#3355ff\s*;/.test(root[0])],
    ['it reports both places it changed, in the one file that holds them', envelope?.occurrences === 2 && envelope?.files === 1],
    ['and the file is the same but for those two names', after === before.replace(/--gap\b/g, '--wire-gap')],
  ] };
} });

// `target` is the variable to land in FRONT of, not a selector. This used to
// pass the selector, so the move asked to land in front of a declaration named
// `:root` — which no rule has — and the operation correctly refused. Moving a
// variable to where it already is would not have proved anything either: the
// destination here is a real one, and the order is what gets checked.
fullScenario({ domain: 'style', action: 'move_variables', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-mover', value: '9px' }] });
  const before = css(fixture);
  const order = (src) => (src.match(/--[a-z-]+(?=\s*:)/g) || []);
  const orderBefore = order(before);
  const { envelope } = await call('style', 'move_variables', { moves: [{ file: cell.file, selector: cell.selector, name: '--wire-mover', target: '--gap' }] });
  const after = css(fixture);
  const orderAfter = order(after);
  return { envelope, checks: [
    ['it started after the variable it is moved in front of', orderBefore.indexOf('--wire-mover') > orderBefore.indexOf('--gap')],
    ['and ends up before it', orderAfter.indexOf('--wire-mover') < orderAfter.indexOf('--gap')],
    ['carrying its value with it', /--wire-mover:\s*9px/.test(after)],
    ['exactly once, not copied', orderAfter.filter((n) => n === '--wire-mover').length === 1],
    ['and no other variable was lost', orderBefore.every((n) => orderAfter.includes(n)) && orderAfter.length === orderBefore.length],
    // File order alone is also true of a declaration dumped above `:root {`,
    // where it declares nothing.
    ['landing inside the rule, not above it', ruleBlock(after, ':root').some((b) => /--wire-mover:\s*9px\s*;/.test(b))],
    ['and nothing but that one line moved', after === before.replace('  --wire-mover: 9px;\n', '').replace('  --gap:', '  --wire-mover: 9px;\n  --gap:')],
  ] };
} });

// POSITION IS WHAT A SECTION IS. `at: 0` writes the comment at byte 0, above
// `:root {` and outside every rule — and an implementation that appended it to
// the end of the file instead satisfies "the file contains it" identically. So
// this makes the gesture the panel actually makes, `before: '--brand'`, and
// asserts the line it drew is between the two variables it was asked to come
// between.
fullScenario({ domain: 'style', action: 'add_section', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const before = css(fixture);
  const { envelope } = await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Wire section', before: '--brand' } });
  const after = css(fixture);
  const root = ruleBlock(after, ':root');
  return { envelope, checks: [
    ['the heading is inside the rule it was asked for', root.length === 1 && root[0].includes('/* Wire section */')],
    ['drawn between the two variables it was asked to come between', /--gap:\s*1rem;\s*\n\s*\/\* Wire section \*\/\s*\n\s*--brand:/.test(after)],
    ['written once', (after.match(/Wire section/g) || []).length === 1],
    ['both variables are still declared, either side of it', /--gap:\s*1rem\s*;/.test(root[0]) && /--brand:\s*#3355ff\s*;/.test(root[0])],
    ['a line was inserted, not the file rewritten', after === before.replace('  --brand: #3355ff;', '  /* Wire section */\n  --brand: #3355ff;')],
    ['and it says what it titled the section', envelope?.title === 'Wire section'],
  ] };
} });

fullScenario({ domain: 'style', action: 'set_section_title', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Before rename', at: 0 } });
  const text = css(fixture);
  const start = text.indexOf('Before rename');
  const { envelope } = await call('style', 'set_section_title', { edit: { file: cell.file, start, end: start + 'Before rename'.length, title: 'After rename', expect: 'Before rename' } });
  const after = css(fixture);
  return { envelope, checks: [
    ['the new title is in the stylesheet', after.includes('After rename')],
    ['and the old title is gone', !after.includes('Before rename')],
    // A handler that wrote the whole stylesheet away, leaving only the new
    // comment, passed both of the checks above.
    ['the rules the file already had are all still in it', after.includes(':root') && /--gap:/.test(after) && /--brand:/.test(after) && after.includes('.pricing-grid') && after.includes('.card')],
    ['and only the title changed', after === text.replace('Before rename', 'After rename')],
  ] };
} });

// The two ways this goes wrong are named in cssVars.js's own comments, and
// "the words are gone" accepts both: cutting only the WORDS leaves an empty
// `/*  */` behind, and cutting from the heading to the end of the rule takes
// --gap and --brand with it, against an explicit promise that "the variables
// under it do not go anywhere". The heading is drawn between them here, so
// there is something under it to lose.
fullScenario({ domain: 'style', action: 'remove_section', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const original = css(fixture);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Doomed section', before: '--brand' } });
  const before = css(fixture);
  const start = before.indexOf('Doomed section');
  const { envelope } = await call('style', 'remove_section', { edit: { file: cell.file, start, end: start + 'Doomed section'.length, expect: 'Doomed section' } });
  const after = css(fixture);
  return { envelope, checks: [
    ['a real heading stood between two variables first', /--gap:\s*1rem;\s*\n\s*\/\* Doomed section \*\/\s*\n\s*--brand:/.test(before)],
    ['the words are gone', !after.includes('Doomed section')],
    ['and so is the comment that held them — no empty /* */ left standing', !/\/\*\s*\*\//.test(after)],
    ['the variables under it did not go with it', /--brand:\s*#3355ff\s*;/.test(after) && /--gap:\s*1rem\s*;/.test(after)],
    ['nor did the rule they are in', ruleBlock(after, ':root').length === 1 && after.includes(GRID_RULE) && after.includes(CARD_RULE)],
    ['and the stylesheet is exactly what it was before the heading was added', after === original],
  ] };
} });

// A NO-OP PASSED THIS. The heading was put there by the scenario's own setup
// one line earlier, so "it is still in the file" was true before the operation
// ran. Here the start is real — `at: 0` leaves the comment above `:root {`,
// outside every rule — and the destination is real: with no `before`,
// moveHeading must land it after the LAST declaration in the rule.
fullScenario({ domain: 'style', action: 'move_heading', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Movable heading', at: 0 } });
  const before = css(fixture);
  const start = before.indexOf('Movable heading');
  const { envelope } = await call('style', 'move_heading', { edit: { file: cell.file, selector: cell.selector, start, end: start + 'Movable heading'.length, expect: 'Movable heading' } });
  const after = css(fixture);
  const root = ruleBlock(after, ':root');
  return { envelope, checks: [
    ['it started above the rule, outside every one of them', before.startsWith('/* Movable heading */')],
    ['it is not there any more', !after.startsWith('/* Movable heading */')],
    ['it is inside the rule it was moved into', root.length === 1 && root[0].includes('/* Movable heading */')],
    ['after the last declaration in that rule, which is where a heading with no anchor goes', after.indexOf('Movable heading') > after.indexOf('--brand')],
    ['moved, not copied', (after.match(/Movable heading/g) || []).length === 1],
    ['the variables it now heads are all still declared', /--gap:\s*1rem\s*;/.test(root[0]) && /--brand:\s*#3355ff\s*;/.test(root[0])],
    ['and the comment is the only thing that moved', after === before.replace('/* Movable heading */\n', '').replace('  --brand: #3355ff;\n', '  --brand: #3355ff;\n  /* Movable heading */\n')],
  ] };
} });

// ── source ─────────────────────────────────────────────────────────────────

fullScenario({ domain: 'source', action: 'read', run: async ({ call }) => {
  const { envelope } = await call('source', 'read', { path: 'src/pages/index.astro' });
  return { envelope, checks: [
    ['it returns the page the fixture authored', String(envelope?.text || '').includes('<Hero')],
    ['with a digest a guarded write can use', !!envelope?.digest],
  ] };
} });

// Both old checks were constants. The mapper always emits a `path` key, and
// `outsideProject` is false whenever the path is null — so a resolver that
// resolved nothing passed, which is exactly what it was doing (it read a field
// the handler has never sent). The specifier here is EXTENSION-LESS on
// purpose: the answer cannot be the specifier with its directories tidied up,
// because the resolver has to try .ts and then .js to find the file at all.
fullScenario({ domain: 'source', action: 'resolve_path', run: async ({ call, fixture }) => {
  const { envelope } = await call('source', 'resolve_path', { fromFile: 'src/pages/index.astro', spec: '../lib/format' });
  return { envelope, checks: [
    ['it answers with the file that specifier points at', envelope?.path === 'src/lib/format.js'],
    ['which is a file the project really has', fixture.exists('src/lib/format.js')],
    ['found by guessing the extension, not by echoing the spec back', !fixture.exists('src/lib/format')],
    ['and resolved against the importing file rather than the project root', !fixture.exists('lib/format.js')],
    ['it does not claim the spec left the project', envelope?.outsideProject === false],
  ] };
} });

// Vacuous before this: the mapper emits `text` unconditionally, so the
// disjunct held for every ok:true answer including an empty string, and the
// other two names were not fields this operation has. `money` rather than a
// component's `default` because a symbol that is really declared somewhere is
// what makes `line` mean anything — for `default` the handler answers 0, which
// is its "I could not find it".
fullScenario({ domain: 'source', action: 'read_symbol', run: async ({ call, fixture }) => {
  const { envelope } = await call('source', 'read_symbol', { fromFile: 'src/pages/index.astro', spec: '../lib/format', name: 'money' });
  const file = fixture.read('src/lib/format.js');
  return { envelope, checks: [
    ['it answers about the file the specifier resolves to', envelope?.file === 'src/lib/format.js'],
    ['not about the file that did the importing', envelope?.file !== 'src/pages/index.astro'],
    ['with that file’s own bytes, whole', envelope?.text === file],
    ['which contain the symbol that was asked for', String(envelope?.text || '').includes('export function money(n) {')],
    ['and the line its declaration starts on is that declaration’s line', envelope?.line === 1 && file.split('\n')[envelope.line - 1] === 'export function money(n) {'],
    ['the symbol is named back, so the answer cannot be about a different one', envelope?.name === 'money'],
  ] };
} });

// 'starts with' is true of a write that stored the new first line and lost
// money() — and prepending to what was read is precisely the case where the
// rest arriving is the thing worth checking. Replacing a whole file means the
// file IS the bytes that were sent.
fullScenario({ domain: 'source', action: 'write', run: async ({ call, fixture }) => {
  const original = fixture.read('src/lib/format.js');
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const next = `// wire-wrote-this\n${String(read.envelope?.text || '')}`;
  const { envelope } = await call('source', 'write', { path: 'src/lib/format.js', text: next, expectedDigest: read.envelope?.digest });
  const after = fixture.read('src/lib/format.js');
  return { envelope, checks: [
    ['the text it was built from was the whole file', read.envelope?.text === original],
    ['the file on disk is exactly the bytes that were sent', after === next],
    ['so what was in it before is still in it, unchanged, below the new line', after === `// wire-wrote-this\n${original}` && after.includes('export function money(n) {')],
    ['and the answer describes the file it wrote', envelope?.path === 'src/lib/format.js' && envelope?.bytes === Buffer.byteLength(next, 'utf8')],
  ] };
} });

// THE RANGE IS THE POINT, and a replacement of line 1 cannot tell a range
// replacement apart from a whole-file write: only the suffix has to survive.
// Line 2 is the middle of the file, so a prefix and a suffix both do.
fullScenario({ domain: 'source', action: 'replace_range', run: async ({ call, fixture }) => {
  const lines = fixture.read('src/lib/format.js').split('\n');
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'replace_range', { path: 'src/lib/format.js', startLine: 2, endLine: 2, text: '  return `USD ${n.toFixed(2)}`;', expectedDigest: read.envelope?.digest });
  const after = fixture.read('src/lib/format.js').split('\n');
  return { envelope, checks: [
    ['the fixture really had that line to replace', lines[1] === '  return `$${n.toFixed(2)}`;'],
    ['it is now the replacement', after[1] === '  return `USD ${n.toFixed(2)}`;'],
    ['the line above it was left where it was', after[0] === lines[0] && after[0] === 'export function money(n) {'],
    ['and every line below it is byte-identical', after.slice(2).join('\n') === lines.slice(2).join('\n')],
    ['the file is the length it was — nothing was swallowed by the range', after.length === lines.length],
    ['and the answer says which range it replaced', envelope?.replacedLines === '2-2' && envelope?.lines === after.length],
  ] };
} });


// ── page ───────────────────────────────────────────────────────────────────

fullScenario({ domain: 'page', action: 'list', run: async ({ call }) => {
  const { envelope } = await call('page', 'list', {});
  const routes = (envelope?.pages || []).map((p) => p.route);
  return { envelope, checks: [
    ['the fixture home page is listed', routes.includes('/')],
    ['so is the about page', routes.includes('/about')],
    ['and the dynamic route the fixture declares', routes.some((r) => String(r).includes('[slug]'))],
    ['components are reported too', (envelope?.components || []).some((c) => c.name === 'Card')],
  ] };
} });

fullScenario({ domain: 'page', action: 'read', run: async ({ call }) => {
  const { envelope } = await call('page', 'read', { path: 'src/pages/index.astro' });
  return { envelope, checks: [
    ['it reports the page as editable astro', envelope?.format === 'astro' && envelope?.editable === true],
    ['and lists the imports the page really has', (envelope?.imports || []).some((i) => String(i.path).includes('Hero.astro'))],
  ] };
} });

// `layout: 'Base'` is half the operation, and a file existing said nothing
// about it. page:create resolves the layout, writes the import aimed from
// src/pages, and renders the page inside it; a create that wrote an EMPTY file
// passed the old check and produced a page with no layout at all.
fullScenario({ domain: 'page', action: 'create', run: async ({ call, fixture }) => {
  const { envelope } = await call('page', 'create', { name: 'wire-made', layout: 'Base' });
  const made = fixture.exists('src/pages/wire-made.astro') ? fixture.read('src/pages/wire-made.astro') : '';
  const spec = (made.match(/import\s+Base\s+from\s+'([^']+)'/) || [])[1] || '';
  return { envelope, checks: [
    ['the new page exists on disk', fixture.exists('src/pages/wire-made.astro')],
    ['and the answer addresses it project-relative', envelope?.path === 'src/pages/wire-made.astro'],
    ['it imports the layout it was asked for', spec === '../layouts/Base.astro'],
    ['aimed at a file that is really there from where this page sits', !!spec && fixture.exists(path.posix.join('src/pages', spec))],
    ['and the markup renders inside that layout', /<Base[\s/>]/.test(made)],
  ] };
} });

// "Move or rename a page, REWRITING ITS IMPORTS" is the registered contract,
// and a move that copied the bytes verbatim satisfied both old checks while
// leaving `../layouts/Base.astro` in a file now a directory deeper — a page
// that no longer builds. The rebase is what is asserted, by resolving the
// specifier the moved file ended up with from where the file now sits.
fullScenario({ domain: 'page', action: 'move', run: async ({ call, fixture }) => {
  await call('page', 'create', { name: 'wire-made', layout: 'Base' });
  const before = fixture.read('src/pages/wire-made.astro');
  const { envelope } = await call('page', 'move', { from: 'src/pages/wire-made.astro', to: 'moved/index.astro' });
  const after = fixture.exists('src/pages/moved/index.astro') ? fixture.read('src/pages/moved/index.astro') : '';
  const spec = (after.match(/import\s+Base\s+from\s+'([^']+)'/) || [])[1] || '';
  return { envelope, checks: [
    ['the old path is gone', !fixture.exists('src/pages/wire-made.astro')],
    ['and the new path exists', fixture.exists('src/pages/moved/index.astro')],
    ['the answer names where it landed', envelope?.path === 'src/pages/moved/index.astro'],
    ['the layout import was rebased for the directory it moved into', spec === '../../layouts/Base.astro'],
    ['so it is no longer the specifier that worked at the old depth', before.includes("'../layouts/Base.astro'") && spec !== '../layouts/Base.astro'],
    ['and it resolves to the layout from where the page now lives', !!spec && fixture.exists(path.posix.join('src/pages/moved', spec))],
  ] };
} });

fullScenario({ domain: 'page', action: 'delete', run: async ({ call, fixture }) => {
  await call('page', 'create', { name: 'wire-doomed', layout: 'Base' });
  const before = fixture.exists('src/pages/wire-doomed.astro');
  const { envelope } = await call('page', 'delete', { path: 'src/pages/wire-doomed.astro' });
  return { envelope, checks: [
    ['the page was there first', before],
    ['and is gone from disk', !fixture.exists('src/pages/wire-doomed.astro')],
    ['the pages beside it are untouched', fixture.exists(INDEX) && fixture.exists('src/pages/about.astro')],
    ['including the one in a folder of its own', fixture.exists('src/pages/notes/[slug].astro')],
    ['and src/pages itself is still there', fixture.exists('src/pages')],
  ] };
} });

fullScenario({ domain: 'page', action: 'folder_create', run: async ({ call, fixture }) => {
  const { envelope } = await call('page', 'folder_create', { dir: 'wire-docs' });
  return { envelope, checks: [['the folder exists under pages', fixture.exists('src/pages/wire-docs')]] };
} });

// WITH A PAGE IN IT. Renaming an empty folder leaves "and rebase what it
// holds" — the second half of the registered summary — untested, and a rename
// implemented as mkdir(new) + rm -rf(old) would destroy every page in the
// folder and pass both of the old checks unchanged.
fullScenario({ domain: 'page', action: 'folder_rename', run: async ({ call, fixture }) => {
  await call('page', 'create', { name: 'wire-docs/inner', layout: 'Base' });
  const before = fixture.read('src/pages/wire-docs/inner.astro');
  const { envelope } = await call('page', 'folder_rename', { from: 'wire-docs', to: 'wire-guide' });
  const after = fixture.exists('src/pages/wire-guide/inner.astro') ? fixture.read('src/pages/wire-guide/inner.astro') : '';
  const spec = (after.match(/import\s+Base\s+from\s+'([^']+)'/) || [])[1] || '';
  return { envelope, checks: [
    ['the old folder is gone', !fixture.exists('src/pages/wire-docs')],
    ['and the new one exists', fixture.exists('src/pages/wire-guide')],
    ['the page inside came with it rather than being deleted', fixture.exists('src/pages/wire-guide/inner.astro')],
    ['with nothing left behind at the old path', !fixture.exists('src/pages/wire-docs/inner.astro')],
    ['its contents carried across untouched', after === before && after.length > 0],
    ['and its layout import still resolves from where it now sits', !!spec && fixture.exists(path.posix.join('src/pages/wire-guide', spec))],
  ] };
} });

// A `high`-risk recursive delete, asserted on both sides: what must go, and
// what must NOT. With an empty folder, "and the pages in it" went untested —
// and so did the blast radius: a delete that resolved to src/pages and removed
// the whole tree satisfied the two old checks.
fullScenario({ domain: 'page', action: 'folder_delete', run: async ({ call, fixture }) => {
  await call('page', 'create', { name: 'wire-guide/doomed', layout: 'Base' });
  const before = fixture.exists('src/pages/wire-guide/doomed.astro');
  const { envelope } = await call('page', 'folder_delete', { dir: 'wire-guide' });
  return { envelope, checks: [
    ['the folder and the page in it were there first', before],
    ['the folder is gone', !fixture.exists('src/pages/wire-guide')],
    ['and so is the page it held', !fixture.exists('src/pages/wire-guide/doomed.astro')],
    ['the pages outside it are untouched', fixture.exists('src/pages/index.astro') && fixture.exists('src/pages/about.astro')],
    ['including the ones in another folder', fixture.exists('src/pages/notes/[slug].astro')],
    ['and src/pages itself is still there', fixture.exists('src/pages')],
  ] };
} });

fullScenario({ domain: 'page', action: 'component_create', run: async ({ call, fixture, ref }) => {
  // The whole operation, not a file write.
  //
  // "Make a component out of that" means four things in Stacki, and the menu
  // item does all four: the component file, the import, the props the markup
  // needs from page scope, and the markup itself replaced by the instance. The
  // Agent API used to expose only the middle of that — and could not even
  // reach it, because its declared input was a shape no client could obtain.
  //
  // It takes a ref now, resolved against the live model, and runs the same code
  // the person's command runs. The assertions below are about the extracted
  // SUBTREE surviving, not about formatting.
  const target = await ref('div');
  const before = fixture.read('src/pages/index.astro');
  const { envelope } = await call('page', 'component_create', { name: 'WireCard', ref: target, withProps: true });
  const after = fixture.read('src/pages/index.astro');
  const made = fixture.exists('src/components/WireCard.astro') ? fixture.read('src/components/WireCard.astro') : '';
  return { envelope, checks: [
    ['the component file was written', fixture.exists('src/components/WireCard.astro')],
    // The subtree, element by element — the loop, the component inside it and
    // the props it passes. A component that arrived empty would satisfy a
    // "not blank" check and none of these.
    ['the extracted div came with it', made.includes('class="pricing-grid"')],
    ['including the loop over plans', /plans\.map/.test(made)],
    ['and the Card inside the loop', /<Card/.test(made)],
    ['with the props that Card was given', made.includes('title={plan.title}') && made.includes('body={plan.body}')],
    ['the Card import travelled into the component', /import\s+Card\s+from/.test(made)],
    ['aimed correctly from src/components', /from\s+'\.\/Card\.astro'/.test(made)],
    ['and the component reads plans from its props', /Astro\.props/.test(made) && made.includes('plans')],
    ['the page now imports it', /import\s+WireCard\s+from/.test(after)],
    ['and renders it as an instance', /<WireCard/.test(after)],
    ['the markup it replaced is gone from the page', before.includes('class="pricing-grid"') && !after.includes('class="pricing-grid"')],
    ['the rest of the page is untouched', after.includes('<Hero') && after.includes('<footer')],
    ['the answer names the file it made', typeof envelope.path === 'string' && envelope.path.includes('WireCard')],
    // The extracted markup reads the page's `plans`, so the operation has to
    // notice and carry it across. This is the half that makes it the real
    // command rather than a file write.
    ['it derived the page value the markup needs', (envelope.props || []).includes('plans')],
    ['and the instance passes it back in', /<WireCard[^>]*plans=\{plans\}/.test(after)],
    // ok:true has to mean the whole operation happened, not half of it.
    ['success means the markup really was replaced', envelope.replaced === true],
  ] };
} });

// The COUNTED answer. 'index.astro' appearing somewhere in the JSON was
// satisfied by a scan that ignored the name and listed every .astro file under
// src, and by one reporting `count: 0` for the page that really renders a Card.
fullScenario({ domain: 'page', action: 'component_usage', run: async ({ call }) => {
  const { envelope } = await call('page', 'component_usage', { name: 'Card' });
  const files = envelope?.files || [];
  return { envelope, checks: [
    ['it counts the instances rather than listing candidates', envelope?.total === 1],
    ['found in exactly one file', files.length === 1],
    ['the page that really renders a Card', files[0]?.path === 'src/pages/index.astro'],
    ['counted once, because that page renders one', files[0]?.count === 1],
    ['and said to be a page, which is how a caller knows where to go', files[0]?.kind === 'page'],
    ['the component\'s own file is not one of its users', !files.some((f) => String(f.path).includes('components/Card.astro'))],
    ['nor is the page that never mentions it', !files.some((f) => String(f.path).includes('about.astro'))],
  ] };
} });

// THE ROUTES, from a real Astro. "Enumerated them or said why not" was
// satisfied by the literal answer `{ paths: [], problem: null }` — no paths and
// no reason — because the mapper always emits the `problem` key, and the
// scenario declared no `needs`, so there was no dev server and the handler
// short-circuited before it could enumerate anything. It ran getStaticPaths
// nowhere and passed. With a server the two routes the fixture declares are
// facts, so they are the assertion.
fullScenario({ domain: 'page', action: 'dynamic_paths', needs: 'server', run: async ({ call, fixture }) => {
  await call('project', 'dev_start', {});
  try {
    const { envelope } = await call('page', 'dynamic_paths', { path: 'src/pages/notes/[slug].astro' });
    const paths = envelope?.paths || [];
    const routes = paths.map((p) => p.route).sort();
    fixture.observedWorld('asked the running dev server to run the page\'s own getStaticPaths');
    return { envelope, checks: [
      ['it enumerates the routes the page really stands for', JSON.stringify(routes) === JSON.stringify(['/notes/first', '/notes/second'])],
      ['each filled in from the params getStaticPaths returned', paths.some((p) => p.params?.slug === 'first' && p.route === '/notes/first')],
      ['and the other one too, so it is not one lucky match', paths.some((p) => p.params?.slug === 'second' && p.route === '/notes/second')],
      ['with a label a picker can show', paths.every((p) => typeof p.label === 'string' && p.label.length > 0)],
      ['and no problem reported, because there was none', envelope?.problem === null],
    ] };
  } finally {
    await call('project', 'dev_stop', {});
  }
} });

// Given something to find. `routes.length === 0` was the honest answer for a
// project with no integrations and proved nothing about the operation: an
// implementation that never read node_modules/.avb/routes.json, or read it and
// dropped every entry, passed — and the filtering and mapping in
// electron/injectedRoutes.js is the whole of what this does.
//
// No dependencies needed: Astro writes that file as it resolves its routes
// (see the preview integration in electron/main.js) and the reader only parses
// it, so the file IS the input. Three entries, one of which must survive.
fullScenario({ domain: 'page', action: 'injected_routes', run: async ({ call, fixture }) => {
  fixture.write(
    'node_modules/.avb/routes.json',
    JSON.stringify([
      { pattern: '/blog/[slug]', origin: 'external', entrypoint: 'node_modules/@acme/blog/pages/post.astro', params: ['slug'] },
      { pattern: '/about', origin: 'project', entrypoint: 'src/pages/about.astro', params: [] },
      { pattern: '/__avb/paths', origin: 'external', entrypoint: 'node_modules/.avb/paths.js', params: [] },
    ])
  );
  const { envelope } = await call('page', 'injected_routes', {});
  const routes = envelope?.routes || [];
  return { envelope, checks: [
    ['it reports the route an integration injected, and only that one', routes.length === 1],
    ['naming the pattern the integration registered', routes[0]?.route === '/blog/[slug]'],
    ['the file inside the dependency that serves it', routes[0]?.entrypoint === 'node_modules/@acme/blog/pages/post.astro'],
    ['the package it came from', routes[0]?.from === '@acme/blog'],
    ['and the params that route takes', JSON.stringify(routes[0]?.params) === JSON.stringify(['slug'])],
    ['the project\'s own pages are left out — the editor already has those', !routes.some((r) => r.route === '/about')],
    ['and so is Stacki\'s own preview route', !routes.some((r) => String(r.route).startsWith('/__avb'))],
  ] };
} });

fullScenario({ domain: 'page', action: 'import_path', run: async ({ call }) => {
  const { envelope } = await call('page', 'import_path', { fromFile: 'src/pages/index.astro', targetFile: 'src/components/Card.astro' });
  return { envelope, checks: [['it computes the specifier the page would use', envelope?.relative === '../components/Card.astro']] };
} });

// Rebased to a page one directory deeper, so the answer has to CHANGE. The
// old destination was src/pages/about.astro — the same depth as the page it
// came from, where the correct answer is the specifier it was already given —
// and the check only asked whether some key was present, under a name the
// operation does not use. It answers `path`.
fullScenario({ domain: 'page', action: 'rebase_import', run: async ({ call }) => {
  const spec = '../components/Card.astro';
  // One call, because that is what a FULL scenario gets. The control is
  // page.import_path — a different operation — asked what the deeper page
  // would import the same component as if it were starting from scratch.
  const fresh = await call('page', 'import_path', { fromFile: 'src/pages/notes/[slug].astro', targetFile: 'src/components/Card.astro' });
  const { envelope } = await call('page', 'rebase_import', { fromPage: 'src/pages/index.astro', toPage: 'src/pages/notes/[slug].astro', spec });
  return { envelope, checks: [
    ['it answers with the specifier the deeper page needs', envelope?.path === '../../components/Card.astro'],
    ['which is not the one it was given', envelope?.path !== spec],
    ['and still resolves to the same component', path.normalize(path.join('src/pages/notes', envelope?.path || '')) === path.normalize('src/components/Card.astro')],
    ['agreeing with what that page would import it as from scratch', envelope?.path === fresh.envelope?.relative],
  ] };
} });

// ── asset ──────────────────────────────────────────────────────────────────

// `under` is the operation, not a hint. Two substrings found anywhere in the
// answer were satisfied by a listing of the WHOLE project — the src root is in
// the unfiltered answer and would have to be absent here — and by an answer
// carrying basenames instead of paths, which no other asset action can be
// given. So the assertions are: what folder every entry is in, and that each
// one names itself the way `read_text`, `move` and `delete` need to be told.
fullScenario({ domain: 'asset', action: 'list', run: async ({ call }) => {
  const { envelope } = await call('asset', 'list', { under: 'public' });
  const entries = envelope?.entries || [];
  const at = (p) => entries.find((e) => e.path === p);
  return { envelope, checks: [
    ['it answered with entries at all', entries.length > 0],
    ['every one of which is inside the folder that was asked for', entries.every((e) => e.path === 'public' || String(e.path || '').startsWith('public/'))],
    ['so nothing from src/ came along', !entries.some((e) => e.path === 'src' || String(e.path || '').startsWith('src/'))],
    ['the image is listed at its full path, as a file', at('public/images/dot.png')?.isDir === false],
    ['the folder holding it is listed as a folder', at('public/images')?.isDir === true],
    ['and the robots file the fixture ships', at('public/robots.txt')?.isDir === false],
    ['each entry keeping its own name beside its path', at('public/images/dot.png')?.name === 'dot.png'],
    ['and saying which root it came from', entries.every((e) => e.root === 'public')],
    ['the counts describe the list actually returned', envelope?.returned === entries.length && envelope?.total === entries.length],
    ['nothing was cut off', envelope?.truncated === false],
    ['and public/ is there, so it is not reported missing', envelope?.missingPublic === false],
  ] };
} });

fullScenario({ domain: 'asset', action: 'read_text', run: async ({ call }) => {
  const { envelope } = await call('asset', 'read_text', { path: 'public/robots.txt' });
  return { envelope, checks: [['it returns the canary the fixture put in robots.txt', String(envelope?.text || '').includes(ROBOTS_CANARY)]] };
} });

fullScenario({ domain: 'asset', action: 'dimensions', run: async ({ call }) => {
  const { envelope } = await call('asset', 'dimensions', { path: 'public/images/dot.png' });
  const d = envelope?.dims || {};
  return { envelope, checks: [['it reads the real pixel size of the fixture PNG', d.w === DOT_WIDTH && d.h === DOT_HEIGHT]] };
} });

// `afterDigest` IS THE ANSWER, as much as the bytes are.
//
// The mapper used to hash `input.text` — the text the caller ASKED for — so a
// write that did not land still reported the digest of what the file was
// supposed to contain, and a client holding that for optimistic concurrency
// held a digest no file has. It reads the file now, and this says so in the
// only way that does not just re-run the implementation: the digest is
// computed here, from the bytes on disk, and cross-checked against what a
// different operation reports for the same file.
const digestHere = (text) =>
  require('node:crypto').createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64url').slice(0, 22);

fullScenario({ domain: 'asset', action: 'write_text', run: async ({ call, fixture }) => {
  const NEW = 'User-agent: *\nDisallow: /wire\n';
  const read = await call('asset', 'read_text', { path: 'public/robots.txt' });
  const before = read.envelope?.digest;
  const { envelope } = await call('asset', 'write_text', { path: 'public/robots.txt', text: NEW, ref: read.envelope?.ref });
  const after = await call('asset', 'read_text', { path: 'public/robots.txt' });
  const onDisk = fixture.read('public/robots.txt');
  return { envelope, checks: [
    ['the file on disk is exactly the text that was sent', onDisk === NEW],
    ['so the canary the fixture shipped is gone', !onDisk.includes(ROBOTS_CANARY)],
    ['it names the file it wrote', envelope?.path === 'public/robots.txt'],
    ['and answers with the digest of what is on disk now', envelope?.afterDigest === digestHere(onDisk)],
    ['which is what reading the file back reports as its digest', envelope?.afterDigest === after.envelope?.digest],
    ['and not the digest of what was there before', typeof before === 'string' && envelope?.afterDigest !== before],
  ] };
} });

fullScenario({ domain: 'asset', action: 'mkdir', run: async ({ call, fixture }) => {
  const { envelope } = await call('asset', 'mkdir', { parent: 'public', name: 'wire-folder' });
  return { envelope, checks: [['the folder exists', fixture.exists('public/wire-folder')]] };
} });

fullScenario({ domain: 'asset', action: 'move', run: async ({ call, fixture }) => {
  const { envelope } = await call('asset', 'move', { path: 'public/spare.txt', toFolder: 'public/wire-folder' });
  return { envelope, checks: [
    ['the old path is gone', !fixture.exists('public/spare.txt')],
    ['and the file is in the new folder', fixture.exists('public/wire-folder/spare.txt')],
  ] };
} });

fullScenario({ domain: 'asset', action: 'rename', run: async ({ call, fixture }) => {
  await call('asset', 'mkdir', { parent: 'public', name: 'wire-folder' });
  await call('asset', 'move', { path: 'public/spare.txt', toFolder: 'public/wire-folder' });
  const { envelope } = await call('asset', 'rename', { path: 'public/wire-folder/spare.txt', name: 'renamed.txt' });
  return { envelope, checks: [
    ['the old name is gone', !fixture.exists('public/wire-folder/spare.txt')],
    ['and the new name exists', fixture.exists('public/wire-folder/renamed.txt')],
  ] };
} });

fullScenario({ domain: 'asset', action: 'delete', run: async ({ call, fixture }) => {
  // WHAT MUST SURVIVE, named. "It was there, now it is not" is equally true of
  // a delete that took the folder with it — and this fixture's public/ holds
  // the robots canary and an image other scenarios assert against.
  const before = fixture.exists('public/spare.txt');
  const { envelope } = await call('asset', 'delete', { path: 'public/spare.txt' });
  return { envelope, checks: [
    ['the file was there first', before],
    ['and is gone from disk', !fixture.exists('public/spare.txt')],
    ['its neighbour in the same folder is untouched', fixture.exists('public/robots.txt') && fixture.read('public/robots.txt').includes(ROBOTS_CANARY)],
    ['the image beside it is still there', fixture.exists('public/images/dot.png')],
    ['and public/ itself was not what was removed', fixture.exists('public')],
  ] };
} });


// ── content ────────────────────────────────────────────────────────────────
//
// The fixture has no node_modules, and reading the Astro CONTENT CONFIG needs
// them. That is a real property of the project, not a hole in the test: the
// collection-shaped operations answer with a named refusal, and the checks
// below assert the exact truthful answer rather than shrugging at any envelope.

// WHAT `needs: 'deps'` IS FOR.
//
// Reading a content config means bundling it, and electron/contentConfig.js
// bundles it with the PROJECT's own esbuild. A fixture with no node_modules
// therefore cannot answer a single collection question — it can only say the
// dependencies are missing — and these scenarios used to accept exactly that
// as their proof. `configNeedsDeps` was the check: the content domain was
// graded on its refusal message, which is how five of these could be red for
// the right reason and the rest green for the wrong one.
//
// The scenarios below ask for a fixture with the dependencies really installed
// and asssert against real collections, real entries and real files.

// The path is the answer, not a hint. `cms:list` names a file relative to
// src/ and the mapper's one job is to hand back the project-relative path the
// rest of this API takes — so a substring search for 'site.json' passed
// whichever convention came out, while a client feeding 'data/site.json' back
// into cms_read got `bad_path`. Asserted by round trip: the path this listing
// gives is handed straight to another operation.
fullScenario({ domain: 'content', action: 'cms_list', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_list', {});
  const site = (envelope?.files || []).find((f) => f.name === 'site.json') || {};
  const back = await call('content', 'cms_read', { path: site.path || '' });
  return { envelope, checks: [
    ['it finds the JSON data file the fixture ships', site.name === 'site.json'],
    ['named the way every other operation here names a file', site.path === 'src/data/site.json'],
    ['having really parsed it, so the listing can say what fields it holds', Array.isArray(site.keys) && site.keys.includes('title') && site.keys.includes('tagline')],
    ['and the path it answered with is one content.cms_read accepts', back.envelope?.ok === true && back.envelope?.data?.tagline === 'A place to test things'],
    ['it also finds the collection declared in a page\'s own frontmatter', (envelope?.files || []).some((f) => f.path === 'src/pages/index.astro#plans' && f.entries === 3)],
  ] };
} });

// The VALUES, because `typeof data === 'object'` was satisfied by `[]`, by any
// other JSON file in the project, and by a stale cached object.
fullScenario({ domain: 'content', action: 'cms_read', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_read', { path: 'src/data/site.json' });
  const data = envelope?.data;
  return { envelope, checks: [
    ['it answers about the file it was asked for', envelope?.path === 'src/data/site.json'],
    ['parsed into the exact values the fixture wrote', data?.title === 'Fixture' && data?.tagline === 'A place to test things'],
    ['and holds nothing else — those are the two keys in that file', JSON.stringify(Object.keys(data || {})) === JSON.stringify(['title', 'tagline'])],
    ['with a ref for writing it back through', typeof envelope?.ref === 'string' && envelope.ref.startsWith('stacki:')],
  ] };
} });

fullScenario({ domain: 'content', action: 'cms_write', run: async ({ call, fixture }) => {
  const read = await call('content', 'cms_read', { path: 'src/data/site.json' });
  const was = read.envelope?.data || {};
  const { envelope } = await call('content', 'cms_write', { path: 'src/data/site.json', data: { ...was, wireWrote: true }, ref: read.envelope?.ref });
  const onDisk = JSON.parse(fixture.read('src/data/site.json'));
  return { envelope, checks: [
    ['the new key is in the file on disk', onDisk.wireWrote === true],
    // A write that persisted only the changed field left the page reading a
    // `site.tagline` that no longer existed, and the single check above held.
    ['the keys it was not asked about are still there', Object.keys(was).every((k) => k in onDisk)],
    ['with the values they had', Object.keys(was).every((k) => JSON.stringify(onDisk[k]) === JSON.stringify(was[k]))],
    ['including the one the page reads', typeof onDisk.tagline === 'string' && onDisk.tagline.length > 0],
  ] };
} });

// A file existing is not the operation. `cms:create` seeds an empty collection
// and answers with the rel the caller has to be able to address it by — a
// create that wrote nothing, or answered a path no other action accepts, left
// the file on disk and passed.
fullScenario({ domain: 'content', action: 'cms_create', run: async ({ call, fixture }) => {
  const { envelope } = await call('content', 'cms_create', { name: 'wireteam' });
  const made = fixture.exists('src/data/wireteam.json') ? fixture.read('src/data/wireteam.json') : null;
  const back = await call('content', 'cms_read', { path: envelope?.path || '' });
  return { envelope, checks: [
    ['a new data file exists', fixture.exists('src/data/wireteam.json')],
    ['seeded as an empty collection, ready to take rows', made === '[]\n'],
    ['the answer addresses it the way every other operation would', envelope?.path === 'src/data/wireteam.json'],
    ['and that path really opens, as an empty collection', back.envelope?.ok === true && Array.isArray(back.envelope?.data) && back.envelope.data.length === 0],
    ['nothing else in src/data was touched', JSON.parse(fixture.read('src/data/site.json')).title === 'Fixture'],
  ] };
} });

// WHICH pages, not whether the key exists. The handler is
// `{ files: importersOf(...).map(h => h.rel) }`, so `'files' in envelope` was a
// constant: an import scanner that found nothing at all passed. And the rels it
// answers with are src-relative, which no other operation in this API accepts —
// so the answer is checked by opening one of the files it named.
fullScenario({ domain: 'content', action: 'cms_usage', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_usage', { path: 'src/data/site.json' });
  const files = envelope?.files || [];
  const back = await call('page', 'read', { path: files[0] || '' });
  return { envelope, checks: [
    ['it names the page that imports the data file', files.includes('src/pages/index.astro')],
    ['and only that page — about.astro imports no data', files.length === 1],
    ['the path it answers with is one another operation can open', back.envelope?.ok === true],
    ['and that page really does import this file', (back.envelope?.imports || []).some((i) => String(i.path).includes('../data/site.json'))],
  ] };
} });

// Seeded first, because `readCmsMeta` swallows every error and answers `{}` —
// so `typeof meta === 'object'` held for a handler that had lost the file, the
// project root or the ability to parse JSON, and the CMS panel would silently
// lose every field type a person had chosen. `.stacki/cms.json` is keyed the
// way the panel keys it, relative to src/; the answer has to be addressable by
// the rest of this API, which is project-relative.
fullScenario({ domain: 'content', action: 'cms_meta', run: async ({ call, fixture }) => {
  fixture.write(
    '.stacki/cms.json',
    JSON.stringify({ 'data/site.json': { label: 'Wire', fields: { tagline: 'text' } } }, null, 2) + '\n'
  );
  const { envelope } = await call('content', 'cms_meta', {});
  const mine = envelope?.meta?.['src/data/site.json'];
  return { envelope, checks: [
    ['it reads the presentation stored for the CMS panel', mine?.label === 'Wire'],
    ['carrying the field types with it', mine?.fields?.tagline === 'text'],
    ['keyed the way the rest of this API addresses a data file', JSON.stringify(Object.keys(envelope?.meta || {})) === JSON.stringify(['src/data/site.json'])],
  ] };
} });

// WHERE it was stored, not just that the word came back. `cms:setMeta` writes
// .stacki/cms.json in the project root — a file this fixture can open, which
// the old comment here denied — and keys it by the src-relative rel the CMS
// panel looks a field up by. Stored under any other key the round trip still
// contains 'Wire' and the panel never finds it again.
fullScenario({ domain: 'content', action: 'cms_set_meta', run: async ({ call, fixture }) => {
  const { envelope } = await call('content', 'cms_set_meta', { path: 'src/data/site.json', fields: { label: 'Wire' } });
  const onDisk = fixture.exists('.stacki/cms.json') ? JSON.parse(fixture.read('.stacki/cms.json')) : {};
  const back = await call('content', 'cms_meta', {});
  return { envelope, checks: [
    ['it wrote the field under the key the CMS panel looks it up by', onDisk['data/site.json']?.label === 'Wire'],
    ['and under no other key', JSON.stringify(Object.keys(onDisk)) === JSON.stringify(['data/site.json'])],
    ['reading it back names the same file this call named', back.envelope?.meta?.['src/data/site.json']?.label === 'Wire'],
  ] };
} });

fullScenario({ domain: 'content', action: 'cms_delete', run: async ({ call, fixture }) => {
  await call('content', 'cms_create', { name: 'wireteam' });
  const before = fixture.exists('src/data/wireteam.json');
  const siteBefore = fixture.read('src/data/site.json');
  const { envelope } = await call('content', 'cms_delete', { path: 'src/data/wireteam.json' });
  return { envelope, checks: [
    ['the data file was there first', before],
    ['and is gone', !fixture.exists('src/data/wireteam.json')],
    // site.json is what <Hero heading={site.tagline}/> reads. A delete that
    // cleared the folder would satisfy the two checks above and break the page.
    ['the data file the page reads is untouched', fixture.read('src/data/site.json') === siteBefore],
    ['and src/data itself is still there', fixture.exists('src/data')],
  ] };
} });

fullScenario({ domain: 'content', action: 'config', needs: 'deps', run: async ({ call }) => {
  const { envelope } = await call('content', 'config', {});
  const notes = (envelope?.collections || []).find((c) => c.name === 'notes');
  return { envelope, checks: [
    ['it names the content config the fixture authored', String(envelope?.configPath || '').includes('content.config')],
    ['and reads the collection out of it', !!notes],
    ['with the loader the config declares', notes?.loader?.kind === 'glob' && String(notes?.loader?.base).includes('notes')],
    ['and the zod schema resolved to a real JSON Schema', !!notes?.schema?.properties?.title],
  ] };
} });

fullScenario({ domain: 'content', action: 'collections', needs: 'deps', run: async ({ call }) => {
  const { envelope } = await call('content', 'collections', {});
  const byName = Object.fromEntries((envelope?.collections || []).map((c) => [c.name, c]));
  return { envelope, checks: [
    ['it finds both collections the config declares', !!byName.notes && !!byName.links],
    ['counting the entries each really has', byName.notes?.count === 2 && byName.links?.count === 2],
    ['and reports no error reading them', (envelope?.collections || []).every((c) => !c.error)],
  ] };
} });

fullScenario({ domain: 'content', action: 'entries', needs: 'deps', run: async ({ call }) => {
  const { envelope } = await call('content', 'entries', { collection: 'notes' });
  const ids = (envelope?.entries || []).map((e) => e.id).sort();
  const first = (envelope?.entries || []).find((e) => e.id === 'first');
  return { envelope, checks: [
    ['it lists the entries the fixture wrote', JSON.stringify(ids) === JSON.stringify(['first', 'second'])],
    ['each pointing at the file it came from', first?.file === 'src/content/notes/first.md'],
    ['with the frontmatter parsed into data', first?.data?.title === 'The first note' && first?.data?.draft === false],
    ['and the markdown body carried alongside it', String(first?.body || '').includes('Something worth writing down')],
  ] };
} });

// Answered by the dev server, because only it can run the project's loaders —
// so this raises one, exactly as an agent working on a live site would have.
// The entry's OWN VALUES, keyed by whichever of the two the loader sampled —
// which is the only thing a really-running loader can prove. A dev route
// answering a shape-only skeleton (`{id:'first', data:{title:''}}`) satisfied
// "title is a string", and so did an entry whose schema was never applied.
fullScenario({ domain: 'content', action: 'sample_entry', needs: 'server', run: async ({ call, fixture }) => {
  const TITLE = { first: 'The first note', second: 'The second note' };
  const DRAFT = { first: false, second: true };
  const BODY = { first: 'Something worth writing down.', second: 'And another.' };
  await call('project', 'dev_start', {});
  try {
    const { envelope } = await call('content', 'sample_entry', { collection: 'notes' });
    const entry = envelope?.entry || {};
    const id = entry.id;
    fixture.observedWorld('asked the running dev server to run the collection loader');
    return { envelope, checks: [
      ['it answers with an entry of the collection that was asked for', entry.collection === 'notes'],
      ['identified the way that collection identifies it', id === 'first' || id === 'second'],
      ['carrying that entry\'s own title, not a placeholder', typeof TITLE[id] === 'string' && entry.data?.title === TITLE[id]],
      ['and the frontmatter field beside it, as the schema types it', typeof DRAFT[id] === 'boolean' && entry.data?.draft === DRAFT[id]],
      ['with the words that are in the file', typeof BODY[id] === 'string' && String(entry.body || '').includes(BODY[id])],
      ['and naming the file it came from', entry.filePath === `src/content/notes/${id}.md`],
    ] };
  } finally {
    await call('project', 'dev_stop', {});
  }
} });

// The titles themselves. `titleOf` falls back to the entry id when it cannot
// find a title key, so a regression that stopped reading `data.title` answered
// 'first' / 'second' — non-empty strings, check passed — and a reference picker
// showed raw ids instead of the names a person recognises, which is the whole
// of what this operation is for.
fullScenario({ domain: 'content', action: 'targets', needs: 'deps', run: async ({ call }) => {
  const { envelope } = await call('content', 'targets', { collection: 'notes' });
  const targets = envelope?.targets || [];
  const ids = targets.map((t) => t.id).sort();
  return { envelope, checks: [
    ['it lists what a reference to this collection could point at', JSON.stringify(ids) === JSON.stringify(['first', 'second'])],
    ['labelled with the title the entry itself carries', targets.find((t) => t.id === 'first')?.title === 'The first note'],
    ['and so is the other one, so it is not one lucky match', targets.find((t) => t.id === 'second')?.title === 'The second note'],
    ['none of them falling back to showing the id', targets.every((t) => t.title !== t.id)],
  ] };
} });

// Asked about an entry that BREAKS the schema, because that is the answer that
// can only come from really running it: `title` is required and missing, and
// `draft` is a boolean given a string. An entry that validates cleanly looks
// the same whether the schema was applied or never read at all.
fullScenario({ domain: 'content', action: 'validate', needs: 'deps', run: async ({ call }) => {
  const { envelope } = await call('content', 'validate', { collection: 'notes', data: { draft: 'not a boolean' } });
  const said = JSON.stringify(envelope?.issues || []);
  return { envelope, checks: [
    ['it reaches a verdict rather than refusing to look', Array.isArray(envelope?.issues)],
    ['and finds what is wrong with an entry that breaks the schema', (envelope?.issues || []).length > 0],
    ['naming the required field that is missing', said.includes('title')],
    ['and the one whose type is wrong', said.includes('draft')],
  ] };
} });

fullScenario({ domain: 'content', action: 'write_entry', needs: 'deps', run: async ({ call, fixture }) => {
  const list = await call('content', 'entries', { collection: 'notes' });
  const first = (list.envelope?.entries || []).find((e) => e.id === 'first');
  const before = fixture.read('src/content/notes/second.md');
  // `edits` is a LIST of { path, value }. It was declared as an object of
  // fields, and this scenario passed neither — it sent a body alone, which the
  // mapper turned into `edits: {}`, which reached `.map` and threw. Every call
  // this operation could receive failed until the schema matched the code.
  const { envelope } = await call('content', 'write_entry', {
    entry: first,
    edits: [{ path: ['title'], value: 'Retitled by the wire test' }],
    body: 'Rewritten by the wire test.\n',
  });
  const after = fixture.read('src/content/notes/first.md');
  const reread = await call('content', 'entries', { collection: 'notes' });
  const now = (reread.envelope?.entries || []).find((e) => e.id === 'first');
  return { envelope, checks: [
    ['it reports having changed the file', envelope?.changed === true],
    ['the frontmatter field really is rewritten on disk', /title:\s*Retitled by the wire test/.test(after)],
    ['and the body with it', after.includes('Rewritten by the wire test.')],
    ['the field it was not asked about is untouched', /draft:\s*false/.test(after)],
    ['reading the collection back reports the new value', now?.data?.title === 'Retitled by the wire test'],
    ['and the other entry is exactly as it was', fixture.read('src/content/notes/second.md') === before],
  ] };
} });

fullScenario({ domain: 'content', action: 'rename_plan', needs: 'deps', run: async ({ call, fixture }) => {
  const before = fixture.read('src/content/notes/first.md');
  const { envelope } = await call('content', 'rename_plan', { collection: 'notes', from: 'first', to: 'introduction' });
  const pointers = envelope?.pointers || [];
  return { envelope, checks: [
    ['it plans the move the rename would make', envelope?.move?.from === 'src/content/notes/first.md' && envelope?.move?.to === 'src/content/notes/introduction.md'],
    ['and finds the entry elsewhere that points at this one', pointers.some((p) => p.collection === 'links' && p.entryId === 'pointer')],
    ['naming the field that holds the reference', pointers.some((p) => JSON.stringify(p.path || []).includes('note'))],
    ['while leaving the entry that points somewhere else out of it', !pointers.some((p) => p.entryId === 'other')],
    ['and it is a plan, so nothing has moved yet', fixture.exists('src/content/notes/first.md') && !fixture.exists('src/content/notes/introduction.md')],
    ['nor has anything been rewritten', fixture.read('src/content/notes/first.md') === before],
  ] };
} });

fullScenario({ domain: 'content', action: 'rename', needs: 'deps', run: async ({ call, fixture }) => {
  const body = fixture.read('src/content/notes/first.md');
  const otherBefore = fixture.read('src/content/links/other.md');
  const { envelope } = await call('content', 'rename', { collection: 'notes', from: 'first', to: 'introduction' });
  const reread = await call('content', 'entries', { collection: 'notes' });
  const ids = (reread.envelope?.entries || []).map((e) => e.id).sort();
  return { envelope, checks: [
    ['it reports the rename as done', envelope?.renamed === true],
    ['the old identity is gone from disk', !fixture.exists('src/content/notes/first.md')],
    ['the new one is there', fixture.exists('src/content/notes/introduction.md')],
    ['carrying the entry\'s content with it', fixture.read('src/content/notes/introduction.md') === body],
    ['the collection now answers under the new id', JSON.stringify(ids) === JSON.stringify(['introduction', 'second'])],
    ['the entry that pointed at it was updated to follow', /note:\s*introduction/.test(fixture.read('src/content/links/pointer.md'))],
    ['and the one that pointed elsewhere was left alone', fixture.read('src/content/links/other.md') === otherBefore],
  ] };
} });

// `'path' in envelope` was a textbook tautology: the mapper always emits the
// key, `null` included, so a resolver that resolved nothing passed. What the
// operation exists to answer is WHERE '../data/site.json' from
// src/pages/index.astro points, so that is what is asserted — and the file it
// names is opened, to be sure the answer is a real place and not a string.
fullScenario({ domain: 'content', action: 'resolve_import', run: async ({ call, fixture }) => {
  const { envelope } = await call('content', 'resolve_import', { fromFile: 'src/pages/index.astro', spec: '../data/site.json' });
  const at = typeof envelope?.path === 'string' ? envelope.path : '';
  const there = !!at && fixture.exists(at);
  let holds = false;
  try {
    holds = there && JSON.parse(fixture.read(at))?.tagline === 'A place to test things';
  } catch {
    holds = false;
  }
  return { envelope, checks: [
    ['it resolves the import to the file it points at', at === 'src/data/site.json'],
    ['named project-relative, not as the specifier it was given', at !== '../data/site.json' && !at.startsWith('/')],
    ['and that file is really there', there],
    ['holding the data the importing page reads', holds],
  ] };
} });


// ── project ────────────────────────────────────────────────────────────────

// The permission level is the load-bearing field here — an agent decides what
// to attempt from it — and "truthy" accepted a constant. info() sources it from
// the gate, this rig runs at 'full', and a regression pinning it to 'full' or
// to anything else is now the difference between passing and failing.
fullScenario({ domain: 'project', action: 'info', run: async ({ call, fixture }) => {
  const { envelope } = await call('project', 'info', {});
  return { envelope, checks: [
    ['the project reads as open', envelope?.project?.open === true],
    ['under the name of the folder that is really open', envelope?.project?.name === path.basename(fixture.root)],
    ['reporting the level this rig was granted, read from the gate', envelope?.access?.mode === 'full'],
    ['in the same words the person granting it saw', envelope?.access?.label === 'Full control'],
    ['and the page the app is showing, by path and by route', envelope?.page?.file === 'src/pages/index.astro' && envelope?.page?.route === '/'],
  ] };
} });

// What the scan is FOR: the counts, which pages are patterns rather than URLs,
// and what each component takes. 'Hero' appearing in the JSON was satisfied by
// `{name:'Hero', props: []}` — prop extraction broken end to end — and by the
// dynamic route being enumerated as an ordinary page. Both of those were true
// when this was written; see electron/mcp/agent/domains.js summarizeScan.
fullScenario({ domain: 'project', action: 'scan', run: async ({ call }) => {
  const { envelope } = await call('project', 'scan', {});
  const pages = envelope?.pages || [];
  const components = envelope?.components || [];
  const hero = components.find((c) => c.name === 'Hero');
  const card = components.find((c) => c.name === 'Card');
  return { envelope, checks: [
    ['it counts everything the fixture holds', envelope?.counts?.pages === 3 && envelope?.counts?.components === 2 && envelope?.counts?.layouts === 1],
    ['the home page among them, by route and by path', pages.some((p) => p.route === '/' && p.path === 'src/pages/index.astro')],
    ['the dynamic route reported as one', pages.find((p) => p.path === 'src/pages/notes/[slug].astro')?.dynamic === true],
    ['and it is the only one, so the flag means something', pages.filter((p) => p.dynamic).length === 1],
    ['each component carrying the props it really declares', JSON.stringify(hero?.props) === JSON.stringify(['heading'])],
    ['including the one that takes two', JSON.stringify((card?.props || []).slice().sort()) === JSON.stringify(['body', 'title'])],
    ['and the layout the pages wrap themselves in', (envelope?.layouts || []).some((l) => l.name === 'Base' && l.path === 'src/layouts/Base.astro')],
  ] };
} });

fullScenario({ domain: 'project', action: 'classes', run: async ({ call }) => {
  const { envelope } = await call('project', 'classes', {});
  return { envelope, checks: [
    ['it finds the classes the fixture stylesheet declares', (envelope?.classes || []).includes('hero')],
    ['and counts them', Number.isInteger(envelope?.total) && envelope.total > 0],
  ] };
} });

// The ANSWER, not its type. `installed: !!(raw?.has ?? raw)` is a boolean
// whatever the handler says, so `project:hasNodeModules` could have been
// replaced by `() => true` and this passed — and an agent would be told to run
// an install it does not need, or not to run one it does. This rig has no
// node_modules, so `false` is the only truthful answer and disk is asked too.
// The `true` side is proved by project.install, which asserts it after really
// running the package manager.
fullScenario({ domain: 'project', action: 'dependencies', run: async ({ call, fixture }) => {
  const { envelope } = await call('project', 'dependencies', {});
  return { envelope, checks: [
    ['it says the dependencies are not installed', envelope?.installed === false],
    ['agreeing with the project on disk, which has no node_modules', !fixture.exists('node_modules')],
  ] };
} });

// The VERDICT. `kind` is `raw?.kind ?? 'unknown'`, always a string — so
// dev:diagnose could lose its ability to see node_modules or astro entirely,
// answer 'unknown' forever, and "why the dev server will not start" became a
// shrug that passed. This rig has node and no dependencies, which is exactly
// the 'no-deps' branch, and its two supporting facts are checked against disk.
fullScenario({ domain: 'project', action: 'diagnose', run: async ({ call, fixture }) => {
  const { envelope } = await call('project', 'diagnose', {});
  return { envelope, checks: [
    ['it names the state this project is really in', envelope?.kind === 'no-deps'],
    ['because there is no astro here to find', envelope?.astroVersion === null && !fixture.exists('node_modules/astro')],
    ['and reports the node it did find', envelope?.nodeFound === true && /^v\d+\./.test(String(envelope?.nodeVersion))],
    ['with no version requirement to quote, having no package to read one from', envelope?.requires === null],
  ] };
} });

// TWO edits, so "popped one step" can be told apart from "threw the session
// away". With a single edit on the stack, an undo implemented as "restore the
// file to how it was when the project opened" — or as a git checkout of that
// path — passed identically, and that is the difference between Cmd-Z and
// losing work.
fullScenario({ domain: 'project', action: 'undo', run: async ({ call, fixture }) => {
  const opened = fixture.read(INDEX);
  await call('target', 'set_prop', { ref: await nodeNamed(call, 'div'), name: 'data-keep', value: 'yes' });
  const afterFirst = fixture.read(INDEX);
  await call('target', 'add_class', { ref: await nodeNamed(call, 'div'), className: 'undo-me' });
  const afterSecond = fixture.read(INDEX);
  const { envelope } = await call('project', 'undo', {});
  const now = fixture.read(INDEX);
  return { envelope, checks: [
    ['both edits landed on the div first', !!gridTag(afterSecond) && gridTag(afterSecond).includes('data-keep="yes"') && gridTag(afterSecond).includes('undo-me')],
    ['undo took the last one back off that element', !!gridTag(now) && !gridTag(now).includes('undo-me')],
    ['and left the edit under it exactly where it was', !!gridTag(now) && gridTag(now).includes('data-keep="yes"')],
    ['one step, so the file is what it was before that edit', now === afterFirst],
    ['not what it was when the project opened', now !== opened],
  ] };
} });

// The same shape, from the other side. With one step on the stack, "redo the
// last undone step" and "restore a whole-file snapshot" are indistinguishable;
// with two, a redo that reapplied more than the one step it should — or that
// disturbed the edit underneath — fails.
fullScenario({ domain: 'project', action: 'redo', run: async ({ call, fixture }) => {
  const opened = fixture.read(INDEX);
  await call('target', 'set_prop', { ref: await nodeNamed(call, 'div'), name: 'data-keep', value: 'yes' });
  const afterFirst = fixture.read(INDEX);
  await call('target', 'add_class', { ref: await nodeNamed(call, 'div'), className: 'redo-me' });
  const afterSecond = fixture.read(INDEX);
  await call('project', 'undo', {});
  const undone = fixture.read(INDEX);
  const { envelope } = await call('project', 'redo', {});
  const now = fixture.read(INDEX);
  return { envelope, checks: [
    ['undo took the second edit back first, and only that one', undone === afterFirst && !undone.includes('redo-me')],
    ['redo put it back on the element it was made to', !!gridTag(now) && gridTag(now).includes('redo-me')],
    ['restoring exactly the state before the undo, no more', now === afterSecond],
    ['the edit under it was never disturbed', !!gridTag(now) && gridTag(now).includes('data-keep="yes"')],
    ['and the page is not the one the project opened with', now !== opened],
  ] };
} });

// dev_status / probe / install / dev_start / dev_stop are exercised against a
// REAL dev server in test/mcp-dev-lifecycle.js, which owns the process, the
// port and the installed fixture. They are registered here so the matrix sees
// one scenario per operation; each delegates to that harness.
const devLifecycle = require('./mcpDevLifecycle.js');

// `needs: 'deps'` on the three that have to reach a REAL running site: the app
// only starts its own preview when the project can run, and probe and
// dev_status are about what is actually listening.
fullScenario({ domain: 'project', action: 'dev_status', needs: 'server', run: (ctx) => devLifecycle.devStatus(ctx) });
fullScenario({ domain: 'project', action: 'dev_start', needs: 'server', run: (ctx) => devLifecycle.devStart(ctx) });
fullScenario({ domain: 'project', action: 'probe', needs: 'server', run: (ctx) => devLifecycle.probe(ctx) });
fullScenario({ domain: 'project', action: 'dev_stop', needs: 'server', run: (ctx) => devLifecycle.devStop(ctx) });
fullScenario({ domain: 'project', action: 'install', run: (ctx) => devLifecycle.install(ctx) });

// ── git ────────────────────────────────────────────────────────────────────
//
// A throwaway repository with a LOCAL BARE ORIGIN, so `push` is a real push
// that lands somewhere checkable and no remote anybody owns is touched.

const { execFileSync } = require('node:child_process');
const git = (fixture, args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim();

// A git question whose ANSWER is its exit code — `merge-base --is-ancestor` is
// the only honest way to ask "did that branch's history really join this one",
// and it says so by succeeding or failing rather than by printing.
const gitSaysYes = (fixture, args) => {
  try {
    execFileSync('git', args, { cwd: fixture.root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// The same, for a question git can REFUSE: asking a stash that is not there
// what it holds. The refusal is an answer — "nothing was parked" — and it
// belongs in a named failing check rather than in a thrown scenario.
const gitOrNothing = (fixture, args) => {
  try {
    return execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

// Each git scenario gets its own repository with a seed commit. Fixtures are
// per-scenario now, so nothing inherits `init` from a neighbour — and a
// scenario that silently depended on one was never testing what it claimed.
const seedRepo = async (call) => {
  await call('git', 'init', {});
  await call('git', 'commit', { message: 'seed commit for this scenario' });
};

fullScenario({ domain: 'git', action: 'init', run: async ({ call, fixture }) => {
  const { envelope } = await call('git', 'init', {});
  return { envelope, checks: [['the project is a git repository now', fixture.exists('.git')]] };
} });

// EVERY FIELD, AGAINST GIT ITSELF.
//
// `git:info` catches its own failures one subprocess at a time: a branch that
// could not be read becomes '(no commits yet)', a HEAD that could not be read
// becomes null, an unreadable status leaves `dirty` false. The key is present
// in all of those, so asking whether the key EXISTS grades a handler whose
// every git call failed as a pass — it answers a well-shaped fiction.
//
// The extra branch is deliberately alphabetically before the trunk: git lists
// branches alphabetically and main.js deliberately puts the trunk first, so
// this is the one arrangement where the documented ordering is falsifiable.
fullScenario({ domain: 'git', action: 'info', run: async ({ call, fixture }) => {
  await seedRepo(call);
  await call('git', 'checkout', { branch: 'a-side-branch', create: true });
  await call('git', 'checkout', { branch: 'main' });
  const { envelope } = await call('git', 'info', {});
  return { envelope, checks: [
    ['it is a repository', envelope?.isRepo === true],
    ['on the branch git says is checked out', envelope?.branch === git(fixture, ['branch', '--show-current']) && envelope?.branch === 'main'],
    ['at the commit HEAD points at', envelope?.head === git(fixture, ['rev-parse', 'HEAD'])],
    ['naming the trunk', envelope?.trunk === 'main'],
    ['listing both branches, trunk first, whatever order git gives them', (envelope?.branches || []).join(',') === 'main,a-side-branch'],
    ['and git really does list them the other way round', git(fixture, ['branch', '--format=%(refname:short)']).split('\n').map((s) => s.trim()).join(',') === 'a-side-branch,main'],
    ['a clean tree, which is what a fresh seed commit leaves', envelope?.dirty === false && (envelope?.dirtyFiles || []).length === 0],
    ['and git agrees it is clean', git(fixture, ['status', '--porcelain']) === ''],
    ['no remote, because none was added', envelope?.remote === null],
    ['no upstream, so "0 ahead" is not being confused with "never pushed"', envelope?.hasUpstream === false && envelope?.ahead === 0],
    ['and nothing parked', Array.isArray(envelope?.parked) && envelope.parked.length === 0],
  ] };
} });

// The STATUS COLUMNS are the operation. gitHistory.js takes care not to trim
// the porcelain line before slicing it, precisely so a worktree-only change
// stays distinguishable from a staged one — and "the name appears somewhere in
// the JSON" is true of an answer that got every one of those columns wrong.
fullScenario({ domain: 'git', action: 'status', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/status-canary.txt', 'untracked\n');
  const { envelope } = await call('git', 'status', {});
  const files = envelope?.files || [];
  const f = files.find((x) => x.path === 'public/status-canary.txt');
  return { envelope, checks: [
    ['it reports exactly the one thing that changed', files.length === 1 && envelope?.total === 1 && envelope?.returned === 1],
    ['at its repo-relative path rather than its basename', !!f],
    ['as untracked', f?.untracked === true],
    ['which means it is not staged', f?.staged === false],
    ['shown with the letter for a new file', f?.status === 'A'],
    ['and that is exactly what git\'s own porcelain says', git(fixture, ['status', '--porcelain']) === '?? public/status-canary.txt'],
  ] };
} });

fullScenario({ domain: 'git', action: 'commit', run: async ({ call, fixture }) => {
  // Only the repository: committing is what this scenario is for, so seeding a
  // commit here would make the subject its own setup.
  await call('git', 'init', {});
  const { envelope } = await call('git', 'commit', { message: 'The fixture, as the wire test found it' });
  return { envelope, checks: [['git reports a commit with that message', git(fixture, ['log', '-1', '--pretty=%s']) === 'The fixture, as the wire test found it']] };
} });

// A non-empty list was the whole check, and a history this test wrote itself
// deserves better: a log that ignored the paging, read the wrong repository or
// answered with one blank placeholder record all produced a non-empty list.
// Two commits and a page of one pins the order, the paging and `atEnd` — the
// three things the panel scrolls on.
fullScenario({ domain: 'git', action: 'log', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const older = git(fixture, ['rev-parse', 'HEAD']);
  fixture.write('public/log-canary.txt', 'written for the second commit\n');
  await call('git', 'commit', { message: 'the newer of the two commits' });
  const newer = git(fixture, ['rev-parse', 'HEAD']);
  const { envelope } = await call('git', 'log', { limit: 1 });
  const commits = envelope?.commits || [];
  return { envelope, checks: [
    ['a page of one holds one commit', commits.length === 1],
    ['holding the newest commit, not the oldest', commits[0]?.hash === newer && newer !== older],
    ['with the subject it was given', commits[0]?.subject === 'the newer of the two commits'],
    ['its short hash agreeing with git', commits[0]?.shortHash === git(fixture, ['rev-parse', '--short', 'HEAD'])],
    ['and its parent being the seed commit', (commits[0]?.parents || []).join(',') === older],
    ['the older commit is not on this page', !commits.some((c) => c.hash === older)],
    ['and the history is not over, because there is one behind it', envelope?.atEnd === false],
  ] };
} });

// `fixture` was used here and never taken from the arguments — a bare
// identifier that threw ReferenceError the moment the scenario ran, which is
// all this had ever done. The contract is `ls-files --cached --others
// --exclude-standard`: tracked and untracked, minus what .gitignore excludes.
fullScenario({ domain: 'git', action: 'all_files', run: async ({ call, fixture }) => {
  fixture.write('.gitignore', 'ignored-by-git/\n');
  fixture.write('ignored-by-git/secret.txt', 'must not be listed\n');
  await seedRepo(call);
  // Written after the seed commit, so this one is genuinely untracked.
  fixture.write('public/nested/deep/untracked-canary.txt', 'not committed\n');
  const { envelope } = await call('git', 'all_files', {});
  const paths = (envelope?.files || []).map((f) => f.path);
  const tracked = git(fixture, ['ls-files']).split('\n').filter(Boolean);
  return { envelope, checks: [
    ['git itself tracks the page', tracked.includes('src/pages/index.astro')],
    ['and Stacki lists every file git tracks', tracked.every((t) => paths.includes(t))],
    ['including the untracked one, which the contract asks for', paths.includes('public/nested/deep/untracked-canary.txt')],
    ['at its full path rather than its basename', !paths.includes('untracked-canary.txt')],
    ['while what .gitignore excludes stays out', !paths.some((p) => p.startsWith('ignored-by-git/'))],
    ['and git\'s own internals are never files of the project', !paths.some((p) => p === '.git' || p.startsWith('.git/'))],
    ['each entry carrying the status fields the shape promises', (envelope?.files || []).every((f) => typeof f.path === 'string' && 'status' in f && 'staged' in f)],
  ] };
} });

// THE WORKING TREE HAS TO DIFFER, or the question is unanswerable.
//
// Straight after a seed commit the file on disk and the file at HEAD are the
// same bytes, so a handler that ignored `ref` and simply read the disk passed —
// and someone asking "what did this look like before my change" was handed
// their own change back. The page is overwritten first, so the two answers are
// now different text and only one of them is the commit's.
fullScenario({ domain: 'git', action: 'file_at', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const committed = git(fixture, ['show', 'HEAD:src/pages/index.astro']);
  fixture.write('src/pages/index.astro', '<p>working copy only</p>\n');
  const { envelope } = await call('git', 'file_at', { ref: 'HEAD', path: 'src/pages/index.astro' });
  const text = String(envelope?.text ?? '');
  return { envelope, checks: [
    ['the file on disk really is something else now', fixture.read('src/pages/index.astro').includes('working copy only')],
    ['and the answer is the committed text, byte for byte', text.trim() === committed && committed.includes('<Hero')],
    ['not what the working tree holds', !text.includes('working copy only')],
    ['and not the empty string a missing file would give', text.length > 0],
    ['whole rather than clipped', envelope?.truncated === false],
  ] };
} });

// A SECOND, NARROW COMMIT — because the seed is a root commit and touches
// every file in the project, so "the list is non-empty" was satisfied by a
// handler that ignored `ref` and answered with `git status`, or with the whole
// tree, or with a different commit entirely. One commit that adds one file
// makes the right answer a list of exactly one, and the untracked decoy left
// on disk afterwards is what a status-shaped answer would drag in.
fullScenario({ domain: 'git', action: 'commit_files', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/second.txt', 'the only thing the second commit adds\n');
  await call('git', 'commit', { message: 'a commit that touches one file' });
  fixture.write('public/uncommitted.txt', 'never committed, so no commit touched it\n');
  const { envelope } = await call('git', 'commit_files', { ref: 'HEAD' });
  const files = envelope?.files || [];
  return { envelope, checks: [
    ['exactly one file was in that commit', files.length === 1],
    ['named at its repo-relative path', files[0]?.path === 'public/second.txt'],
    ['as an addition', files[0]?.status === 'A'],
    ['which is what git says that commit touched', git(fixture, ['show', '--name-status', '--format=', 'HEAD']) === 'A\tpublic/second.txt'],
    ['the working tree is not what was asked about', !files.some((f) => f.path === 'public/uncommitted.txt') && fixture.exists('public/uncommitted.txt')],
    ['and neither is the commit before it', !files.some((f) => f.path === 'src/pages/index.astro')],
  ] };
} });

// The OR in the old check made the real assertion optional: any non-empty list
// satisfied the second half, so a worktree belonging to another repository, or
// this one reported as detached with no branch, passed. Basenames are compared
// because the temp root arrives through macOS's /private symlink.
fullScenario({ domain: 'git', action: 'worktrees', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'worktrees', {});
  const list = envelope?.worktrees || [];
  const w = list[0] || {};
  return { envelope, checks: [
    ['this repository has one worktree and one is reported', list.length === 1],
    ['and it is this project', path.basename(String(w.path || '')) === path.basename(fixture.root)],
    ['on the branch that is checked out', w.branch === 'main' && w.branch === git(fixture, ['branch', '--show-current'])],
    ['at the commit that branch points at', w.head === git(fixture, ['rev-parse', 'HEAD'])],
    ['an ordinary checkout, not a detached HEAD', w.detached === false],
    ['and not a bare repository', w.bare === false],
  ] };
} });

fullScenario({ domain: 'git', action: 'checkout', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const was = git(fixture, ['branch', '--show-current']);
  // An uncommitted canary. A checkout implemented with `reset --hard` and
  // `clean -fdx` puts the branch name right and destroys the user's work doing
  // it, which is exactly what the one-check version could not see.
  fixture.write('public/uncommitted-canary.txt', 'work in progress\n');
  const { envelope } = await call('git', 'checkout', { branch: 'wire-branch', create: true });
  return { envelope, checks: [
    ['git reports the new branch as current', git(fixture, ['branch', '--show-current']) === 'wire-branch'],
    ['which is not the branch it was on', was !== 'wire-branch'],
    ['the uncommitted work came across untouched', fixture.exists('public/uncommitted-canary.txt') && fixture.read('public/uncommitted-canary.txt').includes('work in progress')],
    ['the committed files are still here', fixture.read('src/pages/index.astro').includes('<Hero')],
    ['and the branch it left still exists', git(fixture, ['branch', '--list', was]).includes(was)],
  ] };
} });

fullScenario({ domain: 'git', action: 'merge', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const base = git(fixture, ['rev-parse', 'HEAD']);
  // A branch with a commit of its own, then merge it back: merging the branch
  // you are standing on is refused, correctly.
  await call('git', 'checkout', { branch: 'wire-branch', create: true });
  fixture.write('public/merge-canary.txt', 'from the branch\n');
  await call('git', 'commit', { message: 'branch commit' });
  const branchTip = git(fixture, ['rev-parse', 'HEAD']);
  await call('git', 'checkout', { branch: 'main' });
  const { envelope } = await call('git', 'merge', { branch: 'wire-branch' });
  return { envelope, checks: [
    // THE POINT OF A MERGE IS THE HISTORY, not the files. `git checkout
    // wire-branch -- .` produces every other postcondition here — the canary
    // appears, the base object is still reachable — while recording nothing,
    // so main would still not contain the branch and the next merge would
    // conflict with work it already has.
    ['the branch\'s commit is now part of this branch\'s history', gitSaysYes(fixture, ['merge-base', '--is-ancestor', branchTip, 'HEAD'])],
    ['still standing on main afterwards', git(fixture, ['branch', '--show-current']) === 'main'],
    ['with no merge left half-done', !fixture.exists('.git/MERGE_HEAD')],
    ['and nothing left uncommitted by it', git(fixture, ['status', '--porcelain']) === ''],
    ['the base commit is still reachable', git(fixture, ['cat-file', '-t', base]) === 'commit'],
    ['the branch\'s file is on main with the branch\'s content', fixture.read('public/merge-canary.txt') === 'from the branch\n'],
    ['and it says which branch it merged into, and that it moved', envelope?.into === 'main' && envelope?.changed === true],
  ] };
} });

// Same missing `fixture`, and it asked to merge `main` into `main`, which is
// refused on principle — so this never reached a conflict, let alone resolved
// one. A real disagreement is built here: one file, changed differently on two
// branches, resolved by taking the incoming side deliberately.
fullScenario({ domain: 'git', action: 'resolve_merge', run: async ({ call, fixture }) => {
  const FILE = 'public/conflict-canary.txt';
  fixture.write(FILE, 'the common ancestor\n');
  await seedRepo(call);
  const base = git(fixture, ['rev-parse', 'HEAD']);

  await call('git', 'checkout', { branch: 'wire-conflict', create: true });
  fixture.write(FILE, 'the incoming side\n');
  await call('git', 'commit', { message: 'branch edits the canary' });

  await call('git', 'checkout', { branch: 'main' });
  fixture.write(FILE, 'the side already here\n');
  await call('git', 'commit', { message: 'main edits the same line' });

  // Proves the disagreement is real before anything is asked to settle it:
  // merge reports what it could not reconcile, then leaves the tree alone.
  const attempt = await call('git', 'merge', { branch: 'wire-conflict' });
  const clashed = JSON.stringify(attempt.envelope?.conflicts || attempt.envelope || {});

  const { envelope } = await call('git', 'resolve_merge', { branch: 'wire-conflict', choices: { [FILE]: 'theirs' } });
  const after = fixture.read(FILE);
  const status = git(fixture, ['status', '--porcelain']);
  return { envelope, checks: [
    ['the two branches really disagree about that file', clashed.includes('conflict-canary')],
    ['and the merge was the one thing that could not go through cleanly', attempt.envelope?.ok !== true || clashed.includes('conflict-canary')],
    ['resolving takes the side that was asked for', after.trim() === 'the incoming side'],
    ['leaving no conflict markers behind', !/^<{7}|^={7}|^>{7}/m.test(after)],
    ['nothing is left unmerged', !/^(UU|AA|DD|AU|UA|DU|UD)/m.test(status)],
    ['the merge is committed rather than left in progress', !fixture.exists('.git/MERGE_HEAD')],
    ['both sides are still reachable in history', git(fixture, ['cat-file', '-t', base]) === 'commit'],
    ['and no unrelated file was rewritten', fixture.read('src/pages/index.astro').includes('<Hero')],
  ] };
} });

// A CLEAN TREE IS NOT THE PROMISE. `git reset --hard && git clean -fd` leaves
// exactly the state the old check asked for, having thrown the person's
// uncommitted work away — which is the one thing the handler says park exists
// to prevent ("They are never lost"). So the proof is that the bytes are
// somewhere: in a stash, under Stacki's own tag, readable back out.
fullScenario({ domain: 'git', action: 'park', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/park-canary.txt', 'parked\n');
  const { envelope } = await call('git', 'park', {});
  const stashes = git(fixture, ['stash', 'list', '--format=%gs']).split('\n').filter(Boolean);
  return { envelope, checks: [
    ['it says it parked something', envelope?.parked === true],
    ['naming the branch it parked the work against', envelope?.branch === 'main'],
    ['the working tree is clean afterwards', git(fixture, ['status', '--porcelain']) === ''],
    ['and the file is off disk', !fixture.exists('public/park-canary.txt')],
    ['one stash holds it', stashes.length === 1],
    ['tagged as Stacki\'s own, so nobody else\'s stash is ever restored in its place', (stashes[0] || '').includes('stacki:park:main')],
    ['and the bytes are still in there — untracked work included', gitOrNothing(fixture, ['show', 'stash@{0}^3:public/park-canary.txt']) === 'parked'],
  ] };
} });

// EXISTENCE WAS THE WHOLE CHECK, and a file can come back empty, or come back
// as the branch's committed version rather than the parked one, and still
// exist. What was parked has to be what returns.
//
// `restored` is asserted as well, because unpark's failure path — the one that
// runs `reset --hard` and `clean -fd` and leaves the work in the stash —
// returns `{ restored: false, error }`, and that used to be spread over
// `{ ok: true }` and arrive as a success. It is a refusal now (the mapper turns
// it into `problem('failed', …)`), which the framework's `ok === true` catches;
// this pins the successful half of that same distinction.
fullScenario({ domain: 'git', action: 'unpark', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/park-canary.txt', 'parked\n');
  fixture.write('src/pages/about.astro', '<p>edited before parking</p>\n');
  await call('git', 'park', {});
  const parkedAway = !fixture.exists('public/park-canary.txt');
  const heldOne = git(fixture, ['stash', 'list']).split('\n').filter(Boolean).length === 1;
  const { envelope } = await call('git', 'unpark', {});
  return { envelope, checks: [
    ['parking took the file away first', parkedAway],
    ['leaving exactly one stash to come back from', heldOne],
    ['unpark says it restored the work rather than refusing', envelope?.restored === true],
    ['with no note explaining why it could not', envelope?.note === undefined],
    ['the untracked file is back', fixture.exists('public/park-canary.txt')],
    ['holding the bytes that were parked, not an empty file', fixture.read('public/park-canary.txt') === 'parked\n'],
    ['the edit to a tracked file came back too', fixture.read('src/pages/about.astro') === '<p>edited before parking</p>\n'],
    ['and the stash is consumed rather than left duplicating the work', git(fixture, ['stash', 'list']) === ''],
  ] };
} });

fullScenario({ domain: 'git', action: 'restore_file', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const committed = git(fixture, ['show', 'HEAD:src/pages/about.astro']);
  fixture.write('src/pages/about.astro', '<p>vandalised</p>\n');
  // A SECOND DIRTY FILE, which must stay dirty. `restore_file` restoring the
  // whole working tree — `git checkout <ref> -- .` — satisfies "this file
  // matches HEAD" while throwing away everything else uncommitted.
  fixture.write('public/keep-my-edit.txt', 'not committed, and not yours to revert\n');
  const { envelope } = await call('git', 'restore_file', { ref: 'HEAD', path: 'src/pages/about.astro' });
  return { envelope, checks: [
    ['the file matches what HEAD holds', fixture.read('src/pages/about.astro').trim() === committed.trim()],
    ['the other uncommitted change is still there', fixture.exists('public/keep-my-edit.txt') && fixture.read('public/keep-my-edit.txt').includes('not yours to revert')],
    ['and git still reports it as unstaged work', git(fixture, ['status', '--porcelain']).includes('keep-my-edit.txt')],
  ] };
} });

// THE WHOLE TREE, AND THE FILE THAT SHOULD NOT SURVIVE IT.
//
// "one file no longer contains one string" was true of a restore that deleted
// that file, or emptied it, or put back only the path it was pointed at. And
// it never touched the semantic gitSnapshot.js chose `read-tree -u --reset`
// for: a file that is TRACKED NOW and absent at the ref has to go, because a
// pathspec checkout would leave it behind and present "the old project plus
// whatever has appeared since" as how it was.
//
// So the restore goes back past a commit that added a file, and what was on
// disk unsaved has to be recoverable rather than quietly discarded.
fullScenario({ domain: 'git', action: 'restore_project', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const first = git(fixture, ['rev-parse', 'HEAD']);
  const aboutThen = git(fixture, ['show', `${first}:src/pages/about.astro`]);
  const indexThen = git(fixture, ['show', `${first}:src/pages/index.astro`]);

  // A second commit, so the ref asked for is not HEAD — and so there is a
  // tracked file that does not exist at it.
  fixture.write('public/added-later.txt', 'added after the commit being restored to\n');
  fixture.write('src/pages/about.astro', '<p>committed later, and not part of the restore</p>\n');
  await call('git', 'commit', { message: 'a commit made after the one to restore to' });
  const second = git(fixture, ['rev-parse', 'HEAD']);

  // And unsaved work on top of that, which restoring must park rather than eat.
  fixture.write('src/pages/index.astro', '<p>unsaved when the restore happened</p>\n');

  const { envelope } = await call('git', 'restore_project', { ref: first });
  return { envelope, checks: [
    ['the page that was committed since is back to how it was at that commit', fixture.read('src/pages/about.astro').trim() === aboutThen],
    ['and so is the one that was only unsaved — the whole tree moved, not one path', fixture.read('src/pages/index.astro').trim() === indexThen],
    ['a file tracked now but absent at that commit is gone, not left behind', !fixture.exists('public/added-later.txt')],
    ['so nothing at all differs from that commit', git(fixture, ['diff', '--name-only', first]) === ''],
    ['the branch did not move — going back is not a rewrite', git(fixture, ['rev-parse', 'HEAD']) === second],
    ['it says it parked what was on disk', envelope?.parked === true],
    ['git holds that under Stacki\'s own tag', git(fixture, ['stash', 'list', '--format=%gs']).includes('stacki:park:main')],
    ['and the unsaved work is readable back out of it', gitOrNothing(fixture, ['show', 'stash@{0}:src/pages/index.astro']) === '<p>unsaved when the restore happened</p>'],
  ] };
} });

fullScenario({ domain: 'git', action: 'delete_branch', run: async ({ call, fixture }) => {
  await seedRepo(call);
  // TWO branches to choose between. With only one, "the named branch is gone"
  // and "every branch is gone" describe the same world, so the scenario could
  // not tell a delete from a purge.
  await call('git', 'checkout', { branch: 'wire-branch', create: true });
  await call('git', 'checkout', { branch: 'wire-keeper', create: true });
  await call('git', 'checkout', { branch: 'main' });
  const before = git(fixture, ['branch', '--list', 'wire-branch']).includes('wire-branch');
  const { envelope } = await call('git', 'delete_branch', { branch: 'wire-branch', force: true });
  const branches = git(fixture, ['branch', '--format=%(refname:short)']).split('\n').map((b) => b.trim()).filter(Boolean);
  return { envelope, checks: [
    ['the branch existed first', before],
    ['and git no longer lists it', !branches.includes('wire-branch')],
    ['the branch it was not asked about survived', branches.includes('wire-keeper')],
    ['and so did the one it is standing on', branches.includes('main')],
  ] };
} });

// ASKED OF A gh THIS TEST OWNS.
//
// `typeof installed === 'boolean'` was a tautology: the handler returns
// `{installed:false,authed:false}` in its catch and `{installed:true,…}`
// otherwise, so it is a boolean on every path — replace the whole handler with
// a constant and it still passed, and the publish dialog would then tell
// somebody with gh installed to go and install it. It was also machine-
// dependent: true on the developer's Mac, false in CI.
//
// The fake exits 0 for `--version` and 64 for anything else, so
// `installed:true, authed:false` is reachable only by really running a gh
// TWICE and reading BOTH answers — and it is the same answer everywhere.
fullScenario({ domain: 'git', action: 'gh_status', run: async ({ call, fixture }) => {
  await seedRepo(call);
  return withFakeGh(async ({ calls }) => {
    const { envelope } = await call('git', 'gh_status', {});
    const seen = calls();
    return { envelope, checks: [
      ['a gh really ran, and it was the one this test owns', seen.length === 2],
      ['asked first whether there is a gh at all', seen[0]?.[0] === '--version'],
      ['and then whether it is signed in', seen[1]?.join(' ') === 'auth status'],
      ['so it reports the gh it found as installed', envelope?.installed === true],
      ['and signed out, which is what this gh answered', envelope?.authed === false],
      ['naming no account, because none answered', envelope?.user === undefined],
      ['and asking about gh changed nothing in the repository', git(fixture, ['status', '--porcelain']) === '' && git(fixture, ['remote']) === ''],
    ] };
  });
} });

fullScenario({ domain: 'git', action: 'push', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const os = require('node:os');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-wire-origin-'));
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: fixture.root, stdio: 'ignore' });
    // A second commit, so "the origin has A commit" and "the origin has the
    // commit that was here" are different facts.
    fixture.write('public/push-canary.txt', 'the tip that has to arrive\n');
    await call('git', 'commit', { message: 'the commit that must land' });
    const head = git(fixture, ['rev-parse', 'HEAD']);
    const { envelope } = await call('git', 'push', { branch: 'main' });
    const inOrigin = (args) => {
      try {
        return execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    };
    return { envelope, checks: [
      // A non-empty log was the whole check, and it is true of a push of the
      // wrong branch, or of an older commit. This is the exact commit on the
      // exact ref.
      ['the exact commit that was here is on origin\'s main', inOrigin(['rev-parse', 'refs/heads/main']) === head],
      ['and it is the only branch that went', inOrigin(['for-each-ref', '--format=%(refname)', 'refs/heads']) === 'refs/heads/main'],
      ['the origin can read the file that commit added', inOrigin(['show', 'refs/heads/main:public/push-canary.txt']) === 'the tip that has to arrive'],
      // `-u` is not decoration: git:info reports hasUpstream/ahead off it, and
      // without it the branch reads as never pushed.
      ['the branch now tracks origin/main', gitOrNothing(fixture, ['rev-parse', '--abbrev-ref', '@{upstream}']) === 'origin/main'],
      ['so git says there is nothing left to push', gitOrNothing(fixture, ['rev-list', '--count', '--left-only', 'HEAD...@{upstream}']) === '0'],
    ] };
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
} });

boundaryScenario({
  domain: 'git', action: 'publish',
  why: 'Publishing creates a repository on GitHub under the user\'s own account and pushes to it. Everything up to the external program runs — schema, permission gate, dispatcher, domain adapter and the real git:publish handler — and the `gh` binary itself is replaced by a test-owned fake, so GitHub is never reached.',
  run: async ({ call }) => {
    // THIS SCENARIO ONCE CREATED A REAL REPOSITORY.
    //
    // It was graded BOUNDARY on the assumption that publish would refuse
    // before doing anything external. It did not: the real handler ran, `gh`
    // resolved to the developer's authenticated binary, and GitHub made
    // heymarcell/stacki-wire-test-never-created. The boundary was a hope
    // rather than a mechanism.
    //
    // Now the boundary IS a mechanism: `gh` is shadowed on PATH by a fake this
    // test owns, the shadow is verified before the call is allowed to happen,
    // and if the fake never ran this fails rather than assuming it was fine.
    return withFakeGh(async ({ calls }) => {
      const { envelope } = await call('git', 'publish', { repoName: 'stacki-wire-boundary-fake', private: true });
      const seen = calls();
      const create = seen.find((argv) => argv[0] === 'repo' && argv[1] === 'create');

      // FAIL CLOSED. No recorded invocation means the real gh may have been
      // the one that answered, and that is the failure this file exists for.
      if (!seen.length) {
        return { good: false, detail: 'the fake gh was never invoked — the boundary cannot be proven, so this fails rather than assume GitHub was untouched' };
      }

      const flag = (name) => create && create.includes(name);
      const held = [
        ['the fake gh was asked for its version first', seen.some((argv) => argv[0] === '--version')],
        ['and then asked to create a repository', !!create],
        ['under the name the caller gave', !!create && create.includes('stacki-wire-boundary-fake')],
        ['privately, as asked', flag('--private')],
        ['from this project as the source', flag('--source')],
        ['wiring it up as origin', flag('--remote')],
        ['and pushing', flag('--push')],
        // AND WHAT CAME BACK. The half above only proves what arrived at the
        // seam. The fake logs every argv BEFORE it decides what to do, so an
        // invocation that exited 64 is still recorded and `create` is still
        // found — and `typeof ok === 'boolean'` is satisfied by ok:false. So a
        // publish that reached the boundary and FAILED there was graded good.
        ['the operation succeeded rather than failing at the boundary', envelope?.ok === true],
        ['answering with the URL this fake printed, which the handler had to parse out of real output', envelope?.url === 'https://github.com/fake-owner/fake-repo'],
        ['from output that came back from the program itself', String(envelope?.output || '').includes('https://github.com/fake-owner/fake-repo')],
        // Nothing else was asked of gh — so a handler that grew an extra call
        // to the network cannot slip past unnoticed.
        ['and gh was asked for nothing but its version and that one repo create', seen.length === 2 && seen.every((argv) => argv[0] === '--version' || argv[0] === 'repo')],
      ];
      const failed = held.filter(([, ok]) => !ok).map(([label]) => label);
      return {
        good: failed.length === 0,
        detail: failed.length ? `${failed.join('; ')} | argv seen: ${JSON.stringify(seen)}` : '',
      };
    });
  },
});

module.exports = { flatten };
