// A real Astro project with real content collections, for the six content
// suites — content-config, content-entries, content-refs, content-fields,
// content-view and cms-panel.
//
// Those six used to point at `~/Downloads/awesome-client-main`: a personal,
// uncommitted folder. It is not on this machine, it cannot be on a GitHub
// runner, and every one of the six answered a missing fixture by printing
// "skipped" and exiting 0. Roughly 179 check() sites had never run anywhere.
//
// So the fixture is owned by the tests. The mechanism is the one the repo
// already has: test/agent-canvas-fixture.js installs Astro ONCE into a cache
// directory (STACKI_CANVAS_CACHE) and copies node_modules out of it, and this
// reuses that cache rather than starting a second one. The project's own
// esbuild and its own `astro/zod` are what electron/contentConfig.js runs — it
// bundles src/content.config.ts with the project's esbuild and leaves
// `astro/zod` external so the config's schemas and our introspection share one
// zod instance — so a fixture without a real node_modules is not a fixture at
// all.
//
// What is in here is chosen, not decorative. Every collection below exists
// because one of the six suites asserts something about it that an editor gets
// wrong if the reader is wrong:
//
//   26 collections     the CMS panel counts them, and a panel that shows
//                      nothing looks exactly like a project with nothing in it.
//   five loader kinds  glob, file, file-with-a-parser, glob-with-generateId,
//                      and somebody's own loader — which is the difference
//                      between a collection you can save to and one whose
//                      entries are rebuilt from scratch on the next sync.
//   nine formats       md, mdx, mdoc, json (array, keyed, and one file per
//                      entry), yaml (flat and grouped), csv, ndjson, toml.
//                      Each one is patched rather than re-serialized, and the
//                      test of that is a diff nobody has to read twice.
//   a 12-way union     blocks on a landing page, with an image in one branch
//                      and a reference in another.
//   a 5-way union      at ENTRY level: each settings record is a different
//                      kind of thing, so the form is a type switcher.
//   z.lazy recursion   navigation points at itself, and has to come back as a
//                      $ref rather than unrolling forever.
//   two transforms     testimonials.featured is the string "true" on disk and
//                      a boolean in the entry.
//   cross-field rules  jobs and recipes, which no single field can enforce.
//   a loose object     notes, where a field nobody declared must survive a save.
//   no schema at all   legal, where every key is the user's.

const fs = require('fs');
const path = require('path');
const { ensureAstro, astroCached, CACHE } = require('../agent-canvas-fixture.js');
const { ownedTempDir, releaseTempDir, sweepStaleRuns } = require('./ownedTemp.js');

/** The prefix every content fixture uses, so a sweep can recognise its own. */
const PREFIX = 'stacki-content-fixture-';

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'stacki-content-fixture',
    type: 'module',
    private: true,
    // js-yaml is astro's own direct dependency, which is why the FAQ parser
    // below can import it: a project that has Astro installed has it.
    dependencies: { astro: '^7', 'js-yaml': '^4' },
  },
  null,
  2
);

const LOADERS_TS = `// Loaders that build their entries somewhere other than this repo.
//
// None of them stores anything: the events come from a calendar API, the
// releases from the forge, the icons from a package on disk, the announcements
// from a spreadsheet, and buildInfo from the build that is running. Astro calls
// load() on every sync and replaces whatever was there, so an editor that
// offered a save button over one of these would be writing into a file that the
// next build overwrites. Stacki reads that from the loader's shape — no glob(),
// no file(), therefore read-only — which is what electron/content/
// stub-astro-loaders.mjs is deciding.

const remote = (name, source) => ({
  name,
  load: async () => {
    throw new Error(\`\${name} only runs during a build (source: \${source}).\`);
  },
});

export const eventsLoader = (source) => remote('events-loader', source);
export const releasesLoader = (source) => remote('releases-loader', source);
export const iconLibraryLoader = (source) => remote('icon-library-loader', source);
export const announcementsLoader = (source) => remote('announcements-loader', source);
export const buildInfoLoader = () => remote('build-info-loader', 'the build itself');
`;

const PARSERS_TS = `// The two files whose records are not the shape Astro wants.
//
// A parser stands between the file and the collection, so what an entry holds
// is not what the file holds — and a field the parser invented has nowhere to
// be written back to. Stacki says so in the panel rather than drawing an
// editable box over it.

import { load } from 'js-yaml';

/**
 * faqs.yaml groups its questions under categories, because that is how the
 * page shows them. An entry is a question, and it carries the category it was
 * found under — a field that is in the entry and not in the file.
 */
export const parseFaqs = (text) => {
  const doc = load(text) || {};
  return (doc.categories || []).flatMap((category) =>
    (category.questions || []).map((question) => ({ ...question, category: category.slug }))
  );
};

/**
 * testimonials.csv is a spreadsheet export. Every cell is a string, including
 * the ones that are really numbers and the one that is really a boolean — the
 * schema is what turns them back, and the file keeps the strings.
 */
export const parseTestimonials = (text) => {
  const rows = text
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const header = split(rows.shift() || '');
  return rows.map((row) => Object.fromEntries(split(row).map((cell, i) => [header[i], cell])));
};

// Enough CSV for a file this project writes itself: quoted cells, doubled
// quotes inside them, commas anywhere else.
const split = (line) => {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
};
`;

