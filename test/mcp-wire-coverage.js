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
const { guardSuite } = require('./support/suiteGuard.js');
const { DOMAINS } = require('../electron/mcp/agent/registry.js');

// A HANG MUST NOT REPORT A PASS, AND THIS IS THE SUITE MOST ABLE TO HANG.
//
// It was not in suiteGuard's consumer list, which made the qualification floor
// the one long suite with no floor under it. Node exits 0 on an empty event
// loop, so a run that drains its loop part way through is recorded as a pass;
// a run that wedges while holding a socket never reaches the exit handler at
// all, which is what the deadline is for. See test/support/suiteGuard.js.
//
// The deadline is set from the measured cost: a healthy run of all 111
// scenarios is 82 seconds on this machine with a warm Astro cache, and the
// per-case bounds below cap a sick one at three kills, so a worst case is about
// half an hour. Forty-five minutes is past that and far short of "somebody
// notices tomorrow".
const suiteDone = guardSuite('mcp-wire-coverage', Number(process.env.WIRE_SUITE_TIMEOUT_MS) || 2700000);

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

// ── the watchdogs ──────────────────────────────────────────────────────────
//
// THIS SUITE HAD NO CLOCK ON IT AT ALL, AND IT IS THE ONE THAT DRIVES THE
// MUTATIONS.
//
// A hundred and eleven scenarios, every write and every high-risk operation in
// the registry among them, each one a real MCP client over real HTTP into a real
// Astro fixture — and for a handful, a real dev server. Measured on this
// machine before any of this was added: 113 checks, 82 seconds, exit 0. What
// it did not have was any answer to a single operation that stops answering: no
// per-scenario bound, and not even the suite-level `guardSuite` the other long
// suites use. The slowest single scenario, measured the same way, is under seven
// seconds — page.dynamic_paths, which boots a real Astro — so the bounds below
// sit roughly forty times above anything a healthy run does.
//
// What that costs is not the waiting. It is that a wedged operation produces NO
// DIAGNOSIS. The suite prints its counts at the end and nothing before, so a run
// that never returns names no scenario, no domain and no phase — the reader is
// left with a process, an ownedRoots array nobody can see, and a hundred and
// eleven candidates. Worse, `guardSuite`'s first lesson applies here in full: if
// the wedge happens to drain the event loop rather than hold a socket, node
// exits 0 and the qualification floor reports a PASS having run part of itself.
//
// So there are two clocks now, and neither of them is allowed to be quiet:
//
//   the SUITE deadline    (guardSuite, above) — the outer floor, which fails
//                         loudly and exits non-zero whatever else happened.
//   the PER-CASE bounds   (below) — one around bringing a scenario's rig up, one
//                         around the scenario body, one around tearing it down.
//                         Each names the scenario and the phase it killed, and
//                         each turns into an ordinary failed check, so the suite
//                         FAILS with the case named. Never a skip, never a pass.
//
// The bounds are deliberately far above anything legitimate rather than tight:
// their job is to convert "forever, anonymously" into "four minutes, named", not
// to police performance. The slowest scenario in a healthy run is printed at the
// end so the headroom stays a measured number rather than a guess.
const budgetMs = (name, fallback) => {
  const given = Number(process.env[name]);
  return Number.isFinite(given) && given > 0 ? given : fallback;
};
/** Bringing one scenario's rig up: fixture, deps clone, Astro, MCP, client. */
const START_BUDGET_MS = budgetMs('WIRE_START_TIMEOUT_MS', 240000);
/** The scenario body. A single wire call already carries its own 180s deadline. */
const RUN_BUDGET_MS = budgetMs('WIRE_CASE_TIMEOUT_MS', 240000);
/** Putting it down again: client, server, dev server, jsdom, fixture. */
const STOP_BUDGET_MS = budgetMs('WIRE_STOP_TIMEOUT_MS', 120000);
// AND A CEILING ON HOW MANY KILLS ARE WORTH COLLECTING.
//
// A wedge is almost never one scenario's own fault — a dev server that will not
// die, a port that will not free, a machine out of descriptors — so scenario N+1
// usually wedges the same way. Waiting out a hundred and ten more bounds proves
// nothing and buys hours. After this many the run stops and says how many it
// abandoned, which is itself a failure.
const KILL_CEILING = Number(process.env.WIRE_KILL_CEILING) || 3;

/** A bound that passed, carrying the scenario and the phase it was watching. */
class CaseTimeout extends Error {
  constructor(label, ms) {
    super(`${label} was still going after ${ms}ms, so the watchdog ended the wait`);
    this.name = 'CaseTimeout';
    this.label = label;
    this.ms = ms;
  }
}

