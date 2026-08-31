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

const { createAudit, projectOriginTest, originOf } = require('../electron/mcp/audit');

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

// A page with enough real findings to prove the cleanup-failure result is the
// SAME result, not a thinner one wearing its name.
//
// Sixty-plus violations is not arbitrary: the response cap is what makes the two
// paths diverge, and the `incomplete` bucket is what a flat slice eats first,
// because every incomplete is severity `info` and sorts last.
function busyPage() {
  const nodes = (n, tag) =>
    Array.from({ length: n }, (_, i) => ({ target: [`${tag}:nth-of-type(${i + 1})`], html: `<${tag}>x</${tag}>`, failureSummary: 'because' }));
  return {
    version: '4.13.0',
    violations: [{ id: 'color-contrast', impact: 'serious', help: 'contrast', helpUrl: 'x', tags: ['wcag2aa'], nodeTotal: 100, nodes: nodes(100, 'p') }],
    incomplete: [{ id: 'duplicate-id-aria', impact: null, help: 'ids', helpUrl: 'x', tags: [], nodeTotal: 5, nodes: nodes(5, 'div') }],
    passCount: 3,
    inapplicableCount: 1,
  };
}

// A window that never gets used, so that "nothing was measured" can be asserted
// by the fact that this was never constructed.
//
// `axe` overrides what the accessibility probe answers; `axeThrows` makes the
// engine fail, which is the other thing a result must never quietly lose.
function countingWindows({ axe = null, axeThrows = false, capturable = false } = {}) {
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
            if (axeThrows) throw new Error('axe blew up');
            return axe || { version: '4.13.0', violations: [], incomplete: [], passCount: 0, inapplicableCount: 0 };
          }
          return { title: 'fake', readyState: 'complete' };
        },
        getURL: () => 'http://127.0.0.1:4321/',
        // `capture: true` only reaches the encoder for a non-empty image, so
        // this one is empty unless a test asks for a picture.
        capturePage: async () => ({ isEmpty: () => !capturable }),
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

  // --- WHICH ORIGINS COUNT AS THE PROJECT'S.
  //
  // The audit's whole closed-world claim rests on this predicate, and it
  // deliberately accepts more than one string: Stacki builds its own preview URL
  // as 127.0.0.1 but adopts a user-started dev server by reading Astro's output,
  // which prints localhost. Same scheme, same port, either name for the loopback
  // interface is the same server. Everything else is somebody else's.
  {
    const isProject = projectOriginTest('http://127.0.0.1:4321');
    check('the project origin is itself', isProject('http://127.0.0.1:4321'));
    check('  and the same server under its other name', isProject('http://localhost:4321') && isProject('http://[::1]:4321'));
    check('  but not another port', !isProject('http://127.0.0.1:4322'));
    check('  not another scheme', !isProject('https://127.0.0.1:4321'));
    check('  not somewhere else entirely', !isProject('http://evil.example') && !isProject('http://127.0.0.1.evil.example:4321'));
    check('  and not an opaque origin', !isProject(null) && !isProject('null') && !isProject(''));

    // The tolerance is for loopback ONLY. A project served from a real host does
    // not suddenly trust the machine it is being audited on.
    const remote = projectOriginTest('https://example.com');
    check('a non-loopback project trusts only itself', remote('https://example.com') && !remote('http://localhost:443') && !remote('https://localhost'));

    // And the origin reader: an opaque origin is not an origin, so a refusal can
    // say "an unreadable origin" instead of the word "null".
    check('an opaque origin reads as none', originOf('data:text/html,x') === null && originOf('about:blank') === null && originOf('javascript:1') === null);
    check('  a real one reads as itself', originOf('http://127.0.0.1:4321/a/b?c') === 'http://127.0.0.1:4321');
    check('  and a userinfo spoof reads as the real host', originOf('http://127.0.0.1:4321@evil.example/x') === 'http://evil.example');
  }

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
    const { FakeWindow } = countingWindows({ axe: busyPage() });
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: sessionFailingFrom(3) });
    const res = await audit.run({ route: '/', viewports: ['phone'] });
    // The control: the identical page, cleaning up properly.
    const clean = await createAudit({
      BrowserWindow: countingWindows({ axe: busyPage() }).FakeWindow,
      getPreviewUrl: () => base,
      session: sessionFailingFrom(999),
    }).run({ route: '/', viewports: ['phone'] });

    check('a cleanup failure cannot return an ordinary success', res.ok !== true, short(res));
    check('  and it says the session was not cleaned', res.code === 'session_not_cleaned', short(res.code));
    // NOT `!== true` on a field that is absent either way. The result carries an
    // engine block, and its isolation claim is false rather than missing.
    check('  and its engine block says isolation failed', res.engine && res.engine.sessionIsolated === false, short(res.engine));
    // "Handed back what it measured" as a NUMBER, against the same page audited
    // cleanly. `Array.isArray([])` was true of an implementation that returned
    // nothing at all.
    check('  while still handing back what it did measure', res.findingCount === clean.findingCount && res.findingCount === 105, `${res.findingCount} vs ${clean.findingCount}`);
    check('  the same findings the clean run returns', res.returnedFindingCount === clean.returnedFindingCount && (res.findings || []).length === clean.findings.length, `${res.findings?.length} vs ${clean.findings?.length}`);
    // THE BUCKET A FLAT SLICE EATS FIRST.
    check(
      '  including the incomplete bucket the cap reserves',
      (res.findings || []).filter((f) => f.kind === 'incomplete').length === clean.findings.filter((f) => f.kind === 'incomplete').length &&
        (res.findings || []).some((f) => f.kind === 'incomplete'),
      `${(res.findings || []).filter((f) => f.kind === 'incomplete').length} incomplete kept`
    );
    // And the sentence the payload is required to carry, on this path too.
    check('  and the limits sentence, which is the one quoted out of context', /does not mean WCAG compliant/.test(String(res.limits)), short(res.limits));
    check('  and the truncation accounting', !!res.truncation && res.truncation.detected === 105 && res.truncated === true, short(res.truncation));
  }

  // --- AFTER, with the engine broken as well: a failure must not become a page
  //     with nothing wrong with it.
  {
    const { FakeWindow } = countingWindows({ axeThrows: true });
    const audit = createAudit({ BrowserWindow: FakeWindow, getPreviewUrl: () => base, session: sessionFailingFrom(3) });
    const res = await audit.run({ route: '/', viewports: ['phone'] });
    check('a broken engine is still reported when the cleanup fails', /axe blew up/.test(String(res.engine?.error)), short(res.engine));
    check('  and the run is not passed off as a clean page', res.ok === false && res.findingCount === 0 && res.engine?.accessibility === null, short(res));
  }

  // --- AFTER, with a capture asked for: taken, paid for, and not thrown away.
  {
    const { FakeWindow } = countingWindows({ capturable: true });
    const audit = createAudit({
      BrowserWindow: FakeWindow,
      getPreviewUrl: () => base,
      session: sessionFailingFrom(3),
      encodeImage: () => ({ buffer: Buffer.from('img'), size: { width: 375, height: 800 } }),
    });
    const res = await audit.run({ route: '/', viewports: ['phone'], capture: true });
    check('a capture survives a cleanup failure', Array.isArray(res.captures) && res.captures.length === 1, short(res.captures?.length));
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
  console.log(`audit-session-failure: ${checked} passed  [the origin test, and: no clean session, no audit]`);
})().catch((err) => {
  console.error('audit-session-failure threw\n', err);
  process.exit(1);
});
