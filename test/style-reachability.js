// What a cascade answer is allowed to decide, and over which files.
//
//   node test/style-reachability.js
//
// `winning: true` is not a fact about a stylesheet. It is a claim about a box
// on a screen: of every declaration that reaches this element, THIS is the one
// the browser is using. So a declaration in a file the page never loads cannot
// be it — cannot be the winner, cannot be the thing an on-page declaration is
// told it lost to, and cannot be named as the reason one lost.
//
// All three were being said. `style.read` over a project with one unimported
// stylesheet and one orphaned component answered, in a single payload:
//
//   src/styles/site.css        gap: var(--gap)  winning: false
//                                overriddenBy: file:src/styles/zz-unimported.css
//   src/styles/zz-unimported   gap: 99px        winning: true    (reached: 'unknown')
//   src/components/Orphan      outline: magenta winning: true    (reached: FALSE)
//
// The last line is self-contradictory on its face, and the reason all three
// happened is ordering rather than arithmetic: the cascade was computed over
// every rule in the project and reachability was pinned on afterwards, a label
// stuck to a decision it had no part in.
//
// This file is about the ordering. It asserts what the response may claim for
// each tier of evidence, and it carries a POSITIVE CONTROL for every refusal —
// make the file genuinely reach the page and the same declaration must become
// eligible — because a blanket "never win" would pass every negative here and
// would be a worse answer than the one it replaced.
//
// The harness (agent-harness.js) is the real main process, the real Astro
// parser and the real Style-panel cascade. Where a section needs a SERVED
// document it builds one: a jsdom page, read by the shipped text of the
// preload's own rule collector, answered back through the real canvas bridge.

const fs = require('fs');
const path = require('path');
const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

class Skip extends Error {}

