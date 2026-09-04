// One row per viewport a picture was asked for.
//
//   node test/audit-capture-rows.js
//
// `captures[]` is metadata about pictures, and the tool description promises a
// row for every viewport the caller asked about, with `included` carrying the
// difference between "here it is" and "there isn't one". A row that is ABSENT
// says nothing at all — which is exactly what a caller got when the window
// handed back an empty frame: two viewports asked about, `captures: []`, and
// one counter in `dropped` as the only trace of it. The comment in
// electron/mcp/audit/index.js says a missing row is the dishonesty the capture
// block exists to prevent; this file is what makes that true.
//
// It also pins the half a `included: false` row on its own cannot say: WHY
// there is no picture. Only a byte budget is fixed by asking again for one
// viewport at a time, and `next` used to tell a caller to do exactly that about
// a frame that will come back empty however narrow the call.

const { createAudit, liveWindowCount } = require('../electron/mcp/audit');

const failures = [];
let checked = 0;
const short = (v, n = 400) => JSON.stringify(v ?? null).slice(0, n);
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const AXE_QUIET = { version: '4.13.0', violations: [], incomplete: [], passCount: 0, inapplicableCount: 0 };
const GEO_QUIET = {
  viewportWidth: 375,
  documentScrollWidth: 375,
  overflowBy: 0,
  overflows: false,
  culprits: [],
  culpritTotal: 0,
  truncated: false,
};

/** A window whose compositor either has a frame or does not. */
function windowsWhoseFrameIs(blank) {
  return class FakeWindow {
    constructor() {
      this.webContents = {
        on: () => {},
        once: (event, fn) => {
          if (event === 'did-finish-load') setImmediate(fn);
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: async (src) => {
          if (typeof src === 'string' && src.includes('documentElement')) return GEO_QUIET;
          if (typeof src === 'string' && src.includes('axe.run')) return AXE_QUIET;
          return { title: 'fake', readyState: 'complete' };
        },
        getURL: () => 'http://127.0.0.1:4321/',
        capturePage: async () => ({ isEmpty: () => blank }),
      };
    }
    async loadURL() {}
    setContentSize() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  };
}

const cleanSession = {
  fromPartition: () => ({
    clearStorageData: async () => {},
    clearCache: async () => {},
    clearAuthCache: async () => {},
  }),
};

const jpeg = () => ({ buffer: Buffer.alloc(1000, 7), size: { width: 100, height: 100 } });

const audit = (blank, encodeImage) =>
  createAudit({
    BrowserWindow: windowsWhoseFrameIs(blank),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: cleanSession,
    ...(encodeImage ? { encodeImage } : {}),
  });

(async () => {
  // --- 1. A BLANK FRAME IS STILL AN ANSWER ABOUT THAT VIEWPORT.
  {
    const res = await audit(true, jpeg).run({ route: '/x', viewports: ['phone', 'tablet'], capture: true, rules: [] });
    check('the audit of a page that paints nothing still succeeds', res.ok === true, short({ ok: res.ok, code: res.code }));
    check(
      'two viewports asked about produce two capture rows',
      Array.isArray(res.captures) && res.captures.length === 2,
      short(res.captures)
    );
    check(
      '  and both of them say there is no picture',
      (res.captures || []).every((c) => c.included === false && c.bytes === null && c.sha256 === null),
      short(res.captures)
    );
    check(
      '  naming the viewport each one is about, so the rows can be told apart',
      (res.captures || []).map((c) => c.viewport.key).join(',') === 'phone,tablet',
      short((res.captures || []).map((c) => c.viewport))
    );
    check(
      '  and saying WHY, in a field and not only in prose',
      (res.captures || []).every((c) => c.omittedBecause === 'empty_frame' && /empty frame/i.test(c.note)),
      short((res.captures || []).map((c) => ({ because: c.omittedBecause, note: c.note })))
    );
    check('no image block was sent for either', (res.images || []).length === 0, short((res.images || []).length));
    check(
      'the counter that used to be the only evidence still agrees with the rows',
      res.dropped?.capturesRequestedButNotTaken === 2 && res.truncation?.omittedCaptureCount === 2,
      short({ dropped: res.dropped, omitted: res.truncation?.omittedCaptureCount })
    );
    // ADVICE THAT CANNOT TERMINATE IS NOT ADVICE. Re-running for one viewport
    // at a time gets a picture past a byte budget; it does nothing at all about
    // a window that painted nothing.
    check(
      'and the answer does not tell the caller to re-run for a frame that will be empty again',
      res.next == null,
      short(res.next)
    );
  }

  // --- 2. THE POSITIVE CONTROL. Same call, a window that has a frame.
  {
    const res = await audit(false, jpeg).run({ route: '/x', viewports: ['phone', 'tablet'], capture: true, rules: [] });
    check('a page that paints gets two rows too', (res.captures || []).length === 2, short((res.captures || []).length));
    check(
      '  both included, both carrying the identity of their picture',
      (res.captures || []).every((c) => c.included === true && typeof c.sha256 === 'string' && c.bytes === 1000),
      short(res.captures)
    );
    check('  with no reason to give for an omission that did not happen', (res.captures || []).every((c) => c.omittedBecause === undefined), short(res.captures));
    check('and two image blocks were sent', (res.images || []).length === 2, short((res.images || []).length));
    check('nothing was requested and not taken', res.dropped?.capturesRequestedButNotTaken === 0, short(res.dropped));
  }

  // --- 3. NO ENCODER WIRED AT ALL.
  //
  // Production always wires one (electron/mcp/index.js), so this is about the
  // module as a library: `capture: true` used to produce no row, no image, and
  // `capturesRequestedButNotTaken: 0` — three fields all saying nothing
  // happened, about a request that was made and never attempted.
  {
    const res = await audit(false, null).run({ route: '/x', viewports: ['phone'], capture: true, rules: [] });
    check('a capture asked for with no encoder is still a row', (res.captures || []).length === 1, short(res.captures));
    check(
      '  saying it was never attempted, rather than saying nothing',
      res.captures?.[0]?.included === false && res.captures[0].omittedBecause === 'no_encoder',
      short(res.captures?.[0])
    );
    check(
      '  and counted as a picture that was asked for and not taken',
      res.dropped?.capturesRequestedButNotTaken === 1,
      short(res.dropped)
    );
    check('and no retry hint, because a narrower call would not help either', res.next == null, short(res.next));
  }

  // --- 4. NOT ASKING FOR A PICTURE STILL MEANS NO ROWS.
  //
  // The rule is one row per viewport a picture was asked FOR. A plain audit
  // must not start carrying empty capture metadata.
  {
    const res = await audit(true, jpeg).run({ route: '/x', viewports: ['phone', 'tablet'], rules: [] });
    check('an audit that asked for no picture has no capture rows', (res.captures || []).length === 0, short(res.captures));
    check('  and nothing counted as not taken', (res.dropped?.capturesRequestedButNotTaken ?? 0) === 0, short(res.dropped));
  }

  check('every audit window this suite opened was destroyed', liveWindowCount() === 0, short({ live: liveWindowCount() }));

  if (failures.length) {
    console.error(`audit-capture-rows: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-capture-rows: ${checked} passed  [one row per viewport asked about, and why there is no picture]`);
})().catch((err) => {
  console.error('audit-capture-rows: threw\n', err?.stack || err);
  process.exit(1);
});
