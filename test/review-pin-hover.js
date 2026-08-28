// What a review pin is painted, at rest and under a real pointer.
//
//   npm run test:pinhover
//
// A pin is a `<button>`, and the editor tints any button on hover:
//
//   button:hover:not(:disabled):where(…) { background: var(--bg-active); }
//
// `:where()` adds no specificity, so that selector is (0,2,1). A pin's colour
// lives on `.review-pin { background: var(--review-open) }` — (0,1,0), weaker.
// So unless a pin's hover rule re-asserts a background, the generic tint wins
// and repaints it with 9% white. Over a white page that is an open pin turning
// into a ghost with an invisible number, which is what shipped.
//
// Deferred, resolved and cluster never had the bug, because their hover rules
// happen to set backgrounds of their own. Open and open-selected did not.
//
// THIS TESTS THE CASCADE, NOT THE APP. It loads the real stylesheet and the
// real class names into a bare window, because that is what the defect is made
// of — specificity — and because booting the whole editor to answer a
// stylesheet question is slow, flaky, and no more truthful. The pins' place in
// the running app is already covered by the review visual suites.
//
// `:hover` is driven by the real pointer: a synthetic mouseover does not set
// it. So this moves the mouse with `sendInputEvent` and reads
// `getComputedStyle`, the same way test/vars-row-height.js drives its drags.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

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
app.on('window-all-closed', () => {});

const CSS = path.join(__dirname, '..', 'src', 'styles.css');

// Every pin state, laid out far enough apart that a pointer on one is nowhere
// near another. `open` here is the SELECTED class, not the status.
const STATES = [
  { id: 'open', cls: 'review-pin is-open', label: 'open' },
  { id: 'open-selected', cls: 'review-pin is-open open', label: 'open selected' },
  { id: 'deferred', cls: 'review-pin is-deferred', label: 'deferred' },
  { id: 'resolved', cls: 'review-pin is-resolved', label: 'resolved' },
  { id: 'cluster', cls: 'review-pin is-cluster', label: 'cluster' },
];

// Inlined rather than linked: a data: URL cannot pull in a file:// stylesheet,
// and the page silently rendered with default button styling — every pin
// measured rgb(239,239,239) and the test "passed" the states it should have
// failed. The bytes are the same either way; the cascade is what matters.
const sheet = fs.readFileSync(CSS, 'utf8');

const page = `<!doctype html><meta charset="utf-8">
<style>
${sheet}
</style>
<style>
  /* A white ground, because the bug is only invisible against one. The pins
     are positioned absolutely by the app; here they are placed by the test. */
  html, body { margin: 0; background: #fff; height: 100%; }
  .slot { position: absolute; }
</style>
<body>
${STATES.map((s, i) => `<div class="slot" style="left:${60 + i * 150}px; top:120px"><button id="${s.id}" class="${s.cls}"><span class="review-pin-n">${i + 1}</span></button></div>`).join('\n')}
</body>`;

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 300, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await wait(700);
  const js = (code) => win.webContents.executeJavaScript(code, true);

  check('the real stylesheet loaded', (await js(`getComputedStyle(document.documentElement).getPropertyValue('--review-open').trim().length > 0`)) === true, 'src/styles.css did not apply');

  // The tokens, resolved by the browser rather than copied into this file: a
  // renamed token should fail loudly instead of comparing two stale strings.
  const tokens = JSON.parse(
    await js(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const rgb = (v) => { const d = document.createElement('div'); d.style.color = v.trim(); document.body.appendChild(d);
        const out = getComputedStyle(d).color; d.remove(); return out; };
      return JSON.stringify({ open: rgb(cs.getPropertyValue('--review-open')),
        deferred: rgb(cs.getPropertyValue('--review-deferred')),
        resolved: rgb(cs.getPropertyValue('--review-resolved')),
        tint: rgb(cs.getPropertyValue('--bg-active')) });
    })()`)
  );
  say(`  tokens: open=${tokens.open} resolved=${tokens.resolved} generic-hover-tint=${tokens.tint}`);

  const at = async (id) =>
    JSON.parse(
      await js(`(() => { const p = document.getElementById(${JSON.stringify(id)}); const r = p.getBoundingClientRect(); const cs = getComputedStyle(p);
        return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), hovering: p.matches(':hover'),
          background: cs.backgroundColor, color: cs.color, transform: cs.transform, boxShadow: cs.boxShadow.slice(0, 40) }); })()`)
    );

  say('\n  measuring (real pointer)');
  const seen = {};
  for (const s of STATES) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 280 });
    await wait(160);
    const rest = await at(s.id);
    // One move does not reliably set :hover; Chromium wants actual movement.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rest.x, y: rest.y - 25 });
    await wait(90);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rest.x - 2, y: rest.y - 1 });
    await wait(90);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rest.x, y: rest.y });
    await wait(260);
    const hover = await at(s.id);
    seen[s.id] = { rest, hover };
    say(`    ${s.label.padEnd(14)} rest ${rest.background.padEnd(22)} hover ${hover.background}`);
    check(`${s.label}: the pointer reached it`, hover.hovering === true, JSON.stringify(hover));
  }

  say('\n  asserting');
  const ghosted = (v) => v === tokens.tint || /rgba\([^)]*,\s*0(\.\d+)?\)$/.test(v || '');

  // THE BUG. Both open states must keep the open-status colour under a pointer.
  for (const id of ['open', 'open-selected']) {
    const m = seen[id];
    check(`${id}: is the open-status colour at rest`, m.rest.background === tokens.open, m.rest.background);
    check(`${id}: AND KEEPS IT UNDER THE POINTER`, m.hover.background === tokens.open, `${m.rest.background} -> ${m.hover.background}`);
    check(`${id}: is not repainted with the generic button tint`, !ghosted(m.hover.background), m.hover.background);
  }

  // The states that were already correct must stay correct.
  check('deferred keeps its own background under the pointer', seen.deferred.hover.background === seen.deferred.rest.background, `${seen.deferred.rest.background} -> ${seen.deferred.hover.background}`);
  check('  and its status ring survives', /inset/.test(seen.deferred.hover.boxShadow) || seen.deferred.hover.boxShadow.length > 0, seen.deferred.hover.boxShadow);
  check('resolved is the resolved colour at rest', seen.resolved.rest.background === tokens.resolved, seen.resolved.rest.background);
  check('  and keeps it under the pointer', seen.resolved.hover.background === tokens.resolved, `${seen.resolved.rest.background} -> ${seen.resolved.hover.background}`);
  check('a cluster stays a solid neutral', !ghosted(seen.cluster.hover.background), seen.cluster.hover.background);

  // No pin, in any state, may end up translucent under a pointer.
  for (const s of STATES) {
    check(`${s.label}: the hovered pin is opaque`, !ghosted(seen[s.id].hover.background), seen[s.id].hover.background);
  }

  // The fix must not cost the affordance.
  check('hovering an open pin still lifts it', seen.open.hover.transform !== seen.open.rest.transform, `${seen.open.rest.transform} -> ${seen.open.hover.transform}`);
  check('and the number stays legible against it', seen.open.hover.color === 'rgb(255, 255, 255)', seen.open.hover.color);

  win.destroy();
  if (failures.length) {
    shout(`\nreview-pin-hover: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    app.exit(1);
    return;
  }
  say(`\nreview-pin-hover: ${checked} checks passed  [real stylesheet, real pointer, computed backgrounds]`);
  app.exit(0);
})().catch((err) => {
  shout(`review-pin-hover: threw\n${err?.stack || err}`);
  app.exit(1);
});
