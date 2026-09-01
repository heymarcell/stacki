// One arm of the held-out evaluation.
//
//   node scripts/eval/heldout/run.js --arm=baseline --app=<Stacki.app> --out=<dir>
//   node scripts/eval/heldout/run.js --arm=candidate --tasks=understand,auditfix
//
// WHAT ONE TRIAL IS. A disposable copy of a held-out project; a real packaged
// Stacki opened on it with its own userData and its own port; a recording proxy
// in front of that endpoint; a fresh Claude Code with no built-in tools and no
// user configuration, mounted on the proxy; and then a check that reads the
// world the trial left behind.
//
// WHAT MAKES THE TWO ARMS COMPARABLE. Same project bytes (hash-verified), same
// brief (byte-identical), same host flags, same model, same effort, fresh
// context. The only thing that differs is which Stacki.app is launched — which
// is why `--app` is required and why the resulting sha is written into every
// result file.
//
// NOTHING HERE MUTATES THE MACHINE. No user MCP registration, no `~/.claude`,
// no settings file outside the trial's own workspace. Every process, port and
// directory is owned by the trial and accounted for at teardown; a trial that
// leaves residue is recorded as having left residue rather than as a pass.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const corpus = require('./corpus.js');
const { TASKS, byId, idsOf } = require('./tasks.js');
const { createRecorder, summarise } = require('./recorder.js');
const { runHost, claudeVersion } = require('./host.js');
const { startPackagedApp, available, APP } = require(path.join(REPO, 'test/support/packagedApp.js'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portTaken = (port) =>
  new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (taken) => {
      socket.destroy();
      done(taken);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(true), 400).unref?.();
  });

async function freePort(from) {
  for (let port = from; port < from + 300; port += 1) {
    if (!(await portTaken(port))) return port;
  }
  throw new Error('no free port for the recorder');
}

/**
 * Where the project's own Astro is serving from.
 *
 * Read out of Astro's own lock file rather than asked of Stacki, because one of
 * the tasks runs at `visual`, where every project read is refused — and a check
 * that could only see the render at some permission levels would be a check
 * that measured the permission gate instead of the change.
 */
function previewUrlOf(root) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, '.astro', 'dev.json'), 'utf8'));
    return lock?.port ? `http://127.0.0.1:${lock.port}` : null;
  } catch {
    return null;
  }
}

