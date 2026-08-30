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
const { find } = require('../electron/mcp/agent/registry.js');

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

  // A FRESH RIG PER SCENARIO.
  //
  // This used to be one rig per domain with scenarios running in declared
  // order, and that was not isolation — it was an ordering that happened to
  // work. It stopped working the moment `set_text` entered the Hero component
  // and did not leave: every later ref resolved inside Hero's tree, and a dozen
  // mutations looked like they had silently stopped writing. Fixing the ref
  // helper fixed that symptom and left the architecture alone.
  //
  // So each scenario now gets its own project, its own MCP endpoint and its own
  // client. Order independence stops being a property to test for and becomes a
  // property of the shape: there is nothing for scenario N to inherit from
  // N-1, because N-1's fixture no longer exists.
  //
  // It costs about 620ms a scenario, roughly seventy seconds for the set. That
  // is a fair price for never again debugging a failure that belongs to a
  // neighbour.
  const order = [];
  for (const domain of DOMAIN_ORDER) for (const s of allScenarios().filter((x) => x.domain === domain)) order.push(s);
  // SCENARIO_ORDER=reverse|shuffle proves the isolation rather than asserting
  // it — the results have to be identical whichever way round they run.
  const mode = process.env.SCENARIO_ORDER || 'normal';
  if (mode === 'reverse') order.reverse();
  if (mode === 'shuffle') {
    // Deterministic: a shuffle nobody can reproduce is not evidence.
    let seed = 20260829;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  for (const s of order) {
    let rig = null;
    try {
      rig = await startWireRig({ withDeps: s.needs === 'deps', realDevServer: s.needs === 'server' });
      const ref = async (want = 'h1') => {
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

      const subject = { key: `${s.domain}.${s.action}`, invoked: false, envelope: null, count: 0 };
      let worldReads = 0;
      const watched = async (domain, action, args = {}) => {
        const out = await rig.call(domain, action, args);
        if (domain === s.domain && action === s.action) {
          subject.invoked = true;
          subject.envelope = out.envelope;
          subject.count += 1;
        }
        return out;
      };
      const fixture = {
        get root() {
          worldReads += 1;
          return rig.root;
        },
        read: (rel) => {
          worldReads += 1;
          return rig.harness.read(rel);
        },
        exists: (rel) => {
          worldReads += 1;
          return rig.harness.exists(rel);
        },
        write: (rel, text) => rig.harness.write(rel, text),
        observedWorld: (what) => {
          if (typeof what !== 'string' || !what.trim()) throw new Error('observedWorld needs to say what was inspected');
          worldReads += 1;
          return what;
        },
        scratch: {},
      };

      let raw = null;
      let verdict = null;
      try {
        raw = await s.run({ call: watched, tool: rig.tool, ref, fixture });
      } catch (err) {
        verdict = { good: false, detail: `threw: ${String(err?.message || err).slice(0, 240)}` };
      }
      if (!verdict) verdict = s.grade === 'full' ? judgeFull(raw, subject) : raw;
      if (verdict?.good && s.grade === 'full') {
        const entry = find(s.domain, s.action);
        if (entry && (entry.risk === 'write' || entry.risk === 'high') && worldReads === 0) {
          verdict = {
            good: false,
            detail: `${s.domain}.${s.action} is a ${entry.risk} operation and the scenario never read the world — its only evidence is the operation's own success flag. Inspect the file, the repository, the port or a follow-up read.`,
          };
        }
      }
      results.set(`${s.domain}.${s.action}`, verdict);
      check(`${s.domain}.${s.action} [${s.grade}] through the wire`, verdict?.good === true, verdict?.detail || '');
    } finally {
      // Owned, so it goes. A rig that will not stop is a leak, not a detail.
      if (rig) await rig.stop();
    }
  }

  console.log(`  scenarios registered: ${scenarioCount()}  (order: ${mode}, fresh fixture each)`);
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
