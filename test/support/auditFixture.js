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
</Base>
`;

// A second route that is clean in BOTH projects. If an audit of /clean ever
// reports anything, the detector is reporting on the fixture's shape rather than
// on its defects.
const CONTROL_PAGE = `---
import Base from '../layouts/AuditBase.astro';
---
<Base>
  <h1>Control</h1>
  <div class="tile">Nothing here is wrong at any width.</div>
  <div class="carousel"><div class="carousel-row"></div></div>
  <p class="readable">Readable text.</p>
  <label for="q">Search</label><input id="q" type="search" />
  <button aria-label="Go"><span aria-hidden="true">&#8594;</span></button>
  <img src="${PIXEL}" width="48" height="48" alt="A described marker" />
</Base>
`;

/** The files, for a broken or a clean variant of the fixture. */
function auditFixture({ broken }) {
  return {
    'src/styles/audit.css': broken ? BROKEN_CSS : CLEAN_CSS,
    'src/layouts/AuditBase.astro': LAYOUT,
    'src/pages/audit.astro': page(broken),
    'src/pages/clean.astro': CONTROL_PAGE,
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

module.exports = { auditFixture, SEEDED, SEEDED_INCOMPLETE, MUST_NOT_FIRE_ON_CLEAN, BASE_CSS };
