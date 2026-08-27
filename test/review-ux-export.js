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
    const pin = [...document.querySelectorAll('.review-pin.is-cluster')][0];
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
  must('comment mode starts', commenting);
  await shot('05-comment-mode', 'Comment mode — click an element to place a comment');

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
          const el =
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
    for (const ch of 'This heading is too tight on mobile.') {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    }
    await wait(500);
    const typed = await js(`(document.querySelector('.review-composer textarea')?.value || '')`);
    must('and what was typed into it arrived', typed.length > 0, JSON.stringify(typed));
    await shot('06-new-comment-composer', 'New-comment composer — anchored, ~316px, the only content entry over the canvas');
  } else {
    MISSING.push(['06-new-comment-composer', 'a real click on the canvas did not open the composer']);
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

  // An orphan, from the source outwards.
  //
  // The element the review was left on is cut out of the page file, Astro
  // rebuilds, and the anchor stops resolving. That part was always real — what
  // was missing was any check that it had happened, so a rebuild that did not
  // land, or a review that re-anchored to something else, still produced a
  // file called `20-orphaned-review`.
  //
  // Three things have to be true before the picture is taken, and they are the
  // three the state IS: the review says it is orphaned, there is no marker for
  // it on the canvas, and there is no Locate button offering to go to
  // something that is not there.
  //
  // Which file, and which element, comes from the review itself rather than
  // from a guess. The first version of this cut `<h1>` out of index.astro on
  // the assumption that was where the review lived; the h1 is in Hero.astro,
  // index.astro has no h1 at all, and the edit was a no-op that still produced
  // a file called `20-orphaned-review`. Asking the store where the review is
  // anchored is both more honest and less brittle.
  const anchoredAt = (() => {
    const all = reviews.list({ detail: 'full', status: 'all', limit: 100 });
    const rows = all?.reviews || [];
    const row = rows.find((r) => /too tight/i.test(r?.message || r?.messages?.[0]?.body || ''));
    if (!row) return null;
    return { id: row.id, file: row.source || null, tag: row.creationContext?.tag || null, state: row.anchorState };
  })();
  must('the seeded review is anchored to a real file', !!anchoredAt?.file, JSON.stringify(anchoredAt));

  let page = null;
  let before = null;
  if (anchoredAt?.file) {
    page = path.join(root, anchoredAt.file);
    before = fs.readFileSync(page, 'utf8');
    // Take out the element the review names. A tag that appears more than once
    // would leave the anchor resolvable, so this removes the whole element and
    // checks the file actually changed.
    const tag = anchoredAt.tag || 'h1';
    const whole = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`);
    let cut = before.replace(whole, '');
    if (cut === before) cut = before.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`), '');
    must(`the fixture has a <${tag}> to cut out of ${anchoredAt.file}`, cut !== before, before.slice(0, 200));
    if (cut !== before) fs.writeFileSync(page, cut, 'utf8');
  }
  await backToList();

  // Wait for the state rather than for a number of milliseconds: a rebuild
  // takes as long as it takes, and a sleep that is usually long enough is a
  // flake with a timer on it.
  const orphaned = await until.soft('the review to orphan', 20000, async () => {
    await pickRow('/too tight/i');
    const seen = await js(`(() => {
      const t = document.querySelector('.review-thread');
      if (!t) return null;
      return {
        orphan: !!t.querySelector('.review-orphan'),
        dot: t.querySelector('.review-dot')?.className || '',
        locate: !!t.querySelector('.review-locate'),
        pins: document.querySelectorAll('.review-pin').length,
      };
    })()`);
    return seen && seen.orphan ? seen : null;
  });

  must('the review reports itself orphaned', !!orphaned, JSON.stringify(orphaned));
  if (orphaned) {
    must('and its dot says so', /is-orphaned/.test(orphaned.dot), orphaned.dot);
    // The two things an orphan must NOT do: claim a place on the page, and
    // offer to take you to one.
    must('an orphan has no marker on the canvas to point at', orphaned.pins === 0, `${orphaned.pins} pins`);
    must('and does not offer to locate what is gone', !orphaned.locate);
    await shot('20-orphaned-review', 'Orphaned review — readable Inspector, no pin, no Locate');
  } else {
    MISSING.push(['20-orphaned-review', 'the review never reported itself orphaned']);
  }

  if (page && before != null) fs.writeFileSync(page, before, 'utf8');
  // And back: an orphan is a state the source can leave as well as enter, and
  // a run that left the fixture cut would take every later state with it.
  const rejoined = await until.soft('the review to re-anchor', 20000, async () => {
    const pins = await js(`document.querySelectorAll('.review-pin').length`);
    return pins > 0 ? pins : null;
  });
  must('restoring the source brings the markers back', !!rejoined, String(rejoined));

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
  await shot('26-inspector-overflow', 'Inspector overflow — Colour… and the one destructive act, both out of the way');

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
  await shot('27-defer-form', 'Defer — a reason and where it is tracked, before anything changes');
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
  p.failed { margin:0 0 20px; padding:9px 12px; background:#2c1618; border:1px solid #5a2226; border-radius:8px; color:#f0a8ad; font-size:12px; }
</style>
<h1>Stacki — Visual Review UX states</h1>
<p class="sub">${SHOTS.length} states, captured from the running app at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.</p>
${MISSING.length ? `<p class="missing"><b>${MISSING.length} state${MISSING.length === 1 ? '' : 's'} not captured:</b> ${MISSING.map(([n, why]) => `${n} — ${why}`).join('; ')}</p>` : ''}
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
  return teardown(FAILED.length ? 1 : 0);
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
