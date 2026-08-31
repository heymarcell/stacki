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
const { residueOf, describeResidue } = require('./support/ownedResidue.js');
const { DOMAINS } = require('../electron/mcp/agent/registry.js');

/** Every fixture directory this run created, so teardown can be checked. */
const ownedRoots = [];
const { find } = require('../electron/mcp/agent/registry.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

// ── the runner ─────────────────────────────────────────────────────────────

// THE ORDER COMES FROM THE REGISTRY, not from a list typed here.
//
// This was a literal, and the counts below it were printed rather than checked
// — so a scenario whose domain was not in the literal was registered (the
// operation matrix, which only proves parity, stayed green), never executed,
// and never counted as missing. Renaming a domain in the registry and the
// scenario set, or adding one, would have stopped every scenario in it from
// running while both suites went on saying passed.
const DOMAIN_ORDER = [...DOMAINS];

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
      ownedRoots.push(rig.root);
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
        // NO FALLBACK. This used to answer `hit || seen[1] || root`, so asking
        // for a tag the tree does not have handed back a neighbour and every
        // "did it act on the right element" assertion downstream was being made
        // about the wrong one — silently, and only when the fixture changed
        // shape. A scenario that cannot find what it asked for should stop,
        // saying what was there instead.
        if (!hit) {
          throw new Error(
            `${s.domain}.${s.action}: no <${want}> in the tree — it holds ${seen.map((n) => n.tag || n.name).filter(Boolean).join(', ')}`
          );
        }
        return hit.ref || null;
      };

      // Reads made to SET UP a scenario go through the rig directly and are not
      // the subject; the recorder below counts only calls to the operation under
      // test. target.read is the one operation that is both — it is what mints a
      // ref — so its own scenario reads twice by construction: once here for a
      // ref, once as the subject it is judged on.


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
      // A BOUNDARY SCENARIO IS STILL A SCENARIO. Its own {good, detail} used to
      // be the whole verdict, unexamined — no subject recorder, so nothing
      // checked that the operation it names was the one that ran, or that it
      // ran once. The boundary judgement layers on top of that rather than
      // replacing it.
      if (!verdict && s.grade !== 'full') {
        if (!subject.invoked) verdict = { good: false, detail: `${s.domain}.${s.action} was never invoked, so nothing was proven about it` };
        else if (subject.count !== 1) verdict = { good: false, detail: `${s.domain}.${s.action} was invoked ${subject.count} times; a scenario makes exactly one subject call` };
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
      // Owned, so it goes. A rig that will not stop is a leak, not a detail —
      // and now it says which part of itself it could not put down, rather than
      // deleting the fixture out from under a server that is still serving.
      if (rig) {
        const { problems } = (await rig.stop()) || { problems: [] };
        if (problems.length) {
          check(`${s.domain}.${s.action} tore its fixture down cleanly`, false, problems.join('; '));
        }
      }
    }
  }

  console.log(`  scenarios registered: ${scenarioCount()}  (order: ${mode}, fresh fixture each)`);
  console.log(`  scenarios run:        ${results.size}`);

  // AND EVERY ONE OF THEM RAN. The two numbers above were printed and never
  // compared, which is what let a whole domain be skipped in silence.
  const ranKeys = new Set([...results.keys()]);
  const neverRan = allScenarios()
    .map((x) => `${x.domain}.${x.action}`)
    .filter((key) => !ranKeys.has(key));
  check(
    'every registered scenario was executed',
    neverRan.length === 0 && results.size === scenarioCount(),
    neverRan.length ? `never ran: ${neverRan.join(', ')}` : `${results.size} ran of ${scenarioCount()} registered`
  );

  // CLEANUP IS A RESULT, NOT A COURTESY.
  //
  // A hundred and eleven fixtures were made here, several of them running a
  // real Astro server and a real esbuild. Whether they are gone is a fact about
  // this machine, so it is asked rather than assumed — and it is asked about
  // the exact directories this run created, never about a program's name.
  const residue = await residueOf(ownedRoots);
  check(
    'every fixture this run made is gone, and nothing is still running in one',
    residue.dirs.length === 0 && residue.processes.length === 0,
    describeResidue(residue)
  );
  console.log(`  fixtures made: ${ownedRoots.length} · left on disk: ${residue.dirs.length} · processes still in one: ${residue.processes.length}`);

  if (failures.length) {
    console.error(`\nmcp-wire-coverage: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-wire-coverage: ${checked} passed  [official client -> MCP -> Agent API -> fixture]`);
})().catch((err) => {
  console.error('mcp-wire-coverage threw\n', err);
  process.exit(1);
});