const CONTENT_CONFIG_TS = `import { defineCollection, reference, z } from 'astro:content';
import { file, glob } from 'astro/loaders';
import {
  announcementsLoader,
  buildInfoLoader,
  eventsLoader,
  iconLibraryLoader,
  releasesLoader,
} from './loaders/remote';
import { parseFaqs, parseTestimonials } from './loaders/parsers';

// A landing page is a stack of blocks, and a block is one of twelve things.
// The image and the references live inside branches of the union, which is the
// awkward place for anything walking a schema to find them.
const blocks = (image) =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('hero'),
      heading: z.string().min(3).max(120),
      subheading: z.string().max(200).optional(),
      image: image().optional(),
    }),
    z.object({
      type: z.literal('features'),
      heading: z.string(),
      items: z.array(z.object({ title: z.string(), body: z.string() })).min(1),
    }),
    z.object({ type: z.literal('cta'), label: z.string(), href: z.string().url() }),
    z.object({
      type: z.literal('testimonialList'),
      heading: z.string(),
      quotes: z.array(reference('testimonials')).min(1),
    }),
    z.object({ type: z.literal('logos'), heading: z.string(), logos: z.array(image()).min(1) }),
    z.object({ type: z.literal('faq'), heading: z.string(), questions: z.array(reference('faqs')).min(1) }),
    z.object({
      type: z.literal('pricingTable'),
      heading: z.string(),
      plans: z.array(reference('pricingPlans')).min(1),
    }),
    z.object({ type: z.literal('richText'), markdown: z.string() }),
    z.object({
      type: z.literal('stats'),
      items: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
    }),
    z.object({ type: z.literal('video'), url: z.string().url(), caption: z.string().max(200).optional() }),
    z.object({ type: z.literal('gallery'), images: z.array(image()).min(1) }),
    z.object({ type: z.literal('spacer'), size: z.enum(['small', 'medium', 'large']) }),
  ]);

// Navigation holds itself. z.lazy is the only way to say that, and a reader
// that unrolls it instead of emitting a $ref never finishes.
const navItem = z.object({
  label: z.string().min(1),
  // A section header is a label with nothing behind it: the key is there, the
  // value is null. That is not the same as the key being absent.
  href: z.string().min(1).nullable(),
  children: z.array(z.lazy(() => navItem)).optional(),
});

export const collections = {
  // --- one file per entry, id from the path -------------------------------
  blog: defineCollection({
    loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
    schema: ({ image }) =>
      z.object({
        title: z.string().min(3).max(120),
        description: z.string().max(400),
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        author: reference('authors'),
        contributors: z.array(reference('authors')).default([]),
        heroImage: image().optional(),
        category: z.enum(['engineering', 'design', 'product', 'company']),
        tags: z.array(z.string()).min(1).max(8),
        draft: z.boolean().default(false),
        readingTime: z.number().int().min(1).max(60).optional(),
        relatedPosts: z.array(reference('blog')).optional(),
        seo: z
          .object({ ogImage: image().optional(), noindex: z.boolean().optional() })
          .optional(),
      }),
  }),

  docs: defineCollection({
    loader: glob({ base: './src/content/docs', pattern: '**/*.md' }),
    schema: z.object({
      title: z.string().min(3).max(120),
      summary: z.string().max(300),
      version: z.string().regex(/^\\d+\\.x$/),
      order: z.number().int().min(1),
      updatedAt: z.coerce.date(),
      maintainer: reference('authors').optional(),
      draft: z.boolean().default(false),
    }),
  }),

  tutorials: defineCollection({
    loader: glob({ base: './src/content/tutorials', pattern: '**/*.mdoc' }),
    schema: z.object({
      title: z.string().min(3).max(120),
      summary: z.string().max(300),
      author: reference('authors'),
      difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
      minutes: z.number().int().min(5).max(240),
      publishedAt: z.coerce.date(),
    }),
  }),

  caseStudies: defineCollection({
    loader: glob({ base: './src/content/case-studies', pattern: '**/*.mdx' }),
    schema: z.object({
      title: z.string().min(3).max(120),
      client: reference('clients'),
      author: reference('authors'),
      summary: z.string().max(300),
      industry: z.enum(['energy', 'logistics', 'retail', 'software']),
      publishedAt: z.coerce.date(),
      metrics: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
    }),
  }),

  recipes: defineCollection({
    loader: glob({ base: './src/content/recipes', pattern: '**/*.md' }),
    schema: z
      .object({
        title: z.string().min(3).max(120),
        servings: z.number().int().min(1).max(24),
        prepMinutes: z.number().int().min(0).max(600),
        cookMinutes: z.number().int().min(0).max(600),
        totalMinutes: z.number().int().min(0).max(1200),
        ingredients: z.array(z.string()).min(1),
      })
      .refine((r) => r.totalMinutes >= r.prepMinutes + r.cookMinutes, {
        message: 'The total time has to cover the preparation and the cooking.',
        path: ['totalMinutes'],
      }),
  }),

  // Every key in the file belongs to whoever wrote it.
  notes: defineCollection({
    loader: glob({ base: './src/content/notes', pattern: '**/*.md' }),
    schema: z.looseObject({
      title: z.string().min(3).max(120),
      takenAt: z.coerce.date(),
      attendees: z.array(z.string()).min(1),
    }),
  }),

  // No schema at all: nothing is required, nothing is checked, and the panel
  // draws whatever the frontmatter holds.
  legal: defineCollection({
    loader: glob({ base: './src/content/legal', pattern: '**/*.md' }),
  }),

  landingPages: defineCollection({
    loader: glob({ base: './src/content/landing-pages', pattern: '**/*.json' }),
    schema: ({ image }) =>
      z.object({
        title: z.string().min(3).max(120),
        slug: z.string().regex(/^[a-z0-9-]+$/),
        publishedAt: z.coerce.date(),
        blocks: z.array(blocks(image)).min(1),
      }),
  }),

  apiEndpoints: defineCollection({
    loader: glob({ base: './src/content/api-endpoints', pattern: '**/*.json' }),
    schema: z.object({
      path: z.string().regex(/^\\/.*/),
      method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
      summary: z.string().max(300),
      auth: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('none') }),
        z.object({ kind: z.literal('apiKey'), header: z.string() }),
        z.object({ kind: z.literal('oauth'), scopes: z.array(z.string()).min(1) }),
      ]),
      deprecated: z.boolean().default(false),
    }),
  }),

  // --- one file per entry, id built by the loader --------------------------
  //
  // The id is not the path, so renaming the file does not rename the entry —
  // and the ids Stacki shows for these are guesses, which it says out loud.
  changelog: defineCollection({
    loader: glob({
      base: './src/content/changelog',
      pattern: '**/*.md',
      generateId: ({ data }) => String(data.version),
    }),
    schema: z.object({
      version: z.string().regex(/^\\d+\\.\\d+\\.\\d+$/),
      releasedAt: z.coerce.date(),
      highlights: z.array(z.string()).min(1),
    }),
  }),

  localized: defineCollection({
    loader: glob({
      base: './src/content/localized',
      pattern: '**/*.md',
      generateId: ({ entry }) => entry.replace(/\\.md$/, '').split('/').reverse().join('-'),
    }),
    schema: z.object({
      title: z.string().min(3).max(120),
      locale: z.enum(['en', 'de']),
      summary: z.string().max(300),
    }),
  }),

  // --- one file, many entries ----------------------------------------------
  authors: defineCollection({
    loader: file('src/data/authors.json'),
    schema: z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      bio: z.string().max(400),
      website: z.string().url().optional(),
      joinedOn: z.coerce.date(),
    }),
  }),

  clients: defineCollection({
    loader: file('src/data/clients.json'),
    schema: z.object({
      name: z.string(),
      employees: z.number().int().min(1),
      industry: z.enum(['energy', 'logistics', 'retail', 'software']),
      since: z.string().regex(/^\\d{4}$/),
      site: z.string().url(),
    }),
  }),

  products: defineCollection({
    loader: file('src/data/products.json'),
    schema: z.object({
      name: z.string(),
      tagline: z.string().max(200),
      website: z.string().url(),
      // Nullable is not optional: the key has to be there, and the value may
      // be nothing. An editor that treats the two the same deletes a key the
      // schema requires.
      docsUrl: z.string().url().nullable(),
      pricing: z.object({ currency: z.string(), monthly: z.number(), annual: z.number() }),
      variants: z
        .array(
          z.object({
            sku: z.string().regex(/^[A-Z]{3}-[A-Z]+$/),
            label: z.string(),
            stock: z.number().int().min(0),
          })
        )
        .min(1),
      featureFlags: z.record(z.string(), z.boolean()).optional(),
    }),
  }),

  siteSettings: defineCollection({
    loader: file('src/data/site-settings.json'),
    // Each record is a different kind of thing, so the whole entry is the
    // union — the form is a type switcher rather than an object.
    schema: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('brand'),
        siteName: z.string(),
        themeColor: z.string().regex(/^#[0-9a-f]{6}$/),
      }),
      z.object({
        kind: z.literal('seo'),
        defaultTitle: z.string(),
        defaultDescription: z.string().max(300),
      }),
      z.object({ kind: z.literal('social'), twitter: z.string().url(), github: z.string().url() }),
      z.object({
        kind: z.literal('analytics'),
        provider: z.enum(['plausible', 'fathom', 'none']),
        siteId: z.string(),
      }),
      z.object({
        kind: z.literal('footer'),
        copyright: z.string(),
        links: z.array(z.object({ label: z.string(), href: z.string().url() })).min(1),
      }),
    ]),
  }),

  navigation: defineCollection({
    loader: file('src/data/navigation.json'),
    schema: z.object({ label: z.string(), items: z.array(z.lazy(() => navItem)) }),
  }),

  team: defineCollection({
    loader: file('src/data/team.yaml'),
    schema: z.object({
      id: z.string(),
      name: z.string(),
      title: z.string(),
      bio: z.string().max(400),
      email: z.string().email(),
      startedOn: z.coerce.date(),
    }),
  }),

  faqs: defineCollection({
    loader: file('src/data/faqs.yaml', { parser: parseFaqs }),
    schema: z.object({
      id: z.string(),
      question: z.string().min(3).max(200),
      answer: z.string(),
      // Invented by the parser out of the grouping. It is in every entry and
      // in none of the records, which is exactly what the panel has to say.
      category: z.string(),
      popularity: z.number().int().min(0).max(100),
    }),
  }),

  testimonials: defineCollection({
    loader: file('src/data/testimonials.csv', { parser: parseTestimonials }),
    schema: z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      company: reference('clients'),
      quote: z.string(),
      rating: z.enum(['1', '2', '3', '4', '5']),
      // "true" in the file, true in the entry. Writing the entry's value back
      // is how a CSV ends up holding a boolean literal no spreadsheet wrote.
      featured: z.enum(['true', 'false']).transform((v) => v === 'true'),
    }),
  }),

  jobs: defineCollection({
    loader: file('src/data/jobs.ndjson'),
    schema: z
      .object({
        id: z.string(),
        title: z.string(),
        team: z.enum(['engineering', 'design', 'marketing']),
        location: z.string(),
        open: z.boolean(),
        postedAt: z.coerce.date(),
        closesAt: z.coerce.date(),
        salary: z.object({ currency: z.string(), min: z.number(), max: z.number() }),
        applyUrl: z.string().url(),
      })
      .refine((job) => job.closesAt > job.postedAt, {
        message: 'The closing date has to come after the day the job was posted.',
        path: ['closesAt'],
      })
      .refine((job) => job.salary.max >= job.salary.min, {
        message: 'The top of the salary range has to be at least the bottom of it.',
        path: ['salary', 'max'],
      }),
  }),

  pricingPlans: defineCollection({
    loader: file('src/data/pricing.toml'),
    schema: z.object({
      name: z.string(),
      tagline: z.string().max(200),
      monthly: z.number().min(0),
      yearly: z.number().min(0),
      highlighted: z.boolean(),
      features: z.array(z.string()).min(1),
      limits: z.object({
        projects: z.number().int().min(1),
        seats: z.number().int().min(1),
        storageGb: z.number().int().min(1),
      }),
      addOns: z.record(z.string(), z.object({ price: z.number(), unit: z.string() })).optional(),
    }),
  }),

  // --- built somewhere else, read-only -------------------------------------
  events: defineCollection({
    loader: eventsLoader('https://example.invalid/calendar.json'),
    schema: z.object({ title: z.string(), startsAt: z.coerce.date(), city: z.string() }),
  }),
  releases: defineCollection({
    loader: releasesLoader('https://example.invalid/releases'),
    schema: z.object({ tag: z.string(), publishedAt: z.coerce.date(), notes: z.string() }),
  }),
  iconLibrary: defineCollection({
    loader: iconLibraryLoader('node_modules/@example/icons'),
    schema: z.object({ name: z.string(), viewBox: z.string(), path: z.string() }),
  }),
  announcements: defineCollection({
    loader: announcementsLoader('https://example.invalid/sheet'),
    schema: z.object({ headline: z.string(), showUntil: z.coerce.date() }),
  }),
  buildInfo: defineCollection({
    loader: buildInfoLoader(),
    schema: z.object({ commit: z.string(), builtAt: z.coerce.date() }),
  }),
};
`;

