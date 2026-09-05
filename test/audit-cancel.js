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
//   too late is harmless  aborting after the run finished changes nothing
//   the wire carries it   the real MCP tool handler passes the SDK's signal to
//                         the engine, rather than the engine being told by a
//                         test that reaches past it

const { createAudit, liveWindowCount } = require('../electron/mcp/audit');

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
// failure rather than a wait.
let finished = false;
const SUITE_DEADLINE_MS = 180000;
const watchdog = setTimeout(() => {
  console.error(`audit-cancel: the suite did not finish within ${SUITE_DEADLINE_MS}ms — an audit is still waiting on something`);
  process.exit(1);
}, SUITE_DEADLINE_MS);
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.error('audit-cancel: the process exited without finishing — an audit never answered, so nothing was reported');
  process.exitCode = 1;
});

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
      this.loadURL = () =>
        held('load').then((v) => {
          if (finishLoad) setImmediate(finishLoad);
          return v;
        });
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

// The shape the engine actually asks for -- a partition factory, not a session.
const cleanSession = {
  fromPartition: () => ({
    clearStorageData: async () => {},
    clearCache: async () => {},
    clearAuthCache: async () => {},
  }),
};
const THREE = [
  { width: 375, height: 700 },
  { width: 768, height: 900 },
  { width: 1280, height: 900 },
];
const ONE = [{ width: 375, height: 700 }];

const newLog = () => ({ opened: 0, destroyed: 0, destroyRefused: 0, destroyRefusalsLeft: 0, encoded: 0, blockedOn: [] });

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
    session: cleanSession,
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
  }

  // ---- NO LISTENER SURVIVES THE AWAIT IT GUARDED ---------------------------
  //
  // The signal outlives every await in the run, and the abort is raced on all
  // of them: a listener left behind per await is a leak that announces itself
  // as MaxListenersExceededWarning on a six-viewport audit and then stops
  // announcing itself. Counted on a real AbortSignal, after a real run.
  {
    const log = newLog();
    const ac = new AbortController();
    const before = ac.signal.listenerCount ? ac.signal.listenerCount('abort') : 0;
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [], capture: true }, { signal: ac.signal });
    const after = ac.signal.listenerCount ? ac.signal.listenerCount('abort') : 0;
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
  // Proving a thirty-second budget costs thirty seconds, and there is no
  // cheaper oracle for it: an assertion that the code contains a timeout is not
  // an assertion that the timeout fires. The two cases run on two engines at
  // once, so the file pays for one of them rather than both. A build that drops
  // either budget does not fail slowly here -- it never answers, and the
  // deadline below is what turns that into a red line rather than a hang.
  {
    const freezeLog = newLog();
    const freezeGate = gate('freeze');
    const captureLog = newLog();
    const captureGate = gate('capture');
    const started = Date.now();
    const [freeze, picture] = await Promise.all([
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

  finished = true;
  clearTimeout(watchdog);
  if (failures.length) {
    console.error(`audit-cancel: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-cancel: ${checked} passed  [an abandoned audit stops mid-await, cleans up, and frees the queue]`);
})().catch((err) => {
  finished = true;
  clearTimeout(watchdog);
  console.error('audit-cancel: threw', err);
  process.exit(1);
});
