// The audit, given up on.
//
//   node test/audit-cancel.js
//
// An audit is the one operation in this surface long enough for the caller to
// go away in the middle of it: six viewports is six page loads and six
// injections of a 580 KB engine, and a host tool-timeout or a disconnected
// client lands squarely inside that. Until this suite the engine could not be
// told. `docs/mcp-compatibility.md` recorded the consequence honestly as
// "Cancellation on a closed stream — UNSUPPORTED — an audit in flight runs to
// completion", and the cost was not only the wasted work: audits are
// serialised, so every audit queued behind an abandoned one waited for it.
//
// The seam is real and it was already being handed to the handler. A tool
// callback's second argument carries `mcpReq.signal`, a live AbortSignal the
// SDK aborts when the request goes away; electron/mcp/auditTool.js used to
// declare one parameter and drop it.
//
// WHAT THIS FILE USED TO BE ABLE TO PROVE, AND WHY THAT WAS NOT ENOUGH.
//
// The first version of this suite drove the engine with a window whose
// `loadURL` was `async () => {}`, whose `did-finish-load` arrived on the next
// tick and whose `executeJavaScript` and `capturePage` answered instantly. On
// such a window a run reaches the next checkpoint in microseconds, so an engine
// that only ever reads `signal.aborted` BETWEEN viewports looks identical to
// one that interrupts the await it is sitting on. It reported "27 passed" in
// 2.9 seconds against a build where a real abort during a hanging load took
// 39,582ms to answer, and answered `audit_failed` with a timeout it had caused
// itself rather than saying it had been cancelled at all.
//
// So every window here BLOCKS on a promise the test owns, and the abort
// assertions are two-part: the run answered `cancelled`, and it answered while
// that promise was STILL UNRESOLVED. A checkpoint-only engine cannot satisfy
// the second half — it has to wait the gate out — and the wall-clock deadline
// on each case turns that wait into a red line rather than a slow suite.
//
// WHAT IS STILL NOT PROVEN HERE. That destroying the window is what releases a
// real renderer, and that any of this survives a real MCP transport. Both are
// wall-clock claims about Chromium and a socket, and they are measured in
// test/audit-cancel-inflight.js against real Electron and the official client.
// This suite is the fast control-flow half.
//
// WHAT THIS ASSERTS, and each one is refusal-shaped so a surface that cancelled
// everything would fail the positive controls:
//
//   nothing starts        an already-aborted request opens NO window
//   nothing queued starts a run abandoned while queued opens no window either,
//                         the run in front of it still finishes, AND its own
//                         refusal arrives before that run does
//   it interrupts         an abort during a load, and during a probe, answers
//                         while the operation is still outstanding
//   it says how far it got a run abandoned after one viewport says one viewport
//   nothing leaks         liveWindowCount() is 0 on every path out
//   nothing is inherited  the audit session is CLEARED on every path out, and
//                         the last thing to happen to the shared partition is
//                         always a clear rather than a page load — the property
//                         `sessionIsolated` claims, read off a double that
//                         models the state rather than counting nothing
//   too late is harmless  aborting after the run finished changes nothing
//   nothing is unbounded  including the reset on the way OUT, which was the one
//                         await on the cancel path with no bound of any kind:
//                         driven with a `clearStorageData` that never settles,
//                         on an ordinary run and on a cancelled one, and a
//                         reset that times out is REPORTED rather than swallowed
//   an abandoned clear is not a finished one
//                         a time box stops the WAITING, not the clear, so the
//                         audit behind one that timed out refuses at the door
//                         rather than measuring a partition that clear may wipe
//                         underneath it -- and the audit after it lands is
//                         measured normally, so the refusal is not permanent
//   nothing leaks a listener
//                         counted with `getEventListeners`, the reading that
//                         works on an EventTarget, with a canary that proves the
//                         count can move before it is asked to mean anything
//   the wire carries it   the real MCP tool handler passes the SDK's signal to
//                         the engine, rather than the engine being told by a
//                         test that reaches past it

const { getEventListeners } = require('node:events');

const { createAudit, liveWindowCount } = require('../electron/mcp/audit');
const { guardSuite } = require('./support/suiteGuard.js');

// AN EXIT CODE THAT IS NOT A REPORT IS NOT A PASS.
//
// Every abort case here holds a promise that the engine is supposed to stop
// waiting for. A build that does NOT stop waiting for it leaves this process
// with an empty event loop and no pending handle — and node's answer to an
// empty event loop is to exit ZERO, silently, having printed nothing. That is
// the exact false green this suite exists to prevent, and it is how the first
// run of one of its own mutations came back "passed" with no output at all.
//
// So: nothing but the report at the bottom may end this process cleanly, and a
// run that takes longer than any of its cases could legitimately take is a
// failure rather than a wait. The guard was written here first and now lives in
// test/support/suiteGuard.js, so the other suites that need it get this one
// rather than a fourth paraphrase of it.
const suiteDone = guardSuite('audit-cancel', 180000);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => {
  try {
    return typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v)?.slice(0, 300);
  } catch {
    return String(v);
  }
};

// HOW LONG A CANCELLED RUN MAY TAKE TO ANSWER, in this process, with no browser
// in it. The engine's own budgets are 20,000ms for a load and 30,000ms for a
// probe, so a build that waits its gate out lands an order of magnitude outside
// this rather than merely near it. Generous enough for a loaded machine.
const ANSWER_BY_MS = 3000;

const AXE = { violations: [], incomplete: [], passCount: 0, inapplicableCount: 0, version: '4.13.0', knownRuleIds: [] };

/**
 * A promise the test opens by hand.
 *
 * `released()` is read at the moment the audit ANSWERS, which is the whole
 * oracle: a run that came back while its own load was still outstanding
 * interrupted that load, and a run that waited for it did not.
 */
function gate(name) {
  let open = () => {};
  let released = false;
  const promise = new Promise((res) => {
    open = res;
  });
  // Nobody may await a gate that is never released; the engine races it.
  promise.catch(() => {});
  return {
    name,
    promise,
    released: () => released,
    release: (value) => {
      released = true;
      open(value);
    },
  };
}

/**
 * Wait for something to become true, ON THE CLOCK.
 *
 * Every other wait in this file spins on `setImmediate`, which is right when the
 * thing being waited for is a microtask away. It is WRONG when a real timer
 * stands in front of it: the engine sleeps `SETTLE_MS` (250ms) after every page
 * load, and five thousand immediates go by in a fraction of that — so a spin
 * that "waits for the run to reach its overflow probe" fell straight through
 * with nothing blocked, and the case went on to release its stray at a moment
 * of the loop's choosing rather than the one it names. Bounded in milliseconds,
 * and it reports whether the condition actually came true rather than assuming
 * it did.
 */
const until = async (condition, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return !!condition();
};

/**
 * A window that counts itself AND blocks where a real one blocks.
 *
 * `gateFor(phase, nth)` is asked before every operation the engine awaits on
 * this window — 'load', 'freeze', 'settle', 'overflow', 'axe', 'capture' — and
 * a gate it hands back holds that operation open until the test releases it.
 *
 * `destroy()` rejects everything still outstanding, which is what a destroyed
 * webContents does: Electron rejects the loadURL, executeJavaScript and
 * capturePage in flight on a frame it has disposed. A fake that resolved them
 * instead, or left them pending for ever, would make the engine look cancelled
 * for a reason the real browser does not supply.
 */