// --- blog -----------------------------------------------------------------

const blogPost = ({ title, description, pubDate, author, category, tags, extra = '', body }) =>
  `---
title: ${title}
description: ${description}
pubDate: ${pubDate}
author: ${author}
category: ${category}
tags:
${tags.map((t) => `  - ${t}`).join('\n')}
${extra}---

${body}
`;

const FILES = {
  'package.json': PACKAGE_JSON,
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
  'src/loaders/remote.ts': LOADERS_TS,
  'src/loaders/parsers.ts': PARSERS_TS,
  'src/content.config.ts': CONTENT_CONFIG_TS,

  // The first entry in the collection, because files sort by path and digits
  // sort before letters. content-view opens it, content-fields validates it,
  // and content-refs moves it up a folder to watch its image path follow.
  'src/content/blog/2025/the-cost-of-a-thousand-images.md': blogPost({
    title: 'The cost of a thousand images',
    description:
      'A site with a thousand images is a site with a thousand decisions, and most of them are made once and paid for on every page load after that.',
    pubDate: '2025-11-04',
    author: 'avery-chen',
    category: 'engineering',
    tags: ['images', 'performance'],
    extra: 'heroImage: ../../../assets/images/thousand-images.png\ndraft: false\n',
    body: `We counted them, in the end, because nobody could agree on the number.

The answer was 1,140, and about eight hundred of them were the same six
screenshots at slightly different sizes.`,
  }),

  'src/content/blog/2025/what-editors-need.md': blogPost({
    title: 'What editors actually need',
    description:
      'We sat with four people who publish for a living and watched them use the tools we had built for them. None of it went the way the roadmap said.',
    pubDate: '2025-12-02',
    author: 'marisol-vega',
    category: 'product',
    tags: ['research', 'editing'],
    extra: `contributors:
  - avery-chen
  - toshi-nakamura
readingTime: 11
draft: false
`,
    body: `The first thing everybody did was reach for the file, not the form.

That is not a failure of the form. It is a fact about who is holding the
keyboard, and it is worth designing around rather than training away.`,
  }),

  'src/content/blog/2026/loaders-in-practice.md': blogPost({
    title: 'Loaders in practice',
    description:
      'A loader is a promise about where entries come from, and the promise is the part that decides whether anybody can edit them.',
    pubDate: '2026-01-19',
    author: 'avery-chen',
    category: 'engineering',
    tags: ['loaders', 'astro'],
    extra: 'draft: false\n',
    body: `Every loader answers the same question twice: where do the entries live,
and who owns them once they are there.`,
  }),

  'src/content/blog/content-collections-explained.md': blogPost({
    title: 'Content collections, explained once',
    description:
      'The shortest true description of a content collection, for people who have read three longer ones and are still guessing.',
    pubDate: '2026-03-08',
    author: 'toshi-nakamura',
    category: 'company',
    tags: ['astro', 'collections'],
    extra: 'draft: false\n',
    body: `A collection is a name, a place to look, and a shape. Everything else is
a consequence of those three.`,
  }),

  // Renamed by content-refs, edited by content-entries. Deliberately has no
  // `draft` key: the check that a save writes no defaults is only worth
  // anything over a file that is missing one.
  'src/content/blog/schema-design-for-editors.md': blogPost({
    title: 'Schema design for editors',
    description:
      'A schema written for a validator and a schema written for a form are not the same document, even when they parse the same data.',
    pubDate: '2026-02-18',
    author: 'avery-chen',
    category: 'engineering',
    tags: ['schemas', 'editing', 'forms'],
    body: `Constraints are the interesting part. A minimum length is a sentence the
form can say before anybody presses save.`,
  }),

  'src/content/blog/the-editor-and-the-repo.md': blogPost({
    title: 'The editor and the repo',
    description:
      'Two audiences, one file. The reviewer reads the diff and the editor reads the page, and only one of them chose the format.',
    pubDate: '2026-04-02',
    author: 'toshi-nakamura',
    category: 'design',
    tags: ['git', 'editing'],
    extra: 'draft: false\n',
    body: `The failure mode of a visual editor is not a crash. It is a commit nobody
can review.`,
  }),

  // Points at schema-design-for-editors, so renaming that one has to reach in
  // here and rewrite it.
  'src/content/blog/writing-for-the-web.md': blogPost({
    title: 'Writing for the web, still',
    description:
      'Short sentences, real headings, and links that say where they go. The advice has not changed and neither has the reason for it.',
    pubDate: '2026-05-11',
    author: 'jonas-akerlund',
    category: 'design',
    tags: ['writing'],
    extra: `relatedPosts:
  - schema-design-for-editors
  - content-collections-explained
draft: false
`,
    body: `Nobody reads. Everybody scans, decides, and then reads the one paragraph
they were looking for.`,
  }),

  // --- docs ---------------------------------------------------------------
  'src/content/docs/getting-started.md': `---
title: Getting started
summary: Install the package, point it at a project, and open the first collection.
version: 7.x
order: 1
updatedAt: 2026-05-02
draft: false
---

Nothing here needs a build step. Point it at a folder that has a
\`src/content.config.ts\` in it and it will tell you what it found.
`,

  // The nested id content-entries asserts on: an id with a folder in it.
  'src/content/docs/collections/loaders.md': `---
title: Loaders
summary: Where a collection's entries come from, and what that decides about editing them.
version: 7.x
order: 2
updatedAt: 2026-05-04
maintainer: toshi-nakamura
draft: false
---

A \`glob()\` collection keeps one file per entry. A \`file()\` collection keeps
all of them in one. Anything else is somebody's own loader, and its entries are
rebuilt on every sync.
`,

  'src/content/docs/collections/schemas.md': `---
title: Schemas
summary: What a schema is allowed to say, and which parts of it a form can act on.
version: 7.x
order: 3
updatedAt: 2026-05-06
maintainer: marisol-vega
draft: false
---

Optional, nullable and defaulted are three different things, and a form that
collapses them into one writes keys nobody asked for.
`,

  // --- tutorials (.mdoc) --------------------------------------------------
  'src/content/tutorials/add-a-collection.mdoc': `---
title: Add a collection
summary: Declare it, give it a loader, and put one entry in it.
author: marisol-vega
difficulty: beginner
minutes: 15
publishedAt: 2026-02-02
---

{% callout type="note" %}
Start with a \`glob()\` collection. It is the one you can look at in a folder.
{% /callout %}

Add the collection to \`src/content.config.ts\`, then create the first entry.
`,

  'src/content/tutorials/build-a-blog.mdoc': `---
title: Build a blog
summary: A collection, a schema, a route, and the seven posts that prove it works.
author: avery-chen
difficulty: intermediate
minutes: 45
publishedAt: 2026-03-14
---

{% callout type="warning" %}
Set the id rule before you write the second post, not after.
{% /callout %}

The route is the easy half. The schema is where the decisions are.
`,

  // --- case studies (.mdx) ------------------------------------------------
  // The body holds imports and JSX. Nothing an editor writes may touch it.
  'src/content/case-studies/helios.mdx': `---
title: Helios Energy moves 14 years of copy
client: helios
author: marisol-vega
summary: A migration nobody wanted, done in six weeks, with the review history intact.
industry: energy
publishedAt: 2026-01-27
metrics:
  - label: Pages migrated
    value: "4,120"
  - label: Weeks
    value: "6"
---

import Figure from '../../components/Figure.astro';
import { Chart } from '../../components/Chart.jsx';

<Figure src="/images/helios-before.png" caption="What the old CMS looked like" />

The interesting number is not 4,120. It is the eleven people who kept
publishing while it happened.

<Chart client:load data={[1, 2, 3]} />
`,

  'src/content/case-studies/northwind.mdx': `---
title: Northwind stops copying between two systems
client: northwind
author: avery-chen
summary: One source of truth, arrived at by deleting the second one rather than syncing it.
industry: logistics
publishedAt: 2026-04-09
metrics:
  - label: Systems retired
    value: "1"
  - label: Hours saved each week
    value: "9"
---

import Figure from '../../components/Figure.astro';

export const team = ['ops', 'marketing'];

<Figure src="/images/northwind.png" caption="The two systems, before" />

Nobody had decided to run two content systems. It had simply never been
anybody's job to stop.
`,

  // --- changelog: id built by the loader ----------------------------------
  'src/content/changelog/2026-06-12.md': `---
version: 0.9.4
releasedAt: 2026-06-12
highlights:
  - Collections with a parser are marked in the panel
  - Renaming an entry rewrites what points at it
---

A quiet release, mostly about saying what is going on.
`,

  'src/content/changelog/2026-07-30.md': `---
version: 1.0.0
releasedAt: 2026-07-30
highlights:
  - Every format is patched rather than re-serialized
  - Cross-field rules land on the field they belong to
---

The first release we would put in front of somebody else's repo.
`,

  // --- localized: id built by the loader ----------------------------------
  'src/content/localized/de/home.md': `---
title: Willkommen
locale: de
summary: Die deutsche Startseite, mit derselben Struktur und anderen Worten.
---

Der Text ist nicht die Übersetzung des englischen Textes. Er ist der deutsche
Text.
`,

  'src/content/localized/en/home.md': `---
title: Welcome
locale: en
summary: The English home page, which is the one everything else is measured against.
---

The English copy is the one that changes first, and the one everything else
has to catch up with.
`,

  // --- legal: no schema at all --------------------------------------------
  'src/content/legal/privacy.md': `---
title: Privacy
updated: 2026-03-01
owner: legal@example.com
reviewed: true
---

We keep what we need to run the service and nothing that is only interesting.
`,

  'src/content/legal/terms.md': `---
title: Terms of service
updated: 2026-02-14
owner: legal@example.com
reviewed: true
---

Use it for what it is for. Do not use it for the other things.
`,

  // --- notes: looseObject -------------------------------------------------
  'src/content/notes/editor-retro.md': `---
title: Editor retro
takenAt: 2026-05-20
attendees:
  - Avery
  - Marisol
  - Toshi
customFieldNobodyPlanned: the thing Toshi typed into the frontmatter at 11pm
---

Everyone agreed the save button was fine and the thing before it was not.
`,

  'src/content/notes/loader-notes.md': `---
title: Loader notes
takenAt: 2026-06-03
attendees:
  - Avery
  - Jonas
---

Read-only is not a nicety: a save over a custom loader writes into a file the
next sync overwrites.
`,

  // --- recipes: a cross-field rule ----------------------------------------
  'src/content/recipes/cold-brew.md': `---
title: Cold brew, without the ceremony
servings: 4
prepMinutes: 10
cookMinutes: 0
totalMinutes: 730
ingredients:
  - 100g coarse coffee
  - 1L cold water
---

Twelve hours. There is no shortcut and everybody keeps looking for one.
`,

  'src/content/recipes/sourdough.md': `---
title: Sourdough for people with jobs
servings: 8
prepMinutes: 40
cookMinutes: 45
totalMinutes: 1200
ingredients:
  - 500g strong white flour
  - 350g water
  - 100g starter
  - 10g salt
---

The schedule is the recipe. The ingredients are barely worth writing down.
`,

  // --- landing pages: a union of twelve block kinds ------------------------
  'src/content/landing-pages/about.json': JSON.stringify(
    {
      title: 'About',
      slug: 'about',
      publishedAt: '2026-01-05',
      blocks: [
        {
          type: 'hero',
          heading: 'We build the boring half',
          subheading: 'The half that has to still be there in four years.',
          image: '../../assets/images/editors.png',
        },
        { type: 'richText', markdown: 'Founded in 2021, in a room with one window.' },
        {
          type: 'stats',
          items: [
            { label: 'People', value: '14' },
            { label: 'Countries', value: '5' },
          ],
        },
      ],
    },
    null,
    2
  ),

  'src/content/landing-pages/home.json': JSON.stringify(
    {
      title: 'Home',
      slug: 'home',
      publishedAt: '2026-01-05',
      blocks: [
        {
          type: 'hero',
          heading: 'Edit the repo, not a copy of it',
          subheading: 'Your content stays in the files your reviewers already read.',
          image: '../../assets/images/editors.png',
        },
        {
          type: 'features',
          heading: 'What it does',
          items: [
            { title: 'Reads your schema', body: 'The form is the schema, not a guess at it.' },
            { title: 'Writes one line', body: 'A one-field edit is a one-line diff.' },
          ],
        },
        {
          type: 'testimonialList',
          heading: 'People who use it',
          quotes: ['tst-001', 'tst-003'],
        },
        { type: 'cta', label: 'Start a project', href: 'https://example.com/start' },
      ],
    },
    null,
    2
  ),

  'src/content/landing-pages/pricing.json': JSON.stringify(
    {
      title: 'Pricing',
      slug: 'pricing',
      publishedAt: '2026-02-01',
      blocks: [
        { type: 'hero', heading: 'Three plans, one of which is free' },
        { type: 'pricingTable', heading: 'Plans', plans: ['starter', 'team', 'business'] },
        { type: 'faq', heading: 'Questions', questions: ['billing-cycle', 'billing-refunds'] },
        { type: 'spacer', size: 'large' },
      ],
    },
    null,
    2
  ),

  // --- api endpoints: a union in a field -----------------------------------
  'src/content/api-endpoints/create-entry.json': JSON.stringify(
    {
      path: '/v1/collections/{name}/entries',
      method: 'POST',
      summary: 'Create one entry in a collection, validated against that collection’s schema.',
      auth: { kind: 'apiKey', header: 'X-Stacki-Key' },
      deprecated: false,
    },
    null,
    2
  ),

  'src/content/api-endpoints/list-collections.json': JSON.stringify(
    {
      path: '/v1/collections',
      method: 'GET',
      summary: 'Every collection this project declares, with its loader and entry count.',
      auth: { kind: 'oauth', scopes: ['collections:read'] },
    },
    null,
    2
  ),

  // --- data files ----------------------------------------------------------
  //
  // An array of records, each carrying its own id. Renaming one means writing
  // a field, not moving a file and not renaming a key.
  'src/data/authors.json': JSON.stringify(
    [
      {
        id: 'avery-chen',
        name: 'Avery Chen',
        role: 'Editor in Chief',
        bio: 'Ran a newsroom CMS for nine years and has opinions about all of them.',
        website: 'https://averychen.example.com',
        joinedOn: '2021-03-01',
      },
      {
        id: 'marisol-vega',
        name: 'Marisol Vega',
        role: 'Staff Writer',
        bio: 'Writes the tutorials and then does them again from scratch to check.',
        joinedOn: '2022-09-12',
      },
      {
        id: 'toshi-nakamura',
        name: 'Toshi Nakamura',
        role: 'Developer Advocate',
        bio: 'Explains the loader model to people who did not ask about the loader model.',
        website: 'https://toshi.example.com',
        joinedOn: '2023-01-30',
      },
      {
        id: 'jonas-akerlund',
        name: 'Jonas Åkerlund',
        role: 'Design Lead',
        bio: 'Draws the form before anybody writes the schema, which is the right order.',
        joinedOn: '2024-06-17',
      },
    ],
    null,
    2
  ),

  // An object keyed by id, with a $schema key Astro ignores and an editor must
  // not eat. helios is deliberately the first record after it.
  'src/data/clients.json': `{
  "$schema": "./clients.schema.json",
  "helios": {
    "name": "Helios Energy",
    "employees": 900,
    "industry": "energy",
    "since": "2011",
    "site": "https://helios.example.com"
  },
  "northwind": {
    "name": "Northwind Freight",
    "employees": 4300,
    "industry": "logistics",
    "since": "1998",
    "site": "https://northwind.example.com"
  },
  "atlas": {
    "name": "Atlas Retail Group",
    "employees": 260,
    "industry": "retail",
    "since": "2016",
    "site": "https://atlas.example.com"
  }
}
`,

  'src/data/products.json': `{
  "beacon": {
    "name": "Beacon",
    "tagline": "The one that watches the build",
    "website": "https://beacon.example.com",
    "docsUrl": "https://docs.example.com/beacon",
    "pricing": {
      "currency": "USD",
      "monthly": 19,
      "annual": 190
    },
    "variants": [
      { "sku": "BCN-STD", "label": "Standard", "stock": 120 },
      { "sku": "BCN-PRO", "label": "Pro", "stock": 40 }
    ],
    "featureFlags": {
      "liveReload": true,
      "auditLog": false
    }
  },
  "lantern": {
    "name": "Lantern",
    "tagline": "The one that reads the schema",
    "website": "https://lantern.example.com",
    "docsUrl": null,
    "pricing": {
      "currency": "USD",
      "monthly": 0,
      "annual": 0
    },
    "variants": [
      { "sku": "LTN-FREE", "label": "Free", "stock": 0 }
    ]
  },
  "quarry": {
    "name": "Quarry",
    "tagline": "The one that keeps the history",
    "website": "https://quarry.example.com",
    "docsUrl": "https://docs.example.com/quarry",
    "pricing": {
      "currency": "EUR",
      "monthly": 49,
      "annual": 490
    },
    "variants": [
      { "sku": "QRY-STD", "label": "Standard", "stock": 12 }
    ],
    "featureFlags": {
      "liveReload": false
    }
  }
}
`,

  // Every record is a different kind of thing.
  'src/data/site-settings.json': JSON.stringify(
    [
      { kind: 'brand', siteName: 'Stacki Demo', themeColor: '#2f6df6' },
      {
        kind: 'seo',
        defaultTitle: 'Stacki Demo — content that lives in the repo',
        defaultDescription: 'A demo project with every collection shape the editor knows about.',
      },
      { kind: 'social', twitter: 'https://example.com/stacki', github: 'https://example.com/stacki-git' },
      { kind: 'analytics', provider: 'plausible', siteId: 'stacki-demo' },
      {
        kind: 'footer',
        copyright: '© 2026 Stacki Demo',
        links: [
          { label: 'Privacy', href: 'https://example.com/privacy' },
          { label: 'Terms', href: 'https://example.com/terms' },
        ],
      },
    ],
    null,
    2
  ),

  'src/data/navigation.json': JSON.stringify(
    {
      main: {
        label: 'Main navigation',
        items: [
          { label: 'Product', href: '/product' },
          {
            label: 'Docs',
            href: null,
            children: [
              { label: 'Getting started', href: '/docs/getting-started' },
              { label: 'Loaders', href: '/docs/collections/loaders' },
            ],
          },
          { label: 'Pricing', href: '/pricing' },
        ],
      },
      footer: {
        label: 'Footer navigation',
        items: [
          { label: 'Privacy', href: '/legal/privacy' },
          { label: 'Terms', href: '/legal/terms' },
        ],
      },
    },
    null,
    2
  ),

  // Comments and block scalars, which a re-serializer throws away.
  'src/data/team.yaml': `# The team page. The order here is the order on the site.
# Bios are block scalars so they can run to a few lines without folding.
- id: rosa-lindqvist
  name: Rosa Lindqvist
  title: Head of Product
  bio: |
    Joined to write the roadmap and stayed to delete most of it.
    Runs the editor research sessions.
  email: rosa@example.com
  startedOn: 2021-04-01

# Hired the week the first release shipped.
- id: dmitri-ozols
  name: Dmitri Ozols
  title: Principal Engineer
  bio: |
    Owns the serializers. Believes a diff is a user interface.
  email: dmitri@example.com
  startedOn: 2021-09-13

- id: femi-adeyemi
  name: Femi Adeyemi
  title: Support Lead
  bio: |
    Reads every bug report twice before answering, which is why the
    answers are short.
  email: femi@example.com
  startedOn: 2023-02-20
`,

  // Grouped by category. An entry is a question, two levels down, and the
  // category it sits under is a field the parser invents.
  'src/data/faqs.yaml': `# Frequently asked questions, grouped the way the site shows them.
categories:
  - slug: billing
    label: Billing
    questions:
      - id: billing-cycle
        question: When am I charged?
        answer: >
          On the day you subscribed, every month, until you stop. There is no
          proration and no surprise invoice at the end of the year.
        popularity: 88
      - id: billing-refunds
        question: Can I get a refund?
        answer: |
          Yes, within 30 days, for any reason, by replying to the receipt.
          After that we will still talk to you about it.
        popularity: 42
      - id: billing-vat
        question: Do you handle VAT?
        answer: >
          We collect it where we have to and show it on the invoice.
        popularity: 17

  - slug: accounts
    label: Accounts
    questions:
      - id: accounts-seats
        question: What counts as a seat?
        answer: >
          One person who can open the editor. Bots and CI do not need one.
        popularity: 61
      - id: accounts-sso
        question: Is there single sign-on?
        answer: |
          On the Business plan, through any provider that speaks SAML.
        popularity: 35

  - slug: content
    label: Content
    questions:
      - id: content-formats
        question: Which file formats can it write?
        answer: >
          Markdown, MDX, Markdoc, JSON, YAML, TOML, CSV and NDJSON, each
          patched in place rather than re-serialized.
        popularity: 74
      - id: content-git
        question: Does it commit for me?
        answer: |
          Only when you ask it to. The rest of the time it writes files and
          leaves your git alone.
        popularity: 53
      - id: content-readonly
        question: Why can I not edit this collection?
        answer: >
          Because a loader builds it. Its entries are rebuilt from scratch on
          the next sync, so anything written here would be overwritten.
        popularity: 29
`,

  // A spreadsheet export: every cell is a string, and the quoted ones must
  // stay quoted.
  'src/data/testimonials.csv': `# Exported from the marketing sheet. Do not reformat: featured is a string here.
id,name,role,company,quote,rating,featured
tst-001,Dana Whitfield,"Head of Content, Northwind",northwind,"It writes the file we would have written by hand",5,true
tst-002,Aput Nashoba,Editor,helios,"Our reviewers stopped complaining about the diffs",4,true
tst-003,Priya Raman,"Director, Digital",atlas,"The form knows what the schema wants, which is new",5,false
tst-004,Lars Vestergaard,Engineer,helios,"I read the commit and understood it",4,false
`,

  // One JSON object per line. The record is the line.
  'src/data/jobs.ndjson': `{"id":"staff-engineer-2026","title":"Staff Engineer","team":"engineering","location":"Remote (EU)","open":true,"postedAt":"2026-03-01","closesAt":"2026-06-01","salary":{"currency":"EUR","min":95000,"max":130000},"applyUrl":"https://example.com/jobs/staff-engineer"}
{"id":"design-systems-2026","title":"Design Systems Engineer","team":"design","location":"Berlin","open":true,"postedAt":"2026-04-12","closesAt":"2026-07-12","salary":{"currency":"EUR","min":80000,"max":105000},"applyUrl":"https://example.com/jobs/design-systems"}
{"id":"content-lead-2026","title":"Content Lead","team":"marketing","location":"Remote (worldwide)","open":false,"postedAt":"2026-01-08","closesAt":"2026-03-08","salary":{"currency":"EUR","min":70000,"max":90000},"applyUrl":"https://example.com/jobs/content-lead"}
`,

  // Inline tables on one line, add-ons in sub-tables, and a header comment
  // that a re-emit would take with it.
  'src/data/pricing.toml': `# Plans, as marketing writes them. The order here is the order on the page.
# limits stays inline: it reads as one thing and it is one thing.

[starter]
name = "Starter"
tagline = "For one person and one project"
monthly = 0
yearly = 0
highlighted = false
features = ["1 project", "1 seat", "Community support"]
limits = { projects = 1, seats = 1, storageGb = 1 }

[team]
name = "Team"
tagline = "For a few people who publish together"
monthly = 29
yearly = 290
highlighted = true
features = ["10 projects", "8 seats", "Review history", "Email support"]
limits = { projects = 10, seats = 8, storageGb = 50 }

[team.addOns.extraSeats]
price = 6
unit = "seat"

[team.addOns.extraStorage]
price = 4
unit = "10GB"

[business]
name = "Business"
tagline = "For a lot of people and an auditor"
monthly = 99
yearly = 990
highlighted = false
features = ["Unlimited projects", "40 seats", "SSO", "Audit log", "Priority support"]
limits = { projects = 500, seats = 40, storageGb = 500 }

[business.addOns.extraSeats]
price = 5
unit = "seat"
`,
};

