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
const { auditFixture, SEEDED, SEEDED_INCOMPLETE, MUST_NOT_FIRE_ON_CLEAN } = require('./support/auditFixture.js');
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

/** Every file in the project that a person would notice changing. */
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
          out.set(path.relative(dir, full), fs.statSync(full).size);
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
    else if (b.get(k) !== v) changed.push(`changed ${k} (${v} -> ${b.get(k)})`);
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

  const beforeBytes = projectBytes(root);
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

  // --- 320 is a standards failure, other widths are a measurement
  {
    const reflow = await call('audit', { route: '/audit', viewports: ['reflow'] });
    check('the reflow viewport audits', reflow.ok === true, short(reflow));
    const o = (reflow.findings || []).filter((f) => f.ruleId === 'horizontal-overflow');
    check('overflow at 320 is reported as a standard', o.length > 0 && o.every((f) => f.kind === 'standard'), short(o.map((f) => f.kind)));
    check('and it names the success criterion', o.length > 0 && /1\.4\.10/.test(String(o[0].standard)), short(o[0]?.standard));
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

  // ------------------------------------------------------- it changed nothing
  {
    const afterBytes = projectBytes(root);
    const changed = diffBytes(beforeBytes, afterBytes);
    check('the audit wrote nothing to the project', changed.length === 0, changed.slice(0, 6).join('; '));

    const viewAfter = await call('get_context', { styleDetail: 'none' });
    check('the person is still on the same page', viewAfter.page?.route === viewBefore.page?.route, `${viewBefore.page?.route} -> ${viewAfter.page?.route}`);
    check('at the same breakpoint', viewAfter.view?.device === viewBefore.view?.device, `${viewBefore.view?.device} -> ${viewAfter.view?.device}`);
    // NOT by comparing refs. A ref embeds the revision and an expiry, so two
    // reads of the SAME unchanged node produce different ref strings by design;
    // asserting on them would fail whether or not anything moved. What must not
    // move is which node is selected, which is its source range.
    check('with the same thing selected', viewAfter.selection?.status === viewBefore.selection?.status, `${viewBefore.selection?.status} -> ${viewAfter.selection?.status}`);
    check('  at the same place in the same file',
      JSON.stringify(viewAfter.selection?.source ?? null) === JSON.stringify(viewBefore.selection?.source ?? null),
      `${short(viewBefore.selection?.source)} -> ${short(viewAfter.selection?.source)}`);
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
    check('auditing a route that does not exist answers rather than hangs', typeof missing.ok === 'boolean', short(missing));
    check('and leaks no window whichever way it went', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
    const afterBytes = projectBytes(root);
    check('and still wrote nothing', diffBytes(beforeBytes, afterBytes).length === 0);
  }

  return finish();
})()
  .catch((err) => {
    console.error('mcp-audit threw\n', err);
    failures.push(`  the run threw: ${err?.message || err}`);
    return finish();
  });

async function finish() {
  try {
    if (stopPreview) await stopPreview();
  } catch {
    /* reported by the residue check below */
  }
  // CLEANUP FAILURE IS TEST FAILURE.
  check('no audit window outlived the run', liveWindowCount() === 0, `${liveWindowCount()} still registered`);
  try {
    removeCanvasProject(root);
  } catch (err) {
    failures.push(`  the fixture would not come down: ${err?.message || err}`);
  }
  try {
    releaseTempDir(userData);
  } catch {
    /* best effort */
  }
  if (failures.length) {
    console.error(`\nmcp-audit: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    app.exit(1);
    return;
  }
  console.log(`mcp-audit: ${checked} passed  [real Astro, real browser, seeded defects, clean controls]`);
  app.exit(0);
}
