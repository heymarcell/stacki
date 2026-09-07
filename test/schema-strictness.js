// Every closed object on the wire, proved closed by being sent an unknown key.
//
//   node test/schema-strictness.js
//
// This PR rebuilt every branch of every input schema with `z.strictObject`, so
// a key nobody typed correctly is REFUSED rather than dropped. The evidence
// offered for that is easy to fake and hard to trust: `additionalProperties:
// false` appears N times in the advertised document. That proves a string is
// present in a JSON file. It does not prove a call is refused, it does not
// prove the refusal names the key, and — the half that actually matters on a
// surface with a destructive operation in it — it does not prove the operation
// did not run before the refusal came back.
//
// So nothing here counts anything in a document. The suite:
//
//   DERIVES the closed locations from the shipping schema. Every object
//   position in the delivered JSON Schema of every published tool — top level,
//   each discriminated-union action branch, each `operations[]` entry, a move
//   target, a node spec, a viewport object, a declaration identity, the edit
//   objects inside a batch. A shape added tomorrow is walked without anybody
//   remembering to add it to a list.
//
//   INJECTS an unknown key AT THAT EXACT DEPTH, over a real MCP wire, and
//   requires the call to be refused with Stacki's own `bad_arguments`, the key
//   named, and NOTHING DISPATCHED — observed at the seam, not assumed. The
//   same call without the key is sent every time as the positive control: it
//   must get past the schema and reach the app, otherwise a surface that
//   refused everything would satisfy the whole file.
//
//   PERMITS the containers that are open on purpose. `z.record`, `z.unknown()`
//   and the CMS values whose arbitrary keys ARE the product semantics are
//   listed with a reason each, and each one is sent an unknown key that must be
//   ACCEPTED and must ARRIVE at the app intact. A fix that closed user data
//   would be a regression, and this is what catches it.
//
//   DRIVES EVERY BOUND AT ITS EDGE. A rebuild that only ever refused more
//   would be a nuisance; one that ACCEPTS more is the failure this mechanism
//   must not have. So every `minItems`/`maxItems` the document publishes is
//   sent one item too few and one too many over the wire and must be refused
//   with nothing dispatched, and sent EXACTLY the bound and must reach the app.
//
//   HOLDS THE CLOSED SCHEMA AGAINST THE OPEN ONE. Every node the rebuild
//   replaced remembers what it replaced (`openSourceOf` in agentTools.js), and
//   both halves are converted to the JSON Schema a client is served and
//   required to be identical except for the fence the rebuild exists to add.
//   That is the assertion that catches the whole class rather than the fields
//   that happened to be hurt: a keyword nobody thought to look for cannot go
//   missing quietly. The zod trees are compared a second time, check by check,
//   because a `.refine()` is invisible in JSON Schema.
//
//   AUDITS the rebuild for lost semantics. `closeShape` reconstructs an object
//   from its `.shape`, and anything not carried across is gone. The mechanism
//   is driven with probe schemas that DO use every such construct — a
//   refinement, a bound on an array of objects, a catch, both kinds of default
//   — so what survives and what does not is measured rather than assumed.
//
// WHAT IT FOUND. Three defects, each fixed in electron/mcp/agentTools.js and
// each still asserted here from two independent readings: objects inside a
// `z.record` left open (the `{type, value}` pair in a node's `props`); a nested
// discriminated union demoted to a plain one, so a refusal stopped naming the
// key; and — the only one that WIDENED the surface — every bound on an array of
// objects deleted by the rebuild, twelve advertised keywords at once, so
// `target.edit` accepted an empty batch and `content.write_entry` accepted
// five thousand edits in one undo transaction.

const fs = require('node:fs');
const path = require('node:path');

const { registerTools } = require('../electron/mcp/tools.js');
const A = require('../electron/mcp/agentTools.js');
const { AuditInput } = require('../electron/mcp/auditTool.js');
// The transport's size gate, so the premise it is sized against can be checked
// where that premise is actually declared. See the write_entry block below.
const { MAX_BODY_BYTES } = require('../electron/mcp/server.js');
const { startStrictnessWire } = require('./support/strictnessWire.js');
// The SDK's own JSON Schema validator, so the delivered OUTPUT document is
// graded by the thing a client grades it with rather than by a reading of it.
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');
const { guardSuite } = require('./support/suiteGuard.js');

// A HANG EXITS ZERO, and this suite awaits a wire. Every assertion below is
// downstream of a request somebody has to answer; an await that never settles
// drains the loop, prints nothing, and node reports a pass. See
// test/support/suiteGuard.js, and test/audit-cancel.js, where that happened.
const suiteDone = guardSuite('schema-strictness', 300000);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 300) => JSON.stringify(v ?? null).slice(0, n);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The key nobody's schema knows. Distinctive so a message can be searched. */
const UNKNOWN_KEY = 'stackiUnknownKey';
/** The key used to stand in a record where any key is legal. */
const RECORD_KEY = 'stackiRecordProbe';

// ── the surface, composed the way the product composes it ────────────────────
//
// `registerTools` is the function electron/mcp/server.js calls, given exactly
// what electron/mcp/index.js gives it. Reading the schemas from here rather
// than from a rig's idea of the surface is what stops this suite grading a
// thirteen-tool server nobody has — the mistake test/schema-dispatch-contract.js
// records at PRODUCT_TOOLS, made once already on this branch.
function composed() {
  const tools = new Map();
  const recorder = {
    registerTool: (name, config, handler) => {
      tools.set(name, { name, config, handler });
      return { name };
    },
    registerResource: () => ({}),
    registerPrompt: () => ({}),
  };
  registerTools(recorder, {
    getContext: async () => ({}),
    capture: async () => ({}),
    getComments: async () => ({}),
    comment: async () => ({}),
    api: { run: async () => ({}), capabilities: () => ({}), checkAccess: () => null },
    audit: async () => ({}),
  });
  return tools;
}

// ── reading the delivered document ───────────────────────────────────────────

const STRUCTURAL = ['type', 'properties', 'required', 'items', 'oneOf', 'anyOf', 'allOf', 'enum', 'const', 'additionalProperties', 'propertyNames', 'prefixItems', '$ref', 'not'];
const branchesOf = (n) => (Array.isArray(n?.oneOf) ? n.oneOf : Array.isArray(n?.anyOf) ? n.anyOf : null);

/**
 * What kind of place in the document this is.
 *
 *   closed      an object that refuses what it does not know.
 *   record      an object whose KEYS are the caller's to choose (`z.record`).
 *   any         a value with no shape at all (`z.unknown()`).
 *   openObject  an object with declared properties and no fence — the defect.
 *
 * Derived from the document rather than from a list, because the whole point
 * is that a shape added tomorrow lands in one of these four buckets on its own.
 */
function kindOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (!STRUCTURAL.some((k) => k in node)) return 'any';
  // A UNION IS NOT A PLACE, IT IS A CHOICE OF PLACES. The eight domain
  // schemas arrive as `{type:'object', oneOf:[…], properties:{…}}` — the
  // `type` is the SDK's, the `properties` is `summarised()`'s top-level index
  // of every branch's arguments, and neither is an object a key can be sent
  // to. Reading the wrapper as an unfenced object made all eight of them look
  // like holes; the branches underneath are the real positions.
  if (branchesOf(node)) return null;
  if (node.type !== 'object') return null;
  if (node.additionalProperties === false) return 'closed';
  if (node.properties) return 'openObject';
  return 'record';
}

/**
 * Every object position in one tool's delivered schema.
 *
 * `route` is how to get there — a branch to take, a property to descend, an
 * array element, a record value — and is what lets the builder below place a
 * key at exactly that depth rather than near it.
 */
function locationsIn(toolName, json) {
  const out = [];
  const walk = (node, route, label) => {
    if (!node || typeof node !== 'object') return;
    const kind = kindOf(node);
    if (kind) out.push({ tool: toolName, kind, route, label, node });
    const branches = branchesOf(node);
    if (branches) {
      branches.forEach((b, i) => walk(b, [...route, { k: 'branch', i }], `${label}|${i}`));
      return;
    }
    if (node.type === 'object' && node.properties) {
      for (const [name, sub] of Object.entries(node.properties)) walk(sub, [...route, { k: 'prop', name }], `${label}.${name}`);
    }
    if (node.type === 'array' && node.items) walk(node.items, [...route, { k: 'item' }], `${label}[]`);
    if (node.type === 'object' && node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, [...route, { k: 'value' }], `${label}{*}`);
    }
  };
  walk(json, [], toolName);
  return out;
}

/**
 * Every ARRAY position that publishes a bound, with the route to it.
 *
 * A separate walk from `locationsIn` because an array is not one of its four
 * kinds — `kindOf` returns null for it — so the sweep that proves keys are
 * refused walked straight past the twelve keywords that went missing. Derived
 * the same way and for the same reason: a bound added tomorrow is driven at its
 * edge without anybody adding a row to a list.
 */
function boundedArraysIn(toolName, json) {
  const out = [];
  const walk = (node, route, label) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'array' && (node.minItems !== undefined || node.maxItems !== undefined)) {
      out.push({ tool: toolName, route, label, node, min: node.minItems, max: node.maxItems });
    }
    const branches = branchesOf(node);
    if (branches) {
      branches.forEach((b, i) => walk(b, [...route, { k: 'branch', i }], `${label}|${i}`));
      return;
    }
    if (node.type === 'object' && node.properties) {
      for (const [name, sub] of Object.entries(node.properties)) walk(sub, [...route, { k: 'prop', name }], `${label}.${name}`);
    }
    if (node.type === 'array' && node.items) walk(node.items, [...route, { k: 'item' }], `${label}[]`);
    if (node.type === 'object' && node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, [...route, { k: 'value' }], `${label}{*}`);
    }
  };
  walk(json, [], toolName);
  return out;
}

/**
 * Put a value at the end of a route inside an already-built call.
 *
 * The builder below constructs a call that is valid everywhere; this replaces
 * exactly one array in it with one of a chosen length, so the ONLY thing wrong
 * with a refused call is its size. Branch steps are dropped because a built
 * value has already taken its branch, and an array step lands on element 0
 * because that is the element the builder filled in.
 */
function place(root, route, items) {
  const steps = route.filter((s) => s.k !== 'branch');
  let cur = root;
  for (const step of steps.slice(0, -1)) cur = step.k === 'prop' ? cur[step.name] : step.k === 'item' ? cur[0] : cur[RECORD_KEY];
  const last = steps[steps.length - 1];
  if (last.k === 'prop') cur[last.name] = items;
  else if (last.k === 'item') cur[0] = items;
  else cur[RECORD_KEY] = items;
  return root;
}

/** The property path a refusal should name, read off the same route. */
const pathOf = (route) =>
  route
    .filter((s) => s.k !== 'branch')
    .map((s) => (s.k === 'prop' ? s.name : s.k === 'item' ? 0 : RECORD_KEY));

/**
 * The name of a location with the incidentals removed — which branch it was
 * reached through, and which element of an array it landed in. What is left is
 * the SHAPE, so the same shape reached six different ways is justified once.
 */
const canonical = (loc) =>
  `${loc.tool}:${loc.route
    .filter((s) => s.k !== 'branch' && s.k !== 'item')
    .map((s) => (s.k === 'prop' ? s.name : '*'))
    .join('.')}`;

// ── building a call that is wrong in exactly one place ───────────────────────
//
// Every value the builder invents satisfies the constraint declared for it, so
// the ONLY thing wrong with an injected call is the key. Without that, a
// refusal proves nothing: "this call was rejected" and "this call was rejected
// BECAUSE of the unknown key" are different facts, and only the second one is
// about strictness.

