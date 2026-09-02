// Does the config Stacki hands people actually work?
//
//   node scripts/eval/heldout/config-smoke.js
//
// Development evidence, never CI: it needs a built `Stacki.app` and a real
// Claude Code, and it costs a model call.
//
// WHY IT EXISTS. The connection panel's project recipes name an environment
// variable instead of carrying the bearer token, because the files they are for
// -- `.mcp.json`, `.cursor/mcp.json` -- are files their own documentation tells
// people to commit. `test/mcp.js` proves the generated text contains no token
// and names the right variable. It cannot prove the result CONNECTS, and a
// secure config that does not work is not a fix, it is a regression with a good
// excuse.
//
// So this takes the exact bytes the shipped component produces, writes them as
// a config file, puts the token ONLY in the child process's environment, and
// drives a real Claude Code at a real packaged Stacki through the recording
// proxy. Then it does it again with the variable absent, because a test that
// only ever sees success cannot tell connecting from being unable to fail.
//
// It runs the trial through `runHost`, the same function every held-out trial
// uses, with `configPath` pointing at the generated file. That matters: an
// earlier version of this rebuilt the `claude` invocation by hand and could not
// connect with a LITERAL token either -- it was testing the hand-rolled command,
// not the config.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const corpus = require('./corpus.js');
const { createRecorder, summarise } = require('./recorder.js');
const { runHost, claudeVersion } = require('./host.js');
const { startPackagedApp, available, APP } = require(path.join(REPO, 'test/support/packagedApp.js'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PROMPT =
  'Call the stacki MCP tool get_capabilities with no arguments, then reply with only the access level label it reports.';

/** The recipes, out of the shipped component rather than retyped here. */
function recipes() {
  const outfile = path.join(REPO, 'node_modules', '.stacki-test', 'config-smoke-dialog.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  require(path.join(REPO, 'node_modules', 'esbuild')).buildSync({
    entryPoints: [path.join(REPO, 'src/ui/McpDialog.jsx')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

async function main() {
  const appPath = arg('app', APP);
  const out = arg('out', path.join(os.tmpdir(), 'stacki-config-smoke'));
  if (!available(appPath)) {
    console.error(`no packaged app at ${appPath} — build one with npm run dist:mac:unsigned`);
    process.exit(2);
  }
  const say = (m) => console.log(`config-smoke: ${m}`);
  say(`claude ${claudeVersion()}`);

  const { CLIENTS, TOKEN_ENV_VAR } = recipes();
  const recipe = CLIENTS.find((c) => c.key === 'claude-json');
  if (!recipe || recipe.scope !== 'project') throw new Error('the claude-json recipe is not project-scoped');

  const source = await corpus.project('astro-blog', { log: say });
  fs.mkdirSync(out, { recursive: true });
  const projectDir = corpus.checkout(source.root, path.join(out, 'project'));

  const app = await startPackagedApp({ access: 'edit', project: projectDir, app: appPath, portFrom: 45800 });
  await app.untilOpen();
  say(`stacki at ${app.url}`);

  const results = [];
  let port = 48100;
  for (const withVariable of [true, false]) {
    const name = withVariable ? 'variable-exported' : 'variable-absent';
    const ws = path.join(out, name);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true });
    const logPath = path.join(ws, 'wire.jsonl');
    const recorder = createRecorder({ upstreamUrl: app.url, token: app.token, port: port++, logPath });
    await recorder.start();

    // The product's own bytes, unedited.
    const text = recipe.text({ url: recorder.url, token: app.token });
    const configPath = path.join(ws, 'stacki.mcp.json');
    fs.writeFileSync(configPath, text, 'utf8');
    const tokenBytes = text.split(app.token).length - 1;

    const host = await runHost({
      workspace: ws,
      url: recorder.url,
      token: app.token,
      prompt: PROMPT,
      mode: 'mcp-only',
      model: arg('model', 'sonnet'),
      timeoutMs: 300000,
      configPath,
      // THE POINT: the token exists here and nowhere else.
      env: withVariable ? { [TOKEN_ENV_VAR]: app.token } : {},
    });
    await recorder.stop();
    const wire = summarise(logPath);
    results.push({ name, tokenBytes, wire, host });
    say(
      `${name.padEnd(18)} tokenBytesInConfig=${tokenBytes} preambleCalls=${wire.preambleCalls} ` +
        `toolCalls=${wire.toolCalls} answered=${JSON.stringify(String(host.text).slice(0, 60))}`
    );
  }

  const [exported, absent] = results;
  const problems = [];
  if (exported.tokenBytes !== 0) problems.push('the generated config contained the token');
  if (exported.wire.toolCalls < 1) problems.push('the committable config did not reach Stacki');
  if (!/edit project/i.test(String(exported.host.text))) problems.push('it connected but did not answer from Stacki');
  if (absent.wire.preambleCalls !== 0) problems.push('it reached Stacki with no variable set, so the variable is not what authorised it');

  const said = await app.stop();
  problems.push(...(said?.problems || []));
  fs.rmSync(projectDir, { recursive: true, force: true });

  if (problems.length) {
    console.error(`config-smoke: FAILED — ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('config-smoke: passed  [the committable config carries no token, and connects only when the variable is exported]');
  process.exit(0);
}

if (require.main === module) {
  process.env.STACKI_NO_DIALOGS = '1';
  main().catch((err) => {
    console.error('config-smoke: threw\n', err?.stack || err);
    process.exit(1);
  });
}
