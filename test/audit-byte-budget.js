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

const {
  createAudit,
  MAX_RESPONSE_BYTES,
  MAX_TOTAL_RESPONSE_BYTES,
  IMAGE_BLOCK_BUDGET_BYTES,
  MAX_CAPTURES,
  liveWindowCount,
} = require('../electron/mcp/audit');
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
function windowsServing(axe, { blank = true, ran = null } = {}) {
  return class FakeWindow {
    constructor() {
      this.webContents = {
        on: () => {},
        once: (event, fn) => {
          if (event === 'did-finish-load') setImmediate(fn);
        },
        setWindowOpenHandler: () => {},
        executeJavaScript: async (src) => {
          // WHAT THE PAGE WAS ACTUALLY ASKED TO EVALUATE, by kind. The only
          // honest oracle for "the engine did not run" is that the engine was
          // never sent: a result with no accessibility findings is equally
          // consistent with a page that has none. Classified rather than
          // sampled, because the axe bundle's first forty characters say
          // nothing about what it is.
          if (ran) {
            ran.push(
              typeof src !== 'string'
                ? 'not-source'
                : src.length > 50000
                  ? 'engine-bundle'
                  : src.includes('axe.run')
                    ? 'engine-script'
                    : src.includes('culpritTotal')
                      ? 'overflow-probe'
                      : src.includes('data-stacki-audit')
                        ? 'freeze'
                        : 'settle'
            );
          }
          // `culpritTotal`, not `documentElement`: the 580 KB axe bundle mentions
          // documentElement too, so dispatching on that answered the ENGINE with
          // a geometry result and hid it from `ran` entirely.
          if (typeof src === 'string' && src.includes('culpritTotal')) {
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
  // `images` never reaches the payload: the tool takes it off and sends each
  // entry as an image block. Measuring the envelope means building it the same
  // way, or the measurement is of a shape the product does not send.
  const { images = [], ...body } = res;
  const env = answer(body, { spaces: 0, images });
  // NOT content[0]. Image blocks come first, deliberately, so a host that
  // renders only the first block renders the picture.
  const text = env.content.find((b) => b.type === 'text').text;
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

  // --- EVERY DENOMINATOR IN THE ANSWER HAS A NAME, AND THEY ADD UP.
  //
  // `counts` is a breakdown of the SCORED set: what the page actually handed
  // Stacki, after the two in-page caps (forty geometry culprits, twelve axe
  // nodes per rule) and before the two response caps. That is a third
  // population, it is not `findingCount`, it is not `returnedFindingCount`, and
  // until now nothing in the payload named it -- a dogfood read
  // `counts: {standard:24, incomplete:12}` beside `findingCount: 96` and
  // `returnedFindingCount: 29` and had no field that equalled 36.
  //
  // Asserted as ARITHMETIC rather than as presence, so a stage that quietly
  // absorbs another fails here. And the fixture is built so all three numbers
  // DIFFER: a run where detected === scored === returned satisfies every
  // identity below trivially.
  {
    // nodeTotal is what axe found; `nodes` is what the in-page slice handed
    // back. Thirty-two against twelve is the shape a real rule on a real page
    // produces, and it is the only way to make detected > scored.
    const capped = (n, prefix, kind, found) => {
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const r = rule(`${prefix}${i}`, kind, NODES_PER_RULE);
        r.nodeTotal = found;
        out.push(r);
      }
      return out;
    };
    const res = await audit(
      {
        version: '4.13.0',
        violations: capped(3, 'contrast-v', 'violation', 32),
        incomplete: capped(1, 'contrast-i', 'incomplete', 32),
        passCount: 0,
        inapplicableCount: 0,
      },
      { viewports: ['phone'] }
    );
    const t = res.truncation;
    check('all three populations really differ in this fixture', t.detected > t.scored && t.scored > t.returned, short(t));
    check('the scored stage is named', typeof t.scored === 'number', short(t));
    check(
      '  detected minus what the page capped is scored',
      t.detected - t.omittedBeforeScoring.geometryCulprits - t.omittedBeforeScoring.axeNodes === t.scored,
      short(t)
    );
    check(
      '  scored minus the two response caps is returned',
      t.scored - t.omittedByResponseBudget - t.omittedByByteBudget === t.returned,
      short(t)
    );
    check(
      '  and `counts` breaks down the scored set, not either of the other two',
      Object.values(res.counts).reduce((a, b) => a + b, 0) === t.scored,
      short({ counts: res.counts, scored: t.scored, detected: t.detected, returned: t.returned })
    );
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
    // EVERY FIELD THE PAGE CHOOSES THE LENGTH OF, not only the ones that were
    // easy to think of. `target.tag` is a tag name off the document and a
    // custom element's is arbitrary; `evidence` is a free record and a computed
    // `calc()` round-trips verbatim. Both were unbounded, and neither was in
    // this fixture, so removing their caps left all 36 checks green.
    const monstrous = plainPage({ violations: 3 });
    for (const r of monstrous.violations) {
      r.help = 'H'.repeat(20000);
      for (const n of r.nodes) {
        n.target = ['S'.repeat(20000)];
        n.refPath = { path: 'P'.repeat(20000), exact: true };
        n.tag = `x-${'T'.repeat(20000)}`;
        // `evidence` is a free record. In production `failureSummary` is
        // clipped where it is collected in the page; the cap here is what
        // stands between the answer and the next evidence field somebody adds
        // without remembering to.
        n.failureSummary = 'F'.repeat(20000);
      }
    }
    const res = await audit(monstrous);
    const size = envelopeOf(res);
    check('three findings with enormous fields are still a small answer', size.textBytes <= HARD_CEILING, short({ ...size, returned: res.returnedFindingCount }));
    check('  and the answer says the fields were shortened', (res.findings || []).some((f) => Array.isArray(f.truncatedFields) && f.truncatedFields.length > 0), short((res.findings || [])[0]?.truncatedFields));
    check('  naming each one that was cut', (res.findings || []).every((f) => (f.truncatedFields || []).every((n) => typeof n === 'string' && n.length)), short((res.findings || [])[0]?.truncatedFields));
    check('  including the tag and the evidence, not only the obvious ones',
      (res.findings || []).some((f) => (f.truncatedFields || []).includes('target.tag')) &&
        (res.findings || []).some((f) => (f.truncatedFields || []).some((n) => n.startsWith('evidence.'))),
      short((res.findings || [])[0]?.truncatedFields));
    check('  and counts them, rather than leaving it to `truncated`',
      res.truncation.findingsWithShortenedFields === (res.findings || []).filter((f) => f.truncatedFields?.length).length &&
        res.truncation.findingsWithShortenedFields > 0,
      short({ counted: res.truncation.findingsWithShortenedFields }));
    check('  and every string in the answer is under its cap',
      !/[A-Za-z]{2000,}/.test(JSON.stringify(res)),
      'a very long unbroken run of characters survived into the answer');
    check('  rather than dropping the findings to hide it', res.returnedFindingCount === res.findingCount, short({ returned: res.returnedFindingCount, detected: res.findingCount }));
  }

  // --- A PICTURE IS AN IMAGE BLOCK, NOT A STRING IN THE PAYLOAD.
  //
  // This section used to inject `Buffer.alloc(2048)` and assert
  // `captures[0].data.length > 100`. A 2 KB fake is a quarter of one per cent of
  // a real capture, so nothing in the repo had ever measured what asking for a
  // picture costs. Measured, with real hidden windows and the real encoder: one
  // capture is 80,011-234,307 bytes of jpeg and 106,684-312,412 characters of
  // base64, and `audit({viewports:['desktop'], rules:['image-alt'], capture:true})`
  // on a page with ZERO findings was 153,406 characters of structuredContent of
  // which 151,916 -- 99.0% -- was the image. The host replaced the whole result
  // with a file pointer.
  //
  // So the fake is now the MEASURED size of a real desktop capture, and the
  // arithmetic is the HOST'S OWN, transcribed from the shipped binary rather
  // than guessed at, so raising a Stacki constant cannot make this pass.
  {
    // Claude Code 2.1.251, /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code
    // bin/claude.exe, chunk-1fsp1n10.js: `var C=0.5, l=1600, d=25000`.
    //   d  -- the default limit, in TOKENS, overridable by MAX_MCP_OUTPUT_TOKENS
    //   C  -- a cheap pre-gate at half of it: a result estimating under this is
    //         accepted without the tokenizer ever running
    //   l  -- what an image content block is charged, FLAT, whatever it weighs
    // and ds(): when structuredContent is present the text blocks are DISCARDED
    // and JSON.stringify(structuredContent) is what gets counted.
    const HOST_TOKEN_LIMIT = 25000;
    const HOST_CHEAP_GATE = 12500;
    const IMAGE_BLOCK_TOKENS = 1600;
    // The desktop capture from the measurement table above: a real 1440x900
    // window photographed at 2880x1800 on a 2x display, downsampled by
    // capture.js's MAX_EDGE to 1400x875 and encoded at quality 82.
    const MEASURED_DESKTOP_JPEG = 113_937;
    const estimateTokens = (env) =>
      Math.round(JSON.stringify(env.structuredContent).length / 4) +
      (env.content || []).filter((b) => b.type === 'image').length * IMAGE_BLOCK_TOKENS;

    // A DIFFERENT PICTURE EVERY TIME, so "the picture moved" can be told from
    // "the same bytes came back", and so one sha256 cannot stand for another.
    let frame = 0;
    const shooting = (axe, args) =>
      createAudit({
        BrowserWindow: windowsServing(axe, { blank: false }),
        getPreviewUrl: () => 'http://127.0.0.1:4321',
        session: cleanSession,
        encodeImage: () => ({ buffer: Buffer.alloc(MEASURED_DESKTOP_JPEG, (frame++ % 251) + 1), size: { width: 1400, height: 875 } }),
      }).run({ route: '/dense', ...args });

    /** The envelope the tool actually sends. */
    const envelope = ({ images = [], ...body }) => answer(body, { spaces: 0, images });
    /** THE SHAPE THIS FINDING REPLACED, rebuilt from the very same bytes. */
    const asJsonPayload = ({ images = [], ...body }) =>
      answer(
        { ...body, captures: (body.captures || []).map((c) => ({ ...c, data: images.find((i) => i.viewport === c.viewport.key)?.data })) },
        { spaces: 0 }
      );

    // --- THE CONTROL FIRST. Prove the threshold can be crossed at all, with
    // the product's own bytes, before trusting that the fixed shape is under it.
    // Without this, "under the gate" could be true because the fixture is small.
    {
      const one = await shooting(page({ violations: 0, incomplete: 0 }), { capture: true, viewports: ['desktop'] });
      const before = estimateTokens(asJsonPayload(one));
      const after = estimateTokens(envelope(one));
      check(
        'base64 inside the payload really does exceed what the host will accept',
        before > HOST_TOKEN_LIMIT,
        short({ estimatedTokens: before, hostLimit: HOST_TOKEN_LIMIT })
      );
      check(
        '  and the same capture as an image block is inside the gate the host never counts past',
        after <= HOST_CHEAP_GATE,
        short({ estimatedTokens: after, cheapGate: HOST_CHEAP_GATE })
      );
      check(
        '  which is the ZERO-FINDING case, where the picture is the entire answer',
        one.returnedFindingCount === 0 && after < before / 10,
        short({ findings: one.returnedFindingCount, before, after })
      );
      check(
        '  because the image is an image block, not a string in the payload',
        !/[A-Za-z0-9+/]{2000,}/.test(JSON.stringify(envelope(one).structuredContent)),
        'something very long and base64-shaped survived into structuredContent'
      );
      const env = envelope(one);
      check(
        '  and the envelope really carries it',
        env.content.filter((b) => b.type === 'image').length === one.captures.filter((c) => c.included).length &&
          env.content.filter((b) => b.type === 'image').length === 1,
        short({ blocks: env.content.map((b) => b.type), included: one.captures.map((c) => c.included) })
      );
      check(
        '  with the image block first, so a host that renders one block renders the picture',
        env.content[0].type === 'image' && typeof env.content[0].data === 'string' && env.content[0].mimeType === 'image/jpeg',
        short({ first: env.content[0]?.type, mime: env.content[0]?.mimeType })
      );
      check(
        '  metadata for the capture and image data for none',
        one.captures.every((c) => typeof c.included === 'boolean' && c.data === undefined),
        short(one.captures)
      );
      check(
        '  saying what the picture is OF, at the width it was taken',
        one.captures.every((c) => c.renderedOffscreen === true && /offscreen/i.test(c.note) && /1440x900/.test(c.note)),
        short(one.captures[0]?.note)
      );
      check(
        '  and carrying its identity, so a before and an after can be compared',
        typeof one.captures[0].sha256 === 'string' && one.captures[0].sha256.length > 8,
        short(one.captures[0]?.sha256)
      );
    }

    // --- TWO PICTURES OF THE SAME ROUTE ARE TELLABLE APART WITHOUT SENDING ONE.
    {
      const a = await shooting(page({ violations: 2 }), { capture: true, viewports: ['phone'] });
      const b = await shooting(page({ violations: 2 }), { capture: true, viewports: ['phone'] });
      check(
        'two captures of the same route are distinguished by their digests',
        a.captures[0].sha256 !== b.captures[0].sha256 && a.images?.[0]?.data !== b.images?.[0]?.data,
        short({ a: a.captures[0].sha256, b: b.captures[0].sha256 })
      );
    }

    // --- THREE VIEWPORTS, WHICH IS THE DEFAULT AND WAS THE WORST CASE.
    // Measured before this change: 458,021 characters of structuredContent, of
    // which 455,748 were the three images.
    {
      const three = await shooting(page({ violations: 24, incomplete: 12 }), { capture: true });
      const env = envelope(three);
      check('the default three viewports each get a picture', three.captures.filter((c) => c.included).length === 3, short(three.captures.map((c) => c.included)));
      check('  as three image blocks', env.content.filter((b) => b.type === 'image').length === 3, short(env.content.map((b) => b.type)));
      check(
        '  and the whole answer is still inside the host gate',
        estimateTokens(env) <= HOST_CHEAP_GATE,
        short({ estimatedTokens: estimateTokens(env), cheapGate: HOST_CHEAP_GATE })
      );
      check(
        '  where base64 in the payload would have been three times over the limit',
        estimateTokens(asJsonPayload(three)) > HOST_TOKEN_LIMIT * 3,
        short({ asJson: estimateTokens(asJsonPayload(three)) })
      );
      check(
        '  the findings were charged for the pictures, in their own field',
        three.truncation.responseByteCap === MAX_TOTAL_RESPONSE_BYTES - 3 * IMAGE_BLOCK_BUDGET_BYTES &&
          three.truncation.responseByteCap < MAX_RESPONSE_BYTES,
        short({ inForce: three.truncation.responseByteCap, declared: MAX_RESPONSE_BYTES })
      );
      check(
        '  and still returned findings to act on',
        three.returnedFindingCount >= 8,
        short({ returned: three.returnedFindingCount })
      );
      check(
        '  with the total budget covering both halves',
        Buffer.byteLength(JSON.stringify(env.structuredContent), 'utf8') + 3 * IMAGE_BLOCK_BUDGET_BYTES <= MAX_TOTAL_RESPONSE_BYTES,
        short({
          structured: Buffer.byteLength(JSON.stringify(env.structuredContent), 'utf8'),
          images: 3 * IMAGE_BLOCK_BUDGET_BYTES,
          total: MAX_TOTAL_RESPONSE_BYTES,
        })
      );
    }

    // --- A PICTURE THAT WILL NOT FIT IS DROPPED, AND SAID TO BE DROPPED.
    //
    // Six viewports is what the input schema allows. The budget affords three
    // images beside a findings answer worth having, so three viewports get a row
    // that says plainly that they got no picture -- rather than no row at all,
    // which says nothing, or a row implying an image that was never sent.
    {
      const many = await shooting(page({ violations: 12 }), {
        capture: true,
        viewports: ['reflow', 'phone', 'tablet', 'desktop', { width: 900, height: 700 }, { width: 1920, height: 1080 }],
      });
      check('every viewport asked about has a row', many.captures.length === 6, short(many.captures.length));
      check('  three of which carry a picture', many.captures.filter((c) => c.included).length === MAX_CAPTURES, short(many.captures.map((c) => c.included)));
      check(
        '  and three of which say they do not',
        many.truncation.omittedCaptureCount === 3 && many.captures.filter((c) => c.included === false).length === 3,
        short({ omitted: many.truncation.omittedCaptureCount })
      );
      check(
        '  with nothing on a dropped row that implies an image',
        many.captures
          .filter((c) => !c.included)
          .every((c) => c.data === undefined && c.bytes === null && c.mimeType === null && c.sha256 === null && /no picture/i.test(c.note)),
        short(many.captures.filter((c) => !c.included)[0])
      );
      check(
        '  and the answer recommends the narrower call, by name',
        typeof many.next === 'string' && /viewports:/.test(many.next) && /capture:true/.test(many.next),
        short(many.next)
      );
      check(
        '  which is a call that fits: one viewport, one picture, inside the gate',
        estimateTokens(envelope(await shooting(page({ violations: 12 }), { capture: true, viewports: ['tablet'] }))) <= HOST_CHEAP_GATE,
        short({ tokens: estimateTokens(envelope(await shooting(page({ violations: 12 }), { capture: true, viewports: ['tablet'] }))) })
      );
      check(
        '  and six images never rode along in the envelope',
        envelope(many).content.filter((b) => b.type === 'image').length === MAX_CAPTURES,
        short(envelope(many).content.map((b) => b.type))
      );
      // `next` QUOTES THE ROUTE, so it is a caller-chosen string in the answer.
      // Two earlier fields in this result were caught doing exactly this and
      // pushing a zero-finding reply past what the host would take.
      {
        const longRoute = `/${'a'.repeat(4000)}`;
        const res = await shooting(page({ violations: 12 }), {
          route: longRoute,
          capture: true,
          viewports: ['reflow', 'phone', 'tablet', 'desktop'],
        });
        const bytes = Buffer.byteLength(JSON.stringify(envelope(res).structuredContent), 'utf8');
        check(
          '  and a four-thousand-character route cannot smuggle bytes in through `next`',
          bytes + MAX_CAPTURES * IMAGE_BLOCK_BUDGET_BYTES <= MAX_TOTAL_RESPONSE_BYTES && res.next.length < 900,
          short({ structured: bytes, next: res.next.length })
        );
      }
    }

    // --- CAPTURE OFF CANNOT RETURN CAPTURE DATA.
    //
    // BOTH HALVES, because one is not a control. Without an `encodeImage` the
    // capture block never runs whatever the flag says, so `captures.length === 0`
    // was true by construction: review patched the engine to ignore the flag
    // entirely and this section stayed green. So this audit can really take a
    // picture, and is asked twice.
    {
      const on = await shooting(page({ violations: 24, incomplete: 12 }), { capture: true, viewports: ['phone'] });
      check('capture:true really produces a capture', Array.isArray(on.captures) && on.captures.length > 0, short({ captures: on.captures?.length }));
      check('  with a real image beside the payload', on.images?.length === 1 && typeof on.images?.[0]?.data === 'string' && on.images[0].data.length > 100_000, short({ len: on.images?.[0]?.data?.length }));

      const off = await shooting(page({ violations: 24, incomplete: 12 }), { capture: false, viewports: ['phone'] });
      check('capture:false returns no captures at all', Array.isArray(off.captures) && off.captures.length === 0, short({ captures: off.captures?.length }));
      check('  and no image blocks either', envelope(off).content.every((b) => b.type === 'text'), short(envelope(off).content.map((b) => b.type)));
      check('  and no base64 rides along in the payload', !/[A-Za-z0-9+/]{2000,}/.test(JSON.stringify(off)), 'something very long and base64-shaped is in the answer');
      check('  while the findings are unaffected by asking for one', off.returnedFindingCount >= on.returnedFindingCount, short({ off: off.returnedFindingCount, on: on.returnedFindingCount }));
    }
  }

  // --- WHAT `rules` SCOPES, AND WHAT AN EMPTY ONE COSTS.
  //
  // Here because both halves are about what a call PAYS FOR. The audit already
  // renders any route offscreen at any width in a window of its own and
  // photographs it -- which is the only way to see a route at a width you chose,
  // since nothing in the MCP surface sets the person's breakpoint and nothing
  // should. What made that unusable was F18 above; what made it expensive is
  // that `rules: []` was indistinguishable from omitting the field, so a caller
  // who wanted geometry and a picture paid for the axe bundle and a full WCAG
  // pass as well.
  //
  // AND THE CONTRACT THE FILTER HAS ALWAYS HAD, now asserted instead of implied:
  // `rules` scopes the ACCESSIBILITY engine only. The geometry probe is not a
  // rule list and always runs. A caller who reads "rules" as "everything this
  // audit checks" is reading a different tool.
  {
    const overflowing = {
      viewportWidth: 375,
      documentScrollWidth: 520,
      overflowBy: 145,
      overflows: true,
      culprits: [
        {
          selector: 'main > div.banner',
          match: { index: 0, of: 1 },
          tag: 'div',
          rect: { x: 0, y: 0, width: 520, height: 40, top: 0, right: 520, bottom: 40, left: 0 },
          overflowBy: 145,
          edge: 'right',
          computed: { 'overflow-x': 'visible', width: '520px', 'min-width': 'auto', position: 'static' },
          ref: { path: 'src/pages/index.astro#0.2.0', exact: true },
          text: 'Sale',
        },
      ],
      culpritTotal: 1,
      truncated: false,
    };
    /** A window that overflows, records what it was asked to evaluate, and knows two axe rules. */
    const measuring = (ran) =>
      class extends windowsServing(
        {
          version: '4.13.0',
          violations: [rule('color-contrast', 'violation', 2)],
          incomplete: [],
          passCount: 0,
          inapplicableCount: 0,
          knownRuleIds: ['color-contrast', 'image-alt'],
        },
        { ran }
      ) {
        constructor(...args) {
          super(...args);
          const inner = this.webContents.executeJavaScript;
          this.webContents.executeJavaScript = async (src) => {
            if (typeof src === 'string' && src.includes('culpritTotal')) return overflowing;
            return inner(src);
          };
        }
      };
    const withRules = (rules, ran) =>
      createAudit({ BrowserWindow: measuring(ran), getPreviewUrl: () => 'http://127.0.0.1:4321', session: cleanSession }).run({
        route: '/dense',
        viewports: ['phone'],
        ...(rules === undefined ? {} : { rules }),
      });

    // --- rules: [] means NO ACCESSIBILITY ENGINE.
    {
      const ran = [];
      const res = await withRules([], ran);
      check('an audit with rules:[] still audits', res.ok === true, short({ ok: res.ok, code: res.code }));
      check(
        '  and the engine was never even sent to the page',
        ran.length > 0 && ran.every((kind) => !kind.startsWith('engine')),
        short(ran)
      );
      check('  which the answer says, rather than reporting a clean page', res.engine.accessibility === null && res.engine.error === null, short(res.engine));
      check('  with no accessibility findings at all', (res.findings || []).every((f) => f.category !== 'accessibility'), short((res.findings || []).map((f) => f.category)));
      check('  and no accessibility numbers on the viewport record', res.viewports[0].accessibility === null, short(res.viewports[0]));
      // THE HALF THAT MAKES IT USEFUL: the measurement still happened.
      check(
        '  while the geometry it was asked for is measured as usual',
        (res.findings || []).some((f) => f.ruleId === 'horizontal-overflow'),
        short((res.findings || []).map((f) => f.ruleId))
      );
    }

    // --- OMITTING `rules` IS NOT THE SAME THING, or the empty array means nothing.
    {
      const ran = [];
      const res = await withRules(undefined, ran);
      check('omitting rules still runs the whole WCAG set', res.engine.accessibility === 'axe-core 4.13.0', short(res.engine));
      check('  which really was sent to the page, bundle and all', ran.includes('engine-bundle') && ran.includes('engine-script'), short(ran));
      check('  and produces accessibility findings', (res.findings || []).some((f) => f.category === 'accessibility'), short((res.findings || []).map((f) => f.category)));
    }

    // --- A NAMED RULE SCOPES THE ENGINE, AND ONLY THE ENGINE.
    {
      const res = await withRules(['color-contrast'], []);
      check('a named rule runs the engine', res.engine.accessibility === 'axe-core 4.13.0', short(res.engine));
      check(
        '  and the geometry probe runs regardless, because it is not a rule in that list',
        (res.findings || []).some((f) => f.ruleId === 'horizontal-overflow'),
        short((res.findings || []).map((f) => f.ruleId))
      );
      check('  with nothing unknown to report', Array.isArray(res.engine.unknownRules) && res.engine.unknownRules.length === 0, short(res.engine.unknownRules));
    }

    // --- A RULE ID THE ENGINE DOES NOT HAVE IS SAID OUT LOUD.
    //
    // It used to be accepted in silence, and silence is indistinguishable from
    // "that rule found nothing" -- which is the answer a typo produces and the
    // answer a caller will believe.
    {
      const res = await withRules(['color-contrast', 'colour-contrast', 'no-such-rule'], []);
      check(
        'rule ids the engine does not have are named back',
        Array.isArray(res.engine.unknownRules) && res.engine.unknownRules.join(',') === 'colour-contrast,no-such-rule',
        short(res.engine.unknownRules)
      );
      check('  and the ones it does have still ran', res.engine.accessibility === 'axe-core 4.13.0' && (res.findings || []).some((f) => f.category === 'accessibility'), short(res.engine));
    }

    // --- AND A PICTURE AT A WIDTH NOBODY HAS A BREAKPOINT FOR.
    //
    // The route E3 asks to be documented, asserted so documenting it cannot
    // outlive it: an arbitrary width, rendered offscreen, photographed, with no
    // accessibility pass paid for.
    {
      const res = await createAudit({
        BrowserWindow: windowsServing(page({ violations: 0 }), { blank: false }),
        getPreviewUrl: () => 'http://127.0.0.1:4321',
        session: cleanSession,
        encodeImage: () => ({ buffer: Buffer.alloc(40_000, 3), size: { width: 900, height: 700 } }),
      }).run({ route: '/pricing', viewports: [{ width: 900, height: 700 }], rules: [], capture: true });
      check('a route can be photographed at a width of the caller\'s choosing', res.ok === true && res.captures.length === 1, short({ ok: res.ok, code: res.code, captures: res.captures?.length }));
      check('  reported under its own viewport key', res.captures[0].viewport.key === 'custom-900x700' && res.captures[0].viewport.width === 900, short(res.captures[0].viewport));
      check('  labelled as an offscreen render at that width, not the person\'s screen', res.captures[0].renderedOffscreen === true && /offscreen at 900x700/.test(res.captures[0].note), short(res.captures[0].note));
      check('  and it cost no accessibility pass', res.engine.accessibility === null && res.engine.error === null, short(res.engine));
    }
  }

  // --- AND THE TOOL, NOT ONLY THE ENGINE, IS WHAT SENDS IT.
  //
  // Everything above measures `answer()` called the way auditTool.js calls it.
  // That is an assumption about a file, and an assumption about a file is what
  // put 150 KB of base64 on the wire in the first place. So this drives the
  // REGISTERED HANDLER: whatever it returns is what a client receives.
  {
    const { registerAuditTool } = require('../electron/mcp/auditTool.js');
    let handler = null;
    const server = { registerTool: (_name, _def, fn) => { handler = fn; } };
    const engine = createAudit({
      BrowserWindow: windowsServing(page({ violations: 4 }), { blank: false }),
      getPreviewUrl: () => 'http://127.0.0.1:4321',
      session: cleanSession,
      encodeImage: () => ({ buffer: Buffer.alloc(113_937, 9), size: { width: 1400, height: 875 } }),
    });
    const registered = registerAuditTool(server, { audit: (args) => engine.run(args), api: { checkAccess: () => null } });
    check('the audit tool registers', registered === true && typeof handler === 'function');

    const out = await handler({ route: '/dense', viewports: ['phone'], capture: true });
    check(
      'the tool sends the picture as an image block',
      (out.content || []).filter((b) => b.type === 'image').length === 1,
      short((out.content || []).map((b) => b.type))
    );
    check(
      '  and not as base64 in structuredContent',
      !/[A-Za-z0-9+/]{2000,}/.test(JSON.stringify(out.structuredContent)),
      'the tool put base64 in the payload'
    );
    check(
      '  with `images` never reaching the client as a field',
      out.structuredContent.images === undefined && Array.isArray(out.structuredContent.captures),
      short(Object.keys(out.structuredContent).filter((k) => /image/i.test(k)))
    );
    check(
      '  and the capture row still describing what was sent',
      out.structuredContent.captures.length === 1 && out.structuredContent.captures[0].included === true,
      short(out.structuredContent.captures)
    );
    // AND THE SCHEMA THE TOOL PUBLISHES ACCEPTS ITS OWN ANSWER. A payload that
    // its own outputSchema rejects is a client-side failure nobody sees here.
    const { AuditOutput } = require('../electron/mcp/auditTool.js');
    const parsed = AuditOutput.safeParse(out.structuredContent);
    check('  which the published outputSchema validates', parsed.success === true, short(parsed.error?.issues?.slice(0, 3)));
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
