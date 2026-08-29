// Stacki's MCP endpoint, spoken to the way a 2026 client speaks to it.
//
//   node test/mcp-modern.js
//
// Every other MCP test in this repository hand-writes the wire: an
// `initialize` carrying `protocolVersion: '2025-06-18'`, then JSON-RPC bodies
// posted with fetch. That tests HTTP, and it is exactly why PR #16 shipped —
// a hand-written request validates whatever the hand wrote, and the thing that
// actually broke was the half no hand-written request has: the CLIENT checking
// `structuredContent` against the output schema it was handed by `tools/list`.
//
// So this one uses the official client, and it does three things the old tests
// could not:
//
//   IT SPEAKS 2026-07-28. The protocol dropped the handshake — no `initialize`,
//   a per-request `_meta` envelope, an `Mcp-Method` header, and `server/discover`
//   in place of the negotiation that used to happen once. Stacki has served
//   that revision all along and NOTHING exercised it. A modern-only client is
//   the normal case now, and it was the untested one.
//
//   IT NEGOTIATES. `auto` probes with `server/discover` and falls back to the
//   2025 handshake. Both outcomes have to work against this server, because
//   Stacki is dual-era and clients in the wild are all three.
//
//   IT VALIDATES THE WAY A CLIENT DOES. The official client parses each tool's
//   declared output schema and checks the result against it. A field the
//   service sends and the schema never declared makes the client throw the
//   whole answer away — which is the shape of the only MCP bug we have shipped.
//
// The raw-HTTP tests in test/mcp.js are not replaced. They cover the things
// that ARE the transport: host and origin validation, the bearer, the path,
// malformed bodies, header/body mismatch. Those belong in a hand-written
// request. Application behaviour does not.

const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { createStackiMcpServer } = require('../electron/mcp/server.js');
const { createContextStore } = require('../electron/mcp/contextStore.js');
const { connectMcp, toolCatalog, MODERN_VERSION } = require('./support/mcpWire.js');

const PORT = 43897;
const TOKEN = 'modern-wire-token-aaaaaaaaaaaaaaaaaaaa';
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const ROOT = path.join(require('os').tmpdir(), 'stacki-mcp-modern-project');

// The same published renderer payload the rest of the MCP tests use, so this
// suite and test/mcp.js are describing one server rather than two.
const payload = () => ({
  project: { root: ROOT, branch: 'main' },
  page: { route: '/', file: path.join(ROOT, 'src/pages/index.astro') },
  view: { device: 'desktop', viewportWidth: 1280, viewportHeight: 800 },
  preview: { status: 'on' },
  selection: {
    present: true,
    nodeKind: 'element',
    tag: 'span',
    occurrence: 1,
    occurrenceCount: 4,
    keys: ['src/pages/index.astro#0.3'],
    componentChain: ['index'],
    breadcrumbs: ['index', 'span'],
    text: 'Learn more',
    props: { class: 'pill' },
    classes: ['pill'],
    hidden: false,
    inert: false,
    rect: { x: 10, y: 20, w: 100, h: 40 },
  },
});
const fakeTrail = (keys) => (keys || []).map((k) => ({ file: String(k).split('#')[0], startLine: 1, endLine: 1 }));
const SNAPSHOT = (() => {
  const store = createContextStore({ resolveTrail: fakeTrail });
  store.publish(payload());
  return store.read();
})();

const EMPTY_SHARED = {
  mode: 'off', enabled: false, workspace: null, secure: null, lastSyncAt: null,
  problem: null, pending: 0, private: 0, syncing: false,
  identity: { actorId: 'a-1', displayName: 'You' }, suggestion: null,
  newShareRelay: { ok: true, hosted: true, origin: 'https://stacki-relay.neongod.io', label: 'Hosted relay' },
};

