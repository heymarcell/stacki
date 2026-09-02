// What the response budget returns, and what it must never drop.
//
//   node test/audit-budget.js
//
// The audit detects more than it can send. Three caps stand between a page and
// the answer -- the in-page geometry cap, the per-rule axe node cap, and the
// sixty-finding response budget -- and the contract is that none of them
// discards anything silently: `findingCount` is the true total, `truncated` says
// the list is short, and `truncation` says where each layer lost something.
//
// This file is about the last of the three, because it is the one whose
// arithmetic can be wrong while every honesty field goes on being right.
//
// WHY IT IS NOT PROVEN AGAINST A REAL BROWSER. The shapes that matter are "a
// page whose findings are almost all undecided" and "a page with more violations
// than the budget", and seeding either against a real renderer means writing a
// page with a hundred real contrast failures on it. The engine already takes its
// window as an argument, so the axe result is injected through the seam that
// exists. What a real browser proves -- that these findings are real -- is
// proven in test/mcp-audit.js against a real Astro page.
//
// THE SHAPE THIS EXISTS FOR, and it came from measurement rather than from
// reading the code: surveying four upstream Astro examples through the packaged
// app, 105 of 129 findings came back `incomplete`, because axe cannot resolve a
// background it cannot see. The portfolio's home page detected 96, scored 36 and
// returned 15 -- forty-five slots of a sixty-slot budget unused. The reserve
// that exists to STOP the incomplete bucket being eaten was also capping it.

const { createAudit } = require('../electron/mcp/audit');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null).slice(0, 240);

