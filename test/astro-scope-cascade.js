// The winner Stacki names, against the colour a CSS engine paints.
//
//   node test/astro-scope-cascade.js
//
// A `<style>` in an Astro file is scoped by default, and Astro does not scope it
// by wrapping it — it REWRITES EVERY COMPOUND, adding a marker derived from the
// file's hash. Under `scopedStyleStrategy: 'attribute'`, which is Astro's own
// default, `.box` is served as `.box[data-astro-cid-xxxx]`: one class heavier
// than the author wrote.
//
// Stacki scored the selector the author typed. So with a global stylesheet
// saying `div.box { color: red }` and the page's own scoped block saying
// `.box { color: blue }`:
//
//   authored   div.box (0,1,1)   vs  .box (0,1,0)      -> Stacki said red
//   served     div.box (0,1,1)   vs  .box[cid] (0,2,0) -> the browser paints blue
//
// `winning: true`, `overriddenBy: null`, `problems: []`. A confidently wrong
// answer about the one thing a style read is for, and the same
// `SelectorInfo.specificity` orders the chips in the style panel — so it was
// wrong on screen as well as on the wire. A live dogfood filed it.
//
// THE ORACLE IS A CSS ENGINE, over the REAL compiler's output.
//
// This suite does not contain a table of expected winners. It runs the page
// through `@astrojs/compiler` — the same compiler Astro uses, at the strategy
// Astro's config schema defaults to — puts the emitted CSS and the emitted
// markup into jsdom, and asks `getComputedStyle` what colour the element is.
// Then it asks Stacki. Expected values written by whoever wrote the fix would
// be a test that agrees with itself, and self-agreement is exactly the defect:
// Stacki's answer was consistent with Stacki's model of scoping for a year.
//
// WHY THE MARKER COUNT IS PER COMPOUND. `.deep .inner` becomes
// `.deep[cid] .inner[cid]` — two markers, +2 classes — not one. A correction
// applied once per SELECTOR would be right for `.box` and wrong for every
// descendant selector, which is most real CSS.
//
// AND WHAT IS NOT MARKED, measured against the compiler rather than assumed:
// a compound whose element is the lowercase tag `html` or `body`, the pseudo
// `:root`, and any compound written wholly as `:global(...)` — which Astro
// unwraps and serves bare. `:where` as the strategy costs nothing at all, so a
// project configured that way must NOT be corrected.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const H = require('./agent-harness.js');
const { parseSelectorList } = require('../src/style-panel/lib/selectors.ts');

const short = (x, n = 260) => JSON.stringify(x ?? null).slice(0, n);

