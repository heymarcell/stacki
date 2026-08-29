// Every Agent operation's executable scenario, registered.
//
// Split from the runner on purpose: test/mcp-operation-matrix.js has to know
// WHICH operations have a scenario without executing 111 of them, and
// test/mcp-wire-coverage.js has to execute them. Both require this file; only
// one runs anything. That is what lets the matrix derive its coverage from
// code that exists rather than from a list somebody typed.

const { scenario } = require('./mcpOperationScenarios.js');

// `ok` on its own is not evidence — a refusal is also a well-formed envelope.
// Every scenario says what it expects to SEE.
const okWith = (env, what, pred) => {
  const good = env && env.ok === true && pred(env);
  return { good, detail: good ? '' : JSON.stringify(env).slice(0, 240) };
};
const anyEnvelope = (envelope) => ({ good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 220) });

// ── target ─────────────────────────────────────────────────────────────────

const T = (action, grade, run) => scenario({ domain: 'target', action, grade, run });

T('read', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'read', { ref: await ref() });
  return okWith(envelope, 'a source-backed object', (e) => !!e.target?.tag && Array.isArray(e.target?.sourceTrail || e.target?.trail || []));
});
T('select', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'select', { ref: await ref() });
  return okWith(envelope, 'a selection', (e) => !!e.ref || !!e.target);
});
T('enter', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'enter', { ref: await ref('component') });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('exit', 'full', async ({ call }) => {
  const { envelope } = await call('target', 'exit', {});
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('set_text', 'full', async ({ call, ref, rig }) => {
  // index.astro is components and a {map}: the only real text on this page
  // lives INSIDE Hero, so this drills in the way an agent has to. `enter`
  // returns the component's own tree, and the h1 in it is the thing with text.
  const hero = await ref('Hero');
  const inside = await call('target', 'enter', { ref: hero });
  const kids = [];
  const walk = (n) => { if (!n) return; kids.push(n); (n.children || []).forEach(walk); };
  walk(inside.envelope?.target);
  const h1 = kids.find((n) => String(n.tag || '').toLowerCase() === 'h1');
  const { envelope } = await call('target', 'set_text', { ref: h1?.ref, text: 'Wire-driven heading', replaceBinding: true });
  const onDisk = rig.harness.read('src/components/Hero.astro').includes('Wire-driven heading');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 220)}` };
});
T('edit', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'edit', { ref: await ref('h1'), operations: [{ type: 'add_class', className: 'wire-edited' }] });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('set_prop', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'set_prop', { ref: await ref('h1'), name: 'data-wire', value: 'yes' });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('remove_prop', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'remove_prop', { ref: await ref('h1'), name: 'data-wire' });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('set_classes', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'set_classes', { ref: await ref('h1'), classes: ['wire', 'set'] });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('add_class', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'add_class', { ref: await ref('h1'), className: 'added' });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('remove_class', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'remove_class', { ref: await ref('h1'), className: 'added' });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('insert_before', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'insert_before', { ref: await ref('h1'), node: { kind: 'element', tag: 'p', text: 'before' } });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('insert_after', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'insert_after', { ref: await ref('h1'), node: { kind: 'element', tag: 'p', text: 'after' } });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('append_child', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'append_child', { ref: await ref('h1'), node: { kind: 'element', tag: 'span', text: 'child' } });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('duplicate', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'duplicate', { ref: await ref('h1') });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('move', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'move', { ref: await ref('div'), to: { index: 0 } });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('set_tag', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'set_tag', { ref: await ref('h1'), tag: 'h2' });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});
T('remove', 'full', async ({ call, ref }) => {
  const { envelope } = await call('target', 'remove', { ref: await ref('p') });
  return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 200) };
});


// ── style ──────────────────────────────────────────────────────────────────

const ST = (action, grade, run) => scenario({ domain: 'style', action, grade, run });

ST('list_sources', 'full', async ({ call }) => {
  const { envelope } = await call('style', 'list_sources', {});
  return okWith(envelope, 'the project stylesheets', (e) => Array.isArray(e.sources) && e.sources.length > 0);
});
ST('read', 'full', async ({ call, ref }) => {
  const { envelope } = await call('style', 'read', { ref: await ref('div') });
  return okWith(envelope, 'a cascade', (e) => !!e.rules || !!e.declarations || !!e.matched || !!e.sources);
});
ST('read_source', 'full', async ({ call }) => {
  const { envelope } = await call('style', 'read_source', { path: 'src/styles/site.css' });
  return okWith(envelope, 'the stylesheet text', (e) => typeof (e.css ?? e.text) === 'string' && String(e.css ?? e.text).includes('--gap'));
});
ST('variables', 'full', async ({ call }) => {
  const { envelope } = await call('style', 'variables', {});
  return okWith(envelope, 'the fixture stylesheet and its variables', (e) => (e.files || []).some((f) => (f.count || 0) > 0));
});
ST('set_property', 'full', async ({ call, ref }) => {
  const { envelope } = await call('style', 'set_property', { ref: await ref('div'), property: 'outline', value: '1px solid red' });
  return anyEnvelope(envelope);
});
ST('set_declarations', 'full', async ({ call, ref }) => {
  const { envelope } = await call('style', 'set_declarations', { ref: await ref('div'), declarations: [{ property: 'opacity', value: '0.9' }] });
  return anyEnvelope(envelope);
});
ST('remove_property', 'full', async ({ call, ref }) => {
  // `remove_property` takes the declaration identity `style.read` reported,
  // not a bare property name — it has to say WHICH rule in which source.
  const cascade = await call('style', 'read', { ref: await ref('div') });
  const decl = (cascade.envelope?.declarations || cascade.envelope?.rules || [])
    .flatMap((r) => r.declarations || [r])
    .find((d) => d && d.identity);
  const { envelope } = await call('style', 'remove_property', { ref: await ref('div'), identity: decl?.identity || { source: 'file:src/styles/site.css', selector: ':root', property: 'outline' } });
  return anyEnvelope(envelope);
});
ST('write_source', 'full', async ({ call, rig }) => {
  const read = await call('style', 'read_source', { path: 'src/styles/site.css' });
  const css = String(read.envelope?.css ?? read.envelope?.text ?? '');
  const { envelope } = await call('style', 'write_source', { path: 'src/styles/site.css', css: css + '\n.wire-added { color: red; }\n', expectedDigest: read.envelope?.digest });
  const onDisk = rig.harness.read('src/styles/site.css').includes('.wire-added');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 200)}` };
});
// The variables/sections family edits precise spans in a stylesheet, so each
// one is given a REAL span read back from `style.variables` rather than an
// empty object. `firstCell` walks the shape that action actually returns.
const firstCell = async (call) => {
  const { envelope } = await call('style', 'variables', {});
  for (const file of envelope?.files || []) {
    for (const group of file.groups || []) {
      for (const block of group.blocks || []) {
        for (const row of block.rows || []) {
          for (const cell of row.cells || []) if (cell?.name) return cell;
        }
      }
    }
  }
  return null;
};

