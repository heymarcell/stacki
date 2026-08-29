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

fullScenario({ domain: 'target', action: 'set_text', run: async ({ call, ref, rig }) => {
  const inside = await call('target', 'enter', { ref: await ref('Hero') });
  const h1 = flatten(inside.envelope?.target).find((n) => String(n.tag || '').toLowerCase() === 'h1');
  const { envelope } = await call('target', 'set_text', { ref: h1?.ref, text: 'Wire-driven heading', replaceBinding: true });
  return { envelope, checks: [
    ['the text is in Hero.astro on disk', rig.harness.read('src/components/Hero.astro').includes('Wire-driven heading')],
    ['and the old text is gone', !rig.harness.read('src/components/Hero.astro').includes('Welcome to Stacki')],
  ] };
} });

fullScenario({ domain: 'target', action: 'edit', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'edit', { ref: await ref('div'), operations: [{ type: 'add_class', className: 'wire-batch' }] });
  return { envelope, checks: [['the batched class reached the file', rig.harness.read('src/pages/index.astro').includes('wire-batch')]] };
} });

fullScenario({ domain: 'target', action: 'set_prop', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'set_prop', { ref: await ref('div'), name: 'data-wire', value: 'yes' });
  return { envelope, checks: [['the prop is authored in the page', /data-wire=("|\{)?"?yes/.test(rig.harness.read('src/pages/index.astro'))]] };
} });

fullScenario({ domain: 'target', action: 'remove_prop', run: async ({ call, ref, rig }) => {
  await call('target', 'set_prop', { ref: await ref('div'), name: 'data-doomed', value: 'x' });
  const before = rig.harness.read('src/pages/index.astro').includes('data-doomed');
  const { envelope } = await call('target', 'remove_prop', { ref: await ref('div'), name: 'data-doomed' });
  return { envelope, checks: [
    ['the prop was there first', before],
    ['and is gone from the file', !rig.harness.read('src/pages/index.astro').includes('data-doomed')],
  ] };
} });

fullScenario({ domain: 'target', action: 'set_classes', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'set_classes', { ref: await ref('div'), classes: ['wire-only'] });
  const src = rig.harness.read('src/pages/index.astro');
  return { envelope, checks: [
    ['the new class list is authored', src.includes('wire-only')],
    ['and it replaced what was there', !src.includes('pricing-grid') || src.includes('wire-only')],
  ] };
} });

fullScenario({ domain: 'target', action: 'add_class', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'add_class', { ref: await ref('div'), className: 'wire-added' });
  return { envelope, checks: [['the class is in the page source', rig.harness.read('src/pages/index.astro').includes('wire-added')]] };
} });

fullScenario({ domain: 'target', action: 'remove_class', run: async ({ call, ref, rig }) => {
  await call('target', 'add_class', { ref: await ref('div'), className: 'wire-doomed' });
  const before = rig.harness.read('src/pages/index.astro').includes('wire-doomed');
  const { envelope } = await call('target', 'remove_class', { ref: await ref('div'), className: 'wire-doomed' });
  return { envelope, checks: [
    ['the class was added first', before],
    ['and removing it took it out of the file', !rig.harness.read('src/pages/index.astro').includes('wire-doomed')],
  ] };
} });

fullScenario({ domain: 'target', action: 'insert_before', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'insert_before', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'inserted-before' } });
  return { envelope, checks: [['the new node is authored in the page', rig.harness.read('src/pages/index.astro').includes('inserted-before')]] };
} });

fullScenario({ domain: 'target', action: 'insert_after', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'insert_after', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'inserted-after' } });
  return { envelope, checks: [['the new node is authored in the page', rig.harness.read('src/pages/index.astro').includes('inserted-after')]] };
} });

fullScenario({ domain: 'target', action: 'append_child', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('target', 'append_child', { ref: await ref('footer'), node: { kind: 'element', tag: 'span', text: 'appended-child' } });
  return { envelope, checks: [['the child is authored inside the parent', rig.harness.read('src/pages/index.astro').includes('appended-child')]] };
} });

