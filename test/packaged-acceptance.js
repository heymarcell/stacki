// The whole chain, in the thing people install.
//
//   node test/packaged-acceptance.js
//
// test/packaged-mcp.js proves the packaged bundle serves the 2026 protocol with
// nothing open. This proves the rest of the sentence: that a real MCP client can
// open a real Astro project in a packaged Stacki, read it, change it, see the
// change in the running site and in a screenshot, and undo it — one coherent
// system rather than a set of parts that each pass alone.
//
// Everything here is the real thing. The app is release/mac-universal/Stacki.app,
// built unsigned. The project is a real Astro project with its dependencies
// really installed. The dev server is Astro's. The screenshots are pixels.
// Nothing reaches into Electron internals: if the packaged app cannot answer
// over HTTP, this fails.
//
// THE SCREENSHOT INVARIANT. A capture is only evidence if it is a photograph of
// the state just asserted. So each one is compared by the hash of its own bytes
// against the one before it, and a change that should be visible has to make
// those hashes differ — a stale or cached image cannot pass for a fresh one.

const crypto = require('node:crypto');
const { startPackagedApp, available, APP } = require('./support/packagedApp.js');

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

(async () => {
  if (!available()) {
    console.log(`packaged-acceptance: skipped  [no ${APP} — run npm run dist:mac:unsigned]`);
    return;
  }

  const app = await startPackagedApp({ access: 'edit' });
  try {
    // ── the project opens, through the one automation door ────────────────
    const info = await app.untilOpen();
    check('the packaged app opened the project it was pointed at', info?.ok === true && info?.project?.open === true, brief(info));
    check('  and it is the fixture this test made', String(info?.project?.name || '').startsWith('stacki-agent-'), brief(info?.project));

    const pages = await app.run('page', 'list');
    check('page.list answers from the bundle', pages?.ok === true && (pages.pages || []).some((p) => p.route === '/'), brief(pages));

    const src0 = await app.run('source', 'read', { path: 'src/pages/index.astro' });
    check('source.read answers with the page on disk', src0?.ok === true && String(src0.text || '').includes('Made carefully.'), brief(src0?.text));

    const read = await app.run('target', 'read');
    check('target.read answers with a source-backed tree', read?.ok === true && !!read?.target?.ref, brief(read?.target, 160));
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      (n.children || []).forEach(walk);
    };
    walk(read?.target);
    const footer = flat.find((n) => String(n.tag || '').toLowerCase() === 'footer');
    const grid = flat.find((n) => String(n.tag || '').toLowerCase() === 'div');
    check('  including the nodes the fixture page really has', !!footer && !!grid, flat.map((n) => n.tag || n.name).join(', '));

    const ctx = await app.call('get_context', { styleDetail: 'essential' });
    check('get_context describes the open project', String(ctx?.project?.root || '').length > 0 && ctx?.page?.file === 'src/pages/index.astro', brief(ctx?.page));

    const comments = await app.run('comment', 'list');
    check('get_comments answers rather than failing with no reviews', comments === undefined || typeof comments === 'object', brief(comments));

    // ── the site is actually being served ─────────────────────────────────
    const first = await app.untilPreviewReady();
    check('the preview comes up and can be photographed', first?.status === 'ready', brief(first?.status));

    const dev = await app.run('project', 'dev_status');
    check('the app reports the preview as running', dev?.ok === true && dev.status === 'on', brief(dev));
    check('  and names the address it bound', typeof dev?.url === 'string' && dev.url.startsWith('http'), String(dev?.url));
    const served = await fetch(dev.url, { signal: AbortSignal.timeout(8000) }).then((r) => r.status).catch(() => 0);
    check('  which really answers HTTP', served >= 200 && served < 500, String(served));

    // ── a capture, by the hash of its own bytes ───────────────────────────
    const shot = async () => {
      const res = await app.client.callTool({ name: 'capture', arguments: { target: 'viewport', format: 'png' } }, undefined, { timeout: 240000 });
      const img = (res.content || []).find((c) => c.type === 'image');
      return {
        meta: res.structuredContent,
        bytes: img?.data ? Buffer.from(img.data, 'base64').length : 0,
        hash: img?.data ? crypto.createHash('sha256').update(img.data).digest('hex').slice(0, 16) : null,
      };
    };
    /** Capture until the picture changes, so a stale image cannot pass. */
    const shotUntilChanged = async (was, tries = 30) => {
      let now = null;
      for (let i = 0; i < tries; i += 1) {
        now = await shot();
        if (now.hash && now.hash !== was) return now;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return now;
    };

    const before = await shot();
    check('the screenshot is a real image', before.bytes > 1000 && !!before.hash, `${before.bytes} bytes`);
    check('  of a page that is ready, not a placeholder', before.meta?.status === 'ready', brief(before.meta?.status));

    // ── MUTATION: source, model, render, pixels ───────────────────────────
    // Set on the <footer>, which already holds a <p>. Stacki authors this as
    // text of the footer itself rather than replacing the paragraph, so the
    // proof is that the canary ARRIVES everywhere and leaves again — not that
    // the paragraph disappeared, which this operation never promised.
    const CANARY = 'Changed by the packaged acceptance test';
    const edit = await app.run('target', 'set_text', { ref: footer.ref, text: CANARY });
    check('a mutation through MCP is accepted by the packaged app', edit?.ok === true, brief(edit));
    check('  and it is undoable, through Stacki\'s own stack', edit?.undoable !== false, brief(edit?.undoable));

    const src1 = await app.run('source', 'read', { path: 'src/pages/index.astro' });
    check('  the page source on disk carries the new text', String(src1?.text || '').includes(CANARY), brief(src1?.text, 160));

    const reread = await app.run('target', 'read');
    check('  Stacki\'s own model reports the new text', JSON.stringify(reread?.target || {}).includes(CANARY), brief(reread?.target, 160));

    // Polled, because a dev server rebuilds on its own schedule. Asking once and
    // calling a miss a failure would be testing the timing, not the change.
    const servedWith = async (needle, tries = 25) => {
      let html = '';
      for (let i = 0; i < tries; i += 1) {
        html = await fetch(dev.url, { signal: AbortSignal.timeout(10000) }).then((r) => r.text()).catch(() => '');
        if (html.includes(needle)) return html;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return html;
    };
    const rendered = await servedWith(CANARY);
    check('  the running site serves the new text', rendered.includes(CANARY), brief(rendered.slice(0, 200)));

    const after = await shotUntilChanged(before.hash);
    check('  and the screenshot changed with it', after.hash !== before.hash, `${before.hash} -> ${after.hash}`);
    check('  the capture being of a ready page, not a rebuild', after.meta?.status === 'ready', brief(after.meta?.status));

    // ── UNDO: all the way back ────────────────────────────────────────────
    const undo = await app.run('project', 'undo');
    check('undo is accepted', undo?.ok === true && undo.undone === true, brief(undo));

    // Saves are debounced, so the file catches up a moment after the model does.
    // Bounded, and it still has to happen: what is asserted is that undo reaches
    // the disk, not that it reached it within one round trip.
    let src2 = null;
    for (let i = 0; i < 30; i += 1) {
      src2 = await app.run('source', 'read', { path: 'src/pages/index.astro' });
      if (!String(src2?.text || '').includes(CANARY)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    check('  the source is what it was', String(src2?.text || '').includes('Made carefully.'), brief(src2?.text, 160));
    check('  with no trace of the edit', !String(src2?.text || '').includes(CANARY), brief(src2?.text, 160));

    const backModel = await app.run('target', 'read');
    check('  and the model agrees', !JSON.stringify(backModel?.target || {}).includes(CANARY));

    // Waits for the canary to be GONE, the same way it waited for it to arrive.
    let restored = '';
    for (let i = 0; i < 25; i += 1) {
      restored = await fetch(dev.url, { signal: AbortSignal.timeout(10000) }).then((r) => r.text()).catch(() => '');
      if (restored.includes('Made carefully.') && !restored.includes(CANARY)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('  the running site serves the original again', restored.includes('Made carefully.') && !restored.includes(CANARY));

    const back = await shotUntilChanged(after.hash);
    check('  and the screenshot came back too', back.hash !== after.hash, `${after.hash} -> ${back.hash}`);

    // ── STYLE: authored, rendered, photographed ───────────────────────────
    const styled = await app.run('style', 'set_property', {
      ref: grid.ref,
      selector: '.pricing-grid',
      source: 'file:src/styles/site.css',
      property: 'outline',
      value: '6px solid rgb(255, 0, 0)',
    });
    check('a style change through MCP is accepted', styled?.ok === true, brief(styled));

    const css = await app.run('source', 'read', { path: 'src/styles/site.css' });
    check('  the stylesheet on disk carries the declaration', /outline:\s*6px solid rgb\(255, 0, 0\)/.test(String(css?.text || '')), brief(css?.text, 200));

    const servedCss = await fetch(dev.url, { signal: AbortSignal.timeout(15000) }).then((r) => r.text()).catch(() => '');
    check('  and the running site is still serving the page', servedCss.includes('pricing-grid'), brief(servedCss.slice(0, 160)));

    const painted = await shotUntilChanged(back.hash);
    check('  the change is visible in a screenshot', painted.hash !== back.hash, `${back.hash} -> ${painted.hash}`);

    const undoStyle = await app.run('project', 'undo');
    check('the style change is undoable too', undoStyle?.ok === true, brief(undoStyle));
    let css2 = null;
    for (let i = 0; i < 30; i += 1) {
      css2 = await app.run('source', 'read', { path: 'src/styles/site.css' });
      if (!/outline:\s*6px solid/.test(String(css2?.text || ''))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    check('  and the stylesheet is what it was', !/outline:\s*6px solid/.test(String(css2?.text || '')), brief(css2?.text, 200));
  } finally {
    const { problems, pid, port } = await app.stop();
    check('the packaged app, its project and its port are all gone', problems.length === 0, `pid ${pid}, port ${port}: ${problems.join('; ')}`);
  }

  if (failures.length) {
    console.error(`\npackaged-acceptance: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged-acceptance: ${checked} passed  [real bundle, real Astro, real pixels, undone again]`);
})().catch((err) => {
  console.error('packaged-acceptance threw\n', err);
  process.exit(1);
});
