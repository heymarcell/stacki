// The three tables that describe one surface, held against each other.
//
//   node test/schema-dispatch-contract.js
//
// An operation exists in three places and no two of them are the same file:
//
//   the SCHEMA     electron/mcp/agentTools.js — what a client is told it may
//                  send, and the only thing a client can read.
//   the REGISTRY   electron/mcp/agent/registry.js — what it costs, where it
//                  runs, whether undo reaches it. get_capabilities and the
//                  coverage doc are generated from it.
//   the DISPATCH   electron/mcp/agent/domains.js and index.js — the arguments
//                  actually read on the way to the handler.
//
// Nothing checked that they agreed, and two things had already drifted:
//
//   `prepend_child` was in the dispatcher's NORMALIZE table, implemented in
//   src/modelOps.js, and in neither the batch `Operation` union nor the
//   registry — an operation no client could name, reachable only from inside
//   the process. Three tables described the same set and one had an extra
//   member.
//
//   Every argument mistake on all eight domain tools came back as a raw host
//   sentence with no structuredContent, because the SDK validates `tools/call`
//   input BEFORE the handler runs and a failure there is a protocol error. The
//   handler's own refusal shaping was never reached, so `{ok:false, code, …}`
//   — the thing the whole surface is built on — did not exist for the 73
//   operations that declare a required argument. Fixing that for the eight
//   DOMAIN tools left six of the fourteen PUBLISHED ones still answering with
//   the raw sentence, `capture` and `comment` among them — so the sweep runs
//   over the published tools rather than over the registry, and over a wire
//   held equal to what the product composes rather than over the rig's own
//   idea of the surface. `audit` was the sixth, and it survived a sweep that
//   claimed to cover every tool because the rig did not publish it.
//
//   And a declared OUTPUT schema that nothing validates is decoration. The
//   audit tool shipped three fields its own schema rejected; a strict client
//   hard-fails on that, because the SDK refuses the whole call with "Output
//   validation error" and the agent gets no answer at all rather than a wrong
//   one. Every tool's answer is checked against the schema that tool publishes.
//
// This file is what stops either coming back under a different operation. It
// reads the SHIPPING TABLES and the REAL tools/list, never a typed list, so
// nothing here can be satisfied by writing an operation's name down somewhere.
//
// THE WIRE HALF RUNS AT `visual`, the level that allows nothing. Every one of
// the 111 operations is called, and at that level a well-formed call is refused
// by the gate and a malformed one by the argument check — so the sweep proves
// the shape of both answers without executing a single operation against the
// fixture.
//
// AND THEN A SECOND WIRE RUNS AT `full`, because the first one cannot grade a
// success and had been read as though it could. Every answer the `visual` sweep
// validates is a REFUSAL — twelve of them, all `permission_denied` or
// `bad_arguments` — and a refusal carries none of the fields a mutation
// answers with. `changedFiles`, `notes`, `through`, `documentBefore` and
// `revisionAfter` are declared in the Envelope and were reached by nothing:
// no SUCCESS from any mutating operation in this repository was ever held
// against the schema its tool publishes. The defect class that leaves open is
// named in test/audit-schema-conformance.js — "a field DECLARED as an array
// and emitted as a number" — and it has shipped, in `git`: a whole-tree
// restore answered a COUNT on `changedFiles`, the SDK refused the call for
// failing its own output schema, and the agent was told a destructive
// operation had failed WHILE THE WORKING TREE HAD IN FACT BEEN RESTORED. So
// the second wire runs one mutation per mutating tool at a level where it
// really runs, proves on disk that it really ran, and validates the success
// envelope with the same validator.

const { DOMAINS, actionsOf, find } = require('../electron/mcp/agent/registry.js');
const { NORMALIZE } = require('../electron/mcp/agent/index.js');
const { DOMAINS: DISPATCH } = require('../electron/mcp/agent/domains.js');
const { answer } = require('../electron/mcp/agentTools.js');
const { createContextStore } = require('../electron/mcp/contextStore.js');
const { buildIdentity } = require('../electron/buildInfo.js');
const { createCapture } = require('../electron/mcp/capture.js');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');
const { startWireRig } = require('./support/mcpWireRig.js');
const { guardSuite } = require('./support/suiteGuard.js');

// A HANG MUST NOT REPORT A PASS. This suite drives a real MCP wire and awaits a
// reply for every operation in the registry; a server that stops answering one
// of them leaves an await nobody settles, and node exits 0 on an empty event
// loop — so the run would print nothing after the last operation it reached and
// be recorded as a pass of the whole contract. See test/support/suiteGuard.js.
const suiteDone = guardSuite('schema-dispatch-contract');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 300) => JSON.stringify(v ?? null).slice(0, n);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * EVERY KEY THE `visual` WIRE EVER PUT ON AN ENVELOPE.
 *
 * Filled by the two sweeps below — the 111-operation one and the per-tool
 * grading one — and read by the mutation sweep at the bottom, which asserts
 * that the fields it grades are fields NONE of those refusals reached. That is
 * the whole of finding 63 stated as something falsifiable: without it, "every
 * tool answers within its own declared output schema" reads like coverage of
 * the surface and is coverage of the refusal branch.
 */
const refusalKeys = new Set();
/** Record what an answer carried, so the claim above is measured and not asserted. */
const noteKeys = (into, value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const k of Object.keys(value)) into.add(k);
};

const OPERATIONS = [];
for (const domain of DOMAINS) for (const action of actionsOf(domain)) OPERATIONS.push({ domain, action, op: find(domain, action) });

// ── the size of the surface ──────────────────────────────────────────────────
//
// Named here because every other number in the product is derived from it: the
// coverage doc, the 444 permission answers, get_capabilities. A change to it is
// a decision, and this is where the decision has to be made deliberately.
check('the surface is eight domains', DOMAINS.length === 8, DOMAINS.join(', '));
check('and exactly 112 operations', OPERATIONS.length === 112, String(OPERATIONS.length));

