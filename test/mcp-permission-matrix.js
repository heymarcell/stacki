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
  // A FRESH FIXTURE PER OPERATION PER LEVEL.
  //
  // This used to build one rig per level and run all hundred and eleven
  // scenarios through it in order, which meant they inherited each other's
  // world: by the time target.remove ran, the node it wanted had been removed
  // by a neighbour, so `ref` came back null, so the MCP input schema rejected
  // the call before the Agent API's gate was ever consulted. A hundred and
  // thirty-two subjects were never asked the question, and the file reported no
  // open doors because nobody had knocked on them.
  //
  // Four hundred and forty-four fixtures is the honest cost of four hundred and
  // forty-four independent answers. Most take about a second; only the handful
  // that declare a fixture pay for dependencies or a dev server.
  const seen = [];
  for (const mode of MODES) {
    for (const op of ops) {
      const s = getScenario(op.domain, op.action);
      let rig = null;
      try {
        // The fixture each operation actually needs, and no more. Every rig used
        // to clone the whole Astro node_modules — 154MB, four hundred and
        // forty-four times — for operations that never look at a content
        // config. The gate is about authorisation; only the operations that
        // cannot reach their own gate without dependencies pay for them.
        rig = await startWireRig({
          agentMode: 'full',
          withDeps: s.needs === 'deps' || s.needs === 'server',
          realDevServer: false,
        });
        const envelopes = [];
        // THE LEVEL APPLIES TO THE OPERATION UNDER TEST, NOT TO ITS SETUP.
        //
        // Every scenario needs a ref, and a ref comes from target.read, which
        // is itself gated. Preparing the fixture at the level under test meant
        // the setup was refused first and the subject never ran. So the fixture
        // is prepared at full access and the level is applied to exactly one
        // call: the one the gate is about. Put back in a finally, so a refused
        // subject cannot lock the rest of the scenario out.
        const watched = async (domain, action, args = {}) => {
          const subject = domain === op.domain && action === op.action;
          if (!subject) return rig.call(domain, action, args);
          rig.harness.setMode(mode);
          try {
            const out = await rig.call(domain, action, args);
            envelopes.push(out.envelope);
            return out;
          } finally {
            rig.harness.setMode('full');
          }
        };
        const ref = async (want = 'h1') => {
          // Read at full access: this is setup, not the subject.
          const { envelope } = await rig.call('target', 'read');
          const root = envelope?.target;
          if (!root) return null;
          const stack = [root]; const flat = [];
          while (stack.length) { const n = stack.shift(); if (!n) continue; flat.push(n); for (const c of n.children || []) stack.push(c); }
          const hit = flat.find((n) => String(n.tag || n.name || '').toLowerCase() === String(want).toLowerCase());
          return (hit || flat[1] || root)?.ref || null;
        };
        const fixture = {
          root: rig.root,
          read: (rel) => rig.harness.read(rel),
          exists: (rel) => rig.harness.exists(rel),
          write: (rel, text) => rig.harness.write(rel, text),
          observedWorld: (what) => what,
          scratch: {},
        };
        try {
          await s.run({ call: watched, tool: rig.tool, rig, ref, fixture });
        } catch {
          /* a scenario that cannot complete at this level is expected; the
             envelopes it produced before giving up are what matter */
        }
        const denied = envelopes.some((e) => e?.ok === false && e?.code === 'permission_denied');
        // An envelope is only evidence if it IS one. A call whose arguments the
        // MCP input schema rejected returns no structuredContent at all, and
        // counting that absence as "reached and not refused" is how this file
        // first reported the entire write surface as an open door at visual.
        const reached = envelopes.some((e) => e && typeof e.ok === 'boolean');
        seen.push({ ...op, mode, denied, reached });
      } finally {
        if (rig) await rig.stop();
      }
    }
  }

  const expected = ops.length * MODES.length;
  check('every operation was tried at every level', seen.length === expected, `${seen.length} of ${expected}`);

  // REACHED, not merely attempted.
  //
  // An envelope is only evidence about the gate if the operation was actually
  // invoked. A scenario whose setup was refused never makes its own call, and
  // counting that silence as "not an open door" is how this file could report a
  // clean matrix while a quarter of the surface was never asked the question.
  // So the count is a gate of its own rather than a footnote.
  const unreached = seen.filter((r) => !r.reached);
  check(
    'every operation reached its own permission gate',
    unreached.length === 0,
    `${unreached.length} of ${expected} never invoked: ` +
      [...new Set(unreached.map((r) => `${r.domain}.${r.action}@${r.mode}`))].slice(0, 14).join(', ')
  );

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
    console.log(`  subjects expected: ${expected} · reached: ${seen.filter((r) => r.reached).length} · unreached: ${unreached.length}`);
    console.log(`  unexpected accepts: ${wrongAccepts.length} · unexpected denials: ${wrongDenials.length}`);
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