function controlledWindows(log, { onOpen = null, gateFor = () => null } = {}) {
  return class FakeWindow {
    constructor() {
      log.opened += 1;
      const nth = log.opened;
      this.destroyed = false;
      // Every operation this window handed out that has not answered yet.
      const outstanding = new Set();
      this.rejectOutstanding = () => {
        for (const reject of [...outstanding]) reject(new Error('Object has been destroyed'));
        outstanding.clear();
      };
      const held = (phase, value) => {
        const g = gateFor(phase, nth);
        if (!g) return Promise.resolve(value);
        log.blockedOn.push(phase);
        return new Promise((resolve, reject) => {
          outstanding.add(reject);
          g.promise.then(
            () => {
              outstanding.delete(reject);
              resolve(value);
            },
            (err) => {
              outstanding.delete(reject);
              reject(err);
            }
          );
        });
      };
      this.held = held;
      let finishLoad = null;
      this.webContents = {
        on: () => {},
        once: (event, fn) => {
          // The load event follows the load, and only if the load was allowed
          // to finish: a gated load that is never released never fires it,
          // exactly as a page that never finishes streaming never does.
          if (event === 'did-finish-load') finishLoad = fn;
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: (src) => {
          const phase =
            typeof src === 'string' && src.includes('culpritTotal')
              ? 'overflow'
              : typeof src === 'string' && src.includes('axe.run')
                ? 'axe'
                : typeof src === 'string' && src.includes('axe.configure')
                  ? 'axe'
                  : typeof src === 'string' && src.length > 100000
                    ? 'axe'
                    : typeof src === 'string' && src.includes('readyState')
                      ? 'settle'
                      : 'freeze';
          const answer =
            phase === 'overflow'
              ? { viewportWidth: 375, documentScrollWidth: 375, overflowBy: 0, overflows: false, culprits: [], culpritTotal: 0, truncated: false }
              : phase === 'axe'
                ? AXE
                : { title: 'fake', readyState: 'complete' };
          return held(phase, answer);
        },
        getURL: () => 'http://127.0.0.1:4321/',
        // A frame with something in it, so an engine that has an encoder
        // actually reaches it. An empty frame is a different branch and a
        // different suite's business.
        capturePage: () => held('capture', { isEmpty: () => false, getSize: () => ({ width: 375, height: 700 }) }),
      };
      // Fired after the window for viewport N exists, which is how a test aborts
      // "in the middle" without racing a timer against the engine.
      if (onOpen) onOpen(nth);
      this.loadURL = () => {
        // NAVIGATING DIRTIES THE PARTITION, WHICH IS THE WHOLE POINT OF
        // CLEARING IT. A page that has begun loading may already have set a
        // cookie or written to localStorage, and on this engine's single
        // `stacki-audit` partition that state outlives the window — measured,
        // and written up at AUDIT_PARTITION in electron/mcp/audit/index.js. So
        // the double marks it here rather than on a successful load: a run
        // abandoned mid-load is exactly the case that must still clean up.
        log.session.dirty = true;
        return held('load').then((v) => {
          if (finishLoad) setImmediate(finishLoad);
          return v;
        });
      };
    }
    setContentSize() {}
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      // A DESTROY THAT WILL NOT DESTROY. Not a hypothetical: the engine's own
      // `finally` has always wrapped this call in a try/catch and left the
      // window in the registry when it threw, because "the count is the alarm".
      // If destroying the window were the ONLY thing that released a cancelled
      // run, this is the shape in which that run would still hang -- so the
      // signal is raced on every await as well, and this window is how that
      // half is proven separately.
      if (log.destroyRefusalsLeft > 0) {
        log.destroyRefusalsLeft -= 1;
        log.destroyRefused += 1;
        throw new Error('this window will not be destroyed');
      }
      this.destroyed = true;
      log.destroyed += 1;
      this.rejectOutstanding();
    }
  };
}

/**
 * The session, as a thing that can be DIRTY.
 *
 * A DOUBLE THAT COUNTS NOTHING GRADES NOTHING. This file's headline says an
 * abandoned audit "cleans up", and `audit/index.js` promises the final reset
 * runs "on every path out" — but the double here used to be three `async () =>
 * {}` no-ops, so the only cleanup any assertion could observe was the window
 * count. Measured: deleting the reset from the engine's `finally` whenever the
 * signal had aborted left the cancelled page's cookies, localStorage and auth
 * cache in the shared audit partition for the NEXT audit to read — the exact
 * thing `sessionIsolated` claims cannot happen — and this suite still reported
 * 71 passed.
 *
 * So the double models the property rather than the call. Every window that
 * navigates on the partition DIRTIES it, the way a real page setting a cookie
 * does; `clearStorageData` is what makes it clean again. `dirty` is therefore
 * not a count of calls but an ordering: it can only be false if a clear
 * happened AFTER the last page was loaded, which is what "on every path out"
 * means and what a counter alone cannot tell you.
 *
 * The shape is the one the engine asks for -- a partition factory, not a
 * session -- and it is per-log, so each case reads its own.
 */
const sessionFor = (log) => ({
  fromPartition: (name) => {
    log.session.partitions.add(name);
    return {
      clearStorageData: async () => {
        // A CLEAR THAT NEVER COMES BACK, WHICH IS WHAT THE REAL ONE CAN DO.
        //
        // `clearStorageData` is an IPC round trip to Chromium's network
        // service, not a local write, and a round trip has no guarantee of
        // returning. `log.session.holdClearFrom` makes the Nth call onwards
        // hang for ever, so the engine's bounds on this call are measurable
        // rather than merely present in the source. Counted BEFORE the hold
        // and marked clean only AFTER it: a clear that never returned did not
        // clean anything, and the double must not say it did.
        //
        // `holdClearOnly` holds exactly ONE call instead, which is what a wedged
        // IPC round trip really looks like -- that message never came back, and
        // the next one may be answered perfectly well. It is what makes the
        // audit AFTER the one that timed out observable at all: with every
        // subsequent clear hanging too, the next run merely times out again, and
        // whether it measured the page on a partition a stray clear was about to
        // wipe cannot be seen.
        //
        // `holdClearAt` holds NAMED CALLS ON GATES OF THEIR OWN, which is the
        // only way two abandoned clears can be told apart. Every case above
        // shares one gate, so releasing it releases everything held on it, and
        // "the second one landed while the first was still outstanding" -- the
        // exact sequence that let a second `strand` erase the first record --
        // cannot be posed at all. Keyed by call number, same numbering as
        // `holdClearOnly`.
        log.session.attempted += 1;
        // WHICH CALL THIS IS, held for the whole of it. Read back off
        // `attempted` after the await, a clear that hung for three more calls
        // reported itself as the LAST one -- which is precisely the clear whose
        // identity matters, and the reading that made a stray look like a
        // routine one.
        const nth = log.session.attempted;
        const at = log.session.holdClearAt[nth] || null;
        const held = at
          ? true
          : log.session.holdClearOnly
            ? nth === log.session.holdClearOnly
            : log.session.holdClearFrom && nth >= log.session.holdClearFrom;
        if (held) {
          // WHEN THE ROUND TRIP IS GENUINELY IN FLIGHT, which is the only moment
          // at which cancelling one proves anything. `attempted` moves before
          // this branch is even chosen, so a test that aborts on `attempted`
          // can be aborting on a clear that already came back; `holding` moves
          // only for a call that is really hanging.
          log.session.holding += 1;
          await (at || log.session.holdClear).promise;
        }
        log.session.storage += 1;
        log.session.dirty = false;
        // WHICH RUN THE WIPE ACTUALLY LANDED IN, which is the property the mark
        // exists to protect and the only reading that can tell "refused" from
        // "was not wiped". `liveRun` is set by the case; a case that does not
        // set it records 0 and reads nothing here.
        log.session.landed.push({ clear: nth, whileRun: log.liveRun });
      },
      clearCache: async () => {
        log.session.cache += 1;
      },
      clearAuthCache: async () => {
        log.session.auth += 1;
      },
    };
  },
});

/**
 * The run left the shared partition clean, whatever else it did.
 *
 * Called on every case that reached the engine's own try block, because that is
 * where the `finally` lives. A case that never got that far -- refused before
 * it started, or abandoned while queued -- has nothing to clean and is asserted
 * separately.
 */
const cleanedUp = (label, log) => {
  const state = () => short({ ...log.session, partitions: [...log.session.partitions] });
  check(`${label}: the audit session was cleared`, log.session.storage > 0, state());
  check(`  ${label}: cache and auth cache with it, which sit outside clearStorageData`, log.session.cache === log.session.storage && log.session.auth === log.session.storage, state());
  check(
    `  ${label}: and the LAST thing that happened to the partition was a clear, so the next audit inherits nothing`,
    log.session.dirty === false,
    `${state()} — a page was loaded on the audit partition and no reset followed it; the next audit reads this one's cookies`
  );
  check(`  ${label}: all of it on the one audit partition`, [...log.session.partitions].join() === 'stacki-audit', [...log.session.partitions].join() || 'no partition was ever asked for');
};

const THREE = [
  { width: 375, height: 700 },
  { width: 768, height: 900 },
  { width: 1280, height: 900 },
];
const ONE = [{ width: 375, height: 700 }];

