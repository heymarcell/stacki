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
// BOUNDARY used to mean "the operation is expected not to complete". That is
// no longer true and the old wording was hiding something better: git.publish
// now runs its REAL production handler all the way to the external program and
// returns a real successful result — only the `gh` binary at the very end is a
// test-owned double, verified to be the thing that answered.
//
// So BOUNDARY means: the production implementation is executed through the last
// controllable local seam, and the external side-effect provider is replaced by
// a fail-closed double. It must prove the registered operation ran, that the
// real path reached the seam, that the genuine external provider could not be
// reached, and what intent arrived there. A mock buried inside Stacki is not a
// boundary; the seam has to be the edge of the world.

const GRADES = new Set(['full', 'boundary']);

/** Every registered scenario, keyed `domain.action`. */
const scenarios = new Map();

// 'deps'   the project's node_modules, so its content config can be bundled
// 'server' those, and a real dev server the app may start — kept separate
//          because starting Astro in every fixture that merely needs to read a
//          config costs a process and a port per scenario, and fourteen of them
//          contending over ports is how a working lifecycle times out.
const NEEDS = new Set(['deps', 'server']);

function register(spec) {
  const { domain, action, grade, why, run, needs = null } = spec || {};
  const where = `${domain || '?'}.${action || '?'}`;

  if (typeof domain !== 'string' || !domain) throw new Error(`scenario(${where}): domain must be a non-empty string`);
  if (typeof action !== 'string' || !action) throw new Error(`scenario(${where}): action must be a non-empty string`);
  if (!GRADES.has(grade)) throw new Error(`scenario(${where}): grade must be 'full' or 'boundary', got ${JSON.stringify(grade)}`);
  if (typeof run !== 'function') throw new Error(`scenario(${where}): run must be a function — coverage cannot be declared, only executed`);
  if (grade === 'boundary' && (typeof why !== 'string' || why.trim().length < 20)) {
    throw new Error(`scenario(${where}): a boundary scenario must explain in 'why' what external effect it stops short of`);
  }
  // What the fixture has to BE for the scenario to mean anything. Only one
  // kind so far — `deps`, a project with its node_modules really installed,
  // without which no content question can be answered at all. Declared rather
  // than assumed, so a runner that cannot supply it can say so instead of
  // grading the operation on the refusal it gets back.
  if (needs !== null && !NEEDS.has(needs)) {
    throw new Error(`scenario(${where}): needs must be one of ${[...NEEDS].join(', ')}, got ${JSON.stringify(needs)}`);
  }
  const key = `${domain}.${action}`;
  if (scenarios.has(key)) throw new Error(`scenario(${key}): registered twice`);

  scenarios.set(key, { domain, action, grade, why: why || null, run, needs });
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
function judgeFull(out, subject) {
  // THE RECORDER IS NOT OPTIONAL. `if (subject)` made the core invariant
  // something a caller could opt out of by forgetting an argument, which is
  // the same permissiveness this file has already had to remove twice.
  if (!subject || typeof subject !== 'object' || typeof subject.key !== 'string') {
    return { good: false, detail: 'judgeFull was called without a subject record — a FULL verdict cannot be reached without knowing what the runner actually invoked' };
  }
  if (!out || typeof out !== 'object') return { good: false, detail: 'the scenario returned nothing' };
  const { envelope, checks } = out;

  // BOUND TO THE SUBJECT, not to whatever the scenario handed back.
  //
  // A scenario runs setup calls, the operation under test, and often a read to
  // prove the postcondition. Trusting it to return the right one of those is
  // trusting the author to have been careful — and the whole point of this file
  // is to stop relying on that. `subject` is what the runner RECORDED for the
  // registered domain.action, so a scenario that accidentally returns a
  // successful setup envelope while its own operation failed cannot pass.
  if (!subject.invoked) {
    return { good: false, detail: `${subject.key} was never invoked — the scenario ran, but not the operation it is registered for` };
  }
  // EXACTLY ONE. Not "at least one": a scenario that calls its own subject
  // twice can have the first fail and the second succeed, return the second,
  // and look green. Setup and read-back belong to OTHER operations.
  if (subject.count !== 1) {
    return { good: false, detail: `${subject.key} was invoked ${subject.count} times; a FULL scenario makes exactly one subject call, so a failing first attempt cannot be papered over by a second. Use other operations for setup and read-back.` };
  }
  if (subject.envelope !== envelope) {
    return { good: false, detail: `the judged envelope is not the one ${subject.key} returned — a setup or read answer was handed back instead` };
  }

  if (!envelope || typeof envelope !== 'object') {
    return { good: false, detail: 'the operation under test produced no structuredContent — it was never invoked, or it answered isError' };
  }
  if (envelope.ok !== true) {
    return { good: false, detail: `the operation refused rather than succeeded: ${JSON.stringify(envelope).slice(0, 220)}` };
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    return { good: false, detail: 'FULL needs at least one postcondition; an envelope on its own proves reachability, not behaviour' };
  }

  // STRICT SHAPES. A Promise is truthy, and an unawaited postcondition that
  // silently counts as "held" is a test that proves nothing while looking
  // rigorous. So the label must be a real string and the result must be an
  // actual boolean — not truthy, boolean.
  for (const [i, entry] of checks.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return { good: false, detail: `check ${i} is not a [label, boolean] pair` };
    }
    const [label, held] = entry;
    if (typeof label !== 'string' || !label.trim()) {
      return { good: false, detail: `check ${i} has no label` };
    }
    if (typeof held !== 'boolean') {
      return { good: false, detail: `check "${label}" is ${held instanceof Promise ? 'a Promise — it was probably not awaited' : `a ${typeof held}`}, not a boolean` };
    }
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
