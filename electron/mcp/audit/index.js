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
const { overflowFinding, axeFinding, sortFindings } = require('./findings');
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

// axe.min.js rather than require('axe-core').source: the packaged property is
// the UNMINIFIED build at 1.3 MB, and this string is injected into a page on
// every viewport of every audit. The minified file is 580 KB and identical in
// behaviour.
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
  return new BrowserWindow({
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
    const res = await axe.run(document, { resultTypes: ['violations'], runOnly: ${runOnly} });
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
      nodes: rule.nodes.slice(0, 12).map((n) => ({
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
    const partition = `stacki-audit-${runId}`;
    const safeRoute = String(route || '/').startsWith('/') ? route : `/${route}`;
    // NO `#avb-design`. See the note at the top of this file: that hash is what
    // makes the canvas a different document from the site.
    const url = new URL(safeRoute, base.endsWith('/') ? base : `${base}/`).href;

    const findings = [];
    const captures = [];
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
          win = makeAuditWindow(BrowserWindow, { width: viewport.width, height: viewport.height, partition });
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
              findings.push(overflowFinding({ viewport, culprit, documentOverflowBy: geo.overflowBy }));
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
          liveWindows.delete(`${runId}:${viewport.key}`);
          try {
            if (win && !win.isDestroyed()) win.destroy();
          } catch {
            /* a window that will not close must not take the audit with it */
          }
        }
      }
    } catch (err) {
      return { ok: false, code: 'audit_failed', message: String(err?.message || err).slice(0, 300), runId };
    }

    const sorted = sortFindings(findings);
    const kept = sorted.slice(0, MAX_FINDINGS);

    return {
      ok: true,
      runId,
      route: safeRoute,
      url,
      engine: { accessibility: axeVersion ? `axe-core ${axeVersion}` : null, error: engineError },
      viewports: perViewport,
      findings: kept,
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