const newLog = () => ({
  opened: 0,
  destroyed: 0,
  destroyRefused: 0,
  destroyRefusalsLeft: 0,
  encoded: 0,
  blockedOn: [],
  // Which run the case believes is in flight, so `landed` can say which run a
  // stray wipe arrived in. Only the cases that care set it.
  liveRun: 0,
  session: {
    storage: 0,
    cache: 0,
    auth: 0,
    attempted: 0,
    holding: 0,
    holdClearFrom: 0,
    holdClearOnly: 0,
    holdClearAt: {},
    holdClear: null,
    dirty: false,
    landed: [],
    partitions: new Set(),
  },
});

/**
 * An audit with a deadline of the TEST's own.
 *
 * A run that never answers is not a slow pass and it is not a hang to be
 * discovered by a human watching a terminal: it is a failure, and it has to
 * arrive as one, named, at a moment the suite chose.
 */
const boundDeadline = (label, promise, ms) => {
  let timer = null;
  // CLEARED WHEN THE AUDIT WINS. A deadline left running after the thing it was
  // watching has answered is a live timer, and node does not exit while one is
  // pending: the suite finished in thirty-three seconds and then sat for
  // another forty-five doing nothing, which reads from the outside exactly like
  // the hang this file exists to detect.
  const stop = (v) => {
    clearTimeout(timer);
    return v;
  };
  return Promise.race([
    promise.then((v) => stop({ answered: true, value: v })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ answered: false, value: `${label} never answered within ${ms}ms` }), ms);
    }),
  ]);
};

// EVERY ABORT CASE ANSWERS, OR FAILS BY NAME. A build that goes back to
// checkpoints does not merely miss the promptness assertion below -- it waits
// out a twenty-second load budget, or thirty seconds of probe, on every one of
// these. Left unbounded that is a suite that takes minutes to say what is wrong
// and, in the worst case, one that empties its event loop and exits zero.
const ABORT_DEADLINE_MS = 10000;
const answeredCancel = async (label, promise) => {
  const out = await boundDeadline(label, promise, ABORT_DEADLINE_MS);
  check(`${label} answers at all`, out.answered === true, short(out.value));
  return out.answered ? out.value : { ok: null, code: null, message: String(out.value) };
};

// An encoder, because without one the engine never calls capturePage at all --
// it pushes a `no_encoder` row instead, which is the right answer and is not
// the code path a capture assertion is about.
const fakeEncoder = (log) => (_image, format) => {
  log.encoded += 1;
  return { buffer: Buffer.from('not a real jpeg'), size: { width: 375, height: 700 }, format };
};

const engineWith = (log, opts = {}) =>
  createAudit({
    BrowserWindow: controlledWindows(log, opts),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: sessionFor(log),
    encodeImage: opts.encoder ? fakeEncoder(log) : null,
  });

