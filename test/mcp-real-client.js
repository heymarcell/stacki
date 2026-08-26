// A real MCP client for a real Stacki, over real HTTP.
//
// Everything else in test/ reaches the Agent API by requiring it. That is the
// right way to test a unit and the wrong way to believe a claim about the
// wire: the handler that drops a field on its way into `structuredContent`
// looks perfect from inside the process, and shipped that way once already.
//
// So this speaks the protocol. It POSTs JSON-RPC to the endpoint the app is
// actually listening on, with the bearer token the app actually minted, and
// reads what actually came back — including the shapes a well-behaved client
// would never send, because the point is to find out what happens then.
//
// It knows nothing about Stacki's internals on purpose. Give it a url and a
// token and it will talk to a packaged build, a build running from source, or
// anything else that answers the same protocol.

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

/**
 * Where a running Stacki keeps the token it minted.
 *
 * The app writes this itself, once, mode 0600, and reads it back on every
 * launch — so reading it is how a test learns the live credential without one
 * being pasted into a file somebody might commit. Nothing here invents a
 * token: if the app has not made one, there is nothing to attach to.
 */
function liveToken({ userData } = {}) {
  const dir =
    userData ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Stacki')
      : path.join(os.homedir(), '.config', 'Stacki'));
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-token.json'), 'utf8'));
    return typeof saved?.token === 'string' && saved.token.length >= 32 ? saved.token : null;
  } catch {
    return null;
  }
}

/** The percentile of a list of numbers, for latency that is reported rather than averaged away. */
const pct = (list, p) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/**
 * A client bound to one endpoint.
 *
 * `timeoutMs` is not a formality. A tool that never answers is a bug this
 * campaign is looking for, and without a deadline it presents as a test run
 * that simply never ends — so every request carries one and a timeout is
 * recorded as a failure with the call that caused it.
 */