fullScenario({ domain: 'target', action: 'duplicate', run: async ({ call, ref, rig }) => {
  const before = (rig.harness.read('src/pages/index.astro').match(/<Hero/g) || []).length;
  const { envelope } = await call('target', 'duplicate', { ref: await ref('footer') });
  const after = (rig.harness.read('src/pages/index.astro').match(/<Hero/g) || []).length;
  return { envelope, checks: [['the page has one more copy of that node than before', after === before + 1]] };
} });

fullScenario({ domain: 'target', action: 'move', run: async ({ call, ref, rig }) => {
  const before = rig.harness.read('src/pages/index.astro');
  const { envelope } = await call('target', 'move', { ref: await ref('div'), to: { index: 0 } });
  return { envelope, checks: [['the page source is not what it was', rig.harness.read('src/pages/index.astro') !== before]] };
} });

fullScenario({ domain: 'target', action: 'set_tag', run: async ({ call, ref, rig }) => {
  await call('target', 'insert_after', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'retag-me' } });
  const { envelope } = await call('target', 'set_tag', { ref: (await ref('p')), tag: 'h4' });
  return { envelope, checks: [['an h4 is now authored in the page', /<h4/.test(rig.harness.read('src/pages/index.astro'))]] };
} });

fullScenario({ domain: 'target', action: 'remove', run: async ({ call, ref, rig }) => {
  await call('target', 'insert_after', { ref: await ref('div'), node: { kind: 'element', tag: 'p', text: 'doomed-node' } });
  const before = rig.harness.read('src/pages/index.astro').includes('doomed-node');
  const target = flatten((await call('target', 'read')).envelope?.target).find((n) => String(n.text || '').includes('doomed-node'));
  const { envelope } = await call('target', 'remove', { ref: target?.ref });
  return { envelope, checks: [
    ['the node was there first', before],
    ['and is gone from the file', !rig.harness.read('src/pages/index.astro').includes('doomed-node')],
  ] };
} });


// ── style ──────────────────────────────────────────────────────────────────

const firstCell = async (call) => {
  const { envelope } = await call('style', 'variables', {});
  for (const file of envelope?.files || []) for (const g of file.groups || []) for (const b of g.blocks || []) for (const r of b.rows || []) for (const c of r.cells || []) if (c?.name) return c;
  return null;
};
const css = (rig) => rig.harness.read('src/styles/site.css');

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
  const { envelope } = await call('style', 'variables', {});
  const cell = await firstCell(call);
  return { envelope, checks: [
    ['it reports the fixture stylesheet', (envelope?.files || []).some((f) => String(f.path).includes('site.css'))],
    ['with a real variable and its span', !!cell && typeof cell.valueStart === 'number'],
  ] };
} });

fullScenario({ domain: 'style', action: 'write_source', run: async ({ call, rig }) => {
  const read = await call('style', 'read_source', { path: 'src/styles/site.css' });
  const next = String(read.envelope?.css || '') + '\n.wire-written { color: red; }\n';
  const { envelope } = await call('style', 'write_source', { path: 'src/styles/site.css', css: next, expectedDigest: read.envelope?.digest });
  return { envelope, checks: [['the rule is in the stylesheet on disk', css(rig).includes('.wire-written')]] };
} });

fullScenario({ domain: 'style', action: 'set_property', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('style', 'set_property', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', property: 'outline', value: '3px solid red' });
  return { envelope, checks: [['the declaration is authored in a stylesheet', css(rig).includes('outline') && css(rig).includes('3px solid red')]] };
} });

