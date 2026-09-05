// What this server says a client may keep, and what it says it will tell them.
//
//   node test/mcp-cache-hints.js
//
// Two claims a server makes about itself, both of which Stacki used to get
// wrong in the same direction — by letting the SDK answer for it.
//
// CAPABILITIES. `McpServer` sets `listChanged: true` for tools, resources and
// prompts the moment the first one of each is registered, unless the server
// said otherwise at construction, and `server/discover` advertises the bits
// verbatim. Stacki said nothing, so it advertised three times over that it
// would tell clients when its lists changed — with no code anywhere in the
// repository that emits such a notification, and a per-request transport with
// no channel to send one down. A modern client reads those bits to decide
// which notification types to ask for on its listen filter, so the lie costs a
// listener that can never fire.
//
// CACHE. The 2026-07-28 revision makes `ttlMs` and `cacheScope` REQUIRED fields
// on six results (SEP-2549), and the SDK fills them with the conservative
// `{ttlMs: 0, cacheScope: 'private'}` when nothing says otherwise. For the four
// catalogue results and the five guide resources that was a measurably wrong
// description: they are byte-identical on every machine running this build and
// contain nothing about anybody.
//
// THE BOUNDARY IS THE POINT, and it is asserted by RULE rather than by listing
// today's URIs: every `stacki://guide/*` resource must be publicly cacheable,
// and every other resource must not be. A project resource added tomorrow
// without a thought about caching inherits `private`, and a guide that stopped
// being static would fail this suite rather than quietly reach a shared cache.
//
// The 2025 era is checked too: cache fields are a modern-only concept and a
// legacy response must carry none.

const fs = require('node:fs');
const path = require('node:path');

const { createStackiMcpServer, CAPABILITIES, CACHE_HINTS } = require('../electron/mcp/server.js');
const { connectMcp } = require('./support/mcpWire.js');
const { guardSuite, freePort, portTaken } = require('./support/suiteGuard.js');

// A HANG MUST NOT REPORT A PASS. See test/support/suiteGuard.js: node exits 0
// on an empty event loop, so an await that never settles reads as success.
const suiteDone = guardSuite('mcp-cache-hints');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => {
  try {
    return typeof v === 'string' ? v.slice(0, 400) : JSON.stringify(v)?.slice(0, 400);
  } catch {
    return String(v);
  }
};

// A PORT PER SERVER INSTANCE. Three servers are started in turn here, and
// `fetch` keeps its connections alive: pointed at one port twice, the second
// server inherited a socket belonging to the first and the read reset. Ports
// are cheap; debugging that is not.
// PROBED, NOT ASSUMED — see the note in test/host-limits.js. Three consecutive
// ports are needed, so the probe walks until it finds a free RUN of three.
let BASE_PORT = 44961 + ((process.pid % 40) * 4);
const TOKEN = 'cache-hints-token-aaaaaaaaaaaaaaaa';
const urlFor = (port) => `http://127.0.0.1:${port}/mcp`;
const MODERN = '2026-07-28';

// A profile read has to reach real code rather than a stub that answers `{}`,
// or "the project resource is private" would be a claim about nothing.
const projectApi = (level) => ({
  capabilities: () => ({ level, operations: [] }),
  run: async (domain, action) => ({ ok: true, domain, action, items: [], from: 'fixture' }),
});

const build = (level, port) =>
  createStackiMcpServer({
    port,
    token: TOKEN,
    name: 'stacki',
    version: '0.1.23',
    getContext: async () => ({}),
    capture: async () => ({ image: null, mimeType: null, meta: {} }),
    getComments: async () => ({ comments: [] }),
    comment: async () => ({ ok: true }),
    api: projectApi(level),
    audit: { run: async () => ({ ok: true }) },
    onError: () => {},
  });

/** One modern request, hand-written, so the exact result fields can be read. */
async function modern(port, method, params = {}, extraHeaders = {}) {
  const res = await fetch(urlFor(port), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-method': method,
      'mcp-protocol-version': MODERN,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'cache-hints-test', version: '1.0.0' },
        },
      },
    }),
  });
  const body = await res.json();
  return { status: res.status, result: body.result, error: body.error };
}

const readResource = (port, uri) => modern(port, 'resources/read', { uri }, { 'mcp-name': uri });

