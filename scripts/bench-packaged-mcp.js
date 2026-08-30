// What the packaged app costs to talk to.
//
//   node scripts/bench-packaged-mcp.js
//
// Measurement, not a gate. Nothing here fails a build: the point is to know
// where the time goes before deciding whether any of it is worth moving, and
// the previous round of this taught the lesson worth repeating — style.read
// looked slow and was mostly the browser's own style resolution, not MCP.
//
// COLD is the first call of its kind against a freshly launched app. WARM is
// every call after it. They are reported separately because they answer
// different questions: cold is what an agent's first question costs, warm is
// what a conversation costs.

const crypto = require('node:crypto');
const { startPackagedApp, available, APP } = require('../test/support/packagedApp.js');

const SAMPLES = Number(process.env.BENCH_SAMPLES || 12);

const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

(async () => {
  if (!available()) {
    console.log(`bench-packaged-mcp: skipped  [no ${APP} — run npm run dist:mac:unsigned]`);
    return;
  }

  const app = await startPackagedApp({ access: 'edit' });
  const rows = [];
  try {
    await app.untilOpen();
    await app.untilPreviewReady();

    const read = await app.run('target', 'read');
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      (n.children || []).forEach(walk);
    };
    walk(read?.target);
    const footer = flat.find((n) => String(n.tag || '').toLowerCase() === 'footer');
    const grid = flat.find((n) => String(n.tag || '').toLowerCase() === 'div');

    /** One measured call: wall clock and the size of what came back. */
    const timed = async (fn) => {
      const started = process.hrtime.bigint();
      const res = await fn();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(JSON.stringify(res ?? null), 'utf8');
      } catch {
        bytes = 0;
      }
      return { ms, bytes };
    };

    const rawTool = (name, args) => app.client.callTool({ name, arguments: args }, undefined, { timeout: 240000 });

    const CASES = [
      ['server/discover', 'MCP transport', () => app.client.request({ method: 'server/discover', params: {} })],
      ['tools/list', 'MCP transport', () => app.client.listTools()],
      ['get_context (essential)', 'renderer round trip', () => app.call('get_context', { styleDetail: 'essential' })],
      ['get_context (full)', 'renderer round trip + cascade', () => app.call('get_context', { styleDetail: 'full' })],
      ['target.read', 'renderer round trip', () => app.run('target', 'read')],
      ['style.read', 'cascade / style resolution', () => app.run('style', 'read', { ref: grid.ref })],
      ['source.read', 'main process + disk', () => app.run('source', 'read', { path: 'src/pages/index.astro' })],
      ['capture (viewport)', 'preview + capture', () => rawTool('capture', { target: 'viewport', format: 'png' })],
      ['capture (selection)', 'preview + capture', () => rawTool('capture', { target: 'selection', format: 'png' })],
      ['project.dev_status', 'renderer round trip', () => app.run('project', 'dev_status')],
    ];

    for (const [label, layer, fn] of CASES) {
      const cold = await timed(fn);
      const warm = [];
      let bytes = cold.bytes;
      for (let i = 0; i < SAMPLES; i += 1) {
        const one = await timed(fn);
        warm.push(one.ms);
        bytes = one.bytes;
      }
      rows.push({ label, layer, cold: cold.ms, p50: quantile(warm, 0.5), p95: quantile(warm, 0.95), bytes });
    }

    // A mutation and its undo, measured in pairs so the document ends where it
    // started and every sample costs the same thing.
    const editWarm = [];
    const undoWarm = [];
    let editBytes = 0;
    let undoBytes = 0;
    let editCold = null;
    let undoCold = null;
    for (let i = 0; i < SAMPLES; i += 1) {
      const e = await timed(() => app.run('target', 'set_text', { ref: footer.ref, text: `bench ${i} ${crypto.randomUUID().slice(0, 8)}` }));
      const u = await timed(() => app.run('project', 'undo'));
      if (i === 0) {
        editCold = e;
        undoCold = u;
      } else {
        editWarm.push(e.ms);
        undoWarm.push(u.ms);
      }
      editBytes = e.bytes;
      undoBytes = u.bytes;
    }
    rows.push({ label: 'target.set_text', layer: 'renderer + model + save', cold: editCold.ms, p50: quantile(editWarm, 0.5), p95: quantile(editWarm, 0.95), bytes: editBytes });
    rows.push({ label: 'project.undo', layer: 'renderer + model + save', cold: undoCold.ms, p50: quantile(undoWarm, 0.5), p95: quantile(undoWarm, 0.95), bytes: undoBytes });
  } finally {
    const { problems } = await app.stop();
    if (problems.length) console.error(`  teardown left something behind: ${problems.join('; ')}`);
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n) => String(Math.round(v)).padStart(n);
  console.log(`\n  packaged MCP, ${SAMPLES} warm samples each\n`);
  console.log(`  ${pad('operation', 24)} ${pad('cold', 7)} ${pad('p50', 6)} ${pad('p95', 6)} ${pad('bytes', 8)} dominant layer`);
  console.log(`  ${'-'.repeat(24)} ${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(8)} ${'-'.repeat(30)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.label, 24)} ${num(r.cold, 6)}m ${num(r.p50, 5)}m ${num(r.p95, 5)}m ${String(r.bytes).padStart(8)} ${r.layer}`);
  }
  console.log('');
})().catch((err) => {
  console.error('bench-packaged-mcp threw\n', err);
  process.exit(1);
});
