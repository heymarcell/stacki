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
const MAX_CAPTURES = 3;
// axe can return hundreds of nodes for one rule on a big page. Twelve is enough
// to act on and the number is reported rather than assumed.
const AXE_NODES_PER_RULE = 12;

// ONE in-memory partition, shared by every audit, and deliberately not
// `persist:` anything. It keeps the audit's storage out of the app's own session
// -- an audit must not inherit a login or leave one behind -- while a partition
// PER RUN would mint a fresh Session object every time somebody audits a page,
// for the lifetime of the process, to isolate reads from reads.
const AUDIT_PARTITION = 'stacki-audit';

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
function makeAuditWindow(BrowserWindow, { width, height, partition }) {
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
  // Nor may it navigate the audit somewhere else and have the result reported
  // under the route that was asked for.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
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
      let el = null;
      try { el = document.querySelector(Array.isArray(target) ? target[target.length - 1] : target); } catch {}
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
    const pack = (list, bucket) => list.map((rule) => ({
      id: rule.id, impact: rule.impact, help: rule.help, helpUrl: rule.helpUrl, tags: rule.tags,
      bucket,
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
function createAudit({ BrowserWindow, getPreviewUrl, encodeImage = null }) {
  /**
   * @param {object} opts
   * @param {string=} opts.route          route to audit; defaults to the site root
   * @param {Array=}  opts.viewports      names or {width,height}; defaults to phone/tablet/desktop
   * @param {Array=}  opts.rules          specific accessibility rule ids; defaults to WCAG A/AA
   * @param {boolean=} opts.capture       return a screenshot per viewport
   */
  async function run({ route = '/', viewports: wanted, rules = null, capture = false } = {}) {
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

    const findings = [];
    const captures = [];
    let capturesWanted = 0;
    const perViewport = [];
    let axeVersion = null;
    let engineError = null;

    try {
      for (const viewport of chosen.viewports) {
        const started = Date.now();
        let win = null;
        try {
          // A FRESH WINDOW PER VIEWPORT, and the size set before the load.
          //
          // Resizing one loaded window is cheaper and re-evaluates media queries
          // correctly, but a page whose script reads innerWidth once on load
          // would then be laid out for the first width and stretched to the
          // rest. A visitor at 375 gets a page that loaded at 375, so that is
          // what gets measured.
          win = makeAuditWindow(BrowserWindow, { width: viewport.width, height: viewport.height, partition: AUDIT_PARTITION });
          liveWindows.set(`${runId}:${viewport.key}`, win);

          const loaded = new Promise((resolve, reject) => {
            win.webContents.once('did-finish-load', resolve);
            win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${desc || 'load failed'} (${code})`)));
          });
          loaded.catch(() => {});
          await win.loadURL(url).catch(() => {});
          await withTimeout(loaded, LOAD_TIMEOUT_MS, `loading ${safeRoute} at ${viewport.width}px`);

          await win.webContents.executeJavaScript(FREEZE, true).catch(() => {});
          await withTimeout(win.webContents.executeJavaScript(SETTLE, true), PROBE_TIMEOUT_MS, 'settling the page');
          await wait(SETTLE_MS);

          // --- geometry
          const geo = await withTimeout(win.webContents.executeJavaScript(OVERFLOW, true), PROBE_TIMEOUT_MS, 'measuring overflow');
          if (geo.overflows) {
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
            }
          }

          // --- accessibility
          let axeResult = null;
          try {
            await win.webContents.executeJavaScript(axeSource(), true);
            axeResult = await withTimeout(win.webContents.executeJavaScript(axeScript({ rules }), true), PROBE_TIMEOUT_MS, 'running the accessibility engine');
            axeVersion = axeResult.version;
            for (const rule of axeResult.violations) {
              for (const node of rule.nodes) findings.push(axeFinding({ viewport, rule, node, bucket: 'violation' }));
            }
            for (const rule of axeResult.incomplete) {
              for (const node of rule.nodes) findings.push(axeFinding({ viewport, rule, node, bucket: 'incomplete' }));
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
    }

    const sorted = sortFindings(findings);
    // WHEN THE CAP BITES, IT MUST NOT EAT ONE BUCKET WHOLE.
    //
    // sortFindings ranks by severity, and every `incomplete` is severity `info`
    // -- last. So a page with sixty violations would have had its entire
    // incomplete bucket dropped, while `counts.incomplete` went on reporting the
    // true number: the one channel whose whole purpose is honest uncertainty,
    // silently emptied. A quarter of the budget is reserved for it.
    const INCOMPLETE_SHARE = Math.floor(MAX_FINDINGS / 4);
    const undecided = sorted.filter((f) => f.kind === 'incomplete');
    const decided = sorted.filter((f) => f.kind !== 'incomplete');
    const keptUndecided = undecided.slice(0, Math.min(INCOMPLETE_SHARE, undecided.length));
    const keptDecided = decided.slice(0, MAX_FINDINGS - keptUndecided.length);
    const kept = sortFindings([...keptDecided, ...keptUndecided]);

    return {
      ok: true,
      runId,
      route: safeRoute,
      url,
      engine: { accessibility: axeVersion ? `axe-core ${axeVersion}` : null, error: engineError },
      viewports: perViewport,
      findings: kept,
      // EVERY PLACE SOMETHING WAS DROPPED, SAID OUT LOUD. The claim is that
      // nothing is silently discarded, and three things can be: elements past
      // the culprit cap, axe nodes past twelve per rule, and captures past three.
      // A caller that never hears about them cannot know to ask differently.
      dropped: {
        culpritsTruncatedAtViewports: perViewport.filter((v) => v.culpritsTruncated).map((v) => v.viewport.key),
        axeNodesPerRuleCap: AXE_NODES_PER_RULE,
        captureCap: MAX_CAPTURES,
        capturesRequestedButNotTaken: capturesWanted > captures.length ? capturesWanted - captures.length : 0,
      },
      // Never a silent truncation. If there were more, the count is the true one
      // and the flag says the list is not.
      findingCount: sorted.length,
      truncated: sorted.length > kept.length,
      counts: {
        mechanical: sorted.filter((f) => f.kind === 'mechanical').length,
        standard: sorted.filter((f) => f.kind === 'standard').length,
        advisory: sorted.filter((f) => f.kind === 'advisory').length,
        incomplete: sorted.filter((f) => f.kind === 'incomplete').length,
      },
      captures,
      // Said in the payload, not only in the documentation, because this is the
      // sentence somebody will quote out of context.
      limits:
        'Automated rules find roughly half of the accessibility problems a real audit finds. No violations does not ' +
        'mean accessible and does not mean WCAG compliant. `incomplete` findings are neither passes nor failures - ' +
        'a person has to look at them.',
    };
  }

  return { run };
}

module.exports = {
  createAudit,
  liveWindowCount,
  liveWindows,
  axeSource,
  MAX_FINDINGS,
  MAX_CAPTURES,
  SETTLE_MS,
  LOAD_TIMEOUT_MS,
};
