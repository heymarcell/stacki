// The shipped MCP surface, with the dispatch seam wired to a counter.
//
// test/schema-strictness.js has to prove something no schema document can be
// read for: that an unknown key at a given depth is REFUSED, and that nothing
// ran on the way to refusing it. "Nothing ran" is only a claim unless somebody
// is watching the place where running would happen, so this rig puts the watch
// exactly there — on the implementation functions electron/mcp/index.js hands
// to the server, which are the only way past the tool handlers into the app.
//
// WHY NOT test/support/mcpWireRig.js. That rig exists to run REAL operations
// against a real fixture project, and it pays for it: a jsdom App, an Astro
// parser, a project on disk, sometimes a node_modules clone. This suite never
// wants an operation to run — the interesting answer is always a refusal, and
// the interesting fact is always that the implementation was not reached. A
// spy is not a weaker version of that fixture, it is the instrument the
// question needs: `api.run` cannot be observed as "not called" through a real
// dispatcher that logs nothing.
//
// Everything ABOVE the seam is the product: createStackiMcpServer, the same
// registerTools that composes the fourteen tools, advertised()'s pass-through
// validation, publishChecked's re-check inside the handler, the official
// client, and a real HTTP wire between them. So a call graded here took the
// same road a Claude Code call takes, and stopped in the same place.

const net = require('node:net');

const { createStackiMcpServer } = require('../../electron/mcp/server.js');
const { createContextStore } = require('../../electron/mcp/contextStore.js');
const { connectMcp } = require('./mcpWire.js');

/** Whether something is already listening there. Same reading as mcpWireRig. */
const portTaken = (port) =>
  new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (taken) => {
      socket.destroy();
      done(taken);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    // A LOOPBACK CONNECT THAT DOES NEITHER IS NOT EVIDENCE OF A FREE PORT.
    // Silence means a loaded machine or a socket on its way down, and reading
    // that as "free" is how a suite fails with "already in use".
    setTimeout(() => settle(true), 500).unref?.();
  });

// A base that differs per process, so two suites running at once do not both
// start at the same number and take each other out.
let nextPort = 45620 + ((process.pid % 400) * 30);

/**
 * A capture meta that satisfies the schema `capture` publishes.
 *
 * The control half of every injection is a call that MUST get past the schema,
 * and over a real wire the SDK validates what comes back against the tool's
 * declared output schema. A spy that answered `{}` would fail there, and the
 * suite would read a rig defect as a product refusal.
 */
const CAPTURE_META = {
  revision: 0,
  status: 'preview_not_ready',
  target: 'selection',
  requestedTarget: 'selection',
  format: 'png',
  source: null,
  view: { device: null, viewportWidth: null, viewportHeight: null },
  occurrence: null,
  occurrenceCount: null,
  rect: null,
  pixelSize: null,
  bytes: 0,
  note: 'This rig has no canvas; it exists to watch the dispatch seam.',
};

const COMMENTS = {
  ok: true,
  revision: 1,
  status: 'open',
  scope: 'project',
  total: 0,
  returned: 0,
  truncated: false,
  reviews: [],
  problem: null,
};

/**
 * Start the shipped endpoint with every implementation replaced by a spy.
 *
 * `seam` is the whole point: `seam.count` is how many times a tool handler got
 * past its own argument check and reached the app, and `seam.calls` records
 * what it was handed — which is how the open-data assertions prove a key was
 * not merely accepted but DELIVERED.
 */
async function startStrictnessWire({ era = 'modern' } = {}) {
  const seam = { count: 0, calls: [] };
  const record = (what, args) => {
    seam.count += 1;
    seam.calls.push({ what, args });
  };

  const context = createContextStore({ resolveTrail: () => [] });

  const implementations = {
    // The cold-start snapshot, which test/schema-dispatch-contract.js proves
    // validates against the schema get_context publishes.
    getContext: async (args) => {
      record('get_context', args);
      return context.read();
    },
    capture: async (args) => {
      record('capture', args);
      return { image: null, mimeType: null, meta: { ...CAPTURE_META, target: args?.target || 'selection', requestedTarget: args?.target || 'selection', format: args?.format || 'png' } };
    },
    getComments: async (args) => {
      record('get_comments', args);
      return COMMENTS;
    },
    comment: async (args) => {
      record('comment', args);
      return { ok: false, action: String(args?.action || 'create'), code: 'no_project', message: 'This rig has no review ledger.', revision: 0 };
    },
    api: {
      run: async (domain, action, args) => {
        record(`${domain}.${action}`, args);
        return { ok: true, action };
      },
      capabilities: () => {
        record('get_capabilities', null);
        return { ok: true };
      },
      // The audit tool's gate. Counted as the seam because it IS the first
      // thing past the argument check, and because a suite that let the audit
      // engine itself run would be measuring an engine rather than a schema.
      checkAccess: (operation, risk) => {
        record('audit.checkAccess', { operation, risk });
        return null;
      },
    },
    audit: async (args) => {
      record('audit.run', args);
      return { ok: true };
    },
  };

  let port = nextPort++;
  for (let tries = 0; tries < 200 && (await portTaken(port)); tries += 1) port = nextPort++;
  let token = `strictness-token-${port}-aaaaaaaaaaaa`;
  let url = `http://127.0.0.1:${port}/mcp`;

  const build = () => createStackiMcpServer({ port, token, version: '0.0.0-strictness', ...implementations });

  // ASKING WHETHER A PORT IS FREE AND BINDING IT ARE TWO SEPARATE MOMENTS, and
  // another suite can take it in between. Losing that race is retried; every
  // other start failure is real and throws.
  let server = build();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await server.start?.();
      break;
    } catch (err) {
      if (!/already in use|EADDRINUSE/i.test(String(err?.message || err)) || attempt >= 25) throw err;
      await Promise.resolve(server.stop?.()).catch(() => {});
      port = nextPort++;
      for (let tries = 0; tries < 200 && (await portTaken(port)); tries += 1) port = nextPort++;
      token = `strictness-token-${port}-aaaaaaaaaaaa`;
      url = `http://127.0.0.1:${port}/mcp`;
      server = build();
    }
  }

  const { client, close: closeClient } = await connectMcp({ url, token, era, name: 'Stacki schema strictness' });

  /**
   * One tool call, with the seam read across it.
   *
   * `dispatched` is the number of implementation calls THIS call caused, so a
   * caller never has to remember to reset a counter — forgetting that is how a
   * "nothing ran" assertion quietly becomes "nothing ran since the last time
   * somebody remembered".
   */
  const call = async (name, args) => {
    const before = seam.count;
    let raw = null;
    let threw = null;
    try {
      raw = await client.callTool({ name, arguments: args }, { timeout: 30000 });
    } catch (err) {
      threw = err;
    }
    const caused = seam.calls.slice(before);
    return {
      envelope: raw?.structuredContent ?? null,
      text: raw?.content?.[0]?.text ?? null,
      isError: raw?.isError ?? null,
      dispatched: seam.count - before,
      handedOver: caused,
      threw,
    };
  };

  let stopped = false;
  const stop = async () => {
    if (stopped) return { problems: [] };
    stopped = true;
    const problems = [];
    const closed = await closeClient();
    if (closed && closed.ok === false) problems.push(`the MCP client would not close: ${closed.error}`);
    await server.stop?.();
    return { problems };
  };

  return { client, call, seam, stop, url, token, port };
}

module.exports = { startStrictnessWire };
