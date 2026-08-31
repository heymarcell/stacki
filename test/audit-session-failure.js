// What the audit does when it cannot promise a clean browser session.
//
//   node test/audit-session-failure.js
//
// The REAL cookie and localStorage isolation is proven against a real browser in
// test/mcp-audit.js. What is proven here is the other half, which a real browser
// cannot be asked to demonstrate on command: what happens when the wipe FAILS.
//
// `createAudit` already takes its Electron pieces as arguments, so a session that
// refuses to clear is injected through the seam that exists rather than through a
// switch added to production for a test to flip.
//
// The invariant, in three parts:
//
//   BEFORE   a reset that cannot be confirmed means nothing is measured at all.
//   BETWEEN  a reset that fails between viewports stops the audit there.
//   AFTER    a reset that fails after measuring may not return ok:true, because
//            the next audit may now see what this one left behind.

const { createAudit } = require('../electron/mcp/audit');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null).slice(0, 220);

/** A session whose clears fail on the Nth call onwards. */
function sessionFailingFrom(n) {
  let calls = 0;
  return {
    calls: () => calls,
    fromPartition: () => ({
      clearStorageData: async () => {
        calls += 1;
        if (calls >= n) throw new Error('storage refused to clear');
      },
      clearCache: async () => {},
      clearAuthCache: async () => {},
    }),
  };
}

// A window that never gets used, so that "nothing was measured" can be asserted
// by the fact that this was never constructed.
function countingWindows() {
  let made = 0;
  class FakeWindow {
    constructor() {
      made += 1;
      const handlers = new Map();
      this.webContents = {
        on: () => {},
        // The audit waits on did-finish-load. Firing it on the next tick is what
        // makes this a window rather than a hang.
        once: (event, fn) => {
          handlers.set(event, fn);
          if (event === 'did-finish-load') setImmediate(fn);
        },
        setWindowOpenHandler: () => {},
        // The probes return shapes the engine reads: a settle, a geometry answer
        // with no overflow, and an axe result with nothing in it. A clean page.
        executeJavaScript: async (src) => {
          if (typeof src === 'string' && src.includes('documentElement')) {
            return { viewportWidth: 375, documentScrollWidth: 375, overflowBy: 0, overflows: false, culprits: [], culpritTotal: 0, truncated: false };
          }
          if (typeof src === 'string' && src.includes('axe.run')) {
            return { version: '4.13.0', violations: [], incomplete: [], passCount: 0, inapplicableCount: 0 };
          }
          return { title: 'fake', readyState: 'complete' };
        },
        getURL: () => 'http://127.0.0.1:4321/',
        capturePage: async () => ({ isEmpty: () => true }),
      };
    }
    async loadURL() {}
    setContentSize() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  }
  return { FakeWindow, made: () => made };
}

(async () => {
  const base = 'http://127.0.0.1:4321';

  // --- BEFORE: no session API at all.
  {
    const { FakeWindow, made } = countingWindows();
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: null });
    const res = await audit.run({ route: '/', viewports: ['phone'] });
    check('with no session API the audit refuses', res.ok === false && res.code === 'session_not_isolated', short(res));
    check('  and says the browser state cannot be cleared', /cannot be cleared/i.test(String(res.message)), short(res.message));
    // THE POINT. Not "it reported a problem" -- it never opened a page.
    check('  and no page was ever opened', made() === 0, `${made()} windows were created`);
  }

  // --- BEFORE: a session whose very first clear throws.
  {
    const { FakeWindow, made } = countingWindows();
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: sessionFailingFrom(1) });
    const res = await audit.run({ route: '/', viewports: ['phone'] });
    check('a reset that fails before measuring stops the audit', res.ok === false && res.code === 'session_not_isolated', short(res));
    check('  and names the reason', /refused to clear/.test(String(res.message)), short(res.message));
    check('  and nothing was measured', made() === 0, `${made()} windows were created`);
  }

  // --- BETWEEN: the run-level reset succeeds, a viewport-level one fails.
  //
  // Call 1 is the run boundary, call 2 is the first viewport. Failing from 2
  // means the audit gets past the gate and must stop at the first viewport.
  {
    const { FakeWindow, made } = countingWindows();
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: sessionFailingFrom(2) });
    const res = await audit.run({ route: '/', viewports: ['phone', 'tablet', 'desktop'] });
    check('a reset that fails between viewports stops the audit', res.ok === false && res.code === 'session_not_isolated', short(res));
    check('  and it stopped rather than measuring the rest', made() < 3, `${made()} of 3 viewports were opened`);
  }

  // --- AFTER: everything measured, and the final cleanup fails.
  //
  // One viewport: call 1 is the run gate, call 2 is the viewport, call 3 is the
  // cleanup. Failing from 3 leaves the measurement intact and the cleanup broken.
  {
    const { FakeWindow } = countingWindows();
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: sessionFailingFrom(3) });
    const res = await audit.run({ route: '/', viewports: ['phone'] });
    check('a cleanup failure cannot return an ordinary success', res.ok !== true, short(res));
    check('  and it says the session was not cleaned', res.code === 'session_not_cleaned', short(res.code));
    check('  and it does not claim isolation', res.engine?.sessionIsolated !== true, short(res.engine));
    check('  while still handing back what it did measure', Array.isArray(res.findings), short(typeof res.findings));
  }

  // --- And the ordinary path still works, so none of the above is vacuous.
  {
    const { FakeWindow, made } = countingWindows();
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: sessionFailingFrom(999) });
    const res = await audit.run({ route: '/', viewports: ['phone'] });
    check('a session that clears cleanly still audits', res.ok === true, short(res));
    check('  and reports itself isolated', res.engine?.sessionIsolated === true, short(res.engine));
    check('  and did open a page', made() === 1, `${made()} windows`);
  }

  if (failures.length) {
    console.error(`\naudit-session-failure: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-session-failure: ${checked} passed  [no clean session, no audit]`);
})().catch((err) => {
  console.error('audit-session-failure threw\n', err);
  process.exit(1);
});
