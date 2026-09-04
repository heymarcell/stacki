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
// `axeScript` and the geometry probe compute the occurrence index inside the
// audited page, and a source grep cannot tell a working `indexOf` from a broken
// one.
//
// AND THE FIXTURES ARE THE PAGE'S OWN OUTPUT, WHICH IS THE HARDER HALF.
//
// The first version of this file asserted uniqueness over a hand-written
// `match: {index: i, of: 5}` sitting beside five UNIQUE selectors -- a pair
// section 3 of this same file proves the page never emits. The assertion passed
// over a shape that does not exist while the real one, five unique selectors and
// one shared model path, still hashed to a single id. So every fixture below is
// either the literal output of the shipped in-page script run in a real DOM, or
// a hand-written copy of a shape one of those sections has just proved.

const { createAudit, axeScript, liveWindowCount } = require('../electron/mcp/audit');
const { OVERFLOW } = require('../electron/mcp/audit/probe.js');
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
        // WHAT THE PAGE ACTUALLY REPORTS, proved by section 3 running the
        // shipped in-page source over exactly this markup. axe's own selector
        // generator gives each row a selector that matches ONE element, so
        // `match` carries no information whatsoever here -- one of one. The only
        // fact that separates row two from row four is which of the elements
        // carrying the identical `data-avb-p` it is, and that ordinal travels
        // with the path it disambiguates.
        refPath: { path: SHARED_MODEL_PATH, exact: true, match: { index: i, of: REPEATED } },
        tag: 'time',
        rect: { x: 12, y: 100 * (i + 1), width: 80, height: 18 },
        match: { index: 0, of: 1 },
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
const NAV_PATH = 'src/layouts/Base.astro#0.0.1 src/components/Nav.astro#0.0.1';
const navCulprits = Array.from({ length: 3 }, (_, i) => ({
  selector: 'nav.site-nav > ul > li > a',
  match: { index: i, of: 3 },
  tag: 'a',
  rect: { x: 300 + i, y: 8 + i * 30, width: 120, height: 24, top: 8 + i * 30, right: 420 + i, bottom: 32 + i * 30, left: 300 + i },
  overflowBy: 40 + i,
  edge: 'right',
  computed: { 'overflow-x': 'visible', width: '120px', 'min-width': 'auto', position: 'static' },
  ref: { path: NAV_PATH, exact: true, match: { index: i, of: 3 } },
  text: 'Archive',
}));

