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

const { makeCanvasProject, removeCanvasProject, astroCached } = require('./agent-canvas-fixture.js');
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
 * Stop, then leave.
 *
 * `app.exit()` skips before-quit, so the Astro dev server this run started
 * outlives it — one orphaned server per run, holding its port and its memory,
 * until somebody notices there are forty of them. It is stopped through the
 * app's own door first.
 */
async function teardown(code) {
  try {
    const status = mcp.status();
    if (status?.running && status.url && status.token) {
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
      // Exiting here would delete the project directory out from under that
      // command and leave the server running for as long as the machine is up.
      // So wait for the port to actually go quiet — the real state, not a sleep.
      if (previewUrl) {
        const stop = Date.now() + 20000;
        for (;;) {
          try {
            await fetch(previewUrl, { signal: AbortSignal.timeout(1000) });
          } catch {
            break;
          }
          if (Date.now() > stop) {
            shout(`review-ux-visual: the preview at ${previewUrl} would not stop`);
            break;
          }
          await wait(400);
        }
      }
    }
  } catch (err) {
    shout(`review-ux-visual: could not stop the preview: ${String(err?.message || err).slice(0, 120)}`);
  }
  removeCanvasProject(root);
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* a temp folder that will not go is not a failure */
  }
  app.exit(code);
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

  const rowCount = await js(`document.querySelectorAll('.comments-row').length`);
  check('the panel lists the seeded comments', rowCount >= 3, String(rowCount));

  // --- a short thread on the canvas ---------------------------------------
  const openPin = async (n) =>
    js(`(() => {
      const pins = [...document.querySelectorAll('.review-pin')];
      const pin = pins.find((p) => (p.textContent || '').trim().startsWith('${n}')) || pins[0];
      if (!pin) return 'no pins';
      pin.click();
      return 'clicked';
    })()`);

  await openPin(tiny.review.number);
  await wait(800);
  await shot('02-compact-short');

  const compact = await js(`(() => {
    const el = document.querySelector('.review-popover');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const scroll = el.querySelectorAll('.review-thread-scroll').length;
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      shellOverflow: getComputedStyle(el).overflowY,
      scrollRegions: scroll,
      headInScroll: !!el.querySelector('.review-thread-scroll .review-thread-head'),
      footInScroll: !!el.querySelector('.review-thread-scroll .review-thread-foot'),
      grip: !!el.querySelector('.review-grip'),
    };
  })()`);
  check('the compact card opened', !!compact, JSON.stringify(compact));
  if (compact) {
    check('it is the width it claims', compact.w >= 330 && compact.w <= 370, String(compact.w));
    check('a short thread stays short', compact.h < 400, String(compact.h));
    check('the shell itself does not scroll', compact.shellOverflow === 'hidden', compact.shellOverflow);
    check('there is exactly one scroll region', compact.scrollRegions === 1, String(compact.scrollRegions));
    check('the header is not inside it', compact.headInScroll === false);
    check('the footer is not inside it', compact.footInScroll === false);
    check('and the header shows a grip', compact.grip === true);
  }

  // --- a very long agent reply --------------------------------------------
  await js(`document.querySelector('.review-popover .review-x:last-of-type')?.click()`);
  await wait(500);
  // Back to the list, whatever is currently open.
  //
  // A thread showing in the panel REPLACES the list, so a row cannot be
  // clicked until whatever is open has been closed — and the close button in
  // the panel header matches the same selector as the one in the popover, so
  // "click .review-x" was closing the wrong thing.
  const backToList = async () => {
    await js(`(() => {
      document.querySelector('.comments-reader .comments-back')?.click();
      document.querySelector('.comments-open .review-x:last-of-type')?.click();
      return true;
    })()`);
    await wait(500);
    return js(`document.querySelectorAll('.comments-row').length`);
  };
  const pickRow = async (pattern) => {
    await backToList();
    return js(`(() => {
      const rows = [...document.querySelectorAll('.comments-row')];
      const row = rows.find((r) => ${pattern}.test(r.textContent || ''));
      if (!row) return 'not found';
      row.click();
      return 'clicked';
    })()`);
  };

  const rowTexts = await js(`[...document.querySelectorAll('.comments-row')].map((r) => (r.textContent || '').slice(0, 60))`);
  say(`  rows: ${JSON.stringify(rowTexts)}`);
  const clicked = await pickRow('/spacing on this/i');
  check('the long thread has a row to click', clicked === 'clicked', String(clicked));
  await wait(1400);
  const openedWhat = await js(`(() => {
    const el = document.querySelector('.comments-reader') || document.querySelector('.comments-open');
    if (!el) return 'nothing open';
    return {
      where: el.className,
      number: el.querySelector('.review-number')?.textContent,
      messages: el.querySelectorAll('.review-msg').length,
      hasMd: !!el.querySelector('.review-md'),
      pre: el.querySelectorAll('.review-md-pre').length,
      links: el.querySelectorAll('.review-md-link').length,
    };
  })()`);
  say(`  opened: ${JSON.stringify(openedWhat)}`);
  await shot('03-long-thread-docked');

  const docked = await js(`(() => {
    const el = document.querySelector('.comments-reader');
    if (!el) return null;
    const scroll = el.querySelector('.review-thread-scroll');
    return {
      docked: true,
      back: !!el.querySelector('.comments-back'),
      scrollable: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
      canvasVisible: !!document.querySelector('iframe'),
      popover: !!document.querySelector('.review-popover'),
      md: !!el.querySelector('.review-md'),
      code: !!el.querySelector('.review-md-pre'),
      link: !!el.querySelector('.review-md-link'),
      list: !!el.querySelector('.review-md ul'),
      quote: !!el.querySelector('.review-md blockquote'),
    };
  })()`);
  check('a long thread opens docked in the panel', !!docked && docked.docked, JSON.stringify(docked));
  if (docked) {
    check('with a way back to the list', docked.back === true);
    check('its body scrolls', docked.scrollable === true);
    check('the website is still visible beside it', docked.canvasVisible === true);
    check('and no card is covering the design', docked.popover === false);
    check('markdown rendered', docked.md === true);
    check('the fenced block became a code block', docked.code === true);
    check('the url became a link', docked.link === true);
    check('the list became a list', docked.list === true);
    check('and the quote a blockquote', docked.quote === true);
  }

  // Scrolled halfway, and at the bottom: the header and reply box must still
  // be there in both.
  await js(`(() => {
    const s = document.querySelector('.comments-reader .review-thread-scroll');
    if (s) s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2);
    return true;
  })()`);
  await shot('04-long-thread-half-scrolled');
  const half = await js(`(() => {
    const el = document.querySelector('.comments-reader');
    if (!el) return null;
    const head = el.querySelector('.review-thread-head').getBoundingClientRect();
    const foot = el.querySelector('.review-thread-foot').getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { headVisible: head.top >= box.top - 1 && head.bottom <= box.bottom + 1, footVisible: foot.bottom <= box.bottom + 1 && foot.top >= box.top };
  })()`);
  check('the header is still on screen halfway down', half?.headVisible === true, JSON.stringify(half));
  check('and so is the reply box', half?.footVisible === true, JSON.stringify(half));

  await js(`(() => {
    const s = document.querySelector('.comments-reader .review-thread-scroll');
    if (s) s.scrollTop = s.scrollHeight;
    return true;
  })()`);
  await shot('05-long-thread-bottom');
  const bottom = await js(`!!document.querySelector('.comments-reader .review-thread-foot .review-reply')`);
  check('the reply box is reachable at the bottom too', bottom === true);

  // --- a ten-message discussion -------------------------------------------
  check('the ten-message thread has a row', (await pickRow('/feels crowded/i')) === 'clicked');
  await wait(1000);
  await shot('06-ten-messages');

  // --- resolved: absent from the canvas until selected --------------------
  await backToList();
  await js(`(() => {
    const tabs = [...document.querySelectorAll('.comments-filters button')];
    const all = tabs.find((t) => t.textContent.trim() === 'All');
    if (all) all.click();
    return !!all;
  })()`);
  await wait(900);
  const pinsWhenAll = await js(`document.querySelectorAll('.review-pin').length`);
  await shot('07-resolved-deselected');

  check('the resolved thread has a row under All', (await pickRow('/Colour was wrong/i')) === 'clicked');
  await wait(1400);
  const pinsWhenSelected = await js(`document.querySelectorAll('.review-pin').length`);
  await shot('08-resolved-selected');
  check(
    'selecting a resolved comment brings its marker back',
    pinsWhenSelected > pinsWhenAll,
    `${pinsWhenAll} deselected -> ${pinsWhenSelected} selected`
  );

  // --- a narrow window -----------------------------------------------------
  win.setSize(900, 700);
  await wait(1200);
  await shot('09-narrow-window');
  const narrow = await js(`(() => {
    const el = document.querySelector('.review-popover') || document.querySelector('.comments-reader');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width), vw: innerWidth, vh: innerHeight };
  })()`);
  check('the reader is still fully on screen in a small window', !!narrow && narrow.left >= -1 && narrow.right <= narrow.vw + 1 && narrow.top >= -1, JSON.stringify(narrow));

  win.setSize(1600, 1000);
  await wait(900);
  await shot('10-wide-window');

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
