// What the host actually asked for, and what it cost.
//
// WHY NOT COUNT INSIDE THE AGENT. The previous evaluation counted the agent's
// own invocations of a CLI shim. That misses the entire preamble: a real host
// calls `server/discover`, `tools/list`, `resources/list` and `prompts/list`
// before the model has seen the task, and those are the bytes Stacki charges
// every session unconditionally. An agent-side counter reports a fraction of
// the cost and calls it the cost.
//
// WHY NOT COUNT INSIDE STACKI. Because then the measurement ships. This sits
// between the host and an unmodified Stacki, forwards bytes without touching
// them, and writes one JSONL row per JSON-RPC message. The server under test
// does not know it is being measured, which is the only way the number is about
// the product rather than about the instrument.
//
// It streams. An SSE response — `subscriptions/listen` is one, and it is held
// open for the life of the session — is forwarded chunk by chunk as it arrives
// and parsed on the side. Buffering it would look like a working proxy right up
// until the first long-lived stream, at which point the host would hang.

const http = require('node:http');
const fs = require('node:fs');

/** Every JSON-RPC message in a body, whether it arrived as JSON or as SSE. */
function messagesOf(contentType, text) {
  if (/text\/event-stream/i.test(contentType || '')) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        out.push(JSON.parse(line.slice(5).trim()));
      } catch {
        /* a comment or a keep-alive, not a message */
      }
    }
    return out;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

/**
 * Sit in front of `upstreamUrl` on `port` and write every exchange to
 * `logPath`.
 *
 * The bearer is checked here as well as upstream: this endpoint is on loopback
 * like the real one, and a proxy that answered strangers would be a hole the
 * product does not have.
 */