function value(node, route, inject) {
  if (!node || typeof node !== 'object') return null;
  const step = route[0];
  const rest = route.slice(1);
  const here = route.length === 0;

  const branches = branchesOf(node);
  if (branches) {
    const i = step?.k === 'branch' ? step.i : 0;
    return value(branches[i], step?.k === 'branch' ? rest : route, inject);
  }
  if ('const' in node) return node.const;
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];

  const kind = kindOf(node);
  if (kind === 'any') return here && inject ? { [UNKNOWN_KEY]: 1 } : 'stacki-any';
  if (kind === 'record') {
    const inner = typeof node.additionalProperties === 'object' ? node.additionalProperties : {};
    if (step?.k === 'value') return { [RECORD_KEY]: value(inner, rest, inject) };
    if (here && inject) return { [UNKNOWN_KEY]: value(inner, [], false) };
    return {};
  }
  if (node.type === 'object') {
    const out = {};
    for (const name of node.required || []) out[name] = value(node.properties?.[name], [], false);
    if (step?.k === 'prop') out[step.name] = value(node.properties?.[step.name], rest, inject);
    if (here && inject) out[UNKNOWN_KEY] = 1;
    return out;
  }
  if (node.type === 'array') {
    const wanted = Math.max(node.minItems || 0, step?.k === 'item' ? 1 : 0);
    const items = [];
    for (let i = 0; i < wanted; i += 1) items.push(value(node.items, i === 0 && step?.k === 'item' ? rest : [], i === 0 && step?.k === 'item' ? inject : false));
    return items;
  }
  if (node.type === 'string') {
    const min = Math.max(node.minLength || 1, 1);
    return 'x'.repeat(node.maxLength ? Math.min(min, node.maxLength) : min);
  }
  if (node.type === 'integer' || node.type === 'number') {
    let n = typeof node.minimum === 'number' && node.minimum > 0 ? node.minimum : 0;
    if (typeof node.maximum === 'number' && n > node.maximum) n = node.maximum;
    return n;
  }
  if (node.type === 'boolean') return false;
  return null;
}

/**
 * What a call needs BEYOND its required arguments to reach the app.
 *
 * Two handler-level checks stand between a schema that accepted a call and the
 * implementation, and both are deliberate and documented where they live. The
 * positive control has to get past them or it proves nothing, so they are named
 * here rather than worked around by weakening the assertion.
 */
const EXTRA_TO_DISPATCH = {
  // `text` is optional in the schema ONLY so that `value` can be accepted as
  // its wire alias; a call with neither is refused by the handler with a
  // sentence naming both. See `domain()` in electron/mcp/agentTools.js.
  'target:set_text': { text: 'x' },
  // AND THE SAME OPERATION INSIDE AN EDIT BATCH, which is refused by the same
  // handler check for the same reason: `{type:"set_text"}` with neither
  // spelling used to be ACCEPTED in the batch form while the action form was
  // refused, and it reached the app as a set_text with no text — an element
  // whose words were replaced with the empty string on an `ok:true`.
  //
  // A FUNCTION, because this argument is not at the top level. The generic
  // builder mints operations from the schema's REQUIRED fields alone, so it
  // produces a bare `{type:"set_text"}`; the value has to be added inside each
  // operation without disturbing anything else the case put there — the
  // injected unknown key of a strictness probe, or the other 29 operations of a
  // bound probe.
  'target:edit': (args) => ({
    operations: (args?.operations || []).map((op) =>
      op && op.type === 'set_text' && typeof op.value !== 'string' && typeof op.text !== 'string' ? { ...op, value: 'x' } : op
    ),
  }),
  // `create` needs something written in it: reviewTools.js `requirementProblem`
  // refuses an empty comment before the review ledger is touched.
  comment: { message: 'x' },
};

const extraFor = (tool, args) => {
  const entry = EXTRA_TO_DISPATCH[`${tool}:${args?.action}`] || EXTRA_TO_DISPATCH[tool] || {};
  return typeof entry === 'function' ? entry(args) : entry;
};

// ── what the app is allowed to add on the way through ────────────────────────
//
// The control call is also the no-transform oracle: every key sent must arrive
// at the app with the value it was sent, and every key that arrives unsent must
// be a schema-declared default or one of these. A `.transform()` or a
// `.preprocess()` anywhere on the surface shows up here as a value that changed
// shape between the wire and the seam, on real arguments rather than by
// inspection.
const ADDED_BY_THE_HANDLER = {
  // reviewTools.js labels an agent's messages with the name it gave at
  // initialize. A label, never a permission.
  comment: ['client'],
};
// The eight domain tools dispatch as `api.run(domain, action, rest)`, so the
// discriminator is consumed on the way rather than forwarded. True of every
// tool that takes one, which is why it is not a per-tool row.
const DISCRIMINATOR = 'action';

/** The defaults the delivered document declares, by property name. */
const declaredDefaults = (json) => {
  const out = {};
  for (const [name, spec] of Object.entries(json?.properties || {})) if (spec && 'default' in spec) out[name] = spec.default;
  return out;
};