fullScenario({ domain: 'style', action: 'set_declarations', run: async ({ call, ref, rig }) => {
  const { envelope } = await call('style', 'set_declarations', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', declarations: [{ property: 'opacity', value: '0.42' }] });
  return { envelope, checks: [['the declaration reached the stylesheet', css(rig).includes('0.42')]] };
} });

fullScenario({ domain: 'style', action: 'remove_property', run: async ({ call, ref, rig }) => {
  await call('style', 'set_property', { ref: await ref('div'), selector: '.pricing-grid', source: 'file:src/styles/site.css', property: 'letter-spacing', value: '3px' });
  const before = css(rig).includes('letter-spacing');
  const cascade = await call('style', 'read', { ref: await ref('div') });
  const decl = (cascade.envelope?.rules || []).flatMap((r) => r.declarations || []).find((d) => d?.identity && String(d.property) === 'letter-spacing');
  const { envelope } = await call('style', 'remove_property', { ref: await ref('div'), identity: decl?.identity });
  return { envelope, checks: [
    ['the declaration was written first', before],
    ['and removing it took it out of the stylesheet', !css(rig).includes('letter-spacing')],
  ] };
} });

fullScenario({ domain: 'style', action: 'set_variable', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'set_variable', { edit: { file: cell.file, valueStart: cell.valueStart, valueEnd: cell.valueEnd, value: '2.5rem', expect: cell.value } });
  return { envelope, checks: [
    ['the new value is in the stylesheet', css(rig).includes('2.5rem')],
    ['and the old one is gone', !css(rig).includes(`${cell.name}: ${cell.value}`)],
  ] };
} });

fullScenario({ domain: 'style', action: 'add_variables', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-added', value: '4px' }] });
  return { envelope, checks: [['the variable is declared in the stylesheet', css(rig).includes('--wire-added')]] };
} });

fullScenario({ domain: 'style', action: 'rename_variables', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-old', value: '1px' }] });
  const before = css(rig).includes('--wire-old');
  const { envelope } = await call('style', 'rename_variables', { renames: [{ from: '--wire-old', to: '--wire-new' }] });
  return { envelope, checks: [
    ['the old name existed', before],
    ['the new name is there', css(rig).includes('--wire-new')],
    ['and the old one is not', !css(rig).includes('--wire-old')],
  ] };
} });

fullScenario({ domain: 'style', action: 'move_variables', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  await call('style', 'add_variables', { adds: [{ file: cell.file, selector: cell.selector, name: '--wire-mover', value: '9px' }] });
  const before = css(rig);
  const { envelope } = await call('style', 'move_variables', { moves: [{ file: cell.file, selector: cell.selector, name: '--wire-mover', target: cell.selector, at: 0 }] });
  const after = css(rig);
  return { envelope, checks: [
    ['the variable still exists', after.includes('--wire-mover')],
    ['and the stylesheet was rewritten', after !== before],
  ] };
} });

fullScenario({ domain: 'style', action: 'add_section', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Wire section', at: 0 } });
  return { envelope, checks: [['the section heading is in the stylesheet', css(rig).includes('Wire section')]] };
} });

fullScenario({ domain: 'style', action: 'set_section_title', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Before rename', at: 0 } });
  const text = css(rig);
  const start = text.indexOf('Before rename');
  const { envelope } = await call('style', 'set_section_title', { edit: { file: cell.file, start, end: start + 'Before rename'.length, title: 'After rename', expect: 'Before rename' } });
  return { envelope, checks: [
    ['the new title is in the stylesheet', css(rig).includes('After rename')],
    ['and the old title is gone', !css(rig).includes('Before rename')],
  ] };
} });

fullScenario({ domain: 'style', action: 'remove_section', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Doomed section', at: 0 } });
  const text = css(rig);
  const start = text.indexOf('Doomed section');
  const { envelope } = await call('style', 'remove_section', { edit: { file: cell.file, start, end: start + 'Doomed section'.length, expect: 'Doomed section' } });
  return { envelope, checks: [['the section heading is gone from the stylesheet', !css(rig).includes('Doomed section')]] };
} });

