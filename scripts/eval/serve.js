// One evaluation trial: a real Stacki, a real project, and nothing else.
//
//   node scripts/eval/serve.js --arm=candidate --task=understand --trial=1 --workspace=/tmp/...
//
// Starts a Stacki MCP endpoint over a real owned Astro fixture, writes the
// endpoint and the task brief into an ISOLATED workspace, and waits for the
// agent to say it is finished. Then it runs the hidden oracle against the actual
// world -- files, model, audit -- and stops everything it started.
//
// WHAT THE AGENT CAN SEE: the workspace. A task brief, an adapter, and a project.
// WHAT IT CANNOT SEE: this file, the oracle, Stacki's source, the other arm.
//
// The baseline arm runs from an owned git worktree at origin/main, so "Phase A"
// means the code that is actually on main rather than a simulation of it.

const fs = require('node:fs');
const path = require('node:path');

const TASKS = require('./tasks.js');

const arg = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const arm = arg('arm', 'candidate');
const taskId = arg('task');
const trial = Number(arg('trial', '1'));
const workspace = arg('workspace');
const repo = arg('repo', path.resolve(__dirname, '..', '..'));

if (!taskId || !workspace) {
  console.error('need --task and --workspace');
  process.exit(2);
}
const task = TASKS[taskId];
if (!task) {
  console.error(`unknown task ${taskId}; have ${Object.keys(TASKS).join(', ')}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A KILL MUST NOT LEAK A DEV SERVER.
//
// This process owns a real Astro rig, its port and its temp fixture, and the only
// cleanup was the happy path's `finally`. An external terminate -- which
// launch.sh actively invites by writing a pid file -- skipped it entirely and left
// twelve Astro servers behind. `rigRef` is set as soon as there is something to
// stop, and both signals stop it before exiting.
let rigRef = null;
let stopping = false;
const stopAndExit = async (signal) => {
  if (stopping) return;
  stopping = true;
  try {
    if (rigRef) await rigRef.stop();
  } catch (err) {
    console.error(`stopping the rig on ${signal} failed:`, err?.message || err);
  }
  process.exit(signal === 'SIGTERM' ? 143 : 130);
};
process.on('SIGTERM', () => void stopAndExit('SIGTERM'));
process.on('SIGINT', () => void stopAndExit('SIGINT'));

(async () => {
  // Loaded from whichever checkout this arm is: the baseline worktree has Phase-A
  // code, this one has the candidate.
  const { startWireRig } = require(path.join(repo, 'test/support/mcpWireRig.js'));

  fs.mkdirSync(workspace, { recursive: true });
  const rig = await startWireRig({
    era: 'modern',
    agentMode: 'edit',
    withDeps: !!task.needsDeps,
    extra: task.fixture || {},
    // NO AUDIT TOOL IN EITHER ARM, and that is a stated limit rather than a
    // convenience. The audit renders in a real hidden BrowserWindow; this rig is
    // an in-process Stacki with no Electron around it, so the tool cannot run
    // here for anybody. Both arms are therefore identical in that respect, and
    // the audit-and-fix task below measures whether Phase-B GUIDANCE helps an
    // agent find and fix the defects -- not the Phase-C tool, which is proven in
    // test/mcp-audit.js and test/packaged-audit.js against a real browser.
  });

  rigRef = rig;
  let result = { arm, task: taskId, trial, ok: false };
  try {
    fs.writeFileSync(
      path.join(workspace, 'endpoint.json'),
      JSON.stringify(
        {
          url: rig.url,
          token: rig.token,
          clientModule: require.resolve('@modelcontextprotocol/client', { paths: [repo] }),
          transportModule: require.resolve('@modelcontextprotocol/client', { paths: [repo] }),
        },
        null,
        1
      ),
      'utf8'
    );
    fs.copyFileSync(path.join(__dirname, 'mcp-adapter.js'), path.join(workspace, 'mcp-adapter.js'));
    fs.writeFileSync(path.join(workspace, 'TASK.md'), task.brief, 'utf8');
    fs.writeFileSync(path.join(workspace, 'mcp-log.jsonl'), '', 'utf8');
    // The project the agent is working on, so a checker can look at it later and
    // the agent can be told where it is without being told anything else.
    fs.writeFileSync(path.join(workspace, 'project-path.txt'), rig.root, 'utf8');
    // Anything the task needs to exist before the agent starts -- a seeded review
    // comment, for instance. Run through the rig, so it is real state rather than
    // a file the checker later pretends was one.
    if (typeof task.setup === 'function') {
      result.setup = await task.setup({ rig, root: rig.root });
    }
    fs.writeFileSync(path.join(workspace, 'READY'), 'ready', 'utf8');

    // Wait for the agent. A trial that never finishes is a failed trial, recorded
    // as one rather than hung on.
    const deadline = Date.now() + Number(arg('timeout', '900')) * 1000;
    while (!fs.existsSync(path.join(workspace, 'DONE')) && Date.now() < deadline) await sleep(1000);
    result.finished = fs.existsSync(path.join(workspace, 'DONE'));

    // THE ORACLE. Independent of anything the agent said about itself.
    result.oracle = await task.check({ rig, root: rig.root, workspace, arm });
    result.ok = result.oracle?.pass === true;
  } catch (err) {
    result.error = String(err?.message || err);
  } finally {
    const stopped = await rig.stop();
    result.cleanupProblems = stopped?.problems || [];
    if (result.cleanupProblems.length) result.ok = false;
  }

  // The measured behaviour, read back out of the adapter's own log.
  try {
    const lines = fs
      .readFileSync(path.join(workspace, 'mcp-log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const seen = new Map();
    let redundant = 0;
    for (const l of lines) {
      const key = `${l.verb}:${JSON.stringify(l.args)}`;
      if (seen.has(key)) redundant += 1;
      seen.set(key, true);
    }
    const isCall = (l) => l.verb === 'call';
    result.metrics = {
      mcpInteractions: lines.length,
      toolCalls: lines.filter(isCall).length,
      resourcesRead: lines.filter((l) => l.verb === 'read').length,
      resourceLists: lines.filter((l) => l.verb === 'resources').length,
      promptsFetched: lines.filter((l) => l.verb === 'prompt').length,
      discovery: lines.filter((l) => ['tools', 'schema', 'resources', 'prompts', 'instructions'].includes(l.verb)).length,
      invalid: lines.filter((l) => !l.ok).length,
      redundant,
      responseBytes: lines.reduce((n, l) => n + (l.answerBytes || 0), 0),
      elapsedMs: lines.length ? lines[lines.length - 1].at - lines[0].at : 0,
    };
  } catch (err) {
    result.metricsError = String(err?.message || err);
  }

  fs.writeFileSync(path.join(workspace, 'result.json'), JSON.stringify(result, null, 1), 'utf8');
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  console.error('serve failed:', err?.stack || err);
  process.exit(1);
});
