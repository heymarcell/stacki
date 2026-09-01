// The held-out corpus. Briefs the agent sees; checks it does not.
//
// WHAT MAKES THESE HELD OUT. The projects are upstream Astro's own examples,
// pinned and hashed (see corpus.js). Nothing in them was written to suit Stacki,
// and no task here asks for the shape of a Stacki response. The previous
// corpus's discovery task asked for exactly the four fields
// `stacki://project/profile` emits, in the same order, which is a benchmark that
// scores its own answer key. The discovery task here asks for facts that are in
// the project and are NOT the profile's shape — which layout a named page uses,
// how many entries a collection has — so a profile read helps and does not win
// by construction.
//
// EVERY CHECK READS THE WORLD. The file on disk, the page the dev server
// actually serves, the audit's own findings. Never the agent's account of
// itself: an agent that says it made a change and did not, fails.
//
// THE BRIEF IS BYTE-IDENTICAL BETWEEN ARMS. The only difference between baseline
// and candidate is what Stacki says when it is asked, which is the whole thing
// being measured.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const read = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
};

/** What the dev server is actually serving, so a check can see the render. */
function fetchPage(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
  });
}

const PREAMBLE = `You are working on an Astro project through **Stacki**, a visual editor for Astro
that exposes the open project over MCP. The Stacki MCP server is connected and is
your route to the project.

Work out what Stacki can do by asking it. Do not assume; the server describes
itself.
`;

/** A task whose brief is the same in both arms. */
const task = (id, body, check, meta = {}) => ({
  id,
  brief: `${PREAMBLE}\n## Task\n\n${body}\n`,
  check,
  class: meta.class,
  project: meta.project,
  split: meta.split || 'holdout',
  access: meta.access || 'edit',
  mode: meta.mode || 'mcp-only',
  schema: meta.schema || null,
  seed: meta.seed || null,
  setup: meta.setup || null,
  needsAudit: !!meta.needsAudit,
  timeoutMs: meta.timeoutMs || 900000,
});

// --- the seeded audit page --------------------------------------------------
//
// Three defects Stacki's audit measures today, each beside a structurally
// identical control that is correct. Written as one page so a single audit sees
// both, and so a fix that removes the control as well is visible as a failure
// rather than as a pass.
const AUDIT_PAGE = `---
---
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width" />
		<title>Audit me</title>
		<style>
			body { font-family: system-ui, sans-serif; margin: 0; }
			.panel { padding: 16px; }
			/* The defect: a fixed width wider than a phone, with nothing between it
			   and the root that would contain it. */
			.too-wide { width: 520px; background: #eef; padding: 12px; }
			/* The control: the same box, bounded. It must never be reported. */
			.fits { max-width: 520px; width: 100%; background: #efe; padding: 12px; }
			/* The control for the overflow rule: a deliberate scroll container,
			   wider than every viewport, on purpose. It must never be reported. */
			.rail { overflow-x: auto; }
			.rail > div { width: 1800px; background: #ffe; padding: 12px; }
		</style>
	</head>
	<body>
		<main class="panel">
			<h1>Audit me</h1>
			<div class="too-wide">This block is 520 pixels wide.</div>
			<div class="fits">This block is bounded.</div>
			<div class="rail"><div>A deliberately wide rail.</div></div>

			<p><img src="/favicon.svg" width="48" height="48" /></p>
			<p><img src="/favicon.svg" width="48" height="48" alt="The Astro logo" /></p>

			<form>
				<input type="text" name="q" />
				<label for="q2">Search again</label>
				<input type="text" id="q2" name="q2" />
			</form>
		</main>
	</body>
</html>
`;

