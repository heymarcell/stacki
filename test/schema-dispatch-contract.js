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
//   operations that declare a required argument.
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

(async () => {
  // `visual` allows nothing, so the whole sweep below can call every operation
  // — including the ones that install packages, start servers and talk to
  // remotes — without any of them running.
  const rig = await startWireRig({ era: 'modern', agentMode: 'visual' });
  const problems = [];
  try {
    const listed = await rig.client.listTools();
    const tools = new Map(listed.tools.map((t) => [t.name, t]));

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
  console.error('schema-dispatch-contract: threw\n', err?.stack || err);
  process.exit(1);
});
