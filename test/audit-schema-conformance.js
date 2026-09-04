// Every shape the audit emits is a shape the audit's own schema declares.
//
//   node test/audit-schema-conformance.js
//
// THE DEFECT THIS FILE IS THE ANSWER TO, TWICE OVER.
//
// `audit` is the one Stacki tool that publishes an `outputSchema`, and the MCP
// SDK turns that zod object into JSON Schema with `additionalProperties: false`
// on every object in it. A conformant client validates `structuredContent`
// against that document and REFUSES THE WHOLE CALL when a single key is not
// declared. Not a warning, not a stripped field -- no result at all.
//
// It has now shipped twice. First `engine.unknownRules`,
// `truncation.omittedCaptureCount` and `truncation.totalByteCap`; a check was
// added to test/mcp-audit.js that walks every live answer against the published
// schema, and it was believed to have closed the class. It had not. A native
// dogfood then found `findings[].target.modelPathMatch` -- emitted by
// findings.js for EVERY repeated node, so one alt-less <img> inside a `.map()`
// made the whole audit undeliverable -- and the new check stayed green, because
// no fixture that suite validated rendered a repeated node that produced a
// finding. A checker that is only as good as the payloads it happens to see is
// not a guard; it is a coincidence.
//
// So this suite does not wait for a payload to arrive. It DRIVES THE ENGINE
// DOWN EVERY BRANCH IT HAS -- clean, overflowing, flooded past both caps, the
// reflow width, no accessibility pass at all, and each of the refusals -- and
// walks each answer against the schema the tool publishes. Then it closes the
// loop the other way: every property `findings[].target` declares must have
// been emitted by one of those answers, so a field that is declared and never
// produced (or produced and never declared) is a failure here rather than a
// support ticket about a client that "does nothing".
//
// It is also the module the two audit suites that need a validator import: one
// walker, so mcp-audit's live answers and audit-identity's repeated-node
// findings are judged by the same rules as these.
//
// DEPENDENCY-FREE ON PURPOSE. The obvious move is ajv and it is wrong twice:
// the copy in node_modules is a transitive v6 that cannot read the draft zod
// emits, and this module is required by an ELECTRON suite, where any throw at
// require time is a modal dialog on somebody's screen instead of a red line in
// a terminal. Hence the try/catch around deriving the schema, and a walker that
// implements the handful of keywords zod actually emits.

const zod = require('zod');
const { AuditOutput } = require('../electron/mcp/auditTool.js');
const { createAudit, liveWindowCount } = require('../electron/mcp/audit');

// The exact document the SDK publishes for this tool, or null. Derived once,
// and never allowed to throw: a checker that crashes the suite it guards is
// worse than one that reports it could not be built, which is what
// `schemaDerived` below is for.
let published = null;
try {
  published = zod.toJSONSchema(AuditOutput, { io: 'output', unrepresentable: 'any' });
} catch {
  published = null;
}

/** The published JSON Schema for an audit answer, or null if it could not be derived. */
const publishedSchema = () => published;

/**
 * Everything about `value` that the schema does not allow, deep.
 *
 * Not just undeclared keys. The two defects this class has produced in this
 * codebase are an undeclared key and -- one tool over, in `git` -- a field
 * DECLARED as an array and emitted as a number, which fails a client just as
 * hard. So types, integers, enums, required-ness and `additionalProperties` are
 * all checked, which is every keyword zod emits for this schema.
 *
 * Returns [] when handed no schema, so a caller that could not derive one sees
 * it as its own reported failure rather than as a clean walk.
 */