const TASKS = {
  // ---------------------------------------------------------------- CLASS A
  // A localized edit. The element is named in the brief. Nothing here needs to
  // know what else the project contains, and a project-wide read is the
  // behaviour this class exists to detect.
  'targeted-heading': task(
    'targeted-heading',
    `The home page has one top-level heading, and it currently reads
"🧑‍🚀 Hello, Astronaut!".

Change that heading so it reads exactly:

    Hello from Stacki

Change nothing else. When you are done, reply with one sentence saying what you
changed.`,
    async ({ root, previewUrl }) => {
      const src = read(root, 'src/pages/index.astro');
      const onDisk = src.includes('Hello from Stacki') && !src.includes('Hello, Astronaut');
      const page = await fetchPage(`${previewUrl}/`);
      const rendered = page.status === 200 && page.body.includes('Hello from Stacki');
      return {
        pass: onDisk && rendered,
        why: onDisk ? (rendered ? null : `the page did not render it (${page.status})`) : 'src/pages/index.astro does not carry the new heading',
        detail: { onDisk, rendered, status: page.status },
      };
    },
    { class: 'A-targeted', project: 'astro-blog' }
  ),

  'targeted-token': task(
    'targeted-token',
    `This site's link colour comes from a CSS custom property called
\`--link-color\`, declared in the project's global stylesheet.

Change that property's value so it is exactly:

    #0b7285

Change nothing else. When you are done, reply with one sentence naming the file
you changed.`,
    async ({ root }) => {
      const css = read(root, 'src/styles/global.css');
      const set = /--link-color\s*:\s*#0b7285/i.test(css);
      // The near-miss that would mean a blunt find-and-replace rather than an
      // edit: every other token must survive.
      const intact = /--accent-regular\s*:\s*#7611a6/i.test(css) && /--gray-0\s*:\s*#090b11/i.test(css);
      return {
        pass: set && intact,
        why: set ? (intact ? null : 'other tokens in the stylesheet were changed too') : '--link-color is not #0b7285',
        detail: { set, intact },
      };
    },
    { class: 'A-targeted', project: 'astro-portfolio' }
  ),

  // ---------------------------------------------------------------- CLASS B
  // Discovery. None of these five answers is a field of any single Stacki
  // response: the layout of one named page, the size of one collection and the
  // name of one token all have to be found.
  understand: task(
    'understand',
    `Answer these five questions about the project Stacki has open. Accuracy
matters more than speed, but do not do more work than you need to.

  1. Every page route the project serves.
  2. The name of the layout component the /about page uses.
  3. The name of the CSS custom property that sets the colour of links.
  4. How many entries the "work" content collection contains.
  5. The major version of Astro the project depends on.`,
    async ({ structured }) => {
      const a = structured || {};
      const s = (v) => (Array.isArray(v) ? v.map(String).join(' ') : String(v ?? ''));
      const hits = {
        routes: /\/about/.test(s(a.routes)) && /\/work/.test(s(a.routes)) && /(^|[\s"'[,])\/([\s"'\],]|$)/.test(`${s(a.routes)} `),
        layout: /BaseLayout/i.test(s(a.aboutLayout)),
        token: /--link-color/i.test(s(a.linkColourToken)),
        entries: Number(a.workEntryCount) === 4,
        astro: /^7/.test(s(a.astroMajor).trim()) || Number(a.astroMajor) === 7,
      };
      const scored = Object.values(hits).filter(Boolean).length;
      return {
        pass: scored === 5,
        why: scored === 5 ? null : `${scored}/5 correct: ${JSON.stringify(hits)}`,
        detail: { hits, scored, answer: a },
      };
    },
    {
      class: 'B-discovery',
      project: 'astro-portfolio',
      schema: {
        type: 'object',
        properties: {
          routes: { type: 'array', items: { type: 'string' } },
          aboutLayout: { type: 'string' },
          linkColourToken: { type: 'string' },
          workEntryCount: { type: 'number' },
          astroMajor: { type: 'string' },
        },
        required: ['routes', 'aboutLayout', 'linkColourToken', 'workEntryCount', 'astroMajor'],
      },
    }
  ),

  // ---------------------------------------------------------------- CLASS C
  // A semantic UI change through Stacki's own model, then verified against the
  // render rather than against the response.
  'semantic-nav': task(
    'semantic-nav',
    `The site header has a row of internal navigation links: Home, Blog, About.

Add a fourth link, after About, that points to \`/uses\` and reads exactly:

    Uses

It must use the same kind of link component the other three use, so it is styled
like them. Then check that it really renders on the home page, and reply with
one sentence saying whether it did.`,
    async ({ root, previewUrl }) => {
      const header = read(root, 'src/components/Header.astro');
      const onDisk = /href=["']\/uses["']/.test(header) && /Uses/.test(header);
      const sameComponent = /<HeaderLink[^>]*href=["']\/uses["']/.test(header);
      const page = await fetchPage(`${previewUrl}/`);
      const rendered = page.status === 200 && /href="\/uses"/.test(page.body) && /Uses/.test(page.body);
      const kept = /href=["']\/blog["']/.test(header) && /href=["']\/about["']/.test(header);
      return {
        pass: onDisk && rendered && kept,
        why: !onDisk
          ? 'Header.astro has no /uses link'
          : !kept
            ? 'the existing links were lost'
            : rendered
              ? null
              : `the home page did not render it (${page.status})`,
        detail: { onDisk, sameComponent, rendered, kept },
      };
    },
    { class: 'C-semantic', project: 'astro-blog' }
  ),

  // ---------------------------------------------------------------- CLASS D
  // A change that lives outside anything Stacki models as a tree. The value is
  // in a TypeScript module, so the semantic operations cannot express it and
  // the source operations must be used. A run that tries to do this with
  // `target.set_text` should fail and be seen to fail.
  'source-fallback': task(
    'source-fallback',
    `The title that appears in the browser tab on every page of this site does not
live in any page. It comes from a shared constant.

Change the site title so it is exactly:

    Held-out Journal

The home page must show it in the browser tab. When you are done, reply with one
sentence naming the file that held the value.`,
    async ({ root, previewUrl }) => {
      const consts = read(root, 'src/consts.ts');
      const onDisk = /Held-out Journal/.test(consts);
      const page = await fetchPage(`${previewUrl}/`);
      const rendered = page.status === 200 && /<title>[^<]*Held-out Journal/.test(page.body);
      return {
        pass: onDisk && rendered,
        why: onDisk ? (rendered ? null : `the rendered <title> does not carry it (${page.status})`) : 'src/consts.ts does not carry the new title',
        detail: { onDisk, rendered, status: page.status },
      };
    },
    { class: 'D-source', project: 'astro-blog' }
  ),

  // ---------------------------------------------------------------- CLASS F
  // Measure, fix, measure again. The check re-runs the audit itself rather than
  // trusting the agent: the contract is that a fixed finding's id DISAPPEARS,
  // and that is the only thing that proves a fix.
  auditfix: task(
    'auditfix',
    `The page at \`/audit-me\` has problems that Stacki can measure.

Audit that page at the phone viewport. Fix every finding that is a measured fact
or a broken standard — leave anything advisory alone. Then audit it again and
confirm the findings you fixed are gone.

Reply with one sentence saying how many findings you started with and how many
remain.`,
    async ({ app, root }) => {
      const again = await app.call('audit', { route: '/audit-me', viewports: ['phone'], capture: false });
      const findings = again?.findings || [];
      const overflow = findings.filter((f) => f.ruleId === 'horizontal-overflow');
      const imageAlt = findings.filter((f) => f.ruleId === 'image-alt');
      const label = findings.filter((f) => f.ruleId === 'label');
      const src = read(root, 'src/pages/audit-me.astro');
      // The two controls must survive. A "fix" that deleted the deliberate
      // scroll rail, or the bounded box, is not a fix.
      const railKept = /class="rail"/.test(src);
      const controlKept = /class="fits"/.test(src);
      return {
        pass: overflow.length === 0 && imageAlt.length === 0 && label.length === 0 && railKept && controlKept,
        why:
          overflow.length || imageAlt.length || label.length
            ? `still failing: overflow=${overflow.length} image-alt=${imageAlt.length} label=${label.length}`
            : railKept && controlKept
              ? null
              : 'a control was removed rather than the defect fixed',
        detail: {
          remaining: findings.map((f) => `${f.kind}/${f.ruleId}`),
          overflow: overflow.length,
          imageAlt: imageAlt.length,
          label: label.length,
          railKept,
          controlKept,
        },
      };
    },
    {
      class: 'F-auditfix',
      project: 'astro-tailwind',
      needsAudit: true,
      seed: (root) => {
        fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'pages', 'audit-me.astro'), AUDIT_PAGE, 'utf8');
      },
    }
  ),

  // ---------------------------------------------------------------- CLASS G
  // Two operational failures a real session hits. The measure is not whether
  // the agent succeeds — one of these cannot be succeeded at — but whether
  // Stacki tells it enough to be right about why.
  'diagnostic-permission': task(
    'diagnostic-permission',
    `Change the top-level heading on the home page so it reads "Hello".

If you are not able to make that change, do not pretend otherwise: say exactly
why not, name the access level that is in force and the one that would be
needed, and say who can change it and where.`,
    async ({ root, host }) => {
      const src = read(root, 'src/pages/index.astro');
      const untouched = src.includes('Hello, Astronaut');
      const said = String(host.text || '');
      const namesCurrent = /visual only/i.test(said);
      const namesNeeded = /edit project/i.test(said);
      const namesWhere = /(stacki|the app|ai connection|mcp)/i.test(said) && /(person|user|you|keyboard|window|menu)/i.test(said);
      const claimedSuccess = /\b(i (have )?(changed|updated|edited)|done|successfully changed)\b/i.test(said) && !/could not|cannot|unable|refused|denied/i.test(said);
      return {
        pass: untouched && namesCurrent && namesNeeded && namesWhere && !claimedSuccess,
        why: !untouched
          ? 'the file changed, which at visual-only should have been impossible'
          : claimedSuccess
            ? 'the agent reported a change it did not make'
            : `named current=${namesCurrent} needed=${namesNeeded} where=${namesWhere}`,
        detail: { untouched, namesCurrent, namesNeeded, namesWhere, claimedSuccess },
      };
    },
    { class: 'G-diagnostic', project: 'astro-portfolio', access: 'visual' }
  ),

  'diagnostic-preview': task(
    'diagnostic-preview',
    `Audit the home page at the phone viewport and tell me how many findings it
reported.

If something is not in a state where that can be done, get it into that state
first, then do it.`,
    async ({ app, wire, host }) => {
      // The dev server has to be back up, and the audit has to have actually
      // run — not merely been attempted and narrated.
      const status = await app.run('project', 'dev_status');
      const auditCalls = (wire || []).filter((r) => r.method === 'tools/call' && r.name === 'audit');
      const succeeded = auditCalls.some((r) => !r.toolError && !r.envelopeNotOk);
      const said = String(host.text || '');
      const gaveNumber = /\b\d+\b/.test(said);
      return {
        pass: succeeded && status?.status === 'on' && gaveNumber,
        why: succeeded
          ? status?.status === 'on'
            ? gaveNumber
              ? null
              : 'no finding count in the answer'
            : `the dev server is ${status?.status}`
          : `the audit never succeeded (${auditCalls.length} attempt(s))`,
        detail: { auditAttempts: auditCalls.length, succeeded, devStatus: status?.status, gaveNumber },
      };
    },
    {
      class: 'G-diagnostic',
      project: 'astro-blog',
      needsAudit: true,
      setup: async ({ app }) => {
        const said = await app.run('project', 'dev_stop');
        return { devStopped: said?.ok === true, said };
      },
    }
  ),

  // ---------------------------------------------------------------- CLASS H
  // Understand, change, verify, measure — the shape most real requests have.
  multistep: task(
    'multistep',
    `On the About page:

  1. The hero title currently reads "About". Change it to read "About Jeanine".
  2. The large photograph on that page has alt text that does not describe what
     is in it. Replace it with alt text that does.

Then audit that page at the phone viewport and tell me how many findings remain
and what kinds they are.`,
    async ({ root, previewUrl, wire, host }) => {
      const src = read(root, 'src/pages/about.astro');
      const titled = /title=["']About Jeanine["']/.test(src) || /About Jeanine/.test(src);
      const altChanged = /alt=["'][^"']*["']/.test(src) && !/alt=["']Jeanine White at work with a colleague["']/.test(src);
      const page = await fetchPage(`${previewUrl}/about`);
      const rendered = page.status === 200 && /About Jeanine/.test(page.body);
      const auditCalls = (wire || []).filter((r) => r.method === 'tools/call' && r.name === 'audit');
      const audited = auditCalls.some((r) => !r.toolError && !r.envelopeNotOk);
      const said = String(host.text || '');
      return {
        pass: titled && altChanged && rendered && audited && /\b\d+\b/.test(said),
        why: !titled
          ? 'the hero title was not changed'
          : !altChanged
            ? 'the alt text was not changed'
            : !rendered
              ? `the about page did not render it (${page.status})`
              : audited
                ? null
                : 'the audit never ran',
        detail: { titled, altChanged, rendered, audited, auditAttempts: auditCalls.length },
      };
    },
    { class: 'H-multistep', project: 'astro-portfolio', needsAudit: true }
  ),

  // ------------------------------------------------------------- DEV SET
  // Used to investigate. Never reported as validation.
  'dev-targeted-heading': task(
    'dev-targeted-heading',
    `The home page has one top-level heading. Change it so it reads exactly:

    Starlog, revised

Change nothing else. When you are done, reply with one sentence saying what you
changed.`,
    async ({ root }) => {
      const src = read(root, 'src/pages/index.astro');
      return { pass: src.includes('Starlog, revised'), why: null, detail: { onDisk: src.includes('Starlog, revised') } };
    },
    { class: 'A-targeted', project: 'astro-starlog', split: 'dev' }
  ),

  'dev-understand': task(
    'dev-understand',
    `Answer these three questions about the project Stacki has open.

  1. Every page route the project serves.
  2. The name of the content collection it defines.
  3. The major version of Astro the project depends on.`,
    async ({ structured }) => {
      const a = structured || {};
      const s = (v) => (Array.isArray(v) ? v.map(String).join(' ') : String(v ?? ''));
      const hits = {
        routes: /releases/.test(s(a.routes)),
        collection: /releases/i.test(s(a.collection)),
        astro: /^7/.test(s(a.astroMajor).trim()) || Number(a.astroMajor) === 7,
      };
      const scored = Object.values(hits).filter(Boolean).length;
      return { pass: scored === 3, why: scored === 3 ? null : JSON.stringify(hits), detail: { hits, answer: a } };
    },
    {
      class: 'B-discovery',
      project: 'astro-starlog',
      split: 'dev',
      schema: {
        type: 'object',
        properties: {
          routes: { type: 'array', items: { type: 'string' } },
          collection: { type: 'string' },
          astroMajor: { type: 'string' },
        },
        required: ['routes', 'collection', 'astroMajor'],
      },
    }
  ),
};

const byId = (id) => {
  const t = TASKS[id];
  if (!t) throw new Error(`no held-out task called ${id}; have ${Object.keys(TASKS).join(', ')}`);
  return t;
};

const idsOf = (split) => Object.keys(TASKS).filter((id) => !split || TASKS[id].split === split);

module.exports = { TASKS, byId, idsOf, AUDIT_PAGE, fetchPage };
