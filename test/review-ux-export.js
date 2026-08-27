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
// Drive a real window without taking the screen. See electron/main.js: the
// window is created but never shown, which captures the same pixels and puts
// nothing in front of whatever the person running this is actually doing.
process.env.STACKI_HIDDEN_WINDOW = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');
const { readDevLock, awaitDevServerGone } = require('./support/devServer.js');
const { createState } = require('./support/assertedState.js');
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

/**
 * The same wait, for a condition whose absence is a finding rather than a
 * crash — null instead of a throw, so the caller can record what did not
 * happen and carry on capturing the rest.
 */
until.soft = async (what, timeout, fn, every = 400) => {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) {
      shout(`  timed out waiting for ${what}`);
      return null;
    }
    await wait(every);
  }
};

app.on('window-all-closed', () => {});

if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  say('review-ux-export: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

// What DEAD runs left behind. Electron rewrites a small userData during
// shutdown, after teardown has removed it, so one reappears per run and they
// pile up quietly.
//
// Only dead ones. Every temp root a harness makes carries a marker naming the
// run and the pid that owns it, and this walks past anything it cannot prove is
// finished — see test/support/ownedTemp.js. It used to delete by name prefix
// alone, which meant a second harness starting up could take the Astro fixture
// out from under a run already using it. `stacki-canvas-` is the prefix all of
// them use.
const sweptRuns = sweepStaleRuns(['stacki-export-user-', 'stacki-canvas-']);
for (const s of sweptRuns.swept) say(`review-ux-export: swept ${s.name} (dead ${s.harness} pid ${s.pid})`);
const root = makeCanvasProject({ harness: 'review-ux-export', log: (m) => say(`review-ux-export: ${m}`) });
const userData = ownedTempDir('stacki-export-user-', { harness: 'review-ux-export' });
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

// The comment placed by a REAL CLICK on a real element — and, once posted, the
// only seeded review with a source anchor narrow enough to cut out of the page
// without taking the page with it. Its wording is deliberately unlike every
// other seeded message, because rows are found here by matching their text.
const ORPHAN_MESSAGE = 'This heading needs more room above it.';

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
// Claims this run made about what a picture shows, that did not hold.
//
// A screenshot is evidence only if something checked that the app was in the
// state the caption names. "Orphaned review" over a picture of an attached one
// is worse than no picture: it is a false pass with an image attached. Every
// entry here makes the run exit non-zero.
const FAILED = [];
const must = (claim, ok, detail) => {
  if (ok) return true;
  FAILED.push(detail ? `${claim} — ${detail}` : claim);
  shout(`  FAILED  ${claim}${detail ? ` — ${detail}` : ''}`);
  return false;
};

// ── which states this package is REQUIRED to contain ────────────────────────
//
// "Required" used to mean nothing at all. A state that could not be produced
// went onto MISSING, got a line on the contact sheet, and the run exited 0 — so
// a package of review UX states with no picture of the composer in it passed.
// And a state that WAS captured was never checked against its own caption, so
// eleven pictures of the ~260px Comments Index went out labelled
// `inspector 260px`. Both of those happened.
//
// So there is one way to capture anything now — `state()` — and it will not
// photograph a window that is not in the state the caption names. Anything on
// this list that is missing at the end, for any reason, fails the run.
const REQUIRED = [
  '01-comments-index',
  '02-peek-hover',
  '03-peek-focus',
  '04-cluster-chooser',
  '05-comment-mode',
  '06-new-comment-composer',
  '07-inspector-short',
  '08-inspector-long-reply',
  '09-inspector-half-scrolled',
  '10-inspector-bottom',
  '11-inspector-ten-messages',
  '12-draft-preserved',
  '13-inspector-360',
  '14-inspector-440',
  '15-inspector-520',
  '16-index-all-filter',
  '17-resolved-selected',
  '18-resolved-deselected',
  '19-deferred-review',
  '20-orphaned-review',
  '21-layout-roomy',
  '22-layout-props-collapsed',
  '23-layout-overlay',
  '24-phone-preview',
  '25-desktop-preview',
  '26-inspector-overflow',
  '27-defer-form',
  // The display matrix. Eleven sizes, each of which has to be a picture of the
  // Review Inspector — see the matrix block below for what went out instead.
  'matrix-mbp14-1024x665',
  'matrix-mbp14-1147x745',
  'matrix-mbp14-1352x878',
  'matrix-mbp14-1512x982',
  'matrix-mbp14-1800x1169',
  'matrix-mbp16-1168x755',
  'matrix-mbp16-1312x848',
  'matrix-mbp16-1496x967',
  'matrix-mbp16-1728x1117',
  'matrix-mbp16-2056x1329',
  'matrix-external-1920x1080',
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await app.whenReady();
  // No Dock icon and no app-switcher entry either — the window is invisible,
  // and a bouncing icon for something nobody can see is the same interruption
  // in a smaller shape.
  if (process.platform === 'darwin') app.dock?.hide();

  const win = await until('the window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to load', () => (win.webContents.isLoading() ? null : true));
  await wait(600);
  win.setMinimumSize(600, 400);
  win.setSize(1512, 982);
  // The window is never shown — see STACKI_HIDDEN_WINDOW above — and a window
  // that has never been shown has a document that does not have focus. Chromium
  // still lets element.focus() set document.activeElement in that state, and
  // still does not DISPATCH the focus event, so React's onFocus never runs.
  //
  // That is what `03-peek-focus` was a picture of: a pin that was
  // document.activeElement, a Peek that had never been asked for, and a caption
  // saying the Peek was there. Production was right the whole time; the harness
  // was asking the question in a window where the answer could not arrive.
  //
  // webContents.focus() gives the document focus without showing the window and
  // without taking the screen — checked: the frontmost application does not
  // change. Every state below is now captured under the focus conditions a real
  // window has, which is also the more truthful place to photograph from.
  win.webContents.focus();
  win.webContents.send('menu:openProject');

  const js = (code) => win.webContents.executeJavaScript(code, true);

  /**
   * What the app is, as far as any of these captions are concerned.
   *
   * One reader, so a claim and a caption cannot disagree about which element
   * they mean. Everything here is measured from the live DOM at the moment it
   * is asked — no remembered state, and nothing derived from what the harness
   * believes it did.
   */
  const look = () => js(`(() => {
    const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
    const panel = document.querySelector('.panel.left');
    const props = document.querySelector('.panel.right');
    const canvas = document.querySelector('.preview-frame-wrap');
    const inspector = document.querySelector('.review-inspector');
    const peek = document.querySelector('.review-peek');
    const cluster = document.querySelector('.review-cluster');
    const active = document.activeElement;
    return {
      vw: innerWidth,
      vh: innerHeight,
      // What the LEFT PANEL is presenting. 'index' is the Comments Index, which
      // is a different panel from the Inspector and about 260px narrower.
      mode: panel ? (panel.classList.contains('is-overlay') ? 'overlay' : panel.classList.contains('is-inspector') ? 'docked' : 'index') : null,
      panelW: width(panel),
      // The Inspector's own box, not the panel that may or may not be holding
      // one. A width is only an Inspector width if there is an Inspector.
      inspector: !!inspector,
      inspectorW: width(inspector),
      canvasW: width(canvas),
      propsW: width(props),
      propsVisible: !!props && width(props) > 0,
      indexRows: document.querySelectorAll('.comments-row').length,
      selectedRows: document.querySelectorAll('.comments-row.on').length,
      filters: [...document.querySelectorAll('.comments-filters button')].map((b) => ({ t: b.textContent.trim(), on: b.className.includes('on') || b.getAttribute('aria-pressed') === 'true' })),
      thread: !!document.querySelector('.review-thread'),
      messages: document.querySelectorAll('.review-msg').length,
      dot: document.querySelector('.review-thread .review-dot')?.className || '',
      orphanNote: !!document.querySelector('.review-orphan'),
      locate: !!document.querySelector('.review-locate'),
      sourcePath: document.querySelector('.review-source-path')?.textContent?.trim() || '',
      where: document.querySelector('.review-where')?.textContent?.trim() || '',
      // What an orphan says it WAS about: the tag, and the words that were in
      // it, frozen at the moment somebody wrote the comment. On an orphan this
      // is the only description of the target there is.
      target: document.querySelector('.review-target')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      verbs: [...document.querySelectorAll('.review-actions button')].map((b) => b.textContent.trim()),
      scroll: (() => { const s = document.querySelector('.review-thread-scroll'); return s ? { top: Math.round(s.scrollTop), max: Math.round(s.scrollHeight - s.clientHeight) } : null; })(),
      draft: document.querySelector('.review-reply textarea')?.value || '',
      pins: [...document.querySelectorAll('.review-pin')].map((el) => ({
        ids: (el.getAttribute('data-review-ids') || '').split(' ').filter(Boolean),
        cls: el.className,
        n: (el.textContent || '').trim(),
      })),
      peek: peek
        ? {
            cluster: peek.classList.contains('is-cluster'),
            w: Math.round(peek.getBoundingClientRect().width),
            h: Math.round(peek.getBoundingClientRect().height),
            pointerEvents: getComputedStyle(peek).pointerEvents,
            ariaHidden: peek.getAttribute('aria-hidden'),
            text: (peek.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          }
        : null,
      cluster: cluster ? { rows: cluster.querySelectorAll('.review-cluster-row').length, textarea: !!cluster.querySelector('textarea'), role: cluster.getAttribute('role') } : null,
      composer: !!document.querySelector('.review-composer'),
      composerText: document.querySelector('.review-composer textarea')?.value || '',
      draftAnchor: !!document.querySelector('.review-draft-anchor'),
      commenting: !!document.querySelector('.frame-clip.commenting'),
      menu: [...document.querySelectorAll('.review-menu [role="menuitem"]')].map((b) => b.textContent.trim()),
      deferForm: (() => { const f = document.querySelector('.review-defer'); return f ? { fields: f.querySelectorAll('textarea, input').length, buttons: [...f.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })(),
      active: active ? { cls: String(active.className || ''), label: active.getAttribute('aria-label') || '', tag: active.tagName } : null,
      frameW: width(document.querySelector('iframe')),
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);

  /**
   * Set the state up, assert it IS that state, and only then photograph it.
   *
   * The discipline lives in test/support/assertedState.js so it can be proved
   * without a window — see test/asserted-state.js. What matters here is the
   * fourth argument: a state that supplies a `read` gets one capture-time
   * object, shared by its claims and its caption, so the words under a picture
   * and the pixels in it are about the same moment.
   */
  const state = createState({
    settle: () => wait(650),
    capture: async (name) => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
    },
    onCaptured: (shot) => {
      SHOTS.push(shot);
      say(`  ${shot.name}`);
    },
    onFailed: (name, what, detail) => {
      FAILED.push(`${name}: ${what}${detail ? ` — ${detail}` : ''}`);
      shout(`  FAILED  ${name}: ${what}${detail ? ` — ${detail}` : ''}`);
    },
  });

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
  await state('01-comments-index', 'Comments index — rows only, nothing selected', async () => {
    const s = await look();
    return [
      ['the left panel is the Comments Index', s.mode === 'index', JSON.stringify({ mode: s.mode, panelW: s.panelW })],
      ['and not an Inspector', s.inspector === false && s.thread === false],
      ['there are rows to navigate', s.indexRows > 0, String(s.indexRows)],
      ['and none of them is selected', s.selectedRows === 0, String(s.selectedRows)],
      ['nothing overflows sideways', s.overflowX === false],
    ];
  });

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
  await state('02-peek-hover', 'Passive Peek — hover. Read-only, two lines, pointer-events none', async () => {
    const s = await look();
    return [
      ['a Peek is on screen', !!s.peek, JSON.stringify(s.peek)],
      ['with a real size', !!s.peek && s.peek.w > 0 && s.peek.h > 0, JSON.stringify(s.peek)],
      ['it is the single-review Peek, not a cluster count', !!s.peek && s.peek.cluster === false, JSON.stringify(s.peek)],
      ['it says what the review says', !!s.peek && /too tight/i.test(s.peek.text), JSON.stringify(s.peek?.text)],
      ['the pointer goes straight through it', s.peek?.pointerEvents === 'none', String(s.peek?.pointerEvents)],
      ['and it is decoration over the pin, not a second control', s.peek?.ariaHidden === 'true'],
    ];
  });
  await js(`document.querySelector('.review-pin')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))`);
  await wait(400);

  // Focus the pin the way a keyboard would reach it, and let React's own
  // onFocus do the rest. Nothing here mounts a Peek by hand: the whole question
  // is whether focusing a pin produces one, and a harness that injects the
  // answer is not asking.
  const focusedPin = await js(`(() => {
    const pin = ${pinBy(tiny.review.number)};
    if (!pin) return { ok: false, why: 'no pin for the review' };
    pin.focus();
    return { ok: document.activeElement === pin, label: pin.getAttribute('aria-label') || '', n: (pin.textContent || '').trim() };
  })()`);
  await wait(700);
  await state('03-peek-focus', 'Peek — keyboard focus. Same context without a pointer', async () => {
    const s = await look();
    return [
      ['the pin took keyboard focus', focusedPin?.ok === true, JSON.stringify(focusedPin)],
      ['the focused element is the intended pin', /review-pin/.test(s.active?.cls || ''), JSON.stringify(s.active)],
      ['and it carries the whole accessible name itself', new RegExp(`Comment #${tiny.review.number}\\b`).test(s.active?.label || '') && /too tight/i.test(s.active?.label || ''), JSON.stringify(s.active?.label)],
      ['a Peek is on screen', !!s.peek, JSON.stringify(s.peek)],
      ['with a real size', !!s.peek && s.peek.w > 0 && s.peek.h > 0, JSON.stringify(s.peek)],
      ['it is the single-review Peek, not a cluster count', !!s.peek && s.peek.cluster === false, JSON.stringify(s.peek)],
      ['it is the same passive context the pointer gets', !!s.peek && /too tight/i.test(s.peek.text), JSON.stringify(s.peek?.text)],
      ['the pointer goes straight through it', s.peek?.pointerEvents === 'none', String(s.peek?.pointerEvents)],
      ['and it stays decoration, because the pin already said it', s.peek?.ariaHidden === 'true'],
    ];
  });
  await js(`document.activeElement?.blur()`);
  await wait(400);

  // --- the cluster chooser --------------------------------------------------
  await js(`(() => {
    const pin = [...document.querySelectorAll('.review-pin.is-cluster')][0];
    pin?.click();
    return !!pin;
  })()`);
  await wait(800);
  await state('04-cluster-chooser', 'Cluster chooser — which review, never the first by default', async () => {
    const s = await look();
    return [
      ['the chooser is open', !!s.cluster, JSON.stringify(s.cluster)],
      ['as a labelled non-modal dialog', s.cluster?.role === 'dialog', String(s.cluster?.role)],
      ['offering more than one review', (s.cluster?.rows || 0) >= 2, String(s.cluster?.rows)],
      ['and nothing to type into — it only chooses', s.cluster?.textarea === false],
      ['no review has been opened for you', s.thread === false],
    ];
  });
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
  await state('05-comment-mode', 'Comment mode — click an element to place a comment', async () => {
    const s = await look();
    return [
      ['comment mode is armed on the canvas', s.commenting === true],
      ['and nothing is being composed yet', s.composer === false],
    ];
  });

  // Placing the comment is a REAL CLICK, dispatched inside the page.
  //
  // Two earlier versions of this were not real. A click dispatched on the
  // <iframe> element reaches the element, not the document inside it, and
  // produced a picture with no composer in it captioned "the composer".
  // Posting `avb:click-node` by hand fixed the picture and broke the evidence:
  // it skipped the page's injected listener, the hit-testing, the measurement
  // and comment mode's own gate, then proved that the half it kept works.
  //
  // `webContents.sendInputEvent` was the next thing to try, and it does not
  // work here — measured, not assumed. The preview is an out-of-process iframe
  // (its own OS process; see `framesInSubtree`), and input injected at the
  // window's widget never reaches it: with comment mode armed and the page
  // fully marked, thirteen clicks across the canvas produced no `hover-node`
  // and no `click-node` at all. That is an Electron limit, not a Stacki bug.
  //
  // So the click is dispatched in the frame that owns the document, through
  // `webFrameMain.executeJavaScript`. From the page's own listener onwards
  // everything is the real thing: its hit test, its marker lookup, its
  // measurement of the clicked box, its `postMessage` to the parent,
  // PreviewPane's listener, comment mode's gate, the pin ratios and the
  // composer. The one link not exercised is Chromium's event routing into an
  // OOPIF, which is not our code and which nothing in this process can drive.
  const frame = await until.soft(
    'the preview frame',
    20000,
    async () =>
      win.webContents.mainFrame.framesInSubtree.find(
        (f) => f !== win.webContents.mainFrame && /^https?:/.test(f.url || '')
      ) || null
  );
  must('the preview runs in a frame this can reach', !!frame, String(frame && frame.url));

  let hasComposer = false;
  let clicked = null;
  if (frame) {
    // Something worth commenting on: a heading or a paragraph with real size,
    // on screen, and never the document element — a comment anchored to <html>
    // is technically a comment and visually a picture of nothing.
    clicked = await frame
      .executeJavaScript(
        `(() => {
          const marked = [...document.querySelectorAll('[data-avb-p]')];
          const fits = (n) => {
            const b = n.getBoundingClientRect();
            return b.width > 60 && b.height > 14 && b.top > 8 && b.bottom < innerHeight - 8;
          };
          // The page's OWN heading first, when it is on screen. Every other
          // element here belongs to a component, and a node inside a component
          // anchors to that component's usage in the open file — which is a
          // whole section of the page, not a heading. The orphan state later on
          // has to remove this element and leave a page behind.
          const el =
            marked.find((n) => n.classList.contains('section-title') && fits(n)) ||
            marked.find((n) => /^(H1|H2|H3|P|LI)$/.test(n.tagName) && fits(n)) ||
            marked.find((n) => n.tagName !== 'HTML' && n.tagName !== 'BODY' && fits(n));
          if (!el) return { ok: false, why: 'nothing on screen to click', marked: marked.length };
          const b = el.getBoundingClientRect();
          const x = Math.round(b.left + b.width / 2);
          const y = Math.round(b.top + b.height / 2);
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
          }
          return { ok: true, tag: el.tagName, x, y, marked: marked.length };
        })()`,
        true
      )
      .catch((err) => ({ ok: false, why: String(err && err.message) }));

    must('the page is marked up for the editor', (clicked?.marked || 0) > 0, JSON.stringify(clicked));
    must('and a real element was clicked in it', clicked?.ok === true, JSON.stringify(clicked));
    await wait(1200);
    hasComposer = await js(`!!document.querySelector('.review-composer')`);
    if (!hasComposer) {
      const why = await js(`(() => ({
        commenting: !!document.querySelector('.frame-clip.commenting'),
        anchor: !!document.querySelector('.review-draft-anchor'),
        pins: document.querySelectorAll('.review-pin').length,
      }))()`);
      shout(`  clicked ${JSON.stringify(clicked)} but: ${JSON.stringify(why)}`);
    }
  }

  // This state is REQUIRED. It is the only picture of the one surface that
  // takes new content over the canvas, and a package of review UX states that
  // silently omits "leaving a comment" is not a package of review UX states.
  must('a real click on the canvas opens the composer', hasComposer);
  if (hasComposer) {
    // Type into it the same way — through the window, not by setting .value —
    // so the picture shows a composer that has actually been used.
    await js(`document.querySelector('.review-composer textarea')?.focus()`);
    await wait(200);
    for (const ch of ORPHAN_MESSAGE) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    }
    await wait(500);
    const typed = await js(`(document.querySelector('.review-composer textarea')?.value || '')`);
    must('and what was typed into it arrived', typed.length > 0, JSON.stringify(typed));
    await state('06-new-comment-composer', 'New-comment composer — anchored, ~316px, the only content entry over the canvas', async () => {
      const s = await look();
      return [
        ['the composer is open', s.composer === true],
        ['with the anchor showing which point is being commented on', s.draftAnchor === true],
        ['and what was typed into it is in it', s.composerText.length > 0, JSON.stringify(s.composerText)],
      ];
    });
    // …and post it. Everything seeded through `reviews.act` above is anchored
    // by a pin ratio with no element behind it, which the store resolves to the
    // outermost thing on the page — <Base> in index.astro, for all eight of
    // them. Cutting THAT out to make an orphan empties the page, which is how
    // `20-orphaned-review` came to be a picture of a blank white preview.
    //
    // This one went through a real click on a real marked element, so it is
    // anchored to that element in the file that actually declares it — which is
    // something that can be removed on its own.
    const posted = await js(`(() => {
      const b = [...document.querySelectorAll('.review-composer button')].find((x) => /^Post$/i.test((x.textContent || '').trim()));
      b?.click();
      return !!b;
    })()`);
    must('the composed comment can be posted', posted === true);
    await wait(1600);
  } else {
    MISSING.push(['06-new-comment-composer', 'a real click on the canvas did not open the composer']);
  }
  // Escape undoes ONE rung of the review ladder at a time, on purpose — the
  // chooser, then the reader, then the selection, then comment mode. So leaving
  // comment mode is "press Escape until it is off", not "press Escape".
  //
  // Pressing it once left comment mode armed for the whole of the rest of the
  // run, and every later Escape then went to that same rung and did nothing
  // else: which is why `18-resolved-deselected` was a picture of a review that
  // was still selected, with the resolved marker still on the canvas.
  const pressEscape = () =>
    js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  const escapeUntil = async (what, done) => {
    for (let i = 0; i < 6; i++) {
      if (await done()) return true;
      await pressEscape();
      await wait(350);
    }
    const ok = await done();
    must(`Escape reaches ${what}`, ok);
    return ok;
  };
  await escapeUntil('the end of comment mode', async () => (await look()).commenting === false);

  /** Nothing selected, nothing open — the state the index is in before anybody picks a row. */
  const clearSelection = () =>
    escapeUntil('the selection', async () => {
      const s = await look();
      return s.selectedRows === 0 && s.thread === false;
    });

  // --- the Inspector --------------------------------------------------------
  await pickRow('/too tight/i');
  await state('07-inspector-short', 'Review Inspector — a one-message thread', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['holding exactly one message', s.messages === 1, String(s.messages)],
    ];
  });

  await pickRow('/spacing on this/i');
  await state('08-inspector-long-reply', 'Inspector — a long agent reply, top', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['with a reply under the first message', s.messages >= 2, String(s.messages)],
      ['long enough to scroll', !!s.scroll && s.scroll.max > 40, JSON.stringify(s.scroll)],
      ['and it is at the top of it', !!s.scroll && s.scroll.top === 0, JSON.stringify(s.scroll)],
    ];
  });
  await js(`(() => { const s = document.querySelector('.review-thread-scroll'); if (s) s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2); return true; })()`);
  await state('09-inspector-half-scrolled', 'Half-scrolled — header and reply box still in place', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the thread is scrolled, but not to either end', !!s.scroll && s.scroll.top > 0 && s.scroll.top < s.scroll.max, JSON.stringify(s.scroll)],
      ['and the reply box is still there to reply from', s.verbs.length > 0, JSON.stringify(s.verbs)],
    ];
  });
  await js(`(() => { const s = document.querySelector('.review-thread-scroll'); if (s) s.scrollTop = s.scrollHeight; return true; })()`);
  await state('10-inspector-bottom', 'At the bottom — Markdown, code, table, link, mail address', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the thread is scrolled to the bottom', !!s.scroll && s.scroll.top >= s.scroll.max - 4, JSON.stringify(s.scroll)],
    ];
  });

  await pickRow('/feels crowded/i');
  await state('11-inspector-ten-messages', 'Ten-message discussion', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['with ten messages in it', s.messages >= 10, String(s.messages)],
    ];
  });

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
  await state('12-draft-preserved', 'Unsent reply, kept across switching to another review and back', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the unsent reply is still in the box', s.draft === 'half written reply that must survive', JSON.stringify(s.draft)],
      ['and it is this review it was written on', s.messages >= 10, String(s.messages)],
    ];
  });

  // --- widths ---------------------------------------------------------------
  // Resized the way a person resizes it: the separator between the reader and
  // the canvas, which takes Home/End and the arrows.
  //
  // This used to write localStorage and re-open the review. The stored width is
  // read ONCE, in a lazy useState initialiser, and the app never remounts — so
  // it did nothing, all three "widths" were the same 440px default, and the
  // three captions saying 360 / 440 / 520 were three pictures of one width. The
  // claims below would have caught it; there were none.
  const pressResizer = async (key, shift = false) => {
    const ok = await js(`(() => {
      const r = document.querySelector('.review-resizer');
      if (!r) return false;
      r.focus();
      r.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', shiftKey: ${shift}, bubbles: true, cancelable: true }));
      return true;
    })()`);
    // One press per render. The handler works from the width it was last
    // RENDERED with, so several presses inside one frame are one press — four
    // Shift+Rights in a loop moved it eighty pixels, not a hundred and sixty.
    await wait(140);
    return ok;
  };
  const setWidth = async (want) => {
    must('there is a resizer to drag', (await pressResizer('Home')) === true);
    let got = 0;
    for (let i = 0; i < 40; i++) {
      got = (await look()).inspectorW;
      if (Math.abs(got - want) <= 2) break;
      await pressResizer(got < want ? 'ArrowRight' : 'ArrowLeft', Math.abs(got - want) >= 40);
    }
    must(`the Inspector could be resized to ${want}`, Math.abs(got - want) <= 2, String(got));
    await wait(300);
  };
  // 360, 440, 560 are INSPECTOR_MIN / INSPECTOR_DEFAULT / INSPECTOR_MAX in
  // src/reviewLayout.js. The picture at "its minimum" used to be taken at 370,
  // which is not the minimum — a caption off by the width of a scrollbar is
  // still a caption that is not true.
  const atWidth = (want) => async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      [`it is ${want}px wide`, Math.abs(s.inspectorW - want) <= 2, JSON.stringify({ inspectorW: s.inspectorW, panelW: s.panelW, want })],
      ['docked, with room left for the canvas', s.mode === 'docked' && s.canvasW >= 600, JSON.stringify({ mode: s.mode, canvas: s.canvasW })],
      ['and nothing overflows sideways', s.overflowX === false],
    ];
  };
  await setWidth(360);
  await state('13-inspector-360', 'Inspector at its minimum, 360px', atWidth(360));
  await setWidth(440);
  await state('14-inspector-440', 'Inspector at its default, 440px', atWidth(440));
  await setWidth(520);
  await state('15-inspector-520', 'Inspector widened to 520px', atWidth(520));
  await setWidth(440);

  // --- states ---------------------------------------------------------------
  await backToList();
  await js(`(() => {
    const all = [...document.querySelectorAll('.comments-filters button')].find((b) => b.textContent.trim() === 'All');
    all?.click();
    return !!all;
  })()`);
  await wait(700);
  await clearSelection();
  await state('16-index-all-filter', 'Index under All — deferred and resolved discoverable, canvas still clean', async () => {
    const s = await look();
    return [
      ['the Comments Index is showing', s.mode === 'index' && s.indexRows > 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['under the All filter', s.filters.some((f) => f.t === 'All' && f.on), JSON.stringify(s.filters)],
      ['with more rows than the open ones alone', s.indexRows >= 7, String(s.indexRows)],
      ['nothing is selected', s.selectedRows === 0, String(s.selectedRows)],
      ['and the resolved review is still off the canvas', !s.pins.some((pin) => pin.ids.includes(done.review.id)), JSON.stringify(s.pins.map((x) => x.cls))],
    ];
  });

  await pickRow('/Colour was wrong/i');
  await state('17-resolved-selected', 'Resolved review selected — green pin returns, Reopen and no Defer', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['it is the resolved one', /is-resolved/.test(s.dot), s.dot],
      ['selecting it brings its marker back', s.pins.some((pin) => pin.ids.includes(done.review.id)), JSON.stringify(s.pins.map((x) => x.cls))],
      ['it offers to reopen', s.verbs.some((v) => /Reopen/i.test(v)), JSON.stringify(s.verbs)],
      ['and does not offer to defer something already done', !s.verbs.some((v) => /Defer/i.test(v)), JSON.stringify(s.verbs)],
    ];
  });
  await backToList();
  await clearSelection();
  await state('18-resolved-deselected', 'Deselected — the resolved marker is gone again', async () => {
    const s = await look();
    return [
      ['no review is open', s.thread === false && s.inspector === false],
      ['and none is selected in the index', s.selectedRows === 0, String(s.selectedRows)],
      ['the resolved marker is off the canvas again', !s.pins.some((pin) => pin.ids.includes(done.review.id)), JSON.stringify(s.pins.map((x) => x.cls))],
      ['while the open ones are still on it', s.pins.length > 0, String(s.pins.length)],
    ];
  });

  await pickRow('/gap under this/i');
  await state('19-deferred-review', 'Deferred review — grey status, its reason kept', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['its status says deferred', /is-deferred/.test(s.dot), s.dot],
      ['and the reason it was deferred is still on it', /Waiting on the new spacing scale/i.test(await js(`document.querySelector('.review-thread')?.textContent || ''`))],
    ];
  });

  // An orphan, from the source outwards — with the page still standing.
  //
  // The element the review was left on is cut out of the page file, Astro
  // rebuilds, and the anchor stops resolving. The checks that it HAPPENED were
  // added earlier and are kept: the review says it is orphaned, there is no
  // marker for it, and there is no Locate button offering to go to something
  // that is not there.
  //
  // What the picture showed was a blank white preview. That is a true picture
  // of an orphan and useless as evidence of one, because a page with nothing on
  // it is what a failed build looks like too. The old check demanded
  // `pins === 0` — EVERY marker gone — which forced the cut to be wide enough to
  // orphan every review in the fixture, and took the fixture out with it.
  //
  // The state actually worth showing is narrower and harder: ONE source-backed
  // target disappeared, and the rest of the project is exactly where it was. So
  // the element is chosen for being an inner one — a heading, a paragraph — and
  // never a container whose removal empties the page; only that element is cut;
  // and the claims below include the pricing cards still being on the canvas.
  // Cutting a CONTAINER is what made the old picture blank. The tag has to be
  // an inner one: a heading, a paragraph, a list item — something the page can
  // lose and still be a page.
  const NARROW = /^(h1|h2|h3|h4|h5|h6|p|small|li|code|strong|em|figcaption)$/i;
  const allRows = () => reviews.list({ detail: 'full', status: 'all', limit: 100 })?.reviews || [];
  const orphanTarget = (() => {
    const row = allRows().find((r) => String(r.message || r.messages?.[0]?.body || '') === ORPHAN_MESSAGE);
    if (!row || !row.source) return null;
    return {
      id: row.id,
      number: row.number,
      file: row.source,
      tag: String(row.creationContext?.tag || ''),
      message: String(row.message || ''),
    };
  })();
  must(
    'the comment placed by a real click is in the store, with a source anchor',
    !!orphanTarget,
    JSON.stringify(allRows().map((r) => ({ msg: String(r.message || '').slice(0, 30), src: r.source, tag: r.creationContext?.tag })))
  );
  must(
    'and it is anchored to an inner element, not a container that holds the page',
    NARROW.test(orphanTarget?.tag || ''),
    JSON.stringify({ tag: orphanTarget?.tag, file: orphanTarget?.file })
  );

  /** The reviews that are NOT the one being orphaned — the page has to keep theirs. */
  const bystanders = (reviews.list({ detail: 'full', status: 'open', limit: 100 })?.reviews || [])
    .filter((r) => r.id !== orphanTarget?.id)
    .map((r) => r.id);

  /** Is the rest of the fixture still rendering? Asked of the page itself. */
  const pageAlive = async () => {
    const f = win.webContents.mainFrame.framesInSubtree.find(
      (x) => x !== win.webContents.mainFrame && /^https?:/.test(x.url || '')
    );
    if (!f) return { ok: false, why: 'no preview frame' };
    return f
      .executeJavaScript(
        `(() => ({
          cards: document.querySelectorAll('.pricing-grid .card').length,
          starter: /Starter/.test(document.body.textContent || ''),
          panel: !!document.querySelector('.panel'),
          text: (document.body.textContent || '').replace(/\\s+/g, ' ').trim().length,
          target: document.querySelectorAll('${orphanTarget?.tag || 'h1'}').length,
        }))()`,
        true
      )
      .catch((err) => ({ ok: false, why: String(err && err.message) }));
  };

  const aliveBefore = await pageAlive();
  must('the fixture renders its pricing cards to begin with', (aliveBefore?.cards || 0) === 3, JSON.stringify(aliveBefore));

  let page = null;
  let before = null;
  if (orphanTarget) {
    page = path.join(root, orphanTarget.file);
    before = fs.readFileSync(page, 'utf8');
    // ONE element. Non-greedy, and the tag is one this fixture never nests in
    // itself, so this takes out the first <tag>…</tag> and nothing else.
    const tag = orphanTarget.tag;
    // Paired first, then self-closing — a component usage is written
    // `<Hero … />` and would otherwise not match at all.
    let cut = before.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`), '');
    if (cut === before) cut = before.replace(new RegExp(`<${tag}\\b[^>]*\\/>`), '');
    must(`the fixture has a <${tag}> to cut out of ${orphanTarget.file}`, cut !== before, before.slice(0, 240));
    if (cut !== before) fs.writeFileSync(page, cut, 'utf8');
    const now = fs.readFileSync(page, 'utf8');
    must('and the source on disk really changed', now !== before && now === cut, `${before.length} → ${now.length}`);
  }
  await backToList();

  // Wait for the state rather than for a number of milliseconds: a rebuild
  // takes as long as it takes, and a sleep that is usually long enough is a
  // flake with a timer on it.
  const orphaned = await until.soft('the review to orphan', 25000, async () => {
    await pickRow('/more room above/i');
    const seen = await js(`!!document.querySelector('.review-thread .review-orphan')`);
    return seen ? true : null;
  });
  must('the review reports itself orphaned', orphaned === true, String(orphaned));

  const aliveAfter = await pageAlive();
  await state(
    '20-orphaned-review',
    'Orphaned review — its target is gone, the rest of the page is not',
    async () => {
      const s = await look();
      const mine = s.pins.filter((pin) => pin.ids.includes(orphanTarget?.id));
      const others = s.pins.filter((pin) => pin.ids.some((id) => bystanders.includes(id)));
      return [
        ['the Inspector is open on the orphaned review', s.inspector === true && s.thread === true, JSON.stringify({ mode: s.mode, thread: s.thread })],
        ['it says its target is gone', s.orphanNote === true],
        ['its status is orphaned', /is-orphaned/.test(s.dot), s.dot],
        ['it has no marker on the canvas to point at', mine.length === 0, JSON.stringify(mine)],
        ['and does not offer to locate what is gone', s.locate === false],
        ['the file it was left in is still named', s.sourcePath.length > 0, JSON.stringify(s.sourcePath)],
        ['and what it was left ON is still described', /<h2>/.test(s.target) && /Plan/.test(s.target), JSON.stringify(s.target)],
        // The half that was missing: the page behind it.
        ['the element really was cut from the page', (aliveAfter?.target || 0) < (aliveBefore?.target || 0), JSON.stringify({ before: aliveBefore?.target, after: aliveAfter?.target })],
        ['the rest of the page is still rendering', (aliveAfter?.cards || 0) === 3 && aliveAfter?.starter === true && aliveAfter?.panel === true, JSON.stringify(aliveAfter)],
        ['it is not a blank page mid-rebuild', (aliveAfter?.text || 0) > 60, JSON.stringify(aliveAfter?.text)],
        ['and the reviews on what is left still have their markers', others.length > 0, JSON.stringify(s.pins.map((x) => x.cls))],
      ];
    }
  );

  if (page && before != null) fs.writeFileSync(page, before, 'utf8');
  // And back: an orphan is a state the source can leave as well as enter, and
  // a run that left the fixture cut would take every later state with it.
  const rejoined = await until.soft('the review to re-anchor', 25000, async () => {
    const back = await js(
      `[...document.querySelectorAll('.review-pin')].some((p) => (p.getAttribute('data-review-ids') || '').split(' ').includes('${orphanTarget?.id}'))`
    );
    return back ? true : null;
  });
  must('restoring the source re-anchors the review that was orphaned', rejoined === true, String(rejoined));
  must('and the file is byte-for-byte what it was', page ? fs.readFileSync(page, 'utf8') === before : true);

  // --- layout ---------------------------------------------------------------
  await backToList();
  await pickRow('/spacing on this/i');
  win.setSize(1728, 1117);
  await wait(1200);
  await state('21-layout-roomy', 'Roomy — Inspector, canvas and Style panel all usable', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['docked beside the canvas', s.mode === 'docked', s.mode],
      ['the canvas is somewhere you can work', s.canvasW >= 600, String(s.canvasW)],
      ['and the Style panel is still there', s.propsVisible === true, String(s.propsW)],
      ['nothing overflows sideways', s.overflowX === false],
    ];
  });
  win.setSize(1312, 848);
  await wait(1200);
  await state('22-layout-props-collapsed', 'Tighter — Style collapses before the canvas is crushed', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['still docked', s.mode === 'docked', s.mode],
      ['the Style panel has gone', s.propsVisible === false, String(s.propsW)],
      ['and that is what kept the canvas usable', s.canvasW >= 600, String(s.canvasW)],
      ['nothing overflows sideways', s.overflowX === false],
    ];
  });
  win.setSize(1024, 665);
  await wait(1200);
  await state('23-layout-overlay', 'Constrained — the Inspector floats over the canvas, no scrim', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the Inspector is over the canvas rather than beside it', s.mode === 'overlay', s.mode],
      ['it is still wide enough to read', s.inspectorW >= 360, String(s.inspectorW)],
      ['the canvas keeps its width behind it', s.canvasW >= 600, String(s.canvasW)],
      ['nothing overflows sideways', s.overflowX === false],
    ];
  });
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
  await state('24-phone-preview', 'Phone preview while reading a review', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the preview is a phone', s.frameW > 0 && s.frameW <= 420, String(s.frameW)],
      ['and the review is still readable beside it', s.messages >= 1, String(s.messages)],
    ];
  });
  await device('desktop');
  await wait(1500);
  await state('25-desktop-preview', 'Desktop preview while reading a review', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the preview is back to a desktop', s.frameW > 600, String(s.frameW)],
    ];
  });

  // --- the two surfaces that had never been photographed --------------------
  //
  // Both are real states of the Inspector, both are reachable in two presses,
  // and neither was in this package. The overflow matters more than it used
  // to: recolouring moved into it when the status dot stopped being the colour
  // picker, so "how do I change the colour" is now answered entirely by this
  // menu. And Defer is one of the two verbs in the footer — the deferred
  // review at 19 shows the result, and nothing showed the form that reaches it.
  await backToList();
  await pickRow('/spacing on this/i');

  const openedMenu = await js(`(() => {
    const b = document.querySelector('.review-overflow button[aria-haspopup="menu"]');
    b?.click();
    return !!b;
  })()`);
  await wait(500);
  const menuItems = await js(`[...document.querySelectorAll('.review-menu [role="menuitem"]')].map((b) => b.textContent.trim())`);
  must('the Inspector overflow opens', openedMenu === true);
  must('and it is the only place colour is edited from', (menuItems || []).some((t) => /Colour/i.test(t)), JSON.stringify(menuItems));
  must('and it holds the destructive act', (menuItems || []).some((t) => /Delete/i.test(t)), JSON.stringify(menuItems));
  await state('26-inspector-overflow', 'Inspector overflow — Colour… and the one destructive act, both out of the way', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the overflow menu is open', s.menu.length > 0, JSON.stringify(s.menu)],
      ['it is where colour is edited from', s.menu.some((x) => /Colour/i.test(x)), JSON.stringify(s.menu)],
      ['and where the destructive act lives', s.menu.some((x) => /Delete/i.test(x)), JSON.stringify(s.menu)],
    ];
  });

  // Escape from inside the menu closes the MENU. It used to fall through to
  // the app and close the whole Inspector, so looking in here cost you the
  // review you were reading — which is also why this run could not reach the
  // Defer button afterwards.
  await js(`(() => {
    const b = document.querySelector('.review-overflow button[aria-haspopup="menu"]');
    b?.focus();
    b?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await wait(450);
  const afterEscape = await js(`(() => ({
    menu: !!document.querySelector('.review-menu'),
    thread: !!document.querySelector('.review-thread'),
  }))()`);
  must('Escape closes the overflow menu', afterEscape.menu === false, JSON.stringify(afterEscape));
  must('and leaves the review open behind it', afterEscape.thread === true, JSON.stringify(afterEscape));

  const openedDefer = await js(`(() => {
    const b = [...document.querySelectorAll('.review-actions button')].find((x) => /Defer/i.test(x.textContent || ''));
    b?.click();
    return !!b;
  })()`);
  await wait(500);
  const deferForm = await js(`(() => {
    const f = document.querySelector('.review-defer');
    if (!f) return null;
    return { fields: f.querySelectorAll('textarea, input').length, buttons: [...f.querySelectorAll('button')].map((b) => b.textContent.trim()) };
  })()`);
  must('Defer opens its form rather than deferring on the spot', openedDefer === true && !!deferForm, JSON.stringify(deferForm));
  if (deferForm) {
    // Deferring without saying why is how a deferred review becomes a review
    // nobody can pick back up.
    must('and it asks for a reason and somewhere it is tracked', deferForm.fields >= 2, JSON.stringify(deferForm));
    must('and it can be backed out of', deferForm.buttons.some((t) => /Cancel/i.test(t)), JSON.stringify(deferForm));
  }
  await state('27-defer-form', 'Defer — a reason and where it is tracked, before anything changes', async () => {
    const s = await look();
    return [
      ['the Review Inspector is open', s.inspector === true, JSON.stringify({ mode: s.mode, panelW: s.panelW, inspectorW: s.inspectorW })],
      ['the left panel is presenting it, not the Comments Index', s.mode !== 'index' && s.indexRows === 0, JSON.stringify({ mode: s.mode, rows: s.indexRows })],
      ['and there is a conversation in it', s.thread === true],
      ['the Defer form is open rather than deferred on the spot', !!s.deferForm, JSON.stringify(s.deferForm)],
      ['it asks for a reason and somewhere it is tracked', (s.deferForm?.fields || 0) >= 2, JSON.stringify(s.deferForm)],
      ['it can be backed out of', (s.deferForm?.buttons || []).some((x) => /Cancel/i.test(x)), JSON.stringify(s.deferForm)],
      ['and nothing has been deferred yet', /is-open/.test(s.dot), s.dot],
    ];
  });
  // Backed out of through its own Cancel, so the review is left exactly as it
  // was found — a deferral nobody asked for would change every later state.
  await js(`(() => {
    const b = [...document.querySelectorAll('.review-defer button')].find((x) => /Cancel/i.test(x.textContent || ''));
    b?.click();
    return !!b;
  })()`);
  await wait(450);
  const stillOpen = await js(`(() => ({
    form: !!document.querySelector('.review-defer'),
    verbs: [...document.querySelectorAll('.review-actions button')].map((b) => b.textContent.trim()),
  }))()`);
  must('Cancel puts the defer form away', stillOpen.form === false, JSON.stringify(stillOpen));
  must('and the review is still open, not deferred', stillOpen.verbs.some((t) => /Resolve/i.test(t)), JSON.stringify(stillOpen));
  await backToList();

  // --- the display matrix ---------------------------------------------------
  //
  // Eleven sizes, each photographed with the REVIEW INSPECTOR OPEN.
  //
  // It used to run straight after backToList(), so the left panel was the
  // Comments Index — about 260px of rows — and the caption read the width of
  // `.panel.left` and called it `inspector 260px`. Eleven pictures of the wrong
  // panel, each captioned as the right one, in the package whose whole job is
  // to show what the Inspector does at these sizes. Nothing checked, so nothing
  // said.
  //
  // So a review is opened first, and every claim below is about the Inspector
  // itself rather than about whatever happens to be in the left panel. The
  // long review, because it is the one with enough in it to fill the reader.
  await backToList();
  const opened = await pickRow('/spacing on this/i');
  must('the matrix has a review open to photograph', opened === 'clicked', String(opened));
  await wait(900);

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

  /**
   * Read the geometry once it has stopped moving.
   *
   * A window resize is three separate things — the OS resizing the window, the
   * renderer noticing, React re-rendering — and a fixed wait between them is a
   * race. Waiting for two identical readings waits for the thing itself.
   */
  const settled = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const now = await look();
      const key = JSON.stringify(now);
      if (key === last) return now;
      last = key;
      await wait(150);
    }
    return JSON.parse(last);
  };

  // The fields the caption quotes and the claims are about. If any of them has
  // moved between settling and the shutter, the picture is of a window this
  // caption was not written for, and the state fails rather than being
  // relabelled with numbers nobody checked.
  const CAPTIONED = ['vw', 'vh', 'mode', 'inspector', 'inspectorW', 'panelW', 'canvasW', 'propsW', 'propsVisible', 'overflowX'];
  const captionedOnly = (g) => Object.fromEntries(CAPTIONED.map((k) => [k, g?.[k]]));

  say('');
  say('  display matrix — mode, Inspector, canvas, Style panel, overflow');
  for (const [slug, w, h] of MATRIX) {
    win.setSize(w, h);
    await wait(250);
    // Stabilised here so the resize is over before anything is claimed…
    const target = await settled();
    // …and read AGAIN at capture time, inside state(), which waits before it
    // takes the picture. The geometry below is that second read: it is what the
    // claims are about, what the caption says, and — because nothing happens
    // between it and the shutter — what the PNG contains.
    const ok = await state(
      `matrix-${slug}`,
      (g) => `${w}×${h} — ${g.mode}, Inspector ${g.inspectorW}px, canvas ${g.canvasW}px, Style ${g.propsVisible ? `${g.propsW}px` : 'collapsed'}`,
      async (g) => [
        ['the Review Inspector is open', g.inspector === true, JSON.stringify(g)],
        ['the left panel is presenting it, not the Comments Index', g.mode !== 'index' && g.indexRows === 0, JSON.stringify({ mode: g.mode, rows: g.indexRows })],
        ['there is a conversation in it', g.thread === true],
        // The width in the caption is the Inspector's own box, and the panel
        // holding it is the same object — not some other panel that happened to
        // be there.
        ['the width in the caption is the Inspector', g.inspectorW > 0 && Math.abs(g.panelW - g.inspectorW) <= 24, JSON.stringify({ panelW: g.panelW, inspectorW: g.inspectorW })],
        ['it is within what the Inspector may be', g.inspectorW >= 360 && g.inspectorW <= 560, String(g.inspectorW)],
        // Docked or over the canvas — those are the two, and the caption says
        // which. 'closed' and 'index' are not states this picture may be in.
        ['the mode in the caption is one the layout has', g.mode === 'docked' || g.mode === 'overlay', String(g.mode)],
        ['the canvas is real, and still somewhere you can work', g.canvasW >= 600, String(g.canvasW)],
        ['the Style panel is measured, not assumed', g.propsVisible === g.propsW > 0, JSON.stringify({ visible: g.propsVisible, w: g.propsW })],
        ['Style collapses before the canvas is crushed', g.propsVisible === false || g.canvasW >= 600, JSON.stringify({ props: g.propsW, canvas: g.canvasW })],
        ['and nothing overflows the window sideways', g.overflowX === false, JSON.stringify({ vw: g.vw })],
        // And the window is still the one that settled a moment ago.
        [
          'the geometry at the shutter is the geometry that settled',
          CAPTIONED.every((k) => g?.[k] === target?.[k]),
          JSON.stringify({ settled: captionedOnly(target), atCapture: captionedOnly(g) }),
        ],
      ],
      settled
    );
    // Printed from what the picture actually claims, not from the earlier read.
    if (ok) say(`    ${SHOTS[SHOTS.length - 1].caption}`);
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
  p.failed { margin:0 0 20px; padding:9px 12px; background:#2c1618; border:1px solid #5a2226; border-radius:8px; color:#f0a8ad; font-size:12px; }
</style>
<h1>Stacki — Visual Review UX states</h1>
<p class="sub">${SHOTS.length} states, captured from the running app at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.</p>
${MISSING.length ? `<p class="missing"><b>${MISSING.length} state${MISSING.length === 1 ? '' : 's'} not captured:</b> ${MISSING.map(([n, why]) => `${n} — ${why}`).join('; ')}</p>` : ''}
${(() => {
  const absent = REQUIRED.filter((name) => !SHOTS.some((s) => s.name === name));
  return absent.length
    ? `<p class="failed"><b>${absent.length} REQUIRED state${absent.length === 1 ? '' : 's'} missing — this package is incomplete:</b> ${absent.join('; ')}</p>`
    : `<p class="sub">All ${REQUIRED.length} required states are present, and each was asserted to be the state its caption names before it was photographed.</p>`;
})()}
${FAILED.length ? `<p class="failed"><b>${FAILED.length} claim${FAILED.length === 1 ? '' : 's'} did not hold — do not treat these as evidence:</b> ${FAILED.join('; ')}</p>` : ''}
<div class="grid">
${SHOTS.map((s) => `  <figure><img src="${s.name}.png" alt="${s.caption}"><figcaption><b>${s.name}</b>${s.caption}</figcaption></figure>`).join('\n')}
</div>
`;
  fs.writeFileSync(path.join(OUT, 'index.html'), sheet, 'utf8');

  say('');
  say(`review-ux-export: ${SHOTS.length} states in ${OUT}`);
  for (const [name, why] of MISSING) shout(`  NOT CAPTURED  ${name} — ${why}`);
  say(`  open ${path.join(OUT, 'index.html')} to look through them`);
  if (FAILED.length) {
    shout(`\nreview-ux-export: ${FAILED.length} claim(s) about these states did not hold\n`);
    for (const f of FAILED) shout(`  ${f}`);
  }
  // A required state that is not here — because it could not be produced, or
  // because what it claimed about itself did not hold — is a failing run. It
  // used to be a line on the contact sheet and an exit code of 0.
  const absent = REQUIRED.filter((name) => !SHOTS.some((s) => s.name === name));
  if (absent.length) {
    shout(`\nreview-ux-export: ${absent.length} required state(s) missing from the package\n`);
    for (const name of absent) shout(`  ${name}`);
  }
  say(
    `review-ux-export: ${REQUIRED.length - absent.length}/${REQUIRED.length} required states, ${SHOTS.length} captured`
  );
  return teardown(FAILED.length || absent.length ? 1 : 0);
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

  // Read BEFORE anything is asked to stop, and long before the fixture goes:
  // this is the only record of which process holds the port, and it lives
  // inside the directory that is about to be deleted.
  const devLock = readDevLock(root);

  await attempt('stopping the preview', async () => {
    // Through the app's own bridge first — `window.avb.stopDevServer` is the
    // same call the editor makes when a project is closed, and unlike the MCP
    // route it does not need a server this harness never turns on. Asking
    // through MCP was the only route before, so on every run where MCP was not
    // up the whole step returned early and reported success.
    const live = BrowserWindow.getAllWindows()[0];
    if (live && !live.isDestroyed()) {
      await live.webContents.executeJavaScript('window.avb?.stopDevServer?.()', true).catch(() => null);
    }
    const status = mcp.status();
    if (!status?.running || !status.url || !status.token) {
      const gone = await awaitDevServerGone(devLock);
      say(`  preview: ${gone.how} [port ${devLock?.port ?? "none"}]`);
      return;
    }
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
    await call({ action: 'dev_stop' });

    // `ok` from dev_stop means "asked", not "stopped": Astro 7 daemonizes its
    // dev server, so Stacki hands the job to `astro dev stop` and returns. What
    // was checked next was whether the URL still answered — and a dev server
    // whose project directory has been deleted does not refuse connections, it
    // answers 500. fetch resolves, so "it threw" was never going to be true, and
    // the step above it returned early and silently whenever the MCP server was
    // not up. Five runs, five orphaned servers, one per run, each holding the
    // next port up.
    //
    // The process is the question. Waiting for it HERE also fixes the order:
    // `astro dev stop` needs the project it is stopping to still exist, and the
    // fixture is removed a few lines below.
    const gone = await awaitDevServerGone(devLock);
    say(`  preview: ${gone.how} [port ${devLock?.port ?? "none"}]`);
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
    releaseTempDir(userData);
    if (fs.existsSync(userData)) throw new Error('still there');
  });

  if (problems.length) {
    shout(`\nreview-ux-export: ${problems.length} cleanup failure(s) — this is a failing run\n`);
    for (const p of problems) shout(`  ${p}`);
  }
  app.exit(problems.length ? 1 : code);
}
