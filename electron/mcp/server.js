// The endpoint.
//
// One Streamable HTTP route on loopback, and four gates in front of it. None of
// this is optional on a local machine: any page in any browser can POST to
// 127.0.0.1, and a server that answers "what is on this person's screen" is
// exactly the sort of thing that should not answer strangers.
//
//   Host      A page that resolves its own domain to 127.0.0.1 reaches this
//             server with the browser believing it is same-origin. The Host
//             header is the one thing that still says otherwise, so anything
//             that isn't localhost is refused. (DNS rebinding.)
//   Origin    A browser puts one on every cross-site request it makes; a real
//             MCP client sends none. Non-localhost origins are refused, and no
//             CORS headers are ever sent, so nothing is granted read access.
//   Bearer    A random token generated once and kept in the app's own data
//             directory — never in the project, never in git, never logged.
//   Path      Only POST /mcp exists. Everything else is 404.
//
// No `electron` in this file: it takes its two tool implementations as
// functions, so the whole surface can be started, called and stopped in a test
// with no app around it.

const http = require('node:http');
const crypto = require('node:crypto');

const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
const { toNodeHandler, localhostHostValidation, localhostOriginValidation } = require('@modelcontextprotocol/node');

const { registerTools, INSTRUCTIONS } = require('./tools');

// WHAT THIS SERVER ACTUALLY DOES, RATHER THAN WHAT THE SDK ASSUMES IT DOES.
//
// `McpServer` sets `listChanged: true` for tools, resources and prompts the
// moment the first one of each is registered, unless the server was built
// having already said otherwise:
//
//   registerCapabilities({ tools: { listChanged:
//     this.server.getCapabilities().tools?.listChanged ?? true } })
//
// and `server/discover` then advertises those bits verbatim. Stacki emitted no
// list-changed notification anywhere — there is no such call in this
// repository — so for as long as nothing said otherwise, every client was told
// three times that it would be kept up to date, by a server with no way to tell
// it anything.
//
// That is not cosmetic. A modern client reads these bits to decide which
// notification types to ask for on its `subscriptions/listen` filter, so a
// false one buys a listener that can never fire. And the lists genuinely cannot
// change: a fresh `McpServer` is built per request, its registrations all
// happen before it answers anything, and the transport is one POST per request
// with no channel to push a notification down afterwards. Static is the truth,
// so static is what is declared.
//
// The right way to make these `true` is to emit the notifications — not to
// leave the flag standing and hope nobody listens.
const CAPABILITIES = Object.freeze({
  tools: { listChanged: false },
  resources: { listChanged: false },
  prompts: { listChanged: false },
});

// HOW LONG AN ANSWER STAYS TRUE, AND WHO MAY HOLD IT.
//
// The 2026-07-28 revision requires `ttlMs`/`cacheScope` on six results
// (SEP-2549). The SDK fills them with `{ttlMs: 0, cacheScope: 'private'}` when
// nothing says otherwise, which is the correct conservative default and was
// also, until now, a measurably wrong description of five of them.
//
//   server/discover, tools/list, prompts/list, resources/list
//     Built from registrations that are decided before the server answers and
//     are identical on every machine running this build: two fresh connections
//     return byte-identical catalogues (asserted in test/mcp-cache-hints.js).
//     No project data is in any of them, so a shared cache holding one cannot
//     leak anything: `public`.
//
//   resources/read
//     Deliberately NOT public here. `stacki://project/profile` is this
//     person's project, gated on their permission level, and a per-operation
//     hint applies to every resource — so the operation keeps the conservative
//     default and the five static guides opt IN individually, in
//     electron/mcp/intelligence.js. A hint added to a new project resource by
//     accident is then a hint that says `private`, which is the safe way round.
//
// FIVE MINUTES, and the number is a staleness budget rather than a guess. The
// catalogue can only change when a different build of the app answers on this
// port, which needs Stacki to be restarted; five minutes bounds how long a
// client that reconnects across that restart can keep describing the old one,
// while still covering the reconnect storms that are the actual cost — a
// session that connects repeatedly pays for one catalogue rather than ten.
const CATALOGUE_TTL_MS = 5 * 60 * 1000;
const CACHE_HINTS = Object.freeze({
  'server/discover': { ttlMs: CATALOGUE_TTL_MS, cacheScope: 'public' },
  'tools/list': { ttlMs: CATALOGUE_TTL_MS, cacheScope: 'public' },
  'prompts/list': { ttlMs: CATALOGUE_TTL_MS, cacheScope: 'public' },
  'resources/list': { ttlMs: CATALOGUE_TTL_MS, cacheScope: 'public' },
  'resources/read': { ttlMs: 0, cacheScope: 'private' },
});

const DEFAULT_PORT = 43821;
const DEFAULT_HOST = '127.0.0.1';
const ENDPOINT_PATH = '/mcp';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Equal-length, constant-time string compare. */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length is not a secret (it is fixed by us), and timingSafeEqual demands a
  // match before it will look at the bytes.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerOf(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    // Nothing here is for a browser, and nothing about it should be reusable.
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/**
 * Build the server. Nothing listens until `start()`.
 *
 * `token` is required — a server that answers without one is not a server we
 * are willing to open.
 */
function createStackiMcpServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  token,
  name = 'stacki',
  version = '0.0.0',
  instructions = INSTRUCTIONS,
  getContext,
  capture,
  getComments,
  comment,
  // The Agent API — the editor half of the surface. Optional here so the
  // endpoint can still be built in a test that only cares about the four
  // original tools; when it is absent those four are all there is.
  api = null,
  // The audit engine. Optional in the same way `api` is: the four original tools
  // can be served without one, and a test that builds the endpoint with no app
  // around it has no browser to render a page in.
  audit = null,
  onError,
} = {}) {
  if (!token || typeof token !== 'string') throw new Error('an MCP bearer token is required');
  if (typeof getContext !== 'function' || typeof capture !== 'function') {
    throw new Error('get_context and capture implementations are required');
  }
  // Required rather than optional: a Stacki that answered `get_comments` on one
  // machine and not on another would be a client configuration problem nobody
  // could diagnose from the outside.
  if (typeof getComments !== 'function' || typeof comment !== 'function') {
    throw new Error('get_comments and comment implementations are required');
  }

  const report = (err) => {
    try {
      onError?.(err);
    } catch {
      /* a reporter that throws must not take the request with it */
    }
  };

  // A fresh instance per request: nothing is carried between callers, so two
  // clients can hold this endpoint at once without sharing anything.
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name, version },
      { instructions, capabilities: CAPABILITIES, cacheHints: CACHE_HINTS }
    );
    registerTools(server, {
      getContext,
      capture,
      getComments,
      comment,
      api,
      audit,
      // Who is connected, when the protocol has said. A client names itself at
      // initialize, which in a stateless transport is a different request from
      // the tool call — so this is often null, and the app falls back to a
      // generic agent name rather than guessing at a person. It is used only
      // to LABEL an agent's messages; nothing is authorized by it.
      clientName: () => {
        try {
          return server.server?.getClientVersion?.()?.name || null;
        } catch {
          return null;
        }
      },
    });
    return server;
  }, { onerror: report });

  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = http.createServer((req, res) => {
    // Both guards answer the request themselves when they refuse it.
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    if (!tokenMatches(bearerOf(req.headers.authorization), token)) {
      sendJson(
        res,
        401,
        { error: 'unauthorized', message: 'Stacki MCP requires the bearer token from the app.' },
        // Correct HTTP for a 401, and deliberately bare: this is a static
        // token, not OAuth, and pointing a client at metadata it would then
        // fail to fetch turns a typo into a login loop.
        { 'www-authenticate': 'Bearer' }
      );
      return;
    }

    // HOW BIG AN ASK IS ALLOWED TO BE.
    //
    // There was no limit anywhere in the stack: a 64 MB POST was read into a
    // JavaScript string and answered. The endpoint is on loopback behind a
    // bearer, so this is not the first line of defence -- but "authenticated"
    // and "unbounded" is still the wrong pair, and the four gates above cost
    // nothing precisely because they refuse before any work happens. This
    // refuses before the body is read at all.
    //
    // EIGHT MEGABYTES, from the largest thing the surface actually accepts: a
    // stylesheet through `style.write_source`, capped by its own schema at two
    // million characters. Eight is comfortably clear of that after JSON
    // escaping and the envelope, and nowhere near a size worth buffering by
    // accident.
    //
    // Declared length only. A body arriving without one is not refused -- every
    // MCP client sends Content-Length for a JSON POST, and refusing the ones
    // that might not would be trading a real client for a hypothetical
    // attacker who is already holding the token.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      sendJson(res, 413, {
        error: 'payload_too_large',
        message: `Stacki MCP accepts requests up to ${MAX_BODY_BYTES} bytes; this one declared ${declared}.`,
      });
      req.destroy();
      return;
    }

    const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    if (path !== ENDPOINT_PATH) {
      sendJson(res, 404, { error: 'not_found', message: `Stacki MCP is served at ${ENDPOINT_PATH}.` });
      return;
    }

    Promise.resolve(nodeHandler(req, res)).catch((err) => {
      report(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });

  // A stray connection must never keep the app alive at quit.
  server.on('error', report);

  let listening = false;

  return {
    port,
    host,
    get url() {
      return `http://${host}:${port}${ENDPOINT_PATH}`;
    },
    get listening() {
      return listening;
    },

    /**
     * Take the port, or say exactly why not. Never a different port: an agent
     * configured against 43821 that silently ends up talking to nothing is a
     * worse failure than not starting.
     */
    start() {
      return new Promise((resolve, reject) => {
        const onceError = (err) => {
          server.removeListener('listening', onceListening);
          if (err && err.code === 'EADDRINUSE') {
            reject(
              new Error(
                `port ${port} is already in use, so the Stacki MCP server did not start. ` +
                  'Another Stacki window, or another program, is holding it. Close that, or set ' +
                  'STACKI_MCP_PORT to a free port and restart Stacki.'
              )
            );
            return;
          }
          if (err && err.code === 'EACCES') {
            reject(new Error(`this machine will not let Stacki listen on port ${port}.`));
            return;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        const onceListening = () => {
          server.removeListener('error', onceError);
          server.on('error', report);
          listening = true;
          resolve(this);
        };
        server.removeListener('error', report);
        server.once('error', onceError);
        server.once('listening', onceListening);
        server.listen(port, host);
      });
    },

    async stop() {
      listening = false;
      try {
        await handler.close();
      } catch (err) {
        report(err);
      }
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        // Anything still holding a socket does not get to hold the quit.
        server.closeAllConnections?.();
      });
    },
  };
}

module.exports = {
  createStackiMcpServer,
  tokenMatches,
  bearerOf,
  DEFAULT_PORT,
  DEFAULT_HOST,
  ENDPOINT_PATH,
  MAX_BODY_BYTES,
  CAPABILITIES,
  CACHE_HINTS,
  CATALOGUE_TTL_MS,
};
