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
// WHAT THIS ASSERTS, and each one is refusal-shaped so a surface that cancelled
// everything would fail the positive controls:
//
//   nothing starts        an already-aborted request opens NO window
//   nothing queued starts a run abandoned while queued opens no window either,
//                         and the run in front of it still finishes
//   it stops between      aborting after the first viewport measures fewer
//     viewports           viewports than were asked for, and every window that
//                         was opened is destroyed
//   nothing leaks         liveWindowCount() is 0 on every path out
//   too late is harmless  aborting after the run finished changes nothing
//   the wire carries it   the real MCP tool handler passes the SDK's signal to
//                         the engine, rather than the engine being told by a
//                         test that reaches past it
//
// The engine is driven with the same fake BrowserWindow the other non-Electron
// audit suites use: this is about control flow and window ownership, and a real
// Chromium would only make it slower and less deterministic. The packaged
// proofs cover the real browser.

const { createAudit, liveWindowCount } = require('../electron/mcp/audit');

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

const AXE = { violations: [], incomplete: [], passCount: 0, inapplicableCount: 0, version: '4.13.0', knownRuleIds: [] };

/**
 * A window that counts itself.
 *
 * `opened` and `destroyed` are the oracle for "it stopped": a run that honoured
 * the abort opened fewer windows than the viewport list asked for, and a run
 * that cleaned up destroyed every one it opened.
 */
function countingWindows(log, { onOpen = null } = {}) {
  return class FakeWindow {
    constructor() {
      log.opened += 1;
      this.destroyed = false;
      this.webContents = {
        on: () => {},
        once: (event, fn) => {
          if (event === 'did-finish-load') setImmediate(fn);
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: async (src) => {
          if (typeof src === 'string' && src.includes('culpritTotal')) {
            return { viewportWidth: 375, documentScrollWidth: 375, overflowBy: 0, overflows: false, culprits: [], culpritTotal: 0, truncated: false };
          }
          if (typeof src === 'string' && src.includes('axe.run')) return AXE;
          return { title: 'fake', readyState: 'complete' };
        },
        getURL: () => 'http://127.0.0.1:4321/',
        capturePage: async () => ({ isEmpty: () => true }),
      };
      // Fired after the window for viewport N exists, which is how a test aborts
      // "in the middle" without racing a timer against the engine.
      if (onOpen) onOpen(log.opened);
    }
    async loadURL() {}
    setContentSize() {}
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      log.destroyed += 1;
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

const engineWith = (log, opts = {}) =>
  createAudit({
    BrowserWindow: countingWindows(log, opts),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: cleanSession,
  });

(async () => {
  // ---- POSITIVE CONTROL -----------------------------------------------------
  // Everything below asserts that something did NOT happen. Without this, an
  // engine that refused every audit would pass the whole suite.
  {
    const log = { opened: 0, destroyed: 0 };
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [] });
    check('an audit nobody cancelled runs', res?.ok === true, short(res));
    check('  and opens one window per viewport', log.opened === 3, short(log));
    check('  and destroys every one of them', log.destroyed === 3, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- ABORTED BEFORE IT STARTED -------------------------------------------
  {
    const log = { opened: 0, destroyed: 0 };
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
  // Audits are serialised. The run in front must be unaffected, and the one
  // behind must not become work.
  {
    const log = { opened: 0, destroyed: 0 };
    const engine = engineWith(log);
    const ac = new AbortController();
    const first = engine.run({ route: '/', viewports: THREE, rules: [] });
    const second = engine.run({ route: '/other', viewports: THREE, rules: [] }, { signal: ac.signal });
    ac.abort();
    const [a, b] = await Promise.all([first, second]);
    check('the audit in front of a cancelled one still finishes', a?.ok === true, short(a));
    check('the one abandoned in the queue is refused', b?.ok === false && b.code === 'cancelled', short(b));
    check('  and only the first run opened windows', log.opened === 3, short(log));
    check('  and all of them were destroyed', log.destroyed === 3, short(log));
    check('  and none is live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- ABORTED PART WAY THROUGH --------------------------------------------
  //
  // The abort fires once the first viewport's window exists, so the run is
  // genuinely mid-flight rather than aborted at a boundary a timer guessed at.
  {
    const log = { opened: 0, destroyed: 0 };
    const ac = new AbortController();
    const engine = createAudit({
      BrowserWindow: countingWindows(log, { onOpen: (n) => { if (n === 1) ac.abort(); } }),
      getPreviewUrl: () => 'http://127.0.0.1:4321',
      session: cleanSession,
    });
    const res = await engine.run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal });
    check('an audit cancelled mid-run is refused', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and stops before measuring every viewport', log.opened < 3 && log.opened >= 1, short(log));
    check('  and destroys every window it did open', log.destroyed === log.opened, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- ONE VIEWPORT ---------------------------------------------------------
  //
  // With a single viewport the between-viewports check runs once, before any
  // work. An audit abandoned while its only page was loading therefore ran to
  // completion and answered as though nobody had gone.
  {
    const log = { opened: 0, destroyed: 0 };
    const ac = new AbortController();
    const engine = createAudit({
      BrowserWindow: countingWindows(log, { onOpen: () => ac.abort() }),
      getPreviewUrl: () => 'http://127.0.0.1:4321',
      session: cleanSession,
    });
    const res = await engine.run({ route: '/', viewports: [{ width: 375, height: 700 }], rules: [] }, { signal: ac.signal });
    check('a one-viewport audit can be cancelled too', res?.ok === false && res.code === 'cancelled', short(res));
    check('  and says what it had measured rather than claiming nothing', /viewport/.test(String(res?.message || '')), short(res?.message));
    check('  with its window destroyed', log.destroyed === log.opened && log.opened === 1, short(log));
    check('  and none live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- TOO LATE -------------------------------------------------------------
  {
    const log = { opened: 0, destroyed: 0 };
    const ac = new AbortController();
    const res = await engineWith(log).run({ route: '/', viewports: THREE, rules: [] }, { signal: ac.signal });
    ac.abort();
    check('an audit that had already finished keeps its answer', res?.ok === true, short(res));
    check('  and aborting afterwards destroys nothing further', log.destroyed === log.opened && log.opened === 3, short(log));
    check('  and leaves none live', liveWindowCount() === 0, String(liveWindowCount()));
  }

  // ---- THE WIRE CARRIES IT --------------------------------------------------
  //
  // Every assertion above reaches the engine directly. This one does not: it
  // registers the REAL audit tool on a real McpServer and asserts that the
  // handler hands the SDK's own second argument down. A handler that went back
  // to `async (args) => …` passes every test above and fails this one.
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

  if (failures.length) {
    console.error(`audit-cancel: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-cancel: ${checked} passed  [an abandoned audit stops, cleans up, and frees the queue]`);
})().catch((err) => {
  console.error('audit-cancel: threw', err);
  process.exit(1);
});
