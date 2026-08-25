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

const DEFAULT_PORT = 43821;
const DEFAULT_HOST = '127.0.0.1';
const ENDPOINT_PATH = '/mcp';

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
    const server = new McpServer({ name, version }, { instructions });
    registerTools(server, { getContext, capture, getComments, comment });
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

module.exports = { createStackiMcpServer, tokenMatches, bearerOf, DEFAULT_PORT, DEFAULT_HOST, ENDPOINT_PATH };
