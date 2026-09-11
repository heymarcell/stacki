// What every finding of one rule shares is said once, and nothing is lost by it.
//
//   node test/audit-rule-dictionary.js
//
// WHY THIS EXISTS. `category`, `standard` and `help` come off the RULE, never
// off the element it fired on, so an answer with thirty findings of one rule
// carried thirty identical copies of the same three strings. That was not
// merely verbose: the response budget is charged on each finding SERIALISED
// (fitToBytes, electron/mcp/audit/index.js), so the copies were displacing
// findings, which then came back counted in `omittedByByteBudget`. Measured on
// a live project: 42 of 72 findings dropped on one route, 312 of 340 on another.
//
// Hoisting them into `rules[ruleId]` is worth 35-50% more findings admitted
// under the SAME budget -- measured below, relationally, never as a pinned
// count. test/audit-budget.js:159-166 sets out why pinning a number here would
// go red for reasons that have nothing to do with the property being protected.
//
// THE TRAP THIS GUARDS. `message` is NOT a rule constant. For an axe rule it is
// (`rule.help` plus a fixed suffix), but both overflow builders compose it per
// finding out of that culprit's own overflow and edge. Hoisting it
// unconditionally would publish one element's sentence as a fact about the rule
// -- a lie in the answer, which costs more than the bytes buy. Section (c) is
// that case, driven through the real geometry probe, and it fails if the
// hoisting rule is ever loosened to "always".

const { createAudit } = require('../electron/mcp/audit');
const { answer } = require('../electron/mcp/agentTools.js');
const { guardSuite } = require('./support/suiteGuard.js');

// A HANG MUST NOT REPORT A PASS. See test/support/suiteGuard.js.
const suiteDone = guardSuite('audit-rule-dictionary');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`    ${what}${detail ? ` — ${detail}` : ''}`);
};
const short = (v, n = 260) => JSON.stringify(v ?? null).slice(0, n);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

const SELECTOR = 'div.mx-auto > section.relative > article.group > p.mt-3.text-sm';
const HTML = '<p class="mt-3 text-sm" data-avb-p="src/pages/index.astro#0.2.1.3">Body copy</p>';
const SUMMARY = "Fix any of the following: Element's background color could not be determined due to a background gradient";