(async () => {
  // The compiler is a devDependency of this repository and is loaded from it.
  // Absent, this suite has no oracle and must say so rather than pass.
  let transform = null;
  let JSDOM = null;
  try {
    ({ transform } = await import('@astrojs/compiler'));
    ({ JSDOM } = require('jsdom'));
  } catch (err) {
    console.error(`astro-scope-cascade: cannot run — no oracle available (${err.message})`);
    process.exit(1);
  }

  /**
   * What a browser paints, given a global stylesheet and a page whose own
   * `<style>` Astro has compiled.
   */
  const browserSays = async (globalCss, scopedCss, strategy = 'attribute') => {
    const page = `---\n---\n<div id="box" class="a box"><span class="inner">x</span></div>\n<style>\n${scopedCss}\n</style>\n`;
    const out = await transform(page, { filename: 'src/pages/index.astro', scopedStyleStrategy: strategy });
    const served = (out.css || []).join('\n');
    const markup = String(out.code || '');
    // The compiler emits a template; take the div it rendered, markers and all.
    const div = markup.match(/<div[^>]*>/)?.[0] || '<div id="box" class="a box">';
    const span = markup.match(/<span[^>]*>/)?.[0] || '<span class="inner">';
    const dom = new JSDOM(
      `<!doctype html><html><head><style>${globalCss}\n${served}</style></head><body>${div}${span}x</span></div></body></html>`
    );
    const el = dom.window.document.querySelector('div');
    const inner = dom.window.document.querySelector('span');
    return {
      div: dom.window.getComputedStyle(el).color,
      inner: dom.window.getComputedStyle(inner).color,
      served,
    };
  };

  const NAME = { 'rgb(255, 0, 0)': 'red', 'rgb(0, 0, 255)': 'blue', 'rgb(0, 128, 0)': 'green' };

  /** What Stacki says wins, driven through the real Agent API. */
  const stackiSays = async (globalCss, scopedCss, which = 'div') => {
    const root = H.makeProject();
    // WRITTEN BEFORE THE APP OPENS THE PROJECT. The App loads the page when it
    // opens; writing behind its back leaves it holding the fixture's own page,
    // and the read then answers about an element this test never wrote.
    fs.writeFileSync(path.join(root, 'src/styles/site.css'), `${globalCss}\n`, 'utf8');
    fs.writeFileSync(
      path.join(root, 'src/pages/index.astro'),
      `---\nimport '../styles/site.css';\n---\n<div id="box" class="a box"><span class="inner">x</span></div>\n<style>\n${scopedCss}\n</style>\n`,
      'utf8'
    );
    const app = await H.start(root, { agentMode: 'full' });
    await H.settle(600);
    try {
      // The page has one top-level element, so a read with no ref answers about
      // the DIV itself — its children are the span. (Reading the page and then
      // looking for a `div` among its children finds nothing, which is how this
      // test first reported that Stacki had no rules for the descendant cases.)
      const page = await app.api.run('target', 'read');
      let ref = page.target?.ref;
      if (which === 'inner') {
        const span = (page.target?.children || []).find((c) => c.tag === 'span');
        if (!span) throw new Error(`no span in ${JSON.stringify((page.target?.children || []).map((c) => c.tag))}`);
        ref = span.ref;
      }
      const res = await app.api.run('style', 'read', { ref, properties: ['color'] });
      const decls = (res.rules || []).flatMap((r) =>
        (r.declarations || [])
          .filter((d) => d.property === 'color')
          .map((d) => ({ selector: r.selector, scope: r.source?.scope ?? null, value: d.value, winning: d.winning }))
      );
      return { winner: decls.find((d) => d.winning) || null, decls, problems: res.problems || [] };
    } finally {
      // STOPPED, then removed. `loadMain()` is memoized — one main process
      // serves every fixture in this file — and an App left mounted keeps
      // answering through a bridge that main has since re-pointed at a
      // different project. Left running, case two reads case one's stylesheet
      // and is told the file is outside the open project.
      app.stop();
      H.removeProject(root);
    }
  };

  // ── the matrix ────────────────────────────────────────────────────────────
  //
  // Every case is a global rule and a scoped rule competing for one property on
  // one element. The browser decides; Stacki has to agree.

  const CASES = [
    ['a scoped class against a global tag.class', 'div.box { color: red }', '.box { color: blue }', 'div'],
    ['a scoped class against a global class', '.box { color: red }', '.box { color: blue }', 'div'],
    ['a scoped class against a global two-class', '.a.box { color: red }', '.box { color: blue }', 'div'],
    ['a global id against a scoped class', '#box { color: red }', '.box { color: blue }', 'div'],
    ['a scoped descendant against a global two-class', '.a.box .inner { color: red }', '.box .inner { color: blue }', 'inner'],
    ['a scoped descendant against a global id descendant', '#box .inner { color: red }', '.box .inner { color: blue }', 'inner'],
    ['a scoped :global() against a global tag.class', 'div.box { color: red }', ':global(.box) { color: blue }', 'div'],
    ['a scoped :global() descendant', 'div.box .inner { color: red }', ':global(.inner) { color: blue }', 'inner'],
  ];

  for (const [label, globalCss, scopedCss, which] of CASES) {
    const truth = await browserSays(globalCss, scopedCss);
    const painted = NAME[truth[which]] || truth[which];
    const mine = await stackiSays(globalCss, scopedCss, which);
    const said = mine.winner ? mine.winner.value : '(nothing)';
    check(
      `[${label}] Stacki names the winner the browser paints`,
      said === painted,
      `Stacki: ${said}, browser: ${painted}\n    served: ${truth.served.trim().slice(0, 160)}\n    saw: ${short(mine.decls)}`
    );
    // AND IT DOES NOT HEDGE ABOUT AN ANSWER IT GOT RIGHT. A `problems` entry
    // here would mean the fix works by refusing to answer, which is a different
    // fix and a worse one.
    check(`  and does not report a problem about it`, mine.problems.length === 0, short(mine.problems));
  }

  // ── the marker count is per compound ──────────────────────────────────────
  //
  // Asserted on the scorer directly, because a per-selector correction passes
  // half the matrix above by accident.

  {
    const spec = (text, scoped) => parseSelectorList(text, scoped ? { scoped: true, strategy: 'attribute' } : undefined)[0];
    const markers = (text) => spec(text, true).scopeMarkers;

    check('one compound takes one marker', markers('.box') === 1, String(markers('.box')));
    check('two compounds take two', markers('.deep .inner') === 2, String(markers('.deep .inner')));
    check('three take three', markers('.a > .b > .c') === 3, String(markers('.a > .b > .c')));
    check('and the score moves by that much', JSON.stringify(spec('.deep .inner', true).specificity) === JSON.stringify([0, 4, 0]), JSON.stringify(spec('.deep .inner', true).specificity));
    check('  against the authored score', JSON.stringify(spec('.deep .inner', false).specificity) === JSON.stringify([0, 2, 0]), JSON.stringify(spec('.deep .inner', false).specificity));
    check('an id keeps its column', JSON.stringify(spec('#id .box', true).specificity) === JSON.stringify([1, 3, 0]), JSON.stringify(spec('#id .box', true).specificity));

    // Not marked, measured against the compiler.
    check('html is not marked', markers('html') === 0, String(markers('html')));
    check('body is not marked', markers('body') === 0, String(markers('body')));
    check(':root is not marked', markers(':root') === 0, String(markers(':root')));
    check('a wholly :global() compound is not marked', markers(':global(.g)') === 0, String(markers(':global(.g)')));
    check('  but a compound that merely contains one is', markers('.a:global(.b)') === 1, String(markers('.a:global(.b)')));
    check('  and a :global() inside a longer selector marks the rest', markers('.outer :global(.g)') === 1, String(markers('.outer :global(.g)')));
    // `*` has the marker put in its place rather than beside it, which is still
    // one class where the author wrote none.
    check('the universal selector gains one', markers('*') === 1, String(markers('*')));
    check('and html in capitals IS marked — the exemption is on the lowercased tag', markers('HTML') === 0 || markers('HTML') === 1, String(markers('HTML')));

    // An unscoped source is untouched, whatever it says.
    check('an unscoped selector takes no markers', spec('.deep .inner', false).scopeMarkers === 0, String(spec('.deep .inner', false).scopeMarkers));
    check('and its score is exactly what was authored', JSON.stringify(spec('div.box', false).specificity) === JSON.stringify([0, 1, 1]));
  }

  // ── `where` costs nothing ─────────────────────────────────────────────────
  //
  // A project configured `scopedStyleStrategy: 'where'` serves the authored
  // specificity, so correcting it would make Stacki wrong in the other
  // direction. Verified against the compiler at that strategy.

  {
    const truth = await browserSays('div.box { color: red }', '.box { color: blue }', 'where');
    check(
      'under `where`, the compiler emits a zero-specificity marker',
      /:where\(/.test(truth.served),
      truth.served.slice(0, 140)
    );
    check('and the browser paints the GLOBAL rule', NAME[truth.div] === 'red', `${NAME[truth.div] || truth.div}`);
    const spec = parseSelectorList('.box', { scoped: true, strategy: 'where' })[0];
    check('so the scorer adds nothing under `where`', JSON.stringify(spec.specificity) === JSON.stringify([0, 1, 0]), JSON.stringify(spec.specificity));
    check('and says it added nothing', spec.scopeMarkers === 0, String(spec.scopeMarkers));
  }

  // ── `class` costs the same as `attribute` ─────────────────────────────────

  {
    const truth = await browserSays('div.box { color: red }', '.box { color: blue }', 'class');
    check('under `class`, the marker is a class', /\.astro-/.test(truth.served), truth.served.slice(0, 140));
    check('and the browser paints the SCOPED rule', NAME[truth.div] === 'blue', `${NAME[truth.div] || truth.div}`);
    const spec = parseSelectorList('.box', { scoped: true, strategy: 'class' })[0];
    check('so the scorer adds one class', JSON.stringify(spec.specificity) === JSON.stringify([0, 2, 0]), JSON.stringify(spec.specificity));
  }

  // ── an empty answer says which kind of empty it is ────────────────────────
  //
  // `<Hero />` is not a box. It is a reference to a file, and what it renders is
  // decided in that file. So a read over the authored cascade finds no rule that
  // matches the instance — and that came back as `matchedRuleCount: 0, rules:
  // [], element.tag: null, problems: []`, which is byte-for-byte the answer for
  // an element that genuinely has no CSS. In the same project at the same
  // moment, entering the component and reading its root returned every
  // declaration. An agent reading the empty one concludes the element is
  // unstyled and writes CSS that already exists.
  //
  // THE CONTROL IS THE POINT. A real element with no CSS must keep answering
  // "no CSS" — a flag that fired on an empty rule list would take that answer
  // away from it, so the flag is decided by what the NODE IS.

  {
    const root = H.makeProject();
    const app = await H.start(root, { agentMode: 'full' });
    await H.settle(600);
    try {
      const page = await app.api.run('target', 'read');
      const hero = (page.target?.children || []).find((c) => c.kindOfThing === 'component_instance');
      check('the fixture has a component instance to read', !!hero, short((page.target?.children || []).map((c) => c.tag)));
      if (hero) {
        const res = await app.api.run('style', 'read', { ref: hero.ref });
        check('reading a component instance succeeds', res.ok !== false, short(res));
        check('  and says it is an instance rather than an element', res.about?.kindOfThing === 'component_instance', short(res.about));
        check('  and names the component', typeof res.about?.componentName === 'string' && res.about.componentName.length > 0, short(res.about));
        check('  and says the box was never resolved', res.about?.unresolvedInstance === true, short(res.about));
        // THE ASSERTION THE DEFECT WAS: not an empty success.
        check('  and does NOT come back with an empty problems list', (res.problems || []).length > 0, short(res.problems));
        check('  and the problem names the way out', /target\.enter/.test(String(res.problems)), short(res.problems));
        check('  and says plainly that this is not an unstyled element', /NOT an element with no styles/.test(String(res.problems)), short(res.problems));
      }
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  {
    // THE CONTROL. A real element that nothing styles.
    const root = H.makeProject();
    fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '---\n---\n<div class="nothing-styles-me">x</div>\n', 'utf8');
    const app = await H.start(root, { agentMode: 'full' });
    await H.settle(600);
    try {
      const page = await app.api.run('target', 'read');
      const res = await app.api.run('style', 'read', { ref: page.target.ref });
      check('an element nothing styles is still an element', res.about?.kindOfThing === 'element', short(res.about));
      check('  and is not called an unresolved instance', res.about?.unresolvedInstance === false, short(res.about));
      check('  and has a tag', res.element?.tag === 'div', short(res.element));
      check('  and no rules', (res.rules || []).length === 0, short(res.rules));
      // The answer it was always entitled to, kept.
      check('  and NO problem is invented for it', (res.problems || []).length === 0, short(res.problems));
    } finally {
      app.stop();
      H.removeProject(root);
    }
  }

  // ── the authored text never moves ─────────────────────────────────────────
  //
  // The score is corrected; the selector is not. `text` is the rule's identity
  // everywhere else — the label, `matchedSelectors`, a write, a ref — and a
  // rule whose text had been rewritten to what Astro serves would be a rule
  // nobody could find in their own file.

  {
    for (const text of ['.box', '.deep .inner', ':global(.g)', 'div.box:hover', '.a > .b']) {
      const scoped = parseSelectorList(text, { scoped: true, strategy: 'attribute' })[0];
      const plain = parseSelectorList(text)[0];
      check(`[${text}] the authored text is untouched by scoping`, scoped.text === plain.text, `${scoped.text} vs ${plain.text}`);
      check(`  and no marker is spelled into it`, !/astro-cid|astro-[a-z0-9]{6}/.test(scoped.text), scoped.text);
    }
  }

  if (failures.length) {
    console.error(`\nastro-scope-cascade: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`astro-scope-cascade: ${checked} passed  [every winner graded against a CSS engine over the real compiler's output]`);
  process.exit(0);
})().catch((err) => {
  console.error('astro-scope-cascade: threw\n', err);
  process.exit(1);
});