// ── the one function every answer in this surface goes through ───────────────
//
// `answer()` is where an envelope becomes an MCP result, and it now has a
// second channel for the answers that are partly a picture. A client can only
// SEE an image if it arrives as an image block; base64 inside the JSON string
// is a string. Asserted on the blocks themselves rather than on the option
// being accepted, because accepting an option is not sending anything.
{
  const plain = answer({ ok: true, thing: 1 });
  check('an answer with no pictures is one text block', plain.content.length === 1 && plain.content[0].type === 'text', short(plain.content));
  check('  carrying the whole envelope', JSON.parse(plain.content[0].text).thing === 1, short(plain.content[0].text));

  const withImages = answer({ ok: true, thing: 1 }, { images: [{ data: 'QUJD', mimeType: 'image/jpeg' }, { data: 'REVG' }] });
  check('images arrive as image blocks', withImages.content.filter((c) => c.type === 'image').length === 2, short(withImages.content));
  check('  before the text, so a host that shows one block shows the picture', withImages.content[0]?.type === 'image', short(withImages.content.map((c) => c?.type)));
  check('  with the bytes and type they were given', withImages.content[0]?.data === 'QUJD' && withImages.content[0]?.mimeType === 'image/jpeg', short(withImages.content[0]));
  check('  defaulting the type rather than sending none', withImages.content[1]?.mimeType === 'image/png', short(withImages.content[1]));
  check('  and the envelope is still the last block, unchanged', JSON.parse(withImages.content.at(-1)?.text || '{}').thing === 1, short(withImages.content.at(-1)));
  check('  and still the structured content', withImages.structuredContent?.thing === 1, short(withImages.structuredContent));

  const empty = answer({ ok: true }, { images: [{ data: '' }, null, { mimeType: 'image/png' }] });
  check('an image with no bytes is not sent as an empty one', empty.content.every((c) => c.type === 'text'), short(empty.content));

  const compact = answer({ ok: true, thing: 1 }, { spaces: 0, images: [{ data: 'QUJD' }] });
  check('the two channels are independent', compact.content[0]?.type === 'image' && !String(compact.content[1]?.text ?? '\n').includes('\n'), short(compact.content[1]?.text));
}

/** The `action` a schema branch is for, from the branch's own const. */
const actionOf = (branch) => branch?.properties?.action?.const ?? branch?.properties?.action?.enum?.[0] ?? null;
const branchesOf = (schema) => schema?.anyOf || schema?.oneOf || (schema ? [schema] : []);

/**
 * How many tools the PRODUCT publishes, counted by the product's own composer.
 *
 * The sweep below used to compare itself against `tools/list` on this wire,
 * which meant "every tool this rig happens to publish" — and the rig only
 * registers `audit` when the caller hands one over, which this suite did not.
 * So the one tool the header is about was in neither the bad-argument sweep nor
 * the output grading, and the guard that was supposed to notice could not: the
 * numerator and the denominator were the same list.
 *
 * `registerTools` is the function electron/mcp/server.js calls to compose the
 * surface, given here exactly what electron/mcp/index.js gives it — an api and
 * an audit — and handed a server that records names and offers nothing else. A
 * fifteenth tool registered anywhere it reaches is counted the day it lands,
 * and a rig that then fails to publish it is caught rather than believed.
 */
function productToolNames() {
  const names = [];
  const recorder = {
    registerTool: (name) => {
      names.push(name);
      return { name };
    },
    // Not the tool surface, but registerTools composes the whole endpoint and
    // both are registered on the way past. Recorded rather than ignored so a
    // resource that starts calling registerTool is not silently a tool.
    registerResource: () => ({}),
    registerPrompt: () => ({}),
  };
  require('../electron/mcp/tools.js').registerTools(recorder, {
    getContext: async () => ({}),
    capture: async () => ({}),
    getComments: async () => ({}),
    comment: async () => ({}),
    api: { run: async () => ({}), capabilities: () => ({}), checkAccess: () => null },
    audit: async () => ({}),
  });
  return names;
}

