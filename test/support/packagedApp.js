// A packaged Stacki, launched and driven, and taken down again.
//
// Everything that makes the packaged proof possible lives here so the tests
// that use it read as tests rather than as process management: a fixture with
// the project's own dependencies really installed, the automation nonce the app
// checks for, an isolated userData, a port nobody else is on, and a teardown
// that reports what it could not clean up rather than swallowing it.
//
// OWNERSHIP. Every path and every process here is made by this module. The
// stop() records exact pids and exact directories, and answers with what
// survived — nothing greps for "a Stacki" or "an astro".

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const H = require('../agent-harness.js');
const { EXTRA, writeBinary } = require('./mcpWireFixture.js');
const { connectMcp } = require('./mcpWire.js');
const { CACHE, ensureAstro } = require('../agent-canvas-fixture.js');
const { projectFingerprint } = require('../../electron/mcp/agent/refs.js');
const { createManifest, residueOfManifest, describeManifestResidue } = require('./ownership.js');
// The evaluation harness's environment builder. See `contained` below for why
// a test-support module depends on it rather than approximating it.
const { containedEnv } = require('../../scripts/eval/heldout/host.js');

const APP = path.join(__dirname, '..', '..', 'release', 'mac-universal', 'Stacki.app');
const BINARY = path.join(APP, 'Contents', 'MacOS', 'Stacki');

/**
 * The bundle to launch.
 *
 * Defaulted rather than fixed because a held-out A/B needs two of them at once
 * — one built from the baseline commit, one from the candidate — and the whole
 * comparison is void if both arms launch the same app. Every test in the suite
 * passes nothing and gets this checkout's own build, exactly as before.
 */
const binaryOf = (app) => path.join(app || APP, 'Contents', 'MacOS', 'Stacki');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const available = (app) => fs.existsSync(binaryOf(app));

const portTaken = (port) =>
  new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (taken) => {
      socket.destroy();
      done(taken);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(false), 300).unref?.();
  });

async function freePort(from) {
  for (let port = from; port < from + 200; port += 1) {
    if (!(await portTaken(port))) return port;
  }
  throw new Error('no free port for the packaged MCP endpoint');
}

/**
 * A fixture the packaged app is allowed to open.
 *
 * The dependencies are real — cloned from the shared cache — because a project
 * that cannot run Astro cannot render, and a packaged proof that never renders
 * is the in-process proof again with a longer startup.
 */