(async () => {
  const tools = composed();
  const wire = await startStrictnessWire({ era: 'modern' });
  const problems = [];
  // The OUTPUT half of the delivered document, kept for the refusal-branch
  // block near the foot of this file. Read off the wire for the same reason the
  // input half is: what a client validates against is what the transport sent,
  // not what a converter run here would have produced.
  const deliveredOutput = new Map();
  try {
    const listed = await wire.client.listTools();

    // ── this wire is the product's surface, not a subset of it ───────────────
    check('the product composes fourteen tools', tools.size === 14, [...tools.keys()].join(', '));
    check(
      'and this wire publishes exactly those, so every injection below lands on the real surface',
      same([...tools.keys()], listed.tools.map((t) => t.name)),
      `product: ${[...tools.keys()].join(', ')}\n    wire: ${listed.tools.map((t) => t.name).join(', ')}`
    );

    // The document a client is actually handed. Read off the wire rather than
    // recomputed here, so the schema this suite injects into is byte-for-byte
    // the one a validating client would refuse the call against.
    const delivered = new Map(listed.tools.map((t) => [t.name, t.inputSchema]));
    for (const t of listed.tools) if (t.outputSchema) deliveredOutput.set(t.name, t.outputSchema);
    // The two readings held equal. `$schema` and a top-level `type` are added
    // by the transport on the way out and are not the schema's own; everything
    // that decides whether a call is accepted has to be identical, or this
    // suite is injecting into a document nobody is served.
    const body = (json) => {
      const { $schema, type, ...rest } = json || {};
      return JSON.stringify(rest);
    };
    for (const [name, entry] of tools) {
      const local = entry.config.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
      check(
        `${name}'s advertised input schema is the same in this process as on the wire`,
        body(local) === body(delivered.get(name)),
        `${short(body(local), 200)}\n    ${short(body(delivered.get(name)), 200)}`
      );
    }

    // ── every object position, derived ───────────────────────────────────────
    const all = [];
    for (const [name] of tools) all.push(...locationsIn(name, delivered.get(name)));
    const byKind = (k) => all.filter((l) => l.kind === k);

    // NAMED HERE BECAUSE IT IS A DECISION, not an observation. Every one of
    // these numbers is what the sweep below is measured against; a change to
    // any of them is somebody adding or removing a shape on the public input
    // surface, and it should have to be written down.
    check('the input surface has 158 closed object positions', byKind('closed').length === 158, String(byKind('closed').length));
    check('  9 record positions, where the caller chooses the keys', byKind('record').length === 9, String(byKind('record').length));
    check('  6 shapeless values, where the caller chooses everything', byKind('any').length === 6, String(byKind('any').length));
    check('  and no object with a shape and no fence', byKind('openObject').length === 0, byKind('openObject').map((l) => l.label).join(', '));
    check('the closed positions are most of the surface', byKind('closed').length > all.length * 0.85, `${byKind('closed').length} of ${all.length}`);

    // Depth is the thing this suite exists to test, so it is asserted rather
    // than hoped for: a walker that stopped at the top level would find one
    // object per tool and nothing else.
    const depths = byKind('closed').map((l) => l.route.filter((s) => s.k !== 'branch').length);
    check('the closed positions are not all at the top level', Math.max(...depths) >= 3, `deepest is ${Math.max(...depths)} properties down`);
    check('  and there are nested ones in quantity', depths.filter((d) => d > 0).length >= 30, `${depths.filter((d) => d > 0).length} of ${depths.length} are below the top level`);

    // ── WHERE THE SURFACE CANNOT NAME THE KEY ────────────────────────────────
    //
    // A refusal that says "something in there is wrong" is most of an answer.
    // Everywhere else on this surface the refusal names the key, and a client
    // can fix its own call; in two places it cannot, and they are not the same
    // kind of thing.
    //
    // INHERENT. `audit`'s `viewports` accepts a NAME or a `{width,height}`
    // pair. When neither half matches, "no branch of this union matched" is the
    // only honest report — zod cannot know which one was meant.
    //
    // A DEFECT, AND THE SECOND ONE THIS SUITE FOUND. Everything inside
    // `target.edit`'s `operations` used to name the key and no longer does,
    // because `closeField` demotes a DISCRIMINATED union to a plain one:
    //
    //   if (def.type === 'union' && Array.isArray(def.options)) {
    //     const rebuilt = def.options.map(closeField);
    //     ...
    //     return withDescription(z.union(rebuilt), field);   // <- the discriminator
    //   }
    //
    // A discriminated union in zod 4 IS a union with a `discriminator` on its
    // def, so the nested `Operation` union matches that branch, every option is
    // rebuilt (each is an object, so each comes back a new instance), and what
    // is put back is `z.union` — thirteen branches tried in turn, and an error
    // that is `invalid_union` with thirteen sub-errors buried in `errors[]`,
    // none of which `issuesOf()` reads. What an agent receives is
    //
    //   target.edit could not run — operations.0: Invalid input.
    //
    // which is the one shape in this surface an agent cannot act on — the exact
    // thing `advertised()` and `badArguments()` were written to remove,
    // reproduced one level down by the fix for the level above.
    //
    // THE FIX, in electron/mcp/agentTools.js `closeField`:
    //
    //   return withDescription(
    //     def.discriminator ? z.discriminatedUnion(def.discriminator, rebuilt) : z.union(rebuilt),
    //     field
    //   );
    //
    // Measured with that applied: `operations.0: Unrecognized key: "bogus"`.
    // When it lands, delete the second entry below — the sweep already requires
    // every other position to name the key, so those positions join it with no
    // other edit.
    const CANNOT_NAME_THE_KEY = [
      { why: 'a union of a viewport NAME and a {width,height} pair: neither half matched, and zod cannot know which was meant', is: (l) => l.label.startsWith('audit.viewports[]') },
      // The same inherent shape one level down, and the reason it is inherent
      // rather than a defect: a prop VALUE is either a plain string or a
      // `{type, value}` pair, so an unknown key inside the pair fails BOTH
      // halves and `invalid_union` is the honest answer -- zod cannot know
      // which half was meant. It is refused, with the path naming the prop,
      // which is what the caller acts on; only the key itself is unnamed.
      // This row REPLACED the batch-operation row, which was a real defect:
      // closeField rebuilt a discriminated union as a plain one and lost the
      // discriminator. That is fixed, and every operations[] position now
      // names its key under the sweep's ordinary rule.
      { why: 'a union of a bare string and a {type,value} pair: neither half matched, so no single key can be blamed', is: (l) => /\.props\{\*\}\|1$/.test(l.label) },
    ];
    const cannotName = (loc) => CANNOT_NAME_THE_KEY.find((e) => e.is(loc)) || null;

    // ── THE SWEEP ────────────────────────────────────────────────────────────
    const exercised = new Set();
    let named = 0;
    let unnameable = 0;
    for (const loc of byKind('closed')) {
      const json = delivered.get(loc.tool);
      const clean = value(json, loc.route, false);
      const dirty = value(json, loc.route, true);
      const extra = extraFor(loc.tool, clean);
      // COMPUTED AGAIN FOR THE DIRTY CALL, because an extra may now be a
      // FUNCTION of the arguments -- `target:edit` fills in the one operation
      // whose required fields alone do not reach the app. Derived from `clean`
      // once and spread over both, such an extra replaces `dirty`'s injected
      // operation with a clean one: measured the first time this entry was
      // added, thirteen operations positions answered `ok:true` because the
      // unknown key they were supposed to be injecting had been overwritten
      // before the call was made. Nothing changes for the object-valued
      // entries, which do not depend on the arguments at all.
      const dirtyExtra = extraFor(loc.tool, dirty);
      const where = `${loc.label} (${pathOf(loc.route).join('.') || 'top level'})`;

      // (1) THE CONTROL. The same call, spelled right, must get past the schema
      // and reach the app. Without this the injection below is satisfied by a
      // surface that refuses everything.
      const control = await wire.call(loc.tool, { ...clean, ...extra });
      const passed = check(
        `${where}: the same call without the key gets past the schema`,
        control.envelope?.code !== 'bad_arguments',
        short({ sent: { ...clean, ...extra }, code: control.envelope?.code, message: control.envelope?.message })
      );
      check(`  ${where}: and reaches the app`, control.dispatched > 0, short({ dispatched: control.dispatched, envelope: control.envelope }));

      // AND ARRIVES UNCHANGED. Every key sent is at the seam with the value it
      // was sent; every key at the seam that was not sent is a declared default
      // or one of the two documented additions. This is the transform oracle.
      if (passed && control.handedOver.length) {
        const sent = { ...clean, ...extra };
        const got = control.handedOver.at(-1)?.args ?? {};
        const allowed = new Set([DISCRIMINATOR, ...(ADDED_BY_THE_HANDLER[loc.tool] || []), ...Object.keys(declaredDefaults(json))]);
        const changed = Object.keys(sent).filter((k) => !allowed.has(k) && JSON.stringify(got?.[k]) !== JSON.stringify(sent[k]));
        const invented = Object.keys(got || {}).filter((k) => !(k in sent) && !allowed.has(k));
        check(`  ${where}: nothing the caller sent was transformed on the way`, changed.length === 0, changed.length ? `${changed.join(', ')}\n    sent ${short(sent, 200)}\n    got  ${short(got, 200)}` : '');
        check(`  ${where}: and nothing undeclared was invented`, invented.length === 0, invented.length ? `${invented.join(', ')} in ${short(got, 200)}` : '');
      }

      // (2) THE INJECTION, at exactly this depth.
      const res = await wire.call(loc.tool, { ...dirty, ...dirtyExtra });
      exercised.add(loc.label);
      check(`${where}: an unknown key here is refused`, res.envelope?.ok === false, short(res.envelope));
      check(
        `  ${where}: as bad_arguments — the SCHEMA stopped it`,
        res.envelope?.code === 'bad_arguments',
        short({ code: res.envelope?.code, message: res.envelope?.message })
      );
      // THE HALF THAT MATTERS. A refusal that arrives after the work is not a
      // refusal, and this surface has a destructive operation in every domain.
      check(`  ${where}: and NOTHING was dispatched`, res.dispatched === 0, short(res.handedOver));

      // The key, named — which is what makes a refusal something an agent can
      // act on rather than something it has to guess past. The two places that
      // cannot are registered above with a reason each, and both directions are
      // asserted: a registered position must still fail to name it, so a fix
      // that lands is noticed rather than absorbed.
      const issues = res.envelope?.issues || [];
      const namesIt = issues.some((i) => String(i.message || '').includes(UNKNOWN_KEY)) || String(res.envelope?.message || '').includes(UNKNOWN_KEY);
      const excused = cannotName(loc);
      if (excused) {
        unnameable += 1;
        // It must still say WHERE. An unnameable refusal that also pointed at
        // nothing would leave an agent with no move at all; what it reports is
        // an ancestor of the position the key was sent to.
        const wanted = pathOf(loc.route);
        const prefixes = issues.some((i) => (i.path || []).every((seg, n) => JSON.stringify(seg) === JSON.stringify(wanted[n])));
        check(`  ${where}: still says WHERE, even though it cannot say WHICH — ${excused.why}`, prefixes && issues.length > 0, `sent at ${short(wanted)}, reported at ${short(issues.map((i) => i.path))}`);
        check(`  ${where}: and it really cannot name it — if this went red the fix landed, so delete its row from CANNOT_NAME_THE_KEY`, !namesIt, short(issues));
      } else {
        named += 1;
        check(`  ${where}: naming the key that was not recognised`, namesIt, short(issues));
        check(
          `  ${where}: at the depth it was sent at`,
          issues.some((i) => JSON.stringify(i.path || []) === JSON.stringify(pathOf(loc.route))),
          `expected ${short(pathOf(loc.route))}, got ${short(issues.map((i) => i.path))}`
        );
      }
    }

    // ── COMPLETENESS ─────────────────────────────────────────────────────────
    //
    // Not "the sweep passed" but "the sweep covered everything the walk found".
    // A location quietly dropped from the derived list is the failure mode this
    // catches, and it is the only thing standing between a derived oracle and a
    // hand-written one that forgot a shape.
    check(
      'every closed position the walk found was actually injected into',
      exercised.size === byKind('closed').length,
      `${exercised.size} exercised, ${byKind('closed').length} derived: missing ${byKind('closed').map((l) => l.label).filter((l) => !exercised.has(l)).join(', ') || 'none'}`
    );
    check(
      '  and every one of them either named the key or is a registered exception',
      named === 151 && unnameable === 7,
      `${named} named the key, ${unnameable} could not: ${byKind('closed').filter(cannotName).map((l) => l.label).join(', ')}`
    );

    // ── OPEN ON PURPOSE, AND STAYING OPEN ────────────────────────────────────
    //
    // These are not oversights. Each is a place where the KEYS are the
    // product's data — a frontmatter field an author invented, an attribute
    // name, a project-relative path — and closing one would refuse a document
    // Stacki itself wrote. The reason is written beside each so that a later
    // sweep for "additionalProperties: false" cannot mistake them for misses,
    // and each is sent an unknown key that must be ACCEPTED and DELIVERED.
    const OPEN_BY_DESIGN = [
      { tool: 'target', ends: 'node.props', why: 'an element’s attributes: the keys are HTML attribute and component prop names the author chooses.' },
      { tool: 'content', ends: 'fields', why: 'frontmatter fields: the keys are the collection’s own schema, defined in the project and not here.' },
      { tool: 'content', ends: 'fields.*', why: 'and their values are whatever that collection declares — a string, a date, a nested object.' },
      { tool: 'content', ends: 'entry', why: 'an entry object handed straight back from a read, accepted as a selector; its keys are the collection’s.' },
      { tool: 'content', ends: 'entry.*', why: 'and its values are the entry’s own data, which Stacki wrote and must be able to read back.' },
      { tool: 'content', ends: 'data', why: 'a whole CMS document. Its shape is the project’s content schema; declaring one here would be a second copy of it.' },
      { tool: 'content', ends: 'edits.value', why: 'the new value for one field, which is whatever that field holds.' },
      { tool: 'git', ends: 'choices', why: 'a merge resolution keyed by project-relative path: the keys are the conflicting files git named.' },
      { tool: 'git', ends: 'choices.*', why: '"ours", "theirs", or one entry per hunk — a scalar or a list, per file.' },
    ];
    const openLocations = [...byKind('record'), ...byKind('any')];
    const matched = new Map(OPEN_BY_DESIGN.map((e) => [`${e.tool}:${e.ends}`, 0]));
    for (const loc of openLocations) {
      const suffix = canonical(loc).split(':')[1];
      const hits = OPEN_BY_DESIGN.filter((e) => e.tool === loc.tool && suffix.endsWith(e.ends));
      if (!check(`${loc.label} is open, and exactly one justification covers it`, hits.length === 1, `${hits.length} justifications matched ${canonical(loc)}`)) continue;
      matched.set(`${hits[0].tool}:${hits[0].ends}`, matched.get(`${hits[0].tool}:${hits[0].ends}`) + 1);

      const json = delivered.get(loc.tool);
      const dirty = value(json, loc.route, true);
      const extra = extraFor(loc.tool, dirty);
      const res = await wire.call(loc.tool, { ...dirty, ...extra });
      check(`  ${loc.label}: an unknown key here is ACCEPTED — ${hits[0].why}`, res.envelope?.code !== 'bad_arguments', short({ sent: dirty, code: res.envelope?.code, message: res.envelope?.message }));
      check(`  ${loc.label}: and reaches the app`, res.dispatched > 0, short(res.envelope));
      // NOT MERELY ACCEPTED — DELIVERED. A schema that accepted the key and
      // then stripped it would pass the line above and lose the user's data,
      // which is the exact failure closing an object causes.
      check(
        `  ${loc.label}: with the caller's key still in it`,
        JSON.stringify(res.handedOver.at(-1)?.args ?? {}).includes(UNKNOWN_KEY),
        short(res.handedOver.at(-1)?.args, 400)
      );
    }
    for (const [key, hits] of matched) {
      check(`the justification for ${key} still describes something that exists`, hits > 0, 'nothing on the surface matched it — either it was closed, or it was renamed');
    }

    // ── STILL OPEN, AND NOT USER DATA ────────────────────────────────────────
    //
    // THE ONE HOLE THIS SUITE FOUND. `props` is a record — its keys are the
    // author's, correctly — but its VALUES may be `{type: "string"|"expr",
    // value}`, and that object is an ordinary declared shape an agent has to
    // construct. `closeField` never reaches it: a `z.record` holds its inner
    // type under `valueType`, and the wrapper walk looks for `innerType` and
    // `element` only, so it returns the record untouched and everything inside
    // it stays as `z.object` — which STRIPS.
    //
    // Measured: target.insert_before with
    //   node.props.x = {type:'string', value:'v', bogus:1}
    // is accepted, `bogus` is dropped, and the insert runs.
    //
    // THE FIX, in electron/mcp/agentTools.js `closeField`, beside the union
    // branch that is there for the same reason:
    //
    //   if (def.type === 'record') {
    //     const closedValue = closeField(def.valueType);
    //     if (closedValue === def.valueType) return field;
    //     return withDescription(z.record(def.keyType, closedValue), field);
    //   }
    //
    // That closes the six positions below and leaves the record's KEYS open,
    // which is the half that is deliberate. When it lands, delete this block:
    // the walk above already classifies those positions as `closed` and sweeps
    // them, so nothing else here needs editing.
    // ── A KEY BELONGING TO ANOTHER BRANCH, NOT MERELY A NONSENSE ONE ─────────
    //
    // Everything above injects a key no schema has anywhere, which is the
    // clean experiment. The mistake an agent actually makes is different and
    // worse: a key that IS real, on another action, whose value would be acted
    // on if the branch had stayed open. Written out by name because these
    // specific misdirections are the point.
    const CROSSED = [
      ['git', { action: 'push', branchName: 'feature-x' }, 'branchName', 'pushes the CURRENT branch instead of the named one'],
      ['git', { action: 'restore_file', path: 'src/pages/index.astro', rev: 'abc123' }, 'rev', 'restores from HEAD instead of the named revision'],
      ['target', { action: 'remove', target: 'refrefrefrefrefref' }, 'target', 'removes the person’s live SELECTION instead of the ref'],
      ['project', { action: 'probe', route: '/pricing' }, 'route', 'probes the preview root instead of the named route'],
      ['audit', { rout: '/pricing' }, 'rout', 'audits the site root and reports findings about a page nobody asked about'],
      ['get_comments', { scop: 'selection' }, 'scop', 'widens a read of one element’s reviews to the whole project'],
      // `value` is `set_text`'s argument, sent on an `add_class`. Refused —
      // but the message can only say `operations.0`, for the discriminator
      // reason registered above, so that is what is asserted rather than the
      // key. It is the one row here whose refusal an agent cannot act on.
      ['target', { action: 'edit', ref: 'refrefrefrefrefref', operations: [{ type: 'add_class', className: 'x', value: 'belongs to set_text' }] }, 'operations.0', 'adds the class and silently ignores the text the caller meant to set'],
    ];
    for (const [tool, args, key, wouldHave] of CROSSED) {
      const res = await wire.call(tool, args);
      check(`${tool} with a key that belongs elsewhere is refused (else it ${wouldHave})`, res.envelope?.code === 'bad_arguments', short(res.envelope));
      check(`  ${tool}: saying ${key}`, String(res.envelope?.message || '').includes(key), short(res.envelope?.message));
      check(`  ${tool}: and nothing dispatched`, res.dispatched === 0, short(res.handedOver));
    }

    // ── EVERY PUBLISHED BOUND, DRIVEN AT ITS EDGE ────────────────────────────
    //
    // THE THIRD DEFECT THIS SUITE FOUND, and the only one so far that WIDENED
    // what the surface accepts. Everything above is about a key being refused;
    // this is about a call that should have been refused and was not.
    //
    // `closeField`'s array branch was `return z.array(closedInner)`. In zod 4 a
    // bound is a CHECK on the wrapper, not part of the type, so rebuilding the
    // wrapper deleted it — and because `Operation` is a discriminated union the
    // element always came back a new instance, so the rebuild always fired.
    // Twelve advertised keywords went missing at once, `minItems`/`maxItems`
    // vanished from the document a validating client refuses against, and
    // `target.edit` accepted 0 operations and 40 of them. Five of the six had
    // no downstream guard: five thousand variable renames in one undo
    // transaction was a schema-legal call. Twelve keywords across seven fields,
    // `audit.viewports` included -- the seventh was found by the invariance
    // check below rather than by anybody predicting it.
    //
    // So each bound is driven at both sides of its edge, over the wire, with
    // the positive control ON the boundary — a refusal at max+1 proves nothing
    // if max itself is refused too, and a suite that only checked max+1 would
    // pass against a schema that refused every array.
    const bounded = [];
    for (const [name] of tools) bounded.push(...boundedArraysIn(name, delivered.get(name)));
    check('the input surface publishes 17 bounded arrays', bounded.length === 17, `${bounded.length}: ${bounded.map((b) => `${b.label} ${b.min ?? ''}..${b.max ?? ''}`).join(', ')}`);
    check(
      '  including the six the rebuild had emptied',
      ['target|4.operations', 'style|4.declarations', 'style|9.adds', 'style|10.renames', 'style|11.moves', 'content|11.edits'].every((l) => bounded.some((b) => b.label === l)),
      bounded.map((b) => b.label).join(', ')
    );

    for (const loc of bounded) {
      const json = delivered.get(loc.tool);
      const sized = (n) => {
        const call = place(value(json, loc.route, false), loc.route, Array.from({ length: n }, () => value(loc.node.items, [], false)));
        return { ...call, ...extraFor(loc.tool, call) };
      };
      const where = `${loc.label} (${pathOf(loc.route).join('.')})`;
      const reportsHere = (res, code) =>
        (res.envelope?.issues || []).some((i) => JSON.stringify(i.path || []) === JSON.stringify(pathOf(loc.route)) && i.code === code);

      // TOO FEW. Only where the schema says there is a floor; `min` of 1 is
      // "this operation has to do something", and it is the one bound that had
      // a partner guard in the handler — which is exactly why losing it went
      // unnoticed for the other five.
      if (loc.min > 0) {
        const under = await wire.call(loc.tool, sized(loc.min - 1));
        check(`${where}: ${loc.min - 1} items is refused, the floor is ${loc.min}`, under.envelope?.code === 'bad_arguments', short(under.envelope));
        check(`  ${where}: naming the array and saying it is too small`, reportsHere(under, 'too_small'), short(under.envelope?.issues));
        check(`  ${where}: and NOTHING was dispatched`, under.dispatched === 0, short(under.handedOver));

        const atFloor = await wire.call(loc.tool, sized(loc.min));
        check(`  ${where}: and exactly ${loc.min} is ACCEPTED — the control that stops "refuses everything" passing`, atFloor.envelope?.code !== 'bad_arguments', short(atFloor.envelope));
        check(`  ${where}: reaching the app`, atFloor.dispatched > 0, short(atFloor.envelope));
      }

      // TOO MANY. The half with teeth: `content.write_entry` at 501 edits and
      // `style.rename_variables` at 101 are single calls that land in a single
      // undo transaction.
      if (loc.max !== undefined) {
        const over = await wire.call(loc.tool, sized(loc.max + 1));
        check(`${where}: ${loc.max + 1} items is refused, the ceiling is ${loc.max}`, over.envelope?.code === 'bad_arguments', short(over.envelope));
        check(`  ${where}: naming the array and saying it is too big`, reportsHere(over, 'too_big'), short(over.envelope?.issues));
        check(`  ${where}: and NOTHING was dispatched`, over.dispatched === 0, short(over.handedOver));

        const atCeiling = await wire.call(loc.tool, sized(loc.max));
        check(`  ${where}: and exactly ${loc.max} is ACCEPTED`, atCeiling.envelope?.code !== 'bad_arguments', short(atCeiling.envelope));
        check(`  ${where}: reaching the app`, atCeiling.dispatched > 0, short(atCeiling.envelope));
      }
    }

    // ── THE ONE ARGUMENT WITH TWO NAMES, AND ONE PRECEDENCE ──────────────────
    //
    // `set_text` takes `text` as an action and `value` inside an `edit` batch,
    // and the wire accepts both spellings in both forms so an agent reading two
    // schemas side by side cannot lose a call to the difference. Accepting two
    // names means deciding which wins when BOTH arrive, and the two branches of
    // `normalise` decided it opposite ways: the action preferred `text`, the
    // batch preferred `value`. So one pair of arguments wrote two different
    // words into the same element depending on the shape the caller happened to
    // reach for, and both answered ok.
    //
    // The oracle is not the envelope — both shapes succeed either way. It is
    // WHAT REACHED THE APP, read at the dispatch seam, which is the only place
    // the two forms can be compared with each other.
    {
      const REF = 'refrefrefrefrefref';
      const single = await wire.call('target', { action: 'set_text', ref: REF, text: 'FROM TEXT', value: 'FROM VALUE' });
      check('set_text with both spellings dispatches', single.dispatched === 1, short(single.envelope));
      const singleArgs = single.handedOver[0]?.args || {};
      check('  the action form takes `text`', singleArgs.text === 'FROM TEXT', short(singleArgs));
      check('  and does not carry the loser through', !('value' in singleArgs), short(singleArgs));

      const batch = await wire.call('target', {
        action: 'edit',
        ref: REF,
        operations: [{ type: 'set_text', text: 'FROM TEXT', value: 'FROM VALUE' }],
      });
      check('the same pair inside an edit batch dispatches too', batch.dispatched === 1, short(batch.envelope));
      const op = (batch.handedOver[0]?.args?.operations || [])[0] || {};
      check('  THE BATCH FORM TAKES THE SAME ONE', op.value === 'FROM TEXT', short(op));
      check('  under the name the operation declares', !('text' in op), short(op));
      check(
        '  so one pair of arguments cannot mean two different things',
        singleArgs.text === op.value,
        short({ action: singleArgs.text, batch: op.value })
      );

      // AND THE ALIAS STILL WORKS ALONE, in both directions — a precedence made
      // to agree by ignoring one of the two names would satisfy everything
      // above while breaking the thing the alias exists for.
      const aliasOnly = await wire.call('target', { action: 'set_text', ref: REF, value: 'ONLY VALUE' });
      check('  `value` alone still reaches the app as `text`', (aliasOnly.handedOver[0]?.args || {}).text === 'ONLY VALUE', short(aliasOnly.handedOver[0]?.args));
      const batchAlias = await wire.call('target', { action: 'edit', ref: REF, operations: [{ type: 'set_text', text: 'ONLY TEXT' }] });
      check(
        '  and `text` alone still reaches it as an operation’s `value`',
        ((batchAlias.handedOver[0]?.args?.operations || [])[0] || {}).value === 'ONLY TEXT',
        short(batchAlias.handedOver[0]?.args?.operations)
      );

      // ── AND NEITHER SPELLING AT ALL, WHICH WAS TWO DIFFERENT ANSWERS ───────
      //
      // Accepting two names means BOTH are optional in the schema, so a call
      // carrying neither is schema-legal in both shapes and only a handler
      // check can refuse it. The action form had that check; the batch form did
      // not. Measured on this wire, one ref, two calls:
      //
      //   {action:"set_text", ref}                             → bad_arguments
      //   {action:"edit", ref, operations:[{type:"set_text"}]}  → {"ok":true}
      //
      // The second reached the app, where NORMALIZE.set_text is
      // `String(o.value ?? '')` -- so an operation with no text in it replaced
      // the element's words with the empty string and answered ok. The oracle
      // is BOTH halves: the envelope, and that nothing was dispatched.
      const neitherSingle = await wire.call('target', { action: 'set_text', ref: REF });
      const neitherBatch = await wire.call('target', { action: 'edit', ref: REF, operations: [{ type: 'set_text' }] });
      check('set_text with neither spelling is refused', neitherSingle.envelope?.code === 'bad_arguments', short(neitherSingle.envelope));
      check(
        '  AND THE SAME OPERATION IN A BATCH IS REFUSED THE SAME WAY',
        neitherBatch.envelope?.code === 'bad_arguments',
        short(neitherBatch.envelope)
      );
      check(
        '  neither of them reaching the app, which is where the wipe happened',
        neitherSingle.dispatched === 0 && neitherBatch.dispatched === 0,
        short({ single: neitherSingle.handedOver, batch: neitherBatch.handedOver })
      );
      check(
        '  and the batch refusal names which operation it was',
        (neitherBatch.envelope?.issues || []).some((i) => JSON.stringify(i.path) === JSON.stringify(['operations', 0, 'value'])),
        short(neitherBatch.envelope?.issues)
      );
      // AND THE BATCH IS REFUSED WHOLE. A batch that applied the operations in
      // front of the bad one and then stopped would be a worse answer than
      // either -- a half-edited document with an `ok:false` over it.
      const mixed = await wire.call('target', {
        action: 'edit',
        ref: REF,
        operations: [{ type: 'add_class', className: 'x' }, { type: 'set_text' }],
      });
      check(
        '  a batch whose SECOND operation has no text is refused whole',
        mixed.envelope?.code === 'bad_arguments' && mixed.dispatched === 0,
        short({ envelope: mixed.envelope, handedOver: mixed.handedOver })
      );
      check(
        '  naming the operation that was wrong rather than the first one',
        (mixed.envelope?.issues || []).some((i) => JSON.stringify(i.path) === JSON.stringify(['operations', 1, 'value'])),
        short(mixed.envelope?.issues)
      );
      // AND AN EMPTY STRING IS NOT A MISSING ONE. "Make this element say
      // nothing" is a real edit, in both forms, and a guard that refused it
      // would be refusing the operation rather than the mistake.
      const emptySingle = await wire.call('target', { action: 'set_text', ref: REF, text: '' });
      const emptyBatch = await wire.call('target', { action: 'edit', ref: REF, operations: [{ type: 'set_text', value: '' }] });
      check('  while an EMPTY string still reaches the app in the action form', emptySingle.dispatched === 1 && emptySingle.handedOver[0]?.args?.text === '', short(emptySingle.handedOver));
      check(
        '  and in the batch form',
        emptyBatch.dispatched === 1 && ((emptyBatch.handedOver[0]?.args?.operations || [])[0] || {}).value === '',
        short(emptyBatch.handedOver)
      );
    }

    // ── AND THE ONE BOUND ANOTHER FILE'S ARGUMENT RESTS ON ───────────────────
    //
    // `MAX_BODY_BYTES` in electron/mcp/server.js is sized from "the largest
    // schema-legal request", and the request it names is a
    // `content.write_entry`: 500 edits plus a one-million-character body.
    // docs/mcp-compatibility.md repeats that reasoning and test/mcp.js asserts
    // the gate is above 11 MB on the strength of it.
    //
    // With `.max(500)` deleted by the rebuild there was no largest
    // schema-legal `write_entry` at all, so the transport's number was sized
    // against a premise that had stopped being true — and nothing said so,
    // because the assertion that depends on it compares one constant with
    // another. It is checked HERE, where the premise lives, off the document a
    // client is actually served.
    const writeEntry = (delivered.get('content')?.oneOf || []).find((b) => b?.properties?.action?.const === 'write_entry');
    if (check('content publishes a write_entry branch', !!writeEntry, short(Object.keys(delivered.get('content') || {})))) {
      check('  the premise the transport limit is sized against: at most 500 edits', writeEntry.properties?.edits?.maxItems === 500, short(writeEntry.properties?.edits));
      check('  and a body of at most a million characters', writeEntry.properties?.body?.maxLength === 1000000, short(writeEntry.properties?.body));
      check(
        '  and the transport gate is above what those two make, so no schema-legal write is refused at the socket',
        MAX_BODY_BYTES > 1000000 + 500 * 1000,
        `${MAX_BODY_BYTES} bytes`
      );
    }

  } finally {
    const said = await wire.stop();
    problems.push(...(said?.problems || []));
  }

  // ── THE REBUILD, AUDITED FOR WHAT IT DROPS ───────────────────────────────
  //
  // `closeShape` reconstructs an object from its `.shape`. Everything that was
  // attached to the object rather than to its fields is gone unless the code
  // carries it across, and the code carries exactly one thing across: the
  // description. So the safety of this rewrite rests entirely on a claim about
  // what the real schemas use — and that claim is asserted here, over the
  // schema objects themselves, rather than written down and believed.
  {
    // THE EIGHT CLOSED DOMAIN UNIONS, plus audit's schema as it is DECLARED.
    // `audit` is closed at its registration rather than at its definition — by
    // `closedObject()` inside `publishChecked` — so the exported schema is the
    // pre-close one. That is the right tree for the question "does this
    // surface use a construct closeShape would drop", and the wrong one for
    // "is this object strict", so the strictness reading below is taken over
    // the eight that ship closed and audit's is taken off the wire instead.
    const closedTrees = { target: A.TargetInput, style: A.StyleInput, source: A.SourceInput, page: A.PageInput, content: A.ContentInput, asset: A.AssetInput, project: A.ProjectInput, git: A.GitInput };
    const types = new Map();
    const checks = new Map();
    const defaults = [];
    const looseObjects = [];
    const demoted = [];
    let objects = 0;
    const seen = new Set();
    const walk = (node, at, { strictness }) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      const def = node.def;
      if (!def) return;
      seen.add(node);
      types.set(def.type, (types.get(def.type) || 0) + 1);
      for (const c of def.checks || []) checks.set(c?._zod?.def?.check ?? 'unknown', (checks.get(c?._zod?.def?.check ?? 'unknown') || 0) + 1);
      if (def.type === 'default') defaults.push({ at, inner: def.innerType?.def?.type });
      if (def.type === 'object') {
        objects += 1;
        // `z.strictObject` is `z.object` with a `never` catchall; anything else
        // is an object that strips.
        if (strictness && def.catchall?.def?.type !== 'never') looseObjects.push(at);
        for (const [k, v] of Object.entries(node.shape || {})) walk(v, `${at}.${k}`, { strictness });
      }
      if (Array.isArray(def.options)) {
        // A UNION WHOSE BRANCHES ALL PIN THE SAME FIELD TO A LITERAL IS A
        // DISCRIMINATED UNION, whatever it ended up being built as. Derived
        // rather than listed, so the demotion is found wherever it happens.
        const literalFields = def.options.map((o) => Object.entries(o?.shape || {}).filter(([, f]) => f?.def?.type === 'literal').map(([k]) => k));
        const shared = literalFields.length > 1 ? literalFields.reduce((a, b) => a.filter((k) => b.includes(k))) : [];
        if (strictness && shared.length && !def.discriminator) demoted.push(`${at} (discriminates on ${shared.join('/')} and does not know it)`);
        def.options.forEach((o, i) => walk(o, `${at}|${i}`, { strictness }));
      }
      for (const key of ['innerType', 'element', 'valueType', 'keyType', 'in', 'out']) if (def[key]) walk(def[key], `${at}.<${key}>`, { strictness });
    };
    for (const [name, tree] of Object.entries(closedTrees)) walk(tree, name, { strictness: true });
    walk(AuditInput, 'audit', { strictness: false });

    // ONE ALLOW-LIST, so that a construct added tomorrow is a failure rather
    // than a silent new node type. Naming the six dangerous ones would let a
    // seventh through; naming what IS allowed cannot.
    const ALLOWED = ['object', 'string', 'number', 'boolean', 'literal', 'enum', 'array', 'union', 'optional', 'nullable', 'default', 'record', 'unknown'];
    const unexpected = [...types.keys()].filter((t) => !ALLOWED.includes(t));
    check(
      'every schema node on the public input surface is a plain shape',
      unexpected.length === 0,
      unexpected.length ? `${unexpected.join(', ')} — a transform, a pipe or a catch is not carried across by closeShape; see closeField` : `saw ${[...types.keys()].sort().join(', ')}`
    );
    check('  no pipe, so nothing on the input surface transforms or preprocesses', !types.has('pipe'), short([...types.keys()]));
    check('  no catch, which closeField would leave OPEN rather than close', !types.has('catch'), short([...types.keys()]));
    // THE SURFACE REALLY DOES DECLARE BOUNDS, IN QUANTITY. Without this line
    // the invariance check below — "the closed tree publishes the same
    // keywords as the open one" — would be satisfied by a surface that
    // declared none at all, which is the shape the defect it exists to catch
    // actually left behind.
    //
    // This replaced a rule that used to read "no custom check, so no
    // refinement is riding on an object that gets rebuilt". That rule was
    // load-bearing only while the rebuild DELETED checks; it now carries them,
    // proved on a probe below and asserted over the real trees in the
    // invariance block, so the surface is no longer forbidden a refinement it
    // would silently lose.
    check(
      '  and the bounds this suite drives are declared in quantity, so the invariance check is not vacuous',
      (checks.get('max_length') || 0) > 40 && (checks.get('min_length') || 0) > 5,
      `checks in use: ${[...checks.entries()].map(([k, n]) => `${k}×${n}`).sort().join(', ')}`
    );
    check('  the inventory really walked the surface', objects > 140 && types.get('literal') > 100, `${objects} objects, ${types.get('literal')} literals`);

    // THE `.default()` BRANCH, WHICH IS THE ONE THAT CAN LOSE A VALUE. It is
    // proved below to freeze a function default into a snapshot. The reason
    // that is latent rather than shipped is this: no default on the input
    // surface sits on a type closeField rebuilds.
    check('no default on the input surface wraps a rebuilt type', defaults.every((d) => !['object', 'array', 'union', 'record'].includes(d.inner)), short(defaults));

    // AND THE SECOND, INDEPENDENT READING OF THE HOLE. The sweep found it in
    // the delivered JSON Schema; this finds it in the zod tree, by a different
    // property (a missing `never` catchall rather than a missing
    // `additionalProperties`). Two derivations agreeing is what makes the count
    // above a measurement rather than a transcription.
    check(
      'no object shape in the zod trees is left un-strict',
      looseObjects.length === 0,
      looseObjects.join(', ') || 'none'
    );

    // AND THE SECOND DEFECT, READ THE SAME WAY. The wire sweep found it as a
    // refusal that could not name the key; this finds it as a union that
    // discriminates on `type` and has no discriminator. Two derivations from
    // different evidence, which is what makes the register above a measurement.
    check(
      'no union in the zod trees lost its discriminator to the rebuild',
      demoted.length === 0,
      demoted.join('; ') || 'none'
    );
  }

  // ── CLOSING A SCHEMA CHANGES THE FENCE AND NOTHING ELSE ──────────────────
  //
  // THE GENERAL FORM OF THE THIRD DEFECT, and the only assertion in this file
  // that could have caught it before it shipped. Everything else here grades the
  // closed schema against what it OUGHT to say; this grades it against what the
  // schema itself said before `closed()` touched it, which is the only reading
  // that notices a keyword going missing that nobody thought to look for.
  //
  // The comparison is possible at all because every node `carried()` builds
  // remembers the node it was built from — `openSourceOf` in agentTools.js.
  // Without that the open tree is unreachable the moment the rebuild returns,
  // which is precisely how twelve advertised bounds were deleted with 1,565
  // assertions watching.
  //
  // The rule is deliberately absolute: convert both halves to the JSON Schema a
  // client is served and require them to be IDENTICAL except for
  // `additionalProperties: false` appearing where a fence was added. Not "the
  // bounds match" — everything. A description, a `const`, a `format`, an
  // `enum`, a `required` list: if the rebuild drops any of it this is red,
  // whether or not anybody predicted that construct.
  {
    const z = require('zod');
    const jsonOf = (schema) => z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });

    // EVERY REBUILT NODE ON THE PUBLISHED SURFACE, found by walking the trees
    // the fourteen tools were actually registered with. Reading the schemas off
    // `composed()` rather than off the eight exports is what puts `audit`,
    // `get_context`, `capture`, `get_comments`, `comment` and
    // `get_capabilities` inside this check too — they are closed at
    // registration by `publishChecked`, and their open schemas are not exported
    // anywhere.
    const walkTree = (node, at, visit) => {
      const def = node?.def;
      if (!def) return;
      visit(node, at);
      if (def.type === 'object') for (const [k, v] of Object.entries(node.shape || {})) walkTree(v, `${at}.${k}`, visit);
      if (Array.isArray(def.options)) def.options.forEach((o, i) => walkTree(o, `${at}|${i}`, visit));
      for (const key of ['innerType', 'element', 'valueType', 'keyType']) if (def[key]) walkTree(def[key], `${at}.<${key}>`, visit);
    };

    const pairs = [];
    for (const [name, entry] of tools) {
      const tree = entry.config.inputSchema.schema;
      if (!check(`${name} publishes the zod schema it was registered with`, !!tree?.def, 'advertised() stopped exposing `schema`, and the invariance check below is grading nothing')) continue;
      walkTree(tree, name, (node, at) => {
        const open = A.openSourceOf(node);
        if (open) pairs.push({ at, open, shut: node });
      });
    }

    // NAMED HERE BECAUSE IT IS A DECISION. 196 is every node the rebuild
    // replaced across the fourteen tools — the eight domain unions and their
    // branches, the nested `Operation` union and its thirteen, every nested
    // object, record and bounded array, and the six tools closed at
    // registration. If it moves, somebody changed the shape of the surface or
    // the reach of the rebuild, and either should have to be written down.
    //
    // It was 197 while `Operation` was closed TWICE — once at declaration and
    // again on the way into `target.edit.operations` — because the array around
    // it was rebuilt to hold the second generation. `closeField` now hands back
    // a schema it has already closed, so the array keeps its own identity and
    // there is one fewer rebuilt node. Nothing a client is shown changed:
    // measured, the fourteen published documents are byte-identical either way.
    check('the rebuild replaced 196 nodes on the published surface, and each remembers its original', pairs.length === 196, `${pairs.length} rebuilt nodes`);
    check(
      '  including the eight domain unions themselves',
      ['target', 'style', 'source', 'page', 'content', 'asset', 'project', 'git'].every((n) => pairs.some((p) => p.at === n)),
      pairs.filter((p) => !p.at.includes('.') && !p.at.includes('|')).map((p) => p.at).join(', ')
    );
    check(
      '  and audit’s schema, which is closed at registration rather than at declaration',
      pairs.some((p) => p.at === 'audit'),
      'audit was registered without being closed'
    );

    // AND EVERY PAIR HAS TO HAVE AN OPEN HALF THAT IS ACTUALLY OPEN.
    //
    // The comparison below grades a rebuild against the schema it was built
    // from. If that schema is ITSELF something this rebuild produced, the pair
    // compares one generation against the next and agrees with itself: whatever
    // the first close lost, the second close lost too, so the difference is
    // zero and the loss is invisible. That is not a hypothetical — it is where
    // `Operation` sat. Closed at declaration and closed again inside
    // `target.edit.operations`, its thirty nodes were graded generation-2
    // against generation-1, and the union nobody had touched was reachable from
    // neither half of any pair, in the very block whose header calls it the
    // only assertion that would have caught twelve bounds being deleted.
    //
    // MEASURED with a bound deleted by the FIRST close of `Operation` (the
    // `set_classes` branch's `classes` array, `.max(80)` dropped in `closed()`):
    // before the fix the comparison below stayed GREEN and only the hard-coded
    // totals moved; after it, it reports
    // `target|4.operations.<element>.oneOf.3.properties.classes.maxItems: the
    // rebuild LOST 80`.
    const shadowed = pairs.filter((p) => A.openSourceOf(p.open));
    check(
      '  and every pair’s open half is a schema the rebuild never touched, so the comparison below is not grading a rebuild against a rebuild',
      shadowed.length === 0,
      `${shadowed.length} of ${pairs.length} pairs have an open half this file rebuilt: ${shadowed.slice(0, 6).map((p) => p.at).join(', ')}`
    );

    /** Every keyword difference between the two documents, position by position. */
    const differences = (open, shut, at) => {
      const out = [];
      const walk = (a, b, p) => {
        if (a === b) return;
        const bothObjects = a && typeof a === 'object' && b && typeof b === 'object';
        if (!bothObjects) {
          if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${p}: ${JSON.stringify(a)} became ${JSON.stringify(b)}`);
          return;
        }
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          // THE ONE DIFFERENCE THE REBUILD IS FOR. Anything else — including
          // `additionalProperties` appearing as anything other than `false` —
          // falls through to the walk and is reported.
          if (!(k in a) && k === 'additionalProperties' && b[k] === false) continue;
          if (!(k in a)) out.push(`${p}.${k}: the rebuild INVENTED ${JSON.stringify(b[k])}`);
          else if (!(k in b)) out.push(`${p}.${k}: the rebuild LOST ${JSON.stringify(a[k])}`);
          else walk(a[k], b[k], `${p}.${k}`);
        }
      };
      walk(open, shut, at);
      return out;
    };

    const BOUNDS = ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'multipleOf'];
    const countKeys = (node, pred) => {
      let n = 0;
      const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) return v.forEach(walk);
        for (const [k, val] of Object.entries(v)) {
          if (pred(k, val)) n += 1;
          walk(val);
        }
      };
      walk(node);
      return n;
    };

    const lost = [];
    let fences = 0;
    let bounds = 0;
    for (const { at, open, shut } of pairs) {
      const before = jsonOf(open);
      const after = jsonOf(shut);
      lost.push(...differences(before, after, at));
      fences += countKeys(after, (k, v) => k === 'additionalProperties' && v === false);
      bounds += countKeys(after, (k) => BOUNDS.includes(k));
    }

    check(
      'closing a schema changes nothing a client is shown except the fence it exists to add',
      lost.length === 0,
      lost.slice(0, 20).join('\n    ')
    );
    // THE POSITIVE CONTROLS FOR THE COMPARISON ITSELF. Two identical documents
    // that both said nothing would satisfy the assertion above, and "said
    // nothing" is exactly the state the defect left behind. So the fences the
    // comparison forgave and the bounds it compared are both counted, over the
    // same walk, and both are numbers that go down when a keyword is lost.
    //
    // The totals are per PAIR rather than per position, so a nested tree is
    // counted once for itself and once again inside every rebuilt ancestor.
    // They fell from 1,122 and 432 when `Operation` stopped being closed a
    // second time: the array around it is no longer a rebuilt node, and with it
    // went one whole extra count of the union's own thirty. Nothing was
    // dropped from the surface — the published documents are byte-identical —
    // and every one of those keywords is still counted, once, under the union.
    //
    // They ROSE from 1,091 and 1,076 when the page domain got one path space.
    // Five arguments that were a bare `z.string().max(300)` — `page.move`'s
    // `to` and the four folder paths — became `PagePath`, which is `.min(1)`
    // as well, because an empty page path is not a page path and the resolver
    // has always refused one; and two that were `RelPath` (`.min(1).max(1024)`,
    // a path anywhere in the project) became the same `PagePath`, which is the
    // narrower and truer bound. Net five more bounded keywords, counted twice
    // each. The number moving is the mechanism working: it is here so that a
    // bound cannot go missing quietly, and a bound that CHANGES on purpose is
    // supposed to be argued for in this comment.
    check('  the comparison saw fences in quantity, which are the difference it forgives', fences > 400, `${fences} additionalProperties:false across the rebuilt nodes`);
    check(
      '  and compared real constraints: 1,101 bound keywords across the rebuilt nodes',
      bounds === 1101,
      `${bounds} of ${BOUNDS.join('/')} — this number DROPS when a bound is dropped, which is what makes the check above load-bearing`
    );

    // AND THE SAME QUESTION ASKED OF THE ZOD TREES, which is not the same
    // question. A check JSON Schema cannot express — a `.refine()` — is
    // invisible to the comparison above: both halves emit nothing for it and
    // agree. So every check object in each open node is tallied by kind and
    // required to be present in the rebuilt one, walking WITHOUT deduplication
    // so a shape shared by three branches counts three times on both sides,
    // exactly as the rebuild expands it three times.
    const tally = (root) => {
      const out = new Map();
      walkTree(root, '', (node) => {
        for (const c of node.def?.checks || []) out.set(c?._zod?.def?.check ?? 'unknown', (out.get(c?._zod?.def?.check ?? 'unknown') || 0) + 1);
      });
      return out;
    };
    const mismatched = [];
    let checksSeen = 0;
    for (const { at, open, shut } of pairs) {
      const before = tally(open);
      const after = tally(shut);
      for (const [kind, n] of before) {
        checksSeen += n;
        if ((after.get(kind) || 0) !== n) mismatched.push(`${at}: ${kind} ${n} before, ${after.get(kind) || 0} after`);
      }
      for (const [kind, n] of after) if (!before.has(kind)) mismatched.push(`${at}: ${kind} invented ${n} times`);
    }
    check('every check on the open trees is still on the rebuilt ones, kind for kind', mismatched.length === 0, mismatched.slice(0, 20).join('; '));
    check('  and the tally walked something: 1,086 checks across the rebuilt nodes', checksSeen === 1086, `${checksSeen} checks`);
  }

  // ── THE MECHANISM, DRIVEN WITH SCHEMAS THAT DO USE THOSE CONSTRUCTS ──────
  //
  // The inventory above is only worth having if breaking its rule would
  // actually cost something. So `closeShape` is run — the real one, reached
  // through the exported `publishChecked`, not a copy — over probe schemas
  // that carry a description, a refinement, a catch and both kinds of default,
  // and what survives is asserted. Every line here is a fact about the shipping
  // function, and each one is why a line in the inventory exists.
  {
    const z = require('zod');
    /**
     * Close a probe schema through the REAL publishChecked, and hand back what
     * a client would be shown and what the handler would check with.
     *
     * `closeShape` and `closeField` are module-local, and a copy of them here
     * would be a second implementation graded instead of the first. This is the
     * same door electron/mcp/tools.js sends every non-domain tool through.
     */
    const closeIt = (inputSchema) => {
      let got = null;
      const recorder = { registerTool: (_n, config) => { got = config; return {}; } };
      A.publishChecked(recorder, 'probe', { title: 'probe', description: 'probe', inputSchema }, async (a) => a);
      return {
        schema: got.inputSchema,
        json: got.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
      };
    };

    // The property the whole suite rests on, on a shape nobody shipped.
    const nested = closeIt(z.object({ outer: z.object({ inner: z.object({ leaf: z.string() }) }) })).schema;
    check('closeShape closes an object three levels down', nested.safeParse({ outer: { inner: { leaf: 'x', bogus: 1 } } }).success === false, short(nested.safeParse({ outer: { inner: { leaf: 'x', bogus: 1 } } }).error?.issues));
    check('  and still accepts the same value without the key', nested.safeParse({ outer: { inner: { leaf: 'x' } } }).success === true, short(nested.safeParse({ outer: { inner: { leaf: 'x' } } }).error?.issues));

    // DESCRIPTIONS ARE CARRIED ACROSS, which is the one thing closeShape
    // remembers to do — and it had to be taught: rebuilding dropped the
    // sentence published beside two operations. See `closed()`. Read out of the
    // ADVERTISED document, because a description a client is not shown is not a
    // description that survived.
    const described = closeIt(z.object({ thing: z.object({ a: z.string() }).describe('a sentence a client reads') })).json;
    check('a nested object keeps its own description through the rebuild', described.properties?.thing?.description === 'a sentence a client reads', short(described.properties?.thing));
    check('  and is closed at the same time', described.properties?.thing?.additionalProperties === false, short(described.properties?.thing));

    // A CHECK ON A REBUILT WRAPPER SURVIVES — the fix for the third defect, on
    // a probe rather than on the surface. This assertion used to read the other
    // way round: the rebuild dropped every check, and the inventory forbade the
    // surface a refinement so that nothing would be silently deleted. It did
    // not forbid a BOUND, and bounds are checks too, so twelve of them went.
    // `carried()` now re-attaches `def.checks` on every rebuilt wrapper.
    const refinedSchema = () => z.object({ pair: z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, 'a must be below b') });
    const wouldHaveFailed = { pair: { a: 9, b: 1 } };
    check(
      'a refinement attached to a nested object SURVIVES the rebuild',
      closeIt(refinedSchema()).schema.safeParse(wouldHaveFailed).success === false,
      short(closeIt(refinedSchema()).schema.safeParse(wouldHaveFailed))
    );
    check('  (the same schema unrebuilt refuses it identically, so the probe is real)', refinedSchema().safeParse(wouldHaveFailed).success === false);
    check(
      '  and the value the refinement allows is still accepted, so it was carried rather than replaced by a blanket refusal',
      closeIt(refinedSchema()).schema.safeParse({ pair: { a: 1, b: 9 } }).success === true,
      short(closeIt(refinedSchema()).schema.safeParse({ pair: { a: 1, b: 9 } }))
    );

    // AND A BOUND ON AN ARRAY OF OBJECTS, which is the exact shape that was
    // lost. `.min(1).max(2)` on an array whose element is an object: the
    // element always rebuilds to a new instance, so the array always rebuilt,
    // and `z.array(closedInner)` published no `minItems` and no `maxItems` and
    // accepted an empty batch. Both the runtime answer and the ADVERTISED
    // document are read, because the two failed together and a fix that only
    // restored one would leave a validating client refusing calls Stacki takes,
    // or taking calls Stacki refuses.
    const boundedProbe = closeIt(z.object({ ops: z.array(z.object({ a: z.string() })).min(1).max(2) }));
    const opsOf = (n) => ({ ops: Array.from({ length: n }, () => ({ a: 'x' })) });
    check('a bound on an array of objects survives the rebuild: 0 is refused', boundedProbe.schema.safeParse(opsOf(0)).success === false, short(boundedProbe.schema.safeParse(opsOf(0))));
    check('  1 is accepted', boundedProbe.schema.safeParse(opsOf(1)).success === true, short(boundedProbe.schema.safeParse(opsOf(1))));
    check('  2 is accepted', boundedProbe.schema.safeParse(opsOf(2)).success === true, short(boundedProbe.schema.safeParse(opsOf(2))));
    check('  3 is refused', boundedProbe.schema.safeParse(opsOf(3)).success === false, short(boundedProbe.schema.safeParse(opsOf(3))));
    check('  and the advertised document still says so', boundedProbe.json.properties?.ops?.minItems === 1 && boundedProbe.json.properties?.ops?.maxItems === 2, short(boundedProbe.json.properties?.ops));
    // AND THE SAME BOUND ON AN ARRAY OF A DISCRIMINATED UNION, which is what
    // `target.edit.operations` actually is.
    const unionProbe = closeIt(z.object({ ops: z.array(z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })])).min(1).max(2) }));
    const tOf = (n) => ({ ops: Array.from({ length: n }, () => ({ t: 'a' })) });
    check('the same bound on an array of a discriminated union survives too', unionProbe.schema.safeParse(tOf(0)).success === false && unionProbe.schema.safeParse(tOf(3)).success === false, short([unionProbe.schema.safeParse(tOf(0)).success, unionProbe.schema.safeParse(tOf(3)).success]));
    check('  and it still accepts the sizes it declares', unionProbe.schema.safeParse(tOf(1)).success === true && unionProbe.schema.safeParse(tOf(2)).success === true, short(unionProbe.schema.safeParse(tOf(2))));
    check('  and publishes both keywords', unionProbe.json.properties?.ops?.minItems === 1 && unionProbe.json.properties?.ops?.maxItems === 2, short(unionProbe.json.properties?.ops));

    // A CATCH IS LEFT OPEN. `closeField` recognises the wrapper well enough to
    // close its inner type and then falls through to `return field`, handing
    // back the ORIGINAL — so a catch-wrapped object keeps stripping.
    const caught = closeIt(z.object({ thing: z.object({ a: z.string() }).catch({ a: 'fallback' }) })).schema;
    check('a catch-wrapped object is left open by the rebuild', caught.safeParse({ thing: { a: 'x', bogus: 1 } }).success === true, short(caught.safeParse({ thing: { a: 'x', bogus: 1 } })));

    // A NESTED DISCRIMINATED UNION KEEPS ITS DISCRIMINATOR. The mechanism
    // behind the second defect, on a probe rather than on the surface. It used
    // to come back as a plain `z.union`: still refusing the same values, but
    // answering `invalid_union`/"Invalid input" with the real sub-errors buried
    // in `errors[]` where `issuesOf()` never looks — so the caller was told
    // only that something, somewhere, was wrong. The rebuild now carries the
    // discriminator across, and the key is named again.
    const branches = [z.object({ kind: z.literal('a'), x: z.string() }), z.object({ kind: z.literal('b'), y: z.string() })];
    const demotedProbe = closeIt(z.object({ pick: z.discriminatedUnion('kind', branches) })).schema;
    const demotedIssues = demotedProbe.safeParse({ pick: { kind: 'a', x: 'v', bogus: 1 } }).error?.issues || [];
    check('a nested discriminated union still refuses the unknown key', demotedIssues.length > 0, short(demotedIssues));
    check(
      '  and NAMES the key, because the discriminator survived the rebuild',
      demotedIssues.some((i) => i.code === 'unrecognized_keys'),
      short(demotedIssues)
    );
    check(
      '  (the same shape declared strict by hand answers identically — the rebuild lost nothing)',
      (z.strictObject({ pick: z.discriminatedUnion('kind', branches.map((b) => z.strictObject(b.shape))) }).safeParse({ pick: { kind: 'a', x: 'v', bogus: 1 } }).error?.issues || []).some((i) => i.code === 'unrecognized_keys')
    );

    // THE `.default()` ROUND TRIP, WHICH IS THE QUESTION ZOD 4 MAKES WORTH
    // ASKING. `def.defaultValue` is a GETTER that CALLS a function default, so
    // `closedInner.default(def.defaultValue)` does not re-wrap the function —
    // it captures one snapshot of its result, at schema-construction time, and
    // serves that forever. Measured, not reasoned about.
    let produced = 0;
    const fnDefault = closeIt(z.object({ thing: z.object({ n: z.number() }).default(() => ({ n: (produced += 1) })) })).schema;
    const first = fnDefault.parse({}).thing.n;
    const second = fnDefault.parse({}).thing.n;
    check('a FUNCTION default on a rebuilt object is frozen to one snapshot', first === second, `${first} then ${second}`);
    check('  and the function is not called again after the rebuild', produced === 1, `called ${produced} times`);
    check(
      '  (unrebuilt, the same default is fresh every parse, which is what was lost)',
      (() => {
        let n = 0;
        const raw = z.object({ n: z.number() }).default(() => ({ n: (n += 1) }));
        return raw.parse(undefined).n !== raw.parse(undefined).n;
      })()
    );
    // A LITERAL default is unharmed, and the rebuilt object is still closed
    // around it — which is what the surface's own defaults rely on.
    const litDefault = closeIt(z.object({ thing: z.object({ n: z.number() }).default({ n: 7 }) })).schema;
    check('a literal default survives the rebuild', litDefault.parse({}).thing.n === 7, short(litDefault.parse({})));
    check('  and the object it defaults to is closed', litDefault.safeParse({ thing: { n: 7, bogus: 1 } }).success === false, short(litDefault.safeParse({ thing: { n: 7, bogus: 1 } })));

    // A default whose inner type closeField does not rebuild is returned
    // untouched — which is why every default the real surface declares still
    // works, and the freezing above is latent rather than shipped.
    const scalarDefault = closeIt(z.object({ mode: z.enum(['a', 'b']).default('a') })).schema;
    check('a default on a primitive is returned untouched', scalarDefault.parse({}).mode === 'a', short(scalarDefault.parse({})));
  }

  // ── THE BLIND SPOT OF THE INVENTORY, CLOSED BY READING THE SOURCE ────────
  //
  // The walk above reads the schemas AFTER closeShape has run, so a construct
  // the rebuild DELETED leaves no tree to find it in. The invariance block
  // closed most of that gap — it holds the open node beside the rebuilt one and
  // compares them — but only for nodes the rebuild replaced. A `z.preprocess`
  // or a `.brand` is a wrapper `closeField` does not recognise: it returns the
  // ORIGINAL, so there is no pair to compare and the object inside goes on
  // stripping. That is what is scanned for here, and neither construct has a
  // homonym in this codebase, so the reading is exact.
  //
  // `.refine` and `.superRefine` used to be on this list, because the rebuild
  // deleted them without a word. They are not any more: `carried()` re-attaches
  // every check, the probe above proves a nested refinement still refuses what
  // it refused, and the check tally in the invariance block would go red if one
  // were dropped on the real surface.
  {
    const dir = path.join(__dirname, '..', 'electron', 'mcp');
    const files = [];
    const collect = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) collect(path.join(d, entry.name));
        else if (entry.name.endsWith('.js')) files.push(path.join(d, entry.name));
      }
    };
    collect(dir);
    check('the source scan found the MCP surface', files.length > 15, `${files.length} files under electron/mcp`);
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const construct of ['z.preprocess(', '.brand(']) {
        let from = 0;
        for (;;) {
          const at = text.indexOf(construct, from);
          if (at < 0) break;
          hits.push(`${path.relative(path.join(__dirname, '..'), file)}: ${construct}`);
          from = at + 1;
        }
      }
    }
    check(
      'no preprocess or brand is declared anywhere in electron/mcp',
      hits.length === 0,
      hits.length ? `${hits.join('; ')}\n    closeField does not recognise either wrapper, so it hands back the ORIGINAL and the object inside goes on stripping — see the catch probe above` : ''
    );
    // POSITIVE CONTROL for the scanner itself: it must find something it is
    // looking for, or "no hits" means only that the search was broken.
    const canary = files.filter((f) => fs.readFileSync(f, 'utf8').includes('.optional('));
    check('  and the scanner can find a construct that IS used', canary.length > 0, `${canary.length} files declare .optional(`);
  }

  // ── THE REFUSAL BRANCH, WHICH WAS THE ONE OBJECT LEFT OPEN ───────────────
  //
  // Every input position above is closed. The OUTPUT side has one shared object
  // in it — `ToolRefusal` — and it was `z.object`, which strips. Because
  // `orRefusal(X)` is `z.union([X, ToolRefusal])`, that made the refusal branch
  // a hole straight through the declared output schema of every tool that
  // publishes one: any value carrying `{ok:false, code, message}` validated
  // against it whatever else it held.
  //
  // The reason that matters here rather than only in principle: this surface
  // has a rule that a refusal never carries a host absolute path, and a check
  // that validates a refusal against the schema its own tool publishes was
  // being told yes with the path still attached. An open branch on the output
  // side is a broken ORACLE, not just a loose contract.
  //
  // The tools are DERIVED — every published tool whose output union actually
  // contains this object — so a tool that starts publishing a refusal tomorrow
  // is checked without anybody adding it to a list, and the count is asserted
  // so the block cannot pass by finding none.
  {
    // `orRefusal` no longer hands the union straight to `registerTool`: it
    // wraps it so the payload's fields can be published at the TOP LEVEL beside
    // the branches (see `hoistUnionProperties` in agentTools.js), and the union
    // itself rides along on `.schema` exactly as `advertised()` carries an input
    // schema. Both readings are tried, so this derivation keeps working whether
    // a tool declares the union directly or through the wrapper.
    const unionOptions = (declared) => {
      for (const candidate of [declared, declared?.schema]) {
        if (Array.isArray(candidate?.def?.options)) return candidate.def.options;
      }
      return null;
    };
    const refusalTools = [...tools]
      .filter(([, entry]) => (unionOptions(entry.config.outputSchema) || []).includes(A.ToolRefusal))
      .map(([name]) => name);
    check(
      'the refusal branch is published by the four tools that answer with one',
      same(refusalTools, ['get_context', 'capture', 'get_comments', 'comment']),
      refusalTools.join(', ') || 'no published tool declares orRefusal(); this block would grade nothing'
    );

    // THE POSITIVE CONTROL FIRST. A branch that refused everything would
    // satisfy every negative assertion below, and would break the four tools it
    // is declared on.
    const realRefusal = {
      ok: false,
      code: 'bad_arguments',
      operation: 'get_context',
      message: 'get_context could not run — styleDetail: Invalid option',
      issues: [{ path: ['styleDetail'], message: 'Invalid option', code: 'invalid_value' }],
    };
    check(
      'a real refusal still validates against the branch declared for it',
      A.ToolRefusal.safeParse(realRefusal).success === true,
      short(A.ToolRefusal.safeParse(realRefusal).error?.issues)
    );
    check(
      '  and the refusal this surface actually builds does too, field for field',
      A.ToolRefusal.safeParse(A.badToolArguments('get_context', A.ToolRefusal.safeParse({}).error)).success === true,
      short(A.ToolRefusal.safeParse(A.badToolArguments('get_context', A.ToolRefusal.safeParse({}).error)).error?.issues)
    );

    // AND THE HOLE, at both depths it existed at.
    const smuggled = { ...realRefusal, [UNKNOWN_KEY]: '/Users/somebody/Projects/thing' };
    check(
      'a refusal carrying a key nobody declared is refused by the branch',
      A.ToolRefusal.safeParse(smuggled).success === false,
      short(A.ToolRefusal.safeParse(smuggled).data)
    );
    const smuggledIssue = { ...realRefusal, issues: [{ ...realRefusal.issues[0], [UNKNOWN_KEY]: 1 }] };
    check(
      '  and so is one that hides it inside an issue, one level down',
      A.ToolRefusal.safeParse(smuggledIssue).success === false,
      short(A.ToolRefusal.safeParse(smuggledIssue).data)
    );

    // THROUGH THE UNION, which is the shape a tool actually declares: the
    // payload branch must not catch what the refusal branch rejects.
    for (const name of refusalTools) {
      const declared = tools.get(name).config.outputSchema;
      check(
        `${name}'s declared output refuses a refusal with an undeclared key beside it`,
        declared.safeParse(smuggled).success === false,
        short(declared.safeParse(smuggled).data)
      );
    }

    // AND THE SECOND, INDEPENDENT READING: the document the transport really
    // sent. The two derivations agree or one of them is wrong — the same rule
    // this file applies to the input side.
    for (const name of refusalTools) {
      const doc = deliveredOutput.get(name);
      const branches = Array.isArray(doc?.anyOf) ? doc.anyOf : [];
      const refusal = branches.find((b) => b?.properties?.code && b?.properties?.message && b?.properties?.ok?.const === false);
      check(
        `  and the delivered output document for ${name} carries the refusal branch closed`,
        !!refusal && refusal.additionalProperties === false,
        refusal ? short(refusal.additionalProperties) : `no refusal branch in ${short(Object.keys(doc || {}))}`
      );
    }

    // ── AND THE SHAPE THE UNION USED TO DELETE ──────────────────────────────
    //
    // Declaring the refusal branch cost these four tools their published SHAPE.
    // `z.union([Payload, ToolRefusal])` emits `{anyOf:[…]}` and nothing else, so
    // the top-level `properties` and `required` a host reads to render or to
    // type a result went to nothing at all -- measured on the wire, all four:
    // `root keys: $schema,anyOf | properties? false | required? false`. The
    // declaration got truer and the document got useless, which is not a trade
    // this surface has to make.
    //
    // Both halves are asserted here, because a fix for either alone is easy and
    // wrong: hoisting the payload's `required` to the root would refuse every
    // refusal (reinstating the false declaration), and collapsing the branches
    // into one all-optional object would publish a document that accepts `{}`.
    const validator = new AjvJsonSchemaValidator();
    const verdict = async (schema, value) => validator.getValidator(schema)(value);
    // A CONTROL ON THE VALIDATOR ITSELF, before a single verdict is read.
    {
      const trivial = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
      check('the output validator says yes to what it should', (await verdict(trivial, { n: 1 })).valid === true, '');
      check('  and no to what it should not', (await verdict(trivial, { n: 'x' })).valid === false, '');
    }

    for (const name of refusalTools) {
      const doc = deliveredOutput.get(name);
      const branches = Array.isArray(doc?.anyOf) ? doc.anyOf : [];
      const payload = branches.find((b) => !(b?.properties?.ok?.const === false));
      const refusal = branches.find((b) => b?.properties?.ok?.const === false);

      // (1) THE FIELDS ARE READABLE AT THE TOP LEVEL AGAIN, which is the whole
      // complaint: a client that has never heard of `anyOf` must still be able
      // to see what this tool answers with.
      const declaredAtRoot = Object.keys(doc?.properties || {});
      const payloadFields = Object.keys(payload?.properties || {});
      check(
        `${name} publishes its payload's fields at the top level, not only inside a branch`,
        payloadFields.length > 0 && payloadFields.every((f) => declaredAtRoot.includes(f)),
        `root: ${declaredAtRoot.join(', ') || '(none)'}
    payload: ${payloadFields.join(', ')}`
      );

      // (2) AND THEY ARE PUBLISHED IN A FORM BOTH BRANCHES SATISFY. A
      // top-level `properties` entry is asserted against every answer, so a
      // hoisted field that only fits the payload would refuse every refusal
      // carrying that field -- `ok` is `boolean` in a payload and `const false`
      // in a refusal, and two of these four declare both. Proved per key per
      // branch rather than trusted: the hoisted fragment is either the
      // branch's own, or an `anyOf` that contains it.
      const narrowed = [];
      for (const branch of branches) {
        for (const [field, spec] of Object.entries(branch.properties || {})) {
          const hoisted = doc?.properties?.[field];
          const carries =
            JSON.stringify(hoisted) === JSON.stringify(spec) ||
            (Array.isArray(hoisted?.anyOf) && hoisted.anyOf.some((alt) => JSON.stringify(alt) === JSON.stringify(spec)));
          if (!carries) narrowed.push(`${field}: ${short(hoisted, 120)} does not carry ${short(spec, 120)}`);
        }
      }
      check(`  and narrows none of them on the way up`, narrowed.length === 0, narrowed.join('\n    '));

      // (3) `required` AT THE ROOT IS TRUE OF EVERY ANSWER, not just of the
      // payload. The intersection, or nothing at all when the two branches
      // share no field -- which is the honest answer for get_context and
      // capture, whose payloads and refusals have no key in common.
      const rooted = doc?.required || [];
      const inEvery = rooted.filter((f) => branches.every((b) => (b.required || []).includes(f)));
      check(
        `  and requires at the root only what EVERY answer carries`,
        rooted.length === inEvery.length,
        `root required: ${rooted.join(', ') || '(none)'}
    payload: ${(payload?.required || []).join(', ')}
    refusal: ${(refusal?.required || []).join(', ')}`
      );

      // (4) THE DOCUMENT A CLIENT VALIDATES WITH STILL ACCEPTS A REFUSAL. This
      // is the assertion the whole union was declared for, and the one a naive
      // hoist breaks.
      const built = A.badToolArguments(name, A.ToolRefusal.safeParse({}).error);
      const said = await verdict(doc, built);
      check(`  and the delivered document still validates the refusal this surface builds`, said.valid === true, `${said.errorMessage || ''}\n    ${short(built)}`);

      // (5) AND STILL REFUSES SOMETHING THAT IS NEITHER. Without this the fix
      // could be a root that accepts any object at all, which would satisfy
      // every assertion above it.
      const neither = await verdict(doc, { stackiNotAnAnswer: 1 });
      check(`  while refusing an object that is neither a payload nor a refusal`, neither.valid === false, short(neither));

      // (6) AND THE RUNTIME HALF, WHICH IS A DIFFERENT OBJECT ENTIRELY.
      //
      // The document above is what a CLIENT validates with. The SERVER validates
      // an answer through `~standard.validate` on the registered schema, and
      // that is now a wrapper rather than the zod union itself (see
      // `publishedAs` in agentTools.js). A wrapper that published a better
      // document and quietly stopped checking anything — which is exactly what
      // `advertised()` does on the INPUT side, deliberately, because the
      // handler re-checks — would satisfy every assertion above it and turn off
      // output validation for four tools with nothing to say so.
      const declared = tools.get(name).config.outputSchema;
      const validated = async (value) => declared['~standard'].validate(value);
      const onRefusal = await validated(built);
      check(
        `  and the SERVER's own check accepts that refusal too`,
        !(onRefusal?.issues || []).length,
        short(onRefusal?.issues)
      );
      const onNonsense = await validated({ stackiNotAnAnswer: 1 });
      check(
        `  and refuses an answer that is neither, rather than waving everything through`,
        (onNonsense?.issues || []).length > 0,
        short(onNonsense)
      );
      // A WRONG-TYPED PAYLOAD, which is the assertion the union was strict for.
      const wrongTyped = { ...built, code: 12 };
      const onWrongType = await validated(wrongTyped);
      check(
        `  and refuses a refusal whose declared field has the wrong type`,
        (onWrongType?.issues || []).length > 0,
        short(onWrongType)
      );
    }
  }

  // ── A STRICT ROOT IS NOT A CLOSED SCHEMA ─────────────────────────────────
  //
  // `closedObject()` — the function `publishChecked` runs over the six
  // non-domain tools' input schemas — used to hand back any object whose own
  // catchall was already `never`, on the reasoning that it was closed already.
  // It is not: strictness at the top says nothing about the objects underneath,
  // which is the whole argument for `closeShape` over `z.strictObject` in the
  // first place — "a mistyped field inside `node` is exactly as invisible as a
  // mistyped field beside it, and rather more likely".
  //
  // Nothing on the shipping surface declares a strict root today, which is why
  // no injection above could reach this: the defect is that the guard sat one
  // `z.strictObject` away from silently reopening every nested object on a
  // tool, on the day somebody closed a root by hand believing it made the tool
  // safer. So this block declares that tool, through the real `publishChecked`.
  //
  // The oracle is not "was it refused". It is WHAT THE HANDLER RAN WITH: a
  // stripped key is an argument the caller wrote and nobody ran, and the four
  // measured retargets at the head of agentTools.js are all of that shape.
  {
    const z = require('zod');
    const probe = (inputSchema) => {
      let handler = null;
      const ran = [];
      A.publishChecked(
        { registerTool: (_n, _c, fn) => { handler = fn; return { name: _n }; } },
        'strict_root_probe',
        { title: 'probe', description: 'a tool whose author closed its root by hand', inputSchema },
        async (args) => { ran.push(args); return { content: [], structuredContent: { ok: true } }; }
      );
      return { call: (args) => handler(args), ran };
    };

    const shape = { node: z.object({ id: z.string(), tag: z.string().optional() }) };
    const strictRoot = probe(z.strictObject(shape));
    const looseRoot = probe(z.object(shape));

    // POSITIVE CONTROL: a well-formed call still gets through both.
    const good = { node: { id: 'n1' } };
    await strictRoot.call(good);
    await looseRoot.call(good);
    check('a tool with a hand-closed root still runs a call that is right', strictRoot.ran.length === 1 && JSON.stringify(strictRoot.ran[0]) === JSON.stringify(good), short(strictRoot.ran));
    check('  and so does the same tool with an open root', looseRoot.ran.length === 1, short(looseRoot.ran));

    const wrong = { node: { id: 'n1', [UNKNOWN_KEY]: 'dropped' } };
    const strictAnswer = await strictRoot.call(wrong);
    const looseAnswer = await looseRoot.call(wrong);
    check(
      'an unknown key one level inside a hand-closed root is refused',
      strictAnswer?.structuredContent?.ok === false && strictAnswer.structuredContent.code === 'bad_arguments',
      short(strictAnswer?.structuredContent)
    );
    check(
      `  and the refusal names ${UNKNOWN_KEY} rather than describing the object`,
      JSON.stringify(strictAnswer?.structuredContent?.issues || []).includes(UNKNOWN_KEY),
      short(strictAnswer?.structuredContent?.issues)
    );
    check(
      '  and NOTHING RAN: the handler was never reached with arguments nobody wrote',
      strictRoot.ran.length === 1,
      `${strictRoot.ran.length} calls reached the handler; the second is ${short(strictRoot.ran[1])} — the key was stripped and the tool ran on what was left`
    );
    // The open root is the control: it was already refusing this, and if it
    // ever stops, the assertion above is measuring the wrong mechanism.
    check(
      '  the same call on an open root is refused too, so the fence is the nesting and not the root',
      looseAnswer?.structuredContent?.code === 'bad_arguments' && looseRoot.ran.length === 1,
      short(looseAnswer?.structuredContent)
    );
  }

  check('the wire left nothing behind', problems.length === 0, problems.join('; '));

  suiteDone();
  if (failures.length) {
    console.error(`schema-strictness: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`schema-strictness: ${checked} passed  [every closed object position injected at depth, refused, and proved to dispatch nothing]`);
})().catch((err) => {
  suiteDone();
  if (failures.length) console.error(`schema-strictness: ${failures.length} of ${checked} had already failed\n${failures.join('\n')}`);
  console.error('schema-strictness: threw\n', err?.stack || err);
  process.exit(1);
});
