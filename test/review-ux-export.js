// Photograph every state of the review UI, one file each.
//
//   npm run export:reviewux
//   node --check test/review-ux-export.js && electron test/review-ux-export.js [outDir]
//
// The visual harness asserts; this one only looks. It runs the shipped main
// process against a real project with a real dev server, seeds the
// conversations that matter — a short one, a long agent reply, a ten-message
// discussion, Markdown with code and a table, a resolved thread, an orphan, a
// cluster — and writes a PNG per state, plus a contact sheet to look through
// them in.
//
// It exists because a review UI cannot be judged from a DOM snapshot, and
// because "look at all of it" is otherwise twenty-five manual steps that are
// easy to do differently each time.

process.env.STACKI_NO_DIALOGS = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');

const OUT = process.argv[2] || path.join(os.homedir(), 'Downloads', 'stacki-review-ux-states');

const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, { timeout = 240000, every = 250 } = {}) {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await wait(every);
  }
}

app.on('window-all-closed', () => {});

if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  say('review-ux-export: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

sweepStaleRuns(['stacki-export-user-']);
const root = makeCanvasProject({ log: (m) => say(`review-ux-export: ${m}`) });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-export-user-'));
app.setPath('userData', userData);
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(root)]: 'edit' } }, null, 2),
  'utf8'
);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

const mcp = require('../electron/mcp');
const reviews = require('../electron/review');
require('../electron/main.js');

// --- the conversations ------------------------------------------------------

const LONG_REPLY = [
  'Done. Three files changed, one left alone on purpose.',
  '',
  'The padding was never set on the pill itself — it came from `.hero-inner`, which every',
  'card in that row inherits. Changing it there would have moved four other things, so the',
  'pill now sets its own and the inherited value is left where it is.',
  '',
  '- `src/components/Hero.astro` — the pill now carries `px-3`',
  '- `src/styles/site.css` — added `--pill-pad`, used in one place',
  '- `src/components/Panel.astro` — untouched, see below',
  '',
  '1. Read the computed styles at 375 and 1440',
  '2. Found `.hero-inner` was the winner at both',
  '3. Gave the pill its own value rather than editing the shared one',
  '',
  '> The reason `Panel.astro` is untouched: it renders the same class but inside a',
  '> different container, so it was never affected by this in the first place.',
  '',
  '| breakpoint | before | after |',
  '| --- | --- | --- |',
  '| 375 | 8px | 12px |',
  '| 1440 | 8px | 12px |',
  '',
  '```css',
  ':root {',
  '  --pill-pad: 12px;',
  '}',
  '',
  '.hero .pill {',
  '  padding-inline: var(--pill-pad);',
  '}',
  '```',
  '',
  'Reference: https://developer.mozilla.org/en-US/docs/Web/CSS/inheritance',
  '',
  'Mail me at design@example.com if the token name should be different.',
  '',
  '~~Reverted the first attempt~~ kept the second.',
].join('\n');