const section = async (fn) => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Skip) return;
    failures.push(`  a section threw before it could finish\n    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
  }
};

// ── the project ─────────────────────────────────────────────────────────────
//
// Three tiers of evidence about one element, so the answer has to tell them
// apart rather than hedge them all the same way:
//
//   site.css        imported by the layout the page uses         → proved here
//   zz-unimported   imported by nothing, and later in document   → nothing proved
//                   order, so it wins any cascade it is let into
//   Orphan.astro    imported by nothing; Astro emits a component's CSS for the
//                   pages whose module graph holds it, so its `:global()` rule
//                   is proved NOT to be here
//   Escaping.astro  the same shape as Orphan, imported by the page — the half
//                   that makes "not loaded" a finding rather than a blanket

const BASE_LAYOUT = `---
import '../styles/site.css';
---
<html lang="en">
  <head><title>Fixture</title></head>
  <body>
    <slot />
  </body>
</html>
`;

const INDEX = `---
import Base from '../layouts/Base.astro';
import Escaping from '../components/Escaping.astro';
---
<Base>
  <Escaping />
  <div class="pricing-grid card-x">
    <p class="many">many</p>
  </div>
</Base>
`;

const FIXTURE = {
  'package.json': JSON.stringify({ name: 'reach-fixture', type: 'module', dependencies: { astro: '^5.0.0' } }, null, 2),

  'src/styles/site.css': `:root {
  --gap: 1rem;
}

.pricing-grid {
  display: grid;
  gap: var(--gap);
}

@media (min-width: 50em) {
  .pricing-grid { gap: 4rem; }
}

@media (min-width: 900px) {
  .pricing-grid { row-gap: 5rem; }
}
`,

  // IMPORTED BY NOTHING, and sorted after site.css, so in a cascade that let it
  // in it beats the stylesheet the page actually loads — which is exactly what
  // it was doing.
  'src/styles/zz-unimported.css': `.pricing-grid {
  gap: 99px;
  letter-spacing: 9px;
}
`,

  // ALSO IMPORTED BY NOTHING, and — unlike the one above — nothing in it shares
  // a selector with anything the page serves. That is the difference a running
  // preview can see: a file whose every matching rule is missing from the
  // browser's own list is not loaded, whatever an import walk could not follow.
  'src/styles/zz-ghost.css': `div.pricing-grid {
  word-spacing: 7px;
}
`,

  // IMPORTED BY NOTHING. `:global()` leaves the rule unhashed, so it looks
  // exactly like a rule that reaches the page — and the escaped-rule scan reads
  // every .astro file in the PROJECT, which is how it got offered as one.
  'src/components/Orphan.astro': `<span class="orphan">orphan</span>
<style>
  :global(.pricing-grid) { outline: 9px solid magenta; }
  :global(.card-x) { text-indent: 9px; }
</style>
`,

  // The same shape, imported by the page. Its rule really does reach the
  // element and must not be denied along with the orphan.
  'src/components/Escaping.astro': `<span class="escaping">esc</span>
<style>
  :global(.pricing-grid) { color: rebeccapurple; }
</style>
`,

  'src/layouts/Base.astro': BASE_LAYOUT,
  'src/pages/index.astro': INDEX,
};

// The viewport section wants ONE stylesheet and no argument about whether it is
// on the page, so that what decides `winning` there is the width and nothing
// else. Same media queries, one file, imported by the layout.
const VIEW_FIXTURE = {
  'package.json': FIXTURE['package.json'],
  'src/styles/site.css': FIXTURE['src/styles/site.css'],
  'src/layouts/Base.astro': BASE_LAYOUT,
  'src/pages/index.astro': `---
import Base from '../layouts/Base.astro';
---
<Base>
  <div class="pricing-grid">priced</div>
</Base>
`,
};

const declsOf = (answer, prop) =>
  (answer.rules || []).flatMap((r) =>
    (r.declarations || []).filter((d) => d.property === prop).map((d) => ({ ...d, rule: r }))
  );
const ruleFrom = (answer, file, prop) =>
  (answer.rules || []).find((r) => r.source.file === file && (r.declarations || []).some((d) => d.property === prop));
const declFrom = (answer, file, prop) =>
  declsOf(answer, prop).find((d) => d.rule.source.file === file);

(async () => {
  // ── 1 · the three tiers, read through the whole product ───────────────────

  const root = H.makeProject(FIXTURE);
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  const page = await run('target', 'read');
  const grid = (page.target.children || []).find((c) => (c.label || '').includes('pricing-grid'));
  check('the fixture page has the element this file is about', !!grid, short((page.target.children || []).map((c) => c.label || c.tag)));
  if (!grid) {
    console.log(`\nstyle-reachability: ${checked} checks, ${failures.length} failed`);
    console.log(failures.join('\n'));
    process.exit(1);
  }

  const before = await run('style', 'read', { ref: grid.ref, properties: ['gap', 'outline', 'color', 'letter-spacing', 'text-indent'] });
  check('style.read answers about it', before.ok === true, short(before));

  // ── A · A STYLESHEET NOTHING IMPORTS DECIDES NOTHING ──────────────────────

  await section(async () => {
    const ghost = ruleFrom(before, 'src/styles/zz-unimported.css', 'gap');
    check('the unimported stylesheet is still LISTED — it is in the project', !!ghost, short((before.rules || []).map((r) => r.source.file)));
    if (!ghost) throw new Skip('zz-unimported');
    check(
      'and is not claimed to reach the page',
      ghost.source.reachedByOpenPage === 'unknown',
      short(ghost.source)
    );
    check(
      '  with the reason spelled out: a walk ran from this page and did not arrive',
      ghost.source.reachEvidence === 'unproven',
      short(ghost.source)
    );

    const ghostGap = ghost.declarations.find((d) => d.property === 'gap');
    check('its declaration cannot claim to be the winner', ghostGap.winning !== true, short(ghostGap));
    check(
      '  and says why it is not an answer, rather than leaving a bare null',
      typeof ghostGap.unprovenSource === 'string' && /import chain/.test(ghostGap.unprovenSource),
      short(ghostGap)
    );

    // The half that costs the reader most: the declaration that IS on the page
    // being told, by name and by file, that it lost to one that is not.
    const real = declFrom(before, 'src/styles/site.css', 'gap');
    check('the imported stylesheet is reported as reaching the page', real.rule.source.reachedByOpenPage === true, short(real.rule.source));
    check('and its declaration is not reported as losing', real.winning !== false, short({ winning: real.winning, by: real.overriddenBy }));
    check(
      '  because nothing that is not proved to be here may be an `overriddenBy`',
      (before.rules || []).every((r) =>
        (r.declarations || []).every((d) => !d.overriddenBy || d.overriddenBy.source !== 'file:src/styles/zz-unimported.css')
      ),
      short((before.rules || []).flatMap((r) => r.declarations.map((d) => d.overriddenBy?.source || null)))
    );
    // Not silence either: what stopped it from being a plain `true` is named.
    check(
      'it is contested instead, by the file that might yet turn out to be here',
      real.winning === null && (real.contestedBy || []).some((c) => c.source === 'file:src/styles/zz-unimported.css'),
      short({ winning: real.winning, contestedBy: real.contestedBy })
    );

    // NEGATIVE CONTROL FOR THE WHOLE SECTION. A property only the reaching
    // stylesheet declares still resolves to an answer — the fix must not have
    // turned `winning` into a field that is always null.
    const display = declFrom(before, 'src/styles/site.css', 'display');
    check(
      'a property only the page\'s own stylesheet sets still has a winner',
      display && display.winning === true,
      short(display && { value: display.value, winning: display.winning })
    );
  });

  // ── B · A COMPONENT THE PAGE DOES NOT IMPORT IS NOT ON THE PAGE ───────────

  await section(async () => {
    const orphan = ruleFrom(before, 'src/components/Orphan.astro', 'outline');
    check('the orphaned component\'s escaped rule is not silently dropped', !!orphan, short((before.rules || []).map((r) => r.source.file)));
    if (!orphan) throw new Skip('orphan');
    check('it is proved not to reach the page', orphan.source.reachedByOpenPage === false, short(orphan.source));
    check('  which is the one tier that may be published as false', orphan.source.reachEvidence === 'not-loaded', short(orphan.source));

    const magenta = orphan.declarations.find((d) => d.property === 'outline');
    check(
      'and `reachedByOpenPage: false` no longer sits beside `winning: true`',
      magenta.winning !== true,
      short({ reached: orphan.source.reachedByOpenPage, winning: magenta.winning })
    );
    check(
      '  nor beside `winning: false`, which would name a winner it never ran against',
      magenta.winning === null && magenta.overriddenBy === null,
      short(magenta)
    );
    check(
      '  it was left out of the cascade, and the answer says so in words',
      typeof magenta.notInCascade === 'string' && /not loaded by this page/.test(magenta.notInCascade),
      short(magenta.notInCascade)
    );

    // AND IT CANNOT DEFEAT SOMETHING THAT IS ACTUALLY HERE. Escaping.astro is
    // the same construct — a `:global()` rule escaping a scoped block — in a
    // component this page imports.
    const escaping = ruleFrom(before, 'src/components/Escaping.astro', 'color');
    check('a component the page DOES import reaches it', escaping && escaping.source.reachedByOpenPage === true, short(escaping && escaping.source));
    const purple = escaping.declarations.find((d) => d.property === 'color');
    check('  and its declaration is an answer, not a hedge', purple.winning === true, short(purple));
    check(
      '  so the two are told apart rather than both denied',
      orphan.source.reachedByOpenPage !== escaping.source.reachedByOpenPage,
      short([orphan.source.reachedByOpenPage, escaping.source.reachedByOpenPage])
    );
  });

  // ── C · THE SAME SELECTOR IN TWO FILES IS NOT THE SAME RULE ───────────────
  //
  // `reconcileComputed` signs for the browser's rules: a rule the served
  // document reports that no authored source accounts for is the response's own
  // evidence that its scan is incomplete. It was matching them on selector text
  // alone — so `:global(.card-x)` in a component nothing imports would sign for
  // a `.card-x` the browser reported, and the answer would stop saying it could
  // not account for it. Eleven identical characters, two different rules.

  await section(async () => {
    const { reconcileComputed } = await styleModule();
    const document = [{ selector: '.card-x', cssText: 'text-indent: 9px;', stylesheet: 'inline <style>' }];
    const orphanRule = (reached) => [
      {
        selector: ':global(.card-x)',
        matchedSelectors: ['.card-x'],
        declarations: [{ property: 'text-indent', value: '9px', winning: null }],
        source: { file: 'src/components/Orphan.astro', reachedByOpenPage: reached },
      },
    ];

    const denied = reconcileComputed(orphanRule(false), null, document);
    check(
      'a rule in a source the page does not load may not sign for the browser\'s rule',
      denied.unaccountedRules.length === 1 && denied.unaccountedRules[0].selector === '.card-x',
      short(denied.unaccountedRules)
    );
    // POSITIVE CONTROL: the identical rule, identical selector, identical
    // declaration — from a source that IS on the page.
    const allowed = reconcileComputed(orphanRule(true), null, document);
    check(
      '  while the same rule from a source that is accounts for it',
      allowed.unaccountedRules.length === 0,
      short(allowed.unaccountedRules)
    );
    check(
      '  and one nothing could prove either way still accounts for it, because "unknown" is not "no"',
      reconcileComputed(orphanRule('unknown'), null, document).unaccountedRules.length === 0,
      short(reconcileComputed(orphanRule('unknown'), null, document).unaccountedRules)
    );

    // The same rule, one axis over: a property whose only declaration is in a
    // source the page does not load is NOT explained by it.
    const unexplained = reconcileComputed(orphanRule(false), { 'text-indent': '9px' }, null);
    check(
      'and a computed value it cannot be the cause of is reported unexplained',
      unexplained.unexplained.some((u) => u.property === 'text-indent'),
      short(unexplained.unexplained)
    );
    check(
      '  which the same declaration from a reaching source does explain',
      reconcileComputed(orphanRule(true), { 'text-indent': '9px' }, null).unexplained.length === 0,
      short(reconcileComputed(orphanRule(true), { 'text-indent': '9px' }, null).unexplained)
    );
  });

  // ── INSIDE A COMPONENT, NOTHING IS DENIED ─────────────────────────────────
  //
  // `openFilePath` becomes the component the moment somebody drills into one,
  // and a walk rooted there is a walk through PART of the page. What it does
  // not reach it may not deny — the page above imports the rest — so from in
  // here every source but the open file's own blocks is unchecked, and the
  // project's stylesheet still gets to win an argument.

  await section(async () => {
    const instance = (page.target.children || []).find((c) => c.tag === 'Escaping');
    if (!instance) throw new Skip('no Escaping instance');
    const inside = await run('target', 'enter', { ref: instance.ref });
    const span = (inside.target.children || []).find((c) => c.tag === 'span');
    if (!span) throw new Skip('no span inside Escaping');
    const styles = await run('style', 'read', { ref: span.ref, properties: ['color'] });
    check(
      'from inside a component nothing is published as not-loaded',
      (styles.rules || []).every((r) => r.source.reachedByOpenPage !== false),
      short((styles.rules || []).map((r) => [r.source.file, r.source.reachedByOpenPage]))
    );
    check(
      '  and no source is held against another on evidence that cannot exist here',
      (styles.rules || []).every((r) => r.source.reachEvidence !== 'unproven'),
      short((styles.rules || []).map((r) => [r.source.file, r.source.reachEvidence]))
    );
    await run('target', 'exit');
  });

  // ── A/B POSITIVE CONTROLS · make them reach, and they become eligible ─────
  //
  // Everything above is a refusal, and a refusal that is hard-coded passes
  // every one of them. So the SAME files are made to reach this page — the
  // layout imports the stylesheet, the page imports the component — and the
  // same declarations must go from "may not decide" to deciding.

  await section(async () => {
    app.write('src/layouts/Base.astro', BASE_LAYOUT.replace("import '../styles/site.css';", "import '../styles/site.css';\nimport '../styles/zz-unimported.css';"));
    app.write('src/pages/index.astro', INDEX.replace("import Escaping from '../components/Escaping.astro';", "import Escaping from '../components/Escaping.astro';\nimport Orphan from '../components/Orphan.astro';"));
    await H.settle(300);
    const after = await run('style', 'read', { ref: grid.ref, properties: ['gap', 'outline', 'letter-spacing'] });

    const ghost = ruleFrom(after, 'src/styles/zz-unimported.css', 'gap');
    check('the stylesheet the layout now imports is proved to reach the page', ghost && ghost.source.reachedByOpenPage === true, short(ghost && ghost.source));
    check('  and says which evidence says so', ghost && ghost.source.reachEvidence === 'loaded', short(ghost && ghost.source));
    const spacing = ghost.declarations.find((d) => d.property === 'letter-spacing');
    check(
      '  so a property only it declares is now an answer',
      spacing.winning === true && !spacing.unprovenSource,
      short(spacing)
    );
    // And the sentence that was a lie before is now simply true: the imported
    // stylesheet later in document order really does override the earlier one.
    const real = declFrom(after, 'src/styles/site.css', 'gap');
    check(
      '  and it may now be the thing an earlier stylesheet lost to',
      real.winning === false && real.overriddenBy && real.overriddenBy.source === 'file:src/styles/zz-unimported.css',
      short({ winning: real.winning, by: real.overriddenBy })
    );

    const orphan = ruleFrom(after, 'src/components/Orphan.astro', 'outline');
    check('the component the page now imports reaches it', orphan && orphan.source.reachedByOpenPage === true, short(orphan && orphan.source));
    const magenta = orphan.declarations.find((d) => d.property === 'outline');
    check('  and its rule is back in the cascade', magenta.winning === true && !magenta.notInCascade, short(magenta));

    // Put the fixture back, so the sections after this read the project this
    // file describes.
    app.write('src/layouts/Base.astro', BASE_LAYOUT);
    app.write('src/pages/index.astro', INDEX);
    await H.settle(300);
    const restored = await run('style', 'read', { ref: grid.ref, properties: ['outline'] });
    check(
      'and undoing the imports puts the refusal back, so the answer tracks the project',
      ruleFrom(restored, 'src/components/Orphan.astro', 'outline').source.reachedByOpenPage === false,
      short(ruleFrom(restored, 'src/components/Orphan.astro', 'outline').source)
    );
  });

  app.stop();
  H.removeProject(root);

  // ── D · THE VIEWPORT THE ANSWER IS ABOUT ──────────────────────────────────
  //
  // The app measures it — PreviewPane reports the iframe's own client box, App
  // holds it as `canvasReport`, and it travels in the MCP payload as
  // `page.viewportWidth` — and `readStyles` has always accepted one. Nothing
  // handed it over. So a live read of an element inside `@media (min-width:
  // 50em)` came back `viewport: null` and hedged `winning: null` about a query
  // the app could see holds, which is the same "two answers to one question"
  // in a payload that also carries the resolved `computed`.
  //
  // The seam is `src/agent/commands.js`, and this drives THAT: the shipped
  // `createAgentCommands`, over a real project, with the app bundle it is
  // written against. The canvas report is the stub — there is no iframe in a
  // jsdom to measure — and it is the only stub: the cascade, the parser and
  // the stylesheet are real.

  await section(async () => {
    const mod = await styleModule();
    if (typeof mod.createAgentCommands !== 'function') throw new Skip('commands');
    const vroot = H.makeProject(VIEW_FIXTURE);
    const vapp = await H.start(vroot, { agentMode: 'full' });
    await H.settle(300);
    // try/finally rather than a trailing stop(): a section that throws half way
    // must still hand the temporary project back, or the run leaves one behind
    // for every failure it reports.
    try {
      const node = { id: 'grid', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'pricing-grid' } }, children: [] };
      const bundleFor = (canvas) => ({
        project: () => ({ path: vroot }),
        selectedId: () => 'grid',
        model: () => ({ nodes: [node] }),
        openFile: () => 'src/pages/index.astro',
        revision: () => 1,
        digest: () => 'model-digest',
        pathFor: () => null, // no preview: this section is about the query, not the browser
        canvas: () => canvas,
        select: () => {},
        settle: async () => {},
      });
      const readAt = async (canvas) => {
        mod.setHost({
          projectPath: vroot,
          nodes: [node],
          selectedId: 'grid',
          files: [],
          astroFiles: [],
          openFilePath: `${vroot}/src/pages/index.astro`,
          renderedClasses: [],
          pathOf: null,
        });
        return mod.createAgentCommands(() => bundleFor(canvas))({ domain: 'style', action: 'read', properties: ['gap'] });
      };

      // 50em is 800px. The report is the shape PreviewPane publishes.
      const wide = await readAt({ device: 'desktop', viewportWidth: 1200, viewportHeight: 900 });
      const narrow = await readAt({ device: 'phone', viewportWidth: 375, viewportHeight: 812 });
      const blind = await readAt(null);

      const gaps = (answer) => declsOf(answer, 'gap');
      const inQuery = (answer) => gaps(answer).find((d) => (d.rule.atContext || []).some((a) => /min-width: 50em/.test(a)));
      const inBase = (answer) => gaps(answer).find((d) => !(d.rule.atContext || []).length);

      check('the command surface answers at all', wide.ok === true && narrow.ok === true && blind.ok === true, short({ wide: wide.ok, narrow: narrow.ok, blind: blind.ok }));
      check('and the fixture stylesheet reached it', gaps(wide).length >= 2, short(gaps(wide).map((d) => `${d.rule.selector}:${d.value}`)));

      check(
        'the measured viewport reaches the answer, and the answer names it',
        wide.viewport && wide.viewport.width === 1200 && wide.viewport.height === 900,
        short(wide.viewport)
      );
      check('at 1200 the media declaration is the one that wins', inQuery(wide)?.winning === true, short(inQuery(wide)));
      check('  and does not stay "unknown" at a viewport that decides it', inQuery(wide)?.appliesWhen === null, short(inQuery(wide)));
      check(
        '  while the base declaration it supersedes is reported OVERRIDDEN',
        inBase(wide)?.winning === false && /min-width: 50em/.test(String(inBase(wide)?.overriddenBy?.atContext || '')),
        short({ winning: inBase(wide)?.winning, by: inBase(wide)?.overriddenBy })
      );
      check('  exactly one declaration of the property is the resting winner', gaps(wide).filter((d) => d.winning === true).length === 1, short(gaps(wide).map((d) => [d.value, d.winning])));

      // THE PX FORM OF THE SAME QUESTION, in the same stylesheet.
      const rowGap = (answer) => declsOf(answer, 'row-gap').find((d) => (d.rule.atContext || []).some((a) => /900px/.test(a)));
      check('a px query is decided by the same measurement', rowGap(wide)?.winning === true, short(rowGap(wide)));
      check('  and is ruled out at a width below it', rowGap(narrow)?.winning === null && Array.isArray(rowGap(narrow)?.appliesWhen), short(rowGap(narrow)));

      check('at 375 the answer says which viewport it is about', narrow.viewport?.width === 375, short(narrow.viewport));
      check('  the base declaration is the winner there', inBase(narrow)?.winning === true, short(inBase(narrow)));
      check('  and the media one says what it is waiting for', inQuery(narrow)?.winning === null && /min-width: 50em/.test(String(inQuery(narrow)?.appliesWhen || '')), short(inQuery(narrow)));

      // AND WITH NOTHING MEASURED, NO GUESS. A width taken from a device name
      // would be wrong for the two devices that fill the pane or are dragged, and
      // a wrong viewport is a confidently wrong winner.
      check('with no canvas report the answer says no viewport rather than assuming one', blind.viewport === null, short(blind.viewport));
      check('  and neither declaration claims the property', gaps(blind).every((d) => d.winning !== true), short(gaps(blind).map((d) => [d.value, d.winning])));
      check(
        '  naming the query that makes it undecidable',
        (inBase(blind)?.contestedBy || []).some((c) => /min-width: 50em/.test(String(c.atContext))),
        short(inBase(blind)?.contestedBy)
      );

    } finally {
      vapp.stop();
      H.removeProject(vroot);
    }
  });

  // ── E · WHAT A RUNNING PREVIEW SETTLES THAT AN IMPORT WALK CANNOT ─────────
  //
  // An import walk can never say `false` about a stylesheet: an @import inside
  // a package, a Vite plugin or astro.config can load one nothing here can
  // follow. The browser can. Its list of matching rules IS what reaches this
  // element, and when it can be trusted whole — every sheet readable, short
  // enough that the preload's cap dropped nothing — a selector missing from it
  // is a selector that is not here.
  //
  // ONE DIRECTION ONLY, and the direction matters: absence is proof, presence
  // is not. "The browser reports `.pricing-grid`, so this file's
  // `.pricing-grid` is the one it is reporting" is the conflation section C is
  // about. So this narrows `unproven` to `not-loaded` and never the reverse.

  await section(async () => {
    const mod = await styleModule();
    if (typeof mod.setCanvasFrame !== 'function') throw new Skip('canvas bridge');
    const { JSDOM } = require('jsdom');
    const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    const collector = sliceFunction(preloadSource, 'matchedRulesIn');
    const producer = sliceProperty(preloadSource, 'documentRules');
    const cap = Number((preloadSource.match(/const MAX_DOCUMENT_RULES = (\d+);/) || [])[1]);
    check('the preload still ships the collector this section reads the page with', !!collector && !!producer && cap > 0, short({ collector: !!collector, cap }));
    if (!collector || !producer) throw new Skip('preload');
    // The cap is mirrored in styleAgent, because a list that HIT it may be
    // missing the very rule this takes as proof of absence. Two copies of a
    // number is a bug waiting to happen, so the two are compared here.
    const mirrored = Number((fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'styleAgent.js'), 'utf8').match(/const MAX_DOCUMENT_RULES = (\d+);/) || [])[1]);
    check('and the cap the cascade trusts is the cap the preload enforces', mirrored === cap, `styleAgent ${mirrored} vs preload ${cap}`);

    const matchedRulesIn = new Function(`${collector}; return matchedRulesIn;`)();
    const reply = new Function('d', 'els', 'document', 'matchedRulesIn', 'MAX_DOCUMENT_RULES', `return ({ ${producer} });`);

    const eroot = H.makeProject(FIXTURE);
    const eapp = await H.start(eroot, { agentMode: 'full' });
    await H.settle(300);
    try {
      const node = { id: 'served', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'pricing-grid card-x' } }, children: [] };
      // What the dev server actually serves for this page: site.css's rules, and
      // the orphan's `.card-x` is NOT among them — because the orphan is not on
      // this page. `div.pricing-grid` is not among them either.
      const SERVED = `.pricing-grid { display: grid; gap: var(--gap); } .card-x { text-indent: 9px; }`;
      const CANNED = { display: 'grid', gap: '16px', color: 'rebeccapurple', 'text-indent': '9px' };
      const serve = (css) =>
        new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body><div id="el" class="pricing-grid card-x"></div></body></html>`).window.document;
      const previewServing = (doc) => ({
        postMessage(message) {
          const el = doc.getElementById('el');
          const computedProps = {};
          for (const prop of message.props || []) computedProps[prop] = CANNED[prop] ?? null;
          setImmediate(() =>
            mod.receiveCanvasReply({
              type: 'avb:query-result',
              id: message.id,
              ready: true,
              found: true,
              identity: null,
              matched: {},
              computed: {},
              computedProps,
              ...reply({ rules: message.rules }, [el], doc, matchedRulesIn, cap),
            })
          );
        },
      });
      const read = async (css) => {
        mod.setHost({
          projectPath: eroot,
          nodes: [node],
          selectedId: 'served',
          files: [],
          astroFiles: [],
          openFilePath: `${eroot}/src/pages/index.astro`,
          renderedClasses: [],
          pathOf: null,
        });
        if (css !== null) mod.setCanvasFrame(previewServing(serve(css)));
        const out = await mod.readStyles(node, { pathOf: () => 'src/pages/index.astro#0.0.0' });
        mod.setCanvasFrame(null);
        return out;
      };

      // With no preview, the import walk is all there is, and `div.pricing-grid`
      // in the unimported stylesheet is undecidable — so it contests.
      const dark = await read(null);
      const darkGhost = (dark.rules || []).find((r) => r.selector === 'div.pricing-grid');
      check('with no preview the unimported rule is unproven, not denied', darkGhost && darkGhost.source.reachEvidence === 'unproven', short(darkGhost && darkGhost.source));

      const lit = await read(SERVED);
      check('the preview answered with the rules the document says match', Array.isArray(lit.documentRules) && lit.documentRules.length > 0, short(lit.documentRules));
      const litGhost = (lit.rules || []).find((r) => r.selector === 'div.pricing-grid');
      check(
        'a selector a trustworthy document never reports does not reach the element',
        litGhost && litGhost.source.reachedByOpenPage === false && litGhost.source.reachEvidence === 'not-loaded',
        short(litGhost && litGhost.source)
      );
      check(
        '  so its declaration is out of the cascade rather than contesting it',
        litGhost && litGhost.declarations[0].winning === null && /not loaded by this page/.test(String(litGhost.declarations[0].notInCascade)),
        short(litGhost && litGhost.declarations[0])
      );
      // AND THE POINT OF NARROWING: an answer that had to hedge now does not.
      const wordSpacing = declsOf(dark, 'word-spacing')[0];
      check('the hedge it removed was a real one', wordSpacing && wordSpacing.winning === null, short(wordSpacing));

      // AND THE DIRECTION IT REFUSES TO GO. The browser reports `.pricing-grid`,
      // and the unimported stylesheet also declares `.pricing-grid` — that is not
      // evidence that the browser is reporting THIS file's rule, and it must not
      // be promoted by it.
      const stillGhost = (lit.rules || []).find((r) => r.source.file === 'src/styles/zz-unimported.css' && r.selector === '.pricing-grid');
      check(
        'sharing a selector with a rule the browser reports proves nothing about the file',
        stillGhost && stillGhost.source.reachedByOpenPage === 'unknown' && stillGhost.source.reachEvidence === 'unproven',
        short(stillGhost && stillGhost.source)
      );
      check(
        '  so it still may not claim the property',
        stillGhost && stillGhost.declarations.find((d) => d.property === 'gap').winning !== true,
        short(stillGhost && stillGhost.declarations)
      );

      // AND THE ORPHAN'S `:global(.card-x)` MAY NOT SIGN FOR THE SERVED `.card-x`.
      check(
        'the served rule an off-page component merely shares a selector with is named unaccounted',
        (lit.coverage?.runtime?.unaccountedRules || []).some((r) => r.selector === '.card-x'),
        short(lit.coverage?.runtime?.unaccountedRules)
      );
      check('  so the answer does not claim complete coverage', lit.coverage?.complete === false, short(lit.coverage?.complete));

      // POSITIVE CONTROL for that last pair: author the same selector in the
      // stylesheet the page really loads, and the same served rule IS accounted
      // for. Without this, "unaccounted" could be hard-wired.
      eapp.write('src/styles/site.css', `${eapp.read('src/styles/site.css')}\n.card-x { text-indent: 9px; }\n`);
      await H.settle(200);
      const owned = await read(SERVED);
      check(
        'the same served rule, authored in a stylesheet the page loads, IS accounted for',
        !(owned.coverage?.runtime?.unaccountedRules || []).some((r) => r.selector === '.card-x'),
        short(owned.coverage?.runtime?.unaccountedRules)
      );

    } finally {
      eapp.stop();
      H.removeProject(eroot);
    }
  });

  console.log(`\nstyle-reachability: ${checked} checks, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

