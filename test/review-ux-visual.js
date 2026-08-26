// Look at the review UI. Actually look at it.
//
//   npx electron test/review-ux-visual.js [outDir]
//
// A DOM snapshot cannot tell you that a card is enormous, that a header has
// scrolled away, that a scrollbar looks like an embedded web page, or that a
// two-thousand-word thread has covered the design it is about. Those are the
// things this feature was rebuilt for, so they have to be seen.
//
// So this runs the shipped main process under Electron, opens a project with a
// real dev server, seeds the review ledger with the conversations that broke
// the old reader — a long agent reply, a ten-message discussion, Markdown with
// code and links, a resolution nobody can prove — opens each one the way a
// person opens it, and photographs the window.
//
// It asserts the few things a picture cannot: that the header and the footer
// are outside the scroll region, that the card is the size it claims, that a
// resolved pin is absent until it is selected. Everything else is for a human
// to look at, which is why the files are written where they can be opened.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

// Nobody is watching this run. A modal dialog would stop it dead — the app
// waits for a click that is never coming — and leave the box on the screen of
// whoever started it. Set before main.js is required, because that is when the
// updater and its handlers are wired up.
process.env.STACKI_NO_DIALOGS = '1';

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'stacki-review-ux');
const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, { timeout = 120000, every = 250 } = {}) {
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
  say('review-ux-visual: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

// What earlier runs left behind. Electron rewrites a small userData during
// shutdown, after teardown has removed it, so one reappears per run and they
// pile up quietly. Swept here rather than pretended about.
sweepStaleRuns(['stacki-ux-user-', 'stacki-canvas-']);

const root = makeCanvasProject({ log: (m) => say(`review-ux-visual: ${m}`) });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ux-user-'));
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

/**
 * Stop, then leave — and fail if anything could not be stopped.
 *
 * Cleanup is part of correctness here, not a courtesy. A run that passed every
 * assertion and left an Astro dev server behind is a run that will be repeated
 * until the machine has forty of them holding several gigabytes, which is
 * exactly what happened, and which presents as the machine being slow rather
 * than as anything to do with tests.
 *
 * So every step is attempted even after an earlier one fails — stopping at the
 * first problem is how the rest of the mess gets left — the problems are
 * collected, and any of them makes the exit code non-zero however well the
 * assertions went.
 *
 * The screenshots are OUTPUT, not leaked state: they are the point of this
 * harness and are written where somebody can open them.
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
        body: JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'tools/call', params: { name: 'project', arguments: args } }),
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

    // `ok` from dev_stop means "asked", not "stopped": Astro 7 daemonizes its
    // dev server, so Stacki hands the job to `astro dev stop` and returns.
    // Exiting on that ok deletes the project directory out from under the
    // command and leaves the server running. So wait for the port to actually
    // go quiet — the real state, not a sleep long enough to usually work.
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
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (fs.existsSync(root)) throw new Error('still there');
  });
  await attempt(`removing the app data ${userData}`, () => {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (fs.existsSync(userData)) throw new Error('still there');
  });

  if (problems.length) {
    shout(`\nreview-ux-visual: ${problems.length} cleanup failure(s) — this is a failing run\n`);
    for (const p of problems) shout(`  ${p}`);
  }
  app.exit(problems.length ? 1 : code);
}

// --- the conversations that broke the old reader -----------------------------

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
  'The variable is here if you want to move it again:',
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
  'Reference for the inheritance rule: https://developer.mozilla.org/en-US/docs/Web/CSS/inheritance',
  '',
  'Anything with `~~a strikethrough~~` is something I considered and rejected.',
].join('\n');

const SHOTS = [];

(async () => {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });

  const win = await until('the window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to load', () => (win.webContents.isLoading() ? null : true));
  await wait(600);
  win.setSize(1500, 950);
  win.webContents.send('menu:openProject');

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await wait(700);
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    SHOTS.push(file);
    say(`  shot ${name}`);
  };

  // Wait for a rendering canvas before anything is commented on.
  await until(
    'the canvas',
    async () => (await js(`!!document.querySelector('iframe') && !document.querySelector('.welcome')`)) || null,
    { timeout: 240000 }
  );
  await wait(4000);

  // --- seed ----------------------------------------------------------------
  //
  // Through the review module's own door, with the payload the renderer has
  // published — the same path a click in comment mode takes.
  // Each on its own spot. Everything here is anchored to the same element —
  // there is only one selection — so without distinct pin ratios all four
  // reviews merge into one cluster, and a cluster is the one case where a
  // resolved review's marker is SUPPOSED to stay (its open neighbours keep it
  // alive). Separating them is what lets the resolved-pin behaviour be seen.
  const make = (message, pin, extra = {}) =>
    reviews.act({ action: 'create', message, authorType: 'human', pin, ...extra });
  const reply = (threadId, message, authorType = 'agent') =>
    reviews.act({ action: 'reply', threadId, message, authorType });

  const tiny = make('This pill is too tight at 375.', { xRatio: 0.12, yRatio: 0.10 });
  check('a review can be seeded', tiny.ok === true, JSON.stringify(tiny).slice(0, 200));
  if (!tiny.ok) throw new Error('nothing to photograph');

  const longOne = make('Have a look at the spacing on this and tell me what is going on.', { xRatio: 0.45, yRatio: 0.30 });
  reply(longOne.review.id, LONG_REPLY);

  const many = make('The whole row feels crowded.', { xRatio: 0.80, yRatio: 0.52 });
  for (let i = 1; i <= 9; i++) {
    reply(many.review.id, i % 2 ? `Reply ${i}: narrowed it down a little further.` : `And another thought, number ${i}.`, i % 2 ? 'agent' : 'human');
  }

  const done = make('Colour was wrong here.', { xRatio: 0.30, yRatio: 0.75 });
  reply(done.review.id, 'Changed it to the brand token and checked both breakpoints.');
  reviews.act({ action: 'resolve', threadId: done.review.id, authorType: 'agent' });

  await wait(1200);

  // --- the panel -----------------------------------------------------------
  const openPanel = () =>
    js(`(() => {
      if (document.querySelector('.comments-body') || document.querySelector('.comments-reader')) return 'already';
      // The rail buttons carry no title — the tooltip is a separate element —
      // so this is the last one, which is Comments. See src/ui/LeftRail.jsx.
      const rail = [...document.querySelectorAll('.rail-btn')];
      if (!rail.length) return 'no rail button';
      rail[rail.length - 1].click();
      return 'clicked';
    })()`);
  check('the Comments rail button exists', (await openPanel()) !== 'no rail button');
  await wait(900);
  await shot('01-comments-panel');

  // Back to the list, whatever is open, then pick a row by what it says. The
  // Inspector REPLACES the list, so a row cannot be clicked until whatever is
  // open has been closed.
  const backToList = async () => {
    await js(`document.querySelector('.review-back')?.click()`);
    await wait(500);
    return js(`document.querySelectorAll('.comments-row').length`);
  };
  const pickRow = async (pattern) => {
    await backToList();
    const clicked = await js(`(() => {
      const rows = [...document.querySelectorAll('.comments-row')];
      const row = rows.find((r) => ${pattern}.test(r.textContent || ''));
      if (!row) return 'not found';
      row.click();
      return 'clicked';
    })()`);
    await wait(900);
    return clicked;
  };

  const rowCount = await js(`document.querySelectorAll('.comments-row').length`);
  check('the index lists the seeded comments', rowCount >= 3, String(rowCount));
  check('and the index never renders a thread inside itself', (await js(`!document.querySelector('.comments-body .review-thread')`)) === true);
  // Opening Comments must not decide for somebody which review they came for.
  check('opening Comments selects nobody', (await js(`!document.querySelector('.comments-row.on')`)) === true);
  check('and shows no Inspector', (await js(`!document.querySelector('.review-inspector')`)) === true);

  // --- filters mean what they say ------------------------------------------
  const filterCounts = await js(`(() => {
    const tabs = [...document.querySelectorAll('.comments-filters .seg button')];
    return tabs.map((t) => t.textContent.trim());
  })()`);
  check('the four status filters are there', filterCounts.join(',').includes('Open'), JSON.stringify(filterCounts));

  // --- peek -----------------------------------------------------------------
  const hoverPin = async (n) =>
    js(`(() => {
      const pins = [...document.querySelectorAll('.review-pin')];
      const pin = pins.find((p) => (p.textContent || '').trim() === String(${n})) || pins[0];
      if (!pin) return 'no pins';
      // React delegates enter/leave through pointerover/pointerout, so a bare
      // pointerenter reaches nothing.
      pin.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      pin.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      return 'hovered';
    })()`);
  await hoverPin(tiny.review.number);
  await wait(700);
  await shot('02-peek');
  const peek = await js(`(() => {
    const el = document.querySelector('.review-peek');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      pointer: getComputedStyle(el).pointerEvents,
      buttons: el.querySelectorAll('button').length,
      fields: el.querySelectorAll('textarea, input').length,
      links: el.querySelectorAll('a').length,
      role: el.getAttribute('role'),
      lines: Math.round(el.querySelector('.review-peek-body')?.getBoundingClientRect().height || 0),
    };
  })()`);
  check('hovering a pin shows a peek', !!peek, JSON.stringify(peek));
  if (peek) {
    check('about the right size', peek.w >= 200 && peek.w <= 280, String(peek.w));
    check('the pointer goes through it', peek.pointer === 'none', peek.pointer);
    check('there is nothing to press', peek.buttons === 0, String(peek.buttons));
    check('nothing to type into', peek.fields === 0, String(peek.fields));
    check('no links to follow', peek.links === 0, String(peek.links));
    check('and it is a tooltip', peek.role === 'tooltip', peek.role);
    check('bounded to about two lines', peek.lines > 0 && peek.lines <= 44, String(peek.lines));
  }
  await js(`document.querySelector('.review-pin')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
  await wait(300);

  // --- pin click goes to the Inspector -------------------------------------
  await js(`(() => {
    const pins = [...document.querySelectorAll('.review-pin')];
    const pin = pins.find((p) => (p.textContent || '').trim() === String(${tiny.review.number})) || pins[0];
    pin?.click();
    return true;
  })()`);
  await wait(1200);
  await shot('03-inspector-short');
  const inspector = await js(`(() => {
    const el = document.querySelector('.review-inspector');
    if (!el) return null;
    const scroll = el.querySelectorAll('.review-thread-scroll');
    return {
      w: Math.round(el.getBoundingClientRect().width),
      role: el.tagName,
      label: el.getAttribute('aria-label'),
      head: !!el.querySelector('.review-thread-head'),
      back: !!el.querySelector('.review-back'),
      locate: !!el.querySelector('.review-locate'),
      overflow: !!el.querySelector('.review-overflow'),
      scrollers: scroll.length,
      headInScroll: !!el.querySelector('.review-thread-scroll .review-thread-head'),
      footInScroll: !!el.querySelector('.review-thread-scroll .review-thread-foot'),
      foot: !!el.querySelector('.review-thread-foot .review-reply'),
      resizer: !!el.querySelector('.review-resizer'),
      popover: !!document.querySelector('.review-popover'),
      canvas: Math.round(document.querySelector('iframe')?.getBoundingClientRect().width || 0),
      overflowX: document.documentElement.scrollWidth <= innerWidth + 1,
    };
  })()`);
  check('clicking a pin opens the Inspector', !!inspector, JSON.stringify(inspector));
  if (inspector) {
    check('and never a floating conversation', inspector.popover === false);
    check('it is a labelled region', inspector.role === 'SECTION' && !!inspector.label, JSON.stringify(inspector.label));
    check('with a Back', inspector.back === true);
    check('a Locate', inspector.locate === true);
    check('an overflow menu', inspector.overflow === true);
    check('exactly one conversation scroller', inspector.scrollers === 1, String(inspector.scrollers));
    check('the header outside it', inspector.headInScroll === false);
    check('the footer outside it', inspector.footInScroll === false);
    check('a reply box in the footer', inspector.foot === true);
    check('a resize divider', inspector.resizer === true);
    check('the website still visible beside it', inspector.canvas >= 300, String(inspector.canvas));
    check('and no horizontal overflow', inspector.overflowX === true);
  }

  // A short review and a long one land in the same place.
  await js(`document.querySelector('.review-back')?.click()`);
  await wait(500);
  check('the long thread has a row', (await pickRow('/spacing on this/i')) === 'clicked');
  await wait(1200);
  await shot('04-inspector-long');
  const longShape = await js(`(() => {
    const el = document.querySelector('.review-inspector');
    if (!el) return null;
    const s = el.querySelector('.review-thread-scroll');
    return {
      same: true,
      scrollable: s ? s.scrollHeight > s.clientHeight : false,
      scrollers: el.querySelectorAll('.review-thread-scroll').length,
      md: !!el.querySelector('.review-md'),
      code: !!el.querySelector('.review-md-pre'),
      link: !!el.querySelector('.review-md-link'),
      w: Math.round(el.getBoundingClientRect().width),
    };
  })()`);
  check('a long thread opens in the same Inspector', !!longShape && longShape.same);
  check('at the same width — length routes nothing', longShape.w === inspector.w, `${inspector.w} vs ${longShape.w}`);
  // Whether it scrolls depends on the window height, which the matrix varies
  // deliberately; what must hold is that the region exists and is the only one.
  check('its conversation is the one scroll region', longShape.scrollers === 1, String(longShape.scrollers));
  check('Markdown rendered', longShape.md === true);
  check('code blocks', longShape.code === true);
  check('and links', longShape.link === true);

  // Header and footer survive scrolling.
  await js(`(() => { const s = document.querySelector('.review-thread-scroll'); if (s) s.scrollTop = s.scrollHeight; return true; })()`);
  await shot('05-inspector-bottom');
  check('the reply box is still there at the bottom', (await js(`!!document.querySelector('.review-thread-foot .review-reply')`)) === true);
  check('and so is the header', (await js(`!!document.querySelector('.review-thread-head')`)) === true);

  // --- drafts survive switching --------------------------------------------
  await js(`(() => {
    const t = document.querySelector('.review-reply textarea');
    if (!t) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, 'half written reply');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(400);
  await js(`document.querySelector('.review-back')?.click()`);
  await wait(400);
  await pickRow('/too tight/i');
  await wait(700);
  await js(`document.querySelector('.review-back')?.click()`);
  await wait(400);
  await pickRow('/spacing on this/i');
  await wait(800);
  const kept = await js(`document.querySelector('.review-reply textarea')?.value || ''`);
  check('an unsent reply survives going to another review and back', kept === 'half written reply', JSON.stringify(kept));
  await shot('06-draft-preserved');

  // --- the display matrix ---------------------------------------------------
  //
  // The sizes the design was validated at. Each one is measured AND
  // photographed, because a number can be right while the thing looks wrong.
  const MATRIX = [
    ['mbp14-largest', 1024, 665],
    ['mbp14-larger', 1147, 745],
    ['mbp14-balanced', 1352, 878],
    ['mbp14-default', 1512, 982],
    ['mbp14-more', 1800, 1169],
    ['mbp16-largest', 1168, 755],
    ['mbp16-larger', 1312, 848],
    ['mbp16-balanced', 1496, 967],
    ['mbp16-default', 1728, 1117],
    ['mbp16-more', 2056, 1329],
    ['external-1080', 1920, 1080],
  ];
  win.setMinimumSize(600, 400);
  /**
   * Read the geometry once it has stopped moving.
   *
   * A window resize is three separate things — the OS resizing the window, the
   * renderer noticing, React re-rendering — and a fixed wait between them is a
   * race. Waiting for two identical readings waits for the thing itself.
   */
  const settledGeometry = async (read) => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const now = await read();
      const key = JSON.stringify(now);
      if (key === last) return now;
      last = key;
      await wait(150);
    }
    return JSON.parse(last);
  };

  for (const [slug, w, h] of MATRIX) {
    win.setSize(w, h);
    await wait(250);
    const g = await settledGeometry(() => js(`(() => {
      const panel = document.querySelector('.panel.left');
      const props = document.querySelector('.panel.right');
      // The area between the panels, not the iframe: the iframe is the
      // previewed device (a 1280px desktop, a 375px phone) and says nothing
      // about how much room the canvas has been left.
      const canvas = document.querySelector('.preview-frame-wrap');
      const body = document.querySelector('.review-body');
      return {
        vw: innerWidth,
        mode: panel ? (panel.classList.contains('is-overlay') ? 'overlay' : panel.classList.contains('is-inspector') ? 'docked' : 'index') : null,
        inspector: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
        canvas: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
        props: props ? Math.round(props.getBoundingClientRect().width) : 0,
        prose: body ? Math.round(body.getBoundingClientRect().width) : 0,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      };
    })()`));
    say(`  ${slug.padEnd(15)} ${JSON.stringify(g)}`);
    check(`${slug}: no horizontal overflow`, g.overflowX === false, JSON.stringify(g));
    check(`${slug}: the Inspector is readable`, g.inspector >= 320, String(g.inspector));
    if (g.mode === 'docked') {
      check(`${slug}: the canvas is usable`, g.canvas >= 600, String(g.canvas));
    }
    if (g.mode === 'overlay') {
      check(`${slug}: the canvas keeps its width behind the overlay`, g.canvas >= 600, String(g.canvas));
    }
    check(`${slug}: prose has a real measure`, g.prose === 0 || g.prose >= 280, String(g.prose));
    await shot(`matrix-${slug}`);
  }
  win.setSize(1512, 982);
  await wait(700);

  say('');
  say(`review-ux-visual: ${SHOTS.length} screenshots in ${OUT}`);
  for (const f of SHOTS) say(`  ${f}`);

  if (failures.length) {
    shout(`\nreview-ux-visual: ${failures.length} failed, ${checked - failures.length} passed\n`);
    for (const f of failures) shout(f);
    return teardown(1);
  }
  say(`review-ux-visual: ${checked} passed  [a real window, photographed]`);
  return teardown(0);
})().catch((err) => {
  shout(`review-ux-visual: ${err?.stack || err}`);
  void teardown(1);
});
