// Measuring the real page, in a browser Stacki already owns.
//
// WHY NOT THE CANVAS. The obvious idea is to measure the preview the person is
// looking at. It is wrong twice over.
//
// First, it is not the site. The canvas iframe is loaded with `#avb-design`, and
// in that mode the page keeps the <template> markers that let the editor address
// nodes. A <template> is an element, and `:nth-child` counts it -- so every
// nth-child rule in the project resolves differently there than it does for a
// visitor. An audit of that page reports on a document nobody will ever see.
//
// Second, it is somebody's screen. Auditing three viewports means resizing their
// preview three times, and every failure mode of that -- a resize that does not
// come back, a scroll position lost, focus moved -- lands on a person who was in
// the middle of something.
//
// So the audit renders the page again, off screen, in a window of its own. That
// is not a second browser: `electron/thumbs.js` has always done exactly this to
// photograph a project, for the same reason ("nothing is photographed through the
// app any more"). This is that window, with a measurement instead of a camera.
//
// The URL is the dev server Stacki is already running, WITHOUT the design hash.
// That gets both halves right at once: the page lays out exactly as a visitor's
// would, because the markers remove themselves outside design mode -- and the
// `data-avb-p` attributes and comment markers survive, so a box on the screen can
// still be traced back to a node in a file. It is the one configuration that is
// both true to the site and traceable to the source.
//
// EVERY WINDOW IS OWNED. Audit windows are held in a module-level registry keyed
// by a run id, destroyed in a `finally`, and countable from outside so a test can
// assert none survived. A hidden window that leaks is invisible by construction,
// which is exactly why it has to be counted rather than trusted.

const fs = require('node:fs');
const path = require('node:path');

const { FREEZE, SETTLE, OVERFLOW } = require('./probe');
const { overflowFinding, unattributedOverflowFinding, axeFinding, sortFindings } = require('./findings');
const { resolveViewports } = require('../viewports');

const LOAD_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 30000;
// A page whose fonts and first paint have landed still moves for a moment.
// thumbs.js waits 1800ms because it is photographing a hero animation; a
// measurement needs the layout to be final, not the animation to be over, and
// the freeze stylesheet has already stopped the animation.
const SETTLE_MS = 250;

// The response budget. An audit that returns four hundred findings is a context
// bomb, and one that silently returns the first twenty is a lie. So: a cap, and
// the truth about it in the result.
const MAX_FINDINGS = 60;
// AND THE BUDGET THAT ACTUALLY BINDS: bytes.
//
// A cap on the NUMBER of findings says nothing about how big they are. Sixty
// findings off a dense page serialize to about 80 KB, and a native Claude Code
// dogfood had 19 of 72 audit calls (26%) refused by the host --
// `result (N characters) exceeds maximum allowed tokens` -- between 52,640 and
// 428,948 characters, in the default configuration, on the plainest possible
// call. The count cap was green through every one of them.
//
// WHY BYTES AND NOT TOKENS. Stacki does not know the host's tokenizer, its
// version, or its limit, and a budget tuned to one client is a budget that
// breaks on the next. Bytes are the thing the server can actually count, and
// they are counted on the serialized payload rather than estimated from the
// finding list. The number is chosen well under the smallest result this host
// was measured to refuse, so the margin absorbs whatever the tokenizer does.
//
// The envelope sends this payload TWICE -- `structuredContent` and a JSON copy
// in a text block (agentTools.js `answer`) -- so the wire cost is about twice
// this. The host counts the text block, which is what this bounds.
const MAX_RESPONSE_BYTES = 30000;
// A quarter of the byte budget is held for `incomplete`, for exactly the reason
// a quarter of the count budget is: they sort last, so a straight walk down the
// list spends the whole budget on violations and empties the one bucket whose
// entire purpose is honest uncertainty. A floor, not a ceiling.
const INCOMPLETE_BYTE_SHARE = 0.25;
// PER-FIELD CAPS, because the count cap is not a bound while one field is
// unbounded. `evidence.html` and `evidence.failureSummary` are already clipped
// to 240 where they are collected; these are the five that were not. Three
// findings with a 20 KB selector serialize to half a megabyte and never come
// near the sixty-finding cap.
const FIELD_CAPS = {
  message: 400,
  standard: 120,
  help: 200,
  selector: 300,
  modelPath: 300,
};
const MAX_CAPTURES = 3;
// axe can return hundreds of nodes for one rule on a big page. Twelve is enough
// to act on and the number is reported rather than assumed.
const AXE_NODES_PER_RULE = 12;

// ONE in-memory partition, and it is CLEARED AT EVERY AUDIT BOUNDARY.
//
// The partition alone was not isolation, and the comment that used to sit here
// said it was. Measured, on this Electron, with two windows on one origin: a
// window that set a cookie and a localStorage value, destroyed, then a FRESH
// window on the same partition -- which read back `probe=FROM_A` and `FROM_A`.
// The session survives its last window, so audit N+1 inherited audit N. Not
// persisted to disk is a different property from not shared between runs, and
// only the first was ever true.
//
// A partition per run would isolate, and would mint a Session object per audit
// for the life of the process. So: one bounded session, wiped at the boundary.
// clearStorageData covers cookies, DOM storage, IndexedDB, service workers and
// cache storage; clearCache and clearAuthCache take the two that sit outside it.
// Verified to bring a following window back to `cookie: ""`, `localStorage:
// null`, across two consecutive cycles.
const AUDIT_PARTITION = 'stacki-audit';

/**
 * Wipe the audit session.
 *
 * `session` arrives through the factory rather than being required here, so this
 * module still loads in a plain node process and a test can hand it a fake.
 */
