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
//   AUDITS the rebuild for lost semantics. `closeShape` reconstructs an object
//   from its `.shape`, and anything not carried across is gone: a refinement, a
//   catch, a transform, an object-level description, a function default. The
//   inventory that says none of those is used on the real surface is an
//   ASSERTION here rather than a sentence in a report, and the mechanism itself
//   is driven with probe schemas that DO use them, so the inventory rule is
//   known to be load-bearing rather than assumed to be.
//
// WHAT IT FOUND. One class of object on the input surface is still open, and
// it is not user data: the `{type, value}` pair inside a node's `props` record.
// See NOT_CLOSED below — it is registered, its current behaviour is pinned, and
// the one-line production fix is in the failure message.

const fs = require('node:fs');
const path = require('node:path');

const { registerTools } = require('../electron/mcp/tools.js');
const A = require('../electron/mcp/agentTools.js');
const { AuditInput } = require('../electron/mcp/auditTool.js');
const { startStrictnessWire } = require('./support/strictnessWire.js');

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
  // `create` needs something written in it: reviewTools.js `requirementProblem`
  // refuses an empty comment before the review ledger is touched.
  comment: { message: 'x' },
};

const extraFor = (tool, args) => EXTRA_TO_DISPATCH[`${tool}:${args?.action}`] || EXTRA_TO_DISPATCH[tool] || {};

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
      const res = await wire.call(loc.tool, { ...dirty, ...extra });
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
    check(
      '  and no custom check, so no refinement is riding on an object that gets rebuilt',
      !checks.has('custom'),
      `checks in use: ${[...checks.keys()].sort().join(', ')}`
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

    // A REFINEMENT DOES NOT SURVIVE. This is why the inventory asserts no
    // custom check exists on the input surface: if one did, rebuilding would
    // delete the rule and the schema would go on looking correct.
    const refinedSchema = () => z.object({ pair: z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, 'a must be below b') });
    const wouldHaveFailed = { pair: { a: 9, b: 1 } };
    check(
      'a refinement attached to a nested object is DROPPED by the rebuild',
      closeIt(refinedSchema()).schema.safeParse(wouldHaveFailed).success === true,
      'if this went red, closeField learned to carry checks across and the inventory rule can be relaxed'
    );
    check('  (the same schema unrebuilt does refuse it, so the probe is real)', refinedSchema().safeParse(wouldHaveFailed).success === false);

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
  // The walk above reads the schemas AFTER closeShape has run, which sees a
  // catch, a pipe or a refinement on a SCALAR, because those are returned
  // untouched. The one thing it cannot see is a refinement that was attached to
  // an OBJECT and deleted by the rebuild — the tree it would have been in no
  // longer exists. That case is caught here instead, and `.refine` and
  // `.superRefine` have no homonym in this codebase, so the reading is exact.
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
      for (const construct of ['.refine(', '.superRefine(', 'z.preprocess(', '.brand(']) {
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
      'no refinement, preprocess or brand is declared anywhere in electron/mcp',
      hits.length === 0,
      hits.length ? `${hits.join('; ')}\n    one of these on an object schema is deleted by closeShape without a word — see the probe above` : ''
    );
    // POSITIVE CONTROL for the scanner itself: it must find something it is
    // looking for, or "no hits" means only that the search was broken.
    const canary = files.filter((f) => fs.readFileSync(f, 'utf8').includes('.optional('));
    check('  and the scanner can find a construct that IS used', canary.length > 0, `${canary.length} files declare .optional(`);
  }

  check('the wire left nothing behind', problems.length === 0, problems.join('; '));

  if (failures.length) {
    console.error(`schema-strictness: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`schema-strictness: ${checked} passed  [every closed object position injected at depth, refused, and proved to dispatch nothing]`);
})().catch((err) => {
  if (failures.length) console.error(`schema-strictness: ${failures.length} of ${checked} had already failed\n${failures.join('\n')}`);
  console.error('schema-strictness: threw\n', err?.stack || err);
  process.exit(1);
});