const SHOTS = [];
// States this run could not produce. Named in the output and on the contact
// sheet rather than filled in with a picture of something else.
const MISSING = [];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await app.whenReady();

  const win = await until('the window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to load', () => (win.webContents.isLoading() ? null : true));
  await wait(600);
  win.setMinimumSize(600, 400);
  win.setSize(1512, 982);
  win.webContents.send('menu:openProject');

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name, caption) => {
    await wait(650);
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    SHOTS.push({ name, caption });
    say(`  ${name}`);
  };

  await until(
    'the canvas',
    async () => (await js(`!!document.querySelector('iframe') && !document.querySelector('.welcome')`)) || null,
    { timeout: 300000 }
  );
  await wait(4000);

  // --- seed ----------------------------------------------------------------
  const make = (message, pin, extra = {}) =>
    reviews.act({ action: 'create', message, authorType: 'human', pin, ...extra });
  const reply = (threadId, message, authorType = 'agent') =>
    reviews.act({ action: 'reply', threadId, message, authorType });

  const tiny = make('This pill is too tight at 375.', { xRatio: 0.12, yRatio: 0.1 });
  const longOne = make('Have a look at the spacing on this and tell me what is going on.', { xRatio: 0.45, yRatio: 0.3 });
  reply(longOne.review.id, LONG_REPLY);

  const many = make('The whole row feels crowded.', { xRatio: 0.86, yRatio: 0.55 });
  for (let i = 1; i <= 9; i++) {
    reply(
      many.review.id,
      i % 2 ? `Reply ${i}: narrowed it down a little further.` : `And another thought, number ${i}.`,
      i % 2 ? 'agent' : 'human'
    );
  }

  const done = make('Colour was wrong here.', { xRatio: 0.3, yRatio: 0.78 });
  reply(done.review.id, 'Changed it to the brand token and checked both breakpoints.');
  reviews.act({ action: 'resolve', threadId: done.review.id, authorType: 'agent' });

  const deferred = make('The gap under this could be tighter.', { xRatio: 0.66, yRatio: 0.2 });
  reviews.act({ action: 'defer', threadId: deferred.review.id, reason: 'Waiting on the new spacing scale.', authorType: 'human' });

  // A cluster: three reviews close enough together to merge into one marker.
  const cluster = [];
  for (let i = 0; i < 3; i++) {
    const r = make(
      ['Accent colour looks off here.', 'Pro badge is too subtle.', 'Spacing is tight on mobile.'][i],
      { xRatio: 0.5 + i * 0.002, yRatio: 0.62 + i * 0.002 }
    );
    if (r.ok) cluster.push(r.review);
  }

  await wait(1400);

  // --- the index ------------------------------------------------------------
  await js(`(() => {
    const rail = [...document.querySelectorAll('.rail-btn')];
    rail[rail.length - 1]?.click();
    return true;
  })()`);
  await wait(900);
  await shot('01-comments-index', 'Comments index — rows only, nothing selected');

  const backToList = async () => {
    await js(`document.querySelector('.review-back')?.click()`);
    await wait(500);
  };
  const pickRow = async (pattern) => {
    await backToList();
    const got = await js(`(() => {
      const rows = [...document.querySelectorAll('.comments-row')];
      const row = rows.find((r) => ${pattern}.test(r.textContent || ''));
      if (!row) return 'not found';
      row.click();
      return 'clicked';
    })()`);
    await wait(900);
    return got;
  };

  // --- peek, on hover and on focus -----------------------------------------
  const pinBy = (n) => `[...document.querySelectorAll('.review-pin')].find((p) => (p.textContent || '').trim() === '${n}')`;
  await js(`(() => {
    const pin = ${pinBy(tiny.review.number)} || document.querySelector('.review-pin');
    pin?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    pin?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    return true;
  })()`);
  await wait(700);
  await shot('02-peek-hover', 'Passive Peek — hover. Read-only, two lines, pointer-events none');
  await js(`document.querySelector('.review-pin')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))`);
  await wait(400);

  await js(`(() => {
    const pin = ${pinBy(tiny.review.number)} || document.querySelector('.review-pin');
    pin?.focus();
    return true;
  })()`);
  await wait(700);
  await shot('03-peek-focus', 'Peek — keyboard focus. Same context without a pointer');
  await js(`document.activeElement?.blur()`);
  await wait(400);

  // --- the cluster chooser --------------------------------------------------
  await js(`(() => {
    const pin = [...document.querySelectorAll('.review-pin.many')][0];
    pin?.click();
    return !!pin;
  })()`);
  await wait(800);
  await shot('04-cluster-chooser', 'Cluster chooser — which review, never the first by default');
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(400);

  // --- the new-comment composer --------------------------------------------
  // `C` is the documented way in, and it is what the toolbar button does.
  // The frame gets a `commenting` class once the mode is actually on, which
  // is the thing to wait for.
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
  await wait(500);
  let commenting = await js(`!!document.querySelector('.frame-clip.commenting')`);
  if (!commenting) {
    await js(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /\\+\\s*Comment/i.test(b.textContent || ''));
      btn?.click();
      return !!btn;
    })()`);
    await wait(600);
    commenting = await js(`!!document.querySelector('.frame-clip.commenting')`);
  }
  if (!commenting) shout('review-ux-export: comment mode would not start — 05 and 06 will not show it');
  await shot('05-comment-mode', 'Comment mode — click an element to place a comment');
  // Placing the comment goes through the app's real input path.
  //
  // A click dispatched on the <iframe> element reaches the element, not the
  // document inside it — the first version of this captured a picture with no
  // composer in it and called it "the composer". What the preview actually
  // does when somebody clicks in comment mode is post `avb:click-node` to the
  // window, and PreviewPane listens for exactly that, so this posts the same
  // message: the same code path, without a physical mouse.
  const placed = await js(`(() => {
    const frame = document.querySelector('iframe');
    if (!frame) return 'no frame';
    const r = frame.getBoundingClientRect();
    const rect = { x: 60, y: 90, w: 320, h: 44 };
    window.postMessage(
      {
        type: 'avb:click-node',
        path: '0.0',
        occurrence: 0,
        occurrenceCount: 1,
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        rect,
      },
      '*'
    );
    return 'posted';
  })()`);
  if (placed !== 'posted') shout(`review-ux-export: could not place a draft comment (${placed})`);
  await wait(1100);
  // A state that could not be produced is not photographed.
  //
  // Writing the file anyway would put a picture of something else under a name
  // that claims otherwise, which is worse than a gap: somebody reviewing these
  // would take it as evidence. The run says what is missing instead.
  const hasComposer = await js(`!!document.querySelector('.review-composer')`);
  if (!hasComposer) {
    MISSING.push(['06-new-comment-composer', 'the composer did not open from a synthesised canvas click']);
  }
  if (hasComposer) {
    await shot('06-new-comment-composer', 'New-comment composer — anchored, ~316px, the only content entry over the canvas');
  }
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(500);

  // --- the Inspector --------------------------------------------------------
  await pickRow('/too tight/i');
  await shot('07-inspector-short', 'Review Inspector — a one-message thread');

  await pickRow('/spacing on this/i');
  await shot('08-inspector-long-reply', 'Inspector — a long agent reply, top');
  await js(`(() => { const s = document.querySelector('.review-thread-scroll'); if (s) s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2); return true; })()`);
  await shot('09-inspector-half-scrolled', 'Half-scrolled — header and reply box still in place');
  await js(`(() => { const s = document.querySelector('.review-thread-scroll'); if (s) s.scrollTop = s.scrollHeight; return true; })()`);
  await shot('10-inspector-bottom', 'At the bottom — Markdown, code, table, link, mail address');

  await pickRow('/feels crowded/i');
  await shot('11-inspector-ten-messages', 'Ten-message discussion');

  // --- a preserved draft ----------------------------------------------------
  await js(`(() => {
    const t = document.querySelector('.review-reply textarea');
    if (!t) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, 'half written reply that must survive');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(400);
  await pickRow('/too tight/i');
  await pickRow('/feels crowded/i');
  await shot('12-draft-preserved', 'Unsent reply, kept across switching to another review and back');

  // --- widths ---------------------------------------------------------------
  const setWidth = async (w) => {
    await js(`(() => { try { localStorage.setItem('stacki.inspectorWidth', '${w}'); } catch {} return true; })()`);
    // Re-open so the stored width is picked up.
    await backToList();
    await pickRow('/spacing on this/i');
    await wait(500);
  };
  await setWidth(370);
  await shot('13-inspector-370', 'Inspector at its minimum, 370px');
  await setWidth(440);
  await shot('14-inspector-440', 'Inspector at its default, 440px');
  await setWidth(520);
  await shot('15-inspector-520', 'Inspector widened to 520px');
  await setWidth(440);

  // --- states ---------------------------------------------------------------
  await backToList();
  await js(`(() => {
    const all = [...document.querySelectorAll('.comments-filters button')].find((b) => b.textContent.trim() === 'All');
    all?.click();
    return !!all;
  })()`);
  await wait(700);
  await shot('16-index-all-filter', 'Index under All — deferred and resolved discoverable, canvas still clean');

  await pickRow('/Colour was wrong/i');
  await shot('17-resolved-selected', 'Resolved review selected — green pin returns, Reopen and no Defer');
  await backToList();
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(700);
  await shot('18-resolved-deselected', 'Deselected — the resolved marker is gone again');

  await pickRow('/gap under this/i');
  await shot('19-deferred-review', 'Deferred review — grey status, its reason kept');

  // An orphan: cut the element the review was left on out of the page.
  const page = path.join(root, 'src/pages/index.astro');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, before.replace(/<h1[\s\S]*?<\/h1>/, ''), 'utf8');
  await wait(3500);
  await backToList();
  await pickRow('/too tight/i');
  await shot('20-orphaned-review', 'Orphaned review — readable Inspector, nothing to point at');
  fs.writeFileSync(page, before, 'utf8');
  await wait(2500);

  // --- layout ---------------------------------------------------------------
  await backToList();
  await pickRow('/spacing on this/i');
  win.setSize(1728, 1117);
  await wait(1200);
  await shot('21-layout-roomy', 'Roomy — Inspector, canvas and Style panel all usable');
  win.setSize(1312, 848);
  await wait(1200);
  await shot('22-layout-props-collapsed', 'Tighter — Style collapses before the canvas is crushed');
  win.setSize(1024, 665);
  await wait(1200);
  await shot('23-layout-overlay', 'Constrained — the Inspector floats over the canvas, no scrim');
  win.setSize(1512, 982);
  await wait(1200);

  // --- the preview device, while reading ------------------------------------
  const device = async (label) =>
    js(`(() => {
      const b = [...document.querySelectorAll('.preview-toolbar button')].find((x) => /${label}/i.test(x.title || x.textContent || ''));
      b?.click();
      return !!b;
    })()`);
  await device('phone');
  await wait(1500);
  await shot('24-phone-preview', 'Phone preview while reading a review');
  await device('desktop');
  await wait(1500);
  await shot('25-desktop-preview', 'Desktop preview while reading a review');

  // --- the display matrix ---------------------------------------------------
  const MATRIX = [
    ['mbp14-1024x665', 1024, 665],
    ['mbp14-1147x745', 1147, 745],
    ['mbp14-1352x878', 1352, 878],
    ['mbp14-1512x982', 1512, 982],
    ['mbp14-1800x1169', 1800, 1169],
    ['mbp16-1168x755', 1168, 755],
    ['mbp16-1312x848', 1312, 848],
    ['mbp16-1496x967', 1496, 967],
    ['mbp16-1728x1117', 1728, 1117],
    ['mbp16-2056x1329', 2056, 1329],
    ['external-1920x1080', 1920, 1080],
  ];
  for (const [slug, w, h] of MATRIX) {
    win.setSize(w, h);
    // Wait for the layout to stop moving rather than for a fixed time: a
    // resize is the OS, the renderer and React, in that order.
    let last = null;
    for (let i = 0; i < 40; i++) {
      const now = await js(`(() => {
        const p = document.querySelector('.panel.left');
        const c = document.querySelector('.preview-frame-wrap');
        return JSON.stringify({
          w: p ? Math.round(p.getBoundingClientRect().width) : 0,
          c: c ? Math.round(c.getBoundingClientRect().width) : 0,
          vw: innerWidth,
        });
      })()`);
      if (now === last) break;
      last = now;
      await wait(150);
    }
    const g = JSON.parse(last);
    await shot(`matrix-${slug}`, `${w}x${h} — inspector ${g.w}px, canvas ${g.c}px`);
  }
  win.setSize(1512, 982);

  // --- a contact sheet ------------------------------------------------------
  const sheet = `<!doctype html><meta charset="utf-8"><title>Stacki review UX — states</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:28px; background:#111; color:#e8e8e8; font:14px/1.5 -apple-system,system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 24px; color:#888; font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:22px; }
  figure { margin:0; background:#191919; border:1px solid #2a2a2a; border-radius:10px; overflow:hidden; }
  img { display:block; width:100%; height:auto; background:#000; }
  figcaption { padding:9px 11px; font-size:12px; color:#ccc; }
  figcaption b { display:block; color:#fff; font-size:11px; font-family:ui-monospace,monospace; margin-bottom:2px; }
  p.missing { margin:0 0 20px; padding:9px 12px; background:#2a2118; border:1px solid #4a3a1e; border-radius:8px; color:#e0c98a; font-size:12px; }
</style>
<h1>Stacki — Visual Review UX states</h1>
<p class="sub">${SHOTS.length} states, captured from the running app at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.</p>
${MISSING.length ? `<p class="missing"><b>${MISSING.length} state${MISSING.length === 1 ? '' : 's'} not captured:</b> ${MISSING.map(([n, why]) => `${n} — ${why}`).join('; ')}</p>` : ''}
<div class="grid">
${SHOTS.map((s) => `  <figure><img src="${s.name}.png" alt="${s.caption}"><figcaption><b>${s.name}</b>${s.caption}</figcaption></figure>`).join('\n')}
</div>
`;
  fs.writeFileSync(path.join(OUT, 'index.html'), sheet, 'utf8');

  say('');
  say(`review-ux-export: ${SHOTS.length} states in ${OUT}`);
  for (const [name, why] of MISSING) shout(`  NOT CAPTURED  ${name} — ${why}`);
  say(`  open ${path.join(OUT, 'index.html')} to look through them`);
  return teardown(0);
})().catch((err) => {
  shout(`review-ux-export: ${err?.stack || err}`);
  void teardown(1);
});

