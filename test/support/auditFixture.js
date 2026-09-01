// Two Astro projects that differ only in the defects.
//
// The whole value of a seeded corpus is in the PAIRING. A detector that fires on
// "there is an input" rather than on "this input has no accessible name" passes a
// broken-fixture test and fails a real project, so every seeded defect here sits
// beside a structurally identical control that is correct. The clean project is
// the broken one with the defects fixed and nothing else changed.
//
// Every defect below was verified to fire, and every control verified not to,
// against axe-core 4.13.0 in a real browser BEFORE the engine was written. Two
// things that looked like obvious seeds are deliberately absent:
//
//   A DUPLICATE ID is not a WCAG violation any more. axe 4.13 tags `duplicate-id`
//   and `duplicate-id-active` `deprecated` and `wcag2a-obsolete`, because WCAG 2.2
//   obsoleted SC 4.1.1 Parsing. Seeding one and calling the result a standards
//   failure would be an overclaim. What IS seeded is `duplicate-id-aria`, which is
//   current -- and which the engine returns as `incomplete` rather than as a
//   violation, so it is also the honest example of that third bucket.
//
//   AN UNLABELLED INPUT WITH A PLACEHOLDER is not unlabelled. A placeholder counts
//   toward the accessible name, so axe's `label` rule passes and the "seeded
//   defect" is a green test proving nothing. The seeded input has no placeholder.
//
// The carousel is the most important thing in the file. It is wider than the
// viewport at every width, on purpose, inside `overflow-x: auto`. A detector that
// cannot tell it apart from the broken banner is not shippable, and it is the one
// control that fails loudly if the overflow rule is written as "is this element
// wide" instead of "does this reach the document".

const BASE_CSS = `:root {
  --gap: 1rem;
  --brand: #3355ff;
  --ink: #1a1a1a;
  --paper: #ffffff;
}

body {
  margin: 0;
  font: 16px/1.5 system-ui, sans-serif;
  color: var(--ink);
  background: var(--paper);
}

.wrap { padding: var(--gap); }

/* A real scroll container. Its child is wider than any viewport BY DESIGN, and
   nothing about it is a defect at any width. */
.carousel {
  overflow-x: auto;
  white-space: nowrap;
}
.carousel-row {
  width: 1400px;
  height: 48px;
  background: linear-gradient(90deg, var(--brand), #88aaff);
}

.readable { color: #595959; background: var(--paper); }

.tile { padding: var(--gap); border: 1px solid #e6e6e6; }

/* Icon buttons state their own colours. Left to the user agent's defaults they
   compute to a contrast axe reports -- correctly -- as too low, which would make
   the CLEAN control genuinely defective. The control has to be clean because it
   is correct, never because the finding was filtered out afterwards. */
button { color: var(--ink); background: #f0f0f0; border: 1px solid #767676; }

/* The oldest trick in accessibility: put it off the left of the world so it is
   read but not seen. A skip link and visually-hidden text are CORRECT, and an
   overflow detector that blames them is worse than useless -- they sort to the
   top, so the two most prominent findings on a well-built page are its
   accessibility features. Present in BOTH variants, never reported in either. */
/* A data table that genuinely needs its width. At 320 it overflows, and WCAG 2.2
   SC 1.4.10 exempts content requiring a two-dimensional layout -- so the audit
   may report the GEOMETRY and must not call it a failure. */
.wide-table { border-collapse: collapse; }
.wide-table th, .wide-table td { border: 1px solid #767676; padding: 4px 10px; white-space: nowrap; }

.sr-only { position: absolute; left: -9999px; width: 1px; height: 1px; }
.skip-link { position: absolute; left: -10000px; top: 0; }
`;

// The defects, as CSS. A fixed 520px banner fits at 768 and 1440 and only breaks
// out of a 375px phone -- which is what makes it a viewport-specific finding
// rather than a finding that happens to mention a viewport.
const BROKEN_CSS = `${BASE_CSS}
.banner-overflow {
  width: 520px;
  height: 56px;
  background: var(--brand);
}

/* #999 on #fff computes to 2.84:1 -- under the 4.5:1 that SC 1.4.3 asks for. */
.faint { color: #999999; background: var(--paper); }
`;