/**
 * Put a clock on one awaited step.
 *
 * Returns the raced promise and the watchdog's own state. `fired` is set
 * SYNCHRONOUSLY inside the timer, before the rejection, precisely so that a
 * handler on the underlying promise can ask — whenever it finally settles —
 * whether anybody is still waiting for it. That is how a rig that arrives after
 * its bound gets adopted and stopped rather than left running on a port.
 *
 * Nothing here can CANCEL the work: a wedged await stays wedged, holding
 * whatever it holds. What this buys is the diagnosis and the exit code, and the
 * suite deadline above is what finally ends the process if the wreckage will not
 * let it exit on its own.
 */
const bounded = (label, ms, work) => {
  const state = { fired: false, label, ms };
  let timer = null;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => {
      state.fired = true;
      reject(new CaseTimeout(label, ms));
    }, ms);
  });
  return { state, done: Promise.race([work, bell]).finally(() => clearTimeout(timer)) };
};

/**
 * THE WATCHDOG IS A MECHANISM, SO IT IS MEASURED BEFORE IT IS RELIED ON.
 *
 * Every other check in this file fires on its own scenario. These three cannot:
 * a bound only fires on work that hangs, and a healthy run has none — so
 * `bounded` could be deleted, or its timer left unstarted, or its rejection
 * swallowed by the `finally`, and all 113 checks would still be green. That is
 * the same shape of hole this suite exists to close, one level down.
 *
 * Shrinking the real bounds to a millisecond is NOT a substitute, and finding
 * that out is why this is here. `WIRE_STOP_TIMEOUT_MS=1` over the whole set
 * killed nothing: `rig.stop()` runs as a chain of already-resolved awaits and
 * blocking synchronous fs work, and microtasks are drained before the timer
 * phase is reached, so the bell never gets a turn. Measured directly: fifty
 * `await Promise.resolve()` beat a 1ms timer; one `setTimeout(50)` did not. So
 * the bound catches a step that WAITS — a socket that never closes, a dev server
 * that never exits, a call that never answers, which is the whole failure mode —
 * and cannot catch a blocked event loop, which nothing in this process could.
 *
 * So the three properties are asserted against work whose shape is chosen here:
 *
 *   it FIRES on a step that never settles, and names the step
 *   it does NOT fire on a step that finishes inside its bound  (no false kills)
 *   it passes a real failure through as itself, not as a timeout
 */
