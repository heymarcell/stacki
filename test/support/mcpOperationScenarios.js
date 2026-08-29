// What it takes to claim an Agent operation is covered.
//
// This file has been wrong twice, in the same direction, and both corrections
// are worth keeping in view because the failure mode is subtle.
//
// FIRST it held a hand-typed `COVERED` set. That proved every action had been
// CATEGORISED and nothing else: type a string into a Set and the ledger reports
// coverage whether or not a byte ever crossed the wire. So coverage stopped
// being declared and started being registered, with the callable that produces
// it required at construction.
//
// THEN it turned out a registered scenario could still prove almost nothing.
// The permissive helper accepted `ok: false` — a refusal is a well-formed
// envelope — so sixty-one of a hundred and seven FULL scenarios were really
// asserting "the operation is reachable and its errors are shaped correctly".
// That is worth knowing and it is not what FULL says.
//
// So FULL now has a contract the framework enforces rather than a convention a
// reviewer has to notice:
//
//   the operation under test must ANSWER — structuredContent, not an isError
//   the answer must SUCCEED — ok === true
//   and at least one POSTCONDITION specific to that operation must hold,
//   checked outside the envelope wherever the operation leaves a trace
//
// A scenario that cannot supply a postcondition is not FULL. There is no
// grade between them and there is deliberately no way to opt out.
//
// BOUNDARY is for one thing only: an operation whose last hop would be an
// external side effect nobody should cause from a test. It runs everything up
// to that hop, and it says on itself what it stopped short of.

const GRADES = new Set(['full', 'boundary']);

/** Every registered scenario, keyed `domain.action`. */
const scenarios = new Map();

function register(spec) {
  const { domain, action, grade, why, run } = spec || {};
  const where = `${domain || '?'}.${action || '?'}`;

  if (typeof domain !== 'string' || !domain) throw new Error(`scenario(${where}): domain must be a non-empty string`);
  if (typeof action !== 'string' || !action) throw new Error(`scenario(${where}): action must be a non-empty string`);
  if (!GRADES.has(grade)) throw new Error(`scenario(${where}): grade must be 'full' or 'boundary', got ${JSON.stringify(grade)}`);
  if (typeof run !== 'function') throw new Error(`scenario(${where}): run must be a function — coverage cannot be declared, only executed`);
  if (grade === 'boundary' && (typeof why !== 'string' || why.trim().length < 20)) {
    throw new Error(`scenario(${where}): a boundary scenario must explain in 'why' what external effect it stops short of`);
  }
  const key = `${domain}.${action}`;
  if (scenarios.has(key)) throw new Error(`scenario(${key}): registered twice`);

  scenarios.set(key, { domain, action, grade, why: why || null, run });
  return scenarios.get(key);
}

/**
 * A FULL scenario.
 *
 * `run` must return `{ envelope, checks }`:
 *
 *   envelope  what the operation under test answered, straight from
 *             structuredContent. The framework requires `ok === true`.
 *   checks    `[[label, boolean], …]` — at least one, all true. This is the
 *             postcondition: what is true about the world now that was not
 *             before, or what the answer actually contained.
 *
 * Returning the envelope alone is not enough, and there is no flag that makes
 * it enough. That is the whole point of the shape.
 */
const fullScenario = (spec) => register({ ...spec, grade: 'full' });

/**
 * A BOUNDARY scenario.
 *
 * `run` returns `{ good, detail }`. The operation is expected NOT to complete —
 * that is what the boundary means — so a truthful refusal at the external hop
 * is a pass, and `why` has to say which hop.
 */
const boundaryScenario = (spec) => register({ ...spec, grade: 'boundary' });

/**
 * Judge one FULL result. Exported so the runner and the matrix agree, and so
 * the contract lives in one place rather than in whoever wrote the loop.
 */
function judgeFull(out) {
  if (!out || typeof out !== 'object') return { good: false, detail: 'the scenario returned nothing' };
  const { envelope, checks } = out;
  if (!envelope || typeof envelope !== 'object') {
    return { good: false, detail: 'the operation under test produced no structuredContent — it was never invoked, or it answered isError' };
  }
  if (envelope.ok !== true) {
    return { good: false, detail: `the operation refused rather than succeeded: ${JSON.stringify(envelope).slice(0, 220)}` };
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    return { good: false, detail: 'FULL needs at least one postcondition; an envelope on its own proves reachability, not behaviour' };
  }
  const failed = checks.filter(([, held]) => !held).map(([label]) => label);
  if (failed.length) return { good: false, detail: `postcondition failed: ${failed.join('; ')}` };
  return { good: true, detail: '', evidence: checks.map(([label]) => label) };
}

const coveredKeys = () => [...scenarios.keys()];
const byGrade = (grade) => [...scenarios.values()].filter((s) => s.grade === grade);
const get = (domain, action) => scenarios.get(`${domain}.${action}`) || null;
const all = () => [...scenarios.values()];
const size = () => scenarios.size;
const reset = () => scenarios.clear();

module.exports = { fullScenario, boundaryScenario, judgeFull, scenarios, coveredKeys, byGrade, get, all, size, reset, GRADES };