const CLEAN_CSS = `${BASE_CSS}
/* The same banner, constrained. Same element, same place, no overflow. */
.banner-overflow {
  width: 100%;
  max-width: 520px;
  height: 56px;
  background: var(--brand);
}

.faint { color: #595959; background: var(--paper); }
`;

const LAYOUT = `---
import '../styles/audit.css';
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Audit fixture</title>
  </head>
  <body>
    <main class="wrap">
      <slot />
    </main>
  </body>
</html>
`;

// A 1x1 transparent GIF, so the fixture needs no binary asset on disk.
const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * The page.
 *
 * `broken` decides only which half of each PAIR is defective. The structure,
 * the order and the element count are identical in both, so a diff of the two
 * rendered pages is exactly the seeded defects and nothing else.
 */
const page = (broken) => `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <a class="skip-link" href="#end">Skip to content</a>
  <span class="sr-only">Visually hidden, and correct</span>
  <h1>Audit fixture</h1>

  <!-- SEED 1 / CONTROL 1: horizontal overflow, phone only.
       Broken: a fixed 520px banner in a 375px viewport.
       Clean:  the same banner with max-width, so it fits everywhere. -->
  <div class="banner-overflow">Banner</div>
  <div class="tile">A tile that has always fitted its container.</div>

  <!-- CONTROL: intentional sideways scroll. Wider than every viewport, at every
       viewport, on purpose. Must NEVER be reported. -->
  <div class="carousel">
    <div class="carousel-row"></div>
  </div>

  <!-- SEED 2 / CONTROL 2: contrast. -->
  <p class="${broken ? 'faint' : 'readable'}">Text that has to be read.</p>
  <p class="readable">Text that has always been readable.</p>

  <!-- SEED 3 / CONTROL 3: an input with no accessible name.
       No placeholder on the broken one -- a placeholder would give it a name. -->
  ${broken ? '<input type="email" />' : '<label for="mail">Email</label><input id="mail" type="email" />'}
  <label for="mail-ok">Postcode</label><input id="mail-ok" type="text" />

  <!-- SEED 4 / CONTROL 4: a button with no discernible text. -->
  ${broken ? '<button><span aria-hidden="true">&#10005;</span></button>' : '<button aria-label="Dismiss"><span aria-hidden="true">&#10005;</span></button>'}
  <button aria-label="Open menu"><span aria-hidden="true">&#9776;</span></button>

  <!-- SEED 5 / CONTROL 5: a meaningful image with no alternative. -->
  ${broken ? `<img src="${PIXEL}" width="48" height="48" />` : `<img src="${PIXEL}" width="48" height="48" alt="A small marker" />`}
  <img src="${PIXEL}" width="48" height="48" alt="A described marker" />

  <!-- SEED 6: an id used by a label, duplicated. axe returns this as INCOMPLETE
       rather than as a violation, which is the point of seeding it: the third
       bucket has to be real, and it has to survive to the caller as its own kind. -->
  ${broken ? '<label for="dup">First</label><input id="dup" /><input id="dup" />' : '<label for="dup">First</label><input id="dup" />'}

  <div id="end"></div>
</Base>
`;

// A second route that is clean in BOTH projects. If an audit of /clean ever
// reports anything, the detector is reporting on the fixture's shape rather than
// on its defects.
const CONTROL_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <a class="skip-link" href="#end">Skip to content</a>
  <span class="sr-only">Visually hidden, and correct</span>
  <h1>Control</h1>
  <div class="tile">Nothing here is wrong at any width.</div>
  <div class="carousel"><div class="carousel-row"></div></div>
  <p class="readable">Readable text.</p>
  <label for="q">Search</label><input id="q" type="search" />
  <button aria-label="Go"><span aria-hidden="true">&#8594;</span></button>
  <img src="${PIXEL}" width="48" height="48" alt="A described marker" />
  <div id="end"></div>
