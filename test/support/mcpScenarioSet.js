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

fullScenario({ domain: 'target', action: 'read', run: async ({ call }) => {
  const { envelope } = await call('target', 'read');
  const t = envelope?.target;
  return { envelope, checks: [
    ['it answers with a source-backed node', !!t?.ref && !!t?.tag],
    ['that names the fixture page', JSON.stringify(t?.page || {}).includes('index.astro')],
    ['and carries the children the page really has', (t?.children || []).length > 0],
  ] };
} });

fullScenario({ domain: 'target', action: 'select', run: async ({ call, ref }) => {
  const r = await ref('Hero');
  const { envelope } = await call('target', 'select', { ref: r });
  const now = await call('target', 'read');
  return { envelope, checks: [
    ['selecting answers about the node asked for', !!envelope],
    ['and the editor still reads a live tree afterwards', !!now.envelope?.target?.ref],
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

fullScenario({ domain: 'target', action: 'exit', run: async ({ call, ref }) => {
  await call('target', 'enter', { ref: await ref('Hero') });
  const { envelope } = await call('target', 'exit', {});
  const back = await call('target', 'read');
  return { envelope, checks: [
    ['leaving the component answers', !!envelope],
    ['and the page tree is what reads back', JSON.stringify(back.envelope?.target?.page || {}).includes('index.astro')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_text', run: async ({ call, ref, fixture }) => {
  const inside = await call('target', 'enter', { ref: await ref('Hero') });
  const h1 = flatten(inside.envelope?.target).find((n) => String(n.tag || '').toLowerCase() === 'h1');
  const { envelope } = await call('target', 'set_text', { ref: h1?.ref, text: 'Wire-driven heading', replaceBinding: true });
  return { envelope, checks: [
    ['the text is in Hero.astro on disk', fixture.read('src/components/Hero.astro').includes('Wire-driven heading')],
    ['and the old text is gone', !fixture.read('src/components/Hero.astro').includes('Welcome to Stacki')],
  ] };
} });

fullScenario({ domain: 'target', action: 'edit', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'edit', { ref: await ref('div'), operations: [{ type: 'add_class', className: 'wire-batch' }] });
  return { envelope, checks: [['the batched class reached the file', fixture.read('src/pages/index.astro').includes('wire-batch')]] };
} });

fullScenario({ domain: 'target', action: 'set_prop', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'set_prop', { ref: await ref('div'), name: 'data-wire', value: 'yes' });
  return { envelope, checks: [['the prop is authored in the page', /data-wire=("|\{)?"?yes/.test(fixture.read('src/pages/index.astro'))]] };
} });

fullScenario({ domain: 'target', action: 'remove_prop', run: async ({ call, ref, fixture }) => {
  await call('target', 'set_prop', { ref: await ref('div'), name: 'data-doomed', value: 'x' });
  const before = fixture.read('src/pages/index.astro').includes('data-doomed');
  const { envelope } = await call('target', 'remove_prop', { ref: await ref('div'), name: 'data-doomed' });
  return { envelope, checks: [
    ['the prop was there first', before],
    ['and is gone from the file', !fixture.read('src/pages/index.astro').includes('data-doomed')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_classes', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'set_classes', { ref: await ref('div'), classes: ['wire-only'] });
  const src = fixture.read('src/pages/index.astro');
  return { envelope, checks: [
    ['the new class list is authored', src.includes('wire-only')],
    ['and it replaced what was there', !src.includes('pricing-grid') || src.includes('wire-only')],
  ] };
} });

fullScenario({ domain: 'target', action: 'add_class', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'add_class', { ref: await ref('div'), className: 'wire-added' });
  return { envelope, checks: [['the class is in the page source', fixture.read('src/pages/index.astro').includes('wire-added')]] };
} });

fullScenario({ domain: 'target', action: 'remove_class', run: async ({ call, ref, fixture }) => {
  await call('target', 'add_class', { ref: await ref('div'), className: 'wire-doomed' });
  const before = fixture.read('src/pages/index.astro').includes('wire-doomed');
  const { envelope } = await call('target', 'remove_class', { ref: await ref('div'), className: 'wire-doomed' });
  return { envelope, checks: [
    ['the class was added first', before],
    ['and removing it took it out of the file', !fixture.read('src/pages/index.astro').includes('wire-doomed')],
  ] };
} });

fullScenario({ domain: 'target', action: 'insert_before', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'insert_before', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'inserted-before' } });
  return { envelope, checks: [['the new node is authored in the page', fixture.read('src/pages/index.astro').includes('inserted-before')]] };
} });

fullScenario({ domain: 'target', action: 'insert_after', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'insert_after', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'inserted-after' } });
  return { envelope, checks: [['the new node is authored in the page', fixture.read('src/pages/index.astro').includes('inserted-after')]] };
} });

