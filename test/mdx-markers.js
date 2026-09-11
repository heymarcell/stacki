// The preview's markers, on a project that has .mdx in it.
//
//   node test/mdx-markers.js
//
// Stacki hands Astro one markdown processor, and Astro uses it for two
// pipelines. Markdown renders to an HTML string, so a `{type:'html'}` mdast node
// is exactly the right way to smuggle a `<template data-avb-s="N">` marker in.
// MDX compiles to JSX, where a raw-HTML node is not representable at all, and
// mdxjs-rs does not shrug at it — it refuses the document:
//
//   MDXError: Cannot compile a `raw` node (raw HTML) to MDX/JSX output.
//   ... (mdxjs-rs:raw-html)
//
// So opening a project that contained any .mdx made every .mdx route answer
// HTTP 500 — in the previewed copy only, which is the cruellest shape for it:
// the project's own `astro dev` was fine, so it reads as the project's fault.
// It was found by auditing the official Astro blog starter, which ships
// `using-mdx.mdx`. That was the default first-run experience.
//
// WHAT THIS DRIVES. Not a copy of the plugin. `writeMarkerConfig` is lifted out
// of electron/main.js and run for real, so the file under test is the
// astro.config.mjs the app actually generates, and the processor under test is
// the object that config actually hands Astro. A copy of the marker plugin
// pasted in here would have kept passing while the shipped one was broken,
// which is the failure mode this repository is named after.
//
// The satteri that compiles is the fixture project's own, resolved from its
// node_modules the way Astro resolves it.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const {
  makeCanvasProject,
  removeCanvasProject,
  astroCached,
  sweepStaleRuns,
} = require('./agent-canvas-fixture.js');
const { skipSuite } = require('./support/suiteGuard.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

// Declared through skipSuite, so STACKI_NO_SKIPS can forbid a run that asserts
// nothing — a suite that exits 0 having checked nothing is indistinguishable
// from one that passed.
if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  skipSuite('mdx-markers', 'no astro cache and STACKI_CANVAS_OFFLINE is set');
  process.exit(process.exitCode || 0);
}

sweepStaleRuns({ log: (m) => console.log(`mdx-markers: ${m}`) });

// ---------------------------------------------------------------------------
// The real thing, lifted out of main
// ---------------------------------------------------------------------------

// `resolveNodeBin` is answered with this process's own node so that
// `parsesAsModule` really spawns `node --check` over the generated config. That
// is not incidental: the config is a template literal inside a template
// literal, an unescaped backtick in a comment is enough to break it, and the
// app's own answer to a config that will not parse is to silently start a
// preview without outlines. Here it is a failure with a name.
function loadWriteMarkerConfig() {
  const electronDir = path.join(__dirname, '..', 'electron');
  const src = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
  const start = src.indexOf('const PATHS_ENDPOINT = `');
  const end = src.indexOf('async function spawnDevServer(');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('writeMarkerConfig is no longer where this test reads it from (electron/main.js)');
  }
  const logs = [];
  const fn = new Function(
    'fs',
    'path',
    'spawnSync',
    'toPosix',
    'resolveNodeBin',
    'pushDevLog',
    '__dirname',
    `${src.slice(start, end)}; return writeMarkerConfig;`
  )(
    fs,
    path,
    spawnSync,
    (p) => p.split(path.sep).join('/'),
    () => process.execPath,
    (chunk) => logs.push(String(chunk)),
    electronDir
  );
  return { writeMarkerConfig: fn, logs };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// The shape the Astro blog starter ships: prose, headings, a bare import, a JSX
// element with children, and a list. The import matters — it is a root child
// that is deliberately NOT wrapped, so it also checks the numbering offset.
const MDX_BODY = `This theme comes with the [mdx](https://example.com/mdx) integration.

## Why MDX?

MDX is Markdown that supports embedded JavaScript & JSX syntax.

## Example

import Thing from '../../components/Thing.astro';

<Thing href="#">
	Embedded component in MDX
</Thing>

## More Links

- [one](https://example.com/one)
- [two](https://example.com/two)
`;

const MD_BODY = `# A plain markdown post

Lorem ipsum dolor sit amet, consectetur adipiscing elit.

- one
- two
`;