</Base>
`;

// MORE INSTANCES OF ONE RULE THAN THE PER-RULE CAP.
//
// The audit takes at most AXE_NODES_PER_RULE (12) nodes per rule out of the page.
// Seventeen is enough to prove the difference between "there were 12" and "there
// were 17 and you were shown 12" -- which is the whole truncation contract.
// Each image is distinguishable so a reader can see which ones came back.
// THE SC 1.4.10 EXCEPTION, on a route of its own.
//
// A timetable is wide because a timetable IS wide. WCAG 2.2 exempts content that
// needs a two-dimensional layout for its meaning, and a geometry probe cannot
// tell such a table from a layout that simply failed to reflow -- which is the
// whole reason 320px overflow may not promote itself to a standards verdict.
//
// It lives here rather than on /audit because it overflows at 375 as well, and on
// the shared page it displaced the seeded banner as the first culprit. A fixture
// that perturbs the corpus it sits in is a fixture in the wrong place.
const TABLE_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>Timetable</h1>
  <table class="wide-table">
    <caption>Services</caption>
    <thead><tr><th>Service</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th></tr></thead>
    <tbody><tr><td>Early</td><td>06:00</td><td>06:00</td><td>06:00</td><td>06:00</td><td>06:00</td><td>07:30</td><td>08:30</td></tr></tbody>
  </table>
  <div id="end"></div>
</Base>
`;

// MORE OVERFLOWING ELEMENTS THAN THE GEOMETRY CAP (40).
//
// The axe path had /many; the geometry path had nothing, and that is exactly why
// its pre-cap accounting could be broken twice without a test noticing. Fifty
// unconstrained 520px blocks overflow a 375px phone, so the in-page walk finds
// fifty and may hand back at most forty.
const WIDE_COUNT = 50;
const WIDE_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>Many wide</h1>
${Array.from({ length: WIDE_COUNT }, (_, i) => `  <div class="banner-overflow" data-n="${i + 1}">Wide ${i + 1}</div>`).join('\n')}
  <div id="end"></div>
</Base>
`;

const MANY_COUNT = 17;
const MANY_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>Many</h1>
${Array.from({ length: MANY_COUNT }, (_, i) => `  <img src="${PIXEL}" width="24" height="24" data-n="${i + 1}" />`).join('\n')}
  <div id="end"></div>
</Base>
`;

// TWO ROUTES THAT PROVE AUDIT SESSIONS DO NOT BLEED.
//
// /setstate writes a cookie and a localStorage value as the page loads.
// /seestate reports whatever it can see. Two audits, same origin, same project --
// which is exactly what a person auditing a route twice does. If audit N+1 reads
// what audit N wrote, the audit browser is not isolated.
//
// Measured before this was fixed: the second audit read back `probe=FROM_A` and
// `FROM_A`. A partition that is not `persist:` is not written to disk; it is very
// much shared between windows.
const AUDIT_STATE_VALUE = 'STACKI_AUDIT_STATE_PROBE_V1';
const SET_STATE_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>set</h1>
  <script is:inline>
    document.cookie = 'stacki_audit_probe=${AUDIT_STATE_VALUE}; path=/';
    try { localStorage.setItem('stacki_audit_probe', '${AUDIT_STATE_VALUE}'); } catch (e) {}
  </script>
  <div id="end"></div>
</Base>
`;
const SEE_STATE_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>see</h1>
  <div id="seen"></div>
  <script is:inline>
    // THE OBSERVATION HAS TO BECOME A FINDING.
    //
    // An audit reports findings, not page text, so this page turns "I can see the
    // previous audit's state" into something the accessibility engine detects: an
    // image with no alternative. Leaked state -> image-alt fires. Clean session ->
    // the same image with a proper alt, and nothing fires.
    var leaked = false;
    if (document.cookie.indexOf('stacki_audit_probe') >= 0) leaked = true;
    try { if (localStorage.getItem('stacki_audit_probe')) leaked = true; } catch (e) {}
    var img = document.createElement('img');
    img.src = '${PIXEL}';
    img.width = 40; img.height = 40;
    img.setAttribute('data-leaked', leaked ? 'yes' : 'no');
    if (!leaked) img.alt = 'Nothing carried over from the previous audit';
    document.getElementById('seen').appendChild(img);
  </script>
  <div id="end"></div>
</Base>
`;