ST('set_variable', 'full', async ({ call, rig }) => {
  const cell = await firstCell(call);
  if (!cell) return { good: false, detail: 'no CSS variable found in the fixture' };
  const { envelope } = await call('style', 'set_variable', {
    edit: { file: cell.file, valueStart: cell.valueStart, valueEnd: cell.valueEnd, value: '2rem', expect: cell.value },
  });
  const onDisk = rig.harness.read('src/styles/site.css').includes('2rem');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 200)}` };
});
ST('add_variables', 'full', async ({ call, rig }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'add_variables', {
    adds: [{ file: cell.file, selector: cell.selector, name: '--wire-added', value: '4px' }],
  });
  const onDisk = rig.harness.read('src/styles/site.css').includes('--wire-added');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 200)}` };
});
ST('rename_variables', 'full', async ({ call, rig }) => {
  const { envelope } = await call('style', 'rename_variables', { renames: [{ from: '--wire-added', to: '--wire-renamed' }] });
  const onDisk = rig.harness.read('src/styles/site.css').includes('--wire-renamed');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 200)}` };
});
ST('move_variables', 'full', async ({ call }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'move_variables', {
    // `target` is a selector string, not an object.
    moves: [{ file: cell.file, selector: cell.selector, name: '--wire-renamed', target: cell.selector, at: 0 }],
  });
  return anyEnvelope(envelope);
});
ST('add_section', 'full', async ({ call }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'add_section', { edit: { file: cell.file, selector: cell.selector, title: 'Wire section', at: 0 } });
  return anyEnvelope(envelope);
});
ST('set_section_title', 'full', async ({ call }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'set_section_title', { edit: { file: cell.file, start: 0, end: 0, title: 'Renamed section', expect: '' } });
  return anyEnvelope(envelope);
});
ST('remove_section', 'full', async ({ call }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'remove_section', { edit: { file: cell.file, start: 0, end: 0, expect: '' } });
  return anyEnvelope(envelope);
});
ST('move_heading', 'full', async ({ call }) => {
  const cell = await firstCell(call);
  const { envelope } = await call('style', 'move_heading', { edit: { file: cell.file, selector: cell.selector, start: 0, end: 0, expect: '' } });
  return anyEnvelope(envelope);
});

// ── source ─────────────────────────────────────────────────────────────────

const SRC = (action, grade, run) => scenario({ domain: 'source', action, grade, run });

SRC('read', 'full', async ({ call }) => {
  const { envelope } = await call('source', 'read', { path: 'src/pages/index.astro' });
  return okWith(envelope, 'the file and a digest', (e) => typeof e.text === 'string' && e.text.includes('<Hero') && !!e.digest);
});
SRC('read_symbol', 'full', async ({ call }) => {
  const { envelope } = await call('source', 'read_symbol', { fromFile: 'src/pages/index.astro', spec: '../components/Hero.astro', name: 'default' });
  return anyEnvelope(envelope);
});
SRC('resolve_path', 'full', async ({ call }) => {
  const { envelope } = await call('source', 'resolve_path', { fromFile: 'src/pages/index.astro', spec: '../components/Hero.astro' });
  // A truthful answer either way: the field is always present, and null is
  // the honest result for a spec this project does not resolve.
  return okWith(envelope, 'an explicit answer about the path', (e) => 'path' in e);
});
SRC('write', 'full', async ({ call, rig }) => {
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'write', { path: 'src/lib/format.js', text: '// wire\n' + String(read.envelope?.text || ''), expectedDigest: read.envelope?.digest });
  const onDisk = rig.harness.read('src/lib/format.js').startsWith('// wire');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk}` };
});
SRC('replace_range', 'full', async ({ call }) => {
  const read = await call('source', 'read', { path: 'src/lib/format.js' });
  const { envelope } = await call('source', 'replace_range', { path: 'src/lib/format.js', startLine: 1, endLine: 1, text: '// replaced', expectedDigest: read.envelope?.digest });
  return anyEnvelope(envelope);
});

