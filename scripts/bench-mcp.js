// What Stacki's MCP endpoint actually costs, measured.
//
//   npm run bench:mcp
//
// Deliberately NOT part of `npm test`. A wall-clock threshold on a shared CI
// runner is a flake generator, and a benchmark that fails the build teaches
// people to ignore it. This prints numbers; the regression tests that keep
// optimizations honest are event/count invariants, not milliseconds.
//
// Everything is measured through the same path a client uses — the official
// MCP client over HTTP to a real server in front of the real Agent API — so
// what comes out includes transport, JSON, schema validation and dispatch,
// which is the number an agent actually waits for.
//
// Cold is the first call of its kind; warm is every call after. They are
// reported separately because they answer different questions: cold is what a
// session pays once, warm is what a workflow pays repeatedly.

const zlib = require('zlib');
const { startWireRig } = require('../test/support/mcpWireRig.js');

const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 20);

const ns = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    min: +s[0].toFixed(1),
    p50: +at(50).toFixed(1),
    p90: +at(90).toFixed(1),
    p95: +at(95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    mean: +(s.reduce((t, v) => t + v, 0) / s.length).toFixed(1),
  };
}

(async () => {
  const rig = await startWireRig();
  const rows = [];

  // A ref, taken once: re-reading it inside the timed section would measure
  // two operations and attribute the total to one.
  const read = await rig.call('target', 'read');
  const pageRef = read.envelope?.target?.ref;

  const bench = async (label, fn) => {
    const cold = ns();
    const first = await fn();
    const coldMs = ms(cold, ns());
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(first ?? {}), 'utf8');
    } catch {
      bytes = 0;
    }
    const warm = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = ns();
      await fn();
      warm.push(ms(t, ns()));
    }
    rows.push({ label, cold: +coldMs.toFixed(1), bytes, ...stats(warm) });
  };

  // Protocol surface.
  await bench('server/discover', () => rig.client.request({ method: 'server/discover', params: {} }));
  await bench('tools/list', () => rig.client.listTools());

  // The non-domain tools.
  await bench('get_capabilities', () => rig.tool('get_capabilities'));
  await bench('get_context', () => rig.tool('get_context', { styleDetail: 'none' }));
  await bench('get_context essential', () => rig.tool('get_context', { styleDetail: 'essential' }));
  await bench('get_context full', () => rig.tool('get_context', { styleDetail: 'full' }));
  await bench('get_comments summary', () => rig.tool('get_comments', { status: 'open' }));
  await bench('capture selection', () => rig.tool('capture', { target: 'selection' }));

  // Reads across every domain, which is what a workflow actually leans on.
  await bench('target.read', () => rig.call('target', 'read', { ref: pageRef }));
  await bench('style.read', () => rig.call('style', 'read', { ref: pageRef }));
  await bench('style.list_sources', () => rig.call('style', 'list_sources'));
  await bench('style.variables', () => rig.call('style', 'variables'));
  await bench('source.read', () => rig.call('source', 'read', { path: 'src/pages/index.astro' }));
  await bench('page.list', () => rig.call('page', 'list'));
  await bench('page.read', () => rig.call('page', 'read', { path: 'src/pages/index.astro' }));
  await bench('content.cms_list', () => rig.call('content', 'cms_list'));
  await bench('content.collections', () => rig.call('content', 'collections'));
  await bench('asset.list', () => rig.call('asset', 'list', { under: 'public' }));
  await bench('project.info', () => rig.call('project', 'info'));
  await bench('project.scan', () => rig.call('project', 'scan'));
  await bench('git.info', () => rig.call('git', 'info'));
  await bench('git.status', () => rig.call('git', 'status'));

  // ── the catalog ──────────────────────────────────────────────────────────
  const listed = await rig.client.listTools();
  const json = JSON.stringify(listed);
  const catalog = {
    tools: listed.tools.length,
    raw: Buffer.byteLength(json, 'utf8'),
    gzip: zlib.gzipSync(json).length,
    descriptions: listed.tools.reduce((t, x) => t + Buffer.byteLength(x.description || '', 'utf8'), 0),
    inputSchemas: listed.tools.reduce((t, x) => t + Buffer.byteLength(JSON.stringify(x.inputSchema || {}), 'utf8'), 0),
    outputSchemas: listed.tools.reduce((t, x) => t + Buffer.byteLength(JSON.stringify(x.outputSchema || {}), 'utf8'), 0),
  };

  // ── whole workflows, which is what "slow" actually means to somebody ─────
  const workflow = async (label, steps) => {
    const t = ns();
    let calls = 0;
    let bytes = 0;
    for (const step of steps) {
      const out = await step();
      calls += 1;
      try {
        bytes += Buffer.byteLength(JSON.stringify(out ?? {}), 'utf8');
      } catch {
        /* an unserialisable answer still counts as a call */
      }
    }
    return { label, calls, ms: +ms(t, ns()).toFixed(1), bytes };
  };

  const flows = [];
  flows.push(await workflow('visual read', [
    () => rig.tool('get_context', { styleDetail: 'essential' }),
    () => rig.call('target', 'read', { ref: pageRef }),
  ]));
  flows.push(await workflow('style edit', [
    () => rig.tool('get_context', { styleDetail: 'essential' }),
    () => rig.call('target', 'read', { ref: pageRef }),
    () => rig.call('style', 'read', { ref: pageRef }),
    () => rig.call('style', 'set_property', { ref: pageRef, property: 'opacity', value: '0.95' }),
    () => rig.tool('capture', { target: 'selection' }),
  ]));
  flows.push(await workflow('page investigation', [
    () => rig.call('page', 'list'),
    () => rig.call('page', 'read', { path: 'src/pages/index.astro' }),
    () => rig.call('source', 'read', { path: 'src/pages/index.astro' }),
  ]));

  // ── report ───────────────────────────────────────────────────────────────
  const pad = (v, n) => String(v).padStart(n);
  console.log(`\nStacki MCP benchmark — ${ITERATIONS} warm iterations per operation`);
  console.log(`node ${process.version} · ${process.platform}/${process.arch}\n`);
  console.log('  operation                 cold    p50    p90    p95    max   bytes');
  console.log('  ' + '-'.repeat(68));
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(24)}${pad(r.cold, 6)}${pad(r.p50, 7)}${pad(r.p90, 7)}${pad(r.p95, 7)}${pad(r.max, 7)}${pad(r.bytes, 8)}`);
  }
  console.log('\n  catalog');
  console.log(`    ${catalog.tools} tools · raw ${catalog.raw} B · gzip ${catalog.gzip} B`);
  console.log(`    descriptions ${catalog.descriptions} B · inputSchemas ${catalog.inputSchemas} B · outputSchemas ${catalog.outputSchemas} B`);
  console.log('\n  workflows (machine time, no model thinking)');
  for (const f of flows) console.log(`    ${f.label.padEnd(22)}${pad(f.calls, 3)} calls  ${pad(f.ms, 8)} ms  ${pad(f.bytes, 8)} B`);
  console.log('');

  if (process.env.BENCH_JSON) {
    require('fs').writeFileSync(process.env.BENCH_JSON, JSON.stringify({ node: process.version, iterations: ITERATIONS, rows, catalog, flows }, null, 2));
    console.log(`  written to ${process.env.BENCH_JSON}\n`);
  }

  await rig.stop();
  process.exit(0);
})().catch((err) => {
  console.error('bench-mcp threw\n', err);
  process.exit(1);
});