// ROUTES THAT TRY TO LEAVE THE PROJECT.
//
// A server-side redirect is not a navigation the page initiated, so
// `will-navigate` never fires for it. Measured against the engine before this was
// guarded: a project route answering 302 to a second local origin had that origin
// loaded, axe run on it, and three of ITS findings returned under the project's
// own route and URL.
//
// The outside port is fixed so the test can listen on it and assert it was never
// contacted -- refusing after fetching would still be a leak.
const OUTSIDE_ORIGIN_PORT = 45999;
const REDIRECT_OUT_ENDPOINT = `export function GET() {
  return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:${OUTSIDE_ORIGIN_PORT}/landed' } });
}
`;
const REDIRECT_IN_ENDPOINT = `export function GET() {
  return new Response(null, { status: 302, headers: { location: '/clean' } });
}
`;
// A page that sends ITSELF somewhere else, which is the other half of the
// contract: same-origin is ordinary visitor behaviour, off-origin is refused.
const NAVIGATE_OUT_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>going</h1>
  <script is:inline>location.href = 'http://127.0.0.1:${OUTSIDE_ORIGIN_PORT}/landed';</script>
  <div id="end"></div>
</Base>
`;

// THE DELAY IS SIZED AGAINST THE ENGINE, NOT PICKED.
//
// The audit's measurement window runs from did-finish-load through SETTLE_MS
// (250ms) and the probes. A navigation has to START inside that window to be
// what these pages are about, and for the same-origin one it has to COMMIT
// inside it too, because what `finalRoutes` reports is the document that was
// actually MEASURED -- one that commits after the last probe changed nothing and
// must not be claimed. Measured at 300ms: the block was caught (it is instant)
// and the same-origin landing was not (it still had a request to make). 100ms
// leaves both comfortably inside.
const LATE_MS = 100;

// A PAGE THAT WAITS, THEN LEAVES. The refusal for a navigation that happens
// DURING measurement is a different code path from one that happens during the
// load: the block was read once, right after did-finish-load, and a page that
// waited had its navigation cancelled and reported as an ordinary clean audit.
const LATE_OUT_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>waiting</h1>
  <script is:inline>
    addEventListener('load', () => setTimeout(() => {
      location.href = 'http://127.0.0.1:${OUTSIDE_ORIGIN_PORT}/late';
    }, ${LATE_MS}));
  </script>
</Base>
`;
// The same timing, staying at home: the document that gets measured is /clean,
// and saying so is the whole point of finalRoutes.
const LATE_IN_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>moving along</h1>
  <script is:inline>
    addEventListener('load', () => setTimeout(() => { location.href = '/clean'; }, ${LATE_MS}));
  </script>
</Base>
`;
// AN OFF-ORIGIN DOCUMENT INSIDE THE PAGE. `will-navigate` is the main frame's
// event, so an iframe was fetched and rendered in the audit window while the
// guard reported nothing. The title is real so the embed itself does not seed a
// frame-title violation and confuse what this page is for.
const FRAME_OUT_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>embedded</h1>
  <iframe src="http://127.0.0.1:${OUTSIDE_ORIGIN_PORT}/framed" width="240" height="160" title="an off-origin embed"></iframe>
</Base>
`;

// A FRAME WHOSE FIRST HOP IS INNOCENT.
//
// The iframe's src is SAME ORIGIN, so the frame's first navigation is allowed --
// and then its own server answers 302 to somewhere else. That redirect arrives as
// `will-redirect` for a subframe, which a main-frame-only redirect guard ignored:
// measured against that code the second origin served two requests, the document
// and an image inside it, with ok:true and nothing named as blocked.
const FRAME_REDIRECT_ENDPOINT = `export function GET() {
  return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:${OUTSIDE_ORIGIN_PORT}/frame-redirect-landed' } });
}
`;
const FRAME_REDIRECT_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>host page</h1>
  <iframe src="/frame-redirect" width="240" height="160" title="a same-origin embed"></iframe>
