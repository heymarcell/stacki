// What style.read is allowed to claim.
//
//   node test/style-cascade-truth.js
//
// A cascade answer is not a list of rules. It is an assertion about a rendered
// box — this declaration wins, that one is overridden, nothing else reaches
// here — and every one of those is a statement an agent will act on without
// looking. So the failures this file is about are not missing rules. They are
// SENTENCES THAT ARE NOT TRUE:
//
//   two declarations of the same property both saying they win;
//   a stylesheet the page never loads reported as the winner over one it does;
//   `rules: [], rulesOmitted: 0` printed beside a populated `computed`, which
//   says "nothing styles this" about an element the browser is plainly styling;
//   "the stylesheet changed since you read it" about a rule that was never in
//   it, and a stylesheet that was never read.
//
// Each section below names the sentence, and asserts the response cannot say
// it. The harness (agent-harness.js) is the real main process, the real Astro
// parser and the real Style-panel cascade — there is no canvas, so anything
// this file says about the LIVE document is about how honestly its absence is
// reported. The one thing that needs a real CSSOM is checked against the
// shipped preload text itself, in a jsdom document, at the end.

const fs = require('fs');
const path = require('path');
const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// A stylesheet with more matching rules than style.read will ever print, so the
// display cap is a fact the response has to account for rather than a silence.
const MANY = Array.from({ length: 45 }, (_, i) => `.many { --n-${i}: ${i}; }`).join('\n');