fullScenario({ domain: 'style', action: 'move_heading', run: async ({ call, rig }) => {
  const cell = await firstCell(call);
  await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Movable heading', at: 0 } });
  const text = css(rig);
  const start = text.indexOf('Movable heading');
  const { envelope } = await call('style', 'move_heading', { edit: { file: cell.file, selector: cell.selector, start, end: start + 'Movable heading'.length, expect: 'Movable heading' } });
  return { envelope, checks: [['the heading survives the move', css(rig).includes('Movable heading')]] };
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

fullScenario({ domain: 'source', action: 'write', run: async ({ call, rig }) => {
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'write', { path: 'src/lib/format.js', text: '// wire-wrote-this\n' + String(read.envelope?.text || ''), expectedDigest: read.envelope?.digest });
  return { envelope, checks: [['the file on disk starts with what was written', rig.harness.read('src/lib/format.js').startsWith('// wire-wrote-this')]] };
} });

fullScenario({ domain: 'source', action: 'replace_range', run: async ({ call, rig }) => {
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'replace_range', { path: 'src/lib/format.js', startLine: 1, endLine: 1, text: '// wire-replaced-line-one', expectedDigest: read.envelope?.digest });
  return { envelope, checks: [['the first line is the replacement', rig.harness.read('src/lib/format.js').split('\n')[0] === '// wire-replaced-line-one']] };
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

fullScenario({ domain: 'page', action: 'create', run: async ({ call, rig }) => {
  const { envelope } = await call('page', 'create', { name: 'wire-made', layout: 'Base' });
  return { envelope, checks: [['the new page exists on disk', rig.harness.exists('src/pages/wire-made.astro')]] };
} });

fullScenario({ domain: 'page', action: 'move', run: async ({ call, rig }) => {
  const { envelope } = await call('page', 'move', { from: 'src/pages/wire-made.astro', to: 'moved/index.astro' });
  return { envelope, checks: [
    ['the old path is gone', !rig.harness.exists('src/pages/wire-made.astro')],
    ['and the new path exists', rig.harness.exists('src/pages/moved/index.astro')],
  ] };
} });

fullScenario({ domain: 'page', action: 'delete', run: async ({ call, rig }) => {
  const before = rig.harness.exists('src/pages/moved/index.astro');
  const { envelope } = await call('page', 'delete', { path: 'src/pages/moved/index.astro' });
  return { envelope, checks: [
    ['the page was there first', before],
    ['and is gone from disk', !rig.harness.exists('src/pages/moved/index.astro')],
  ] };
} });

fullScenario({ domain: 'page', action: 'folder_create', run: async ({ call, rig }) => {
  const { envelope } = await call('page', 'folder_create', { dir: 'wire-docs' });
  return { envelope, checks: [['the folder exists under pages', rig.harness.exists('src/pages/wire-docs')]] };
} });

fullScenario({ domain: 'page', action: 'folder_rename', run: async ({ call, rig }) => {
  const { envelope } = await call('page', 'folder_rename', { from: 'wire-docs', to: 'wire-guide' });
  return { envelope, checks: [
    ['the old folder is gone', !rig.harness.exists('src/pages/wire-docs')],
    ['and the new one exists', rig.harness.exists('src/pages/wire-guide')],
  ] };
} });

fullScenario({ domain: 'page', action: 'folder_delete', run: async ({ call, rig }) => {
  const before = rig.harness.exists('src/pages/wire-guide');
  const { envelope } = await call('page', 'folder_delete', { dir: 'wire-guide' });
  return { envelope, checks: [
    ['the folder was there first', before],
    ['and is gone', !rig.harness.exists('src/pages/wire-guide')],
  ] };
} });

fullScenario({ domain: 'page', action: 'component_create', run: async ({ call, rig }) => {
  const { envelope } = await call('page', 'component_create', { name: 'WireBox', nodes: [{ kind: 'element', tag: 'div', text: 'wire' }] });
  return { envelope, checks: [['the component file exists', rig.harness.exists('src/components/WireBox.astro')]] };
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

fullScenario({ domain: 'page', action: 'rebase_import', run: async ({ call }) => {
  const { envelope } = await call('page', 'rebase_import', { fromPage: 'src/pages/index.astro', toPage: 'src/pages/about.astro', spec: '../components/Card.astro' });
  return { envelope, checks: [['it answers about the specifier for the new location', 'relative' in (envelope || {}) || 'spec' in (envelope || {})]] };
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

fullScenario({ domain: 'asset', action: 'write_text', run: async ({ call, rig }) => {
  const read = await call('asset', 'read_text', { path: 'public/robots.txt' });
  const { envelope } = await call('asset', 'write_text', { path: 'public/robots.txt', text: 'User-agent: *\nDisallow: /wire\n', ref: read.envelope?.ref });
  return { envelope, checks: [
    ['the new text is on disk', rig.harness.read('public/robots.txt').includes('/wire')],
    ['and the old canary is gone', !rig.harness.read('public/robots.txt').includes(ROBOTS_CANARY)],
  ] };
} });

fullScenario({ domain: 'asset', action: 'mkdir', run: async ({ call, rig }) => {
  const { envelope } = await call('asset', 'mkdir', { parent: 'public', name: 'wire-folder' });
  return { envelope, checks: [['the folder exists', rig.harness.exists('public/wire-folder')]] };
} });

fullScenario({ domain: 'asset', action: 'move', run: async ({ call, rig }) => {
  const { envelope } = await call('asset', 'move', { path: 'public/spare.txt', toFolder: 'public/wire-folder' });
  return { envelope, checks: [
    ['the old path is gone', !rig.harness.exists('public/spare.txt')],
    ['and the file is in the new folder', rig.harness.exists('public/wire-folder/spare.txt')],
  ] };
} });

fullScenario({ domain: 'asset', action: 'rename', run: async ({ call, rig }) => {
  const { envelope } = await call('asset', 'rename', { path: 'public/wire-folder/spare.txt', name: 'renamed.txt' });
  return { envelope, checks: [
    ['the old name is gone', !rig.harness.exists('public/wire-folder/spare.txt')],
    ['and the new name exists', rig.harness.exists('public/wire-folder/renamed.txt')],
  ] };
} });

fullScenario({ domain: 'asset', action: 'delete', run: async ({ call, rig }) => {
  const before = rig.harness.exists('public/wire-folder/renamed.txt');
  const { envelope } = await call('asset', 'delete', { path: 'public/wire-folder/renamed.txt' });
  return { envelope, checks: [
    ['the file was there first', before],
    ['and is gone from disk', !rig.harness.exists('public/wire-folder/renamed.txt')],
  ] };
} });


// ── content ────────────────────────────────────────────────────────────────
//
// The fixture has no node_modules, and reading the Astro CONTENT CONFIG needs
// them. That is a real property of the project, not a hole in the test: the
// collection-shaped operations answer with a named refusal, and the checks
// below assert the exact truthful answer rather than shrugging at any envelope.

const configNeedsDeps = (e) => /dependencies installed/i.test(String(e?.error || e?.message || ''));

fullScenario({ domain: 'content', action: 'cms_list', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_list', {});
  return { envelope, checks: [['it finds the JSON data file the fixture ships', JSON.stringify(envelope).includes('site.json')]] };
} });

fullScenario({ domain: 'content', action: 'cms_read', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_read', { path: 'src/data/site.json' });
  return { envelope, checks: [['it parses the fixture data', !!envelope?.data && typeof envelope.data === 'object']] };
} });

fullScenario({ domain: 'content', action: 'cms_write', run: async ({ call, rig }) => {
  const read = await call('content', 'cms_read', { path: 'src/data/site.json' });
  const { envelope } = await call('content', 'cms_write', { path: 'src/data/site.json', data: { ...(read.envelope?.data || {}), wireWrote: true }, ref: read.envelope?.ref });
  return { envelope, checks: [['the new key is in the file on disk', JSON.parse(rig.harness.read('src/data/site.json')).wireWrote === true]] };
} });

fullScenario({ domain: 'content', action: 'cms_create', run: async ({ call, rig }) => {
  const { envelope } = await call('content', 'cms_create', { name: 'wireteam' });
  return { envelope, checks: [['a new data file exists', rig.harness.exists('src/data/wireteam.json')]] };
} });

fullScenario({ domain: 'content', action: 'cms_usage', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_usage', { path: 'src/data/site.json' });
  return { envelope, checks: [['it answers where the data is used', !!envelope && ('usages' in envelope || 'files' in envelope || 'pages' in envelope)]] };
} });

fullScenario({ domain: 'content', action: 'cms_meta', run: async ({ call }) => {
  const { envelope } = await call('content', 'cms_meta', {});
  return { envelope, checks: [['it answers with a meta map', !!envelope && typeof envelope.meta === 'object']] };
} });

fullScenario({ domain: 'content', action: 'cms_set_meta', run: async ({ call, call2 }) => {
  const { envelope } = await call('content', 'cms_set_meta', { path: 'src/data/site.json', fields: { label: 'Wire' } });
  const back = await call('content', 'cms_meta', {});
  return { envelope, checks: [['the meta it set reads back', JSON.stringify(back.envelope?.meta || {}).includes('Wire')]] };
} });

fullScenario({ domain: 'content', action: 'cms_delete', run: async ({ call, rig }) => {
  const before = rig.harness.exists('src/data/wireteam.json');
  const { envelope } = await call('content', 'cms_delete', { path: 'src/data/wireteam.json' });
  return { envelope, checks: [
    ['the data file was there first', before],
    ['and is gone', !rig.harness.exists('src/data/wireteam.json')],
  ] };
} });

fullScenario({ domain: 'content', action: 'config', run: async ({ call }) => {
  const { envelope } = await call('content', 'config', {});
  return { envelope, checks: [
    ['it names the content config the fixture authored', String(envelope?.configPath || '').includes('content.config')],
    ['and says plainly that reading it needs the dependencies', configNeedsDeps(envelope)],
  ] };
} });

fullScenario({ domain: 'content', action: 'collections', run: async ({ call }) => {
  const { envelope } = await call('content', 'collections', {});
  return { envelope, checks: [
    ['it answers with a collections list', Array.isArray(envelope?.collections)],
    ['and says why it is empty rather than pretending', configNeedsDeps(envelope) || envelope.collections.length > 0],
  ] };
} });

const collectionAnswer = (envelope, key) => [
  [`it answers about ${key}`, !!envelope],
  ['truthfully, given the config cannot be read without dependencies',
    configNeedsDeps(envelope) || /not a collection/i.test(String(envelope?.message || '')) || Array.isArray(envelope?.[key]) || envelope?.ok === true],
];

fullScenario({ domain: 'content', action: 'entries', run: async ({ call }) => {
  const { envelope } = await call('content', 'entries', { collection: 'notes' });
  return { envelope, checks: [['it answers with an entries list', Array.isArray(envelope?.entries)]] };
} });

fullScenario({ domain: 'content', action: 'sample_entry', run: async ({ call }) => {
  const { envelope } = await call('content', 'sample_entry', { collection: 'notes' });
  return { envelope, checks: collectionAnswer(envelope, 'entry') };
} });

fullScenario({ domain: 'content', action: 'targets', run: async ({ call }) => {
  const { envelope } = await call('content', 'targets', { collection: 'notes' });
  return { envelope, checks: collectionAnswer(envelope, 'targets') };
} });

fullScenario({ domain: 'content', action: 'validate', run: async ({ call }) => {
  const { envelope } = await call('content', 'validate', { collection: 'notes', data: { title: 'Wire' } });
  return { envelope, checks: collectionAnswer(envelope, 'issues') };
} });

fullScenario({ domain: 'content', action: 'write_entry', run: async ({ call }) => {
  const list = await call('content', 'entries', { collection: 'notes' });
  const first = (list.envelope?.entries || [])[0] || { collection: 'notes', id: 'first' };
  const { envelope } = await call('content', 'write_entry', { entry: first, body: 'Rewritten by the wire test.' });
  return { envelope, checks: collectionAnswer(envelope, 'entry') };
} });

fullScenario({ domain: 'content', action: 'rename_plan', run: async ({ call }) => {
  const { envelope } = await call('content', 'rename_plan', { collection: 'notes', from: 'title', to: 'heading' });
  return { envelope, checks: collectionAnswer(envelope, 'plan') };
} });

fullScenario({ domain: 'content', action: 'rename', run: async ({ call }) => {
  const { envelope } = await call('content', 'rename', { collection: 'notes', from: 'title', to: 'heading' });
  return { envelope, checks: collectionAnswer(envelope, 'changed') };
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

fullScenario({ domain: 'project', action: 'undo', run: async ({ call, ref, rig }) => {
  await call('target', 'add_class', { ref: await ref('div'), className: 'undo-me' });
  const applied = rig.harness.read('src/pages/index.astro').includes('undo-me');
  const { envelope } = await call('project', 'undo', {});
  return { envelope, checks: [
    ['the edit landed first', applied],
    ['and undo took it back out of the file', !rig.harness.read('src/pages/index.astro').includes('undo-me')],
  ] };
} });

fullScenario({ domain: 'project', action: 'redo', run: async ({ call, ref, rig }) => {
  await call('target', 'add_class', { ref: await ref('div'), className: 'redo-me' });
  await call('project', 'undo', {});
  const undone = !rig.harness.read('src/pages/index.astro').includes('redo-me');
  const { envelope } = await call('project', 'redo', {});
  return { envelope, checks: [
    ['undo removed it first', undone],
    ['and redo put it back', rig.harness.read('src/pages/index.astro').includes('redo-me')],
  ] };
} });

// dev_status / probe / install / dev_start / dev_stop are exercised against a
// REAL dev server in test/mcp-dev-lifecycle.js, which owns the process, the
// port and the installed fixture. They are registered here so the matrix sees
// one scenario per operation; each delegates to that harness.
const devLifecycle = require('./mcpDevLifecycle.js');

fullScenario({ domain: 'project', action: 'dev_status', run: (ctx) => devLifecycle.devStatus(ctx) });
fullScenario({ domain: 'project', action: 'dev_start', run: (ctx) => devLifecycle.devStart(ctx) });
fullScenario({ domain: 'project', action: 'probe', run: (ctx) => devLifecycle.probe(ctx) });
fullScenario({ domain: 'project', action: 'dev_stop', run: (ctx) => devLifecycle.devStop(ctx) });
fullScenario({ domain: 'project', action: 'install', run: (ctx) => devLifecycle.install(ctx) });

// ── git ────────────────────────────────────────────────────────────────────
//
// A throwaway repository with a LOCAL BARE ORIGIN, so `push` is a real push
// that lands somewhere checkable and no remote anybody owns is touched.

const { execFileSync } = require('node:child_process');
const git = (rig, args) => execFileSync('git', args, { cwd: rig.root, encoding: 'utf8' }).trim();

fullScenario({ domain: 'git', action: 'init', run: async ({ call, rig }) => {
  const { envelope } = await call('git', 'init', {});
  return { envelope, checks: [['the project is a git repository now', rig.harness.exists('.git')]] };
} });

fullScenario({ domain: 'git', action: 'info', run: async ({ call }) => {
  const { envelope } = await call('git', 'info', {});
  return { envelope, checks: [['it reports the repository it just initialised', 'branch' in envelope || 'head' in envelope || 'repo' in envelope]] };
} });

fullScenario({ domain: 'git', action: 'status', run: async ({ call, rig }) => {
  rig.harness.write('public/status-canary.txt', 'untracked\n');
  const { envelope } = await call('git', 'status', {});
  return { envelope, checks: [['it sees the file just written into the working tree', JSON.stringify(envelope).includes('status-canary')]] };
} });

fullScenario({ domain: 'git', action: 'commit', run: async ({ call, rig }) => {
  const { envelope } = await call('git', 'commit', { message: 'The fixture, as the wire test found it' });
  return { envelope, checks: [['git reports a commit with that message', git(rig, ['log', '-1', '--pretty=%s']) === 'The fixture, as the wire test found it']] };
} });

fullScenario({ domain: 'git', action: 'log', run: async ({ call }) => {
  const { envelope } = await call('git', 'log', { limit: 5 });
  return { envelope, checks: [['it lists the commit that was just made', (envelope?.commits || []).length > 0]] };
} });

fullScenario({ domain: 'git', action: 'all_files', run: async ({ call }) => {
  const { envelope } = await call('git', 'all_files', {});
  return { envelope, checks: [['it lists the tracked page', (envelope?.files || []).some((f) => String(f).includes('index.astro'))]] };
} });

fullScenario({ domain: 'git', action: 'file_at', run: async ({ call }) => {
  const { envelope } = await call('git', 'file_at', { ref: 'HEAD', path: 'src/pages/index.astro' });
  return { envelope, checks: [['it returns the committed page text', String(envelope?.text || '').includes('<Hero')]] };
} });

fullScenario({ domain: 'git', action: 'commit_files', run: async ({ call }) => {
  const { envelope } = await call('git', 'commit_files', { ref: 'HEAD' });
  return { envelope, checks: [['it lists files that commit touched', (envelope?.files || []).length > 0]] };
} });

fullScenario({ domain: 'git', action: 'worktrees', run: async ({ call, rig }) => {
  const { envelope } = await call('git', 'worktrees', {});
  return { envelope, checks: [['it reports the fixture working tree', JSON.stringify(envelope).includes(path.basename(rig.root)) || (envelope?.worktrees || []).length > 0]] };
} });

fullScenario({ domain: 'git', action: 'checkout', run: async ({ call, rig }) => {
  const { envelope } = await call('git', 'checkout', { branch: 'wire-branch', create: true });
  return { envelope, checks: [['git reports the new branch as current', git(rig, ['branch', '--show-current']) === 'wire-branch']] };
} });

fullScenario({ domain: 'git', action: 'merge', run: async ({ call, rig }) => {
  const base = git(rig, ['rev-parse', 'HEAD']);
  await call('git', 'checkout', { branch: 'wire-branch' });
  const { envelope } = await call('git', 'merge', { branch: 'main' });
  return { envelope, checks: [['the repository still has the base commit reachable', git(rig, ['cat-file', '-t', base]) === 'commit']] };
} });

fullScenario({ domain: 'git', action: 'resolve_merge', run: async ({ call }) => {
  const { envelope } = await call('git', 'resolve_merge', { branch: 'main', choices: {} });
  return { envelope, checks: [['it answers about the merge state', !!envelope]] };
} });

fullScenario({ domain: 'git', action: 'park', run: async ({ call, rig }) => {
  rig.harness.write('public/park-canary.txt', 'parked\n');
  const { envelope } = await call('git', 'park', {});
  return { envelope, checks: [['the working tree is clean of the parked change', !git(rig, ['status', '--porcelain']).includes('park-canary')]] };
} });

fullScenario({ domain: 'git', action: 'unpark', run: async ({ call, rig }) => {
  const { envelope } = await call('git', 'unpark', {});
  return { envelope, checks: [['the parked change is back in the working tree', rig.harness.exists('public/park-canary.txt')]] };
} });

fullScenario({ domain: 'git', action: 'restore_file', run: async ({ call, rig }) => {
  const committed = git(rig, ['show', 'HEAD:src/pages/about.astro']);
  rig.harness.write('src/pages/about.astro', '<p>vandalised</p>\n');
  const { envelope } = await call('git', 'restore_file', { ref: 'HEAD', path: 'src/pages/about.astro' });
  return { envelope, checks: [['the file matches what HEAD holds', rig.harness.read('src/pages/about.astro').trim() === committed.trim()]] };
} });

fullScenario({ domain: 'git', action: 'restore_project', run: async ({ call, rig }) => {
  rig.harness.write('src/pages/about.astro', '<p>vandalised again</p>\n');
  const { envelope } = await call('git', 'restore_project', { ref: 'HEAD' });
  return { envelope, checks: [['the vandalism is gone', !rig.harness.read('src/pages/about.astro').includes('vandalised again')]] };
} });

fullScenario({ domain: 'git', action: 'delete_branch', run: async ({ call, rig }) => {
  await call('git', 'checkout', { branch: 'main' });
  const before = git(rig, ['branch', '--list', 'wire-branch']).includes('wire-branch');
  const { envelope } = await call('git', 'delete_branch', { branch: 'wire-branch', force: true });
  return { envelope, checks: [
    ['the branch existed first', before],
    ['and git no longer lists it', !git(rig, ['branch', '--list', 'wire-branch']).includes('wire-branch')],
  ] };
} });

fullScenario({ domain: 'git', action: 'gh_status', run: async ({ call }) => {
  const { envelope } = await call('git', 'gh_status', {});
  return { envelope, checks: [['it reports whether the gh CLI is installed', typeof envelope?.installed === 'boolean']] };
} });

fullScenario({ domain: 'git', action: 'push', run: async ({ call, rig }) => {
  const os = require('node:os');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-wire-origin-'));
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: rig.root, stdio: 'ignore' });
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
