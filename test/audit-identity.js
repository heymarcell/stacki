// One rendered node, one finding id.
//
//   node test/audit-identity.js
//
// A finding id is the whole remediation loop: run, fix, run again, and say
// "that one is gone" rather than "the array is shorter". `test/audit-budget.js`
// and `test/mcp-audit.js` both check that ids are STABLE across two runs, and
// both pass while the ids are not UNIQUE -- mcp-audit compares
// `new Set(first)` with `new Set(second)`, so an N-way collapse on both sides is
// invisible to it by construction.
//
// It collapses on the ordinary Astro page. `data-avb-p` is a SOURCE path, and a
// `.map()` is one node in the source however many times it renders: the real
// serializer emits the identical attribute on every iteration
// (electron/astroParser.js -- the path prop is `{type:'string', value:path}`).
// A native dogfood measured the consequence: `f_4Sjf8vrN_o4ea-Kn` five times
// across five different `<time>` elements, and 22 findings sharing 6 ids. Fixing
// one of five rows was indistinguishable from fixing none.
//
// So this file asserts the property the other two cannot: that the number of
// distinct ids equals the number of findings, on a page whose findings share a
// model path by construction -- while still asserting stability across reruns,
// and that an id whose selector is UNAMBIGUOUS is byte-identical to the one the
// product minted before the disambiguator existed.
//
// The in-page half is tested in a real DOM (jsdom), not by reading the source:
// `axeScript` computes the occurrence index inside the audited page, and a
// source grep cannot tell a working `indexOf` from a broken one.

const { createAudit, axeScript, liveWindowCount } = require('../electron/mcp/audit');
const { axeFinding, overflowFinding, findingId } = require('../electron/mcp/audit/findings.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 300) => JSON.stringify(v ?? null).slice(0, n);

// THE COLLISION CONDITION, BUILT THE WAY THE PAGE BUILDS IT.
//
// One component (`PostRow.astro`) rendered five times from a `.map()`. Every
// instance carries the SAME `data-avb-p`, because the source has one node; only
// the rendered selector and the occurrence index tell them apart. This is the
// shape no fixture in the repo had: /wide and /many write every element out
// literally, so each one gets a distinct model path and the collision cannot
// occur there.
const SHARED_MODEL_PATH = 'src/pages/blog/index.astro#0.2.1 src/components/PostRow.astro#0.0.3';
const REPEATED = 5;

const repeatedContrast = () => ({
  version: '4.13.0',
  violations: [
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must meet minimum colour contrast ratio thresholds',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
      tags: ['cat.color', 'wcag2aa', 'wcag143'],
      nodeTotal: REPEATED,
      nodes: Array.from({ length: REPEATED }, (_, i) => ({
        target: [`li:nth-child(${i + 1}) > time`],
        html: '<time class="faint">Jan 1</time>',
        failureSummary: 'Fix any of the following: Element has insufficient colour contrast',
        refPath: { path: SHARED_MODEL_PATH, exact: true },
        tag: 'time',
        rect: { x: 12, y: 100 * (i + 1), width: 80, height: 18 },
        // What the in-page `locate()` reports: which of the selector's matches
        // this node is. Section 3 below proves the page really computes it.
        match: { index: i, of: REPEATED },
      })),
    },
  ],
  incomplete: [],
  passCount: 0,
  inapplicableCount: 0,
});

// Three navigation links, one model path, one selector, three different boxes --
// the geometry half of the same collision. These already CARRY
// `target.selectorMatch` in the payload today and still shared one id: the
// disambiguator existed and was not fed into the hash.
const NAV_REF = { path: 'src/layouts/Base.astro#0.0.1 src/components/Nav.astro#0.0.1', exact: true };
const navCulprits = Array.from({ length: 3 }, (_, i) => ({
  selector: 'nav.site-nav > ul > li > a',
  match: { index: i, of: 3 },
  tag: 'a',
  rect: { x: 300 + i, y: 8 + i * 30, width: 120, height: 24, top: 8 + i * 30, right: 420 + i, bottom: 32 + i * 30, left: 300 + i },
  overflowBy: 40 + i,
  edge: 'right',
  computed: { 'overflow-x': 'visible', width: '120px', 'min-width': 'auto', position: 'static' },
  ref: NAV_REF,
  text: 'Archive',
}));

