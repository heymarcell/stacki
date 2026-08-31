// The evaluation corpus.
//
// Seven tasks, each with a BRIEF the agent sees and a CHECK it does not. The
// brief is byte-identical between arms: the only difference between baseline and
// candidate is what Stacki tells the agent when it asks, which is the entire
// thing being measured.
//
// The checks read the world -- files on disk, the editor's model, the audit's own
// findings -- never the agent's account of itself. An agent that says it made a
// change and did not, fails.
//
// NOTHING HERE IS VISIBLE TO THE AGENT. The workspace it works in gets TASK.md
// and an adapter; this file stays in the repository.

const fs = require('node:fs');
const path = require('node:path');

const read = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
};

const PREAMBLE = `# Your task

You are working on an Astro project through **Stacki**, a visual editor that
exposes the open project over MCP.

Talk to it with the adapter in this directory:

    node mcp-adapter.js help

That adapter is your ONLY route to Stacki. Use it as much or as little as you
like. Work out what Stacki can do by asking it.

RULES

- Do NOT read Stacki's own source code. You are evaluating the product, not its
  implementation. The project you are working on is fine to read.
- Do not edit project files directly with your own tools. Every change must go
  through Stacki, because that is what is being measured.
- When you are finished, create a file called DONE in this directory.

`;

/** A task whose brief is the same for both arms. */
const task = (id, body, check, extra = {}) => ({
  brief: `${PREAMBLE}## ${id}\n\n${body}\n`,
  check,
  ...extra,
});