/**
 * A free RUN of three: the suite binds `from`, +1 and +2.
 *
 * A LOOP THAT FALLS OUT OF ITS OWN BOTTOM IS NOT A SEARCH. This was a `for` with
 * a `break` on success and no `else`: after two hundred failures it left
 * BASE_PORT at `start + 3` -- a number the probe had never looked at, chosen
 * because it happened to be where the walk stopped -- and the suite bound it
 * anyway. The failure it was meant to prevent then arrived as EADDRINUSE from
 * inside `server.start()`, blaming the server for the port picker's silence.
 * `freePort` throws when it runs out; so does this.
 */
async function freeRunOfThree(from, tries = 200) {
  let at = from;
  for (let n = 0; n < tries; n += 1) {
    const start = await freePort(at);
    if (start === (await freePort(start)) && start + 1 === (await freePort(start + 1)) && start + 2 === (await freePort(start + 2))) {
      return start;
    }
    at = start + 3;
  }
  throw new Error(`no free run of three ports in ${from}..${at} after ${tries} tries`);
}

(async () => {
  // ---- THE PROBE THIS SUITE PICKS ITS OWN PORTS WITH ----------------------
  //
  // Three servers are bound below on numbers `freePort` chose, so a probe that
  // answers "free" about a port it could not ask about does not fail here as a
  // wrong answer -- it fails as EADDRINUSE inside `server.start()`, which reads
  // like a bug in the server. It is graded here rather than in a suite of its
  // own because this is the suite that depends on it hardest: three ports in a
  // row rather than one.
  //
  // `net.connect` is replaced for the duration, which is the only way to make a
  // real EACCES or EMFILE appear on demand: the module holds `net` by reference,
  // so the probe under test is the shipped one, called normally.
  {
    const net = require('node:net');
    const { EventEmitter } = require('node:events');
    const realConnect = net.connect;
    const withConnectError = async (code) => {
      net.connect = () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        const err = new Error(`connect ${code} 127.0.0.1:1`);
        err.code = code;
        setImmediate(() => socket.emit('error', err));
        return socket;
      };
      try {
        return await portTaken(1);
      } finally {
        net.connect = realConnect;
      }
    };
    // The canary: the probe CAN say "free", so the four readings below are a
    // distinction it draws rather than a constant it returns.
    check('a refused connection means the port is free', (await withConnectError('ECONNREFUSED')) === false);
    for (const code of ['EACCES', 'EMFILE', 'EADDRNOTAVAIL', 'EHOSTUNREACH']) {
      check(
        `  and ${code} does not: a probe that could not ask the question must not answer "take it"`,
        (await withConnectError(code)) === true,
        `${code} was read as a free port`
      );
    }
    // And a port something really is listening on, through the real socket.
    const listener = net.createServer(() => {});
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const busy = listener.address().port;
    check('a port with a listener on it reads as taken', (await portTaken(busy)) === true, String(busy));
    await new Promise((resolve) => listener.close(resolve));
    check('  and the same port reads as free once the listener has gone', (await portTaken(busy)) === false, String(busy));

    // AND A SEARCH THAT RUNS OUT SAYS SO RATHER THAN GUESSING. Driven with a
    // budget of zero tries, which is the same exit the two-hundredth failure
    // takes; the old loop reached it silently and the suite bound whatever
    // number the walk had stopped on.
    let ranOut = null;
    try {
      await freeRunOfThree(BASE_PORT, 0);
    } catch (err) {
      ranOut = String(err?.message || err);
    }
    check('a port search that runs out of tries throws rather than handing back an unprobed number', /no free run of three ports/.test(ranOut || ''), short(ranOut));
  }

  BASE_PORT = await freeRunOfThree(BASE_PORT);
  const PORT = BASE_PORT;
  const server = build('full', PORT);
  await server.start();
  try {
    // ---- CAPABILITIES ARE TRUTHFUL ----------------------------------------
    const disc = await modern(PORT, 'server/discover');
    const caps = disc.result?.capabilities;
    check('server/discover answers', disc.status === 200 && !!caps, short(disc));
    for (const family of ['tools', 'resources', 'prompts']) {
      check(
        `${family}.listChanged is advertised false`,
        caps?.[family]?.listChanged === false,
        short(caps?.[family])
      );
    }
    // THE REASON IT IS FALSE, and this used to check the wrong thing entirely:
    // it asked whether the CAPABILITIES constant mentioned the emitter names,
    // which it never would and which says nothing about the surface. The
    // question is whether any code in the shipped surface sends one, so the
    // shipped surface is what gets read.
    //
    // A provenance check rather than a behavioural one, deliberately, and it is
    // the strongest available: this transport is one POST per request with a
    // fresh server each time, so there is no channel a notification could be
    // observed arriving on. If a future change adds an emitter, this fails and
    // the declaration above can be reconsidered — which is the point.
    const EMITTERS = /\.(sendToolListChanged|sendResourceListChanged|sendPromptListChanged)\s*\(|notifications\/(tools|resources|prompts)\/list_changed/;
    const sourceFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) sourceFiles.push(at);
      }
    };
    walk(path.join(__dirname, '..', 'electron'));
    walk(path.join(__dirname, '..', 'src'));
    const emitting = sourceFiles.filter((f) => EMITTERS.test(fs.readFileSync(f, 'utf8')));
    check('the scan actually read the surface', sourceFiles.length > 50, `${sourceFiles.length} files`);
    check(
      'and nothing in it emits a list-changed notification',
      emitting.length === 0,
      emitting.map((f) => path.relative(path.join(__dirname, '..'), f)).join(', ')
    );
    check(
      'the declaration is frozen, so nothing can flip it at runtime',
      Object.isFrozen(CAPABILITIES) && Object.isFrozen(CACHE_HINTS),
      short({ caps: Object.isFrozen(CAPABILITIES), hints: Object.isFrozen(CACHE_HINTS) })
    );
    // Nothing that is not implemented may be advertised at all.
    check('resources.subscribe is not advertised', caps?.resources?.subscribe === undefined, short(caps?.resources));
    check('no logging capability is advertised', caps?.logging === undefined, short(caps));
    check('no completions capability is advertised', caps?.completions === undefined, short(caps));

    // ---- THE STATIC CATALOGUE IS PUBLICLY CACHEABLE ------------------------
    const CATALOGUE = ['server/discover', 'tools/list', 'prompts/list', 'resources/list'];
    for (const method of CATALOGUE) {
      const r = method === 'server/discover' ? disc : await modern(PORT, method);
      check(`${method} carries a cache hint`, typeof r.result?.ttlMs === 'number', short(r.result && Object.keys(r.result)));
      check(`  ${method} is public`, r.result?.cacheScope === 'public', short({ scope: r.result?.cacheScope }));
      check(`  ${method} has a lifetime worth having`, r.result?.ttlMs > 0, short({ ttlMs: r.result?.ttlMs }));
    }

    // ---- AND IT IS ACTUALLY STABLE, WHICH IS WHY IT MAY BE CACHED ----------
    //
    // A cache hint on a result that differs between two reads is a promise the
    // server cannot keep. Two fresh connections, compared byte for byte.
    const a1 = await modern(PORT, 'tools/list');
    const a2 = await modern(PORT, 'tools/list');
    check(
      'two tools/list reads are byte-identical, including order',
      JSON.stringify(a1.result?.tools) === JSON.stringify(a2.result?.tools),
      'a cacheable catalogue that changes between reads is not cacheable'
    );
    const r1 = await modern(PORT, 'resources/list');
    const r2 = await modern(PORT, 'resources/list');
    check(
      'two resources/list reads are byte-identical, including order',
      JSON.stringify(r1.result?.resources) === JSON.stringify(r2.result?.resources),
      short(r1.result?.resources?.map((x) => x.uri))
    );
    const p1 = await modern(PORT, 'prompts/list');
    const p2 = await modern(PORT, 'prompts/list');
    check(
      'two prompts/list reads are byte-identical, including order',
      JSON.stringify(p1.result?.prompts) === JSON.stringify(p2.result?.prompts),
      short(p1.result?.prompts?.map((x) => x.name))
    );

    // ---- THE RESOURCE BOUNDARY, BY RULE -----------------------------------
    const uris = (r1.result?.resources || []).map((x) => x.uri);
    check('the catalogue advertises resources to check', uris.length > 0, short(uris));
    let guides = 0;
    let projectish = 0;
    for (const uri of uris) {
      const read = await readResource(PORT, uri);
      const ttl = read.result?.ttlMs;
      const scope = read.result?.cacheScope;
      check(`${uri} answers with cache fields`, typeof ttl === 'number' && typeof scope === 'string', short(read.result && Object.keys(read.result)));
      if (uri.startsWith('stacki://guide/')) {
        guides++;
        check(`  ${uri} is public (static product guidance)`, scope === 'public', short({ ttl, scope }));
        check(`  ${uri} has a lifetime`, ttl > 0, short({ ttl }));
      } else {
        projectish++;
        // THE ONE THAT MATTERS. This is a person's project, gated on the level
        // they granted. A shared cache must never be told it may hold it, and
        // no cached copy may outlive a permission change.
        check(`  ${uri} is NOT publicly cacheable — it is project data`, scope === 'private', short({ uri, ttl, scope }));
        check(`  ${uri} is not cacheable at all`, ttl === 0, short({ uri, ttl }));
      }
    }
    check('at least one guide was checked', guides >= 1, String(guides));
    check('at least one project resource was checked', projectish >= 1, String(projectish));

    // ---- A CHANGE OF LEVEL CANNOT BE SERVED FROM A CACHED ANSWER -----------
    //
    // Not by asking the cache — there is no cache here to ask — but by asserting
    // the property that makes a stale answer impossible: the project resource is
    // never marked cacheable at ANY level, so there is nothing for a client to
    // hold across the change.
    await server.stop();
    const VISUAL_PORT = BASE_PORT + 1;
    const visual = build('visual', VISUAL_PORT);
    await visual.start();
    try {
      const asVisual = await readResource(VISUAL_PORT, 'stacki://project/profile');
      check(
        'the project profile is private at the lowest level too',
        asVisual.result?.cacheScope === 'private' && asVisual.result?.ttlMs === 0,
        short({ ttl: asVisual.result?.ttlMs, scope: asVisual.result?.cacheScope })
      );
      const guideAsVisual = await readResource(VISUAL_PORT, 'stacki://guide/editing');
      check(
        'and a guide is still public at the lowest level — it says nothing about the project',
        guideAsVisual.result?.cacheScope === 'public',
        short({ scope: guideAsVisual.result?.cacheScope })
      );
    } finally {
      await visual.stop();
    }

    // ---- THE LEGACY ERA IS UNTOUCHED --------------------------------------
    //
    // Cache fields are a modern-only concept. A 2025 client must see exactly
    // what it saw before, or "dual-era" is not what this server is.
    const LEGACY_PORT = BASE_PORT + 2;
    const legacy = build('full', LEGACY_PORT);
    await legacy.start();
    try {
      const { client, close } = await connectMcp({ url: urlFor(LEGACY_PORT), token: TOKEN, era: 'legacy' });
      const listed = await client.listTools();
      check('a legacy client still lists the tools', (listed.tools || []).length > 0, String((listed.tools || []).length));
      // THE 2025 ADVERTISEMENT CHANGED TOO, and nothing asserted it. The same
      // declaration reaches a legacy client through `initialize`'s capabilities
      // rather than through `server/discover`, and a server that told the truth
      // to one era and not the other would be worse than one that told neither.
      const legacyCaps = client.getServerCapabilities?.() || null;
      check('the legacy handshake advertises capabilities at all', !!legacyCaps, short(legacyCaps));
      for (const family of ['tools', 'resources', 'prompts']) {
        check(
          `  and ${family}.listChanged is false there too`,
          legacyCaps?.[family]?.listChanged === false,
          short(legacyCaps?.[family])
        );
      }
      check(
        'and its result carries no cache fields',
        listed.ttlMs === undefined && listed.cacheScope === undefined,
        short({ ttlMs: listed.ttlMs, cacheScope: listed.cacheScope })
      );
      await close();
    } finally {
      await legacy.stop();
    }
  } finally {
    if (server.listening) await server.stop();
  }

  if (failures.length) {
    console.error(`mcp-cache-hints: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  suiteDone();
  console.log(`mcp-cache-hints: ${checked} passed  [truthful capabilities; the catalogue is public, the project is not]`);
})().catch((err) => {
  console.error('mcp-cache-hints: threw', err);
  process.exit(1);
});