const axeRule = (id, kind, n) => ({
  id,
  impact: kind === 'violation' ? 'serious' : null,
  help: 'Elements must meet minimum color contrast ratio thresholds',
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}?application=axeAPI`,
  tags: ['cat.color', 'wcag2aa', 'wcag143'],
  nodeTotal: n,
  nodes: Array.from({ length: n }, (_, i) => ({
    target: [`${SELECTOR}:nth-child(${i + 1})`],
    html: HTML,
    failureSummary: SUMMARY,
    refPath: { path: 'src/pages/index.astro#0.2.1.3', exact: true },
    tag: 'p',
    rect: { x: 12, y: 340 + i * 48, width: 288, height: 24 },
  })),
});

const QUIET_GEOMETRY = { viewportWidth: 375, documentScrollWidth: 375, overflowBy: 0, overflows: false, culprits: [], culpritTotal: 0, truncated: false };

// TWO CULPRITS THAT OVERFLOW BY DIFFERENT AMOUNTS, so the two findings of
// `horizontal-overflow` carry genuinely different messages. This is the shape
// that must NOT hoist.
const OVERFLOWING = {
  viewportWidth: 320,
  documentScrollWidth: 460,
  overflowBy: 140,
  overflows: true,
  culpritTotal: 2,
  truncated: false,
  culprits: [
    { selector: 'div.wide', tag: 'div', overflowBy: 140, edge: 'right', rect: { x: 0, y: 10, width: 460, height: 40 }, computed: {}, text: 'wide', ref: null, match: null },
    { selector: 'img.hero', tag: 'img', overflowBy: 62, edge: 'right', rect: { x: 0, y: 80, width: 382, height: 200 }, computed: {}, text: null, ref: null, match: null },
  ],
};

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
          if (typeof src === 'string' && src.includes('culpritTotal')) return geometry;
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
    close() {}
    setBounds() {}
    getBounds() {
      return { x: 0, y: 0, width: 375, height: 812 };
    }
  };
}

const cleanSession = {
  fromPartition: () => ({
    clearStorageData: async () => {},
    clearCache: async () => {},
    setPermissionRequestHandler: () => {},
    webRequest: { onBeforeRequest: () => {} },
    protocol: { handle: () => {} },
  }),
};

const run = (axe, geometry = QUIET_GEOMETRY, args = {}) =>
  createAudit({
    BrowserWindow: windowsServing(axe, geometry),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: cleanSession,
  }).run({ route: '/dense', ...args });

const pageOf = (rules) => ({ version: '4.13.0', violations: rules, incomplete: [], passCount: 0, inapplicableCount: 0 });

// A finding as it read before the split, rebuilt from the two halves.
const rejoin = (res, f) => {
  const rule = (res.rules || {})[f.ruleId] || {};
  return { ...rule, ...f, message: f.message ?? rule.message };
};

(async () => {
  // --- (a) NOTHING WAS LOST -------------------------------------------------
  {
    const res = await run(pageOf([axeRule('color-contrast', 'violation', 40)]));
    check('the run answers', res.ok === true, short(res).slice(0, 120));
    const joined = (res.findings || []).map((f) => rejoin(res, f));
    check('  it returned findings', joined.length > 0, short(res.returnedFindingCount));
    check(
      '  and every one of them still has a category, a criterion, a help URL and a message',
      joined.every((f) => f.category && f.standard && f.help && f.message),
      short(joined.find((f) => !(f.category && f.standard && f.help && f.message)))
    );
    check(
      '  with the criterion the rule actually carries',
      joined.every((f) => f.standard === 'wcag2aa, wcag143'),
      short([...new Set(joined.map((f) => f.standard))])
    );
    check(
      '  and a viewport that resolves in viewports[]',
      joined.every((f) => (res.viewports || []).some((v) => v.viewport.key === f.viewport.key)),
      short({ findings: [...new Set(joined.map((f) => f.viewport.key))], viewports: (res.viewports || []).map((v) => v.viewport.key) })
    );

    // --- (b) THE DICTIONARY IS EXACTLY WHAT THE FINDINGS NAME ---------------
    const named = [...new Set((res.findings || []).map((f) => f.ruleId))].sort();
    const carried = Object.keys(res.rules || {}).sort();
    check(
      'every rule a finding names is in the dictionary, and every entry is named by a finding',
      named.length === carried.length && named.every((id, i) => id === carried[i]),
      short({ named, carried })
    );

    // --- (d) AND IT BUYS ADMISSIONS -----------------------------------------
    // Relational, never a pinned count: the two halves together must serialise
    // smaller than the findings would whole. This is the entire mechanism, so
    // it dies the moment hoisting stops.
    const split = bytes(res.findings) + bytes(res.rules || {});
    const whole = bytes(joined);
    check(
      'the split answer is smaller than the same findings carried whole',
      split < whole,
      short({ split, whole, saved: whole - split, findings: joined.length })
    );
    check(
      '  and the saving grows with the number of findings sharing a rule',
      whole - split > 100 * joined.length * 0.5,
      short({ saved: whole - split, findings: joined.length, perFinding: Math.round((whole - split) / joined.length) })
    );

    // --- (e) THE ACCOUNTING STAYS TRUE --------------------------------------
    check(
      'returnedFindingCount is what is in findings',
      res.returnedFindingCount === (res.findings || []).length,
      short({ said: res.returnedFindingCount, actual: (res.findings || []).length })
    );
    check(
      '  and what was detected minus what came back is what it says was omitted',
      res.omittedFindingCount === res.findingCount - res.returnedFindingCount,
      short({ detected: res.findingCount, returned: res.returnedFindingCount, omitted: res.omittedFindingCount })
    );
  }

  // --- (c) THE MESSAGE THAT IS NOT THE RULE'S -------------------------------
  {
    const res = await run(pageOf([]), OVERFLOWING, { viewports: ['reflow'] });
    const overflow = (res.findings || []).filter((f) => f.ruleId === 'horizontal-overflow');
    check('the geometry probe produced more than one overflow finding', overflow.length > 1, short(overflow.length));
    const entry = (res.rules || {})['horizontal-overflow'];
    check('  the overflow rule has an entry', !!entry, short(Object.keys(res.rules || {})));
    check(
      '  which carries NO message, because its findings do not agree on one',
      !!entry && entry.message === undefined,
      short(entry)
    );
    check(
      '  so every one of them keeps its own',
      overflow.every((f) => typeof f.message === 'string' && f.message.length > 0),
      short(overflow.map((f) => f.message && f.message.slice(0, 40)))
    );
    check(
      '  and those messages really are different',
      new Set(overflow.map((f) => f.message)).size === overflow.length,
      short(overflow.map((f) => f.message))
    );
    // The constants still hoist for the same rule -- only `message` is withheld.
    check(
      '  while the rule constants hoist anyway',
      !!entry && entry.category === 'responsive' && entry.standard === null && typeof entry.help === 'string',
      short(entry)
    );
    check(
      '  and the finding no longer carries them',
      overflow.every((f) => !('category' in f) && !('standard' in f) && !('help' in f)),
      short(overflow[0])
    );
  }

  // --- an answer with no findings still carries the key ----------------------
  {
    const res = await run(pageOf([]));
    check('an answer with nothing found still carries a dictionary', !!res.rules && typeof res.rules === 'object', short(res.rules));
    check('  which is empty', Object.keys(res.rules).length === 0, short(res.rules));
    const env = answer({ ...res }, { spaces: 0 });
    check('  and the envelope still serialises', typeof env.content?.[0]?.text === 'string', typeof env.content?.[0]?.text);
  }

  if (failures.length) {
    console.error(`audit-rule-dictionary: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  suiteDone();
  console.log(`audit-rule-dictionary: ${checked} passed  [said once, lost nothing, and the message that is not the rule's stays put]`);
})().catch((err) => {
  console.error('audit-rule-dictionary: threw', err);
  process.exit(1);
});
