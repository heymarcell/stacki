// A two-tool MCP server that answers rubbish, so the premise can be measured.
//
// test/refusal-contract.js exists because of a claim about the SDK: that a
// result carrying `isError` is NOT validated against the tool's declared output
// schema, so a malformed refusal ships while a malformed success does not. That
// claim is load-bearing — it is the whole reason a refusal needs a suite of its
// own — and it is the sort of thing that is true of one SDK version and quietly
// false of the next.
//
// So it is not read off the source and believed. This builds a real endpoint
// with the same `createMcpHandler` / `McpServer` pair electron/mcp/server.js
// uses, registers two tools that publish an output schema and then both answer
// with a payload that schema rejects, and differs between them in one bit:
// whether the result says `isError`. A real client calls both. Whatever comes
// back is what the SDK does, on this machine, at this version.
//
// Deliberately NOT Stacki's server. Stacki's own tools all answer correctly, so
// measuring them would prove nothing about what happens when one does not; and
// wiring a deliberately broken tool into the product's composer would mean
// shipping a broken tool. The endpoint here has no gates, no bearer and no
// project — it is a measuring instrument, and it is thrown away at the end of
// the check.

const http = require('node:http');
const z = require('zod');

const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');

const { connectMcp } = require('./mcpWire.js');

// What both tools publish, and what neither of them sends. `wanted` is required
// and `additionalProperties` is closed, so `{ unexpected: … }` fails on two
// counts rather than one — a validator that only checks one of them still says
// no.
const DeclaredOutput = z.object({ wanted: z.string() });

/** The payload both tools answer with. Nothing in it is legal. */
const MALFORMED = Object.freeze({ unexpected: 'this field is not in the schema', wanted: 12345 });

/**
 * Start the instrument, run `body(client)`, and take it down again.
 *
 * The teardown is in a `finally` and reports what it could not close, in the
 * same shape test/support/mcpWireRig.js uses: a suite that leaves a socket
 * behind against a server it was measuring has not finished.
 */
async function withPremiseServer(body) {
  const server = new http.Server();
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'refusal-premise', version: '0.0.0' },
      { capabilities: { tools: { listChanged: false } } }
    );
    const publish = (name, isError) =>
      mcp.registerTool(
        name,
        {
          title: name,
          description: 'Answers a payload its own output schema rejects.',
          inputSchema: z.object({}),
          outputSchema: DeclaredOutput,
        },
        async () => ({
          content: [{ type: 'text', text: JSON.stringify(MALFORMED) }],
          structuredContent: { ...MALFORMED },
          ...(isError ? { isError: true } : {}),
        })
      );
    publish('malformed_success', false);
    publish('malformed_refusal', true);
    return mcp;
  });
  const nodeHandler = toNodeHandler(handler);
  server.on('request', (req, res) => nodeHandler(req, res));

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();

  const problems = [];
  let close = null;
  try {
    const connected = await connectMcp({ url: `http://127.0.0.1:${port}/mcp`, era: 'modern', name: 'refusal-premise' });
    close = connected.close;
    return await body(connected.client);
  } finally {
    if (close) {
      const said = await close();
      if (said && said.ok === false) problems.push(`the premise client would not close: ${said.error}`);
    }
    await new Promise((done) => server.close(() => done()));
    if (problems.length) throw new Error(problems.join('; '));
  }
}

module.exports = { withPremiseServer, MALFORMED, DeclaredOutput };
