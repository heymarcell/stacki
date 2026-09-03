// The audit, against a real Astro page in a real browser.
//
//   node --check test/mcp-audit.js && electron test/mcp-audit.js
//
// Electron, because there is no version of this worth running without a real
// rendering engine. Contrast is computed from composited colours, overflow is
// computed from laid-out boxes, and an accessible name is computed from the
// accessibility tree. jsdom has none of those, so a jsdom audit would be a test
// of the shape of an object rather than of whether the page is broken.
//
// WHAT THIS EXISTS TO CATCH, in the order the sabotage campaign attacks it:
//
//   A DETECTOR THAT STOPPED DETECTING. Every seeded defect has a checked-in
//   expectation and must be found.
//   A DETECTOR THAT FIRES ON SHAPE. Every seeded defect sits beside a
//   structurally identical control that is correct, and a second route that is
//   clean in both variants. Neither may be reported.
//   THE WRONG VIEWPORT. The overflow is seeded so it fits at 768 and 1440 and
//   only breaks a 375px phone. A finding at three viewports is a finding whose
//   viewport is decoration.
//   AN INTENTIONAL SCROLL CONTAINER READ AS A BUG. The carousel is wider than
//   every viewport, at every viewport, deliberately. This is the check most
//   likely to fail if the overflow rule is ever rewritten as "is this wide".
//   AN AUDIT THAT CHANGED SOMETHING. The project's bytes and the person's view
//   are compared before and after.
//   A WINDOW THAT SURVIVED. Hidden windows leak invisibly, so they are counted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { app, BrowserWindow, dialog } = require('electron');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null).slice(0, 220);

process.env.STACKI_NO_DIALOGS = '1';

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');
const { auditFixture, SEEDED, SEEDED_INCOMPLETE, MUST_NOT_FIRE_ON_CLEAN, MANY_COUNT, WIDE_COUNT, OUTSIDE_ORIGIN_PORT } = require('./support/auditFixture.js');
const { liveWindowCount } = require('../electron/mcp/audit');

app.on('window-all-closed', () => {});

if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  console.log('mcp-audit: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

const sweptRuns = sweepStaleRuns(['stacki-canvas-user-', 'stacki-canvas-']);
for (const s of sweptRuns.swept) console.log(`mcp-audit: swept ${s.name} (dead ${s.harness} pid ${s.pid})`);

const root = makeCanvasProject({ harness: 'mcp-audit', log: (m) => console.log(`mcp-audit: ${m}`) });

// The seeded defects, written into the real Astro project the canvas fixture
// built. Broken variant: the clean control lives on /clean, in the same project,
// so both are served by one dev server and neither can differ by accident.
for (const [rel, body] of Object.entries(auditFixture({ broken: true }))) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

// ONE DEFECT ON THE PAGE STACKI OPENS BY DEFAULT.
//
// The /audit route carries the corpus, but a semantic fix needs a ref, and a ref
// comes from reading the page the editor has open. So the image with no
// alternative is seeded on index.astro too -- that is the one fixed through
// target.set_prop below, which is the path this whole product is supposed to
// make ordinary.
{
  const index = path.join(root, 'src/pages/index.astro');
  const body = fs.readFileSync(index, 'utf8');
  fs.writeFileSync(
    index,
    body.replace(
      '</Base>',
      '  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="48" height="48" />\n</Base>'
    ),
    'utf8'
  );
}

const userData = ownedTempDir('stacki-canvas-user-', { harness: 'mcp-audit' });
app.setPath('userData', userData);
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(root)]: 'edit' } }, null, 2),
  'utf8'
);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