/** A window that answers the probes with whatever axe result it was given. */
function windowsServing(axe) {
  return class FakeWindow {
    constructor() {
      this.webContents = {
        on: () => {},
        once: (event, fn) => {
          if (event === 'did-finish-load') setImmediate(fn);
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: async (src) => {
          if (typeof src === 'string' && src.includes('documentElement')) {
            return { viewportWidth: 375, documentScrollWidth: 375, overflowBy: 0, overflows: false, culprits: [], culpritTotal: 0, truncated: false };
          }
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

/** A session that always wipes cleanly, so nothing here is about isolation. */
const cleanSession = {
  fromPartition: () => ({
    clearStorageData: async () => {},
    clearCache: async () => {},
    clearAuthCache: async () => {},
  }),
};

// The per-rule node cap is twelve, so a bucket of N findings needs N/12 rules.
// Written out rather than assumed: a fixture that quietly hit the node cap would
// be measuring the node cap instead of the budget.
const NODES_PER_RULE = 12;
const rule = (id, kind, n = NODES_PER_RULE) => ({
  id,
  impact: kind === 'violation' ? 'serious' : null,
  help: id,
  helpUrl: 'x',
  tags: kind === 'violation' ? ['wcag2aa'] : [],
  nodeTotal: n,
  nodes: Array.from({ length: n }, (_, i) => ({
    target: [`${id}-${i}`],
    html: `<p>${i}</p>`,
    failureSummary: 'because',
  })),
});

/** Exactly `n` findings, spread across as many rules as the node cap requires. */
const rulesFor = (n, prefix, kind) => {
  const out = [];
  for (let left = n, i = 0; left > 0; i += 1) {
    const take = Math.min(NODES_PER_RULE, left);
    out.push(rule(`${prefix}${i}`, kind, take));
    left -= take;
  }
  return out;
};

const page = ({ violations = 0, incomplete = 0 }) => ({
  version: '4.13.0',
  violations: rulesFor(violations, 'v', 'violation'),
  incomplete: rulesFor(incomplete, 'i', 'incomplete'),
  passCount: 0,
  inapplicableCount: 0,
});

const audit = (axe) =>
  createAudit({
    BrowserWindow: windowsServing(axe),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: cleanSession,
  }).run({ route: '/', viewports: ['phone'] });

const kindCounts = (res) => ({
  standard: (res.findings || []).filter((f) => f.kind === 'standard').length,
  incomplete: (res.findings || []).filter((f) => f.kind === 'incomplete').length,
});

(async () => {
  // --- THE REAL-WORLD SHAPE: a page whose findings are all undecided.
  //
  // 48 incomplete, nothing decided. The budget is sixty. Every one of them fits,
  // so every one of them must be sent -- and the old arithmetic sent fifteen.
  {
    const res = await audit(page({ incomplete: 48 }));
    const counts = kindCounts(res);
    check('a page of only incomplete findings fills the budget', counts.incomplete === 48, short({ counts, returned: res.returnedFindingCount }));
    check('  and returns them all rather than a quarter of the budget', res.returnedFindingCount === 48, short(res.returnedFindingCount));
    check('  so nothing is reported as dropped', res.truncated === false && res.truncation?.omittedByResponseBudget === 0, short(res.truncation));
    check('  and the true total agrees with the list', res.findingCount === 48 && res.omittedFindingCount === 0, short({ detected: res.findingCount, omitted: res.omittedFindingCount }));
  }

  // --- MORE UNDECIDED THAN THE BUDGET: it fills, and says it was cut.
  {
    const res = await audit(page({ incomplete: 120 }));
    check('more incomplete than the budget fills it exactly', res.returnedFindingCount === 60, short(res.returnedFindingCount));
    check('  and says so, with the true total', res.truncated === true && res.findingCount === 120 && res.truncation.omittedByResponseBudget === 60, short(res.truncation));
  }

  // --- THE BUCKET THE RESERVE EXISTS FOR: a busy page must be unchanged.
  //
  // This is the assertion that stops the fix above from becoming a regression.
  // With more violations than the whole budget, `incomplete` is severity `info`
  // and sorts last, so a flat slice would take sixty violations and send the
  // undecided bucket to zero. Fifteen of it survives, exactly as before.
  {
    const res = await audit(page({ violations: 96, incomplete: 48 }));
    const counts = kindCounts(res);
    check('a busy page still reserves a quarter for the undecided', counts.incomplete === 15, short(counts));
    check('  and gives the rest to what was decided', counts.standard === 45, short(counts));
    check('  filling the budget and no more', res.returnedFindingCount === 60, short(res.returnedFindingCount));
    check('  while reporting the true total', res.findingCount === 144 && res.truncated === true, short({ detected: res.findingCount }));
  }

  // --- FEW OF EACH: neither cap does anything.
  {
    const res = await audit(page({ violations: 3, incomplete: 3 }));
    const counts = kindCounts(res);
    check('a quiet page is sent whole', res.returnedFindingCount === 6 && counts.standard === 3 && counts.incomplete === 3, short({ counts, returned: res.returnedFindingCount }));
    check('  and is not called truncated', res.truncated === false, short(res.truncated));
  }

  // --- MOSTLY UNDECIDED WITH A FEW REAL FAILURES: the decided ones are never
  //     the thing that gets dropped.
  {
    const res = await audit(page({ violations: 12, incomplete: 120 }));
    const counts = kindCounts(res);
    check('every decided finding survives a flood of undecided ones', counts.standard === 12, short(counts));
    check('  and the undecided fill what is left', counts.incomplete === 48 && res.returnedFindingCount === 60, short({ counts, returned: res.returnedFindingCount }));
  }

  // --- AND THE SENTENCE THAT MUST BE ON EVERY ANSWER.
  {
    const res = await audit(page({ incomplete: 4 }));
    check('the limits sentence survives every path through the budget', /does not mean WCAG compliant/.test(String(res.limits)), short(res.limits));
    check('  and incomplete is counted in its own bucket', res.counts?.incomplete === 4 && res.counts?.standard === 0, short(res.counts));
  }

  if (failures.length) {
    console.error(`audit-budget: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-budget: ${checked} passed  [the response budget fills, and the undecided bucket keeps its floor]`);
})().catch((err) => {
  console.error('audit-budget: threw\n', err?.stack || err);
  process.exit(1);
});