/** The text of one `name: …,` property in an object literal, bracket-matched. */
function sliceProperty(source, name) {
  const at = source.indexOf(`${name}: `);
  if (at === -1) return null;
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return source.slice(at, i).trim().replace(/,$/, '');
      depth--;
    } else if (c === ',' && depth === 0) return source.slice(at, i).trim();
  }
  return null;
}

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

// The agent's own modules, bundled the way the app bundles them (they import
// TypeScript), so the command surface, the style agent and the host record are
// ONE instance sharing ONE host — which is what driving `createAgentCommands`
// against a stub app bundle needs.
let styleModuleCache = null;
async function styleModule() {
  if (styleModuleCache) return styleModuleCache;
  const esbuild = require('esbuild');
  const repo = path.join(__dirname, '..');
  const dir = path.join(repo, 'node_modules', '.stacki-test');
  fs.mkdirSync(dir, { recursive: true });
  const outfile = path.join(dir, 'style-reachability.bundle.js');
  await esbuild.build({
    stdin: {
      contents:
        "export * from './src/agent/styleAgent.js'\n" +
        "export { createAgentCommands } from './src/agent/commands.js'\n" +
        "export { setHost, getHost } from './src/style-panel/lib/host.ts'\n" +
        "export { setCanvasFrame, receiveCanvasReply, hasCanvas } from './src/canvasQuery.js'\n",
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