// AND THE OTHER BRANCH, which has to keep working for the elements a model path
// never reaches: three cards drawn by a third-party widget, no `data-avb-p`
// anywhere above them, one selector matching all three. Nothing but the
// selector's own ordinal can tell these apart, so this is what fails if the
// selector branch of `whereOf` is ever collapsed into the model-path one.
const widgetCulprits = Array.from({ length: 3 }, (_, i) => ({
  selector: 'div.widget > div.card',
  match: { index: i, of: 3 },
  tag: 'div',
  rect: { x: 8, y: 400 + i * 60, width: 500, height: 50, top: 400 + i * 60, right: 508, bottom: 450 + i * 60, left: 8 },
  overflowBy: 133 - i,
  edge: 'right',
  computed: { 'overflow-x': 'visible', width: '500px', 'min-width': 'auto', position: 'static' },
  ref: null,
  text: 'Sponsored',
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
const allCulprits = [...navCulprits, ...widgetCulprits];
const OVERFLOWING = {
  viewportWidth: 375,
  documentScrollWidth: 460,
  overflowBy: 85,
  overflows: true,
  culprits: allCulprits,
  culpritTotal: allCulprits.length,
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
      '  and each naming which RENDER of that one source node it is',
      contrast.every((f) => f.target.modelPathMatch && f.target.modelPathMatch.of === REPEATED) &&
        new Set(contrast.map((f) => f.target.modelPathMatch?.index)).size === REPEATED,
      short(contrast.map((f) => f.target.modelPathMatch))
    );
    // THE PAYLOAD AND THE ID CANNOT DISAGREE. Every selector here matches one
    // element, so `selectorMatch` is correctly absent -- and if it were the
    // thing being hashed, five findings would share one id again.
    check(
      '  with no selector ordinal published, because the selector is unambiguous',
      contrast.every((f) => f.target.selectorMatch === undefined),
      short(contrast.map((f) => f.target.selectorMatch ?? 'absent'))
    );
    check(
      '  and the id is the published ordinal, not something else',
      contrast.every(
        (f) =>
          f.id ===
          findingId({ ruleId: 'color-contrast', viewport: 'phone', where: `${SHARED_MODEL_PATH}[${f.target.modelPathMatch.index}]` })
      ),
      short(contrast.map((f) => f.id))
    );

    // The geometry half: these carried selectorMatch before the fix and still
    // collided, so this is the assertion that the PAYLOAD's disambiguator and
    // the ID's disambiguator are the same fact.
    const nav = (res.findings || []).filter((f) => f.target.selector === 'nav.site-nav > ul > li > a');
    check('  three overflowing links are three findings', nav.length === 3, short(nav.length));
    check('    with three ids', new Set(nav.map((f) => f.id)).size === 3, short(nav.map((f) => f.id)));
    check(
      '    and the payload still says which box each one is',
      nav.every((f) => f.target.selectorMatch && f.target.selectorMatch.of === 3) &&
        new Set(nav.map((f) => f.target.selectorMatch?.index)).size === 3,
      short(nav.map((f) => f.target.selectorMatch))
    );

    // THE NO-MODEL-PATH BRANCH. Three boxes a third-party widget drew, sharing
    // one selector and carrying no marker at all. The selector's own ordinal is
    // the only disambiguator there is, and it has to stay in the hash.
    const widget = (res.findings || []).filter((f) => f.target.selector === 'div.widget > div.card');
    check('  three unattributable boxes are three findings', widget.length === 3, short(widget.length));
    check('    with three ids of their own', new Set(widget.map((f) => f.id)).size === 3, short(widget.map((f) => f.id)));
    check(
      '    hashed on the selector and its ordinal, because there is nothing else',
      widget.every(
        (f, i) =>
          f.target.modelPath === null &&
          f.target.modelPathMatch === undefined &&
          f.id === findingId({ ruleId: 'horizontal-overflow', viewport: 'phone', where: `div.widget > div.card[${f.target.selectorMatch.index}]` })
      ),
      short(widget.map((f) => ({ id: f.id, m: f.target.selectorMatch })))
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
    // The five <time> elements carry the IDENTICAL marker, because the source
    // has one node and the serializer stamps it on every iteration. That is the
    // collision; everything below is whether the page can still tell them apart.
    const dom = new JSDOM(
      `<!doctype html><html><body><nav id="nav"><a href="/a">a</a></nav><ul>${Array.from({ length: REPEATED }, (_, i) => `<li><time class="faint" data-avb-p="${SHARED_MODEL_PATH}">day ${i}</time></li>`).join('')}</ul></body></html>`,
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
      nodes.every((n, i) => n.tag === 'time') && nodes.length === REPEATED,
      short(nodes.map((n) => n.tag))
    );
    check(
      '  all five reading back the one model path their source really has',
      nodes.every((n) => n.refPath && n.refPath.path === SHARED_MODEL_PATH && n.refPath.exact === true),
      short(nodes.map((n) => n.refPath && n.refPath.path))
    );
    // THE ORDINAL THAT ACTUALLY DISAMBIGUATES, counted in the page over the
    // elements carrying that identical attribute. `match` above is one-of-one
    // for every one of these, so if this is not computed there is nothing left.
    check(
      '  and each saying WHICH render of it it is',
      nodes.every((n, i) => n.refPath.match && n.refPath.match.of === REPEATED && n.refPath.match.index === i),
      short(nodes.map((n) => n.refPath && n.refPath.match))
    );

    // AND NOW THE STEP THE FIRST VERSION OF THIS FILE MISSED: build findings out
    // of what the page just said, rather than out of a fixture. This is the
    // assertion that section 1 cannot make on its own, because section 1 writes
    // its own input.
    const vp3 = { key: 'phone', width: 375, height: 812, device: 'phone', standard: null };
    const rule3 = { id: 'color-contrast', impact: 'serious', help: 'h', helpUrl: 'u', tags: ['wcag2aa'] };
    const fromPage = nodes.map((n) => axeFinding({ viewport: vp3, rule: rule3, node: n, bucket: 'violation' }));
    check(
      'five findings minted from the PAGE\'s own output have five ids',
      new Set(fromPage.map((f) => f.id)).size === REPEATED,
      short(fromPage.map((f) => f.id))
    );
    check(
      '  and every one of them publishes the ordinal its id was hashed on',
      fromPage.every(
        (f) =>
          f.target.modelPathMatch &&
          f.id === findingId({ ruleId: 'color-contrast', viewport: 'phone', where: `${SHARED_MODEL_PATH}[${f.target.modelPathMatch.index}]` })
      ),
      short(fromPage.map((f) => f.target.modelPathMatch))
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
      `<!doctype html><html><body><ul>${Array.from({ length: REPEATED }, () => `<li><time class="faint" data-avb-p="${SHARED_MODEL_PATH}">x</time></li>`).join('')}</ul></body></html>`,
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
    // THE K-TH MENTION IS THE K-TH MATCH, and that is an inference, said out
    // loud. axe hands back a selector, not an element, so re-resolving one
    // string five times used to find the FIRST element five times: five nodes
    // with one rect, one model path and one id. axe walks the document in order
    // and querySelectorAll answers in document order, so within one rule's node
    // list the k-th repeat of a string is the k-th element it matches. The
    // counter is per rule, because one element failing two rules is named twice
    // and both mentions are that same first element.
    check('    resolving the k-th mention to the k-th match', nodes.every((n, i) => n.match && n.match.index === i), short(nodes.map((n) => n.match)));
    check(
      '    so five nodes are five different elements, not the first one five times',
      new Set(nodes.map((n) => n.refPath && n.refPath.match && n.refPath.match.index)).size === REPEATED,
      short(nodes.map((n) => n.refPath && n.refPath.match))
    );
    const vp4 = { key: 'phone', width: 375, height: 812, device: 'phone', standard: null };
    const rule4 = { id: 'color-contrast', impact: 'serious', help: 'h', helpUrl: 'u', tags: ['wcag2aa'] };
    const ambiguous = nodes.map((n) => axeFinding({ viewport: vp4, rule: rule4, node: n, bucket: 'violation' }));
    check(
      '    and five findings out of them have five ids',
      new Set(ambiguous.map((f) => f.id)).size === REPEATED,
      short(ambiguous.map((f) => f.id))
    );

    // AND THE SAME RULE NAMED TWICE FOR ONE ELEMENT IS STILL THAT ELEMENT.
    // The per-rule counter must not run on across rules, or an element that
    // fails image-alt and link-name would be resolved to two different boxes.
    const twice = await dom.window.eval(axeScript({ rules: null }));
    check(
      'a second run of the same page resolves the same five elements',
      JSON.stringify(twice.violations[0].nodes.map((n) => n.refPath.match)) ===
        JSON.stringify(nodes.map((n) => n.refPath.match)),
      short(twice.violations[0].nodes.map((n) => n.refPath.match))
    );
  }

  // --- 4b. THE GEOMETRY PROBE, RUN WHOLE, IN A REAL DOM.
  //
  // Section 1's overflow half is a fixture. This is the shipped `OVERFLOW`
  // script -- helpers, walk, containment rules and all -- evaluated against a
  // document laid out to overflow, and it is built on the shape the reviewer's
  // probe found and no fixture had: five rows from a `.map()` whose loop key
  // gives each one a UNIQUE id attribute. Every selector is therefore
  // one-of-one, `selectorMatch` is absent from all five payloads, and the model
  // path is shared by construction -- so if the ordinal is not counted over the
  // marker, these five findings are one finding.
  {
    const { JSDOM } = require('jsdom');
    const rows = Array.from(
      { length: REPEATED },
      (_, i) => `<li class="row" id="post-${i}" data-avb-p="${SHARED_MODEL_PATH}">row ${i}</li>`
    ).join('');
    const dom = new JSDOM(`<!doctype html><html><body><ul class="list">${rows}</ul></body></html>`, { runScripts: 'outside-only' });
    const w = dom.window;
    // jsdom has no layout and no CSS.escape. Only those two are stood in for;
    // the walk, the selectors, the containment rules and the ordinals are the
    // script's own.
    w.CSS = w.CSS || { escape: (x) => String(x).replace(/([^\w-])/g, '\\$1') };
    Object.defineProperty(w.HTMLHtmlElement.prototype, 'clientWidth', { configurable: true, get: () => 375 });
    Object.defineProperty(w.HTMLHtmlElement.prototype, 'scrollWidth', { configurable: true, get: () => 460 });
    w.Element.prototype.getBoundingClientRect = function rect() {
      return this.classList && this.classList.contains('row')
        ? { x: 0, y: 0, width: 460, height: 20, top: 0, right: 460, bottom: 20, left: 0 }
        : { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    };
    const geo = w.eval(OVERFLOW);
    check('the shipped overflow probe finds the five overflowing rows', geo.overflows === true && geo.culprits.length === REPEATED, short({ overflows: geo.overflows, n: geo.culprits.length }));
    check(
      '  each with a selector that matches exactly one element',
      geo.culprits.every((c, i) => c.selector === `#post-${i}` && c.match.of === 1),
      short(geo.culprits.map((c) => [c.selector, c.match]))
    );
    check(
      '  and each knowing which render of the one shared model path it is',
      geo.culprits.every((c, i) => c.ref && c.ref.path === SHARED_MODEL_PATH && c.ref.match && c.ref.match.of === REPEATED && c.ref.match.index === i),
      short(geo.culprits.map((c) => c.ref && c.ref.match))
    );
    const vpG = { key: 'phone', width: 375, height: 812, device: 'phone', standard: null };
    const geoFindings = geo.culprits.map((culprit) => overflowFinding({ viewport: vpG, culprit, documentOverflowBy: 85 }));
    check(
      'five overflowing renders of one component are five ids',
      new Set(geoFindings.map((f) => f.id)).size === REPEATED,
      short(geoFindings.map((f) => f.id))
    );
    check(
      '  with nothing but the model-path ordinal available to separate them',
      geoFindings.every((f) => f.target.selectorMatch === undefined && f.target.modelPathMatch && f.target.modelPathMatch.of === REPEATED),
      short(geoFindings.map((f) => ({ sel: f.target.selectorMatch ?? 'absent', path: f.target.modelPathMatch })))
    );
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