async function runTrial({ id, arm, appPath, outDir, trial, model, effort, log }) {
  const task = byId(id);
  const started = Date.now();
  const ws = path.join(outDir, `t${trial}-${id}-${arm}`);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  const result = {
    task: id,
    class: task.class,
    split: task.split,
    project: task.project,
    arm,
    trial,
    app: appPath,
    mode: task.mode,
    access: task.access,
    model,
    ok: false,
  };

  let app = null;
  let recorder = null;
  const projectDir = path.join(ws, 'project');

  try {
    const source = await corpus.project(task.project, { log });
    result.projectHash = source.contentHash;
    result.astro = source.astro;
    corpus.checkout(source.root, projectDir);
    if (task.seed) task.seed(projectDir);
    log(`${id}/${arm}: project ready`);

    const port = await freePort(44500 + ((process.pid % 50) * 6));
    app = await startPackagedApp({ access: task.access, project: projectDir, app: appPath, portFrom: port });
    log(`${id}/${arm}: app on ${app.url}`);

    // At `visual` every project read is refused, so "is it open" cannot be
    // asked — `capture` is the one door that is open at every level, and
    // waiting on it is waiting on the same thing.
    if (task.access !== 'visual') await app.untilOpen();
    const ready = await app.untilPreviewReady();
    result.previewStatus = ready?.status || null;
    if (task.setup) result.setup = await task.setup({ app, root: projectDir });

    // The preview URL is captured BEFORE the agent runs: one task deliberately
    // stops the dev server, and a check that read the address afterwards would
    // read whatever the agent left rather than where the project is served.
    const previewBefore = previewUrlOf(projectDir);

    const wirePath = path.join(ws, 'wire.jsonl');
    const proxyPort = await freePort(47500 + ((process.pid % 50) * 6));
    recorder = createRecorder({ upstreamUrl: app.url, token: app.token, port: proxyPort, logPath: wirePath });
    await recorder.start();

    fs.writeFileSync(path.join(ws, 'BRIEF.md'), task.brief, 'utf8');
    const host = await runHost({
      workspace: ws,
      url: recorder.url,
      token: app.token,
      prompt: task.brief,
      mode: task.mode,
      model,
      effort,
      schema: task.schema,
      timeoutMs: task.timeoutMs,
      log: (m) => log(`${id}/${arm}: ${m}`),
    });
    await recorder.stop();
    recorder = null;

    result.host = {
      ok: host.ok,
      turns: host.turns,
      elapsedMs: host.elapsedMs,
      timedOut: host.timedOut,
      usage: host.usage,
      costUsd: host.costUsd,
      permissionDenials: host.permissionDenials,
      builtinToolCalls: host.builtinToolCalls,
      builtinUsed: host.builtinUsed,
      mcpToolCalls: host.mcpToolCalls,
      toolUse: host.toolUse,
      text: host.text,
    };
    // THE ISOLATION CLAIM, CHECKED RATHER THAN ASSERTED. In `mcp-only` the
    // model has no built-in tools at all, so any built-in call means the flag
    // did not take and the trial's MCP counts are not the whole story.
    result.isolationHeld = task.mode !== 'mcp-only' || host.builtinToolCalls === 0;

    result.wire = summarise(wirePath);
    const wireRows = fs
      .readFileSync(wirePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const previewUrl = previewUrlOf(projectDir) || previewBefore;
    result.previewUrl = previewUrl;
    result.oracle = await task.check({
      app,
      root: projectDir,
      previewUrl,
      host,
      wire: wireRows,
      structured: host.structured,
      // What the project hashed to before the trial started, so a check can
      // assert that nothing at all changed rather than that one string survived.
      projectHash: result.projectHash,
    });
    result.ok = result.oracle?.pass === true;
  } catch (err) {
    result.error = String(err?.stack || err?.message || err);
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
    if (app) {
      const said = await app.stop().catch((e) => ({ problems: [String(e?.message || e)] }));
      result.cleanupProblems = said?.problems || [];
    }
    // The project the app opened is removed by the app's own teardown; the
    // workspace around it is this run's evidence and stays.
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  result.elapsedMs = Date.now() - started;
  fs.writeFileSync(path.join(ws, 'result.json'), JSON.stringify(result, null, 1), 'utf8');
  return result;
}

async function main() {
  const arm = arg('arm');
  const appPath = arg('app', APP);
  const outDir = arg('out', path.join(os.tmpdir(), 'stacki-heldout-runs'));
  const trial = Number(arg('trial', '1'));
  const model = arg('model', 'sonnet');
  const effort = arg('effort', null);
  const split = arg('split', null);
  const only = arg('tasks', null);

  if (!arm) {
    console.error('need --arm=baseline|candidate');
    process.exit(2);
  }
  if (!available(appPath)) {
    console.error(`no packaged app at ${appPath} — build one with npm run dist:mac:unsigned`);
    process.exit(2);
  }
  const ids = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : idsOf(split);

  fs.mkdirSync(outDir, { recursive: true });
  const log = (m) => console.log(`[${arm}] ${m}`);
  log(`claude ${claudeVersion()}`);
  log(`app ${appPath}`);
  log(`manifest ${corpus.manifestHash().slice(0, 16)}  tasks ${ids.join(', ')}`);

  const results = [];
  for (const id of ids) {
    const r = await runTrial({ id, arm, appPath, outDir, trial, model, effort, log });
    results.push(r);
    log(
      `${id}: ${r.ok ? 'PASS' : 'FAIL'}${r.error ? ` (${r.error.split('\n')[0]})` : ''}` +
        `  calls=${r.wire?.toolCalls ?? '-'} profile=${r.wire?.projectProfileReads ?? '-'}` +
        ` bytes=${r.wire?.responseBytes ?? '-'} ${Math.round((r.elapsedMs || 0) / 1000)}s` +
        `${r.oracle?.why ? ` — ${r.oracle.why}` : ''}`
    );
    // A moment between trials so a port the last one released is really free.
    await sleep(2000);
  }

  fs.writeFileSync(
    path.join(outDir, `summary-${arm}-t${trial}.json`),
    JSON.stringify({ arm, trial, app: appPath, model, manifestHash: corpus.manifestHash(), results }, null, 1),
    'utf8'
  );
  const passed = results.filter((r) => r.ok).length;
  log(`${passed}/${results.length} passed`);
  process.exit(0);
}

if (require.main === module) {
  process.env.STACKI_NO_DIALOGS = '1';
  main().catch((err) => {
    console.error('the run failed:', err?.stack || err);
    process.exit(1);
  });
}

module.exports = { runTrial, previewUrlOf, TASKS };