(async () => {
  // `visual` allows nothing, so the whole sweep below can call every operation
  // — including the ones that install packages, start servers and talk to
  // remotes — without any of them running.
  //
  // WITH AN AUDIT, because the product ships with one. test/support/mcpWireRig.js
  // says it at the option: "A rig that omits it serves a 13-tool surface nobody
  // has, which is how the agent benchmark came to measure a server that does not
  // exist." The stub never runs here — at `visual` the gate refuses `audit.run`
  // before the handler, and a malformed call is refused before that — so what is
  // measured is the tool's registration, which is the thing that was wrong.
  const rig = await startWireRig({
    era: 'modern',
    agentMode: 'visual',
    audit: async () => ({ ok: true, route: '/', findingCount: 0, returnedFindingCount: 0, findings: [] }),
  });
  const problems = [];
  try {
    const listed = await rig.client.listTools();
    const tools = new Map(listed.tools.map((t) => [t.name, t]));

    // ── this wire is the product's surface, not a subset of it ───────────────
    const PRODUCT_TOOLS = productToolNames();
    check('the product composes fourteen tools', PRODUCT_TOOLS.length === 14, PRODUCT_TOOLS.join(', '));
    check(
      'and this wire publishes exactly those, so the sweep below is over the real surface',
      same(PRODUCT_TOOLS, listed.tools.map((t) => t.name)),
      `product: ${PRODUCT_TOOLS.join(', ')}\n    wire: ${listed.tools.map((t) => t.name).join(', ')}`
    );

    // ── the schema and the registry describe the same set ────────────────────
    const advertised = new Map();
    for (const domain of DOMAINS) {
      const tool = tools.get(domain);
      if (!check(`the ${domain} tool is published`, !!tool, short(listed.tools.map((t) => t.name)))) continue;
      const branches = branchesOf(tool.inputSchema);
      const named = branches.map(actionOf);
      check(
        `every published ${domain} branch names exactly one action`,
        named.every((a) => typeof a === 'string' && a),
        short(named)
      );
      check(
        `${domain}'s published actions are the registry's`,
        same(named.filter(Boolean), actionsOf(domain)),
        `schema: ${named.join(', ')}\n    registry: ${actionsOf(domain).join(', ')}`
      );
      check(`${domain} publishes no branch twice`, new Set(named).size === named.length, short(named));
      for (const branch of branches) if (actionOf(branch)) advertised.set(`${domain}.${actionOf(branch)}`, branch);
    }

    // ── the three tables that describe target's operations ───────────────────
    //
    // The batch `Operation` union, the dispatcher's NORMALIZE table, and the
    // registry's target writes. All three are read from what ships.
    {
      const targetTool = tools.get('target');
      const editBranch = branchesOf(targetTool?.inputSchema).find((b) => actionOf(b) === 'edit');
      const union = branchesOf(editBranch?.properties?.operations?.items).map((b) => b?.properties?.type?.const).filter(Boolean);
      // `edit` is the batch itself rather than a member of it, so it is the one
      // target write with no `Operation` type of its own.
      const registryWrites = actionsOf('target').filter((a) => a !== 'edit' && find('target', a).risk !== 'read');
      check('the batch operation union is not empty', union.length > 0, short(union));
      check(
        'the dispatcher normalises exactly the operations the batch schema publishes',
        same(Object.keys(NORMALIZE), union),
        `NORMALIZE: ${Object.keys(NORMALIZE).sort().join(', ')}\n    schema:    ${[...union].sort().join(', ')}`
      );
      check(
        'and exactly the target writes the registry has',
        same(Object.keys(NORMALIZE), registryWrites),
        `NORMALIZE: ${Object.keys(NORMALIZE).sort().join(', ')}\n    registry:  ${[...registryWrites].sort().join(', ')}`
      );
    }

    // ── what the dispatcher reads, against what the schema offers ────────────
    //
    // Not a grep: every main-table `args` and `result` mapper is CALLED with a
    // recording Proxy in place of the arguments, and the keys it really touched
    // are compared with the branch its client is shown. A mapper that reads
    // `input.locator` the schema never offers, or the historical `edits`
    // declared as an object, is what this catches.
    const ctx = {
      root: rig.root,
      branch: 'main',
      devUrl: null,
      payload: null,
      callMain: async () => ({}),
      sourceRef: () => null,
      refObservation: () => ({ digest: null }),
      writeText: async () => ({ through: {} }),
    };
    for (const { domain, action } of OPERATIONS) {
      const entry = DISPATCH[domain]?.[action];
      if (!entry || typeof entry !== 'object' || typeof entry.args !== 'function') continue;
      const read = new Set();
      const recorder = new Proxy(
        {},
        {
          get: (_t, key) => {
            if (typeof key === 'string') read.add(key);
            return undefined;
          },
          has: (_t, key) => {
            if (typeof key === 'string') read.add(key);
            return false;
          },
        }
      );
      try {
        await entry.args(recorder, ctx);
      } catch {
        /* a mapper that throws on undefined arguments still recorded what it
           reached for, which is the whole question */
      }
      if (typeof entry.result === 'function') {
        try {
          entry.result({}, recorder, ctx);
        } catch {
          /* same */
        }
      }
      const offered = new Set(Object.keys(advertised.get(`${domain}.${action}`)?.properties || {}));
      const undeclared = [...read].filter((k) => !offered.has(k));
      check(
        `${domain}.${action} reads only arguments its own schema offers`,
        undeclared.length === 0,
        undeclared.length ? `reads ${undeclared.join(', ')}; offers ${[...offered].join(', ') || '(nothing)'}` : ''
      );
    }

    // ── EVERY operation answers in Stacki's own shape ────────────────────────
    //
    // Two calls each. One deliberately malformed, which must be Stacki's
    // `bad_arguments` naming the field; one well-formed, which at `visual` must
    // be Stacki's `permission_denied`. Neither may be a raw transport sentence,
    // which is what all 73 operations with a required argument used to give.
    const WRONG = { string: {}, number: 'not a number', integer: 'not a number', boolean: 'not a boolean', array: 'not a list', object: 'not an object' };
    /** A property of this branch that can be given a value of the wrong type. */
    const spoilable = (branch) => {
      const props = Object.entries(branch?.properties || {}).filter(([k]) => k !== 'action');
      const required = new Set(branch?.required || []);
      // A required one first: that is the failure a real agent hits.
      const ordered = [...props].sort((a, b) => Number(required.has(b[0])) - Number(required.has(a[0])));
      for (const [name, spec] of ordered) {
        const type = Array.isArray(spec?.type) ? spec.type[0] : spec?.type;
        if (type && WRONG[type] !== undefined) return { name, value: WRONG[type] };
      }
      return null;
    };

    let spoiled = 0;
    for (const { domain, action } of OPERATIONS) {
      const branch = advertised.get(`${domain}.${action}`);
      if (!branch) continue;

      // (1) the well-formed call. It runs nothing: `visual` allows nothing.
      {
        const res = await rig.client.callTool({ name: domain, arguments: { action } });
        let parsed = null;
        try {
          parsed = JSON.parse(String(res?.content?.[0]?.text));
        } catch {
          /* a raw host sentence is not JSON, which is the complaint */
        }
        noteKeys(refusalKeys, res?.structuredContent);
        check(`${domain}.${action} answers with structured content`, !!res?.structuredContent, short(res?.content?.[0]?.text));
        check(`  ${domain}.${action}: the text block is the same payload`, !!parsed && parsed.ok === false, short(res?.content?.[0]?.text));
        check(`  ${domain}.${action}: with a code a client can branch on`, typeof parsed?.code === 'string' && parsed.code.length > 0, short(parsed?.code));
        check(
          `  ${domain}.${action}: refused by the gate, since visual allows nothing`,
          parsed?.code === 'permission_denied' || parsed?.code === 'bad_arguments',
          short(parsed)
        );
      }

      // (2) the malformed one, where the branch offers anything to get wrong.
      const spoil = spoilable(branch);
      if (!spoil) continue;
      spoiled += 1;
      const res = await rig.client.callTool({ name: domain, arguments: { action, [spoil.name]: spoil.value } });
      let parsed = null;
      try {
        parsed = JSON.parse(String(res?.content?.[0]?.text));
      } catch {
        /* see above */
      }
      noteKeys(refusalKeys, res?.structuredContent);
      check(`${domain}.${action} with a bad ${spoil.name} is a Stacki refusal`, !!res?.structuredContent && parsed?.ok === false, short(res?.content?.[0]?.text));
      check(`  ${domain}.${action}: as bad_arguments`, parsed?.code === 'bad_arguments', short(parsed?.code));
      check(`  ${domain}.${action}: naming the operation`, parsed?.operation === `${domain}.${action}`, short(parsed?.operation));
      check(
        `  ${domain}.${action}: and the field that is wrong`,
        (parsed?.issues || []).some((i) => Array.isArray(i.path) && i.path[0] === spoil.name),
        short(parsed?.issues)
      );
    }
    check('most of the surface had something to get wrong', spoiled > 80, `${spoiled} of ${OPERATIONS.length}`);

    // ── EVERY PUBLISHED TOOL, not only the eight domains ─────────────────────
    //
    // The sweep above is over the registry's 111 operations, which are reached
    // through eight of the fourteen tools this server publishes. The other six
    // — get_context, capture, get_comments, comment, get_capabilities, audit —
    // were never in it, and every one of them still answered a mistyped
    // argument with the host's own sentence, no structuredContent, nothing to
    // branch on:
    //
    //   capture {target: 12345}
    //     -> "Input validation error: Invalid arguments for tool capture:
    //         target: Invalid option: expected one of "selection"|"viewport""
    //
    // `capture` and `comment` are the two tools the `visual` level exists for,
    // so that was the first shape an agent at the lowest level could hit.
    //
    // `audit` is the one this suite could not see. It was fixed for five of the
    // six and missed on the sixth, and the guard below said "every published
    // tool" while driving a rig that published thirteen — the tool the header
    // of this file is about was in neither the sweep nor the grading. Driving
    // off tools/list is not enough on its own; what the wire lists is held
    // against what the product composes, up at PRODUCT_TOOLS.
    {
      /** The action a top-level tool has none of, and a domain tool needs. */
      const openingFor = (tool) => {
        for (const branch of branchesOf(tool.inputSchema)) {
          const spoil = spoilable(branch);
          if (!spoil) continue;
          const action = actionOf(branch);
          return {
            bad: { ...(action ? { action } : {}), [spoil.name]: spoil.value },
            field: spoil.name,
          };
        }
        return null;
      };

      let swept = 0;
      for (const tool of listed.tools) {
        const opening = openingFor(tool);
        if (!check(`${tool.name} publishes an argument that can be got wrong`, !!opening, short(tool.inputSchema, 200))) continue;
        swept += 1;
        const res = await rig.client.callTool({ name: tool.name, arguments: opening.bad });
        const said = res?.structuredContent;
        check(
          `${tool.name} answers a bad ${opening.field} with structured content`,
          !!said,
          short(res?.content?.[0]?.text)
        );
        check(`  ${tool.name}: as Stacki's own refusal, not a host sentence`, said?.ok === false && said?.code === 'bad_arguments', short(said?.code ?? res?.content?.[0]?.text));
        check(`  ${tool.name}: naming the field that is wrong`, (said?.issues || []).some((i) => Array.isArray(i.path) && i.path[0] === opening.field), short(said?.issues));
      }
      // Against the PRODUCT's count, not this wire's. The two are held equal a
      // few dozen lines up; saying it again here is what stops a rig that
      // quietly stops publishing something from taking the guard with it.
      check(
        'the sweep covered every published tool',
        swept === PRODUCT_TOOLS.length && swept === listed.tools.length,
        `${swept} of ${listed.tools.length} on the wire, ${PRODUCT_TOOLS.length} in the product: ${listed.tools.map((t) => t.name).join(', ')}`
      );

      // AND THE SHIM DID NOT BUY IT BY LOOSENING THE SCHEMA. `advertised()`
      // publishes the real schema and makes the host's own validation a
      // pass-through; a version of it that published something laxer would
      // stop the raw sentence by making the argument legal, which is the
      // opposite of the fix. So the constraint each of these tools used to
      // refuse with is read back off the wire.
      const PUBLISHED = [
        ['get_context', 'styleDetail', ['none', 'essential', 'full']],
        ['capture', 'target', ['selection', 'viewport']],
        ['get_comments', 'scope', ['project', 'page', 'selection']],
        ['comment', 'action', ['create', 'reply', 'focus', 'resolve', 'defer', 'reopen']],
      ];
      for (const [name, field, values] of PUBLISHED) {
        const spec = tools.get(name)?.inputSchema?.properties?.[field];
        check(`${name} still publishes ${field} as the enum it refuses on`, same(spec?.enum || [], values), short(spec));
      }
    }

    // ── WHAT A TOOL ANSWERS, AGAINST WHAT IT DECLARED ────────────────────────
    //
    // Validated with the SDK's OWN validator — the same one the endpoint uses
    // to decide whether to hand the client an answer or a protocol error — so
    // this cannot pass on a second implementation's more forgiving reading.
    {
      const validator = new AjvJsonSchemaValidator();
      const verdictOf = async (schema, payload) =>
        payload === undefined || payload === null
          ? { valid: false, errorMessage: 'no structuredContent' }
          : validator.getValidator(schema)(payload);

      // TWO OF THE THIRTEEN ARE NOT THE PRODUCT ON THIS WIRE.
      // test/support/mcpWireRig.js substitutes its own implementations for the
      // app's two canvas tools: `getContext` hands back the App's RAW renderer
      // payload rather than the snapshot contextStore mints from it (no
      // revision, no timestamp, `present` where the schema says `status`), and
      // `capture` answers a meta with `view: null` because the harness has no
      // canvas. Grading those two on this wire would grade the rig. So the
      // SHIPPING implementations are graded instead, in this process, against
      // the very schemas tools.js publishes for them — which is the stronger
      // measurement anyway: contextStore is fed the App's real payload.
      const SUBSTITUTED = ['get_context', 'capture'];
      check('the two tools the rig substitutes are still published', SUBSTITUTED.every((n) => tools.has(n)), short([...tools.keys()]));

      // AND THE FOURTEENTH IS GRADED LIKE THE REST, which is only possible
      // because its schema was written to make it possible: `audit` is the one
      // tool here with a strict payload schema, at `visual` every call it gets
      // is a gate refusal, and AuditOutput DECLARES the four fields
      // permissions.refusal() carries rather than stripping them. So the
      // refusal an agent at the lowest level actually receives is inside the
      // schema that tool published, and the loop below can say so. Asserted
      // here, separately, because "it graded" and "it graded a refusal from the
      // gate" are different facts and the loop only proves the first.
      {
        const res = await rig.client.callTool({ name: 'audit', arguments: {} });
        const said = res?.structuredContent;
        check('audit at visual is refused by the gate', said?.ok === false && said?.code === 'permission_denied', short(said));
        check('  and the client is told it failed rather than being handed a wrong answer', res?.isError === true, short({ isError: res?.isError }));
        const verdict = await verdictOf(tools.get('audit')?.outputSchema, said);
        check('  and that refusal validates against the schema audit publishes', verdict.valid === true, `${verdict.errorMessage || ''}\n    ${short(said)}`);
      }

      let graded = 0;
      for (const tool of listed.tools) {
        if (SUBSTITUTED.includes(tool.name)) continue;
        if (!check(`${tool.name} declares an output schema`, !!tool.outputSchema, tool.name)) continue;
        const branch = branchesOf(tool.inputSchema)[0];
        const action = actionOf(branch);
        const res = await rig.client.callTool({ name: tool.name, arguments: action ? { action } : {} });
        const verdict = await verdictOf(tool.outputSchema, res?.structuredContent);
        graded += 1;
        // WHAT WAS ACTUALLY GRADED, recorded rather than described. Every one
        // of these is a refusal — this wire is at `visual` — and the mutation
        // sweep at the bottom of the file holds its own successes against this
        // set to show which declared fields nothing here can reach.
        noteKeys(refusalKeys, res?.structuredContent);
        check(`${tool.name} answers within its own declared output schema`, verdict.valid === true, `${verdict.errorMessage || ''}\n    ${short(res?.structuredContent)}`);
      }
      check(
        'every tool the wire can grade was graded',
        graded === PRODUCT_TOOLS.length - SUBSTITUTED.length,
        `${graded} of ${PRODUCT_TOOLS.length - SUBSTITUTED.length}`
      );

      // get_context, off the wire: the shipping store, fed the App's own
      // published payload, against the schema get_context publishes.
      //
      // `build` is the other half of that answer and it is attached by the tool
      // handler rather than by the store (electron/mcp/tools.js), so a caller
      // grading the store's output alone is grading a fragment. Put together
      // the way a client receives them.
      {
        const schema = tools.get('get_context')?.outputSchema;
        const answer = (snapshot) => ({ ...snapshot, build: buildIdentity() });
        const store = createContextStore({ resolveTrail: (keys) => rig.harness.resolveTrail(keys) });
        const cold = await verdictOf(schema, answer(store.read()));
        check('the cold-start snapshot validates against the schema get_context publishes', cold.valid === true, cold.errorMessage || '');
        store.publish(rig.harness.payload());
        const live = await verdictOf(schema, answer(store.read()));
        check('  and so does the snapshot minted from the App’s real payload', live.valid === true, `${live.errorMessage || ''}\n    ${short(answer(store.read()))}`);
        // AND IT IS THE APP'S PAYLOAD, not the cold start passing under its
        // name: a store nobody published to knows no project and no page, so a
        // validator that only ever sees `{root: null}` has proved nothing.
        check('  which is really the App’s payload and not the cold start again', typeof store.read().project?.root === 'string' && !!store.read().page?.file, short(store.read().project));
        check('  with the selection the App has, described', store.read().selection?.status !== 'no_project' && !!store.read().selection?.tag, short(store.read().selection?.tag));

        // capture, off the wire: the shipping implementation with no window,
        // which is the answer a real client gets when Stacki is not showing
        // anything — meta and no picture, never a bare refusal.
        const capture = createCapture({ getWindow: () => null, ask: async () => null, readSnapshot: () => store.read() });
        const shot = await capture({ target: 'selection', paddingPx: 48, format: 'png' });
        const meta = await verdictOf(tools.get('capture')?.outputSchema, shot?.meta);
        check('capture’s own meta validates against the schema capture publishes', meta.valid === true, `${meta.errorMessage || ''}\n    ${short(shot?.meta)}`);
      }
    }

    // ── AN ARGUMENT THAT BELONGS TO ANOTHER ACTION ───────────────────────────
    //
    // Every branch of every domain schema is closed. It used not to be, and a
    // `z.object()` STRIPS a key it does not know — which on a surface where
    // most arguments are optional and several operations fall back to a
    // sensible default for the one you left out is not tidiness but a silent
    // retarget.
    //
    // These four were measured at ac57c20 being accepted with `ok: true` and
    // doing something other than what was asked. Two are `high` risk and one
    // is destructive. They are written out by name rather than generated,
    // because the point is these specific misdirections and not the general
    // property — and each asserts that the operation did NOT run, which is the
    // half that matters: a refusal that arrives after the work is not a
    // refusal.
    //
    // `visual` refuses all of them at the gate anyway, which is exactly why
    // the code matters: `bad_arguments` proves the SCHEMA stopped it, while
    // `permission_denied` would prove only that this rig is at the lowest
    // level.
    {
      const retargets = [
        ['git', 'restore_file', { path: 'src/pages/index.astro', rev: 'abc123' }, 'rev', 'restores from HEAD instead of the named revision'],
        ['git', 'push', { branchName: 'feature-x' }, 'branchName', 'pushes the CURRENT branch instead of the named one'],
        ['target', 'remove', { target: 'refrefrefrefrefref' }, 'target', "removes the person's live SELECTION instead of the ref"],
        ['project', 'probe', { route: '/pricing' }, 'route', 'probes the preview root instead of the named route'],
      ];
      for (const [tool, action, args, key, wouldHave] of retargets) {
        const { envelope: env } = await rig.call(tool, action, args);
        check(
          `${tool}.${action} with a mistyped \`${key}\` is refused`,
          env?.ok === false,
          short(env)
        );
        check(
          `  as bad_arguments — the schema stopped it, not the gate (else it ${wouldHave})`,
          env?.code === 'bad_arguments',
          short({ code: env?.code, message: env?.message })
        );
        check(`  and the message names ${key}`, String(env?.message || '').includes(key), short(env?.message));
      }

      // AND THE SAME ONE LEVEL DOWN. `edit` takes a batch of operations, each
      // its own discriminated union on `type`; closing the outer schema and
      // leaving the inner one open would refuse the easy case and keep the
      // hard one.
      const { envelope: nested } = await rig.call('target', 'edit', {
        ref: 'refrefrefrefrefref',
        operations: [{ type: 'add_class', className: 'x', value: 'belongs to set_text' }],
      });
      check('a foreign key inside one operation of an edit batch is refused', nested?.ok === false, short(nested));
      check('  as bad_arguments', nested?.code === 'bad_arguments', short({ code: nested?.code }));
      check(
        '  naming the operation it was in',
        /operations\.0/.test(String(nested?.message || '')),
        short(nested?.message)
      );

      // POSITIVE CONTROLS. Without these, a surface that refused every call
      // would satisfy everything above. Both use the right spelling of the
      // same argument, and both must get past the schema — at `visual` they
      // are then refused by the GATE, which is a different code and is the
      // proof that the schema let them through.
      const { envelope: spelled } = await rig.call('git', 'restore_file', { path: 'src/pages/index.astro', ref: 'abc123' });
      check(
        'the same call with `ref` spelled right gets past the schema',
        spelled?.code !== 'bad_arguments',
        short({ code: spelled?.code, message: spelled?.message })
      );
      const { envelope: batch } = await rig.call('target', 'edit', {
        ref: 'refrefrefrefrefref',
        operations: [{ type: 'add_class', className: 'x' }],
      });
      check(
        'and a well-formed edit batch gets past it too',
        batch?.code !== 'bad_arguments',
        short({ code: batch?.code, message: batch?.message })
      );
    }

  } finally {
    const said = await rig.stop();
    problems.push(...(said?.problems || []));
  }

  // ── WHAT A MUTATION ANSWERS, AGAINST WHAT ITS TOOL DECLARED ────────────────
  //
  // THE HALF THE SWEEP ABOVE CANNOT SEE.
  //
  // "every tool the wire can grade was graded" is true and it is twelve
  // refusals. `visual` is the level that allows nothing, so every answer that
  // loop validates is `permission_denied` or `bad_arguments` — and a refusal
  // carries `ok`, `code`, `message`, `operation`, `issues` and very little
  // else. The Envelope declares a great deal more than that, and all of it
  // belongs to the answers a mutation gives: `changedFiles`, an ARRAY of
  // `{file, beforeDigest, afterDigest, patch:{hunks:[{at,text}], linesAdded,
  // linesRemoved}}`; `notes`, an array of strings; `through`, an enum of
  // exactly `editor|disk`; `documentBefore`/`document`; `revisionBefore`/
  // `revisionAfter`, integers. None of it was ever validated against anything,
  // on any wire, in any suite: the four successes in test/agent-api.js are
  // read-only, and this file's grading loop is at `visual`.
  //
  // WHICH IS THE EXACT SHAPE OF A DEFECT THAT HAS SHIPPED. `git.restore_project`
  // answers a COUNT of restored files — naming every file of a whole-tree
  // restore is the one thing this API promises not to send — and it landed on
  // `changedFiles`, which the schema declares as an array. The SDK validates
  // structured output, so it refused the whole call: `isError: true`, no
  // structuredContent, no envelope, and an agent told that a destructive
  // operation had failed WHILE THE WORKING TREE HAD ALREADY BEEN RESTORED. The
  // guard for it is `ownChangedFiles` in electron/mcp/agent/index.js, and
  // measured here on 2026-09-07 by removing it: every check in this file still
  // passed, 1041 of 1041, exit 0, while `git.restore_project` over a real
  // client answered nothing at all.
  //
  // So this wire runs at `full`, which allows everything, and every mutating
  // tool answers a real success against the real fixture. Each one is asserted
  // three ways: it SUCCEEDED (`ok:true`, and the client was handed a result
  // rather than an isError), it really HAPPENED (read off disk, or back off the
  // wire — a success that changed nothing would validate perfectly), and the
  // envelope it answered with VALIDATES against the schema its tool publishes.
  {
    // A SECOND RIG, STARTED AFTER THE FIRST HAS STOPPED, never beside it.
    // test/agent-harness.js puts its jsdom on the process globals, and two
    // live harnesses would steer one another's documents — the same reason
    // mcpWireRig captures `global.window` at construction time.
    const mutating = await startWireRig({ era: 'modern', agentMode: 'full' });
    const validator = new AjvJsonSchemaValidator();
    const gradeAgainst = (schema, payload) =>
      payload === undefined || payload === null
        ? { valid: false, errorMessage: 'no structuredContent' }
        : validator.getValidator(schema)(payload);

    try {
      const listedFull = await mutating.client.listTools();
      const fullTools = new Map(listedFull.tools.map((t) => [t.name, t]));

      // THE MUTATING SURFACE, FROM THE REGISTRY — never a list typed here.
      //
      // This is the completeness gate the header of the section is about. A
      // ninth domain, or a mutating action added to a domain that had none,
      // enters this set the day it lands in registry.js; if the table below
      // has nothing for it, the two checks at the bottom fail. A sweep whose
      // denominator is its own numerator measures nothing, which is how the
      // grading loop above came to be read as covering the surface.
      const MUTATING_TOOLS = DOMAINS.filter((d) => actionsOf(d).some((a) => find(d, a).risk !== 'read'));
      check('every domain in the registry has a mutating operation', MUTATING_TOOLS.length === DOMAINS.length, `${MUTATING_TOOLS.length} of ${DOMAINS.length}: ${MUTATING_TOOLS.join(', ')}`);

      const H = mutating.harness;
      const INDEX = 'src/pages/index.astro';
      const SHEET = 'src/styles/site.css';
      const SITE = 'src/data/site.json';
      const ROBOTS = 'User-agent: *\nDisallow: /wire-graded\n';
      const TEXT = 'Wire-graded text';
      const CLASS = 'wire-graded';
      const HEADER = '// wire-graded\n';
      const flatten = (node, out = []) => {
        if (!node) return out;
        out.push(node);
        for (const child of node.children || []) flatten(child, out);
        return out;
      };
      // A ref for a tag, read fresh EVERY time. A ref carries the revision the
      // read saw and every mutation below bumps it, so a ref held across one
      // is refused as `stale_target` — which is the surface working correctly
      // and would leave this sweep grading refusals again, one level down.
      const refFor = async (tag, within = null) => {
        const { envelope } = await mutating.call('target', 'read', within ? { ref: within } : {});
        const hit = flatten(envelope?.target).find((n) => String(n.tag || '').toLowerCase() === tag);
        return hit?.ref || null;
      };
      const json = (rel) => {
        try {
          return JSON.parse(H.read(rel));
        } catch {
          return null;
        }
      };

      // Carried between steps: the commit `git.restore_project` restores to.
      const state = {};

      // ONE MUTATION PER MUTATING TOOL, in an order that leaves each one able
      // to run. They share a fixture on purpose — a rig apiece would be eight
      // fixtures for eight envelopes — so the order is owned: the two target
      // writes before the undo that takes one back, the git repository seeded
      // after everything else is on disk so the commit has something to hold.
      const MUTATIONS = [
        {
          domain: 'target',
          action: 'set_text',
          args: async () => ({ ref: await refFor('p', await refFor('footer')), text: TEXT }),
          evidence: 'the page on disk says it',
          landed: () => H.read(INDEX).includes(`<p>${TEXT}</p>`) && !H.read(INDEX).includes('Made carefully.'),
        },
        {
          domain: 'target',
          action: 'add_class',
          args: async () => ({ ref: await refFor('div'), className: CLASS }),
          evidence: 'the class is on that div and the one it already had is still there',
          landed: () => /<div class="pricing-grid wire-graded">/.test(H.read(INDEX)),
        },
        {
          domain: 'style',
          action: 'set_property',
          args: async () => ({ ref: await refFor('div'), selector: '.pricing-grid', source: `file:${SHEET}`, property: 'outline', value: '3px solid red' }),
          evidence: 'the declaration is in the stylesheet',
          landed: () => /outline:\s*3px solid red;/.test(H.read(SHEET)),
        },
        {
          domain: 'source',
          action: 'write',
          args: async () => {
            const read = await mutating.call('source', 'read', { path: 'src/lib/format.js' });
            state.source = `${HEADER}${String(read.envelope?.text || '')}`;
            return { path: 'src/lib/format.js', text: state.source, expectedDigest: read.envelope?.digest };
          },
          evidence: 'the file is the bytes that were sent',
          landed: () => H.read('src/lib/format.js') === state.source,
        },
        {
          domain: 'page',
          action: 'create',
          args: async () => ({ name: CLASS, layout: 'Base' }),
          evidence: 'the page exists and is inside the layout it asked for',
          landed: () => H.exists(`src/pages/${CLASS}.astro`) && /<Base[\s/>]/.test(H.read(`src/pages/${CLASS}.astro`)),
        },
        {
          domain: 'content',
          action: 'cms_write',
          args: async () => {
            const read = await mutating.call('content', 'cms_read', { path: SITE });
            return { path: SITE, data: { ...(read.envelope?.data || {}), wireGraded: true }, ref: read.envelope?.ref };
          },
          evidence: 'the entry on disk carries the new field and still carries the old ones',
          landed: () => json(SITE)?.wireGraded === true && typeof json(SITE)?.tagline === 'string',
        },
        {
          domain: 'asset',
          action: 'write_text',
          args: async () => {
            const read = await mutating.call('asset', 'read_text', { path: 'public/robots.txt' });
            // What this write replaces, so the undo below can be graded against
            // the bytes that were actually there rather than a constant.
            state.robotsBeforeWrite = H.read('public/robots.txt');
            return { path: 'public/robots.txt', text: ROBOTS, ref: read.envelope?.ref };
          },
          evidence: 'the file is exactly the text that was sent',
          landed: () => H.read('public/robots.txt') === ROBOTS,
        },
        {
          domain: 'project',
          action: 'undo',
          args: async () => ({}),
          // ONE STEP OFF THE TOP, AND WHICH STEP THAT IS CHANGED.
          //
          // This used to read: cms_write is the last UNDOABLE step above, the
          // asset write answers `undoable: false`, so the field cms_write added
          // is the thing that goes. That was true until 861d319, which found
          // that an asset write "named nothing, so `named` came back empty, the
          // file was never snapshotted, and the write answered undoable: false"
          // -- a real defect -- and set `write_text` to `undoable: true` in the
          // registry. The asset write is now the top of the stack, and this
          // sweep kept grading against the old one.
          //
          // The PROPERTY is unchanged and is what matters: exactly one edit
          // comes off, and the ones beneath it stay. So the asset write must be
          // reverted to the bytes it replaced, and cms_write's field must still
          // be there -- asserting it is GONE would now be asserting that undo
          // took two steps.
          evidence: 'the last undoable edit came back off, and the ones under it did not',
          landed: () =>
            H.read('public/robots.txt') === state.robotsBeforeWrite &&
            json(SITE)?.wireGraded === true &&
            typeof json(SITE)?.tagline === 'string' &&
            H.read(INDEX).includes(TEXT),
        },
        {
          domain: 'git',
          action: 'init',
          args: async () => ({}),
          evidence: 'the project is a repository now',
          landed: () => H.exists('.git'),
        },
        {
          domain: 'git',
          action: 'commit',
          args: async () => ({ message: 'The fixture, as the mutation sweep left it' }),
          evidence: 'git.info reports that commit as HEAD and nothing outstanding',
          landed: async (env) => {
            state.head = env?.head || null;
            const { envelope: info } = await mutating.call('git', 'info', {});
            return !!state.head && info?.head === state.head && info?.dirty === false;
          },
        },
        {
          // THE OPERATION THE WHOLE SECTION IS HERE FOR. This is the one that
          // answers a count where the schema declares an array, and it is the
          // only mutating operation on the surface that does.
          domain: 'git',
          action: 'restore_project',
          args: async () => {
            const read = await mutating.call('asset', 'read_text', { path: 'public/robots.txt' });
            // WHAT THE COMMIT ACTUALLY HOLDS, read here rather than assumed to
            // be ROBOTS. The undo above reverts the asset write before this
            // section commits, so the committed bytes are the ones that write
            // replaced -- and a constant here would be grading the restore
            // against a file state that no longer exists by the time git sees
            // it. This is also the literal wording of the evidence: the file
            // that was dirtied after the commit is the COMMITTED one again.
            state.robotsAtCommit = H.read('public/robots.txt');
            await mutating.call('asset', 'write_text', { path: 'public/robots.txt', text: 'dirtied after the commit\n', ref: read.envelope?.ref });
            if (H.read('public/robots.txt') === state.robotsAtCommit) throw new Error('the tree was not dirtied, so a restore would restore nothing');
            return { ref: state.head };
          },
          evidence: 'the file that was dirtied after the commit is the committed one again',
          landed: () => H.read('public/robots.txt') === state.robotsAtCommit,
        },
      ];

      const succeeded = new Set();
      const successKeys = new Set();
      for (const step of MUTATIONS) {
        const { domain, action } = step;
        const op = `${domain}.${action}`;
        // Not a read wearing a mutation's name. The registry decides.
        check(`${op} is an operation the registry calls a mutation`, find(domain, action)?.risk !== 'read', short(find(domain, action)?.risk));
        const tool = fullTools.get(domain);
        if (!check(`${op}: the ${domain} tool declares an output schema on this wire`, !!tool?.outputSchema, domain)) continue;

        const { envelope, raw } = await mutating.call(domain, action, await step.args());
        check(`${op} SUCCEEDS at full, so there is a success to grade`, envelope?.ok === true, short(envelope));
        check(`  ${op}: and the client is handed a result rather than an isError`, raw?.isError !== true, short({ isError: raw?.isError, text: raw?.content?.[0]?.text }));
        const verdict = gradeAgainst(tool.outputSchema, envelope);
        check(`  ${op}: and that SUCCESS validates against the schema ${domain} publishes`, verdict.valid === true, `${verdict.errorMessage || ''}\n    ${short(envelope)}`);
        // A SUCCESS THAT CHANGED NOTHING VALIDATES PERFECTLY. Without this the
        // sweep could be satisfied by a surface that answered `{ok:true}` to
        // everything, which is the failure mode a schema check cannot see.
        let landed = false;
        try {
          landed = await step.landed(envelope);
        } catch (err) {
          landed = false;
          check(`  ${op}: reading the world back threw`, false, String(err?.message || err));
        }
        check(`  ${op}: and it really happened — ${step.evidence}`, landed === true, '');
        if (envelope?.ok === true && verdict.valid === true && landed === true) {
          succeeded.add(domain);
          noteKeys(successKeys, envelope);
        }
      }

      // ── THE COMPLETENESS GATE, EXTENDED ──────────────────────────────────
      //
      // The one above says every tool the `visual` wire can grade was graded.
      // This says the same thing about the half that wire cannot reach, and it
      // counts a tool as covered only when a call to it SUCCEEDED, VALIDATED
      // and LANDED — so a mutation that quietly starts refusing (a fixture
      // change, a stale ref, a level that stops allowing it) drops its tool out
      // of the set and fails here, rather than reducing the coverage in silence
      // the way `graded` used to when a rig stopped publishing a tool.
      check(
        'every mutating tool is named in the mutation table',
        same(MUTATING_TOOLS, [...new Set(MUTATIONS.map((m) => m.domain))]),
        `registry: ${MUTATING_TOOLS.join(', ')}\n    table:    ${[...new Set(MUTATIONS.map((m) => m.domain))].join(', ')}`
      );
      check(
        'and every one of them answered a graded, landed SUCCESS',
        same(MUTATING_TOOLS, [...succeeded]),
        `registry: ${MUTATING_TOOLS.join(', ')}\n    graded:   ${[...succeeded].sort().join(', ') || '(nothing)'}`
      );

      // ── AND IT GRADED SOMETHING THE REFUSAL SWEEP CANNOT REACH ───────────
      //
      // The argument for this whole section, measured rather than asserted.
      // `refusalKeys` is every key that appeared on ANY envelope the `visual`
      // wire produced — the well-formed call and the spoiled one for all 111
      // operations, and the twelve the grading loop validated. Nothing was
      // sampled: the set is filled where each answer arrives, so it cannot fall
      // behind a sweep that grows. These five fields are declared in
      // the Envelope, are carried only by answers to work that actually ran,
      // and are exactly where a wrong KIND hides — `changedFiles` is the array
      // `git` shipped as a number, `through` is a two-value enum, and
      // `revisionAfter` is an integer.
      const MUTATION_ONLY = ['changedFiles', 'notes', 'through', 'documentBefore', 'revisionAfter'];
      check(
        'no refusal on the visual wire ever carried the fields a mutation answers with',
        MUTATION_ONLY.every((f) => !refusalKeys.has(f)),
        `refusals carried: ${[...refusalKeys].sort().join(', ')}`
      );
      check(
        'and every one of them was on an envelope this sweep graded',
        MUTATION_ONLY.every((f) => successKeys.has(f)),
        `graded successes carried: ${[...successKeys].sort().join(', ')}\n    missing: ${MUTATION_ONLY.filter((f) => !successKeys.has(f)).join(', ') || '(none)'}`
      );
    } finally {
      const said = await mutating.stop();
      problems.push(...(said?.problems || []));
    }
  }

  // Cleanup failure is test failure.
  check('the rig left nothing behind', problems.length === 0, problems.join('; '));

  suiteDone();
  if (failures.length) {
    console.error(`schema-dispatch-contract: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`schema-dispatch-contract: ${checked} passed  [${OPERATIONS.length} operations: schema, registry, dispatch, the shape of every refusal, and one graded success per mutating tool]`);
})().catch((err) => {
  suiteDone();
  // WHAT HAD ALREADY FAILED, BEFORE WHATEVER THREW.
  //
  // A wire that stops publishing a tool fails the surface check at the top and
  // then throws at the first call to the missing tool, and the stack for
  // "Tool audit not found" says nothing about which claim this suite was making
  // when it went. The checks that had already been made are printed first.
  if (failures.length) console.error(`schema-dispatch-contract: ${failures.length} of ${checked} had already failed\n${failures.join('\n')}`);
  console.error('schema-dispatch-contract: threw\n', err?.stack || err);
  process.exit(1);
});
