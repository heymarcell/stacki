// The size of the answer, not the number of things in it.
//
//   node test/audit-byte-budget.js
//
// `test/audit-budget.js` proves the finding COUNT is bounded and honestly
// accounted. It passes today, and it passed all the way through a native
// dogfood in which **19 of 72 audit calls (26%) were rejected by the host** with
// `result (N characters) exceeds maximum allowed tokens` -- between 52,640 and
// 428,948 characters, in the default configuration, on the plainest possible
// call. A cap of sixty findings says nothing at all about how big sixty
// findings are.
//
// So this file measures the thing the other one cannot: the bytes of the actual
// MCP result envelope, built by the same `answer()` the audit tool ships
// through. That envelope carries the payload TWICE -- once as
// `structuredContent` and once as a JSON string in a text block -- and the host
// counts what it is given, so measuring `JSON.stringify(findings)` would
// understate the real answer by more than half.
//
// THE BOUND IS ABSOLUTE, NOT RELATIVE. Asserting only "under whatever the
// product declares" would go green the moment somebody raised the constant. The
// hard ceiling below is set from measured host behaviour -- the SMALLEST result
// the host actually refused was 52,640 characters -- with a wide margin under
// it, because Stacki does not control the host's tokenizer and must not tune
// itself to one version of one client.

