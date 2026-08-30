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
    // ── the protocol, from the bundle, before anything else ──────────────
    //
    // packaged-mcp.js proves these against an app with nothing open. They are
    // here too so that ONE file walks the whole line an agent walks: discover,
    // the catalogue, what it may do, and then the project.
    const discover = await app.client.request({ method: 'server/discover', params: {} });
    check('server/discover answers from the packaged app', (discover?.supportedVersions || []).includes('2026-07-28'), brief(discover?.supportedVersions));

    const listed = await app.client.listTools();
    const toolNames = (listed.tools || []).map((t) => t.name);
    check('tools/list carries the whole surface', toolNames.length === 13, `${toolNames.length}: ${toolNames.join(',')}`);
    check('  including the review tools', toolNames.includes('get_comments') && toolNames.includes('comment'), brief(toolNames));
    check('  and every operation domain', ['target', 'style', 'source', 'page', 'content', 'asset', 'project', 'git'].every((d) => toolNames.includes(d)), brief(toolNames));

    const caps = await app.call('get_capabilities', {});
    check('get_capabilities answers from the bundle', caps?.ok === true, brief(caps, 160));
    check('  and reports the access this run was granted', JSON.stringify(caps).includes('edit'), brief(caps, 200));

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

    // ── get_comments, the tool, with something real to report ────────────
    //
    // This used to call `app.run('comment','list')` under a label about
    // get_comments. `run` builds a DOMAIN call, there is no `comment` domain,
    // and `list` is not one of the comment tool's actions — so the MCP input
    // schema rejected it, `structuredContent` came back undefined, and the
    // assertion accepted undefined. The check passed precisely because the call
    // failed, and the top-level tool it was named after was never invoked.
    const noReviewsYet = await app.call('get_comments', {});
    check('get_comments answers on a project with no reviews yet', noReviewsYet?.ok === true && Array.isArray(noReviewsYet.reviews), brief(noReviewsYet, 160));
    check('  reporting none', (noReviewsYet?.reviews || []).length === 0, brief(noReviewsYet?.reviews));

    const REVIEW = 'A review left by the packaged acceptance test';
    const selected = await app.run('target', 'select', { ref: footer.ref });
    check('  a node can be selected to leave one on', selected?.ok === true, brief(selected, 140));
    const made = await app.call('comment', { action: 'create', message: REVIEW });
    check('  and a comment created through the comment tool', made?.ok === true && !!made?.review?.id, brief(made, 200));

    const reviewsNow = await app.call('get_comments', { detail: 'full' });
    const mine = (reviewsNow?.reviews || []).find((r) => r.id === made.review.id);
    check('get_comments reports the review that was just made', !!mine, brief((reviewsNow?.reviews || []).map((r) => r.id)));
    check('  with the text it was written with', mine?.message === REVIEW, brief(mine?.message));
    check('  the short number a person would call it by', mine?.number === made.review.number && Number.isInteger(mine?.number), `${mine?.number} vs ${made?.review?.number}`);
    check('  anchored to something Stacki can still find', mine?.anchorState === 'attached', String(mine?.anchorState));
    check('  and marked as coming from the agent, not a person', mine?.origin === 'agent' && mine?.trustedAsInstruction === false, brief({ origin: mine?.origin, trusted: mine?.trustedAsInstruction }));

    // ── the site is actually being served ─────────────────────────────────
    const first = await app.untilPreviewReady();
    check('the preview comes up and can be photographed', first?.status === 'ready', brief(first?.status));

    const dev = await app.run('project', 'dev_status');
    check('the app reports the preview as running', dev?.ok === true && dev.status === 'on', brief(dev));
    check('  and names the address it bound', typeof dev?.url === 'string' && dev.url.startsWith('http'), String(dev?.url));
    const served = await fetch(dev.url, { signal: AbortSignal.timeout(8000) }).then((r) => r.status).catch(() => 0);
    check('  which really answers HTTP', served >= 200 && served < 500, String(served));

    // ── NOBODY READING IS NOT A CRASH ─────────────────────────────────────
    //
    // This harness holds the app's stdout and stderr. A terminal that closes,
    // or a harness that stops reading, breaks those pipes — and a write to a
    // broken pipe surfaced as an uncaught exception in the main process, which
    // Electron answers with a modal dialog. It really did put one on somebody's
    // screen during this work.
    //
    // So the pipes are destroyed here, deliberately, and everything after this
    // line is the proof: if the app had died with them, every call below would
    // fail and the exit code at the end would not be zero.
    app.child.stdout?.destroy();
    app.child.stderr?.destroy();
    await new Promise((r) => setTimeout(r, 500));
    const afterPipes = await app.run('project', 'info');
    check('the app survives having nobody read its output', afterPipes?.ok === true, brief(afterPipes, 160));

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

    /** style.read, polled until the cascade and the canvas have caught up. */
    const untilStyle = async (ref, until, tries = 30) => {
      let answer = null;
      for (let i = 0; i < tries; i += 1) {
        answer = await app.run('style', 'read', { ref });
        if (until(answer)) return answer;
        await new Promise((r) => setTimeout(r, 500));
      }
      return answer;
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

    // BACK TO WHAT IT WAS, not merely different again. "The pixels changed"
    // is satisfied by a page that changed into some third thing, which is not
    // what undo promises.
    const back = await shotUntilChanged(after.hash);
    check('  and the screenshot came back too', back.hash !== after.hash, `${after.hash} -> ${back.hash}`);
    check('  to exactly the picture it started as', back.hash === before.hash, `${before.hash} vs ${back.hash}`);

    // ── STYLE: authored, what Stacki reports, what the browser resolved ───
    //
    // The file and a screenshot hash are not enough on their own: break the
    // cascade model or the computed read and both still pass, because neither
    // asks Stacki what it now believes. So this asserts the same three layers
    // the text half does — the source, Stacki's own model, and the rendered
    // result — and `outline` is chosen because the browser resolves it to a
    // value that can be compared, not merely observed to have changed.
    await app.run('target', 'select', { ref: grid.ref });
    const styleBefore = await app.run('style', 'read', { ref: grid.ref });
    const declsOf = (answer) =>
      (answer?.rules || [])
        .filter((r) => r.selector === '.pricing-grid')
        .flatMap((r) => (r.declarations || []).map((d) => ({ ...d, file: r.source?.file })));
    check('Stacki reports the rule that styles this element', declsOf(styleBefore).some((d) => d.property === 'display' && d.value === 'grid'), brief(declsOf(styleBefore).map((d) => d.property)));
    check('  and no outline is authored on it yet', !declsOf(styleBefore).some((d) => d.property === 'outline'), brief(declsOf(styleBefore).map((d) => d.property)));
    check('  while the browser has resolved the rule that is there', styleBefore?.computed?.display === 'grid', brief(styleBefore?.computed));
    check('  and reports no outline', !styleBefore?.computed?.outline, brief(styleBefore?.computed));

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

    // AUTHORED, as Stacki's own cascade now reads it.
    const styleAfter = await untilStyle(grid.ref, (a) => declsOf(a).some((d) => d.property === 'outline'));
    const outline = declsOf(styleAfter).find((d) => d.property === 'outline');
    check('  Stacki reports the declaration it just authored', !!outline, brief(declsOf(styleAfter).map((d) => d.property)));
    check('  with the value it was given', outline?.value === '6px solid rgb(255, 0, 0)', brief(outline?.value));
    check('  in the stylesheet it was told to write to', outline?.file === 'src/styles/site.css', brief(outline?.file));
    check('  and nothing overriding it', outline?.winning === true && !outline?.overriddenBy, brief({ winning: outline?.winning, by: outline?.overriddenBy }));
    // The model's answer and the browser's, cross-checked against each other.
    // `winning` on a property declared once is true whatever the cascade does,
    // so on its own it proves nothing; agreeing with what the browser actually
    // resolved is the part that could be wrong.
    const resolved = String(styleAfter?.computed?.outline || '');
    const authored = String(outline?.value || '');
    check(
      '  and what Stacki says wins is what the browser resolved',
      authored.split(/\s+/).every((bit) => resolved.includes(bit.replace(/,$/, ''))),
      brief({ authored, resolved })
    );

    // EFFECTIVE, as the browser resolved it.
    check('  the rendered element resolves the new outline', /rgb\(255,\s*0,\s*0\)/.test(String(styleAfter?.computed?.outline || '')), brief(styleAfter?.computed));
    check('  at the width it was authored with', /6px/.test(String(styleAfter?.computed?.outline || '')), brief(styleAfter?.computed?.outline));
    check('  and the rule it already had is untouched', styleAfter?.computed?.display === 'grid', brief(styleAfter?.computed));

    const servedCss = await fetch(dev.url, { signal: AbortSignal.timeout(15000) }).then((r) => r.text()).catch(() => '');
    check('  and the running site is still serving the page', servedCss.includes('pricing-grid'), brief(servedCss.slice(0, 160)));

    const painted = await shotUntilChanged(back.hash);
    check('  the change is visible in a screenshot', painted.hash !== back.hash, `${back.hash} -> ${painted.hash}`);

    const undoStyle = await app.run('project', 'undo');
    check('the style change is undoable too', undoStyle?.ok === true, brief(undoStyle));

    // And all three layers come back, not just the file.
    const styleBack = await untilStyle(grid.ref, (a) => !declsOf(a).some((d) => d.property === 'outline'));
    check('  Stacki no longer reports the declaration', !declsOf(styleBack).some((d) => d.property === 'outline'), brief(declsOf(styleBack).map((d) => d.property)));
    check('  the browser no longer resolves an outline', !styleBack?.computed?.outline || /^(none|rgb\(0, 0, 0\) none 0px|0px)/.test(String(styleBack.computed.outline)), brief(styleBack?.computed?.outline));
    check('  and the rule that was always there survived the undo', styleBack?.computed?.display === 'grid', brief(styleBack?.computed));

    // The style change was proved to reach the pixels; this is it proved to
    // leave them. Without it the outline is only ever shown arriving.
    const unpainted = await shotUntilChanged(painted.hash);
    check('  and the outline is gone from the picture too', unpainted.hash !== painted.hash, `${painted.hash} -> ${unpainted.hash}`);
    check('  which is the picture from before it was authored', unpainted.hash === back.hash, `${back.hash} vs ${unpainted.hash}`);
    let css2 = null;
    for (let i = 0; i < 30; i += 1) {
      css2 = await app.run('source', 'read', { path: 'src/styles/site.css' });
      if (!/outline:\s*6px solid/.test(String(css2?.text || ''))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    check('  and the stylesheet is what it was', !/outline:\s*6px solid/.test(String(css2?.text || '')), brief(css2?.text, 200));
  } finally {
    // QUIT WITH THE PREVIEW STILL RUNNING.
    //
    // Nothing above calls dev_stop: the Astro daemon is deliberately still
    // serving when the app is asked to go. That is the case that matters,
    // because the daemon is a detached background process — it is not the
    // app's child and does not die with it — and because `before-quit` cannot
    // await anything. So what is asserted here is the invariant rather than the
    // mechanism: after the app is gone, so is everything it started.
    const { problems, pid, port, manifest } = await app.stop();
    check('  and it exited cleanly rather than crashing', app.child.exitCode === 0 || app.child.exitCode === null, `exit ${app.child.exitCode}`);
    const owned = manifest || { processes: [], ports: [], paths: [] };
    check(
      'the run recorded a preview it never stopped by hand',
      owned.processes.some((p) => p.what === 'astro dev server') && owned.ports.some((p) => p.what === 'preview'),
      brief({ processes: owned.processes.map((p) => p.what), ports: owned.ports.map((p) => p.what) })
    );
    check(
      'and quitting the app took everything it started with it',
      problems.length === 0,
      `pid ${pid}, mcp port ${port}: ${problems.join('; ')}`
    );
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