function createRecorder({ upstreamUrl, token, port, host = '127.0.0.1', logPath }) {
  const upstream = new URL(upstreamUrl);
  const out = fs.createWriteStream(logPath, { flags: 'a' });
  const record = (row) => out.write(`${JSON.stringify(row)}\n`);
  const startedAt = Date.now();
  let open = 0;
  let peakOpen = 0;

  const server = http.createServer((req, res) => {
    const given = /^Bearer[ ]+(.+)$/i.exec(String(req.headers.authorization || '').trim());
    if (!given || given[1].trim() !== token) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const began = process.hrtime.bigint();
      const asked = messagesOf(req.headers['content-type'], body.toString('utf8'));

      const headers = { ...req.headers, authorization: `Bearer ${token}`, host: upstream.host };
      delete headers['content-length'];
      if (body.length) headers['content-length'] = String(body.length);

      open += 1;
      peakOpen = Math.max(peakOpen, open);

      const relay = http.request(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: upstream.pathname,
          method: req.method,
          headers,
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          const seen = [];
          let httpBytes = 0;
          up.on('data', (c) => {
            httpBytes += c.length;
            seen.push(c);
            // FORWARDED THE MOMENT IT ARRIVES. A held-open stream that is only
            // flushed at `end` is a stream that never flushes.
            res.write(c);
          });
          up.on('end', () => {
            res.end();
            open -= 1;
            const ms = Number(process.hrtime.bigint() - began) / 1e6;
            const answered = messagesOf(up.headers['content-type'], Buffer.concat(seen).toString('utf8'));
            for (const m of asked) {
              const back = answered.find((r) => r.id !== undefined && r.id === m.id) || null;
              record({
                at: Date.now() - startedAt,
                method: m.method || null,
                id: m.id ?? null,
                // The tool called, or the resource read, or the prompt fetched:
                // one column, because every one of them is "what did it ask
                // for" and a report that split them could not sort by cost.
                name: m.params?.name || m.params?.uri || null,
                args: m.params?.arguments ? JSON.stringify(m.params.arguments).slice(0, 600) : null,
                requestBytes: bytes(m),
                responseBytes: back ? bytes(back) : 0,
                httpBytes,
                streamed: answered.length > 1,
                protocolError: back?.error ? back.error.message || String(back.error.code) : null,
                // An application failure — a refusal, a stale ref, a bad
                // argument — is a successful round trip and a failed call. The
                // previous harness counted only transport failures and reported
                // "0 invalid calls", which was true and meant nothing.
                toolError: back?.result?.isError === true,
                envelopeNotOk: back?.result?.structuredContent?.ok === false,
                refusalCode: back?.result?.structuredContent?.code || null,
                ms: Math.round(ms),
                status: up.statusCode,
              });
            }
            if (!asked.length) {
              record({
                at: Date.now() - startedAt,
                method: `HTTP ${req.method}`,
                id: null,
                httpBytes,
                ms: Math.round(ms),
                status: up.statusCode,
              });
            }
          });
          up.on('error', () => {
            open -= 1;
            res.end();
          });
        }
      );
      relay.on('error', (err) => {
        open -= 1;
        record({ at: Date.now() - startedAt, method: 'TRANSPORT_ERROR', error: String(err.message) });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_upstream_failed', message: String(err.message) }));
      });
      // A client that goes away mid-request must not leave the upstream leg
      // holding a socket: the spec makes a closed stream a cancellation, and
      // whatever Stacki does about that, the instrument must not be what keeps
      // it alive.
      req.on('aborted', () => relay.destroy());
      res.on('close', () => {
        if (!res.writableEnded) relay.destroy();
      });
      if (body.length) relay.write(body);
      relay.end();
    });
  });

  return {
    url: `http://${host}:${port}${upstream.pathname}`,
    get peakConcurrentRequests() {
      return peakOpen;
    },
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      }),
    stop: () =>
      new Promise((resolve) => {
        out.end();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Read a log back and reduce it to the numbers a report wants. */
function summarise(logPath) {
  let rows = [];
  try {
    rows = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
  const of = (m) => rows.filter((r) => r.method === m);
  const calls = of('tools/call');
  const reads = of('resources/read');
  const profileReads = reads.filter((r) => String(r.name || '').startsWith('stacki://project/'));
  const guideReads = reads.filter((r) => String(r.name || '').startsWith('stacki://guide/'));

  // A repeat is the same method with the same arguments, seen again. Not every
  // repeat is waste — re-reading a target after a write is verification — so it
  // is reported, never subtracted.
  const seen = new Set();
  let repeats = 0;
  for (const r of rows) {
    if (r.method !== 'tools/call' && r.method !== 'resources/read') continue;
    const key = `${r.method}|${r.name}|${r.args || ''}`;
    if (seen.has(key)) repeats += 1;
    seen.add(key);
  }

  const sum = (xs, k) => xs.reduce((a, r) => a + (r[k] || 0), 0);
  const preambleMethods = ['server/discover', 'initialize', 'tools/list', 'resources/list', 'prompts/list'];
  const preamble = rows.filter((r) => preambleMethods.includes(r.method));

  return {
    messages: rows.length,
    preambleCalls: preamble.length,
    preambleBytes: sum(preamble, 'responseBytes'),
    toolsListBytes: sum(of('tools/list'), 'responseBytes'),
    resourcesListBytes: sum(of('resources/list'), 'responseBytes'),
    promptsListBytes: sum(of('prompts/list'), 'responseBytes'),
    discoverBytes: sum(of('server/discover'), 'responseBytes'),
    toolCalls: calls.length,
    resourceReads: reads.length,
    projectProfileReads: profileReads.length,
    projectProfileBytes: sum(profileReads, 'responseBytes'),
    guideReads: guideReads.length,
    guideBytes: sum(guideReads, 'responseBytes'),
    promptGets: of('prompts/get').length,
    listenStreams: of('subscriptions/listen').length,
    protocolErrors: rows.filter((r) => r.protocolError).length,
    toolErrors: rows.filter((r) => r.toolError).length,
    refusals: rows.filter((r) => r.envelopeNotOk).length,
    refusalCodes: [...new Set(rows.filter((r) => r.refusalCode).map((r) => r.refusalCode))],
    repeats,
    responseBytes: sum(rows, 'responseBytes'),
    httpBytes: sum(rows, 'httpBytes'),
    elapsedMs: rows.length ? rows[rows.length - 1].at : 0,
    byTool: Object.entries(
      calls.reduce((acc, r) => {
        acc[r.name || '?'] = (acc[r.name || '?'] || 0) + 1;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1]),
  };
}

module.exports = { createRecorder, summarise, messagesOf };