</Base>
`;
// THE CONTROL. Identical shape, and the redirect stays at home. A guard that
// refuses this one has not fixed the leak, it has broken ordinary pages: a frame
// that 302s within the project is normal browser behaviour.
const FRAME_REDIRECT_IN_ENDPOINT = `export function GET() {
  return new Response(null, { status: 302, headers: { location: '/clean' } });
}
`;
const FRAME_REDIRECT_IN_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>host page, staying home</h1>
  <iframe src="/frame-redirect-in" width="240" height="160" title="a same-origin embed"></iframe>
</Base>
`;

/** The files, for a broken or a clean variant of the fixture. */
function auditFixture({ broken }) {
  return {
    'src/styles/audit.css': broken ? BROKEN_CSS : CLEAN_CSS,
    'src/layouts/AuditBase.astro': LAYOUT,
    'src/pages/audit.astro': page(broken),
    'src/pages/clean.astro': CONTROL_PAGE,
    'src/pages/many.astro': MANY_PAGE,
    'src/pages/table.astro': TABLE_PAGE,
    'src/pages/wide.astro': WIDE_PAGE,
    'src/pages/redirect-out.js': REDIRECT_OUT_ENDPOINT,
    'src/pages/redirect-in.js': REDIRECT_IN_ENDPOINT,
    'src/pages/navigate-out.astro': NAVIGATE_OUT_PAGE,
    'src/pages/late-out.astro': LATE_OUT_PAGE,
    'src/pages/late-in.astro': LATE_IN_PAGE,
    'src/pages/frame-out.astro': FRAME_OUT_PAGE,
    'src/pages/frame-redirect.js': FRAME_REDIRECT_ENDPOINT,
    'src/pages/frame-redirect-page.astro': FRAME_REDIRECT_PAGE,
    'src/pages/frame-redirect-in.js': FRAME_REDIRECT_IN_ENDPOINT,
    'src/pages/frame-redirect-in-page.astro': FRAME_REDIRECT_IN_PAGE,
    'src/pages/setstate.astro': SET_STATE_PAGE,
    'src/pages/seestate.astro': SEE_STATE_PAGE,
  };
}

// What the broken fixture is supposed to produce, as data, so the test asserts
// against a checked-in expectation rather than against whatever came back.
//
// `viewports` is the exact set the finding must appear at -- null means "every
// viewport audited". Getting this wrong in the permissive direction is how a
// viewport-specific check quietly stops being viewport-specific.
const SEEDED = [
  { ruleId: 'horizontal-overflow', kind: 'mechanical', viewports: ['phone'], where: 'banner-overflow' },
  { ruleId: 'color-contrast', kind: 'standard', viewports: null, where: 'faint' },
  { ruleId: 'label', kind: 'standard', viewports: null, where: 'input' },
  { ruleId: 'button-name', kind: 'standard', viewports: null, where: 'button' },
  { ruleId: 'image-alt', kind: 'standard', viewports: null, where: 'img' },
];

// Seeded, but expected in the `incomplete` bucket rather than as a violation.
const SEEDED_INCOMPLETE = [{ ruleId: 'duplicate-id-aria', kind: 'incomplete' }];

// Rules that must NEVER fire on either project. The carousel is the reason this
// list exists.
const MUST_NOT_FIRE_ON_CLEAN = ['horizontal-overflow', 'color-contrast', 'label', 'button-name', 'image-alt'];

module.exports = { auditFixture, SEEDED, SEEDED_INCOMPLETE, MUST_NOT_FIRE_ON_CLEAN, BASE_CSS, MANY_COUNT, WIDE_COUNT, AUDIT_STATE_VALUE, OUTSIDE_ORIGIN_PORT };