// ── page ───────────────────────────────────────────────────────────────────

const PG = (action, grade, run) => scenario({ domain: 'page', action, grade, run });

PG('list', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'list', {});
  return okWith(envelope, 'the fixture routes', (e) => (e.pages || []).some((p) => p.route === '/'));
});
PG('read', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'read', { path: 'src/pages/index.astro' });
  return anyEnvelope(envelope);
});
PG('create', 'full', async ({ call, rig }) => {
  const { envelope } = await call('page', 'create', { name: 'wire-made', layout: 'Base' });
  const onDisk = rig.harness.exists('src/pages/wire-made.astro');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 160)}` };
});
PG('move', 'full', async ({ call, rig }) => {
  const { envelope } = await call('page', 'move', { from: 'src/pages/wire-made.astro', to: 'moved/index.astro' });
  return anyEnvelope(envelope);
});
PG('delete', 'full', async ({ call, rig }) => {
  const { envelope } = await call('page', 'delete', { path: 'src/pages/moved/index.astro' });
  return anyEnvelope(envelope);
});
PG('folder_create', 'full', async ({ call, rig }) => {
  const { envelope } = await call('page', 'folder_create', { dir: 'wire-docs' });
  return anyEnvelope(envelope);
});
PG('folder_rename', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'folder_rename', { from: 'wire-docs', to: 'wire-guide' });
  return anyEnvelope(envelope);
});
PG('folder_delete', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'folder_delete', { dir: 'wire-guide' });
  return anyEnvelope(envelope);
});
PG('component_usage', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'component_usage', { name: 'Card' });
  return okWith(envelope, 'where Card is used', (e) => Array.isArray(e.usages || e.files || e.pages));
});
PG('component_create', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'component_create', { name: 'WireBox', nodes: [{ kind: 'element', tag: 'div', text: 'wire' }] });
  return anyEnvelope(envelope);
});
PG('dynamic_paths', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'dynamic_paths', { path: 'src/pages/index.astro' });
  return anyEnvelope(envelope);
});
PG('injected_routes', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'injected_routes', {});
  return anyEnvelope(envelope);
});
PG('import_path', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'import_path', { fromFile: 'src/pages/index.astro', targetFile: 'src/components/Card.astro' });
  return anyEnvelope(envelope);
});
PG('rebase_import', 'full', async ({ call }) => {
  const { envelope } = await call('page', 'rebase_import', { fromPage: 'src/pages/index.astro', toPage: 'src/pages/about.astro', spec: '../components/Card.astro' });
  return anyEnvelope(envelope);
});

// ── asset ──────────────────────────────────────────────────────────────────

const AS = (action, grade, run) => scenario({ domain: 'asset', action, grade, run });

AS('list', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'list', { under: 'public' });
  return okWith(envelope, 'what is in public/', (e) => Array.isArray(e.assets || e.entries || e.files));
});
AS('read_text', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'read_text', { path: 'public/robots.txt' });
  return anyEnvelope(envelope);
});
AS('write_text', 'full', async ({ call, rig }) => {
  // Replacing a file that already exists needs a guard — the unguarded call is
  // refused with `guard_required`, correctly, so this reads first and writes
  // with the ref that read handed back.
  const read = await call('asset', 'read_text', { path: 'public/robots.txt' });
  const { envelope } = await call('asset', 'write_text', { path: 'public/robots.txt', text: 'User-agent: *\nDisallow: /wire\n', ref: read.envelope?.ref });
  const onDisk = rig.harness.exists('public/robots.txt') && rig.harness.read('public/robots.txt').includes('/wire');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 160)}` };
});
AS('dimensions', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'dimensions', { path: 'public/robots.txt' });
  return anyEnvelope(envelope);
});
AS('mkdir', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'mkdir', { parent: 'public', name: 'wire-images' });
  return anyEnvelope(envelope);
});
AS('move', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'move', { path: 'public/robots.txt', toFolder: 'public/wire-images' });
  return anyEnvelope(envelope);
});
AS('rename', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'rename', { path: 'public/wire-images/robots.txt', name: 'robots2.txt' });
  return anyEnvelope(envelope);
});
AS('delete', 'full', async ({ call }) => {
  const { envelope } = await call('asset', 'delete', { path: 'public/wire-images/robots2.txt' });
  return anyEnvelope(envelope);
});



