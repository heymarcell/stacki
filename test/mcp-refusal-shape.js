// A refusal, as it reaches a client.
//
//   node test/mcp-refusal-shape.js
//
// Stacki refuses well. `permissions.refusal()` names the operation, the level in
// force, the level that would be needed, where a person changes it, and that
// nothing was changed. It is the best diagnostic in the product.
//
// It reached the wire in three different shapes.
//
//   agentTools.js       `...(body.ok === false ? { isError: true } : {})`
//   reviewTools comment `...(body.ok ? {} : { isError: true })`
//   reviewTools get_comments   never
//   auditTool           never, not even on permission_denied
//
// So the byte-identical refusal that `target.set_text` returns as an error came
// back from `audit` as a call that worked. The spec says a tool that fails for an
// application reason SHOULD set `isError` so the model can self-correct, and a
// host that keys off it -- Claude Code does -- recorded a refused audit as a
// success. At the default permission level `audit` is ALWAYS refused, so this
// was the common case and not the edge one.
//
// This drives the real endpoint with the official client and asserts the shape
// on every tool that can refuse. It is deliberately not a unit test of `answer`:
// what matters is what a client receives, and `isError` is a property of the
// tool RESULT that only the wire can show.

const { createStackiMcpServer } = require('../electron/mcp/server.js');
const { connectMcp } = require('./support/mcpWire.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null).slice(0, 260);

// The refusal every gated surface in the product hands back, verbatim from
// permissions.js. Every tool below is wired to return exactly this, so a
// difference in what arrives is a difference in the DELIVERY and nothing else.
const REFUSAL = {
  ok: false,
  code: 'permission_denied',
  operation: 'audit.run',
  risk: 'read',
  mode: 'visual',
  requires: 'inspect',
  message:
    'Stacki’s agent access is set to "Visual only", and audit.run needs "Inspect project". ' +
    'The person at the keyboard can change it in Stacki: the AI connection (MCP) window. Nothing was changed.',
};

const OK_CONTEXT = {
  revision: 1,
  timestamp: 1,
  project: { root: '/tmp/x' },
  page: { route: '/', file: 'src/pages/index.astro' },
  view: { device: 'desktop', viewportWidth: 1200, viewportHeight: 800 },
  preview: { status: 'on', url: 'http://127.0.0.1:4321' },
  selection: {
    status: 'no_selection',
    nodeKind: null,
    tag: null,
    occurrence: null,
    occurrenceCount: null,
    source: null,
    sourceTrail: null,
    componentChain: [],
    breadcrumbs: [],
    text: null,
    props: null,
    classes: null,
    ref: null,
    editable: false,
    hidden: false,
    inert: false,
    rect: null,
    spacing: null,
  },
};

const PORT = 46310 + (process.pid % 300);
const TOKEN = 'refusal-shape-token-aaaaaaaaaaaaaaaa';

(async () => {
  // An endpoint whose every gated surface refuses. `api` is the real shape the
  // tools expect; `checkAccess` is the door `audit` asks, and returning the
  // refusal from it is exactly what the gate does at `visual`.
  const api = {
    run: async () => ({ ...REFUSAL, operation: 'target.set_text', requires: 'edit' }),
    capabilities: async () => ({ ok: true, stacki: { version: '0' }, access: { mode: 'visual' } }),
    checkAccess: () => REFUSAL,
    nodeRef: () => null,
  };

  const server = createStackiMcpServer({
    port: PORT,
    token: TOKEN,
    version: '0.0.0-refusal',
    getContext: async () => OK_CONTEXT,
    capture: async () => ({ image: null, mimeType: null, meta: { ...REFUSAL, status: 'no_project' } }),
    // The two that never set it.
    getComments: async () => ({ ...REFUSAL, code: 'no_project', message: 'No project is open in Stacki.' }),
    comment: async () => ({ ...REFUSAL, code: 'no_project', message: 'No project is open in Stacki.' }),
    api,
    audit: async () => ({ ok: false, code: 'no_preview', message: 'Stacki has no dev server running for this project.' }),
    onError: () => {},
  });
  await server.start();

  const { client, close } = await connectMcp({ url: server.url, token: TOKEN, era: 'modern', name: 'refusal-shape' });

  const call = async (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });

  try {
    // --- EVERY TOOL THAT CAN REFUSE, AND WHAT ARRIVES.
    const cases = [
      ['audit', { viewports: ['phone'] }, 'permission_denied'],
      ['get_comments', {}, 'no_project'],
      ['comment', { action: 'create', message: 'x' }, 'no_project'],
      ['target', { action: 'set_text', ref: 'stacki:nope', text: 'x' }, 'permission_denied'],
      ['style', { action: 'read', ref: 'stacki:nope' }, 'permission_denied'],
      ['project', { action: 'info' }, 'permission_denied'],
    ];

    for (const [name, args, code] of cases) {
      const res = await call(name, args);
      check(`${name} refuses with isError`, res.isError === true, short({ isError: res.isError, sc: res.structuredContent }));
      check(`  ${name} says ok:false in the envelope`, res.structuredContent?.ok === false, short(res.structuredContent));
      check(`  ${name} carries the code a client can branch on`, res.structuredContent?.code === code, short(res.structuredContent?.code));
      check(`  ${name} carries the sentence a person can act on`, typeof res.structuredContent?.message === 'string' && res.structuredContent.message.length > 10, short(res.structuredContent?.message));
      check(
        `  ${name} says the same thing in the text block`,
        typeof res.content?.[0]?.text === 'string' && res.content[0].text.includes(code),
        short(res.content?.[0]?.text)
      );
    }

    // --- THE PERMISSION REFUSAL, IN FULL. The fields that make it actionable
    //     rather than merely present.
    {
      const res = await call('audit', { viewports: ['phone'] });
      const body = res.structuredContent;
      check('a permission refusal names the operation', body?.operation === 'audit.run', short(body?.operation));
      check('  the level in force', body?.mode === 'visual', short(body?.mode));
      check('  the level that would be needed', body?.requires === 'inspect', short(body?.requires));
      check('  and where a person changes it', /AI connection \(MCP\)/i.test(String(body?.message)), short(body?.message));
      check('  and that nothing happened', /Nothing was changed/.test(String(body?.message)), short(body?.message));
    }

    // --- A SUCCESS MUST NOT CARRY IT. An `isError` that is always true is the
    //     same as one that is never set.
    {
      const res = await call('get_context', {});
      check('a successful call is not marked an error', res.isError !== true, short({ isError: res.isError }));
      check('  and it answers', res.structuredContent?.project?.root === '/tmp/x', short(res.structuredContent?.project));
      // The field this phase added, on the read that works at every level.
      check('  and it says whether the project is being served', res.structuredContent?.preview?.status === 'on', short(res.structuredContent?.preview));
      check('  and where', res.structuredContent?.preview?.url === 'http://127.0.0.1:4321', short(res.structuredContent?.preview));
    }

    // --- AN AUDIT'S OWN FAILURE, not a permission one: same delivery.
    {
      const open = createStackiMcpServer({
        port: PORT + 1,
        token: TOKEN,
        version: '0.0.0-refusal',
        getContext: async () => OK_CONTEXT,
        capture: async () => ({ image: null, mimeType: null, meta: {} }),
        getComments: async () => ({ ok: true, revision: 1, status: 'open', scope: 'project', total: 0, returned: 0, truncated: false, reviews: [], problem: null }),
        comment: async () => ({ ok: true }),
        api: { ...api, checkAccess: () => null },
        audit: async () => ({ ok: false, code: 'no_preview', message: 'Stacki has no dev server running for this project.' }),
        onError: () => {},
      });
      await open.start();
      const second = await connectMcp({ url: open.url, token: TOKEN, era: 'modern', name: 'refusal-shape-2' });
      const res = await second.client.callTool({ name: 'audit', arguments: { viewports: ['phone'] } }, undefined, { timeout: 30000 });
      check('an audit that cannot run is an error too, not only a refused one', res.isError === true, short({ isError: res.isError, sc: res.structuredContent }));
      check('  and it says why', res.structuredContent?.code === 'no_preview', short(res.structuredContent));
      const good = await second.client.callTool({ name: 'get_comments', arguments: {} }, undefined, { timeout: 30000 });
      check('  while a review read that works is not an error', good.isError !== true, short({ isError: good.isError }));
      await second.close();
      await open.stop();
    }
  } finally {
    await close();
    await server.stop();
  }

  if (failures.length) {
    console.error(`mcp-refusal-shape: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-refusal-shape: ${checked} passed  [one refusal shape, on every tool, over the wire]`);
})().catch((err) => {
  console.error('mcp-refusal-shape: threw\n', err?.stack || err);
  process.exit(1);
});
