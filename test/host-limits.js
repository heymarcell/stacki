// What a real host will actually carry, and what it silently cuts.
//
//   node test/host-limits.js
//
// Server instructions and tool descriptions are not documentation: with MCP
// tool search on — which is the DEFAULT in the Claude Code this ships against —
// they are the retrieval metadata a model picks a tool by. A description that
// is cut in half is a tool that does not get found, and the cut is silent.
//
// MEASURED, not assumed. Claude Code 2.1.259 truncates both the server
// `instructions` string and every tool `description` at 2048 CHARACTERS,
// appending "… [truncated]", at connect time and regardless of whether tool
// search is on. That was established by running the client against an
// instrumented MCP server and reading its own `--debug=mcp` log back, not from
// documentation.
//
// So this suite pins two things:
//
//   THE CAP, which is the host's and is a hard failure. A string over it is
//   already being cut on somebody's machine.
//
//   HEADROOM, which is ours. `get_comments` measured 2,047 characters against
//   a 2,048 cap — one character. Nothing warned, nothing would have warned, and
//   the next word added to it would have silently truncated the description of
//   one of the two tools the lowest permission level exists for. A limit that
//   can be crossed by a typo is not a limit anybody is respecting on purpose.
//
// Read over the WIRE rather than out of the modules, because the wire is what
// the host is handed: a description assembled from three concatenated string
// literals is one string by the time it matters.

const { createStackiMcpServer } = require('../electron/mcp/server.js');
const { connectMcp } = require('./support/mcpWire.js');

// The host's cap, in characters. Not bytes: the measurement was of characters.
const HOST_LIMIT = 2048;
// Ours. Enough that an ordinary edit cannot cross the host's without this
// suite saying so first.
const HEADROOM = 128;
const OUR_LIMIT = HOST_LIMIT - HEADROOM;

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const PORT = 45201 + (process.pid % 60);
const TOKEN = 'host-limits-token-aaaaaaaaaaaaaaaa';

(async () => {
  const server = createStackiMcpServer({
    port: PORT,
    token: TOKEN,
    name: 'stacki',
    version: '0.1.23',
    getContext: async () => ({}),
    capture: async () => ({ image: null, mimeType: null, meta: {} }),
    getComments: async () => ({ comments: [] }),
    comment: async () => ({ ok: true }),
    api: { capabilities: () => ({ level: 'full', operations: [] }), run: async () => ({ ok: true }) },
    audit: { run: async () => ({ ok: true }) },
    onError: () => {},
  });
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'host-limits', version: '1.0.0' },
          },
        },
      }),
    });
    const discovered = (await res.json()).result;
    const instructions = discovered?.instructions || '';
    check('the server sends instructions', instructions.length > 0, String(instructions.length));
    check(
      `the instructions fit the host's ${HOST_LIMIT}-character cap`,
      instructions.length <= HOST_LIMIT,
      `${instructions.length} characters — a real host is cutting the end off this`
    );
    check(
      `  with room to edit them (<= ${OUR_LIMIT})`,
      instructions.length <= OUR_LIMIT,
      `${instructions.length} characters, ${HOST_LIMIT - instructions.length} from the cap`
    );

    const { client, close } = await connectMcp({ url: `http://127.0.0.1:${PORT}/mcp`, token: TOKEN, era: 'modern' });
    const { tools } = await client.listTools();
    check('the catalogue has tools to measure', tools.length > 0, String(tools.length));

    let tightest = { name: null, length: -1 };
    for (const tool of tools) {
      const description = tool.description || '';
      check(`${tool.name} has a description`, description.length > 0, tool.name);
      check(
        `  ${tool.name} fits the host's ${HOST_LIMIT}-character cap`,
        description.length <= HOST_LIMIT,
        `${description.length} characters — a real host is cutting the end off this`
      );
      check(
        `  ${tool.name} has room to edit (<= ${OUR_LIMIT})`,
        description.length <= OUR_LIMIT,
        `${description.length} characters, ${HOST_LIMIT - description.length} from the cap`
      );
      if (description.length > tightest.length) tightest = { name: tool.name, length: description.length };
    }
    // Reported rather than asserted: a number to watch, printed every run, so
    // the margin is visible before it is gone.
    console.log(
      `  closest to the cap: ${tightest.name} at ${tightest.length}/${HOST_LIMIT} characters ` +
        `(${HOST_LIMIT - tightest.length} spare) · instructions ${instructions.length}/${HOST_LIMIT}`
    );
    await close();
  } finally {
    await server.stop();
  }

  if (failures.length) {
    console.error(`host-limits: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`host-limits: ${checked} passed  [nothing this server says is being silently cut in half]`);
})().catch((err) => {
  console.error('host-limits: threw', err);
  process.exit(1);
});