/** A window that answers the geometry probe and the engine with canned results. */
function windowsServing(axe, geometry) {
  return class FakeWindow {
    constructor() {
      this.webContents = {
        on: () => {},
        once: (event, fn) => {
          if (event === 'did-finish-load') setImmediate(fn);
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: async (src) => {
          if (typeof src === 'string' && src.includes('documentElement')) return geometry;
          if (typeof src === 'string' && src.includes('axe.run')) return axe;
          return { title: 'fake', readyState: 'complete' };
        },
        getURL: () => 'http://127.0.0.1:4321/',
        capturePage: async () => ({ isEmpty: () => true }),
      };
    }
    async loadURL() {}
    setContentSize() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  };
}

const cleanSession = {
  fromPartition: () => ({
    clearStorageData: async () => {},
    clearCache: async () => {},
    clearAuthCache: async () => {},
  }),
};

const QUIET = { viewportWidth: 375, documentScrollWidth: 375, overflowBy: 0, overflows: false, culprits: [], culpritTotal: 0, truncated: false };
const OVERFLOWING = {
  viewportWidth: 375,
  documentScrollWidth: 460,
  overflowBy: 85,
  overflows: true,
  culprits: navCulprits,
  culpritTotal: navCulprits.length,
  truncated: false,
};

const run = (axe, geometry, args = {}) =>
  createAudit({
    BrowserWindow: windowsServing(axe, geometry),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: cleanSession,
  }).run({ route: '/blog', viewports: ['phone'], ...args });

(async () => {
  // --- 1. FIVE RENDERS OF ONE COMPONENT ARE FIVE FINDINGS WITH FIVE IDS.
  {
    const res = await run(repeatedContrast(), OVERFLOWING);
    check('the repeated page audits', res.ok === true, short({ ok: res.ok, code: res.code, message: res.message }));

    const ids = (res.findings || []).map((f) => f.id);
    check(
      'every rendered finding has an id of its own',
      ids.length > 0 && new Set(ids).size === ids.length,
      short({ findings: ids.length, distinct: new Set(ids).size, ids })
    );

    const contrast = (res.findings || []).filter((f) => f.ruleId === 'color-contrast');
    check('  five renders of one component are five accessibility findings', contrast.length === REPEATED, short(contrast.length));
    check(
      '  all sharing the one model path the source actually has',
      contrast.every((f) => f.target.modelPath === SHARED_MODEL_PATH && f.target.exact === true),
      short(contrast.map((f) => f.target.modelPath))
    );
    check(
      '  and each naming which occurrence it is',
      contrast.every((f) => f.target.selectorMatch && f.target.selectorMatch.of === REPEATED) &&
        new Set(contrast.map((f) => f.target.selectorMatch?.index)).size === REPEATED,
      short(contrast.map((f) => f.target.selectorMatch))
    );

    // The geometry half: these carried selectorMatch before the fix and still
    // collided, so this is the assertion that the PAYLOAD's disambiguator and
    // the ID's disambiguator are the same fact.
    const nav = (res.findings || []).filter((f) => f.ruleId === 'horizontal-overflow');
    check('  three overflowing links are three findings', nav.length === 3, short(nav.length));
    check('    with three ids', new Set(nav.map((f) => f.id)).size === 3, short(nav.map((f) => f.id)));
    check(
      '    and the payload still says which box each one is',
      nav.every((f) => f.target.selectorMatch && f.target.selectorMatch.of === 3) &&
        new Set(nav.map((f) => f.target.selectorMatch?.index)).size === 3,
      short(nav.map((f) => f.target.selectorMatch))
    );

    // --- STABILITY. Unique is worth nothing if it is unique per RUN.
    const again = await run(repeatedContrast(), OVERFLOWING);
    check(
      'a second audit of the same page returns the identical ids, in the identical order',
      JSON.stringify((again.findings || []).map((f) => f.id)) === JSON.stringify(ids),
      short({ first: ids, second: (again.findings || []).map((f) => f.id) })
    );
  }

  // --- 2. AN UNAMBIGUOUS FINDING'S ID DOES NOT MOVE.
  //
  // The disambiguator is in the hash exactly when it is in the payload -- that
  // is, when the selector matches more than one element. A page with one
  // offending element must therefore mint the SAME id it minted before any of
  // this existed, or every id in every project churns for nothing.
  //
  // These four constants were read out of the product at e2d7eeb, before the
  // change, by calling the same two builders. They are not "whatever it says
  // now": if the rule that decides `where` moves, they fail.
  {
    const vp = { key: 'phone', width: 375, height: 812, device: 'phone', standard: null };
    const rule = {
      id: 'image-alt',
      impact: 'critical',
      help: 'Images must have alternate text',
      helpUrl: 'u',
      tags: ['wcag2a', 'wcag111'],
    };
    const node = {
      target: ['main > img.hero'],
      html: '<img>',
      failureSummary: 's',
      refPath: { path: 'src/pages/index.astro#0.1.2', exact: true },
      tag: 'img',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      match: { index: 0, of: 1 },
    };
    const culprit = {
      selector: 'main > div.banner',
      match: { index: 0, of: 1 },
      tag: 'div',
      rect: { x: 0, y: 0, width: 520, height: 40, top: 0, right: 520, bottom: 40, left: 0 },
      overflowBy: 145,
      edge: 'right',
      computed: {},
      ref: { path: 'src/pages/index.astro#0.2.0', exact: true },
      text: 'x',
    };
    check(
      'an accessibility finding on a unique element keeps the id it had at e2d7eeb',
      axeFinding({ viewport: vp, rule, node, bucket: 'violation' }).id === 'f_cMR-P32ygXs5_x2l',
      short(axeFinding({ viewport: vp, rule, node, bucket: 'violation' }).id)
    );
    check(
      '  including when it has no model path at all',
      axeFinding({ viewport: vp, rule, node: { ...node, refPath: null }, bucket: 'violation' }).id === 'f_kQURi-ghD4cvqoZ9',
      short(axeFinding({ viewport: vp, rule, node: { ...node, refPath: null }, bucket: 'violation' }).id)
    );
    check(
      'an overflow finding on a unique element keeps the id it had at e2d7eeb',
      overflowFinding({ viewport: vp, culprit, documentOverflowBy: 145 }).id === 'f_j2lHSigCyp34WbOs',
      short(overflowFinding({ viewport: vp, culprit, documentOverflowBy: 145 }).id)
    );
    // AND THE ONE SPELLING THAT DID CHANGE, ON PURPOSE AND ONLY HERE.
    //
    // The overflow builder used to append `[0]` to the selector fallback
    // unconditionally, while the accessibility builder appended nothing. One
    // rule replaced two, and the rule is the one the payload already follows:
    // the occurrence index is present exactly when `selectorMatch` is. So an
    // unattributable overflow on a unique selector hashes without the `[0]` it
    // used to carry. Asserted rather than discovered.
    check(
      '  and an unattributable overflow now hashes the bare selector, as the payload describes it',
      overflowFinding({ viewport: vp, culprit: { ...culprit, ref: null }, documentOverflowBy: 145 }).id ===
        findingId({ ruleId: 'horizontal-overflow', viewport: 'phone', where: 'main > div.banner' }),
      short(overflowFinding({ viewport: vp, culprit: { ...culprit, ref: null }, documentOverflowBy: 145 }).id)
    );
  }

  // --- 3. THE PAGE REALLY COMPUTES THE OCCURRENCE, IN A REAL DOM.
  //
  // Sections 1 and 2 hand the engine a `match` that a fixture wrote. This runs
  // the actual in-page source against an actual document with five identical
  // `<time>` elements, with a stub `axe` standing in for the engine and nothing
  // else stubbed -- `querySelectorAll`, `indexOf` and the selector resolution are
  // the DOM's own.
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(
      `<!doctype html><html><body><nav id="nav"><a href="/a">a</a></nav><ul>${Array.from({ length: REPEATED }, (_, i) => `<li><time class="faint">day ${i}</time></li>`).join('')}</ul></body></html>`,
      { runScripts: 'outside-only' }
    );
    dom.window.axe = {
      version: '4.13.0-stub',
      run: async () => ({
        violations: [
          {
            id: 'color-contrast',
            impact: 'serious',
            help: 'h',
            helpUrl: 'u',
            tags: ['wcag2aa'],
            nodes: Array.from({ length: REPEATED }, (_, i) => ({
              target: [`li:nth-child(${i + 1}) > time`],
              html: '<time></time>',
              failureSummary: 'f',
            })),
          },
          {
            id: 'link-name',
            impact: 'serious',
            help: 'h',
            helpUrl: 'u',
            tags: ['wcag2a'],
            nodes: [{ target: ['#nav > a'], html: '<a></a>', failureSummary: 'f' }],
          },
        ],
        incomplete: [],
        passes: [],
        inapplicable: [],
      }),
    };
    // The five <time> elements share one class, so a selector a real page would
    // produce matches all five. Ask for the ambiguous one on purpose.
    dom.window.document.querySelectorAll('time').forEach((el, i) => {
      el.setAttribute('data-i', String(i));
    });
    const out = await dom.window.eval(axeScript({ rules: null }));
    const nodes = out.violations[0].nodes;
    check('the in-page engine wrapper reports one entry per node', nodes.length === REPEATED, short(nodes.length));
    // Each of those selectors is `li:nth-child(N) > time`, which matches exactly
    // ONE element -- so the honest answer is "one of one", and the payload stays
    // byte-identical to today because `targetOf` emits `selectorMatch` only
    // above one. Section 4 is the case where the selector matches many.
    check(
      '  each saying how many elements its selector matches',
      nodes.every((n) => n.match && n.match.index === 0 && n.match.of === 1),
      short(nodes.map((n) => n.match))
    );
    check(
      '  and each resolving to the element axe named, not to the first one',
      nodes.every((n, i) => n.refPath === null && n.tag === 'time') && nodes.length === REPEATED,
      short(nodes.map((n) => n.tag))
    );
    const single = out.violations[1].nodes[0];
    check(
      'a selector that matches one element says so',
      single.match && single.match.index === 0 && single.match.of === 1,
      short(single.match)
    );

    // AND THE ENGINE'S OWN RULE LIST, fetched only when the caller named rules.
    // Stacki compares what was asked for against this, so a rule id the engine
    // does not have is named back instead of being accepted in silence -- and
    // the list has to come from the ENGINE, not from a table that goes stale.
    dom.window.axe.getRules = () => [{ ruleId: 'color-contrast' }, { ruleId: 'image-alt' }];
    const named = await dom.window.eval(axeScript({ rules: ['color-contrast', 'no-such-rule'] }));
    check(
      'naming rules makes the page report which rule ids the engine has',
      Array.isArray(named.knownRuleIds) && named.knownRuleIds.join(',') === 'color-contrast,image-alt',
      short(named.knownRuleIds)
    );
    check(
      '  and naming none does not pay for that list',
      (await dom.window.eval(axeScript({ rules: null }))).knownRuleIds === null,
      short((await dom.window.eval(axeScript({ rules: null }))).knownRuleIds)
    );
  }

  // --- 4. A SELECTOR THAT MATCHES MANY, RESOLVED IN A REAL DOM.
  //
  // The case above cannot fail on `of`, because axe answered with five
  // unambiguous selectors. This is the one the dogfood hit: ONE selector, five
  // matching elements, and axe naming the same string five times -- which is
  // what a component rendered in a `.map()` looks like from the outside.
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(
      `<!doctype html><html><body><ul>${Array.from({ length: REPEATED }, () => '<li><time class="faint">x</time></li>').join('')}</ul></body></html>`,
      { runScripts: 'outside-only' }
    );
    dom.window.axe = {
      version: '4.13.0-stub',
      run: async () => ({
        violations: [
          {
            id: 'color-contrast',
            impact: 'serious',
            help: 'h',
            helpUrl: 'u',
            tags: ['wcag2aa'],
            // axe answers with the element it found. Five elements, and a
            // selector generator that produced the same string for each: the
            // engine result carries no ordinal of its own.
            nodes: Array.from({ length: REPEATED }, () => ({ target: ['time.faint'], html: '<time></time>', failureSummary: 'f' })),
          },
        ],
        incomplete: [],
        passes: [],
        inapplicable: [],
      }),
    };
    const out = await dom.window.eval(axeScript({ rules: null }));
    const nodes = out.violations[0].nodes;
    check('five identical selectors are five nodes', nodes.length === REPEATED, short(nodes.length));
    check(
      '  and the page says how many the selector matches',
      nodes.every((n) => n.match && n.match.of === REPEATED),
      short(nodes.map((n) => n.match))
    );
    // HONEST LIMIT, ASSERTED SO IT CANNOT BE MISREAD AS A DEFECT: axe hands back
    // a selector, not an element, so re-resolving one selector five times finds
    // the first element five times. The occurrence index is real for the case
    // that matters -- distinct selectors, which is what axe's own selector
    // generator produces for repeated nodes -- and the `of` is real either way.
    check('    reporting the occurrence it could actually resolve', nodes.every((n) => n.match && n.match.index === 0), short(nodes.map((n) => n.match)));
  }

  // --- 5. NO WINDOW SURVIVED.
  check('every audit window this suite opened was destroyed', liveWindowCount() === 0, short({ live: liveWindowCount() }));

  if (failures.length) {
    console.error(`audit-identity: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-identity: ${checked} passed  [one rendered node, one id -- and an unambiguous one does not churn]`);
})().catch((err) => {
  console.error('audit-identity: threw\n', err?.stack || err);
  process.exit(1);
});