function schemaViolations(value, schema, at = '') {
  if (!schema || typeof schema !== 'object') return [];
  const here = at || '/';
  // A nullable field is anyOf[string, null] and a union is the same shape: it
  // is a violation only when EVERY branch rejects it.
  const branches = schema.anyOf || schema.oneOf;
  if (Array.isArray(branches) && branches.length) {
    const per = branches.map((b) => schemaViolations(value, b, at));
    if (per.some((p) => p.length === 0)) return [];
    return [`${here} fits none of the ${branches.length} declared branches`];
  }
  const out = [];
  if (schema.type) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok =
      schema.type === 'integer'
        ? Number.isInteger(value)
        : schema.type === 'number'
          ? kind === 'number'
          : schema.type === kind;
    // A wrong type makes every deeper answer noise, so this one stops here.
    if (!ok) return [`${here} is ${kind}, schema says ${schema.type}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${here} is ${JSON.stringify(value)}, not one of ${schema.enum.join('|')}`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => out.push(...schemaViolations(v, schema.items, `${at}[${i}]`)));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) out.push(`${at}/${key} is required and absent`);
  }
  const props = schema.properties;
  if (!props) return out;
  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      out.push(...schemaViolations(value[key], props[key], `${at}/${key}`));
      continue;
    }
    // `additionalProperties` is false on every object zod closes, and a
    // subschema on the one open record (`evidence`), which is walked rather
    // than waved through.
    if (schema.additionalProperties === false) out.push(`${at}/${key} is not declared`);
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      out.push(...schemaViolations(value[key], schema.additionalProperties, `${at}/${key}`));
    }
  }
  return out;
}

/**
 * The key paths a payload actually carries, in the spelling the schema uses.
 *
 * `/findings[]/target/modelPathMatch` -- array indices collapse to `[]`, so
 * "was this field ever emitted by anything" is a set membership question. This
 * is the half that catches a schema check which passes because it never saw the
 * shape, which is exactly how the second instance shipped.
 */
function keyPathsIn(value, at = '', into = new Set()) {
  if (!value || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const v of value) keyPathsIn(v, `${at}[]`, into);
    return into;
  }
  for (const key of Object.keys(value)) {
    into.add(`${at}/${key}`);
    keyPathsIn(value[key], `${at}/${key}`, into);
  }
  return into;
}

/** What a client receives: the wire copy, with `undefined` gone as JSON drops it. */
const onTheWire = (answer) => {
  const { images, ...body } = answer || {};
  return JSON.parse(JSON.stringify(body));
};

module.exports = { publishedSchema, schemaViolations, keyPathsIn, onTheWire };

if (require.main !== module) return;

// ---------------------------------------------------------------- the suite

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 300) => JSON.stringify(v ?? null).slice(0, n);

/** A window that answers the geometry probe and the engine with canned results. */
function windowsServing(axe, geometry, { url = 'http://127.0.0.1:4321/', image = null } = {}) {
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
        getURL: () => url,
        capturePage: async () => image || { isEmpty: () => true },
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
  fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {} }),
};
// The session that cannot be wiped, which is the `session_not_isolated` answer.
const lockedSession = {
  fromPartition: () => ({
    clearStorageData: async () => {
      throw new Error('storage is locked by another process');
    },
    clearCache: async () => {},
    clearAuthCache: async () => {},
  }),
};