const mcp = require('../electron/mcp');
require('../electron/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, { timeout = 60000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
    } catch (err) {
      last = null;
    }
    if (last) return last;
    await wait(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Every file in the project that a person would notice changing, BY CONTENT.
 *
 * This used to store fs.statSync(full).size, and the check built on it was named
 * "the audit wrote nothing to the project". A same-length rewrite -- one
 * character swapped for another -- passed it. That is the exact shape of a
 * false-green oracle: a name that promises content and an implementation that
 * compares length.
 *
 * SHA-256 of the bytes, keyed by relative path, so a change, an addition and a
 * removal are all visible and none of them depends on size. Hashes rather than
 * contents so a failure prints a path and a digest instead of a file.
 */
function projectBytes(dir) {
  const skip = new Set(['node_modules', '.git', 'dist', '.astro', '.stacki']);
  const out = new Map();
  const walk = (d, depth) => {
    if (depth > 8) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else {
        try {
          out.set(path.relative(dir, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16));
        } catch {
          /* a file that vanished mid-walk is reported by the comparison */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}
const diffBytes = (a, b) => {
  const changed = [];
  for (const [k, v] of b) if (!a.has(k)) changed.push(`added ${k}`);
  for (const [k, v] of a) {
    if (!b.has(k)) changed.push(`removed ${k}`);
    else if (b.get(k) !== v) changed.push(`changed ${k} (sha ${v} -> ${b.get(k)})`);
  }
  return changed;
};

let stopPreview = null;

(async () => {
  await app.whenReady();

  const status = await until('the MCP server', () => {
    const s = mcp.status();
    return s.running ? s : null;
  });

  const window_ = await until('the app window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to finish loading', () => (window_.webContents.isLoading() ? null : true), { timeout: 60000 });
  await wait(500);
  window_.webContents.send('menu:openProject');

  let rpc = 1;
  /** Any JSON-RPC method, for the ones that are not tools/call. */
  const rpc_ = async (method, params) => {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method, params }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
    return JSON.parse(line.replace(/^data:\s*/, '')).result || null;
  };
  const call = async (name, args) => {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
    const body = JSON.parse(line.replace(/^data:\s*/, ''));
    if (body.error) return { ok: false, code: 'rpc_error', message: JSON.stringify(body.error) };
    // A handler that threw comes back as content with no structuredContent. Say
    // what it said rather than reporting the absence -- "no_content" is a
    // symptom, and the stack that caused it is right there in the payload.
    if (body.result?.structuredContent) return body.result.structuredContent;
    const said = (body.result?.content || []).map((c) => c.text || '').join(' ').slice(0, 400);
    return { ok: false, code: 'no_content', message: said || JSON.stringify(body.result).slice(0, 400) };
  };
  stopPreview = () => call('project', { action: 'dev_stop' });

  const ready = await until(
    'the preview to render the page',
    async () => {
      const ctx = await call('get_context', { styleDetail: 'none' });
      return ctx.project?.root && ctx.selection?.status === 'ready' ? ctx : null;
    },
    { timeout: 180000 }
  );
  check('the project opened and the canvas is rendering', ready.selection.status === 'ready', short(ready.selection?.status));

  // ------------------------------------------------------------------ the audit

  const viewBefore = await call('get_context', { styleDetail: 'none' });
  const windowsBefore = BrowserWindow.getAllWindows().length;

  const audit = await call('audit', { route: '/audit' });
  check('the audit ran', audit.ok === true, short(audit));
  if (!audit.ok) {
    return finish();
  }

  check('it names the engine it used', /axe-core/.test(String(audit.engine?.accessibility)), short(audit.engine));
  check('and the engine did not error', audit.engine?.error == null, short(audit.engine?.error));
  check('it audited the three default viewports', (audit.viewports || []).length === 3, short((audit.viewports || []).map((v) => v.viewport.key)));
  check(
    'and it says what automated rules cannot do',
    /does not mean accessible/.test(String(audit.limits)) && /incomplete/.test(String(audit.limits)),
    short(audit.limits)
  );

  const findings = audit.findings || [];
  const byRule = (id) => findings.filter((f) => f.ruleId === id);

  // --- every seeded defect is found, at the viewports it should be found at
  for (const seed of SEEDED) {
    const hits = byRule(seed.ruleId);
    check(`seeded: ${seed.ruleId} is found`, hits.length > 0, short(findings.map((f) => f.ruleId)));
    if (!hits.length) continue;
    // At least one hit at the claimed kind. Not every hit: axe legitimately
    // returns SOME results for the same rule as `incomplete` -- contrast over a
    // gradient is the example in this fixture -- and demanding uniformity would
    // be demanding that it stop being honest.
    check(
      `seeded: ${seed.ruleId} is classified ${seed.kind}`,
      hits.some((f) => f.kind === seed.kind),
      short(hits.map((f) => `${f.kind}@${f.viewport.key}`))
    );
    if (seed.viewports) {
      const at = [...new Set(hits.map((f) => f.viewport.key))].sort();
      check(
        `seeded: ${seed.ruleId} is found ONLY at ${seed.viewports.join(', ')}`,
        JSON.stringify(at) === JSON.stringify([...seed.viewports].sort()),
        `found at ${at.join(', ')}`
      );
    }
  }

  // --- the overflow finding, in detail
  {
    const overflow = byRule('horizontal-overflow');
    const phone = overflow.find((f) => f.viewport.key === 'phone');
    check('the overflow finding is at the phone viewport', !!phone, short(overflow.map((f) => f.viewport.key)));
    if (phone) {
      check('and it names the element that overflows', /banner-overflow/.test(phone.target.selector || ''), short(phone.target));
      check('and its evidence is the real measurement', phone.evidence.viewportWidth === 375 && phone.evidence.documentOverflowBy >= 2, short(phone.evidence));
      check('and it reports how far past the edge the element goes', phone.evidence.elementOverflowBy > 100, short(phone.evidence.elementOverflowBy));
      check('and it carries the computed overflow-x that got it blamed', phone.evidence.computed?.['overflow-x'] === 'visible', short(phone.evidence.computed));
      // Source truthfulness: a real Stacki path or an honest null. Never a path
      // invented from the selector.
      const t = phone.target;
      check(
        'and its source location is either a real Stacki path or an honest null',
        (typeof t.modelPath === 'string' && t.modelPath.length > 0) || (t.modelPath === null && typeof t.note === 'string'),
        short(t)
      );
    }

    // THE CONTROL THAT MATTERS MOST. The carousel is wider than every viewport
    // at every viewport, on purpose, inside overflow-x: auto.
    const carousel = findings.filter((f) => /carousel/.test(f.target?.selector || ''));
    check('the intentional scroll container is never reported', carousel.length === 0, short(carousel.map((f) => `${f.ruleId}@${f.viewport.key}`)));

    // THE CONTROL THAT NEARLY WAS NOT THERE. A skip link and visually-hidden
    // text sit at left:-9999px, which is correct and about as common as HTML
    // gets. Before this was fixed they were reported as overflow AND sorted
    // first, at 10000px and 9999px, ahead of the real 145px culprit -- so the
    // two most prominent findings on a well-built page were its accessibility
    // features.
    const offLeft = findings.filter((f) => /sr-only|skip-link/.test(f.target?.selector || ''));
    check('visually-hidden text off the left edge is never reported', offLeft.length === 0, short(offLeft.map((f) => `${f.ruleId}@${f.viewport.key}:${f.target?.selector}`)));
    check('  and every overflow finding blames the right edge', overflow.every((f) => f.evidence.edge === 'right'), short(overflow.map((f) => f.evidence.edge)));
  }

  // --- the incomplete bucket is real and is kept apart
  {
    const incomplete = findings.filter((f) => f.kind === 'incomplete');
    for (const seed of SEEDED_INCOMPLETE) {
      const hit = incomplete.find((f) => f.ruleId === seed.ruleId);
      check(`seeded: ${seed.ruleId} comes back as incomplete, not as a violation`, !!hit, short(incomplete.map((f) => f.ruleId)));
      if (hit) {
        check(`  and ${seed.ruleId} says a person has to look`, /could not decide/.test(hit.message), short(hit.message));
        check(`  and ${seed.ruleId} is not counted as a standard`, hit.kind !== 'standard');
      }
    }
    check('the counts keep incomplete apart from standard', audit.counts.incomplete === incomplete.length, short(audit.counts));
  }

  // --- ids are stable across runs, so a fix can be proven rather than inferred
  {
    const again = await call('audit', { route: '/audit' });
    check('a second audit of the same page returns the same findings', again.ok === true);
    const a = new Set(findings.map((f) => f.id));
    const b = new Set((again.findings || []).map((f) => f.id));
    const same = a.size === b.size && [...a].every((id) => b.has(id));
    check('and every finding id is identical', same, `first ${a.size}, second ${b.size}`);
    // STABLE IS HALF THE CLAIM. Comparing two SETS cannot see an N-way collapse:
    // when one model node rendered five times shared one id, both sets held that
    // id once and this check was green. The count is what says they are distinct.
    check(
      'and every finding has an id of its own',
      findings.length === a.size,
      `${findings.length} findings, ${a.size} ids`
    );
    check(
      '  on the second run too',
      (again.findings || []).length === b.size,
      `${(again.findings || []).length} findings, ${b.size} ids`
    );
  }

  // --- the clean control route, in the SAME project, reports nothing
  {
    const clean = await call('audit', { route: '/clean' });
    check('the clean control route audits', clean.ok === true, short(clean));
    const onClean = (clean.findings || []).filter((f) => MUST_NOT_FIRE_ON_CLEAN.includes(f.ruleId));
    // A CLAIM OF FAILURE is what must not appear. `incomplete` is not one: it is
    // the engine saying it could not determine the answer, and on a page with a
    // gradient behind text that is the honest result rather than a false
    // positive. Counting it as one would push the implementation toward
    // suppressing uncertainty, which is the opposite of what this audit promises.
    const claimed = onClean.filter((f) => f.kind === 'standard' || f.kind === 'mechanical');
    const undecided = onClean.filter((f) => f.kind === 'incomplete');
    check(
      'no seeded rule CLAIMS a failure on the clean control',
      claimed.length === 0,
      short(claimed.map((f) => `${f.ruleId}/${f.kind}@${f.viewport.key}:${f.target?.selector}`))
    );
    check(
      '  and anything undecided there is reported as undecided, not as clean',
      undecided.every((f) => f.kind === 'incomplete' && /could not decide/.test(f.message)),
      short(undecided.map((f) => `${f.ruleId}/${f.kind}`))
    );
  }

  // --- viewport arguments are validated rather than clamped
  {
    const bad = await call('audit', { route: '/audit', viewports: ['nonsense'] });
    check('an unknown viewport is refused', bad.ok === false, short(bad));
    check('  and the refusal says which ones exist', /phone/.test(String(bad.message)) && /desktop/.test(String(bad.message)), short(bad.message));
    // The count is refused by the declared schema, before the handler runs. That
    // is the protocol doing its job, and a caller does not need context to
    // understand "too many".
    const many = await call('audit', { route: '/audit', viewports: ['phone', 'phone', 'phone', 'phone', 'phone', 'phone', 'phone'] });
    check('too many viewports is refused', many.ok === false, short(many));
  }

  // --- A ROUTE THAT ANSWERS 404 IS AN ERROR PAGE, NOT THE ROUTE
  //
  // did-fail-load fires for network failures only. Astro's dev 404 returns a
  // body, so it finishes loading like anything else -- and the audit would
  // measure THAT page, find a contrast problem on it, and report it under the
  // route the caller asked for. A typo would come back as findings about the
  // project.
  {
    const missing = await call('audit', { route: '/definitely-not-a-route-at-all', viewports: ['phone'] });
    check('a route that answers with an error page is refused', missing.ok === false && missing.code === 'route_not_ok', short(missing));
    check('  and the status is reported', typeof missing.status === 'number' && missing.status >= 400, short(missing.status));
    check('  and no findings are attributed to the route that was asked for', !Array.isArray(missing.findings) || missing.findings.length === 0);
    check('  and it left no window behind', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
  }

  // --- LEAVING THE PROJECT, BY EVERY ROUTE OUT OF IT
  //
  // A server-side redirect is not a page-initiated navigation, so `will-navigate`
  // never sees it. Measured against the engine before this was guarded: a project
  // route answering 302 to a second local origin had that origin LOADED, axe run
  // on it, and three of its findings returned under the project's own route and
  // URL. A third-party document reported as the project.
  //
  // The outside origin is listened to here, so "refused" can mean "never
  // contacted" rather than "fetched and then discarded".
  {
    let outsideHits = 0;
    const outside = http.createServer((_req, res) => {
      outsideHits += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>OUTSIDE_ORIGIN</title><img src="x.gif"><p>outside</p>');
    });
    await new Promise((r) => outside.listen(OUTSIDE_ORIGIN_PORT, '127.0.0.1', r));
    try {
      // B. server-side redirect to another origin
      // `capture: true` on purpose: without it `captures` is empty on EVERY
      // result and the assertion below passes whatever the guard does.
      const out = await call('audit', { route: '/redirect-out', viewports: ['phone'], capture: true });
      check('a route that redirects off-origin is refused', out.ok === false && out.code === 'route_outside_project', short(out));
      check('  and the outside origin is never contacted', outsideHits === 0, `${outsideHits} requests reached it`);
      // Nothing of the refused page: not its title, not the markup a finding
      // would have carried, not the text axe would have quoted in a summary.
      check(
        '  and it names the origin without quoting the page',
        String(out.blockedOrigin || '').includes(String(OUTSIDE_ORIGIN_PORT)) &&
          !/OUTSIDE_ORIGIN|x\.gif|>outside</.test(JSON.stringify(out)),
        short(out.blockedOrigin)
      );
      check('  and reports no findings at all', !Array.isArray(out.findings) || out.findings.length === 0);
      check('  and no capture, though one was asked for', !Array.isArray(out.captures) || out.captures.length === 0, short(out.captures));

      // D. page-initiated navigation off-origin
      const nav = await call('audit', { route: '/navigate-out', viewports: ['phone'] });
      check('a page that navigates off-origin is refused', nav.ok === false && nav.code === 'route_outside_project', short(nav));
      check('  and that origin is still never contacted', outsideHits === 0, `${outsideHits} requests reached it`);

      // C. same-origin redirect is ordinary visitor behaviour -- followed, and
      //    reported as the document that was actually measured.
      const inRes = await call('audit', { route: '/redirect-in', viewports: ['phone'] });
      check('a same-origin redirect is followed', inRes.ok === true, short(inRes));
      check('  and the page actually measured is named', Array.isArray(inRes.finalRoutes) && inRes.finalRoutes.includes('/clean'), short(inRes.finalRoutes));
      check('  rather than pretending the requested route was the one measured', inRes.route === '/redirect-in');

      // E. the page leaves AFTER the load, while it is being measured. The block
      //    is real either way; being told about it is what was missing.
      const late = await call('audit', { route: '/late-out', viewports: ['phone'] });
      check('a page that leaves DURING measurement is refused too', late.ok === false && late.code === 'route_outside_project', short(late));
      check('  and that origin is still never contacted', outsideHits === 0, `${outsideHits} requests reached it`);
      check('  and the refusal names when it happened', /while it was being measured/.test(String(late.message)), short(late.message));

      // F. the same timing, same origin: allowed, and the document actually
      //    measured is named rather than the one that was asked for.
      const lateIn = await call('audit', { route: '/late-in', viewports: ['phone'] });
      check('a same-origin move during measurement is allowed', lateIn.ok === true, short(lateIn));
      check('  and the document it ended on is named', Array.isArray(lateIn.finalRoutes) && lateIn.finalRoutes.includes('/clean'), short(lateIn.finalRoutes));

      // G. an off-origin document INSIDE the page.
      const framed = await call('audit', { route: '/frame-out', viewports: ['phone'] });
      check('an off-origin iframe is never fetched', outsideHits === 0, `${outsideHits} requests reached it`);
      check('  and the page is still measured', framed.ok === true, short(framed));
      check(
        '  and the frame that was dropped is named',
        Array.isArray(framed.blockedSubframeOrigins) &&
          framed.blockedSubframeOrigins.some((o) => o.includes(String(OUTSIDE_ORIGIN_PORT))),
        short(framed.blockedSubframeOrigins)
      );
      check('  and nothing of that document is reported', !/OUTSIDE_ORIGIN|x\.gif/.test(JSON.stringify(framed)));

      // H. A FRAME WHOSE FIRST HOP IS INNOCENT AND WHOSE SERVER IS NOT.
      //
      // The iframe src is same-origin, so the frame's first navigation is
      // allowed; the 302 that answers it arrives as `will-redirect` for a
      // SUBFRAME. A redirect guard that only looks at the main frame never sees
      // it, and the second origin gets the document.
      const frameRedirect = await call('audit', { route: '/frame-redirect-page', viewports: ['phone'] });
      check('a same-origin frame redirected off-origin never reaches it', outsideHits === 0, `${outsideHits} requests reached it`);
      check('  and the project page is still audited', frameRedirect.ok === true, short(frameRedirect));
      check(
        '  and the origin the frame was sent to is named',
        Array.isArray(frameRedirect.blockedSubframeOrigins) &&
          frameRedirect.blockedSubframeOrigins.some((o) => o.includes(String(OUTSIDE_ORIGIN_PORT))),
        short(frameRedirect.blockedSubframeOrigins)
      );
      check('  and none of that document is reported', !/OUTSIDE_ORIGIN|x\.gif|>outside</.test(JSON.stringify(frameRedirect)));
      check('  and no capture of it either', !Array.isArray(frameRedirect.captures) || frameRedirect.captures.length === 0);

      // I. THE CONTROL, same shape, redirect staying inside the project. Blocking
      //    this one would not be a fix, it would be a broken browser.
      const frameHome = await call('audit', { route: '/frame-redirect-in-page', viewports: ['phone'] });
      check('a frame that redirects WITHIN the project is left alone', frameHome.ok === true, short(frameHome));
      check(
        '  and nothing is reported as blocked',
        frameHome.blockedSubframeOrigins === undefined,
        short(frameHome.blockedSubframeOrigins)
      );
      check('  and the outside origin is still untouched', outsideHits === 0, `${outsideHits} requests reached it`);

      check('no audit window survived any of it', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
    } finally {
      await new Promise((r) => outside.close(r));
    }
  }

  // --- WHAT THE TOOL DECLARES ABOUT ITSELF.
  //
  // `openWorldHint` is the one that had to change. The document fence is real and
  // is proven above; it is not the same claim as a closed world, because the page
  // this tool renders decides for itself what scripts, fonts and images it pulls
  // and from where. The spec's own words are "may interact with an open world of
  // external entities", and a real browser rendering a real project page does.
  {
    const listed = await rpc_('tools/list', {});
    const audit_ = (listed?.tools || []).find((t) => t.name === 'audit');
    const a = audit_?.annotations || {};
    check('the audit tool is on the surface with annotations', !!audit_ && !!audit_.annotations, JSON.stringify(Object.keys(a)));
    check('  it is read-only and not destructive', a.readOnlyHint === true && a.destructiveHint === false, JSON.stringify(a));
    check('  and it does NOT claim a closed world, because the page it renders is not one', a.openWorldHint === true, JSON.stringify(a));
  }

  // --- the route is untrusted input
  {
    const off = await call('audit', { route: '//example.invalid/x' });
    check('a route that resolves to another origin is refused', off.ok === false && off.code === 'route_outside_project', short(off));
    check('  and the refusal names where it would have gone', /example\.invalid/.test(String(off.message)), short(off.message));
    // The one hash that turns the project's own page into the canvas document --
    // the exact document this engine exists not to measure.
    const hashed = await call('audit', { route: '/audit#avb-design', viewports: ['phone'] });
    check('a design-mode hash is dropped rather than honoured', hashed.ok === true && !/avb-design/.test(String(hashed.url)), short(hashed.url));
    check('  and the route reported is the real one', hashed.ok === true && hashed.route === '/audit', short(hashed.route));
  }

  // --- ONE AUDIT MUST NOT INHERIT ANOTHER'S BROWSER STATE
  //
  // /setstate writes a cookie and a localStorage value as it loads. /seestate
  // looks for them and turns the answer into a finding: leaked state gives an
  // image with no alternative, a clean session gives the same image with one.
  //
  // This is the shape of a real defect. Measured on the shared partition this
  // engine used to use: a window that wrote those values, destroyed, then a fresh
  // window on the same partition read them straight back. Not persisted to disk
  // and not shared between runs are different properties, and only the first was
  // ever true.
  {
    const seed = await call('audit', { route: '/setstate', viewports: ['phone'] });
    check('the state-writing route audits', seed.ok === true, short(seed));
    check('  and the audit says it isolated its session', seed.engine?.sessionIsolated === true, short(seed.engine));

    const after = await call('audit', { route: '/seestate', viewports: ['phone'] });
    check('the state-reading route audits', after.ok === true, short(after));
    const leaked = (after.findings || []).filter((f) => f.ruleId === 'image-alt');
    check(
      'a later audit sees NOTHING the earlier one wrote',
      leaked.length === 0,
      leaked.length ? `leaked: ${short(leaked.map((f) => f.target?.selector))}` : ''
    );

    // And again, so it is a property of every boundary rather than of the first.
    await call('audit', { route: '/setstate', viewports: ['phone'] });
    const third = await call('audit', { route: '/seestate', viewports: ['phone'] });
    check('and the boundary holds on the next cycle too', (third.findings || []).every((f) => f.ruleId !== 'image-alt'), short((third.findings || []).map((f) => f.ruleId)));
    check('no audit window survived the isolation checks', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
  }

  // --- WHAT THE CAPS HID, COUNTED
  //
  // /many carries 17 images with no alternative. The audit takes at most 12 axe
  // nodes per rule OUT OF THE PAGE, before Stacki has seen anything -- so the
  // count that used to be called "the true one" was the number that survived a
  // cap it could not see past. A caller reading 12 could not tell "there were 12"
  // from "there were 17 and you got 12".
  {
    const many = await call('audit', { route: '/many', viewports: ['phone'] });
    check('the over-cap route audits', many.ok === true, short(many));
    if (many.ok) {
      const alts = (many.findings || []).filter((f) => f.ruleId === 'image-alt');
      check(`findingCount reports the TRUE total, not the capped one`, many.findingCount >= MANY_COUNT, `findingCount=${many.findingCount}, seeded=${MANY_COUNT}`);
      check('  and returnedFindingCount matches what actually came back', many.returnedFindingCount === (many.findings || []).length, `${many.returnedFindingCount} vs ${(many.findings || []).length}`);
      check('  and the returned list obeys the per-rule cap', alts.length <= 12, `${alts.length} image-alt findings returned`);
      check('  so truncated is true', many.truncated === true, short({ truncated: many.truncated }));
      check('  and omitted is the difference', many.omittedFindingCount === many.findingCount - many.returnedFindingCount, short({ omitted: many.omittedFindingCount, detected: many.findingCount, returned: many.returnedFindingCount }));
      check('  and it says the omission happened BEFORE scoring', (many.truncation?.omittedBeforeScoring?.axeNodes || 0) >= MANY_COUNT - 12, short(many.truncation?.omittedBeforeScoring));
      check('  the truncation block is self-consistent', many.truncation?.detected === many.findingCount && many.truncation?.returned === many.returnedFindingCount, short(many.truncation));
      check('  and the findings that DID come back are actionable', alts.length > 0 && alts.every((f) => f.target?.selector), short(alts.slice(0, 2).map((f) => f.target?.selector)));
    }
  }

  // --- THE GEOMETRY CAP HAS ITS OWN PRE-CAP ACCOUNTING, AND IT WAS WRONG TWICE
  //
  // /wide has 50 unconstrained 520px blocks. The in-page walk may hand back at
  // most 40, so the difference between "there were 40" and "there were 50 and you
  // got 40" is the whole contract -- and the counter that was supposed to carry it
  // sat AFTER the cap's skip, so it stopped counting at exactly the moment it
  // started mattering. The axe path had /many; this path had nothing, which is
  // why the bug survived a rewrite that was specifically about it.
  {
    const wide = await call('audit', { route: '/wide', viewports: ['phone'] });
    check('the over-cap geometry route audits', wide.ok === true, short(wide));
    if (wide.ok) {
      const vp = (wide.viewports || [])[0];
      check('the page really does overflow there', vp && vp.overflows === true, short(vp));
      check('  and the walk counted every offender, not just the ones it kept', vp && vp.culpritsTruncated === true, short(vp));
      check('  findingCount exceeds what the geometry cap returned', wide.findingCount > (wide.findings || []).filter((f) => f.ruleId === 'horizontal-overflow').length, short({ detected: wide.findingCount, returned: wide.returnedFindingCount }));
      check('  and it is at least the number actually seeded', wide.findingCount >= WIDE_COUNT, `${wide.findingCount} vs ${WIDE_COUNT} seeded`);
      check('  truncated says so', wide.truncated === true);
      check('  and the omission is attributed to the in-page cap', (wide.truncation?.omittedBeforeScoring?.geometryCulprits || 0) > 0, short(wide.truncation?.omittedBeforeScoring));
    }
  }

  // --- 320 IS A MEASUREMENT THAT RELATES TO A CRITERION, NOT A VERDICT ON IT
  //
  // This block used to assert the opposite: that overflow at 320 came back as
  // `kind: 'standard'`. That was an overclaim. WCAG 2.2 SC 1.4.10 exempts content
  // needing a two-dimensional layout -- data tables, maps, diagrams, video -- and
  // a geometry probe cannot tell an exempt table from a layout that failed to
  // reflow. The measurement is real; the verdict is not Stacki's to give.
  {
    const reflow = await call('audit', { route: '/audit', viewports: ['reflow'] });
    check('the reflow viewport audits', reflow.ok === true, short(reflow));
    const o = (reflow.findings || []).filter((f) => f.ruleId === 'horizontal-overflow');
    check('overflow at 320 is still detected', o.length > 0, short((reflow.findings || []).map((f) => f.ruleId)));
    check('  and it is a MEASUREMENT, not a standards verdict', o.every((f) => f.kind === 'mechanical'), short(o.map((f) => f.kind)));
    check('  and it claims no broken rule', o.every((f) => f.standard === null), short(o.map((f) => f.standard)));
    check('  while still naming the criterion it relates to', o.length > 0 && /1\.4\.10/.test(String(o[0].relatedStandard)), short(o[0]?.relatedStandard));
    check('  and saying the exception exists', o.length > 0 && /two-dimensional layout/.test(String(o[0].message)), short(o[0]?.message));
    check('  and never asserting compliance either way', o.every((f) => !/violates|non-compliant|fails WCAG/i.test(String(f.message))));

    // THE EXCEPTION IN THE FLESH, on a route of its own.
    //
    // A timetable overflows at 320 and may be entirely legitimate in doing so.
    // The audit may report the geometry; it may not call it a failure. If this
    // ever comes back as `standard`, Stacki is telling somebody their timetable
    // breaks WCAG on the strength of its width.
    const tableRun = await call('audit', { route: '/table', viewports: ['reflow'] });
    check('the exception route audits at 320', tableRun.ok === true, short(tableRun));
    const table = (tableRun.findings || []).filter((f) => f.ruleId === 'horizontal-overflow');
    check('  a wide data table at 320 is still measured', table.length > 0, short((tableRun.findings || []).map((f) => f.ruleId)));
    check('  but reported as measurement only', table.every((f) => f.kind === 'mechanical' && f.standard === null), short(table.map((f) => `${f.kind}/${f.standard}`)));
    check('  with the criterion named as related, not broken', table.every((f) => /1\.4\.10/.test(String(f.relatedStandard))), short(table.map((f) => f.relatedStandard)));
  }

  // --- evidence, in the state it was measured in
  {
    const shot = await call('audit', { route: '/audit', viewports: ['phone'], capture: true });
    check('an audit can return a capture', shot.ok === true && (shot.captures || []).length === 1, short((shot.captures || []).length));
    const cap = (shot.captures || [])[0];
    if (cap) {
      check('the capture names the viewport it was taken at', cap.viewport.width === 375, short(cap.viewport));
      check('and it is bounded', cap.bytes > 0 && cap.bytes < 3_500_000, `${cap.bytes} bytes`);
      // The picture is of the state the findings describe: the same window, the
      // same load, nothing in between.
      const stillOverflows = (shot.findings || []).some((f) => f.ruleId === 'horizontal-overflow' && f.viewport.key === 'phone');
      check('and the findings beside it describe that same state', stillOverflows);
    }
    const noShot = await call('audit', { route: '/audit', viewports: ['phone'] });
    check('captures are off by default', (noShot.captures || []).length === 0);
  }

  // --------------------------------------------------------------- remediation
  //
  // The point of the whole exercise: findings an agent can act on with the
  // operations Phase A already shipped, and then PROVE it acted, by the finding
  // going away rather than by the array getting shorter.
  //
  // Two fixes, deliberately of different kinds. One semantic, through the model,
  // on the page the editor has open. One at the source, on a stylesheet, because
  // a rule that reaches an element on a route nobody has selected is exactly the
  // case a semantic operation cannot express.

  let fixedIds = [];
  {
    // --- 1. SEMANTIC: an image with no alternative, on the open page.
    const home = await call('audit', { route: '/', viewports: ['phone'] });
    check('the open page audits', home.ok === true, short(home));
    const altFinding = (home.findings || []).find((f) => f.ruleId === 'image-alt');
    check('and the image with no alternative is found there', !!altFinding, short((home.findings || []).map((f) => f.ruleId)));

    if (altFinding) {
      fixedIds.push(altFinding.id);
      const page = await call('target', { action: 'read' });
      const img = (page.target?.children || []).find((c) => c.tag === 'img');
      check('the page reads, with the image on it', !!img, short((page.target?.children || []).map((c) => c.tag)));
      if (img) {
        const set = await call('target', { action: 'set_prop', ref: img.ref, name: 'alt', value: 'A described marker' });
        check('target.set_prop adds the alternative', set.ok === true, short(set));

        // The world, not the envelope: the file on disk.
        const onDisk = await until(
          'the alt to reach the file',
          async () => (/alt="A described marker"/.test(fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8')) ? true : null),
          { timeout: 20000 }
        ).catch(() => null);
        check('and the source file on disk now carries it', onDisk === true);

        // And the running page. Retried, because Astro has to rebuild before the
        // audit's fresh load can see it.
        const gone = await until(
          'the finding to go away',
          async () => {
            const again = await call('audit', { route: '/', viewports: ['phone'] });
            if (!again.ok) return null;
            return (again.findings || []).some((f) => f.id === altFinding.id) ? null : again;
          },
          { timeout: 60000, every: 2000 }
        ).catch(() => null);
        check('and re-auditing no longer reports it, by id', !!gone, 'the finding survived the fix');
      }
    }

    // --- 2. SOURCE: the CSS rule behind the mobile overflow.
    const before = await call('audit', { route: '/audit', viewports: ['phone'] });
    const overflowBefore = (before.findings || []).find((f) => f.ruleId === 'horizontal-overflow');
    const contrastBefore = (before.findings || []).find((f) => f.ruleId === 'color-contrast');
    check('the overflow is there before the fix', !!overflowBefore, short((before.findings || []).map((f) => f.ruleId)));

    // Taken before the stylesheet changes, at the width the change is visible at.
    const shotBefore = await call('audit', { route: '/audit', viewports: ['phone'], capture: true });
    const shotBeforeFix = (shotBefore.captures || [])[0] || null;
    check('a capture before the fix comes back', !!shotBeforeFix, short(shotBefore.captures?.length));

    const css = await call('style', { action: 'read_source', path: 'src/styles/audit.css' });
    // The field is `css`, not `text`: style.read_source answers with the
    // stylesheet under the name the style panel uses for it.
    check('the stylesheet reads', css.ok === true && typeof css.css === 'string', short(css));
    if (css.ok && typeof css.css === 'string' && overflowBefore) {
      fixedIds.push(overflowBefore.id);
      const fixed = css.css.replace('  width: 520px;', '  width: 100%;\n  max-width: 520px;');
      check('the fix actually changes the stylesheet text', fixed !== css.css);
      const wrote = await call('style', { action: 'write_source', path: 'src/styles/audit.css', css: fixed, expectedDigest: css.digest });
      check('style.write_source accepts it with the digest it read', wrote.ok === true, short(wrote));
      check('and the file on disk changed', /max-width: 520px/.test(fs.readFileSync(path.join(root, 'src/styles/audit.css'), 'utf8')));

      const after = await until(
        'the overflow to go away',
        async () => {
          const again = await call('audit', { route: '/audit', viewports: ['phone'] });
          if (!again.ok) return null;
          return (again.findings || []).some((f) => f.id === overflowBefore.id) ? null : again;
        },
        { timeout: 60000, every: 2000 }
      ).catch(() => null);
      check('re-auditing no longer reports the overflow, by id', !!after, 'the overflow survived the fix');

      // THE FIX WAS A FIX, NOT A SILENCING. The defects nobody touched are still
      // reported, so "it went quiet" cannot pass for "it got better".
      if (after && contrastBefore) {
        check(
          'and the defects that were NOT fixed are still reported',
          (after.findings || []).some((f) => f.id === contrastBefore.id),
          short((after.findings || []).map((f) => f.ruleId))
        );
      }
    }

    // --- 3. THE PICTURE MOVED TOO.
    //
    // A screenshot is evidence only of the state it was taken in. The strongest
    // available proof of that is a before and an after of the SAME route at the
    // SAME width across a change that alters what it looks like: the banner is
    // 520px wide before the fix and full-width after it, so an encoder that
    // cached, reused or pre-computed an image cannot produce two different ones.
    if (shotBeforeFix) {
      const shotAfterFix = await call('audit', { route: '/audit', viewports: ['phone'], capture: true });
      const after = (shotAfterFix.captures || [])[0];
      check('a capture after the fix comes back', !!after, short(shotAfterFix.captures?.length));
      if (after) {
        // The bytes ride in the response's image blocks now, not in the capture
        // ROW, so the row carries a digest of them instead. Comparing digests is
        // the same claim and a better one: two 150 KB base64 strings compared for
        // inequality would also have passed if both were undefined.
        check(
          'and it is not the picture taken before the fix',
          !!after.sha256 && after.sha256 !== shotBeforeFix.sha256,
          `${shotBeforeFix.bytes} -> ${after.bytes} bytes`
        );
      }
    }

    // The clean control is still clean after all of that.
    const cleanAfter = await call('audit', { route: '/clean' });
    const claimedAfter = (cleanAfter.findings || []).filter(
      (f) => MUST_NOT_FIRE_ON_CLEAN.includes(f.ruleId) && (f.kind === 'standard' || f.kind === 'mechanical')
    );
    check('the clean control is still clean after the fixes', claimedAfter.length === 0, short(claimedAfter.map((f) => f.ruleId)));
  }

  // ------------------------------------------------------- it changed nothing
  //
  // Measured from AFTER the remediation, so that the two fixes above are not
  // mistaken for the audit having written something.
  {
    const beforeBytes = projectBytes(root);
    await call('audit', { route: '/audit' });
    const afterBytes = projectBytes(root);
    const changed = diffBytes(beforeBytes, afterBytes);
    check('the audit wrote nothing to the project', changed.length === 0, changed.slice(0, 6).join('; '));
    check('and the fixes it was asked for did land', fixedIds.length === 2, `${fixedIds.length} fixed`);

    const viewAfter = await call('get_context', { styleDetail: 'none' });
    check('the person is still on the same page', viewAfter.page?.route === viewBefore.page?.route, `${viewBefore.page?.route} -> ${viewAfter.page?.route}`);
    check('at the same breakpoint', viewAfter.view?.device === viewBefore.view?.device, `${viewBefore.view?.device} -> ${viewAfter.view?.device}`);
    // NOT by comparing refs. A ref embeds the revision and an expiry, so two
    // reads of the SAME unchanged node produce different ref strings by design;
    // asserting on them would fail whether or not anything moved. What must not
    // move is which node is selected, which is its source range.
    // A COMPOSITE IDENTITY, not the ref.
    //
    // A ref embeds the revision and an expiry, so two reads of the same
    // unchanged node produce different strings by design and comparing them
    // would fail whether or not anything moved. But comparing the source range
    // alone is too weak in the other direction: two different nodes can share a
    // range, and an earlier sabotage moved the selection without this noticing.
    // So: everything about the selection that says WHICH node it is.
    const identity = (sel) =>
      JSON.stringify({
        status: sel?.status ?? null,
        nodeKind: sel?.nodeKind ?? null,
        tag: sel?.tag ?? null,
        occurrence: sel?.occurrence ?? null,
        source: sel?.source ?? null,
        breadcrumbs: sel?.breadcrumbs ?? null,
        componentChain: sel?.componentChain ?? null,
      });
    check(
      'with the same thing selected',
      identity(viewAfter.selection) === identity(viewBefore.selection),
      `${short(identity(viewBefore.selection))} -> ${short(identity(viewAfter.selection))}`
    );
    check('and the same viewport width', viewAfter.view?.viewportWidth === viewBefore.view?.viewportWidth, `${viewBefore.view?.viewportWidth} -> ${viewAfter.view?.viewportWidth}`);

    check('no audit window survived the run', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
    check('and the app has no extra windows', BrowserWindow.getAllWindows().length === windowsBefore, `${windowsBefore} -> ${BrowserWindow.getAllWindows().length}`);
  }

  // ------------------------------------------------------------- and it failed safely
  //
  // A route that does not exist still has to leave the world alone. Astro answers
  // a missing route with a 404 PAGE rather than a failed load, so this asserts the
  // outcome that is actually true: the audit completes, and nothing leaked.
  {
    const missing = await call('audit', { route: '/definitely-not-a-route-here' });
    // Not `typeof ok === 'boolean'`, which was true either way. A missing route
    // is refused by name, and the refusal is what must not write anything.
    check('auditing a route that does not exist is refused, not measured', missing.ok === false && missing.code === 'route_not_ok', short(missing));
    check('and leaks no window whichever way it went', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
    const settled = projectBytes(root);
    await call('audit', { route: '/definitely-not-a-route-here' });
    check('and still wrote nothing', diffBytes(settled, projectBytes(root)).length === 0);
  }

  return finish();
})()
  .catch((err) => {
    console.error('mcp-audit threw\n', err);
    failures.push(`  the run threw: ${err?.message || err}`);
    return finish();
  });

async function finish() {
  // A DEV SERVER THAT WILL NOT STOP IS OWNED RESIDUE.
  //
  // This said "reported by the residue check below", and there was no such check
  // for the dev server -- so a preview that refused to stop was swallowed twice
  // over. It is a named failure now.
  try {
    const said = stopPreview ? await stopPreview() : null;
    if (said && said.ok === false) {
      failures.push(`  the dev server would not stop: ${said.message || said.code || 'refused'}`);
      checked++;
    }
  } catch (err) {
    failures.push(`  stopping the dev server threw: ${err?.message || err}`);
    checked++;
  }
  // CLEANUP FAILURE IS TEST FAILURE.
  check('no audit window outlived the run', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
  try {
    removeCanvasProject(root);
  } catch (err) {
    failures.push(`  the fixture would not come down: ${err?.message || err}`);
    checked++;
  }
  if (fs.existsSync(root)) {
    failures.push(`  the owned fixture is still on disk: ${root}`);
    checked++;
  }
  // CLEANUP FAILURE IS TEST FAILURE.
  //
  // This was `catch { /* best effort */ }`, which is the one thing the standard
  // this repository runs on forbids: a userData directory that cannot be removed
  // is owned residue, and swallowing the error printed green over it.
  try {
    releaseTempDir(userData);
  } catch (err) {
    failures.push(`  the owned userData directory would not come down: ${err?.message || err}`);
    checked++;
  }
  // And prove it actually went, rather than trusting a call that did not throw.
  if (fs.existsSync(userData)) {
    failures.push(`  the owned userData directory is still on disk: ${userData}`);
    checked++;
  }
  if (failures.length) {
    console.error(`\nmcp-audit: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    app.exit(1);
    return;
  }
  console.log(`mcp-audit: ${checked} passed  [real Astro, real browser, seeded defects, clean controls]`);
  app.exit(0);
}
