// The awkward project.
//
// agent-canvas-fixture.js is a small, well-behaved Astro site: it exists to
// prove the ordinary path works on a real dev server. This one exists to be
// difficult on purpose, because every honest answer the Agent API gives about
// a node — where its text comes from, how many copies of it exist, which rule
// is actually painting it — is easy on a flat page and hard here.
//
// So it holds, deliberately and in one place: components inside components
// inside slots, Fragments, conditionals, ternaries nested two deep, maps
// nested inside maps, the same component repeated, text that is literal, text
// that is bound, text that is both in the same element, frontmatter constants,
// props, spread props, `class` and `class:list`, custom properties, an inline
// <style>, an external stylesheet with conflicting specificity and a media
// query, a content collection, a JSON file used as a CMS, a dynamic route with
// getStaticPaths, an asset that exists, an import that does not resolve, and a
// page with thousands of markable nodes.
//
// Nothing here is a mock. It installs Astro and runs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureAstro, CACHE } = require('./agent-canvas-fixture.js');

// --- the pages that are written out by hand ---------------------------------

const FILES = {
  'package.json': JSON.stringify(
    { name: 'stacki-stress-fixture', type: 'module', private: true, dependencies: { astro: '^7' } },
    null,
    2
  ),
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",

  // --- styles: two sheets that disagree, on purpose -------------------------
  //
  // `.card .title` and `.title` both match the same element and say different
  // things; the media query says a third. A style read that cannot say which
  // one is winning, and which are merely present, is not answering the
  // question anyone asked.
  'src/styles/global.css': `:root {
  --gap: 12px;
  --brand: rgb(20, 80, 200);
  --brand-soft: color-mix(in srgb, var(--brand) 40%, white);
  --title-size: 20px;
  --missing-on-purpose: var(--not-defined-anywhere, 4px);
}

body {
  color: rgb(30, 30, 40);
  font-family: system-ui, sans-serif;
}

.title {
  font-size: 16px;
  color: rgb(90, 90, 90);
}

.card .title {
  font-size: var(--title-size);
  color: var(--brand);
}

.card .title.is-lead {
  font-weight: 700;
}

.card {
  padding: var(--gap);
  background: rgb(245, 245, 250);
  border: 1px solid var(--brand-soft);
}

.stack > * + * {
  margin-top: var(--gap);
}

.pinned {
  color: rgb(200, 20, 20) !important;
}

@media (max-width: 600px) {
  .card .title {
    font-size: 13px;
  }
}
`,

  'src/styles/late.css': `/* Loaded after global.css: same specificity, later wins. */
.card .title {
  letter-spacing: -0.01em;
}
`,

  // --- data used as a CMS ---------------------------------------------------
  'src/data/site.json': JSON.stringify(
    {
      title: 'Stress fixture',
      tagline: 'Words that live in a JSON file',
      footer: { note: 'Reached through two hops' },
      plans: [
        { id: 'free', name: 'Free', price: '0', blurb: 'For trying it out' },
        { id: 'team', name: 'Team', price: '19', blurb: 'For a few people' },
        { id: 'scale', name: 'Scale', price: '99', blurb: 'For a lot of people' },
      ],
    },
    null,
    2
  ),

  // --- content collection ---------------------------------------------------
  'src/content.config.ts': `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    tag: z.string(),
    order: z.number(),
  }),
});

export const collections = { posts };
`,

  'src/content/posts/first.md': `---
title: The first post
tag: intro
order: 1
---

The body of the first post.
`,
  'src/content/posts/second.md': `---
title: The second post
tag: notes
order: 2
---

The body of the second post.
`,

  // --- components -----------------------------------------------------------
  //
  // Shell renders a slot. Card goes in the slot. Inner goes in Card. Deep goes
  // in Inner. That is four levels of component nesting with a slot boundary in
  // the middle, which is the shape a component chain has to survive.
  'src/components/Shell.astro': `---
const { label = 'shell', ...rest } = Astro.props;
---

<section class="shell" data-label={label} {...rest}>
  <slot />
</section>
`,

  'src/components/Deep.astro': `---
const { word } = Astro.props;
---

<em class="deep">{word}</em>
`,

  'src/components/Inner.astro': `---
import Deep from './Deep.astro';
const { word, tone = 'plain' } = Astro.props;
const suffix = 'inner';
---

<span class="inner" data-tone={tone}>
  <Deep word={word} /> — {suffix}
</span>
`,

  // Literal text, bound text, and both in one element. `class:list` alongside
  // a plain `class` on a sibling, so a class read has to handle each.
  'src/components/Card.astro': `---
import Inner from './Inner.astro';
const { title, lead = false, note, word = 'nested' } = Astro.props;
const FOOTER = 'from a frontmatter const';
---

<article class="card">
  <h3 class:list={['title', { 'is-lead': lead }]}>{title}</h3>
  <p class="body">Literal words only.</p>
  <p class="mixed">Before {title} after</p>
  <p class="bound">{note}</p>
  <Inner word={word} />
  <footer class="foot">{FOOTER}</footer>
</article>
`,

  'src/components/Repeat.astro': `---
const { index } = Astro.props;
---

<li class="repeat">Copy number {index}</li>
`,

  // --- layout ---------------------------------------------------------------
  'src/layouts/Base.astro': `---
import '../styles/global.css';
import '../styles/late.css';
const { title } = Astro.props;
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>
      .inline-styled {
        outline: 1px dashed var(--brand);
        padding: 4px;
      }
    </style>
  </head>
  <body>
    <slot />
  </body>
</html>
`,

  // --- the kitchen-sink page ------------------------------------------------
  'src/pages/index.astro': `---
import Base from '../layouts/Base.astro';
import Shell from '../components/Shell.astro';
import Card from '../components/Card.astro';
import Repeat from '../components/Repeat.astro';
import site from '../data/site.json';

const heading = site.title;
const show = true;
const mode = 'b';
const level = 2;
const spread = { 'data-spread': 'yes', id: 'spread-target' };
const groups = [
  { name: 'first', items: ['one', 'two'] },
  { name: 'second', items: ['three', 'four', 'five'] },
];
---

<Base title={heading}>
  <h1 class="page-title">{heading}</h1>
  <p class="tagline">{site.tagline}</p>
  <p class="inline-styled">Styled by the inline sheet</p>

  {show && <p class="conditional">Only when show is true</p>}

  <p class="ternary">{mode === 'a' ? 'branch A' : 'branch B'}</p>

  <p class="nested-ternary">{level === 1 ? 'one' : level === 2 ? 'two' : 'many'}</p>

  <Fragment>
    <p class="in-fragment">Inside a Fragment</p>
  </Fragment>

  <Shell label="outer" {...spread}>
    <Card title="First card" lead={true} note={site.footer.note} />
    <Card title="Second card" note={site.plans[0].blurb} word="deeper" />
  </Shell>

  <ul class="repeat-list">
    {[0, 1, 2, 3].map((index) => <Repeat index={index} />)}
  </ul>

  <div class="groups">
    {groups.map((group) => (
      <div class="group">
        <h4 class="group-name">{group.name}</h4>
        <ul>
          {group.items.map((item) => <li class="group-item">{item}</li>)}
        </ul>
      </div>
    ))}
  </div>

  <img class="asset" src="/pixel.png" alt="a real asset" width="8" height="8" />
</Base>
`,

  // --- loops at three sizes -------------------------------------------------
  'src/pages/loops.astro': `---
import Base from '../layouts/Base.astro';
const four = Array.from({ length: 4 }, (_, i) => ({ id: i, label: \`item \${i}\` }));
const twenty = Array.from({ length: 20 }, (_, i) => ({ id: i, label: \`row \${i}\` }));
const twoHundred = Array.from({ length: 200 }, (_, i) => ({ id: i, label: \`cell \${i}\` }));
---

<Base title="Loops">
  <ul class="four">{four.map((it) => <li class="four-item">{it.label}</li>)}</ul>
  <ul class="twenty">{twenty.map((it) => <li class="twenty-item">{it.label}</li>)}</ul>
  <ul class="two-hundred">{twoHundred.map((it) => <li class="two-hundred-item">{it.label}</li>)}</ul>
</Base>
`,

  // --- a dynamic route ------------------------------------------------------
  'src/pages/blog/[slug].astro': `---
import { getCollection } from 'astro:content';
import Base from '../../layouts/Base.astro';

export async function getStaticPaths() {
  const posts = await getCollection('posts');
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}

const { post } = Astro.props;
---

<Base title={post.data.title}>
  <h1 class="post-title">{post.data.title}</h1>
  <p class="post-tag">{post.data.tag}</p>
</Base>
`,
};