(async () => {
  const server = createStackiMcpServer({
    port: PORT,
    token: TOKEN,
    version: '1.2.3',
    getContext: async ({ styleDetail }) => {
      const snap = JSON.parse(JSON.stringify(SNAPSHOT));
      if (styleDetail === 'essential' || styleDetail === 'full') snap.selection.essentialComputedStyles = { display: 'flex' };
      if (styleDetail === 'full') snap.selection.computedStyles = { display: 'flex', 'scroll-snap-stop': 'normal' };
      return snap;
    },
    // capture's contract is { image, mimeType, meta } — a refusal is a null
    // image WITH meta, never a bare { ok:false }. createCapture always sends
    // meta on every path, including its refusals.
    capture: async (args) => ({
      image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      meta: {
        revision: SNAPSHOT.revision,
        status: 'ready',
        target: args.target,
        requestedTarget: args.target,
        format: args.format,
        source: SNAPSHOT.selection.source,
        view: SNAPSHOT.view,
        occurrence: 0,
        occurrenceCount: 1,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        pixelSize: { width: 10, height: 10 },
        bytes: 4,
        // nullable, not optional: the real capture always sends it, as a
        // string of caveats or null when there are none.
        note: null,
      },
    }),
    getComments: async () => ({
      ok: true, revision: 1, status: 'open', scope: 'project',
      total: 0, returned: 0, truncated: false, reviews: [], problem: null, shared: EMPTY_SHARED,
    }),
    comment: async () => ({ ok: false, code: 'no_project', message: 'No project is open in Stacki.' }),
  });
  await server.start?.();
  await new Promise((r) => setTimeout(r, 300));

  const open = [];
  const connect = async (era) => {
    const c = await connectMcp({ url: URL_, token: TOKEN, era });
    open.push(c.close);
    return c;
  };

  try {
    // ── The three eras all reach the same server ────────────────────────────
    //
    // Stacki is dual-era. A client pinned to 2026-07-28 never sends
    // `initialize` at all; a 2025 client sends nothing else. Both are normal.
    for (const era of ['modern', 'auto', 'legacy']) {
      let cat = null;
      try {
        const { client } = await connect(era);
        cat = await toolCatalog(client);
      } catch (err) {
        check(`a ${era} client connects`, false, String(err?.message || err));
        continue;
      }
      check(`a ${era} client connects and lists tools`, cat.tools.length > 0, `${cat.tools.length} tools`);
      check(`  and ${era} sees the four core tools`, ['get_context', 'capture', 'get_comments', 'comment'].every((n) => cat.byName.has(n)), [...cat.byName.keys()].join(','));
    }

    // ── server/discover, which only the modern era has ──────────────────────
    //
    // The 2026 revision replaced the handshake with this. Servers MUST answer
    // it; a client MAY use it to learn the era before sending anything else,
    // and `auto` uses it as its probe.
    {
      const { client } = await connect('modern');
      const discover = await client.request({ method: 'server/discover', params: {} }, require('@modelcontextprotocol/client').DiscoverResultSchema ?? undefined).catch((e) => ({ __err: e }));
      const d = discover && !discover.__err ? discover : null;
      check('server/discover answers', !!d, String(discover?.__err?.message || '').slice(0, 200));
      if (d) {
        check('  and names the modern revision it serves', (d.supportedVersions || []).includes(MODERN_VERSION), JSON.stringify(d.supportedVersions));
        check('  and advertises the tools capability', !!d.capabilities?.tools, JSON.stringify(d.capabilities));
        check('  and carries the server instructions', typeof d.instructions === 'string' && d.instructions.length > 0, `${(d.instructions || '').length} chars`);
      }
    }

    // ── Results validate against the schema the CLIENT was handed ───────────
    //
    // Not against a schema read out of the repository — that only proves the
    // repository agrees with itself. The official client validates
    // structuredContent against the output schema that arrived over the wire,
    // and throws the whole result away when it does not fit. That is the
    // failure PR #16 fixed, and this is the check that would have caught it.
    {
      const { client } = await connect('modern');
      const cat = await toolCatalog(client);
      check('every tool publishes an output schema', cat.tools.every((t) => !!t.outputSchema), cat.tools.filter((t) => !t.outputSchema).map((t) => t.name).join(','));

      const calls = [
        ['get_context', { styleDetail: 'none' }],
        ['get_context', { styleDetail: 'essential' }],
        ['get_context', { styleDetail: 'full' }],
        ['capture', {}],
        ['get_comments', { status: 'all' }],
        ['get_comments', { status: 'open', detail: 'full' }],
        ['comment', { action: 'create', message: 'hello' }],
      ];
      for (const [name, args] of calls) {
        const label = `${name}(${Object.entries(args).map(([k, v]) => `${k}:${v}`).join(',') || ''})`;
        let res = null;
        try {
          res = await client.callTool({ name, arguments: args });
        } catch (err) {
          check(`${label} returns a schema-valid result`, false, String(err?.message || err).slice(0, 300));
          continue;
        }
        // A refusal is still a result: `ok:false` with a code is Stacki's
        // contract for "nothing is selected", and it must validate too.
        const textErr = (res.content || []).map((c) => c.text || '').join(' ');
        check(`${label} validates against its declared output schema`, !/Output validation error/i.test(textErr), textErr.slice(0, 300));
        check(`${label} carries structuredContent`, !!res.structuredContent, JSON.stringify(res).slice(0, 200));
      }

      // The one that shipped broken: `shared` must survive the round trip
      // whole. Every key the service sends has to be declared, or a strict
      // client discards the entire response.
      //
      // A schema violation makes the client REJECT rather than return, so this
      // is caught and reported by name. Letting it throw would end the suite
      // with a stack trace instead of telling anyone which field drifted.
      let shared = null;
      let sharedErr = null;
      try {
        const comments = await client.callTool({ name: 'get_comments', arguments: { status: 'all' } });
        shared = comments.structuredContent?.shared || null;
      } catch (err) {
        sharedErr = String(err?.message || err);
      }
      check('get_comments returns the sharing status', !!shared, sharedErr || 'no shared object came back');
      for (const key of Object.keys(EMPTY_SHARED)) {
        check(`  shared.${key} survives the wire`, !!shared && key in shared, sharedErr || Object.keys(shared || {}).join(','));
      }
    }

    // ── An unsupported revision is refused the way the spec says ────────────
    {
      const bad = await fetch(URL_, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': '1900-01-01',
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/list',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } },
        }),
      });
      const body = await bad.json().catch(() => null);
      // -32022 is UnsupportedProtocolVersionError, and the client is supposed
      // to be able to retry from `data.supported` rather than guess.
      check('an unknown protocol revision is refused as -32022', body?.error?.code === -32022, JSON.stringify(body).slice(0, 200));
      check('  and the refusal names what the server does support', (body?.error?.data?.supported || []).includes(MODERN_VERSION), JSON.stringify(body?.error?.data));
    }
  } finally {
    for (const close of open) await close();
    await server.stop?.();
  }

  if (failures.length) {
    console.error(`\nmcp-modern: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-modern: ${checked} passed  [official client, 2026-07-28, auto and legacy]`);
})().catch((err) => {
  console.error('mcp-modern threw\n', err);
  process.exit(1);
});