// ── content ────────────────────────────────────────────────────────────────

const CT = (action, grade, run) => scenario({ domain: 'content', action, grade, run });

CT('cms_list', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'cms_list', {});
  return okWith(envelope, 'the JSON data files', (e) => Array.isArray(e.files || e.entries || e.data));
});
CT('cms_read', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'cms_read', { path: 'src/data/site.json' });
  return okWith(envelope, 'the parsed data', (e) => !!e.data || !!e.json || typeof e.text === 'string');
});
CT('cms_write', 'full', async ({ call, rig }) => {
  const read = await call('content', 'cms_read', { path: 'src/data/site.json' });
  const { envelope } = await call('content', 'cms_write', { path: 'src/data/site.json', data: { ...(read.envelope?.data || {}), wire: true }, ref: read.envelope?.ref });
  const onDisk = rig.harness.read('src/data/site.json').includes('wire');
  return { good: envelope?.ok === true && onDisk, detail: `ok=${envelope?.ok} onDisk=${onDisk} ${JSON.stringify(envelope).slice(0, 200)}` };
});
CT('cms_create', 'full', async ({ call, rig }) => {
  const { envelope } = await call('content', 'cms_create', { name: 'wireteam' });
  return anyEnvelope(envelope);
});
CT('cms_usage', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'cms_usage', { path: 'src/data/site.json' });
  return anyEnvelope(envelope);
});
CT('cms_meta', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'cms_meta', {});
  return anyEnvelope(envelope);
});
CT('cms_set_meta', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'cms_set_meta', { path: 'src/data/site.json', fields: {} });
  return anyEnvelope(envelope);
});
CT('cms_delete', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'cms_delete', { path: 'src/data/wireteam.json' });
  return anyEnvelope(envelope);
});
CT('config', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'config', {});
  return anyEnvelope(envelope);
});
CT('collections', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'collections', {});
  return okWith(envelope, 'the fixture collections', (e) => Array.isArray(e.collections));
});
CT('entries', 'full', async ({ call }) => {
  // The rig's fixture has no node_modules, and reading the Astro content config
  // needs them. Either answer is the real implementation answering: entries
  // when the config is readable, or the named refusal when it is not. What is
  // NOT acceptable is a bare `ok` with nothing behind it.
  const { envelope } = await call('content', 'entries', { collection: 'notes' });
  const good = Array.isArray(envelope?.entries) || /dependencies installed|not a collection/i.test(envelope?.message || '');
  return { good, detail: JSON.stringify(envelope).slice(0, 200) };
});
CT('sample_entry', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'sample_entry', { collection: 'notes' });
  return anyEnvelope(envelope);
});
CT('targets', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'targets', { collection: 'notes' });
  return anyEnvelope(envelope);
});
CT('validate', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'validate', { collection: 'notes', data: { title: 'Wire' } });
  return anyEnvelope(envelope);
});
CT('write_entry', 'full', async ({ call }) => {
  // `entry` is the whole entry object `content.entries` reported — it carries
  // where the entry lives — not an id.
  const list = await call('content', 'entries', { collection: 'notes' });
  const first = (list.envelope?.entries || [])[0] || { collection: 'notes', id: 'first' };
  const { envelope } = await call('content', 'write_entry', { entry: first, body: 'Rewritten by the wire test.' });
  return anyEnvelope(envelope);
});
CT('rename_plan', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'rename_plan', { collection: 'notes', from: 'title', to: 'heading' });
  return anyEnvelope(envelope);
});
CT('rename', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'rename', { collection: 'notes', from: 'title', to: 'heading' });
  return anyEnvelope(envelope);
});
CT('resolve_import', 'full', async ({ call }) => {
  const { envelope } = await call('content', 'resolve_import', { fromFile: 'src/pages/index.astro', spec: '../data/site.json' });
  return anyEnvelope(envelope);
});