// A page that does not resolve its import.
//
// NOT part of the baseline: an unresolved import fails the whole build, not
// just the page holding it, so a fixture that shipped this could never be
// built as a sanity check. Phase 22 writes it when it wants something honestly
// broken, and deletes it again.
const BROKEN_PAGE = `---
import Missing from '../components/DoesNotExist.astro';
---

<Missing />
`;

/** An 8×8 PNG, so the asset domain has a real image with real dimensions. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFIoASA' +
    'GAAABAAEAAe0aWQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * A page with thousands of markable nodes.
 *
 * Written rather than looped in the template on purpose: a `.map` over 3000
 * items is one marked node rendered 3000 times, and that is Phase 7's problem.
 * This is 3000 *distinct* nodes, which is what makes a page big for the parser,
 * the marker plugin and the tree.
 */
function bigPage(rows = 600) {
  const block = (i) => `  <section class="big-row" data-row="${i}">
    <h2 class="big-head">Row ${i}</h2>
    <p class="big-text">Text for row ${i}</p>
    <span class="big-tag">tag-${i}</span>
    <a class="big-link" href="#row-${i}">link ${i}</a>
  </section>`;
  return `---
import Base from '../layouts/Base.astro';
---

<Base title="Big">
${Array.from({ length: rows }, (_, i) => block(i)).join('\n')}
</Base>
`;
}

/**
 * Write the fixture into a fresh temp directory with a real node_modules.
 *
 * `realpathSync` for the same reason the canvas fixture does it: on macOS the
 * temp directory is under a symlink, Vite resolves ids to real paths, and a
 * project opened at the symlinked spelling renders with no markers in it.
 */
function makeStressProject({ log = () => {}, rows = 600 } = {}) {
  ensureAstro({ log });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-stress-')));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'src/pages/big.astro'), bigPage(rows), 'utf8');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/pixel.png'), PIXEL_PNG);
  fs.mkdirSync(path.join(root, 'src/assets/nested/deeper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/assets/nested/deeper/note.txt'), 'a text asset\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src/assets/held by spaces.txt'), 'spaces in the name\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src/assets/ünïcödé-ﬁle.txt'), 'unicode in the name\n', 'utf8');
  fs.cpSync(path.join(CACHE, 'node_modules'), path.join(root, 'node_modules'), {
    recursive: true,
    dereference: false,
  });
  return root;
}

const removeStressProject = (root) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* a temp folder that will not go is not a test failure */
  }
};

module.exports = { makeStressProject, removeStressProject, FILES, bigPage, PIXEL_PNG, BROKEN_PAGE };