function createMcpClient({ url, token, timeoutMs = 30000, name = 'stacki-stress', version = '1.0.0' }) {
  if (!url) throw new Error('createMcpClient needs the endpoint url');
  let rpc = 1;
  let sessionId = null;
  let protocolVersion = null;
  const latency = [];
  const failures = [];
  let calls = 0;

  const headers = (extra = {}) => {
    const base = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) delete base[k.toLowerCase()];
      else base[k.toLowerCase()] = v;
    }
    return base;
  };

  /**
   * One HTTP round trip, with nothing assumed about the answer.
   *
   * Deliberately tolerant: a torture case sends a truncated body or an unknown
   * method and wants the status and the text, not an exception. Only the
   * transport failing — including the deadline passing — throws.
   */
  async function raw({ body, rawBody, method = 'POST', extraHeaders = {}, deadline = timeoutMs } = {}) {
    const started = Date.now();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), deadline);
    try {
      const res = await fetch(url, {
        method,
        headers: headers(extraHeaders),
        body: method === 'GET' || method === 'OPTIONS' ? undefined : rawBody !== undefined ? rawBody : JSON.stringify(body),
        signal: stop.signal,
      });
      const text = await res.text();
      const ms = Date.now() - started;
      latency.push(ms);
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      return { status: res.status, headers: res.headers, text, ms, json: parseBody(text) };
    } catch (err) {
      const ms = Date.now() - started;
      const timedOut = err?.name === 'AbortError';
      failures.push({ kind: timedOut ? 'timeout' : 'transport', ms, message: String(err?.message || err) });
      if (timedOut) throw new Error(`request exceeded ${deadline}ms — a tool that never answers is the bug`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streamable HTTP may answer as JSON or as one SSE frame; both are the same
   * message. Anything that is neither comes back as null rather than throwing,
   * because "the server said something unparseable" is a finding.
   */
  function parseBody(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    const frame = trimmed.split('\n').find((l) => l.startsWith('data:'));
    if (!frame) return null;
    try {
      return JSON.parse(frame.replace(/^data:\s*/, ''));
    } catch {
      return null;
    }
  }

  async function rpcCall(method, params, opts = {}) {
    const id = rpc++;
    const res = await raw({ body: { jsonrpc: '2.0', id, method, params }, ...opts });
    return { ...res, id, message: res.json };
  }

  async function initialize({ protocol = '2025-06-18' } = {}) {
    sessionId = null;
    protocolVersion = null;
    const res = await rpcCall('initialize', {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name, version },
    });
    const result = res.message?.result || null;
    if (result?.protocolVersion) protocolVersion = result.protocolVersion;
    // The notification the spec asks for once initialize has been answered.
    // Skipping it leaves some servers refusing every later call, and a client
    // that only ever worked because Stacki is lenient is not testing Stacki.
    if (result) {
      await raw({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } }).catch(() => {});
    }
    return { ok: !!result, result, error: res.message?.error || null, sessionId, status: res.status, ms: res.ms };
  }

  async function listTools() {
    const res = await rpcCall('tools/list', {});
    return {
      ok: !!res.message?.result,
      tools: res.message?.result?.tools || [],
      names: (res.message?.result?.tools || []).map((t) => t.name),
      error: res.message?.error || null,
      ms: res.ms,
    };
  }

  /**
   * Call a tool and answer with what the wire said.
   *
   * `structured` is `structuredContent` untouched — not merged with anything,
   * not defaulted. A field the server failed to send has to read as missing
   * here or this client would hide exactly the class of bug it exists to find.
   */
  async function call(tool, args = {}, opts = {}) {
    calls++;
    const res = await rpcCall('tools/call', { name: tool, arguments: args }, opts);
    const result = res.message?.result || null;
    const out = {
      tool,
      status: res.status,
      ms: res.ms,
      rpcError: res.message?.error || null,
      isError: !!result?.isError,
      structured: result ? result.structuredContent : undefined,
      content: result?.content || [],
      text: (result?.content || []).find((c) => c.type === 'text')?.text ?? null,
      image: (result?.content || []).find((c) => c.type === 'image') || null,
      raw: res.message,
    };
    if (out.rpcError || out.isError) {
      failures.push({ kind: out.rpcError ? 'rpc' : 'tool', tool, code: out.structured?.code || null, ms: out.ms });
    }
    return out;
  }

  /** The structuredContent alone, for the many places that only want the answer. */
  const s = async (tool, args, opts) => (await call(tool, args, opts)).structured;

  /**
   * Fire a batch at once and wait for all of them.
   *
   * Every entry carries its own index so a response can be matched back to the
   * request that asked for it — the correlation bug this campaign is meant to
   * rule out is invisible if the caller only counts successes.
   */
  async function concurrently(items) {
    return Promise.all(
      items.map(async (item, index) => {
        const started = Date.now();
        try {
          const res = await call(item.tool, item.args, item.opts);
          return { index, label: item.label || item.tool, ok: true, ms: Date.now() - started, res };
        } catch (err) {
          return { index, label: item.label || item.tool, ok: false, ms: Date.now() - started, error: String(err?.message || err) };
        }
      })
    );
  }

  const stats = () => ({
    calls,
    requests: latency.length,
    failures: failures.length,
    failureKinds: failures.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {}),
    latency: { p50: pct(latency, 50), p95: pct(latency, 95), max: latency.length ? Math.max(...latency) : null },
  });

  return {
    url,
    get token() {
      return token;
    },
    get sessionId() {
      return sessionId;
    },
    get protocolVersion() {
      return protocolVersion;
    },
    initialize,
    listTools,
    call,
    s,
    raw,
    rpcCall,
    concurrently,
    stats,
    failures,
    reset() {
      latency.length = 0;
      failures.length = 0;
      calls = 0;
    },
  };
}

/**
 * One HTTP request written onto a socket by hand.
 *
 * Node's fetch refuses to let a caller set `Host`: undici overwrites it with
 * the authority it dialled, silently. A test that used fetch to check the
 * DNS-rebinding guard would therefore always send a *correct* Host, get a 200,
 * and report that the guard is broken — which is a bug in the test, and was,
 * once. The only way to put a chosen Host on the wire is to write the request
 * yourself, so that is what this does. Also the way to send a header twice, a
 * bad request line, or a body whose length disagrees with its Content-Length.
 */
function rawSocketRequest({
  port,
  host = '127.0.0.1',
  method = 'POST',
  target = '/mcp',
  headers = {},
  body = '',
  requestLine = null,
  timeoutMs = 15000,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const lines = [requestLine || `${method} ${target} HTTP/1.1`];
    const sent = { host: `${host}:${port}`, 'content-length': String(payload.length), connection: 'close', ...headers };
    for (const [k, v] of Object.entries(sent)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
      else lines.push(`${k}: ${v}`);
    }
    const head = `${lines.join('\r\n')}\r\n\r\n`;

    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    let finished = false;
    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error(`raw request exceeded ${timeoutMs}ms`)), timeoutMs);

    socket.on('connect', () => {
      socket.write(head);
      if (payload.length) socket.write(payload);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (err) => finish(reject, err));
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] || 0);
      const split = text.indexOf('\r\n\r\n');
      finish(resolve, {
        status,
        headersText: split >= 0 ? text.slice(0, split) : text,
        body: split >= 0 ? text.slice(split + 4) : '',
        text,
      });
    });
  });
}

module.exports = { createMcpClient, liveToken, rawSocketRequest };