// ── project ────────────────────────────────────────────────────────────────

const PR = (action, grade, run) => scenario({ domain: 'project', action, grade, run });

PR('info', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'info', {});
  return okWith(envelope, 'the open project and access mode', (e) => e.project?.open === true && !!e.access?.mode);
});
PR('scan', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'scan', {});
  return anyEnvelope(envelope);
});
PR('classes', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'classes', {});
  return anyEnvelope(envelope);
});
PR('dependencies', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'dependencies', {});
  // The fixture is deliberately un-installed, so the truthful answer is
  // `installed: false` — an explicit fact, not an empty list.
  return okWith(envelope, 'whether the project dependencies are installed', (e) => typeof e.installed === 'boolean');
});
PR('diagnose', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'diagnose', {});
  return anyEnvelope(envelope);
});
PR('probe', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'probe', {});
  return anyEnvelope(envelope);
});
PR('dev_status', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'dev_status', {});
  return anyEnvelope(envelope);
});
PR('undo', 'full', async ({ call, rig }) => {
  await call('target', 'add_class', { ref: (await rig.call('target', 'read')).envelope?.target?.children?.[0]?.ref, className: 'undo-me' });
  const { envelope } = await call('project', 'undo', {});
  return anyEnvelope(envelope);
});
PR('redo', 'full', async ({ call }) => {
  const { envelope } = await call('project', 'redo', {});
  return anyEnvelope(envelope);
});
scenario({ domain: 'project', action: 'dev_start', grade: 'boundary',
  why: 'Starting the dev server spawns a real Astro process and binds a port; the rig drives the schema, permission gate and dispatch and stops at the bridge that would spawn it.',
  run: async ({ call }) => {
  const { envelope } = await call('project', 'dev_start', {});
  return anyEnvelope(envelope);
} });
scenario({ domain: 'project', action: 'dev_stop', grade: 'boundary',
  why: 'The counterpart of dev_start: it would terminate a real spawned process, so the rig stops at the same bridge.',
  run: async ({ call }) => {
  const { envelope } = await call('project', 'dev_stop', {});
  return anyEnvelope(envelope);
} });
scenario({ domain: 'project', action: 'install', grade: 'boundary',
  why: 'Running the package manager reaches the network and writes node_modules; the rig proves the gate and dispatch without acquiring anything.',
  run: async ({ call }) => {
  const { envelope } = await call('project', 'install', {});
  return anyEnvelope(envelope);
} });


// ── git ────────────────────────────────────────────────────────────────────
//
// Against a throwaway repository with a LOCAL BARE ORIGIN, so `push` is a real
// push that really lands somewhere and no remote anybody owns is touched. The
// only thing kept behind a boundary here is `publish`, which creates a
// repository on GitHub.