// A one-pixel PNG apiece. content-refs moves a post up a folder and then checks
// that the image path it rewrote resolves to a file that is really there — so
// these have to be real bytes, not a promise of them.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const BINARY_FILES = {
  'src/assets/images/thousand-images.png': PNG_1PX,
  'src/assets/images/editors.png': PNG_1PX,
};

// ---------------------------------------------------------------------------

/**
 * The project, written to a temp directory this run owns, with node_modules
 * copied in from the shared Astro cache.
 *
 * Copied rather than symlinked: electron/contentConfig.js writes its generated
 * runner into `<project>/node_modules/.stacki`, and a symlinked node_modules
 * would put that inside the shared cache — where a second run would overwrite
 * it while the first was reading it.
 */
function makeContentProject({ log = () => {}, harness = 'content-fixture' } = {}) {
  ensureAstro({ log });
  // What DEAD runs of this harness left behind, and nothing else — see
  // test/support/ownedTemp.js for why a prefix alone is not ownership.
  sweepStaleRuns([PREFIX]);
  const root = ownedTempDir(PREFIX, { harness });
  try {
    for (const [rel, body] of Object.entries(FILES)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
    }
    for (const [rel, base64] of Object.entries(BINARY_FILES)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(base64, 'base64'));
    }
    fs.cpSync(path.join(CACHE, 'node_modules'), path.join(root, 'node_modules'), {
      recursive: true,
      dereference: false,
    });
  } catch (err) {
    // A half-written fixture is still 150MB of somebody's disk, and the caller
    // never learns its name — so it is this function that has to clean up after
    // itself before the throw leaves.
    releaseTempDir(root);
    throw err;
  }
  return root;
}

