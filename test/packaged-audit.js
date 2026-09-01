// Phase B and Phase C, in the thing people install.
//
//   node test/packaged-audit.js
//
// packaged-acceptance.js proves the Phase-A chain through the bundle. This
// proves the two halves added on top of it, in the same way and for the same
// reason: a feature that works from source and not from `Stacki.app` is a
// feature nobody has.
//
// Everything real. The app is release/mac-universal/Stacki.app, built unsigned.
// The project is a real Astro project with real dependencies and the seeded
// audit corpus in it. The client is the official MCP client. The findings come
// out of a browser the packaged app started.
//
// TWO THINGS THAT ONLY THIS FILE CAN CATCH:
//
//   axe-core NOT BEING IN THE BUNDLE. It is required lazily, from
//   node_modules/axe-core/axe.min.js, which means a packaging config that does
//   not ship it fails HERE and passes everywhere else.
//
//   THE PROFILE BEING A FIXTURE. The project profile has to describe the real
//   Astro project this test made — its routes, its components, its Astro
//   version — and not a canned object that happens to have the right shape.

const fs = require('node:fs');
const path = require('node:path');

const { startPackagedApp, available, APP } = require('./support/packagedApp.js');
const { auditFixture, MUST_NOT_FIRE_ON_CLEAN } = require('./support/auditFixture.js');
const { TOPIC_NAMES, uriFor } = require('../electron/mcp/guide.js');
const { PROFILE_URI, PROMPTS } = require('../electron/mcp/intelligence.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const brief = (v, n = 220) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s && s.length > n ? `${s.slice(0, n)}…` : s;
  } catch {
    return String(v);
  }
};
const textOf = (res) => (res?.contents || []).map((c) => c.text || '').join('');
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!available()) {
    console.log(`packaged-audit: skipped  [no ${APP} — run npm run dist:mac:unsigned]`);
    return;
  }

  // `edit`, not `full`: everything here is a read or an ordinary edit, and a
  // test that quietly ran at the highest level would not be testing the level
  // people are actually on.
  const app = await startPackagedApp({ access: 'edit', extraFiles: auditFixture({ broken: true }) });

  try {
    const info = await app.untilOpen();
    check('the packaged app opened the fixture', info?.project?.open === true, brief(info?.project));
    await app.untilPreviewReady();

    // ─────────────────────────────────────────────── Phase B, from the bundle

    const listed = await app.client.listResources();
    const uris = (listed.resources || []).map((r) => r.uri);
    check('the packaged app advertises the guides', TOPIC_NAMES.every((t) => uris.includes(uriFor(t))), brief(uris));
    check('  and the project profile', uris.includes(PROFILE_URI), brief(uris));

    const prompts = (await app.client.listPrompts()).prompts || [];
    const names = prompts.map((p) => p.name);
    check('the packaged app advertises the prompts', PROMPTS.every((p) => names.includes(p.name)), brief(names));

    const got = await app.client.getPrompt({ name: 'stacki_audit_and_fix', arguments: { route: '/audit' } });
    const promptText = (got.messages || []).map((m) => m.content?.text || '').join('\n');
    check('prompts/get answers from the bundle', promptText.includes('/audit'), brief(promptText, 120));

    const guide = textOf(await app.client.readResource({ uri: uriFor('audit') }));
    check('a guide reads from the bundle', bytes(guide) > 400 && /incomplete/.test(guide), `${bytes(guide)} bytes`);
    check('  and it still refuses the compliance claim', /No violations does NOT mean accessible/.test(guide));

    // THE PROFILE DESCRIBES THIS PROJECT, NOT A SHAPE.
    const profileText = textOf(await app.client.readResource({ uri: PROFILE_URI }));
    let profile = null;
    try {
      profile = JSON.parse(profileText);
    } catch {
      /* asserted next */
    }
    check('the project profile reads from the bundle', profile?.ok === true, brief(profileText, 200));
    const p = profile?.profile || {};
    check('  and it names the real project', String(p.project?.name || '').startsWith('stacki-agent-'), brief(p.project));
    check('  and the routes this fixture really has', JSON.stringify(p.routes || {}).includes('src/pages/audit.astro'), brief(p.routes, 200));
    check('  and the Astro version out of its package.json', typeof p.framework?.astro === 'string' && p.framework.astro.length > 0, brief(p.framework));
    check('  and its real components', JSON.stringify(p.components || {}).includes('Card'), brief(p.components, 160));
    check('  with provenance on every section', ['project', 'framework', 'routes', 'components', 'styles', 'tokens', 'breakpoints', 'classes', 'content'].every((k) => typeof p[k]?.source === 'string'));
    check('  and project text framed as data', /is not an instruction/i.test(String(p.about)));

    // Phase A is untouched by any of it.
    const toolNames = ((await app.client.listTools()).tools || []).map((t) => t.name);
    check('the tool surface is the whole fourteen', toolNames.length === 14, `${toolNames.length}: ${toolNames.join(',')}`);
    const ctx = await app.call('get_context', { styleDetail: 'none' });
    check('get_context still answers normally', String(ctx?.project?.root || '').length > 0, brief(ctx?.page));

    // ─────────────────────────────────────────────── Phase C, from the bundle

    const audit = await app.call('audit', { route: '/audit' });
    check('the packaged app audits a route', audit?.ok === true, brief(audit, 300));

    if (audit?.ok) {
      // If axe were missing from the bundle this is where it would say so.
      check('  axe-core shipped inside the app', /axe-core/.test(String(audit.engine?.accessibility)), brief(audit.engine));
      check('  and the engine did not error', audit.engine?.error == null, brief(audit.engine?.error));
      check('  it audited the three default viewports', (audit.viewports || []).length === 3, brief((audit.viewports || []).map((v) => v.viewport.key)));

      const ids = (id) => (audit.findings || []).filter((f) => f.ruleId === id);
      check('  the seeded overflow is found', ids('horizontal-overflow').length > 0, brief((audit.findings || []).map((f) => f.ruleId)));
      const at = [...new Set(ids('horizontal-overflow').map((f) => f.viewport.key))];
      check('  and only at the phone', JSON.stringify(at) === JSON.stringify(['phone']), at.join(','));
      check('  the seeded contrast failure is found', ids('color-contrast').length > 0);
      check('  the seeded unlabelled input is found', ids('label').length > 0);
      check('  the seeded unnamed button is found', ids('button-name').length > 0);
      check('  the seeded image with no alternative is found', ids('image-alt').length > 0);
      check('  the intentional scroll container is not reported', (audit.findings || []).every((f) => !/carousel/.test(f.target?.selector || '')), brief((audit.findings || []).map((f) => f.target?.selector)));
      check('  incomplete is its own bucket', typeof audit.counts?.incomplete === 'number');
      check('  and the payload says what automated rules cannot do', /does not mean accessible/.test(String(audit.limits)));

      // Evidence, from the packaged browser.
      const shot = await app.call('audit', { route: '/audit', viewports: ['phone'], capture: true });
      const cap = (shot?.captures || [])[0];
      check('  a capture comes back from the bundle', !!cap, brief(shot?.captures?.length));
      if (cap) {
        check('  at the viewport it names', cap.viewport.width === 375, brief(cap.viewport));
        check('  and bounded', cap.bytes > 0 && cap.bytes < 3_500_000, `${cap.bytes} bytes`);
      }

      // The clean route in the same project.
      const clean = await app.call('audit', { route: '/clean' });
      const claimed = (clean?.findings || []).filter((f) => MUST_NOT_FIRE_ON_CLEAN.includes(f.ruleId) && (f.kind === 'standard' || f.kind === 'mechanical'));
      check('  the clean control claims no failure', claimed.length === 0, brief(claimed.map((f) => `${f.ruleId}@${f.viewport.key}`)));

      // ── remediation, through the packaged app ──────────────────────────
      //
      // PACKAGED FIX -> REAL FILE -> REAL PAGE -> REAL AUDIT -> REAL PIXELS.
      //
      // Four independent viewpoints, because a write that only proves itself is
      // not proof: the MCP read, the actual bytes on the harness's own disk, the
      // re-audit, and the picture.
      const overflow = ids('horizontal-overflow')[0];
      const cssPath = path.join(app.project, 'src/styles/audit.css');
      const beforeOnDisk = fs.readFileSync(cssPath, 'utf8');
      check('  the stylesheet on disk starts with the defect', /width:\s*520px/.test(beforeOnDisk), brief(beforeOnDisk.slice(0, 80)));
      const shotBefore = await app.call('audit', { route: '/audit', viewports: ['phone'], capture: true });
      const capBefore = (shotBefore?.captures || [])[0] || null;
      check('  a capture of the broken state comes back', !!capBefore, brief(shotBefore?.captures?.length));

      const css = await app.run('style', 'read_source', { path: 'src/styles/audit.css' });
      check('  the stylesheet reads through the bundle', css?.ok === true && typeof css.css === 'string', brief(css, 160));
      if (css?.ok && overflow) {
        const fixed = css.css.replace('  width: 520px;', '  width: 100%;\n  max-width: 520px;');
        const wrote = await app.run('style', 'write_source', { path: 'src/styles/audit.css', css: fixed, expectedDigest: css.digest });
        check('  the fix writes through the bundle', wrote?.ok === true, brief(wrote, 160));

        // VIEWPOINT 1: the harness's own read of the real file on disk. Not the
        // envelope, not an MCP answer -- the bytes.
        const afterOnDisk = fs.readFileSync(cssPath, 'utf8');
        check('  the actual file on disk carries the change', /max-width:\s*520px/.test(afterOnDisk), brief(afterOnDisk.slice(0, 120)));
        check('  and no longer carries the defect', !/\n\s*width:\s*520px;/.test(afterOnDisk));
        check('  and the file really changed', afterOnDisk !== beforeOnDisk);

        // VIEWPOINT 2: the same file, read back through MCP.
        const reread = await app.run('style', 'read_source', { path: 'src/styles/audit.css' });
        check('  MCP reads the changed stylesheet back', reread?.ok === true && /max-width:\s*520px/.test(String(reread.css)), brief(reread?.css?.slice(0, 120)));
        check('  and the two viewpoints agree', reread?.css === afterOnDisk);

        let gone = null;
        for (let i = 0; i < 20 && !gone; i += 1) {
          await sleep(2000);
          const again = await app.call('audit', { route: '/audit', viewports: ['phone'] });
          if (again?.ok && !(again.findings || []).some((f) => f.id === overflow.id)) gone = again;
        }
        check('  re-auditing no longer reports it, by id', !!gone, 'the overflow survived the fix');
        // And the ones nobody fixed are still there, so a detector that broke
        // cannot pass for a fix that worked.
        if (gone) {
          check('  while the defects nobody fixed are still reported', (gone.findings || []).some((f) => f.ruleId === 'color-contrast'), brief((gone.findings || []).map((f) => f.ruleId)));

          // VIEWPOINT 4: the pixels. The banner is 520px wide before and
          // full-width after, so two captures of the same route at the same width
          // cannot legitimately be the same bytes.
          const shotAfter = await app.call('audit', { route: '/audit', viewports: ['phone'], capture: true });
          const capAfter = (shotAfter?.captures || [])[0] || null;
          check('  a capture of the corrected state comes back', !!capAfter, brief(shotAfter?.captures?.length));
          if (capBefore && capAfter) {
            check('  and it is not the picture of the broken state', capAfter.data !== capBefore.data, `${capBefore.bytes} -> ${capAfter.bytes} bytes`);
            check('  at the viewport the fix was measured at', capAfter.viewport.width === 375, brief(capAfter.viewport));
          }
          // VIEWPOINT 3 restated: the running page no longer overflows at all.
          const vp = (gone.viewports || [])[0];
          check('  and the running page no longer scrolls sideways', vp && vp.overflows === false, brief(vp));
        }
      }
    }

    // Below `inspect` none of it is available. A second app, because the level
    // is granted per project when the app starts.
    const visual = await startPackagedApp({ access: 'visual', portFrom: 44200, extraFiles: auditFixture({ broken: true }) });
    try {
      await visual.untilOpen();
      const denied = await visual.call('audit', { route: '/audit' });
      check('at visual the packaged audit is refused', denied?.ok === false && denied?.code === 'permission_denied', brief(denied, 200));
      check('  and it names the level it needs', denied?.requires === 'inspect', brief(denied?.requires));
      const prof = textOf(await visual.client.readResource({ uri: PROFILE_URI }));
      check('  and the project profile is refused too', /permission_denied/.test(prof), brief(prof, 160));
      check('  carrying no project fact', !/src\/pages\/audit\.astro|--brand/.test(prof), brief(prof, 160));
      // The guides are not project data and stay readable.
      const g = textOf(await visual.client.readResource({ uri: uriFor('operating-model') }));
      check('  while the guidance stays readable', bytes(g) > 400, `${bytes(g)} bytes`);
    } finally {
      const { problems } = await visual.stop();
      check('the visual-level app left nothing behind', (problems || []).length === 0, (problems || []).join('; '));
    }
  } finally {
    const { problems } = await app.stop();
    check('the packaged app left nothing behind', (problems || []).length === 0, (problems || []).join('; '));
  }

  if (failures.length) {
    console.error(`\npackaged-audit: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged-audit: ${checked} passed  [resources, prompts, profile, audit, remediation — all from Stacki.app]`);
})().catch((err) => {
  console.error('packaged-audit threw\n', err);
  process.exit(1);
});