function makeFixture({ nonce, extraFiles = null }) {
  ensureAstro();
  // `extraFiles` is opt-in rather than always-on: a test that needs extra routes
  // (the audit corpus) should not change the project every other packaged test
  // is asserting page and component counts against.
  const project = H.makeProject({ ...EXTRA, ...(extraFiles || {}) });
  writeBinary(fs, path, project);
  try {
    execFileSync('cp', ['-Rc', path.join(CACHE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'pipe' });
  } catch {
    fs.cpSync(path.join(CACHE, 'node_modules'), path.join(project, 'node_modules'), { recursive: true, dereference: false });
  }
  // The nonce the app will look for. Written here, passed separately in the
  // environment: matching the two is what makes a stale fixture unusable.
  fs.writeFileSync(path.join(project, '.stacki-automation'), nonce, 'utf8');
  return project;
}

/**
 * Launch it, wait for its MCP server, and connect an official client.
 *
 * `access` is written into the app's own settings file, keyed the way the app
 * keys it — the same grant a person makes from the access menu. `full` is
 * deliberately not reachable this way (see electron/mcp/agent/access.js: it
 * comes from a live session or not at all), so `edit` is the ceiling here and
 * that is what a write needs.
 */
async function startPackagedApp({
  access = 'edit',
  nonce = null,
  portFrom = 43990,
  extraFiles = null,
  // A PROJECT THIS MODULE DID NOT BUILD.
  //
  // `makeFixture` writes the shared fixture, which is the right thing for every
  // packaged test: they assert page and component counts against it. A held-out
  // evaluation needs the opposite — a project nothing here has seen — so it
  // hands one over whole, with its own dependencies already installed.
  //
  // It must be a DISPOSABLE COPY. `stop()` removes whatever it opened, because
  // a trial that leaves its project behind leaves the next trial starting from
  // the last one's edits. Pass a checkout, never the reference corpus.
  project: given = null,
  // Which bundle to launch. See `binaryOf`.
  app = APP,
  // Whether a person is meant to watch this one. See `appVars` below.
  visible = false,
  // WHETHER THIS APP IS PART OF A TRIAL, and must therefore be unable to reach
  // GitHub.
  //
  // `git.publish` runs INSIDE THIS PROCESS, not inside the agent host. So a
  // held-out trial that contained its agent and launched this with
  // `{...process.env}` had a contained agent asking an UNCONTAINED app to
  // create a repository — which is exactly the route that created a real one in
  // an earlier campaign, and the reason test/support/fakeGh.js exists at all.
  // The agent's `ghCallsDuringTrial` then proved what went through the agent's
  // `gh` and nothing whatever about this app's.
  //
  // OPT-IN, NOT DEFAULT-ON, and the choice is deliberate. Eight callers start
  // this app and only the evaluation runners are trials; the rest are ordinary
  // packaged suites that legitimately run with the developer's environment.
  // Containment does not merely remove credentials — it sets CI=1, repoints
  // GIT_CONFIG_GLOBAL at a throwaway identity with no credential helper, and
  // shadows `gh` — so switching it on by default would silently change what
  // every one of those suites measures, and would hand each of them two temp
  // directories they never allocated and must now tear down. A containment that
  // changes the ordinary suites is a regression with a security rationale.
  //
  // The risk of opting in is that a future trial FORGETS. That is closed at the
  // other end rather than here: `runHost` records `siblingsContained` and
  // defaults it to false, so a runner that contains its host and forgets its
  // app writes "the app was not contained" into its own results file. The
  // omission speaks; it does not merely fail to be mentioned.
  contained = false,
} = {}) {
  if (!available(app)) throw new Error(`no packaged app at ${app}`);
  const binary = binaryOf(app);
  const marker = nonce || `stacki-automation-${process.pid}-${(process.hrtime.bigint() % 1000000n).toString()}`;
  const project = given || makeFixture({ nonce: marker, extraFiles });
  if (given) {
    if (!fs.existsSync(path.join(given, 'node_modules', 'astro'))) {
      throw new Error(`no astro is installed in ${given}; a held-out project must arrive with its dependencies`);
    }
    fs.writeFileSync(path.join(given, '.stacki-automation'), marker, 'utf8');
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-packaged-userdata-'));
  const port = await freePort(portFrom);

  // The app resolves the automation path before opening it, so the grant has to
  // be keyed to what it will actually open.
  const opened = fs.realpathSync(project);
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(opened)]: access } }),
    'utf8'
  );

  // WHAT THIS RUN OWNS, written down as it is acquired.
  //
  // The parent that starts this process cannot see inside it, and by the time
  // it looks the fixture is deliberately gone. So every identity is recorded
  // the moment it exists — before anything can delete the evidence of it.
  const manifest = createManifest(process.env.STACKI_OWNERSHIP_MANIFEST || null);
  manifest.path('project', project);
  manifest.path('userData', userData);
  manifest.port('mcp', port);

  // Passed through `containedEnv`'s `env` channel rather than merged over its
  // answer, so the harness sees what this caller deliberately set — and so a
  // future STACKI_* name that happens to look credential-shaped is exempt from
  // the shape strip for the right reason instead of by luck.
  const appVars = {
    // HIDDEN BY DEFAULT, AND THAT IS THE RIGHT DEFAULT. Every packaged suite
    // wants a window that captures identically and never takes the screen; a
    // run that steals focus several times a minute is a run nobody leaves
    // going. `visible: true` is for the one thing that has to be watched by a
    // person — the dogfood replay, where the point is that somebody sees the
    // site not go blank.
    STACKI_NO_DIALOGS: visible ? '0' : '1',
    STACKI_HIDDEN_WINDOW: visible ? '0' : '1',
    STACKI_MCP_PORT: String(port),
    STACKI_AUTOMATION_PROJECT: project,
    STACKI_AUTOMATION_MARKER: marker,
  };
  // Built before the spawn so a refusal happens before there is a process to
  // clean up. `containedEnv` fails closed: if the fake `gh` did not take PATH,
  // or a GitHub credential was passed in, it throws rather than launching.
  const containment = contained ? containedEnv(appVars, { siblingsContained: true }) : null;

  const output = [];
  let exited = null;
  const child = spawn(binary, [`--user-data-dir=${userData}`], {
    env: containment ? containment.env : { ...process.env, ...appVars },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  child.on('exit', (code) => {
    exited = code;
  });
  manifest.process('packaged app', child.pid);

  // A START THAT NEVER COMPLETES STILL OWNS THE CONTAINMENT IT BUILT.
  //
  // `stop()` is the only thing that tears the containment down, and there is no
  // `stop()` to call when the app never answered — the caller gets a throw and
  // nothing else. Left alone, an app that failed to start would leave a fake
  // `gh` directory and a GH_CONFIG_DIR in os.tmpdir() on every attempt. This is
  // the same defect `containedEnv` itself had to fix one round ago, in the same
  // shape: teardown reachable only along the happy path.
  const url = `http://127.0.0.1:${port}/mcp`;
  let token = null;
  let client = null;
  let close = null;
  try {
    for (let i = 0; i < 160 && token === null && exited === null; i += 1) {
      await sleep(500);
      try {
        token = JSON.parse(fs.readFileSync(path.join(userData, 'mcp-token.json'), 'utf8')).token;
      } catch {
        /* not written yet */
      }
    }
    if (!token) {
      throw new Error(`the packaged app did not start its MCP server (exit=${exited})\n${output.join('').slice(-800)}`);
    }
    ({ client, close } = await connectMcp({ url, token, era: 'modern', name: 'Stacki Phase A Agent' }));
  } catch (err) {
    if (containment) {
      try {
        containment.cleanup();
      } catch {
        /* nothing to tear down */
      }
    }
    // The app is dead or never answered; the process is killed for the case
    // where it is running but silent, so its userData is not still held.
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    // AND THE DIRECTORIES THIS FUNCTION MADE. `userData` has no other reference
    // in the world — the caller never sees it, because the caller gets a throw
    // instead of the object that names it — so leaving it behind leaves a
    // directory nobody can ever identify as theirs. The fixture project goes
    // the same way when this module built it; a project the CALLER handed over
    // is the caller's to remove. Everything the error needs to be diagnosed is
    // already in its message: the exit code and the tail of the app's output.
    for (const dir of given ? [userData] : [userData, project]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* still held; the parent's ownership sweep will report it */
      }
    }
    throw err;
  }

  const call = async (name, args = {}) =>
    (await client.callTool({ name, arguments: args }, { timeout: 240000 })).structuredContent;
  const run = async (domain, action, args = {}) => {
    const answer = await call(domain, { action, ...args });
    // A project action can start, restart or stop a server. Re-claiming after
    // each one costs a read of the lock file and is the difference between a
    // manifest that describes the run and one that describes one moment of it.
    if (domain === 'project') {
      claimDevServer();
      claimHelpers();
    }
    return answer;
  };

  /** Wait for the window to finish opening the project it was pointed at. */
  const untilOpen = async (timeoutMs = 90000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await run('project', 'info');
      // The app starts its own preview as it opens the project, so ownership
      // can change here — before anything has asked for a capture.
      claimDevServer();
      claimHelpers();
      if (info?.ok === true && info?.project?.open) return info;
      if (Date.now() > deadline) return info;
      await sleep(500);
    }
  };

  /**
   * Wait until the app is actually SHOWING the page.
   *
   * Not the same as the project being open: the dev server has to be up and
   * the canvas has to have loaded it before a computed style or a screenshot
   * means anything. Asked of capture itself, because `preview_not_ready` is
   * exactly the answer a premature proof would have accepted.
   */
  /**
   * Astro's own record of the server it forked, and everything it names.
   *
   * Recorded rather than discovered later: the lock file lives in the project,
   * and the project is the first thing teardown removes.
   */
  const claimDevServer = () => {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(opened, '.astro', 'dev.json'), 'utf8'));
      if (lock?.pid) manifest.process('astro dev server', lock.pid, { rename: true });
      if (lock?.port) manifest.port('preview', lock.port);
      return lock;
    } catch {
      return null;
    }
  };

  /**
   * Everything running out of the project directory, whoever started it.
   *
   * The app spawns more than a dev server: reading a content config leaves a
   * runner and an esbuild service behind, and those pids exist only inside the
   * app. Rather than have the app publish them, they are found by the one thing
   * that identifies them as this run's — the path they are running out of. That
   * is ownership by identity, not by program name: nothing here cares whether a
   * process is called node, astro or esbuild.
   */
  const claimHelpers = () => {
    manifest.processesUnder('a process in the project', opened);
    // AND UNDER userData. Electron's own children — the renderer, the GPU
    // process, the utility processes — carry `--user-data-dir=<userData>` in
    // their argv and nothing else this run owns. They were invisible to a
    // manifest that only looked at the project path, so an app that had to be
    // SIGKILLed could leave its helpers behind and still be a clean run.
    manifest.processesUnder('a helper of the app', userData);
  };

  /** Claim everything claimable, at whatever moment this is called. */
  const claimAll = () => {
    claimDevServer();
    claimHelpers();
  };

  const untilPreviewReady = async (timeoutMs = 180000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await call('capture', { target: 'viewport', format: 'png' });
      // Claimed as soon as there is something to claim, and re-claimed on each
      // look: a server that is restarted forks a new pid, and the old entry
      // staying in the manifest is correct — it must be gone as well.
      claimAll();
      if (last?.status && last.status !== 'preview_not_ready' && last.status !== 'preview_starting') return last;
      if (Date.now() > deadline) return last;
      await sleep(1000);
    }
  };

  const stop = async () => {
    const problems = [];
    // THE LAST MOMENT THE EVIDENCE EXISTS. The lock file lives in the project
    // and the project is about to go, so everything is claimed once more before
    // anything is torn down.
    claimDevServer();
    claimHelpers();
    // The manifest is marked complete only here: a run that died before this
    // owned things it never finished accounting for, and the parent needs to
    // tell that apart from a run that owned nothing.
    manifest.complete();

    const closed = await close();
    if (closed && closed.ok === false) problems.push(`the MCP client would not close: ${closed.error}`);
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        problems.push('the app would not take SIGTERM');
      }
      for (let i = 0; i < 40 && child.exitCode === null; i += 1) await sleep(250);
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(250);
      }
    }
    if (child.exitCode === null) problems.push(`the app (pid ${child.pid}) is still running`);

    // TORN DOWN ONLY ONCE THE APP IS DEAD, and what it saw travels with the
    // answer. Removing the fake `gh` while the app could still call it would
    // un-shadow the real one for whatever the app does on its way out.
    let ghCallsDuringTrial = null;
    if (containment) {
      try {
        ghCallsDuringTrial = containment.cleanup();
      } catch (err) {
        problems.push(`the app's containment would not tear down: ${err?.message || err}`);
      }
    }

    for (const dir of [userData, project]) {
      for (let attempt = 0; attempt < 6 && fs.existsSync(dir); attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* still held */
        }
        if (fs.existsSync(dir)) await sleep(300);
      }
      if (fs.existsSync(dir)) problems.push(`${dir} would not go`);
    }
    // JUDGED FROM WHAT THIS RUN RECORDED, not from the four things this function
    // happens to know about. It used to check the app pid, two directories and
    // the MCP port — so a stranded preview on its own port, or a content-config
    // runner, was a clean teardown as far as anyone running this file directly
    // could tell. Only the five-run parent would have noticed, and only if it
    // was the one running it.
    const left = await residueOfManifest(manifest.read(), { graceMs: 8000 });
    if (left.processes.length || left.ports.length || left.paths.length) {
      problems.push(describeManifestResidue(left));
    }
    return {
      problems,
      pid: child.pid,
      port,
      project,
      userData,
      manifest: manifest.read(),
      // NULL WHEN UNCONTAINED, never an empty list. `[]` from an app that was
      // launched with the developer's real `gh` would read as "the app called
      // gh zero times", which is precisely the false proof this exists to stop.
      ghCallsDuringTrial,
    };
  };

  return {
    child,
    client,
    call,
    run,
    untilOpen,
    untilPreviewReady,
    claimDevServer,
    claimAll,
    manifest,
    stop,
    project,
    opened,
    userData,
    port,
    marker,
    output,
    url,
    token,
    // What was CHECKED about this app's environment, available as soon as it is
    // running rather than only at teardown, so a trial can record it beside the
    // agent's. Null when the app was not contained — which is the truth, and is
    // what a reader of the results should see.
    containment: containment ? containment.assertions : null,
  };
}

module.exports = { startPackagedApp, available, APP, BINARY, sleep, portTaken };