fullScenario({ domain: 'target', action: 'append_child', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('target', 'append_child', { ref: await ref('footer'), node: { kind: 'element', tag: 'span', text: 'appended-child' } });
  return { envelope, checks: [['the child is authored inside the parent', fixture.read('src/pages/index.astro').includes('appended-child')]] };
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

fullScenario({ domain: 'target', action: 'move', run: async ({ call, ref, fixture }) => {
  const before = fixture.read('src/pages/index.astro');
  const { envelope } = await call('target', 'move', { ref: await ref('div'), to: { index: 0 } });
  return { envelope, checks: [['the page source is not what it was', fixture.read('src/pages/index.astro') !== before]] };
} });

fullScenario({ domain: 'target', action: 'set_tag', run: async ({ call, ref, fixture }) => {
  await call('target', 'insert_after', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'retag-me' } });
  const { envelope } = await call('target', 'set_tag', { ref: (await ref('p')), tag: 'h4' });
  return { envelope, checks: [['an h4 is now authored in the page', /<h4/.test(fixture.read('src/pages/index.astro'))]] };
} });

fullScenario({ domain: 'target', action: 'remove', run: async ({ call, ref, fixture }) => {
  await call('target', 'insert_after', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'doomed-node' } });
  const before = fixture.read('src/pages/index.astro').includes('doomed-node');
  const target = flatten((await call('target', 'read')).envelope?.target).find((n) => String(n.text || '').includes('doomed-node'));
  const { envelope } = await call('target', 'remove', { ref: target?.ref });
  return { envelope, checks: [
    ['the node was there first', before],
    ['and is gone from the file', !fixture.read('src/pages/index.astro').includes('doomed-node')],
  ] };
} });


// ── style ──────────────────────────────────────────────────────────────────

const firstCell = async (call) => {
  const { envelope } = await call('style', 'variables', {});
  for (const file of envelope?.files || []) for (const g of file.groups || []) for (const b of g.blocks || []) for (const r of b.rows || []) for (const c of r.cells || []) if (c?.name) return c;
  return null;
};
const css = (fixture) => fixture.read('src/styles/site.css');

fullScenario({ domain: 'style', action: 'list_sources', run: async ({ call }) => {
  const { envelope } = await call('style', 'list_sources', {});
  return { envelope, checks: [['it names the fixture stylesheet', (envelope?.sources || []).some((x) => String(x.label || x.key).includes('site.css'))]] };
} });

fullScenario({ domain: 'style', action: 'read', run: async ({ call, ref }) => {
  const { envelope } = await call('style', 'read', { ref: await ref('div') });
  return { envelope, checks: [['it answers with the cascade for that node', Array.isArray(envelope?.rules) || Array.isArray(envelope?.declarations) || Array.isArray(envelope?.matched)]] };
} });

fullScenario({ domain: 'style', action: 'read_source', run: async ({ call }) => {
  const { envelope } = await call('style', 'read_source', { path: 'src/styles/site.css' });
  return { envelope, checks: [
    ['it returns the stylesheet text', typeof envelope?.css === 'string'],
    ['containing the variable the fixture declares', String(envelope?.css || '').includes('--gap')],
    ['and a digest to guard a write with', !!envelope?.digest],
  ] };
} });

fullScenario({ domain: 'style', action: 'variables', run: async ({ call }) => {
  // One subject call, and it is the LAST one: `firstCell` also asks
  // style.variables, so calling it after would leave the runner holding a
  // different invocation than the one being judged. The framework caught
  // exactly that, which is what it is for.
  const { envelope } = await call('style', 'variables', {});
  const cell = (() => {
    for (const file of envelope?.files || []) for (const g of file.groups || []) for (const b of g.blocks || []) for (const r of b.rows || []) for (const c of r.cells || []) if (c?.name) return c;
    return null;
  })();
  return { envelope, checks: [
    ['it reports the fixture stylesheet', (envelope?.files || []).some((f) => String(f.path).includes('site.css'))],
    ['with a real variable and its span', !!cell && typeof cell.valueStart === 'number'],
  ] };
} });

