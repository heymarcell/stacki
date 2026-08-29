// What it takes to claim an Agent operation is covered.
//
// The first version of the coverage ledger held a hand-typed `COVERED` set.
// That could prove every registry action had been CATEGORISED, and nothing
// else: once somebody types `'target.read'` into a Set, the ledger reports
// coverage whether or not a single byte ever crossed the wire. Coverage that
// can be asserted by typing is paperwork.
//
// So coverage is not declared here. It is REGISTERED, and a registration
// without an executable `run` is rejected at load time — there is no shape a
// scenario can take that claims coverage without carrying the code that
// produces it.
//
// Two honest grades, and the difference is never blurred in a report:
//
//   FULL      a real MCP client reached the real implementation and a
//             meaningful result or state transition was checked.
//
//   BOUNDARY  the operation would cause an external side effect nobody should
//             cause from a test — publishing a repository, pushing to somebody
//             else's remote. The MCP schema, the permission gate, the argument
//             validation and the dispatch are all exercised; the last hop is
//             deliberately not taken. A BOUNDARY scenario still RUNS.
//
// There is no third grade. An operation with no scenario fails the matrix.

const GRADES = new Set(['full', 'boundary']);

/** Every registered scenario, keyed `domain.action`. */
const scenarios = new Map();

/**
 * Register one executable scenario.
 *
 * Throws rather than returns: a malformed scenario is a broken test file, and
 * the failure belongs at load time where the stack points at the offender —
 * not later, as a mysteriously absent key.
 */
function scenario(spec) {
  const { domain, action, grade, why, run } = spec || {};
  const where = `${domain || '?'}.${action || '?'}`;

  if (typeof domain !== 'string' || !domain) throw new Error(`scenario(${where}): domain must be a non-empty string`);
  if (typeof action !== 'string' || !action) throw new Error(`scenario(${where}): action must be a non-empty string`);
  if (!GRADES.has(grade)) throw new Error(`scenario(${where}): grade must be 'full' or 'boundary', got ${JSON.stringify(grade)}`);
  // THE POINT OF THE FILE: no callable, no coverage. There is no way to
  // register a claim without the code that backs it.
  if (typeof run !== 'function') throw new Error(`scenario(${where}): run must be a function — coverage cannot be declared, only executed`);
  // A boundary scenario is a deliberate exception and has to say why in the
  // place a reader will look, not in a commit message.
  if (grade === 'boundary' && (typeof why !== 'string' || why.trim().length < 20)) {
    throw new Error(`scenario(${where}): a boundary scenario must explain in 'why' what external effect it stops short of`);
  }
  const key = `${domain}.${action}`;
  if (scenarios.has(key)) throw new Error(`scenario(${key}): registered twice`);

  scenarios.set(key, { domain, action, grade, why: why || null, run });
  return scenarios.get(key);
}

/** The keys the matrix compares against registry.js. Derived, never typed. */
const coveredKeys = () => [...scenarios.keys()];
const byGrade = (grade) => [...scenarios.values()].filter((s) => s.grade === grade);
const get = (domain, action) => scenarios.get(`${domain}.${action}`) || null;
const all = () => [...scenarios.values()];
const size = () => scenarios.size;

/** For tests that need a clean slate (the registry's own unit checks). */
const reset = () => scenarios.clear();

module.exports = { scenario, scenarios, coveredKeys, byGrade, get, all, size, reset, GRADES };