const SHARED = { gfm: true, smartypants: true, syntaxHighlight: 'shiki', shikiConfig: {} };

// What was actually exercised, printed on the way out. A suite that says only
// "10 passed" cannot tell you it ran against an Astro too old to have the thing
// under test — which is exactly how this suite first went red on CI and green on
// every desk.
let exercised = '';

const main = async () => {
  const { writeMarkerConfig, logs } = loadWriteMarkerConfig();
  const root = makeCanvasProject({
    harness: 'mdx-markers',
    log: (m) => console.log(`mdx-markers: ${m}`),
  });

  try {
    // ── the generated config exists, and node agrees it is a module ────────
    const cfgPath = writeMarkerConfig(root);
    if (
      !check(
        'writeMarkerConfig wrote a config node can load',
        cfgPath && fs.existsSync(cfgPath),
        logs.join('') || String(cfgPath)
      )
    ) {
      return;
    }

    const require_ = createRequire(path.join(root, 'package.json'));
    const cfg = (await import(pathToFileURL(cfgPath).href)).default;
    const processor = cfg && cfg.markdown && cfg.markdown.processor;
    if (
      !check(
        'the generated config hands Astro a satteri processor',
        processor && processor.name === 'satteri',
        JSON.stringify({ markdown: Object.keys((cfg && cfg.markdown) || {}), name: processor && processor.name })
      )
    ) {
      return;
    }
    // WHETHER THE REGRESSION IS REACHABLE ON THIS ASTRO AT ALL.
    //
    // satteri grew `createMdxRenderer` at some point; before it, Astro had no
    // MDX pipeline for a processor to poison and @astrojs/mdx said so plainly.
    // A stale never-invalidated CI cache key served exactly such an Astro, and
    // this suite failed there while passing on every desk. That is a fact about
    // the fixture's Astro, not a defect in the app, so it is reported as what it
    // is — and it is an ERROR where a skip would be a lie (STACKI_NO_SKIPS).
    // Walked up from the resolved entry rather than resolved as a subpath:
    // satteri's `exports` map publishes "." and nothing else, so asking for
    // `@astrojs/markdown-satteri/package.json` throws and the version silently
    // read "unknown" — a detail line that cannot be wrong is worth more.
    const satteriVersion = (() => {
      try {
        let dir = path.dirname(require_.resolve('@astrojs/markdown-satteri'));
        for (let up = 0; up < 5; up++) {
          const manifest = path.join(dir, 'package.json');
          if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
          dir = path.dirname(dir);
        }
      } catch {
        /* reported as unknown below */
      }
      return 'unknown';
    })();
    const hasMdxPipeline = typeof processor.createMdxRenderer === 'function';
    exercised = `satteri ${satteriVersion}, MDX pipeline ${hasMdxPipeline ? 'exercised' : 'ABSENT'}`;
    if (!hasMdxPipeline) {
      const reason = `satteri ${satteriVersion} has no createMdxRenderer, so the raw-HTML regression is not reachable on this Astro`;
      const forbidding = process.env.STACKI_NO_SKIPS;
      if (forbidding && forbidding !== '0') {
        check('the MDX half of this suite could run at all', false, reason);
      } else {
        console.log(`mdx-markers: MDX half not run  [${reason}]`);
      }
    }

    const mdxId = path.join(root, 'src', 'content', 'posts', 'using-mdx.mdx');
    const mdId = path.join(root, 'src', 'content', 'posts', 'plain.md');

    if (hasMdxPipeline) {
      // ── MDX COMPILES, AND KEEPS ITS MARKERS ───────────────────────────────
      let compiled = null;
      let mdxError = null;
      try {
        const renderer = await processor.createMdxRenderer(SHARED, {
          srcDir: pathToFileURL(path.join(root, 'src') + path.sep),
          sourcemap: false,
        });
        compiled = await renderer.process(MDX_BODY, mdxId, { title: 'Using MDX' });
      } catch (err) {
        mdxError = err;
      }

      // THE REGRESSION. Before the fix this threw mdxjs-rs:raw-html, the route
      // 500'd, and no amount of reading the project explained why.
      check(
        'an .mdx document compiles through the preview processor',
        !mdxError,
        mdxError && String(mdxError.message || mdxError).replace(/\s+/g, ' ').slice(0, 300)
      );

      if (!mdxError) {
        const code = String(compiled.code || '');
        const starts = (code.match(/data-avb-s/g) || []).length;
        const ends = (code.match(/data-avb-e/g) || []).length;
        // Compiling is half of it. A fix that made MDX compile by dropping the
        // markers would leave every .mdx page with no outlines and nothing
        // saying so, which is the same defect wearing a green tick.
        check('the compiled MDX carries start markers', starts > 0, `starts=${starts}`);
        check(
          'every start marker is matched by an end marker',
          starts === ends,
          `starts=${starts} ends=${ends}`
        );
        check(
          'the markers are template elements, as the collector and AVB_CLEANUP expect',
          /template/.test(code),
          code.slice(0, 200)
        );
      }
    }

    // ── MARKDOWN IS UNCHANGED ─────────────────────────────────────────────
    // The markdown pipeline still gets the raw-HTML marker, which is correct
    // there and is what every outline in the app has always been built from.
    let rendered = null;
    let mdError = null;
    try {
      const renderer = await processor.createRenderer(SHARED);
      rendered = await renderer.render(MD_BODY, {
        fileURL: pathToFileURL(mdId),
        frontmatter: {},
      });
    } catch (err) {
      mdError = err;
    }
    check(
      'a .md document still renders through the preview processor',
      !mdError,
      mdError && String(mdError.message || mdError).replace(/\s+/g, ' ').slice(0, 300)
    );
    if (!mdError) {
      const html = String(rendered.code || rendered.html || '');
      check(
        'markdown still gets its raw-HTML marker',
        html.includes('<template data-avb-s="'),
        html.slice(0, 200)
      );
    }

    if (hasMdxPipeline) {
      // ── THE HAZARD IS STILL A HAZARD ──────────────────────────────────────
      // A control, so that the assertion above cannot pass for the wrong reason.
      // If satteri ever starts accepting a raw-HTML node in an MDX document, the
      // regression this file guards stops being reachable, and this says so out
      // loud rather than leaving a test that proves nothing.
      const { satteri } = await import(pathToFileURL(require_.resolve('@astrojs/markdown-satteri')).href);
      const rawMarkerPlugin = () => ({
        name: 'raw-html-marker',
        paragraph: (node, ctx) => {
          const parent = ctx.parent(node);
          if (!parent || parent.type !== 'root') return;
          ctx.insertBefore(node, { type: 'html', value: '<template data-avb-s="0"></template>' });
        },
      });
      let controlError = null;
      try {
        const renderer = await satteri({ mdastPlugins: [rawMarkerPlugin] }).createMdxRenderer(SHARED, {
          srcDir: pathToFileURL(path.join(root, 'src') + path.sep),
          sourcemap: false,
        });
        await renderer.process(MDX_BODY, mdxId, { title: 'Using MDX' });
      } catch (err) {
        controlError = err;
      }
      check(
        'a raw-HTML marker in the MDX pipeline is still refused, so the fix is still load-bearing',
        controlError && /raw/i.test(String(controlError.message || controlError)),
        controlError
          ? String(controlError.message || controlError).replace(/\s+/g, ' ').slice(0, 200)
          : 'it compiled — satteri now accepts raw HTML in MDX; this control needs rewriting'
      );
    }

  } finally {
    // Cleanup failure is test failure, not a warning.
    try {
      removeCanvasProject(root);
      check('the fixture project is gone', !fs.existsSync(root), root);
    } catch (err) {
      check('the fixture project could be removed', false, String(err && err.message));
    }
  }
};

main()
  .then(() => {
    if (failures.length) {
      console.error(`\nmdx-markers: ${failures.length} failed, ${checked - failures.length} passed\n`);
      console.error(failures.join('\n') + '\n');
      process.exit(1);
    }
    console.log(`mdx-markers: ${checked} passed${exercised ? `  [${exercised}]` : ''}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nmdx-markers: threw\n  ${String((err && err.stack) || err)}\n`);
    process.exit(1);
  });
