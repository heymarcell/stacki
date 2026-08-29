// Every Agent operation, and the executable scenario that earns its coverage.
//
//   node test/mcp-operation-matrix.js
//
// The first version of this file held a hand-typed `COVERED` set. It could
// prove every registry action had been CATEGORISED and nothing else: once
// somebody types `'target.read'` into a Set, the ledger reports coverage
// whether or not a byte ever crossed the wire. Coverage that can be asserted by
// typing is paperwork, and paperwork is exactly what we were trying to stop
// relying on.
//
// So there is no COVERED set here any more. Coverage is DERIVED from
// test/support/mcpScenarioSet.js, where every entry carries the function that
// produces it — a registration without a callable `run` is rejected at load
// time. The number in this report and the code that earns it cannot drift
// apart, because the number IS the code.
//
// Two grades, and the report never blurs them:
//
//   FULL      a real MCP client reached the real implementation and a
//             meaningful result or state transition was checked.
//   BOUNDARY  the last hop would be an external side effect nobody should
//             cause from a test. Everything up to it runs; the reason is
//             recorded on the scenario itself.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { DOMAINS, actionsOf, find } = require('../electron/mcp/agent/registry.js');
// Requiring the set REGISTERS the scenarios. It does not run them: registration
// and execution were split so this file can audit coverage without spending
// several minutes booting rigs.
require('./support/mcpScenarioSet.js');
const { all: allScenarios, get: getScenario } = require('./support/mcpOperationScenarios.js');

const registryKeys = [];
for (const domain of DOMAINS) for (const action of actionsOf(domain)) registryKeys.push(`${domain}.${action}`);

const scenarioKeys = allScenarios().map((s) => `${s.domain}.${s.action}`);

check('the registry still reports operations', registryKeys.length > 0, String(registryKeys.length));
check('scenarios are registered', scenarioKeys.length > 0, String(scenarioKeys.length));

// ── the two directions of drift ────────────────────────────────────────────

const missing = registryKeys.filter((k) => !scenarioKeys.includes(k));
check(
  'EVERY registry operation has an executable scenario',
  missing.length === 0,
  missing.length
    ? `${missing.length} operation(s) in registry.js with no scenario:\n      ${missing.join('\n      ')}\n    Add one to test/support/mcpScenarioSet.js — it must carry a run() that drives the operation through a real MCP client.`
    : ''
);

const ghosts = scenarioKeys.filter((k) => !registryKeys.includes(k));
check(
  'no scenario names an operation the registry does not have',
  ghosts.length === 0,
  ghosts.length ? `${ghosts.join(', ')} — renamed or removed from registry.js, so the scenario is describing something that no longer exists` : ''
);

// ── every scenario carries the code that earns it ──────────────────────────
//
// Belt and braces: the registry rejects a run-less scenario at construction, so
// this can only fail if that guard is ever weakened. It is cheap and it names
// the invariant.
const uncallable = allScenarios().filter((s) => typeof s.run !== 'function');
check('every scenario carries an executable run()', uncallable.length === 0, uncallable.map((s) => `${s.domain}.${s.action}`).join(', '));

const badGrade = allScenarios().filter((s) => s.grade !== 'full' && s.grade !== 'boundary');
check('every scenario is graded full or boundary', badGrade.length === 0, badGrade.map((s) => `${s.domain}.${s.action}:${s.grade}`).join(', '));

const unexplained = allScenarios().filter((s) => s.grade === 'boundary' && !s.why);
check('every boundary scenario says what it stops short of', unexplained.length === 0, unexplained.map((s) => `${s.domain}.${s.action}`).join(', '));

// ── the report ─────────────────────────────────────────────────────────────

const full = allScenarios().filter((s) => s.grade === 'full');
const boundary = allScenarios().filter((s) => s.grade === 'boundary');

const risk = { read: 0, write: 0, high: 0 };
for (const domain of DOMAINS) {
  for (const action of actionsOf(domain)) {
    const entry = find(domain, action);
    if (entry && risk[entry.risk] != null) risk[entry.risk] += 1;
  }
}

if (!failures.length) {
  console.log(`  ${registryKeys.length} operations across ${DOMAINS.length} domains  [read ${risk.read} · write ${risk.write} · high ${risk.high}]`);
  console.log(`  REGISTERED   full ${full.length} · boundary ${boundary.length} · unaccounted ${missing.length}`);
  // REGISTERED IS NOT PASSING, and this file cannot tell the difference: it
  // audits the ledger without executing anything, on purpose, so that a
  // hundred-odd rigs do not have to boot to answer "is every operation
  // accounted for". Whether those scenarios actually SUCCEED is what
  // test/mcp-wire-coverage.js runs, and that is the number a coverage claim
  // has to come from. Saying "110 FULL covered" on the strength of 110
  // scenario objects existing would be the same overstatement this whole pass
  // exists to correct.
  console.log('  (registration only — run test:mcpwire for executed/passing counts)');
  for (const s of boundary) console.log(`    boundary — ${s.domain}.${s.action}: ${s.why.split('.')[0]}.`);
}

if (failures.length) {
  console.error(`\nmcp-operation-matrix: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`mcp-operation-matrix: ${checked} passed  [every operation has an executable scenario; passing is measured elsewhere]`);