async function resetAuditSession(session) {
  if (!session || typeof session.fromPartition !== 'function') {
    return { ok: false, reason: 'this build handed the audit no session API, so its browser state cannot be cleared' };
  }
  try {
    const ses = session.fromPartition(AUDIT_PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    // Present since Electron 2; guarded because a fake in a test need not have it.
    if (typeof ses.clearAuthCache === 'function') await ses.clearAuthCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

// axe.min.js rather than the package's own `source` property: that one is the
// UNMINIFIED build at 1.3 MB, and this string is injected into a page on every
// viewport of every audit. The minified file is 580 KB and behaves identically.
//
// Resolved lazily, and cached, so the cost is paid by the first audit rather
// than by starting the app.
let axeSourceCache = null;
function axeSource() {
  if (axeSourceCache) return axeSourceCache;
  const file = require.resolve('axe-core/axe.min.js');
  axeSourceCache = fs.readFileSync(file, 'utf8');
  return axeSourceCache;
}

/** Every audit window alive right now, so cleanup can be proven rather than assumed. */
const liveWindows = new Map();
const liveWindowCount = () => liveWindows.size;

let runSeq = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The origin of a URL, or null when it does not have one.
 *
 * `data:`, `about:`, `file:` and `javascript:` are OPAQUE origins, and the URL
 * standard spells those as the string "null". Returning that string put the word
 * "null" into a refusal message as though it were a hostname and stopped the
 * "unreadable origin" wording ever being reached. An opaque origin is not an
 * origin, so it comes back as one.
 */
function originOf(u) {
  try {
    const origin = new URL(u).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

// THE SAME SERVER, SPELLED TWO WAYS.
//
// The preview URL Stacki builds itself is `http://127.0.0.1:PORT`, but a dev
// server the user started and Stacki adopted is scraped from Astro's own output,
// which prints `http://localhost:PORT`. Those are different origins to a string
// compare, so a redirect between them -- which frameworks do -- would have been
// refused as "outside the project" on a page that never left the machine. Same
// scheme, same port and both names for the loopback interface is the same server.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A test for "is this origin the project's", tolerant of loopback spelling only. */
function projectOriginTest(projectOrigin) {
  let base = null;
  try {
    base = new URL(projectOrigin);
  } catch {
    /* falls through to an exact compare, which will simply never match */
  }
  const loopback = !!base && LOOPBACK_NAMES.has(base.hostname);
  return (origin) => {
    if (!origin) return false;
    if (origin === projectOrigin) return true;
    if (!loopback) return false;
    let other = null;
    try {
      other = new URL(origin);
    } catch {
      return false;
    }
    return other.protocol === base.protocol && other.port === base.port && LOOPBACK_NAMES.has(other.hostname);
  };
}

/** The path+query of a URL, for reporting which document was actually measured. */
function routeOf(u) {
  try {
    const parsed = new URL(u);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

// The sentence that goes on every answer. Named because the response budget has
// to measure the result's non-finding overhead before the result exists, and two
// copies of this paragraph would drift.
const LIMITS_SENTENCE =
  'Automated rules find roughly half of the accessibility problems a real audit finds. No violations does not ' +
  'mean accessible and does not mean WCAG compliant. `incomplete` findings are neither passes nor failures - ' +
  'a person has to look at them.';

/** The serialized size of a value, in the bytes a host counts. */
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

/**
 * A finding with its unbounded fields brought inside a cap, saying which.
 *
 * The shortening is NAMED in the finding, because a clipped selector still
 * looks like a selector and a reader who is not told cannot know that the one
 * they were handed will not match. Nothing here decides whether a finding is
 * worth keeping -- that is the budget's job below -- and nothing is dropped:
 * every field survives, shorter.
 */
function clipFinding(finding) {
  const truncatedFields = [];
  const clip = (value, cap, name) => {
    if (typeof value !== 'string' || value.length <= cap) return value;
    truncatedFields.push(name);
    return `${value.slice(0, cap)}…`;
  };
  const target = finding.target || null;
  const clippedTarget = target
    ? {
        ...target,
        selector: clip(target.selector, FIELD_CAPS.selector, 'target.selector'),
        modelPath: clip(target.modelPath, FIELD_CAPS.modelPath, 'target.modelPath'),
      }
    : target;
  const out = {
    ...finding,
    message: clip(finding.message, FIELD_CAPS.message, 'message'),
    standard: clip(finding.standard, FIELD_CAPS.standard, 'standard'),
    help: clip(finding.help, FIELD_CAPS.help, 'help'),
    ...(clippedTarget ? { target: clippedTarget } : {}),
  };
  // Absent rather than empty, so an untouched finding is the shape it always
  // was and a reader can test the field's presence.
  if (truncatedFields.length) out.truncatedFields = truncatedFields;
  return out;
}

/**
 * As many findings as fit, most important first, undecided keeping their floor.
 *
 * Mirrors the count cap deliberately: the two buckets are filled separately so
 * that a page whose violations would swallow the whole budget still returns
 * some of what the engine could not decide. `overhead` is the measured size of
 * everything in the result that is not a finding, so the budget is spent on the
 * answer rather than on an estimate of it.
 */
function fitToBytes(sorted, overhead, budget = MAX_RESPONSE_BYTES) {
  const room = Math.max(0, budget - overhead);
  const sized = sorted.map((f) => ({ finding: f, bytes: jsonBytes(f) + 1 }));
  const undecided = sized.filter((s) => s.finding.kind === 'incomplete');
  const decided = sized.filter((s) => s.finding.kind !== 'incomplete');

  const fill = (list, allowance) => {
    const out = [];
    let used = 0;
    for (const item of list) {
      if (used + item.bytes > allowance) break;
      out.push(item.finding);
      used += item.bytes;
    }
    return { out, used };
  };

  // What the undecided bucket would actually use, capped at its share. Taking
  // the smaller of the two is what makes this a floor: a page with two
  // incomplete findings does not reserve a quarter of the budget for them.
  const wanted = undecided.reduce((n, s) => n + s.bytes, 0);
  const reserve = Math.min(wanted, Math.floor(room * INCOMPLETE_BYTE_SHARE));

  const first = fill(decided, room - reserve);
  const second = fill(undecided, room - first.used);
  return [...first.out, ...second.out];
}

/** Reject rather than hang for ever on a page that never loads. */
function withTimeout(promise, ms, what) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_res, rej) => {
      timer = setTimeout(() => rej(new Error(`${what} did not finish within ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * The window an audit renders in.
 *
 * Deliberately the same shape as thumbs.js's: no preload, no node, sandboxed,
 * hidden but painting. `partition` keeps its storage out of anything else's --
 * an audit must not inherit a login or leave one behind.
 */
function makeAuditWindow(BrowserWindow, { width, height, partition, isProjectOrigin, onBlocked, onSubframeBlocked }) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      paintWhenInitiallyHidden: true,
      offscreen: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      backgroundThrottling: false,
      images: true,
      partition,
    },
  });
  // THE AUDITED PAGE MAY NOT OPEN A WINDOW.
  //
  // window.open(), or a target=_blank link the page follows itself, would put a
  // VISIBLE window on somebody's screen in the middle of an audit -- taking
  // focus, outliving the run, and never appearing in the registry below, because
  // only windows this file made are in it. The page is not trusted; it does not
  // get to create UI.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // NAVIGATION, INCLUDING THE KIND `will-navigate` NEVER SEES.
  //
  // A server-side redirect is not a navigation the page initiated, so
  // `will-navigate` does not fire for it. Electron raises `will-redirect`
  // instead, and the previous guard listened only for the former. Measured
  // against a project route answering 302 to a second local origin: the audit
  // loaded that origin, ran axe on it, and returned three of ITS findings under
  // the project's route and URL. A third-party document reported as the project.
  //
  // So both events, and the same rule for each: leaving the project's origin is
  // refused; staying on it is ordinary visitor behaviour and is allowed, with the
  // page that is finally measured reported truthfully.
  //
  // AND THE FRAMES UNDERNEATH IT, INCLUDING THE ONES THAT LEAVE LATER.
  //
  // THE INVARIANT: no off-origin document loads in ANY frame of this window.
  //
  // Three events are needed for that, and each of them can be about the main
  // frame or about one underneath it. `will-navigate` is documented as the main
  // frame's; `will-frame-navigate` sees a frame's FIRST navigation; and a frame's
  // SERVER can still answer that first navigation with a redirect, which arrives
  // as `will-redirect` for that same frame.
  //
  // That last case is what escaped. The redirect guard asked `isMainFrame` and
  // returned early when it was false, on the reasoning that subframes were
  // will-frame-navigate's business -- but will-frame-navigate had already seen
  // and allowed the frame's SAME-ORIGIN first hop. Measured against that code:
  //
  //   page -> <iframe src="/frame-redirect">      same origin, allowed
  //   /frame-redirect -> 302 to a second origin   will-redirect, isMainFrame:false
  //   ... ignored, and the second origin served two requests: the document and
  //       an image inside it, rendered in the audit window, with ok:true and
  //       nothing named in blockedSubframeOrigins.
  //
  // So no event asks WHICH event it is any more. Every one of them asks the same
  // two questions in the same order: is the target this project's, and if not, is
  // this the main frame or one underneath it. What differs is only the REPORT --
  // the main document leaving fails the audit, a frame leaving drops that frame
  // and is named, because a page that embeds a video is an ordinary page and not
  // a reason to refuse the run.
  const allowed = (target) => isProjectOrigin(originOf(target));
  const frameOf = (details, positionalUrl) => {
    const target = typeof details?.url === 'string' ? details.url : positionalUrl;
    // `isMainFrame` is on the details object in this Electron; if some build ever
    // omits it, treating the event as the main frame's keeps the strict path.
    const isMain = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : true;
    return { target, isMain };
  };
  const guard = (kind) => (details, positionalUrl) => {
    const { target, isMain } = frameOf(details, positionalUrl);
    if (allowed(target)) return;
    details.preventDefault();
    if (isMain) onBlocked?.({ kind, target });
    else onSubframeBlocked?.(originOf(target));
  };
  win.webContents.on('will-redirect', guard('redirect'));
  win.webContents.on('will-navigate', guard('navigate'));
  // Fires for the main frame too, which is harmless: an off-origin main-frame
  // navigation is refused by whichever of the two sees it first, and `blocked`
  // keeps the first report.
  win.webContents.on('will-frame-navigate', guard('navigate'));
  return win;
}

/**
 * Run the accessibility engine, and give every result back a source location.
 *
 * axe answers in CSS selectors. Those are re-resolved in the page so the element
 * can be asked for its `data-avb-p` -- which is how a rule violation acquires a
 * truthful Stacki path, or honestly acquires none.
 */
function axeScript({ rules }) {
  const runOnly = rules && rules.length
    ? `{ type: 'rule', values: ${JSON.stringify(rules)} }`
    : `{ type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22a','wcag22aa'] }`;
  return `(async () => {
    // BOTH buckets. resultTypes limits which result arrays keep their full node
    // lists; anything omitted is truncated to ONE node per rule. Asking only for
    // violations therefore quietly reduced every incomplete result to a single
    // node -- while the payload went on presenting incomplete as a first-class
    // bucket that a person has to look at.
    const res = await axe.run(document, { resultTypes: ['violations', 'incomplete'], runOnly: ${runOnly} });
    const locate = (target) => {
      // A SHADOW OR FRAME PATH IS NOT A SELECTOR.
      //
      // axe answers with an ARRAY when the node is inside a shadow root or an
      // iframe: each entry is a hop. Taking the last hop and running it against
      // the top document finds some OTHER element that happens to match -- and
      // then reads its data-avb-p and reports it as this finding's source, with
      // exact:true. A confidently wrong file location is worse than none, so a
      // multi-hop target resolves to nothing and says why.
      if (Array.isArray(target) && target.length > 1) {
        return { refPath: null, rect: null, tag: null, crossBoundary: true };
      }
      let el = null;
      try { el = document.querySelector(Array.isArray(target) ? target[0] : target); } catch {}
      if (!el) return { refPath: null, rect: null, tag: null };
      let n = el, refPath = null;
      while (n && n.nodeType === 1) {
        const p = n.getAttribute && n.getAttribute('data-avb-p');
        if (p) { refPath = { path: p, exact: n === el }; break; }
        n = n.parentElement;
      }
      const r = el.getBoundingClientRect();
      return { refPath, tag: el.tagName.toLowerCase(),
               rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
    };
    // nodeTotal is the number axe ACTUALLY found for this rule, carried out
    // alongside the capped list. Without it the slice below is the only number
    // that ever reaches Stacki, and a rule with fifty offenders is
    // indistinguishable from one with twelve.
    const pack = (list, bucket) => list.map((rule) => ({
      id: rule.id, impact: rule.impact, help: rule.help, helpUrl: rule.helpUrl, tags: rule.tags,
      bucket,
      nodeTotal: rule.nodes.length,
      nodes: rule.nodes.slice(0, ${AXE_NODES_PER_RULE}).map((n) => ({
        target: n.target,
        html: String(n.html || '').slice(0, 240),
        failureSummary: String(n.failureSummary || '').replace(/\\s+/g, ' ').slice(0, 240),
        ...locate(n.target),
      })),
    }));
    return {
      version: axe.version,
      violations: pack(res.violations, 'violation'),
      incomplete: pack(res.incomplete, 'incomplete'),
      passCount: (res.passes || []).length,
      inapplicableCount: (res.inapplicable || []).length,
    };
  })()`;
}

/**
 * Build the audit.
 *
 * Everything Electron arrives as an argument, so the orchestration can be tested
 * without an app and the module can be required in a plain node process.
 */
function createAudit({ BrowserWindow, getPreviewUrl, encodeImage = null, session = null }) {
  // ONE AUDIT AT A TIME.
  //
  // The session is shared and wiped at the boundary, so two overlapping runs
  // would clear each other's state halfway through and report on a page whose
  // cookies vanished underneath it. Runs queue instead. This is a real
  // constraint of the design, not an oversight: the alternative is a session per
  // run, which is the unbounded thing being avoided.
  let queue = Promise.resolve();
  /**
   * @param {object} opts
   * @param {string=} opts.route          route to audit; defaults to the site root
   * @param {Array=}  opts.viewports      names or {width,height}; defaults to phone/tablet/desktop
   * @param {Array=}  opts.rules          specific accessibility rule ids; defaults to WCAG A/AA
   * @param {boolean=} opts.capture       return a screenshot per viewport
   */
  async function run(opts = {}) {
    // Chain rather than reject: a second audit waits its turn.
    const mine = queue.then(() => runExclusive(opts));
    queue = mine.catch(() => {});
    return mine;
  }

  async function runExclusive({ route = '/', viewports: wanted, rules = null, capture = false } = {}) {
    const chosen = resolveViewports(wanted);
    if (!chosen.ok) return chosen;

    const base = getPreviewUrl();
    if (!base) {
      return {
        ok: false,
        code: 'no_preview',
        message: 'Stacki has no dev server running for this project, so there is no page to audit. Start the preview first.',
      };
    }

    const runId = `audit-${process.pid}-${++runSeq}`;
    // THE ROUTE IS UNTRUSTED INPUT, AND A LEADING SLASH PROVES NOTHING.
    //
    // `//evil.example/x` starts with a slash and resolves, against any base, to
    // a DIFFERENT ORIGIN -- so the audit would render a third-party site in a
    // window Stacki opened, and report on it as though it were the project. And
    // `/#avb-design` resolves to the project's own root wearing the one hash
    // that turns the page into the canvas document, which is the exact thing
    // this engine exists not to measure.
    //
    // So: resolve first, then check the result. Same origin as the dev server, no
    // hash, or it is refused by name.
    const baseHref = base.endsWith('/') ? base : `${base}/`;
    let resolved;
    try {
      resolved = new URL(String(route || '/'), baseHref);
    } catch {
      return { ok: false, code: 'bad_route', message: `${route} is not a route this project can serve.` };
    }
    if (resolved.origin !== new URL(baseHref).origin) {
      return {
        ok: false,
        code: 'route_outside_project',
        message:
          `${route} resolves to ${resolved.origin}, which is not the project Stacki is serving. ` +
          'The audit only ever renders this project.',
      };
    }
    // The hash is dropped rather than refused: it changes nothing a visitor sees
    // except `#avb-design`, and silently keeping that one would be the bug.
    resolved.hash = '';
    const safeRoute = `${resolved.pathname}${resolved.search}`;
    const url = resolved.href;
    // The one origin this audit is allowed to measure, decided once from the dev
    // server the app is running and never from anything a page says.
    const projectOrigin = new URL(baseHref).origin;
    const isProjectOrigin = projectOriginTest(projectOrigin);
    // Off-origin frames that were dropped so the page could still be measured.
    // Named in the result: a page rendered without its embeds is not the page a
    // visitor sees, and the caller is entitled to know which ones went.
    const blockedSubframes = new Set();
    // Where the audit actually ENDED, when a same-origin redirect moved it. The
    // caller asked about one route and may have been shown another; both are
    // reported rather than only the one that was asked for.
    const finalRoutes = new Set();

    const findings = [];
    const captures = [];
    let capturesWanted = 0;
    const perViewport = [];
    let axeVersion = null;
    let engineError = null;
    let sessionReset = null;
    let cleanupReset = null;
    // THE TRUE NUMBER DETECTED, counted before any cap discards anything.
    //
    // findingCount used to be `sorted.length`, described in a comment as "the
    // true one". It was the number that SURVIVED two earlier caps: twelve axe
    // nodes per rule inside the page, and forty geometry culprits. A rule with
    // fifty violations reported twelve and called it the total.
    let detectedTotal = 0;
    const omittedBefore = { geometryCulprits: 0, axeNodes: 0 };

    try {
      // BEFORE: nothing this audit sees was put there by the last one -- and if
      // that cannot be CONFIRMED, nothing is measured at all.
      //
      // This used to record the result and carry on, so an audit whose session
      // could not be cleared still ran, still returned ok:true, and still carried
      // `sessionIsolated`. A result that cannot support its own isolation claim
      // is worse than no result.
      sessionReset = await resetAuditSession(session);
      if (!sessionReset.ok) {
        return {
          ok: false,
          code: 'session_not_isolated',
          message:
            `The audit could not start from a clean browser session: ${sessionReset.reason}. Nothing was ` +
            'measured, because findings from a session carrying another audit\'s cookies would not describe ' +
            'this page.',
          route: safeRoute,
          runId,
        };
      }
      for (const viewport of chosen.viewports) {
        const started = Date.now();
        let win = null;
        try {
          // AND BETWEEN VIEWPORTS. The mechanism documented at the top of this
          // file -- a destroyed window's cookies and storage surviving for the
          // next window on the same partition -- is just as true inside one run
          // as across two. Without this, a page that sets state on its first
          // visit shows the phone a first visit and the tablet a return visit,
          // and the two viewports are no longer measuring the same page.
          const between = await resetAuditSession(session);
          if (!between.ok) {
            return {
              ok: false,
              code: 'session_not_isolated',
              message:
                `The audit could not clear its session before the ${viewport.key} viewport: ${between.reason}. ` +
                'It stopped rather than measure a page carrying the previous viewport\'s state.',
              route: safeRoute,
              runId,
            };
          }
          // A FRESH WINDOW PER VIEWPORT, and the size set before the load.
          //
          // Resizing one loaded window is cheaper and re-evaluates media queries
          // correctly, but a page whose script reads innerWidth once on load
          // would then be laid out for the first width and stretched to the
          // rest. A visitor at 375 gets a page that loaded at 375, so that is
          // what gets measured.
          let blocked = null;
          // A CANCELLED NAVIGATION NEED NOT BE WAITED OUT.
          //
          // Blocking a redirect usually produces did-fail-load with ERR_ABORTED
          // straight away, but "usually" is not a contract: if neither load event
          // arrives, the refusal we have already decided on sat behind the full
          // twenty-second load timeout. The block is its own signal.
          let signalBlocked = () => {};
          const blockedSignal = new Promise((resolve) => {
            signalBlocked = resolve;
          });
          win = makeAuditWindow(BrowserWindow, {
            width: viewport.width,
            height: viewport.height,
            partition: AUDIT_PARTITION,
            isProjectOrigin,
            onBlocked: (info) => {
              if (!blocked) blocked = info;
              signalBlocked();
            },
            onSubframeBlocked: (origin) => {
              if (origin) blockedSubframes.add(origin);
            },
          });
          liveWindows.set(`${runId}:${viewport.key}`, win);

          // THE STATUS, NOT JUST THE LOAD.
          //
          // did-fail-load fires for network-level failures only. A 404 or a 500
          // returns a body, so it finishes loading like anything else -- and the
          // audit would measure Astro's dev 404 page, find a contrast problem on
          // it, and report that under the route the caller asked for. A typo in a
          // route would come back as findings about the project.
          let httpStatus = null;
          win.webContents.on('did-navigate', (_e, _url, code) => {
            if (typeof code === 'number' && httpStatus === null) httpStatus = code;
          });
          const loaded = new Promise((resolve, reject) => {
            win.webContents.once('did-finish-load', resolve);
            win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${desc || 'load failed'} (${code})`)));
          });
          loaded.catch(() => {});
          await win.loadURL(url).catch(() => {});
          // A BLOCKED NAVIGATION LOOKS LIKE A FAILED LOAD, and it is not one.
          //
          // preventDefault on will-redirect aborts the load, so did-fail-load
          // fires with ERR_ABORTED. Letting that reject first turned a refusal we
          // chose into a generic `audit_failed`, which tells the caller nothing
          // about why. The block is checked before the load result is believed.
          let loadError = null;
          try {
            await withTimeout(Promise.race([loaded, blockedSignal]), LOAD_TIMEOUT_MS, `loading ${safeRoute} at ${viewport.width}px`);
          } catch (err) {
            loadError = err;
          }
          if (blocked) {
            return {
              ok: false,
              code: 'route_outside_project',
              message:
                `${safeRoute} tried to ${blocked.kind === 'redirect' ? 'redirect' : 'navigate'} to another origin, ` +
                'which the audit refused. Nothing outside this project is measured, and nothing from that page is ' +
                'reported. Only the origin is named here — a page Stacki declined to load is not quoted.',
              blockedOrigin: originOf(blocked.target),
              route: safeRoute,
              runId,
            };
          }
          if (loadError) throw loadError;

          // THE BACKSTOP. Read the document that is ACTUALLY loaded, before
          // anything measures it.
          //
          // The two event guards above should make this unreachable, and that is
          // exactly why it is here: an audit that measures first and validates
          // afterwards has already run axe on somebody else's page. Event
          // semantics are a thing to be wrong about; the final URL is a fact.
          const finalUrl = win.webContents.getURL();
          if (!isProjectOrigin(originOf(finalUrl))) {
            return {
              ok: false,
              code: 'route_outside_project',
              message:
                `${safeRoute} ended on ${originOf(finalUrl) || 'an unreadable origin'}, which is not this project. ` +
                'Nothing was measured there.',
              blockedOrigin: originOf(finalUrl),
              route: safeRoute,
              runId,
            };
          }

          if (httpStatus !== null && httpStatus >= 400) {
            return {
              ok: false,
              code: 'route_not_ok',
              message:
                `${safeRoute} answered HTTP ${httpStatus}. That page renders and could be measured, but the ` +
                'findings would describe an error page rather than the route asked for, so nothing is reported.',
              status: httpStatus,
              route: safeRoute,
              runId,
            };
          }

          // A same-origin redirect is ordinary visitor behaviour and is followed.
          // What must not happen is reporting the page that was ASKED for when a
          // different one was measured.
          const landed = routeOf(finalUrl);
          if (landed && landed !== safeRoute) finalRoutes.add(landed);

          await win.webContents.executeJavaScript(FREEZE, true).catch(() => {});
          await withTimeout(win.webContents.executeJavaScript(SETTLE, true), PROBE_TIMEOUT_MS, 'settling the page');
          await wait(SETTLE_MS);

          // --- geometry
          const geo = await withTimeout(win.webContents.executeJavaScript(OVERFLOW, true), PROBE_TIMEOUT_MS, 'measuring overflow');
          if (geo.overflows) {
            // Every qualifying culprit counts, including the ones the in-page cap
            // did not hand back.
            detectedTotal += geo.culpritTotal || geo.culprits.length;
            omittedBefore.geometryCulprits += Math.max(0, (geo.culpritTotal || 0) - geo.culprits.length);
            for (const culprit of geo.culprits) {
              findings.push(
                overflowFinding({
                  viewport,
                  culprit,
                  documentOverflowBy: geo.overflowBy,
                  measured: { viewportWidth: geo.viewportWidth, documentScrollWidth: geo.documentScrollWidth },
                })
              );
            }
            // THE DOCUMENT SCROLLS AND NOTHING WAS BLAMED.
            //
            // Every culprit rule above is a reason NOT to blame an element, and
            // they can all be true at once: overflow from a text node with no box
            // of its own, from a margin, from something the walk cannot reach.
            // Reporting nothing then would be the worst possible answer -- the
            // page demonstrably scrolls sideways and the audit says it is fine.
            // So the measurement itself is the finding, with no element on it.
            if (geo.culprits.length === 0) {
              findings.push(unattributedOverflowFinding({ viewport, documentOverflowBy: geo.overflowBy }));
              detectedTotal += 1;
            }
          }

          // --- accessibility
          let axeResult = null;
          try {
            await win.webContents.executeJavaScript(axeSource(), true);
            axeResult = await withTimeout(win.webContents.executeJavaScript(axeScript({ rules }), true), PROBE_TIMEOUT_MS, 'running the accessibility engine');
            axeVersion = axeResult.version;
            for (const bucket of ['violation', 'incomplete']) {
              const rules = bucket === 'violation' ? axeResult.violations : axeResult.incomplete;
              for (const rule of rules) {
                const total = typeof rule.nodeTotal === 'number' ? rule.nodeTotal : rule.nodes.length;
                detectedTotal += total;
                omittedBefore.axeNodes += Math.max(0, total - rule.nodes.length);
                for (const node of rule.nodes) findings.push(axeFinding({ viewport, rule, node, bucket }));
              }
            }
          } catch (err) {
            // A page that breaks the engine must not silently become a clean
            // page. The audit reports what it could not do.
            engineError = String(err?.message || err).slice(0, 200);
          }

          // --- evidence
          //
          // Taken AFTER the measurements, from the same window, in the same
          // state, with nothing in between that could move the layout. The
          // caption and the picture are of one moment by construction.
          if (capture && encodeImage) capturesWanted += 1;
          if (capture && captures.length < MAX_CAPTURES && encodeImage) {
            const image = await win.webContents.capturePage();
            if (!image.isEmpty()) {
              const { buffer, size } = encodeImage(image, 'jpeg');
              captures.push({
                viewport: { key: viewport.key, width: viewport.width, height: viewport.height },
                mimeType: 'image/jpeg',
                bytes: buffer.length,
                width: size.width,
                height: size.height,
                data: buffer.toString('base64'),
              });
            }
          }

          // WHAT THE PAGE DID WHILE IT WAS BEING MEASURED.
          //
          // `blocked` was read once, immediately after the load, and never again
          // -- so a page that waited and THEN tried to leave (a delayed
          // meta-refresh, a timer in a load handler) had its navigation cancelled
          // correctly and reported as an ordinary successful audit. The refusal
          // happened; nobody was told. The same read also fixes the other half:
          // a same-origin move after the load changed which document was measured
          // without changing `finalRoutes`.
          if (blocked) {
            return {
              ok: false,
              code: 'route_outside_project',
              message:
                `${safeRoute} tried to ${blocked.kind === 'redirect' ? 'redirect' : 'navigate'} to another origin ` +
                'while it was being measured, which the audit refused. Nothing outside this project is measured, and ' +
                'the findings from this run are discarded because the page did not stay still. Only the origin is ' +
                'named here — a page Stacki declined to load is not quoted.',
              blockedOrigin: originOf(blocked.target),
              route: safeRoute,
              runId,
            };
          }
          const settledUrl = win.webContents.getURL();
          if (!isProjectOrigin(originOf(settledUrl))) {
            return {
              ok: false,
              code: 'route_outside_project',
              message:
                `${safeRoute} ended on ${originOf(settledUrl) || 'an unreadable origin'} while it was being ` +
                'measured, which is not this project. The findings from this run are discarded.',
              blockedOrigin: originOf(settledUrl),
              route: safeRoute,
              runId,
            };
          }
          const settledRoute = routeOf(settledUrl);
          if (settledRoute && settledRoute !== safeRoute) finalRoutes.add(settledRoute);

          perViewport.push({
            viewport: { key: viewport.key, width: viewport.width, height: viewport.height, device: viewport.device },
            documentScrollWidth: geo.documentScrollWidth,
            overflows: geo.overflows,
            overflowBy: geo.overflowBy,
            culpritsTruncated: !!geo.truncated,
            accessibility: axeResult
              ? {
                  violationRules: axeResult.violations.length,
                  incompleteRules: axeResult.incomplete.length,
                  passRules: axeResult.passCount,
                  inapplicableRules: axeResult.inapplicableCount,
                }
              : null,
            ms: Date.now() - started,
          });
        } finally {
          // DELETE ONLY IF IT ACTUALLY WENT. Removing the entry first and then
          // destroying meant a destroy that threw left a live window that the
          // leak count could no longer see -- the oracle reporting zero because
          // it had been told to stop looking.
          try {
            if (win && !win.isDestroyed()) win.destroy();
            liveWindows.delete(`${runId}:${viewport.key}`);
          } catch (err) {
            /* left in the registry on purpose: the count is the alarm */
          }
        }
      }
    } catch (err) {
      return { ok: false, code: 'audit_failed', message: String(err?.message || err).slice(0, 300), runId };
    } finally {
      // AFTER, on every path out including the ones that threw: nothing this
      // audit created outlives it for the next one to read.
      //
      // NOT `.catch(() => {})`. That swallowed exactly the failure the isolation
      // claim depends on -- an audit could leave a page's cookies behind for the
      // next one and still return an ordinary successful result.
      cleanupReset = await resetAuditSession(session);
    }

    const sorted = sortFindings(findings);
    // WHEN THE CAP BITES, IT MUST NOT EAT ONE BUCKET WHOLE.
    //
    // sortFindings ranks by severity, and every `incomplete` is severity `info`
    // -- last. So a page with sixty violations would have had its entire
    // incomplete bucket dropped, while `counts.incomplete` went on reporting the
    // true number: the one channel whose whole purpose is honest uncertainty,
    // silently emptied. A quarter of the budget is reserved for it.
    //
    // THE RESERVE IS A FLOOR. IT USED TO BE A CEILING, AND ON REAL PAGES THAT IS
    // THE ONLY WAY IT EVER BIT.
    //
    // `keptUndecided` was `undecided.slice(0, min(15, undecided.length))` --
    // never more than fifteen incomplete, whatever the rest of the budget was
    // doing. That is invisible against the audit's own fixture, which is seeded
    // with violations, and it is the normal case on a project somebody actually
    // wrote: surveying four upstream Astro examples, 105 of 129 findings came
    // back `incomplete` (axe cannot resolve a background it cannot see), and the
    // portfolio's home page detected 96, scored 36, and returned 15 -- with
    // forty-five slots of a sixty-slot budget unused and twenty-one findings
    // dropped for no reason at all. `truncated` said so, honestly, about a
    // truncation that did not need to happen.
    //
    // Decided findings still get first refusal on everything above the floor, so
    // a page with sixty violations is unchanged: fifteen incomplete survive and
    // forty-five violations fill the rest, exactly as before.
    const INCOMPLETE_SHARE = Math.floor(MAX_FINDINGS / 4);
    const undecided = sorted.filter((f) => f.kind === 'incomplete');
    const decided = sorted.filter((f) => f.kind !== 'incomplete');
    const floorUndecided = Math.min(INCOMPLETE_SHARE, undecided.length);
    const keptDecided = decided.slice(0, MAX_FINDINGS - floorUndecided);
    const keptUndecided = undecided.slice(0, MAX_FINDINGS - keptDecided.length);
    const byCount = sortFindings([...keptDecided, ...keptUndecided]);

    // AND THEN THE SECOND CAP, WHICH IS THE ONE THAT WAS MISSING.
    //
    // The count cap above has now chosen sixty. This asks the only question the
    // host will ask: how big is that? The fields are brought inside their caps
    // first -- shortening a selector keeps a finding, dropping a finding loses
    // one -- and then as many of the survivors as fit are taken, in the order
    // they were already in.
    //
    // The overhead is MEASURED, not guessed: everything the result carries that
    // is not a finding, serialized, so the budget is spent on the actual answer.
    // `truncation` and the counts are integers that are not known until after
    // the selection, so a small allowance stands in for them; being generous
    // there costs a finding, and being wrong the other way costs the promise.
    const clipped = byCount.map(clipFinding);
    const overhead =
      jsonBytes({
        ok: true,
        runId,
        route: safeRoute,
        ...(finalRoutes.size ? { finalRoutes: [...finalRoutes] } : {}),
        url,
        ...(blockedSubframes.size ? { blockedSubframeOrigins: [...blockedSubframes] } : {}),
        engine: { accessibility: axeVersion ? `axe-core ${axeVersion}` : null, error: engineError, sessionIsolated: true },
        viewports: perViewport,
        captures,
        limits: LIMITS_SENTENCE,
      }) + 512;
    const kept = fitToBytes(clipped, overhead);
    const omittedByBytes = clipped.length - kept.length;

    // ONE RESULT, BUILT ONCE.
    //
    // A cleanup failure used to return a hand-built object of its own, and every
    // field the real one has that it did not was a silent loss on a path that
    // still handed back findings: the reserved `incomplete` share, so a busy page
    // lost that whole bucket; `engine.error`, so a page that broke axe came back
    // as a clean page; the captures that had already been taken and paid for;
    // `finalRoutes`, on a path whose own message then named the route that was
    // ASKED for as the one measured. The failure changes the VERDICT, not the
    // measurements, so it is applied to this object rather than replacing it.
    const result = {
      ok: true,
      runId,
      route: safeRoute,
      // Present only when a same-origin redirect landed somewhere else. The
      // findings describe THIS document, not `route`.
      ...(finalRoutes.size ? { finalRoutes: [...finalRoutes] } : {}),
      url,
      // Off-origin documents this run refused to load INSIDE the page. Present
      // only when there were some: the page was measured without them.
      ...(blockedSubframes.size ? { blockedSubframeOrigins: [...blockedSubframes] } : {}),
      engine: {
        accessibility: axeVersion ? `axe-core ${axeVersion}` : null,
        error: engineError,
        // Whether the audit actually started from a wiped session AND left one,
        // rather than whether the code meant to. Both halves: a run that cannot
        // clear up after itself has not isolated the next audit from this one.
        sessionIsolated: sessionReset?.ok === true && cleanupReset?.ok === true,
      },
      viewports: perViewport,
      findings: kept,
      // THE TRUE TOTAL, counted before any cap discarded anything.
      //
      // `findingCount` is what the engine DETECTED. `returnedFindingCount` is
      // what is in `findings`. `truncated` is true if anything was dropped at
      // ANY layer -- the in-page geometry cap, the per-rule axe node cap, or the
      // response cap below. A caller reading 12 no longer has to wonder whether
      // that means "there were 12" or "there may have been 500".
      findingCount: detectedTotal,
      returnedFindingCount: kept.length,
      omittedFindingCount: Math.max(0, detectedTotal - kept.length),
      // EVERY PLACE SOMETHING WAS DROPPED, SAID OUT LOUD. The claim is that
      // nothing is silently discarded, and three things can be: elements past
      // the culprit cap, axe nodes past twelve per rule, and captures past three.
      // A caller that never hears about them cannot know to ask differently.
      // WHERE it was dropped, layer by layer, so the number above is checkable.
      truncation: {
        detected: detectedTotal,
        returned: kept.length,
        omitted: Math.max(0, detectedTotal - kept.length),
        // Discarded inside the page, before Stacki ever saw them.
        omittedBeforeScoring: omittedBefore,
        // Discarded by the finding-count cap, after scoring. This counts ONLY
        // that layer: it used to absorb everything between scoring and the
        // answer, and a byte budget hiding inside it would be exactly the
        // silent discard the rest of this block exists to prevent.
        omittedByResponseBudget: Math.max(0, sorted.length - byCount.length),
        // And discarded because the answer would not have fitted through the
        // host. Its own number, because it is its own reason: a caller seeing
        // this one knows to narrow the route or the viewports rather than to
        // assume the page has sixty problems.
        omittedByByteBudget: omittedByBytes,
        responseCap: MAX_FINDINGS,
        responseByteCap: MAX_RESPONSE_BYTES,
        incompleteReserved: INCOMPLETE_SHARE,
      },
      dropped: {
        culpritsTruncatedAtViewports: perViewport.filter((v) => v.culpritsTruncated).map((v) => v.viewport.key),
        axeNodesPerRuleCap: AXE_NODES_PER_RULE,
        captureCap: MAX_CAPTURES,
        capturesRequestedButNotTaken: capturesWanted > captures.length ? capturesWanted - captures.length : 0,
      },
      // Never a silent truncation. If there were more, the count is the true one
      // and the flag says the list is not.
      truncated: detectedTotal > kept.length,
      counts: {
        mechanical: sorted.filter((f) => f.kind === 'mechanical').length,
        standard: sorted.filter((f) => f.kind === 'standard').length,
        advisory: sorted.filter((f) => f.kind === 'advisory').length,
        incomplete: sorted.filter((f) => f.kind === 'incomplete').length,
      },
      captures,
      // Said in the payload, not only in the documentation, because this is the
      // sentence somebody will quote out of context.
      limits: LIMITS_SENTENCE,
    };

    // AN AUDIT THAT COULD NOT CLEAN UP IS NOT AN ISOLATED AUDIT.
    //
    // The measurements are real and are all still here -- throwing them away
    // would help nobody -- but the verdict is ok:false and says why, because the
    // next audit may now see what this one left behind. A warning beside ok:true
    // would be the swallow this replaced, wearing a different hat.
    if (cleanupReset && cleanupReset.ok === false) {
      const measured = finalRoutes.size ? [...finalRoutes].join(', ') : safeRoute;
      return {
        ...result,
        ok: false,
        code: 'session_not_cleaned',
        message:
          `The audit measured ${measured} but could not clear its browser session afterwards: ` +
          `${cleanupReset.reason}. Everything below is the real measurement; what cannot be promised is that the ` +
          'NEXT audit starts clean, so this run is not reported as isolated.',
      };
    }

    return result;
  }

  return { run };
}

module.exports = {
  createAudit,
  resetAuditSession,
  // Exported to be asserted directly: the loopback tolerance below is a
  // RELAXATION of the origin check, and a relaxation nobody tests is a hole.
  projectOriginTest,
  originOf,
  AUDIT_PARTITION,
  liveWindowCount,
  liveWindows,
  axeSource,
  MAX_FINDINGS,
  // Exported for the same reason MAX_FINDINGS is: a budget a test can only
  // guess at is a budget that can be raised to make a failing test pass.
  MAX_RESPONSE_BYTES,
  FIELD_CAPS,
  MAX_CAPTURES,
  SETTLE_MS,
  LOAD_TIMEOUT_MS,
};
