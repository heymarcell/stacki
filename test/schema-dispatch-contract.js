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

const { DOMAINS, actionsOf, find } = require('../electron/mcp/agent/registry.js');
const { NORMALIZE } = require('../electron/mcp/agent/index.js');
const { DOMAINS: DISPATCH } = require('../electron/mcp/agent/domains.js');
const { answer } = require('../electron/mcp/agentTools.js');
const { createContextStore } = require('../electron/mcp/contextStore.js');
const { createCapture } = require('../electron/mcp/capture.js');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');
const { startWireRig } = require('./support/mcpWireRig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 300) => JSON.stringify(v ?? null).slice(0, n);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const OPERATIONS = [];
for (const domain of DOMAINS) for (const action of actionsOf(domain)) OPERATIONS.push({ domain, action, op: find(domain, action) });

// ── the size of the surface ──────────────────────────────────────────────────
//
// Named here because every other number in the product is derived from it: the
// coverage doc, the 444 permission answers, get_capabilities. A change to it is
// a decision, and this is where the decision has to be made deliberately.
check('the surface is eight domains', DOMAINS.length === 8, DOMAINS.join(', '));
check('and exactly 111 operations', OPERATIONS.length === 111, String(OPERATIONS.length));

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
        check(`${tool.name} answers within its own declared output schema`, verdict.valid === true, `${verdict.errorMessage || ''}\n    ${short(res?.structuredContent)}`);
      }
      check(
        'every tool the wire can grade was graded',
        graded === PRODUCT_TOOLS.length - SUBSTITUTED.length,
        `${graded} of ${PRODUCT_TOOLS.length - SUBSTITUTED.length}`
      );

      // get_context, off the wire: the shipping store, fed the App's own
      // published payload, against the schema get_context publishes.
      {
        const schema = tools.get('get_context')?.outputSchema;
        const store = createContextStore({ resolveTrail: (keys) => rig.harness.resolveTrail(keys) });
        const cold = await verdictOf(schema, store.read());
        check('the cold-start snapshot validates against the schema get_context publishes', cold.valid === true, cold.errorMessage || '');
        store.publish(rig.harness.payload());
        const live = await verdictOf(schema, store.read());
        check('  and so does the snapshot minted from the App’s real payload', live.valid === true, `${live.errorMessage || ''}\n    ${short(store.read())}`);
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
  } finally {
    const said = await rig.stop();
    problems.push(...(said?.problems || []));
  }

  // Cleanup failure is test failure.
  check('the rig left nothing behind', problems.length === 0, problems.join('; '));

  if (failures.length) {
    console.error(`schema-dispatch-contract: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`schema-dispatch-contract: ${checked} passed  [${OPERATIONS.length} operations: schema, registry, dispatch and the shape of every refusal]`);
})().catch((err) => {
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
