// A real Astro project, for the acceptance that needs a real render.
//
// agent-acceptance.js proves the source half of the Agent API against the real
// parser, the real serializer and real files, with no browser. That is most of
// it and it is not all of it: this feature's whole claim is
//
//   visual object → exact Stacki object → semantic edit → rendered result
//
// and the two ends of that sentence need a canvas. Computed styles come from an
// engine. Rendered classes come from a page that ran. `capture` is a photograph.
// None of them can be checked without something painting.
//
// So this writes a project with Astro genuinely installed in it, and the markup
// is chosen rather than convenient — every construct here is one the Agent API
// gets wrong if something is off:
//
//   {show && ( … )}     a node inside a conditional had no source offset at all
//                       before upstream 0.1.21. Its line range is the check.
//   ternary branches    the same, on both sides.
//   <Fragment slot>     renders nothing of its own, and the page answers about
//                       the component's root div when asked what it rendered
//                       with. The model is the only thing that knows.
//   a loop              one source node, several rendered cards.
//   var(--gap)          a property whose value is somewhere else.
//   {site.tagline}      words that are not in the file.
//
// node_modules is expensive, so it is installed once into a cache directory and
// copied. `STACKI_CANVAS_CACHE` overrides where that lives.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ownedTempDir, releaseTempDir, sweepStaleRuns } = require('./support/ownedTemp.js');

const CACHE =
  process.env.STACKI_CANVAS_CACHE || path.join(os.tmpdir(), 'stacki-canvas-astro-cache');

const FILES = {
  'package.json': JSON.stringify(
    // Current Astro, not a pinned old major: the marker plugin this fixture
    // exists to exercise is written against what people are running, and a
    // fixture on an older major tests a combination nobody has.
    { name: 'stacki-canvas-fixture', type: 'module', private: true, dependencies: { astro: '^7' } },
    null,
    2
  ),
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",

  'src/styles/site.css': `:root {
  --gap: 12px;
  --brand: rgb(40, 80, 200);
}

.pricing-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap);
}

.card {
  padding: 16px;
  background: rgb(240, 240, 245);
}

.card h3 {
  margin: 0;
  color: var(--brand);
}

.hero h1 {
  font-size: 40px;
}

.section-title {
  margin: 24px 0 8px;
  font-size: 20px;
}
`,

  'src/data/site.json': JSON.stringify({ title: 'Canvas fixture', tagline: 'Words that live in a file' }, null, 2),

  // A Fragment in a slot, holding a component whose root div has a class of its
  // own. Asked what the Fragment rendered with, the page hands back that div —
  // which is exactly the confusion upstream 0.1.21 fixed.
  'src/components/Panel.astro': `---
const { title } = Astro.props;
---
<section class="panel">
  <h2>{title}</h2>
  <div class="panel_body">
    <slot name="column2" />
  </div>
</section>
`,

  'src/components/Inner.astro': `---
---
<div class="inner_wrap">
  <p>Inside the slot</p>
</div>
`,

  'src/components/Card.astro': `---
const { title, body } = Astro.props;
---
<article class="card">
  <h3>{title}</h3>
  <p>{body}</p>
</article>
`,

  // The conditional and the ternary, written the way components actually are.
  'src/components/Hero.astro': `---
const { heading, show = true, compact = false } = Astro.props;
---
<section class="hero">
  {show && (
    <div class="hero_inner">
      <h1>We're here for you</h1>
      <p>{heading}</p>
    </div>
  )}
  {compact ? (
    <small class="hero_note">Short version</small>
  ) : (
    <p class="hero_note">The longer note that this page shows by default</p>
  )}
</section>
`,

  'src/layouts/Base.astro': `---
import '../styles/site.css';
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Canvas fixture</title>
  </head>
  <body>
    <slot />
  </body>
</html>
`,

  // A heading the PAGE owns.
  //
  // Everything else on this page is a component — Hero, Card, Panel — and a
  // rendered node inside a component resolves to the component's usage in the
  // file that is open, because that is the outermost thing the open file owns.
  // So index.astro had nothing inner and source-backed of its own, and a review
  // left anywhere on it anchored to <Hero> or <Base>. Removing one of those to
  // make an orphan removes the page.
  //
  // One heading fixes that: something narrow, declared here, that can be cut
  // out while the pricing cards and the panel carry on rendering. See
  // 20-orphaned-review in test/review-ux-export.js.
  'src/pages/index.astro': `---
import Base from '../layouts/Base.astro';
import Hero from '../components/Hero.astro';
import Card from '../components/Card.astro';
import Panel from '../components/Panel.astro';
import Inner from '../components/Inner.astro';
import site from '../data/site.json';

const plans = [
  { title: 'Starter', body: 'For one person' },
  { title: 'Team', body: 'For a few people' },
  { title: 'Company', body: 'For a lot of people' },
];
---
<Base>
  <Hero heading={site.tagline} />
  <h2 class="section-title">Plans</h2>
  <div class="pricing-grid">
    {plans.map((plan) => (
      <Card title={plan.title} body={plan.body} />
    ))}
  </div>
  <Panel title="A panel">
    <Fragment slot="column2">
      <Inner />
    </Fragment>
  </Panel>
</Base>
`,

  'public/robots.txt': 'User-agent: *\nAllow: /\n',
};

/**
 * Astro, installed once.
 *
 * A real npm install, into a real node_modules — not a symlink farm. The app's
 * own test harness has been confused by a pnpm layout before, and a dev server
 * that cannot resolve its own package is not a test of anything.
 */
function ensureAstro({ log = () => {} } = {}) {
  const marker = path.join(CACHE, 'node_modules', 'astro', 'package.json');
  if (fs.existsSync(marker)) return CACHE;
  log(`installing astro into ${CACHE} (once)`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'package.json'), FILES['package.json'], 'utf8');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: CACHE,
    stdio: 'pipe',
    timeout: 300000,
  });
  if (!fs.existsSync(marker)) throw new Error('astro did not install into the cache');
  return CACHE;
}

/** Whether the cache is already there, so a caller can decide about the network. */
const astroCached = () => fs.existsSync(path.join(CACHE, 'node_modules', 'astro', 'package.json'));

/** Write the project, with node_modules copied in from the cache. */
function makeCanvasProject({ log = () => {}, harness = 'canvas-fixture' } = {}) {
  ensureAstro({ log });
  // Marked as this run's, so a harness starting up beside this one can tell
  // the difference between a fixture in use and a fixture left by a run that
  // died. See test/support/ownedTemp.js — the prefix alone used to be the
  // whole test, and `stacki-canvas-` is the prefix every canvas harness uses.
  const root = ownedTempDir('stacki-canvas-', { harness });
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  // Copied rather than linked: a symlinked node_modules is the layout that has
  // confused this app's harnesses before, and the point of this fixture is to
  // be ordinary.
  fs.cpSync(path.join(CACHE, 'node_modules'), path.join(root, 'node_modules'), {
    recursive: true,
    dereference: false,
  });
  return root;
}

/** A project this run made, removed by the run that made it. */
const removeCanvasProject = (root) => releaseTempDir(root);

module.exports = { makeCanvasProject, removeCanvasProject, ensureAstro, astroCached, sweepStaleRuns, FILES, CACHE };