const FIXTURE = {
  // Tailwind 4 is a Vite plugin, not an Astro integration: naming it is the
  // only honest thing Stacki can say about the utilities it generates.
  'package.json': JSON.stringify(
    {
      name: 'cascade-fixture',
      type: 'module',
      dependencies: { astro: '^5.0.0', tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0' },
    },
    null,
    2
  ),

  // The one stylesheet the layout actually imports.
  'src/styles/site.css': `@import "tailwindcss";

:root {
  --gap: 1rem;
  --brand: #3355ff;
}

.pricing-grid {
  display: grid;
  gap: var(--gap);
}

.card {
  padding: 1rem;
}

@media (min-width: 768px) {
  .pricing-grid {
    gap: 2rem;
  }
}
`,

  // Imported by nothing. listCssFiles walks the whole project, so it is in the
  // cascade anyway — the question is whether the answer says so.
  'src/styles/zz-unimported.css': `.pricing-grid {
  gap: 99px;
}
`,

  'src/styles/many.css': `${MANY}\n`,

  // A component's scoped block whose only escape hatch is `:global()`. Astro
  // leaves those rules unhashed, so `display: inline-grid` genuinely reaches
  // the page's `.pricing-grid`; `.escaping` beside it is hashed and does not.
  'src/components/Escaping.astro': `<span class="escaping">esc</span>
<style>
  .escaping { color: blue; }
  .pricing-grid { color: rebeccapurple; }
  :global(.pricing-grid) { outline: 2px dashed blue; }
</style>
`,

  // The false positive the Astro hash exists to prevent: a scoped rule for a
  // class this component does not render. It must never be offered.
  'src/components/Badge.astro': `<span class="badge">new</span>
<style>
  .badge { color: red; }
  .pricing-grid { outline: 3px solid red; }
</style>
`,

  // The dogfood's own case: a component's scoped rules for an element that
  // component renders. Both of these DO apply, and the second one wins.
  'src/components/Nav.astro': `<nav class="nav">
  <a class="link" href="/" aria-current="page">Home</a>
</nav>
<style>
  .link { color: var(--brand); }
  .link[aria-current] { color: #fff; }
</style>
`,

  'src/pages/index.astro': `---
import Base from '../layouts/Base.astro';
import Nav from '../components/Nav.astro';
import Badge from '../components/Badge.astro';
import Escaping from '../components/Escaping.astro';
import Card from '../components/Card.astro';
---
<Base>
  <Nav />
  <Badge />
  <Escaping />
  <div class="pricing-grid">
    <p class="many">many</p>
  </div>
  <div class="grid h-screen place-items-center">utilities only</div>
  <Card title="One" body="Two" />
</Base>
`,
};

class Skip extends Error {}

// A section whose subject does not exist yet must report every OTHER section's
// verdict rather than taking the run down with it.
const section = async (fn) => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Skip) return;
    failures.push(`  a section threw before it could finish\n    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  }
};

const declsOf = (answer, prop) =>
  (answer.rules || []).flatMap((r) => (r.declarations || []).filter((d) => d.property === prop).map((d) => ({ ...d, rule: r })));

(async () => {
  const root = H.makeProject(FIXTURE);
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  const page = await run('target', 'read');
  const kids = page.target.children;
  const grid = kids.find((c) => c.label === 'pricing-grid');
  const util = kids.find((c) => c.label === 'grid');
  const navInstance = kids.find((c) => c.tag === 'Nav');
  check('the fixture page has the elements this file is about', !!grid && !!util && !!navInstance, short(kids.map((c) => c.label || c.tag)));

  const gridStyles = await run('style', 'read', { ref: grid.ref, properties: ['gap', 'display'] });
  check('style.read answers about the grid', gridStyles.ok === true, short(gridStyles));

  // ── F16c2 · one property, one winner ───────────────────────────────────────
  //
  // `.pricing-grid { gap: var(--gap) }` and `@media (min-width: 768px) { …
  // gap: 2rem }` are both in site.css. Whatever the answer says about the
  // media-query one, it cannot also be "this is the declaration that wins" —
  // nothing here knows the viewport.

  await section(async () => {
    const gaps = declsOf(gridStyles, 'gap');
    check('every gap declaration reaching the grid is reported', gaps.length >= 3, short(gaps.map((d) => `${d.rule.selector}:${d.value}`)));
    const claimedWinners = gaps.filter((d) => d.winning === true);
    check(
      'and exactly one of them claims to win',
      claimedWinners.length === 1,
      short(gaps.map((d) => ({ sel: d.rule.selector, at: d.rule.atContext, value: d.value, winning: d.winning })))
    );
    const media = gaps.find((d) => (d.rule.atContext || []).length > 0);
    check('a declaration inside @media does not claim to be the winner', media && media.winning === null, short(media && { winning: media.winning }));
    check(
      'and says the condition it is waiting for instead',
      media && Array.isArray(media.appliesWhen) && /min-width: 768px/.test(media.appliesWhen.join(' ')),
      short(media && media.appliesWhen)
    );
  });

  // ── F16c1 · a winner has an address ────────────────────────────────────────
  //
  // Three files in this fixture declare `gap` for `.pricing-grid`. A bare
  // selector string cannot name which of them won, and one of them is a
  // stylesheet nothing imports.

  await section(async () => {
    const gaps = declsOf(gridStyles, 'gap');
    const loser = gaps.find((d) => d.winning === false);
    check('an overridden declaration exists to be asked about', !!loser, short(gaps.map((d) => d.winning)));
    check(
      'and the thing overriding it is named by source, not only by selector',
      loser && loser.overriddenBy && typeof loser.overriddenBy === 'object' && typeof loser.overriddenBy.source === 'string',
      short(loser && loser.overriddenBy)
    );
    check(
      'so the winner can be found in the file it was authored in',
      loser && /^file:src\/styles\//.test(loser.overriddenBy.source),
      short(loser && loser.overriddenBy)
    );

    const fromSite = (gridStyles.rules || []).find((r) => r.source.file === 'src/styles/site.css' && r.selector === '.pricing-grid');
    const fromNowhere = (gridStyles.rules || []).find((r) => r.source.file === 'src/styles/zz-unimported.css');
    check('the imported stylesheet is reported as reaching this page', fromSite && fromSite.source.reachedByOpenPage === true, short(fromSite && fromSite.source));
    check(
      'and the one nothing imports is not claimed to reach it',
      fromNowhere && fromNowhere.source.reachedByOpenPage === 'unknown',
      short(fromNowhere && fromNowhere.source)
    );
    check(
      'and the answer says what set the cascade was decided over',
      typeof gridStyles.coverage?.cascadeScope === 'string' && /whether or not/.test(gridStyles.coverage.cascadeScope),
      short(gridStyles.coverage?.cascadeScope)
    );
  });

  // ── F16a · a scoped block belongs to what it rendered, and to nothing else ─
  //
  // Badge.astro's `.pricing-grid { outline: 3px solid red }` is hashed to
  // Badge's own elements and cannot reach the page's grid. Nav.astro's rules
  // for the link Nav renders DO reach it. Both halves, or the fix is a
  // regression in one direction or the other.

  await section(async () => {
    const badge = (gridStyles.rules || []).find((r) => /Badge/.test(r.source.label || '') && r.selector === '.pricing-grid');
    check("another component's scoped rule is not offered for an element it did not render", !badge, short(badge && badge.source));

    const inside = await run('target', 'enter', { ref: navInstance.ref });
    const link = (inside.target.children || []).find((c) => c.tag === 'a');
    const linkStyles = await run('style', 'read', { ref: link.ref, properties: ['color'] });
    const colors = declsOf(linkStyles, 'color');
    check("a component's own scoped rules reach the element it rendered", colors.length === 2, short(colors.map((d) => d.rule.selector)));
    check(
      'and the more specific one is reported as the winner',
      colors.find((d) => d.winning === true)?.rule.selector === '.link[aria-current]',
      short(colors.map((d) => ({ sel: d.rule.selector, winning: d.winning })))
    );
    check(
      'and a scoped block is marked as scoped, not as page-wide CSS',
      colors.every((d) => d.rule.source.scope === 'scoped'),
      short(colors.map((d) => d.rule.source.scope))
    );
    await run('target', 'exit');
  });

  // ── F16a2 · `:global()` inside a scoped block escapes the component ────────

  await section(async () => {
    const escaped = (gridStyles.rules || []).find((r) => /Escaping/.test(r.source.label || ''));
    check('a :global() rule in another component reaches the page and is reported', !!escaped, short((gridStyles.rules || []).map((r) => r.source.label)));
    check('with the selector Astro leaves behind, not the :global() wrapper', escaped && escaped.selector === '.pricing-grid', short(escaped && escaped.selector));
    check('and the declaration it carries', escaped && escaped.declarations.some((d) => d.property === 'outline'), short(escaped && escaped.declarations));
    check('and it is marked as reaching the page globally', escaped && escaped.source.scope === 'global', short(escaped && escaped.source));
    // The rule directly above it in the same block is NOT wrapped, so Astro
    // hashes it to Escaping's own elements and it can never paint the page's
    // grid — even though its selector matches the page's grid exactly. Offering
    // it is the false positive the hash exists to prevent, and now that the file
    // is scanned it is the pruning that has to prevent it.
    const hashed = (gridStyles.rules || [])
      .flatMap((r) => (r.declarations || []).map((d) => ({ selector: r.selector, source: r.source.label, value: d.value })))
      .find((d) => d.value === 'rebeccapurple');
    check('while the hashed rule beside it in the same block is not offered', !hashed, short(hashed));
    check(
      'and a rule Stacki must not write back says so',
      escaped && escaped.editable === false,
      short(escaped && { editable: escaped.editable })
    );
    // Being a source of rules is not the same as being somewhere to put one.
    const asDestination = (gridStyles.writableSources || []).find((w) => /Escaping/.test(w.label));
    check('and the component it came from is not offered as somewhere to write', asDestination && asDestination.writable === false, short(asDestination));
    check('while a real stylesheet is', (gridStyles.writableSources || []).some((w) => w.label === 'src/styles/site.css' && w.writable === true), short(gridStyles.writableSources));

    // Asked to write there anyway, it refuses with the reason rather than with
    // a shrug — and the component file is untouched.
    const before = app.read('src/components/Escaping.astro');
    const refused = await run('style', 'set_property', {
      ref: grid.ref,
      identity: escaped.declarations[0].identity,
      property: 'outline',
      value: '9px solid black',
    });
    check('writing into a :global() rule is refused', refused.ok === false && refused.code === 'read_only', short(refused));
    check('and says where the rule really lives', /scoped <style>/.test(String(refused.message)), short(refused.message));
    check('and the component file is byte-for-byte what it was', app.read('src/components/Escaping.astro') === before);
  });

  // ── F16d · a count that names its own unit ────────────────────────────────

  await section(async () => {
    const many = (await run('target', 'read', { ref: grid.ref })).target.children.find((c) => c.label === 'many');
    const manyStyles = await run('style', 'read', { ref: many.ref });
    check('45 matching rules are matched', manyStyles.listCap?.matched === 45, short(manyStyles.listCap));
    check('and 40 are returned', manyStyles.listCap?.returned === 40, short(manyStyles.listCap));
    check('and the five that were not are attributed to the cap, by name', manyStyles.listCap?.omittedByCap === 5, short(manyStyles.listCap));
    check('and the cap itself is stated', manyStyles.listCap?.max === 40, short(manyStyles.listCap));
  });

  // ── F16b, F16e · rules[] reconciled against computed ──────────────────────
  //
  // `class="grid h-screen place-items-center"` is Tailwind. Those utilities
  // exist only in the dev server's generated stylesheet, so no amount of
  // scanning authored files will find them. The response may not answer
  // "nothing reaches this element, and nothing was left out".

  await section(async () => {
    const utilStyles = await run('style', 'read', { ref: util.ref, properties: ['display'] });
    check('the utility element still reports its classes', (utilStyles.element?.classes || []).includes('h-screen'), short(utilStyles.element));
    check('no authored rule is invented for it', (utilStyles.rules || []).length === 0, short((utilStyles.rules || []).map((r) => r.selector)));
    check('and the cap did not bite', utilStyles.listCap?.omittedByCap === 0, short(utilStyles.listCap));
    check('but the answer does not claim complete coverage', utilStyles.coverage?.complete === false, short(utilStyles.coverage));
    check(
      'it says generated CSS is outside what it read',
      (utilStyles.coverage?.excludes || []).some((t) => /generated at build time/i.test(t)),
      short(utilStyles.coverage?.excludes)
    );
    check(
      'and names the dependency that generates it, from package.json',
      /@tailwindcss\/vite@\^4\.1\.0/.test(String(utilStyles.coverage?.note || '')),
      short(utilStyles.coverage?.note)
    );
    check(
      'and does not guess which of the classes are utilities',
      !/h-screen|place-items-center/.test(JSON.stringify(utilStyles.coverage || {})),
      short(utilStyles.coverage)
    );
    check(
      'the absence of a preview is reported as absence of a preview',
      utilStyles.coverage?.runtime?.available === false && /preview|canvas/i.test(String(utilStyles.coverage.runtime.reason)),
      short(utilStyles.coverage?.runtime)
    );
    check(
      'and not as absence of rules',
      utilStyles.documentRules === null,
      short({ documentRules: utilStyles.documentRules })
    );
    check(
      'with no canvas there is no computed value to reconcile against, and it says so',
      utilStyles.explainsComputed === null && Array.isArray(utilStyles.unexplained) && utilStyles.unexplained.length === 0,
      short({ explainsComputed: utilStyles.explainsComputed, unexplained: utilStyles.unexplained })
    );
  });

  // The reconciliation itself, driven directly: a computed value no returned
  // rule can account for must come back as unexplained. The harness has no
  // canvas, so the rule is exercised through the module the canvas feeds.

  await section(async () => {
    const { reconcileComputed } = await styleModule();
    check('the reconciliation is a thing that can be asked on its own', typeof reconcileComputed === 'function');
    if (typeof reconcileComputed !== 'function') throw new Skip('reconcileComputed');
    const rules = [{ declarations: [{ property: 'gap', winning: true }, { property: 'color', winning: false }] }];
    const out = reconcileComputed(rules, { display: 'grid', gap: '16px', color: 'red' });
    check('a property with a winning authored declaration is explained', !out.unexplained.some((u) => u.property === 'gap'), short(out.unexplained));
    check('a property only a losing declaration mentions is not', out.unexplained.some((u) => u.property === 'color'), short(out.unexplained));
    check('and a property nothing authored declares is not', out.unexplained.some((u) => u.property === 'display'), short(out.unexplained));
    check('so the answer does not claim to explain the computed style', out.explainsComputed === false);
    check('and with nothing computed it claims nothing either way', reconcileComputed(rules, null).explainsComputed === null);
  });

  // ── F16f · the element style.read is talking about ───────────────────────

  await section(async () => {
    const compStyles = await run('style', 'read', { ref: navInstance.ref });
    check(
      'a component instance says where its identity came from',
      compStyles.element?.identitySource === 'model',
      short(compStyles.element)
    );
    const gridEl = (await run('style', 'read', { ref: grid.ref })).element;
    check('and a plain element does too', gridEl.identitySource === 'model' && gridEl.tag === 'div', short(gridEl));
  });

  // ── F16g · three refusals, three sentences ───────────────────────────────
  //
  // "The stylesheet changed since you read it" is advice: read it again. For a
  // source that was never loaded, and for a rule that was never in the file,
  // following that advice produces the identical failure for ever.

  await section(async () => {
    const notLoaded = await run('style', 'set_property', {
      ref: grid.ref,
      identity: { source: 'file:src/styles/generated.css', sourceLabel: 'generated.css', selector: '.pricing-grid', atContext: [], property: 'gap' },
      property: 'gap',
      value: '3rem',
    });
    check('a source that was never loaded is not called stale', notLoaded.code === 'no_source', short(notLoaded));
    check(
      'and the message does not blame a change that did not happen',
      !/(?<!not )changed since you read it/.test(String(notLoaded.message)) && !/[Rr]ead the styles again/.test(String(notLoaded.message)),
      short(notLoaded.message)
    );

    const neverThere = await run('style', 'set_property', {
      ref: grid.ref,
      identity: { source: 'file:src/styles/site.css', sourceLabel: 'src/styles/site.css', selector: '.never-authored', atContext: [], property: 'gap' },
      property: 'gap',
      value: '3rem',
    });
    check('a rule that was never in a real stylesheet gets its own code', neverThere.code === 'no_rule', short(neverThere));
    check(
      'and is not diagnosed as staleness, nor told to read again',
      !/(?<!not )changed since you read it/.test(String(neverThere.message)) && !/[Rr]ead the styles again/.test(String(neverThere.message)),
      short(neverThere.message)
    );
    check('and the stylesheet was not touched', /gap: var\(--gap\)/.test(app.read('src/styles/site.css')));

    // And the real staleness path still fires, or the fix above traded one
    // wrong answer for another.
    const fresh = await run('style', 'read', { ref: grid.ref });
    const gapDecl = declsOf(fresh, 'gap').find((d) => d.rule.source.file === 'src/styles/site.css' && !(d.rule.atContext || []).length);
    app.write('src/styles/site.css', app.read('src/styles/site.css').replace('--brand: #3355ff;', '--brand: #3355ff; --extra: 1px;'));
    await H.settle(200);
    const stale = await run('style', 'set_property', { ref: grid.ref, identity: gapDecl.identity, property: 'gap', value: '3rem' });
    check('a stylesheet that really did change is still refused as stale', stale.code === 'stale_target', short(stale));
    check('and says so', /changed since you read it/.test(String(stale.message)), short(stale.message));
  });

  // ── F16h · zero rules from zero sources is not zero rules ────────────────
  //
  // The file list style.read reads from is loaded by the Style panel's own
  // effects, and the panel mounts only when a person opens the Style tab. In an
  // MCP-only session it may never have rendered — and an empty cascade then
  // says nothing whatever about the element.

  await section(async () => {
    const answer = await run('style', 'read', { ref: grid.ref });
    check('the answer says how many sources it read', Number.isInteger(answer.coverage?.sourcesScanned), short(answer.coverage));
    check('and it read some', answer.coverage.sourcesScanned >= 3, short(answer.coverage));
    check('and breaks them down by what kind they are', answer.coverage.kinds?.stylesheet >= 3, short(answer.coverage.kinds));

    // The agent path with NO panel at all: a host record holding the page model
    // and nothing else, which is what an MCP-only session leaves it as. The
    // stylesheets have to be found from here, and found without writing the
    // list back into the record the panel owns.
    const mod = await styleModule();
    mod.setHost({
      projectPath: root,
      nodes: [{ id: 'solo', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'pricing-grid' } }, children: [] }],
      selectedId: 'solo',
      files: [],
      astroFiles: [],
      openFilePath: null,
      renderedClasses: [],
      pathOf: null,
    });
    const solo = await mod.readStyles({ id: 'solo', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'pricing-grid' } } }, {});
    check(
      'style.read finds the project stylesheets itself when the panel never did',
      solo.rules.some((r) => r.source.file === 'src/styles/site.css' && r.selector === '.pricing-grid'),
      short({ scanned: solo.coverage?.sourcesScanned, rules: solo.rules.map((r) => r.source.key) })
    );
    check('and says it read them', solo.coverage?.sourcesScanned >= 3, short(solo.coverage));
    check('and does not write the list into the record the panel owns', mod.getHost().files.length === 0, short(mod.getHost().files.length));

    // The refusal that must survive it: with no project to ask, an empty
    // cascade has to say it is empty for want of a source, not for want of CSS.
    mod.setHost({ projectPath: null, files: [], astroFiles: [] });
    const blind = await mod.readStyles({ id: 'solo', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'pricing-grid' } } }, {});
    check('with nothing to scan the answer says so rather than saying no CSS', blind.coverage?.sourcesScanned === 0 && blind.problems.some((p) => /no stylesheet/i.test(p)), short({ cov: blind.coverage, problems: blind.problems }));
  });

  app.stop();
  H.removeProject(root);

  // ── F16b, the half that needs a real CSSOM ────────────────────────────────
  //
  // Generated CSS exists only in the served document. The preload is what can
  // see it, and it runs in an isolated world no test can require — so the
  // SHIPPED TEXT of its collector is evaluated here, against a jsdom document
  // holding a stylesheet no authored file in the project contains.

  await section(async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    const collector = sliceFunction(source, 'matchedRulesIn');
    check('the preload still ships the collector this section is about', !!collector, 'function matchedRulesIn was not found in electron/preload.js');
    if (collector) {
      const { JSDOM } = require('jsdom');
      const dom = new JSDOM(`<!doctype html><html><head><style>
        .grid { display: grid; }
        .h-screen { height: 100vh; }
        @media (min-width: 900px) { .grid { gap: 2rem; } }
        .nope { color: red; }
      </style></head><body><div class="grid h-screen" id="el"></div></body></html>`);
      const fn = new Function(`${collector}; return matchedRulesIn;`)();
      const out = fn(dom.window.document, dom.window.document.getElementById('el'), 50);
      const selectors = out.rules.map((r) => r.selector);
      check('the collector finds the rules the document says match', selectors.includes('.grid') && selectors.includes('.h-screen'), short(selectors));
      check('and not the ones it says do not', !selectors.includes('.nope'), short(selectors));
      check('it carries the declarations, so the value is readable', /display/.test(out.rules.find((r) => r.selector === '.grid').cssText), short(out.rules[0]));
      check('and marks every one of them as belonging to the document', out.rules.every((r) => r.origin === 'document' && r.editable === false), short(out.rules[0]));
      check('and gives none of them a project file to edit', out.rules.every((r) => !('file' in r) && !('identity' in r)), short(out.rules[0]));
      check('a conditional rule is reported with its condition, not as a plain match', out.rules.some((r) => /min-width: 900px/.test(String(r.atContext || ''))), short(out.rules.map((r) => r.atContext)));
      check('and it counts the sheets it could not read', out.unreadable === 0, short(out));
    }
  });

  console.log(`\nstyle-cascade-truth: ${checked} checks, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

/** The text of one top-level `function name(…) { … }`, brace-matched. */
function sliceFunction(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) return null;
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return null;
}

// The agent's own style modules, bundled the way the app bundles them (they
// import TypeScript), so the host record can be put into the state an MCP-only
// session leaves it in — a page model and no panel. A second module instance
// with its own host is exactly what that needs: the app's copy keeps whatever
// the panel gave it.
let styleModuleCache = null;
async function styleModule() {
  if (styleModuleCache) return styleModuleCache;
  const esbuild = require('esbuild');
  const repo = path.join(__dirname, '..');
  const dir = path.join(repo, 'node_modules', '.stacki-test');
  fs.mkdirSync(dir, { recursive: true });
  const outfile = path.join(dir, 'style-cascade-truth.bundle.js');
  await esbuild.build({
    stdin: {
      contents: "export * from './src/agent/styleAgent.js'\nexport { setHost, getHost } from './src/style-panel/lib/host.ts'\n",
      resolveDir: repo,
      loader: 'js',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  styleModuleCache = require(outfile);
  return styleModuleCache;
}
