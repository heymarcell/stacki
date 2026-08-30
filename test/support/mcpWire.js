// A real MCP client, pointed at a real Stacki endpoint.
//
// Every MCP test in this repository used to speak the wire by hand: an
// `initialize` with `protocolVersion: '2025-06-18'`, then JSON-RPC bodies
// posted with fetch. That is a fine way to test HTTP, and it is the reason
// PR #16 shipped — a hand-written request validates whatever the hand wrote,
// and the thing that actually broke was the part no hand-written request
// exercised: the client validating `structuredContent` against the output
// schema it was handed by `tools/list`.
//
// So application-level tests use the OFFICIAL client from here on, and raw
// HTTP is kept for the things that are genuinely about transport — host and
// origin validation, the bearer, the path, malformed bodies, header/body
// mismatch.
//
// THE THREE ERAS, because Stacki serves two of them and clients pick:
//
//   modern  — `{ pin: '2026-07-28' }`. Per-request `_meta` envelope, the
//             `Mcp-Method` header, `server/discover`. No handshake.
//   auto    — probe with `server/discover`, fall back to `initialize`.
//   legacy  — the plain 2025 `initialize` sequence. The client's DEFAULT,
//             and what every existing Stacki test has been using.
//
// The version numbers are not spelled out twice: MODERN_VERSION is the one
// the server advertises, and a test that wants "whatever modern is" asks for
// it by name rather than by string literal.

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

// The revision Stacki's server advertises on `server/discover`. Kept here so a
// protocol bump is one edit rather than a grep.
const MODERN_VERSION = '2026-07-28';

/** The era a test wants, in the shape the SDK's `versionNegotiation` takes. */
const ERAS = {
  modern: { mode: { pin: MODERN_VERSION } },
  auto: { mode: 'auto' },
  legacy: undefined, // the SDK default: plain 2025 initialize
};

/**
 * Connect a real client to a running Stacki MCP endpoint.
 *
 * Returns the connected client plus a `close()` that is safe to call twice —
 * a test that fails half way through still has to leave no socket behind.
 */
async function connectMcp({
  url,
  token,
  era = 'modern',
  name = 'stacki-wire-test',
  version = '1.0.0',
  capabilities = {},
  timeoutMs = 30000,
} = {}) {
  if (!url) throw new Error('connectMcp needs the endpoint url');
  if (!(era in ERAS)) throw new Error(`unknown era ${era}; expected one of ${Object.keys(ERAS).join(', ')}`);

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });

  const client = new Client({ name, version }, {
    capabilities,
    ...(ERAS[era] ? { versionNegotiation: ERAS[era] } : {}),
  });

  await client.connect(transport, { timeout: timeoutMs });

  let closed = false;
  /**
   * Answers what happened rather than swallowing it.
   *
   * A second close is nothing to report — the first one did the work. A FIRST
   * close that fails is a socket still open against the thing under test, and
   * this used to report it as a clean teardown: the caller's own
   * "the client would not close" branch was unreachable, because this could
   * not reject.
   */
  const close = async () => {
    if (closed) return { ok: true };
    closed = true;
    try {
      await client.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  };
  return { client, transport, close, era, modernVersion: MODERN_VERSION };
}

/**
 * Every tool the server offers, keyed by name, with the output schema the
 * CLIENT was given.
 *
 * That last part is the point: validating a result against a schema read out
 * of the repository proves the repository agrees with itself. Validating it
 * against the schema that arrived over the wire is what a real client does.
 */
async function toolCatalog(client) {
  const listed = await client.listTools();
  const byName = new Map();
  for (const tool of listed.tools || []) byName.set(tool.name, tool);
  return { tools: listed.tools || [], byName, raw: listed };
}

module.exports = { connectMcp, toolCatalog, MODERN_VERSION, ERAS };