/** A project this run made, removed by the run that made it. */
const removeContentProject = (root) => releaseTempDir(root);

/**
 * The fixture a suite should read, and what to do about it afterwards.
 *
 * A developer pointing one of these suites at a real project still gets that
 * project — `node test/content-config.js ~/work/site`, or
 * STACKI_CONTENT_FIXTURE — and nothing is created or deleted in that case.
 * With no override the suite builds its own, which is the default because a
 * suite whose fixture is somebody's Downloads folder has never run anywhere
 * else.
 *
 * @returns {{ source: string, owned: string|null, skip: string|null }}
 *   `skip` is a sentence and is only ever set for the one case the repo
 *   already allows: no cache, and STACKI_CANVAS_OFFLINE set.
 */
function contentFixture(name, { log = () => {} } = {}) {
  const override = process.argv[2] || process.env.STACKI_CONTENT_FIXTURE;
  if (override) {
    const source = path.resolve(override);
    if (!fs.existsSync(path.join(source, 'src', 'content.config.ts'))) {
      throw new Error(
        `${name}: ${source} has no src/content.config.ts. ` +
          'That path came from argv[2] or STACKI_CONTENT_FIXTURE — point it at an Astro project, ' +
          'or unset it and this builds its own fixture.'
      );
    }
    return { source, owned: null, skip: null };
  }
  if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
    return {
      source: null,
      owned: null,
      skip: `${name}: skipped — STACKI_CANVAS_OFFLINE is set and the Astro cache at ${CACHE} is cold, so the one npm install this needs cannot be done.`,
    };
  }
  let root;
  try {
    root = makeContentProject({ log });
  } catch (err) {
    // Loudly, and with the two things that fix it. A core suite that cannot
    // build its fixture has not passed — it has not run, and the difference is
    // the whole reason this file exists.
    throw new Error(
      `${name}: could not build its fixture. Astro has to be installed once into ${CACHE} — ${String(
        err?.message || err
      )}. Point STACKI_CANVAS_CACHE at a warm cache, or set STACKI_CANVAS_OFFLINE=1 to skip this suite deliberately.`
    );
  }
  // Removed by the run that made it, however the run ends: a failing suite
  // exits through process.exit(), which no finally block outruns.
  process.on('exit', () => removeContentProject(root));
  return { source: root, owned: root, skip: null };
}

module.exports = {
  contentFixture,
  makeContentProject,
  removeContentProject,
  astroCached,
  sweepStaleRuns,
  PREFIX,
  FILES,
  CACHE,
};