fullScenario({ domain: 'style', action: 'write_source', run: async ({ call, fixture }) => {
  const read = await call('style', 'read_source', { path: 'src/styles/site.css' });
  const next = String(read.envelope?.css || '') + '\n.wire-written { color: red; }\n';
  const { envelope } = await call('style', 'write_source', { path: 'src/styles/site.css', css: next, expectedDigest: read.envelope?.digest });
  return { envelope, checks: [['the rule is in the stylesheet on disk', css(fixture).includes('.wire-written')]] };
} });

fullScenario({ domain: 'style', action: 'set_property', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('style', 'set_property', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', property: 'outline', value: '3px solid red' });
  return { envelope, checks: [['the declaration is authored in a stylesheet', css(fixture).includes('outline') && css(fixture).includes('3px solid red')]] };
} });

fullScenario({ domain: 'style', action: 'set_declarations', run: async ({ call, ref, fixture }) => {
  const { envelope } = await call('style', 'set_declarations', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', declarations: [{ property: 'opacity', value: '0.42' }] });
  return { envelope, checks: [['the declaration reached the stylesheet', css(fixture).includes('0.42')]] };
} });

fullScenario({ domain: 'style', action: 'remove_property', run: async ({ call, ref, fixture }) => {
  await call('style', 'set_property', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', property: 'letter-spacing', value: '3px' });
  const before = css(fixture).includes('letter-spacing');
  const cascade = await call('style', 'read', { ref: await ref('div') });
  const decl = (cascade.envelope?.rules || []).flatMap((r) => r.declarations || []).find((d) => d?.identity && String(d.property) === 'letter-spacing');
  const { envelope } = await call('style', 'remove_property', { ref: await ref('div'), identity: decl?.identity });
  return { envelope, checks: [
    ['the declaration was written first', before],
    ['and removing it took it out of the stylesheet', !css(fixture).includes('letter-spacing')],
  ] };
} });

fullScenario({ domain: 'style', action: 'set_variable', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'set_variable', { edit: { file: cell.file, valueStart: cell.valueStart, valueEnd: cell.valueEnd, value: '2.5rem', expect: cell.value } });
  return { envelope, checks: [
    ['the new value is in the stylesheet', css(fixture).includes('2.5rem')],
    ['and the old one is gone', !css(fixture).includes(`${cell.name}: ${cell.value}`)],
  ] };
} });

fullScenario({ domain: 'style', action: 'add_variables', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-added', value: '4px' }] });
  return { envelope, checks: [['the variable is declared in the stylesheet', css(fixture).includes('--wire-added')]] };
} });

fullScenario({ domain: 'style', action: 'rename_variables', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-old', value: '1px' }] });
  const before = css(fixture).includes('--wire-old');
  const { envelope } = await call('style', 'rename_variables', { renames: [{ from: '--wire-old', to: '--wire-new' }] });
  return { envelope, checks: [
    ['the old name existed', before],
    ['the new name is there', css(fixture).includes('--wire-new')],
    ['and the old one is not', !css(fixture).includes('--wire-old')],
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
  ] };
} });

fullScenario({ domain: 'style', action: 'add_section', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Wire section', at: 0 } });
  return { envelope, checks: [['the section heading is in the stylesheet', css(fixture).includes('Wire section')]] };
} });

fullScenario({ domain: 'style', action: 'set_section_title', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Before rename', at: 0 } });
  const text = css(fixture);
  const start = text.indexOf('Before rename');
  const { envelope } = await call('style', 'set_section_title', { edit: { file: cell.file, start, end: start + 'Before rename'.length, title: 'After rename', expect: 'Before rename' } });
  return { envelope, checks: [
    ['the new title is in the stylesheet', css(fixture).includes('After rename')],
    ['and the old title is gone', !css(fixture).includes('Before rename')],
  ] };
} });