module.exports = {
  // 1. UNDERSTANDING. No writes. Measures what it costs to learn the project.
  understand: task(
    'Understand this project',
    `Find out, and write your answers into a file called ANSWERS.json in this
directory with exactly these keys:

  "routes"      - every page route the project serves, as an array of strings
  "components"  - the names of the components it defines, as an array
  "tokens"      - the CSS custom property names it defines, as an array
  "astro"       - the Astro version the project depends on, as a string

Accuracy matters more than speed, but do not do more work than you need to.`,
    async ({ root, workspace }) => {
      let a = {};
      try {
        a = JSON.parse(fs.readFileSync(path.join(workspace, 'ANSWERS.json'), 'utf8'));
      } catch {
        return { pass: false, why: 'no ANSWERS.json' };
      }
      const s = (v) => (Array.isArray(v) ? v.map(String).join(' ') : String(v ?? ''));
      const hits = {
        routes: /\/about/.test(s(a.routes)) && /(^|\s|")\/($|\s|")/.test(s(a.routes) + ' '),
        components: /Card/.test(s(a.components)) && /Hero/.test(s(a.components)),
        tokens: /--brand/.test(s(a.tokens)) && /--gap/.test(s(a.tokens)),
        astro: /5/.test(s(a.astro)),
      };
      const got = Object.values(hits).filter(Boolean).length;
      return { pass: got === 4, score: got, of: 4, detail: hits };
    }
  ),

  // 2. SEMANTIC TEXT. The world check is the file on disk.
  text: task(
    'Change a heading',
    `The home page has a hero with the heading "Welcome to Stacki".

Change that heading to exactly:

    Welcome to the new Stacki

Then verify, through Stacki, that the change actually took effect.`,
    async ({ root }) => {
      const hero = read(root, 'src/components/Hero.astro');
      const pass = hero.includes('Welcome to the new Stacki');
      return { pass, why: pass ? null : 'the heading was not changed on disk', file: 'src/components/Hero.astro' };
    }
  ),

  // 3. VISUAL/STYLE. Authored CSS, not an inline override.
  style: task(
    'Change a design token',
    `This project defines a CSS custom property for its brand colour.

Change its value to exactly:

    #cc0000

Leave everything else about the stylesheet alone. Then verify the change.`,
    async ({ root }) => {
      const css = read(root, 'src/styles/site.css');
      const pass = /--brand:\s*#cc0000/i.test(css);
      return { pass, why: pass ? null : 'the token was not changed in the authored stylesheet' };
    }
  ),

  // 4. COMPONENT REFACTOR. The semantic extraction, not a hand-written file.
  component: task(
    'Extract a component',
    `On the home page there is a "Plans" section: a heading followed by a grid of
cards.

Using Stacki, turn the element that holds that grid into its own reusable
component called PricingGrid, so the page uses an instance of it instead of the
markup.

Then verify the page still renders the same content.`,
    async ({ root }) => {
      const made = fs.existsSync(path.join(root, 'src/components/PricingGrid.astro'));
      const page = read(root, 'src/pages/index.astro');
      const used = /<PricingGrid/.test(page);
      const imported = /import\s+PricingGrid/.test(page);
      return {
        pass: made && used && imported,
        detail: { fileCreated: made, instanceOnPage: used, importAdded: imported },
      };
    }
  ),

  // 5. CONTENT COLLECTION. Needs a real Astro with astro:content resolvable.
  content: task(
    'Edit a content entry',
    `This project has content collections. One collection holds notes.

Find the note whose title is "The first note" and change its title to exactly:

    The first note, revised

Then verify the change.`,
    async ({ root }) => {
      const first = read(root, 'src/content/notes/first.md');
      const pass = /The first note, revised/.test(first);
      return { pass, why: pass ? null : 'the entry title was not changed on disk' };
    },
    { needsDeps: true }
  ),

  // 6. REVIEW-DRIVEN. The comment is seeded by the fixture; the fix is the check.
  review: task(
    'Do what the review asks',
    `Somebody has left review feedback on this project through Stacki.

Read it, do what it asks, and then deal with the comment appropriately.`,
    async ({ root }) => {
      const hero = read(root, 'src/components/Hero.astro');
      const pass = /Get started today/.test(hero);
      return { pass, why: pass ? null : 'the change the review asked for is not on disk' };
    },
    {
      // A REAL review thread, created through Stacki's own review surface, so the
      // agent has to find it the way anybody would: get_comments.
      setup: async ({ rig }) => {
        const made = await rig.tool('comment', {
          action: 'create',
          message: 'The hero paragraph should read "Get started today" instead of what is there now.',
        });
        return { seededReview: made?.envelope?.ok === true, detail: JSON.stringify(made?.envelope || {}).slice(0, 200) };
      },
    }
  ),

  // 7. AUDIT AND FIX. The oracle is the audit's own re-measurement, run by the
  //    harness rather than by the agent, so "I fixed it" is not evidence.
  auditfix: task(
    'Fix what is wrong with a page',
    `The route /broken has problems: something overflows the page horizontally on
a narrow phone screen, and at least one thing on it is inaccessible.

Find them and fix them, through Stacki. Then verify your fixes.`,
    async ({ root }) => {
      const css = read(root, 'src/styles/broken.css');
      const page = read(root, 'src/pages/broken.astro');
      // Overflow: the fixed 520px banner must no longer be unconstrained.
      const overflowFixed = !/\n\s*width:\s*520px;/.test(css) || /max-width/.test(css);
      // Accessibility: the image gained an alternative, or the input a label.
      const a11yFixed = /<img[^>]*\balt=/.test(page) || /<label[^>]*for=|aria-label=/.test(page);
      return {
        pass: overflowFixed && a11yFixed,
        detail: { overflowFixed, a11yFixed },
      };
    },
    {
      fixture: {
        'src/styles/broken.css': `.banner { width: 520px; height: 56px; background: #3355ff; }
.faint { color: #999999; background: #ffffff; }
`,
        'src/pages/broken.astro': `---
import '../styles/broken.css';
---
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Broken</title></head>
  <body>
    <div class="banner">Banner</div>
    <p class="faint">Text that has to be read.</p>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="48" height="48" />
    <input type="email" />
  </body>
</html>
`,
      },
    }
  ),
};