// One component rendered N times: the shape that produced the defect. Every row
// carries the identical `data-avb-p`, so every finding carries `modelPathMatch`
// and nothing else in the payload can tell row two from row four.
const SHARED_MODEL_PATH = 'src/pages/blog/index.astro#0.2.1 src/components/PostRow.astro#0.0.3';
const axeAnswer = ({ rows = 5, incomplete = 1, unknownRules = null, crossBoundary = false } = {}) => ({
  version: '4.13.0',
  violations: [
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must meet minimum colour contrast ratio thresholds',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
      tags: ['cat.color', 'wcag2aa', 'wcag143'],
      nodeTotal: rows,
      nodes: Array.from({ length: rows }, (_, i) => ({
        target: [`li:nth-child(${i + 1}) > time`],
        html: '<time class="faint">Jan 1</time>',
        failureSummary: 'Fix any of the following: Element has insufficient colour contrast',
        refPath: { path: SHARED_MODEL_PATH, exact: true, match: { index: i, of: rows } },
        tag: 'time',
        rect: { x: 12, y: 100 * (i + 1), width: 80, height: 18 },
        match: { index: 0, of: 1 },
      })),
    },
    // The three targets that are NOT a marked node: one inside a shadow root,
    // one whose nearest marker is an ancestor, one with no marker at all. Each
    // takes a different branch of targetOf and each writes a different `note`.
    {
      id: 'image-alt',
      impact: 'critical',
      help: 'Images must have alternative text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/image-alt',
      tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
      nodeTotal: 3,
      nodes: [
        {
          target: crossBoundary ? ['my-widget', 'img'] : ['section > img'],
          html: '<img src="a.png">',
          failureSummary: 'Fix any of the following: Element has no alt attribute',
          refPath: crossBoundary ? null : { path: 'src/pages/blog/index.astro#0.2', exact: false, match: null },
          crossBoundary,
          tag: 'img',
          rect: { x: 0, y: 10, width: 40, height: 40 },
          match: { index: 0, of: 1 },
        },
        {
          target: ['div.embed > img'],
          html: '<img src="b.png">',
          failureSummary: 'Fix any of the following: Element has no alt attribute',
          refPath: null,
          tag: 'img',
          rect: { x: 0, y: 60, width: 40, height: 40 },
          match: { index: 0, of: 2 },
        },
        {
          target: ['div.embed > img'],
          html: '<img src="c.png">',
          failureSummary: 'Fix any of the following: Element has no alt attribute',
          refPath: null,
          tag: 'img',
          rect: { x: 0, y: 110, width: 40, height: 40 },
          match: { index: 1, of: 2 },
        },
      ],
    },
  ],
  incomplete: Array.from({ length: incomplete }, () => ({
    id: 'color-contrast-enhanced',
    impact: null,
    help: 'Elements must meet enhanced colour contrast ratio thresholds',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast-enhanced',
    tags: ['cat.color', 'wcag2aaa'],
    nodeTotal: 1,
    nodes: [
      {
        target: ['body > main'],
        html: '<main>…</main>',
        failureSummary: '',
        refPath: { path: 'src/pages/blog/index.astro#0.1', exact: true, match: { index: 0, of: 1 } },
        tag: 'main',
        rect: { x: 0, y: 0, width: 375, height: 800 },
        match: { index: 0, of: 1 },
      },
    ],
  })),
  passCount: 12,
  inapplicableCount: 4,
  ...(unknownRules ? { unknownRules } : {}),
});

const quietGeometry = {
  viewportWidth: 375,
  documentScrollWidth: 375,
  overflowBy: 0,
  overflows: false,
  culprits: [],
  culpritTotal: 0,
  truncated: false,
};
const overflowGeometry = ({ culprits = 3, truncated = false } = {}) => ({
  viewportWidth: 375,
  documentScrollWidth: 460,
  overflowBy: 85,
  overflows: true,
  culprits: Array.from({ length: culprits }, (_, i) => ({
    selector: 'div.widget > div.card',
    match: { index: i, of: culprits },
    tag: 'div',
    rect: { x: 8, y: 400 + i * 60, width: 500, height: 50, top: 400 + i * 60, right: 508, bottom: 450 + i * 60, left: 8 },
    overflowBy: 133 - i,
    edge: 'right',
    computed: { 'overflow-x': 'visible', width: '500px', 'min-width': 'auto', position: 'static' },
    // Half carry a shared model path (the repeated component) and half carry
    // none (a third-party widget), so both branches of `whereOf` are in here.
    ref: i % 2 === 0 ? { path: SHARED_MODEL_PATH, exact: true, match: { index: i, of: culprits } } : null,
    // Long enough that the field caps have something to shorten.
    text: `Sponsored ${'row '.repeat(120)}`,
  })),
  culpritTotal: culprits + 7,
  truncated,
});
// Nothing attributable, and the document still scrolls: the finding with no
// target at all, which is its own shape.
const unattributedGeometry = {
  viewportWidth: 375,
  documentScrollWidth: 500,
  overflowBy: 125,
  overflows: true,
  culprits: [],
  culpritTotal: 0,
  truncated: false,
};

// A finding that IS valid, so each plant below differs from it in exactly one
// way and the count of violations is the count of things planted. Its own
// validity is checked first, before it is used to prove anything.
const FINDING_SHELL = {
  id: 'f_0000000000000000',
  ruleId: 'image-alt',
  category: 'accessibility',
  kind: 'standard',
  severity: 'critical',
  standard: 'wcag2a, wcag111',
  relatedStandard: null,
  viewport: { key: 'phone', width: 375, height: 812, device: 'phone' },
  message: 'Images must have alternative text',
  target: { selector: 'img', tag: 'img', modelPath: null, exact: false, note: 'no marker' },
  evidence: { impact: 'critical', html: '<img>' },
  help: 'https://dequeuniversity.com/rules/axe/4.13/image-alt',
};