(async () => {
  // ---- POSITIVE CONTROL -----------------------------------------------------
  // Everything below asserts that something did NOT happen. Without this, an
  // engine that refused every audit would pass the whole suite.
  {
    const log = newLog();
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [] });
    check('an audit nobody cancelled runs', res?.ok === true, short(res));
    check('  and opens one window per viewport', log.opened === 3, short(log));
    check('  and destroys every one of them', log.destroyed === 3, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
    cleanedUp('an ordinary audit', log);
    // THE SHAPE OF THE CLEARING, NAMED, so the counters below are known to be
    // reading a real sequence rather than any number above zero: once before the
    // run, once before each of the three viewports, once in the `finally`.
    check('  and clears the session five times: once before the run, once per viewport, once on the way out', log.session.storage === 5, short(log.session));
    check(
      '  and it says so in the result, which is the claim those clears support',
      res?.engine?.sessionIsolated === true,
      short(res?.engine)
    );
  }

  // ---- POSITIVE CONTROL, ON A WINDOW THAT ACTUALLY BLOCKS -------------------
  //
  // The gates below are the mechanism every abort case is measured with, so an
  // engine that treated a gated operation as a failure -- or a fake that never
  // answered one -- would pass those by refusing and fail here.
  {
    const log = newLog();
    const gates = { load: gate('load'), capture: gate('capture') };
    setTimeout(() => gates.load.release(), 40);
    setTimeout(() => gates.capture.release(), 60);
    const engine = engineWith(log, {
      encoder: true,
      gateFor: (phase, nth) => (nth === 1 ? gates[phase] || null : null),
    });
    const started = Date.now();
    const res = await engine.run({ route: '/', viewports: ONE, rules: [], capture: true });
    const took = Date.now() - started;
    check('a load and a capture that take their time still produce an audit', res?.ok === true, short(res));
    check('  and the picture was encoded', log.encoded === 1, short(log));
    check('  and the engine really did wait for them', took >= 60 && gates.load.released() && gates.capture.released(), `${took}ms ${short(log.blockedOn)}`);
    check('  and the window went afterwards', log.destroyed === 1 && liveWindowCount() === 0, short(log));
  }

  // ---- ABORTED BEFORE IT STARTED -------------------------------------------
  {
    const log = newLog();
    const ac = new AbortController();
    ac.abort();
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal });
    check('an audit whose caller had already gone is refused', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and opens no window at all', log.opened === 0, short(log));
    check('  and says so in words', typeof res?.message === 'string' && /cancelled/i.test(res.message), short(res?.message));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
    // NOTHING TO CLEAN, AND NOTHING CLEANED. This one is refused before the
    // engine's try block, so the `finally` never runs -- and it must not need
    // to: no window was opened, so nothing was written to the partition. The
    // assertion is the negative one, and it is what stops `cleanedUp` being
    // satisfiable by an engine that resets the session on paths that never
    // touched it.
    check('  and never touched the session, having never opened a page', log.session.storage === 0 && log.session.dirty === false, short(log.session));
  }

  // ---- ABORTED WHILE QUEUED -------------------------------------------------
  //
  // Audits are serialised. The run in front must be unaffected, the one behind
  // must not become work -- AND the one behind must be answered when it gives
  // up rather than when the run in front finishes. That last part is measured
  // by holding the run in front open: a queued refusal that arrives only after
  // the gate is released is one the caller waited the whole run for, which is
  // what it did (18.6 seconds, against a real client) before the refusal was
  // settled at the abort.
  {
    const log = newLog();
    const front = gate('load');
    const engine = engineWith(log, { gateFor: (phase) => (phase === 'load' ? front : null) });
    const ac = new AbortController();
    const first = engine.run({ route: '/', viewports: ONE, rules: [] });
    const second = engine.run({ route: '/other', viewports: ONE, rules: [] }, { signal: ac.signal });
    // Abandoned once the run in front is demonstrably holding the queue open,
    // so this is a genuinely queued run rather than a timer's guess at one.
    for (let i = 0; i < 5000 && !log.blockedOn.includes('load'); i += 1) await new Promise((r) => setImmediate(r));
    check('the run in front is holding the queue open', log.blockedOn.includes('load'), short(log));
    ac.abort();
    const startedWait = Date.now();
    const b = await answeredCancel('the queued audit', second);
    const answeredIn = Date.now() - startedWait;
    check('the one abandoned in the queue is refused', b?.ok === false && b.code === 'cancelled', short(b));
    check('  and answers before the run in front of it has even loaded a page', front.released() === false, short({ answeredIn }));
    check('  and answers promptly', answeredIn < ANSWER_BY_MS, `${answeredIn}ms`);
    front.release();
    const a = await first;
    check('the audit in front of a cancelled one still finishes', a?.ok === true, short(a));
    check('  and only the first run ever opened a window', log.opened === 1, short(log));
    check('  and its window was destroyed', log.destroyed === 1, short(log));
    check('  and none is live', liveWindowCount() === 0, String(liveWindowCount()));
    // The cancelled one never reached the engine's try; the one in FRONT of it
    // did, and it is that run's cleanup being read here. Three clears: before
    // the run, before its one viewport, and on the way out.
    cleanedUp('the audit in front of a cancelled one', log);
    check('  and the queued refusal added no clears of its own', log.session.storage === 3, short(log.session));
  }

  // ---- ABORTED DURING THE LOAD ---------------------------------------------
  //
  // THE CASE THE OLD FAKE COULD NOT POSE. The load never finishes, the way
  // /hang-load never finishes: headers written, body never ended. A checkpoint
  // engine sits here for two twenty-second budgets and then reports the timeout
  // it caused itself; an engine that races the signal answers now.
  {
    const log = newLog();
    const hang = gate('load');
    const ac = new AbortController();
    const engine = engineWith(log, {
      gateFor: (phase) => (phase === 'load' ? hang : null),
      onOpen: (n) => {
        if (n === 1) setImmediate(() => ac.abort());
      },
    });
    const started = Date.now();
    const res = await answeredCancel('an audit abandoned during a hanging load', engine.run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal }));
    const took = Date.now() - started;
    check('an audit abandoned during a load that never finishes is refused', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and does not report a timeout it caused itself', !/did not finish within/.test(String(res?.message || '')), short(res?.message));
    check('  and answers while that load is STILL outstanding', hang.released() === false, short({ took, blockedOn: log.blockedOn }));
    check('  and answers promptly', took < ANSWER_BY_MS, `${took}ms`);
    check('  and opened only the one window', log.opened === 1, short(log));
    check('  and destroyed it', log.destroyed === 1, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
    // THE CASE THE MUTATION SURVIVED. The page had begun loading on the shared
    // partition when the caller left; if the `finally` skips its reset on an
    // aborted run, whatever that page wrote is what the NEXT audit starts from.
    cleanedUp('an audit abandoned during a load', log);
  }

  // ---- ABORTED DURING A PROBE ----------------------------------------------
  //
  // Past the load, inside the measurement: the freeze injection, which until
  // this change had no budget of any kind on it -- not a timer and not a
  // signal.
  {
    const log = newLog();
    const wedge = gate('freeze');
    const ac = new AbortController();
    const engine = engineWith(log, {
      gateFor: (phase) => (phase === 'freeze' ? wedge : null),
    });
    // Aborted once the engine is demonstrably inside the probe, so this is not
    // a timer racing the engine to a boundary.
    const waitForProbe = (async () => {
      for (let i = 0; i < 2000 && !log.blockedOn.includes('freeze'); i += 1) await new Promise((r) => setImmediate(r));
      ac.abort();
    })();
    const started = Date.now();
    const res = await answeredCancel('an audit abandoned inside a wedged probe', engine.run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal }));
    const took = Date.now() - started;
    await waitForProbe;
    check('an audit abandoned inside a wedged probe is refused', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and the probe was reached', log.blockedOn.includes('freeze'), short(log.blockedOn));
    check('  and it answers while that probe is STILL outstanding', wedge.released() === false, short({ took }));
    check('  and answers promptly', took < ANSWER_BY_MS, `${took}ms`);
    check('  and destroyed the window it was measuring in', log.destroyed === log.opened && log.opened === 1, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
    cleanedUp('an audit abandoned inside a probe', log);
  }

  // ---- HOW FAR IT GOT -------------------------------------------------------
  //
  // The refusal used to claim "Nothing was measured" on a cancel that had
  // measured half a page. Abort as the SECOND window opens: exactly one
  // viewport is complete.
  {
    const log = newLog();
    const ac = new AbortController();
    const engine = engineWith(log, { onOpen: (n) => { if (n === 2) ac.abort(); } });
    const res = await answeredCancel('an audit cancelled between viewports', engine.run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal }));
    check('an audit cancelled mid-run is refused', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and says what it had measured rather than claiming nothing', /1 viewport had been measured/.test(String(res?.message || '')), short(res?.message));
    check('  and stops before measuring every viewport', log.opened === 2, short(log));
    check('  and destroys every window it did open', log.destroyed === log.opened, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
    cleanedUp('an audit cancelled between viewports', log);
  }

  // ---- ONE VIEWPORT ---------------------------------------------------------
  //
  // With a single viewport the between-viewports check runs once, before any
  // work. An audit abandoned while its only page was loading therefore ran to
  // completion and answered as though nobody had gone.
  {
    const log = newLog();
    const hang = gate('load');
    const ac = new AbortController();
    const engine = engineWith(log, {
      gateFor: (phase) => (phase === 'load' ? hang : null),
      onOpen: () => setImmediate(() => ac.abort()),
    });
    const started = Date.now();
    const res = await answeredCancel('a one-viewport audit', engine.run({ route: '/', viewports: ONE, rules: [] }, { signal: ac.signal }));
    const took = Date.now() - started;
    check('a one-viewport audit can be cancelled too', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and says honestly that nothing was measured', /Nothing was measured/.test(String(res?.message || '')), short(res?.message));
    check('  and does not wait its only load out', hang.released() === false && took < ANSWER_BY_MS, `${took}ms`);
    check('  with its window destroyed', log.destroyed === log.opened && log.opened === 1, short(log));
    check('  and none live', liveWindowCount() === 0, String(liveWindowCount()));
    cleanedUp('a one-viewport audit abandoned mid-load', log);
  }

  // ---- CANCELLING IS NOT A WAY OF SKIPPING THE CLEANUP ----------------------
  //
  // The reset on the way out is bounded now, and the obvious way to bound it is
  // the way every other await in this engine is bounded: `withTimeout(...,
  // PROBE_TIMEOUT_MS, what, signal)`, with the signal racing beside the timer.
  // On this one await that is not a bound but a bypass. By the time the
  // `finally` runs on a cancelled audit the signal is ALREADY aborted, so the
  // race is over before it starts: the cleanup is abandoned on its first tick
  // and the cancelled run becomes the one run that leaves the shared partition
  // holding a page's cookies for the next audit to read.
  //
  // So: a cancelled audit whose final clear is SLOW but real. The engine has to
  // wait for it. A build that races the signal here answers before the clear
  // lands, and the partition is still dirty when it does — which is the
  // difference this case is made of, and the reason it is a separate case from
  // the never-settling one below rather than a second assertion on it.
  {
    const log = newLog();
    const slow = gate('a final clear that takes its time');
    log.session.holdClear = slow;
    log.session.holdClearFrom = 3;
    const hang = gate('load');
    const ac = new AbortController();
    const engine = engineWith(log, {
      gateFor: (phase) => (phase === 'load' ? hang : null),
      onOpen: () => setImmediate(() => ac.abort()),
    });
    setTimeout(() => slow.release(), 200);
    const started = Date.now();
    const res = await answeredCancel('a cancelled audit whose final clear is slow', engine.run({ route: '/', viewports: ONE, rules: [] }, { signal: ac.signal }));
    const took = Date.now() - started;
    check('a cancelled audit still answers when its final clear is slow', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and waited for that clear rather than racing the signal past it', slow.released() === true && took >= 200, `${took}ms, released=${slow.released()}`);
    check('  so all three clears actually completed', log.session.storage === 3, short({ attempted: log.session.attempted, storage: log.session.storage }));
    check(
      '  and the partition is clean when the cancelled run answers',
      log.session.dirty === false,
      'the page had already begun loading on the shared partition when the caller left; the next audit reads what it wrote'
    );
    check('  with its window destroyed', log.destroyed === 1, short(log));
    check('  and none live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- TOO LATE -------------------------------------------------------------
  {
    const log = newLog();
    const ac = new AbortController();
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal });
    ac.abort();
    check('an audit that had already finished keeps its answer', res?.ok === true, short(res));
    check('  and aborting afterwards destroys nothing further', log.destroyed === log.opened && log.opened === 3, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
    cleanedUp('an audit aborted after it finished', log);
    check('  and aborting afterwards clears nothing further either', log.session.storage === 5, short(log.session));
  }

  // ---- NO LISTENER SURVIVES THE AWAIT IT GUARDED ---------------------------
  //
  // The signal outlives every await in the run, and the abort is raced on all
  // of them: a listener left behind per await is a leak that announces itself
  // as MaxListenersExceededWarning on a six-viewport audit and then stops
  // announcing itself. Counted on a real AbortSignal, after a real run.
  //
  // COUNTED WITH THE ONE READING THAT CAN COME BACK NON-ZERO.
  //
  // This block used to read `ac.signal.listenerCount ? ac.signal.listenerCount('abort') : 0`
  // on both sides. An `AbortSignal` is an EventTarget, not an EventEmitter, and
  // it has NO `listenerCount` method — so both sides were the literal `0` and
  // the assertion was `0 === 0` whatever the engine had done with the signal.
  // Measured: adding five hundred abort listeners by hand left that expression
  // at 0, while `getEventListeners(signal, 'abort').length` said 500. The file
  // sold that as "counted on a real AbortSignal, after a real run"; it counted
  // nothing at all.
  //
  // `require('node:events').getEventListeners` is the reading that works on an
  // EventTarget, and the positive control below is what stops THIS reading
  // going quietly to zero the way the last one did.
  {
    const log = newLog();
    const ac = new AbortController();
    const listeners = () => getEventListeners(ac.signal, 'abort').length;
    // THE ORACLE, PROVED TO MOVE, BEFORE IT IS ASKED A QUESTION. A count that
    // cannot go up cannot detect a leak, and the previous version of this block
    // is the whole reason that sentence is a test rather than a comment.
    const canary = () => {};
    ac.signal.addEventListener('abort', canary);
    check('the listener count can see a listener at all', listeners() === 1, `${listeners()} after adding one by hand`);
    ac.signal.removeEventListener('abort', canary);
    const before = listeners();
    check('  and goes back down when it is removed', before === 0, `${before}`);
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [], capture: true }, { signal: ac.signal });
    const after = listeners();
    check('a full six-window-worth of awaits still ran', res?.ok === true, short(res));
    check('  and left no abort listener behind', after === before, `${before} -> ${after}`);
  }

  // ---- AND THE BUDGETS, WHICH NOBODY IS CANCELLING -------------------------
  //
  // THE SLOW PART OF THIS FILE, AND THE ONLY THING THAT PROVES A NUMBER.
  //
  // Two of the awaits in a viewport had no bound of ANY kind before this
  // change: the freeze injection and the capture. A wedged JavaScript context
  // never returns from either, and no caller is required to cancel -- a host
  // with no tool timeout simply waits, and so did the audit, for ever.
  //
  // AND THE THIRD AWAIT WITH NO BOUND, WHICH WAS THE ONE ON THE WAY OUT.
  //
  // `runExclusive`'s outer `finally` did `cleanupReset = await
  // resetAuditSession(session)` bare. The same call at the top of the run is
  // wrapped in `withTimeout`, and so is the one between viewports; the one
  // reached on EVERY path out -- including the cancel path this whole file is
  // about -- was not. Reproduced on a double whose third `clearStorageData`
  // never settles: the run had not answered after 40,000ms, so the caller
  // waited for ever AND the queue behind it never reopened, which is the exact
  // cost cancellation exists to avoid.
  //
  // Two cases, because the cleanup runs on two different kinds of exit and only
  // one of them is a normal result: an ordinary audit, which has an isolation
  // claim to withdraw, and a CANCELLED one, which is the path where the signal
  // is already aborted and where a naive fix -- passing the signal to
  // `withTimeout` here, as everywhere else -- would skip the cleanup entirely
  // rather than bound it.
  //
  // Proving a thirty-second budget costs thirty seconds, and there is no
  // cheaper oracle for it: an assertion that the code contains a timeout is not
  // an assertion that the timeout fires. All four cases run on four engines at
  // once, so the file pays for one of them rather than four. A build that drops
  // any of these budgets does not fail slowly here -- it never answers, and the
  // deadline below is what turns that into a red line rather than a hang.
  {
    const freezeLog = newLog();
    const freezeGate = gate('freeze');
    const captureLog = newLog();
    const captureGate = gate('capture');

    // A one-viewport audit clears three times: before the run, before the
    // viewport, and in the `finally`. Holding from the third is holding exactly
    // the one on the way out, and leaving the first two alone is what makes the
    // case about THIS await rather than about the two that were already bounded.
    const outLog = newLog();
    outLog.session.holdClear = gate('final clear');
    outLog.session.holdClearFrom = 3;

    const cancelLog = newLog();
    cancelLog.session.holdClear = gate('final clear, on a cancelled run');
    cancelLog.session.holdClearFrom = 3;
    const cancelAc = new AbortController();
    const cancelHang = gate('load');

    // AND THE FIFTH, WHICH IS ABOUT THE AUDIT AFTER THE ONE THAT TIMED OUT.
    //
    // A TIME BOX IS NOT A CANCELLATION. `withTimeout` stops WAITING for the
    // clear; nothing stops the clear. It is an IPC round trip to the network
    // service on the one partition every audit shares, and when the box expires
    // it is still outstanding -- so it can land at any moment afterwards,
    // including inside the next audit, after that audit has loaded its page.
    //
    // Reproduced on this double before the fix, one engine, two runs, with the
    // partition logging which run had a page on it: `run1 ANSWERED false
    // session_not_cleaned after 30254ms`, `run2: page LOADED on the partition`,
    // `run2 ANSWERED true`, and then `clear#3 LANDED while liveRun=2`. The
    // isolation claim broken the other way about: not a partition left dirty for
    // the next run, but one wiped underneath a run that was using it and still
    // reporting `ok: true` with `sessionIsolated` asserted.
    //
    // Three runs on ONE engine, because the state under test is the engine's:
    // the run that strands the clear, the run that must refuse rather than
    // measure, and -- the positive control that stops "refuse everything for
    // ever" satisfying this -- the run after the stranded clear has landed,
    // which must audit the page normally.
    const strandedLog = newLog();
    strandedLog.session.holdClear = gate('a cleanup its own run abandoned');
    strandedLog.session.holdClearOnly = 3;
    const strandedEngine = engineWith(strandedLog);
    const strandedStory = (async () => {
      const first = await strandedEngine.run({ route: '/', viewports: ONE, rules: [] });
      const openedAfterFirst = strandedLog.opened;
      const at = Date.now();
      const second = await strandedEngine.run({ route: '/', viewports: ONE, rules: [] });
      return {
        first,
        second,
        openedAfterFirst,
        openedAfterSecond: strandedLog.opened,
        secondTook: Date.now() - at,
        // Read at the moment the second run answered: a refusal that arrived
        // after the stray clear had already landed would prove nothing.
        clearStillOutstanding: strandedLog.session.holdClear.released() === false,
      };
    })();

    // AND THE SIXTH, WHICH IS ABOUT A RUN THAT STRANDS TWO CLEARS RATHER THAN
    // ONE.
    //
    // The mark was a SINGLE SLOT, so a second `strand` inside one run
    // overwrote the first record -- and the drop only fired when the mark WAS
    // the settling record, so the second clear coming back cleared the mark
    // while the FIRST was still loose on the shared partition.
    //
    // One run strands twice on the ordinary path: its opening reset is walked
    // away from the instant its caller aborts (that await races the signal),
    // and the reset in its own `finally` then overruns its budget on the way
    // out (that one races the clock alone, deliberately). Two clears, two
    // gates, released in the order that hides the first behind the second.
    //
    // Reproduced against the real engine on this double before the fix, one
    // engine, two runs, with the partition logging which run had a page on it:
    // run 2 was NOT refused, opened its window, answered `ok:true` -- and run
    // 1's opening clear landed inside it:
    //   landed = [{clear:2,whileRun:1},{clear:3,whileRun:2},{clear:1,whileRun:2}]
    //
    // THE ORACLE IS `landed`, not the refusal code. A door that refused for any
    // other reason would satisfy a code assertion; what has to be true is that
    // no clear from run 1 ever lands while run 2 has a page on the partition.
    const firstStray = gate('the opening clear run 1 was cancelled inside');
    const secondStray = gate('the clear run 1\'s own finally timed out on');
    // Run 2's measurement is held open at its overflow probe -- page loaded,
    // state written to the partition, the measurement half done -- so the first
    // stray can be released WHILE that run is using the partition, which is the
    // moment a stray wipe does its damage and the only moment at which `landed`
    // distinguishes "refused" from "was lucky". The overflow probe rather than
    // the axe one because these runs pass `rules: []`, which skips the
    // accessibility pass entirely: a gate on a phase that never happens holds
    // nothing and would quietly turn this into a case about timing. Run 1 opens
    // no window at all (it is cancelled inside its opening clear, before the
    // first viewport), so the first window this engine ever makes is run 2's.
    const twoHold = gate('run 2\'s overflow probe, held so a stray can land inside it');
    const twoLog = newLog();
    twoLog.session.holdClearAt = { 1: firstStray, 2: secondStray };
    const twoEngine = engineWith(twoLog, { gateFor: (phase, nth) => (phase === 'overflow' && nth === 1 ? twoHold : null) });
    const twoAc = new AbortController();
    const twoStory = (async () => {
      twoLog.liveRun = 1;
      // Aborted when the opening clear is really in flight, so run 1 strands a
      // live round trip rather than one that happens to be near a cancel.
      const abortWhenHeld = (async () => {
        for (let i = 0; i < 5000 && twoLog.session.holding < 1; i += 1) await new Promise((r) => setImmediate(r));
        twoAc.abort();
      })();
      const first = await twoEngine.run({ route: '/', viewports: ONE, rules: [] }, { signal: twoAc.signal });
      await abortWhenHeld;
      const strandedTwice = twoLog.session.attempted === 2 && twoLog.session.holding === 2;
      twoLog.liveRun = 0;

      // WITH BOTH STILL OUTSTANDING, THE DOOR HAS TO SAY THERE ARE TWO. A
      // caller told to try again "once it has settled" when two clears are
      // loose is being told to wait for the wrong thing, and a set that reports
      // only its first member is a slot wearing a Set's clothes.
      const bothOut = await twoEngine.run({ route: '/', viewports: ONE, rules: [] });

      // Only the SECOND stray lands. This is the whole case: the old drop was
      // satisfied by whichever record settled last, so this release alone
      // reopened the door.
      secondStray.release();
      for (let i = 0; i < 5000 && twoLog.session.auth < 1; i += 1) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const openedAfterFirst = twoLog.opened;
      const at = Date.now();
      // `liveRun` goes back to 0 THE MOMENT run 2 answers, before anything the
      // test does next -- so a stray released after the refusal is recorded as
      // landing on a quiet partition, and only a stray that lands on a run that
      // is genuinely still measuring is recorded against it.
      twoLog.liveRun = 2;
      let answered = false;
      let secondTook = 0;
      // Read AT THE MOMENT run 2 answers: a refusal that arrived after the
      // stray had already landed would prove nothing.
      let firstStrayStillOutstanding = false;
      const running = twoEngine.run({ route: '/', viewports: ONE, rules: [] }).then((v) => {
        answered = true;
        secondTook = Date.now() - at;
        firstStrayStillOutstanding = firstStray.released() === false;
        twoLog.liveRun = 0;
        return v;
      });
      // Released either when run 2 is demonstrably measuring a page, or when it
      // has refused -- never on a timer's guess at which.
      await until(() => answered || twoLog.blockedOn.includes('overflow'));
      const releasedMidMeasurement = !answered && twoLog.blockedOn.includes('overflow');
      firstStray.release();
      await until(() => twoLog.session.landed.some((l) => l.clear === 1));
      twoHold.release();
      const second = await running;
      const story = {
        first,
        second,
        bothOut,
        strandedTwice,
        openedAfterFirst,
        openedAfterSecond: twoLog.opened,
        secondTook,
        releasedMidMeasurement,
        firstStrayStillOutstanding,
        firstStrayLandedAt: twoLog.session.landed.find((l) => l.clear === 1) || null,
      };

      // AND THE PARTITION COMES BACK once both strays have landed -- the
      // control that stops "refuse for ever" satisfying the refusal.
      twoLog.liveRun = 3;
      await until(() => twoLog.session.landed.length >= 2);
      await new Promise((r) => setImmediate(r));
      story.third = await twoEngine.run({ route: '/', viewports: ONE, rules: [] });
      story.openedAfterThird = twoLog.opened;
      story.landed = twoLog.session.landed;
      return story;
    })();

    const started = Date.now();
    const [freeze, picture, onTheWayOut, cancelledCleanup, stranded, twoStrays] = await Promise.all([
      boundDeadline(
        'a freeze that never returns',
        engineWith(freezeLog, { gateFor: (phase) => (phase === 'freeze' ? freezeGate : null) }).run({ route: '/', viewports: ONE, rules: [] }),
        75000
      ),
      boundDeadline(
        'a capture that never returns',
        engineWith(captureLog, { encoder: true, gateFor: (phase) => (phase === 'capture' ? captureGate : null) }).run(
          { route: '/', viewports: ['phone'], rules: [], capture: true },
          {}
        ),
        75000
      ),
      boundDeadline(
        'a final session reset that never returns',
        engineWith(outLog).run({ route: '/', viewports: ONE, rules: [] }),
        75000
      ),
      boundDeadline(
        'a cancelled audit whose final session reset never returns',
        engineWith(cancelLog, {
          gateFor: (phase) => (phase === 'load' ? cancelHang : null),
          onOpen: () => setImmediate(() => cancelAc.abort()),
        }).run({ route: '/', viewports: ONE, rules: [] }, { signal: cancelAc.signal }),
        75000
      ),
      boundDeadline('an audit whose abandoned cleanup outlives it', strandedStory, 75000),
      boundDeadline('an audit that abandoned TWO clears', twoStory, 75000),
    ]);
    const took = Date.now() - started;
    check('a freeze that never returns does not hold the audit for ever', freeze.answered === true, short(freeze.value));
    // The freeze's own failures are swallowed, as they always have been -- a
    // page that will not take the stylesheet is measured anyway. What the
    // budget buys is that the audit gets THERE.
    check('  and the audit goes on to measure the page', freeze.value?.ok === true, short(freeze.value));
    check('  having waited the probe budget rather than the load one', took >= 30000, `${took}ms`);
    check('a capture that never returns does not hold the audit for ever', picture.answered === true, short(picture.value));
    check('  and says which viewport it could not photograph', /photographing the phone viewport did not finish within 30000ms/.test(String(picture.value?.message || '')), short(picture.value));
    check('  and encoded nothing, because there was no frame to encode', captureLog.encoded === 0, short(captureLog));
    check('  and both windows went', freezeLog.destroyed === 1 && captureLog.destroyed === 1, short({ freezeLog, captureLog }));
    check('  and none is live', liveWindowCount() === 0, String(liveWindowCount()));
    // A BUDGET EXPIRING IS ANOTHER PATH OUT, and the `finally` covers it too.
    // Neither of these runs was cancelled: one measured the page anyway, the
    // other gave up on the photograph. Both leave the partition clean.
    cleanedUp('an audit whose freeze never returned', freezeLog);
    cleanedUp('an audit whose capture never returned', captureLog);

    // THE CLEANUP ON THE WAY OUT, BOUNDED.
    const outValue = onTheWayOut.value;
    check('a final session reset that never returns does not hold the audit for ever', onTheWayOut.answered === true, short(outValue));
    // AND REPORTED, NOT SWALLOWED. The isolation claim rests on this reset, so a
    // reset that timed out has to come back as a refusal that says so -- not as
    // an ordinary ok:true result with `sessionIsolated` still asserted, which is
    // what a `.catch(() => {})` here would have produced.
    check(
      '  and refuses to call itself isolated, by code',
      outValue?.ok === false && outValue?.code === 'session_not_cleaned',
      short(outValue)
    );
    check('  and says the same thing in the engine block the property lives in', outValue?.engine?.sessionIsolated === false, short(outValue?.engine));
    check(
      '  and names the timeout rather than inventing a reason for it',
      /clearing the audit session on the way out did not finish within 30000ms/.test(String(outValue?.message || '')),
      short(outValue?.message)
    );
    check('  while still handing back the viewport it really did measure', Array.isArray(outValue?.viewports) && outValue.viewports.length === 1, short(outValue?.viewports?.length));
    check('  and its window went anyway', outLog.destroyed === 1, short(outLog));
    // AND ON THE CANCEL PATH, WHICH IS THE ONE THIS AWAIT IS REACHED ON MOST.
    //
    // The signal here is already aborted by the time the `finally` runs, which
    // is why the bound on this one await must be the clock alone: a signal
    // raced beside the timer would reject on its first tick and skip the
    // cleanup, turning a cancelled audit into the one audit that leaves the
    // shared partition dirty.
    const cancelValue = cancelledCleanup.value;
    check('a cancelled audit whose final reset never returns still answers', cancelledCleanup.answered === true, short(cancelValue));
    check('  and answers as cancelled', cancelValue?.ok === false && cancelValue?.code === 'cancelled', short(cancelValue));
    check(
      '  having really attempted the clear on the way out rather than skipping it',
      cancelLog.session.attempted === 3 && cancelLog.session.storage === 2,
      short({ attempted: cancelLog.session.attempted, storage: cancelLog.session.storage })
    );
    check('  and destroyed its window', cancelLog.destroyed === 1, short(cancelLog));
    check('  and left none live', liveWindowCount() === 0, String(liveWindowCount()));

    // AND THE AUDIT BEHIND THE ONE WHOSE CLEANUP WAS ABANDONED.
    const story = stranded.value;
    check('an audit whose cleanup is abandoned still answers', stranded.answered === true, short(story));
    check('  and refuses to call itself cleaned', story?.first?.code === 'session_not_cleaned', short(story?.first));
    check('  and it really did open its window and load a page on the partition', story?.openedAfterFirst === 1, short(story?.openedAfterFirst));
    check(
      'the NEXT audit refuses rather than measuring a partition a stray clear may still wipe',
      story?.second?.ok === false && story?.second?.code === 'session_not_isolated',
      short(story?.second)
    );
    check(
      '  naming the abandoned cleanup rather than inventing a reason',
      /previous audit's cleanup was abandoned/.test(String(story?.second?.message || '')) &&
        /did not finish within 30000ms/.test(String(story?.second?.message || '')),
      short(story?.second?.message)
    );
    check('  and opens no window at all', story?.openedAfterSecond === story?.openedAfterFirst, short({ before: story?.openedAfterFirst, after: story?.openedAfterSecond }));
    check('  and says so at once rather than waiting the stray clear out', story?.secondTook < ANSWER_BY_MS, `${story?.secondTook}ms`);
    check('  while that clear really was still outstanding', story?.clearStillOutstanding === true, short(story));

    // AND THE PARTITION COMES BACK when the stray clear finally lands. Without
    // this the fix could be "refuse every audit after the first timeout, for the
    // life of the process", which satisfies everything above it.
    strandedLog.session.holdClear.release();
    // `auth` is the last counter the double moves inside a reset, so waiting for
    // it is waiting for the whole abandoned clear to have finished; one more
    // turn lets the engine's own `then` on it run.
    for (let i = 0; i < 5000 && strandedLog.session.auth < 3; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const third = await boundDeadline('the audit after the stray clear landed', strandedEngine.run({ route: '/', viewports: ONE, rules: [] }), 75000);
    check('an audit run after the stray clear has landed is measured normally', third.value?.ok === true, short(third.value));
    check('  and opened its window', strandedLog.opened === story?.openedAfterFirst + 1, short(strandedLog.opened));
    check('  and claims isolation again', third.value?.engine?.sessionIsolated === true, short(third.value?.engine));
    check('  and left none live', liveWindowCount() === 0, String(liveWindowCount()));

    // ---- AND A RUN THAT ABANDONED TWO CLEARS, WHICH ONE SLOT COULD NOT HOLD --
    const two = twoStrays.value;
    check('an audit that abandoned two clears still answers', twoStrays.answered === true, short(two));
    check('  and answers as cancelled, which is what its caller did', two?.first?.ok === false && two?.first?.code === 'cancelled', short(two?.first));
    // THE PREMISE, ASSERTED. Without this the case below could be passing
    // because only ONE clear was ever stranded, which is the case already
    // covered above and proves nothing about the slot.
    check(
      '  having really left TWO clears outstanding on the partition, not one',
      two?.strandedTwice === true,
      short({ attempted: twoLog.session.attempted, holding: twoLog.session.holding })
    );
    check(
      'an audit attempted while BOTH are outstanding is refused',
      two?.bothOut?.ok === false && two?.bothOut?.code === 'session_not_isolated',
      short(two?.bothOut)
    );
    check(
      '  and counts the second one rather than reporting only the first',
      /1 further cleanup is outstanding on the same partition\./.test(String(two?.bothOut?.message || '')) &&
        /Try again once they have settled\./.test(String(two?.bothOut?.message || '')),
      short(two?.bothOut?.message)
    );
    check(
      'the audit after them refuses even though the SECOND stray has landed',
      two?.second?.ok === false && two?.second?.code === 'session_not_isolated',
      short(two?.second)
    );
    check('  while the FIRST was still outstanding', two?.firstStrayStillOutstanding === true, short(two));
    check('  and opens no window at all', two?.openedAfterSecond === two?.openedAfterFirst, short({ before: two?.openedAfterFirst, after: two?.openedAfterSecond }));
    check('  and says so at once rather than waiting it out', two?.secondTook < ANSWER_BY_MS, `${two?.secondTook}ms`);
    // AND WHAT THE REFUSAL SAYS, which has to name the reason the OLDEST clear
    // was let go of -- a cancel, not a budget. The engine used to assert
    // "after it overran its budget" whichever way out the await took, and to
    // print the module-private CANCELLED symbol as the reason.
    check(
      '  naming the cancel that stranded the oldest one, rather than a budget it never reached',
      /previous audit's cleanup was abandoned \(the audit that started it was cancelled while the clear was in flight\)/.test(String(two?.second?.message || '')) &&
        !/Symbol\(/.test(String(two?.second?.message || '')),
      short(two?.second?.message)
    );
    // AND THE PARTITION COMES BACK, so this is a refusal that ends.
    check('an audit run after BOTH strays landed is measured normally', two?.third?.ok === true, short(two?.third));
    check('  and opened its window', two?.openedAfterThird === two?.openedAfterFirst + 1, short({ after: two?.openedAfterThird, before: two?.openedAfterFirst }));
    check('  and claims isolation again', two?.third?.engine?.sessionIsolated === true, short(two?.third?.engine));
    // THE PROPERTY ITSELF, read off the partition rather than off the refusal.
    //
    // The stray is released while run 2 is HELD OPEN AT ITS AXE INJECTION -- a
    // page loaded, state written, the measurement half done -- so on a build
    // that let run 2 through, the wipe lands inside it and is recorded against
    // it. `liveRun` returns to 0 the instant run 2 answers, so a stray released
    // after a refusal is recorded as landing on a quiet partition. This is the
    // assertion that went red before the fix.
    //
    // TWO CANARIES FIRST, because "no stray landed inside a run" is satisfied
    // by a stray that never landed at all and by a reading that never moves.
    check(
      '  the stray really did land in the end, so the negative below is about WHEN and not WHETHER',
      !!two?.firstStrayLandedAt,
      short(two?.landed)
    );
    check(
      '  and the partition really does record a clear against a run in flight',
      (two?.landed || []).some((l) => l.whileRun > 1),
      short(two?.landed)
    );
    const strayInsideARun = (two?.landed || []).filter((l) => l.clear <= 2 && l.whileRun > 1);
    check(
      '  and no clear run 1 abandoned ever landed inside a run that was measuring',
      strayInsideARun.length === 0,
      short({ landed: two?.landed, strayInsideARun, releasedMidMeasurement: two?.releasedMidMeasurement })
    );
    check('  and left none live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- AND THE TWO RESETS THAT USED TO LET GO OF THEIR CLEAR ---------------
  //
  // The case above strands the clear on the way OUT, which is the one site that
  // ever handed its promise to `strand`. There are two more, and until this
  // block nothing measured them: the reset at the top of a run and the reset
  // between viewports both dropped the promise the moment their await stopped
  // waiting for it.
  //
  // A TIME BOX IS NOT THE ONLY WAY OUT OF THOSE AWAITS, AND IT IS NOT THE
  // COMMON ONE. `resetAuditSession` never rejects -- it answers {ok:false,
  // reason} -- so nothing but the timer and the ABORT can end them, and the
  // abort is the one that fires on every host tool-timeout. Cancelling a run
  // during its opening clear therefore left a live clearStorageData outstanding
  // on the shared `stacki-audit` partition with no record of it anywhere.
  //
  // Reproduced against the real engine on this double, one engine, two runs:
  // run 1 cancelled during its OPENING clear; run 1's own `finally` clear then
  // SUCCEEDS, so `strandedCleanup` stayed null; run 2 was not refused, loaded
  // its page, answered `ok:true` with `sessionIsolated:true`, and run 1's clear
  // landed in the middle of it --
  //   landed = [{clear:2,whileRun:1},{clear:3,whileRun:2},{clear:1,whileRun:2}]
  //
  // Both sites, because they are separate lines with separate `withTimeout`
  // calls and fixing one says nothing about the other. Each runs on ONE engine,
  // because the state under test is the engine's, and each ends with the audit
  // that follows the landed clear -- the positive control that stops "refuse
  // everything for ever" satisfying the refusal.
  //
  // These cases cost milliseconds rather than the thirty seconds the block
  // above pays, because the way out being measured here is the ABORT and not
  // the budget: the clear is still held when the assertions are read.
  for (const site of [
    { where: 'the reset at the top of the run', nth: 1, clearsBeforeAnswer: 2 },
    { where: 'the reset between viewports', nth: 2, clearsBeforeAnswer: 3 },
  ]) {
    const log = newLog();
    log.session.holdClear = gate(`a clear abandoned by ${site.where}`);
    // ONE call held, not every call from the Nth on. The clear run 1 abandons
    // must hang while the clear in run 1's own `finally` succeeds -- that is
    // precisely the shape that left `strandedCleanup` null, and a double that
    // hangs everything afterwards cannot produce it.
    log.session.holdClearOnly = site.nth;
    const engine = engineWith(log);
    const ac = new AbortController();
    // The abort fires when the clear is really hanging, which is what makes
    // this a cancel of an IN-FLIGHT round trip rather than a cancel that
    // happens to land near one.
    const abortWhenHeld = (async () => {
      for (let i = 0; i < 5000 && log.session.holding < 1; i += 1) await new Promise((r) => setImmediate(r));
      ac.abort();
    })();
    const first = await answeredCancel(
      `an audit cancelled inside ${site.where}`,
      engine.run({ route: '/', viewports: ONE, rules: [] }, { signal: ac.signal })
    );
    await abortWhenHeld;
    // WHAT THE CALLER IS TOLD DOES NOT CHANGE. A cancelled run answers
    // `cancelled`; keeping the promise is the NEXT audit's business, and a fix
    // that turned this answer into `session_not_isolated` would be telling the
    // caller its own cancel was a failure of the page.
    check(`  and still answers as cancelled, not as a session failure`, first?.ok === false && first?.code === 'cancelled', short(first));
    check('  while the clear it walked away from is still outstanding', log.session.holdClear.released() === false, short(log.session));
    check(
      '  and its own cleanup clear really did succeed, so nothing below can be coming from that',
      log.session.attempted === site.clearsBeforeAnswer && log.session.storage === site.clearsBeforeAnswer - 1,
      short({ attempted: log.session.attempted, storage: log.session.storage })
    );

    const openedAfterFirst = log.opened;
    const at = Date.now();
    const second = await boundDeadline(`the audit after ${site.where} was abandoned`, engine.run({ route: '/', viewports: ONE, rules: [] }), 75000);
    const secondTook = Date.now() - at;
    const stillOutstanding = log.session.holdClear.released() === false;
    check(`the audit after ${site.where} was abandoned answers`, second.answered === true, short(second.value));
    check(
      '  and refuses at the door rather than measuring a partition that clear may wipe',
      second.value?.ok === false && second.value?.code === 'session_not_isolated',
      short(second.value)
    );
    check(
      '  naming the abandoned cleanup rather than inventing a reason',
      /previous audit's cleanup was abandoned/.test(String(second.value?.message || '')),
      short(second.value?.message)
    );
    check('  and opens no window at all', log.opened === openedAfterFirst, short({ before: openedAfterFirst, after: log.opened }));
    check('  and adds no clear of its own to a partition that has one outstanding', log.session.attempted === site.clearsBeforeAnswer, short(log.session));
    check('  and says so at once rather than waiting the stray clear out', secondTook < ANSWER_BY_MS, `${secondTook}ms`);
    check('  while that clear really was still outstanding when it answered', stillOutstanding === true, short(log.session));

    // AND THE PARTITION COMES BACK. Without this, "refuse every audit after the
    // first cancel, for the life of the process" satisfies everything above.
    log.session.holdClear.release();
    for (let i = 0; i < 5000 && log.session.auth < site.clearsBeforeAnswer; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const after = await boundDeadline(`the audit after ${site.where}'s stray clear landed`, engine.run({ route: '/', viewports: ONE, rules: [] }), 75000);
    check('an audit run after that stray clear has landed is measured normally', after.value?.ok === true, short(after.value));
    check('  and opened its window', log.opened === openedAfterFirst + 1, short(log.opened));
    check('  and claims isolation again', after.value?.engine?.sessionIsolated === true, short(after.value?.engine));
    check('  and left none live', liveWindowCount() === 0, String(liveWindowCount()));
    cleanedUp(`an audit following ${site.where}'s abandoned clear`, log);
  }

  // ---- WHEN THE WINDOW CANNOT BE DESTROYED AT ALL --------------------------
  //
  // LAST, BECAUSE IT DELIBERATELY LEAKS A WINDOW and the registry is module
  // level: every case that asserts `liveWindowCount() === 0` has already run.
  //
  // `win.destroy()` has always been called inside a try/catch, because a
  // destroy that throws must leave the window in the registry where the leak
  // count can still see it — "the count is the alarm". This is that case, and
  // it is why the abort is raced on the AWAITS rather than routed through the
  // window: the run has to answer even when nothing can be done about the
  // window, and the registry has to keep saying so afterwards.
  {
    const log = newLog();
    // Every attempt, not just the first.
    log.destroyRefusalsLeft = 99;
    const wedge = gate('freeze');
    const capture = gate('capture');
    const ac = new AbortController();
    const engine = engineWith(log, { encoder: true, gateFor: (phase) => (phase === 'freeze' ? wedge : phase === 'capture' ? capture : null) });
    const waitForProbe = (async () => {
      for (let i = 0; i < 5000 && !log.blockedOn.includes('freeze'); i += 1) await new Promise((r) => setImmediate(r));
      ac.abort();
    })();
    const started = Date.now();
    const res = await answeredCancel(
      'an audit whose window will not die',
      engine.run({ route: '/', viewports: ONE, rules: [], capture: true }, { signal: ac.signal })
    );
    const took = Date.now() - started;
    await waitForProbe;
    check('  and is cancelled', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and it was the signal that did it, not the destroy', log.destroyRefused > 0, short(log));
    check('  while the probe it was holding is still outstanding', wedge.released() === false && capture.released() === false, short(log.blockedOn));
    check('  and it answered promptly', took < ANSWER_BY_MS, `${took}ms`);
    check('  and the destroy really was attempted and really did fail', log.destroyRefused >= 1 && log.destroyed === 0, short(log));
    check('  and the window it could not destroy is still counted', liveWindowCount() === 1, String(liveWindowCount()));
    // AND THE SESSION IS CLEARED EVEN THEN. The window is stuck, the run was
    // cancelled, and the `finally` still has to leave the partition clean --
    // otherwise the one case where cleanup is hardest is the one case where the
    // next audit inherits a page's cookies.
    cleanedUp('an audit whose window will not die', log);
  }

  // ---- THE WIRE CARRIES IT --------------------------------------------------
  //
  // Every assertion above reaches the engine directly. This one does not: it
  // registers the REAL audit tool on a real McpServer and asserts that the
  // handler hands the SDK's own second argument down. A handler that went back
  // to `async (args) => …` passes every test above and fails this one.
  //
  // It is a hand-made context, and it is deliberately the WEAKEST claim in this
  // file: that the parameter is forwarded. Whether a real transport's abort
  // reaches this signal at all is measured in test/audit-cancel-inflight.js,
  // over a real socket with the official client.
  {
    const { registerAuditTool } = require('../electron/mcp/auditTool.js');
    let sawSignal = 'never called';
    const fakeServer = {
      registerTool: (_name, _config, handler) => {
        fakeServer.handler = handler;
        return { name: _name };
      },
    };
    registerAuditTool(fakeServer, {
      audit: async (_args, opts) => {
        sawSignal =
          opts && opts.signal && typeof opts.signal.aborted === 'boolean' ? 'an AbortSignal' : `no signal (${short(opts)})`;
        return { ok: true, findings: [] };
      },
      api: { checkAccess: () => null },
    });
    check('the audit tool registered a handler', typeof fakeServer.handler === 'function');
    if (typeof fakeServer.handler === 'function') {
      const ac = new AbortController();
      await fakeServer.handler({ route: '/' }, { mcpReq: { signal: ac.signal } });
      check('the tool handler passes the request’s AbortSignal to the engine', sawSignal === 'an AbortSignal', sawSignal);
      // And a host that hands over no context at all must not crash the tool.
      sawSignal = 'never called';
      await fakeServer.handler({ route: '/' }, undefined);
      check('  and a call with no request context still runs', sawSignal === 'no signal (undefined)' || /no signal/.test(sawSignal), sawSignal);
    }
  }

  suiteDone();
  if (failures.length) {
    console.error(`audit-cancel: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-cancel: ${checked} passed  [an abandoned audit stops mid-await, cleans up, and frees the queue]`);
})().catch((err) => {
  suiteDone();
  console.error('audit-cancel: threw', err);
  process.exit(1);
});
