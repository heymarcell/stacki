// The only thing an evaluator agent is given.
//
// TRANSPORT, NOT AN AGENT. It speaks MCP through the official client and prints
// what came back. It does not choose operations, does not fetch guidance on the
// agent's behalf, does not repair bad arguments, and does not hide a refusal. If
// the agent calls something that does not exist, it sees that it does not exist.
//
// It also does not know what the task is, what the right answer is, or which arm
// it is serving. The whole point of the evaluation is that the difference between
// arms is what STACKI says, not what this file does.
//
// Every invocation appends one line to the run's JSONL log: the verb, the
// arguments, the byte size of the answer, whether it was an error, and how long
// it took. That log is the measurement; the agent's prose is not.

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const ENDPOINT = path.join(HERE, 'endpoint.json');
const LOG = path.join(HERE, 'mcp-log.jsonl');

const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? null), 'utf8');

function usage() {
  console.log(`Stacki MCP adapter. Every command talks to the running Stacki over MCP.

  node mcp-adapter.js instructions          the server's own instructions
  node mcp-adapter.js tools                 tools/list (names, titles, descriptions)
  node mcp-adapter.js schema <tool>         the full input schema for one tool
  node mcp-adapter.js call <tool> '<json>'  tools/call
  node mcp-adapter.js resources             resources/list
  node mcp-adapter.js read <uri>            resources/read
  node mcp-adapter.js prompts               prompts/list
  node mcp-adapter.js prompt <name> '<json>'  prompts/get

Some commands may not be supported by the server you are talking to. That is
information about the server, not a bug in this adapter.`);
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb || verb === 'help') return usage();

  let endpoint;
  try {
    endpoint = JSON.parse(fs.readFileSync(ENDPOINT, 'utf8'));
  } catch {
    console.error('No Stacki endpoint is available. The harness has not started one.');
    process.exit(2);
  }

  // Required lazily so `help` works with nothing installed.
  const { Client } = require(endpoint.clientModule);
  const { StreamableHTTPClientTransport } = require(endpoint.transportModule);

  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
  });
  const client = new Client({ name: 'stacki-evaluator', version: '1.0.0' }, { capabilities: {} });

  const started = Date.now();
  let answer = null;
  let failed = null;
  try {
    await client.connect(transport, { timeout: 60000 });
    switch (verb) {
      case 'instructions':
        answer = client.getInstructions?.() ?? '(this server sent no instructions)';
        break;
      case 'tools': {
        const t = await client.listTools();
        answer = (t.tools || []).map((x) => ({ name: x.name, title: x.title, description: x.description }));
        break;
      }
      case 'schema': {
        const t = await client.listTools();
        const one = (t.tools || []).find((x) => x.name === rest[0]);
        answer = one ? { name: one.name, inputSchema: one.inputSchema } : `no tool called ${rest[0]}`;
        break;
      }
      case 'call': {
        const args = rest[1] ? JSON.parse(rest[1]) : {};
        const r = await client.callTool({ name: rest[0], arguments: args }, undefined, { timeout: 180000 });
        answer = r.structuredContent ?? (r.content || []).map((c) => c.text).join('\n');
        break;
      }
      case 'resources': {
        const r = await client.listResources();
        answer = (r.resources || []).map((x) => ({ uri: x.uri, title: x.title, description: x.description }));
        break;
      }
      case 'read': {
        const r = await client.readResource({ uri: rest[0] });
        answer = (r.contents || []).map((c) => c.text || '').join('\n');
        break;
      }
      case 'prompts': {
        const r = await client.listPrompts();
        answer = (r.prompts || []).map((x) => ({ name: x.name, title: x.title, description: x.description }));
        break;
      }
      case 'prompt': {
        const args = rest[1] ? JSON.parse(rest[1]) : {};
        const r = await client.getPrompt({ name: rest[0], arguments: args });
        answer = (r.messages || []).map((m) => m.content?.text || '').join('\n');
        break;
      }
      default:
        failed = `unknown command: ${verb}`;
    }
  } catch (err) {
    failed = String(err?.message || err);
  } finally {
    try {
      await client.close();
    } catch {
      /* the log below records what happened either way */
    }
  }

  const out = failed ? `ERROR: ${failed}` : typeof answer === 'string' ? answer : JSON.stringify(answer, null, 1);
  // One line per interaction. This is the measurement.
  try {
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        at: Date.now(),
        verb,
        args: rest,
        ok: !failed,
        error: failed || null,
        answerBytes: bytes(out),
        ms: Date.now() - started,
      }) + '\n'
    );
  } catch {
    /* a log that cannot be written must not change what the agent sees */
  }
  console.log(out);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('adapter failed:', err?.message || err);
  process.exit(1);
});
