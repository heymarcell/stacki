// Every Agent operation, at every access level, through the real MCP wire.
//
//   node test/mcp-permission-matrix.js
//
// The gate is one line of policy — `read` needs Inspect, `write` needs Edit,
// `high` needs Full — and it is the only thing standing between "an agent can
// look at this project" and "an agent can push it somewhere". A gate is not
// interesting when it works; it is interesting when one operation quietly
// stops being covered by it.
//
// So this asks the registry what each of the 111 operations needs, then drives
// EVERY one of them at all four levels over a real MCP client and checks the
// answer against the policy rather than against a list:
//
//   below what it needs   -> refused, with code `permission_denied`
//   at what it needs      -> not refused for permission reasons
//   above what it needs   -> still not refused for permission reasons
//
// "Not refused for permission reasons" rather than "succeeded", deliberately:
// most operations fail for ordinary reasons at this point in a fixture — a
// stale ref, a file already gone, a collection whose config needs installed
// dependencies. Those are not permission failures and treating them as passes
// for the gate would be the easiest way to make this file lie.
//
// The mode is changed through the HARNESS, never through MCP. There is no
// agent-facing operation that raises its own access level and this test does
// not invent one.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { DOMAINS, actionsOf, find } = require('../electron/mcp/agent/registry.js');
const { MODES, NEEDED } = require('../electron/mcp/agent/permissions.js');
const { startWireRig } = require('./support/mcpWireRig.js');
require('./support/mcpScenarioSet.js');
const { get: getScenario } = require('./support/mcpOperationScenarios.js');

const atLeast = (a, b) => MODES.indexOf(a) >= MODES.indexOf(b);

(async () => {
  const ops = [];
  for (const domain of DOMAINS) {
    for (const action of actionsOf(domain)) {
      const entry = find(domain, action);
      ops.push({ domain, action, risk: entry.risk, needs: NEEDED[entry.risk] || 'full' });
    }
  }
  check('the registry reports every operation with a risk', ops.length > 0 && ops.every((o) => !!o.needs), String(ops.length));

  // THE ARGUMENTS COME FROM THE SCENARIOS, and they have to.
  //
  // The first version of this file called every operation with `{}` and read
  // the answer. That measures nothing: the MCP tool's own input schema rejects
  // a call with no arguments before the Agent API's permission gate is ever
  // reached, so every write operation came back "not refused" and looked like
  // an open door. It was argument validation, not authorisation.
  //
  // So each operation is driven by the same executable scenario the coverage
  // matrix uses — real arguments, real refs — and every envelope it produces
  // is watched for a permission refusal.
  const seen = [];
  for (const mode of MODES) {
    let rig = null;
    try {
      rig = await startWireRig({ agentMode: mode });
      for (const op of ops) {
        const s = getScenario(op.domain, op.action);
        const envelopes = [];
        const watched = async (domain, action, args = {}) => {
          const out = await rig.call(domain, action, args);
          // Only the operation under test counts: a scenario that reads
          // something first would otherwise report the READ's refusal.
          if (domain === op.domain && action === op.action) envelopes.push(out.envelope);
          return out;
        };
        const ref = async (want = 'h1') => {
          const { envelope } = await rig.call('target', 'read');
          const root = envelope?.target;
          if (!root) return null;
          const stack = [root]; const flat = [];
          while (stack.length) { const n = stack.shift(); if (!n) continue; flat.push(n); for (const c of n.children || []) stack.push(c); }
          const hit = flat.find((n) => String(n.tag || n.name || '').toLowerCase() === String(want).toLowerCase());
          return (hit || flat[1] || root)?.ref || null;
        };
        try {
          await s.run({ call: watched, tool: rig.tool, rig, ref });
        } catch {
          /* a scenario that cannot complete at this level is expected; the
             envelopes it produced before giving up are what matter */
        }
        const denied = envelopes.some((e) => e?.ok === false && e?.code === 'permission_denied');
        // An envelope is only evidence if it IS one. A call whose arguments the
        // MCP input schema rejected returns no structuredContent at all —
        // which happens constantly at a low level, because the ref this
        // operation needed came from a read that was itself refused. Counting
        // that absence as "reached and not refused" is how this file first
        // reported the entire write surface as an open door at visual, which
        // it demonstrably is not.
        const reached = envelopes.some((e) => e && typeof e.ok === 'boolean');
        seen.push({ ...op, mode, denied, reached });
      }
    } finally {
      if (rig) await rig.stop();
    }
  }

  check('every operation was tried at every level', seen.length === ops.length * MODES.length, `${seen.length} of ${ops.length * MODES.length}`);

  const wrongDenials = [];
  const wrongAccepts = [];
  for (const row of seen) {
    const allowed = atLeast(row.mode, row.needs);
    if (allowed && row.denied) wrongDenials.push(`${row.domain}.${row.action} needs ${row.needs}, refused at ${row.mode}`);
    // Only meaningful where the operation was actually invoked: a scenario
    // whose earlier setup was itself refused never reaches its own call, and
    // that is a denial upstream rather than an open door here.
    if (!allowed && row.reached && !row.denied) wrongAccepts.push(`${row.domain}.${row.action} needs ${row.needs}, NOT refused at ${row.mode}`);
  }

  check('nothing is refused at or above the level it needs', wrongDenials.length === 0, wrongDenials.slice(0, 12).join('\n      '));
  check('nothing is allowed below the level it needs', wrongAccepts.length === 0, wrongAccepts.slice(0, 12).join('\n      '));

  const deniedRows = seen.filter((r) => r.denied);
  check('the gate refuses somewhere below the required level', deniedRows.length > 0, String(deniedRows.length));

  const openAtVisual = seen.filter((r) => r.mode === 'visual' && r.reached && !r.denied && r.risk !== 'read');
  check('no write or high-risk operation runs at visual', openAtVisual.length === 0, openAtVisual.map((r) => `${r.domain}.${r.action}`).slice(0, 12).join(', '));

  if (!failures.length) {
    const grid = {};
    for (const m of MODES) grid[m] = seen.filter((r) => r.mode === m && r.denied).length;
    console.log(`  ${ops.length} operations × ${MODES.length} levels = ${seen.length} answers`);
    console.log('  refused per level: ' + MODES.map((m) => `${m} ${grid[m]}`).join(' · '));
    console.log('  required levels: ' + Object.entries(NEEDED).map(([r, n]) => `${r} needs ${n}`).join(' · '));
  }

  if (failures.length) {
    console.error(`\nmcp-permission-matrix: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-permission-matrix: ${checked} passed  [${seen.length} operation/level answers, all through a real client]`);
})().catch((err) => {
  console.error('mcp-permission-matrix threw\n', err);
  process.exit(1);
});
