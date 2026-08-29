// A real MCP endpoint in front of the real Agent API, for coverage scenarios.
//
// test/agent-harness.js already builds the hard half: the real electron/main.js
// with a stubbed `electron`, the real App bridge in jsdom, the real Astro
// parser and serializer, and a real Agent API over a real fixture project on
// disk. What it does NOT have is a wire — agent-api.js and agent-acceptance.js
// call `api.run(...)` straight.
//
// That is a fine implementation test and it is not wire coverage. The bug we
// actually shipped lived between the implementation and the client: a field
// the service sent and the schema never declared, which every direct call in
// the repository was blind to by construction.
//
// So this puts the real MCP server in front of that real api, and hands back a
// `call()` that goes:
//
//   official MCP client -> HTTP -> Stacki MCP server -> domain tool
//     -> Agent API dispatcher -> real main/App implementation -> fixture
//
// WHAT IS AND IS NOT REAL HERE, stated plainly because a coverage number that
// hides this is worth nothing: source, files, refs, permission gating, the
// parser, the serializer and the undo stack are the shipping code. The CANVAS
// is not — there is no browser painting, so computed styles and screenshots
// answer empty, exactly as the harness documents. Operations whose whole
// meaning is a rendered pixel are graded against the packaged Electron proof
// instead, not here.

const H = require('../agent-harness.js');
const { createStackiMcpServer } = require('../../electron/mcp/server.js');
const { connectMcp } = require('./mcpWire.js');

let nextPort = 44120;

/**
 * Boot a fixture project, a real Agent API over it, an MCP endpoint in front
 * of that, and an official client connected to the endpoint.
 */
async function startWireRig({ era = 'modern', agentMode = 'full', extra = {} } = {}) {
  const root = H.makeProject(extra);
  const harness = await H.start(root, { agentMode });

  const port = nextPort++;
  const token = `wire-rig-token-${port}-aaaaaaaaaaaa`;
  const url = `http://127.0.0.1:${port}/mcp`;

  const server = createStackiMcpServer({
    port,
    token,
    version: '0.0.0-wire',
    api: harness.api,
    // The four core tools still have to exist for the endpoint to build. The
    // context one is answered from the App's own published payload, so
    // get_context over the wire is the App's real snapshot.
    getContext: async () => harness.payload(),
    capture: async (args) => ({
      image: null,
      mimeType: null,
      // The harness has no canvas. A capture here is an honest refusal WITH
      // meta, which is exactly what createCapture returns when it cannot
      // photograph anything — never a bare { ok:false }.
      meta: {
        revision: 0,
        status: 'preview_not_ready',
        target: args.target,
        requestedTarget: args.target,
        format: args.format,
        source: null,
        view: null,
        occurrence: 0,
        occurrenceCount: 0,
        rect: null,
        pixelSize: null,
        bytes: 0,
        note: 'This rig has no canvas; screenshots are proven against packaged Stacki.',
      },
    }),
    getComments: async () => ({
      ok: true, revision: 1, status: 'open', scope: 'project',
      total: 0, returned: 0, truncated: false, reviews: [], problem: null,
    }),
    comment: async () => ({ ok: false, code: 'no_project', message: 'This rig has no review ledger.' }),
  });
  await server.start?.();

  const { client, close: closeClient } = await connectMcp({ url, token, era, name: 'Stacki Phase A Agent' });

  /**
   * One Agent operation, through the wire.
   *
   * Returns the envelope the client validated against the tool's declared
   * output schema — so a schema drift throws here rather than being silently
   * accepted, which is the whole reason this path exists.
   */
  const call = async (domain, action, args = {}) => {
    const res = await client.callTool({ name: domain, arguments: { action, ...args } });
    return { envelope: res.structuredContent, raw: res };
  };

  /** get_capabilities, get_context and the rest of the non-domain surface. */
  const tool = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { envelope: res.structuredContent, raw: res };
  };

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await closeClient();
    await server.stop?.();
    try {
      harness.stop();
    } catch {
      /* a jsdom that will not close must not fail the suite */
    }
    H.removeProject(root);
  };

  return { root, harness, client, call, tool, stop, url, token, port };
}

module.exports = { startWireRig };