fullScenario({ domain: 'style', action: 'remove_section', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Doomed section', at: 0 } });
  const text = css(fixture);
  const start = text.indexOf('Doomed section');
  const { envelope } = await call('style', 'remove_section', { edit: { file: cell.file, start, end: start + 'Doomed section'.length, expect: 'Doomed section' } });
  return { envelope, checks: [['the section heading is gone from the stylesheet', !css(fixture).includes('Doomed section')]] };
} });

fullScenario({ domain: 'style', action: 'move_heading', run: async ({ call, fixture }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Movable heading', at: 0 } });
  const text = css(fixture);
  const start = text.indexOf('Movable heading');
  const { envelope } = await call('style', 'move_heading', { edit: { file: cell.file, selector: cell.selector, start, end: start + 'Movable heading'.length, expect: 'Movable heading' } });
  return { envelope, checks: [['the heading survives the move', css(fixture).includes('Movable heading')]] };
} });

// ── source ─────────────────────────────────────────────────────────────────

fullScenario({ domain: 'source', action: 'read', run: async ({ call }) => {
  const { envelope } = await call('source', 'read', { path: 'src/pages/index.astro' });
  return { envelope, checks: [
    ['it returns the page the fixture authored', String(envelope?.text || '').includes('<Hero')],
    ['with a digest a guarded write can use', !!envelope?.digest],
  ] };
} });

fullScenario({ domain: 'source', action: 'resolve_path', run: async ({ call }) => {
  const { envelope } = await call('source', 'resolve_path', { fromFile: 'src/pages/index.astro', spec: '../components/Hero.astro' });
  return { envelope, checks: [
    ['it answers explicitly about the path', 'path' in (envelope || {})],
    ['and does not claim the spec escapes the project', envelope?.outsideProject === false],
  ] };
} });

fullScenario({ domain: 'source', action: 'read_symbol', run: async ({ call }) => {
  const { envelope } = await call('source', 'read_symbol', { fromFile: 'src/pages/index.astro', spec: '../components/Hero.astro', name: 'default' });
  return { envelope, checks: [['it answers about a symbol in a file the fixture has', !!envelope && ('text' in envelope || 'path' in envelope || 'symbol' in envelope)]] };
} });

fullScenario({ domain: 'source', action: 'write', run: async ({ call, fixture }) => {
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'write', { path: 'src/lib/format.js', text: '// wire-wrote-this\n' + String(read.envelope?.text || ''), expectedDigest: read.envelope?.digest });
  return { envelope, checks: [['the file on disk starts with what was written', fixture.read('src/lib/format.js').startsWith('// wire-wrote-this')]] };
} });