const { createAudit, MAX_RESPONSE_BYTES, liveWindowCount } = require('../electron/mcp/audit');
const { answer } = require('../electron/mcp/agentTools.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 260) => JSON.stringify(v ?? null).slice(0, n);

// The smallest result this host was measured to REFUSE, in the native dogfood.
// Everything here is required to stay a long way under it.
const SMALLEST_REFUSED_BY_HOST = 52640;
// What Stacki promises, whatever the host of the day happens to allow.
const HARD_CEILING = 32000;
// AND THE PRODUCT'S OWN NUMBER HAS TO EARN ITS PLACE. Asserting only "under the
// ceiling" leaves the suite green if the budget is raised to just below it, so
// the declared budget is required to keep a real margin under the smallest
// result this host was measured to refuse.
const REQUIRED_MARGIN = 0.6;

/** A window that answers the probes with whatever axe result it was given. */
function windowsServing(axe, { blank = true } = {}) {
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
        capturePage: async () => ({ isEmpty: () => blank }),
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

// A FINDING THE SIZE REAL PAGES PRODUCE.
//
// Every string here is the length axe and a real Astro DOM actually hand over,
// not a placeholder: the selector of a Tailwind-shaped node, a `data-avb-p`
// carrying two model paths, axe's own `help` sentence, and the 240-character
// clips `index.js` already applies to `html` and `failureSummary`. A fixture
// with `help: id` and `target: ['v0-6']` -- which is what the count-based suite
// uses -- serializes to about a quarter of this, and is why that suite cannot
// see the defect.
const NODES_PER_RULE = 12;
const SELECTOR =
  'div.mx-auto.max-w-7xl > section.relative.isolate.overflow-hidden > div.grid.grid-cols-1 > article.group.rounded-2xl > a.block.focus\\:outline-none > span.text-sm';
const MODEL_PATH = 'src/pages/index.astro#0.3.1.2.0.4 src/components/PricingCard.astro#0.1.0';
const HELP =
  'Elements must meet minimum colour contrast ratio thresholds so that text remains legible for readers with low vision';
const HTML =
  '<span class="text-sm font-medium tracking-tight text-slate-500 group-hover:text-slate-700 dark:text-slate-400">' +
  'Everything in Starter, plus unlimited projects, priority support and the audit log</span>';
const SUMMARY =
  'Fix any of the following: Element has insufficient colour contrast of 2.94 (foreground colour: #94a3b8, ' +
  'background colour: #f8fafc, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1';

const rule = (id, kind, n = NODES_PER_RULE) => ({
  id,
  impact: kind === 'violation' ? 'serious' : null,
  help: HELP,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}?application=axeAPI`,
  tags: kind === 'violation' ? ['cat.color', 'wcag2aa', 'wcag143', 'TTv5', 'TT13.c', 'EN-301-549', 'EN-9.1.4.3', 'ACT'] : ['cat.color', 'wcag2aa'],
  nodeTotal: n,
  nodes: Array.from({ length: n }, (_, i) => ({
    target: [`${SELECTOR}:nth-child(${i + 1})`],
    html: HTML,
    failureSummary: SUMMARY,
    refPath: { path: MODEL_PATH, exact: true },
    tag: 'span',
    rect: { x: 12, y: 340 + i * 48, width: 288, height: 24 },
  })),
});

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
  violations: rulesFor(violations, 'colour-contrast-v', 'violation'),
  incomplete: rulesFor(incomplete, 'colour-contrast-i', 'incomplete'),
  passCount: 0,
  inapplicableCount: 0,
});

// AN ORDINARY PAGE, at the sizes an ordinary page actually produces: a short
// selector on a hand-written component, one model path, axe's shorter help
// sentences. The dense fixture above is the worst case on purpose; this is the
// control that says the budget does not bite on the common one.
const plainRule = (id, kind, n) => ({
  id,
  impact: kind === 'violation' ? 'serious' : null,
  help: 'Form elements must have labels',
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
  tags: kind === 'violation' ? ['cat.forms', 'wcag2a', 'wcag412'] : ['cat.forms'],
  nodeTotal: n,
  nodes: Array.from({ length: n }, (_, i) => ({
    target: [`main > form > label:nth-child(${i + 1})`],
    html: '<label class="field"><input name="email" /></label>',
    failureSummary: 'Fix any of the following: Form element does not have an implicit or explicit label',
    refPath: { path: 'src/pages/contact.astro#0.1.2', exact: true },
    tag: 'label',
    rect: { x: 12, y: 200 + i * 40, width: 320, height: 32 },
  })),
});

const plainPage = ({ violations = 0, incomplete = 0 }) => {
  const build = (n, prefix, kind) => {
    const out = [];
    for (let left = n, i = 0; left > 0; i += 1) {
      const take = Math.min(NODES_PER_RULE, left);
      out.push(plainRule(`${prefix}${i}`, kind, take));
      left -= take;
    }
    return out;
  };
  return {
    version: '4.13.0',
    violations: build(violations, 'label-v', 'violation'),
    incomplete: build(incomplete, 'label-i', 'incomplete'),
    passCount: 0,
    inapplicableCount: 0,
  };
};

/** A plain audit: default viewports, capture off -- the call the dogfood made. */
const audit = (axe, args = {}) =>
  createAudit({
    BrowserWindow: windowsServing(axe),
    getPreviewUrl: () => 'http://127.0.0.1:4321',
    session: cleanSession,
  }).run({ route: '/dense', ...args });

/** What the host is actually handed, measured the way the host counts it. */
const envelopeOf = (res) => {
  const env = answer(res, { spaces: 0 });
  const text = env.content[0].text;
  const structured = JSON.stringify(env.structuredContent);
  return {
    textBytes: Buffer.byteLength(text, 'utf8'),
    structuredBytes: Buffer.byteLength(structured, 'utf8'),
    wireBytes: Buffer.byteLength(JSON.stringify(env), 'utf8'),
  };
};

(async () => {
  // --- THE DENSE PAGE. This is the reproduction.
  {
    const res = await audit(page({ violations: 240, incomplete: 120 }));
    const size = envelopeOf(res);

    check('a dense page still answers', res.ok === true, short({ ok: res.ok, code: res.code }));
    check(
      'the result the host is handed stays under the hard ceiling',
      size.textBytes <= HARD_CEILING,
      short({ ...size, ceiling: HARD_CEILING, smallestRefusedByHost: SMALLEST_REFUSED_BY_HOST, returned: res.returnedFindingCount })
    );
    check(
      '  which is a long way under the smallest result this host refused',
      size.textBytes < SMALLEST_REFUSED_BY_HOST * 0.7,
      short({ textBytes: size.textBytes, refusedAt: SMALLEST_REFUSED_BY_HOST })
    );
    check(
      '  and both copies together are bounded too, because the envelope sends two',
      size.wireBytes <= HARD_CEILING * 2 + 4096,
      short(size)
    );
    check(
      'the declared budget keeps a real margin under what the host refused',
      MAX_RESPONSE_BYTES <= SMALLEST_REFUSED_BY_HOST * REQUIRED_MARGIN,
      short({ declared: MAX_RESPONSE_BYTES, refusedAt: SMALLEST_REFUSED_BY_HOST, mustBeAtMost: SMALLEST_REFUSED_BY_HOST * REQUIRED_MARGIN })
    );
    check(
      '  and the answer is inside it',
      typeof MAX_RESPONSE_BYTES === 'number' && size.structuredBytes <= MAX_RESPONSE_BYTES,
      short({ structuredBytes: size.structuredBytes, declared: MAX_RESPONSE_BYTES })
    );

    // --- AND IT IS STILL AN AUDIT.
    //
    // A budget that answers with nothing is trivially under any ceiling. The
    // point is a usable answer that fits.
    check('  while still returning findings to act on', res.returnedFindingCount >= 8, short({ returned: res.returnedFindingCount }));
    // NAMING THE FIELDS THAT MAKE A FINDING USEFUL, not only the ones that make
    // it well-formed. Review patched `clipFinding` to drop `evidence` and all
    // 28 checks stayed green -- and the returned count went UP, because losing
    // the evidence bought room under the cap.
    check(
      '  each of which is a whole finding',
      (res.findings || []).every((f) => f.id && f.ruleId && f.kind && f.severity && f.target && f.message && f.evidence && f.help),
      short((res.findings || [])[0])
    );
    check(
      '  carrying the evidence it was found by',
      (res.findings || []).every((f) => typeof f.evidence?.failureSummary === 'string' && typeof f.evidence?.html === 'string'),
      short((res.findings || [])[0]?.evidence)
    );

    // --- AND IT IS STILL HONEST.
    check('the true detected total is unchanged by the budget', res.findingCount === 360 * 3, short({ findingCount: res.findingCount }));
    check('  the returned count matches the list', res.returnedFindingCount === (res.findings || []).length, short({ returned: res.returnedFindingCount, len: res.findings?.length }));
    check('  omitted is detected minus returned', res.omittedFindingCount === res.findingCount - res.returnedFindingCount, short({ omitted: res.omittedFindingCount }));
    check('  and it says the list is short', res.truncated === true, short({ truncated: res.truncated }));
    check(
      '  and says the bytes are why, in its own field',
      typeof res.truncation?.omittedByByteBudget === 'number' && res.truncation.omittedByByteBudget > 0,
      short(res.truncation)
    );
    check(
      '  with the byte budget named alongside the count cap',
      res.truncation?.responseByteCap === MAX_RESPONSE_BYTES && res.truncation?.responseCap === 60,
      short(res.truncation)
    );
    check(
      '  and every layer still adds up to the total omitted',
      res.truncation.omittedBeforeScoring.geometryCulprits +
        res.truncation.omittedBeforeScoring.axeNodes +
        res.truncation.omittedByResponseBudget +
        res.truncation.omittedByByteBudget ===
        res.omittedFindingCount,
      short(res.truncation)
    );
    check('  and the counts still describe everything scored, not what fitted', res.counts.standard + res.counts.incomplete > res.returnedFindingCount, short(res.counts));
    check('  and the limits sentence survives', /does not mean WCAG compliant/.test(String(res.limits)), short(res.limits));
  }

  // --- ORDER IS UNCHANGED BY THE TRIM.
  //
  // The budget selects; it must never emit a differently-ordered prefix, or
  // `run -> fix -> run` stops being comparable by id.
  {
    const a = await audit(page({ violations: 240, incomplete: 120 }));
    const b = await audit(page({ violations: 240, incomplete: 120 }));
    check('two runs of the same page return the same findings in the same order',
      JSON.stringify(a.findings.map((f) => f.id)) === JSON.stringify(b.findings.map((f) => f.id)),
      short({ a: a.findings.slice(0, 3).map((f) => f.id), b: b.findings.slice(0, 3).map((f) => f.id) }));
    const severities = a.findings.map((f) => f.severity);
    const rank = { critical: 0, serious: 1, moderate: 2, minor: 3, info: 4 };
    check('  and they are still in severity order', severities.every((s, i) => i === 0 || rank[severities[i - 1]] <= rank[s]), short(severities.slice(0, 12)));
  }

  // --- THE UNDECIDED FLOOR SURVIVES THE BYTE BUDGET.
  //
  // The count cap reserves a quarter of the budget for `incomplete`, because
  // they sort last and would otherwise be eaten whole. A byte trim that walks
  // the sorted list dropping from the end reintroduces exactly that bug, and
  // `counts.incomplete` would go on reporting the true number while the bucket
  // emptied.
  {
    const res = await audit(page({ violations: 240, incomplete: 120 }));
    const returnedIncomplete = res.findings.filter((f) => f.kind === 'incomplete').length;
    check('a page that would drown the undecided bucket still returns some of it', returnedIncomplete > 0, short({
      returnedIncomplete,
      returned: res.returnedFindingCount,
      counts: res.counts,
    }));
  }

  // --- AN ORDINARY PAGE IS NOT TOUCHED.
  //
  // The negative control that matters: if the byte budget bites on a normal
  // audit, the fix has broken the feature to pass its own test.
  {
    const res = await audit(plainPage({ violations: 6, incomplete: 4 }));
    const size = envelopeOf(res);
    check('an ordinary page returns every finding it detected', res.returnedFindingCount === res.findingCount, short({
      returned: res.returnedFindingCount,
      detected: res.findingCount,
    }));
    check('  reports nothing dropped', res.truncated === false && res.truncation.omittedByByteBudget === 0, short(res.truncation));
    check('  and is comfortably inside the budget', size.textBytes < HARD_CEILING, short(size));
    check('  with its evidence intact rather than clipped', (res.findings || []).every((f) => !f.truncatedFields), short((res.findings || [])[0]?.truncatedFields));
    check('  and none of it missing', (res.findings || []).every((f) => f.message && f.evidence && f.help), short((res.findings || [])[0]));
    check('  and the answer says no field was shortened', res.truncation.findingsWithShortenedFields === 0, short(res.truncation));
  }

  // --- ONE ENORMOUS FIELD CANNOT SMUGGLE THE PAYLOAD PAST THE BUDGET.
  //
  // A handful of findings is under the count cap and always will be, so if a
  // single evidence field is unbounded then the count cap is not a bound at all.
  {
    const monstrous = plainPage({ violations: 3 });
    for (const r of monstrous.violations) {
      r.help = 'H'.repeat(20000);
      for (const n of r.nodes) {
        n.target = ['S'.repeat(20000)];
        n.refPath = { path: 'P'.repeat(20000), exact: true };
      }
    }
    const res = await audit(monstrous);
    const size = envelopeOf(res);
    check('three findings with enormous fields are still a small answer', size.textBytes <= HARD_CEILING, short({ ...size, returned: res.returnedFindingCount }));
    check('  and the answer says the fields were shortened', (res.findings || []).some((f) => Array.isArray(f.truncatedFields) && f.truncatedFields.length > 0), short((res.findings || [])[0]?.truncatedFields));
    check('  rather than dropping the findings to hide it', res.returnedFindingCount === res.findingCount, short({ returned: res.returnedFindingCount, detected: res.findingCount }));
  }

  // --- CAPTURE OFF CANNOT RETURN CAPTURE DATA.
  //
  // BOTH HALVES, because one is not a control. Without an `encodeImage` the
  // capture block never runs whatever the flag says, so `captures.length === 0`
  // was true by construction: review patched the engine to ignore the flag
  // entirely and this section stayed green. So this audit can really take a
  // picture, and is asked twice.
  {
    const shooting = (axe, args) =>
      createAudit({
        BrowserWindow: windowsServing(axe, { blank: false }),
        getPreviewUrl: () => 'http://127.0.0.1:4321',
        session: cleanSession,
        encodeImage: () => ({ buffer: Buffer.alloc(2048, 7), size: { width: 375, height: 800 } }),
      }).run({ route: '/dense', ...args });

    const on = await shooting(page({ violations: 24, incomplete: 12 }), { capture: true, viewports: ['phone'] });
    check('capture:true really produces a capture', Array.isArray(on.captures) && on.captures.length > 0, short({ captures: on.captures?.length }));
    check('  with image data in it', typeof on.captures?.[0]?.data === 'string' && on.captures[0].data.length > 100, short({ len: on.captures?.[0]?.data?.length }));

    const off = await shooting(page({ violations: 24, incomplete: 12 }), { capture: false, viewports: ['phone'] });
    check('capture:false returns no captures at all', Array.isArray(off.captures) && off.captures.length === 0, short({ captures: off.captures?.length }));
    check('  and no base64 rides along in the payload', !/[A-Za-z0-9+/]{2000,}/.test(JSON.stringify(off)), 'something very long and base64-shaped is in the answer');
    check('  while the findings are unaffected by asking for one', off.returnedFindingCount === on.returnedFindingCount, short({ off: off.returnedFindingCount, on: on.returnedFindingCount }));
  }

  // --- AND NO AUDIT WINDOW SURVIVED ANY OF IT.
  {
    check('every audit window this suite opened was destroyed', liveWindowCount() === 0, short({ live: liveWindowCount() }));
  }

  if (failures.length) {
    console.error(`audit-byte-budget: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-byte-budget: ${checked} passed  [the answer fits through the host, and says what it left out]`);
})().catch((err) => {
  console.error('audit-byte-budget: threw\n', err?.stack || err);
  process.exit(1);
});
