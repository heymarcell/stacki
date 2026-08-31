// Build the shared test bundle once, before any parallel trial wants it.
//
// The agent harness bundles src/App.jsx into node_modules/.stacki-test/ and
// caches it there. Seven rigs starting at once all find it missing and all write
// it, and the loser reads a half-written file -- "SyntaxError: Unexpected end of
// input". One rig, started and stopped, leaves a complete bundle for the rest.
const path = require('node:path');
const repo = process.argv[2] || path.resolve(__dirname, '..', '..');
(async () => {
  const { startWireRig } = require(path.join(repo, 'test/support/mcpWireRig.js'));
  const rig = await startWireRig({ era: 'modern', agentMode: 'edit' });
  const { problems } = await rig.stop();
  console.log(`prewarmed ${repo} · cleanup problems: ${(problems || []).length}`);
})().catch((e) => { console.error('prewarm failed:', e.message || e); process.exit(1); });