/**
 * Stop, then leave — and fail if anything could not be stopped.
 *
 * The screenshots are output and stay where they were written; everything else
 * this run created is released, and a failure to release any of it makes the
 * run a failing one however many pictures came out.
 */
async function teardown(code) {
  const problems = [];
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      problems.push(`${what}: ${String(err?.message || err)}`);
    }
  };

  await attempt('stopping the preview', async () => {
    const status = mcp.status();
    if (!status?.running || !status.url || !status.token) return;
    const call = async (args) => {
      const res = await fetch(status.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${status.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project', arguments: args } }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
      try {
        return JSON.parse(line.replace(/^data:\s*/, ''))?.result?.structuredContent || null;
      } catch {
        return null;
      }
    };
    const where = await call({ action: 'dev_status' });
    const previewUrl = where?.url || where?.preview?.url || null;
    await call({ action: 'dev_stop' });
    if (!previewUrl) return;
    const stop = Date.now() + 20000;
    for (;;) {
      try {
        await fetch(previewUrl, { signal: AbortSignal.timeout(1000) });
      } catch {
        return;
      }
      if (Date.now() > stop) throw new Error(`the preview at ${previewUrl} would not stop`);
      await wait(400);
    }
  });

  await attempt('stopping the MCP server', () => mcp.stopMcp());
  await attempt('closing the windows', () => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await attempt(`removing the fixture ${root}`, () => {
    removeCanvasProject(root);
    if (fs.existsSync(root)) throw new Error('still there');
  });
  await attempt(`removing the app data ${userData}`, () => {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (fs.existsSync(userData)) throw new Error('still there');
  });

  if (problems.length) {
    shout(`\nreview-ux-export: ${problems.length} cleanup failure(s) — this is a failing run\n`);
    for (const p of problems) shout(`  ${p}`);
  }
  app.exit(problems.length ? 1 : code);
}
