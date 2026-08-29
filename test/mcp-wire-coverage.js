// Every Agent operation, driven through a real MCP client.
//
//   node test/mcp-wire-coverage.js
//
// test/agent-api.js and test/agent-acceptance.js call `api.run(domain, action)`
// directly. That proves the implementation and it is blind, by construction, to
// everything between the implementation and a client — which is where the one
// MCP bug we shipped lived, and where the second one turned up while this file
// was being written (`project.diagnose` sending a null the schema declared as a
// required string, so a real client got `isError` and no result at all).
//
// Here every operation goes the long way round:
//
//   official MCP client -> HTTP -> Stacki MCP server -> domain tool
//     -> Agent API dispatcher -> real main/App implementation -> fixture on disk
//
// and the client validates every envelope against the output schema it was
// handed by `tools/list`, so a drift throws rather than passing quietly.
//
// The scenarios themselves live in test/support/mcpScenarioSet.js. One rig per
// domain; scenarios run in declared order within it, and the order is owned
// rather than incidental — a scenario that needs a ref reads it first.

require('./support/mcpScenarioSet.js');
const { all: allScenarios, size: scenarioCount, judgeFull } = require('./support/mcpOperationScenarios.js');
const { startWireRig } = require('./support/mcpWireRig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

// ── the runner ─────────────────────────────────────────────────────────────

const DOMAIN_ORDER = ['target', 'style', 'source', 'page', 'asset', 'content', 'project', 'git'];

(async () => {
  const results = new Map();

  for (const domain of DOMAIN_ORDER) {
    const mine = allScenarios().filter((s) => s.domain === domain);
    if (!mine.length) continue;
    let rig = null;
    try {
      rig = await startWireRig();
      // A ref for the fixture's own markup, obtained the way an agent does it:
      // `target.read` with no ref answers the page root, and every node under
      // it carries its own ref. Walked fresh each time, because a ref goes
      // stale the moment the tree it described is edited — which most of the
      // scenarios below do on purpose.
      const ref = async (want = 'h1') => {
        // Leave any component a previous scenario drilled into. Without this,
        // `set_text` enters Hero and every later ref resolves inside Hero's
        // tree instead of the page's — which made a dozen mutations look like
        // they had silently stopped writing. Scenario order must not decide
        // what a ref means.
        await rig.call('target', 'exit', {}).catch(() => {});
        const { envelope } = await rig.call('target', 'read');
        const root = envelope?.target;
        if (!root) return null;
        const wanted = String(want).toLowerCase();
        const stack = [root];
        const seen = [];
        while (stack.length) {
          const node = stack.shift();
          if (!node) continue;
          seen.push(node);
          for (const child of node.children || []) stack.push(child);
        }
        const hit = seen.find((n) => String(n.tag || n.name || '').toLowerCase() === wanted);
        return (hit || seen[1] || root)?.ref || null;
      };
      for (const s of mine) {
        let raw = null;
        let verdict = null;
        try {
          raw = await s.run({ call: rig.call, tool: rig.tool, rig, ref });
        } catch (err) {
          verdict = { good: false, detail: `threw: ${String(err?.message || err).slice(0, 240)}` };
        }
        // FULL is judged by the framework, not by whatever the scenario felt
        // like returning: the operation must have answered, the answer must
        // have succeeded, and a postcondition must hold. BOUNDARY keeps its own
        // shape, because not completing is the thing it asserts.
        if (!verdict) verdict = s.grade === 'full' ? judgeFull(raw) : raw;
        results.set(`${s.domain}.${s.action}`, verdict);
        check(`${s.domain}.${s.action} [${s.grade}] through the wire`, verdict?.good === true, verdict?.detail || '');
      }
    } finally {
      if (rig) await rig.stop();
    }
  }

  // ── The catalog does not grow silently ───────────────────────────────────
  //
  // A byte budget, not a stopwatch — §44's rule, and the one this repository
  // keeps relearning: assert the invariant, not the milliseconds. Every client
  // pays for `tools/list` on every session; it is 131KB raw / 11KB gzipped
  // today, over half of it the Envelope output schema serialised once per
  // domain tool.
  //
  // It has to be measured against the FULL surface. The first version of this
  // check lived in test/mcp-modern.js, whose server is built without `api` and
  // therefore publishes four tools rather than thirteen — the budget passed a
  // deliberate 160KB of padding without noticing, because it was weighing the
  // wrong catalog. Sabotage is why that was found rather than shipped.
  //
  // The headroom is deliberate: a tripwire for a surface that doubles, not a
  // style rule about description length.
  {
    const rig = await startWireRig();
    try {
      const listed = await rig.client.listTools();
      const json = JSON.stringify(listed);
      const raw = Buffer.byteLength(json, 'utf8');
      const gzip = require('zlib').gzipSync(json).length;
      check('the whole tool surface is published', listed.tools.length === 13, `${listed.tools.length} tools`);
      check('the tool catalog has not doubled', raw < 260000, `${raw} bytes raw (131349 when this budget was set)`);
      check('  nor has it compressed worse', gzip < 24000, `${gzip} bytes gzip (11272 when set)`);
      check('  and every tool still declares an output schema', listed.tools.every((t) => !!t.outputSchema), listed.tools.filter((t) => !t.outputSchema).map((t) => t.name).join(','));
    } finally {
      await rig.stop();
    }
  }

  console.log(`  scenarios registered: ${scenarioCount()}`);
  console.log(`  scenarios run:        ${results.size}`);

  if (failures.length) {
    console.error(`\nmcp-wire-coverage: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-wire-coverage: ${checked} passed  [official client -> MCP -> Agent API -> fixture]`);
})().catch((err) => {
  console.error('mcp-wire-coverage threw\n', err);
  process.exit(1);
});