const auditWith = ({ axe = axeAnswer(), geometry = quietGeometry, session = cleanSession, preview = 'http://127.0.0.1:4321', url, image } = {}) =>
  createAudit({
    BrowserWindow: windowsServing(axe, geometry, { url, image }),
    getPreviewUrl: () => preview,
    session,
  });

(async () => {
  // --- 0. THE CHECKER HAS TO BE ABLE TO FAIL.
  //
  // Six checks in an earlier pass of this mission could not fail and were
  // therefore not checks. Each keyword this walker implements is planted here
  // against the real published schema before any answer is judged by it.
  check('the audit output schema derives, the way the SDK derives it', !!published?.properties, short(published && Object.keys(published)));

  const plant = (payload) => schemaViolations(payload, published);
  const ok = { ok: true };
  check(
    'a clean minimal answer passes the walk',
    plant(ok).length === 0,
    short(plant(ok))
  );
  check(
    '  and so does a whole finding, so each plant below differs from a valid one in one way',
    plant({ ok: true, findings: [FINDING_SHELL] }).length === 0,
    short(plant({ ok: true, findings: [FINDING_SHELL] }))
  );
  check(
    'an undeclared key is caught',
    plant({ ok: true, engine: { accessibility: null, error: null, notADeclaredField: 1 } }).length === 1,
    short(plant({ ok: true, engine: { accessibility: null, error: null, notADeclaredField: 1 } }))
  );
  check(
    'a field of the wrong type is caught',
    plant({ ok: true, findingCount: 'seven' }).length === 1,
    short(plant({ ok: true, findingCount: 'seven' }))
  );
  check(
    '  including a whole number declared and a fraction emitted',
    plant({ ok: true, findingCount: 1.5 }).length === 1,
    short(plant({ ok: true, findingCount: 1.5 }))
  );
  check(
    '  and an array declared with a number emitted -- the shape that broke `git`',
    plant({ ok: true, finalRoutes: 3 }).length === 1,
    short(plant({ ok: true, finalRoutes: 3 }))
  );
  check(
    'a value outside a declared enum is caught',
    plant({ ok: true, findings: [{ ...FINDING_SHELL, kind: 'suggestion' }] }).length === 1,
    short(plant({ ok: true, findings: [{ ...FINDING_SHELL, kind: 'suggestion' }] }))
  );
  check(
    'a required field left out is caught',
    plant({ ok: true, findings: [{ ...FINDING_SHELL, target: { selector: null, tag: null, exact: true, note: null } }] }).length === 1,
    short(plant({ ok: true, findings: [{ ...FINDING_SHELL, target: { selector: null, tag: null, exact: true, note: null } }] }))
  );
  check(
    'and a nullable field is not mistaken for one of them',
    plant({ ok: true, findings: [{ ...FINDING_SHELL, standard: null, help: null }] }).length === 0,
    short(plant({ ok: true, findings: [{ ...FINDING_SHELL, standard: null, help: null }] }))
  );

  // --- 1. EVERY BRANCH THE ENGINE HAS, WALKED AGAINST THE PUBLISHED SCHEMA.
  const emitted = new Set();
  const answers = [];
  const sweep = async (what, answer) => {
    const wire = onTheWire(answer);
    answers.push([what, wire]);
    keyPathsIn(wire, '', emitted);
    const bad = schemaViolations(wire, published);
    check(`a client could receive the answer for ${what}`, bad.length === 0, short([...new Set(bad)], 500));
    return wire;
  };

  // The one that shipped broken: a component rendered five times, every finding
  // carrying `modelPathMatch`. This single case is what the mcp-audit fixture
  // never rendered, and it is why the check that existed stayed green.
  const repeated = await sweep(
    'a component rendered five times',
    await auditWith({ geometry: overflowGeometry({}) }).run({ route: '/blog', viewports: ['phone'] })
  );
  check(
    '  and it really is the repeated-node shape -- every contrast finding carries the ordinal',
    (repeated.findings || []).filter((f) => f.ruleId === 'color-contrast').every((f) => f.target.modelPathMatch?.of === 5),
    short((repeated.findings || []).filter((f) => f.ruleId === 'color-contrast').map((f) => f.target.modelPathMatch))
  );

  await sweep('a clean page', await auditWith().run({ route: '/', viewports: ['phone'] }));
  await sweep('three default viewports', await auditWith({ geometry: overflowGeometry({}) }).run({ route: '/blog' }));
  await sweep('the 320px reflow width', await auditWith({ geometry: overflowGeometry({}) }).run({ route: '/blog', viewports: ['reflow'] }));
  await sweep('a custom viewport', await auditWith().run({ route: '/', viewports: [{ width: 900, height: 600 }] }));
  await sweep(
    'a rule id the engine does not have',
    await auditWith({ axe: axeAnswer({ unknownRules: ['no-such-rule'] }) }).run({ route: '/blog', viewports: ['phone'], rules: ['color-contrast', 'no-such-rule'] })
  );
  await sweep('no accessibility pass at all', await auditWith({ geometry: overflowGeometry({}) }).run({ route: '/blog', viewports: ['phone'], rules: [] }));
  await sweep(
    'an element inside a shadow root',
    await auditWith({ axe: axeAnswer({ crossBoundary: true }) }).run({ route: '/blog', viewports: ['phone'] })
  );
  await sweep(
    'overflow nothing can be blamed for',
    await auditWith({ geometry: unattributedGeometry }).run({ route: '/blog', viewports: ['phone'] })
  );
  const flooded = await sweep(
    'more findings than the answer can carry',
    await auditWith({ axe: axeAnswer({ rows: 90, incomplete: 30 }), geometry: overflowGeometry({ culprits: 60, truncated: true }) }).run({
      route: '/blog',
      viewports: ['phone', 'tablet', 'desktop'],
    })
  );
  check(
    '  and that one really did overflow the budget, so the truncation branch was walked',
    flooded.truncated === true && flooded.truncation?.omitted > 0,
    short({ truncated: flooded.truncated, truncation: flooded.truncation })
  );
  await sweep('a capture that was asked for', await auditWith().run({ route: '/', viewports: ['desktop'], capture: true }));

  // The refusals. Each is a different top-level shape and every one of them
  // reaches a client, so each has to fit the schema too.
  await sweep('no dev server', await auditWith({ preview: null }).run({ route: '/' }));
  await sweep('a route off this project', await auditWith().run({ route: '//evil.example/x' }));
  await sweep('a viewport name that does not exist', await auditWith().run({ route: '/', viewports: ['enormous'] }));
  await sweep('a session that cannot be wiped', await auditWith({ session: lockedSession }).run({ route: '/', viewports: ['phone'] }));
  await sweep(
    'a page that ended on another origin',
    await auditWith({ url: 'https://evil.example/landed' }).run({ route: '/', viewports: ['phone'] })
  );

  check('every branch produced an answer', answers.length === 16, short(answers.map(([n]) => n)));

  // --- 2. AND THE OTHER DIRECTION: NOTHING DECLARED WENT UNEXERCISED.
  //
  // The walk above only fails on a field it SEES. That is precisely how the
  // second instance shipped, so `target` -- the object the defect was in -- is
  // closed both ways here: every property it declares was emitted by one of the
  // sixteen answers, and (by section 1) nothing emitted is undeclared.
  const targetProps = Object.keys(published.properties.findings.items.properties.target.properties);
  const unexercisedTarget = targetProps.filter((k) => !emitted.has(`/findings[]/target/${k}`));
  check(
    'every property findings[].target declares was actually emitted by the engine',
    unexercisedTarget.length === 0,
    `declared and never produced: ${unexercisedTarget.join(', ')}`
  );
  check(
    '  including both ordinals, which are the two that disambiguate a repeated node',
    emitted.has('/findings[]/target/selectorMatch') && emitted.has('/findings[]/target/modelPathMatch'),
    short([...emitted].filter((p) => p.startsWith('/findings[]/target')))
  );
  // THE ARGUMENT REFUSAL, which is a shape the ENGINE never produces and the
  // TOOL always can. `audit` checks its own arguments rather than letting the
  // host reject them -- that is what stopped it answering a mistyped viewport
  // with a raw protocol sentence -- and the envelope that returns carries
  // `issues`. A field the schema does not declare makes a conformant client
  // throw away the whole answer, so it is walked here like any other branch,
  // and it needs no browser to produce.
  {
    const { registerAuditTool } = require('../electron/mcp/auditTool.js');
    // publishChecked passes the handler as registerTool's THIRD argument, and
    // wraps it in the argument check — so this is the same door a client knocks
    // on, refusal and all, rather than a re-implementation of it.
    let call = null;
    registerAuditTool(
      { registerTool: (_name, _config, handler) => { call = handler; } },
      // `checkAccess` answers null for "allowed", and `audit` is called
      // directly — both are what the positive control below needs to get past
      // the gate and reach a real run rather than stopping at the refusal.
      { audit: async () => ({ ok: true, route: '/audit', findings: [] }), api: { gate: {}, checkAccess: () => null } }
    );
    check('the audit tool registered a handler to refuse with', typeof call === 'function', typeof call);
    if (call) {
      const answer = await call({ route: '/audit', viewports: [{ width: 'wide' }] });
      const wire = onTheWire(answer?.structuredContent || answer);
      keyPathsIn(wire, '', emitted);
      const bad = schemaViolations(wire, published);
      check('a client could receive the argument refusal', bad.length === 0, short([...new Set(bad)], 400));
      check('  and it is the refusal, not a run', wire.ok === false && wire.code === 'bad_arguments', short(wire).slice(0, 200));
      check('  naming the field that was wrong', Array.isArray(wire.issues) && wire.issues.some((i) => (i.path || []).includes('viewports')), short(wire.issues));
      // Positive control: the same door must still accept a well-formed call,
      // or "it refuses" would be true of everything.
      const fine = await call({ route: '/audit', viewports: ['phone'] });
      const okWire = onTheWire(fine?.structuredContent || fine);
      check('  while a well-formed call is not refused as bad_arguments', okWire.code !== 'bad_arguments', short(okWire).slice(0, 160));
    }
  }

  const findingProps = Object.keys(published.properties.findings.items.properties);
  const unexercisedFinding = findingProps.filter((k) => !emitted.has(`/findings[]/${k}`));
  check(
    'every property a finding declares was actually emitted',
    unexercisedFinding.length === 0,
    `declared and never produced: ${unexercisedFinding.join(', ')}`
  );

  // The top level, same question, with the answer pinned rather than asserted
  // empty: four of these are the permission refusal, which auditTool.js writes
  // from the gate and the engine cannot produce, and three need a real browser
  // and are exercised in test/mcp-audit.js. A NEW declared field that nothing
  // here produces lands in this list and fails the check, which is the forcing
  // function: declare a field, exercise it, or say here why it cannot be.
  const ONLY_OUTSIDE_THIS_SUITE = {
    // `operation` and `issues` used to be here. The argument refusal above
    // produces both, so they are exercised rather than excused -- which is the
    // list working as intended: a field leaves it by being driven, not by being
    // argued about.
    risk: 'permission refusal',
    mode: 'permission refusal',
    requires: 'permission refusal',
    status: 'needs a real HTTP response with a 4xx status',
    blockedSubframeOrigins: 'needs a real off-origin iframe to refuse',
    next: 'needs a real image encoder for a capture to be dropped by the byte budget',
  };
  const unexercisedTop = Object.keys(published.properties).filter((k) => !emitted.has(`/${k}`));
  check(
    'the only declared top-level fields this suite cannot produce are the ones it says it cannot',
    unexercisedTop.length === Object.keys(ONLY_OUTSIDE_THIS_SUITE).length &&
      unexercisedTop.every((k) => ONLY_OUTSIDE_THIS_SUITE[k]),
    short({ unexercised: unexercisedTop, expected: Object.keys(ONLY_OUTSIDE_THIS_SUITE) })
  );

  // --- 3. NO WINDOW SURVIVED.
  check('every audit window this suite opened was destroyed', liveWindowCount() === 0, short({ live: liveWindowCount() }));

  if (failures.length) {
    console.error(`audit-schema-conformance: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`audit-schema-conformance: ${checked} passed  [every branch the engine has, against the schema the tool publishes]`);
})().catch((err) => {
  console.error('audit-schema-conformance: threw\n', err?.stack || err);
  process.exit(1);
});