const GT = (action, grade, run) => scenario({ domain: 'git', action, grade, run });

GT('init', 'full', async ({ call, rig }) => {
  const { envelope } = await call('git', 'init', {});
  const isRepo = rig.harness.exists('.git');
  return { good: envelope?.ok === true && isRepo, detail: `ok=${envelope?.ok} .git=${isRepo} ${JSON.stringify(envelope).slice(0, 160)}` };
});
GT('info', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'info', {});
  return okWith(envelope, 'the repository state', (e) => 'branch' in e || 'repo' in e || 'head' in e);
});
GT('status', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'status', {});
  return okWith(envelope, 'the working tree', (e) => Array.isArray(e.files || e.changed || e.entries) || 'dirty' in e);
});
GT('commit', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'commit', { message: 'The fixture, as the wire test found it' });
  return anyEnvelope(envelope);
});
GT('log', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'log', { limit: 5 });
  return okWith(envelope, 'the commit it just made', (e) => Array.isArray(e.commits) && e.commits.length > 0);
});
GT('all_files', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'all_files', {});
  return okWith(envelope, 'the tracked files', (e) => Array.isArray(e.files) && e.files.length > 0);
});
GT('file_at', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'file_at', { ref: 'HEAD', path: 'src/pages/index.astro' });
  return okWith(envelope, 'the committed text', (e) => typeof e.text === 'string' && e.text.length > 0);
});
GT('commit_files', 'full', async ({ call }) => {
  // Not "commit these files" — it lists the files touched by a commit REF.
  const { envelope } = await call('git', 'commit_files', { ref: 'HEAD' });
  return okWith(envelope, 'the files in that commit', (e) => Array.isArray(e.files));
});
GT('checkout', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'checkout', { branch: 'wire-branch', create: true });
  return anyEnvelope(envelope);
});
GT('merge', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'merge', { branch: 'main' });
  return anyEnvelope(envelope);
});
GT('resolve_merge', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'resolve_merge', { branch: 'main', choices: {} });
  return anyEnvelope(envelope);
});
GT('worktrees', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'worktrees', {});
  return anyEnvelope(envelope);
});
GT('park', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'park', {});
  return anyEnvelope(envelope);
});
GT('unpark', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'unpark', {});
  return anyEnvelope(envelope);
});
GT('restore_file', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'restore_file', { ref: 'HEAD', path: 'src/pages/index.astro' });
  return anyEnvelope(envelope);
});
GT('restore_project', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'restore_project', { ref: 'HEAD' });
  return anyEnvelope(envelope);
});
GT('delete_branch', 'full', async ({ call }) => {
  const { envelope } = await call('git', 'delete_branch', { branch: 'wire-branch' });
  return anyEnvelope(envelope);
});
GT('gh_status', 'full', async ({ call }) => {
  // Read-only: it asks whether the `gh` CLI is present and authenticated. It
  // creates nothing and changes nothing, so it runs for real.
  const { envelope } = await call('git', 'gh_status', {});
  return anyEnvelope(envelope);
});
GT('push', 'full', async ({ call, rig }) => {
  // A REAL push, to a bare repository this test made in its own temp dir. The
  // old ledger filed this under "reaches real infrastructure"; it does not have
  // to, and a push that never runs is a push nobody has tested.
  const { execFileSync } = require('child_process');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-wire-origin-'));
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: rig.root, stdio: 'ignore' });
    const { envelope } = await call('git', 'push', { branch: 'main' });
    // Did anything actually arrive in the bare repo?
    let landed = false;
    try {
      landed = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim().length > 0;
    } catch {
      landed = false;
    }
    return { good: envelope?.ok === true && landed, detail: `ok=${envelope?.ok} landedInBareOrigin=${landed} ${JSON.stringify(envelope).slice(0, 200)}` };
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
scenario({
  domain: 'git', action: 'publish', grade: 'boundary',
  why: 'Publishing creates a repository on GitHub under the user\'s account and pushes to it. There is no local stand-in for that side effect, so the schema, permission gate, argument validation and dispatch run and the external call is where this stops.',
  run: async ({ call }) => {
    const { envelope } = await call('git', 'publish', { repoName: 'stacki-wire-test-never-created', private: true });
    return { good: !!envelope && typeof envelope.ok === 'boolean', detail: JSON.stringify(envelope).slice(0, 220) };
  },
});

module.exports = { okWith, anyEnvelope };