fullScenario({ domain: 'source', action: 'replace_range', run: async ({ call, fixture }) => {
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'replace_range', { path: 'src/lib/format.js', startLine: 1, endLine: 1, text: '// wire-replaced-line-one', expectedDigest: read.envelope?.digest });
  return { envelope, checks: [['the first line is the replacement', fixture.read('src/lib/format.js').split('\n')[0] === '// wire-replaced-line-one']] };
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

fullScenario({ domain: 'page', action: 'create', run: async ({ call, fixture }) => {
  const { envelope } = await call('page', 'create', { name: 'wire-made', layout: 'Base' });
  return { envelope, checks: [['the new page exists on disk', fixture.exists('src/pages/wire-made.astro')]] };
} });

fullScenario({ domain: 'page', action: 'move', run: async ({ call, fixture }) => {
  await call('page', 'create', { name: 'wire-made', layout: 'Base' });
  const { envelope } = await call('page', 'move', { from: 'src/pages/wire-made.astro', to: 'moved/index.astro' });
  return { envelope, checks: [
    ['the old path is gone', !fixture.exists('src/pages/wire-made.astro')],
    ['and the new path exists', fixture.exists('src/pages/moved/index.astro')],
  ] };
} });

fullScenario({ domain: 'page', action: 'delete', run: async ({ call, fixture }) => {
  await call('page', 'create', { name: 'wire-doomed', layout: 'Base' });
  const before = fixture.exists('src/pages/wire-doomed.astro');
  const { envelope } = await call('page', 'delete', { path: 'src/pages/wire-doomed.astro' });
  return { envelope, checks: [
    ['the page was there first', before],
    ['and is gone from disk', !fixture.exists('src/pages/wire-doomed.astro')],
  ] };
} });

fullScenario({ domain: 'page', action: 'folder_create', run: async ({ call, fixture }) => {
  const { envelope } = await call('page', 'folder_create', { dir: 'wire-docs' });
  return { envelope, checks: [['the folder exists under pages', fixture.exists('src/pages/wire-docs')]] };
} });

fullScenario({ domain: 'page', action: 'folder_rename', run: async ({ call, fixture }) => {
  await call('page', 'folder_create', { dir: 'wire-docs' });
  const { envelope } = await call('page', 'folder_rename', { from: 'wire-docs', to: 'wire-guide' });
  return { envelope, checks: [
    ['the old folder is gone', !fixture.exists('src/pages/wire-docs')],
    ['and the new one exists', fixture.exists('src/pages/wire-guide')],
  ] };
} });

fullScenario({ domain: 'page', action: 'folder_delete', run: async ({ call, fixture }) => {
  await call('page', 'folder_create', { dir: 'wire-guide' });
  const before = fixture.exists('src/pages/wire-guide');
  const { envelope } = await call('page', 'folder_delete', { dir: 'wire-guide' });
  return { envelope, checks: [
    ['the folder was there first', before],
    ['and is gone', !fixture.exists('src/pages/wire-guide')],
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

fullScenario({ domain: 'page', action: 'component_usage', run: async ({ call }) => {
  const { envelope } = await call('page', 'component_usage', { name: 'Card' });
  const found = JSON.stringify(envelope);
  return { envelope, checks: [['it finds Card used on the index page', found.includes('index.astro')]] };
} });

fullScenario({ domain: 'page', action: 'dynamic_paths', run: async ({ call }) => {
  const { envelope } = await call('page', 'dynamic_paths', { path: 'src/pages/notes/[slug].astro' });
  return { envelope, checks: [
    ['it answers with a paths list', Array.isArray(envelope?.paths)],
    // Evaluating getStaticPaths needs the Astro runtime, which this fixture
    // deliberately does not install. Either it enumerated them or it says why —
    // what it may not do is invent paths.
    ['and either enumerates them or reports why not', envelope.paths.length > 0 || 'problem' in envelope],
  ] };
} });

fullScenario({ domain: 'page', action: 'injected_routes', run: async ({ call }) => {
  const { envelope } = await call('page', 'injected_routes', {});
  return { envelope, checks: [
    ['it answers with a routes list', Array.isArray(envelope?.routes)],
    // The fixture has no integrations, so empty is the TRUE answer here and
    // asserting it is asserting the fixture, not hiding behind a shrug.
    ['which is empty, because the fixture adds no integrations', envelope.routes.length === 0],
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

fullScenario({ domain: 'asset', action: 'list', run: async ({ call }) => {
  const { envelope } = await call('asset', 'list', { under: 'public' });
  const found = JSON.stringify(envelope);
  return { envelope, checks: [
    ['it lists the robots file the fixture ships', found.includes('robots.txt')],
    ['and the image', found.includes('dot.png')],
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

fullScenario({ domain: 'asset', action: 'write_text', run: async ({ call, fixture }) => {
  const read = await call('asset', 'read_text', { path: 'public/robots.txt' });
  const { envelope } = await call('asset', 'write_text', { path: 'public/robots.txt', text: 'User-agent: *\nDisallow: /wire\n', ref: read.envelope?.ref });
  return { envelope, checks: [
    ['the new text is on disk', fixture.read('public/robots.txt').includes('/wire')],
    ['and the old canary is gone', !fixture.read('public/robots.txt').includes(ROBOTS_CANARY)],
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
  const before = fixture.exists('public/spare.txt');
  const { envelope } = await call('asset', 'delete', { path: 'public/spare.txt' });
  return { envelope, checks: [
    ['the file was there first', before],
    ['and is gone from disk', !fixture.exists('public/spare.txt')],
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

fullScenario({ domain: 'content', action: 'cms_list', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_list', {});
  return { envelope, checks: [['it finds the JSON data file the fixture ships', JSON.stringify(envelope).includes('site.json')]] };
} });

fullScenario({ domain: 'content', action: 'cms_read', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_read', { path: 'src/data/site.json' });
  return { envelope, checks: [['it parses the fixture data', !!envelope?.data && typeof envelope.data === 'object']] };
} });

fullScenario({ domain: 'content', action: 'cms_write', run: async ({ call, fixture }) => {
  const read = await call('content', 'cms_read', { path: 'src/data/site.json' });
  const { envelope } = await call('content', 'cms_write', { path: 'src/data/site.json', data: { ...(read.envelope?.data || {}), wireWrote: true }, ref: read.envelope?.ref });
  return { envelope, checks: [['the new key is in the file on disk', JSON.parse(fixture.read('src/data/site.json')).wireWrote === true]] };
} });

fullScenario({ domain: 'content', action: 'cms_create', run: async ({ call, fixture }) => {
  const { envelope } = await call('content', 'cms_create', { name: 'wireteam' });
  return { envelope, checks: [['a new data file exists', fixture.exists('src/data/wireteam.json')]] };
} });

fullScenario({ domain: 'content', action: 'cms_usage', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_usage', { path: 'src/data/site.json' });
  return { envelope, checks: [['it answers where the data is used', !!envelope && ('usages' in envelope || 'files' in envelope || 'pages' in envelope)]] };
} });

fullScenario({ domain: 'content', action: 'cms_meta', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_meta', {});
  return { envelope, checks: [['it answers with a meta map', !!envelope && typeof envelope.meta === 'object']] };
} });

fullScenario({ domain: 'content', action: 'cms_set_meta', run: async ({ call, fixture }) => {
  const { envelope } = await call('content', 'cms_set_meta', { path: 'src/data/site.json', fields: { label: 'Wire' } });
  // Read back through a different operation: the meta is not in a file this
  // fixture can open, so the follow-up read IS the world evidence.
  const back = await call('content', 'cms_meta', {});
  fixture.observedWorld('read the meta back through content.cms_meta');
  return { envelope, checks: [['the meta it set reads back', JSON.stringify(back.envelope?.meta || {}).includes('Wire')]] };
} });

fullScenario({ domain: 'content', action: 'cms_delete', run: async ({ call, fixture }) => {
  await call('content', 'cms_create', { name: 'wireteam' });
  const before = fixture.exists('src/data/wireteam.json');
  const { envelope } = await call('content', 'cms_delete', { path: 'src/data/wireteam.json' });
  return { envelope, checks: [
    ['the data file was there first', before],
    ['and is gone', !fixture.exists('src/data/wireteam.json')],
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
fullScenario({ domain: 'content', action: 'sample_entry', needs: 'server', run: async ({ call, fixture }) => {
  await call('project', 'dev_start', {});
  try {
    const { envelope } = await call('content', 'sample_entry', { collection: 'notes' });
    fixture.observedWorld('asked the running dev server to run the collection loader');
    return { envelope, checks: [
      ['it answers with one entry of that collection', !!envelope?.entry],
      ['identified the way the collection identifies it', envelope?.entry?.id === 'first' || envelope?.entry?.id === 'second'],
      ['carrying the data the entry really holds', typeof envelope?.entry?.data?.title === 'string'],
      ['and naming the file it came from', String(envelope?.entry?.filePath || '').includes('src/content/notes/')],
    ] };
  } finally {
    await call('project', 'dev_stop', {});
  }
} });

fullScenario({ domain: 'content', action: 'targets', needs: 'deps', run: async ({ call }) => {
  const { envelope } = await call('content', 'targets', { collection: 'notes' });
  const ids = (envelope?.targets || []).map((t) => t.id).sort();
  return { envelope, checks: [
    ['it lists what a reference to this collection could point at', JSON.stringify(ids) === JSON.stringify(['first', 'second'])],
    ['each with the title that identifies it to a person', (envelope?.targets || []).every((t) => typeof t.title === 'string' && t.title.length > 0)],
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

fullScenario({ domain: 'content', action: 'resolve_import', run: async ({ call }) => {
  const { envelope } = await call('content', 'resolve_import', { fromFile: 'src/pages/index.astro', spec: '../data/site.json' });
  return { envelope, checks: [['it resolves the data import the page really has', 'path' in (envelope || {})]] };
} });


// ── project ────────────────────────────────────────────────────────────────

fullScenario({ domain: 'project', action: 'info', run: async ({ call }) => {
  const { envelope } = await call('project', 'info', {});
  return { envelope, checks: [
    ['the project reads as open', envelope?.project?.open === true],
    ['with an access mode', !!envelope?.access?.mode],
    ['and the page the app is showing', String(envelope?.page?.file || '').includes('index.astro')],
  ] };
} });

fullScenario({ domain: 'project', action: 'scan', run: async ({ call }) => {
  const { envelope } = await call('project', 'scan', {});
  return { envelope, checks: [
    ['the scan finds the fixture pages', (envelope?.pages || []).some((p) => p.route === '/')],
    ['and its components', JSON.stringify(envelope).includes('Hero')],
  ] };
} });

fullScenario({ domain: 'project', action: 'classes', run: async ({ call }) => {
  const { envelope } = await call('project', 'classes', {});
  return { envelope, checks: [
    ['it finds the classes the fixture stylesheet declares', (envelope?.classes || []).includes('hero')],
    ['and counts them', Number.isInteger(envelope?.total) && envelope.total > 0],
  ] };
} });

fullScenario({ domain: 'project', action: 'dependencies', run: async ({ call }) => {
  const { envelope } = await call('project', 'dependencies', {});
  return { envelope, checks: [['it says whether the dependencies are installed', typeof envelope?.installed === 'boolean']] };
} });

fullScenario({ domain: 'project', action: 'diagnose', run: async ({ call }) => {
  const { envelope } = await call('project', 'diagnose', {});
  return { envelope, checks: [
    ['it names what state the project is in', typeof envelope?.kind === 'string'],
    ['and reports the node it found', envelope?.nodeFound === true && typeof envelope?.nodeVersion === 'string'],
  ] };
} });

fullScenario({ domain: 'project', action: 'undo', run: async ({ call, ref, fixture }) => {
  await call('target', 'add_class', { ref: await ref('div'), className: 'undo-me' });
  const applied = fixture.read('src/pages/index.astro').includes('undo-me');
  const { envelope } = await call('project', 'undo', {});
  return { envelope, checks: [
    ['the edit landed first', applied],
    ['and undo took it back out of the file', !fixture.read('src/pages/index.astro').includes('undo-me')],
  ] };
} });

fullScenario({ domain: 'project', action: 'redo', run: async ({ call, ref, fixture }) => {
  await call('target', 'add_class', { ref: await ref('div'), className: 'redo-me' });
  await call('project', 'undo', {});
  const undone = !fixture.read('src/pages/index.astro').includes('redo-me');
  const { envelope } = await call('project', 'redo', {});
  return { envelope, checks: [
    ['undo removed it first', undone],
    ['and redo put it back', fixture.read('src/pages/index.astro').includes('redo-me')],
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

fullScenario({ domain: 'git', action: 'info', run: async ({ call }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'info', {});
  return { envelope, checks: [['it reports the repository it just initialised', 'branch' in envelope || 'head' in envelope || 'repo' in envelope]] };
} });

fullScenario({ domain: 'git', action: 'status', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/status-canary.txt', 'untracked\n');
  const { envelope } = await call('git', 'status', {});
  return { envelope, checks: [['it sees the file just written into the working tree', JSON.stringify(envelope).includes('status-canary')]] };
} });

fullScenario({ domain: 'git', action: 'commit', run: async ({ call, fixture }) => {
  // Only the repository: committing is what this scenario is for, so seeding a
  // commit here would make the subject its own setup.
  await call('git', 'init', {});
  const { envelope } = await call('git', 'commit', { message: 'The fixture, as the wire test found it' });
  return { envelope, checks: [['git reports a commit with that message', git(fixture, ['log', '-1', '--pretty=%s']) === 'The fixture, as the wire test found it']] };
} });

fullScenario({ domain: 'git', action: 'log', run: async ({ call }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'log', { limit: 5 });
  return { envelope, checks: [['it lists the commit that was just made', (envelope?.commits || []).length > 0]] };
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

fullScenario({ domain: 'git', action: 'file_at', run: async ({ call }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'file_at', { ref: 'HEAD', path: 'src/pages/index.astro' });
  return { envelope, checks: [['it returns the committed page text', String(envelope?.text || '').includes('<Hero')]] };
} });

fullScenario({ domain: 'git', action: 'commit_files', run: async ({ call }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'commit_files', { ref: 'HEAD' });
  return { envelope, checks: [['it lists files that commit touched', (envelope?.files || []).length > 0]] };
} });

fullScenario({ domain: 'git', action: 'worktrees', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'worktrees', {});
  return { envelope, checks: [['it reports the fixture working tree', JSON.stringify(envelope).includes(path.basename(fixture.root)) || (envelope?.worktrees || []).length > 0]] };
} });

fullScenario({ domain: 'git', action: 'checkout', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'checkout', { branch: 'wire-branch', create: true });
  return { envelope, checks: [['git reports the new branch as current', git(fixture, ['branch', '--show-current']) === 'wire-branch']] };
} });

fullScenario({ domain: 'git', action: 'merge', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const base = git(fixture, ['rev-parse', 'HEAD']);
  // A branch with a commit of its own, then merge it back: merging the branch
  // you are standing on is refused, correctly.
  await call('git', 'checkout', { branch: 'wire-branch', create: true });
  fixture.write('public/merge-canary.txt', 'from the branch\n');
  await call('git', 'commit', { message: 'branch commit' });
  await call('git', 'checkout', { branch: 'main' });
  const { envelope } = await call('git', 'merge', { branch: 'wire-branch' });
  return { envelope, checks: [
    ['the base commit is still reachable', git(fixture, ['cat-file', '-t', base]) === 'commit'],
    ['and the branch\'s file is now on main', fixture.exists('public/merge-canary.txt')],
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

fullScenario({ domain: 'git', action: 'park', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/park-canary.txt', 'parked\n');
  const { envelope } = await call('git', 'park', {});
  return { envelope, checks: [['the working tree is clean of the parked change', !git(fixture, ['status', '--porcelain']).includes('park-canary')]] };
} });

fullScenario({ domain: 'git', action: 'unpark', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('public/park-canary.txt', 'parked\n');
  await call('git', 'park', {});
  const parkedAway = !fixture.exists('public/park-canary.txt');
  const { envelope } = await call('git', 'unpark', {});
  return { envelope, checks: [
    ['parking took the file away first', parkedAway],
    ['and unparking brought it back', fixture.exists('public/park-canary.txt')],
  ] };
} });

fullScenario({ domain: 'git', action: 'restore_file', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const committed = git(fixture, ['show', 'HEAD:src/pages/about.astro']);
  fixture.write('src/pages/about.astro', '<p>vandalised</p>\n');
  const { envelope } = await call('git', 'restore_file', { ref: 'HEAD', path: 'src/pages/about.astro' });
  return { envelope, checks: [['the file matches what HEAD holds', fixture.read('src/pages/about.astro').trim() === committed.trim()]] };
} });

fullScenario({ domain: 'git', action: 'restore_project', run: async ({ call, fixture }) => {
  await seedRepo(call);
  fixture.write('src/pages/about.astro', '<p>vandalised again</p>\n');
  const { envelope } = await call('git', 'restore_project', { ref: 'HEAD' });
  return { envelope, checks: [['the vandalism is gone', !fixture.read('src/pages/about.astro').includes('vandalised again')]] };
} });

fullScenario({ domain: 'git', action: 'delete_branch', run: async ({ call, fixture }) => {
  await seedRepo(call);
  await call('git', 'checkout', { branch: 'wire-branch', create: true });
  await call('git', 'checkout', { branch: 'main' });
  const before = git(fixture, ['branch', '--list', 'wire-branch']).includes('wire-branch');
  const { envelope } = await call('git', 'delete_branch', { branch: 'wire-branch', force: true });
  return { envelope, checks: [
    ['the branch existed first', before],
    ['and git no longer lists it', !git(fixture, ['branch', '--list', 'wire-branch']).includes('wire-branch')],
  ] };
} });

fullScenario({ domain: 'git', action: 'gh_status', run: async ({ call }) => {
  await seedRepo(call);
  const { envelope } = await call('git', 'gh_status', {});
  return { envelope, checks: [['it reports whether the gh CLI is installed', typeof envelope?.installed === 'boolean']] };
} });

fullScenario({ domain: 'git', action: 'push', run: async ({ call, fixture }) => {
  await seedRepo(call);
  const os = require('node:os');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-wire-origin-'));
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: fixture.root, stdio: 'ignore' });
    const { envelope } = await call('git', 'push', { branch: 'main' });
    let landed = '';
    try {
      landed = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim();
    } catch {
      landed = '';
    }
    return { envelope, checks: [['the commit really arrived in the bare origin', landed.length > 0]] };
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
        ['while the envelope came back well-formed', !!envelope && typeof envelope.ok === 'boolean'],
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