async function watchdogsWork() {
  const label = 'a step that never settles';
  const bound = 150;

  const hangs = bounded(label, bound, new Promise(() => {}));
  const startedAt = Date.now();
  let fired = null;
  try {
    await hangs.done;
  } catch (err) {
    fired = err;
  }
  const elapsed = Date.now() - startedAt;
  check(
    'a watchdog ends a step that never settles, and names it',
    fired instanceof CaseTimeout && fired.message.includes(label) && hangs.state.fired === true,
    fired ? `it threw ${fired?.name}: ${fired?.message}` : `nothing was thrown after ${elapsed}ms — the bound did not fire at all`
  );
  check(
    'and it ends it at its bound rather than waiting it out',
    elapsed >= bound && elapsed < bound * 20,
    `bound ${bound}ms · ended after ${elapsed}ms`
  );

  // A HEALTHY STEP MUST NOT BE KILLED. Without this the bound could be a
  // constant `reject` and the check above would still pass, while every scenario
  // in the set was reported as a watchdog kill.
  const quick = bounded('a step that finishes', 5000, (async () => 'finished')());
  let quickValue = null;
  let quickError = null;
  try {
    quickValue = await quick.done;
  } catch (err) {
    quickError = err;
  }
  check(
    'a watchdog leaves a step that finishes inside its bound alone',
    quickValue === 'finished' && quick.state.fired === false && !quickError,
    `value ${JSON.stringify(quickValue)} · fired ${quick.state.fired} · error ${quickError?.message || 'none'}`
  );

  // AND A REAL FAILURE IS STILL A REAL FAILURE. A race that turned every
  // rejection into a CaseTimeout would report "the watchdog killed it" for a
  // scenario that failed honestly in forty milliseconds, and the reader would go
  // looking for a hang that never happened.
  const boom = new Error('the operation refused');
  const failing = bounded('a step that fails', 5000, Promise.reject(boom));
  let passedThrough = null;
  try {
    await failing.done;
  } catch (err) {
    passedThrough = err;
  }
  check(
    'a watchdog passes a real failure through as itself, not as a timeout',
    passedThrough === boom && failing.state.fired === false,
    `caught ${passedThrough?.name}: ${passedThrough?.message} · fired ${failing.state.fired}`
  );
}

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
  // FIRST, AND BEFORE A SINGLE RIG IS BUILT. Everything below depends on these
  // bounds to turn a wedge into a named failure; if they do not work, the run
  // that most needs them is the one that will not report it. So this stops the
  // run rather than counting a failure and carrying on into a hundred and eleven
  // unbounded rigs — the exact situation the bounds were added to end.
  const soundBefore = failures.length;
  await watchdogsWork();
  if (failures.length !== soundBefore) {
    console.error(
      `\nmcp-wire-coverage: the per-case watchdog does not work, so no scenario can be bounded.\n${failures.slice(soundBefore).join('\n')}`
    );
    process.exit(1);
  }

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

  /** Every scenario a watchdog ended, and in which phase. */
  const killedCases = [];
  /** Scenarios never attempted because the run stopped at the kill ceiling. */
  let abandoned = [];
  /** How long each scenario took, so the headroom above stays measured. */
  const took = new Map();
  /** Rigs that turned up after their start bound, and the promise of their end. */
  const orphanDisposals = [];

  for (let index = 0; index < order.length; index += 1) {
    const s = order[index];
    const key = `${s.domain}.${s.action}`;
    // THE CEILING IS ASKED HERE, BEFORE A RIG IS BUILT, so a kill in ANY of the
    // three phases counts — including one in teardown, which happens after this
    // scenario's own verdict has already been recorded.
    if (killedCases.length >= KILL_CEILING) {
      abandoned = order.slice(index).map((rest) => `${rest.domain}.${rest.action}`);
      break;
    }
    const startedAt = Date.now();
    let rig = null;
    try {
      // THE RIG START IS BOUNDED TOO, AND IT IS THE MOST LIKELY PLACE TO WEDGE.
      //
      // It clones a 154MB node_modules, probes and binds a port, boots a real
      // Astro dev server for some scenarios and connects an MCP client — every
      // one of which has hung on somebody's machine at some point. A bound here
      // is worth more than one around the body.
      const starting = startWireRig({ withDeps: s.needs === 'deps', realDevServer: s.needs === 'server' });
      const startGuard = bounded(`${key} · bringing its rig up`, START_BUDGET_MS, starting);
      // A RIG THAT ARRIVES AFTER ITS BOUND IS STILL A RIG.
      //
      // It has a server on a port, a client, a jsdom and a fixture on disk, and
      // the `finally` below will never see it because `rig` stayed null. Left
      // alone it is exactly the leak the residue check at the end exists to
      // catch — and the leak would be blamed on the product rather than on this
      // watchdog. So a late rig is adopted here: counted in `ownedRoots` so the
      // accounting stays honest, and its disposal parked where the run waits for
      // it before it asks about residue.
      orphanDisposals.push(
        starting.then(
          (late) => {
            if (!startGuard.state.fired || !late) return null;
            ownedRoots.push(late.root);
            return Promise.resolve(late.stop?.()).catch(() => null);
          },
          () => null
        )
      );
      try {
        rig = await startGuard.done;
      } catch (err) {
        // Only a WATCHDOG kill becomes a per-case failure here. Every other
        // start failure still throws and takes the run down, exactly as it did
        // before: a rig that refuses to build is not a result about an
        // operation, and dressing it up as one hides it behind a hundred others.
        if (!(err instanceof CaseTimeout)) throw err;
        killedCases.push(`${key} (bringing its rig up, ${START_BUDGET_MS}ms)`);
        const detail = `WATCHDOG killed ${key}: ${err.message}. The rig never came up, so the operation was never reached.`;
        results.set(key, { good: false, detail });
        check(`${key} [${s.grade}] through the wire`, false, detail);
        console.error(`  ${detail}`);
        continue;
      }
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
      // THE BODY, ON A CLOCK, AND THE CLOCK NAMES THE SCENARIO.
      //
      // `s.run` is where the operation under test is actually invoked, so this
      // is the bound that turns "the qualification floor never came back" into
      // "page.dynamic_paths was still going after 240000ms". The async wrapper is
      // not decoration: `s.run` may throw synchronously, and a synchronous throw
      // would otherwise escape the race entirely.
      const running = (async () => s.run({ call: watched, tool: rig.tool, ref, fixture }))();
      const runGuard = bounded(`${key} · running its scenario`, RUN_BUDGET_MS, running);
      try {
        raw = await runGuard.done;
      } catch (err) {
        if (err instanceof CaseTimeout) {
          killedCases.push(`${key} (running its scenario, ${RUN_BUDGET_MS}ms)`);
          verdict = {
            good: false,
            detail:
              `WATCHDOG killed ${key}: ${err.message}. ` +
              `The operation was invoked ${subject.count} time(s) and never settled — nothing is proven about it, ` +
              'and whatever it is still holding outlives the fixture it was holding it in.',
          };
          console.error(`  ${verdict.detail}`);
        } else {
          verdict = { good: false, detail: `threw: ${String(err?.message || err).slice(0, 240)}` };
        }
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
      results.set(key, verdict);
      check(`${key} [${s.grade}] through the wire`, verdict?.good === true, verdict?.detail || '');
    } finally {
      took.set(key, Date.now() - startedAt);
      // Owned, so it goes. A rig that will not stop is a leak, not a detail —
      // and now it says which part of itself it could not put down, rather than
      // deleting the fixture out from under a server that is still serving.
      //
      // AND TEARDOWN IS A PLACE THAT HANGS. `stop()` closes an MCP client, stops
      // an HTTP server, asks main's own `dev:stop` to put a real Astro process
      // down and shuts an esbuild service — a wedge in any of those wedges the
      // suite in the one phase where a scenario has already passed, which is the
      // most confusing possible place to lose the run. So it is bounded like the
      // other two, and a bound that passes is a failed check naming the case.
      if (rig) {
        const stopping = (async () => (await rig.stop()) || { problems: [] })();
        const stopGuard = bounded(`${key} · tearing its fixture down`, STOP_BUDGET_MS, stopping);
        stopping.catch(() => {});
        let problems = [];
        try {
          ({ problems } = await stopGuard.done);
        } catch (err) {
          if (err instanceof CaseTimeout) killedCases.push(`${key} (tearing its fixture down, ${STOP_BUDGET_MS}ms)`);
          problems = [err instanceof CaseTimeout ? `WATCHDOG killed the teardown: ${err.message}` : `stop() threw: ${String(err?.message || err).slice(0, 240)}`];
        }
        if (problems.length) {
          check(`${key} tore its fixture down cleanly`, false, problems.join('; '));
        }
      }
    }
  }

  console.log(`  scenarios registered: ${scenarioCount()}  (order: ${mode}, fresh fixture each)`);
  console.log(`  scenarios run:        ${results.size}`);

  // NOT ONE WATCHDOG FIRED — asserted, not inferred from the absence of noise.
  //
  // Every kill above is already a failed check on its own scenario, and this is
  // deliberately a second one: it is the line a reader sees first, it names all
  // of them together, and it is what makes a kill impossible to read as a slow
  // but healthy run. A watchdog that fires makes this suite FAIL. It never
  // skips the case and never passes it.
  check(
    'no scenario had to be ended by a watchdog',
    killedCases.length === 0,
    killedCases.length ? `ended by a watchdog: ${killedCases.join('; ')}` : ''
  );
  // AND THE RUN WAS NOT CUT SHORT. Stopping at the kill ceiling is the right
  // thing to do and it is still an incomplete run, so it is stated rather than
  // left to be inferred from the count above.
  check(
    'the run was not abandoned part way',
    abandoned.length === 0,
    abandoned.length
      ? `stopped after ${killedCases.length} watchdog kill(s); ${abandoned.length} scenario(s) never attempted, starting at ${abandoned[0]}`
      : ''
  );

  // THE HEADROOM, MEASURED. The bounds above are only defensible next to what a
  // healthy run actually costs, and that number moves as fixtures and machines
  // change — so it is printed every run rather than written into a comment once.
  const slowest = [...took.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (slowest.length) {
    console.log(
      `  slowest scenarios:    ${slowest.map(([k, v]) => `${k} ${v}ms`).join(' · ')}` +
        `  (bounds: start ${START_BUDGET_MS}ms, run ${RUN_BUDGET_MS}ms, stop ${STOP_BUDGET_MS}ms)`
    );
  }

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

  // A LATE RIG IS WAITED FOR BEFORE RESIDUE IS ASKED ABOUT.
  //
  // Otherwise the watchdog manufactures the very leak the next check looks for:
  // a fixture whose disposal was still in flight when the question was put reads
  // as a directory left behind, and gets reported as a product failure. Bounded,
  // because a rig that would not come up in time is not obviously one that will
  // go down in time either.
  if (orphanDisposals.length) {
    try {
      await bounded(`${orphanDisposals.length} late rig(s) · being put down`, STOP_BUDGET_MS, Promise.all(orphanDisposals)).done;
    } catch (err) {
      check('every rig that arrived after its bound was put down', false, String(err?.message || err));
    }
  }

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

  // The suite reached its own end. Anything else — an unsettled await, a killed
  // process, an exit on an empty event loop — leaves this uncalled and the exit
  // code non-zero. See test/support/suiteGuard.js.
  suiteDone();

  if (failures.length) {
    console.error(`\nmcp-wire-coverage: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-wire-coverage: ${checked} passed  [official client -> MCP -> Agent API -> fixture]`);
})().catch((err) => {
  console.error('mcp-wire-coverage threw\n', err);
  process.exit(1);
});
